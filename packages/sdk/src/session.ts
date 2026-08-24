/**
 * SDK TypeScript @nomos/browser — erro, transporte e Sessão.
 *
 * Cliente HTTP puro. Playwright não entra aqui por decisão de arquitetura: o
 * SDK é o que um agente remoto usa, e um agente remoto não tem — nem deve ter —
 * o navegador na própria máquina. Ele fala a tabela de rotas de docs/API.md.
 *
 * Todos os tipos que atravessam a fronteira vêm de packages/core/src/contract.ts.
 * Nada é redefinido aqui; o que se define abaixo são apenas as FORMAS DE CORPO
 * das requisições, que o contrato não modela.
 */
import { API_PREFIX } from "../../core/src/contract.ts";
import type {
  ActionErrorCode,
  ActionResponse,
  ActionTiming,
  BoundingBox,
  BrowserTask,
  Capabilities,
  CredentialRef,
  DownloadRecord,
  Observation,
  PageInfo,
  ResolvedTarget,
  SessionInfo,
  TargetDescriptor,
  UploadRecord,
  VerificationResult,
  VerificationSpec,
} from "../../core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Erro
// ─────────────────────────────────────────────────────────────────────────────

export interface NomosBrowserErrorInit {
  actionId?: string | null;
  timing?: ActionTiming | null;
  detail?: Record<string, unknown>;
  httpStatus?: number | null;
  cause?: unknown;
}

/**
 * Falha do runtime vista pelo SDK. `code` é sempre um `ActionErrorCode` do
 * contrato — o enum é fechado e o SDK não inventa código novo.
 *
 * O erro NUNCA carrega o corpo da requisição: `browser.type` pode transportar
 * `credential_ref`, e um dia um chamador descuidado passará o valor no lugar da
 * referência. Não ecoar o pedido é o que impede que isso vaze num stack trace.
 */
export class NomosBrowserError extends Error {
  override readonly name = "NomosBrowserError";
  readonly code: ActionErrorCode;
  readonly actionId: string | null;
  readonly timing: ActionTiming | null;
  readonly detail: Record<string, unknown> | undefined;
  readonly httpStatus: number | null;

  constructor(code: ActionErrorCode, message: string, init: NomosBrowserErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = code;
    this.actionId = init.actionId ?? null;
    this.timing = init.timing ?? null;
    this.detail = init.detail;
    this.httpStatus = init.httpStatus ?? null;
  }

