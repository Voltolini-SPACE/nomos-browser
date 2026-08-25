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
 * FASE 6b — REFINO POR RECORTE.
 *
 * O DEFEITO MEDIDO: `qwen2.5vl:3b` sobre a tela inteira (1280x800) superestima a
 * largura do alvo ~1,8x e desloca y ~+30 px. Num alvo de 160x100 o centro da
 * caixa cai 9 px FORA da borda direita — o clique erra.
 *
 * A CAUSA: o codificador visual de um VL pequeno reamostra a imagem para uma
 * grade fixa. Um alvo de 160 px numa imagem de 1280 px ocupa 12% da largura;
 * depois da reamostragem sobram pouquíssimos patches sobre ele, e o erro
 * ABSOLUTO cresce com o tamanho da IMAGEM, não com o do alvo.
 *
 * A HIPÓTESE: perguntar duas vezes. A 1ª passada localiza grosso na tela
 * inteira; a 2ª repete a MESMA pergunta sobre um RECORTE em volta da estimativa,
 * onde o alvo ocupa uma fração maior da imagem.
 *
 * A HIPÓTESE FOI REFUTADA PELA MEDIÇÃO, DUAS VEZES, e o default segue a medição.
 *
 * (a) Sob o prompt ANTIGO (que pedia `box: {x,y,width,height}`), 3 tamanhos ×
 *     3 ajustes × 3 execuções — erro do centro em px (mediana), "dentro":
 *
 *       tamanho          passes=0            passes=1            passes=2
 *       grande 320x200   65,6px  3/3         121,7px  3/3        40,8px  3/3
 *       medio  160x100   82,6px  3/3         161,8px  0/3 FORA   77,5px  3/3
 *       pequeno 80x50    22,9px  3/3          23,6px  3/3        23,6px  3/3
 *
 * (b) Sob o prompt ATUAL (FASE 6c, `bbox_2d`+`point_2d`), com `point_then_box`:
 *
 *       tamanho          passes=0            passes=1
 *       grande 320x200    4,5px  2/2          59,2px  2/2   (piorou 13x)
 *       medio  160x100    4,1px  2/2           4,1px  2/2   (refino REJEITADO)
 *       pequeno 80x50     2,8px  2/2           2,8px  2/2   (refino REJEITADO)
 *
 * Recortar NÃO amplia: o alvo continua com os mesmos pixels. Sob o prompt novo
 * o erro já é de ~4px, então não sobra nada para o refino corrigir — ele só
 * arrisca. Nos dois regimes, uma passada é neutra ou pior.
 *
 * ATENÇÃO ao ler a tabela (a): aqueles 65-82px de erro eram do PROMPT, não do
 * modelo. Ver `visionPrompt` em `vision.ts` — pedir o esquema nativo
 * (`bbox_2d` em cantos) derrubou o erro de 82,6px para 5,0px no mesmo alvo,
 * com a mesma imagem e o mesmo modelo. A tabela (a) fica registrada porque foi
 * o que motivou o refino, não porque ainda descreva o produto.
 *
 * Default `0`: ligar por default um degrau que a medição mostra neutro-ou-pior
 * nos dois regimes seria melhorar por intuição. A capacidade fica disponível,
 * medida e auditável, para quem tiver outro modelo ou outra página.
 */
export const DEFAULT_VISION_REFINE_PASSES = 0;
export const MAX_VISION_REFINE_PASSES = 2;
export const DEFAULT_VISION_REFINE_FACTOR = 2.5;
/** Abaixo disto o recorte é menor que o próprio ruído do modelo. */
export const MIN_LADO_DE_RECORTE_PX = 32;
/** Lado mínimo de uma caixa REFINADA. Menor que isso é ruído, não alvo. */
export const MIN_BOX_SIDE_DE_REFINO = 2;
/** Mudança relativa abaixo da qual as passadas convergiram e param. */
export const REFINO_CONVERGENCIA = 0.02;

