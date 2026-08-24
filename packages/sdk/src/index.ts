/**
 * @nomos/browser — SDK TypeScript do NOMOS Browser Runtime.
 *
 *   const browser = new NomosBrowser();
 *   const session = await browser.createSession();
 *   await session.goto("https://example.com");
 *   await session.click({ text: "Login" });
 *
 * Cliente HTTP puro (fetch nativo) + WebSocket (`ws`) para eventos. Nenhuma
 * dependência de navegador: o SDK é a fronteira REMOTA do runtime.
 */
import WebSocket from "ws";
import { API_PREFIX } from "../../core/src/contract.ts";
import type {
  ActionResponse,
  EventName,
  HealthResponse,
  RuntimeEvent,
  SessionInfo,
} from "../../core/src/contract.ts";
import { NomosBrowserError, Session, pruned } from "./session.ts";
import type { CreateSessionOptions, RequestOptions, Transport } from "./session.ts";

export { NomosBrowserError, Session } from "./session.ts";
export type {
  ActOptions,
  ActResult,
  CreateSessionOptions,
  DownloadOptions,
  ExtractOptions,
  GotoOptions,
  NetworkOptions,
  NetworkResult,
  NomosBrowserErrorInit,
  ObserveOptions,
  RequestOptions,
  ScreenshotOptions,
  ScreenshotResult,
  ScreenshotScope,
  ScrollOptions,
  TaskOptions,
  Transport,
  UploadOptions,
  WaitCondition,
  WaitOptions,
} from "./session.ts";

export const DEFAULT_URL = "http://127.0.0.1:7777";
export const DEFAULT_OWNER = "nomos-sdk";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface NomosBrowserOptions {
  /** Base do runtime. Default `http://127.0.0.1:7777` — loopback, nunca exposto. */
  url?: string;
  /** Dono das sessões criadas por este cliente. */
  owner?: string;
  /** Timeout de rede por requisição, em ms. */
  timeout_ms?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transporte HTTP
// ─────────────────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  body: unknown;
}

function isErrorEnvelope(body: unknown): body is ActionResponse<unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    "success" in body &&
    (body as { success: unknown }).success === false &&
    "error" in body
  );
}

/**
 * Traduz falha de transporte em `NomosBrowserError`.
 * `ActionErrorCode` é um enum FECHADO no contrato: recusa de conexão, DNS morto
 * e socket cortado não têm código próprio, então caem em INTERNAL com a causa
 * anexada — inventar um código novo exigiria subir a versão do contrato.
 */
