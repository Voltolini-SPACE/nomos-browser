#!/usr/bin/env node
/**
 * FASE 9 — CLI `nomos-web`
 *
 * A CLI é CLIENTE da API v1 e nada mais. Ela não abre navegador, não importa
 * playwright, não resolve alvo, não decide política: fala HTTP com o runtime e
 * traduz o envelope de volta para o terminal. Toda a lógica de navegador vive do
 * outro lado da fronteira — duplicá-la aqui criaria uma segunda verdade.
 *
 * As duas exceções são leituras de DISCO, não de navegador:
 *   `replay`     — linha do tempo já gravada, via observability/replay.ts
 *   `screenshot --out` — o binário do PNG. O contrato devolve `screenshot_ref`,
 *                  não bytes, e docs/API.md não define rota de download. Inventar
 *                  rota é proibido; então o byte sai de onde ele realmente está.
 *
 * Código de saída — o contrato com quem chama a CLI de dentro de um script:
 *   0 sucesso
 *   1 falha de negócio (envelope `success=false`, ou artefato local ausente)
 *   2 erro de uso (comando/flag/argumento)
 *   3 runtime inalcançável (não houve conversa: conexão recusada, DNS, timeout)
 * A distinção 1 × 3 é o ponto: "o runtime disse não" é diferente de "não achei
 * o runtime". Um script que trate os dois igual vai reagir errado a queda.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  ActionResponse,
  BrowserTask,
  HealthResponse,
  PageInfo,
  RuntimeEvent,
  SessionInfo,
} from "../../core/src/contract.ts";
import { API_PREFIX } from "../../core/src/contract.ts";
import {
  loadReplay,
  screenshotPath,
  timelineOf,
  type ReplayOptions,
  type TimelineItem,
} from "../../observability/src/replay.ts";
import { verifyReplay } from "../../observability/src/replay-verify.ts";
import { readControlToken } from "../../api/src/auth.ts";

export const CLI_NAME = "nomos-web";
export const CLI_VERSION = "0.6.1";
export const DEFAULT_RUNTIME = "127.0.0.1:7777";
export const DEFAULT_TIMEOUT_MS = 30_000;

export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  UNREACHABLE: 3,
});

// ─────────────────────────────────────────────────────────────────────────────
// Erros da CLI
//
// Estes códigos são da CLI, NÃO são `ActionErrorCode`. O enum do contrato
// descreve o que o runtime respondeu; aqui descrevemos o que aconteceu deste
// lado. Misturar os dois faria a CLI parecer inventar código de contrato.
// ─────────────────────────────────────────────────────────────────────────────

export class UsageError extends Error {
  readonly code = "USAGE";
}

export class UnreachableError extends Error {
  readonly code = "RUNTIME_UNREACHABLE";
}

export class CliFailure extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída
// ─────────────────────────────────────────────────────────────────────────────

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

export const defaultIO: CliIO = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
};

export interface Outcome {
  /** O que sai em `--json`. */
  json: unknown;
  /** O que sai sem `--json`. */
  lines: string[];
  /** Preenchido ⇒ exit 1. Nunca é null "por otimismo". */
  error: { code: string; message: string; detail?: unknown } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de argumentos — próprio, sem dependência
// ─────────────────────────────────────────────────────────────────────────────

// `pixels` e `strict` entram aqui (FASE 12) porque são flags SEM valor; fora
// desta lista o parser consumiria o próximo argumento como se fosse o valor
// delas, e `replay verify --strict ses_x` perderia o session_id.
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "help", "version", "headless", "pixels", "strict"]);

const STRING_FLAGS: ReadonlySet<string> = new Set([
  "url",
  "timeout",
  "session",
  "owner",
  "profile",
  "out",
  "scope",
  "events",
  "max",
  "limit",
  "sessions-root",
]);

export interface ParsedArgs {
  command: string | null;
  args: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Parser dirigido por especificação: sabe de antemão quais flags são booleanas.
 * Sem isso, `screenshot --json SESS` engoliria `SESS` como valor de `--json`.
 * Flag desconhecida é erro de uso, não é ignorada — fail closed também aqui.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (token === "-V") {
      flags.set("version", true);
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith("--")) {
      throw new UsageError(`flag curta desconhecida: ${token}`);
    }

    let name = token.slice(2);
    let inline: string | null = null;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    let negated = false;
    if (name.startsWith("no-") && BOOLEAN_FLAGS.has(name.slice(3))) {
      negated = true;
      name = name.slice(3);
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline === null) {
        flags.set(name, !negated);
        continue;
      }
      if (inline !== "true" && inline !== "false") {
        throw new UsageError(`--${name} é booleana; aceita apenas true/false, recebeu ${JSON.stringify(inline)}`);
      }
      flags.set(name, (inline === "true") !== negated);
      continue;
    }

    if (!STRING_FLAGS.has(name)) {
      throw new UsageError(`flag desconhecida: --${name}`);
    }
    if (inline !== null) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`--${name} exige um valor`);
    }
    flags.set(name, next);
    i += 1;
  }

  return { command: positionals[0] ?? null, args: positionals.slice(1), flags };
}

