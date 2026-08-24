/**
 * FASE 2 — CONFIGURAÇÃO DO DAEMON
 *
 * Precedência: DEFAULTS → arquivo → variáveis de ambiente → overrides do código.
 * O override programático vence por último porque quem embute o daemon num teste
 * precisa poder pedir `port: 0` sem que o ambiente do operador o contradiga.
 *
 * Duas regras que este módulo existe para sustentar:
 *
 *  1. NADA DE COERÇÃO SILENCIOSA. `NOMOS_BROWSER_PORT=abc` não vira 7777; lança
 *     ConfigError. Um daemon que "corrige" configuração errada esconde do dono o
 *     fato de que ele nunca leu o que foi pedido.
 *
 *  2. PROVENIÊNCIA REGISTRADA. `sources` diz, por campo, de onde veio o valor
 *     efetivo. Sem isso, "por que está headless?" só se responde por adivinhação.
 *
 * O formato do arquivo é JSON ou um YAML-ish deliberadamente pobre (`chave: valor`,
 * comentário com `#`, um nível de aninhamento). Pobre de propósito: uma dependência
 * de YAML para ler seis chaves seria superfície de supply chain paga a troco de nada.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionErrorCode } from "../../core/src/contract.ts";
import { DEFAULT_POLICY_NAME, NAMED_POLICIES, type PolicyName } from "../../core/src/policy.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export class ConfigError extends Error {
  readonly code: ActionErrorCode = "INVALID_REQUEST";
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConfigError";
    this.detail = detail;
  }
}

/** Política de entrega do texto cru de página. Ver `DaemonConfig.raw_web_content`. */
export type RawWebContentPolicy = "withhold_on_detection" | "always" | "never";

export const RAW_WEB_CONTENT_POLICIES: readonly RawWebContentPolicy[] = Object.freeze([
  "withhold_on_detection",
  "always",
  "never",
]);

export interface DaemonConfig {
  host: string;
  /** 0 = porta efêmera escolhida pelo SO; a porta real sai em `startDaemon()`. */
  port: number;
  version: string;
  /** Default headful: takeover humano (FASE 32) precisa de janela visível. */
  headless: boolean;
  viewport: { width: number; height: number };
  profiles_root: string | null;
  /** Teto de sessões vivas (worker pool do SessionManager). */
  max_workers: number;
  /** FASE 43 — ações simultâneas POR SESSÃO. */
  max_concurrency: number;
  /** FASE 43 — ações aguardando POR SESSÃO. Estourou ⇒ BACKPRESSURE_REJECTED. */
  max_queue: number;
  /** FASE 43 — prazo total por ação (fila + execução). Estourou ⇒ TIMEOUT. */
  action_timeout_ms: number;
  observe_limit: number;
  /** Buffer circular do EventBus (reconexão de WebSocket). */
  event_buffer: number;
  max_body_bytes: number;
  default_policy: PolicyName;
  /** Navegar em 127.0.0.1/rede interna exige ato explícito (anti-SSRF, FASE 40). */
  allow_internal_urls: boolean;
  upload_root: string | null;
  download_root: string | null;
  /** Raiz do audit log JSONL. */
  sessions_root: string | null;
  audit: boolean;
  /**
   * O que fazer com o texto CRU lido da web quando há injeção detectada.
   *
   * O default é `withhold_on_detection` — fail-safe, não fail-closed total.
   * `never` seria mais seguro no papel e inútil na prática: o agente perderia a
   * capacidade de ler qualquer página e o dono desligaria a defesa inteira na
   * primeira semana. `always` mantém o comportamento antigo (marca mas entrega),
   * e existe para quem precisa auditar o cru sem intermediação.
   *
   * Reter só em severidade ALTA é deliberado: média/baixa marcam e entregam,
   * porque um falso positivo de severidade média que apaga conteúdo legítimo
   * transforma a defesa em bug.
   */
  raw_web_content: RawWebContentPolicy;
  /**
   * FASE 4 — ACIONABILIDADE DO GESTO.
   *
   * `scroll_into_view`: rolar o alvo para dentro do viewport antes de clicar,
   * arrastar, focar para digitar ou rolar com `target`. Default LIGADO porque
   * desligado o runtime volta a despachar gesto para coordenada fora da tela —
   * o defeito que a FASE 4 fechou. Existe desligado só para quem precisa medir
   * o comportamento antigo (é assim que os controles negativos do teste provam
   * que a defesa é o que pega o caso).
   */
  scroll_into_view: boolean;
  /** Amostras CONSECUTIVAS iguais da bounding box para declará-la assentada. */
  stability_samples: number;
  /** Intervalo entre amostras de estabilização. */
  stability_interval_ms: number;
  /**
   * Exigir prova de que o evento de clique chegou ao alvo. Default LIGADO: sem
   * ele, `success:true` volta a significar "despachei", não "chegou".
   */
  click_delivery_check: boolean;
  /**
   * `deviceScaleFactor` do contexto do Chromium (DPR). 1 = tela comum, 2 =
   * retina. As coordenadas do runtime são CSS px em qualquer DPR; esta chave
   * existe para que isso seja TESTÁVEL contra um navegador de DPR 2 de verdade,
   * em vez de afirmado.
   */
  device_scale_factor: number;
  /** Proveniência por campo: "default" | "file:<caminho>" | "env:<VAR>" | "override". */
  sources: Record<string, string>;
}

