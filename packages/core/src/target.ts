/**
 * FASE 13/15 — TargetResolver (resolução de alvo + self-healing)
 *
 * Cascata FIXA: selector → role_text → accessibility → semantic → vision → coordinates.
 *
 * Três decisões de projeto que existem para impedir mentira do instrumento:
 *
 *   1. `attempted` registra TODA estratégia percorrida, na ordem. Sem esse rastro,
 *      um alvo que só funcionou porque o resolvedor "deu um jeito" pareceria um
 *      acerto de primeira — e a regressão do seletor ficaria invisível.
 *
 *   2. Ambiguidade INTERROMPE a cascata (TARGET_AMBIGUOUS). Escolher o primeiro
 *      candidato em silêncio, ou cair para a próxima estratégia depois de ver dois
 *      candidatos, é exatamente o comportamento frágil que a missão proíbe: nos dois
 *      casos o runtime agiria sobre um elemento que ninguém pediu.
 *
 *   3. `coordinates` é estruturalmente o último elo. Só é alcançado quando todas as
 *      outras estratégias aplicáveis já falharam — coordenada não compete com
 *      identidade, ela é o que sobra quando não há identidade.
 */
import type { Locator, Page } from "playwright";
import type {
  ActionError,
  ActionErrorCode,
  BoundingBox,
  ResolvedTarget,
  TargetDescriptor,
  TargetStrategy,
  VisionProvider,
} from "./contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Ordem normativa da cascata (art. FASE 13). Não reordenar sem subir o contrato. */
export const CASCADE: readonly TargetStrategy[] = Object.freeze([
  "selector",
  "role_text",
  "accessibility",
  "semantic",
  "vision",
  "coordinates",
] as const);

export const DEFAULT_MAX_CANDIDATES = 60;
export const DEFAULT_VISION_MIN_CONFIDENCE = 0.5;

/**
 * Universo de candidatos da etapa `semantic`. `label` fica de fora de propósito:
 * o rótulo e o campo que ele rotula são o MESMO controle lógico, e listar os dois
 * fabricaria uma ambiguidade que não existe na página.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=option]",
  "[role=combobox]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// ─────────────────────────────────────────────────────────────────────────────
// Tabela de sinônimos (pt + en) — determinística, sem LLM
// ─────────────────────────────────────────────────────────────────────────────

export interface SemanticIntent {
  terms: string[];
  /** Papéis plausíveis. Papel fora da lista é penalizado, não proibido. */
  roles?: string[];
}

/**
 * Tabela pequena e explícita, por decisão. Resolução de alvo é passo determinístico:
 * se dependesse de um modelo, a mesma página daria alvos diferentes entre execuções
 * e nenhum teste de regressão significaria coisa alguma.
 *
 * Ordem importa: `intentFor` procura a chave literal primeiro e só depois varre os
 * termos — por isso `login` vem antes de `username` (ambos contêm o termo "login").
 */
