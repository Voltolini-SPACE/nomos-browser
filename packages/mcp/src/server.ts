#!/usr/bin/env node
/**
 * FASE 6 — SERVIDOR MCP `nomos-browser-mcp`
 *
 * Fala JSON-RPC 2.0 por stdin/stdout (uma mensagem JSON por linha) e traduz
 * cada `tools/call` em UM POST para a API v1 do Browser Runtime. É uma casca
 * de protocolo: não abre navegador, não resolve alvo, não decide plano.
 *
 * Por que JSON-RPC escrito à mão: o SDK oficial de MCP não está instalado e a
 * missão proíbe instalar dependência. O framing por linha é o suficiente para
 * stdio e é verificável — o teste sobe o processo de verdade e conversa com ele.
 *
 * Invariantes que este arquivo se obriga a manter:
 *   1. stdout carrega SOMENTE JSON-RPC. Diagnóstico vai para stderr.
 *   2. Nenhum corpo de requisição entra em log — `browser_type` carrega texto
 *      digitado e referência de credencial.
 *   3. `success:false` do runtime NUNCA vira sucesso MCP. Vira isError com o
 *      `error.code` do contrato preservado no texto.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { API_PREFIX, CONTRACT_VERSION, type ActionResponse, type SessionInfo } from "../../core/src/contract.ts";
import { ToolInputError, buildRuntimeCall, listToolsPayload, toolByName } from "./tools.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Identidade e protocolo
// ─────────────────────────────────────────────────────────────────────────────

export const SERVER_NAME = "nomos-browser-mcp" as const;
export const SERVER_VERSION = "0.1.0" as const;
export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:7777" as const;
export const DEFAULT_OWNER = "mcp:nomos-browser-mcp" as const;

/** Versões de protocolo MCP aceitas. A primeira é a preferida. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Códigos JSON-RPC 2.0. Erro de protocolo ≠ erro de execução da ferramenta. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP do runtime
// ─────────────────────────────────────────────────────────────────────────────

export type FetchLike = (
  input: string,
  // `body` é OPCIONAL porque GET não leva corpo — `fetch` recusa a requisição
  // inteira quando um GET traz `body`, e o erro sai como "falha ao falar com o
  // runtime", que aponta para a rede quando o defeito é aqui. Foi assim que a
  // primeira versão de `whoami` falhou.
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Falha que não é do runtime: rede caiu, resposta ilegível, timeout do cliente.
 * Fica separada de `ActionError` de propósito — inventar um `ActionErrorCode`
 * para "não consegui falar com o daemon" seria mentir sobre a origem da falha.
 */
/**
 * FASE 11 — CREDENCIAL AUSENTE NÃO É FALHA DE REDE.
 *
 * O `SECURITY.md` declarava, verbatim, que "autorização MCP ainda não está
 * implementada" e que "qualquer processo local fala com o runtime". A parte que
 * cabia a este arquivo era esta: o servidor MCP repassava o token do ambiente
 * QUANDO ele existia, e seguia adiante quando não existia — deixando a recusa
 * para o runtime, que naquele momento também não recusava.
 *
 * Agora é fechado aqui também, e com erro PRÓPRIO: um agente que recebe
 * "falha ao falar com o runtime" quando o problema é credencial vai depurar a
 * rede pelo resto da tarde.
 */
export class RuntimeAuthError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "RuntimeAuthError";
    this.detail = detail;
  }
}

export class RuntimeTransportError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = "RuntimeTransportError";
    this.detail = detail;
  }
}

export interface RuntimeClientOptions {
  runtimeUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /**
   * Credencial do control plane. Ausente aqui, cai em `NOMOS_BROWSER_TOKEN`.
   * Ausente nos dois, NENHUMA chamada sai — ver `RuntimeAuthError`.
   */
  token?: string | null;
}

