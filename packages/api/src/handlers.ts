/**
 * FASE 4 — HANDLERS DAS ROTAS DE AÇÃO
 *
 * Cada handler recebe a requisição já validada e devolve APENAS o `result` do
 * envelope. Quem monta `ActionResponse` é o daemon — assim nenhum handler tem a
 * chance de devolver `success: true` sem timing, e o erro nunca escapa do envelope.
 *
 * Regras que este arquivo carrega:
 *
 *  - NADA de lógica de navegador aqui (art. da arquitetura). Handler é cola: pede
 *    ao SessionManager a Page, ao TargetResolver o alvo, ao Pointer/Keyboard o
 *    input, ao Verifier a prova. Se um comportamento novo for preciso, ele nasce
 *    no `core`, não nesta camada.
 *
 *  - NADA de fallback silencioso. Alvo não resolvido lança TargetResolutionError e
 *    o código sobe no envelope. Verificação que não confirmou volta
 *    `verified:false` — nunca `success:true` otimista.
 *
 *  - NENHUM SEGREDO SAI DAQUI. `browser.type` com `credential_ref` injeta pelo
 *    vault: o valor não passa pelo handler, não vai para o resultado e não vai
 *    para o evento. O que sai é a referência e o recibo.
 */
import path from "node:path";
import type { Download, ElementHandle, Locator, Page } from "playwright";
import {
  REQUIRED_CAPABILITY,
  makeAuditEntry,
  newActionId,
  newId,
  nowIso,
  type ActionError,
  type ActionErrorCode,
  type AgentProvider,
  type AuditEntry,
  type AuditEvent,
  type AxNode,
  type BrowserTask,
  type DownloadRecord,
  type EventName,
  type ExtractResult,
  type Observation,
  type ObservationEnvelope,
  type PageInfo,
  type Plan,
  type PlanStep,
  type Provenance,
  type ResolvedTarget,
  type RuntimeEvent,
  type Suspeita,
  type SuspeitaSeveridade,
  type TargetDescriptor,
  type TargetStrategy,
  type UploadRecord,
  type VerificationResult,
  type VerificationSpec,
  type VisionProvider,
} from "../../core/src/contract.ts";
import { SessionManager, isSessionError, toActionError as sessionToActionError } from "../../core/src/session.ts";
import { InputError, PointerEngine, type Point } from "../../core/src/pointer.ts";
import { spotlight } from "../../core/src/spotlight.ts";
import { KeyboardEngine } from "../../core/src/keyboard.ts";
import {
  PerceptionEngine,
  PerceptionError,
  type NetworkLog,
  type ScreenshotScope,
} from "../../core/src/perception.ts";
import {
  isTargetResolutionError,
  resolveDetailed,
  type AttemptTrace,
  type DetailedResolution,
} from "../../core/src/target.ts";
import {
  armarSondaDeEntrega,
  entregaComprovada,
  estabilizarCaixa,
  garantirAcionavel,
  type AcionabilidadeConfig,
  type Acionavel,
  type AlvoAcionavel,
  type LeituraDeEntrega,
} from "../../core/src/actionable.ts";
import { capture as captureSnapshot, verify as verifyAction } from "../../core/src/verifier.ts";
import { CapabilityEngine, PolicyError, checkPath, checkUrl } from "../../core/src/policy.ts";
import { sanitizeObservation, sanitizeText, type ObservacaoSanitizada } from "../../core/src/sanitize.ts";
import { FileVault, VaultError } from "../../core/src/vault.ts";
import {
  TASK_ESTADOS,
  TaskEngine,
  descreverPasso,
  estadoFinal,
  type StepExecutor,
  type TaskAuditEvent,
  type TaskEngineState,
  type TaskPlanner,
  type TaskRecord,
} from "../../core/src/taskengine.ts";
import { AuditLog, SESSIONS_ROOT } from "../../observability/src/audit.ts";
import { SessionRecorder } from "../../observability/src/replay.ts";
import { EventBus } from "../../observability/src/eventbus.ts";
import type { DaemonConfig, RawWebContentPolicy } from "./config.ts";
// `HTTP_STATUS` é a única projeção em tempo de EXECUÇÃO do enum `ActionErrorCode`.
// Usá-la para perguntar "este código existe no contrato?" evita redigitar o enum
// aqui — e uma segunda lista divergiria no dia em que o contrato ganhasse um código.
import { HTTP_STATUS } from "./router.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Erro da camada de API
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  constructor(code: ActionErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

/** Códigos do vault → códigos do contrato. Nenhum vira sucesso, nenhum some. */
const VAULT_CODE_MAP: Readonly<Record<string, ActionErrorCode>> = Object.freeze({
  INVALID_PROFILE: "INVALID_REQUEST",
  INVALID_REF: "INVALID_REQUEST",
  INVALID_TARGET: "TARGET_NOT_FOUND",
  SECRET_NOT_FOUND: "INVALID_REQUEST",
  VAULT_UNREADABLE: "POLICY_BLOCKED",
  VAULT_INSECURE_PERMISSIONS: "POLICY_BLOCKED",
  INJECTION_FAILED: "INTERNAL",
});

/**
 * Traduz qualquer exceção para `ActionError`. É a única porta: um erro que não
 * case com nenhum tipo conhecido vira INTERNAL com a mensagem original — nunca
 * uma mensagem genérica que apagaria a causa.
 */
export function toActionError(e: unknown): ActionError {
  if (e instanceof ApiError) return { code: e.code, message: e.message, detail: e.detail };
  if (isSessionError(e)) return e.toActionError();
  if (isTargetResolutionError(e)) return e.toActionError();
  if (e instanceof PolicyError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof PerceptionError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof InputError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof VaultError) {
    const code = Object.hasOwn(VAULT_CODE_MAP, e.code) ? VAULT_CODE_MAP[e.code]! : "INTERNAL";
    return { code, message: e.message, detail: { ...e.detail, vault_code: e.code } };
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return { code: "TIMEOUT", message: e.message, detail: { kind: "playwright_timeout" } };
  }
  return sessionToActionError(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura estrita do corpo
// ─────────────────────────────────────────────────────────────────────────────

export type Body = Record<string, unknown>;

/** String opcional. Presente porém vazia/não-string é ERRO, não ausência. */
function str(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v === "") {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser string não vazia`, { field: key });
  }
  return v;
}

function reqStr(body: Body, key: string): string {
  const v = str(body, key);
  if (v === null) throw new ApiError("INVALID_REQUEST", `campo obrigatório ausente: ${key}`, { field: key });
  return v;
}

function num(body: Body, key: string, fallback: number | null = null): number | null {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser número finito`, { field: key });
  }
  return v;
}

function bool(body: Body, key: string, fallback: boolean): boolean {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser booleano`, { field: key });
  }
  return v;
}

/** Aceita só as chaves de `TargetDescriptor`; chave estranha é erro, não ruído. */
export function readTarget(raw: unknown, field = "target"): TargetDescriptor {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_REQUEST", `${field} deve ser um objeto TargetDescriptor`, { field });
  }
  const src = raw as Record<string, unknown>;
  const out: TargetDescriptor = {};
  const textual = ["selector", "text", "role", "label", "placeholder", "semantic"] as const;
  for (const k of textual) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") {
      throw new ApiError("INVALID_REQUEST", `${field}.${k} deve ser string não vazia`, { field: `${field}.${k}` });
    }
    out[k] = v;
  }
  if (src.nth !== undefined) {
    if (typeof src.nth !== "number" || !Number.isInteger(src.nth) || src.nth < 0) {
      throw new ApiError("INVALID_REQUEST", `${field}.nth deve ser inteiro >= 0`, { field: `${field}.nth` });
    }
    out.nth = src.nth;
  }
  if (src.coordinates !== undefined) {
    const c = src.coordinates as { x?: unknown; y?: unknown };
    if (c === null || typeof c !== "object" || typeof c.x !== "number" || typeof c.y !== "number") {
      throw new ApiError("INVALID_REQUEST", `${field}.coordinates deve ser {x:number,y:number}`, { field });
    }
    out.coordinates = { x: c.x, y: c.y };
  }
  for (const k of Object.keys(src)) {
    if (!Object.hasOwn(out, k) && !["selector", "text", "role", "label", "placeholder", "semantic", "nth", "coordinates"].includes(k)) {
      throw new ApiError("INVALID_REQUEST", `${field}.${k} não é campo de TargetDescriptor`, { field: `${field}.${k}` });
    }
  }
  if (Object.keys(out).length === 0) {
    throw new ApiError("INVALID_REQUEST", `${field} vazio: informe ao menos um critério`, { field });
  }
  return out;
}

const VERIFICATION_KINDS = [
  "URL_CHANGED",
  "ELEMENT_APPEARED",
  "ELEMENT_DISAPPEARED",
  "NETWORK_SUCCESS",
  "TEXT_CHANGED",
  "DOM_CHANGED",
  "NONE",
] as const;

export function readVerification(raw: unknown): VerificationSpec {
  if (raw === undefined || raw === null) return { kind: "NONE" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_REQUEST", "verification deve ser um objeto VerificationSpec");
  }
  const src = raw as Record<string, unknown>;
  const kind = src.kind;
  if (typeof kind !== "string" || !(VERIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError("INVALID_REQUEST", `verification.kind inválido: ${String(kind)}`, {
      allowed: [...VERIFICATION_KINDS],
    });
  }
  const spec: VerificationSpec = { kind: kind as VerificationSpec["kind"] };
  if (src.expect !== undefined) {
    if (typeof src.expect !== "string") throw new ApiError("INVALID_REQUEST", "verification.expect deve ser string");
    spec.expect = src.expect;
  }
  if (src.timeout_ms !== undefined) {
    if (typeof src.timeout_ms !== "number" || !Number.isInteger(src.timeout_ms) || src.timeout_ms < 0) {
      throw new ApiError("INVALID_REQUEST", "verification.timeout_ms deve ser inteiro >= 0");
    }
    spec.timeout_ms = src.timeout_ms;
  }
  return spec;
}

/** `handle` é opaco e NÃO atravessa a fronteira da API (contrato, ResolvedTarget). */
export function publicTarget(t: ResolvedTarget): Omit<ResolvedTarget, "handle"> {
  const { handle, ...rest } = t;
  void handle;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 4 — acionabilidade
//
// `centerOf` sozinho foi o defeito: ele devolve o centro da caixa RESOLVIDA, que
// pode estar fora do viewport ou já ter se movido, e o Pointer Engine despachava
// para lá sem perguntar nada. Todo gesto que precisa de um ponto passa agora por
// `acionavel()` — que rola, espera assentar, remede e RECUSA quando não dá.
// ─────────────────────────────────────────────────────────────────────────────

function cfgAcionabilidade(svc: RuntimeServices, rolar = true): AcionabilidadeConfig {
  return {
    scroll_into_view: rolar && svc.config.scroll_into_view,
    stability_samples: svc.config.stability_samples,
    stability_interval_ms: svc.config.stability_interval_ms,
  };
}

function alvoDe(t: ResolvedTarget): AlvoAcionavel {
  return { loc: t.handle as Locator | undefined, box: t.box, descricao: t.description };
}

/**
 * Etapas 2–5 da semântica da FASE 4. Lança `TARGET_NOT_ACTIONABLE`.
 *
 * Também SOBRESCREVE `resolved.box` com a caixa assentada: o `target` que sai na
 * resposta tem de dizer onde o alvo estava no instante do gesto, não onde estava
 * antes de a página terminar de rolar. Devolver a caixa velha seria devolver a
 * mesma mentira, só que num campo diferente.
 */
async function acionavel(
  svc: RuntimeServices,
  page: Page,
  resolved: ResolvedTarget,
  pointer: PointerEngine,
  rolar = true,
): Promise<Acionavel> {
  const r = await garantirAcionavel(page, alvoDe(resolved), pointer, cfgAcionabilidade(svc, rolar));
  if (r.detalhe.box_depois !== null) resolved.box = r.detalhe.box_depois;
  return r;
}

/**
 * FASE 10 (missão EMBEDDED_AGENT_UX) — destaque do alvo NA página antes do
 * gesto, com o selo "● NOMOS controlando". Best-effort por contrato: qualquer
 * falha aqui é silenciosa e a ação segue. O dwell só é aguardado quando o
 * desenho de fato aconteceu — página que recusou desenho não ganha atraso.
 * Roda DEPOIS de `acionavel()` (o overlay tem pointer-events:none e não afeta
 * `elementFromPoint`, mas a ordem elimina até a dúvida).
 */
async function destacarAlvo(svc: RuntimeServices, page: Page, resolved: ResolvedTarget, rotulo: string): Promise<void> {
  if (!svc.config.spotlight) return;
  const dwell = svc.config.spotlight_dwell_ms;
  const desenhou = await spotlight(page, resolved.box, {
    dwell_ms: dwell,
    label: rotulo,
    color: svc.config.spotlight_color,
  });
  if (desenhou && dwell > 0) {
    await new Promise((r) => setTimeout(r, dwell));
  }
}

/** Entrega comprovada? `null` quando a checagem está desligada por configuração. */
function entregueAoAlvo(checou: boolean, leitura: LeituraDeEntrega): boolean | null {
  if (!checou) return null;
  // Regra única, definida em `actionable.ts`: listener, navegação ou aba nova
  // provam entrega; `entrega_errada` (o evento foi para outro elemento) e
  // `sem_prova` reprovam. Duplicar a regra aqui deixaria click e type divergirem.
  return entregaComprovada(leitura);
}

function detalheDeEntrega(checou: boolean, leitura: LeituraDeEntrega): Record<string, unknown> {
  return {
    delivery_checked: checou,
    delivery_verified: entregueAoAlvo(checou, leitura),
    delivery_evidence: checou ? leitura.evidencia : null,
    elemento_que_recebeu: leitura.registro?.elemento ?? null,
    evento_entregue: leitura.registro?.tipo ?? null,
    is_trusted: leitura.registro?.isTrusted ?? null,
    // FASE 4b: a navegação é prova, então ela tem de ser AUDITÁVEL. Sem estes
    // campos, "por que este clique passou?" viraria confiança no rótulo.
    url_antes: checou ? leitura.url_antes : null,
    url_depois: checou ? leitura.url_depois : null,
    navegou: checou ? leitura.navegou : null,
    nova_aba: checou ? leitura.nova_aba : null,
    contexto_destruido: checou ? leitura.contexto_destruido : null,
  };
}

const SEM_ENTREGA: LeituraDeEntrega = {
  registro: null,
  evidencia: "desligado",
  url_antes: "",
  url_depois: "",
  navegou: false,
  nova_aba: false,
  contexto_destruido: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Serviços compartilhados pelos handlers
// ─────────────────────────────────────────────────────────────────────────────

interface PageEngines {
  page: Page;
  pointer: PointerEngine;
  keyboard: KeyboardEngine;
  network: NetworkLog;
}

export interface RuntimeServicesOptions {
  config: DaemonConfig;
  sessions: SessionManager;
  bus: EventBus;
  perception?: PerceptionEngine;
  policy?: CapabilityEngine;
  audit?: AuditLog | null;
  /** FASE 33/34. Ausente ⇒ `browser.task` falha explicitamente (fail closed). */
  agent?: AgentProvider | null;
  /**
   * FASE 5/6 — o 4º degrau da cascata de alvo.
   *
   * Ausente ⇒ `vision` sai `skipped` com razão explícita no trace, que é o
   * comportamento honesto e o que o runtime fazia ANTES desta fase — a diferença
   * é que agora existe um caminho pelo qual ele deixa de ser o único possível.
   */
  vision?: VisionProvider | null;
  /**
   * FASE 9 — liberação de recurso do lado do DAEMON quando uma task termina.
   *
   * Fica aqui, e não dentro do motor, porque o que precisa ser solto (lease,
   * fila da sessão) vive no daemon. O motor solta o que é dele — controlador,
   * timers, mapa de execução — e chama isto para o resto.
   */
  onTaskCleanup?: (rec: Readonly<TaskRecord>) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
}

export class RuntimeServices {
  readonly config: DaemonConfig;
  readonly sessions: SessionManager;
  readonly bus: EventBus;
  readonly perception: PerceptionEngine;
  readonly policy: CapabilityEngine;
  readonly audit: AuditLog | null;
  readonly agent: AgentProvider | null;
  readonly vision: VisionProvider | null;
  /** FASE 9 — motor de task persistente. Sempre existe; sem ele não há checkpoint. */
  readonly taskEngine: TaskEngine;

  /** Um par pointer/keyboard por sessão, refeito quando a página ativa muda. */
  readonly #engines = new Map<string, PageEngines>();
  readonly #vaults = new Map<string, FileVault>();
  readonly #tasks = new Map<string, BrowserTask>();
  readonly #recorders = new Map<string, SessionRecorder>();
  /** task_id raiz por sessão — ver `rootTaskFor`. */
  readonly #rootTasks = new Map<string, string>();
  /** Identidade de navegador POR SESSÃO — ver `browserFor`. */
  readonly #browsers = new Map<string, string>();

  constructor(opts: RuntimeServicesOptions) {
    this.config = opts.config;
    this.sessions = opts.sessions;
    this.bus = opts.bus;
    this.perception = opts.perception ?? new PerceptionEngine({ observeLimit: opts.config.observe_limit });
    this.policy =
      opts.policy ??
      new CapabilityEngine({
        defaultPolicy: opts.config.default_policy,
        ...(opts.config.upload_root !== null ? { uploadRoot: opts.config.upload_root } : {}),
        ...(opts.config.download_root !== null ? { downloadRoot: opts.config.download_root } : {}),
      });
    this.audit = opts.audit ?? null;
    this.agent = opts.agent ?? null;
    this.vision = opts.vision ?? null;

    // FASE 9 — o motor nasce COM o serviço, não sob demanda.
    //
    // Construí-lo no primeiro `browser.task` faria o crash recovery do arranque
    // não ter em quem chamar `recuperar()` — e o daemon subiria sem varrer o
    // disco, que é justamente o buraco que esta fase fecha.
    const raizTasks = opts.config.tasks_root ?? opts.config.sessions_root ?? SESSIONS_ROOT;
    this.taskEngine = new TaskEngine({
      root: raizTasks,
      policy: {
        max_attempts: opts.config.task_max_attempts,
        base_ms: opts.config.task_retry_base_ms,
        max_ms: opts.config.task_retry_max_ms,
        jitter: true,
      },
      step_timeout_ms: opts.config.task_step_timeout_ms,
      total_timeout_ms: opts.config.task_total_timeout_ms,
      recover_grace_ms: opts.config.task_recover_grace_ms,
      // A sessão só é reconstituível se o SessionManager ainda a conhece. Depois
      // de um SIGKILL o Chromium filho morreu junto, então isto é `false` — e a
      // task fica RECOVERING esperando um `resume` explícito, em vez de fingir
      // que voltou sozinha.
      canResume: (session_id) => this.sessions.has(session_id),
      onCleanup: opts.onTaskCleanup ?? (() => undefined),
      onAudit: (ev) => this.#trilhaDeTask(ev),
    });
  }

  /**
   * Leva cada fato do motor para a trilha forense da FASE 3.
   *
   * `event: "task"` e o `action` do motor; `task`, `owner` e `provider` no topo
   * da linha; `step_index` e `attempt` no detalhe. Sem os dois últimos, a
   * pergunta "em que passo e em que tentativa isso aconteceu?" só teria resposta
   * relendo o JSON da task — e depois de um cleanup ninguém relê.
   */
  async #trilhaDeTask(ev: TaskAuditEvent): Promise<void> {
    await this.note({
      session: ev.task.session_id,
      event: "task",
      action: ev.action,
      actor: ev.task.owner ?? "runtime",
      owner: ev.task.owner,
      provider: ev.task.provider,
      task: ev.task.task_id,
      result: ev.result,
      verified: ev.result === "ok" ? true : false,
      error: ev.error,
      detail: {
        ...ev.detail,
        task_id: ev.task.task_id,
        run_id: ev.task.run_id,
        step_index: ev.step_index,
        attempt: ev.attempt,
        state: ev.task.state,
      },
    });
  }

  emit(event: EventName, session_id: string | null, action_id: string | null, payload: Record<string, unknown>, source = "runtime"): void {
    this.bus.publish(event, { session_id, action_id, source, payload });
  }

  /**
   * Gravador de replay da sessão (FASE 25).
   *
   * Existe porque a captura sozinha não é evidência: um `screenshot_ref` que só
   * vive na memória do processo desaparece com ele, e `nomos-web replay` teria
   * uma linha do tempo sem nenhuma imagem. O bundle só é reconstituível se o
   * PNG chegar ao disco em `sessions/<id>/screenshots/`.
   */
  recorderFor(session_id: string): SessionRecorder | null {
    if (this.audit === null) return null; // observabilidade desligada por config
    const existente = this.#recorders.get(session_id);
    if (existente !== undefined) return existente;
    const feito = new SessionRecorder(
      session_id,
      this.config.sessions_root !== null ? { root: this.config.sessions_root } : {},
    );
    this.#recorders.set(session_id, feito);
    return feito;
  }

  /**
   * Engines ligados à página ATIVA da sessão. O log de rede é anexado aqui: ele
   * só enxerga tráfego a partir do momento em que passa a escutar, e por isso a
   * primeira ação da sessão já o instala em vez de esperar `browser.network`.
   */
  enginesFor(session_id: string, page: Page): PageEngines {
    const cached = this.#engines.get(session_id);
    if (cached !== undefined && cached.page === page && !page.isClosed()) return cached;
    if (cached !== undefined && cached.page !== page) cached.network.detach();

    const onEvent = (e: RuntimeEvent): void => {
      this.bus.emit(e);
    };
    const made: PageEngines = {
      page,
      pointer: new PointerEngine({ page, session_id, source: "agent", onEvent }),
      keyboard: new KeyboardEngine({ page, session_id, source: "agent", onEvent }),
      network: this.perception.networkLog(page),
    };
    this.#engines.set(session_id, made);
    return made;
  }

  vaultFor(profile: string): FileVault {
    const cached = this.#vaults.get(profile);
    if (cached !== undefined) return cached;
    const vault = new FileVault(profile, {
      onSecretUsed: (usage) => {
        // Só a REFERÊNCIA e o destino viajam. Nenhum campo do vault carrega valor.
        this.emit("secret.used", usage.session, null, {
          ref: usage.ref,
          destino: usage.destino,
          verified: usage.verified,
          provider: usage.provider,
        }, "runtime");
      },
    });
    this.#vaults.set(profile, vault);
    return vault;
  }

  task(task_id: string): BrowserTask | null {
    return this.#tasks.get(task_id) ?? null;
  }

  registerTask(task: BrowserTask): void {
    this.#tasks.set(task.task_id, task);
  }

  async record(entry: AuditEntry): Promise<void> {
    if (this.audit === null) return;
    try {
      await this.audit.append(entry);
    } catch (e) {
      // Auditoria quebrada não pode derrubar a ação, mas também não pode sumir.
      console.error("[api] audit.append falhou:", toActionError(e).message);
    }
  }

  /**
   * Task RAIZ da sessão (FASE 3 forense).
   *
   * Toda ação pertence a alguma task: quando o cliente não abriu uma
   * explicitamente com `browser.task`, ela pertence à task da própria sessão.
   * Sem isso `task` seria `null` em 100% das linhas de uso normal e a pergunta
   * "que trabalho essa ação servia?" não teria resposta na trilha.
   */
  rootTaskFor(session_id: string): string {
    const found = this.#rootTasks.get(session_id);
    if (found !== undefined) return found;
    const made = newId("tsk");
    this.#rootTasks.set(session_id, made);
    return made;
  }

  /**
   * Identidade do navegador DESTA sessão.
   *
   * O `context_id` do `SessionManager` identifica o BrowserContext do POOL, e o
   * pool reaproveita o mesmo contexto entre sessões do mesmo perfil. Usá-lo aqui
   * faria duas sessões distintas aparecerem na trilha como o mesmo navegador —
   * apagando exatamente a fronteira que a auditoria existe para desenhar. Por
   * isso a sessão ganha a SUA identidade, e o contexto do pool fica registrado
   * uma vez, em `detail.pool_context` da linha `session.created`.
   */
  browserFor(session_id: string): string {
    const found = this.#browsers.get(session_id);
    if (found !== undefined) return found;
    const made = newId("bctx");
    this.#browsers.set(session_id, made);
    return made;
  }

  /** Contexto forense da sessão: dono, navegador, aba ativa e task raiz. */
  auditContext(session_id: string): {
    owner: string | null;
    browser: string;
    page: string | null;
    task: string;
  } {
    const task = this.rootTaskFor(session_id);
    // Memoizados: continuam respondendo depois de a sessão fechar, que é
    // justamente quando a última linha da trilha é escrita.
    const browser = this.browserFor(session_id);
    try {
      const info = this.sessions.get(session_id);
      const ativa = info.pages.find((p) => p.active) ?? info.pages[0] ?? null;
      return { owner: info.owner, browser, page: ativa?.page_id ?? null, task };
    } catch {
      // Sessão já fechada ou inexistente: o resto da linha continua valendo.
      return { owner: null, browser, page: null, task };
    }
  }

  /**
   * Escreve uma linha de trilha para um fato que NÃO é uma ação de navegador
   * (política, controle, recuperação, task, provider). Completa o contexto da
   * sessão sozinha; `undefined` do chamador nunca apaga o que ela descobriu.
   */
  async note(entry: Partial<AuditEntry> & { session: string; action: string }): Promise<void> {
    const merged: Record<string, unknown> = { ...this.auditContext(entry.session) };
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) merged[k] = v;
    }
    await this.record(makeAuditEntry(merged as Partial<AuditEntry>));
  }

  /** Solta engines e log de rede de uma sessão encerrada. */
  forget(session_id: string): void {
    const e = this.#engines.get(session_id);
    if (e !== undefined) {
      try {
        e.network.detach();
      } catch {
        // Página já morta: nada a desanexar.
      }
      this.#engines.delete(session_id);
    }
    this.#rootTasks.delete(session_id);
  }

  disposeAll(): void {
    for (const id of [...this.#engines.keys()]) this.forget(id);
    this.#vaults.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ActionRequest {
  tool: string;
  action_id: string;
  session_id: string;
  body: Body;
  /** Identidade de quem chamou (header `x-nomos-client`). */
  client: string | null;
  /**
   * Sujeito do token que autenticou o pedido. Junto com `client` e `owner` é o
   * que faz `actor` deixar de ser "unknown": a trilha antiga só olhava o header
   * `x-nomos-client`, que praticamente nenhum cliente envia.
   */
  subject?: string | null;
  /** Dono da sessão no instante do pedido — preenchido pelo daemon. */
  owner?: string | null;
  /** BrowserContext da sessão (`context_id`) — preenchido pelo daemon. */
  browser?: string | null;
  /** Task a que esta ação pertence — preenchida pelo daemon. */
  task?: string | null;
  /** Provider de IA envolvido, quando houver. */
  provider?: string | null;
  /**
   * page_id da aba REALMENTE usada. Escrito por `pageOf()`, que é o único funil
   * por onde um handler obtém uma `Page`. Sem isto o audit teria de adivinhar a
   * aba ativa no momento da GRAVAÇÃO, que não é a mesma coisa que a aba em que
   * a ação ocorreu.
   */
  page_id?: string | null;
}

export type ActionHandler = (svc: RuntimeServices, req: ActionRequest) => Promise<unknown>;

function pageOf(svc: RuntimeServices, req: ActionRequest): Page {
  const page_id = str(req.body, "page_id");
  const page = svc.sessions.getPage(req.session_id, page_id ?? undefined);
  // Registra a aba EFETIVA na requisição: é o que o audit grava em `page`.
  req.page_id = svc.sessions.pageIdOf(page) ?? page_id;
  return page;
}

function urlGuard(svc: RuntimeServices, url: string): string {
  const d = checkUrl(url, { allow_internal: svc.config.allow_internal_urls });
  if (!d.allowed) {
    throw new ApiError(d.code ?? "POLICY_BLOCKED", d.reason, { url: d.url, scheme: d.scheme, host: d.host, internal: d.internal });
  }
  return d.url ?? url;
}

/**
 * O operador definiu esta chave, ou ela ainda é o default de fábrica?
 *
 * `config.sources` carrega a procedência de cada chave ("default" | "file:…" |
 * "env:…" | "override"). É o que permite distinguir "o operador quer 0" de
 * "ninguém falou nada e o default é 0" — indistinguíveis olhando só o valor.
 */
function refinoEscolhido(svc: RuntimeServices, chave: string): boolean {
  return (svc.config.sources[chave] ?? "default") !== "default";
}

async function resolveOn(
  svc: RuntimeServices,
  req: ActionRequest,
  page: Page,
  descriptor: TargetDescriptor,
  timeout_ms: number | null,
): Promise<ResolvedTarget> {
  /**
   * O trace vai para a TRILHA quando a cascata desceu até a visão — resolvendo
   * por ela, falhando nela, ou pulando-a por falta de provider. Um degrau que
   * gasta um modelo multimodal (ou que é PULADO por não haver um) é exatamente
   * o fato que a auditoria precisa registrar. Os degraus de DOM já se explicam
   * pelo `strategy` da linha da ação; gravar o trace de toda resolução
   * transformaria a trilha em ruído e ninguém leria nenhuma das duas coisas.
   */
  const anotarCascata = async (
    trace: readonly AttemptTrace[],
    strategy: TargetStrategy | null,
    attempted: readonly TargetStrategy[],
  ): Promise<void> => {
    const degrau = trace.find((t) => t.strategy === "vision");
    if (degrau === undefined) return;
    await svc.note({
      session: req.session_id,
      event: "action",
      action: "target.cascade",
      actor: actorOf(req),
      provider: svc.vision?.name ?? null,
      page: req.page_id ?? null,
      action_id: req.action_id,
      result: strategy === null ? "error" : "ok",
      verified: strategy === "vision",
      detail: {
        tool: req.tool,
        strategy,
        attempted: [...attempted],
        vision_outcome: degrau.outcome,
        vision_reason: degrau.reason ?? null,
        vision_min_confidence: svc.config.vision_min_confidence,
        vision_provider: svc.vision?.name ?? null,
        trace: [...trace],
      },
    });
  };

  let res: DetailedResolution;
  try {
    // FASE 5/6: é AQUI que o 4º degrau passa a existir em produção. Antes desta
    // linha o resolvedor era chamado sem `vision`, e toda cascata que chegava lá
    // terminava em `{"strategy":"vision","outcome":"skipped"}` — uma verdade
    // registrada que nenhuma configuração conseguia mudar.
    res = await resolveDetailed(page, descriptor, {
      timeout_ms: timeout_ms ?? 0,
      max_candidates: 60,
      vision: svc.vision,
      vision_min_confidence: svc.config.vision_min_confidence,
      // FASE 6b — repasse das opções de refino de visão, POR PROCEDÊNCIA.
      //
      // Sem repasse nenhum, `vision_refine_passes`/`vision_refine_factor` eram
      // configuração morta: existiam na config e nunca chegavam à cascata.
      //
      // Mas repassá-las incondicionalmente quebra outra coisa, e isto foi
      // MEDIDO (`cascata-percepcao` caiu: 2 inferências viraram 1). A
      // precedência em `resolveDetailed` é
      //     opts.vision_refine_passes ?? politica?.refine_passes ?? DEFAULT
      // ou seja, o que vem daqui GANHA da preferência do próprio VisionProvider.
      // Como o default da config é 0, mandá-lo sempre DESLIGA em silêncio o
      // refino de um provider que pede 2 passadas — o operador não escolheu
      // isso, o default escolheu por ele.
      //
      // `sources` responde exatamente a pergunta certa: "o operador falou?".
      // Enquanto a chave for "default", quem manda é o provider; assim que
      // alguém a define (arquivo, env ou override), a config manda.
      ...(refinoEscolhido(svc, "vision_refine_passes") ? { vision_refine_passes: svc.config.vision_refine_passes } : {}),
      ...(refinoEscolhido(svc, "vision_refine_factor") ? { vision_refine_factor: svc.config.vision_refine_factor } : {}),
    });
  } catch (e) {
    // A cascata que FALHOU é a que mais interessa auditar: é ela que responde
    // "por que o runtime não achou o alvo?" sem depender de alguém ter guardado
    // o corpo da resposta HTTP.
    if (isTargetResolutionError(e)) await anotarCascata(e.trace, null, e.attempted);
    throw e;
  }
  await anotarCascata(res.trace, res.target.strategy, res.target.attempted);

  if (res.target.healed) {
    svc.emit("target.healed", null, null, {
      strategy: res.target.strategy,
      attempted: res.target.attempted,
      description: res.target.description,
    });
    // Um alvo CURADO é literalmente uma nova tentativa: a primeira estratégia
    // não achou nada e outra achou. É o único ponto de retentativa real do
    // runtime, e é aqui que `task.retry` nasce em vez de ser decorativo.
    await svc.note({
      session: req.session_id,
      event: "task",
      action: "task.retry",
      actor: actorOf(req),
      page: req.page_id ?? null,
      action_id: req.action_id,
      result: "ok",
      verified: true,
      detail: {
        tool: req.tool,
        strategy: res.target.strategy,
        attempted: res.target.attempted,
        healed: true,
      },
    });
  }
  return res.target;
}

async function pageInfoOf(svc: RuntimeServices, session_id: string, page: Page): Promise<PageInfo> {
  const info = await svc.sessions.observe(session_id);
  const page_id = svc.sessions.pageIdOf(page);
  const found = info.pages.find((p) => p.page_id === page_id);
  if (found !== undefined) return found;
  // Página existe no Playwright mas não no registro: estado inconsistente, não
  // um detalhe cosmético. Melhor gritar do que inventar um PageInfo.
  throw new ApiError("INTERNAL", "página ativa não consta no registro da sessão", { session_id, page_id });
}

/** Ciclo padrão de uma ação que muda a página: snapshot → agir → verificar. */
async function withVerification<T>(
  page: Page,
  spec: VerificationSpec,
  act: () => Promise<T>,
): Promise<{ value: T; verification: VerificationResult }> {
  const before = await captureSnapshot(page, spec);
  const value = await act();
  const outcome = await verifyAction(page, spec, before, { attempt: 0 });
  const verification: VerificationResult = {
    executed: outcome.executed,
    verified: outcome.verified,
    confidence: outcome.confidence,
    kind: outcome.kind,
    observed: outcome.observed,
    retries: outcome.retries,
  };
  return { value, verification };
}

// ─────────────────────────────────────────────────────────────────────────────
// Navegação
// ─────────────────────────────────────────────────────────────────────────────

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const;
type WaitUntil = (typeof WAIT_UNTIL)[number];

function readWaitUntil(body: Body): WaitUntil {
  const raw = body.wait_until;
  if (raw === undefined || raw === null) return "domcontentloaded";
  if (typeof raw !== "string" || !(WAIT_UNTIL as readonly string[]).includes(raw)) {
    throw new ApiError("INVALID_REQUEST", `wait_until inválido: ${String(raw)}`, { allowed: [...WAIT_UNTIL] });
  }
  return raw as WaitUntil;
}

const handleGoto: ActionHandler = async (svc, req) => {
  const url = urlGuard(svc, reqStr(req.body, "url"));
  const waitUntil = readWaitUntil(req.body);
  const page = pageOf(svc, req);
  try {
    await page.goto(url, { waitUntil });
  } catch (e) {
    throw new ApiError("NAVIGATION_FAILED", `goto(${url}) falhou: ${(e as Error).message}`, { url });
  }
  svc.emit("page.loaded", req.session_id, req.action_id, { url: page.url() }, "agent");
  return pageInfoOf(svc, req.session_id, page);
};

const handleOpen: ActionHandler = async (svc, req) => {
  const url = urlGuard(svc, reqStr(req.body, "url"));
  return svc.sessions.newPage(req.session_id, url);
};

function historyHandler(kind: "back" | "forward" | "reload"): ActionHandler {
  return async (svc, req) => {
    const page = pageOf(svc, req);
    const waitUntil = readWaitUntil(req.body);
    try {
      if (kind === "back") {
        const r = await page.goBack({ waitUntil });
        if (r === null) throw new ApiError("NAVIGATION_FAILED", "não há entrada anterior no histórico");
      } else if (kind === "forward") {
        const r = await page.goForward({ waitUntil });
        if (r === null) throw new ApiError("NAVIGATION_FAILED", "não há entrada seguinte no histórico");
      } else {
        await page.reload({ waitUntil });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("NAVIGATION_FAILED", `${kind} falhou: ${(e as Error).message}`);
    }
    svc.emit("page.loaded", req.session_id, req.action_id, { url: page.url(), via: kind }, "agent");
    return pageInfoOf(svc, req.session_id, page);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedência — a ponte entre o sanitizador e o caminho de execução
// ─────────────────────────────────────────────────────────────────────────────
//
// O sanitizador existia desde a FASE 29 e era chamado APENAS pelo seu próprio
// teste. Defesa que não está no caminho da requisição não é defesa: é uma
// biblioteca com cobertura. Este bloco é a ligação — todo conteúdo que sai de
// `browser.observe` e `browser.extract` passa por aqui antes de virar resposta.

const ORDEM_SEVERIDADE: Readonly<Record<SuspeitaSeveridade, number>> = Object.freeze({
  baixa: 0,
  media: 1,
  alta: 2,
});

function maiorSeveridade(suspeitas: readonly Suspeita[]): SuspeitaSeveridade | null {
  let maior: SuspeitaSeveridade | null = null;
  for (const s of suspeitas) {
    if (maior === null || ORDEM_SEVERIDADE[s.severidade] > ORDEM_SEVERIDADE[maior]) maior = s.severidade;
  }
  return maior;
}

const MOTIVO_DETECCAO =
  "injecao de severidade alta detectada; politica raw_web_content=withhold_on_detection";
const MOTIVO_NEVER = "politica raw_web_content=never: texto cru de pagina nunca e entregue";
const RETIDO_POR_POLITICA = "[!-:politica:never] conteudo retido — ver provenance.sanitized_content";

/**
 * Substituto do texto cru. Carrega o id da suspeita porque o auditor precisa
 * saber QUAL marca do bloco sanitizado corresponde a este campo — sem o id, ler
 * "conteudo retido" num campo e procurar o original entre 40 suspeitas é
 * trabalho manual que ninguém faz.
 */
function marcaDeRetencao(suspeitas: readonly Suspeita[]): string {
  const marcas = suspeitas.map((s) => `[!${s.id}:${s.categoria}:${s.severidade}]`).join("");
  return `${marcas} conteudo retido — ver provenance.sanitized_content`;
}

function provenanceDe(
  san: ObservacaoSanitizada,
  raw_content_available: boolean,
  raw_withheld_reason: string | null,
): Provenance {
  return {
    source: "WEB",
    // Não existe página confiável. O selo é constante de propósito: um campo que
    // às vezes diz TRUSTED convidaria o consumidor a ramificar por ele.
    trust: "UNTRUSTED",
    injection_detected: san.suspeitas.length > 0,
    severity: maiorSeveridade(san.suspeitas),
    findings: san.suspeitas,
    sanitized_content: san.texto_seguro,
    nonce: san.nonce,
    raw_content_available,
    raw_withheld_reason,
    fields_inspected: san.campos_inspecionados,
    origin: san.origem,
  };
}

// Endereçamento de campo. `Suspeita.onde` é a única coordenada que o sanitizador
// devolve, então ela é o endereço — estes padrões espelham exatamente o que
// `camposDaObservacao`/`camposDaArvoreAx` escrevem lá.
const ONDE_TITULO = "título da página";
const RE_ONDE_ELEMENTO = /^elemento (\S+) \(texto\)$/;
const RE_ONDE_ATRIBUTO = /^atributo (\S+) de (\S+)$/;
const RE_ONDE_AX = /^acessibilidade (ax(?:\.\d+)*) \((nome|valor|descricao)\)$/;

function noAxPorCaminho(raiz: AxNode | null, caminho: string): AxNode | null {
  if (raiz === null) return null;
  const partes = caminho.split(".");
  if (partes[0] !== "ax") return null;
  let no: AxNode = raiz;
  for (const p of partes.slice(1)) {
    const i = Number(p);
    const filhos = no.children ?? [];
    if (!Number.isInteger(i) || i < 0 || i >= filhos.length) return null;
    no = filhos[i]!;
  }
  return no;
}

/** Reescreve UM campo cru. Devolve se achou o campo — endereço órfão não é silencioso. */
function redigirCampo(obs: Observation, onde: string, substituto: string): boolean {
  if (onde === ONDE_TITULO) {
    obs.title = substituto;
    return true;
  }
  const elTexto = RE_ONDE_ELEMENTO.exec(onde);
  if (elTexto !== null) {
    const el = (obs.elements ?? []).find((e) => e.ref === elTexto[1]);
    if (el === undefined) return false;
    el.text = substituto;
    return true;
  }
  const attr = RE_ONDE_ATRIBUTO.exec(onde);
  if (attr !== null) {
    const el = (obs.elements ?? []).find((e) => e.ref === attr[2]);
    if (el === undefined || el.attributes === undefined || !Object.hasOwn(el.attributes, attr[1]!)) return false;
    el.attributes[attr[1]!] = substituto;
    return true;
  }
  const ax = RE_ONDE_AX.exec(onde);
  if (ax !== null) {
    const no = noAxPorCaminho(obs.accessibility ?? null, ax[1]!);
    if (no === null) return false;
    if (ax[2] === "nome") no.name = substituto;
    else if (ax[2] === "valor") no.value = substituto;
    else no.description = substituto;
    return true;
  }
  return false;
}

/** Modo `never`: nenhum texto de página sai cru, tenha suspeita ou não. */
function redigirTudo(obs: Observation, substituto: string): void {
  if (typeof obs.title === "string" && obs.title.trim() !== "") obs.title = substituto;
  for (const el of obs.elements ?? []) {
    if (typeof el.text === "string" && el.text.trim() !== "") el.text = substituto;
    const attrs = el.attributes ?? {};
    for (const [nome, valor] of Object.entries(attrs)) {
      if (typeof valor === "string" && valor.trim() !== "") attrs[nome] = substituto;
    }
  }
  const visita = (no: AxNode): void => {
    if (typeof no.name === "string" && no.name.trim() !== "") no.name = substituto;
    if (typeof no.value === "string" && no.value.trim() !== "") no.value = substituto;
    if (typeof no.description === "string" && no.description.trim() !== "") no.description = substituto;
    for (const f of no.children ?? []) visita(f);
  };
  if (obs.accessibility !== null && obs.accessibility !== undefined) visita(obs.accessibility);
}

/**
 * Sela uma `Observation`. Muta `obs` quando há retenção — `obs` acabou de nascer
 * do PerceptionEngine e não é compartilhada com ninguém.
 *
 * Severidade média/baixa NUNCA retém. É o controle de falso positivo: um artigo
 * que *explica* injeção de prompt tem de continuar legível, senão a defesa passa
 * a cegar o agente em conteúdo legítimo e o dono a desliga.
 */
export function selarObservacao(politica: RawWebContentPolicy, obs: Observation): ObservationEnvelope {
  const san = sanitizeObservation(obs);

  if (politica === "never") {
    redigirTudo(obs, RETIDO_POR_POLITICA);
    return { ...obs, provenance: provenanceDe(san, false, MOTIVO_NEVER) };
  }

  const altas = san.suspeitas.filter((s) => s.severidade === "alta");
  if (politica === "always" || altas.length === 0) {
    return { ...obs, provenance: provenanceDe(san, true, null) };
  }

  // Agrupa por campo (ref + onde, conforme a regra) para que um campo com três
  // suspeitas altas leve as três marcas, e não três substituições sobrepostas.
  const porCampo = new Map<string, { onde: string; suspeitas: Suspeita[] }>();
  for (const s of altas) {
    const chave = `${s.ref ?? "-"}|${s.onde}`;
    const atual = porCampo.get(chave);
    if (atual === undefined) porCampo.set(chave, { onde: s.onde, suspeitas: [s] });
    else atual.suspeitas.push(s);
  }
  for (const { onde, suspeitas } of porCampo.values()) redigirCampo(obs, onde, marcaDeRetencao(suspeitas));

  return { ...obs, provenance: provenanceDe(san, false, MOTIVO_DETECCAO) };
}

/** Sela texto cru (`browser.extract`). Mesma regra de retenção da observação. */
export function selarTexto(
  politica: RawWebContentPolicy,
  conteudo: string,
  origem: string | null,
): { content: string; provenance: Provenance } {
  const san = sanitizeText(conteudo, origem !== null ? { origem } : {});

  if (politica === "never") {
    return { content: RETIDO_POR_POLITICA, provenance: provenanceDe(san, false, MOTIVO_NEVER) };
  }
  const altas = san.suspeitas.filter((s) => s.severidade === "alta");
  if (politica === "always" || altas.length === 0) {
    return { content: conteudo, provenance: provenanceDe(san, true, null) };
  }
  return { content: marcaDeRetencao(altas), provenance: provenanceDe(san, false, MOTIVO_DETECCAO) };
}

/**
 * Detalhe de auditoria derivado da procedência.
 *
 * NUNCA o `trecho`: ele é texto literal da página e pode carregar segredo que o
 * dono nunca autorizou a persistir. O audit log fica com contagem e categoria —
 * o suficiente para responder "quantos ataques esta sessão viu, de que tipo".
 */
export function auditProvenanceDetail(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const prov = (result as { provenance?: unknown }).provenance;
  if (prov === null || typeof prov !== "object") return undefined;
  const p = prov as Provenance;
  return {
    injection_detected: p.injection_detected,
    severity: p.severity,
    findings: p.findings.length,
    trust: p.trust,
    raw_withheld: !p.raw_content_available,
    categorias: [...new Set(p.findings.map((f) => f.categoria))],
  };
}

/**
 * Chaves de acionabilidade que a trilha carrega. SOMAM ao `detail` da linha de
 * ação — não viram chave de topo, porque o schema de audit da FASE 3 é fechado e
 * "quanto rolou" é detalhe da ação, não uma nova dimensão forense.
 *
 * Aceita tanto o `result` de um handler (que traz `detail`) quanto o
 * `error.detail` de uma recusa — as duas metades da mesma pergunta: "essa ação
 * conseguiu mirar, e o gesto chegou?".
 */
export function auditAcionabilidadeDetail(fonte: unknown): Record<string, unknown> | undefined {
  if (fonte === null || typeof fonte !== "object") return undefined;
  const interno = (fonte as { detail?: unknown }).detail;
  const src = (interno !== null && typeof interno === "object" ? interno : fonte) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["scrolled", "stabilized_after", "delivery_verified", "actionable"]) {
    if (Object.hasOwn(src, k)) out[k] = src[k];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Detalhe da linha de ação: procedência (FASE 2) + acionabilidade (FASE 4). */
export function auditActionDetail(result: unknown): Record<string, unknown> | undefined {
  const prov = auditProvenanceDetail(result);
  const acion = auditAcionabilidadeDetail(result);
  if (prov === undefined && acion === undefined) return undefined;
  return { ...(prov ?? {}), ...(acion ?? {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Percepção
// ─────────────────────────────────────────────────────────────────────────────

const handleObserve: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const limit = num(req.body, "limit");
  const observation: Observation = await svc.perception.observe(page, {
    accessibility: bool(req.body, "accessibility", false),
    screenshot: bool(req.body, "screenshot", false),
    ...(limit !== null ? { limit } : {}),
    includeHidden: bool(req.body, "include_hidden", false),
    includeDecorative: bool(req.body, "include_decorative", false),
    ...(svc.sessions.pageIdOf(page) !== null ? { page_id: svc.sessions.pageIdOf(page)! } : {}),
  });
  // FASE 32: quem reobservou de fato é quem pode liberar RECOVERING → ACTIVE.
  // FASE 3 (forense): essa transição É a conclusão de uma recuperação, e agora
  // deixa linha — antes o ciclo takeover→release→reobservação sumia da trilha.
  if (svc.sessions.needsReobservation(req.session_id)) {
    svc.sessions.markObserved(req.session_id);
    await svc.note({
      session: req.session_id,
      event: "recovery",
      action: "recovery.complete",
      actor: actorOf(req),
      page: req.page_id ?? null,
      action_id: req.action_id,
      result: "ok",
      verified: true,
      detail: { via: "browser.observe", state: "ACTIVE", recovered: true },
    });
  }
  // Nada observado sai daqui sem selo de procedência. É este ponto — e não o
  // teste do sanitizador — que faz a defesa existir em produção.
  return selarObservacao(svc.config.raw_web_content, observation);
};

const handleFind: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const resolved = await resolveOn(svc, req, page, target, num(req.body, "timeout_ms"));

  // A caixa também ASSENTA aqui, e não só no caminho do clique.
  //
  // O scroll do Chromium é animado: `browser.find` logo depois de um
  // `browser.scroll` lia a caixa no meio da animação e devolvia uma coordenada
  // que já não seria a do alvo um quadro depois. Quem consumisse isso — um
  // agente, um script de medição — receberia um número exato e errado. `find`
  // NÃO rola (observar não é agir); só espera parar de se mexer.
  const est = await estabilizarCaixa(alvoDe(resolved), cfgAcionabilidade(svc, false));
  if (est.removido || est.box === null) {
    throw new ApiError("TARGET_NOT_FOUND", `alvo desapareceu do DOM durante a estabilização (${resolved.description})`, {
      strategy: resolved.strategy,
      amostras_ate_estabilizar: est.amostras,
    });
  }
  resolved.box = est.box;

  svc.emit("element.found", req.session_id, req.action_id, {
    strategy: resolved.strategy,
    attempted: resolved.attempted,
    healed: resolved.healed,
    box: resolved.box,
  }, "agent");
  return { ...publicTarget(resolved), stabilized_after: est.amostras, stabilized: est.estabilizou };
};

const EXTRACT_FORMATS = ["text", "html", "value"] as const;

const handleExtract: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const rawFormat = req.body.format;
  const format = rawFormat === undefined || rawFormat === null ? "text" : rawFormat;
  if (typeof format !== "string" || !(EXTRACT_FORMATS as readonly string[]).includes(format)) {
    throw new ApiError("INVALID_REQUEST", `format inválido: ${String(format)}`, { allowed: [...EXTRACT_FORMATS] });
  }

  if (req.body.target === undefined || req.body.target === null) {
    const content =
      format === "html"
        ? await page.content()
        : await page.evaluate(() => document.body?.innerText ?? "");
    if (format === "value") {
      throw new ApiError("INVALID_REQUEST", 'format "value" exige um target (é o valor de um campo)');
    }
    const selado = selarTexto(svc.config.raw_web_content, content, page.url());
    const out: ExtractResult = {
      content: selado.content,
      scope: "document",
      format,
      provenance: selado.provenance,
    };
    return out;
  }

  const resolved = await resolveOn(svc, req, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
  const loc = resolved.handle as Locator | undefined;
  if (loc === undefined) {
    throw new ApiError("TARGET_NOT_FOUND", "alvo resolvido por coordenada não tem conteúdo extraível", {
      strategy: resolved.strategy,
    });
  }
  const content =
    format === "html" ? await loc.innerHTML() : format === "value" ? await loc.inputValue() : ((await loc.textContent()) ?? "");
  const selado = selarTexto(svc.config.raw_web_content, content, page.url());
  const out: ExtractResult = {
    content: selado.content,
    scope: "element",
    format,
    target: publicTarget(resolved),
    provenance: selado.provenance,
  };
  return out;
};

const SCREENSHOT_SCOPES = ["viewport", "full", "element", "region"] as const;

const handleScreenshot: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const rawScope = req.body.scope;
  const scope = rawScope === undefined || rawScope === null ? "viewport" : rawScope;
  if (typeof scope !== "string" || !(SCREENSHOT_SCOPES as readonly string[]).includes(scope)) {
    throw new ApiError("INVALID_REQUEST", `scope inválido: ${String(scope)}`, { allowed: [...SCREENSHOT_SCOPES] });
  }

  let elementTarget: ElementHandle<Element> | undefined;
  let resolvedForResult: Omit<ResolvedTarget, "handle"> | null = null;
  if (scope === "element") {
    if (req.body.target === undefined) {
      throw new ApiError("INVALID_REQUEST", "scope=element exige target");
    }
    const resolved = await resolveOn(svc, req, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    const loc = resolved.handle as Locator | undefined;
    if (loc === undefined) throw new ApiError("TARGET_NOT_FOUND", "alvo sem elemento para capturar");
    const handle = await loc.elementHandle();
    if (handle === null) throw new ApiError("TARGET_NOT_FOUND", "elemento desapareceu antes da captura");
    elementTarget = handle as ElementHandle<Element>;
    resolvedForResult = publicTarget(resolved);
  }

  let region: { x: number; y: number; width: number; height: number } | undefined;
  if (scope === "region") {
    const r = req.body.region as Record<string, unknown> | undefined;
    if (r === undefined || r === null || typeof r !== "object") {
      throw new ApiError("INVALID_REQUEST", "scope=region exige region {x,y,width,height}");
    }
    for (const k of ["x", "y", "width", "height"]) {
      if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number)) {
        throw new ApiError("INVALID_REQUEST", `region.${k} deve ser número finito`);
      }
    }
    region = { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
  }

  const shot = await svc.perception.capture(page, {
    scope: scope as ScreenshotScope,
    ...(elementTarget !== undefined ? { target: elementTarget } : {}),
    ...(region !== undefined ? { region } : {}),
    devicePixels: bool(req.body, "device_pixels", false),
  });
  // Persistir é parte da captura, não um extra. Uma falha ao gravar é reportada
  // em `persisted:false` — nunca silenciada, nunca fatal para a ação em si.
  let persisted = false;
  let persist_error: string | undefined;
  const recorder = svc.recorderFor(req.session_id);
  if (recorder !== null) {
    try {
      await recorder.saveScreenshot(shot.buffer, shot.screenshot_ref);
      persisted = true;
    } catch (e) {
      persist_error = toActionError(e).message;
      console.error("[api] saveScreenshot falhou:", persist_error);
    }
  }

  return {
    screenshot_ref: shot.screenshot_ref,
    // URL só existe quando o PNG chegou ao disco. Devolver um link para arquivo
    // inexistente seria pior que não devolver: o cliente exibiria imagem quebrada
    // achando que a captura funcionou.
    ...(persisted ? { screenshot_url: `/screenshots/${req.session_id}/${shot.screenshot_ref}.png` } : {}),
    width: shot.width,
    height: shot.height,
    bytes: shot.bytes,
    scope: shot.scope,
    captured_at: shot.captured_at,
    persisted,
    ...(persist_error !== undefined ? { persist_error } : {}),
    ...(resolvedForResult !== null ? { target: resolvedForResult } : {}),
  };
};

const handleNetwork: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const engines = svc.enginesFor(req.session_id, page);
  const limit = num(req.body, "limit");
  const entries = engines.network.entries(limit ?? undefined);
  return {
    requests: entries,
    total: engines.network.size(),
    // Corte visível: sem isto, um buffer que já girou pareceria "a página só fez N pedidos".
    dropped: engines.network.dropped(),
    attached: engines.network.attached,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Abas
// ─────────────────────────────────────────────────────────────────────────────

const handleTabs: ActionHandler = async (svc, req) => {
  const info = await svc.sessions.observe(req.session_id);
  return info.pages;
};

const handleNewTab: ActionHandler = async (svc, req) => {
  const url = str(req.body, "url");
  if (url === null) return svc.sessions.newPage(req.session_id);
  return svc.sessions.newPage(req.session_id, urlGuard(svc, url));
};

const handleSwitchTab: ActionHandler = async (svc, req) => {
  const page_id = reqStr(req.body, "page_id");
  const info = svc.sessions.switchPage(req.session_id, page_id);
  const found = info.pages.find((p) => p.page_id === page_id);
  if (found === undefined) throw new ApiError("TARGET_NOT_FOUND", `page_id ${page_id} sumiu após a troca`);
  return found;
};

const handleCloseTab: ActionHandler = async (svc, req) => {
  const page_id = reqStr(req.body, "page_id");
  await svc.sessions.closePage(req.session_id, page_id);
  return { closed: true, page_id };
};

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

const handleClick: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const spec = readVerification(req.body.verification);
  // (1) resolver — cascata inalterada.
  const resolved = await resolveOn(svc, req, page, target, num(req.body, "timeout_ms"));
  const { pointer } = svc.enginesFor(req.session_id, page);
  const button = req.body.button;
  if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") {
    throw new ApiError("INVALID_REQUEST", `button inválido: ${String(button)}`);
  }

  // (2)–(5) rolar, assentar, remedir, conferir acionabilidade. Recusa aqui é
  // TARGET_NOT_ACTIONABLE e nunca chega a despachar gesto nenhum.
  const acao = await acionavel(svc, page, resolved, pointer);
  await destacarAlvo(svc, page, resolved, "clicar");
  const checar = svc.config.click_delivery_check;
  let leitura: LeituraDeEntrega = SEM_ENTREGA;

  const { value, verification } = await withVerification(page, spec, async () => {
    // (7-a) a sonda é armada o MAIS TARDE possível: armada antes da resolução,
    // ela poderia capturar um clique alheio e creditá-lo a esta ação. Os sinais
    // de navegação/aba nova nascem aqui pelo mesmo motivo — armados depois do
    // clique, não distinguiriam causa de coincidência.
    const sonda = checar ? await armarSondaDeEntrega(page, alvoDe(resolved)) : null;
    try {
      // (6) clicar — no ponto REMEDIDO, não no centro da caixa da resolução.
      const r = await pointer.click(acao.ponto, {
        action_id: req.action_id,
        ...(button !== undefined ? { button: button as "left" | "right" | "middle" } : {}),
        ...(bool(req.body, "humanize", false) ? { humanize: true } : {}),
      });
      // (7-b) ler a prova antes de a verificação de efeito começar a esperar.
      if (sonda !== null) leitura = await sonda.ler();
      return r;
    } finally {
      sonda?.desarmar();
    }
  });

  const detail: Record<string, unknown> = {
    ...acao.detalhe,
    ponto_do_clique: acao.ponto,
    ...detalheDeEntrega(checar, leitura),
  };

  if (checar && detail.delivery_verified !== true) {
    // Despachou e não chegou. É o caso que devolvia `success:true` sem que o
    // elemento recebesse nada — o motivo de esta fase existir.
    throw new ApiError(
      "CLICK_NOT_DELIVERED",
      `clique despachado em (${acao.ponto.x}, ${acao.ponto.y}) não chegou ao alvo (${resolved.description})`,
      detail,
    );
  }

  // (8) só agora.
  return {
    target: publicTarget(resolved),
    verification,
    pointer: { backend: value.backend, fallback_used: value.fallback_used, fallback_reason: value.fallback_reason },
    detail,
  };
};

const handleType: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const spec = readVerification(req.body.verification);
  const text = str(req.body, "text");
  const credential_ref = str(req.body, "credential_ref");
  if ((text === null) === (credential_ref === null)) {
    throw new ApiError("INVALID_REQUEST", "informe exatamente um entre `text` e `credential_ref`");
  }

  const resolved = await resolveOn(svc, req, page, target, num(req.body, "timeout_ms"));
  const { pointer, keyboard } = svc.enginesFor(req.session_id, page);
  const info = svc.sessions.get(req.session_id);

  // Digitar exige FOCO, e foco aqui nasce de um clique real. Um campo fora do
  // viewport recebia o clique numa coordenada morta e o texto ia para o vazio —
  // mesma família de sucesso falso do `browser.click`. Por isso o campo passa
  // pelo mesmo funil de acionabilidade, inclusive no caminho do segredo (onde o
  // `fill` do vault também erraria o alvo se ele estivesse coberto).
  const checar = svc.config.click_delivery_check;
  let leitura: LeituraDeEntrega = SEM_ENTREGA;
  // Caixa mutável em vez de `let`: o TypeScript estreita uma variável atribuída
  // só dentro de closure para `never` no ponto de leitura, e trocar o tipo por
  // `any` para calar isso apagaria a checagem que interessa.
  const capturado: { acao: Acionavel | null } = { acao: null };

  const run = async (): Promise<Record<string, unknown>> => {
    const acao = await acionavel(svc, page, resolved, pointer);
    capturado.acao = acao;
    await destacarAlvo(svc, page, resolved, "digitar");
    if (credential_ref !== null) {
      const vault = svc.vaultFor(info.profile);
      const loc = resolved.handle as Locator | undefined;
      if (loc === undefined) {
        throw new ApiError("TARGET_NOT_FOUND", "injeção de segredo exige elemento; alvo por coordenada não serve", {
          strategy: resolved.strategy,
        });
      }
      const receipt = await vault.injectSecret(page, loc, credential_ref, {
        session: req.session_id,
        mode: "fill",
        destino: resolved.description,
      });
      // O recibo NÃO carrega valor, comprimento nem prefixo — é o contrato do vault.
      return { credential_ref: receipt.ref, injected: receipt.injected, secret_verified: receipt.verified };
    }
    const sonda = checar ? await armarSondaDeEntrega(page, alvoDe(resolved)) : null;
    try {
      await pointer.click(acao.ponto, { action_id: req.action_id });
      if (sonda !== null) leitura = await sonda.ler();
    } finally {
      sonda?.desarmar();
    }
    if (checar) {
      if (entregueAoAlvo(checar, leitura) !== true) {
        throw new ApiError(
          "CLICK_NOT_DELIVERED",
          `clique de foco não chegou ao campo (${resolved.description}) — o texto iria para o vazio`,
          { ...acao.detalhe, ponto_do_clique: acao.ponto, ...detalheDeEntrega(checar, leitura) },
        );
      }
    }
    if (bool(req.body, "clear", false)) {
      const loc = resolved.handle as Locator | undefined;
      if (loc !== undefined) await loc.fill("");
    }
    const r = await keyboard.type(text!, { action_id: req.action_id });
    return { typed_length: r.text_length, backend: r.backend, fallback_used: r.fallback_used };
  };

  const { value, verification } = await withVerification(page, spec, run);
  return {
    target: publicTarget(resolved),
    verification,
    ...value,
    detail: {
      ...(capturado.acao === null ? {} : capturado.acao.detalhe),
      ...detalheDeEntrega(checar && credential_ref === null, leitura),
    },
  };
};

const handlePress: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { keyboard } = svc.enginesFor(req.session_id, page);
  const key = str(req.body, "key");
  const rawKeys = req.body.keys;
  if (key === null && rawKeys === undefined) {
    throw new ApiError("INVALID_REQUEST", "informe `key` ou `keys[]`");
  }
  if (key !== null && rawKeys !== undefined) {
    throw new ApiError("INVALID_REQUEST", "informe `key` OU `keys[]`, não os dois");
  }

  if (key !== null) {
    const r = await keyboard.press(key, { action_id: req.action_id });
    return { pressed: r.keys, backend: r.backend, editing_commands: r.editing_commands };
  }
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.some((k) => typeof k !== "string" || k === "")) {
    throw new ApiError("INVALID_REQUEST", "keys deve ser array não vazio de strings");
  }
  const r = await keyboard.hotkey(rawKeys as string[], { action_id: req.action_id });
  return { pressed: r.keys, backend: r.backend, editing_commands: r.editing_commands };
};

const handleScroll: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { pointer } = svc.enginesFor(req.session_id, page);
  const dx = num(req.body, "dx", 0)!;
  const dy = num(req.body, "dy", 0)!;
  if (dx === 0 && dy === 0) throw new ApiError("INVALID_REQUEST", "scroll exige dx ou dy diferente de zero");

  let at: Point | undefined;
  let detalhe: Record<string, unknown> = {};
  if (req.body.target !== undefined && req.body.target !== null) {
    const resolved = await resolveOn(svc, req, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    // A roda age SOB O CURSOR. Um `at` fora do viewport não rola contêiner
    // nenhum — o evento é descartado e a resposta dizia `success:true` mesmo
    // assim. Mesmo funil de acionabilidade do clique.
    const acao = await acionavel(svc, page, resolved, pointer);
    at = acao.ponto;
    detalhe = { ...acao.detalhe, ponto_do_clique: acao.ponto };
  }
  const r = await pointer.scroll({ dx, dy }, { action_id: req.action_id, ...(at !== undefined ? { at } : {}) });
  return { scrolled: r.delta, at: r.to, backend: r.backend, detail: detalhe };
};

const handleDrag: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { pointer } = svc.enginesFor(req.session_id, page);
  const from = await resolveOn(svc, req, page, readTarget(req.body.from, "from"), num(req.body, "timeout_ms"));
  const to = await resolveOn(svc, req, page, readTarget(req.body.to, "to"), num(req.body, "timeout_ms"));
  const spec = readVerification(req.body.verification);

  // Um arrasto precisa das DUAS pontas simultaneamente acionáveis. Rolar até o
  // destino pode tirar a origem de vista, então a origem é reconferida DEPOIS —
  // e sem rolar, porque rolar de volta só recomeçaria o pêndulo. Se as duas não
  // couberem juntas na tela, isso é TARGET_NOT_ACTIONABLE e não um arrasto
  // torto despachado com uma ponta numa coordenada morta.
  const aFrom = await acionavel(svc, page, from, pointer);
  const aTo = await acionavel(svc, page, to, pointer);
  const aFromDepois = await acionavel(svc, page, from, pointer, false);

  const { value, verification } = await withVerification(page, spec, () =>
    pointer.drag(aFromDepois.ponto, aTo.ponto, { action_id: req.action_id, steps: 12 }),
  );
  return {
    dragged: { from: value.from, to: value.to, steps: value.steps },
    verification,
    from_target: publicTarget(from),
    to_target: publicTarget(to),
    detail: {
      ...aFromDepois.detalhe,
      // `scrolled` da linha de audit tem de somar as duas pontas: o auditor
      // precisa ver o deslocamento total que a ação causou na página.
      scrolled: {
        dx: aFrom.detalhe.scrolled.dx + aTo.detalhe.scrolled.dx + aFromDepois.detalhe.scrolled.dx,
        dy: aFrom.detalhe.scrolled.dy + aTo.detalhe.scrolled.dy + aFromDepois.detalhe.scrolled.dy,
      },
      stabilized_after:
        aFrom.detalhe.stabilized_after + aTo.detalhe.stabilized_after + aFromDepois.detalhe.stabilized_after,
      destino: aTo.detalhe,
      // Arrasto não produz evento `click`: a prova de entrega do clique não se
      // aplica aqui, e fingir que se aplica seria pior que não ter.
      delivery_checked: false,
      delivery_verified: null,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Espera — condição verificável, nunca duração fixa (docs/API.md)
// ─────────────────────────────────────────────────────────────────────────────

const WAIT_CONDITIONS = ["url_contains", "element_visible", "element_hidden", "network_idle", "text_present"] as const;

const handleWait: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const condition = reqStr(req.body, "condition");
  if (!(WAIT_CONDITIONS as readonly string[]).includes(condition)) {
    throw new ApiError("INVALID_REQUEST", `condition inválida: ${condition}`, { allowed: [...WAIT_CONDITIONS] });
  }
  const timeout = num(req.body, "timeout_ms", 15_000)!;
  const value = str(req.body, "value");
  const t0 = Date.now();

  const needValue = (): string => {
    if (value === null) throw new ApiError("INVALID_REQUEST", `condition=${condition} exige \`value\``);
    return value;
  };

  const selectorFor = (): string => {
    if (value !== null) return value;
    if (req.body.target !== undefined) {
      const t = readTarget(req.body.target);
      if (typeof t.selector === "string") return t.selector;
    }
    throw new ApiError("INVALID_REQUEST", `condition=${condition} exige \`value\` (seletor) ou target.selector`);
  };

  try {
    if (condition === "url_contains") {
      const needle = needValue();
      await page.waitForFunction((v: string) => window.location.href.includes(v), needle, { timeout });
    } else if (condition === "element_visible") {
      await page.locator(selectorFor()).first().waitFor({ state: "visible", timeout });
    } else if (condition === "element_hidden") {
      await page.locator(selectorFor()).first().waitFor({ state: "hidden", timeout });
    } else if (condition === "network_idle") {
      await page.waitForLoadState("networkidle", { timeout });
    } else {
      const needle = needValue();
      await page.waitForFunction(
        (v: string) => (document.body?.innerText ?? "").includes(v),
        needle,
        { timeout },
      );
    }
  } catch (e) {
    throw new ApiError("TIMEOUT", `condição "${condition}" não foi satisfeita em ${timeout}ms`, {
      condition,
      timeout_ms: timeout,
      waited_ms: Date.now() - t0,
      cause: (e as Error).message,
    });
  }
  return { waited_ms: Date.now() - t0, condition, satisfied: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// Download / Upload — COMMIT, fail closed em toda etapa
// ─────────────────────────────────────────────────────────────────────────────

const handleDownload: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const root = svc.config.download_root;
  if (root === null) {
    // Sem raiz configurada não existe "fora da raiz"; salvar em qualquer lugar
    // seria exatamente o fallback silencioso que a política proíbe.
    throw new ApiError("DOWNLOAD_DENIED", "download_root não configurado — download negado (fail closed)");
  }
  const url = str(req.body, "url");
  const hasTarget = req.body.target !== undefined && req.body.target !== null;
  if ((url === null) === !hasTarget) {
    throw new ApiError("INVALID_REQUEST", "informe exatamente um entre `url` e `target`");
  }

  const waiter: Promise<Download> = page.waitForEvent("download", { timeout: num(req.body, "timeout_ms", 30_000)! });
  // O waiter nasce ANTES do urlGuard, porque o evento pode chegar durante a
  // navegação. Se o guarda recusar a URL (ou qualquer passo abaixo lançar),
  // ninguém mais espera por ele — e o `page.waitForEvent` rejeita sozinho quando
  // a página/contexto fecha. Sem este handler, essa rejeição é `unhandled` e
  // DERRUBA O PROCESSO do daemon inteiro, levando junto todas as outras sessões.
  // Anexar o handler aqui não consome a rejeição do `await waiter` abaixo:
  // aquele caminho continua caindo no try/catch que devolve TIMEOUT.
  waiter.catch(() => undefined);
  svc.emit("download.started", req.session_id, req.action_id, { via: url !== null ? "url" : "target" }, "agent");

  if (url !== null) {
    const safe = urlGuard(svc, url);
    // Navegar para um recurso baixável dispara o evento e aborta a navegação.
    await page.goto(safe).catch(() => undefined);
  } else {
    const resolved = await resolveOn(svc, req, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    const { pointer } = svc.enginesFor(req.session_id, page);
    // Mesmo funil: um link de download fora do viewport recebia clique morto e
    // o handler culpava o TIMEOUT do download por uma falha que era de mira.
    // A prova de entrega aqui é o próprio evento `download`, então não há sonda.
    const acao = await acionavel(svc, page, resolved, pointer);
    await pointer.click(acao.ponto, { action_id: req.action_id });
  }

  let dl: Download;
  try {
    dl = await waiter;
  } catch (e) {
    throw new ApiError("TIMEOUT", `nenhum download iniciou: ${(e as Error).message}`);
  }

  const suggested = dl.suggestedFilename();
  const decision = checkPath(suggested, "download", { root, mustExist: false });
  if (!decision.allowed) {
    await dl.cancel().catch(() => undefined);
    throw new ApiError(decision.code ?? "DOWNLOAD_DENIED", decision.reason, { filename: suggested, root: decision.root });
  }
  const destination = decision.resolved!;
  await dl.saveAs(destination);

  const record: DownloadRecord = {
    download_id: newId("dl"),
    session_id: req.session_id,
    filename: path.basename(destination),
    mime: null,
    size: null,
    status: "completed",
    source: dl.url(),
    destination,
    created_at: nowIso(),
  };
  svc.emit("download.completed", req.session_id, req.action_id, {
    download_id: record.download_id,
    filename: record.filename,
  }, "agent");
  return record;
};

const handleUpload: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const root = svc.config.upload_root;
  if (root === null) {
    throw new ApiError("UPLOAD_DENIED", "upload_root não configurado — upload negado (fail closed)");
  }
  const candidate = str(req.body, "path") ?? str(req.body, "file_ref");
  if (candidate === null) throw new ApiError("INVALID_REQUEST", "informe `path` ou `file_ref`");

  const decision = checkPath(candidate, "upload", { root, mustExist: true });
  if (!decision.allowed) {
    throw new ApiError(decision.code ?? "UPLOAD_DENIED", decision.reason, { root: decision.root });
  }
  const file = decision.resolved!;

  const resolved = await resolveOn(svc, req, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
  const loc = resolved.handle as Locator | undefined;
  if (loc === undefined) throw new ApiError("TARGET_NOT_FOUND", "upload exige um <input type=file>; alvo por coordenada não serve");

  svc.emit("upload.started", req.session_id, req.action_id, { filename: path.basename(file) }, "agent");
  try {
    await loc.setInputFiles(file);
  } catch (e) {
    throw new ApiError("UPLOAD_DENIED", `setInputFiles falhou: ${(e as Error).message}`, { target: resolved.description });
  }

  const record: UploadRecord = {
    upload_id: newId("up"),
    session_id: req.session_id,
    filename: path.basename(file),
    destination_site: new URL(page.url()).host,
    task: svc.sessions.get(req.session_id).task,
    created_at: nowIso(),
  };
  svc.emit("upload.completed", req.session_id, req.action_id, {
    upload_id: record.upload_id,
    filename: record.filename,
    destination_site: record.destination_site,
  }, "agent");
  return record;
};

// ─────────────────────────────────────────────────────────────────────────────
// Task (FASE 33/34) — exige AgentProvider; sem ele, fail closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tradução do código do motor para o enum FECHADO do contrato v1.
 *
 * `docs/API.md` é explícito: "não inventar código novo sem subir a versão do
 * contrato". O motor produz códigos que o contrato não tem (`CANCELLED`,
 * `RUNTIME_CRASH`, `SESSION_NOT_RECONSTITUTED`), então eles caem no código mais
 * próximo e o ORIGINAL viaja em `detail.task_code` — perder a causa exata seria
 * o pior dos dois mundos.
 */
