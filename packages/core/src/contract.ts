/**
 * CONTRATO NOMOS BROWSER RUNTIME — v1
 *
 * Fonte única de verdade dos tipos que atravessam os módulos. Todo módulo
 * (core, api, mcp, sdk, cli, ui, observability) importa daqui e não redefine.
 *
 * Regra de desacoplamento (art. 3 da missão): NADA neste arquivo pode
 * referenciar um LLM específico. O runtime não sabe quem é o agente — sabe
 * apenas que existe um `AgentProvider` com cinco verbos.
 *
 * Mudança incompatível exige v2. Este é o v1.
 */

export const CONTRACT_VERSION = "1" as const;
export const API_PREFIX = "/api/v1" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sessão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estados de sessão. `PAUSED` existe por causa do takeover humano (FASE 32):
 * quando o humano assume, o agente é congelado — e ao devolver o controle o
 * runtime reobserva, porque assumir que a página não mudou seria mentira.
 */
export type SessionState =
  | "CREATED"
  | "ACTIVE"
  | "IDLE"
  | "PAUSED"
  | "FAILED"
  | "CLOSED"
  | "RECOVERING";

export interface SessionInfo {
  session_id: string;
  owner: string;
  profile: string;
  permissions: Capabilities;
  created_at: string;
  last_activity: string;
  context_id: string;
  pages: PageInfo[];
  task: string | null;
  status: SessionState;
  /** Quem detém o controle agora. `human` congela as ações do agente. */
  control: "agent" | "human";
  /** Cliente atualmente conectado — null significa sessão órfã porém VIVA. */
  attached_client: string | null;
}

export interface PageInfo {
  page_id: string;
  url: string;
  title: string;
  active: boolean;
  opened_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope de ação — toda chamada da API v1 responde nesta forma
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionTiming {
  started_at: string;
  ended_at: string;
  duration_ms: number;
}

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  /** Detalhe estruturado; nunca contém segredo (ver redaction em observability). */
  detail?: Record<string, unknown>;
}

export type ActionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "CONTROL_HELD_BY_HUMAN"
  | "CAPABILITY_DENIED"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "VERIFICATION_FAILED"
  | "NAVIGATION_FAILED"
  | "TIMEOUT"
  | "BACKPRESSURE_REJECTED"
  | "POLICY_BLOCKED"
  | "BROWSER_UNAVAILABLE"
  | "UPLOAD_DENIED"
  | "DOWNLOAD_DENIED"
  | "INVALID_REQUEST"
  | "INTERNAL";

