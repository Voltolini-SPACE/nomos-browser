/**
 * REDAÇÃO DE SEGREDOS — FASE 23
 *
 * Base de toda a observabilidade: EventBus, AuditLog e Replay passam por aqui
 * ANTES de qualquer coisa sair para WebSocket, disco ou log. O contrato
 * (contract.ts) promete em dois pontos que segredo não vaza — `ActionError.detail`
 * "nunca contém segredo (ver redaction em observability)" e `SecretProvider`
 * cujo valor "NUNCA entra em log". Este arquivo é onde essa promessa é cumprida.
 *
 * Política de falha: redigir demais é recuperável, redigir de menos não é.
 * Por isso o casamento de nome é normalizado (case-insensitive, separadores
 * ignorados) e há uma regra de sufixo — `client_secret` e `csrf_token` são
 * segredos ainda que não estejam na lista literal. A regra de sufixo NÃO usa
 * substring: `token_count` e `tokenizer` continuam legíveis.
 *
 * Sem dependência externa. Apenas stdlib.
 */

export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[CIRCULAR]";
export const MAX_DEPTH_MARK = "[MAX_DEPTH]";

/** Profundidade máxima antes de cortar. Evita estrutura patológica travar o bus. */
const DEFAULT_MAX_DEPTH = 16;

/**
 * Campos exigidos pela missão. A comparação é feita sobre a forma normalizada,
 * então `X-API-Key`, `x_api_key` e `xapikey` caem todos no mesmo balde.
 */
export const SENSITIVE_FIELDS: readonly string[] = Object.freeze([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "senha",
  "secret",
  "bearer",
]);

/**
 * Sufixos de alto sinal. Pegam `client_secret`, `db_password`, `csrf_token`,
 * `session_token` sem pegar `token_count`, `tokenizer` ou `credential_ref` —
 * este último tem de sobreviver, porque o contrato audita a REFERÊNCIA do
 * segredo (é o que prova o uso), nunca o valor.
 */
const SENSITIVE_SUFFIXES: readonly string[] = Object.freeze([
  "token",
  "secret",
  "password",
  "senha",
  "apikey",
  "authorization",
  "cookie",
  "bearer",
]);

/** Query params sensíveis (superset do exigido: token, access_token, key, api_key, password, sig). */
export const SENSITIVE_URL_PARAMS: readonly string[] = Object.freeze([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "key",
  "api_key",
  "password",
  "senha",
  "secret",
  "sig",
  "signature",
  "authorization",
  "bearer",
]);

const URL_PARAM_SUFFIXES: readonly string[] = Object.freeze([
  "token",
  "secret",
  "password",
  "senha",
  "apikey",
  "signature",
]);

/** Esquemas de credencial que aparecem no VALOR, não na chave (`Authorization: Bearer x`). */
const CREDENTIAL_SCHEME_RE = /^\s*(bearer|basic|token|apikey)\s+\S/i;
const HTTP_URL_RE = /^\s*https?:\/\//i;

export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s._\-]/g, "");
}

const EXACT_SET: ReadonlySet<string> = new Set(SENSITIVE_FIELDS.map(normalizeFieldName));
const SUFFIX_SET: readonly string[] = SENSITIVE_SUFFIXES.map(normalizeFieldName);
const URL_PARAM_SET: ReadonlySet<string> = new Set(SENSITIVE_URL_PARAMS.map(normalizeFieldName));
const URL_PARAM_SUFFIX_SET: readonly string[] = URL_PARAM_SUFFIXES.map(normalizeFieldName);

/** true quando o NOME do campo indica segredo. Case-insensitive, separador-insensitive. */
export function isSensitiveField(name: string): boolean {
  const n = normalizeFieldName(name);
  if (n.length === 0) return false;
  if (EXACT_SET.has(n)) return true;
  return SUFFIX_SET.some((s) => n.endsWith(s));
}

function isSensitiveUrlParam(rawName: string): boolean {
  let decoded = rawName;
  try {
    decoded = decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    // Percent-encoding inválido: segue com o nome cru em vez de estourar.
    decoded = rawName;
  }
  const n = normalizeFieldName(decoded);
  if (n.length === 0) return false;
  if (URL_PARAM_SET.has(n)) return true;
  return URL_PARAM_SUFFIX_SET.some((s) => n.endsWith(s));
}

