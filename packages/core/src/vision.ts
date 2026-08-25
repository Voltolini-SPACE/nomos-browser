/**
 * FASE 2/3/4 — VISÃO DESACOPLADA, POLÍTICA DE FALLBACK E PROVAS NEGATIVAS
 *
 * Três peças, um único compromisso: **visão nunca vira coordenada de clique sem
 * passar por uma verificação mecânica**. Um modelo multimodal é um palpiteiro
 * eloquente; ele produz texto convincente mesmo quando não viu nada. Este módulo
 * existe para transformar esse palpite em algo que pode FALHAR de forma visível.
 *
 * Decisões que valem explicação:
 *
 *  1. ESTENDE, NÃO REDEFINE. `contract.ts` declara `VisionProvider` com um único
 *     verbo `locate()` que devolve `{box, confidence}`. Esse contrato é v1 e é
 *     fechado. `RichVisionProvider` o ESTENDE: `locate()` continua compatível
 *     (o objeto devolvido continua tendo `box` e `confidence`) e ganha `observe()`
 *     com o resultado auditável. Consequência prática: o `TargetResolver` da
 *     FASE 13 aceita um provider rico sem uma linha de mudança — provado em teste.
 *
 *  2. `reason` É AUDITORIA, NUNCA DECISÃO. O texto do modelo entra no registro
 *     para o humano ler depois. Nenhum ramo de código deste arquivo lê `reason`
 *     para decidir. Se decidisse, a página passaria a poder dirigir o runtime
 *     escrevendo texto (SECURITY.md, T1).
 *
 *  3. `image_hash` EXISTE PARA A OBSERVAÇÃO PODER ENVELHECER. Sem ele, uma
 *     caixa calculada sobre um screenshot de 8 segundos atrás é indistinguível
 *     de uma caixa calculada agora — e clicar com base na primeira é clicar no
 *     lugar onde o botão ESTAVA.
 *
 *  4. FAIL CLOSED NO PARSING. Texto livre, JSON quebrado, caixa degenerada,
 *     confiança ausente, array de 4 números de convenção ambígua: tudo isso
 *     devolve `null` e fica registrado em `rejectionLog()`. Nada aqui inventa
 *     coordenada, e nada aqui escreve em stdout/stderr.
 *
 *  5. CÓDIGOS PRÓPRIOS, MAPEADOS NA FRONTEIRA. `ActionErrorCode` é enum fechado
 *     do contrato v1 e não pode crescer aqui. `VisionOutcome` é o vocabulário
 *     interno desta fase; `VISION_OUTCOME_TO_ACTION_ERROR` é a tradução, e o
 *     `detail` do erro sempre carrega o outcome original para que a tradução
 *     seja lossy no CÓDIGO, nunca na EVIDÊNCIA. Fechar isso direito exige v2.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import {
  type ActionError,
  type ActionErrorCode,
  type BoundingBox,
  type ResolvedTarget,
  type TargetDescriptor,
  type TargetStrategy,
  type VisionProvider,
  nowIso,
} from "./contract.ts";
import { TargetResolver, isTargetResolutionError, type AttemptTrace } from "./target.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Cascata normativa da FASE 3. Visão é o 4º degrau, humano é o 5º. */
export const VISION_CASCADE: readonly VisionRung[] = Object.freeze([
  "dom",
  "accessibility",
  "semantic",
  "vision",
  "human",
] as const);

export const DEFAULT_VISION_THRESHOLD = 0.7;

/**
 * FASE 6c — ONDE MIRAR dentro do que a visão devolveu.
 *
 *   box_center       centro da caixa estimada (comportamento histórico)
 *   point            o ponto que o modelo apontou; sem ponto, falha o degrau
 *   point_then_box   usa o ponto quando ele existe E cai dentro da caixa;
 *                    senão, centro da caixa
 *
 * A distinção existe por uma medição: `qwen2.5vl:3b` erra a LARGURA da caixa em
 * ~1,8x, e o centro de uma caixa inflada escorrega para fora do alvo. A família
 * Qwen2.5-VL é treinada para APONTAR (`point_2d`) além de CAIXAR (`bbox_2d`), e
 * a hipótese é que o ponto não herde a inflação da caixa.
 */
export type VisionAim = "box_center" | "point" | "point_then_box";

export const VISION_AIMS: readonly VisionAim[] = Object.freeze(["box_center", "point", "point_then_box"]);

export function isVisionAim(v: unknown): v is VisionAim {
  return typeof v === "string" && (VISION_AIMS as readonly string[]).includes(v);
}
export const DEFAULT_VISION_TIMEOUT_MS = 20_000;
/** Caixa maior que isto não é um alvo, é a página. Palpite de modelo perdido. */
export const DEFAULT_MAX_AREA_FRACTION = 0.9;
/**
 * Lado mínimo de uma caixa clicável, em px CSS.
 *
 * Não é zelo teórico: MEDIDO. `moondream:1.8b`, num screenshot de 1280x800,
 * devolveu de forma reprodutível `{"x":0,"y":0,"width":0.8,"height":0.8,
 * "coordinate_space":"pixels"}` — números normalizados com o espaço declarado
 * como pixels, porque o modelo ECOOU o template do prompt. Sem este piso, uma
 * caixa de 0,64 px² viraria um clique em (0.4, 0.4), o canto da tela.
 */
export const MIN_BOX_SIDE_PX = 2;
/** Folga de arredondamento entre px CSS do DOM e px da caixa devolvida. */
export const VIEWPORT_TOLERANCE_PX = 0.5;

export const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

/**
 * Modelo padrão. NÃO é `moondream:1.8b`, apesar de ser o menor multimodal desta
 * máquina — ele foi REFUTADO por duas medições independentes:
 *
 *   - esta fase: num screenshot de 640x400 devolveu `{"found": true,
 *     "coordinate_space": "pixels", "confidence": 0.64, "reason": "</curto>"}`
 *     — afirmou ter encontrado o alvo SEM devolver caixa nenhuma; e num de
 *     1280x800 devolveu `0.8x0.8` px. Reprodutível nas duas resoluções.
 *   - `docs/VISION-PROVIDER.md` (FASE 5, outro caminho): string vazia para
 *     bounding box e para pointing.
 *
 * `qwen2.5vl:3b` produz caixa utilizável (erro de centro medido em ~4–5 px na
 * FASE 5). Fail closed continua valendo: se o modelo não estiver instalado, o
 * Ollama responde 404, o provider registra a recusa e devolve `null` — nunca
 * uma coordenada de consolo.
 */
export const DEFAULT_VISION_MODEL = "qwen2.5vl:3b";
export const MAX_REJECTION_LOG = 50;
export const EXCERPT_CAP = 160;

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulário de resultado
// ─────────────────────────────────────────────────────────────────────────────

export type VisionRung = "dom" | "accessibility" | "semantic" | "vision" | "human";

/**
 * Vocabulário PRÓPRIO desta fase. Nenhum destes existe em `ActionErrorCode`
 * (enum fechado do contrato v1) — ver `VISION_OUTCOME_TO_ACTION_ERROR`.
 */
export type VisionOutcome =
  | "RESOLVED"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "STALE_OBSERVATION"
  | "VISION_UNCERTAIN"
  | "BOX_OUT_OF_VIEWPORT"
  | "OVERLAY_OBSTRUCTED"
  | "HUMAN_REQUIRED"
  | "PROVIDER_ERROR"
  | "PROVIDER_TIMEOUT"
  | "INVALID_REQUEST";

/**
 * Tradução para a fronteira da API. É LOSSY de propósito e por obrigação: o
 * contrato v1 não tem código para "observação velha" nem para "escalar ao
 * humano". A perda fica só no CÓDIGO — `toActionError()` sempre repete o
 * outcome original dentro de `detail.vision_outcome`.
 *
 * Racional de cada linha:
 *  - STALE_OBSERVATION  → VERIFICATION_FAILED: a evidência que sustentava a ação
 *                         deixou de valer; é falha de verificação, não de busca.
 *  - VISION_UNCERTAIN   → TARGET_NOT_FOUND: o runtime não localizou o alvo com
 *                         confiança suficiente. Dizer "encontrei mas não confio"
 *                         não existe no v1, e arredondar para sucesso é proibido.
 *  - BOX_OUT_OF_VIEWPORT→ TARGET_NOT_FOUND: a caixa alegada não está na tela;
 *                         portanto o alvo não foi localizado NA TELA.
 *  - OVERLAY_OBSTRUCTED → VERIFICATION_FAILED: achamos a caixa, e a verificação
 *                         mecânica (elementFromPoint) refutou que clicar ali
 *                         atinja o alvo.
 *  - HUMAN_REQUIRED     → TARGET_NOT_FOUND: nenhum degrau automático resolveu.
 *                         O v1 não sabe dizer "escale para humano".
 *  - PROVIDER_TIMEOUT   → TIMEOUT, PROVIDER_ERROR → INTERNAL.
 */
export const VISION_OUTCOME_TO_ACTION_ERROR: Readonly<
  Record<Exclude<VisionOutcome, "RESOLVED">, ActionErrorCode>
> = Object.freeze({
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TARGET_AMBIGUOUS: "TARGET_AMBIGUOUS",
  STALE_OBSERVATION: "VERIFICATION_FAILED",
  VISION_UNCERTAIN: "TARGET_NOT_FOUND",
  BOX_OUT_OF_VIEWPORT: "TARGET_NOT_FOUND",
  OVERLAY_OBSTRUCTED: "VERIFICATION_FAILED",
  HUMAN_REQUIRED: "TARGET_NOT_FOUND",
  PROVIDER_ERROR: "INTERNAL",
  PROVIDER_TIMEOUT: "TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
});