/** Versão declarada no package.json. Ilegível ⇒ "unknown", nunca número inventado. */
export function readPackageVersion(root: string = REPO_ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string") {
      return (parsed as { version: string }).version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7777;

function baseDefaults(): DaemonConfig {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    version: readPackageVersion(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    profiles_root: null,
    max_workers: 4,
    max_concurrency: 4,
    max_queue: 64,
    action_timeout_ms: 30_000,
    observe_limit: 200,
    event_buffer: 1000,
    max_body_bytes: 1_048_576,
    default_policy: DEFAULT_POLICY_NAME,
    allow_internal_urls: false,
    upload_root: null,
    download_root: null,
    sessions_root: null,
    audit: true,
    raw_web_content: "withhold_on_detection",
    scroll_into_view: true,
    stability_samples: 3,
    stability_interval_ms: 50,
    click_delivery_check: true,
    device_scale_factor: 1,
    sources: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coerção estrita
// ─────────────────────────────────────────────────────────────────────────────

function asBool(raw: unknown, field: string, origin: string): boolean {
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  throw new ConfigError(`${field} (${origin}) não é booleano: ${JSON.stringify(raw)}`, { field, origin, raw });
}

function asInt(raw: unknown, field: string, origin: string, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `${field} (${origin}) deve ser inteiro entre ${min} e ${max}; recebido ${JSON.stringify(raw)}`,
      { field, origin, raw, min, max },
    );
  }
  return n;
}

function asString(raw: unknown, field: string, origin: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError(`${field} (${origin}) deve ser string não vazia`, { field, origin });
  }
  return raw.trim();
}

function asPolicy(raw: unknown, field: string, origin: string): PolicyName {
  const s = asString(raw, field, origin);
  // `full` não consta em NAMED_POLICIES de propósito (policy.ts): privilégio total
  // não se conquista escrevendo uma string num arquivo de configuração.
  if (!Object.hasOwn(NAMED_POLICIES, s)) {
    throw new ConfigError(`${field} (${origin}) desconhecida: ${s}`, {
      field,
      origin,
      known: Object.keys(NAMED_POLICIES),
    });
  }
  return s as PolicyName;
}

function asRawWebContent(raw: unknown, field: string, origin: string): RawWebContentPolicy {
  const s = asString(raw, field, origin);
  if (!(RAW_WEB_CONTENT_POLICIES as readonly string[]).includes(s)) {
    throw new ConfigError(`${field} (${origin}) desconhecida: ${s}`, {
      field,
      origin,
      known: [...RAW_WEB_CONTENT_POLICIES],
    });
  }
  return s as RawWebContentPolicy;
}

function asPath(raw: unknown, field: string, origin: string): string {
  return path.resolve(asString(raw, field, origin));
}

// ─────────────────────────────────────────────────────────────────────────────
// Arquivo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê JSON ou YAML-ish. Achata `viewport:` + linhas indentadas em `viewport.width`,
 * para que arquivo e ambiente falem o mesmo vocabulário de chave.
 */