function flagString(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags.get(name);
  if (value === undefined) return null;
  if (typeof value !== "string") throw new UsageError(`--${name} exige um valor`);
  return value;
}

function flagBool(parsed: ParsedArgs, name: string): boolean | null {
  const value = parsed.flags.get(name);
  if (value === undefined) return null;
  if (typeof value !== "boolean") throw new UsageError(`--${name} é booleana e não aceita valor`);
  return value;
}

function flagInt(parsed: ParsedArgs, name: string, fallback: number, min: number): number {
  const raw = flagString(parsed, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`--${name} exige inteiro >= ${min}, recebeu ${JSON.stringify(raw)}`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos
// ─────────────────────────────────────────────────────────────────────────────

interface CommandSpec {
  /** Flags aceitas ALÉM das globais. */
  flags: string[];
  minArgs: number;
  maxArgs: number;
  syntax: string;
}

const GLOBAL_FLAGS: readonly string[] = ["url", "json", "timeout", "help", "version"];

export const COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  health: { flags: [], minArgs: 0, maxArgs: 0, syntax: "health" },
  open: {
    flags: ["session", "owner", "profile", "headless"],
    minArgs: 1,
    maxArgs: 1,
    syntax: "open <url>",
  },
  sessions: { flags: [], minArgs: 0, maxArgs: 0, syntax: "sessions" },
  screenshot: {
    flags: ["out", "scope", "sessions-root"],
    minArgs: 1,
    maxArgs: 1,
    syntax: "screenshot <SESSION_ID> [--out arquivo.png]",
  },
  task: { flags: ["session"], minArgs: 1, maxArgs: 1, syntax: 'task --session <ID> "<objetivo>"' },
  events: { flags: ["session", "events", "max"], minArgs: 0, maxArgs: 0, syntax: "events [--session ID]" },
  replay: {
    flags: ["sessions-root", "limit", "pixels", "strict"],
    minArgs: 1,
    // 2 por causa de `replay verify <ID>`. O subcomando é POSICIONAL e não uma
    // flag porque verificar não é um modo de exibir a linha do tempo: é outra
    // operação, com outra saída e outro código de saída.
    maxArgs: 2,
    syntax: "replay <SESSION_ID> | replay verify <SESSION_ID>",
  },
  close: { flags: [], minArgs: 1, maxArgs: 1, syntax: "close <SESSION_ID>" },
});

export const USAGE = `${CLI_NAME} ${CLI_VERSION} — cliente do NOMOS Browser Runtime (contrato v1)

uso: ${CLI_NAME} <comando> [opções]

comandos:
  health                            estado do runtime
  open <url>                        abre a URL (cria sessão se --session não vier)
  sessions                          lista as sessões do runtime
  screenshot <SESSION_ID>           captura a tela da sessão
  task --session <ID> "<objetivo>"  entrega um objetivo ao agente
  events                            segue o WebSocket de eventos até Ctrl-C
  replay <SESSION_ID>               linha do tempo gravada da sessão
  replay verify <SESSION_ID>        verifica a INTEGRIDADE do replay gravado
  close <SESSION_ID>                fecha a sessão

opções globais:
  --url <host>        runtime alvo (default ${DEFAULT_RUNTIME})
  --json              imprime o JSON cru em vez da tabela
  --timeout <ms>      timeout de cada requisição HTTP (default ${DEFAULT_TIMEOUT_MS})
  -h, --help          esta ajuda
  -V, --version       versão da CLI

opções por comando:
  open         --session <ID>  --owner <nome>  --profile <nome>  --headless / --no-headless
  screenshot   --out <arquivo.png>  --scope <viewport|full|element|region>  --sessions-root <dir>
  task         --session <ID>  (obrigatória)
  events       --session <ID>  --events <a,b,c>  --max <N>
  replay       --sessions-root <dir>  --limit <N>
  replay verify --sessions-root <dir>  --pixels (decodifica os PNG)  --strict (aviso também reprova)

códigos de saída:
  0 sucesso   1 falha de negócio   2 erro de uso   3 runtime inalcançável

a CLI nunca concede capability sensível: sessão criada por ela nasce com a
política padrão do runtime (download/upload/send/purchase/payment/delete negados).`;