export interface ActionResponse<T = unknown> {
  success: boolean;
  action_id: string;
  state: SessionState;
  result: T | null;
  error: ActionError | null;
  timing: ActionTiming;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alvo — nunca só seletor CSS (FASE 13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descritor de alvo. Vários campos podem coexistir: o resolvedor tenta a
 * cascata seletor → role/text → accessibility → semantic → vision → coordenada
 * e devolve por qual estratégia acertou. Um alvo que só tem `selector` é
 * frágil por construção, e o runtime registra isso.
 */
export interface TargetDescriptor {
  selector?: string;
  text?: string;
  role?: string;
  label?: string;
  placeholder?: string;
  semantic?: string;
  coordinates?: { x: number; y: number };
  /** Índice quando o alvo é legitimamente múltiplo (ex.: 3ª linha da tabela). */
  nth?: number;
}

export type TargetStrategy =
  | "selector"
  | "role_text"
  | "accessibility"
  | "semantic"
  | "vision"
  | "coordinates";

export interface ResolvedTarget {
  strategy: TargetStrategy;
  /** Ordem das estratégias tentadas até acertar — evidência de self-healing. */
  attempted: TargetStrategy[];
  box: BoundingBox;
  /** Handle opaco para o backend; não atravessa a fronteira da API. */
  handle?: unknown;
  description: string;
  /** true quando a estratégia que funcionou não foi a primeira pedida. */
  healed: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificação (FASE 14)
// ─────────────────────────────────────────────────────────────────────────────

export type VerificationKind =
  | "URL_CHANGED"
  | "ELEMENT_APPEARED"
  | "ELEMENT_DISAPPEARED"
  | "NETWORK_SUCCESS"
  | "TEXT_CHANGED"
  | "DOM_CHANGED"
  | "NONE";

export interface VerificationSpec {
  kind: VerificationKind;
  /** Alvo/valor esperado conforme o kind. */
  expect?: string;
  timeout_ms?: number;
}

export interface VerificationResult {
  executed: boolean;
  verified: boolean;
  /**
   * Confiança em [0,1]. É derivada de sinais observados (quantas verificações
   * independentes bateram), nunca inventada. 1.0 exige verificação explícita.
   */
  confidence: number;
  kind: VerificationKind;
  observed: string | null;
  retries: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Percepção (FASE 12)
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservedElement {
  ref: string;
  tag: string;
  role: string | null;
  text: string | null;
  attributes: Record<string, string>;
  box: BoundingBox;
  visible: boolean;
  enabled: boolean;
}

export interface Observation {
  url: string;
  title: string;
  page_id: string;
  elements: ObservedElement[];
  /** Árvore de acessibilidade serializada, quando pedida. */
  accessibility: AxNode | null;
  screenshot_ref: string | null;
  observed_at: string;
  /** Quantos elementos existiam antes do corte por `limit`. Sem isto, um
   *  truncamento silencioso pareceria "a página só tem 50 elementos". */
  total_elements: number;
  truncated: boolean;
}

export interface AxNode {
  role: string;
  name: string | null;
  value?: string;
  description?: string;
  children?: AxNode[];
}

/** Adaptador de visão. O runtime não fixa fornecedor (art. 16). */
export interface VisionProvider {
  readonly name: string;
  locate(input: {
    screenshot: Buffer;
    goal: string;
    viewport: { width: number; height: number };
  }): Promise<{ box: BoundingBox; confidence: number } | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities / Policy (FASE 19)
// ─────────────────────────────────────────────────────────────────────────────

export interface Capabilities {
  navigate: boolean;
  read: boolean;
  click: boolean;
  type: boolean;
  download: boolean;
  upload: boolean;
  send: boolean;
  purchase: boolean;
  payment: boolean;
  delete: boolean;
}

/** Classe da ação. COMMIT é o que muda o mundo lá fora — fail closed por padrão. */
export type ActionClass = "OBSERVE" | "ACT" | "COMMIT";

/**
 * Política restrita: o default. Qualquer coisa que altere sistemas externos
 * (send/purchase/payment/delete/upload) nasce negada e só é concedida por ato
 * explícito do dono, nunca por inferência do agente.
 */
export const RESTRICTED_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  navigate: true,
  read: true,
  click: true,
  type: true,
  download: false,
  upload: false,
  send: false,
  purchase: false,
  payment: false,
  delete: false,
});

export const OBSERVE_ONLY_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  navigate: true,
  read: true,
  click: false,
  type: false,
  download: false,
  upload: false,
  send: false,
  purchase: false,
  payment: false,
  delete: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Eventos (FASE 5)
// ─────────────────────────────────────────────────────────────────────────────

export type EventName =
  | "runtime.started"
  | "browser.started"
  | "browser.closed"
  | "session.created"
  | "session.resumed"
  | "session.closed"
  | "session.handoff"
  | "page.opened"
  | "page.loaded"
  | "page.closed"
  | "element.found"
  | "mouse.moved"
  | "mouse.clicked"
  | "mouse.dragged"
  | "mouse.scrolled"
  | "keyboard.typed"
  | "keyboard.pressed"
  | "download.started"
  | "download.completed"
  | "upload.started"
  | "upload.completed"
  | "network.request"
  | "network.response"
  | "network.failed"
  | "task.started"
  | "task.progress"
  | "task.paused"
  | "task.completed"
  | "task.failed"
  | "action.started"
  | "action.completed"
  | "action.failed"
  | "action.retried"
  | "target.healed"
  | "secret.used"
  | "control.taken"
  | "control.returned";

export interface RuntimeEvent<P = Record<string, unknown>> {
  timestamp: string;
  session_id: string | null;
  action_id: string | null;
  /** Quem originou: identidade do agente, "human" ou "runtime". */
  source: string;
  event: EventName;
  payload: P;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task (FASE 33/34)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskState =
  | "QUEUED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING"
  | "PAUSED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface PlanStep {
  id: string;
  intent: string;
  action: string;
  target?: TargetDescriptor;
  value?: string;
  verification?: VerificationSpec;
}

/** Contrato de plano abstrato (FASE 34) — o runtime executa planos de qualquer agente. */
export interface Plan {
  goal: string;
  constraints: string[];
  steps: PlanStep[];
  success_conditions: string[];
  failure_conditions: string[];
}

export interface BrowserTask {
  task_id: string;
  session_id: string;
  goal: string;
  state: TaskState;
  plan: Plan | null;
  actions: string[];
  retries: number;
  evidence: string[];
  result: unknown;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentProvider — a fronteira que mantém o runtime universal (art. 3)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentProvider {
  readonly name: string;
  observe(ctx: { session_id: string; observation: Observation }): Promise<Observation>;
  reason(ctx: { goal: string; observation: Observation }): Promise<string>;
  plan(ctx: { goal: string; observation: Observation; reasoning: string }): Promise<Plan>;
  act(ctx: { session_id: string; step: PlanStep }): Promise<ActionResponse>;
  verify(ctx: { step: PlanStep; response: ActionResponse }): Promise<VerificationResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Segredos (FASE 18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O agente pede por referência; o runtime injeta. O valor NUNCA volta na
 * resposta e NUNCA entra em log — só o uso é auditado.
 */
export interface SecretProvider {
  readonly name: string;
  has(ref: string): Promise<boolean>;
  /** Uso interno do runtime. Chamadores da API não têm rota para isto. */
  resolve(ref: string): Promise<string>;
}

export interface CredentialRef {
  credential_ref: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health (FASE 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  runtime: "ok" | "degraded" | "down";
  browser: "ok" | "starting" | "down";
  workers: { active: number; max: number };
  sessions: { total: number; active: number; idle: number; paused: number };
  version: string;
  contract: string;
  uptime_s: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Downloads / Uploads (FASE 21/22)
// ─────────────────────────────────────────────────────────────────────────────

export type DownloadStatus = "started" | "progress" | "completed" | "failed";

export interface DownloadRecord {
  download_id: string;
  session_id: string;
  filename: string;
  mime: string | null;
  size: number | null;
  status: DownloadStatus;
  source: string;
  destination: string;
  created_at: string;
}

export interface UploadRecord {
  upload_id: string;
  session_id: string;
  filename: string;
  destination_site: string;
  task: string | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria (FASE 24)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  session: string | null;
  actor: string;
  action: string;
  target: string | null;
  result: "ok" | "error" | "denied";
  verified: boolean;
  action_id: string | null;
  /** Nunca contém valor de segredo — apenas a referência usada. */
  detail?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades compartilhadas
// ─────────────────────────────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

let actionCounter = 0;
export function newActionId(): string {
  actionCounter += 1;
  return `act_${Date.now().toString(36)}_${actionCounter.toString(36)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function ok<T>(action_id: string, state: SessionState, result: T, timing: ActionTiming): ActionResponse<T> {
  return { success: true, action_id, state, result, error: null, timing };
}

export function fail(
  action_id: string,
  state: SessionState,
  code: ActionErrorCode,
  message: string,
  timing: ActionTiming,
  detail?: Record<string, unknown>,
): ActionResponse<never> {
  return { success: false, action_id, state, result: null, error: { code, message, detail }, timing };
}

export function timer(): { done: () => ActionTiming } {
  const started = Date.now();
  const started_at = new Date(started).toISOString();
  return {
    done: () => {
      const ended = Date.now();
      return { started_at, ended_at: new Date(ended).toISOString(), duration_ms: ended - started };
    },
  };
}

/** Classe de cada ferramenta da API. O policy engine consulta isto — não adivinha. */
export const ACTION_CLASS: Readonly<Record<string, ActionClass>> = Object.freeze({
  "browser.open": "ACT",
  "browser.goto": "ACT",
  "browser.back": "ACT",
  "browser.forward": "ACT",
  "browser.reload": "ACT",
  "browser.observe": "OBSERVE",
  "browser.find": "OBSERVE",
  "browser.extract": "OBSERVE",
  "browser.screenshot": "OBSERVE",
  "browser.network": "OBSERVE",
  "browser.tabs": "OBSERVE",
  "browser.click": "ACT",
  "browser.type": "ACT",
  "browser.press": "ACT",
  "browser.scroll": "ACT",
  "browser.drag": "ACT",
  "browser.wait": "OBSERVE",
  "browser.new_tab": "ACT",
  "browser.switch_tab": "ACT",
  "browser.close_tab": "ACT",
  "browser.download": "COMMIT",
  "browser.upload": "COMMIT",
  "browser.task": "ACT",
});

/** Capability exigida por ferramenta. Ausente = negado (fail closed). */
export const REQUIRED_CAPABILITY: Readonly<Record<string, keyof Capabilities>> = Object.freeze({
  "browser.open": "navigate",
  "browser.goto": "navigate",
  "browser.back": "navigate",
  "browser.forward": "navigate",
  "browser.reload": "navigate",
  "browser.observe": "read",
  "browser.find": "read",
  "browser.extract": "read",
  "browser.screenshot": "read",
  "browser.network": "read",
  "browser.tabs": "read",
  "browser.wait": "read",
  "browser.click": "click",
  "browser.drag": "click",
  "browser.scroll": "click",
  "browser.new_tab": "navigate",
  "browser.switch_tab": "navigate",
  "browser.close_tab": "navigate",
  "browser.type": "type",
  "browser.press": "type",
  "browser.download": "download",
  "browser.upload": "upload",
  "browser.task": "click",
});
