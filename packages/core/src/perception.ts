/**
 * FASE 12 — PERCEPTION ENGINE
 *
 * Converte uma `Page` do Playwright em `Observation` (contrato v1): DOM
 * anotado, árvore de acessibilidade, screenshot e log de rede.
 *
 * Três compromissos governam este módulo:
 *
 *  1. NÃO ENCOLHER A PÁGINA. `total_elements` conta TODOS os elementos do DOM
 *     (`document.getElementsByTagName("*").length`), inclusive os invisíveis e
 *     decorativos que o filtro descarta. Devolver 50 elementos de uma página de
 *     3000 sem dizer isso faria a página parecer pequena — é exatamente a
 *     mentira que a missão proíbe. Por isso `truncated` é verdadeiro sempre que
 *     `elements.length < total_elements`, seja o corte do `limit` ou do filtro.
 *
 *  2. DIMENSÃO É MEDIDA, NÃO ASSUMIDA. `capture()` lê width/height do PNG real
 *     com `pngDimensions()` (packages/observability/src/png.ts). O runtime não
 *     afirma "capturei 200x120" porque pediu 200x120.
 *
 *  3. SEGREDO NÃO ENTRA EM LOG. Header de autorização/cookie, query param com
 *     token e valor de campo sensível saem como "[REDACTED]" — a CHAVE fica
 *     visível (o auditor precisa saber que houve `Authorization`), o VALOR não.
 *
 * Falhas são explícitas: `PerceptionError` carrega um `ActionErrorCode` do
 * contrato para a camada de API montar o envelope sem adivinhar. Nada aqui
 * devolve resultado degradado em silêncio.
 */
import { pngDimensions } from "../../observability/src/png.ts";
import {
  type ActionError,
  type ActionErrorCode,
  type AxNode,
  type BoundingBox,
  type ObservedElement,
  type Observation,
  newId,
  nowIso,
} from "./contract.ts";
import type { CDPSession, ElementHandle, Page, Request as PwRequest, Response as PwResponse } from "playwright";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

export const REDACTED = "[REDACTED]";

/** Corte padrão de elementos. Truncar é aceitável; truncar calado não é. */
export const DEFAULT_OBSERVE_LIMIT = 200;
export const DEFAULT_TEXT_LIMIT = 200;
export const DEFAULT_ATTR_LIMIT = 256;
export const DEFAULT_NETWORK_LIMIT = 500;
export const DEFAULT_SCREENSHOT_CACHE = 32;
export const DEFAULT_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Redaction local
//
// A missão prevê `packages/observability/src/redact.ts` como dono canônico
// desta lógica. Enquanto ele não existe, a redação vive aqui — nunca ausente.
// Fail closed: na dúvida sobre um nome de header/param, redige.
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_HEADER_RE =
  /(authorization|authentication|cookie|token|secret|password|passwd|api[-_]?key|apikey|credential|session|x-csrf|x-xsrf|signature)/i;

const SENSITIVE_PARAM_RE =
  /(^|[._-])(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|authorization|session|sid|sig|signature|access[-_]?token|refresh[-_]?token|id[-_]?token|code|key|credential)([._-]|$)/i;

/** Nome de ATRIBUTO cujo valor não pode ir em claro para o log/observação. */
const SENSITIVE_ATTR_RE =
  /(password|passwd|token|secret|api[-_]?key|apikey|authorization|credential|otp|cvv|cvc)/i;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? REDACTED : v;
  }
  return out;
}