function validate(parsed: ParsedArgs, command: string, spec: CommandSpec): void {
  const allowed = new Set<string>([...GLOBAL_FLAGS, ...spec.flags]);
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`--${name} não se aplica a "${command}" — uso: ${CLI_NAME} ${spec.syntax}`);
    }
  }
  if (parsed.args.length < spec.minArgs) {
    throw new UsageError(`"${command}" exige ${spec.minArgs} argumento(s) — uso: ${CLI_NAME} ${spec.syntax}`);
  }
  if (parsed.args.length > spec.maxArgs) {
    throw new UsageError(
      `"${command}" aceita no máximo ${spec.maxArgs} argumento(s), recebeu ${parsed.args.length} — uso: ${CLI_NAME} ${spec.syntax}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza o alvo do runtime. `--url` aceita `host:porta` porque o default
 * documentado (`127.0.0.1:7777`) é sem esquema; sem esquema assumimos http.
 */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UsageError(`--url inválida: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`--url exige http ou https, recebeu ${parsed.protocol}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Origem sem userinfo/query — é isto que pode aparecer em mensagem de erro. */
function safeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "(url inválida)";
  }
}

/**
 * `fetch` embrulha o erro real: o `TypeError: fetch failed` de fora não diz nada,
 * o `ECONNREFUSED`/`ENOTFOUND` está algumas camadas abaixo em `cause` (e às vezes
 * dentro de um `AggregateError`, quando IPv4 e IPv6 falham juntos). Sem descer a
 * cadeia, toda queda vira "TypeError" e o operador não sabe se é porta fechada,
 * DNS ou timeout.
 */
function transportCode(error: unknown, depth = 0): string | null {
  if (error === null || typeof error !== "object" || depth > 6) return null;
  const node = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof node.code === "string" && node.code.length > 0) return node.code;
  if (node.name === "TimeoutError" || node.name === "AbortError") return "TIMEOUT";
  if (Array.isArray(node.errors)) {
    for (const inner of node.errors) {
      const found = transportCode(inner, depth + 1);
      if (found !== null) return found;
    }
  }
  const fromCause = transportCode(node.cause, depth + 1);
  if (fromCause !== null) return fromCause;
  // Sem código em lugar nenhum: a mensagem da causa é o que sobra de honesto.
  return depth > 0 && typeof node.message === "string" && node.message.length > 0 ? node.message : null;
}

function describeTransport(error: unknown, baseUrl: string): string {
  const code =
    transportCode(error) ??
    (error instanceof Error ? error.name : "DESCONHECIDO");
  return `sem resposta de ${safeOrigin(baseUrl)} (${code})`;
}

export interface HttpResult {
  status: number;
  text: string;
}

export class RuntimeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Credencial explícita. Sem este campo, `resolveToken(this.token)` lia `undefined`
   *  e um `--token` do operador era descartado sem aviso. */
  readonly token: string | null;

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, token: string | null = null) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.token = token;
  }

  /** Falha de transporte vira UnreachableError (exit 3); resposta HTTP nunca vira. */
  async send(method: string, pathname: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const tok = resolveToken(this.token);
    if (tok !== null) headers["authorization"] = `Bearer ${tok}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UnreachableError(describeTransport(error, this.baseUrl));
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // Conexão caiu no meio do corpo: também é "não consegui falar", não "falhou".
      throw new UnreachableError(describeTransport(error, this.baseUrl));
    }
    return { status: response.status, text };
  }
}

function parseBody(result: HttpResult, pathname: string): unknown {
  if (result.text.trim().length === 0) {
    throw new CliFailure(
      "INVALID_RESPONSE",
      `${pathname} respondeu HTTP ${result.status} com corpo vazio; esperava JSON`,
    );
  }
  try {
    return JSON.parse(result.text);
  } catch {
    const snippet = result.text.length > 120 ? `${result.text.slice(0, 120)}…` : result.text;
    throw new CliFailure(
      "INVALID_RESPONSE",
      `${pathname} respondeu HTTP ${result.status} com corpo não-JSON: ${JSON.stringify(snippet)}`,
    );
  }
}

function isEnvelope(value: unknown): value is ActionResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ActionResponse).success === "boolean" &&
    "action_id" in value &&
    "timing" in value
  );
}

/** Rota de ação: sempre `ActionResponse<T>`, inclusive em erro HTTP (regra 2). */
async function callAction<T>(
  client: RuntimeClient,
  tool: string,
  body: Record<string, unknown>,
): Promise<ActionResponse<T>> {
  const pathname = `${API_PREFIX}/${tool}`;
  const parsed = parseBody(await client.send("POST", pathname, body), pathname);
  if (!isEnvelope(parsed)) {
    throw new CliFailure("INVALID_RESPONSE", `${pathname} não respondeu um ActionResponse do contrato v1`);
  }
  return parsed as ActionResponse<T>;
}