/**
 * FASE 6c — ONDE MIRAR dentro do que a visão devolveu. Ver `VisionAim` em
 * `vision.ts`; o tipo é redeclarado aqui como união literal porque `vision.ts`
 * IMPORTA este módulo, e importar de volta fecharia um ciclo.
 *
 * MEDIDO (`medir-refino.ts`, dimensão `aim`; `qwen2.5vl:3b`, seed fixo,
 * `refine_passes=0`, 3 tamanhos × 3 modos × 3 execuções). Erro do ponto mirado
 * até o centro do alvo (mediana) e MARGEM até a borda mais próxima:
 *
 *   tamanho          box_center        point             point_then_box
 *   grande 320x200   4,2px  m=97px     4,5px  m=98px     4,5px  m=98px
 *   medio  160x100   5,0px  m=46px     4,1px  m=49px     4,1px  m=49px
 *   pequeno 80x50    5,4px  m=22px     2,8px  m=23px     2,8px  m=23px
 *
 * Todos 3/3 dentro do alvo, todos estáveis entre execuções, 1 inferência.
 *
 * `point` vence nos dois tamanhos menores (4,1 vs 5,0 e 2,8 vs 5,4) e perde por
 * 0,3px no maior — ruído. `point_then_box` empatou com `point` em TODAS as
 * células porque o ponto sempre caiu dentro da caixa; ele é o default por
 * carregar a rede de proteção de graça: sem ponto, ou com o modelo se
 * contradizendo, cai no centro da caixa em vez de falhar.
 */
export type AimMode = "box_center" | "point" | "point_then_box";
export const DEFAULT_VISION_AIM: AimMode = "point_then_box";

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

/**
 * Registro do refino por recorte. Vai INTEIRO para `AttemptTrace.detail` do
 * degrau `vision`: gastar uma segunda inferência é uma decisão, e decisão sem
 * rastro é decisão que ninguém pode contestar depois.
 */
export interface RefinoTrace {
  /** Passadas de refino ACEITAS (0 = só a estimativa grosseira valeu). */
  passadas: number;
  /** Caixa da 1ª passada, em CSS px do viewport. */
  box_p1: BoundingBox;
  /** Caixa final. Igual a `box_p1` quando nenhum refino foi aceito. */
  box_refinada: BoundingBox;
  /** Distância entre os centros de `box_p1` e `box_refinada`. */
  deslocamento_px: number;
  /** área(p1) / área(refinada). > 1 = o refino ENCOLHEU a caixa. */
  area_ratio_p1_p2: number;
  refino: "usado" | "rejeitado" | "desligado";
  motivo: string | null;
  /** Inferências gastas no degrau, refino incluído. */
  inferencias: number;
  regiao_de_recorte: BoundingBox | null;
  /** Modo pedido pela configuração. */
  aim_modo: AimMode;
  /** O que de fato mirou. `point` só quando havia ponto utilizável. */
  aim: "point" | "box_center";
  /** Ponto CRU do modelo, em CSS px do viewport. `null` = não veio. */
  aim_point: { x: number; y: number } | null;
  /** Caixa CRUA do modelo, antes de qualquer recentragem pela mira. */
  aim_box_bruta: BoundingBox;
  /** Por que a mira caiu no centro da caixa, quando caiu. */
  aim_motivo: string | null;
}

export interface AttemptTrace {
  strategy: TargetStrategy;
  outcome: AttemptOutcome;
  /** Sonda concreta executada (ex.: `getByRole(button, name="Entrar", exact)`). */
  probe: string;
  candidates: number;
  reason?: string;
  duration_ms: number;
  /** Estruturado e específico do degrau. Hoje só `vision` preenche (`RefinoTrace`). */
  detail?: Record<string, unknown>;
}

