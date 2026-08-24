/**
 * FASE 19 — CAPABILITY ENGINE (policy)
 *
 * Decide, para cada ferramenta da API v1, se a ação é permitida. Três guardas
 * independentes, que somam — passar em uma não dispensa as outras:
 *
 *   1. capability   — a ferramenta exige `X`; o portador tem `X`?
 *   2. URL          — o destino é um esquema/host que a política admite? (SSRF)
 *   3. path         — o arquivo de upload/download está dentro da raiz permitida?
 *
 * Regra estruturante: FAIL CLOSED. Ferramenta que não consta em
 * `REQUIRED_CAPABILITY` é negada; capability ausente é `false`, nunca "assume
 * que sim"; esquema de URL fora da allowlist é negado; raiz de path não
 * configurada nega upload/download em vez de cair na raiz do disco.
 *
 * Tipos vêm de `contract.ts`. Este módulo não redefine nenhum deles.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACTION_CLASS,
  OBSERVE_ONLY_CAPABILITIES,
  REQUIRED_CAPABILITY,
  RESTRICTED_CAPABILITIES,
  type ActionClass,
  type ActionError,
  type ActionErrorCode,
  type Capabilities,
} from "./contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities — normalização vinda da rede
// ─────────────────────────────────────────────────────────────────────────────

/** Ordem canônica das chaves. Derivada de uma política do contrato, não redigitada. */
export const CAPABILITY_KEYS: readonly (keyof Capabilities)[] = Object.freeze(
  Object.keys(RESTRICTED_CAPABILITIES) as (keyof Capabilities)[],
);

/**
 * Constrói um `Capabilities` uniforme partindo da forma do contrato. Copiar a
 * forma de `RESTRICTED_CAPABILITIES` (em vez de montar de `Object.fromEntries`)
 * faz o compilador acusar se o contrato ganhar uma capability nova.
 */
function capabilitiesWhere(value: boolean): Capabilities {
  const out: Capabilities = { ...RESTRICTED_CAPABILITIES };
  for (const k of CAPABILITY_KEYS) out[k] = value;
  return out;
}

export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze(capabilitiesWhere(false));

/**
 * Converte um objeto arbitrário (JSON de cliente) em `Capabilities`.
 * Só `=== true` em propriedade PRÓPRIA concede. `Object.hasOwn` é obrigatório:
 * acesso indexado em objeto literal encontra `Object.prototype` e devolveria
 * uma função truthy para chaves herdadas.
 */