/** Rota de gestão: objeto direto (regra 3). Erro HTTP vira falha de negócio. */
async function callManagement<T>(
  client: RuntimeClient,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const result = await client.send(method, pathname, body);
  const parsed = parseBody(result, pathname);
  if (result.status >= 400) {
    if (isEnvelope(parsed) && parsed.error !== null) {
      throw new CliFailure(parsed.error.code, parsed.error.message, parsed.error.detail);
    }
    const embedded = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof embedded?.code === "string" ? embedded.code : `HTTP_${result.status}`;
    const message =
      typeof embedded?.message === "string" ? embedded.message : `${pathname} respondeu HTTP ${result.status}`;
    throw new CliFailure(code, message, parsed);
  }
  return parsed as T;
}

function envelopeError(envelope: ActionResponse): Outcome["error"] {
  if (envelope.success) return null;
  // Envelope sem `error` violando o contrato: reportar isso é melhor do que
  // imprimir "falhou" sem dizer por quê.
  if (envelope.error === null) {
    return { code: "INVALID_RESPONSE", message: "envelope veio success=false sem campo error" };
  }
  return { code: envelope.error.code, message: envelope.error.message, detail: envelope.error.detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatação de tabela
// ─────────────────────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}


/**
 * Credencial do control plane (FASE 15).
 *
 * Ordem: opção explícita → NOMOS_BROWSER_TOKEN → arquivo do daemon (0600).
 * Ausência NÃO é erro aqui: quem responde 401 é o runtime, e a decisão pertence
 * a ele. Um cliente que se recusasse a arrancar sem token quebraria o modo de
 * migração `auth_disabled`.
 *
 * Um arquivo de token com permissão larga faz `readControlToken` lançar; aqui
 * isso vira "sem token" em vez de crash — o 401 subsequente é mensagem melhor
 * para o operador do que um stack trace.
 */
export function resolveToken(explicito?: string | null): string | null {
  if (explicito !== undefined && explicito !== null && explicito !== "") return explicito;
  const env = process.env.NOMOS_BROWSER_TOKEN;
  if (env !== undefined && env.trim() !== "") return env.trim();
  try {
    return readControlToken(process.env.NOMOS_RUNTIME_DIR);
  } catch {
    return null;
  }
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c ?? "", widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)];
}