  /** Converte o envelope de erro da API v1 preservando código, action_id e timing. */
  static fromEnvelope(envelope: ActionResponse<unknown>, httpStatus: number | null): NomosBrowserError {
    const err = envelope.error;
    const code: ActionErrorCode = err?.code ?? "INTERNAL";
    const message = err?.message ?? "runtime devolveu success=false sem error preenchido";
    return new NomosBrowserError(code, message, {
      actionId: envelope.action_id ?? null,
      timing: envelope.timing ?? null,
      detail: err?.detail,
      httpStatus,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transporte — implementado em index.ts; a Sessão só depende desta interface
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestOptions {
  /** Sobrepõe o timeout do cliente para esta chamada. */
  timeout_ms?: number;
}

export interface Transport {
  /** POST /api/v1/<tool>; desembrulha `ActionResponse` ou lança `NomosBrowserError`. */
  action<T>(tool: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
  /** Rotas de gestão: respondem o objeto direto, sem envelope (docs/API.md, regra 3). */
  management<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formas de corpo (não existem no contrato — são a superfície de chamada)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  owner?: string;
  profile?: string;
  capabilities?: Partial<Capabilities>;
  headless?: boolean;
}

export interface GotoOptions {
  /** `load` | `domcontentloaded` | `networkidle` | `commit` — repassado ao runtime. */
  wait_until?: string;
}

export interface ObserveOptions {
  accessibility?: boolean;
  screenshot?: boolean;
  limit?: number;
}

export interface ActOptions {
  verification?: VerificationSpec;
}

/** `result` de `browser.click` e `browser.type` (docs/API.md). */
export interface ActResult {
  target: ResolvedTarget;
  verification: VerificationResult;
}

export interface ScrollOptions {
  dx?: number;
  dy?: number;
  target?: TargetDescriptor;
}

export interface ExtractOptions {
  target?: TargetDescriptor;
  /** Formato aceito pelo runtime (ex.: `text`, `html`, `markdown`). Não é enum do contrato. */
  format?: string;
}

export type ScreenshotScope = "viewport" | "full" | "element" | "region";

export interface ScreenshotOptions {
  scope?: ScreenshotScope;
  target?: TargetDescriptor;
  region?: BoundingBox;
}

export interface ScreenshotResult {
  screenshot_ref: string;
  width: number;
  height: number;
}

export interface DownloadOptions {
  target?: TargetDescriptor;
  url?: string;
}

export interface UploadOptions {
  target: TargetDescriptor;
  path?: string;
  file_ref?: string;
}

/** docs/API.md: duração fixa **não** é condição de espera. */
export type WaitCondition =
  | "url_contains"
  | "element_visible"
  | "element_hidden"
  | "network_idle"
  | "text_present";

export interface WaitOptions {
  condition: WaitCondition;
  /** Argumento da condição (a substring de `url_contains`, o texto de `text_present`…). */
  value?: string;
  target?: TargetDescriptor;
  timeout_ms?: number;
}

export interface TaskOptions {
  goal: string;
  profile?: string;
}

export interface NetworkOptions {
  limit?: number;
}

export interface NetworkResult {
  requests: Array<Record<string, unknown>>;
}

/** Margem sobre o timeout de negócio: a espera do runtime tem de estourar antes do socket. */
const WAIT_MARGIN_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Sessão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle de uma sessão viva no runtime.
 *
 * `detach()` e `close()` são coisas diferentes e o SDK não confunde as duas:
 * detach solta o cliente e a sessão **continua viva** no runtime; close mata a
 * sessão. Esse é o ponto inteiro do produto — o agente pode morrer sem levar a
 * navegação junto.
 */
export class Session {
  readonly session_id: string;
  #transport: Transport;
  #info: SessionInfo;
  #client: string;

  constructor(transport: Transport, info: SessionInfo, client: string) {
    this.#transport = transport;
    this.#info = info;
    this.#client = client;
    this.session_id = info.session_id;
  }

  get id(): string {
    return this.session_id;
  }

  /** Último `SessionInfo` conhecido. Use `refresh()` para reler do runtime. */
  get info(): SessionInfo {
    return this.#info;
  }

  #act<T>(tool: string, body: Record<string, unknown> = {}, opts?: RequestOptions): Promise<T> {
    return this.#transport.action<T>(tool, { session_id: this.session_id, ...body }, opts);
  }

  async #manage(
    method: "GET" | "POST" | "DELETE",
    suffix: string,
    body?: Record<string, unknown>,
  ): Promise<SessionInfo> {
    const info = await this.#transport.management<SessionInfo>(
      method,
      `${API_PREFIX}/sessions/${encodeURIComponent(this.session_id)}${suffix}`,
      body,
    );
    this.#info = info;
    return info;
  }

  // ── navegação ──────────────────────────────────────────────────────────────

  open(url: string): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.open", { url });
  }

  goto(url: string, opts: GotoOptions = {}): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.goto", pruned({ url, wait_until: opts.wait_until }));
  }