export interface ResolveOptions {
  /** Adaptador de visão. Ausente ⇒ a etapa `vision` é PULADA e marcada como tal. */
  vision?: VisionProvider | null;
  /** Espera condicional aplicada só à primeira estratégia aplicável. 0 = sem espera. */
  timeout_ms?: number;
  vision_min_confidence?: number;
  max_candidates?: number;
  /**
   * Passadas de REFINO por recorte (0..2). Ausente ⇒ o resolvedor pergunta ao
   * PRÓPRIO provider (`refine_passes`), e só então cai no default.
   *
   * A ordem é essa porque quem configura a visão é o dono, e o objeto que ele
   * configurou é o provider — mandar a política por fora do provider obrigaria
   * cada chamador da cascata a repassá-la, e o primeiro que esquecesse voltaria
   * a clicar na estimativa grosseira sem ninguém perceber.
   */
  vision_refine_passes?: number;
  /** Lado do recorte = maior lado da caixa × isto. Ver `MIN_LADO_DE_RECORTE_PX`. */
  vision_refine_factor?: number;
  /** Onde mirar dentro do que a visão devolveu. Mesma precedência do refino. */
  vision_aim?: AimMode;
}

/**
 * Provider que declara a própria política de refino. Opcional e estrutural: um
 * `VisionProvider` do contrato v1 continua válido sem isto.
 */