function codigoDoContrato(code: string | null | undefined): ActionErrorCode {
  if (typeof code === "string" && Object.hasOwn(HTTP_STATUS, code)) return code as ActionErrorCode;
  switch (code) {
    case "SESSION_NOT_RECONSTITUTED":
      return "SESSION_NOT_FOUND";
    // `ABORTED`/`CANCELLED` não existem no enum v1. 499 não é status de contrato
    // e 4xx sugeriria pedido malformado, o que é falso: o pedido estava certo e
    // alguém mandou parar.
    case "ABORTED":
    case "CANCELLED":
    case "RUNTIME_CRASH":
    default:
      return "INTERNAL";
  }
}

/**
 * Constrói o PLANEJADOR e o EXECUTOR de passo para uma task.
 *
 * Os dois fecham sobre `svc`/`req`/`agent` e não sobre uma task específica: é o
 * `ctx.task.session_id` que diz em que sessão agir. Isso é o que permite ao
 * `resume` reusar exatamente o mesmo par depois de um crash — inclusive quando a
 * task foi religada a uma sessão NOVA.
 */
function tarefaIO(
  svc: RuntimeServices,
  req: ActionRequest,
  agent: AgentProvider,
  goal: string,
): { plan: TaskPlanner; execute: StepExecutor } {
  const nota = async (
    action: string,
    event: AuditEvent,
    result: "ok" | "error" | "denied",
    detail: Record<string, unknown>,
    error: { code: string; message: string } | null = null,
  ): Promise<void> => {
    await svc.note({
      session: req.session_id,
      event,
      action,
      actor: actorOf(req),
      provider: agent.name,
      task: req.task ?? null,
      page: req.page_id ?? null,
      action_id: req.action_id,
      result,
      verified: result === "ok",
      error,
      detail,
    });
  };

  /**
   * Todo contato com o provider passa por aqui — e é o ÚNICO ponto onde a
   * resposta dele é avaliada, então é onde `provider.degraded` nasce. Erro ou
   * timeout do modelo vira linha de trilha em vez de sumir num `catch` genérico.
   */
  const viaProvider = async <T>(etapa: string, fn: () => Promise<T>): Promise<T> => {
    const inicio = Date.now();
    try {
      return await fn();
    } catch (e) {
      const err = toActionError(e);
      await nota("provider.degraded", "provider", "error", {
        code: err.code,
        etapa,
        provider: agent.name,
        elapsed_ms: Date.now() - inicio,
      }, { code: err.code, message: err.message });
      throw e;
    }
  };

  /**
   * PLANEJAR NÃO É RETENTADO — decisão do motor, reforçada aqui pelo comentário
   * porque é contraintuitivo: um provider que acabou de dizer "estou fora" não
   * volta em 500 ms, e três tentativas produziriam três `provider.degraded` para
   * a MESMA falha, poluindo a trilha e gastando três inferências.
   */
  const plan: TaskPlanner = async ({ task }) => {
    const page = pageOf(svc, req);
    const raw = await svc.perception.observe(page, { limit: svc.config.observe_limit });
    const observation = await viaProvider("observe", () => agent.observe({ session_id: task.session_id, observation: raw }));
    const reasoning = await viaProvider("reason", () => agent.reason({ goal, observation }));
    return viaProvider("plan", () => agent.plan({ goal, observation, reasoning }));
  };

  const execute: StepExecutor = async ({ task, step, index, attempt }) => {
    // `agent.act` devolve um `ActionResponse` FALHO em vez de lançar quando o
    // passo é recusado — por isso a falha de passo não vira `provider.degraded`:
    // o modelo respondeu, quem recusou foi o runtime. Só uma EXCEÇÃO (modelo
    // fora do ar, timeout de inferência) degrada o provider.
    const response = await viaProvider("act", () => agent.act({ session_id: task.session_id, step }));
    const total = task.checkpoint?.total_steps ?? task.plan?.steps.length ?? 0;
    svc.emit("task.progress", task.session_id, response.action_id, {
      task_id: task.task_id,
      step: step.id,
      step_index: index,
      attempt,
      success: response.success,
      // Frase humana para o painel ("Clicando em Entrar (2 de 5)"). O `step`/id
      // técnico segue no payload para a trilha; a tela mostra a `descricao`.
      descricao: descreverPasso(step, index, total),
    }, agent.name);

    if (!response.success) {
      return {
        ok: false,
        action_id: response.action_id ?? null,
        code: String(response.error?.code ?? "INTERNAL"),
        message: String(response.error?.message ?? "passo falhou"),
        verified: false,
      };
    }
    const v = await viaProvider("verify", () => agent.verify({ step, response }));
    return {
      ok: true,
      action_id: response.action_id ?? null,
      code: null,
      message: null,
      verified: v.verified === true,
      result: response.result,
    };
  };

  return { plan, execute };
}