export function actionErrorCodeFor(outcome: VisionOutcome): ActionErrorCode {
  if (outcome === "RESOLVED") {
    throw new VisionError("INVALID_REQUEST", "RESOLVED não é erro e não tem ActionErrorCode");
  }
  return VISION_OUTCOME_TO_ACTION_ERROR[outcome];
}

export class VisionError extends Error {
  readonly outcome: VisionOutcome;
  readonly detail: Record<string, unknown>;

  constructor(outcome: VisionOutcome, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "VisionError";
    this.outcome = outcome;
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Observação rica
// ─────────────────────────────────────────────────────────────────────────────

/** Ponto de mira em px do referencial da imagem entregue ao modelo. */
export interface VisionPoint {
  x: number;
  y: number;
}

export interface VisionCandidate {
  /** `point_2d` deste candidato, já em px do viewport. `null` = não veio. */
  point?: VisionPoint | null;
  box: BoundingBox;
  confidence: number;
  label: string;
}

export type CoordinateSpace = "pixels" | "normalized";

/**
 * Resultado do provedor de visão.
 *
 * `box` é ESPELHO de `boundingBox`. Existe porque `VisionProvider.locate()` do
 * contrato v1 devolve `{box, confidence}` e o `TargetResolver` lê exatamente
 * esses dois campos. Manter o espelho é o que permite estender sem quebrar —
 * a alternativa seria um adaptador que copia campos e some com o resto.
 */
export interface VisionObservation {
  boundingBox: BoundingBox;
  /** Espelho de `boundingBox` para compatibilidade com o contrato v1. */
  box: BoundingBox;
  /**
   * `point_2d` do modelo, quando houve um utilizável. `null` NÃO significa "o
   * modelo não aponta" — significa "não veio ponto legível nesta resposta", e
   * quem decide o que fazer com isso é a política de mira, não este parser.
   */
  point: VisionPoint | null;
  confidence: number;
  /** Texto do provedor. AUDITORIA — nenhuma decisão deste módulo o lê. */
  reason: string;
  provider: string;
  model: string;
  latency_ms: number;
  /** sha256 (hex) do PNG efetivamente observado. */
  image_hash: string;
  coordinate_space: CoordinateSpace;
  /**
   * Todos os alvos que o provedor viu. Mais de um ⇒ a política declara
   * TARGET_AMBIGUOUS. O primeiro NÃO é escolhido em silêncio.
   */
  candidates: VisionCandidate[];
  observed_at: string;
}

export interface VisionObserveContext {
  goal: string;
  viewport: { width: number; height: number };
  /** sha256 do PNG, quando o chamador já calculou. Evita hashear duas vezes. */
  image_hash?: string;
  timeout_ms?: number;
}

/**
 * Adaptador rico. ESTENDE `VisionProvider` do contrato — não o substitui.
 * `locate()` mantém a assinatura do v1 e devolve um objeto mais largo, o que é
 * compatível por covariância de retorno.
 */
export interface RichVisionProvider extends VisionProvider {
  readonly model: string;
  observe(image: Buffer, context: VisionObserveContext): Promise<VisionObservation | null>;
  locate(input: {
    screenshot: Buffer;
    goal: string;
    viewport: { width: number; height: number };
  }): Promise<VisionObservation | null>;
  /** Toda recusa fica aqui. Fail closed é inútil se ninguém puder auditar. */
  rejectionLog(): VisionRejection[];
}

export type VisionRejectCode =
  | "EMPTY"
  | "NOT_JSON"
  | "NO_BOX"
  | "AMBIGUOUS_ARRAY"
  | "BAD_NUMBER"
  | "DEGENERATE_BOX"
  | "HTTP"
  | "TRANSPORT"
  | "TIMEOUT"
  | "NO_SCRIPT";

export interface VisionRejection {
  code: VisionRejectCode;
  reason: string;
  goal: string;
  image_hash: string;
  at: string;
  /** Trecho do texto do modelo, truncado e escrubado. Nunca vai para stdout. */
  excerpt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash e escrub
// ─────────────────────────────────────────────────────────────────────────────

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * O texto do modelo é derivado de um screenshot da página do dono: pode conter
 * qualquer coisa que estivesse na tela. Regra: se cheira a credencial, o trecho
 * inteiro some; sequências longas de dígitos (cartão, documento) viram [NUM].
 */
const SENSITIVE_TEXT_RE =
  /(senha|password|passwd|token|secret|api[-_ ]?key|apikey|authorization|bearer|cvv|cvc|otp|credential|cart[aã]o)/i;

export function scrubExcerpt(raw: unknown, cap: number = EXCERPT_CAP): string {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  if (SENSITIVE_TEXT_RE.test(flat)) return "[REDACTED]";
  const masked = flat.replace(/\d{6,}/g, "[NUM]");
  return masked.length > cap ? `${masked.slice(0, cap)}…` : masked;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometria
// ─────────────────────────────────────────────────────────────────────────────

export function centerOf(box: BoundingBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export interface ViewportVerdict {
  ok: boolean;
  outcome: VisionOutcome;
  reason: string;
  area_fraction: number;
}

/**
 * A única defesa contra "o modelo mandou clicar em (5000, 9000)". Roda ANTES de
 * qualquer ponteiro existir, porque um clique fora da tela não erra o alvo: ele
 * acerta outra coisa, ou o sistema operacional.
 */
export function checkViewport(
  box: BoundingBox,
  viewport: { width: number; height: number },
  opts: { max_area_fraction?: number; tolerance_px?: number; min_side_px?: number } = {},
): ViewportVerdict {
  const maxArea = opts.max_area_fraction ?? DEFAULT_MAX_AREA_FRACTION;
  const tol = opts.tolerance_px ?? VIEWPORT_TOLERANCE_PX;
  const minSide = opts.min_side_px ?? MIN_BOX_SIDE_PX;
  const vpArea = viewport.width * viewport.height;

  const nums = [box.x, box.y, box.width, box.height];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return { ok: false, outcome: "BOX_OUT_OF_VIEWPORT", reason: "caixa com número não finito", area_fraction: 0 };
  }
  if (!(box.width > 0) || !(box.height > 0)) {
    return {
      ok: false,
      outcome: "BOX_OUT_OF_VIEWPORT",
      reason: `caixa degenerada ${box.width}x${box.height} (área não positiva)`,
      area_fraction: 0,
    };
  }
  if (!(vpArea > 0)) {
    return { ok: false, outcome: "BOX_OUT_OF_VIEWPORT", reason: "viewport sem área", area_fraction: 0 };
  }
  if (box.x < -tol || box.y < -tol) {
    return {
      ok: false,
      outcome: "BOX_OUT_OF_VIEWPORT",
      reason: `origem negativa (${box.x}, ${box.y})`,
      area_fraction: (box.width * box.height) / vpArea,
    };
  }
  if (box.x + box.width > viewport.width + tol || box.y + box.height > viewport.height + tol) {
    return {
      ok: false,
      outcome: "BOX_OUT_OF_VIEWPORT",
      reason:
        `caixa (${box.x},${box.y},${box.width}x${box.height}) extrapola a viewport ` +
        `${viewport.width}x${viewport.height}`,
      area_fraction: (box.width * box.height) / vpArea,
    };
  }

  const frac = (box.width * box.height) / vpArea;

  if (box.width < minSide || box.height < minSide) {
    // Dentro da tela, porém pequena demais para ser alvo de alguém. É o sintoma
    // do modelo que ecoou o template do prompt (ver MIN_BOX_SIDE_PX).
    return {
      ok: false,
      outcome: "VISION_UNCERTAIN",
      reason: `caixa ${box.width}x${box.height} abaixo do lado mínimo clicável de ${minSide}px`,
      area_fraction: frac,
    };
  }

  if (frac >= maxArea) {
    // Não é "fora da tela": é uma caixa que cobre a tela. Isso não identifica
    // alvo nenhum — é o sintoma clássico de coordenada normalizada mal
    // interpretada ou de modelo que respondeu "a página inteira".
    return {
      ok: false,
      outcome: "VISION_UNCERTAIN",
      reason: `caixa cobre ${(frac * 100).toFixed(1)}% da viewport (teto ${(maxArea * 100).toFixed(0)}%)`,
      area_fraction: frac,
    };
  }
  return { ok: true, outcome: "RESOLVED", reason: "dentro da viewport", area_fraction: frac };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sondas executadas DENTRO da página
//
// Cada uma é autocontida (page.evaluate serializa a função): a duplicação de
// `sig` é obrigatória, não descuido.
// ─────────────────────────────────────────────────────────────────────────────

const TOPMOST_IN_PAGE = (pt: { x: number; y: number }): string => {
  const sig = (n: Element | null): string => {
    if (n === null) return "(nenhum)";
    const tag = n.tagName.toLowerCase();
    const id = n.id === "" ? "" : `#${n.id}`;
    const cls = n.classList.length > 0 ? `.${n.classList[0]}` : "";
    const same = document.getElementsByTagName(tag);
    let idx = -1;
    for (let i = 0; i < same.length; i++) {
      if (same[i] === n) {
        idx = i;
        break;
      }
    }
    return `${tag}${id}${cls}@${idx}`;
  };
  return sig(document.elementFromPoint(pt.x, pt.y));
};

const OCCLUSION_IN_PAGE = (el: Element, pt: { x: number; y: number }): { top: string; hit: boolean } => {
  const sig = (n: Element | null): string => {
    if (n === null) return "(nenhum)";
    const tag = n.tagName.toLowerCase();
    const id = n.id === "" ? "" : `#${n.id}`;
    const cls = n.classList.length > 0 ? `.${n.classList[0]}` : "";
    const same = document.getElementsByTagName(tag);
    let idx = -1;
    for (let i = 0; i < same.length; i++) {
      if (same[i] === n) {
        idx = i;
        break;
      }
    }
    return `${tag}${id}${cls}@${idx}`;
  };
  const top = document.elementFromPoint(pt.x, pt.y);
  // `top.contains(el)` NÃO entra: elementFromPoint devolve o mais interno, então
  // aceitar um ancestral seria aceitar qualquer wrapper de página inteira.
  return { top: sig(top), hit: top !== null && (top === el || el.contains(top)) };
};

/** Assinatura estável do elemento no topo da pilha naquele ponto. */
export async function topmostAt(page: Page, x: number, y: number): Promise<string> {
  return await page.evaluate(TOPMOST_IN_PAGE, { x, y });
}

type EvaluatableHandle = {
  evaluate: (fn: (el: Element, arg: { x: number; y: number }) => unknown, arg: { x: number; y: number }) => Promise<unknown>;
};

function asEvaluatable(h: unknown): EvaluatableHandle | null {
  if (h !== null && typeof h === "object" && typeof (h as { evaluate?: unknown }).evaluate === "function") {
    return h as EvaluatableHandle;
  }
  return null;
}

export interface OcclusionVerdict {
  /** false quando não há como decidir — e não-decidido nunca vira "ok". */
  determinable: boolean;
  obstructed: boolean;
  point: { x: number; y: number };
  topmost: string;
  expected: string | null;
  reason: string;
}

/**
 * Verifica se clicar no centro da caixa atinge o alvo.
 *
 * Dois modos, porque as duas origens de alvo têm evidências diferentes:
 *  - `handle` (degraus DOM/AX/semantic): existe identidade de elemento. Compara
 *    `elementFromPoint(centro)` com o próprio elemento. Não precisa de "antes".
 *  - `anchor` (degrau visão): não existe identidade — visão devolve pixels. Usa
 *    a assinatura do topo registrada no instante da observação e detecta que
 *    ALGO se interpôs desde então.
 *
 * Sem nenhum dos dois, o veredito é `determinable:false`. Fail closed: quem
 * chama não pode ler isso como "livre".
 */
export async function checkOcclusion(
  page: Page,
  box: BoundingBox,
  opts: { handle?: unknown; anchor?: string | null } = {},
): Promise<OcclusionVerdict> {
  const pt = centerOf(box);
  const ev = asEvaluatable(opts.handle);

  if (ev !== null) {
    let res: { top: string; hit: boolean };
    try {
      res = (await ev.evaluate(OCCLUSION_IN_PAGE, pt)) as { top: string; hit: boolean };
    } catch (e) {
      return {
        determinable: false,
        obstructed: false,
        point: pt,
        topmost: "(erro)",
        expected: null,
        reason: `sonda de oclusão falhou: ${(e as Error).message.split("\n")[0]}`,
      };
    }
    return {
      determinable: true,
      obstructed: !res.hit,
      point: pt,
      topmost: res.top,
      expected: "(elemento resolvido)",
      reason: res.hit
        ? "elementFromPoint no centro é o próprio alvo"
        : `elementFromPoint no centro é ${res.top}, não o alvo resolvido`,
    };
  }

  if (typeof opts.anchor === "string" && opts.anchor !== "") {
    let top: string;
    try {
      top = await topmostAt(page, pt.x, pt.y);
    } catch (e) {
      return {
        determinable: false,
        obstructed: false,
        point: pt,
        topmost: "(erro)",
        expected: opts.anchor,
        reason: `sonda de oclusão falhou: ${(e as Error).message.split("\n")[0]}`,
      };
    }
    return {
      determinable: true,
      obstructed: top !== opts.anchor,
      point: pt,
      topmost: top,
      expected: opts.anchor,
      reason:
        top === opts.anchor
          ? "topo no centro da caixa é o mesmo da observação"
          : `topo mudou de ${opts.anchor} para ${top} desde a observação`,
    };
  }

  return {
    determinable: false,
    obstructed: false,
    point: pt,
    topmost: "(não sondado)",
    expected: null,
    reason: "sem handle e sem âncora: oclusão indeterminável",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing DEFENSIVO da resposta do modelo
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseContext {
  goal: string;
  viewport: { width: number; height: number };
  image_hash: string;
  provider: string;
  model: string;
  latency_ms: number;
}

export type ParseResult =
  | { ok: true; observation: VisionObservation }
  | { ok: false; rejection: VisionRejection };

function reject(code: VisionRejectCode, reason: string, ctx: ParseContext, excerptSource: unknown): ParseResult {
  return {
    ok: false,
    rejection: {
      code,
      reason,
      goal: ctx.goal,
      image_hash: ctx.image_hash,
      at: nowIso(),
      excerpt: scrubExcerpt(excerptSource),
    },
  };
}

/** Aceita número ou string numérica limpa. "12px" NÃO é número. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function keyed(o: Record<string, unknown>, names: readonly string[]): unknown {
  for (const k of Object.keys(o)) {
    const flat = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (names.includes(flat)) return o[k];
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type BoxRead =
  | { ok: true; box: BoundingBox }
  | { ok: false; code: VisionRejectCode; reason: string };

/**
 * Lê uma caixa de um objeto do modelo.
 *
 * Um array cru de 4 números é RECUSADO de propósito: `[10,20,30,40]` é
 * `[x,y,w,h]` em alguns modelos e `[x0,y0,x1,y1]` em outros, e as duas leituras
 * apontam para lugares diferentes. Escolher uma convenção em silêncio seria
 * exatamente o tipo de palpite que este módulo existe para impedir.
 */
export function readBox(v: unknown): BoxRead {
  if (Array.isArray(v)) {
    return {
      ok: false,
      code: "AMBIGUOUS_ARRAY",
      reason: "array cru de coordenadas é ambíguo (xywh vs corners); o modelo precisa nomear os campos",
    };
  }
  if (!isPlainObject(v)) return { ok: false, code: "NO_BOX", reason: "caixa não é objeto" };

  // Passo 1 — x/y/width/height. Presença de width+height desfaz a ambiguidade.
  const w = num(keyed(v, ["width", "w"]));
  const h = num(keyed(v, ["height", "h"]));
  if (w !== null && h !== null) {
    const x = num(keyed(v, ["x", "left", "x0", "xmin"]));
    const y = num(keyed(v, ["y", "top", "y0", "ymin"]));
    if (x === null || y === null) {
      return { ok: false, code: "BAD_NUMBER", reason: "width/height presentes mas x/y ausentes ou não numéricos" };
    }
    if (!(w > 0) || !(h > 0)) {
      return { ok: false, code: "DEGENERATE_BOX", reason: `largura/altura não positivas (${w}x${h})` };
    }
    return { ok: true, box: { x, y, width: w, height: h } };
  }

  // Passo 2 — cantos, em qualquer das convenções nomeadas.
  const corners: readonly (readonly [readonly string[], readonly string[], readonly string[], readonly string[]])[] = [
    [["left"], ["top"], ["right"], ["bottom"]],
    [["xmin"], ["ymin"], ["xmax"], ["ymax"]],
    [["x0"], ["y0"], ["x1"], ["y1"]],
    [["x1"], ["y1"], ["x2"], ["y2"]],
  ];
  for (const [kx0, ky0, kx1, ky1] of corners) {
    const x0 = num(keyed(v, kx0));
    const y0 = num(keyed(v, ky0));
    const x1 = num(keyed(v, kx1));
    const y1 = num(keyed(v, ky1));
    if (x0 === null || y0 === null || x1 === null || y1 === null) continue;
    if (!(x1 > x0) || !(y1 > y0)) {
      return { ok: false, code: "DEGENERATE_BOX", reason: `cantos invertidos ou iguais (${x0},${y0})-(${x1},${y1})` };
    }
    return { ok: true, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
  }

  const hasNumericNoise = Object.values(v).some((val) => num(val) !== null);
  return {
    ok: false,
    code: hasNumericNoise ? "BAD_NUMBER" : "NO_BOX",
    reason: "nenhuma convenção de caixa reconhecida no objeto",
  };
}

/**
 * Lê `bbox_2d` — a convenção NOMEADA da família Qwen2.5-VL: `[x1,y1,x2,y2]`.
 *
 * `readBox` recusa array cru de propósito, porque `[10,20,30,40]` pode ser
 * `xywh` ou cantos. Aqui NÃO há ambiguidade: quem escolheu o nome `bbox_2d`
 * escolheu junto a convenção de cantos, e ela está documentada pelo modelo. A
 * regra continua a mesma — nunca adivinhar a partir de números soltos; ler a
 * convenção a partir da CHAVE que os nomeia.
 */
function readBbox2d(v: unknown): BoxRead {
  if (!Array.isArray(v)) return { ok: false, code: "NO_BOX", reason: "bbox_2d não é array" };
  if (v.length !== 4) {
    return { ok: false, code: "BAD_NUMBER", reason: `bbox_2d deveria ter 4 números, tem ${v.length}` };
  }
  const n = v.map((x) => num(x));
  if (n.some((x) => x === null)) {
    return { ok: false, code: "BAD_NUMBER", reason: "bbox_2d com elemento não numérico" };
  }
  const [x0, y0, x1, y1] = n as [number, number, number, number];
  if (!(x1 > x0) || !(y1 > y0)) {
    return { ok: false, code: "DEGENERATE_BOX", reason: `bbox_2d com cantos invertidos ou iguais (${x0},${y0})-(${x1},${y1})` };
  }
  return { ok: true, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/**
 * Lê um ponto de mira.
 *
 * Aceita `[x,y]` sob chave nomeada — e isto NÃO contradiz a recusa de arrays em
 * `readBox`. A recusa lá existe porque quatro números têm duas leituras que
 * apontam para lugares DIFERENTES (`xywh` vs cantos). Dois números sob a chave
 * `point_2d` têm uma leitura só. Onde não há ambiguidade não há palpite.
 *
 * `null` para qualquer coisa que não seja um par finito de números.
 */
export function readPoint(v: unknown): VisionPoint | null {
  if (Array.isArray(v)) {
    if (v.length !== 2) return null;
    const x = num(v[0]);
    const y = num(v[1]);
    return x === null || y === null ? null : { x, y };
  }
  if (!isPlainObject(v)) return null;
  const x = num(keyed(v, ["x", "cx", "left", "px"]));
  const y = num(keyed(v, ["y", "cy", "top", "py"]));
  return x === null || y === null ? null : { x, y };
}

/** Retira `<think>` do qwen3.5, cercas markdown e prefixo conversacional. */
export function stripModelNoise(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<\/?think>/gi, " ")
    .replace(/```[a-zA-Z]*\n?/g, " ")
    .replace(/```/g, " ");
}

/** Extrai blocos `{...}`/`[...]` balanceados, respeitando strings e escapes. */
export function extractJsonCandidates(text: string, max = 8): string[] {
  const out: string[] = [];
  const closerOf: Record<string, string> = { "{": "}", "[": "]" };
  for (let i = 0; i < text.length && out.length < max; i++) {
    const open = text[i]!;
    const close = closerOf[open];
    if (close === undefined) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Recusa declarada em linguagem natural, pt + en. Vale mais que qualquer
 * tentativa de parsing: quando o modelo diz que não viu, insistir em extrair
 * número de algum lugar do texto é fabricar coordenada.
 */
const NOT_FOUND_RE =
  /\b(not\s+found|no\s+(match|target|button|element)|no(t)?\s+(visible|present|detected)|(cannot|can\s?not|can['’]t|could\s+not|couldn['’]t|unable\s+to|do(es)?\s+not|don['’]t|doesn['’]t)\s+(find|locate|see|detect|identify)|nada\s+encontrado|n[aã]o\s+(encontr|localiz|vi\b|vejo|consigo|identific|h[aá]\b|est[aá]\s+vis))/i;

const NORMALIZED_HINT = /(normaliz|relativ|0\s*-\s*1|0\.\.1|fraction|percent)/i;
const PIXEL_HINT = /(pixel|px\b|absolut)/i;

function readCandidateList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed)) {
    const list = keyed(parsed, ["boxes", "candidates", "results", "matches", "objects", "detections"]);
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return [parsed];
}

function readConfidence(o: unknown): { value: number; note: string } {
  if (!isPlainObject(o)) return { value: 0, note: "sem objeto para ler confiança" };
  const raw = keyed(o, ["confidence", "score", "conf", "certainty", "probability"]);
  if (raw === undefined) return { value: 0, note: "modelo não declarou confiança" };
  const n = num(raw);
  if (n === null) return { value: 0, note: `confiança não numérica (${scrubExcerpt(raw, 40)})` };
  // Fail closed: fora de [0,1] NÃO é reinterpretado como porcentagem. Converter
  // 2 em 0.02 ou 85 em 0.85 é inventar a régua do modelo.
  if (!(n >= 0) || !(n <= 1)) return { value: 0, note: `confiança ${n} fora de [0,1]` };
  return { value: n, note: "" };
}

function readReason(o: unknown): string {
  if (!isPlainObject(o)) return "";
  const raw = keyed(o, ["reason", "explanation", "why", "rationale", "description", "label", "text"]);
  return raw === undefined ? "" : scrubExcerpt(raw);
}

/**
 * Heurística pixels-vs-0..1.
 *
 * ARMADILHA MEDIDA: a dica `coordinate_space` não é confiável — o modelo pode
 * ECOAR o valor do template do prompt. `moondream:1.8b` declarou "pixels" e
 * mandou 0.8. O parser respeita a dica (é o que o modelo AFIRMOU, e inventar
 * outra leitura seria adivinhar), e quem barra a contradição é o piso
 * `MIN_BOX_SIDE_PX` na política. Regra em uma linha: o parser relata, a
 * política decide.
 */
function isNormalized(box: BoundingBox, viewport: { width: number; height: number }, hint: string): boolean {
  if (NORMALIZED_HINT.test(hint)) return true;
  if (PIXEL_HINT.test(hint)) return false;
  if (!(viewport.width > 1) || !(viewport.height > 1)) return false;
  return box.x <= 1 && box.y <= 1 && box.x + box.width <= 1 && box.y + box.height <= 1;
}

function scale(box: BoundingBox, viewport: { width: number; height: number }): BoundingBox {
  return {
    x: box.x * viewport.width,
    y: box.y * viewport.height,
    width: box.width * viewport.width,
    height: box.height * viewport.height,
  };
}

/**
 * Ponto único de entrada do parsing. É pura: sem rede, sem relógio além de
 * `nowIso()`, sem I/O. É por isso que o teste consegue provar cada recusa com
 * respostas gravadas, sem Ollama vivo.
 */
export function parseVisionResponse(raw: unknown, ctx: ParseContext): ParseResult {
  // 1. Achar o texto do modelo dentro do envelope do servidor.
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (isPlainObject(raw)) {
    const direct = raw["response"];
    const chat = isPlainObject(raw["message"]) ? (raw["message"] as Record<string, unknown>)["content"] : undefined;
    if (typeof direct === "string") text = direct;
    else if (typeof chat === "string") text = chat;
    else return reject("NOT_JSON", "envelope sem campo `response` nem `message.content` textual", ctx, raw);
  } else {
    return reject("NOT_JSON", `resposta de tipo inesperado: ${typeof raw}`, ctx, raw);
  }

  if (text.trim() === "") return reject("EMPTY", "modelo devolveu string vazia", ctx, text);

  const cleaned = stripModelNoise(text);
  if (cleaned.trim() === "") return reject("EMPTY", "só havia ruído (think/cercas) na resposta", ctx, text);

  // 2. Recusa declarada pelo próprio modelo vale mais que qualquer parsing.
  const blocks = extractJsonCandidates(cleaned);
  if (blocks.length === 0 && NOT_FOUND_RE.test(cleaned)) {
    return reject("NO_BOX", "modelo declarou que não encontrou o alvo", ctx, text);
  }
  if (blocks.length === 0) return reject("NOT_JSON", "nenhum bloco JSON balanceado na resposta", ctx, text);

  let parsed: unknown = undefined;
  for (const b of blocks) {
    try {
      parsed = JSON.parse(b);
      break;
    } catch {
      // Bloco quebrado não encerra a busca: modelos costumam ecoar o prompt
      // antes de responder, e o primeiro `{` pode ser lixo.
      parsed = undefined;
    }
  }
  if (parsed === undefined) return reject("NOT_JSON", "nenhum bloco balanceado era JSON válido", ctx, text);

  if (isPlainObject(parsed)) {
    const found = keyed(parsed, ["found", "present", "visible", "detected"]);
    if (found === false) return reject("NO_BOX", "modelo respondeu found=false", ctx, text);
  }

  // 3. Candidatos.
  const rawList = readCandidateList(parsed);
  const hint = `${String(isPlainObject(parsed) ? keyed(parsed, ["coordinatespace", "space", "units", "coordinates"]) ?? "" : "")}`;

  const candidates: VisionCandidate[] = [];
  const notes: string[] = [];
  let space: CoordinateSpace = "pixels";
  let lastFailure: { code: VisionRejectCode; reason: string } | null = null;

  for (const item of rawList) {
    // `bbox_2d` primeiro, e por CHAVE: é a convenção nomeada do Qwen2.5-VL e a
    // única forma de um array de 4 números ser lido sem adivinhação.
    const bbox2d = isPlainObject(item) ? keyed(item, ["bbox2d", "bbox2dpixels"]) : undefined;
    const holder = isPlainObject(item)
      ? (keyed(item, ["box", "bbox", "boundingbox", "rect", "region", "coordinates", "position"]) ?? item)
      : item;
    const read = bbox2d !== undefined ? readBbox2d(bbox2d) : readBox(holder);
    if (!read.ok) {
      lastFailure = { code: read.code, reason: read.reason };
      continue;
    }
    const normalized = isNormalized(read.box, ctx.viewport, hint);
    if (normalized) space = "normalized";
    const box = normalized ? scale(read.box, ctx.viewport) : read.box;
    if (!(box.width > 0) || !(box.height > 0)) {
      lastFailure = { code: "DEGENERATE_BOX", reason: `caixa sem área após conversão (${box.width}x${box.height})` };
      continue;
    }
    const conf = readConfidence(item);
    if (conf.note !== "") notes.push(conf.note);

    /**
     * PONTO DE MIRA. Passa pelas MESMAS conversões da caixa — se a resposta
     * veio normalizada, o ponto também está normalizado, e escalar um e não o
     * outro produziria uma mira em (0,0) com confiança alta.
     *
     * Fora do viewport ⇒ DESCARTADO, não corrigido. Um ponto que o modelo
     * colocou fora da tela é um palpite que ele mesmo não conseguiu situar;
     * pinçá-lo para dentro da borda inventaria uma resposta que ninguém deu.
     */
    const pontoBruto = isPlainObject(item) ? readPoint(keyed(item, ["point2d", "point", "center", "centroid", "click"])) : null;
    let ponto: VisionPoint | null = null;
    if (pontoBruto !== null) {
      const p = normalized
        ? { x: pontoBruto.x * ctx.viewport.width, y: pontoBruto.y * ctx.viewport.height }
        : pontoBruto;
      const dentroDaTela =
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.x <= ctx.viewport.width &&
        p.y <= ctx.viewport.height;
      if (dentroDaTela) ponto = { x: p.x, y: p.y };
      else notes.push(`point_2d fora do viewport (${Math.round(p.x)},${Math.round(p.y)}) — descartado`);
    }

    candidates.push({ box, confidence: conf.value, label: readReason(item), point: ponto });
  }

  if (candidates.length === 0) {
    const f = lastFailure ?? { code: "NO_BOX" as VisionRejectCode, reason: "nenhuma caixa utilizável na resposta" };
    return reject(f.code, f.reason, ctx, text);
  }

  const top = candidates[0]!;
  const reasonParts = [readReason(parsed), top.label, ...notes].filter((s) => s !== "");
  return {
    ok: true,
    observation: {
      boundingBox: top.box,
      box: top.box,
      point: top.point ?? null,
      confidence: top.confidence,
      reason: reasonParts.length > 0 ? scrubExcerpt(reasonParts.join(" | ")) : "modelo não explicou a escolha",
      provider: ctx.provider,
      model: ctx.model,
      latency_ms: ctx.latency_ms,
      image_hash: ctx.image_hash,
      coordinate_space: space,
      candidates,
      observed_at: nowIso(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Base comum aos provedores
// ─────────────────────────────────────────────────────────────────────────────

abstract class BaseVisionProvider implements RichVisionProvider {
  abstract readonly name: string;
  abstract readonly model: string;

  readonly #rejections: VisionRejection[] = [];

  protected record(r: VisionRejection): void {
    this.#rejections.push(r);
    while (this.#rejections.length > MAX_REJECTION_LOG) this.#rejections.shift();
  }

  rejectionLog(): VisionRejection[] {
    return this.#rejections.map((r) => ({ ...r }));
  }

  abstract observe(image: Buffer, context: VisionObserveContext): Promise<VisionObservation | null>;

  /** Adaptador para o `VisionProvider` do contrato v1. Delega em `observe`. */
  async locate(input: {
    screenshot: Buffer;
    goal: string;
    viewport: { width: number; height: number };
  }): Promise<VisionObservation | null> {
    return await this.observe(input.screenshot, { goal: input.goal, viewport: input.viewport });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OllamaVisionProvider
// ─────────────────────────────────────────────────────────────────────────────

export interface OllamaVisionOptions {
  endpoint?: string;
  model?: string;
  timeout_ms?: number;
  /** `format:"json"` do Ollama. Ajuda, mas o parser defensivo continua obrigatório. */
  json_mode?: boolean;
  /** Injetável para testar sem rede. Padrão: `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Endpoint fora do loopback exige consentimento explícito (SECURITY.md T7). */
  allow_remote?: boolean;
  /**
   * Semente do amostrador do backend. Default `0` — FIXA de propósito.
   *
   * DEFEITO MEDIDO (FASE 6): `temperature: 0` sozinho NÃO torna a inferência
   * repetível no Ollama. Duas chamadas consecutivas, mesma imagem, mesmo
   * prompt, deram caixas diferentes:
   *   browser.find  → {x:412,y:150,w:280,h:100}  centro (552,200)
   *   browser.click → caixa diferente,            centro (569,207)
   * Ou seja: `find` e `click` sobre o MESMO alvo discordavam sobre onde ele
   * está. Para um runtime cuja tese é "o rastro é a verdade", isso é grave por
   * si só — a evidência gravada não descreve o gesto que foi despachado.
   *
   * A semente conserta a REPRODUTIBILIDADE, e só ela. Não melhora a precisão do
   * modelo, e nada aqui finge que melhora: o erro em px continua sendo o que a
   * medição disser.
   */
  seed?: number;
  /**
   * Política de REFINO POR RECORTE que este provider declara ao resolvedor de
   * alvo (`target.ts` a lê como `ComPoliticaDeRefino`).
   *
   * Mora no provider, e não numa opção de chamada, porque o provider é o objeto
   * que o dono configurou: quem escolheu `qwen2.5vl:3b` escolheu junto quantas
   * inferências está disposto a pagar por clique. Passar isso por fora
   * obrigaria todo chamador da cascata a repassar, e o primeiro que esquecesse
   * voltaria a clicar na estimativa grosseira sem ninguém notar.
   *
   * O refino em si NÃO é executado aqui: `locate()` recebe uma imagem, não uma
   * `Page`, e recortar exige o navegador. Ver `runVision` em `target.ts`.
   */
  refine_passes?: number;
  refine_factor?: number;
  /**
   * Onde MIRAR dentro do que a visão devolveu. Ver `VisionAim`. Lido por
   * `target.ts` (`ComPoliticaDeMira`) pelo mesmo motivo do refino: o provider é
   * o objeto que o dono configurou.
   */
  aim?: VisionAim;
}

/** Ver `OllamaVisionOptions.seed`. */
export const DEFAULT_VISION_SEED = 0;

/**
 * FASE 6c: o prompt pede CAIXA e PONTO.
 *
 * `bbox_2d` e `point_2d` são os nomes que a família Qwen2.5-VL usa no próprio
 * treino — pedir com o vocabulário do modelo custa nada e evita que ele traduza
 * para um esquema que nunca viu. O `point_2d` existe porque a caixa deste
 * modelo vem inflada (~1,8x em largura, medido) e o centro de uma caixa inflada
 * escorrega para fora do alvo; apontar é uma tarefa diferente de delimitar.
 *
 * `box` continua aceita pelo parser: nenhum provider antigo quebra por causa
 * deste prompt.
 */
export function visionPrompt(goal: string, viewport: { width: number; height: number }): string {
  return [
    `Você recebe UMA captura de tela de ${viewport.width}x${viewport.height} pixels.`,
    `Localize: "${goal}".`,
    "Responda SOMENTE com JSON, sem texto ao redor, neste formato exato:",
    '{"found": true, "bbox_2d": [x1, y1, x2, y2], "point_2d": [x, y],',
    ' "confidence": <0..1>, "coordinate_space": "pixels", "reason": "<curto>"}',
    '"bbox_2d" são os cantos superior-esquerdo e inferior-direito do alvo.',
    '"point_2d" é UM ponto no MEIO do alvo — o lugar exato onde clicar nele.',
    'Se o alvo NÃO estiver visível, responda {"found": false, "reason": "<curto>"}.',
    "Nunca invente coordenada. Coordenadas em pixels a partir do canto superior esquerdo.",
  ].join("\n");
}

function assertLoopback(endpoint: string, allowRemote: boolean): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new VisionError("INVALID_REQUEST", `endpoint inválido: ${endpoint}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (!loopback && !allowRemote) {
    // Mandar screenshot da sessão autenticada do dono para fora da máquina é
    // exfiltração. Exige ato explícito, nunca default (SECURITY.md, ativos).
    throw new VisionError("INVALID_REQUEST", `endpoint de visão fora do loopback: ${host} (use allow_remote)`);
  }
  return u;
}

export class OllamaVisionProvider extends BaseVisionProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly endpoint: string;
  readonly timeout_ms: number;
  readonly json_mode: boolean;
  readonly seed: number;
  /** Lidos por `target.ts` (`ComPoliticaDeRefino`). `undefined` = use o default de lá. */
  readonly refine_passes: number | undefined;
  readonly refine_factor: number | undefined;
  /** Lido por `target.ts` (`ComPoliticaDeMira`). */
  readonly aim: VisionAim | undefined;

  readonly #fetch: typeof fetch;

  constructor(opts: OllamaVisionOptions = {}) {
    super();
    const endpoint = opts.endpoint ?? OLLAMA_ENDPOINT;
    const url = assertLoopback(endpoint, opts.allow_remote === true);
    this.endpoint = url.origin;
    this.model = opts.model ?? DEFAULT_VISION_MODEL;
    this.timeout_ms = opts.timeout_ms ?? DEFAULT_VISION_TIMEOUT_MS;
    this.json_mode = opts.json_mode !== false;
    this.seed = opts.seed ?? DEFAULT_VISION_SEED;
    this.refine_passes = opts.refine_passes;
    this.refine_factor = opts.refine_factor;
    if (opts.aim !== undefined && !isVisionAim(opts.aim)) {
      throw new VisionError("INVALID_REQUEST", `vision aim desconhecido: ${String(opts.aim)}`);
    }
    this.aim = opts.aim;
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new VisionError("INVALID_REQUEST", "nenhum fetch disponível para o OllamaVisionProvider");
    }
    this.#fetch = f;
  }

  async observe(image: Buffer, context: VisionObserveContext): Promise<VisionObservation | null> {
    const image_hash = context.image_hash ?? sha256Hex(image);
    const ctx: ParseContext = {
      goal: context.goal,
      viewport: context.viewport,
      image_hash,
      provider: this.name,
      model: this.model,
      latency_ms: 0,
    };
    const timeout = context.timeout_ms ?? this.timeout_ms;
    const t0 = Date.now();

    let res: Response;
    try {
      res = await this.#fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          model: this.model,
          prompt: visionPrompt(context.goal, context.viewport),
          images: [image.toString("base64")],
          stream: false,
          ...(this.json_mode ? { format: "json" } : {}),
          // `temperature: 0` sozinho não bastou — ver `OllamaVisionOptions.seed`.
          options: { temperature: 0, seed: this.seed },
        }),
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const timedOut = /abort|timeout|timed out/i.test(msg) || (e as Error).name === "TimeoutError";
      this.record({
        code: timedOut ? "TIMEOUT" : "TRANSPORT",
        reason: `falha de transporte: ${msg.split("\n")[0]}`,
        goal: context.goal,
        image_hash,
        at: nowIso(),
        excerpt: "",
      });
      return null;
    }

    ctx.latency_ms = Date.now() - t0;

    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        body = "(corpo ilegível)";
      }
      this.record({
        code: "HTTP",
        reason: `HTTP ${res.status}`,
        goal: context.goal,
        image_hash,
        at: nowIso(),
        excerpt: scrubExcerpt(body),
      });
      return null;
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (e) {
      this.record({
        code: "NOT_JSON",
        reason: `envelope do servidor não é JSON: ${(e as Error).message.split("\n")[0]}`,
        goal: context.goal,
        image_hash,
        at: nowIso(),
        excerpt: "",
      });
      return null;
    }

    const parsed = parseVisionResponse(payload, ctx);
    if (!parsed.ok) {
      this.record(parsed.rejection);
      return null;
    }
    return parsed.observation;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ScriptedVisionProvider — determinístico, para testar a POLÍTICA
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptedEntry {
  box?: BoundingBox;
  /** `point_2d` simulado. `undefined` = o roteiro não aponta (só caixa). */
  point?: VisionPoint | null;
  confidence?: number;
  reason?: string;
  /** Mais de um ⇒ o provedor viu alvos parecidos e não desempata sozinho. */
  candidates?: VisionCandidate[];
  /** Atraso simulado do provedor (só para provar o timeout da política). */
  latency_ms?: number;
  /** Provedor lança em vez de responder. */
  throws?: string;
  /** Provedor responde "não vi nada". */
  absent?: boolean;
  /** Hash divergente: simula observação feita sobre OUTRA imagem. */
  image_hash?: string;
  coordinate_space?: CoordinateSpace;
}

export interface ScriptedOptions {
  name?: string;
  model?: string;
}

const normalizeGoal = (s: string): string => s.trim().toLowerCase();

/**
 * Provedor de mentira controlada. Serve para provar que a POLÍTICA reage certo
 * — não para provar que algum modelo funciona. Os dois testes são distintos e
 * misturá-los produziria um verde que não significa nada.
 */
export class ScriptedVisionProvider extends BaseVisionProvider {
  readonly name: string;
  readonly model: string;

  #calls = 0;
  readonly #table = new Map<string, ScriptedEntry>();

  constructor(table: Record<string, ScriptedEntry> = {}, opts: ScriptedOptions = {}) {
    super();
    this.name = opts.name ?? "scripted";
    this.model = opts.model ?? "scripted/none";
    for (const [k, v] of Object.entries(table)) this.#table.set(normalizeGoal(k), v);
  }

  set(goal: string, entry: ScriptedEntry): void {
    this.#table.set(normalizeGoal(goal), entry);
  }

  get calls(): number {
    return this.#calls;
  }

  resetCalls(): void {
    this.#calls = 0;
  }

  async observe(image: Buffer, context: VisionObserveContext): Promise<VisionObservation | null> {
    this.#calls += 1;
    const t0 = Date.now();
    const real_hash = context.image_hash ?? sha256Hex(image);
    const entry = this.#table.get(normalizeGoal(context.goal));

    if (entry === undefined) {
      this.record({
        code: "NO_SCRIPT",
        reason: `nenhuma entrada roteirizada para "${context.goal}"`,
        goal: context.goal,
        image_hash: real_hash,
        at: nowIso(),
        excerpt: "",
      });
      return null;
    }

    if (entry.latency_ms !== undefined && entry.latency_ms > 0) {
      // Atraso SIMULADO do provedor. Não é sincronização: a política corre
      // contra ele com Promise.race e um relógio próprio.
      await new Promise<void>((r) => {
        const t = setTimeout(r, entry.latency_ms);
        t.unref?.();
      });
    }

    if (entry.throws !== undefined) {
      throw new Error(entry.throws);
    }

    if (entry.absent === true) {
      this.record({
        code: "NO_BOX",
        reason: "roteiro declara alvo ausente",
        goal: context.goal,
        image_hash: real_hash,
        at: nowIso(),
        excerpt: "",
      });
      return null;
    }

    const candidates: VisionCandidate[] =
      entry.candidates !== undefined && entry.candidates.length > 0
        ? entry.candidates.map((c) => ({ ...c, box: { ...c.box } }))
        : entry.box !== undefined
          ? [{ box: { ...entry.box }, confidence: entry.confidence ?? 1, label: entry.reason ?? "", point: entry.point ?? null }]
          : [];

    if (candidates.length === 0) {
      this.record({
        code: "NO_BOX",
        reason: "roteiro sem caixa e sem candidatos",
        goal: context.goal,
        image_hash: real_hash,
        at: nowIso(),
        excerpt: "",
      });
      return null;
    }

    const top = candidates[0]!;
    return {
      boundingBox: { ...top.box },
      box: { ...top.box },
      point: entry.point ?? top.point ?? null,
      confidence: entry.confidence ?? top.confidence,
      reason: entry.reason ?? top.label ?? "roteiro",
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - t0,
      image_hash: entry.image_hash ?? real_hash,
      coordinate_space: entry.coordinate_space ?? "pixels",
      candidates,
      observed_at: nowIso(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Política de fallback — FASE 3
// ─────────────────────────────────────────────────────────────────────────────

export interface RungAttempt {
  rung: VisionRung;
  outcome: "hit" | "miss" | "skipped" | "ambiguous" | "error";
  detail: string;
  duration_ms: number;
}

/**
 * LIMITE DECLARADO — o que `RESOLVED` no 4º degrau significa e o que NÃO significa.
 *
 * SIGNIFICA: a caixa passou por verificação MECÂNICA — veio do screenshot atual
 * (`image_hash`), é única, tem confiança acima do limiar, cabe na viewport, tem
 * tamanho clicável, e o centro dela não está coberto por outro elemento.
 *
 * NÃO SIGNIFICA que a caixa é o alvo que o chamador pediu. Para um alvo
 * só-pixel não existe, por definição, nenhuma fonte independente contra a qual
 * conferir — é justamente por não haver identidade no DOM que se chegou à
 * visão. MEDIDO nesta máquina: `qwen2.5vl:3b`, com confiança 0.99, devolveu
 * `{109,113,280,227}` para um retângulo realmente desenhado em
 * `{60,60,160,80}` (viewport 640x400) — estruturalmente sã, semanticamente
 * errada, e o clique cairia fora. Na mesma página em 1280x800 o mesmo modelo
 * devolveu `{63,65,195,115}`, cujo centro cai DENTRO do alvo.
 *
 * Conclusão operacional: acima do 4º degrau a verificação é da AÇÃO (FASE 14,
 * `verifier.ts`), não do alvo. Quem clica por visão precisa exigir
 * `VerificationSpec` — o degrau 5 (humano) existe para quando nem isso serve.
 */
export interface PolicyResolution {
  outcome: VisionOutcome;
  /** Degrau que PRODUZIU a caixa; "human" quando nenhum produziu. */
  rung: VisionRung;
  /** true ⇒ o 5º degrau. Nenhuma ação automática deve seguir. */
  human_required: boolean;
  attempts: RungAttempt[];
  target: ResolvedTarget | null;
  vision: VisionObservation | null;
  /** Assinatura do topo no centro da caixa, no instante da decisão. */
  anchor: string | null;
  /** sha256 do recorte da caixa, no instante da decisão. */
  region_hash: string | null;
  /** sha256 do screenshot inteiro usado pela visão (null nos degraus DOM). */
  image_hash: string | null;
  reason: string;
  error: ActionError | null;
}

export interface GuardResult {
  ok: boolean;
  outcome: VisionOutcome;
  reason: string;
  detail: Record<string, unknown>;
}

export interface FallbackOptions {
  vision?: RichVisionProvider | null;
  /** Abaixo disto ⇒ VISION_UNCERTAIN. Padrão 0.7. */
  threshold?: number;
  vision_timeout_ms?: number;
  max_area_fraction?: number;
  /** Espera condicional repassada ao TargetResolver nos degraus 1–3. */
  dom_timeout_ms?: number;
  max_candidates?: number;
}

const RUNG_OF_STRATEGY: Readonly<Record<TargetStrategy, VisionRung | null>> = Object.freeze({
  selector: "dom",
  role_text: "dom",
  accessibility: "accessibility",
  semantic: "semantic",
  vision: "vision",
  coordinates: null,
});

const OUTCOME_RANK: Readonly<Record<RungAttempt["outcome"], number>> = Object.freeze({
  hit: 4,
  ambiguous: 3,
  error: 2,
  miss: 1,
  skipped: 0,
});

/** Traduz o rastro do TargetResolver para os degraus 1–3 desta política. */
function attemptsFromTrace(trace: AttemptTrace[]): RungAttempt[] {
  const byRung = new Map<VisionRung, RungAttempt>();
  for (const t of trace) {
    const rung = RUNG_OF_STRATEGY[t.strategy];
    if (rung === null || rung === "vision") continue; // a visão desta política é a de baixo
    const mapped: RungAttempt["outcome"] =
      t.outcome === "hit" ? "hit" : t.outcome === "ambiguous" ? "ambiguous" : t.outcome === "error" ? "error" : t.outcome === "skipped" ? "skipped" : "miss";
    const prev = byRung.get(rung);
    const detail = `${t.strategy}: ${t.probe}${t.reason === undefined ? "" : ` — ${t.reason}`}`;
    if (prev === undefined) {
      byRung.set(rung, { rung, outcome: mapped, detail, duration_ms: t.duration_ms });
    } else {
      prev.duration_ms += t.duration_ms;
      if (OUTCOME_RANK[mapped] > OUTCOME_RANK[prev.outcome]) prev.outcome = mapped;
      prev.detail = `${prev.detail} | ${detail}`;
    }
  }
  const out: RungAttempt[] = [];
  for (const r of ["dom", "accessibility", "semantic"] as const) {
    const a = byRung.get(r);
    out.push(a ?? { rung: r, outcome: "skipped", detail: "descritor não oferece campo para este degrau", duration_ms: 0 });
  }
  return out;
}

function goalOf(d: TargetDescriptor): string {
  return d.semantic ?? d.text ?? d.label ?? d.placeholder ?? "";
}

type Raced<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

async function race<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  // `settled` NUNCA rejeita: se o timeout vencer e `p` falhar depois, não sobra
  // rejeição sem dono para derrubar o processo.
  const settled: Promise<Raced<T>> = p.then(
    (value) => ({ kind: "value" as const, value }),
    (error) => ({ kind: "error" as const, error }),
  );
  if (!(ms > 0)) return await settled;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<Raced<T>>((resolve) => {
    t = setTimeout(() => resolve({ kind: "timeout" }), ms);
    t.unref?.();
  });
  try {
    return await Promise.race([settled, timer]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

/**
 * Cascata da FASE 3: DOM → accessibility → semantic → vision → human.
 *
 * Duas escolhas que mudam o significado do resultado:
 *
 *  a) `coordinates` do descritor é IGNORADA. No `TargetResolver` ela é o último
 *     elo; aqui o último elo é o HUMANO. Deixar a coordenada passar faria uma
 *     coordenada crua curto-circuitar o takeover — o agente clicaria às cegas
 *     onde deveria ter parado e chamado o dono.
 *
 *  b) Ambiguidade nos degraus 1–3 ENCERRA a cascata. Descer para a visão depois
 *     de ver dois candidatos legítimos é lavar a ambiguidade num degrau que não
 *     sabe da existência dela.
 */
export class VisionFallbackPolicy {
  readonly vision: RichVisionProvider | null;
  readonly threshold: number;
  readonly vision_timeout_ms: number;
  readonly max_area_fraction: number;
  readonly dom_timeout_ms: number;
  readonly max_candidates: number | undefined;

  constructor(opts: FallbackOptions = {}) {
    const th = opts.threshold ?? DEFAULT_VISION_THRESHOLD;
    if (typeof th !== "number" || !Number.isFinite(th) || th < 0 || th > 1) {
      throw new VisionError("INVALID_REQUEST", `threshold fora de [0,1]: ${String(opts.threshold)}`);
    }
    this.vision = opts.vision ?? null;
    this.threshold = th;
    this.vision_timeout_ms = opts.vision_timeout_ms ?? DEFAULT_VISION_TIMEOUT_MS;
    this.max_area_fraction = opts.max_area_fraction ?? DEFAULT_MAX_AREA_FRACTION;
    this.dom_timeout_ms = opts.dom_timeout_ms ?? 0;
    this.max_candidates = opts.max_candidates;
  }

  async resolve(page: Page, descriptor: TargetDescriptor): Promise<PolicyResolution> {
    const attempts: RungAttempt[] = [];

    // ── Degraus 1–3: reusa o TargetResolver da FASE 13. Reimplementar
    //    resolução de alvo aqui criaria duas verdades sobre o mesmo DOM.
    const domDescriptor: TargetDescriptor = { ...descriptor };
    delete domDescriptor.coordinates;

    const hasDomField =
      domDescriptor.selector !== undefined ||
      domDescriptor.text !== undefined ||
      domDescriptor.role !== undefined ||
      domDescriptor.label !== undefined ||
      domDescriptor.placeholder !== undefined ||
      domDescriptor.semantic !== undefined;

    if (!hasDomField) {
      return this.#fail(
        "INVALID_REQUEST",
        "human",
        attemptsFromTrace([]),
        "descritor sem nenhum campo utilizável pela cascata (coordinates não é degrau desta política)",
        { descriptor },
      );
    }

    let resolved: ResolvedTarget | null = null;
    let trace: AttemptTrace[] = [];
    try {
      const detailed = await TargetResolver.resolveDetailed(page, domDescriptor, {
        vision: null, // a visão desta política roda ABAIXO, com verificação própria
        timeout_ms: this.dom_timeout_ms,
        max_candidates: this.max_candidates,
      });
      resolved = detailed.target;
      trace = detailed.trace;
    } catch (e) {
      if (!isTargetResolutionError(e)) {
        return this.#fail("PROVIDER_ERROR", "human", attempts, `resolução DOM falhou: ${(e as Error).message}`, {});
      }
      trace = e.trace;
      const domAttempts = attemptsFromTrace(trace);
      if (e.code === "TARGET_AMBIGUOUS") {
        // Encerra aqui. Ver (b) no comentário da classe.
        return this.#fail("TARGET_AMBIGUOUS", "dom", domAttempts, e.message, e.toActionError().detail ?? {});
      }
      if (e.code === "INVALID_REQUEST") {
        return this.#fail("INVALID_REQUEST", "human", domAttempts, e.message, { descriptor });
      }
      // TARGET_NOT_FOUND ⇒ desce para o 4º degrau.
      return await this.#visionRung(page, descriptor, domAttempts);
    }

    const domAttempts = attemptsFromTrace(trace);
    const rung = RUNG_OF_STRATEGY[resolved.strategy] ?? "dom";

    // Degrau DOM acertou: ainda assim o clique precisa alcançar o elemento.
    const occ = await checkOcclusion(page, resolved.box, { handle: resolved.handle });
    if (occ.determinable && occ.obstructed) {
      const res = this.#fail("OVERLAY_OBSTRUCTED", rung, domAttempts, occ.reason, {
        point: occ.point,
        topmost: occ.topmost,
      });
      res.target = resolved;
      res.human_required = true;
      return res;
    }

    const anchor = occ.determinable ? await topmostAt(page, centerOf(resolved.box).x, centerOf(resolved.box).y) : null;
    const region_hash = await this.#regionHash(page, resolved.box);

    return {
      outcome: "RESOLVED",
      rung,
      human_required: false,
      attempts: domAttempts,
      target: resolved,
      vision: null,
      anchor,
      region_hash,
      image_hash: null,
      reason: `resolvido no degrau "${rung}" — ${resolved.description}`,
      error: null,
    };
  }

  // ── 4º degrau ──────────────────────────────────────────────────────────────

  async #visionRung(page: Page, descriptor: TargetDescriptor, attempts: RungAttempt[]): Promise<PolicyResolution> {
    const goal = goalOf(descriptor);
    const t0 = Date.now();

    if (this.vision === null) {
      attempts.push({ rung: "vision", outcome: "skipped", detail: "nenhum VisionProvider injetado", duration_ms: 0 });
      return this.#fail("TARGET_NOT_FOUND", "human", attempts, "degraus 1–3 falharam e não há provedor de visão", {
        goal,
      });
    }
    if (goal === "") {
      attempts.push({ rung: "vision", outcome: "skipped", detail: "descritor sem objetivo textual", duration_ms: 0 });
      return this.#fail("INVALID_REQUEST", "human", attempts, "visão exige semantic/text/label/placeholder", {});
    }

    const viewport = page.viewportSize();
    if (viewport === null || !(viewport.width > 0) || !(viewport.height > 0)) {
      attempts.push({ rung: "vision", outcome: "error", detail: "página sem viewport medível", duration_ms: 0 });
      return this.#fail("PROVIDER_ERROR", "human", attempts, "página sem viewport: caixa não teria régua", {});
    }

    let png: Buffer;
    try {
      png = await page.screenshot({ type: "png", scale: "css", fullPage: false });
    } catch (e) {
      attempts.push({ rung: "vision", outcome: "error", detail: `screenshot falhou: ${(e as Error).message}`, duration_ms: Date.now() - t0 });
      return this.#fail("PROVIDER_ERROR", "human", attempts, "não foi possível capturar a tela para a visão", {});
    }
    const image_hash = sha256Hex(png);

    const raced = await race(
      this.vision.observe(png, { goal, viewport, image_hash, timeout_ms: this.vision_timeout_ms }),
      this.vision_timeout_ms,
    );
    const dur = Date.now() - t0;

    if (raced.kind === "timeout") {
      attempts.push({ rung: "vision", outcome: "error", detail: `provedor não respondeu em ${this.vision_timeout_ms}ms`, duration_ms: dur });
      const r = this.#fail("PROVIDER_TIMEOUT", "human", attempts, `visão excedeu ${this.vision_timeout_ms}ms`, { goal });
      r.image_hash = image_hash;
      return r;
    }
    if (raced.kind === "error") {
      const msg = raced.error instanceof Error ? raced.error.message.split("\n")[0]! : String(raced.error);
      attempts.push({ rung: "vision", outcome: "error", detail: `provedor lançou: ${msg}`, duration_ms: dur });
      const r = this.#fail("PROVIDER_ERROR", "human", attempts, `provedor de visão falhou: ${msg}`, { goal });
      r.image_hash = image_hash;
      return r;
    }

    const obs = raced.value;
    if (obs === null) {
      attempts.push({ rung: "vision", outcome: "miss", detail: "provedor não localizou o alvo", duration_ms: dur });
      const r = this.#fail("TARGET_NOT_FOUND", "human", attempts, "nenhum degrau localizou o alvo", { goal });
      r.image_hash = image_hash;
      return r;
    }

    const finish = (outcome: VisionOutcome, reason: string, detail: Record<string, unknown>): PolicyResolution => {
      attempts.push({
        rung: "vision",
        outcome: outcome === "RESOLVED" ? "hit" : outcome === "TARGET_AMBIGUOUS" ? "ambiguous" : "miss",
        detail: reason,
        duration_ms: dur,
      });
      const r = this.#fail(outcome, "vision", attempts, reason, detail);
      r.vision = obs;
      r.image_hash = image_hash;
      return r;
    };

    // 1. A observação tem de ser DESTA imagem. Um provedor que devolve outro
    //    hash observou outra coisa — e é aí que mora o clique no lugar errado.
    if (obs.image_hash !== image_hash) {
      return finish("STALE_OBSERVATION", "hash da observação difere do screenshot enviado", {
        expected: image_hash,
        observed: obs.image_hash,
      });
    }

    // 2. Ambiguidade antes de confiança: ver dois alvos é um "pare" mais forte
    //    que ver um alvo mal. Não se escolhe o primeiro.
    if (obs.candidates.length > 1) {
      return finish("TARGET_AMBIGUOUS", `provedor devolveu ${obs.candidates.length} candidatos e nenhum desempate`, {
        candidates: obs.candidates.length,
        boxes: obs.candidates.slice(0, 5).map((c) => c.box),
      });
    }

    if (!(obs.confidence >= this.threshold)) {
      return finish("VISION_UNCERTAIN", `confiança ${obs.confidence.toFixed(2)} abaixo do limiar ${this.threshold.toFixed(2)}`, {
        confidence: obs.confidence,
        threshold: this.threshold,
      });
    }

    const vp = checkViewport(obs.boundingBox, viewport, { max_area_fraction: this.max_area_fraction });
    if (!vp.ok) {
      return finish(vp.outcome, vp.reason, { box: obs.boundingBox, viewport, area_fraction: vp.area_fraction });
    }

    // 3. Âncora + hash da região: a evidência que permitirá detectar, no
    //    instante do clique, que a página mudou desde a percepção.
    const c = centerOf(obs.boundingBox);
    const anchor = await topmostAt(page, c.x, c.y);
    const region_hash = await this.#regionHash(page, obs.boundingBox);

    attempts.push({ rung: "vision", outcome: "hit", detail: `caixa aceita (confiança ${obs.confidence.toFixed(2)})`, duration_ms: dur });

    return {
      outcome: "RESOLVED",
      rung: "vision",
      human_required: false,
      attempts,
      target: {
        strategy: "vision",
        attempted: ["selector", "role_text", "accessibility", "semantic", "vision"],
        box: obs.boundingBox,
        description: `região apontada por ${obs.provider}/${obs.model} (confiança ${obs.confidence.toFixed(2)}) via vision`,
        healed: true,
      },
      vision: obs,
      anchor,
      region_hash,
      image_hash,
      reason: `resolvido no 4º degrau por ${obs.provider}/${obs.model}`,
      error: null,
    };
  }

  // ── Guardas de frescor ─────────────────────────────────────────────────────

  /**
   * Última verificação ANTES de agir. Roda oclusão primeiro: um overlay muda
   * tanto os pixels quanto o topo da pilha, e "tem algo por cima" é o
   * diagnóstico específico da mesma evidência que "os pixels mudaram".
   */
  async guard(page: Page, res: PolicyResolution): Promise<GuardResult> {
    if (res.outcome !== "RESOLVED" || res.target === null) {
      return {
        ok: false,
        outcome: "INVALID_REQUEST",
        reason: "não há resolução válida para proteger",
        detail: { outcome: res.outcome },
      };
    }

    const occ = await checkOcclusion(page, res.target.box, {
      handle: res.target.handle,
      anchor: res.anchor,
    });
    if (!occ.determinable) {
      // Indeterminável não é livre. Fail closed.
      return {
        ok: false,
        outcome: "HUMAN_REQUIRED",
        reason: `oclusão indeterminável: ${occ.reason}`,
        detail: { point: occ.point },
      };
    }
    if (occ.obstructed) {
      return {
        ok: false,
        outcome: "OVERLAY_OBSTRUCTED",
        reason: occ.reason,
        detail: { point: occ.point, topmost: occ.topmost, expected: occ.expected },
      };
    }

    if (res.region_hash !== null) {
      const now = await this.#regionHash(page, res.target.box);
      if (now === null) {
        return {
          ok: false,
          outcome: "STALE_OBSERVATION",
          reason: "região da caixa não é mais capturável",
          detail: { box: res.target.box },
        };
      }
      if (now !== res.region_hash) {
        return {
          ok: false,
          outcome: "STALE_OBSERVATION",
          reason: "pixels da região do alvo mudaram entre a percepção e a ação",
          detail: { expected: res.region_hash, observed: now },
        };
      }
    }

    return { ok: true, outcome: "RESOLVED", reason: "alvo alcançável e inalterado desde a percepção", detail: {} };
  }

  /**
   * Confere se uma `VisionObservation` ainda descreve a tela atual.
   * Recaptura no MESMO escopo (viewport, escala CSS) e compara o sha256.
   */
  async assertObservationCurrent(page: Page, observation: { image_hash: string }): Promise<GuardResult> {
    let png: Buffer;
    try {
      png = await page.screenshot({ type: "png", scale: "css", fullPage: false });
    } catch (e) {
      return {
        ok: false,
        outcome: "STALE_OBSERVATION",
        reason: `não foi possível recapturar a tela: ${(e as Error).message.split("\n")[0]}`,
        detail: {},
      };
    }
    const now = sha256Hex(png);
    if (now !== observation.image_hash) {
      return {
        ok: false,
        outcome: "STALE_OBSERVATION",
        reason: "screenshot da observação não corresponde à tela atual",
        detail: { expected: observation.image_hash, observed: now },
      };
    }
    return { ok: true, outcome: "RESOLVED", reason: "observação corresponde à tela atual", detail: { image_hash: now } };
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  async #regionHash(page: Page, box: BoundingBox): Promise<string | null> {
    if (!(box.width > 0) || !(box.height > 0)) return null;
    try {
      const png = await page.screenshot({
        type: "png",
        scale: "css",
        clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      });
      return sha256Hex(png);
    } catch {
      // Região fora da página / elemento sumiu: ausência de hash é informação,
      // não erro fatal. O `guard` trata `null` como observação envelhecida.
      return null;
    }
  }

  #fail(
    outcome: VisionOutcome,
    rung: VisionRung,
    attempts: RungAttempt[],
    reason: string,
    detail: Record<string, unknown>,
  ): PolicyResolution {
    return {
      outcome,
      rung,
      human_required: rung === "human" || outcome === "HUMAN_REQUIRED",
      attempts,
      target: null,
      vision: null,
      anchor: null,
      region_hash: null,
      image_hash: null,
      reason,
      error: {
        code: actionErrorCodeFor(outcome),
        message: reason,
        detail: { ...detail, vision_outcome: outcome, rung },
      },
    };
  }
}

/**
 * Converte qualquer resultado desta fase em `ActionError` do contrato v1.
 * `detail.vision_outcome` preserva o código original — a fronteira perde
 * granularidade no CÓDIGO, nunca na evidência.
 */
export function toActionError(r: { outcome: VisionOutcome; reason: string; detail?: Record<string, unknown> }): ActionError | null {
  if (r.outcome === "RESOLVED") return null;
  return {
    code: actionErrorCodeFor(r.outcome),
    message: r.reason,
    detail: { ...(r.detail ?? {}), vision_outcome: r.outcome },
  };
}

export const Vision = {
  cascade: VISION_CASCADE,
  Policy: VisionFallbackPolicy,
  Ollama: OllamaVisionProvider,
  Scripted: ScriptedVisionProvider,
  parse: parseVisionResponse,
  readBox,
  checkViewport,
  checkOcclusion,
  topmostAt,
  centerOf,
  sha256Hex,
  scrubExcerpt,
  toActionError,
  actionErrorCodeFor,
  OUTCOME_MAP: VISION_OUTCOME_TO_ACTION_ERROR,
} as const;