function pairs(entries: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${pad(k, width)}  ${v}`);
}

function short(value: string | null | undefined, max = 44): string {
  if (value === null || value === undefined || value === "") return "—";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  parsed: ParsedArgs;
  client: RuntimeClient;
  baseUrl: string;
  json: boolean;
  io: CliIO;
}

function replayOptions(parsed: ParsedArgs): ReplayOptions {
  const root = flagString(parsed, "sessions-root");
  return root === null ? {} : { root: path.resolve(root) };
}

/**
 * `assertSafeSessionId` lança para id com travessia — do lado da CLI isso é uso
 * errado (exit 2), não erro interno. O `await` DENTRO do try é essencial: sem
 * ele a rejeição escapa do bloco e o erro de uso vira INTERNAL.
 */
async function guardSessionId<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("session_id inválido")) throw new UsageError(message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// health
// ─────────────────────────────────────────────────────────────────────────────

async function cmdHealth(ctx: Ctx): Promise<Outcome> {
  // `/health` fica FORA do prefixo /api/v1 (docs/API.md, tabela de gestão).
  const health = await callManagement<HealthResponse>(ctx.client, "GET", "/health");
  return {
    json: health,
    lines: pairs([
      ["runtime", String(health.runtime)],
      ["browser", String(health.browser)],
      ["version", String(health.version)],
      ["contract", String(health.contract)],
      ["uptime_s", String(health.uptime_s)],
      ["workers", `${health.workers?.active ?? "?"}/${health.workers?.max ?? "?"}`],
      [
        "sessions",
        `total=${health.sessions?.total ?? "?"} active=${health.sessions?.active ?? "?"} idle=${health.sessions?.idle ?? "?"} paused=${health.sessions?.paused ?? "?"}`,
      ],
    ]),
    // `degraded`/`down` é informação do runtime, não falha da chamada: exit 0.
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sessions
// ─────────────────────────────────────────────────────────────────────────────

async function cmdSessions(ctx: Ctx): Promise<Outcome> {
  const sessions = await callManagement<SessionInfo[]>(ctx.client, "GET", `${API_PREFIX}/sessions`);
  if (!Array.isArray(sessions)) {
    throw new CliFailure("INVALID_RESPONSE", `${API_PREFIX}/sessions não respondeu uma lista`);
  }
  if (sessions.length === 0) {
    return { json: sessions, lines: ["nenhuma sessão no runtime"], error: null };
  }
  const rows = sessions.map((s) => [
    s.session_id,
    String(s.status),
    String(s.owner),
    String(s.control),
    String(s.pages?.length ?? 0),
    short(s.pages?.find((p) => p.active)?.url ?? s.pages?.[0]?.url ?? null, 40),
    short(s.task, 30),
    String(s.last_activity ?? "—"),
  ]);
  return {
    json: sessions,
    lines: table(["SESSION_ID", "STATUS", "OWNER", "CONTROL", "PAGES", "URL", "TASK", "LAST_ACTIVITY"], rows),
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// open
// ─────────────────────────────────────────────────────────────────────────────

async function cmdOpen(ctx: Ctx): Promise<Outcome> {
  const raw = ctx.parsed.args[0]!;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new UsageError(
      `URL inválida: ${JSON.stringify(raw)} — informe o esquema (ex.: https://exemplo.com)`,
    );
  }

  let session = flagString(ctx.parsed, "session");
  let created: SessionInfo | null = null;
  if (session === null) {
    const body: Record<string, unknown> = { owner: flagString(ctx.parsed, "owner") ?? `cli:${CLI_NAME}` };
    const profile = flagString(ctx.parsed, "profile");
    if (profile !== null) body.profile = profile;
    const headless = flagBool(ctx.parsed, "headless");
    if (headless !== null) body.headless = headless;
    // Sem `capabilities` no corpo de propósito: conceder capability é ato do dono.
    created = await callManagement<SessionInfo>(ctx.client, "POST", `${API_PREFIX}/sessions`, body);
    session = created.session_id;
  }

  const envelope = await callAction<PageInfo>(ctx.client, "browser.open", {
    session_id: session,
    url: target.toString(),
  });
  const error = envelopeError(envelope);
  const page = envelope.result;

  const lines = pairs([
    ["session", session],
    ["criada", created === null ? "não (sessão informada)" : "sim — continua aberta; feche com `close`"],
    ["state", String(envelope.state)],
    ["action_id", String(envelope.action_id)],
    ["page_id", page === null ? "—" : String(page.page_id)],
    ["url", page === null ? "—" : short(page.url, 80)],
    ["title", page === null ? "—" : short(page.title, 60)],
    ["duração", `${envelope.timing?.duration_ms ?? "?"} ms`],
  ]);

  return { json: { session_id: session, session_created: created, response: envelope }, lines, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// screenshot
// ─────────────────────────────────────────────────────────────────────────────

interface ShotResult {
  screenshot_ref: string;
  width: number;
  height: number;
}

async function cmdScreenshot(ctx: Ctx): Promise<Outcome> {
  const session = ctx.parsed.args[0]!;
  const scope = flagString(ctx.parsed, "scope") ?? "viewport";
  const envelope = await callAction<ShotResult>(ctx.client, "browser.screenshot", {
    session_id: session,
    scope,
  });
  const error = envelopeError(envelope);
  const shot = envelope.result;

  const rows: [string, string][] = [
    ["session", session],
    ["scope", scope],
    ["state", String(envelope.state)],
    ["action_id", String(envelope.action_id)],
    ["screenshot_ref", shot === null ? "—" : String(shot.screenshot_ref)],
    ["dimensões", shot === null ? "—" : `${shot.width}x${shot.height}`],
  ];

  const out = flagString(ctx.parsed, "out");
  let written: string | null = null;
  let writeError: Outcome["error"] = null;

  if (out !== null && error === null && shot !== null) {
    const options = replayOptions(ctx.parsed);
    const bundle = await guardSessionId(() => loadReplay(session, options));
    const record = bundle.screenshots.find((s) => s.ref === shot.screenshot_ref);
    if (record === undefined) {
      writeError = {
        code: "ARTIFACT_NOT_FOUND",
        message:
          `runtime devolveu ${shot.screenshot_ref} mas o binário não está em ${bundle.dir} — ` +
          "a API v1 não expõe rota de download; use --sessions-root se a trilha vive em outro diretório",
        detail: { dir: bundle.dir, disponiveis: bundle.screenshots.map((s) => s.ref) },
      };
    } else {
      const source = screenshotPath(session, record, options);
      const destination = path.resolve(out);
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        written = destination;
        rows.push(["arquivo", destination], ["bytes", String(record.bytes)]);
      } catch (copyProblem) {
        writeError = {
          code: "WRITE_FAILED",
          message: `não consegui gravar ${destination}: ${copyProblem instanceof Error ? copyProblem.message : String(copyProblem)}`,
          detail: { source },
        };
      }
    }
  } else if (out !== null) {
    rows.push(["arquivo", "não gravado (a captura falhou)"]);
  }

  return {
    json: { session_id: session, response: envelope, file: written, file_error: writeError },
    lines: pairs(rows),
    error: error ?? writeError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// task
// ─────────────────────────────────────────────────────────────────────────────

async function cmdTask(ctx: Ctx): Promise<Outcome> {
  const session = flagString(ctx.parsed, "session");
  if (session === null) {
    throw new UsageError(`"task" exige --session <ID> — uso: ${CLI_NAME} ${COMMANDS.task!.syntax}`);
  }
  const goal = ctx.parsed.args[0]!;
  if (goal.trim().length === 0) throw new UsageError("o objetivo não pode ser vazio");

  const envelope = await callAction<BrowserTask>(ctx.client, "browser.task", {
    session_id: session,
    goal,
  });
  const error = envelopeError(envelope);
  const task = envelope.result;

  const lines = pairs([
    ["session", session],
    ["goal", short(goal, 80)],
    ["task_id", task === null ? "—" : String(task.task_id)],
    ["state", task === null ? String(envelope.state) : String(task.state)],
    ["plan", task?.plan == null ? "—" : `${task.plan.steps.length} passo(s)`],
    ["ações", task === null ? "—" : String(task.actions?.length ?? 0)],
    ["retries", task === null ? "—" : String(task.retries ?? 0)],
    ["duração", `${envelope.timing?.duration_ms ?? "?"} ms`],
  ]);

  return { json: envelope, lines, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// close
// ─────────────────────────────────────────────────────────────────────────────

async function cmdClose(ctx: Ctx): Promise<Outcome> {
  const session = ctx.parsed.args[0]!;
  const body = await callManagement<{ closed?: boolean }>(
    ctx.client,
    "DELETE",
    `${API_PREFIX}/sessions/${encodeURIComponent(session)}`,
  );
  if (body?.closed !== true) {
    return {
      json: body,
      lines: [],
      error: {
        code: "INVALID_RESPONSE",
        message: `runtime respondeu sem {closed:true} para a sessão ${session}`,
        detail: body,
      },
    };
  }
  return { json: body, lines: [`sessão ${session} fechada`], error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// replay — leitura de disco, não de navegador
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FASE 12 — `replay verify <SESSION_ID>`
 *
 * POR QUE CLI **E** ROTA, E NÃO UMA SÓ
 * -----------------------------------
 * A rota `GET /api/v1/sessions/:id/replay/verify` serve quem já fala HTTP com o
 * runtime e quer o veredito sobre a raiz de sessões QUE O DAEMON usa — é o
 * caminho de um painel ou de outro serviço.
 *
 * Esta CLI serve o caso em que a rota não existe: o daemon CAIU. Verificar um
 * replay é exatamente o que se quer fazer depois de uma queda, e um verificador
 * que exige o processo derrubado de pé estaria indisponível na única hora em que
 * importa. Por isso ela lê o disco direto, aceita `--sessions-root` e não abre
 * socket nenhum.
 *
 * Código de saída: 0 íntegro, 1 reprovado. É o que permite usá-la em script.
 */
async function cmdReplayVerify(ctx: Ctx): Promise<Outcome> {
  const session = ctx.parsed.args[1]!;
  const options = replayOptions(ctx.parsed);
  const estrito = ctx.parsed.flags.get("strict") === true;
  const report = await guardSessionId(() =>
    verifyReplay(session, {
      ...options,
      ...(ctx.parsed.flags.get("pixels") === true ? { decodificar_pixels: true } : {}),
    }),
  );

  const erros = report.problemas.filter((p) => p.severidade === "erro");
  const avisos = report.problemas.filter((p) => p.severidade === "aviso");
  const reprovado = estrito ? report.problemas.length > 0 : !report.integro;

  const lines: string[] = [];
  if (report.problemas.length > 0) {
    lines.push(...table(["SEVERIDADE", "CÓDIGO", "ARQUIVO", "MENSAGEM"], report.problemas.map((p) => [
      p.severidade,
      p.codigo,
      p.arquivo ?? "—",
      short(p.mensagem, 78),
    ])));
    lines.push("");
  }
  lines.push(
    ...pairs([
      ["sessão", report.session_id],
      ["diretório", report.dir],
      ["checagens executadas", String(report.cobertura.checagens.length)],
      ["itens na linha do tempo", String(report.contagens.linha_do_tempo)],
      ["erros", String(erros.length)],
      ["avisos", String(avisos.length)],
      ["veredito", reprovado ? "RECUSADO" : "ÍNTEGRO"],
    ]),
  );
  // A lista de checagens é impressa porque, sem ela, "nenhum problema" e "não
  // rodou nada" seriam indistinguíveis na saída.
  lines.push("", `checagens: ${report.cobertura.checagens.join(", ")}`);

  return {
    json: { ...report, veredito: reprovado ? "RECUSADO" : "INTEGRO", estrito },
    lines,
    error: reprovado
      ? {
          code: "REPLAY_INTEGRITY_FAILED",
          message: `replay da sessão ${session} recusado: ${erros.length} erro(s)${estrito ? ` e ${avisos.length} aviso(s)` : ""}`,
          detail: { codigos: [...new Set(report.problemas.map((p) => p.codigo))] },
        }
      : null,
  };
}

async function cmdReplay(ctx: Ctx): Promise<Outcome> {
  // `replay verify <ID>` desvia aqui: o parser é posicional e não tem
  // subcomandos de verdade, e inventar um só para isto custaria mais do que
  // vale.
  if (ctx.parsed.args[0] === "verify") {
    if (ctx.parsed.args.length !== 2) {
      throw new UsageError(`uso: ${CLI_NAME} replay verify <SESSION_ID>`);
    }
    return cmdReplayVerify(ctx);
  }
  if (ctx.parsed.args.length !== 1) {
    throw new UsageError(`uso: ${CLI_NAME} replay <SESSION_ID>`);
  }
  const session = ctx.parsed.args[0]!;
  const options = replayOptions(ctx.parsed);
  const bundle = await guardSessionId(() => loadReplay(session, options));
  const timeline = timelineOf(bundle);

  const limit = flagInt(ctx.parsed, "limit", 0, 1);
  const shown: TimelineItem[] = limit > 0 ? timeline.slice(-limit) : timeline;

  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(...table(["TIMESTAMP", "FONTE", "ACTION_ID", "EVENTO"], shown.map((i) => [
      i.timestamp === "" ? "—" : i.timestamp,
      i.source,
      i.action_id ?? "—",
      short(i.label, 70),
    ])));
    if (shown.length < timeline.length) {
      lines.push(`(mostrando os últimos ${shown.length} de ${timeline.length})`);
    }
  }

  lines.push(
    "",
    ...pairs([
      ["diretório", bundle.dir],
      ["itens", `${timeline.length} (ações ${bundle.actions.length} · eventos ${bundle.events.length} · rede ${bundle.network.length})`],
      ["screenshots", String(bundle.screenshots.length)],
      ["ausentes", bundle.missing.length === 0 ? "nenhum" : bundle.missing.join(", ")],
      ["linhas corrompidas", String(bundle.errors.length)],
    ]),
  );
  if (bundle.result_error !== null) lines.push(`result.json ilegível: ${bundle.result_error}`);
  for (const problem of bundle.errors) {
    lines.push(`corrompida em ${problem.source}, linha ${problem.error.line}: ${problem.error.error}`);
  }

  // Nada gravado E nenhuma fonte no disco: a sessão não tem trilha. Isso é uma
  // falha do pedido, não um "0 itens" alegre.
  const semTrilha = timeline.length === 0 && bundle.missing.length === 5;
  return {
    json: { session_id: session, dir: bundle.dir, timeline: shown, total: timeline.length, missing: bundle.missing, errors: bundle.errors, result: bundle.result, result_error: bundle.result_error },
    lines,
    error: semTrilha
      ? {
          code: "SESSION_NOT_RECORDED",
          message: `nenhuma trilha gravada para ${session} em ${bundle.dir}`,
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// events — segue o WebSocket
// ─────────────────────────────────────────────────────────────────────────────

export function eventsWsUrl(baseUrl: string, session: string | null, events: string | null): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/events`;
  if (session !== null) url.searchParams.set("session_id", session);
  if (events !== null) url.searchParams.set("events", events);
  return url.toString();
}

function formatEvent(event: RuntimeEvent): string {
  const payload = JSON.stringify(event.payload ?? {});
  return [
    event.timestamp ?? "—",
    pad(String(event.event ?? "?"), 18),
    pad(event.session_id ?? "—", 20),
    short(payload, 90),
  ].join("  ");
}

async function cmdEvents(ctx: Ctx): Promise<number> {
  // `ws` só é carregado por quem realmente abre o socket.
  const { WebSocket } = await import("ws");
  const target = eventsWsUrl(ctx.baseUrl, flagString(ctx.parsed, "session"), flagString(ctx.parsed, "events"));
  const max = flagInt(ctx.parsed, "max", 0, 1);

  const socket = new WebSocket(target);
  let opened = false;
  let received = 0;

  return await new Promise<number>((resolve) => {
    let settled = false;
    const onSigint = (): void => {
      // Ctrl-C é término normal deste comando, não erro.
      finish(EXIT.OK);
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
      resolve(code);
    };

    process.on("SIGINT", onSigint);

    socket.on("open", () => {
      opened = true;
      if (!ctx.json) ctx.io.err(`conectado a ${target} — Ctrl-C encerra`);
    });

    socket.on("message", (data: unknown) => {
      // Vários frames chegam no MESMO segmento TCP: o handler dispara em
      // sequência antes de `close()` surtir efeito. Sem esta guarda, `--max N`
      // imprimiria N+k linhas.
      if (settled) return;
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let parsedFrame: RuntimeEvent;
      try {
        parsedFrame = JSON.parse(raw) as RuntimeEvent;
      } catch {
        // Frame ilegível não é descartado em silêncio.
        ctx.io.err(`aviso: frame não-JSON ignorado (${raw.length} bytes)`);
        return;
      }
      ctx.io.out(ctx.json ? JSON.stringify(parsedFrame) : formatEvent(parsedFrame));
      received += 1;
      if (max > 0 && received >= max) finish(EXIT.OK);
    });

    socket.on("error", (error: Error) => {
      if (!opened) {
        ctx.io.err(`erro: RUNTIME_UNREACHABLE: ${describeTransport(error, ctx.baseUrl)}`);
        finish(EXIT.UNREACHABLE);
        return;
      }
      ctx.io.err(`erro: CONNECTION_LOST: stream de eventos caiu — ${error.message}`);
      finish(EXIT.FAILURE);
    });

    socket.on("close", () => {
      finish(opened ? EXIT.OK : EXIT.UNREACHABLE);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Orquestração
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS: Readonly<Record<string, (ctx: Ctx) => Promise<Outcome>>> = Object.freeze({
  health: cmdHealth,
  sessions: cmdSessions,
  open: cmdOpen,
  screenshot: cmdScreenshot,
  task: cmdTask,
  replay: cmdReplay,
  close: cmdClose,
});

function emit(outcome: Outcome, ctx: Ctx): void {
  if (ctx.json) {
    ctx.io.out(JSON.stringify(outcome.json, null, 2));
  } else {
    for (const line of outcome.lines) ctx.io.out(line);
  }
  if (outcome.error !== null) {
    // stdout continua puro em --json; o erro humano vai para stderr.
    ctx.io.err(`erro: ${outcome.error.code}: ${outcome.error.message}`);
  }
}

/**
 * Ponto único de execução. Devolve o código de saída em vez de chamar
 * `process.exit`, para poder ser testado em processo.
 */
export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: ParsedArgs | null = null;
  try {
    parsed = parseArgs(argv);

    if (parsed.flags.get("version") === true) {
      io.out(`${CLI_NAME} ${CLI_VERSION}`);
      return EXIT.OK;
    }
    if (parsed.flags.get("help") === true || parsed.command === "help") {
      io.out(USAGE);
      return EXIT.OK;
    }
    if (parsed.command === null) {
      throw new UsageError("nenhum comando informado");
    }

    const spec = COMMANDS[parsed.command];
    if (spec === undefined) {
      throw new UsageError(`comando desconhecido: ${JSON.stringify(parsed.command)}`);
    }
    validate(parsed, parsed.command, spec);

    const baseUrl = normalizeBaseUrl(flagString(parsed, "url") ?? DEFAULT_RUNTIME);
    const ctx: Ctx = {
      parsed,
      baseUrl,
      client: new RuntimeClient(baseUrl, flagInt(parsed, "timeout", DEFAULT_TIMEOUT_MS, 1)),
      json: parsed.flags.get("json") === true,
      io,
    };

    if (parsed.command === "events") return await cmdEvents(ctx);

    const outcome = await HANDLERS[parsed.command]!(ctx);
    emit(outcome, ctx);
    return outcome.error === null ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    return reportFatal(error, io);
  }
}

/** Nenhum caminho de erro imprime stack: só `code: message`. */
function reportFatal(error: unknown, io: CliIO): number {
  if (process.env.NOMOS_CLI_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
    io.err(error.stack);
  }
  if (error instanceof UsageError) {
    io.err(`erro: USAGE: ${error.message}`);
    io.err(USAGE);
    return EXIT.USAGE;
  }
  if (error instanceof UnreachableError) {
    io.err(`erro: RUNTIME_UNREACHABLE: ${error.message}`);
    return EXIT.UNREACHABLE;
  }
  if (error instanceof CliFailure) {
    io.err(`erro: ${error.code}: ${error.message}`);
    return EXIT.FAILURE;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.err(`erro: INTERNAL: ${message}`);
  io.err("(defina NOMOS_CLI_DEBUG=1 para ver o stack)");
  return EXIT.FAILURE;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv);
}

// Só executa quando é o processo principal — `import` do módulo não dispara nada.
if (import.meta.main === true) {
  await main();
}