/** Levanta o erro guardado de uma task que não terminou em COMPLETED. */
function lancarSeNaoCompletou(rec: TaskRecord): void {
  if (rec.state === "COMPLETED") return;
  const bruto = rec.last_error?.code ?? "INTERNAL";
  throw new ApiError(codigoDoContrato(bruto), rec.last_error?.message ?? `task terminou em ${rec.state}`, {
    task_id: rec.task_id,
    run_id: rec.run_id,
    state: rec.state,
    // O código VERDADEIRO do motor, preservado mesmo quando o enum do contrato
    // não o comporta.
    task_code: bruto,
    step_index: rec.last_error?.step_index ?? rec.step_index,
    attempt: rec.last_error?.attempt ?? rec.attempt,
    retries: rec.retries,
    checkpoint_step_index: rec.checkpoint.step_index,
  });
}

const handleTask: ActionHandler = async (svc, req) => {
  const goal = reqStr(req.body, "goal");
  const idempotency_key = str(req.body, "idempotency_key");
  const agent = svc.agent;
  const engine = svc.taskEngine;

  if (agent === null) {
    // Fail closed, e agora PERSISTIDO: a task existe, está FAILED em disco e
    // diz por quê. Antes ela só existia em memória e sumia com o processo.
    const { record } = await engine.create({
      session_id: req.session_id,
      goal,
      owner: req.owner ?? null,
      provider: null,
      idempotency_key,
      inputs: { reason: "sem AgentProvider" },
    });
    req.task = record.task_id;
    await engine.falhar(record.task_id, "INVALID_REQUEST", "browser.task exige um AgentProvider registrado no daemon; nenhum foi injetado");
    svc.emit("task.failed", req.session_id, req.action_id, { task_id: record.task_id, code: "INVALID_REQUEST" }, "runtime");
    // Devolver um QUEUED que ninguém executará seria mentir por omissão.
    throw new ApiError(
      "INVALID_REQUEST",
      "browser.task exige um AgentProvider registrado no daemon; nenhum foi injetado",
      { task_id: record.task_id, goal },
    );
  }

  const { record, reused } = await engine.create({
    session_id: req.session_id,
    goal,
    owner: req.owner ?? null,
    provider: agent.name,
    idempotency_key,
  });
  // A partir daqui as linhas desta task carregam SEU task_id, não o da sessão.
  req.task = record.task_id;
  req.provider = agent.name;

  // IDEMPOTÊNCIA: chave já usada e task já terminada ⇒ devolve o que foi
  // guardado, sem tocar no navegador. É esta linha que faz a promessa valer
  // ENTRE REINÍCIOS, porque `create` consultou a reserva em DISCO.
  if (reused && estadoFinal(record.state)) {
    lancarSeNaoCompletou(record);
    return record;
  }

  svc.emit("task.started", req.session_id, req.action_id, { task_id: record.task_id, goal }, agent.name);
  const io = tarefaIO(svc, req, agent, goal);
  // `run` devolve a MESMA promessa para uma task já em voo: duas chamadas
  // simultâneas com a mesma chave compartilham uma execução, não duas.
  const final = await engine.run(record.task_id, io);

  if (final.state === "COMPLETED") {
    svc.emit("task.completed", req.session_id, req.action_id, {
      task_id: final.task_id,
      steps: final.checkpoint.total_steps,
      retries: final.retries,
    }, agent.name);
    return final;
  }
  svc.emit("task.failed", req.session_id, req.action_id, {
    task_id: final.task_id,
    state: final.state,
    code: final.last_error?.code ?? null,
  }, agent.name);
  lancarSeNaoCompletou(final);
  return final; // inalcançável; mantém o tipo honesto
};