export function normalizeCapabilities(raw: unknown): Capabilities {
  const out = { ...NO_CAPABILITIES } as Capabilities;
  if (raw === null || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const k of CAPABILITY_KEYS) {
    out[k] = Object.hasOwn(src, k) && src[k] === true;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Políticas nomeadas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nomes aceitáveis vindos de fora do processo. `full` NÃO está aqui de
 * propósito: privilégio total não pode ser conquistado escrevendo uma string
 * num corpo JSON — só por chamada explícita de `fullCapabilities()` no código
 * do dono do processo.
 */
export type PolicyName = "restricted" | "observe";

export const NAMED_POLICIES: Readonly<Record<PolicyName, Readonly<Capabilities>>> = Object.freeze({
  restricted: RESTRICTED_CAPABILITIES,
  observe: OBSERVE_ONLY_CAPABILITIES,
});

export const DEFAULT_POLICY_NAME: PolicyName = "restricted";

export class PolicyError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: ActionErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Resolve uma política a partir de um nome que veio da REDE.
 * Nome desconhecido — inclusive `"full"` — lança. Não existe degradação
 * silenciosa para restricted: o chamador tem de ver o erro.
 */
export function policyFromName(name: unknown): Readonly<Capabilities> {
  if (typeof name !== "string") {
    throw new PolicyError("INVALID_REQUEST", "nome de política deve ser string", { received: typeof name });
  }
  if (name === "full") {
    throw new PolicyError(
      "POLICY_BLOCKED",
      'política "full" não pode ser construída por nome; exige chamada explícita de fullCapabilities()',
      { policy: "full" },
    );
  }
  if (!Object.hasOwn(NAMED_POLICIES, name)) {
    throw new PolicyError("INVALID_REQUEST", `política desconhecida: ${name}`, {
      policy: name,
      known: Object.keys(NAMED_POLICIES),
    });
  }
  return NAMED_POLICIES[name as PolicyName];
}

/** Variante que não lança — devolve `null` no lugar. Continua recusando `"full"`. */
export function tryPolicyFromName(name: unknown): Readonly<Capabilities> | null {
  try {
    return policyFromName(name);
  } catch {
    return null;
  }
}

/**
 * Privilégio total. Existe como FUNÇÃO e não como constante exportada para que
 * conceder tudo seja sempre um ato deliberado no código, e para que cada
 * chamador receba uma cópia mutável própria em vez de compartilhar um objeto.
 */
export function fullCapabilities(): Capabilities {
  return capabilitiesWhere(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisões
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityDecision {
  allowed: boolean;
  /** Capability exigida pela ferramenta; `null` quando a ferramenta é desconhecida. */
  required: keyof Capabilities | null;
  /** Classe da ação conforme `ACTION_CLASS`; `null` quando desconhecida. */
  class: ActionClass | null;
  reason: string;
  /** Código para o envelope `ActionResponse`. `null` quando permitido. */
  code: ActionErrorCode | null;
  tool: string;
  /** De onde vieram as capabilities aplicadas — evidência para auditoria. */
  source: "explicit" | "agent" | "default";
  agent: string | null;
}

export interface UrlDecision {
  allowed: boolean;
  reason: string;
  code: ActionErrorCode | null;
  /** URL normalizada e sem userinfo. `null` quando nem parseou. */
  url: string | null;
  scheme: string | null;
  host: string | null;
  /** true quando o host cai em faixa interna/loopback/link-local. */
  internal: boolean;
}

export interface PathDecision {
  allowed: boolean;
  reason: string;
  code: ActionErrorCode | null;
  /** Caminho absoluto já resolvido (e com symlinks resolvidos quando existe). */
  resolved: string | null;
  root: string | null;
}

/** Converte a decisão negada no `ActionError` do contrato. */
export function toActionError(d: CapabilityDecision | UrlDecision | PathDecision): ActionError {
  if (d.allowed) throw new PolicyError("INTERNAL", "toActionError chamado com decisão permitida");
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === "allowed" || k === "reason" || k === "code") continue;
    detail[k] = v;
  }
  return { code: d.code ?? "POLICY_BLOCKED", message: d.reason, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarda de URL (FASE 40) — anti-SSRF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowlist de esquemas. É allowlist e não blocklist porque uma blocklist
 * esquece o próximo esquema (`view-source:`, `blob:`, `filesystem:`, `ftp:`).
 * `about:` só passa como `about:blank` exato, tratado à parte.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

const INTERNAL_HOST_SUFFIXES: readonly string[] = Object.freeze([".localhost", ".local"]);
const INTERNAL_HOST_EXACT: ReadonlySet<string> = new Set(["localhost", "local"]);

function ipv4Octets(host: string): number[] | null {
  // A URL WHATWG já normalizou 2130706433 e 0x7f.1 para forma pontuada, então
  // basta reconhecer a forma canônica aqui.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return o.every((n) => n <= 255) ? o : null;
}

function isInternalIpv4(o: number[]): boolean {
  if (o[0] === 127) return true; // loopback 127/8
  if (o[0] === 0) return true; // "this network" 0/8 — 0.0.0.0 vira loopback em muitos stacks
  if (o[0] === 10) return true; // privado 10/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // privado 172.16/12
  if (o[0] === 192 && o[1] === 168) return true; // privado 192.168/16
  if (o[0] === 169 && o[1] === 254) return true; // link-local 169.254/16 — metadata de nuvem
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
  return false;
}

/** Expande `::` e devolve os 8 grupos de 16 bits, ou `null` se não for IPv6. */
function ipv6Groups(hostWithBrackets: string): number[] | null {
  if (!hostWithBrackets.startsWith("[") || !hostWithBrackets.endsWith("]")) return null;
  const raw = hostWithBrackets.slice(1, -1);
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isInternalIpv6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  // IPv4-mapped ::ffff:a.b.c.d — a URL WHATWG mostra em hex (::ffff:7f00:1),
  // então a checagem tem de ser sobre os últimos 32 bits, não sobre o texto.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const o = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    return isInternalIpv4(o);
  }
  return false;
}

/** Host interno: loopback, faixas privadas, link-local, `.local`, `localhost`. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, ""); // ponto final é o mesmo host
  if (host === "") return true; // sem host não há destino externo verificável
  const v6 = ipv6Groups(host);
  if (v6 !== null) return isInternalIpv6(v6);
  const v4 = ipv4Octets(host);
  if (v4 !== null) return isInternalIpv4(v4);
  if (INTERNAL_HOST_EXACT.has(host)) return true;
  return INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export interface UrlGuardOptions {
  /**
   * Libera hosts internos. É EXPLÍCITO por desenho: o próprio runtime navega em
   * 127.0.0.1 nos testes e fixtures, e essa permissão tem de ser um ato visível
   * da sessão — nunca inferida do fato de a origem ser local.
   */
  allow_internal?: boolean;
}

export function checkUrl(raw: unknown, opts: UrlGuardOptions = {}): UrlDecision {
  const base: UrlDecision = {
    allowed: false,
    reason: "",
    code: "POLICY_BLOCKED",
    url: null,
    scheme: null,
    host: null,
    internal: false,
  };

  if (typeof raw !== "string" || raw.trim() === "") {
    return { ...base, code: "INVALID_REQUEST", reason: "url ausente ou não é string" };
  }
  const text = raw.trim();

  // about:blank é a página vazia legítima; qualquer outro about: é superfície
  // interna do navegador (about:config, about:credits...).
  if (text.toLowerCase() === "about:blank") {
    return { ...base, allowed: true, code: null, reason: "about:blank permitido", url: "about:blank", scheme: "about:" };
  }

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ...base, code: "INVALID_REQUEST", reason: "url não parseável (esperado absoluta com esquema)" };
  }

  const scheme = u.protocol.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      ...base,
      scheme,
      host: u.hostname || null,
      reason: `esquema bloqueado: ${scheme} (permitidos: http:, https:, about:blank)`,
    };
  }

  // Credencial embutida na URL vaza em log, Referer e histórico. Negar é mais
  // barato do que confiar que toda camada de log vai redigir.
  if (u.username !== "" || u.password !== "") {
    return {
      ...base,
      scheme,
      host: u.hostname || null,
      reason: "url com credencial embutida (userinfo) é bloqueada",
    };
  }

  const internal = isInternalHost(u.hostname);
  const normalized = u.toString();

  if (internal && opts.allow_internal !== true) {
    return {
      ...base,
      scheme,
      host: u.hostname,
      internal: true,
      url: normalized,
      reason: `host interno bloqueado sem allow_internal: ${u.hostname}`,
    };
  }

  return {
    allowed: true,
    reason: internal ? "host interno liberado por allow_internal explícito" : "destino externo permitido",
    code: null,
    url: normalized,
    scheme,
    host: u.hostname,
    internal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarda de path — upload / download
// ─────────────────────────────────────────────────────────────────────────────

export type PathKind = "upload" | "download";

const PATH_DENY_CODE: Readonly<Record<PathKind, ActionErrorCode>> = Object.freeze({
  upload: "UPLOAD_DENIED",
  download: "DOWNLOAD_DENIED",
});

/** `child` está contido em `root` (ou é o próprio root)? Comparação por segmento. */
function contains(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export interface PathGuardOptions {
  root?: string;
  /** upload exige arquivo existente; download aceita destino ainda inexistente. */
  mustExist?: boolean;
}

export function checkPath(candidate: unknown, kind: PathKind, opts: PathGuardOptions = {}): PathDecision {
  const code = PATH_DENY_CODE[kind];
  const rootRaw = opts.root;
  const base: PathDecision = { allowed: false, reason: "", code, resolved: null, root: null };

  if (typeof rootRaw !== "string" || rootRaw.trim() === "") {
    // Sem raiz configurada não existe "fora da raiz" — cair no disco inteiro
    // seria o fallback silencioso que a missão proíbe.
    return { ...base, reason: `raiz de ${kind} não configurada; ${kind} negado (fail closed)` };
  }
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return { ...base, code: "INVALID_REQUEST", reason: "path ausente ou não é string", root: path.resolve(rootRaw) };
  }
  if (candidate.includes("\0")) {
    return { ...base, reason: "path contém byte nulo", root: path.resolve(rootRaw) };
  }

  const root = path.resolve(rootRaw);
  // Relativo é resolvido CONTRA a raiz, nunca contra o cwd do processo — o cwd
  // do daemon não é um lugar previsível para o chamador.
  const resolved = path.resolve(root, candidate);

  if (!contains(root, resolved)) {
    return {
      ...base,
      root,
      resolved,
      reason: `path fora da raiz permitida (traversal): ${kind} negado`,
    };
  }

  // Symlink dentro da raiz apontando para fora derrota a checagem lexical.
  let real: string | null = null;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = null; // não existe ainda
  }
  const mustExist = opts.mustExist ?? kind === "upload";
  if (real === null) {
    if (mustExist) return { ...base, root, resolved, reason: "arquivo não existe" };
  } else {
    let realRoot = root;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      /* raiz ainda não criada: mantém o valor lexical */
    }
    if (!contains(realRoot, real)) {
      return {
        ...base,
        root: realRoot,
        resolved: real,
        reason: "path escapa da raiz via symlink",
      };
    }
    return { allowed: true, reason: "path dentro da raiz permitida", code: null, resolved: real, root: realRoot };
  }

  return { allowed: true, reason: "path dentro da raiz permitida", code: null, resolved, root };
}