function transportError(cause: unknown, method: string, path: string, timeout_ms: number): NomosBrowserError {
  const name = typeof cause === "object" && cause !== null ? (cause as { name?: string }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new NomosBrowserError("TIMEOUT", `${method} ${path} excedeu ${timeout_ms} ms`, {
      detail: { method, path, timeout_ms },
      cause,
    });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new NomosBrowserError("INTERNAL", `falha de transporte em ${method} ${path}: ${message}`, {
    detail: { method, path },
    cause,
  });
}

class HttpTransport implements Transport {
  #base: string;
  #timeout: number;

  readonly token: string | null;

  constructor(base: string, timeout_ms: number, token: string | null = null) {
    this.token = token;
    this.#base = base;
    this.#timeout = timeout_ms;
  }

  get base(): string {
    return this.#base;
  }

  async #raw(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    opts: RequestOptions | undefined,
  ): Promise<RawResponse> {
    const timeout_ms = opts?.timeout_ms ?? this.#timeout;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Credencial do control plane (FASE 15). Ausência não é erro aqui: o 401
    // vem do runtime, que é quem tem autoridade para negar.
    if (this.token !== null) headers["authorization"] = `Bearer ${this.token}`;

    let status: number;
    let text: string;
    try {
      const res = await fetch(`${this.#base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout_ms),
      });
      status = res.status;
      // A leitura do corpo também está sob o mesmo sinal: um servidor que abre a
      // resposta e nunca a fecha é timeout, não sucesso.
      text = await res.text();
    } catch (cause) {
      throw transportError(cause, method, path, timeout_ms);
    }

    if (text.length === 0) return { status, body: undefined };
    try {
      return { status, body: JSON.parse(text) };
    } catch (cause) {
      throw new NomosBrowserError("INTERNAL", `resposta não-JSON em ${method} ${path} (HTTP ${status})`, {
        httpStatus: status,
        detail: { method, path, body_preview: text.slice(0, 200) },
        cause,
      });
    }
  }

  async action<T>(tool: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<T> {
    const { status, body: parsed } = await this.#raw("POST", `${API_PREFIX}/${tool}`, body, opts);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as ActionResponse<T>).success !== "boolean") {
      // Sem envelope não há como saber se a ação ocorreu. Falhar é a única
      // resposta honesta; devolver null seria fabricar sucesso.
      throw new NomosBrowserError("INTERNAL", `envelope ausente ou inválido em ${tool} (HTTP ${status})`, {
        httpStatus: status,
        detail: { tool },
      });
    }
    const envelope = parsed as ActionResponse<T>;
    if (!envelope.success) throw NomosBrowserError.fromEnvelope(envelope, status);
    return envelope.result as T;
  }

  async management<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<T> {
    const { status, body: parsed } = await this.#raw(method, path, body, opts);
    // Rotas de gestão respondem o objeto direto; em erro o runtime devolve o
    // envelope, e é dele que sai o código de negócio.
    if (isErrorEnvelope(parsed)) throw NomosBrowserError.fromEnvelope(parsed, status);
    if (status < 200 || status >= 300) {
      throw new NomosBrowserError("INTERNAL", `HTTP ${status} em ${method} ${path}`, {
        httpStatus: status,
        detail: { method, path },
      });
    }
    return parsed as T;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream de eventos
// ─────────────────────────────────────────────────────────────────────────────

export interface EventFilter {
  session_id?: string;
  events?: EventName[];
}

export interface EventStreamOptions extends EventFilter {
  /**
   * Teto ABSOLUTO de reconexões no ciclo de vida do stream. Não é reiniciado em
   * conexão bem-sucedida de propósito: um runtime que aceita e derruba em loop
   * manteria o cliente girando para sempre com contador que zera.
   */
  max_reconnects?: number;
  backoff_base_ms?: number;
  backoff_max_ms?: number;
  /** Teto da fila do consumidor lento. Estourou, o stream falha — não descarta em silêncio. */
  max_queue?: number;
}

const DEFAULT_MAX_RECONNECTS = 10;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 10_000;
const DEFAULT_MAX_QUEUE = 1_000;

interface Waiter {
  resolve: (r: IteratorResult<RuntimeEvent>) => void;
  reject: (e: unknown) => void;
}

/**
 * `AsyncIterable<RuntimeEvent>` sobre o WebSocket `/events` do runtime.
 * Fecha com `close()` ou saindo do `for await` (`break` chama `return()`).
 */
export class EventStream implements AsyncIterableIterator<RuntimeEvent> {
  readonly url: string;
  #queue: RuntimeEvent[] = [];
  #waiters: Waiter[] = [];
  #ws: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reconnects = 0;
  #maxReconnects: number;
  #backoffBase: number;
  #backoffMax: number;
  #maxQueue: number;
  #closed = false;
  #failure: NomosBrowserError | null = null;

  constructor(base: string, opts: EventStreamOptions = {}) {
    this.url = eventsUrl(base, opts);
    this.#maxReconnects = opts.max_reconnects ?? DEFAULT_MAX_RECONNECTS;
    this.#backoffBase = opts.backoff_base_ms ?? DEFAULT_BACKOFF_BASE_MS;
    this.#backoffMax = opts.backoff_max_ms ?? DEFAULT_BACKOFF_MAX_MS;
    this.#maxQueue = opts.max_queue ?? DEFAULT_MAX_QUEUE;
    // Conexão é ansiosa: eventos entre a chamada e o primeiro `next()` seriam
    // perdidos se esperássemos o consumidor pedir.
    this.#connect();
  }

  /** Quantas reconexões já foram gastas do teto. */
  get reconnects(): number {
    return this.#reconnects;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<RuntimeEvent> {
    return this;
  }

  next(): Promise<IteratorResult<RuntimeEvent>> {
    const buffered = this.#queue.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<RuntimeEvent>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<RuntimeEvent>> {
    await this.close();
    return { value: undefined, done: true };
  }

  async throw(e?: unknown): Promise<IteratorResult<RuntimeEvent>> {
    await this.close();
    throw e;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w.resolve({ value: undefined, done: true });
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.terminate();
      });
    }
  }

  #connect(): void {
    if (this.#closed) return;
    const ws = new WebSocket(this.url);
    this.#ws = ws;
    ws.on("message", (data: unknown) => this.#onMessage(data));
    // 'error' e 'close' são tratados pelo mesmo caminho; `#scheduleReconnect`
    // é idempotente enquanto houver timer pendente.
    ws.on("error", () => this.#scheduleReconnect(ws));
    ws.on("close", () => this.#scheduleReconnect(ws));
  }

  #onMessage(data: unknown): void {
    let text: string;
    if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString("utf8");
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else text = String(data);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      this.#fail(
        new NomosBrowserError("INTERNAL", "frame não-JSON no stream de eventos", {
          detail: { frame_preview: text.slice(0, 200) },
          cause,
        }),
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as RuntimeEvent).event !== "string") {
      this.#fail(new NomosBrowserError("INTERNAL", "frame do stream não é um RuntimeEvent", {}));
      return;
    }
    this.#push(parsed as RuntimeEvent);
  }

  #push(event: RuntimeEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
    if (this.#queue.length > this.#maxQueue) {
      this.#fail(
        new NomosBrowserError(
          "BACKPRESSURE_REJECTED",
          `consumidor lento: fila de eventos passou de ${this.#maxQueue}`,
          { detail: { max_queue: this.#maxQueue } },
        ),
      );
    }
  }

  #scheduleReconnect(from: WebSocket): void {
    if (this.#closed || this.#timer !== null) return;
    if (this.#ws !== null && this.#ws !== from) return; // socket já substituído
    this.#ws = null;
    if (this.#reconnects >= this.#maxReconnects) {
      this.#fail(
        new NomosBrowserError(
          "INTERNAL",
          `stream de eventos caiu e o teto de ${this.#maxReconnects} reconexões foi atingido`,
          { detail: { url: this.url, max_reconnects: this.#maxReconnects } },
        ),
      );
      return;
    }
    const attempt = this.#reconnects;
    this.#reconnects += 1;
    const delay = Math.min(this.#backoffBase * 2 ** attempt, this.#backoffMax);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, delay);
  }

  #fail(error: NomosBrowserError): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    ws?.terminate();
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w.reject(error);
  }
}

/** `http(s)://host/...` → `ws(s)://host/events?...` com o filtro em query. */
export function eventsUrl(base: string, filter: EventFilter): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/events";
  u.search = "";
  if (filter.session_id !== undefined) u.searchParams.set("session_id", filter.session_id);
  if (filter.events !== undefined && filter.events.length > 0) {
    u.searchParams.set("events", filter.events.join(","));
  }
  return u.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente
// ─────────────────────────────────────────────────────────────────────────────

export class NomosBrowser {
  readonly url: string;
  readonly owner: string;
  readonly timeout_ms: number;
  #transport: HttpTransport;
  #streams = new Set<EventStream>();

  constructor(opts: NomosBrowserOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/+$/, "");
    this.owner = opts.owner ?? DEFAULT_OWNER;
    this.timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.#transport = new HttpTransport(this.url, this.timeout_ms);
  }

  /** Acesso ao transporte para quem precisa falar rota nova sem esperar o SDK. */
  get transport(): Transport {
    return this.#transport;
  }

  health(): Promise<HealthResponse> {
    return this.#transport.management<HealthResponse>("GET", "/health");
  }

  sessions(): Promise<SessionInfo[]> {
    return this.#transport.management<SessionInfo[]>("GET", `${API_PREFIX}/sessions`);
  }

  async createSession(opts: CreateSessionOptions = {}): Promise<Session> {
    const info = await this.#transport.management<SessionInfo>("POST", `${API_PREFIX}/sessions`, {
      owner: opts.owner ?? this.owner,
      ...pruned({ profile: opts.profile, capabilities: opts.capabilities, headless: opts.headless }),
    });
    return new Session(this.#transport, info, this.owner);
  }

  /** Reata a uma sessão que sobreviveu ao agente anterior. */
  async session(session_id: string): Promise<Session> {
    const info = await this.#transport.management<SessionInfo>(
      "GET",
      `${API_PREFIX}/sessions/${encodeURIComponent(session_id)}`,
    );
    return new Session(this.#transport, info, this.owner);
  }

  events(filter: EventStreamOptions = {}): EventStream {
    const stream = new EventStream(this.url, filter);
    this.#streams.add(stream);
    return stream;
  }

  /** Fecha todos os streams abertos por este cliente. Não toca nas sessões. */
  async close(): Promise<void> {
    const streams = [...this.#streams];
    this.#streams.clear();
    await Promise.all(streams.map((s) => s.close()));
  }
}

export default NomosBrowser;