// ─────────────────────────────────────────────────────────────────────────────
// FASE 9 — rotas de GESTÃO de task
//
// Respondem o objeto DIRETO, sem envelope `ActionResponse`, como `docs/API.md`
// manda para rotas de gestão: uma listagem de tasks não tem `state` de sessão
// nem `timing` de ação, e embrulhá-la inventaria campos.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskRouteName = "tasks.list" | "tasks.get" | "tasks.cancel" | "tasks.resume";

export async function handleTaskRoute(
  svc: RuntimeServices,
  name: TaskRouteName,
  params: Record<string, string>,
  body: Body,
  search: URLSearchParams,
  actor: string,
  /**
   * FASE 10 — quem PODE, para efeito de lease. Diferente de `actor`, que é quem
   * APARECE na trilha: `x-nomos-client` é auto-declarado e não decide controle.
   */
  principal: string = actor,
  /**
   * FASE 9b — registra (ou solta) a delegação da task para uma sessão.
   *
   * O executor de passo fala com a própria API por loopback e precisa se
   * apresentar como o dono da task, não como o daemon. Em `browser.task` o
   * daemon já fazia isso; no `resume` NÃO fazia, e sob `allow_unleased: false`
   * todo passo retomado bateria em CONTROL_NOT_OWNED — o lease é do agente, o
   * token do loopback é o do runtime. O mapa vive no daemon (é dele o
   * `taskHolders`), então ele entra por injeção em vez de vazar para cá.
   */
  delegar: (session_id: string, quem: string | null) => void = () => undefined,
): Promise<unknown> {
  const engine = svc.taskEngine;
  // Sem hidratar, a listagem mostraria só as tasks criadas DESDE o arranque — e
  // depois de um crash é exatamente a task antiga que o operador procura.
  await engine.hidratar();

  if (name === "tasks.list") {
    const session_id = (typeof body.session_id === "string" ? body.session_id : null) ?? search.get("session_id");
    const state = (typeof body.state === "string" ? body.state : null) ?? search.get("state");
    if (state !== null && state !== "" && !(TASK_ESTADOS as readonly string[]).includes(state)) {
      throw new ApiError("INVALID_REQUEST", `estado desconhecido: ${state}`, { state, known: [...TASK_ESTADOS] });
    }
    const tasks = engine.list({ session_id, state });
    return { tasks, total: tasks.length, filter: { session_id, state } };
  }

  const task_id = params.task_id ?? "";
  if (task_id === "") throw new ApiError("INVALID_REQUEST", "task_id ausente na rota");
  const sessaoDica = (typeof body.session_id === "string" ? body.session_id : null) ?? search.get("session_id");
  const rec = await engine.fetch(task_id, sessaoDica);
  if (rec === null) {
    // 404 honesto: a task não existe nem em memória nem em disco.
    throw new ApiError("SESSION_NOT_FOUND", `task desconhecida: ${task_id}`, { task_id });
  }

  if (name === "tasks.get") return rec;

  if (name === "tasks.cancel") {
    const reason = typeof body.reason === "string" && body.reason !== "" ? body.reason : `cancelada por ${actor}`;
    return engine.cancel(task_id, reason);
  }

  // tasks.resume
  const agent = svc.agent;
  if (estadoFinal(rec.state)) {
    // Não reexecuta. O resultado guardado É a resposta — e sem AgentProvider
    // este caminho continua valendo, porque não há nada a executar.
    return engine.resume(task_id, { plan: naoPlaneja, execute: naoExecuta });
  }
  if (agent === null) {
    throw new ApiError("INVALID_REQUEST", "resume exige um AgentProvider registrado no daemon; nenhum foi injetado", { task_id });
  }
  const novaSessao = typeof body.session_id === "string" && body.session_id !== "" ? body.session_id : null;
  const sessaoAlvo = novaSessao ?? rec.session_id;
  const reqSintetico: ActionRequest = {
    tool: "browser.task",
    action_id: newActionId(),
    session_id: sessaoAlvo,
    body: {},
    client: actor,
    subject: actor,
    owner: rec.owner ?? null,
    task: rec.task_id,
    provider: agent.name,
  };
  const io = tarefaIO(svc, reqSintetico, agent, rec.goal);
  // A delegação dura EXATAMENTE a retomada. Deixá-la registrada depois seria um
  // token de controle pendurado: qualquer passo posterior nesta sessão passaria
  // a agir em nome de quem pediu o resume, muito depois de ele ter ido embora.
  delegar(sessaoAlvo, principal);
  try {
    return await engine.resume(task_id, io, { session_id: novaSessao });
  } finally {
    delegar(sessaoAlvo, null);
  }
}