export const SEMANTIC_INTENTS: Readonly<Record<string, SemanticIntent>> = Object.freeze({
  login: {
    terms: ["entrar", "login", "log in", "sign in", "signin", "acessar", "acesso", "conectar", "autenticar", "enter"],
    roles: ["button", "link"],
  },
  logout: {
    terms: ["sair", "logout", "log out", "sign out", "signout", "desconectar", "encerrar sessao", "deslogar"],
    roles: ["button", "link"],
  },
  submit: {
    terms: ["enviar", "submit", "confirmar", "confirm", "ok", "salvar", "save", "gravar", "aplicar", "apply"],
    roles: ["button"],
  },
  search: {
    terms: ["buscar", "procurar", "pesquisar", "search", "find", "localizar", "busca", "pesquisa"],
    roles: ["button", "textbox", "searchbox", "combobox"],
  },
  cancel: {
    terms: ["cancelar", "cancel", "descartar", "discard", "fechar", "close", "dispensar"],
    roles: ["button", "link"],
  },
  next: {
    terms: ["proximo", "avancar", "continuar", "next", "continue", "seguinte", "prosseguir"],
    roles: ["button", "link"],
  },
  previous: {
    terms: ["anterior", "voltar", "previous", "prev", "back", "retornar"],
    roles: ["button", "link"],
  },
  delete: {
    terms: ["excluir", "apagar", "remover", "deletar", "delete", "remove", "eliminar"],
    roles: ["button", "link"],
  },
  add: {
    terms: ["adicionar", "add", "novo", "nova", "new", "criar", "create", "incluir"],
    roles: ["button", "link"],
  },
  accept: {
    terms: ["aceitar", "accept", "concordar", "agree", "permitir", "allow", "aceito", "entendi"],
    roles: ["button"],
  },
  reject: {
    terms: ["recusar", "rejeitar", "reject", "decline", "negar", "deny", "nao aceito"],
    roles: ["button"],
  },
  username: {
    terms: ["usuario", "username", "user", "login", "conta", "account", "identificacao"],
    roles: ["textbox", "combobox"],
  },
  password: {
    terms: ["senha", "password", "passwd", "palavra passe", "pass"],
    roles: ["textbox"],
  },
  email: {
    terms: ["email", "e mail", "correio", "mail", "endereco de email"],
    roles: ["textbox"],
  },
  checkout: {
    terms: ["finalizar compra", "checkout", "pagar", "pay", "comprar", "buy", "fechar pedido", "finalizar pedido"],
    roles: ["button", "link"],
  },
  download: {
    terms: ["baixar", "download", "transferir", "obter arquivo"],
    roles: ["button", "link"],
  },
  upload: {
    terms: ["enviar arquivo", "upload", "carregar", "anexar", "attach", "escolher arquivo"],
    roles: ["button"],
  },
});

const EXACT_FIELD_SCORE = 100;
const CONTAIN_SCORE = 40;
const ROLE_BONUS = 10;
const ROLE_PENALTY = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Normalização
// ─────────────────────────────────────────────────────────────────────────────