export function parseConfigText(text: string, origin: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new ConfigError(`config JSON inválida em ${origin}: ${(e as Error).message}`, { origin });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config em ${origin} deve ser um objeto`, { origin });
    }
    const flat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) flat[`${k}.${k2}`] = v2;
      } else {
        flat[k] = v;
      }
    }
    return flat;
  }

  const out: Record<string, unknown> = {};
  let parent: string | null = null;
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const noComment = line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "");
    if (noComment.trim() === "") continue;
    const indented = /^\s/.test(noComment);
    const colon = noComment.indexOf(":");
    if (colon < 0) {
      throw new ConfigError(`config ${origin}: linha ${i + 1} sem "chave: valor"`, { origin, line: i + 1 });
    }
    const key = noComment.slice(0, colon).trim();
    let value = noComment.slice(colon + 1).trim();
    if (key === "") {
      throw new ConfigError(`config ${origin}: linha ${i + 1} com chave vazia`, { origin, line: i + 1 });
    }
    if (value === "") {
      // Cabeçalho de bloco (ex.: `viewport:`). Só um nível — mais que isso pede
      // um parser de YAML de verdade, e o daemon não vai carregar um.
      if (indented) {
        throw new ConfigError(`config ${origin}: linha ${i + 1} aninha mais de um nível`, { origin, line: i + 1 });
      }
      parent = key;
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[indented && parent !== null ? `${parent}.${key}` : key] = value;
    if (!indented) parent = null;
  }
  return out;
}

/** Caminhos consultados quando não há `config_file` explícito. */
export function candidateConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.NOMOS_BROWSER_CONFIG;
  if (typeof explicit === "string" && explicit.trim() !== "") return [path.resolve(explicit.trim())];
  return [path.join(REPO_ROOT, "nomos-browser.config.json"), path.join(REPO_ROOT, "nomos-browser.config.yaml")];
}

// ─────────────────────────────────────────────────────────────────────────────

/** chave de config → variável de ambiente correspondente. */
export const ENV_KEYS: Readonly<Record<string, string>> = Object.freeze({
  host: "NOMOS_BROWSER_HOST",
  port: "NOMOS_BROWSER_PORT",
  headless: "NOMOS_BROWSER_HEADLESS",
  "viewport.width": "NOMOS_BROWSER_VIEWPORT_WIDTH",
  "viewport.height": "NOMOS_BROWSER_VIEWPORT_HEIGHT",
  profiles_root: "NOMOS_BROWSER_PROFILES_ROOT",
  max_workers: "NOMOS_BROWSER_MAX_WORKERS",
  max_concurrency: "NOMOS_BROWSER_MAX_CONCURRENCY",
  max_queue: "NOMOS_BROWSER_MAX_QUEUE",
  action_timeout_ms: "NOMOS_BROWSER_ACTION_TIMEOUT_MS",
  observe_limit: "NOMOS_BROWSER_OBSERVE_LIMIT",
  event_buffer: "NOMOS_BROWSER_EVENT_BUFFER",
  max_body_bytes: "NOMOS_BROWSER_MAX_BODY_BYTES",
  default_policy: "NOMOS_BROWSER_POLICY",
  allow_internal_urls: "NOMOS_BROWSER_ALLOW_INTERNAL",
  upload_root: "NOMOS_BROWSER_UPLOAD_ROOT",
  download_root: "NOMOS_BROWSER_DOWNLOAD_ROOT",
  sessions_root: "NOMOS_SESSIONS_ROOT",
  audit: "NOMOS_BROWSER_AUDIT",
  raw_web_content: "NOMOS_BROWSER_RAW_WEB_CONTENT",
  scroll_into_view: "NOMOS_BROWSER_SCROLL_INTO_VIEW",
  stability_samples: "NOMOS_BROWSER_STABILITY_SAMPLES",
  stability_interval_ms: "NOMOS_BROWSER_STABILITY_INTERVAL_MS",
  click_delivery_check: "NOMOS_BROWSER_CLICK_DELIVERY_CHECK",
  device_scale_factor: "NOMOS_BROWSER_DEVICE_SCALE_FACTOR",
});

export interface LoadConfigOptions extends Partial<Omit<DaemonConfig, "sources" | "viewport">> {
  viewport?: { width: number; height: number };
  config_file?: string | null;
  env?: NodeJS.ProcessEnv;
  /** false ignora qualquer arquivo — usado por teste para não herdar do operador. */
  read_file?: boolean;
}

/** Aplica um par chave/valor cru sobre a config, com coerção estrita. */
function applyKey(cfg: DaemonConfig, key: string, raw: unknown, origin: string): boolean {
  switch (key) {
    case "host":
      cfg.host = asString(raw, key, origin);
      break;
    case "port":
      cfg.port = asInt(raw, key, origin, 0, 65535);
      break;
    case "version":
      cfg.version = asString(raw, key, origin);
      break;
    case "headless":
      cfg.headless = asBool(raw, key, origin);
      break;
    case "audit":
      cfg.audit = asBool(raw, key, origin);
      break;
    case "allow_internal_urls":
      cfg.allow_internal_urls = asBool(raw, key, origin);
      break;
    case "viewport.width":
      cfg.viewport = { ...cfg.viewport, width: asInt(raw, key, origin, 1, 20000) };
      break;
    case "viewport.height":
      cfg.viewport = { ...cfg.viewport, height: asInt(raw, key, origin, 1, 20000) };
      break;
    case "max_workers":
      cfg.max_workers = asInt(raw, key, origin, 1, 1024);
      break;
    case "max_concurrency":
      cfg.max_concurrency = asInt(raw, key, origin, 1, 1024);
      break;
    case "max_queue":
      cfg.max_queue = asInt(raw, key, origin, 0, 100_000);
      break;
    case "action_timeout_ms":
      cfg.action_timeout_ms = asInt(raw, key, origin, 1, 3_600_000);
      break;
    case "observe_limit":
      cfg.observe_limit = asInt(raw, key, origin, 1, 100_000);
      break;
    case "event_buffer":
      cfg.event_buffer = asInt(raw, key, origin, 0, 1_000_000);
      break;
    case "max_body_bytes":
      cfg.max_body_bytes = asInt(raw, key, origin, 1, 268_435_456);
      break;
    case "default_policy":
      cfg.default_policy = asPolicy(raw, key, origin);
      break;
    case "raw_web_content":
      cfg.raw_web_content = asRawWebContent(raw, key, origin);
      break;
    case "scroll_into_view":
      cfg.scroll_into_view = asBool(raw, key, origin);
      break;
    case "click_delivery_check":
      cfg.click_delivery_check = asBool(raw, key, origin);
      break;
    case "stability_samples":
      // Mínimo 2: com 1 amostra "consecutivas iguais" não compara nada e a
      // estabilização vira um `await` decorativo.
      cfg.stability_samples = asInt(raw, key, origin, 2, 100);
      break;
    case "stability_interval_ms":
      cfg.stability_interval_ms = asInt(raw, key, origin, 0, 10_000);
      break;
    case "device_scale_factor":
      cfg.device_scale_factor = asInt(raw, key, origin, 1, 8);
      break;
    case "profiles_root":
      cfg.profiles_root = asPath(raw, key, origin);
      break;
    case "upload_root":
      cfg.upload_root = asPath(raw, key, origin);
      break;
    case "download_root":
      cfg.download_root = asPath(raw, key, origin);
      break;
    case "sessions_root":
      cfg.sessions_root = asPath(raw, key, origin);
      break;
    default:
      return false;
  }
  cfg.sources[key] = origin;
  return true;
}

export function loadConfig(opts: LoadConfigOptions = {}): DaemonConfig {
  const env = opts.env ?? process.env;
  const cfg = baseDefaults();
  for (const k of Object.keys(cfg)) if (k !== "sources") cfg.sources[k] = "default";

  // 1. arquivo
  if (opts.read_file !== false) {
    const explicit = typeof opts.config_file === "string" ? [path.resolve(opts.config_file)] : candidateConfigPaths(env);
    const required = typeof opts.config_file === "string" || typeof env.NOMOS_BROWSER_CONFIG === "string";
    let found = false;
    for (const file of explicit) {
      if (!fs.existsSync(file)) continue;
      found = true;
      const parsed = parseConfigText(fs.readFileSync(file, "utf8"), file);
      for (const [k, v] of Object.entries(parsed)) {
        if (!applyKey(cfg, k, v, `file:${file}`)) {
          throw new ConfigError(`chave de configuração desconhecida em ${file}: ${k}`, { file, key: k });
        }
      }
      break;
    }
    // Arquivo pedido de propósito e ausente é erro: seguir com defaults faria o
    // daemon subir com política diferente da que o dono escreveu.
    if (required && !found) {
      throw new ConfigError(`arquivo de configuração não encontrado: ${explicit.join(", ")}`, { candidates: explicit });
    }
  }

  // 2. ambiente
  for (const [key, varName] of Object.entries(ENV_KEYS)) {
    const raw = env[varName];
    if (raw === undefined || raw === "") continue;
    applyKey(cfg, key, raw, `env:${varName}`);
  }

  // 3. overrides programáticos
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    if (k === "env" || k === "config_file" || k === "read_file" || k === "sources") continue;
    if (k === "viewport") {
      const vp = v as { width?: unknown; height?: unknown };
      if (vp.width !== undefined) applyKey(cfg, "viewport.width", vp.width, "override");
      if (vp.height !== undefined) applyKey(cfg, "viewport.height", vp.height, "override");
      continue;
    }
    if (v === null) {
      // null explícito zera raízes opcionais (upload/download/profiles/sessions).
      if (k === "profiles_root" || k === "upload_root" || k === "download_root" || k === "sessions_root") {
        (cfg as unknown as Record<string, unknown>)[k] = null;
        cfg.sources[k] = "override";
        continue;
      }
      throw new ConfigError(`override ${k} não aceita null`, { key: k });
    }
    if (!applyKey(cfg, k, v, "override")) {
      throw new ConfigError(`override de configuração desconhecido: ${k}`, { key: k });
    }
  }

  if (cfg.max_concurrency > cfg.max_queue + cfg.max_concurrency) {
    throw new ConfigError("max_concurrency incoerente com max_queue", {
      max_concurrency: cfg.max_concurrency,
      max_queue: cfg.max_queue,
    });
  }
  return cfg;
}

/** Cópia sem segredo algum — o daemon publica isto em /health quando pedido. */
export function describeConfig(cfg: DaemonConfig): Record<string, unknown> {
  const { sources, ...rest } = cfg;
  return { ...rest, sources };
}