/**
 * Redige query params sensíveis e userinfo. Mantém host/caminho legíveis —
 * o auditor precisa saber PARA ONDE foi, só não pode ver a credencial.
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Não é URL absoluta (data:, blob: malformado, etc). Corta o que for gigante
    // para não inflar o log, e sinaliza o corte.
    return raw.length > 512 ? `${raw.slice(0, 512)}…[truncated]` : raw;
  }
  if (u.username !== "" || u.password !== "") {
    u.username = u.username === "" ? "" : REDACTED;
    u.password = u.password === "" ? "" : REDACTED;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAM_RE.test(key)) u.searchParams.set(key, REDACTED);
  }
  // Fragmento carrega token em fluxo OAuth implícito — mesmo tratamento.
  if (u.hash.length > 1 && u.hash.includes("=")) {
    const frag = new URLSearchParams(u.hash.slice(1));
    let touched = false;
    for (const key of [...frag.keys()]) {
      if (SENSITIVE_PARAM_RE.test(key)) {
        frag.set(key, REDACTED);
        touched = true;
      }
    }
    if (touched) u.hash = `#${frag.toString()}`;
  }
  return u.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Erro tipado
// ─────────────────────────────────────────────────────────────────────────────

export class PerceptionError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ActionErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "PerceptionError";
    this.code = code;
    this.detail = detail;
  }
}

/** Converte qualquer falha em `ActionError` do contrato — sem inventar código. */
export function toActionError(err: unknown): ActionError {
  if (err instanceof PerceptionError) {
    return { code: err.code, message: err.message, detail: err.detail };
  }
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout|timed out/i.test(message);
  return { code: isTimeout ? "TIMEOUT" : "INTERNAL", message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos do módulo (nenhum redefine tipo do contrato)
// ─────────────────────────────────────────────────────────────────────────────

export interface ObserveOptions {
  accessibility?: boolean;
  screenshot?: boolean;
  limit?: number;
  /** Inclui elementos não renderizados. Eles já são contados em total_elements. */
  includeHidden?: boolean;
  /** Inclui wrappers de layout sem texto/role próprio. */
  includeDecorative?: boolean;
  /** Id de página do gestor de sessão. Ausente ⇒ id estável por instância de Page. */
  page_id?: string;
}

export type ScreenshotScope = "viewport" | "full" | "element" | "region";

export interface ScreenshotOptions {
  scope?: ScreenshotScope;
  /** Seletor CSS ou `ref` devolvido por observe (ex.: "e12"). Só para scope=element. */
  target?: string | ElementHandle;
  /** Retângulo em px CSS. Só para scope=region. */
  region?: BoundingBox;
  /** true ⇒ pixels de dispositivo. Padrão: px CSS, o mesmo espaço de `box`. */
  devicePixels?: boolean;
  timeout_ms?: number;
}

export interface ScreenshotCapture {
  screenshot_ref: string;
  scope: ScreenshotScope;
  /** Lido do PNG com pngDimensions() — não é o valor pedido. */
  width: number;
  height: number;
  bytes: number;
  buffer: Buffer;
  captured_at: string;
}

export type NetworkPhase = "request" | "response" | "failed";

export interface NetworkEntry {
  id: string;
  phase: NetworkPhase;
  method: string;
  /** Já redigida. */
  url: string;
  resource_type: string;
  status: number | null;
  status_text: string | null;
  /** Já redigidos. Chave preservada, valor sensível vira "[REDACTED]". */
  request_headers: Record<string, string>;
  response_headers: Record<string, string> | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  from_cache: boolean;
  failure: string | null;
}

export interface NetworkLog {
  entries(limit?: number): NetworkEntry[];
  size(): number;
  /** Quantas entradas o buffer circular já descartou — corte visível, não mudo. */
  dropped(): number;
  /** Espera por uma entrada que satisfaça o predicado. Evento, não sleep. */
  waitFor(predicate: (e: NetworkEntry) => boolean, opts?: { timeout_ms?: number }): Promise<NetworkEntry>;
  clear(): void;
  detach(): void;
  readonly attached: boolean;
}

export interface PerceptionEngineOptions {
  observeLimit?: number;
  textLimit?: number;
  attrLimit?: number;
  networkLimit?: number;
  screenshotCache?: number;
  timeoutMs?: number;
}

interface ScanArgs {
  limit: number;
  includeHidden: boolean;
  includeDecorative: boolean;
  textLimit: number;
  attrLimit: number;
  redacted: string;
}

interface ScanResult {
  total: number;
  elements: ObservedElement[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Coletor executado DENTRO da página
//
// Precisa ser autocontido: `page.evaluate` serializa a função, então nada de
// fechar sobre variáveis do Node.
// ─────────────────────────────────────────────────────────────────────────────

const collectInPage = (args: ScanArgs): ScanResult => {
  const g = globalThis as any;
  // Registro de refs vive no contexto da página: `ref` sobrevive entre observes
  // (mesmo elemento ⇒ mesmo ref) e permite que outros módulos resolvam o alvo.
  // Some na navegação, o que é correto: depois de navegar os elementos são outros.
  const store =
    g.__nomosPerception ??
    (g.__nomosPerception = { seq: 0, byRef: new Map(), refOf: new WeakMap() });

  const INTERACTIVE = new Set([
    "a", "button", "input", "select", "textarea", "summary", "details",
    "option", "label", "iframe", "video", "audio", "embed", "object",
  ]);
  const SENSITIVE_FIELD = /(pass|senha|secret|token|cvv|cvc|card|cartao|otp|pin|api[_-]?key)/i;
  const SENSITIVE_ATTR = /(password|passwd|token|secret|api[-_]?key|apikey|authorization|credential|otp|cvv|cvc)/i;

  const clip = (s: string, cap: number): string => (s.length > cap ? `${s.slice(0, cap)}…` : s);

  const refFor = (el: any): string => {
    let r = store.refOf.get(el);
    if (r === undefined) {
      store.seq += 1;
      r = `e${store.seq}`;
      store.refOf.set(el, r);
      store.byRef.set(r, el);
    }
    return r;
  };

  const inputType = (el: any): string => String(el.getAttribute("type") ?? "text").toLowerCase();

  const roleOf = (el: any, tag: string): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit.trim() !== "") return explicit.trim().split(/\s+/)[0]!;
    if (/^h[1-6]$/.test(tag)) return "heading";
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "button": return "button";
      case "input": {
        const t = inputType(el);
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (t === "hidden" || t === "password" || t === "file") return null;
        return "textbox";
      }
      case "textarea": return "textbox";
      case "select": return el.multiple === true || Number(el.getAttribute("size") ?? 0) > 1 ? "listbox" : "combobox";
      case "img": return (el.getAttribute("alt") ?? "") === "" && el.hasAttribute("alt") ? "presentation" : "img";
      case "nav": return "navigation";
      case "main": return "main";
      case "header": return "banner";
      case "footer": return "contentinfo";
      case "aside": return "complementary";
      case "form": return "form";
      case "search": return "search";
      case "dialog": return "dialog";
      case "progress": return "progressbar";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "tr": return "row";
      case "td": return "cell";
      case "th": return "columnheader";
      case "option": return "option";
      case "p": return "paragraph";
      default: return null;
    }
  };

  const textOf = (el: any, tag: string): string | null => {
    if (tag === "input") {
      const t = inputType(el);
      // Valor de senha/hidden nunca é lido. O agente sabe que o campo existe;
      // o conteúdo não lhe pertence.
      if (t === "password" || t === "hidden") return null;
      const ident = `${el.getAttribute("name") ?? ""} ${el.getAttribute("id") ?? ""} ${el.getAttribute("autocomplete") ?? ""}`;
      const v = typeof el.value === "string" ? el.value : "";
      if (v !== "") return SENSITIVE_FIELD.test(ident) ? args.redacted : clip(v, args.textLimit);
      const ph = el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? el.getAttribute("value");
      return ph === null || ph === "" ? null : clip(ph, args.textLimit);
    }
    if (tag === "textarea") {
      const ident = `${el.getAttribute("name") ?? ""} ${el.getAttribute("id") ?? ""}`;
      const v = typeof el.value === "string" ? el.value : "";
      if (v !== "") return SENSITIVE_FIELD.test(ident) ? args.redacted : clip(v, args.textLimit);
      const ph = el.getAttribute("placeholder");
      return ph === null || ph === "" ? null : clip(ph, args.textLimit);
    }
    if (tag === "select") {
      const opt = el.selectedOptions !== undefined && el.selectedOptions.length > 0 ? el.selectedOptions[0] : null;
      const t = opt === null ? "" : String(opt.textContent ?? "").trim();
      return t === "" ? null : clip(t, args.textLimit);
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      return alt === null || alt === "" ? null : clip(alt, args.textLimit);
    }
    const raw = typeof el.innerText === "string" && el.innerText !== "" ? el.innerText : String(el.textContent ?? "");
    const t = raw.replace(/\s+/g, " ").trim();
    if (t !== "") return clip(t, args.textLimit);
    const label = el.getAttribute("aria-label") ?? el.getAttribute("title");
    return label === null || label === "" ? null : clip(label, args.textLimit);
  };

  const attrsOf = (el: any, tag: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const pwd = tag === "input" && (inputType(el) === "password" || inputType(el) === "hidden");
    for (const name of el.getAttributeNames()) {
      let v = String(el.getAttribute(name) ?? "");
      if (SENSITIVE_ATTR.test(name) || (pwd && name === "value")) v = args.redacted;
      else if (v.length > args.attrLimit) v = `${v.slice(0, args.attrLimit)}…[truncated]`;
      out[name] = v;
    }
    return out;
  };

  const hasOwnText = (el: any): boolean => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && String(n.nodeValue ?? "").trim() !== "") return true;
    }
    return false;
  };

  const isVisible = (el: any, rect: any): boolean => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) === true;
    }
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0;
  };

  const isEnabled = (el: any): boolean => {
    if (el.disabled === true) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.hasAttribute("inert")) return false;
    if (typeof el.closest === "function") {
      if (el.closest("fieldset[disabled]") !== null) return false;
      if (el.closest("[inert]") !== null) return false;
    }
    return true;
  };

  const keep = (el: any, tag: string, visible: boolean): boolean => {
    if (!args.includeHidden && !visible) return false;
    if (args.includeDecorative) return true;
    if (INTERACTIVE.has(tag)) return true;
    if (/^h[1-6]$/.test(tag)) return true;
    if (tag === "img") return String(el.getAttribute("alt") ?? "").trim() !== "";
    if (el.hasAttribute("role") || el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    if (tag === "form" || tag === "table") return true;
    return hasOwnText(el);
  };

  // total = TODOS os elementos do DOM, sem exceção. É verificável de fora com
  // document.querySelectorAll("*").length — de propósito.
  const all = document.getElementsByTagName("*");
  const total = all.length;
  const elements: ObservedElement[] = [];

  for (let i = 0; i < total; i++) {
    if (elements.length >= args.limit) break;
    const el: any = all[i];
    const tag = String(el.tagName).toLowerCase();
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el, rect);
    if (!keep(el, tag, visible)) continue;
    elements.push({
      ref: refFor(el),
      tag,
      role: roleOf(el, tag),
      text: textOf(el, tag),
      attributes: attrsOf(el, tag),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible,
      enabled: isEnabled(el),
    });
  }

  return { total, elements };
};

