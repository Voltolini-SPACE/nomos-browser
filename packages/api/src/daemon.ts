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
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  API_PREFIX,
  CONTRACT_VERSION,
  fail,
  makeAuditEntry,
  newActionId,
  ok,
  timer,
  type ActionErrorCode,
  type ActionResponse,
  type AgentProvider,
  type Capabilities,
  type HealthResponse,
  type RuntimeEvent,
  type PlanStep,
  type SessionInfo,
  type SessionState,
  type VerificationResult,
  type VisionProvider,
} from "../../core/src/contract.ts";
import { agentFromAIProvider, type AIProvider } from "../../core/src/aiprovider.ts";
import { buildAiProvider, buildVisionProvider, descreverProviders } from "./providers.ts";
import { SessionManager, normalizeCapabilities } from "../../core/src/session.ts";
import { CapabilityEngine, policyFromName } from "../../core/src/policy.ts";
import { PerceptionEngine } from "../../core/src/perception.ts";
import { EventBus } from "../../observability/src/eventbus.ts";
import { AuditLog } from "../../observability/src/audit.ts";
import { REDACAO, configSchema, loadConfig, redigirConfig, type DaemonConfig, type LoadConfigOptions } from "./config.ts";
import { EVENTS_PATH, httpStatusFor, matchRoute, parseEventFilter } from "./router.ts";
import {
  DEFAULT_RUNTIME_DIR,
  AuthManager,
  DELEGATION_HEADER,
  principalFor,
  scopeForRoute,
  scopeForTool,
  TOOL_SCOPE,
  ROUTE_SCOPE,
  type IssuedToken,
  type TokenRecord,
} from "./auth.ts";
import {
  LeaseManager,
  CONTROL_NOT_OWNED,
  CONTROL_NOT_OWNED_CODE,
  isLease,
  type LeaseResult,
} from "../../core/src/lease.ts";
import { verifyReplay } from "../../observability/src/replay-verify.ts";
import { selarSessao } from "../../observability/src/replay.ts";
import { RecoveryManager } from "../../core/src/recovery.ts";
import { HealthWatchdog, type HealthEvent, type HealthStats } from "../../observability/src/watchdog.ts";

