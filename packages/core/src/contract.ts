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
  // FASE 4 — o alvo existe mas não pode receber o gesto: fora do viewport
  // mesmo depois de rolar, área zero, invisível, coberto, ou removido do DOM.
  // Existe para separar "não achei" de "achei e não dá para agir", que antes
  // caíam os dois em silêncio com `success:true`.
  | "TARGET_NOT_ACTIONABLE"
  // FASE 4 — o gesto foi despachado e NENHUM evento chegou ao alvo. É o código
  // que impede o sucesso falso: sem ele, "cliquei" e "o elemento foi clicado"
  // eram a mesma afirmação.
  | "CLICK_NOT_DELIVERED"
  | "VERIFICATION_FAILED"
  | "NAVIGATION_FAILED"
  | "TIMEOUT"
  | "BACKPRESSURE_REJECTED"
  | "POLICY_BLOCKED"
  // Live Agent — um HUMANO olhou e disse nao. Merece codigo proprio: juntar
  // isso a `CAPABILITY_DENIED` apagaria a unica diferenca que importa para
  // quem le a trilha depois — se foi a POLITICA que barrou ou se foi uma
  // PESSOA que decidiu. As duas pedem reacoes opostas.
  | "APPROVAL_DENIED"
  // Ninguem respondeu dentro do prazo. Fail-closed: a ausencia de resposta
  // NUNCA vira permissao. Separado de APPROVAL_DENIED porque "disseram nao" e
  // "nao havia ninguem" sao diagnosticos diferentes.
  | "APPROVAL_TIMEOUT"
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
// Procedência de conteúdo web (ligação da defesa anti-injeção)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O vocabulário de suspeita mora AQUI e não em `sanitize.ts` por causa da
 * direção da dependência: `sanitize.ts` já importa deste arquivo. Descrever
 * `Provenance.findings` importando de volta fecharia um ciclo. Além disso este
 * tipo atravessa a fronteira da API — vai no corpo da resposta de
 * `browser.observe`/`browser.extract` —, e tudo que atravessa a fronteira é
 * contrato por definição.
 */
export type SuspeitaCategoria =
  | "instrucao"
  | "impersonacao"
  | "exfiltracao"
  | "execucao"
  | "oculto"
  | "delimitador";

export type SuspeitaSeveridade = "alta" | "media" | "baixa";

export interface Suspeita {
  /** `S1`, `S2`… — o mesmo id aparece como marcador dentro de `sanitized_content`. */
  id: string;
  /** Identificador estável do padrão que disparou. */
  padrao: string;
  categoria: SuspeitaCategoria;
  severidade: SuspeitaSeveridade;
  /** Onde foi encontrado, em linguagem de auditor. */
  onde: string;
  /** `ref` do elemento (`e12`), ou `null` quando não veio de um elemento. */
  ref: string | null;
  /** Excerto LITERAL da página, com contexto. Nunca reescrito. */
  trecho: string;
  motivo: string;
}

export type TrustLevel = "TRUSTED" | "UNTRUSTED";
export type ContentSource = "WEB" | "RUNTIME";

/**
 * Selo de procedência que acompanha TODO conteúdo lido de página.
 *
 * A razão de existir é que o runtime não controla o modelo: não há como impedir
 * que ele leia um parágrafo persuasivo. O que o runtime controla é o *envelope*
 * da entrega. Sem este selo, texto de página e texto de runtime chegam ao agente
 * indistinguíveis — e indistinguível é exatamente a condição que a injeção de
 * prompt explora.
 *
 * `raw_content_available === false` nunca significa "o conteúdo sumiu": o texto
 * literal continua em `findings[].trecho` e dentro de `sanitized_content`. Apagar
 * sem rastro esconderia o ataque de quem audita, que é justamente quem precisa
 * vê-lo.
 */