/** Planejador/executor inertes: usados só no ramo que NÃO reexecuta nada. */
const naoPlaneja: TaskPlanner = async () => {
  throw new ApiError("INTERNAL", "planejador inerte foi chamado: uma task em estado final não deveria replanejar");
};
const naoExecuta: StepExecutor = async () => {
  throw new ApiError("INTERNAL", "executor inerte foi chamado: uma task em estado final não deveria executar passo");
};

// ─────────────────────────────────────────────────────────────────────────────

export const HANDLERS: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "browser.open": handleOpen,
  "browser.goto": handleGoto,
  "browser.back": historyHandler("back"),
  "browser.forward": historyHandler("forward"),
  "browser.reload": historyHandler("reload"),
  "browser.observe": handleObserve,
  "browser.find": handleFind,
  "browser.extract": handleExtract,
  "browser.screenshot": handleScreenshot,
  "browser.network": handleNetwork,
  "browser.tabs": handleTabs,
  "browser.new_tab": handleNewTab,
  "browser.switch_tab": handleSwitchTab,
  "browser.close_tab": handleCloseTab,
  "browser.click": handleClick,
  "browser.type": handleType,
  "browser.press": handlePress,
  "browser.scroll": handleScroll,
  "browser.drag": handleDrag,
  "browser.wait": handleWait,
  "browser.download": handleDownload,
  "browser.upload": handleUpload,
  "browser.task": handleTask,
});