/** Raiz do pacote de UI, resolvida a partir deste arquivo (não do cwd do processo). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
import {
  ApiError,
  RuntimeServices,
  auditAcionabilidadeDetail,
  auditActionDetail,
  auditEntryFor,
  capabilityFor,
  handleTaskRoute,
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
  /**
   * FASE 13 — quando cada trabalho EM EXECUÇÃO começou.
   *
   * `#running` é um contador e não diz há quanto tempo. Sem isto, "worker preso"
   * seria indetectável: uma ação travada dentro do Playwright mantém
   * `running: 1` para sempre e o número sozinho parece saudável.
   */
  #inicios = new Set<{ at: number }>();

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

  /** Idade (ms) do trabalho em execução mais antigo; `null` se nada roda. */
  oldestRunningMs(now = Date.now()): number | null {
    let maisVelho: number | null = null;
    for (const i of this.#inicios) if (maisVelho === null || i.at < maisVelho) maisVelho = i.at;
    return maisVelho === null ? null : now - maisVelho;
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
          const marca = { at: Date.now() };
          this.#inicios.add(marca);
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
              this.#inicios.delete(marca);
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
  /**
   * FASE 13 — o vigia de subsistemas. `null` com `watchdog_enabled: false`.
   * Exposto para que um teste possa mandar sondar AGORA (`tick()`) em vez de
   * dormir e torcer — provocar a falha e conferir na hora é mais honesto.
   */
  readonly watchdog: HealthWatchdog | null;
  /**
   * FASE 10 — o emissor de credenciais deste daemon.
   *
   * Exposto porque "duas IAs disputando a mesma sessão" só é demonstrável com
   * DUAS IDENTIDADES, e identidade neste runtime é o sujeito de um token. Sem
   * isto, um teste multi-agente só conseguiria fingir a segunda IA trocando um
   * header auto-declarado — que é exatamente o que a FASE 10 deixou de aceitar
   * como prova de quem é quem.
   */
  readonly auth: AuthManager;
  /** Segredo do token raiz. Devolvido UMA vez; nunca vai para log. */
  readonly token: string | null;
  readonly tokenPath: string | null;
  /** FASE 5 — o que de fato foi ligado. `null` é resposta, não omissão. */
  readonly ai: AIProvider | null;
  readonly vision: VisionProvider | null;
  health(): HealthResponse;
  close(reason?: string): Promise<void>;
}

export interface StartDaemonOptions extends LoadConfigOptions {
  /**
   * Provedor de agente para `browser.task`.
   *
   * AUSENTE (`undefined`) e `null` são coisas diferentes desde a FASE 5:
   *   undefined ⇒ construa a partir da config (`ai_provider`); nula ⇒ nenhum.
   *   null      ⇒ NENHUM agente, mesmo que a config peça um.
   * Quem injeta o seu em teste continua vencendo sobre a config, que é o ponto.
   */
  agent?: AgentProvider | null;
  /** Mesma regra do `agent`: `undefined` constrói da config, `null` desliga. */
  vision?: VisionProvider | null;
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

/**
 * FASE 14 — código de saída para "já tem um rodando".
 *
 * Precisa ser DIFERENTE de 1: o `KeepAlive` do launchd reinicia em saída
 * malsucedida, e um daemon que sai com 1 porque já existe outro seria
 * reiniciado em laço para descobrir de novo que já existe outro. Com um código
 * próprio, o `service.sh` distingue "falhou" de "não era para subir".
 */
export const EXIT_JA_RODANDO = 9;

/**
 * A aba que o RESULTADO nomeia. `browser.open`, `browser.new_tab`,
 * `browser.switch_tab` e `browser.close_tab` não passam por `pageOf()` — eles
 * criam, trocam ou fecham a aba —, então sem isto a linha de audit apontaria
 * para a aba que estava ativa ANTES da ação, que é a resposta errada.
 */
function paginaDoResultado(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const id = (result as { page_id?: unknown }).page_id;
  return typeof id === "string" && id !== "" ? id : null;
}

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
  const {
    agent: agenteInjetado,
    vision: visaoInjetada,
    install_signal_handlers = false,
    auth_disabled = false,
    runtime_dir,
    ...configOpts
  } = opts;
  const config = loadConfig(configOpts);
  const startedAt = Date.now();

  // ── FASE 5 — providers reais ────────────────────────────────────────────────
  //
  // Construídos AQUI, antes de qualquer socket abrir, porque config inválida
  // (`ai_provider: "gpt4:foo"`) tem de derrubar o arranque com mensagem clara em
  // vez de virar um `browser.task` que falha meia hora depois. `loadConfig` já
  // valida o formato; estas chamadas validam o que só se descobre construindo.
  let ai: AIProvider | null = null;
  let vision: VisionProvider | null = visaoInjetada ?? null;
  let agent: AgentProvider | null = agenteInjetado ?? null;

  if (agenteInjetado === undefined) {
    ai = buildAiProvider(config, {
      // A degradação é do PROVIDER, não de uma sessão: o roteamento vive no
      // daemon, acima de qualquer sessão. A linha vai para o bucket `_runtime`
      // da trilha — forjar um session_id aqui inventaria um vínculo que não há.
      onDegraded: (d) => {
        void services.record(
          makeAuditEntry({
            event: "provider",
            action: "provider.degraded",
            session: null,
            actor: "runtime",
            provider: d.provider_id,
            result: "error",
            verified: false,
            error: { code: d.code, message: d.motivo },
            detail: {
              provider_id: d.provider_id,
              motivo: d.motivo,
              fallback_usado: d.fallback_usado,
              fallback_provider_id: d.fallback_provider_id,
              fallback_ok: d.fallback_ok,
              code: d.code,
              latency_ms: d.latency_ms,
            },
          }),
        );
      },
    });
  }
  if (visaoInjetada === undefined) vision = buildVisionProvider(config);

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
  //
  // FASE 10: `allow_unleased` deixou de ser `true` embutido aqui e passou a sair
  // da CONFIGURAÇÃO, com default `false`. O default antigo tinha um efeito que a
  // própria FINAL_REPORT registrou como ressalva: a sessão que ninguém tivesse
  // "leaseado" ficava aberta para qualquer principal, então a arbitragem só
  // valia contra quem já tinha se anunciado. Agora quem CRIA a sessão recebe
  // lease exclusivo no mesmo ato (ver `sessions.create`), e o resto do mundo
  // precisa adquirir, herdar ou esperar expirar.
  //
  // Os eventos do lease vão para o bus: `control.taken`, `control.returned` e
  // `session.handoff` são fatos de quem manda na sessão, e um cliente que
  // observa /events precisa vê-los para saber que perdeu o volante.
  const leases = new LeaseManager({
    allow_unleased: config.allow_unleased,
    onEvent: (e) => {
      bus.emit(e);
    },
  });

  /**
   * FASE 10 — de quem é a task que está correndo nesta sessão.
   *
   * O executor de passo fala com a própria API por loopback e precisa agir como
   * o agente que abriu a task, não como o daemon. Guardar o holder no INÍCIO e
   * mantê-lo FIXO é o que faz a troca de dono no meio do caminho ser detectada:
   * se o lease mudou de mãos, o passo seguinte é recusado com CONTROL_NOT_OWNED
   * e a task falha de forma declarada — em vez de continuar agindo em nome de
   * um dono que já não é dono.
   */
  const taskHolders = new Map<string, string>();

  // FASE 11-14 — snapshot de sessão em disco.
  //
  // Sem isto o `RecoveryManager` existe mas nunca tem o que recuperar: depois de
  // um SIGKILL o `scan()` devolve lista VAZIA, e um teste que percorre essa lista
  // passa por vacuidade. Foi exatamente o que aconteceu na primeira execução
  // deste gate — o flag ficou verde sem que nada tivesse sido recuperado.
  const recovery = new RecoveryManager({
    ...(config.sessions_root !== null ? { root: config.sessions_root } : {}),
    // Recuperação em silêncio é recuperação inauditável. Cada tentativa de
    // reattach vira linha na trilha da sessão recuperada.
    onRecovery: (p) => {
      void services.note({
        session: p.session_id,
        event: "recovery",
        action: p.phase === "start" ? "recovery.start" : "recovery.complete",
        actor: "runtime",
        result: p.phase === "complete" && p.error !== null ? "error" : "ok",
        verified: p.phase === "complete" ? p.connected === true : null,
        ...(p.error !== null ? { error: { code: String(p.reason ?? "recover"), message: p.error } } : {}),
        detail: {
          phase: p.phase,
          decision: p.decision,
          reason: p.reason,
          connected: p.connected,
          ...(p.error !== null ? { code: String(p.reason ?? "recover"), error: p.error } : {}),
        },
      });
    },
  });

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
    device_scale_factor: config.device_scale_factor,
    ...(config.profiles_root !== null ? { profiles_root: config.profiles_root } : {}),
    onEvent: (e: RuntimeEvent) => {
      bus.emit(e);
    },
  });

  /**
   * Executor REAL dos passos do plano (FASE 5.3).
   *
   * Fala com a PRÓPRIA API por loopback, autenticado com o token raiz, em vez de
   * chamar `handlerFor()` direto. A razão é de segurança, não de estilo: o
   * caminho HTTP é onde moram a checagem de capability, o congelamento por
   * controle humano, o lease, a fila por sessão e a linha de auditoria. Um
   * executor que chamasse o handler direto daria AO MODELO um caminho
   * privilegiado que nenhum cliente humano tem — exatamente o privilégio que
   * este runtime existe para não conceder.
   *
   * Sem ele, `agentFromAIProvider` devolve `CAPABILITY_DENIED` em todo passo, e
   * `browser.task` com provider configurado falharia no primeiro passo de todo
   * plano — um modelo de texto não clica, e fingir que sim seria a mentira mais
   * cara possível neste projeto.
   */
  const CHAVE_DO_VALOR: Readonly<Record<string, string>> = Object.freeze({
    "browser.open": "url",
    "browser.goto": "url",
    "browser.type": "text",
    "browser.press": "key",
    "browser.wait": "value",
  });

  const executarPasso = async (ctx: { session_id: string; step: PlanStep }): Promise<ActionResponse> => {
    const t = timer();
    const ferramenta = ctx.step.action;
    const negar = (code: ActionErrorCode, msg: string): ActionResponse =>
      fail(newActionId(), "ACTIVE", code, msg, t.done(), { step: ctx.step.id, action: ferramenta });

    if (handlerFor(ferramenta) === null) {
      return negar("INVALID_REQUEST", `ação fora do contrato: ${ferramenta}`);
    }
    if (ferramenta === "browser.task") {
      // Plano que abre outra task é recursão sem fundo, e cada nível consome
      // uma vaga da fila da mesma sessão.
      return negar("INVALID_REQUEST", "passo de plano não pode abrir outra task");
    }

    const corpo: Record<string, unknown> = { session_id: ctx.session_id };
    if (ctx.step.target !== undefined) corpo.target = ctx.step.target;
    if (ctx.step.verification !== undefined) corpo.verification = ctx.step.verification;
    // `value` é um campo genérico do plano; cada ferramenta tem o SEU nome de
    // parâmetro. A tabela é curta e explícita de propósito: adivinhar o nome
    // para as demais faria o runtime inventar pedido em nome do modelo.
    const chave = CHAVE_DO_VALOR[ferramenta];
    if (chave !== undefined && ctx.step.value !== undefined) corpo[chave] = ctx.step.value;

    // `0.0.0.0`/`::` são endereços de ESCUTA, não de destino.
    const destino = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const dono = taskHolders.get(ctx.session_id);
    try {
      const r = await fetch(`http://${destino}:${boundPort}${API_PREFIX}/${ferramenta}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A trilha passa a dizer que quem agiu foi o MODELO, não "agent".
          "x-nomos-client": agent?.name ?? "agent",
          // FASE 10 — o passo age COMO o dono da task, não como o daemon. Sem
          // isto, sob `allow_unleased: false`, todo passo de plano bateria na
          // arbitragem: o lease é do agente que pediu a task, e o token daqui é
          // o do runtime. O header só é aceito de token ADMIN (ver auth.ts).
          ...(dono !== undefined ? { [DELEGATION_HEADER]: dono } : {}),
          ...(rootToken !== null ? { authorization: `Bearer ${rootToken.secret}` } : {}),
        },
        body: JSON.stringify(corpo),
      });
      return (await r.json()) as ActionResponse;
    } catch (e) {
      return negar("INTERNAL", `passo não chegou à API do runtime: ${(e as Error).message}`);
    }
  };

  if (agenteInjetado === undefined && ai !== null) {
    agent = agentFromAIProvider(ai, {
      timeout_ms: config.ai_timeout_ms,
      execute: executarPasso,
      // `verify` devolve o que o RUNTIME verificou, não o que o modelo acha.
      // Ausência de verificação vira `verified:false` — não verificado é
      // diferente de verificado-falso, e nenhum dos dois é "deu certo".
      check: async ({ step, response }) => {
        const v = (response.result as { verification?: VerificationResult } | null)?.verification;
        if (v !== undefined && v !== null) return v;
        return {
          executed: response.success,
          verified: false,
          confidence: 0,
          kind: step.verification?.kind ?? "NONE",
          observed: null,
          retries: 0,
        };
      },
    });
  }

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
    vision,
    /**
     * FASE 9 — o que o MOTOR não pode soltar, e o que ele não DEVE soltar.
     *
     * A tentação era liberar o lease da identidade da task. Está errado: o lease
     * pertence ao AGENTE, não à task, e `LeaseManager.release()` exige `lease_id`
     * justamente porque soltar por nome de holder deixaria qualquer um derrubar o
     * controle alheio. Um agente pode rodar três tasks sob um lease; derrubá-lo
     * no fim da primeira quebraria as outras duas.
     *
     * Então este hook NÃO libera o que a task não adquiriu. Ele MEDE, no instante
     * exato do encerramento, o que ficou de pé — abas, lease, fila — e devolve
     * isso para dentro da linha `task.cleanup`. É a diferença entre afirmar
     * "limpei" e mostrar o que sobrou: se algum dia uma task vazar aba ou lease,
     * a prova estará na trilha em vez de depender de alguém suspeitar.
     */
    onTaskCleanup: (rec) => {
      const fila = queues.get(rec.session_id);
      let abas: number | null = null;
      try {
        abas = sessions.get(rec.session_id).pages.length;
      } catch {
        // Sessão já fechada: zero abas é a resposta honesta, e `null` diria
        // "não sei" quando na verdade sabemos que não há sessão.
        abas = 0;
      }
      const lease = leases.snapshot(rec.session_id);
      return {
        pages_open: abas,
        lease_holder: lease?.current_holder ?? null,
        lease_count: lease?.leases.length ?? 0,
        queue_running: fila?.running ?? 0,
        queue_waiting: fila?.waiting ?? 0,
      };
    },
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

  // ── FASE 13 — O VIGIA DENTRO DO RUNTIME ───────────────────────────────────
  //
  // `watchdog.ts` tinha 557 linhas, backoff, janela deslizante e trava de
  // crash-loop — e ZERO instanciações no runtime. Um supervisor que ninguém
  // constrói é documentação executável, não defesa: quando o Chromium morresse
  // por baixo de uma sessão, o daemon continuaria devolvendo `contexts: 1` e
  // `browser: "ok"` para uma sessão que já não existe.
  //
  // As sondas abaixo são as do produto. Todas leem o estado REAL do subsistema
  // (Playwright, fila, motor de task) em vez da nossa própria contabilidade —
  // é justamente a contabilidade que fica mentindo quando algo morre.
  let watchdog: HealthWatchdog | null = null;

  const health = (): HealthResponse => {
    const stats = sessions.poolStats();
    // FASE 13 — o vigia aparece no /health.
    //
    // `frozen` é medido de FORA do laço: quando o event loop trava, nenhum
    // timer dispara, inclusive o que fiscalizaria o travamento. Quem lê daqui
    // compara o último tique com o relógio AGORA e vê a verdade — é a diferença
    // entre "o laço notou que esteve travado" (heartbeat_expired, depois) e "o
    // laço está travado neste instante" (daemon_frozen, agora).
    const wstats = watchdog === null ? null : watchdog.stats();
    const desdeUltimoTique =
      wstats === null || wstats.last_tick_at === null ? null : Date.now() - Date.parse(wstats.last_tick_at);
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
      ...(wstats === null
        ? { watchdog: { enabled: false } }
        : {
            watchdog: {
              enabled: true,
              state: wstats.state,
              ticks: wstats.ticks,
              stale_ms: desdeUltimoTique,
              frozen:
                desdeUltimoTique !== null && desdeUltimoTique > (watchdog as HealthWatchdog).heartbeat_timeout_ms,
              freezes: wstats.freezes,
              last_freeze_ms: wstats.last_freeze_ms,
              degraded_by: wstats.degraded_by,
              detected: wstats.detected,
              recovered: wstats.recovered,
            },
          }),
    };
  };

  // ── rotas de gestão ────────────────────────────────────────────────────────

  async function handleManagement(
    name: string,
    params: Record<string, string>,
    body: Body,
    client: string | null,
    subject: string | null,
    /**
     * FASE 9 — a query string. `GET /tasks?session_id=...&state=RUNNING` não tem
     * corpo, e sem isto o filtro só existiria na documentação.
     */
    search: URLSearchParams,
    /**
     * FASE 10 — quem PODE, para efeito de lease. É o sujeito do token (ou o
     * delegado, quando um token ADMIN age por outro). Deliberadamente diferente
     * de `ator`, que é quem APARECE na trilha: `x-nomos-client` é auto-declarado
     * e não serve para decidir controle.
     */
    principal: string,
    /** A credencial já autenticada. `whoami` a lê; ninguém mais precisa dela. */
    tokenAtual: TokenRecord,
  ): Promise<unknown> {
    // Quem PEDIU a operação de controle. O header do cliente ganha do sujeito
    // do token porque é o mais específico dos dois; nunca cai em "unknown".
    const ator = client ?? subject ?? "runtime";
    switch (name) {
      case "health":
        return health();
      // FASE 17 — a FORMA da configuração, sem valor algum. `valores_efetivos`
      // sai `false` no corpo para que ninguém confunda o default de fábrica com
      // o que está valendo neste daemon: quem quer o efetivo pede `config.get`,
      // que exige ADMIN.
      case "config.schema":
        return { versao_schema: 1, valores_efetivos: false, chaves: configSchema() };
      // Os valores EFETIVOS, com os sensíveis redigidos. A proveniência viaja
      // junto (`sources`) porque "por que está assim?" é a pergunta que essa
      // rota existe para responder, e um valor sem origem só a responde pela
      // metade. Proveniência não é segredo: dizer `env:NOMOS_BROWSER_AUDIT`
      // nomeia a variável, nunca o conteúdo dela.
      case "config.get":
        return {
          versao_schema: 1,
          valores_efetivos: true,
          redacao: REDACAO,
          // `valores` é a projeção FIEL de `DaemonConfig`: exatamente as chaves
          // que `GET /config/schema` descreve, nem uma a mais. Essa correspondência
          // é o que torna as duas rotas legíveis juntas.
          valores: redigirConfig(config),
          // O que só EXISTE depois do listen mora aqui, e não dentro de `valores`.
          //
          // `port: 0` não é a porta: é o pedido "escolha uma efêmera". Publicar
          // só o pedido faria uma rota que se anuncia como efetiva responder a
          // pergunta errada — e sobrescrever `valores.port` com a porta ligada
          // apagaria o fato de que o operador pediu efêmera. As duas verdades
          // cabem, em campos diferentes.
          runtime: { port: boundPort, bind: `${config.host}:${boundPort}` },
        };
      case "whoami": {
        // O SEGREDO NUNCA SAI DAQUI. Só identidade, poderes e prazo — que é
        // exatamente o que um cliente precisa para se autolimitar, e nada do
        // que um atacante precisaria para se passar por ele.
        const tok = tokenAtual;
        return {
          subject: tok.subject,
          token_id: tok.token_id,
          scopes: [...tok.scopes],
          expires_at: tok.expires_at,
          session_scoped: tok.session_allowlist.size > 0,
          principal,
          delegated: principal !== tok.subject,
          // A tabela de escopo POR FERRAMENTA viaja daqui para que clientes
          // (o servidor MCP em primeiro lugar) possam se autolimitar sem
          // manter uma cópia que diverge. Não é segredo: é o contrato de
          // autorização, e saber o que EXIGE uma ferramenta não concede nada.
          tool_scopes: { ...TOOL_SCOPE },
          route_scopes: { ...ROUTE_SCOPE },
        };
      }
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
        // FASE 10 — QUEM CRIA, MANDA. O lease exclusivo é concedido no mesmo
        // ato da criação. Sem isto, com `allow_unleased: false`, o cliente
        // criaria a sessão e seria barrado na primeira ação da própria sessão —
        // que é o jeito mais rápido de um "fail closed" virar "fail sempre".
        const leaseInicial = leases.acquire(info.session_id, principal, { mode: "exclusive" });
        if (!isLease(leaseInicial)) {
          // Sessão recém-criada não pode ter dono anterior. Se tem, o estado
          // interno está corrompido e seguir seria operar às cegas.
          throw new ApiError("INTERNAL", `sessão ${info.session_id} nasceu com lease alheio: ${leaseInicial.message}`, {
            lease_reason: leaseInicial.reason,
            current_holder: leaseInicial.current_holder,
          });
        }
        const task_raiz = services.rootTaskFor(info.session_id);
        const aba = info.pages.find((p) => p.active) ?? info.pages[0] ?? null;
        await services.note({
          session: info.session_id,
          event: "control",
          action: "session.created",
          actor: ator,
          owner: info.owner,
          page: aba?.page_id ?? null,
          task: task_raiz,
          result: "ok",
          verified: true,
          detail: {
            profile: info.profile,
            capabilities: info.permissions,
            goal: info.task,
            attached_client: info.attached_client,
            pages: info.pages.length,
            // Mapeia a identidade desta sessão ao BrowserContext do pool.
            pool_context: info.context_id,
            lease_holder: leaseInicial.holder,
            lease_id: leaseInicial.lease_id,
          },
        });
        await services.note({
          session: info.session_id,
          event: "control",
          action: "lease.acquired",
          actor: ator,
          owner: info.owner,
          result: "ok",
          verified: true,
          detail: {
            holder: leaseInicial.holder,
            lease_id: leaseInicial.lease_id,
            mode: leaseInicial.mode,
            expires_at: leaseInicial.expires_at,
            granted_by: "session.create",
          },
        });
        // A sessão É uma task raiz: sem isto, toda ação fora de `browser.task`
        // ficaria com `task: null` e a trilha não diria a que trabalho serviu.
        await services.note({
          session: info.session_id,
          event: "task",
          action: "task.started",
          actor: ator,
          owner: info.owner,
          task: task_raiz,
          result: "ok",
          verified: true,
          detail: { task_id: task_raiz, goal: info.task, scope: "session_root" },
        });
        return info;
      }
      // FASE 9 — gestão de task. O handler vive em `handlers.ts` junto do motor;
      // aqui só se decide o ator, como nas demais rotas de controle.
      case "tasks.list":
      case "tasks.get":
      case "tasks.cancel":
      case "tasks.resume":
        // `principal` (e não `ator`) é quem decide controle; `taskHolders` entra
        // por injeção para que o `resume` delegue como `browser.task` já delega.
        return handleTaskRoute(services, name, params, body, search, ator, principal, (sid, quem) => {
          if (quem === null) taskHolders.delete(sid);
          else taskHolders.set(sid, quem);
        });
      case "sessions.get":
        return sessions.observe(params.id!);
      case "sessions.delete": {
        const id = params.id!;
        const motivo = typeof body.reason === "string" ? body.reason : "requested";
        // O contexto é lido ANTES do fechamento: depois dele `sessions.get` já
        // não devolve dono nem context_id, e a linha sairia oca.
        const antes = (() => {
          try {
            return sessions.get(id);
          } catch {
            return null;
          }
        })();
        const raiz = services.rootTaskFor(id);
        await sessions.closeSession(id, motivo);
        await services.note({
          session: id,
          event: "control",
          action: "session.closed",
          actor: ator,
          owner: antes?.owner ?? null,
          page: null,
          task: raiz,
          result: "ok",
          verified: true,
          detail: { reason: motivo, pages: antes?.pages.length ?? 0 },
        });
        await services.note({
          session: id,
          event: "task",
          action: motivo === "requested" ? "task.completed" : "task.cancelled",
          actor: ator,
          owner: antes?.owner ?? null,
          page: null,
          task: raiz,
          result: "ok",
          verified: true,
          detail: { task_id: raiz, reason: motivo, scope: "session_root" },
        });
        // Sessão fechada de propósito não é órfã. Marcar CLOSED faz o próximo
        // `scan()` decidir `terminate` — o comportamento que o RecoveryManager
        // já implementa. (Eu havia inventado um `recovery.remove()` que não
        // existe; a chamada a `undefined` transformava todo DELETE em 500.)
        try {
          await recovery.patch(id, { status: "CLOSED" });
        } catch {
          // Snapshot ausente é normal: nem toda sessão chegou a ser gravada.
        }
        // FASE 10 — sessão fechada não deixa lease pendurado. Sem isto, o
        // `session_id` continuaria "dono" de um lease de uma sessão que já não
        // existe, e o próximo que reusasse o id herdaria uma recusa fantasma.
        const soltos = leases.releaseAll(id, "session_closed");
        leases.forget(id);
        taskHolders.delete(id);
        if (soltos.length > 0) {
          await services.note({
            session: id,
            event: "control",
            action: "lease.released",
            actor: ator,
            owner: antes?.owner ?? null,
            result: "ok",
            verified: true,
            // `releaseAll` devolve os LEASE_IDs revogados, não nomes de holder.
            detail: { revoked_lease_ids: soltos, reason: "session_closed" },
          });
        }
        services.forget(id);
        queues.delete(id);

        // ── FASE 12 — SELA O BUNDLE DE REPLAY NO FECHAMENTO ──────────────────
        //
        // Este é o instante certo e o único: depois daqui nada mais é escrito na
        // trilha da sessão, então o digest de agora é o digest do que de fato
        // aconteceu. Selar antes deixaria o selo obsoleto na última linha;
        // selar sob demanda, depois, seria selar o que o disco tiver virado.
        //
        // Falhar ao selar NÃO derruba o fechamento: a sessão está encerrada e o
        // navegador já foi fechado. O que não pode é falhar em silêncio — sem a
        // linha abaixo, "por que este bundle não tem selo?" não teria resposta.
        // A LINHA VEM ANTES DO SELO, e a ordem não é estilo.
        //
        // Primeira tentativa: selar e depois anotar. O resultado foi que TODO
        // bundle nascia divergente — a própria linha `replay.sealed` era escrita
        // em `actions.jsonl` DEPOIS do digest e quebrava o selo que ela anunciava.
        // Anotar primeiro faz o selo cobrir a linha que fala dele, que é o
        // fechamento correto da trilha.
        await services.note({
          session: id,
          event: "control",
          action: "replay.sealed",
          actor: ator,
          owner: antes?.owner ?? null,
          result: "ok",
          verified: true,
          detail: {
            algo: "sha256",
            // O selo é hash SEM CHAVE: fecha corrupção e adulteração
            // oportunista, não fecha adversário com acesso de escrita ao
            // diretório. Está declarado assim em docs/SECURITY.md.
            escopo: "integridade de conteúdo, não autenticidade",
          },
        });
        let selo_arquivos: number | null = null;
        try {
          const selo = await selarSessao(id, config.sessions_root !== null ? { root: config.sessions_root } : {});
          selo_arquivos = selo.files.length;
        } catch (e) {
          // Aqui a anotação de falha NÃO invalida nada: não há selo para quebrar.
          console.error(`[daemon] selo de replay falhou para ${id}:`, (e as Error).message);
          await services.note({
            session: id,
            event: "control",
            action: "replay.seal_failed",
            actor: ator,
            owner: antes?.owner ?? null,
            result: "error",
            verified: false,
            error: { code: "INTERNAL", message: (e as Error).message },
            detail: { motivo: (e as Error).message },
          });
        }
        return { closed: true, session_id: id, replay_sealed: selo_arquivos !== null, sealed_files: selo_arquivos };
      }
      case "sessions.attach": {
        const who = typeof body.client === "string" ? body.client : client;
        if (who === null) throw new ApiError("INVALID_REQUEST", "attach exige `client` no corpo ou header x-nomos-client");
        const atada = sessions.attach(params.id!, who, { force: body.force === true });
        await services.note({
          session: atada.session_id,
          event: "control",
          action: "session.attach",
          actor: who,
          owner: atada.owner,
          result: "ok",
          verified: true,
          detail: { client: who, force: body.force === true, status: atada.status },
        });
        // Sessão órfã que volta a ter condutor retoma a task raiz.
        await services.note({
          session: atada.session_id,
          event: "task",
          action: "task.resume",
          actor: who,
          owner: atada.owner,
          result: "ok",
          verified: true,
          detail: { task_id: services.rootTaskFor(atada.session_id), client: who, scope: "session_root" },
        });
        return atada;
      }
      case "sessions.detach": {
        // Desconecta o CLIENTE. A sessão continua viva, órfã e reatável.
        const solta = sessions.detach(params.id!);
        await services.note({
          session: solta.session_id,
          event: "control",
          action: "session.detach",
          actor: ator,
          owner: solta.owner,
          result: "ok",
          verified: true,
          detail: { status: solta.status, orphan: solta.attached_client === null },
        });
        return solta;
      }
      case "sessions.handoff": {
        const to_owner = body.to_owner;
        if (typeof to_owner !== "string" || to_owner.trim() === "") {
          throw new ApiError("INVALID_REQUEST", "handoff exige `to_owner`");
        }
        const de = (() => {
          try {
            return sessions.get(params.id!).owner;
          } catch {
            return null;
          }
        })();
        const passada = await sessions.handoff(params.id!, to_owner, {
          ...(body.client === null || typeof body.client === "string" ? { client: body.client as string | null } : {}),
        });
        // ── FASE 10 — DONO (rótulo) E HOLDER (controle) NÃO SÃO A MESMA COISA
        //
        // `owner` é a identidade a que a sessão PERTENCE — é ela que o
        // capability engine consulta. `holder` é o principal AUTENTICADO que tem
        // o volante agora. Eu tentei fazer `handoff` arrastar o lease para
        // `to_owner` e a medição mostrou por que está errado: `to_owner` é um
        // rótulo livre ("DONO-2", "outro-agente"), não um sujeito de token. Mover
        // o lease para um nome que nenhuma credencial carrega TRANCA a sessão —
        // ninguém mais consegue agir nela, nunca.
        //
        // Então o lease só muda de mãos quando o chamador diz explicitamente
        // PARA QUEM (`to_holder`). Sem isso, quem tinha o volante continua com
        // ele — e a linha de trilha registra que não houve troca, para que
        // "por que o novo dono não consegue agir?" tenha resposta no audit em
        // vez de virar mistério. A rota dedicada é `POST /lease/transfer`.
        const destinoLease = typeof body.to_holder === "string" && body.to_holder.trim() !== ""
          ? body.to_holder.trim()
          : null;
        const donoLeaseAtual = leases.currentHolder(params.id!);
        let transferencia: LeaseResult | null = null;
        if (destinoLease !== null && donoLeaseAtual !== null && donoLeaseAtual !== destinoLease) {
          transferencia = leases.transfer(params.id!, donoLeaseAtual, destinoLease);
          if (!isLease(transferencia)) {
            throw new ApiError(CONTROL_NOT_OWNED_CODE, `handoff não conseguiu transferir o lease: ${transferencia.message}`, {
              lease_reason: transferencia.reason,
              from: donoLeaseAtual,
              to: destinoLease,
            });
          }
        } else if (destinoLease !== null && donoLeaseAtual === null) {
          const novo = leases.acquire(params.id!, destinoLease, { mode: "exclusive" });
          transferencia = isLease(novo) ? novo : null;
        }
        await services.note({
          session: passada.session_id,
          event: "control",
          action: "lease.transferred",
          actor: ator,
          owner: passada.owner,
          result: "ok",
          verified: transferencia !== null && isLease(transferencia),
          detail: {
            from_holder: donoLeaseAtual,
            to_holder: destinoLease,
            moved: transferencia !== null && isLease(transferencia),
            // Sem `to_holder` o volante NÃO troca — e isso é dito, não omitido.
            reason: destinoLease === null ? "handoff sem to_holder: lease preservado com o holder atual" : "handoff com to_holder",
            lease_id: transferencia !== null && isLease(transferencia) ? transferencia.lease_id : null,
          },
        });
        await services.note({
          session: passada.session_id,
          event: "control",
          action: "session.handoff",
          actor: ator,
          // O dono na linha é o NOVO: é quem responde pela sessão a partir daqui.
          owner: passada.owner,
          result: "ok",
          verified: true,
          detail: {
            from_owner: de,
            to_owner: passada.owner,
            attached_client: passada.attached_client,
            lease_holder: leases.currentHolder(passada.session_id),
          },
        });
        return passada;
      }
      case "sessions.takeover": {
        const quem = typeof body.actor === "string" ? body.actor : "human";
        const tomada = sessions.takeover(params.id!, quem);
        await services.note({
          session: tomada.session_id,
          event: "control",
          action: "session.takeover",
          actor: quem,
          owner: tomada.owner,
          result: "ok",
          verified: true,
          detail: { by: quem, control: tomada.control, status: tomada.status },
        });
        return tomada;
      }
      case "sessions.release": {
        const quem = typeof body.actor === "string" ? body.actor : "human";
        const devolvida = await sessions.release(params.id!, quem);
        await services.note({
          session: devolvida.session_id,
          event: "control",
          action: "session.release",
          actor: quem,
          owner: devolvida.owner,
          result: "ok",
          verified: true,
          detail: { by: quem, control: devolvida.control, status: devolvida.status },
        });
        // `release` NÃO devolve para ACTIVE: devolve para RECOVERING, porque o
        // humano pode ter navegado, fechado abas ou trocado de conta. Isso é o
        // INÍCIO de uma recuperação, e agora deixa rastro — `recovery.complete`
        // sai do lado de `browser.observe`, que é quem de fato reobserva.
        await services.note({
          session: devolvida.session_id,
          event: "recovery",
          action: "recovery.start",
          actor: quem,
          owner: devolvida.owner,
          result: "ok",
          verified: false,
          detail: {
            trigger: "control.returned",
            state: devolvida.status,
            needs_reobservation: true,
          },
        });
        return devolvida;
      }
      // ── FASE 10 — ciclo de vida do lease ─────────────────────────────────
      //
      // Todas exigem que a sessão EXISTA: adquirir lease de uma sessão que não
      // há criaria um dono para o nada, e o id ficaria envenenado para quando a
      // sessão de verdade nascesse.
      case "lease.get": {
        sessions.get(params.id!);
        const snap = leases.snapshot(params.id!);
        return snap ?? {
          session_id: params.id!,
          current_holder: null,
          leases: [],
          allow_unleased: leases.allow_unleased,
        };
      }
      case "lease.acquire": {
        sessions.get(params.id!);
        const r = leases.acquire(params.id!, principal, {
          ...(typeof body.ttl_ms === "number" ? { ttl_ms: body.ttl_ms } : {}),
          ...(body.mode === "shared" || body.mode === "exclusive" ? { mode: body.mode } : {}),
        });
        if (!isLease(r)) {
          throw new ApiError(r.code ?? CONTROL_NOT_OWNED_CODE, r.message, {
            lease: CONTROL_NOT_OWNED,
            lease_reason: r.reason,
            lease_cause: r.cause,
            current_holder: r.current_holder,
            holder: principal,
          });
        }
        await services.note({
          session: params.id!,
          event: "control",
          action: "lease.acquired",
          actor: ator,
          result: "ok",
          verified: true,
          detail: { holder: r.holder, lease_id: r.lease_id, mode: r.mode, reentrant: r.reentrant, fencing_token: r.fencing_token, expires_at: r.expires_at },
        });
        return r;
      }
      case "lease.release": {
        sessions.get(params.id!);
        const lease_id = body.lease_id;
        if (typeof lease_id !== "string" || lease_id.trim() === "") {
          // Soltar por NOME de holder deixaria qualquer um derrubar o controle
          // alheio: o `lease_id` é a prova de que quem solta é quem detém.
          throw new ApiError("INVALID_REQUEST", "release exige `lease_id`");
        }
        const r = leases.release(params.id!, principal, lease_id.trim());
        if (!r.released) {
          throw new ApiError(CONTROL_NOT_OWNED_CODE, r.message, { lease_reason: r.reason, holder: principal });
        }
        await services.note({
          session: params.id!,
          event: "control",
          action: "lease.released",
          actor: ator,
          result: "ok",
          verified: true,
          detail: { holder: principal, lease_id: lease_id.trim(), reason: r.reason },
        });
        return r;
      }
      case "lease.renew": {
        sessions.get(params.id!);
        const lease_id = body.lease_id;
        if (typeof lease_id !== "string" || lease_id.trim() === "") {
          throw new ApiError("INVALID_REQUEST", "renew exige `lease_id`");
        }
        const r = leases.renew(params.id!, principal, lease_id.trim(), {
          ...(typeof body.ttl_ms === "number" ? { ttl_ms: body.ttl_ms } : {}),
        });
        if (!isLease(r)) {
          throw new ApiError(r.code ?? CONTROL_NOT_OWNED_CODE, r.message, {
            lease_reason: r.reason,
            current_holder: r.current_holder,
            holder: principal,
          });
        }
        return r;
      }
      case "lease.transfer": {
        sessions.get(params.id!);
        const to = body.to;
        if (typeof to !== "string" || to.trim() === "") {
          throw new ApiError("INVALID_REQUEST", "transfer exige `to`");
        }
        const r = leases.transfer(params.id!, principal, to.trim(), {
          ...(typeof body.lease_id === "string" ? { lease_id: body.lease_id } : {}),
          ...(typeof body.ttl_ms === "number" ? { ttl_ms: body.ttl_ms } : {}),
        });
        if (!isLease(r)) {
          throw new ApiError(r.code ?? CONTROL_NOT_OWNED_CODE, r.message, {
            lease_reason: r.reason,
            current_holder: r.current_holder,
            holder: principal,
          });
        }
        await services.note({
          session: params.id!,
          event: "control",
          action: "lease.transferred",
          actor: ator,
          result: "ok",
          verified: true,
          detail: { from_holder: principal, to_holder: r.holder, lease_id: r.lease_id },
        });
        return r;
      }
      case "lease.takeover": {
        // ADMIN (ver ROUTE_SCOPE): arranca o lease de quem o detém SEM o
        // consentimento dele. É o equivalente, na arbitragem, ao `takeover`
        // humano da sessão — e por isso não cabe no escopo de agente.
        sessions.get(params.id!);
        const anterior = leases.currentHolder(params.id!);
        const soltos = leases.releaseAll(params.id!, "takeover");
        const r = leases.acquire(params.id!, principal, { mode: "exclusive" });
        if (!isLease(r)) {
          throw new ApiError("INTERNAL", `takeover não conseguiu adquirir após revogar: ${r.message}`, {
            lease_reason: r.reason,
            previous_holder: anterior,
          });
        }
        await services.note({
          session: params.id!,
          event: "control",
          action: "lease.takeover",
          actor: ator,
          result: "ok",
          verified: true,
          detail: { previous_holder: anterior, revoked_lease_ids: soltos, new_holder: r.holder, lease_id: r.lease_id },
        });
        return { ...r, previous_holder: anterior, revoked_lease_ids: soltos };
      }
      // ── FASE 12 — verificação de integridade do replay ────────────────────
      case "replay.verify": {
        const relatorio = await verifyReplay(params.id!, {
          ...(config.sessions_root !== null ? { root: config.sessions_root } : {}),
          ...(search.get("pixels") === "1" ? { decodificar_pixels: true } : {}),
        });
        await services.note({
          session: params.id!,
          event: "control",
          action: "replay.verified",
          actor: ator,
          result: relatorio.integro ? "ok" : "error",
          verified: relatorio.integro,
          detail: {
            integro: relatorio.integro,
            erros: relatorio.contagens.erros,
            avisos: relatorio.contagens.avisos,
            checagens: relatorio.cobertura.checagens.length,
          },
        });
        return relatorio;
      }
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
    subject: string | null,
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

    const req: ActionRequest = { tool, action_id, session_id, body, client, subject };

    let info: SessionInfo;
    try {
      info = sessions.get(session_id);
    } catch (e) {
      const err = toActionError(e);
      await services.record(
        auditEntryFor(req, "error", false, { code: err.code }, { error: { code: err.code, message: err.message } }),
      );
      jsonResponse(res, httpStatusFor(err.code), fail(action_id, "FAILED", err.code, err.message, t.done(), err.detail));
      return;
    }

    // Contexto forense do pedido. É preenchido ANTES de qualquer gate para que
    // até a linha de NEGAÇÃO saiba dono, navegador, aba e task — a negação é o
    // evento que mais importa e era justamente o que saía mais pobre.
    req.owner = info.owner;
    req.browser = services.browserFor(session_id);
    req.task = services.rootTaskFor(session_id);
    const abaAtiva = info.pages.find((p) => p.active) ?? info.pages[0] ?? null;
    req.page_id = abaAtiva?.page_id ?? null;
    const capability = capabilityFor(tool);

    // 1. CAPABILITY — antes de qualquer contato com o navegador.
    const decision = services.policy.check(tool, info.permissions, info.owner);
    if (!decision.allowed) {
      const code = decision.code ?? "CAPABILITY_DENIED";
      await services.record(
        auditEntryFor(
          req,
          "denied",
          false,
          {
            code,
            required: decision.required,
            reason: decision.reason,
            class: decision.class,
            source: decision.source,
          },
          {
            event: "policy",
            action: "policy.deny",
            capability: decision.required ?? capability,
            policy_decision: "deny",
            policy_reason: `${code}: ${decision.reason}`,
            error: { code, message: decision.reason },
          },
        ),
      );
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
      await services.record(
        auditEntryFor(
          req,
          "denied",
          false,
          { code: "CONTROL_HELD_BY_HUMAN", reason: "control_held_by_human", control: info.control },
          {
            event: "policy",
            action: "policy.deny",
            capability,
            policy_decision: "deny",
            policy_reason: `CONTROL_HELD_BY_HUMAN: ${message}`,
            error: { code: "CONTROL_HELD_BY_HUMAN", message },
          },
        ),
      );
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

    // A DECISÃO DE POLÍTICA É UM FATO PRÓPRIO. Ela é registrada aqui, depois de
    // os dois gates terem passado e antes de o handler tocar no navegador: a
    // linha de ação diz o que aconteceu, esta diz o que foi PERMITIDO acontecer.
    await services.record(
      auditEntryFor(
        req,
        "ok",
        null,
        { required: decision.required, class: decision.class, source: decision.source },
        {
          event: "policy",
          action: "policy.allow",
          capability: decision.required ?? capability,
          policy_decision: "allow",
        },
      ),
    );

    services.emit("action.started", session_id, action_id, { tool }, client ?? "agent");

    try {
      const result = await queueFor(session_id).submit(() => handler(services, req), config.action_timeout_ms);
      const state = sessions.has(session_id) ? sessions.get(session_id).status : info.status;
      const verified =
        typeof result === "object" && result !== null && "verification" in result
          ? ((result as { verification?: { verified?: boolean } }).verification?.verified ?? false)
          : false;
      // O detalhe de procedência entra na trilha só para observe/extract, que são
      // as duas ações que leem página. Sem isto, "o agente viu um ataque hoje?"
      // não teria resposta no audit log — só no corpo de uma resposta já perdida.
      await services.record(
        auditEntryFor(req, "ok", verified, auditActionDetail(result), {
          capability,
          policy_decision: "allow",
          page: paginaDoResultado(result) ?? req.page_id ?? null,
        }),
      );
      services.emit("action.completed", session_id, action_id, { tool, verified }, client ?? "agent");
      jsonResponse(res, 200, ok(action_id, state, result, t.done()));
    } catch (e) {
      const err = toActionError(e);
      const state = sessions.has(session_id) ? sessions.get(session_id).status : "FAILED";
      await services.record(
        // A recusa carrega o MESMO detalhe de acionabilidade da linha de sucesso.
        // Sem isso, "por que TARGET_NOT_ACTIONABLE?" só se responderia relendo o
        // corpo de uma resposta HTTP que ninguém guardou.
        auditEntryFor(req, "error", false, { code: err.code, ...(auditAcionabilidadeDetail(err.detail) ?? {}) }, {
          capability,
          policy_decision: "allow",
          error: { code: err.code, message: err.message },
        }),
      );
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

        // ── FASE 10 — QUEM PODE (principal de controle) ─────────────────────
        //
        // Separado de "quem diz que é" de propósito. `x-nomos-client` é texto
        // que o chamador escreve sobre si mesmo e continua servindo à trilha;
        // a arbitragem de lease usa o SUJEITO DO TOKEN, que é a única coisa
        // nesta requisição que alguém teve de provar. Se um token ADMIN declara
        // agir por outro (`x-nomos-on-behalf-of`), é esse o principal — e só
        // ADMIN pode fazê-lo, senão qualquer agente escolheria de quem ser.
        const dono = principalFor(autenticado.token, req.headers as Record<string, string | undefined>);
        if (!dono.ok) {
          envelopeError(res, action_id, "FAILED", "CAPABILITY_DENIED", dono.reason, { auth: dono.failure }, 403);
          return;
        }
        const principal = dono.holder;

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
          // O ATOR da trilha continua sendo o mais específico dos dois; quem
          // decide o lease é o `principal`, que passou pela autenticação.
          const ator = principal;
          const alvoSessao =
            typeof (body as Record<string, unknown>).session_id === "string"
              ? ((body as Record<string, unknown>).session_id as string)
              : url.searchParams.get("session_id");
          // A arbitragem só faz sentido sobre uma sessão que EXISTE. Checar
          // lease antes da existência trocava o 404 honesto ("essa sessão não
          // há") por um 409 ("você não é o dono") — que além de errado é vazamento:
          // diria a um estranho que a sessão existe e tem dono. `handleAction`
          // continua sendo quem produz o SESSION_NOT_FOUND.
          // ── FASE 11 — A ALLOWLIST DE SESSÃO VALE NAS AÇÕES, NÃO SÓ NA GESTÃO
          //
          // DEFEITO MEDIDO NESTA FASE. O gate de autorização roda antes de ler o
          // corpo, e o `session_id` de uma AÇÃO chega NO CORPO — então
          // `sessaoAlvo` era `null` ali em cima e a checagem de
          // `session_allowlist` simplesmente não acontecia nas rotas que mais
          // importam. Um token emitido para a sessão A operava a sessão B.
          //
          // Na bateria adversarial isso apareceu como 409 em vez de 403: quem
          // barrou foi a ARBITRAGEM de lease, por acidente. Com
          // `allow_unleased: true`, ou numa sessão sem lease, o mesmo token
          // teria passado. Defesa que só funciona quando outra defesa está
          // ligada não é defesa — é coincidência.
          if (alvoSessao !== null && alvoSessao !== "") {
            const daSessao = auth.authorize(autenticado.token, escopo, alvoSessao);
            if (!daSessao.ok) {
              envelopeError(
                res,
                action_id,
                "FAILED",
                "CAPABILITY_DENIED",
                daSessao.reason,
                { auth: daSessao.failure, required_scope: escopo, subject: autenticado.token.subject, session_id: alvoSessao },
                403,
              );
              return;
            }
          }
          if (alvoSessao !== null && alvoSessao !== "" && sessions.has(alvoSessao)) {
            const d = leases.check(alvoSessao, ator, { tool: route.tool! });
            if (!d.allowed) {
              // Negação de arbitragem acontecia ANTES de `handleAction` e por
              // isso escapava inteira da trilha: o agente barrado não deixava
              // nenhum rastro de ter tentado.
              await services.note({
                session: alvoSessao,
                event: "policy",
                action: "policy.deny",
                actor: ator,
                capability: capabilityFor(route.tool!),
                policy_decision: "deny",
                policy_reason: `${CONTROL_NOT_OWNED_CODE}: ${d.message}`,
                target: null,
                result: "denied",
                verified: false,
                action_id,
                error: { code: CONTROL_NOT_OWNED_CODE, message: d.message },
                detail: {
                  code: CONTROL_NOT_OWNED_CODE,
                  lease: CONTROL_NOT_OWNED,
                  reason: d.reason,
                  current_holder: d.current_holder ?? null,
                  tool: route.tool,
                },
              });
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
          // FASE 10 — a task nasce amarrada a QUEM a pediu. O executor de
          // passo lê daqui para se apresentar como esse dono nas chamadas de
          // volta pela API. Trocar o dono no meio faz o passo seguinte ser
          // recusado — que é exatamente o comportamento pedido: a task para,
          // declaradamente, em vez de seguir agindo em nome de quem já saiu.
          if (route.tool === "browser.task" && alvoSessao !== null && alvoSessao !== "") {
            taskHolders.set(alvoSessao, principal);
          }
          try {
            await handleAction(route.tool!, body, url.searchParams, client, autenticado.token.subject, res);
          } finally {
            if (route.tool === "browser.task" && alvoSessao !== null && alvoSessao !== "") {
              taskHolders.delete(alvoSessao);
            }
          }
          return;
        }

        const result = await handleManagement(
          route.name,
          route.params,
          body,
          client,
          autenticado.token.subject,
          url.searchParams,
          principal,
          autenticado.token,
        );
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

  // ── FASE 9 — crash recovery de task ────────────────────────────────────────
  //
  // Roda DEPOIS do listen: as tasks que forem retomáveis precisam da API de pé,
  // porque o executor de passo fala com a própria API por loopback. Roda ANTES
  // de `runtime.started` chegar aos assinantes? Não — e é de propósito: a
  // varredura toca disco e não pode atrasar o arranque. O que ela GARANTE é que
  // nenhuma task fica `RUNNING` mentindo; quem retoma é um `POST /resume`.
  try {
    const recuperadas = await services.taskEngine.recuperar();
    if (recuperadas.length > 0) {
      console.error(`[daemon] FASE 9: ${recuperadas.length} task(s) em RECOVERING após queda do runtime`);
    }
  } catch (e) {
    // Falhar a varredura não pode impedir o daemon de subir: um disco com um
    // arquivo ruim tornaria o runtime inarrancável.
    console.error("[daemon] crash recovery de task falhou:", (e as Error).message);
  }

  if (config.watchdog_enabled) {
    watchdog = new HealthWatchdog({
      interval_ms: config.watchdog_interval_ms,
      max_restarts: config.watchdog_max_restarts,
      onEvent: (e: HealthEvent) => {
        // Tique normal não vira linha de trilha: seriam 17 mil linhas por dia
        // dizendo "nada aconteceu", e a trilha existe para o que aconteceu.
        if (e.name === "tick" || e.name === "started") return;
        void services.record(
          makeAuditEntry({
            event: e.name === "degraded" ? "policy" : "recovery",
            action: `watchdog.${e.name}`,
            session: null,
            actor: "watchdog",
            result: e.name === "recovered" ? "ok" : "error",
            verified: e.name === "recovered",
            ...(e.name === "recovered" ? {} : { error: { code: "INTERNAL", message: `${e.kind ?? "watchdog"}: ${e.name}` } }),
            detail: { kind: e.kind, state: e.state, ...e.detail },
          }),
        );
        bus.publish(e.name === "recovered" ? "session.resumed" : "action.failed", {
          source: "watchdog",
          payload: { watchdog: e.name, kind: e.kind, state: e.state, ...e.detail },
        });
      },
      probes: [
        {
          // ── NAVEGADOR MORTO ────────────────────────────────────────────────
          // Pergunta ao Playwright, não ao nosso mapa de contextos: é o mapa que
          // continua dizendo "tudo bem" depois de o Chromium ser morto.
          // O QUE ESTA SONDA ACRESCENTA AO QUE JÁ EXISTIA
          //
          // O `SessionManager` já ouve `context.on("close")` e, quando o
          // navegador morre sem ordem nossa, marca as sessões como FAILED. Isso
          // funciona e não foi mexido. O que NINGUÉM fazia é o resto: a sessão
          // morta continuava DONA do seu lease e com fila viva no daemon. O
          // `session_id` ficava preso a um dono de uma sessão que já não existe,
          // e nenhum outro agente conseguiria assumi-lo — nunca, porque não há
          // mais navegador para expirar coisa alguma.
          //
          // Somado a isso, esta sonda pergunta ao Playwright se cada contexto
          // ainda RESPONDE: o evento `close` cobre a morte que o Playwright
          // percebe; ele não cobre o contexto que ficou no mapa e não responde
          // mais.
          kind: "browser_dead",
          check: async () => {
            const { vivos, mortos } = await sessions.probeContexts();
            const orfas: { session_id: string; status: string; lease: string | null }[] = [];
            for (const s of sessions.list({ include_closed: false })) {
              if (s.status !== "FAILED") continue;
              const dono = leases.currentHolder(s.session_id);
              if (dono !== null || queues.has(s.session_id)) {
                orfas.push({ session_id: s.session_id, status: s.status, lease: dono });
              }
            }
            return {
              ok: mortos.length === 0 && orfas.length === 0,
              detail: { vivos, contextos_mortos: mortos, orfas },
            };
          },
          recover: async (detalhe) => {
            // NÃO ressuscita o Chromium. A sessão do dono (cookies, abas,
            // formulário meio preenchido) morreu com ele; recriar um contexto
            // vazio com o mesmo session_id entregaria ao agente uma sessão que
            // PARECE a dele e não é. Marcar FAILED é dizer a verdade — e soltar
            // o que ficou pendurado é a parte que faltava.
            const afetadas = await sessions.reapDeadContexts();
            const orfas = (detalhe.orfas ?? []) as { session_id: string }[];
            for (const sid of [...afetadas, ...orfas.map((o) => o.session_id)]) {
              leases.releaseAll(sid, "browser_dead");
              leases.forget(sid);
              queues.delete(sid);
              taskHolders.delete(sid);
            }
          },
        },
        {
          // ── WORKER PRESO ───────────────────────────────────────────────────
          // Sem recuperação automática de propósito: a ação travada está dentro
          // do Playwright, e "destravar" daqui seria abandonar um gesto no meio
          // sem saber se ele chegou à página. O prazo da própria fila é quem
          // encerra; o vigia existe aqui para que o fato APAREÇA.
          kind: "worker_stuck",
          check: async () => {
            const limite = config.watchdog_worker_stall_ms;
            const presos: { session_id: string; ha_ms: number }[] = [];
            const agora = Date.now();
            for (const [sid, fila] of queues) {
              const idade = fila.oldestRunningMs(agora);
              if (idade !== null && idade > limite) presos.push({ session_id: sid, ha_ms: idade });
            }
            return { ok: presos.length === 0, detail: { limite_ms: limite, presos } };
          },
        },
        {
          // ── TASK ESTAGNADA ─────────────────────────────────────────────────
          // RUNNING é uma afirmação sobre o presente. Uma task que não move o
          // checkpoint há minutos está em RUNNING mentindo — e o motor de task
          // não tem como saber sozinho, porque quem parou foi o passo, não ele.
          kind: "task_stalled",
          check: async () => {
            const agora = Date.now();
            const paradas = services.taskEngine
              .list({ state: "RUNNING" })
              .map((t) => ({
                task_id: t.task_id,
                session_id: t.session_id,
                parada_ha_ms: agora - Date.parse(t.checkpoint?.updated_at ?? t.updated_at),
                step_index: t.checkpoint?.step_index ?? null,
              }))
              .filter((t) => Number.isFinite(t.parada_ha_ms) && t.parada_ha_ms > config.watchdog_task_stall_ms);
            return { ok: paradas.length === 0, detail: { limite_ms: config.watchdog_task_stall_ms, paradas } };
          },
          recover: async (detalhe) => {
            // PAUSA, não mata. Uma task pausada é retomável por `POST /resume` e
            // deixa o operador decidir; uma task morta pelo vigia perderia o
            // trabalho já feito sem que ninguém tenha pedido isso.
            const paradas = (detalhe.paradas ?? []) as { task_id: string }[];
            for (const p of paradas) {
              await services.taskEngine.pause(p.task_id, "watchdog: sem progresso além do limiar");
            }
          },
        },
      ],
    });
    watchdog.start();
  }

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
      // O vigia para ANTES dos subsistemas: fechar sessões faz contexto sumir, e
      // um watchdog vivo leria isso como "navegador morreu" e tentaria recuperar
      // uma sessão que nós mesmos estamos encerrando.
      watchdog?.stop();
      await new Promise<void>((r) => wss.close(() => r()));
      // Nenhum Chromium fica para trás.
      await sessions.closeAll(reason);
      // Nenhum MODELO fica para trás, tampouco. Um daemon que encerra deixando
      // 5 GB residentes no backend é o cenário medido que faz o jetsam do macOS
      // matar os serviços vizinhos. `release()` nunca lança (I6/AIProvider).
      try {
        await ai?.release?.();
      } catch {
        // Backend já fora do ar: não há nada a liberar, e isso não é falha de
        // encerramento.
      }
      // Nenhum timer de graça e nenhum AbortController de task ficam vivos: um
      // `setTimeout` pendurado segura o event loop e faz o processo não morrer.
      await services.taskEngine.encerrarTudo();
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
    auth,
    watchdog,
    token: rootToken?.secret ?? null,
    tokenPath: auth.tokenPath,
    ai,
    vision,
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

// ─────────────────────────────────────────────────────────────────────────────
// FASE 14 — INSTÂNCIA ÚNICA
// ─────────────────────────────────────────────────────────────────────────────

/** Nome do arquivo de trava dentro do `runtime_dir`. */
export const LOCK_FILE = "daemon.lock";

export interface LockInfo {
  pid: number;
  port: number;
  started_at: string;
  /** Como o processo foi iniciado — ajuda o dono a achar o que ele não lembra de ter subido. */
  argv: string;
}

/** `true` quando o PID existe E é acessível. Sinal 0 não entrega sinal nenhum. */
function processoVivo(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe mas é de outro usuário. Vivo, e não é nosso: recusar.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lerLock(runtimeDir: string): LockInfo | null {
  try {
    const cru = readFileSync(path.join(runtimeDir, LOCK_FILE), "utf8");
    const o = JSON.parse(cru) as Partial<LockInfo>;
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    return { pid: o.pid, port: o.port, started_at: String(o.started_at ?? ""), argv: String(o.argv ?? "") };
  } catch {
    // Ausente ou ilegível: tratado como "sem trava". Uma trava que não dá para
    // ler não pode impedir o daemon de subir para sempre.
    return null;
  }
}

/**
 * Recusa subir quando JÁ HÁ um daemon vivo.
 *
 * DUAS PERGUNTAS, NÃO UMA. O PID sozinho mente nos dois sentidos: um arquivo de
 * trava sobrevive a um `kill -9` (PID morto, trava viva ⇒ o daemon nunca mais
 * subiria) e um PID pode ter sido reciclado pelo SO para outro programa. A porta
 * sozinha também mente: outro processo qualquer pode estar ocupando a 7777.
 *
 * Então: PID vivo ⇒ recusa. PID morto ⇒ trava obsoleta, segue e reescreve. A
 * porta é conferida depois, pelo próprio `listen`, que devolve EADDRINUSE — e é
 * essa a mensagem que o operador precisa ver, não "não sei o que houve".
 */
export function assertInstanciaUnica(runtimeDir: string): LockInfo | null {
  const lock = lerLock(runtimeDir);
  if (lock === null) return null;
  if (!processoVivo(lock.pid)) return lock; // obsoleta: quem chamou vai reescrever
  throw new ApiError(
    "BROWSER_UNAVAILABLE",
    `já existe um nomos-browser vivo (pid ${lock.pid}, porta ${lock.port}, desde ${lock.started_at}) — ` +
      "instância única por diretório de runtime. Pare o outro antes, ou use NOMOS_RUNTIME_DIR diferente.",
    { pid: lock.pid, port: lock.port, started_at: lock.started_at, lock: path.join(runtimeDir, LOCK_FILE) },
  );
}

export function escreverLock(runtimeDir: string, port: number): string {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const alvo = path.join(runtimeDir, LOCK_FILE);
  const info: LockInfo = {
    pid: process.pid,
    port,
    started_at: new Date().toISOString(),
    argv: process.argv.slice(1).join(" "),
  };
  writeFileSync(alvo, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  return alvo;
}

/** Some com a trava — e SÓ com a nossa. */
export function removerLock(runtimeDir: string): void {
  try {
    const lock = lerLock(runtimeDir);
    // Apagar a trava de OUTRO daemon deixaria dois rodando na próxima subida.
    if (lock !== null && lock.pid !== process.pid) return;
    unlinkSync(path.join(runtimeDir, LOCK_FILE));
  } catch {
    // Já removida: nada a fazer.
  }
}

/** Entrada de processo: `node packages/api/src/daemon.ts`. */
export async function main(): Promise<void> {
  // `runtime_dir` e `auth_disabled` precisam de caminho por ambiente: sem isso o
  // daemon rodando como PROCESSO só sabe gravar o token no diretório padrão do
  // usuário, e não há como isolá-lo em teste de crash — que é justamente o
  // cenário em que se precisa de um diretório descartável.
  const runtimeDir = process.env.NOMOS_RUNTIME_DIR;
  const authOff = process.env.NOMOS_BROWSER_AUTH === "off";

  // FASE 14 — instância única. A checagem vem ANTES de qualquer socket abrir:
  // subir um segundo daemon sobre o mesmo perfil significa dois Chromium
  // disputando o mesmo `userDataDir`, que é como se corrompe o perfil do dono.
  const dirTrava = runtimeDir !== undefined && runtimeDir !== "" ? path.resolve(runtimeDir) : DEFAULT_RUNTIME_DIR;
  try {
    const obsoleta = assertInstanciaUnica(dirTrava);
    if (obsoleta !== null) {
      console.error(`[daemon] trava obsoleta de pid ${obsoleta.pid} (morto) — assumindo`);
    }
  } catch (e) {
    console.error(`[daemon] ${(e as Error).message}`);
    process.exit(EXIT_JA_RODANDO);
  }

  const handle = await startDaemon({
    install_signal_handlers: true,
    ...(runtimeDir !== undefined && runtimeDir !== "" ? { runtime_dir: runtimeDir } : {}),
    ...(authOff ? { auth_disabled: true } : {}),
  });
  console.error(
    `nomos-browser em ${handle.url} — contrato v${CONTRACT_VERSION}, versão ${handle.config.version}, ` +
      `headless=${String(handle.config.headless)}, política=${handle.config.default_policy}`,
  );
  const arquivoTrava = escreverLock(dirTrava, handle.port);
  // Encerramento gracioso REMOVE a trava. Sem isto, um SIGTERM limpo deixaria o
  // arquivo para trás e o próximo arranque gastaria a checagem de PID morto —
  // que funciona, mas transforma o caminho normal no caminho de exceção.
  const soltarTrava = (): void => removerLock(dirTrava);
  process.once("exit", soltarTrava);
  console.error(`eventos: ws://${handle.host}:${handle.port}${EVENTS_PATH}`);
  console.error(`trava de instância: ${arquivoTrava}`);
  // FASE 5 — silêncio sobre qual modelo está ligado não é opção. "sem
  // AIProvider" / "sem VisionProvider" é uma resposta e vai para o log; a
  // ausência de linha nenhuma era a única saída inaceitável, e era a de antes.
  console.error(`providers: ${descreverProviders(handle.config, handle.ai, handle.vision)}`);
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