export interface Provenance {
  /** "WEB" para tudo que veio da página. */
  source: ContentSource;
  /** Conteúdo de página é sempre UNTRUSTED — não existe página confiável. */
  trust: TrustLevel;
  injection_detected: boolean;
  /** MAIOR severidade encontrada; `null` quando não houve nenhuma suspeita. */
  severity: SuspeitaSeveridade | null;
  /** Lista completa, com o trecho literal. */
  findings: Suspeita[];
  /** Texto delimitado por nonce, pronto para entrega ao modelo. */
  sanitized_content: string;
  nonce: string;
  /** Conforme a política `raw_web_content`. */
  raw_content_available: boolean;
  /** Por que o cru foi retido, quando foi. `null` quando não houve retenção. */
  raw_withheld_reason: string | null;
  /** Quantos campos textuais foram inspecionados — controle de teste vácuo. */
  fields_inspected: number;
  origin: string | null;
}

/** Resultado de `browser.observe`: a observação MAIS o selo de procedência. */
export interface ObservationEnvelope extends Observation {
  provenance: Provenance;
}

/** Resultado de `browser.extract`. `content` permanece — quem já consome não quebra. */
export interface ExtractResult {
  content: unknown;
  scope: "document" | "element";
  format: string;
  target?: Omit<ResolvedTarget, "handle">;
  provenance: Provenance;
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
  | "control.returned"
  // FASE 20b — RECUSA DE SESSAO POR PRESSAO, AO VIVO.
  //
  // `session.created` so existe quando a sessao nasce. A recusa por pool cheio
  // nao tinha nome nenhum no barramento: quem observava o runtime pelo
  // WebSocket via o silencio de uma sessao que nunca apareceu e nao tinha como
  // distinguir "ninguem pediu" de "pedi e fui recusado".
  | "session.rejected"
  // ── Live Agent Console ────────────────────────────────────────────────────
  // Sem estes nomes, uma sessao governada por autonomia era irreconstituivel:
  // a trilha mostrava a acao acontecendo e nao mostrava a DECISAO que a
  // permitiu. Reconstruir "por que isso rodou?" e' o proposito da trilha.
  | "autonomy.changed"
  | "action.proposed"
  | "action.approved"
  | "action.denied"
  | "cancel.requested"
  | "cancel.accepted"
  | "cancel.too_late"
  | "owner.changed"
  | "agent.paused"
  | "agent.resumed"
  | "emergency_stop"
  | "session.completed";

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
  /**
   * FASE 20b — PROFUNDIDADE DA FILA, AGREGADA.
   *
   * DEFEITO MEDIDO (soak de 100 ciclos): `fila_running`/`fila_waiting` so eram
   * publicados pelo daemon nos ciclos COM task, e nenhuma rota publicava a
   * profundidade da `SessionQueue`. `/health` dizia quantos workers e quantas
   * sessoes havia — nunca quantas acoes estavam presas esperando. Um operador
   * vendo 429 no cliente nao tinha como confirmar a pressao pelo runtime.
   *
   * SO O AGREGADO SAI AQUI, e isso e deliberado: `/health` pede apenas o escopo
   * OBSERVE, que e concedido inclusive a token limitado a UMA sessao (a rota nao
   * nomeia sessao, entao a allowlist nao restringe nada). `running`/`waiting`
   * POR SESSAO neste corpo entregaria a atividade das sessoes alheias a quem so
   * podia ver a propria — quem lesse em laco veria quando cada sessao trabalha e
   * quando para. O agregado responde "o runtime esta sob pressao?" sem dizer de
   * QUEM e a pressao. O detalhe por sessao vive em `GET /api/v1/queues`, ADMIN.
   */
  queues: {
    /** Soma das acoes EM EXECUCAO em todas as filas de sessao. */
    running: number;
    /** Soma das acoes AGUARDANDO em todas as filas de sessao. */
    waiting: number;
    /** Quantas sessoes ja tem fila instanciada (a fila nasce na 1a acao). */
    sessions_with_queue: number;
    /** Teto por sessao, da config — o denominador de `running`. */
    max_concurrency: number;
    /** Teto de espera por sessao, da config — o denominador de `waiting`. */
    max_queue: number;
  };
  version: string;
  contract: string;
  uptime_s: number;
  /**
   * FASE 13 — estado do vigia de subsistemas.
   *
   * Sai no `/health` porque é ali que um supervisor externo (o LaunchAgent da
   * FASE 14, um painel, um `curl` do dono) pergunta se o runtime está bem. Um
   * daemon que responde 200 enquanto o navegador dele morreu não está bem, e
   * antes desta fase era exatamente isso que ele respondia.
   *
   * `frozen` é medido de fora do laço, comparando o último tique com o relógio
   * agora: quando o event loop trava, nenhum timer dispara — inclusive o que
   * fiscalizaria o travamento —, então só quem lê de fora enxerga.
   */
  watchdog?: {
    enabled: boolean;
    state?: "idle" | "running" | "degraded" | "stopped";
    ticks?: number;
    stale_ms?: number | null;
    frozen?: boolean;
    /** Quantas vezes o event loop já ficou travado além do limite. */
    freezes?: number;
    last_freeze_ms?: number | null;
    degraded_by?: string | null;
    detected?: Record<string, number>;
    recovered?: Record<string, number>;
  };
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

/**
 * Classe do fato registrado. Não é decoração: é o que permite separar "o agente
 * clicou" de "a política recusou" de "o humano tomou o volante" sem precisar
 * adivinhar pelo nome da ação.
 */
export type AuditEvent =
  | "action"
  | "policy"
  | "control"
  | "recovery"
  | "task"
  | "provider"
  /**
   * FASE 20b — RECUSA POR CAPACIDADE.
   *
   * Nao cabia em nenhuma das classes anteriores, e forcar uma delas apagaria a
   * pergunta que a classe existe para responder. `policy` seria mentira: nenhuma
   * politica foi consultada quando o pool esta cheio — quem recusou foi o TETO,
   * e um auditor que busca negacao de politica passaria a receber casos que a
   * politica nunca viu. `control` e sobre quem manda na sessao, e aqui nao ha
   * sessao. Com classe propria, "quantas sessoes foram recusadas por pressao
   * ontem?" e um filtro por `event`, nao uma arqueologia por texto de mensagem.
   */
  | "backpressure";

/**
 * A lista em tempo de EXECUCAO dos valores de `AuditEvent`.
 *
 * POR QUE A TUPLA CRUA FICA SEPARADA DA CONSTANTE EXPORTADA: anotar direto
 * (`const X: readonly AuditEvent[] = Object.freeze([...] as const)`) ALARGA o
 * tipo — `(typeof X)[number]` vira `AuditEvent` e o `Exclude` abaixo daria
 * `never` para QUALQUER lista, inclusive uma vazia. O guarda pareceria ativo e
 * nao verificaria nada. Foi exatamente o que aconteceu com `KNOWN_EVENTS` em
 * `router.ts`, corrigido junto nesta fase. Com a tupla intacta, o compilador
 * reprova nas duas direcoes: valor do union que ficou de fora, e valor na lista
 * que nao existe no union.
 */
const AUDIT_EVENTS_TUPLA = [
  "action",
  "policy",
  "control",
  "recovery",
  "task",
  "provider",
  "backpressure",
] as const;

export const AUDIT_EVENTS: readonly AuditEvent[] = Object.freeze(AUDIT_EVENTS_TUPLA);

type AuditEventFaltando = Exclude<AuditEvent, (typeof AUDIT_EVENTS_TUPLA)[number]>;
type AuditEventSobrando = Exclude<(typeof AUDIT_EVENTS_TUPLA)[number], AuditEvent>;
type AuditEventCobertura = [AuditEventFaltando] extends [never]
  ? [AuditEventSobrando] extends [never]
    ? true
    : ["AUDIT_EVENTS declara valor que nao existe em AuditEvent", AuditEventSobrando]
  : ["AuditEvent sem cobertura em AUDIT_EVENTS", AuditEventFaltando];
/** So existe para o typecheck falhar quando AUDIT_EVENTS ficar para tras. */
const _auditEventCobertura: AuditEventCobertura = true;
void _auditEventCobertura;

/**
 * Veredito de política numa linha de auditoria.
 *
 * `require_approval` entrou com o Live Agent, e a lacuna que ele preenche era
 * real: a trilha não tinha como dizer "parou para um humano decidir". As três
 * opções antigas obrigavam a mentir — `deny` afirmaria que a ação foi recusada
 * (não foi; ficou pendente) e `not_applicable` afirmaria que nenhuma política
 * opinou (opinou, e foi justamente ela que segurou). Reconstruir uma sessão
 * governada por autonomia exige distinguir os três desfechos.
 */
export type PolicyDecisionLabel = "allow" | "deny" | "not_applicable" | "require_approval";

export interface AuditErrorRef {
  code: string;
  message: string;
}

/**
 * FASE 3 (auditoria forense) — a linha de `sessions/<id>/actions.jsonl`.
 *
 * TODA chave é obrigatória. `null` é uma resposta ("não se aplica"); chave
 * AUSENTE é uma pergunta sem resposta, e foi exatamente o que impediu a trilha
 * antiga de reconstruir quem agiu, em que aba, sob que decisão de política.
 * `makeAuditEntry` existe para que nenhum produtor consiga esquecer um campo —
 * e para que `undefined` (que `JSON.stringify` APAGA) nunca chegue ao disco.
 */
export interface AuditEntry {
  timestamp: string;
  event: AuditEvent;
  session: string | null;
  /** BrowserContext da sessão — estável na sessão, distinto entre sessões. */
  browser: string | null;
  /** page_id da aba em que o fato ocorreu. */
  page: string | null;
  /** task_id a que o fato pertence. */
  task: string | null;
  /** Dono corrente da sessão no instante do fato. */
  owner: string | null;
  /** Quem pediu. NUNCA "unknown" quando a sessão tem dono. */
  actor: string;
  /** provider_id do AIProvider/VisionProvider envolvido. */
  provider: string | null;
  action: string;
  /** Capability exigida pela ação (de REQUIRED_CAPABILITY). */
  capability: string | null;
  policy_decision: PolicyDecisionLabel;
  /** Código + texto curto quando `deny`. */
  policy_reason: string | null;
  target: string | null;
  result: "ok" | "error" | "denied";
  verified: boolean | null;
  error: AuditErrorRef | null;
  /** Nunca contém valor de segredo — apenas a referência usada. */
  detail: Record<string, unknown>;
  action_id: string | null;
}

/** Contrato de forma: o gate de auditoria confere chave a chave contra esta lista. */
export const AUDIT_FIELDS: readonly (keyof AuditEntry)[] = Object.freeze([
  "timestamp",
  "event",
  "session",
  "browser",
  "page",
  "task",
  "owner",
  "actor",
  "provider",
  "action",
  "capability",
  "policy_decision",
  "policy_reason",
  "target",
  "result",
  "verified",
  "error",
  "detail",
  "action_id",
] as const);

/**
 * Única fábrica de `AuditEntry`. Preenche todo campo ausente com `null` (ou o
 * default do campo) e IGNORA `undefined` vindo do chamador: escrever
 * `{ page: undefined }` produziria uma linha sem a chave `page`, porque
 * `JSON.stringify` elimina `undefined` — o buraco silencioso que esta função
 * existe para fechar.
 */
export function makeAuditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  const base: AuditEntry = {
    timestamp: nowIso(),
    event: "action",
    session: null,
    browser: null,
    page: null,
    task: null,
    owner: null,
    actor: "runtime",
    provider: null,
    action: "unknown",
    capability: null,
    policy_decision: "not_applicable",
    policy_reason: null,
    target: null,
    result: "ok",
    verified: null,
    error: null,
    detail: {},
    action_id: null,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
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