// ─────────────────────────────────────────────────────────────────────────────
// CapabilityEngine
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityEngineOptions {
  /** Política aplicada quando não há capabilities explícitas nem agente registrado. */
  defaultPolicy?: PolicyName | Capabilities;
  uploadRoot?: string;
  downloadRoot?: string;
}

export class CapabilityEngine {
  readonly defaults: Readonly<Capabilities>;
  readonly uploadRoot: string | null;
  readonly downloadRoot: string | null;
  readonly #agents = new Map<string, Readonly<Capabilities>>();

  constructor(opts: CapabilityEngineOptions = {}) {
    const dp = opts.defaultPolicy ?? DEFAULT_POLICY_NAME;
    this.defaults = Object.freeze(
      typeof dp === "string" ? { ...policyFromName(dp) } : normalizeCapabilities(dp),
    );
    this.uploadRoot = typeof opts.uploadRoot === "string" ? path.resolve(opts.uploadRoot) : null;
    this.downloadRoot = typeof opts.downloadRoot === "string" ? path.resolve(opts.downloadRoot) : null;
  }

  /**
   * Política por agente. `capabilities` como string só aceita nome público —
   * `"full"` continua barrado aqui, então registrar um agente a partir de dado
   * de rede não vira escalada de privilégio.
   */
  registerAgent(name: string, capabilities: PolicyName | Capabilities): Readonly<Capabilities> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new PolicyError("INVALID_REQUEST", "nome de agente inválido");
    }
    const caps = Object.freeze(
      typeof capabilities === "string" ? { ...policyFromName(capabilities) } : normalizeCapabilities(capabilities),
    );
    this.#agents.set(name, caps);
    return caps;
  }

  revokeAgent(name: string): boolean {
    return this.#agents.delete(name);
  }

  hasAgent(name: string): boolean {
    return this.#agents.has(name);
  }

  agents(): string[] {
    return [...this.#agents.keys()];
  }

  /** Capabilities efetivas do agente. Agente desconhecido cai no default, não em "tudo". */
  capabilitiesFor(agent: string | null | undefined): Readonly<Capabilities> {
    if (typeof agent === "string" && this.#agents.has(agent)) return this.#agents.get(agent)!;
    return this.defaults;
  }

  /**
   * `capabilities` explícito vence; senão o registro do agente; senão o default.
   * A decisão devolve `source` para que a auditoria saiba qual regra decidiu.
   */
  check(tool: unknown, capabilities?: Capabilities | null, agent?: string | null): CapabilityDecision {
    const agentName = typeof agent === "string" && agent !== "" ? agent : null;
    const toolName = typeof tool === "string" ? tool : "";
    const base = { tool: toolName, agent: agentName };

    let caps: Readonly<Capabilities>;
    let source: CapabilityDecision["source"];
    if (capabilities !== undefined && capabilities !== null) {
      caps = normalizeCapabilities(capabilities);
      source = "explicit";
    } else if (agentName !== null && this.#agents.has(agentName)) {
      caps = this.#agents.get(agentName)!;
      source = "agent";
    } else {
      caps = this.defaults;
      source = "default";
    }

    if (toolName === "") {
      return {
        ...base,
        source,
        allowed: false,
        required: null,
        class: null,
        code: "INVALID_REQUEST",
        reason: "nome de ferramenta ausente ou não é string",
      };
    }

    // `Object.hasOwn` e não `REQUIRED_CAPABILITY[tool]`: acesso indexado acha
    // `Object.prototype`, e uma "ferramenta" chamada `toString` receberia uma
    // função truthy como capability exigida.
    if (!Object.hasOwn(REQUIRED_CAPABILITY, toolName)) {
      return {
        ...base,
        source,
        allowed: false,
        required: null,
        class: Object.hasOwn(ACTION_CLASS, toolName) ? ACTION_CLASS[toolName] : null,
        code: "CAPABILITY_DENIED",
        reason: `ferramenta desconhecida: ${toolName} — negada por fail closed`,
      };
    }

    const required = REQUIRED_CAPABILITY[toolName];
    const klass = Object.hasOwn(ACTION_CLASS, toolName) ? ACTION_CLASS[toolName] : null;

    if (klass === null) {
      // Ferramenta com capability mas sem classe é contrato inconsistente.
      // Negar é a única resposta honesta: não dá para auditar o que não se classifica.
      return {
        ...base,
        source,
        allowed: false,
        required,
        class: null,
        code: "CAPABILITY_DENIED",
        reason: `ferramenta ${toolName} sem ACTION_CLASS no contrato — negada por fail closed`,
      };
    }

    if (caps[required] !== true) {
      return {
        ...base,
        source,
        allowed: false,
        required,
        class: klass,
        code: "CAPABILITY_DENIED",
        reason: `capability "${required}" negada para ${toolName} (classe ${klass})`,
      };
    }

    return {
      ...base,
      source,
      allowed: true,
      required,
      class: klass,
      code: null,
      reason: `capability "${required}" concedida para ${toolName} (classe ${klass})`,
    };
  }

  /** Igual a `check`, porém lançando `PolicyError` — atalho para a camada de API. */
  assertAllowed(tool: string, capabilities?: Capabilities | null, agent?: string | null): CapabilityDecision {
    const d = this.check(tool, capabilities, agent);
    if (!d.allowed) throw new PolicyError(d.code ?? "CAPABILITY_DENIED", d.reason, { tool: d.tool, required: d.required });
    return d;
  }

  checkUrl(url: unknown, opts: UrlGuardOptions = {}): UrlDecision {
    return checkUrl(url, opts);
  }

  checkPath(candidate: unknown, kind: PathKind, opts: PathGuardOptions = {}): PathDecision {
    const root = opts.root ?? (kind === "upload" ? this.uploadRoot : this.downloadRoot) ?? undefined;
    return checkPath(candidate, kind, { ...opts, root });
  }
}

/** Engine com os defaults do contrato. Conveniência; não é singleton obrigatório. */
export function restrictedEngine(opts: Omit<CapabilityEngineOptions, "defaultPolicy"> = {}): CapabilityEngine {
  return new CapabilityEngine({ ...opts, defaultPolicy: "restricted" });
}
