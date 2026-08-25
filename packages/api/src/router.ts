/**
 * FASE 4 — ROTEAMENTO DA API v1
 *
 * Tabela de rotas derivada de `docs/API.md`, sem framework. Puro: casar método +
 * caminho não toca em rede, sessão nem navegador, então é testável isoladamente.
 *
 * Duas decisões que valem explicação:
 *
 *  1. A lista de ferramentas de ação NÃO é redigitada aqui — vem de `ACTION_CLASS`
 *     do contrato. Uma segunda lista divergiria no dia em que o contrato ganhasse
 *     um verbo, e a API passaria a ter uma rota fantasma (ou a faltar uma).
 *
 *  2. `matchRoute` distingue "caminho desconhecido" de "método errado no caminho
 *     certo". Devolver 404 para um POST num caminho que só aceita GET esconderia
 *     do cliente que a rota existe.
 */
import { ACTION_CLASS, API_PREFIX, type ActionErrorCode, type EventName } from "../../core/src/contract.ts";

export type RouteName =
  | "health"
  | "sessions.list"
  | "sessions.create"
  | "sessions.get"
  | "sessions.delete"
  | "sessions.attach"
  | "sessions.detach"
  | "sessions.handoff"
  | "sessions.takeover"
  | "sessions.release"
  | "tasks.list"
  | "tasks.get"
  | "tasks.cancel"
  | "tasks.resume"
  // FASE 10 — ciclo de vida do lease. Sem estas rotas, `allow_unleased: false`
  // seria uma porta trancada sem chave: o segundo agente não teria como pedir
  // controle, e "fail closed" viraria "fail sempre".
  | "lease.get"
  | "lease.acquire"
  | "lease.release"
  | "lease.renew"
  | "lease.transfer"
  | "lease.takeover"
  | "replay.verify"
  // FASE 17 — configuração como CONTRATO consultável. `config.schema` devolve a
  // FORMA (chaves, tipos, faixas, envs) sem valor nenhum; `config.get` devolve
  // os valores efetivos com os sensíveis redigidos. São rotas separadas porque
  // são perguntas diferentes com riscos diferentes: "o que existe?" pode ser
  // respondida a qualquer portador; "o que está valendo aqui?" não.
  | "config.schema"
  | "config.get"
  // FASE 20b — PROFUNDIDADE DA FILA POR SESSAO. Rota SEPARADA de `/health` de
  // proposito: `/health` responde a um token OBSERVE qualquer (inclusive um
  // limitado a uma unica sessao), e a fila por sessao e mapa de ATIVIDADE alheia.
  // Ver o comentario de `queues.get` em `ROUTE_SCOPE` e em `HealthResponse`.
  | "queues.get"
  | "whoami"
  | "action"
  | "events";

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
  /** Preenchido só em `action`: o verbo `browser.<x>` pedido. */
  tool: string | null;
  /** Rotas de gestão respondem o objeto direto; ações respondem o envelope. */
  envelope: boolean;
}

export type RouteLookup =
  | { kind: "match"; route: RouteMatch }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" };

/** Ferramentas de ação conhecidas — projeção do contrato, não cópia. */
export const ACTION_TOOLS: ReadonlySet<string> = new Set(Object.keys(ACTION_CLASS));

interface RouteSpec {
  method: string;
  /** Segmentos; `:nome` captura. */
  segments: string[];
  name: RouteName;
  envelope: boolean;
}

function spec(method: string, pattern: string, name: RouteName, envelope: boolean): RouteSpec {
  return { method, segments: pattern.split("/").filter((s) => s !== ""), name, envelope };
}

const P = API_PREFIX;