const REF_RE = /^e\d+$/;

const resolveRefInPage = (ref: string): any => {
  const g = globalThis as any;
  const store = g.__nomosPerception;
  if (store === undefined) return null;
  return store.byRef.get(ref) ?? null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Log de rede
// ─────────────────────────────────────────────────────────────────────────────

/** Cópia defensiva: o log é evidência, e evidência não muda na mão de quem lê. */
function copyEntry(e: NetworkEntry): NetworkEntry {
  return {
    ...e,
    request_headers: { ...e.request_headers },
    response_headers: e.response_headers === null ? null : { ...e.response_headers },
  };
}

interface Waiter {
  predicate: (e: NetworkEntry) => boolean;
  resolve: (e: NetworkEntry) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class NetworkLogImpl implements NetworkLog {
  attached = true;

  readonly #max: number;
  readonly #buf: NetworkEntry[] = [];
  readonly #byRequest = new WeakMap<PwRequest, NetworkEntry>();
  readonly #started = new WeakMap<PwRequest, number>();
  readonly #waiters = new Set<Waiter>();
  #dropped = 0;
  #detach: () => void = () => {};

  constructor(page: Page, max: number) {
    this.#max = max;

    const onRequest = (req: PwRequest): void => this.#onRequest(req);
    const onResponse = (res: PwResponse): void => this.#onResponse(res);
    const onFailed = (req: PwRequest): void => this.#onFailed(req);
    const onClose = (): void => this.detach();

    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailed);
    page.on("close", onClose);

    this.#detach = () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      page.off("close", onClose);
    };
  }

  #store(entry: NetworkEntry): void {
    this.#buf.push(entry);
    while (this.#buf.length > this.#max) {
      this.#buf.shift();
      this.#dropped += 1; // corte contabilizado; ver dropped()
    }
  }

  #notify(entry: NetworkEntry): void {
    for (const w of [...this.#waiters]) {
      let match = false;
      try {
        match = w.predicate(entry);
      } catch (err) {
        this.#waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(err);
        continue;
      }
      if (match) {
        this.#waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(entry);
      }
    }
  }

  #onRequest(req: PwRequest): void {
    const now = Date.now();
    this.#started.set(req, now);
    const entry: NetworkEntry = {
      id: newId("net"),
      phase: "request",
      method: req.method(),
      url: redactUrl(req.url()),
      resource_type: req.resourceType(),
      status: null,
      status_text: null,
      request_headers: redactHeaders(req.headers()),
      response_headers: null,
      started_at: new Date(now).toISOString(),
      ended_at: null,
      duration_ms: null,
      from_cache: false,
      failure: null,
    };
    this.#byRequest.set(req, entry);
    this.#store(entry);
    this.#notify(entry);
  }

  #finish(req: PwRequest, phase: NetworkPhase): NetworkEntry {
    const now = Date.now();
    // A entrada pode não existir se o log foi anexado no meio do voo — nesse
    // caso registra uma nova em vez de descartar o evento.
    const existing = this.#byRequest.get(req);
    const entry: NetworkEntry = existing ?? {
      id: newId("net"),
      phase,
      method: req.method(),
      url: redactUrl(req.url()),
      resource_type: req.resourceType(),
      status: null,
      status_text: null,
      request_headers: redactHeaders(req.headers()),
      response_headers: null,
      started_at: new Date(now).toISOString(),
      ended_at: null,
      duration_ms: null,
      from_cache: false,
      failure: null,
    };
    entry.phase = phase;
    entry.ended_at = new Date(now).toISOString();
    entry.duration_ms = now - (this.#started.get(req) ?? now);
    if (existing === undefined) {
      this.#byRequest.set(req, entry);
      this.#store(entry);
    }
    return entry;
  }

  #onResponse(res: PwResponse): void {
    const req = res.request();
    const entry = this.#finish(req, "response");
    entry.status = res.status();
    entry.status_text = res.statusText();
    entry.response_headers = redactHeaders(res.headers());
    entry.from_cache = res.status() === 304;
    this.#notify(entry);
  }

  #onFailed(req: PwRequest): void {
    const entry = this.#finish(req, "failed");
    entry.failure = req.failure()?.errorText ?? "unknown";
    this.#notify(entry);
  }

  entries(limit?: number): NetworkEntry[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new PerceptionError("INVALID_REQUEST", `network limit inválido: ${String(limit)}`);
    }
    // Cópia profunda dos headers: quem consome o log não pode mutar o log.
    const slice = limit === undefined ? this.#buf : this.#buf.slice(-limit);
    return slice.map(copyEntry);
  }

  size(): number {
    return this.#buf.length;
  }

  dropped(): number {
    return this.#dropped;
  }

  waitFor(predicate: (e: NetworkEntry) => boolean, opts?: { timeout_ms?: number }): Promise<NetworkEntry> {
    const timeout = opts?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    for (const e of this.#buf) {
      if (predicate(e)) return Promise.resolve(copyEntry(e));
    }
    if (!this.attached) {
      return Promise.reject(new PerceptionError("INTERNAL", "network log desanexado; nenhum evento novo virá"));
    }
    return new Promise<NetworkEntry>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (e) => resolve(copyEntry(e)),
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new PerceptionError("TIMEOUT", `nenhuma requisição casou o predicado em ${timeout}ms`, { timeout_ms: timeout }));
        }, timeout),
      };
      waiter.timer.unref?.();
      this.#waiters.add(waiter);
    });
  }

  clear(): void {
    this.#buf.length = 0;
    this.#dropped = 0;
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.#detach();
    for (const w of [...this.#waiters]) {
      this.#waiters.delete(w);
      clearTimeout(w.timer);
      w.reject(new PerceptionError("INTERNAL", "network log desanexado durante a espera"));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

const pageIds = new WeakMap<Page, string>();

function pageIdOf(page: Page): string {
  let id = pageIds.get(page);
  if (id === undefined) {
    id = newId("pg");
    pageIds.set(page, id);
  }
  return id;
}

export class PerceptionEngine {
  readonly observeLimit: number;
  readonly textLimit: number;
  readonly attrLimit: number;
  readonly networkLimit: number;
  readonly screenshotCache: number;
  readonly timeoutMs: number;

  readonly #shots = new Map<string, ScreenshotCapture>();
  readonly #logs = new WeakMap<Page, NetworkLogImpl>();
  readonly #ax = new WeakMap<Page, CDPSession>();
  #evicted = 0;

  constructor(opts: PerceptionEngineOptions = {}) {
    this.observeLimit = opts.observeLimit ?? DEFAULT_OBSERVE_LIMIT;
    this.textLimit = opts.textLimit ?? DEFAULT_TEXT_LIMIT;
    this.attrLimit = opts.attrLimit ?? DEFAULT_ATTR_LIMIT;
    this.networkLimit = opts.networkLimit ?? DEFAULT_NETWORK_LIMIT;
    this.screenshotCache = opts.screenshotCache ?? DEFAULT_SCREENSHOT_CACHE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Fotografia do estado atual da página. NÃO espera carregamento: quem precisa
   * de estabilidade usa `browser.wait` (FASE 13/14). Observar e esperar são
   * responsabilidades distintas; misturá-las esconderia por que uma observação
   * demorou.
   */
  async observe(page: Page, opts: ObserveOptions = {}): Promise<Observation> {
    const limit = opts.limit ?? this.observeLimit;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new PerceptionError("INVALID_REQUEST", `limit inválido: ${String(opts.limit)}`, { limit: opts.limit });
    }

    const args: ScanArgs = {
      limit,
      includeHidden: opts.includeHidden === true,
      includeDecorative: opts.includeDecorative === true,
      textLimit: this.textLimit,
      attrLimit: this.attrLimit,
      redacted: REDACTED,
    };

    let scan: ScanResult;
    try {
      scan = await page.evaluate(collectInPage, args);
    } catch (err) {
      throw new PerceptionError("INTERNAL", `falha ao varrer o DOM: ${err instanceof Error ? err.message : String(err)}`);
    }

    const accessibility = opts.accessibility === true ? await this.accessibilityTree(page) : null;
    const screenshot_ref =
      opts.screenshot === true ? (await this.capture(page, { scope: "viewport" })).screenshot_ref : null;

    let title: string;
    try {
      title = await page.title();
    } catch (err) {
      throw new PerceptionError("INTERNAL", `falha ao ler o título: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      url: page.url(),
      title,
      page_id: opts.page_id ?? pageIdOf(page),
      elements: scan.elements,
      accessibility,
      screenshot_ref,
      observed_at: nowIso(),
      total_elements: scan.total,
      // Verdadeiro sempre que a lista é menor que o DOM — por `limit` OU por
      // filtro. Um consumidor que precise distinguir compara elements.length
      // com o limit pedido; o que não pode existir é corte invisível.
      truncated: scan.elements.length < scan.total,
    };
  }

  /**
   * Árvore de acessibilidade do Chromium.
   *
   * DESVIO DECLARADO: a missão especificou `page.accessibility.snapshot()`, mas
   * o Playwright 1.62.1 instalado NÃO tem mais essa API — `page.accessibility`
   * é `undefined` (a classe Accessibility foi removida; sobrou `ariaSnapshot`,
   * que devolve YAML, não árvore). Em vez de fingir, este método fala com o
   * domínio Accessibility do CDP — exatamente a fonte que a API removida
   * embrulhava. Nada de fallback silencioso: se o CDP não existir (navegador
   * não-Chromium), levanta PerceptionError.
   */
  async accessibilityTree(page: Page, opts: { interestingOnly?: boolean } = {}): Promise<AxNode | null> {
    const interestingOnly = opts.interestingOnly !== false;
    const session = await this.#axSession(page);
    let raw: RawAxNode[];
    try {
      const res = (await session.send("Accessibility.getFullAXTree")) as unknown as { nodes?: RawAxNode[] };
      raw = res.nodes ?? [];
    } catch (err) {
      this.#ax.delete(page);
      throw new PerceptionError(
        "INTERNAL",
        `Accessibility.getFullAXTree falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw.length === 0) return null;
    const byId = new Map<string, RawAxNode>();
    for (const n of raw) byId.set(String(n.nodeId), n);
    return buildAxRoot(raw[0]!, byId, interestingOnly);
  }

  async #axSession(page: Page): Promise<CDPSession> {
    const cached = this.#ax.get(page);
    if (cached !== undefined) return cached;
    const ctx = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<CDPSession> };
    if (typeof ctx.newCDPSession !== "function") {
      throw new PerceptionError("INTERNAL", "árvore de acessibilidade exige CDP (Chromium); navegador atual não expõe newCDPSession");
    }
    let session: CDPSession;
    try {
      session = await ctx.newCDPSession(page);
      await session.send("Accessibility.enable");
    } catch (err) {
      throw new PerceptionError("INTERNAL", `sessão CDP indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#ax.set(page, session);
    page.once("close", () => this.#ax.delete(page));
    return session;
  }

  /** PNG cru. Use `capture()` quando precisar de dimensões medidas e ref. */
  async screenshot(page: Page, opts: ScreenshotOptions = {}): Promise<Buffer> {
    return (await this.capture(page, opts)).buffer;
  }

  /**
   * Captura + medição. width/height vêm de `pngDimensions()` sobre o PNG real:
   * pedir um clip de 200x120 não é evidência de ter capturado 200x120.
   */
  async capture(page: Page, opts: ScreenshotOptions = {}): Promise<ScreenshotCapture> {
    const scope = opts.scope ?? "viewport";
    const timeout = opts.timeout_ms ?? this.timeoutMs;
    // px CSS por padrão: é o mesmo espaço de `ObservedElement.box` e o que o
    // motor de input do CDP consome. Misturar espaços produz mapa mentiroso.
    const scale = opts.devicePixels === true ? "device" : "css";

    let buffer: Buffer;
    try {
      if (scope === "viewport") {
        buffer = await page.screenshot({ fullPage: false, scale, timeout, type: "png" });
      } else if (scope === "full") {
        buffer = await page.screenshot({ fullPage: true, scale, timeout, type: "png" });
      } else if (scope === "region") {
        const r = opts.region;
        if (r === undefined) {
          throw new PerceptionError("INVALID_REQUEST", "scope=region exige `region`");
        }
        if (!(r.width > 0) || !(r.height > 0)) {
          throw new PerceptionError("INVALID_REQUEST", "region com largura/altura não positiva", { region: r });
        }
        buffer = await page.screenshot({
          clip: { x: r.x, y: r.y, width: r.width, height: r.height },
          scale,
          timeout,
          type: "png",
        });
      } else if (scope === "element") {
        const target = opts.target;
        if (target === undefined) {
          throw new PerceptionError("INVALID_REQUEST", "scope=element exige `target` (seletor ou ref)");
        }
        const handle = typeof target === "string" ? await this.resolveTarget(page, target) : target;
        try {
          buffer = await handle.screenshot({ scale, timeout, type: "png" });
        } finally {
          // Só descarta o handle que ESTE método criou.
          if (typeof target === "string") await handle.dispose();
        }
      } else {
        throw new PerceptionError("INVALID_REQUEST", `scope desconhecido: ${String(scope)}`);
      }
    } catch (err) {
      if (err instanceof PerceptionError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new PerceptionError(/timeout|timed out/i.test(msg) ? "TIMEOUT" : "INTERNAL", `screenshot falhou: ${msg}`);
    }

    const dims = pngDimensions(buffer);
    const capture: ScreenshotCapture = {
      screenshot_ref: newId("shot"),
      scope,
      width: dims.width,
      height: dims.height,
      bytes: buffer.length,
      buffer,
      captured_at: nowIso(),
    };
    this.#remember(capture);
    return capture;
  }

  #remember(capture: ScreenshotCapture): void {
    this.#shots.set(capture.screenshot_ref, capture);
    while (this.#shots.size > this.screenshotCache) {
      const oldest = this.#shots.keys().next();
      if (oldest.done === true) break;
      this.#shots.delete(oldest.value);
      this.#evicted += 1;
    }
  }

  /** `null` quando o ref não existe OU já foi evictado — miss visível, nunca imagem errada. */
  getScreenshot(ref: string): ScreenshotCapture | null {
    return this.#shots.get(ref) ?? null;
  }

  evictedScreenshots(): number {
    return this.#evicted;
  }

  /** Anexa (idempotente) o coletor de rede a uma Page. */
  networkLog(page: Page, opts: { limit?: number } = {}): NetworkLog {
    const existing = this.#logs.get(page);
    if (existing !== undefined && existing.attached) return existing;
    const log = new NetworkLogImpl(page, opts.limit ?? this.networkLimit);
    this.#logs.set(page, log);
    return log;
  }

  /**
   * Resolve `ref` de observação ou seletor CSS num handle vivo.
   * Ambiguidade e ausência são erros do contrato — não se escolhe o primeiro.
   */
  async resolveTarget(page: Page, target: string): Promise<ElementHandle<Element>> {
    if (REF_RE.test(target)) {
      const handle = await page.evaluateHandle(resolveRefInPage, target);
      const el = handle.asElement();
      if (el !== null) return el as ElementHandle<Element>;
      await handle.dispose();
      throw new PerceptionError("TARGET_NOT_FOUND", `ref "${target}" não existe nesta página (navegou?)`, { ref: target });
    }
    const count = await page.locator(target).count();
    if (count === 0) throw new PerceptionError("TARGET_NOT_FOUND", `seletor sem correspondência: ${target}`, { selector: target });
    if (count > 1) {
      throw new PerceptionError("TARGET_AMBIGUOUS", `seletor casou ${count} elementos: ${target}`, { selector: target, count });
    }
    const handle = await page.locator(target).elementHandle({ timeout: this.timeoutMs });
    if (handle === null) throw new PerceptionError("TARGET_NOT_FOUND", `seletor sem handle: ${target}`, { selector: target });
    return handle as ElementHandle<Element>;
  }

  /** Caixa atual de um ref/seletor, medida na hora (a página pode ter movido). */
  async boxOf(page: Page, target: string): Promise<BoundingBox> {
    const handle = await this.resolveTarget(page, target);
    try {
      const box = await handle.boundingBox();
      if (box === null) {
        throw new PerceptionError("TARGET_NOT_FOUND", `alvo sem caixa (não renderizado): ${target}`, { target });
      }
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    } finally {
      await handle.dispose();
    }
  }
}

/** Nó cru do CDP (Accessibility.getFullAXTree). Não é tipo do contrato. */
interface RawAxNode {
  nodeId: string | number;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  description?: { value?: unknown };
  value?: { value?: unknown };
  childIds?: (string | number)[];
}

/**
 * Roles que só existem por causa da estrutura HTML. Quando não têm nome
 * acessível, viram ruído: os filhos sobem no lugar delas. Um nó com nome NUNCA
 * é descartado, mesmo com role genérica.
 */
const NOISE_AX_ROLES = new Set([
  "none", "presentation", "generic", "GenericContainer", "InlineTextBox", "LineBreak", "Ignored",
]);

function axString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function axChildren(
  ids: (string | number)[],
  byId: Map<string, RawAxNode>,
  interestingOnly: boolean,
  seen: Set<string>,
): AxNode[] {
  const out: AxNode[] = [];
  for (const id of ids) {
    const key = String(id);
    if (seen.has(key)) continue; // árvore AX não deveria ciclar; se ciclar, não travamos
    seen.add(key);
    const raw = byId.get(key);
    if (raw === undefined) continue;
    const kids = axChildren(raw.childIds ?? [], byId, interestingOnly, seen);
    const role = axString(raw.role?.value) ?? "unknown";
    const name = axString(raw.name?.value);
    const dropped = raw.ignored === true || (interestingOnly && NOISE_AX_ROLES.has(role) && (name === null || name === ""));
    if (dropped) {
      out.push(...kids); // hoist: o conteúdo não desaparece junto com o invólucro
      continue;
    }
    out.push(makeAxNode(raw, role, name, kids));
  }
  return out;
}

function makeAxNode(raw: RawAxNode, role: string, name: string | null, kids: AxNode[]): AxNode {
  const node: AxNode = { role, name: name === "" ? null : name };
  const value = axString(raw.value?.value);
  if (value !== null && value !== "") node.value = value;
  const description = axString(raw.description?.value);
  if (description !== null && description !== "") node.description = description;
  if (kids.length > 0) node.children = kids;
  return node;
}

/** A raiz nunca é descartada — sumir com ela mudaria o significado da árvore. */
function buildAxRoot(root: RawAxNode, byId: Map<string, RawAxNode>, interestingOnly: boolean): AxNode {
  const seen = new Set<string>([String(root.nodeId)]);
  const kids = axChildren(root.childIds ?? [], byId, interestingOnly, seen);
  return makeAxNode(root, axString(root.role?.value) ?? "unknown", axString(root.name?.value), kids);
}

/** Percorre a árvore Ax em profundidade — utilitário para verificação/testes. */
export function* walkAxTree(node: AxNode | null): Generator<AxNode> {
  if (node === null) return;
  yield node;
  for (const child of node.children ?? []) yield* walkAxTree(child);
}

/** Instância padrão. Módulos que não precisam de configuração usam esta. */
export const perception = new PerceptionEngine();