export class RuntimeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** `true` quando há credencial. O SEGREDO em si não é exposto por getter. */
  readonly authenticated: boolean;
  readonly #fetch: FetchLike;
  readonly #token: string | null;

  constructor(opts: RuntimeClientOptions = {}) {
    const raw = opts.runtimeUrl ?? process.env.NOMOS_BROWSER_URL ?? DEFAULT_RUNTIME_URL;
    // URL inválida derruba no arranque. Cair para o default silenciosamente
    // faria o agente conversar com o daemon errado sem nunca saber.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`NOMOS_BROWSER_URL inválida: ${JSON.stringify(raw)}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`NOMOS_BROWSER_URL deve ser http(s): recebi ${parsed.protocol}`);
    }
    this.baseUrl = raw.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? readIntEnv("NOMOS_BROWSER_TIMEOUT_MS", 120_000);
    this.#fetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    // `undefined` e `null` são coisas diferentes aqui, como em `agent` no
    // daemon: ausente ⇒ herde do ambiente; `null` ⇒ NENHUMA credencial, mesmo
    // que o ambiente tenha uma. Sem essa distinção não haveria como um teste
    // provar a recusa numa máquina cujo operador exporta NOMOS_BROWSER_TOKEN.
    const cru = opts.token !== undefined ? opts.token : (process.env.NOMOS_BROWSER_TOKEN ?? null);
    this.#token = cru !== null && cru.trim() !== "" ? cru.trim() : null;
    this.authenticated = this.#token !== null;
  }

  /**
   * Recusa ANTES de abrir socket. Não é otimização: mandar a chamada sem
   * credencial e deixar o runtime devolver 401 significaria que o servidor MCP
   * considera aceitável tentar — e num dia em que alguém suba o daemon com
   * `NOMOS_BROWSER_AUTH=off` para depurar, "tentar" vira "conseguir".
   */
  #exigirCredencial(path: string): void {
    if (this.#token === null) {
      throw new RuntimeAuthError(
        "nomos-browser-mcp exige NOMOS_BROWSER_TOKEN: o runtime não conversa com processo não identificado. " +
          "O token do daemon fica em ~/.nomos-browser/control-token (0600).",
        { path, runtime_url: this.baseUrl, env: "NOMOS_BROWSER_TOKEN" },
      );
    }
  }

  /**
   * Credencial do control plane (FASE 15/17).
   *
   * O servidor MCP não guarda token próprio: ele repassa o do ambiente. Quem
   * decide o que esse token pode fazer é o runtime, pelos escopos — é ali que a
   * autorização pertence, não numa casca de tradução de protocolo.
   */
  #authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.#token !== null) h["authorization"] = `Bearer ${this.#token}`;
    return h;
  }

  /** GET JSON. Usado por `whoami`; mesma exigência de credencial do POST. */
  async get(path: string): Promise<{ status: number; json: unknown }> {
    this.#exigirCredencial(path);
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await this.#fetch(url, {
        method: "GET",
        headers: this.#authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
    } catch (err) {
      throw new RuntimeTransportError(`falha ao falar com o Browser Runtime em ${this.baseUrl}${path}`, {
        path,
        runtime_url: this.baseUrl,
        cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  /** POST JSON. Devolve status + corpo já parseado; não interpreta o envelope. */
  async post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    this.#exigirCredencial(path);
    const url = `${this.baseUrl}${path}`;
    let status: number;
    let text: string;
    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: this.#authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new RuntimeTransportError(`falha ao falar com o Browser Runtime em ${this.baseUrl}${path}`, {
        path,
        runtime_url: this.baseUrl,
        cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RuntimeTransportError(`resposta do runtime não é JSON (HTTP ${status}) em ${path}`, {
        path,
        http_status: status,
        // Trecho curto só para diagnóstico de rota errada / proxy no caminho.
        body_preview: text.slice(0, 200),
      });
    }
    return { status, json };
  }
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} inválido: ${JSON.stringify(raw)}`);
  return n;
}

function readBoolEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} inválido: ${JSON.stringify(raw)} (use 1/0 ou true/false)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessão
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionOptions {
  owner?: string;
  profile?: string;
  headless?: boolean;
}

/**
 * Uma sessão por processo MCP, criada sob demanda e reutilizada. O cliente pode
 * fixar outra passando `session_id` na chamada.
 *
 * O corpo de criação NÃO pede capabilities: omitir faz o runtime aplicar o
 * default restrito (download/upload/send/purchase/payment/delete negados). Pedir
 * capability aqui seria o servidor MCP se autoconceder poder — concessão é ato
 * do dono, não do adaptador de protocolo.
 *
 * FASE 7 — LEASE. A criação vai pela MESMA rota da API v1 que todo mundo usa
 * (`POST /api/v1/sessions`), e é o runtime que, no mesmo ato, concede o lease
 * EXCLUSIVO ao principal do token (`sessions.create` em `api/src/daemon.ts`).
 * Isto NÃO é um atalho do adaptador: sob `allow_unleased:false` — o default do
 * produto — uma sessão criada por qualquer outro caminho nasceria sem dono e
 * toda ação seguinte bateria em `CONTROL_NOT_OWNED`. O adaptador não pede lease,
 * não renova lease e não rouba lease de ninguém; ele herda o que o runtime deu a
 * quem apresentou a credencial, e o `session_id` resultante volta no cabeçalho
 * de toda resposta (ver `envelopeToResult`) para que o chamador possa continuar.
 */
export class SessionResolver {
  #id: string | null = null;
  #pending: Promise<string> | null = null;
  readonly #client: RuntimeClient;
  readonly #opts: SessionOptions;

  constructor(client: RuntimeClient, opts: SessionOptions = {}) {
    this.#client = client;
    this.#opts = opts;
  }

  get current(): string | null {
    return this.#id;
  }

  async resolve(explicit?: string): Promise<string> {
    if (explicit !== undefined && explicit !== "") return explicit;
    if (this.#id !== null) return this.#id;
    if (this.#pending === null) {
      // Duas chamadas concorrentes sem session_id não podem criar duas sessões:
      // a segunda espera a promessa da primeira.
      this.#pending = this.#create();
      this.#pending.finally(() => {
        this.#pending = null;
      });
    }
    return this.#pending;
  }

  async #create(): Promise<string> {
    const body: Record<string, unknown> = { owner: this.#opts.owner ?? process.env.NOMOS_BROWSER_OWNER ?? DEFAULT_OWNER };
    const profile = this.#opts.profile ?? process.env.NOMOS_BROWSER_PROFILE;
    if (profile !== undefined && profile !== "") body.profile = profile;
    const headless = this.#opts.headless ?? readBoolEnv("NOMOS_BROWSER_HEADLESS");
    if (headless !== undefined) body.headless = headless;

    // Rota de gestão: responde SessionInfo direto, não ActionResponse (API.md §3).
    const { status, json } = await this.#client.post(`${API_PREFIX}/sessions`, body);
    if (status < 200 || status >= 300) {
      throw new RuntimeTransportError(`runtime recusou criar sessão (HTTP ${status})`, {
        http_status: status,
        response: json,
      });
    }
    const info = json as Partial<SessionInfo>;
    if (typeof info?.session_id !== "string" || info.session_id === "") {
      throw new RuntimeTransportError("runtime respondeu criação de sessão sem session_id", { response: json });
    }
    this.#id = info.session_id;
    return info.session_id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado de ferramenta MCP
// ─────────────────────────────────────────────────────────────────────────────

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError: boolean): McpToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * Envelope do contrato → resultado MCP. Único lugar onde success vira isError.
 *
 * FASE 7 — `session_id` VOLTA NO CABEÇALHO.
 *
 * O bootstrap de sessão (ver `SessionResolver`) existe para que um chamador
 * NOMOS não precise entender sessões: ele chama `browser_extract` e funciona.
 * O efeito colateral era que ele TAMBÉM não tinha como continuar de propósito —
 * `nomos mcp chamar` é one-shot (sobe o server, executa, encerra), então a
 * sessão implícita morre com o processo e a chamada seguinte abria outra aba em
 * branco. Devolver o `session_id` na resposta é o que torna a continuidade
 * possível sem obrigar ninguém a criá-la: quem quiser continuar repassa o mesmo
 * `session_id` na chamada seguinte; quem não quiser, ignora a linha.
 */
function envelopeToResult(route: string, sessionId: string, httpStatus: number, envelope: ActionResponse): McpToolResult {
  const head = `route=${route} session_id=${sessionId} http=${httpStatus} action_id=${envelope.action_id} state=${envelope.state} duration_ms=${envelope.timing?.duration_ms ?? "?"}`;
  if (envelope.success === true) {
    return textResult(`${head}\n${JSON.stringify(envelope.result, null, 2)}`, false);
  }
  const err = envelope.error;
  const code = err?.code ?? "INTERNAL";
  const detail = err?.detail === undefined ? "" : `\ndetail: ${JSON.stringify(err.detail, null, 2)}`;
  // FASE 11 — a recusa POR ESCOPO ganha nome próprio.
  //
  // `CAPABILITY_DENIED` cobre coisas diferentes demais: capability de sessão,
  // arbitragem de lease e escopo de token saem todas com o mesmo código. Para
  // quem opera, "seu token não tem o escopo INPUT" e "outra IA está com o
  // volante" pedem ações opostas, e um agente que lê só o código não tem como
  // distinguir. O código do contrato é preservado no texto; o rótulo MCP é que
  // fica específico.
  const d = (err?.detail ?? {}) as Record<string, unknown>;
  const escopoExigido = typeof d.required_scope === "string" ? d.required_scope : null;
  const rotulo =
    escopoExigido !== null && d.auth === "SCOPE_DENIED"
      ? `MCP_SCOPE_DENIED contract_code=${code} required_scope=${escopoExigido}`
      : d.lease === "CONTROL_NOT_OWNED"
        ? `MCP_CONTROL_NOT_OWNED contract_code=${code}`
        : code;
  return textResult(
    `NOMOS_BROWSER_ERROR code=${rotulo}\n${head}\nmessage: ${err?.message ?? "(runtime não informou mensagem)"}${detail}`,
    true,
  );
}

function looksLikeEnvelope(v: unknown): v is ActionResponse {
  return typeof v === "object" && v !== null && "success" in v && "action_id" in v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Servidor MCP
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerOptions extends RuntimeClientOptions, SessionOptions {
  client?: RuntimeClient;
  debug?: boolean;
}

export interface McpServer {
  readonly client: RuntimeClient;
  readonly sessions: SessionResolver;
  /** Trata UMA mensagem JSON-RPC já parseada. `null` = notificação, sem resposta. */
  handleMessage(msg: unknown): Promise<JsonRpcResponse | null>;
  /** Executa uma ferramenta. Exposto para teste sem passar pelo framing. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Identidade e escopos desta credencial, perguntados ao runtime. */
  whoami(): Promise<Record<string, unknown> | null>;
}

export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const client = opts.client ?? new RuntimeClient(opts);
  const sessions = new SessionResolver(client, opts);
  const debug = opts.debug ?? process.env.NOMOS_BROWSER_MCP_DEBUG === "1";

  /** Diagnóstico em stderr. Só nome de método/ferramenta — argumento nunca. */
  function trace(line: string): void {
    if (debug) process.stderr.write(`[${SERVER_NAME}] ${line}\n`);
  }

  /**
   * FASE 11 — QUEM É ESTA CREDENCIAL.
   *
   * SOB DEMANDA, nunca no caminho de toda chamada. A tentação era perguntar uma
   * vez no arranque e pré-checar escopo localmente; a medição mostrou o custo:
   * uma requisição a mais em TODA sessão MCP, e o servidor MCP se colocando como
   * autoridade de autorização que ele não é. A autoridade é o runtime. O que
   * este servidor faz é (1) EXIGIR credencial antes de qualquer socket abrir e
   * (2) PROPAGÁ-LA em todo POST, para que os escopos do runtime valham; quando
   * ele recusa por escopo, a recusa é traduzida em erro MCP legível — ver
   * `envelopeToResult`.
   */
  async function whoami(): Promise<Record<string, unknown> | null> {
    const { status, json } = await client.get(`${API_PREFIX}/whoami`);
    if (status !== 200 || typeof json !== "object" || json === null) return null;
    return json as Record<string, unknown>;
  }

  /**
   * Executa uma ferramenta e SEMPRE devolve um `McpToolResult`.
   *
   * Fronteira deliberada: só `ToolInputError` escapa por exceção, porque
   * argumento malformado é erro de protocolo do cliente e vira código JSON-RPC.
   * Todo o resto — daemon fora do ar, resposta ilegível, resposta fora do
   * contrato — vira `isError:true` aqui dentro. Se a conversão morasse só no
   * despachante de `tools/call`, este método público falharia de um jeito e o
   * caminho MCP de outro, e um chamador direto (CLI, teste) veria semântica
   * diferente da que o agente vê.
   */
  async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // `session_id` é resolvido aqui e injetado no corpo; não é repassado como
    // argumento de ferramenta para não duplicar campo no POST.
    const { session_id: pinned, ...rest } = args;
    // Validar ANTES de resolver sessão: chamada malformada não deve ter o efeito
    // colateral de abrir um navegador no runtime.
    const rpcSemSessao = buildRuntimeCall(name, rest, "");

    // ── credencial ──────────────────────────────────────────────────────────
    if (!client.authenticated) {
      return textResult(
        `NOMOS_BROWSER_ERROR code=MCP_NO_CREDENTIAL\nroute=${rpcSemSessao.route}\n` +
          "message: nomos-browser-mcp exige NOMOS_BROWSER_TOKEN. O runtime não conversa com processo não identificado.\n" +
          "detail: exporte NOMOS_BROWSER_TOKEN com o conteúdo de ~/.nomos-browser/control-token (arquivo 0600 gravado pelo daemon no arranque).",
        true,
      );
    }

    try {
      const sessionId = await sessions.resolve(typeof pinned === "string" ? pinned : undefined);
      const rpc = { ...rpcSemSessao, body: { ...rpcSemSessao.body, session_id: sessionId } };
      trace(`call tool=${name} route=${rpc.route} session=${sessionId}`);

      const { status, json } = await client.post(rpc.path, rpc.body);
      if (!looksLikeEnvelope(json)) {
        throw new RuntimeTransportError(`runtime respondeu ${rpc.path} fora do envelope ActionResponse (HTTP ${status})`, {
          route: rpc.route,
          http_status: status,
          contract: CONTRACT_VERSION,
        });
      }
      return envelopeToResult(rpc.route, sessionId, status, json);
    } catch (err) {
      if (err instanceof RuntimeAuthError) {
        return textResult(
          `NOMOS_BROWSER_ERROR code=MCP_NO_CREDENTIAL\nroute=${rpcSemSessao.route}\nmessage: ${err.message}\ndetail: ${JSON.stringify(err.detail, null, 2)}`,
          true,
        );
      }
      if (err instanceof RuntimeTransportError) {
        return textResult(
          `NOMOS_BROWSER_ERROR code=MCP_TRANSPORT_ERROR\nroute=${rpcSemSessao.route}\nmessage: ${err.message}\ndetail: ${JSON.stringify(err.detail, null, 2)}`,
          true,
        );
      }
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return textResult(`NOMOS_BROWSER_ERROR code=MCP_INTERNAL\nroute=${rpcSemSessao.route}\nmessage: ${msg}`, true);
    }
  }

  async function handleToolsCall(params: unknown): Promise<{ result?: unknown; error?: JsonRpcResponse["error"] }> {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return { error: { code: RPC_INVALID_PARAMS, message: 'tools/call exige params objeto com "name"' } };
    }
    const p = params as Record<string, unknown>;
    const name = p.name;
    if (typeof name !== "string" || name === "") {
      return { error: { code: RPC_INVALID_PARAMS, message: 'tools/call exige "name" string' } };
    }
    if (toolByName(name) === undefined) {
      return { error: { code: RPC_INVALID_PARAMS, message: `ferramenta desconhecida: ${name}` } };
    }
    const rawArgs = p.arguments ?? {};
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return { error: { code: RPC_INVALID_PARAMS, message: `${name}: "arguments" deve ser objeto` } };
    }

    try {
      return { result: await callTool(name, rawArgs as Record<string, unknown>) };
    } catch (err) {
      // Único erro que `callTool` deixa escapar: argumento inválido, que é falha
      // de PROTOCOLO (o cliente montou a chamada errada), não de execução.
      if (err instanceof ToolInputError) {
        return { error: { code: RPC_INVALID_PARAMS, message: err.message, data: { code: err.code } } };
      }
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { error: { code: RPC_INTERNAL_ERROR, message: msg } };
    }
  }

  async function handleMessage(msg: unknown): Promise<JsonRpcResponse | null> {
    if (Array.isArray(msg)) {
      // MCP não usa batch. Recusar é mais honesto que processar metade.
      return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "batch JSON-RPC não é suportado" } };
    }
    if (typeof msg !== "object" || msg === null) {
      return { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_REQUEST, message: "mensagem JSON-RPC deve ser objeto" } };
    }
    const m = msg as Record<string, unknown>;
    const id = (m.id ?? undefined) as string | number | undefined;
    const isNotification = m.id === undefined;
    const method = m.method;

    if (typeof method !== "string") {
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: id ?? null, error: { code: RPC_INVALID_REQUEST, message: '"method" ausente ou não-string' } };
    }
    trace(`recv method=${method}${isNotification ? " (notificação)" : ""}`);

    // Notificações não recebem resposta, por definição do JSON-RPC.
    if (isNotification) return null;
    const rid = id ?? null;

    try {
      switch (method) {
        case "initialize": {
          const requested =
            typeof m.params === "object" && m.params !== null
              ? (m.params as Record<string, unknown>).protocolVersion
              : undefined;
          const protocolVersion =
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: "2.0",
            id: rid,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
              instructions:
                `Adaptador MCP do NOMOS Browser Runtime (contrato v${CONTRACT_VERSION}, runtime em ${client.baseUrl}). ` +
                "Toda ferramenta é uma chamada HTTP à API v1; nenhuma automação acontece neste processo. " +
                "Capabilities sensíveis (download, upload) nascem negadas no runtime: a ferramenta responde " +
                "CAPABILITY_DENIED até o dono conceder.",
            },
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id: rid, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id: rid, result: { tools: listToolsPayload() } };
        case "tools/call": {
          const out = await handleToolsCall(m.params);
          if (out.error !== undefined) return { jsonrpc: "2.0", id: rid, error: out.error };
          return { jsonrpc: "2.0", id: rid, result: out.result };
        }
        default:
          return { jsonrpc: "2.0", id: rid, error: { code: RPC_METHOD_NOT_FOUND, message: `método não suportado: ${method}` } };
      }
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { jsonrpc: "2.0", id: rid, error: { code: RPC_INTERNAL_ERROR, message: msg } };
    }
  }

  return { client, sessions, handleMessage, callTool, whoami };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transporte stdio — uma mensagem JSON por linha
// ─────────────────────────────────────────────────────────────────────────────

export interface StdioHandle {
  /** Resolve quando stdin fecha e toda resposta pendente foi escrita. */
  done: Promise<void>;
}

export function startStdio(
  server: McpServer,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): StdioHandle {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  function write(res: JsonRpcResponse): void {
    // JSON.stringify nunca emite \n cru, então uma linha == uma mensagem.
    output.write(`${JSON.stringify(res)}\n`);
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: RPC_PARSE_ERROR, message: "JSON inválido na linha recebida" } });
      return;
    }
    const p = server
      .handleMessage(parsed)
      .then((res) => {
        if (res !== null) write(res);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        write({ jsonrpc: "2.0", id: null, error: { code: RPC_INTERNAL_ERROR, message: msg } });
      })
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
  });

  const done = new Promise<void>((resolve) => {
    rl.on("close", () => {
      // Não fechar antes de drenar: matar o processo com resposta pendente faria
      // o cliente ver timeout no lugar do erro real.
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });

  return { done };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrada como binário
// ─────────────────────────────────────────────────────────────────────────────

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const server = createMcpServer();
    // Sem `process.exit(0)` no fim: `startStdio` já drena as respostas pendentes,
    // e sair à força truncaria escrita ainda no buffer do pipe — o cliente que
    // fecha stdin logo após pedir veria resposta cortada em vez da resposta.
    // Com stdin fechado e nada pendente, o event loop esvazia e o código é 0.
    startStdio(server);
  } catch (err) {
    // Configuração inválida derruba aqui, com mensagem em stderr — jamais um
    // servidor "de pé" apontando para lugar nenhum.
    process.stderr.write(`[${SERVER_NAME}] arranque falhou: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