export const ROUTES: readonly RouteSpec[] = Object.freeze([
  spec("GET", "/health", "health", false),
  spec("GET", `${P}/sessions`, "sessions.list", false),
  spec("POST", `${P}/sessions`, "sessions.create", false),
  spec("GET", `${P}/sessions/:id`, "sessions.get", false),
  spec("DELETE", `${P}/sessions/:id`, "sessions.delete", false),
  spec("POST", `${P}/sessions/:id/attach`, "sessions.attach", false),
  spec("POST", `${P}/sessions/:id/detach`, "sessions.detach", false),
  spec("POST", `${P}/sessions/:id/handoff`, "sessions.handoff", false),
  spec("POST", `${P}/sessions/:id/takeover`, "sessions.takeover", false),
  spec("POST", `${P}/sessions/:id/release`, "sessions.release", false),
  // FASE 9 — gestão de task. `envelope:false` porque são rotas de GESTÃO, e
  // `docs/API.md` reserva o envelope `ActionResponse` para AÇÕES. Uma listagem
  // de tasks não tem `session state` nem `timing` de ação; embrulhá-la seria
  // inventar campos para satisfazer uma forma que não é a dela.
  spec("GET", `${P}/tasks`, "tasks.list", false),
  spec("GET", `${P}/tasks/:task_id`, "tasks.get", false),
  spec("POST", `${P}/tasks/:task_id/cancel`, "tasks.cancel", false),
  spec("POST", `${P}/tasks/:task_id/resume`, "tasks.resume", false),
  // FASE 10 — lease. `GET` consulta, `POST` adquire (reentrante para quem já
  // detém), `DELETE` solta. `renew`/`transfer`/`takeover` são sub-rotas porque
  // são ATOS distintos sobre o mesmo recurso, e colapsá-los num único POST com
  // um campo `op` esconderia no corpo a diferença entre renovar e tomar.
  spec("GET", `${P}/sessions/:id/lease`, "lease.get", false),
  spec("POST", `${P}/sessions/:id/lease`, "lease.acquire", false),
  spec("DELETE", `${P}/sessions/:id/lease`, "lease.release", false),
  spec("POST", `${P}/sessions/:id/lease/renew`, "lease.renew", false),
  spec("POST", `${P}/sessions/:id/lease/transfer`, "lease.transfer", false),
  spec("POST", `${P}/sessions/:id/lease/takeover`, "lease.takeover", false),
  // FASE 12 — verificação de integridade do replay pela API. A CLI é o caminho
  // do operador; esta rota é o caminho de quem já fala HTTP com o runtime.
  spec("GET", `${P}/sessions/:id/replay/verify`, "replay.verify", false),
  // FASE 11 — "que credencial é esta?". Existe para que um cliente (o servidor
  // MCP, sobretudo) saiba ANTES de agir quais escopos ele carrega, e recuse a
  // chamada com uma mensagem útil em vez de arrancar um 403 do runtime depois
  // de já ter aberto sessão. Nunca devolve o segredo — só o que ele PODE.
  spec("GET", `${P}/config/schema`, "config.schema", false),
  spec("GET", `${P}/config`, "config.get", false),
  spec("GET", `${P}/queues`, "queues.get", false),
  spec("GET", `${P}/whoami`, "whoami", false),
  spec("GET", "/events", "events", false),
]);

export const EVENTS_PATH = "/events";

/** Divide o caminho em segmentos decodificados. `%2F` NÃO vira separador. */
export function segmentsOf(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // Percent-encoding quebrado: mantém cru em vez de "consertar" e casar
        // uma rota que o cliente não pediu.
        return s;
      }
    });
}

function matchSpec(s: RouteSpec, segs: string[]): Record<string, string> | null {
  if (s.segments.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i += 1) {
    const pat = s.segments[i]!;
    if (pat.startsWith(":")) {
      if (segs[i] === "") return null;
      params[pat.slice(1)] = segs[i]!;
    } else if (pat !== segs[i]) {
      return null;
    }
  }
  return params;
}