export function handlerFor(tool: string): ActionHandler | null {
  return Object.hasOwn(HANDLERS, tool) ? HANDLERS[tool]! : null;
}

/** Trilha de auditoria de uma ação. Não recebe corpo — corpo pode carregar segredo. */
/**
 * Quem pediu a ação, em ordem de especificidade:
 *
 *   1. `x-nomos-client` — a identidade que o agente declara por chamada;
 *   2. o sujeito do token que autenticou o pedido;
 *   3. o dono da sessão.
 *
 * A trilha antiga tinha só (1), e como quase nenhum cliente manda o header o
 * campo era "unknown" em 100% das linhas — o dado mais importante da auditoria
 * era o único que faltava. "unknown" só sobra quando não há sessão, token nem
 * dono, e nesse caso o fato é do próprio runtime: `runtime`.
 */
export function actorOf(req: ActionRequest): string {
  for (const cand of [req.client, req.subject, req.owner]) {
    if (typeof cand === "string" && cand.trim() !== "") return cand;
  }
  return "runtime";
}

/** Capability exigida pela ferramenta, direto do contrato. */
export function capabilityFor(tool: string): string | null {
  return Object.hasOwn(REQUIRED_CAPABILITY, tool) ? REQUIRED_CAPABILITY[tool]! : null;
}

export function auditEntryFor(
  req: ActionRequest,
  result: "ok" | "error" | "denied",
  verified: boolean | null,
  detail?: Record<string, unknown>,
  over?: Partial<AuditEntry>,
): AuditEntry {
  const base: Record<string, unknown> = {
    timestamp: nowIso(),
    event: "action" as AuditEvent,
    session: req.session_id === "" ? null : req.session_id,
    browser: req.browser ?? null,
    page: req.page_id ?? null,
    task: req.task ?? null,
    owner: req.owner ?? null,
    actor: actorOf(req),
    provider: req.provider ?? null,
    action: req.tool,
    capability: capabilityFor(req.tool),
    policy_decision: result === "denied" ? "deny" : "allow",
    policy_reason: null,
    target: typeof req.body.target === "object" && req.body.target !== null ? JSON.stringify(req.body.target) : null,
    result,
    verified,
    error: null,
    detail: detail ?? {},
    action_id: req.action_id,
  };
  if (over !== undefined) {
    for (const [k, v] of Object.entries(over)) {
      if (v !== undefined) base[k] = v;
    }
  }
  return makeAuditEntry(base as Partial<AuditEntry>);
}

export { newActionId };
export type { PlanStep };