  back(): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.back");
  }

  forward(): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.forward");
  }

  reload(): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.reload");
  }

  // ── percepção ──────────────────────────────────────────────────────────────

  observe(opts: ObserveOptions = {}): Promise<Observation> {
    return this.#act<Observation>("browser.observe", pruned({ ...opts }));
  }

  find(target: TargetDescriptor): Promise<ResolvedTarget> {
    return this.#act<ResolvedTarget>("browser.find", { target });
  }

  extract(opts: ExtractOptions = {}): Promise<{ content: unknown }> {
    return this.#act<{ content: unknown }>("browser.extract", pruned({ ...opts }));
  }

  screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    return this.#act<ScreenshotResult>("browser.screenshot", pruned({ ...opts }));
  }

  network(opts: NetworkOptions = {}): Promise<NetworkResult> {
    return this.#act<NetworkResult>("browser.network", pruned({ ...opts }));
  }

  // ── ação ───────────────────────────────────────────────────────────────────

  click(target: TargetDescriptor, opts: ActOptions = {}): Promise<ActResult> {
    return this.#act<ActResult>("browser.click", pruned({ target, verification: opts.verification }));
  }

  /**
   * Digita texto ou injeta um segredo POR REFERÊNCIA.
   * Passando `{credential_ref}` o valor nunca transita pelo processo do agente:
   * quem resolve é o vault do runtime, e a resposta não devolve o segredo.
   */
  type(target: TargetDescriptor, value: string | CredentialRef, opts: ActOptions = {}): Promise<ActResult> {
    const payload: Record<string, unknown> =
      typeof value === "string" ? { text: value } : { credential_ref: value.credential_ref };
    return this.#act<ActResult>("browser.type", pruned({ target, ...payload, verification: opts.verification }));
  }

  press(key: string | string[]): Promise<{ pressed: unknown }> {
    const payload = Array.isArray(key) ? { keys: key } : { key };
    return this.#act<{ pressed: unknown }>("browser.press", payload);
  }

  scroll(opts: ScrollOptions = {}): Promise<{ scrolled: unknown }> {
    return this.#act<{ scrolled: unknown }>("browser.scroll", pruned({ ...opts }));
  }

  drag(from: TargetDescriptor, to: TargetDescriptor): Promise<{ dragged: unknown }> {
    return this.#act<{ dragged: unknown }>("browser.drag", { from, to });
  }

  // ── abas ───────────────────────────────────────────────────────────────────

  tabs(): Promise<PageInfo[]> {
    return this.#act<PageInfo[]>("browser.tabs");
  }

  newTab(url?: string): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.new_tab", pruned({ url }));
  }

  switchTab(page_id: string): Promise<PageInfo> {
    return this.#act<PageInfo>("browser.switch_tab", { page_id });
  }

  closeTab(page_id: string): Promise<{ closed: unknown }> {
    return this.#act<{ closed: unknown }>("browser.close_tab", { page_id });
  }

  // ── transferência de arquivo (COMMIT — o runtime pode negar por capability) ──

  download(opts: DownloadOptions = {}): Promise<DownloadRecord> {
    return this.#act<DownloadRecord>("browser.download", pruned({ ...opts }));
  }

  upload(opts: UploadOptions): Promise<UploadRecord> {
    return this.#act<UploadRecord>("browser.upload", pruned({ ...opts }));
  }

  // ── espera e task ──────────────────────────────────────────────────────────

  wait(opts: WaitOptions): Promise<{ waited_ms: number }> {
    // O socket não pode expirar antes da espera pedida, senão o SDK reportaria
    // TIMEOUT de rede onde houve, na verdade, condição não satisfeita.
    const req: RequestOptions | undefined =
      opts.timeout_ms === undefined ? undefined : { timeout_ms: opts.timeout_ms + WAIT_MARGIN_MS };
    return this.#act<{ waited_ms: number }>("browser.wait", pruned({ ...opts }), req);
  }

  task(opts: TaskOptions): Promise<BrowserTask> {
    return this.#act<BrowserTask>("browser.task", pruned({ ...opts }));
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────────

  /** Relê o `SessionInfo` do runtime. */
  refresh(): Promise<SessionInfo> {
    return this.#manage("GET", "");
  }

  attach(client?: string): Promise<SessionInfo> {
    return this.#manage("POST", "/attach", { client: client ?? this.#client });
  }

  /** Solta o cliente. A sessão **continua viva** — nenhum DELETE é enviado. */
  detach(): Promise<SessionInfo> {
    return this.#manage("POST", "/detach");
  }

  handoff(to_owner: string): Promise<SessionInfo> {
    return this.#manage("POST", "/handoff", { to_owner });
  }

  /** Humano assume; o agente congela. */
  takeover(): Promise<SessionInfo> {
    return this.#manage("POST", "/takeover");
  }

  /** Devolve o controle ao agente; o runtime reobserva a página. */
  release(): Promise<SessionInfo> {
    return this.#manage("POST", "/release");
  }

  /** Encerra a sessão no runtime. Irreversível — não é o mesmo que `detach()`. */
  async close(): Promise<{ closed: boolean }> {
    return this.#transport.management<{ closed: boolean }>(
      "DELETE",
      `${API_PREFIX}/sessions/${encodeURIComponent(this.session_id)}`,
    );
  }
}

/** Remove chaves `undefined` para não enviar campo vazio que o runtime leria como presente. */
export function pruned(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