export interface ComPoliticaDeRefino {
  readonly refine_passes?: number;
  readonly refine_factor?: number;
  /** Ver `AimMode`. */
  readonly aim?: AimMode;
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
  /** Detalhe estruturado do degrau. Hoje só `vision` preenche (`RefinoTrace`). */
  detail?: Record<string, unknown>;
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

/**
 * Largura e altura de um PNG, lidas do IHDR. `null` quando não é PNG.
 *
 * Oito linhas em vez de uma dependência: o cabeçalho PNG é fixo — assinatura de
 * 8 bytes, depois o IHDR com largura e altura em big-endian nos offsets 16 e 20.
 */
function dimensoesPng(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Distância entre os centros de duas caixas, em px. */
function distanciaDeCentros(a: BoundingBox, b: BoundingBox): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return Math.hypot(dx, dy);
}

function areaDe(b: BoundingBox): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

/** Converte uma caixa do referencial da IMAGEM para CSS px, dividindo pela escala. */
function paraCss(b: BoundingBox, escala: number): BoundingBox {
  if (escala === 1) return { x: b.x, y: b.y, width: b.width, height: b.height };
  return { x: b.x / escala, y: b.y / escala, width: b.width / escala, height: b.height / escala };
}

/**
 * Região quadrada centrada na estimativa, com margem, presa às bordas do
 * viewport.
 *
 * QUADRADA de propósito: o codificador visual reamostra para uma grade, e um
 * recorte muito alongado desperdiça patches na dimensão longa — que é
 * justamente o eixo em que este modelo já superestima.
 *
 * PRESA às bordas, não deslizante: um recorte que sai do viewport faria o
 * Playwright recusar a captura ("clipped area outside the resulting image"), e
 * um alvo colado na borda é o caso comum, não a exceção.
 */
function regiaoDeRecorte(
  b: BoundingBox,
  fator: number,
  viewport: { width: number; height: number },
): BoundingBox | null {
  const maiorLado = Math.max(b.width, b.height);
  if (!Number.isFinite(maiorLado) || maiorLado <= 0) return null;
  const teto = Math.min(viewport.width, viewport.height);
  const lado = Math.min(Math.max(maiorLado * fator, MIN_LADO_DE_RECORTE_PX), teto);
  if (lado < MIN_LADO_DE_RECORTE_PX || lado <= 0) return null;
  // Recorte do tamanho do viewport não é recorte: seria gastar uma inferência
  // para repetir exatamente a pergunta da 1ª passada.
  if (lado >= viewport.width && lado >= viewport.height) return null;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const x = Math.min(Math.max(cx - lado / 2, 0), Math.max(viewport.width - lado, 0));
  const y = Math.min(Math.max(cy - lado / 2, 0), Math.max(viewport.height - lado, 0));
  // Inteiros: `clip` fracionário produz imagem de tamanho arredondado e a
  // escala de volta deixaria de fechar.
  return { x: Math.round(x), y: Math.round(y), width: Math.round(lado), height: Math.round(lado) };
}

/**
 * Ponto de mira de uma resposta de visão, se houver.
 *
 * Leitura DEFENSIVA e por duck typing: o contrato v1 de `VisionProvider.locate`
 * promete `{box, confidence}` e nada mais. Um provider rico (`vision.ts`)
 * devolve também `point`; um provider de terceiro pode não devolver. Exigir o
 * campo no tipo quebraria o contrato; ignorá-lo desperdiçaria a informação mais
 * precisa que este modelo produz.
 */
function pontoDaResposta(v: unknown): { x: number; y: number } | null {
  if (v === null || typeof v !== "object") return null;
  const p = (v as { point?: unknown }).point;
  if (p === null || typeof p !== "object") return null;
  const x = (p as { x?: unknown }).x;
  const y = (p as { y?: unknown }).y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function pontoDentroDaCaixa(p: { x: number; y: number }, b: BoundingBox, tol = 0): boolean {
  return p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol;
}

/** Caixa `b` cabe em `r`? Tolerância de 1 px para arredondamento do recorte. */
function contidaEm(b: BoundingBox, r: BoundingBox, tol = 1): boolean {
  return (
    b.x >= r.x - tol &&
    b.y >= r.y - tol &&
    b.x + b.width <= r.x + r.width + tol &&
    b.y + b.height <= r.y + r.height + tol
  );
}

async function runVision(
  page: Page,
  d: TargetDescriptor,
  provider: VisionProvider | null | undefined,
  minConfidence: number,
  refinePasses: number,
  refineFactor: number,
  aimModo: AimMode,
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
  let escala = 1;
  try {
    const screenshot = await page.screenshot();

    /**
     * DEFEITO MEDIDO (FASE 6): o runtime mentia para o modelo em DPR ≠ 1.
     *
     *   deviceScaleFactor=1 → viewportSize 1280x800, PNG 1280x800
     *   deviceScaleFactor=2 → viewportSize 1280x800, PNG 2560x1600
     *
     * `page.screenshot()` devolve PIXELS DE DISPOSITIVO; `viewportSize()`
     * devolve CSS px. O código antigo entregava a imagem de 2560x1600 e dizia
     * ao modelo "esta captura tem 1280x800" — depois tratava a resposta, que
     * vem no referencial da IMAGEM, como se fosse CSS px. Em DPR 2 toda
     * coordenada saía com metade do valor certo, e o clique caía longe (ou a
     * caixa era recusada por sair do viewport).
     *
     * O buraco só não tinha vítima porque o degrau `vision` NUNCA executava em
     * produção — é a mesma ausência de injeção que esta fase fecha. Ligar a
     * visão sem isto seria trocar um defeito silencioso por um ativo.
     *
     * Conserto: dizer ao modelo o tamanho REAL da imagem que ele recebeu, e
     * converter a caixa de volta para CSS px pela escala medida. Em DPR 1 a
     * escala é 1 e nada muda.
     */
    const imagem = dimensoesPng(screenshot);
    if (imagem !== null && viewport.width > 0) escala = imagem.width / viewport.width;
    if (!Number.isFinite(escala) || escala <= 0) escala = 1;
    found = await provider.locate({ screenshot, goal, viewport: imagem ?? viewport });
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
  // Caixa da 1ª passada, já em CSS px do viewport.
  const boxP1 = paraCss(found.box, escala);
  // O ponto vem no MESMO referencial da caixa (pixels da imagem) e sofre a
  // MESMA conversão. Converter um e não o outro é como o defeito de DPR da
  // FASE 6, só que mais silencioso.
  const p1 = pontoDaResposta(found);
  let pontoAtual: { x: number; y: number } | null =
    p1 === null ? null : { x: p1.x / escala, y: p1.y / escala };

  // ── REFINO POR RECORTE ────────────────────────────────────────────────────
  const passesMax = Math.min(Math.max(Math.trunc(refinePasses), 0), MAX_VISION_REFINE_PASSES);
  const fator = Number.isFinite(refineFactor) && refineFactor > 1 ? refineFactor : DEFAULT_VISION_REFINE_FACTOR;
  const refino: RefinoTrace = {
    passadas: 0,
    box_p1: boxP1,
    box_refinada: boxP1,
    deslocamento_px: 0,
    area_ratio_p1_p2: 1,
    refino: passesMax === 0 ? "desligado" : "rejeitado",
    motivo: passesMax === 0 ? "vision_refine_passes = 0" : null,
    inferencias: 1,
    regiao_de_recorte: null,
    aim_modo: aimModo,
    aim: "box_center",
    aim_point: null,
    aim_box_bruta: boxP1,
    aim_motivo: null,
  };
  let confianca = found.confidence;
  let atual = boxP1;

  for (let passada = 1; passada <= passesMax; passada += 1) {
    const R = regiaoDeRecorte(atual, fator, viewport);
    if (R === null) {
      refino.motivo = "região de recorte degenerada ou do tamanho do viewport";
      break;
    }
    refino.regiao_de_recorte = R;

    let candidato: BoundingBox | null = null;
    let candidatoPonto: { x: number; y: number } | null = null;
    try {
      // `clip` do Playwright é em CSS px do VIEWPORT (medido: um clip em
      // coordenadas de PÁGINA numa página rolada é recusado com "clipped area
      // outside the resulting image"). A imagem devolvida tem clip×DPR pixels,
      // então a escala de volta é a mesma normalização da 1ª passada.
      const recorte = await page.screenshot({ clip: R });
      const dimsC = dimensoesPng(recorte);
      let escalaC = 1;
      if (dimsC !== null && R.width > 0) escalaC = dimsC.width / R.width;
      if (!Number.isFinite(escalaC) || escalaC <= 0) escalaC = 1;
      refino.inferencias += 1;
      const achado = await provider.locate({
        screenshot: recorte,
        goal,
        viewport: dimsC ?? { width: R.width, height: R.height },
      });
      if (achado === null) {
        refino.motivo = "provider não localizou o alvo no recorte";
        break;
      }
      if (achado.confidence < minConfidence) {
        refino.motivo = `confiança ${achado.confidence.toFixed(2)} no recorte abaixo do mínimo ${minConfidence.toFixed(2)}`;
        break;
      }
      const noRecorte = paraCss(achado.box, escalaC);
      candidato = {
        x: R.x + noRecorte.x,
        y: R.y + noRecorte.y,
        width: noRecorte.width,
        height: noRecorte.height,
      };
      const pN = pontoDaResposta(achado);
      candidatoPonto =
        pN === null ? null : { x: R.x + pN.x / escalaC, y: R.y + pN.y / escalaC };
      confianca = achado.confidence;
    } catch (e) {
      refino.motivo = `recorte falhou: ${(e as Error).message.split("\n")[0]}`;
      break;
    }

    // CRITÉRIO DE ACEITE. Uma caixa que não cabe no recorte que a produziu, ou
    // que ocupa o recorte inteiro, não é refinamento — é o modelo dizendo "está
    // em algum lugar aí". Nesse caso a estimativa grosseira, que ao menos viu a
    // página toda, é a resposta menos ruim.
    if (candidato.width < MIN_BOX_SIDE_DE_REFINO || candidato.height < MIN_BOX_SIDE_DE_REFINO) {
      refino.motivo = "caixa refinada degenerada (lado sub-pixel)";
      break;
    }
    if (!contidaEm(candidato, R)) {
      refino.motivo = "caixa refinada não cabe na região recortada";
      break;
    }
    if (areaDe(candidato) > areaDe(R)) {
      refino.motivo = "caixa refinada maior que a região recortada";
      break;
    }

    const mudanca = distanciaDeCentros(candidato, atual) / Math.max(R.width, 1);
    atual = candidato;
    // O ponto acompanha a caixa que foi ACEITA. Guardar o ponto de uma passada
    // e a caixa de outra misturaria duas leituras diferentes da mesma tela.
    pontoAtual = candidatoPonto;
    refino.passadas = passada;
    refino.refino = "usado";
    refino.motivo = null;
    if (mudanca < REFINO_CONVERGENCIA) {
      refino.motivo = `convergiu: centro moveu ${(mudanca * 100).toFixed(1)}% do recorte`;
      break;
    }
  }

  refino.box_refinada = atual;
  refino.deslocamento_px = Number(distanciaDeCentros(atual, boxP1).toFixed(2));
  refino.area_ratio_p1_p2 = Number((areaDe(boxP1) / Math.max(areaDe(atual), 1)).toFixed(3));

  // ── MIRA (FASE 6c) ────────────────────────────────────────────────────────
  //
  // A cascata devolve UMA caixa, e quem clica usa o CENTRO dela. Para mirar no
  // ponto sem mudar essa convenção — e sem tocar no caminho do clique — a caixa
  // é RECENTRADA no ponto, preservando a extensão estimada pelo modelo. O que
  // muda é onde o gesto cai; o tamanho continua sendo o palpite do modelo, e o
  // rastro guarda a caixa CRUA e o ponto CRU para que nada disso seja opaco.
  refino.aim_modo = aimModo;
  refino.aim_box_bruta = atual;
  refino.aim_point = pontoAtual;

  let alvoFinal = atual;
  if (aimModo === "box_center") {
    refino.aim = "box_center";
    refino.aim_motivo = "configuração pede o centro da caixa";
  } else if (pontoAtual === null) {
    refino.aim = "box_center";
    refino.aim_motivo = "modelo não devolveu point_2d utilizável";
  } else if (aimModo === "point_then_box" && !pontoDentroDaCaixa(pontoAtual, atual)) {
    // Ponto fora da própria caixa que o modelo desenhou é o modelo se
    // contradizendo. `point_then_box` prefere a resposta em que as duas
    // leituras concordam; `point` puro confia no ponto e assume o risco.
    refino.aim = "box_center";
    refino.aim_motivo = "point_2d cai fora da bbox_2d do próprio modelo";
  } else {
    refino.aim = "point";
    refino.aim_motivo = null;
    alvoFinal = {
      x: pontoAtual.x - atual.width / 2,
      y: pontoAtual.y - atual.height / 2,
      width: atual.width,
      height: atual.height,
    };
  }

  return {
    kind: "hit",
    box: alvoFinal,
    description:
      `região apontada por ${provider.name} (confiança ${confianca.toFixed(2)}) via vision` +
      (escala === 1 ? "" : ` — caixa convertida de pixels de imagem para CSS px (escala ${escala})`) +
      (refino.refino === "usado"
        ? ` — refinada em ${refino.passadas} passada(s) de recorte (${refino.inferencias} inferências, centro moveu ${refino.deslocamento_px}px)`
        : "") +
      (refino.aim === "point"
        ? ` — mirando o point_2d (${Math.round(refino.aim_point!.x)}, ${Math.round(refino.aim_point!.y)})`
        : ` — mirando o centro da caixa (${refino.aim_motivo ?? "?"})`),
    probe: probeLabel,
    candidates: 1,
    detail: refino as unknown as Record<string, unknown>,
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
  // Precedência do refino: opção explícita → política DO PRÓPRIO PROVIDER → default.
  // O provider é o objeto que o dono configurou; perguntar a ele evita que a
  // política tenha de ser repassada por todo chamador da cascata (e que o
  // primeiro que esquecesse voltasse a clicar na estimativa grosseira).
  const politica = (opts.vision ?? null) as ComPoliticaDeRefino | null;
  const refinePasses = opts.vision_refine_passes ?? politica?.refine_passes ?? DEFAULT_VISION_REFINE_PASSES;
  const refineFactor = opts.vision_refine_factor ?? politica?.refine_factor ?? DEFAULT_VISION_REFINE_FACTOR;
  const aimModo = opts.vision_aim ?? politica?.aim ?? DEFAULT_VISION_AIM;
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
      outcome = await runVision(page, descriptor, opts.vision, minConf, refinePasses, refineFactor, aimModo);
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
      trace.push({
        strategy,
        outcome: "hit",
        probe: outcome.probe,
        candidates: outcome.candidates,
        duration_ms,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      });
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