export function matchRoute(method: string, pathname: string): RouteLookup {
  const verb = method.toUpperCase();
  const segs = segmentsOf(pathname);

  // Ações: POST /api/v1/browser.<verbo>
  const prefixSegs = P.split("/").filter((s) => s !== "");
  if (segs.length === prefixSegs.length + 1 && prefixSegs.every((s, i) => s === segs[i])) {
    const tool = segs[segs.length - 1]!;
    if (ACTION_TOOLS.has(tool)) {
      if (verb !== "POST") return { kind: "method_not_allowed", allow: ["POST"] };
      return { kind: "match", route: { name: "action", params: {}, tool, envelope: true } };
    }
  }

  const allow = new Set<string>();
  for (const s of ROUTES) {
    const params = matchSpec(s, segs);
    if (params === null) continue;
    if (s.method === verb) {
      return { kind: "match", route: { name: s.name, params, tool: null, envelope: s.envelope } };
    }
    allow.add(s.method);
  }
  if (allow.size > 0) return { kind: "method_not_allowed", allow: [...allow].sort() };
  return { kind: "not_found" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de erro → status HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O código de negócio vive em `error.code`; o status é a tradução para a camada
 * de transporte. Duas linhas são normativas em `docs/API.md`: capability negada é
 * 403 e controle humano é 409.
 */
export const HTTP_STATUS: Readonly<Record<ActionErrorCode, number>> = Object.freeze({
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  CONTROL_HELD_BY_HUMAN: 409,
  CAPABILITY_DENIED: 403,
  TARGET_NOT_FOUND: 404,
  TARGET_AMBIGUOUS: 409,
  // 409 Conflict: o alvo EXISTE (404 seria mentira) mas o estado atual da
  // página conflita com o gesto pedido — coberto, fora de vista, em movimento.
  // É a mesma família de TARGET_AMBIGUOUS: recurso encontrado, pedido
  // irrealizável como está. Um retry depois de mudar a página pode funcionar.
  TARGET_NOT_ACTIONABLE: 409,
  // 500: o runtime fez tudo que lhe cabia — resolveu, rolou, conferiu que o
  // ponto estava livre — despachou o clique e o evento não chegou. Isso é falha
  // do LADO DO SERVIDOR (do runtime ou do navegador), não pedido malformado do
  // cliente, e nenhum 4xx descreveria isso honestamente.
  CLICK_NOT_DELIVERED: 500,
  VERIFICATION_FAILED: 422,
  NAVIGATION_FAILED: 502,
  TIMEOUT: 504,
  BACKPRESSURE_REJECTED: 429,
  POLICY_BLOCKED: 403,
  // 403: um humano negou. Nao e' 401 (a credencial estava boa) nem 409 (nao ha
  // conflito de estado): o pedido foi entendido, avaliado e recusado.
  APPROVAL_DENIED: 403,
  // 408 Request Timeout: o servidor esperou o cliente/humano e desistiu. 504
  // seria culpar um upstream que nao existe — quem nao respondeu foi a pessoa.
  APPROVAL_TIMEOUT: 408,
  BROWSER_UNAVAILABLE: 503,
  UPLOAD_DENIED: 403,
  DOWNLOAD_DENIED: 403,
  INVALID_REQUEST: 400,
  INTERNAL: 500,
});

export function httpStatusFor(code: ActionErrorCode): number {
  return Object.hasOwn(HTTP_STATUS, code) ? HTTP_STATUS[code] : 500;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtro do WebSocket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nomes de evento aceitos em `?events=`. É a projeção em tempo de execução de um
 * union que só existe em tempo de compilação — `_eventCoverage` abaixo faz o
 * compilador reprovar a lista se o contrato ganhar um evento e esta esquecer.
 */
const KNOWN_EVENTS_TUPLA = [
  "runtime.started",
  "browser.started",
  "browser.closed",
  "session.created",
  "session.resumed",
  "session.closed",
  "session.handoff",
  "page.opened",
  "page.loaded",
  "page.closed",
  "element.found",
  "mouse.moved",
  "mouse.clicked",
  "mouse.dragged",
  "mouse.scrolled",
  "keyboard.typed",
  "keyboard.pressed",
  "download.started",
  "download.completed",
  "upload.started",
  "upload.completed",
  "network.request",
  "network.response",
  "network.failed",
  "task.started",
  "task.progress",
  "task.paused",
  "task.completed",
  "task.failed",
  "action.started",
  "action.completed",
  "action.failed",
  "action.retried",
  "target.healed",
  "secret.used",
  "control.taken",
  "control.returned",
  "session.rejected",
  "autonomy.changed",
  "action.proposed",
  "action.approved",
  "action.denied",
  "cancel.requested",
  "cancel.accepted",
  "cancel.too_late",
  "owner.changed",
  "agent.paused",
  "agent.resumed",
  "emergency_stop",
  "session.completed",
] as const;

export const KNOWN_EVENTS: readonly EventName[] = Object.freeze(KNOWN_EVENTS_TUPLA);

// DEFEITO MEDIDO (FASE 20b): este guarda era VÁCUO. `KNOWN_EVENTS` era declarado
// como `const KNOWN_EVENTS: readonly EventName[] = Object.freeze([...] as const)`
// — a anotação ALARGA o tipo, `(typeof KNOWN_EVENTS)[number]` virava `EventName`
// e `Exclude<EventName, EventName>` dá `never` para QUALQUER lista, inclusive
// uma vazia. O compilador aprovava a lista sem olhar para ela; a linha
// "só existe para o typecheck falhar" nunca falharia. Provado removendo
// "control.returned" da lista: com a anotação, `tsc --noEmit` passava.
//
// Com a TUPLA preservada (`KNOWN_EVENTS_TUPLA`, sem anotação alargadora) o
// compilador reprova nas duas direções: evento do contrato que ficou de fora, e
// nome na lista que o contrato não tem.
type MissingEvents = Exclude<EventName, (typeof KNOWN_EVENTS_TUPLA)[number]>;
type ExtraEvents = Exclude<(typeof KNOWN_EVENTS_TUPLA)[number], EventName>;
type EventCoverage = [MissingEvents] extends [never]
  ? [ExtraEvents] extends [never]
    ? true
    : ["KNOWN_EVENTS declara evento inexistente em EventName", ExtraEvents]
  : ["EventName sem cobertura em KNOWN_EVENTS", MissingEvents];
/** Só existe para o typecheck falhar quando KNOWN_EVENTS ficar para trás. */
const _eventCoverage: EventCoverage = true;
void _eventCoverage;

const EVENT_SET: ReadonlySet<string> = new Set(KNOWN_EVENTS);

export interface EventFilterParse {
  session_id: string | null;
  events: EventName[];
  /** Nomes recusados. Não são ignorados em silêncio: o daemon fecha o socket. */
  unknown: string[];
}

export function parseEventFilter(search: URLSearchParams): EventFilterParse {
  const sid = search.get("session_id");
  const raw = search.get("events");
  const events: EventName[] = [];
  const unknown: string[] = [];
  if (raw !== null && raw.trim() !== "") {
    for (const piece of raw.split(",")) {
      const name = piece.trim();
      if (name === "") continue;
      if (EVENT_SET.has(name)) events.push(name as EventName);
      else unknown.push(name);
    }
  }
  return { session_id: sid !== null && sid.trim() !== "" ? sid.trim() : null, events, unknown };
}
