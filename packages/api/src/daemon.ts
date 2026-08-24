/**
 * FASE 2 / 4 / 5 / 43 / 44 — DAEMON nomos-browser
 *
 * `node:http` puro + `ws`. Sem framework: a superfície de dependência do runtime
 * inteiro são `playwright` e `ws`, ambas pinadas.
 *
 * Quatro invariantes que este arquivo existe para sustentar:
 *
 *  1. O DAEMON SOBREVIVE AO CLIENTE (FASE 3/44). Fechar o WebSocket ou derrubar o
 *     socket HTTP cancela uma ASSINATURA, nunca uma sessão. Não há um único
 *     caminho de código em que `req.on("close")` toque no SessionManager. É por
 *     isso que `detach` é uma rota explícita: desconectar tem de ser um ato, não
 *     um efeito colateral de a TCP cair.
 *
 *  2. FAIL CLOSED ANTES DO NAVEGADOR (FASE 19). Capability é checada antes de
 *     enfileirar; negada devolve 403 + CAPABILITY_DENIED sem que o Chromium
 *     chegue a ser tocado. Ferramenta desconhecida é negada pelo mesmo caminho.
 *
 *  3. BACKPRESSURE VISÍVEL (FASE 43). Fila POR SESSÃO com teto de concorrência e
 *     de espera. Estourar devolve BACKPRESSURE_REJECTED na hora — não enfileira
 *     infinitamente, não trava o event loop, não degrada em silêncio. Prazo por
 *     ação devolve TIMEOUT, e o envelope diz que a ação pode continuar correndo.
 *
 *  4. O ENVELOPE É A ÚNICA SAÍDA DE ERRO. Nenhuma rota devolve HTML de stack
 *     trace; até 404 de rota inexistente sai como ActionResponse.
 */
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  API_PREFIX,
  CONTRACT_VERSION,
  fail,
  newActionId,
  ok,
  timer,
  type ActionErrorCode,
  type ActionResponse,
  type AgentProvider,
  type Capabilities,
  type HealthResponse,
  type RuntimeEvent,
  type SessionInfo,
  type SessionState,
} from "../../core/src/contract.ts";
import { SessionManager, normalizeCapabilities } from "../../core/src/session.ts";
import { CapabilityEngine, policyFromName } from "../../core/src/policy.ts";
import { PerceptionEngine } from "../../core/src/perception.ts";
import { EventBus } from "../../observability/src/eventbus.ts";
import { AuditLog } from "../../observability/src/audit.ts";
import { loadConfig, type DaemonConfig, type LoadConfigOptions } from "./config.ts";
import { EVENTS_PATH, httpStatusFor, matchRoute, parseEventFilter } from "./router.ts";
import { AuthManager, scopeForRoute, scopeForTool, type IssuedToken } from "./auth.ts";
import { LeaseManager, CONTROL_NOT_OWNED, CONTROL_NOT_OWNED_CODE } from "../../core/src/lease.ts";
import { RecoveryManager } from "../../core/src/recovery.ts";