/**
 * Redige query params sensíveis preservando o resto da URL byte a byte.
 *
 * Não usa `new URL()` de propósito: o parser normaliza (acrescenta `/`, reordena
 * escapes) e a missão exige preservar o resto da URL. Também redige a senha do
 * userinfo (`https://user:senha@host`).
 */
export function redactUrl(url: string): string {
  if (typeof url !== "string" || url.length === 0) return url;

  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  let head = hashAt >= 0 ? url.slice(0, hashAt) : url;

  // userinfo: esquema://usuario:senha@host  → a senha some, o usuário fica.
  head = head.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]*):([^/?#@]*)@/,
    (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  );

  const qAt = head.indexOf("?");
  if (qAt < 0) return head + hash;

  const base = head.slice(0, qAt);
  const query = head.slice(qAt + 1);
  if (query.length === 0) return head + hash;

  const parts = query.split("&").map((part) => {
    if (part.length === 0) return part;
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    if (!isSensitiveUrlParam(name)) return part;
    return `${name}=${REDACTED}`;
  });

  return `${base}?${parts.join("&")}${hash}`;
}

/** Redige um valor string por conta própria (esquema de credencial ou URL com token). */
function redactStringValue(value: string): string {
  if (CREDENTIAL_SCHEME_RE.test(value)) return REDACTED;
  if (HTTP_URL_RE.test(value)) return redactUrl(value);
  return value;
}

export type HeaderBag = Record<string, string | string[] | number | undefined>;

/**
 * Redige um mapa de cabeçalhos HTTP. Preserva o nome do cabeçalho (é evidência
 * de QUE credencial foi usada) e destrói só o valor.
 */
export function redactHeaders<T extends HeaderBag>(headers: T): T {
  if (headers === null || typeof headers !== "object") return headers;
  const out: HeaderBag = {};
  for (const [k, v] of Object.entries(headers as HeaderBag)) {
    if (isSensitiveField(k)) {
      out[k] = Array.isArray(v) ? v.map(() => REDACTED) : REDACTED;
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? redactStringValue(item) : item));
    } else if (typeof v === "string") {
      out[k] = redactStringValue(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface RedactOptions {
  maxDepth?: number;
  /** Campos extras a redigir nesta chamada (somados à lista global). */
  extraFields?: readonly string[];
}

/**
 * Cópia profunda redigida. Funciona em objeto aninhado, array, Map, Set e Error.
 *
 * O tipo de retorno declara `T` por ergonomia no chamador, mas alguns valores
 * mudam de forma por serem inservíveis em JSON: binário vira `[BINARY:n bytes]`,
 * `Error` vira `{name,message,stack}`, `Map` vira objeto e `Set` vira array.
 * Isso é deliberado — `JSON.stringify(new Error("x"))` é `{}`, ou seja, uma
 * falha que desaparece silenciosamente do log.
 */
export function redactObject<T>(value: T, options: RedactOptions = {}): T {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const extra = new Set((options.extraFields ?? []).map(normalizeFieldName));
  const sensitive = (name: string): boolean => isSensitiveField(name) || extra.has(normalizeFieldName(name));
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return node;

    const t = typeof node;
    if (t === "string") return redactStringValue(node as string);
    if (t === "number" || t === "boolean" || t === "bigint") return node;
    if (t === "function") return `[Function ${(node as { name?: string }).name || "anonymous"}]`;
    if (t === "symbol") return String(node);

    if (depth >= maxDepth) return MAX_DEPTH_MARK;

    const obj = node as object;
    if (seen.has(obj)) return CIRCULAR;

    if (obj instanceof Date) return new Date(obj.getTime());
    if (ArrayBuffer.isView(obj)) return `[BINARY:${(obj as ArrayBufferView).byteLength} bytes]`;
    if (obj instanceof ArrayBuffer) return `[BINARY:${obj.byteLength} bytes]`;
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: redactStringValue(obj.message),
        stack: typeof obj.stack === "string" ? redactStringValue(obj.stack) : undefined,
      };
    }

    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item) => walk(item, depth + 1));
      }
      if (obj instanceof Set) {
        return [...obj].map((item) => walk(item, depth + 1));
      }
      if (obj instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of obj) {
          const key = String(k);
          out[key] = sensitive(key) ? REDACTED : walk(v, depth + 1);
        }
        return out;
      }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = sensitive(k) ? REDACTED : walk(v, depth + 1);
      }
      return out;
    } finally {
      // Sai do caminho atual: nó repetido em ramos irmãos não é ciclo.
      seen.delete(obj);
    }
  };

  return walk(value, 0) as T;
}