/** Minúscula, sem acento, só alfanumérico separado por espaço. "Não-Aceito" → "nao aceito". */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Casamento por token, não por substring: "entrar" não pode casar dentro de "reentrar". */
function containsTerm(haystack: string, term: string): boolean {
  if (term === "" || haystack === "") return false;
  return ` ${haystack} `.includes(` ${term} `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Erro tipado
// ─────────────────────────────────────────────────────────────────────────────

export class TargetResolutionError extends Error {
  readonly code: ActionErrorCode;
  readonly attempted: TargetStrategy[];
  readonly trace: AttemptTrace[];
  readonly detail: Record<string, unknown>;

  constructor(
    code: ActionErrorCode,
    message: string,
    attempted: TargetStrategy[],
    trace: AttemptTrace[],
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TargetResolutionError";
    this.code = code;
    this.attempted = attempted;
    this.trace = trace;
    this.detail = detail;
  }

  /** Converte para o `error` do ActionResponse — o erro tem de chegar ao chamador inteiro. */
  toActionError(): ActionError {
    return {
      code: this.code,
      message: this.message,
      detail: { ...this.detail, attempted: this.attempted, trace: this.trace },
    };
  }
}

export function isTargetResolutionError(e: unknown): e is TargetResolutionError {
  return e instanceof TargetResolutionError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rastro
// ─────────────────────────────────────────────────────────────────────────────

export type AttemptOutcome = "hit" | "miss" | "skipped" | "ambiguous" | "error";

export interface AttemptTrace {
  strategy: TargetStrategy;
  outcome: AttemptOutcome;
  /** Sonda concreta executada (ex.: `getByRole(button, name="Entrar", exact)`). */
  probe: string;
  candidates: number;
  reason?: string;
  duration_ms: number;
}

export interface ResolveOptions {
  /** Adaptador de visão. Ausente ⇒ a etapa `vision` é PULADA e marcada como tal. */
  vision?: VisionProvider | null;
  /** Espera condicional aplicada só à primeira estratégia aplicável. 0 = sem espera. */
  timeout_ms?: number;
  vision_min_confidence?: number;
  max_candidates?: number;
}

export interface DetailedResolution {
  target: ResolvedTarget;
  trace: AttemptTrace[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Coleta de candidatos — uma única viagem ao navegador por sonda
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateMeta {
  index: number;
  visible: boolean;
  /** false quando o candidato CONTÉM outro candidato do mesmo conjunto. */
  innermost: boolean;
  tag: string;
  id: string | null;
  role: string | null;
  text: string;
  label: string;
  aria: string;
  placeholder: string;
  title: string;
  name: string;
  value: string;
  alt: string;
  type: string;
}

interface ProbeResult {
  total: number;
  items: CandidateMeta[];
}

/**
 * Roda DENTRO da página. Não pode fechar sobre nada do Node — só sobre `max`.
 * `innermost` existe porque motores de texto casam o ancestral junto com o elemento
 * (um `<p>` e o `<button>` dentro dele). Descartar o ancestral é reduzir ruído, não
 * escolher em silêncio: dois irmãos com o mesmo texto continuam ambíguos.
 */
const EXTRACT = (elements: (HTMLElement | SVGElement)[], max: number): ProbeResult => {
  const roleFor = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    return "";
  };

  const labelFor = (el: Element): string => {
    let out = "";
    if (el.id !== "") {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l !== null) out += ` ${l.textContent ?? ""}`;
    }
    const wrapping = el.closest("label");
    if (wrapping !== null) out += ` ${wrapping.textContent ?? ""}`;
    const by = el.getAttribute("aria-labelledby");
    if (by !== null) {
      for (const id of by.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n !== null) out += ` ${n.textContent ?? ""}`;
      }
    }
    return out;
  };

  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
  const slice = elements.slice(0, max);

  return {
    total: elements.length,
    items: slice.map((raw, i) => {
      const el = raw as unknown as Element;
      return {
        index: i,
        visible: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
        innermost: !slice.some((other, j) => j !== i && el.contains(other as unknown as Node)),
        tag: el.tagName.toLowerCase(),
        id: el.id === "" ? null : el.id,
        role: roleFor(el) === "" ? null : roleFor(el),
        text: clean((raw as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 200),
        label: clean(labelFor(el)).slice(0, 200),
        aria: el.getAttribute("aria-label") ?? "",
        placeholder: el.getAttribute("placeholder") ?? "",
        title: el.getAttribute("title") ?? "",
        name: el.getAttribute("name") ?? "",
        value: String((el as unknown as { value?: unknown }).value ?? "").slice(0, 120),
        alt: el.getAttribute("alt") ?? "",
        type: el.getAttribute("type") ?? "",
      };
    }),
  };
};

async function probe(loc: Locator, max: number): Promise<ProbeResult> {
  return await loc.evaluateAll(EXTRACT, max);
}

function describeMeta(m: CandidateMeta): string {
  const id = m.id === null ? "" : `#${m.id}`;
  const name = m.text !== "" ? m.text : m.aria !== "" ? m.aria : m.label !== "" ? m.label : m.placeholder;
  return `${m.tag}${id}${name === "" ? "" : ` "${name.slice(0, 40)}"`}`;
}

type Pick =
  | { kind: "hit"; index: number; meta: CandidateMeta }
  | { kind: "miss"; reason: string }
  | { kind: "ambiguous"; reason: string; count: number; samples: string[] };

/**
 * `nth` indexa o conjunto BRUTO em ordem de documento (o que o chamador viu),
 * não o conjunto já filtrado — filtrar antes de indexar mudaria o significado de
 * "a 3ª linha da tabela" sem avisar ninguém.
 */
function pickCandidate(res: ProbeResult, nth: number | undefined, max: number): Pick {
  if (res.total === 0) return { kind: "miss", reason: "nenhum candidato" };

  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 0) return { kind: "miss", reason: `nth inválido: ${String(nth)}` };
    if (nth >= res.total) return { kind: "miss", reason: `nth=${nth} fora do intervalo (total=${res.total})` };
    if (nth >= res.items.length) return { kind: "miss", reason: `nth=${nth} acima do teto de ${max} candidatos` };
    return { kind: "hit", index: nth, meta: res.items[nth]! };
  }

  if (res.total > res.items.length) {
    return {
      kind: "ambiguous",
      reason: `${res.total} candidatos (teto de inspeção ${max}) e nenhum nth`,
      count: res.total,
      samples: [],
    };
  }

  const usable = res.items.filter((i) => i.visible && i.innermost);
  if (usable.length === 0) {
    const invisiveis = res.items.filter((i) => !i.visible).length;
    return {
      kind: "miss",
      reason:
        invisiveis > 0
          ? `${res.total} candidato(s), nenhum visível`
          : `${res.total} candidato(s), nenhum utilizável`,
    };
  }
  if (usable.length > 1) {
    return {
      kind: "ambiguous",
      reason: `${usable.length} candidatos visíveis distintos e nenhum nth`,
      count: usable.length,
      samples: usable.slice(0, 5).map(describeMeta),
    };
  }
  return { kind: "hit", index: usable[0]!.index, meta: usable[0]! };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sondas por estratégia
// ─────────────────────────────────────────────────────────────────────────────

interface ProbeSpec {
  label: string;
  build: () => Locator;
}

type RoleArg = Parameters<Page["getByRole"]>[0];

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function probesFor(page: Page, d: TargetDescriptor, strategy: TargetStrategy): ProbeSpec[] {
  const out: ProbeSpec[] = [];
  switch (strategy) {
    case "selector":
      if (nonEmpty(d.selector)) out.push({ label: `locator(${d.selector})`, build: () => page.locator(d.selector!) });
      break;

    case "role_text":
      if (nonEmpty(d.role) && nonEmpty(d.text)) {
        out.push({
          label: `getByRole(${d.role}, name="${d.text}", exact)`,
          build: () => page.getByRole(d.role as RoleArg, { name: d.text!, exact: true }),
        });
        out.push({
          label: `getByRole(${d.role}, name="${d.text}")`,
          build: () => page.getByRole(d.role as RoleArg, { name: d.text! }),
        });
      }
      if (nonEmpty(d.text)) {
        out.push({ label: `getByText("${d.text}", exact)`, build: () => page.getByText(d.text!, { exact: true }) });
        out.push({ label: `getByText("${d.text}")`, build: () => page.getByText(d.text!) });
      }
      if (nonEmpty(d.role) && !nonEmpty(d.text)) {
        out.push({ label: `getByRole(${d.role})`, build: () => page.getByRole(d.role as RoleArg) });
      }
      break;

    case "accessibility":
      if (nonEmpty(d.label)) {
        out.push({ label: `getByLabel("${d.label}", exact)`, build: () => page.getByLabel(d.label!, { exact: true }) });
        out.push({ label: `getByLabel("${d.label}")`, build: () => page.getByLabel(d.label!) });
      }
      if (nonEmpty(d.placeholder)) {
        out.push({
          label: `getByPlaceholder("${d.placeholder}", exact)`,
          build: () => page.getByPlaceholder(d.placeholder!, { exact: true }),
        });
        out.push({
          label: `getByPlaceholder("${d.placeholder}")`,
          build: () => page.getByPlaceholder(d.placeholder!),
        });
      }
      if (nonEmpty(d.text)) {
        out.push({ label: `getByLabel("${d.text}")`, build: () => page.getByLabel(d.text!) });
        out.push({ label: `getByTitle("${d.text}")`, build: () => page.getByTitle(d.text!) });
        out.push({ label: `getByAltText("${d.text}")`, build: () => page.getByAltText(d.text!) });
      }
      break;

    default:
      break;
  }
  return out;
}

function applicable(d: TargetDescriptor, s: TargetStrategy): boolean {
  switch (s) {
    case "selector":
      return nonEmpty(d.selector);
    case "role_text":
      return nonEmpty(d.role) || nonEmpty(d.text);
    case "accessibility":
      return nonEmpty(d.label) || nonEmpty(d.placeholder) || nonEmpty(d.text);
    case "semantic":
      return nonEmpty(d.semantic);
    case "vision":
      return nonEmpty(visionGoal(d));
    case "coordinates":
      return (
        d.coordinates !== undefined &&
        d.coordinates !== null &&
        Number.isFinite(d.coordinates.x) &&
        Number.isFinite(d.coordinates.y)
      );
  }
}

function visionGoal(d: TargetDescriptor): string | undefined {
  return d.semantic ?? d.text ?? d.label ?? d.placeholder;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic — casamento determinístico por intenção
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedIntent {
  key: string;
  terms: string[];
  roles?: string[];
}

export function intentFor(semantic: string): ResolvedIntent {
  const n = normalize(semantic);
  const direct = SEMANTIC_INTENTS[n];
  if (direct !== undefined) return { key: n, terms: direct.terms.map(normalize), roles: direct.roles };
  for (const [key, intent] of Object.entries(SEMANTIC_INTENTS)) {
    if (intent.terms.some((t) => normalize(t) === n)) {
      return { key, terms: intent.terms.map(normalize), roles: intent.roles };
    }
  }
  // Intenção desconhecida não vira adivinhação: o próprio texto pedido vira o termo.
  return { key: "literal", terms: [n] };
}

export function scoreCandidate(intent: ResolvedIntent, c: CandidateMeta): number {
  const fields = [c.text, c.aria, c.label, c.placeholder, c.title, c.value, c.alt].map(normalize);
  const haystack = normalize([c.role ?? "", ...fields, c.name, c.id ?? ""].join(" "));

  let best = 0;
  for (const term of intent.terms) {
    if (term === "") continue;
    if (fields.some((f) => f !== "" && f === term)) best = Math.max(best, EXACT_FIELD_SCORE);
    else if (containsTerm(haystack, term)) best = Math.max(best, CONTAIN_SCORE);
  }
  if (best === 0) return 0;

  if (intent.roles !== undefined && intent.roles.length > 0) {
    best += intent.roles.includes(c.role ?? "") ? ROLE_BONUS : -ROLE_PENALTY;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execução de uma estratégia
// ─────────────────────────────────────────────────────────────────────────────

interface StrategyHit {
  kind: "hit";
  locator?: Locator;
  box: BoundingBox;
  description: string;
  probe: string;
  candidates: number;
}
interface StrategyMiss {
  kind: "miss";
  reason: string;
  probe: string;
  candidates: number;
  skipped?: boolean;
}
interface StrategyAmbiguous {
  kind: "ambiguous";
  reason: string;
  probe: string;
  candidates: number;
  samples: string[];
}
type StrategyOutcome = StrategyHit | StrategyMiss | StrategyAmbiguous;

async function finishHit(
  loc: Locator,
  index: number,
  meta: CandidateMeta,
  strategy: TargetStrategy,
  probeLabel: string,
  candidates: number,
): Promise<StrategyOutcome> {
  const target = loc.nth(index);
  const box = await target.boundingBox();
  if (box === null) {
    // Caixa nula = elemento não renderizado. Devolver {0,0,0,0} faria o Pointer Engine
    // clicar no canto da tela achando que acertou o alvo. Fail closed.
    return {
      kind: "miss",
      reason: `candidato ${describeMeta(meta)} sem caixa (não renderizado)`,
      probe: probeLabel,
      candidates,
    };
  }
  return {
    kind: "hit",
    locator: target,
    box,
    description: `${describeMeta(meta)} via ${strategy}`,
    probe: probeLabel,
    candidates,
  };
}

async function runLocatorStrategy(
  page: Page,
  d: TargetDescriptor,
  strategy: TargetStrategy,
  max: number,
): Promise<StrategyOutcome> {
  const specs = probesFor(page, d, strategy);
  if (specs.length === 0) {
    return { kind: "miss", reason: "sem sonda aplicável", probe: "—", candidates: 0 };
  }

  let last: StrategyOutcome = { kind: "miss", reason: "nenhuma sonda produziu candidato", probe: specs[0]!.label, candidates: 0 };
  for (const spec of specs) {
    let res: ProbeResult;
    try {
      res = await probe(spec.build(), max);
    } catch (e) {
      // Seletor inválido/role inexistente é FALHA REGISTRADA, não silêncio.
      last = { kind: "miss", reason: `sonda falhou: ${(e as Error).message.split("\n")[0]}`, probe: spec.label, candidates: 0 };
      continue;
    }
    const p = pickCandidate(res, d.nth, max);
    if (p.kind === "ambiguous") {
      return { kind: "ambiguous", reason: p.reason, probe: spec.label, candidates: p.count, samples: p.samples };
    }
    if (p.kind === "hit") {
      return await finishHit(spec.build(), p.index, p.meta, strategy, spec.label, res.total);
    }
    last = { kind: "miss", reason: p.reason, probe: spec.label, candidates: res.total };
  }
  return last;
}

async function runSemantic(page: Page, d: TargetDescriptor, max: number): Promise<StrategyOutcome> {
  const intent = intentFor(d.semantic!);
  const probeLabel = `semantic(${intent.key}) sobre ${INTERACTIVE_SELECTOR.split(",").length} tipos interativos`;
  let res: ProbeResult;
  try {
    res = await probe(page.locator(INTERACTIVE_SELECTOR), max);
  } catch (e) {
    return { kind: "miss", reason: `enumeração falhou: ${(e as Error).message.split("\n")[0]}`, probe: probeLabel, candidates: 0 };
  }
  if (res.total === 0) return { kind: "miss", reason: "página sem elementos interativos", probe: probeLabel, candidates: 0 };

  const scored = res.items
    .filter((i) => i.visible && i.innermost)
    .map((i) => ({ meta: i, score: scoreCandidate(intent, i) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.meta.index - b.meta.index);

  if (scored.length === 0) {
    return { kind: "miss", reason: `nenhum candidato casa a intenção "${intent.key}"`, probe: probeLabel, candidates: res.total };
  }

  const best = scored[0]!.score;
  const top = scored.filter((x) => x.score === best);
  if (top.length > 1) {
    if (d.nth !== undefined && Number.isInteger(d.nth) && d.nth >= 0 && d.nth < top.length) {
      const chosen = top[d.nth]!;
      return await finishHit(page.locator(INTERACTIVE_SELECTOR), chosen.meta.index, chosen.meta, "semantic", probeLabel, res.total);
    }
    return {
      kind: "ambiguous",
      reason: `${top.length} candidatos empatados em ${best} pontos para "${intent.key}" e nenhum nth`,
      probe: probeLabel,
      candidates: top.length,
      samples: top.slice(0, 5).map((x) => describeMeta(x.meta)),
    };
  }

  const chosen = top[0]!;
  return await finishHit(page.locator(INTERACTIVE_SELECTOR), chosen.meta.index, chosen.meta, "semantic", probeLabel, res.total);
}

async function runVision(
  page: Page,
  d: TargetDescriptor,
  provider: VisionProvider | null | undefined,
  minConfidence: number,
): Promise<StrategyOutcome> {
  const goal = visionGoal(d) ?? "";
  if (provider === null || provider === undefined) {
    // Registrada na cascata, marcada como PULADA. Fingir que tentou seria fabricar
    // uma tentativa que nunca existiu — o rastro passaria a mentir.
    return { kind: "miss", reason: "nenhum VisionProvider injetado", probe: `vision("${goal}")`, candidates: 0, skipped: true };
  }
  const probeLabel = `vision:${provider.name}("${goal}")`;
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  let found: { box: BoundingBox; confidence: number } | null;
  try {
    const screenshot = await page.screenshot();
    found = await provider.locate({ screenshot, goal, viewport });
  } catch (e) {
    return { kind: "miss", reason: `provider falhou: ${(e as Error).message.split("\n")[0]}`, probe: probeLabel, candidates: 0 };
  }
  if (found === null) return { kind: "miss", reason: "provider não localizou o alvo", probe: probeLabel, candidates: 0 };
  if (found.confidence < minConfidence) {
    return {
      kind: "miss",
      reason: `confiança ${found.confidence.toFixed(2)} abaixo do mínimo ${minConfidence.toFixed(2)}`,
      probe: probeLabel,
      candidates: 1,
    };
  }
  return {
    kind: "hit",
    box: found.box,
    description: `região apontada por ${provider.name} (confiança ${found.confidence.toFixed(2)}) via vision`,
    probe: probeLabel,
    candidates: 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascata
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveDetailed(
  page: Page,
  descriptor: TargetDescriptor,
  opts: ResolveOptions = {},
): Promise<DetailedResolution> {
  const max = opts.max_candidates ?? DEFAULT_MAX_CANDIDATES;
  const minConf = opts.vision_min_confidence ?? DEFAULT_VISION_MIN_CONFIDENCE;
  const trace: AttemptTrace[] = [];
  const attempted: TargetStrategy[] = [];

  const plan = CASCADE.filter((s) => applicable(descriptor, s));
  if (plan.length === 0) {
    throw new TargetResolutionError(
      "INVALID_REQUEST",
      "TargetDescriptor vazio: nenhuma estratégia da cascata é aplicável",
      [],
      [],
      { descriptor },
    );
  }
  const first = plan[0]!;

  // Espera CONDICIONAL (não sleep): dá à primeira estratégia pedida a chance de
  // a página terminar de montar antes de declararmos que ela falhou e curar.
  if ((opts.timeout_ms ?? 0) > 0) {
    const specs = probesFor(page, descriptor, first);
    if (specs.length > 0) {
      try {
        await specs[0]!.build().first().waitFor({ state: "attached", timeout: opts.timeout_ms });
      } catch {
        // Ausência após a espera é resultado legítimo — a cascata trata e registra.
      }
    }
  }

  for (const strategy of plan) {
    attempted.push(strategy);
    const t0 = Date.now();
    let outcome: StrategyOutcome;

    if (strategy === "semantic") {
      outcome = await runSemantic(page, descriptor, max);
    } else if (strategy === "vision") {
      outcome = await runVision(page, descriptor, opts.vision, minConf);
    } else if (strategy === "coordinates") {
      const c = descriptor.coordinates!;
      const soZinha = plan.length === 1;
      outcome = {
        kind: "hit",
        box: { x: c.x, y: c.y, width: 0, height: 0 },
        description: soZinha
          ? `coordenada (${c.x}, ${c.y}) — único alvo informado, via coordinates`
          : `coordenada (${c.x}, ${c.y}) — último recurso após ${plan.length - 1} estratégia(s) falharem, via coordinates`,
        probe: `coordinates(${c.x}, ${c.y})`,
        candidates: 1,
      };
    } else {
      outcome = await runLocatorStrategy(page, descriptor, strategy, max);
    }

    const duration_ms = Date.now() - t0;

    if (outcome.kind === "ambiguous") {
      trace.push({
        strategy,
        outcome: "ambiguous",
        probe: outcome.probe,
        candidates: outcome.candidates,
        reason: outcome.reason,
        duration_ms,
      });
      // Ambiguidade ENCERRA a cascata. Continuar seria trocar de estratégia depois
      // de já ter visto dois candidatos legítimos — e agir sobre o que a próxima
      // estratégia devolvesse é escolher em silêncio por outro caminho.
      throw new TargetResolutionError(
        "TARGET_AMBIGUOUS",
        `alvo ambíguo em "${strategy}": ${outcome.reason}`,
        [...attempted],
        trace,
        { descriptor, candidates: outcome.candidates, samples: outcome.samples, dica: "informe `nth` ou refine o alvo" },
      );
    }

    if (outcome.kind === "hit") {
      trace.push({ strategy, outcome: "hit", probe: outcome.probe, candidates: outcome.candidates, duration_ms });
      return {
        target: {
          strategy,
          attempted: [...attempted],
          box: outcome.box,
          handle: outcome.locator,
          description: outcome.description,
          // FASE 15: curou quando quem acertou não foi a primeira estratégia pedida.
          healed: strategy !== first,
        },
        trace,
      };
    }

    trace.push({
      strategy,
      outcome: outcome.skipped === true ? "skipped" : "miss",
      probe: outcome.probe,
      candidates: outcome.candidates,
      reason: outcome.reason,
      duration_ms,
    });
  }

  throw new TargetResolutionError(
    "TARGET_NOT_FOUND",
    `alvo não resolvido após ${attempted.length} estratégia(s): ${attempted.join(" → ")}`,
    [...attempted],
    trace,
    { descriptor },
  );
}

export async function resolveTarget(
  page: Page,
  descriptor: TargetDescriptor,
  opts: ResolveOptions = {},
): Promise<ResolvedTarget> {
  return (await resolveDetailed(page, descriptor, opts)).target;
}

export const TargetResolver = {
  cascade: CASCADE,
  resolve: resolveTarget,
  resolveDetailed,
  intentFor,
  normalize,
} as const;