/** Raiz do pacote de UI, resolvida a partir deste arquivo (não do cwd do processo). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
import {
  ApiError,
  RuntimeServices,
  auditEntryFor,
  handlerFor,
  toActionError,
  type ActionRequest,
  type Body,
} from "./handlers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fila por sessão (FASE 43)
// ─────────────────────────────────────────────────────────────────────────────

interface QueueJob {
  cancelled: boolean;
  start: () => void;
}

export class SessionQueue {
  readonly concurrency: number;
  readonly maxQueue: number;
  #running = 0;
  #waiting: QueueJob[] = [];

  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  get running(): number {
    return this.#running;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Enfileira com prazo TOTAL (espera + execução): é o tempo que o cliente de
   * fato aguarda. Estourado o prazo, a promessa rejeita com TIMEOUT; a ação em
   * voo não é abortada (o Playwright não oferece cancelamento cooperativo aqui),
   * e o envelope diz isso em `detail.still_running` em vez de sugerir que parou.
   */
  submit<T>(fn: () => Promise<T>, timeout_ms: number): Promise<T> {
    if (this.#running >= this.concurrency && this.#waiting.length >= this.maxQueue) {
      return Promise.reject(
        new ApiError(
          "BACKPRESSURE_REJECTED",
          `fila da sessão cheia: ${this.#running} em execução e ${this.#waiting.length}/${this.maxQueue} aguardando`,
          { running: this.#running, waiting: this.#waiting.length, max_queue: this.maxQueue, concurrency: this.concurrency },
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let started = false;
      const job: QueueJob = {
        cancelled: false,
        start: () => {
          if (job.cancelled) return;
          started = true;
          this.#running += 1;
          void (async () => {
            try {
              const value = await fn();
              if (!job.cancelled) {
                clearTimeout(deadline);
                resolve(value);
              }
            } catch (e) {
              if (!job.cancelled) {
                clearTimeout(deadline);
                reject(e);
              }
            } finally {
              this.#running -= 1;
              this.#pump();
            }
          })();
        },
      };

      const deadline = setTimeout(() => {
        job.cancelled = true;
        const idx = this.#waiting.indexOf(job);
        if (idx >= 0) this.#waiting.splice(idx, 1);
        reject(
          new ApiError("TIMEOUT", `ação excedeu ${timeout_ms}ms`, {
            timeout_ms,
            queued: !started,
            still_running: started,
          }),
        );
      }, timeout_ms);
      deadline.unref();

      this.#waiting.push(job);
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#running < this.concurrency && this.#waiting.length > 0) {
      const job = this.#waiting.shift()!;
      job.start();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly config: DaemonConfig;
  readonly sessions: SessionManager;
  readonly bus: EventBus;
  readonly services: RuntimeServices;
  readonly startedAt: number;
  /** Arbitragem de controle entre agentes (FASE 9). */
  readonly leases: LeaseManager;
  /** Segredo do token raiz. Devolvido UMA vez; nunca vai para log. */
  readonly token: string | null;
  readonly tokenPath: string | null;
  health(): HealthResponse;
  close(reason?: string): Promise<void>;
}

export interface StartDaemonOptions extends LoadConfigOptions {
  /** Provedor de agente para `browser.task`. Ausente ⇒ a rota falha explicitamente. */
  agent?: AgentProvider | null;
  /**
   * Instala handlers de SIGINT/SIGTERM. Default false: um daemon embutido em
   * teste que sequestrasse os sinais do processo seria efeito colateral escondido.
   */
  install_signal_handlers?: boolean;
  /**
   * Desliga a exigencia de credencial. Existe para migracao e para testes que
   * ainda nao carregam token; NUNCA deve ser usado em operacao real. O daemon
   * avisa em stderr quando arranca assim.
   */
  auth_disabled?: boolean;
  /** Diretorio onde o token efemero do daemon e gravado (0600). */
  runtime_dir?: string;
}

const MAX_URL_LENGTH = 8192;

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * `status` explícito existe porque roteamento tem status próprio (404/405) que
 * não sai de `ActionErrorCode` — o código de negócio continua no envelope.
 */
function envelopeError(
  res: http.ServerResponse,
  action_id: string,
  state: SessionState,
  code: ActionErrorCode,
  message: string,
  detail?: Record<string, unknown>,
  status?: number,
): void {
  const t = timer();
  jsonResponse(res, status ?? httpStatusFor(code), fail(action_id, state, code, message, t.done(), detail));
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) {
      throw new ApiError("INVALID_REQUEST", `corpo maior que ${max} bytes`, { max_body_bytes: max });
    }
    chunks.push(buf);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    throw new ApiError("INVALID_REQUEST", `corpo não é JSON válido: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("INVALID_REQUEST", "corpo deve ser um objeto JSON");
  }
  return parsed as Body;
}

function capabilitiesFromBody(body: Body): Partial<Capabilities> | undefined {
  const policyName = body.policy;
  const raw = body.capabilities;
  if (policyName !== undefined && raw !== undefined) {
    throw new ApiError("INVALID_REQUEST", "informe `policy` OU `capabilities`, não os dois");
  }
  if (policyName !== undefined) {
    // policyFromName recusa "full" por desenho: privilégio total não se conquista
    // escrevendo uma string num corpo JSON.
    return { ...policyFromName(policyName) };
  }
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_REQUEST", "capabilities deve ser objeto");
  }
  return raw as Partial<Capabilities>;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const { agent = null, install_signal_handlers = false, auth_disabled = false, runtime_dir, ...configOpts } = opts;
  const config = loadConfig(configOpts);
  const startedAt = Date.now();

  const auth = new AuthManager({
    disabled: auth_disabled,
    ...(runtime_dir !== undefined ? { runtime_dir } : {}),
  });
  // Token de arranque: efemero, gravado 0600, nunca impresso. O segredo so
  // aparece no retorno de startDaemon() e no arquivo — nao em log, nem em
  // evento, nem em audit.
  const rootToken: IssuedToken | null = auth_disabled ? null : auth.bootstrap();

  // FASE 9/10 — arbitragem de controle.
  //
  // `handoff` trocava o dono, mas nada impedia o agente B de mandar um clique
  // enquanto A ainda operava: dois donos lógicos disputando o mesmo Chromium.
  // `allow_unleased` fica LIGADO para não quebrar o cliente de agente único que
  // nunca pediu lease — mas assim que alguém adquire, os demais são barrados.
  const leases = new LeaseManager({ allow_unleased: true });

  // FASE 11-14 — snapshot de sessão em disco.
  //
  // Sem isto o `RecoveryManager` existe mas nunca tem o que recuperar: depois de
  // um SIGKILL o `scan()` devolve lista VAZIA, e um teste que percorre essa lista
  // passa por vacuidade. Foi exatamente o que aconteceu na primeira execução
  // deste gate — o flag ficou verde sem que nada tivesse sido recuperado.
  const recovery = new RecoveryManager(
    config.sessions_root !== null ? { root: config.sessions_root } : {},
  );

  /** Grava o estado da sessão. Falha aqui NÃO derruba a ação — só perde o recovery. */
  async function snapshot(session_id: string): Promise<void> {
    try {
      const info = await sessions.observe(session_id);
      const ctx = sessions.contextInfo(session_id);
      const ativa = info.pages.find((p) => p.active) ?? info.pages[0];
      await recovery.save({
        session_id,
        owner: info.owner,
        profile: info.profile,
        url: ativa?.url ?? null,
        page_ids: info.pages.map((p) => p.page_id),
        context_id: info.context_id,
        capabilities: info.permissions,
        cdp_endpoint: null,
        browser_pid: process.pid,
        browser_id: ctx.context_id,
        status: info.status,
        ephemeral: ctx.ephemeral,
      });
    } catch (e) {
      console.error("[daemon] snapshot falhou:", (e as Error).message);
    }
  }

  const bus = new EventBus({
    bufferSize: config.event_buffer,
    onHandlerError: (error, event, subscriberId) => {
      console.error(`[daemon] handler de evento falhou (${subscriberId}, ${event.event}):`, (error as Error).message);
    },
  });

  const sessions = new SessionManager({
    max_workers: config.max_workers,
    headless: config.headless,
    viewport: config.viewport,
    ...(config.profiles_root !== null ? { profiles_root: config.profiles_root } : {}),
    onEvent: (e: RuntimeEvent) => {
      bus.emit(e);
    },
  });

  const services = new RuntimeServices({
    config,
    sessions,
    bus,
    perception: new PerceptionEngine({ observeLimit: config.observe_limit }),
    policy: new CapabilityEngine({
      defaultPolicy: config.default_policy,
      ...(config.upload_root !== null ? { uploadRoot: config.upload_root } : {}),
      ...(config.download_root !== null ? { downloadRoot: config.download_root } : {}),
    }),
    audit: config.audit
      ? new AuditLog(config.sessions_root !== null ? { root: config.sessions_root } : {})
      : null,
    agent,
  });

  const queues = new Map<string, SessionQueue>();
  const queueFor = (session_id: string): SessionQueue => {
    const found = queues.get(session_id);
    if (found !== undefined) return found;
    const made = new SessionQueue(config.max_concurrency, config.max_queue);
    queues.set(session_id, made);
    return made;
  };

  let shuttingDown = false;
  /** Porta efetiva. Só é conhecida depois do listen (config.port pode ser 0). */
  let boundPort = config.port;

  const health = (): HealthResponse => {
    const stats = sessions.poolStats();
    const browser: HealthResponse["browser"] =
      stats.contexts > 0 ? "ok" : stats.sessions.total > 0 ? "down" : "starting";
    return {
      runtime: shuttingDown ? "down" : "ok",
      browser,
      workers: stats.workers,
      sessions: stats.sessions,
      version: config.version,
      contract: CONTRACT_VERSION,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
  };

  // ── rotas de gestão ────────────────────────────────────────────────────────

  async function handleManagement(
    name: string,
    params: Record<string, string>,
    body: Body,
    client: string | null,
  ): Promise<unknown> {
    switch (name) {
      case "health":
        return health();
      case "sessions.list": {
        const include_closed = body.include_closed === true;
        return sessions.list({ include_closed });
      }
      case "sessions.create": {
        const owner = body.owner;
        if (typeof owner !== "string" || owner.trim() === "") {
          throw new ApiError("INVALID_REQUEST", "owner é obrigatório");
        }
        const caps = capabilitiesFromBody(body);
        const info = await sessions.createSession({
          owner,
          ...(typeof body.profile === "string" ? { profile: body.profile } : {}),
          ...(caps !== undefined ? { capabilities: normalizeCapabilities(caps) } : {}),
          ...(typeof body.headless === "boolean" ? { headless: body.headless } : {}),
          ...(typeof body.url === "string" ? { url: body.url } : {}),
          ...(typeof body.task === "string" ? { task: body.task } : {}),
          client: typeof body.client === "string" ? body.client : client,
        });
        await snapshot(info.session_id);
        return info;
      }
      case "sessions.get":
        return sessions.observe(params.id!);
      case "sessions.delete": {
        const id = params.id!;
        await sessions.closeSession(id, typeof body.reason === "string" ? body.reason : "requested");
        // Sessão fechada de propósito não é órfã: deixar o snapshot faria o
        // próximo arranque tentar recuperar algo que o dono já encerrou.
        await recovery.remove(id).catch(() => undefined);
        services.forget(id);
        queues.delete(id);
        return { closed: true, session_id: id };
      }
      case "sessions.attach": {
        const who = typeof body.client === "string" ? body.client : client;
        if (who === null) throw new ApiError("INVALID_REQUEST", "attach exige `client` no corpo ou header x-nomos-client");
        return sessions.attach(params.id!, who, { force: body.force === true });
      }
      case "sessions.detach":
        // Desconecta o CLIENTE. A sessão continua viva, órfã e reatável.
        return sessions.detach(params.id!);
      case "sessions.handoff": {
        const to_owner = body.to_owner;
        if (typeof to_owner !== "string" || to_owner.trim() === "") {
          throw new ApiError("INVALID_REQUEST", "handoff exige `to_owner`");
        }
        return sessions.handoff(params.id!, to_owner, {
          ...(body.client === null || typeof body.client === "string" ? { client: body.client as string | null } : {}),
        });
      }
      case "sessions.takeover":
        return sessions.takeover(params.id!, typeof body.actor === "string" ? body.actor : "human");
      case "sessions.release":
        return sessions.release(params.id!, typeof body.actor === "string" ? body.actor : "human");
      default:
        throw new ApiError("INTERNAL", `rota de gestão sem implementação: ${name}`);
    }
  }

  // ── rota de ação ───────────────────────────────────────────────────────────

  async function handleAction(
    tool: string,
    body: Body,
    query: URLSearchParams,
    client: string | null,
    res: http.ServerResponse,
  ): Promise<void> {
    const action_id = newActionId();
    const t = timer();
    const session_id =
      typeof body.session_id === "string" && body.session_id !== ""
        ? body.session_id
        : (query.get("session_id") ?? "");

    if (session_id === "") {
      jsonResponse(
        res,
        httpStatusFor("INVALID_REQUEST"),
        fail(action_id, "FAILED", "INVALID_REQUEST", "session_id é obrigatório (corpo ou ?session_id=)", t.done()),
      );
      return;
    }

    const req: ActionRequest = { tool, action_id, session_id, body, client };

    let info: SessionInfo;
    try {
      info = sessions.get(session_id);
    } catch (e) {
      const err = toActionError(e);
      await services.record(auditEntryFor(req, "error", false, { code: err.code }));
      jsonResponse(res, httpStatusFor(err.code), fail(action_id, "FAILED", err.code, err.message, t.done(), err.detail));
      return;
    }

    // 1. CAPABILITY — antes de qualquer contato com o navegador.
    const decision = services.policy.check(tool, info.permissions, info.owner);
    if (!decision.allowed) {
      const code = decision.code ?? "CAPABILITY_DENIED";
      await services.record(auditEntryFor(req, "denied", false, { required: decision.required, reason: decision.reason }));
      services.emit("action.failed", session_id, action_id, { tool, code, reason: decision.reason }, client ?? "agent");
      jsonResponse(
        res,
        httpStatusFor(code),
        fail(action_id, info.status, code, decision.reason, t.done(), {
          tool,
          required: decision.required,
          class: decision.class,
          source: decision.source,
        }),
      );
      return;
    }

    // 2. CONTROLE HUMANO — o agente congela enquanto o humano tem o volante.
    //
    // Congela TUDO, inclusive OBSERVE. Foi tentador liberar observação para a
    // NOMOS Web continuar espelhando a página, mas o humano assume o controle
    // justamente para fazer o que não quer delegar — digitar senha, código 2FA,
    // confirmar algo sensível. Ler o DOM nesse instante é o vazamento que o
    // takeover existe para evitar. Em headful o humano olha a janela real do
    // Chromium; o espelho não é necessário. O cliente é que deve parar de
    // pedir screenshot enquanto está congelado.
    if (info.control === "human") {
      const message = `sessão ${session_id} está sob controle humano`;
      await services.record(auditEntryFor(req, "denied", false, { reason: "control_held_by_human" }));
      jsonResponse(
        res,
        httpStatusFor("CONTROL_HELD_BY_HUMAN"),
        fail(action_id, info.status, "CONTROL_HELD_BY_HUMAN", message, t.done(), { session_id }),
      );
      return;
    }

    const handler = handlerFor(tool);
    if (handler === null) {
      // Só chega aqui se o contrato declarar uma ferramenta sem handler — é
      // inconsistência interna, não pedido inválido do cliente.
      envelopeError(res, action_id, info.status, "INTERNAL", `ferramenta sem handler: ${tool}`);
      return;
    }

    services.emit("action.started", session_id, action_id, { tool }, client ?? "agent");

    try {
      const result = await queueFor(session_id).submit(() => handler(services, req), config.action_timeout_ms);
      const state = sessions.has(session_id) ? sessions.get(session_id).status : info.status;
      const verified =
        typeof result === "object" && result !== null && "verification" in result
          ? ((result as { verification?: { verified?: boolean } }).verification?.verified ?? false)
          : false;
      await services.record(auditEntryFor(req, "ok", verified));
      services.emit("action.completed", session_id, action_id, { tool, verified }, client ?? "agent");
      jsonResponse(res, 200, ok(action_id, state, result, t.done()));
    } catch (e) {
      const err = toActionError(e);
      const state = sessions.has(session_id) ? sessions.get(session_id).status : "FAILED";
      await services.record(auditEntryFor(req, "error", false, { code: err.code }));
      services.emit("action.failed", session_id, action_id, { tool, code: err.code }, client ?? "agent");
      jsonResponse(
        res,
        httpStatusFor(err.code),
        fail(action_id, state, err.code, err.message, t.done(), err.detail),
      );
    }
  }

  // ── servidor HTTP ──────────────────────────────────────────────────────────

  /**
   * Entrega a NOMOS Web já construída. Não constrói aqui de propósito: o build
   * lê tokens do cofre de marca e pode falhar fechado (marca em quarentena,
   * governança inacessível). Um runtime que morre porque a marca não resolveu
   * seria acoplamento errado — o runtime é independente da marca.
   */
  function serveUi(res: http.ServerResponse, token: string | null): void {
    const dist = path.join(UI_DIR, "dist", "index.html");
    if (!existsSync(dist)) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("NOMOS Web não construída. Rode: node packages/ui/build.ts\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // A UI não embute recurso externo; a CSP torna isso verificável.
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      "x-content-type-options": "nosniff",
    });
    // O token entra na página servida a quem JÁ o apresentou. Não é vazamento:
    // é a mesma credencial voltando para a mesma origem, para que os fetch()
    // seguintes não precisem repeti-la na URL (onde ficaria no histórico).
    const html = readFileSync(dist, "utf8").replace(
      "</head>",
      `<script>window.__NOMOS_TOKEN=${JSON.stringify(token ?? "")};</script></head>`,
    );
    res.end(html);
  }

  /**
   * `GET /screenshots/<session_id>/<ref>.png`
   *
   * Os dois segmentos entram numa concatenação de caminho, então são validados
   * como identificadores — não sanitizados. Sanitizar convida a passar perto;
   * recusar o que não casa o formato não deixa margem (`..`, `/`, `%2e%2e`).
   */
  function serveScreenshot(res: http.ServerResponse, pathname: string): void {
    const partes = pathname.split("/").filter((p) => p !== "");
    const ID = /^[A-Za-z0-9_-]{1,64}$/;
    if (partes.length !== 3 || !ID.test(partes[1]!) || !ID.test(partes[2]!.replace(/\.png$/, ""))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("screenshot inválido\n");
      return;
    }
    const raiz = config.sessions_root ?? path.resolve(UI_DIR, "../../sessions");
    const arquivo = path.join(raiz, partes[1]!, "screenshots", partes[2]!.endsWith(".png") ? partes[2]! : `${partes[2]!}.png`);
    // Cinto e suspensório: mesmo com o formato validado, confirma que o caminho
    // resolvido continua dentro da raiz de sessões.
    if (!path.resolve(arquivo).startsWith(path.resolve(raiz) + path.sep) || !existsSync(arquivo)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("screenshot não encontrado\n");
      return;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(readFileSync(arquivo));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const action_id = newActionId();
      try {
        if (shuttingDown) {
          envelopeError(res, action_id, "CLOSED", "BROWSER_UNAVAILABLE", "daemon está encerrando");
          return;
        }
        const rawUrl = req.url ?? "/";
        if (rawUrl.length > MAX_URL_LENGTH) {
          envelopeError(res, action_id, "FAILED", "INVALID_REQUEST", "URL longa demais");
          return;
        }
        const url = new URL(rawUrl, `http://${req.headers.host ?? "127.0.0.1"}`);

        // NOMOS Web na MESMA ORIGEM do runtime.
        //
        // A alternativa seria liberar CORS para o servidor de UI, e isso abriria
        // exatamente a ameaça T7 do SECURITY.md: com `Access-Control-Allow-Origin`
        // permissivo, qualquer página aberta no navegador do dono passaria a
        // conseguir dirigir o runtime. Servir a UI daqui remove a necessidade de
        // CORS em vez de contorná-la.
        // A credencial é extraída ANTES de qualquer rota, inclusive a da UI e a
        // dos screenshots. Deixá-las fora do gate — como estavam — significaria
        // que qualquer processo local lê a página e as imagens da sessão sem se
        // identificar, e a UI ainda entregaria o token embutido de brinde.
        const cred = AuthManager.extract(req.headers as Record<string, string | undefined>, url);
        const autenticado = auth.authenticate(cred);

        if ((req.method ?? "GET") === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
          if (!autenticado.ok) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
            res.end(`NOMOS Web exige credencial.\nAbra: ${url.origin}/?token=<token>\nToken em: ${auth.tokenPath ?? "(auth desligada)"}\n`);
            return;
          }
          serveUi(res, cred);
          return;
        }

        // PNG gravado pelo SessionRecorder. `screenshot_ref` sozinho é um id
        // opaco: sem esta rota a NOMOS Web não teria como exibir a página
        // espelhada, e o `nomos-web replay` não teria imagem nenhuma.
        if ((req.method ?? "GET") === "GET" && url.pathname.startsWith("/screenshots/")) {
          if (!autenticado.ok) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
            res.end("credencial ausente ou inválida\n");
            return;
          }
          const escopoShot = auth.authorize(autenticado.token, "OBSERVE");
          if (!escopoShot.ok) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("escopo OBSERVE não concedido\n");
            return;
          }
          serveScreenshot(res, url.pathname);
          return;
        }

        const lookup = matchRoute(req.method ?? "GET", url.pathname);

        if (lookup.kind === "not_found") {
          // 404 SAI COMO ENVELOPE. Nada de página de erro do Node com stack.
          envelopeError(
            res,
            action_id,
            "FAILED",
            "INVALID_REQUEST",
            `rota inexistente: ${req.method ?? "GET"} ${url.pathname}`,
            { method: req.method ?? "GET", path: url.pathname, prefix: API_PREFIX },
            404,
          );
          return;
        }
        if (lookup.kind === "method_not_allowed") {
          res.setHeader("allow", lookup.allow.join(", "));
          envelopeError(
            res,
            action_id,
            "FAILED",
            "INVALID_REQUEST",
            `método não permitido em ${url.pathname}`,
            { allow: lookup.allow },
            405,
          );
          return;
        }

        const route = lookup.route;

        // ── FASE 15/16/17 — control plane autenticado e autorizado ──────────
        //
        // O gate vem ANTES de ler o corpo e antes de qualquer efeito. Autenticar
        // depois de já ter agido não é autenticação, é registro.
        //
        // A ordem também importa entre as duas camadas: primeiro "quem é você"
        // (401), depois "o que você pode" (403). Responder 403 a quem não se
        // identificou revelaria que a rota existe e que a credencial ausente
        // seria aceita para alguma outra coisa.
        if (!autenticado.ok) {
          res.setHeader("www-authenticate", 'Bearer realm="nomos-browser"');
          envelopeError(res, action_id, "FAILED", "CAPABILITY_DENIED", autenticado.reason, { auth: autenticado.failure }, 401);
          return;
        }
        const escopo = route.name === "action" ? scopeForTool(route.tool!) : scopeForRoute(route.name);
        const sessaoAlvo = route.params?.id ?? (url.searchParams.get("session_id") ?? null);
        const autorizado = auth.authorize(autenticado.token, escopo, sessaoAlvo);
        if (!autorizado.ok) {
          envelopeError(
            res,
            action_id,
            "FAILED",
            "CAPABILITY_DENIED",
            autorizado.reason,
            { auth: autorizado.failure, required_scope: escopo, subject: autenticado.token.subject },
            403,
          );
          return;
        }

        if (route.name === "events") {
          envelopeError(res, action_id, "FAILED", "INVALID_REQUEST", "/events exige upgrade para WebSocket", {
            hint: `ws://${config.host}:${boundPort}${EVENTS_PATH}`,
          });
          return;
        }

        const client = typeof req.headers["x-nomos-client"] === "string" ? req.headers["x-nomos-client"] : null;
        const body = req.method === "POST" || req.method === "PUT" || req.method === "DELETE"
          ? await readBody(req, config.max_body_bytes)
          : {};

        if (route.name === "action") {
          // Lease (FASE 9/10): depois de autenticar, autorizar E ler o corpo —
          // o `session_id` chega no corpo, não na query. Checar antes seria
          // pular a arbitragem em praticamente toda chamada real.
          const ator = client ?? autenticado.token.subject;
          const alvoSessao =
            typeof (body as Record<string, unknown>).session_id === "string"
              ? ((body as Record<string, unknown>).session_id as string)
              : url.searchParams.get("session_id");
          if (alvoSessao !== null && alvoSessao !== "") {
            const d = leases.check(alvoSessao, ator, { tool: route.tool! });
            if (!d.allowed) {
              envelopeError(res, action_id, "FAILED", CONTROL_NOT_OWNED_CODE, d.message, {
                lease: CONTROL_NOT_OWNED,
                reason: d.reason,
                current_holder: d.current_holder ?? null,
                tool: route.tool,
                actor: ator,
              }, 409);
              return;
            }
          }
          await handleAction(route.tool!, body, url.searchParams, client, res);
          return;
        }

        const result = await handleManagement(route.name, route.params, body, client);
        jsonResponse(res, route.name === "sessions.create" ? 201 : 200, result);
      } catch (e) {
        const err = toActionError(e);
        envelopeError(res, action_id, "FAILED", err.code, err.message, err.detail);
      }
    })().catch((e: unknown) => {
      // Última rede: nenhuma resposta pode morrer sem envelope.
      if (!res.headersSent) {
        envelopeError(res, newActionId(), "FAILED", "INTERNAL", `falha não tratada: ${(e as Error).message}`);
      } else {
        res.end();
      }
    });
  });

  // ── WebSocket /events (FASE 5) ─────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== EVENTS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // O WebSocket era o furo mais silencioso: um socket sem credencial recebia o
    // fluxo de eventos da sessão — URLs visitadas, alvos clicados, tudo. Recusar
    // no upgrade, antes de qualquer frame, é o único ponto em que dá para negar
    // sem já ter vazado o primeiro evento.
    const credWs = AuthManager.extract(req.headers as Record<string, string | undefined>, url);
    const authWs = auth.authenticate(credWs);
    if (!authWs.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Bearer realm=\"nomos-browser\"\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const filter = parseEventFilter(url.searchParams);
    const escopoWs = auth.authorize(authWs.token, "OBSERVE", filter.session_id);
    if (!escopoWs.ok) {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (filter.unknown.length > 0) {
        // Filtro com nome inválido entregaria SILÊNCIO ao cliente, que leria como
        // "nada aconteceu". Fechar com motivo é a única saída honesta.
        ws.close(1008, `evento desconhecido: ${filter.unknown.join(",")}`);
        return;
      }
      sockets.add(ws);
      const sub = bus.subscribe(
        {
          ...(filter.session_id !== null ? { session_id: filter.session_id } : {}),
          ...(filter.events.length > 0 ? { events: filter.events } : {}),
        },
        (event: RuntimeEvent) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify(event));
        },
      );
      // Fechar o socket cancela a ASSINATURA. Nenhuma sessão é tocada aqui —
      // este é literalmente o ponto onde um runtime ingênuo mataria o browser.
      const cleanup = (): void => {
        sub.unsubscribe();
        sockets.delete(ws);
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    });
  });

  // ── escuta ─────────────────────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    const onError = (e: unknown): void => reject(e);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (addr === null || typeof addr === "string") {
    await new Promise<void>((r) => server.close(() => r()));
    throw new ApiError("INTERNAL", "servidor sem endereço após listen");
  }
  const port = addr.port;
  boundPort = port;
  const host = config.host;

  bus.publish("runtime.started", {
    source: "runtime",
    payload: { host, port, contract: CONTRACT_VERSION, version: config.version, headless: config.headless },
  });

  let closing: Promise<void> | null = null;
  const close = async (reason = "shutdown"): Promise<void> => {
    if (closing !== null) return closing;
    shuttingDown = true;
    closing = (async () => {
      for (const ws of [...sockets]) {
        try {
          ws.close(1001, reason);
        } catch {
          // Socket já morto: não há o que fechar.
        }
      }
      sockets.clear();
      await new Promise<void>((r) => wss.close(() => r()));
      // Nenhum Chromium fica para trás.
      await sessions.closeAll(reason);
      services.disposeAll();
      queues.clear();
      bus.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    })();
    return closing;
  };

  const handle: DaemonHandle = {
    host,
    port,
    url: `http://${host}:${port}`,
    config,
    sessions,
    bus,
    services,
    startedAt,
    leases,
    token: rootToken?.secret ?? null,
    tokenPath: auth.tokenPath,
    health,
    close,
  };

  if (install_signal_handlers) {
    const onSignal = (sig: string): void => {
      console.error(`[daemon] ${sig} recebido — encerrando sessões e fechando browsers`);
      void close(sig)
        .then(() => process.exit(0))
        .catch((e: unknown) => {
          console.error("[daemon] falha no encerramento:", (e as Error).message);
          process.exit(1);
        });
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  return handle;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Entrada de processo: `node packages/api/src/daemon.ts`. */
export async function main(): Promise<void> {
  // `runtime_dir` e `auth_disabled` precisam de caminho por ambiente: sem isso o
  // daemon rodando como PROCESSO só sabe gravar o token no diretório padrão do
  // usuário, e não há como isolá-lo em teste de crash — que é justamente o
  // cenário em que se precisa de um diretório descartável.
  const runtimeDir = process.env.NOMOS_RUNTIME_DIR;
  const authOff = process.env.NOMOS_BROWSER_AUTH === "off";
  const handle = await startDaemon({
    install_signal_handlers: true,
    ...(runtimeDir !== undefined && runtimeDir !== "" ? { runtime_dir: runtimeDir } : {}),
    ...(authOff ? { auth_disabled: true } : {}),
  });
  console.error(
    `nomos-browser em ${handle.url} — contrato v${CONTRACT_VERSION}, versão ${handle.config.version}, ` +
      `headless=${String(handle.config.headless)}, política=${handle.config.default_policy}`,
  );
  console.error(`eventos: ws://${handle.host}:${handle.port}${EVENTS_PATH}`);
  // O caminho, nunca o segredo. Quem tem permissão de ler o arquivo já tem o
  // token; imprimi-lo o colocaria em log, histórico de terminal e captura de tela.
  if (authOff) {
    console.error("[daemon] AVISO: autenticação DESLIGADA (NOMOS_BROWSER_AUTH=off) — não use assim em operação");
  } else {
    console.error(`credencial: ${handle.tokenPath ?? "(não gravada)"}`);
  }
}

if ((import.meta as { main?: boolean }).main === true) {
  await main();
}

export type { ActionResponse, HealthResponse };
