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
// Os defaults de visão moram em `vision.ts` porque foram MEDIDOS lá (limiar 0,7
// e 20 s de teto). Reescrevê-los aqui criaria duas verdades que divergem no dia
// em que alguém medir de novo e só corrigir um dos lados.
import { DEFAULT_VISION_THRESHOLD, DEFAULT_VISION_TIMEOUT_MS, VISION_AIMS } from "../../core/src/vision.ts";
// Os limites do refino moram em `target.ts` porque foram MEDIDOS lá; repeti-los
// aqui criaria duas verdades que divergem no dia em que alguém remedir.
import {
  DEFAULT_VISION_AIM,
  DEFAULT_VISION_REFINE_FACTOR,
  DEFAULT_VISION_REFINE_PASSES,
  MAX_VISION_REFINE_PASSES,
  type AimMode,
} from "../../core/src/target.ts";
import { OLLAMA_DEFAULT_BASE } from "../../core/src/providers/ollama.ts";

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
  /**
   * Missão EMBEDDED_AGENT_UX — diretório de extensão (descompactada) carregada
   * no Chromium do runtime via `--load-extension`. null = nenhuma. Só funciona
   * headful ou no headless novo do canal chromium; Chrome de marca não aceita.
   */
  extension_dir: string | null;
  /** FASE 10 — destacar o alvo NA página antes de clique/digitação. */
  spotlight: boolean;
  /** Quanto tempo o destaque fica visível (e quanto o gesto espera por ele). */
  spotlight_dwell_ms: number;
  /** Cor CSS do destaque. null ⇒ `Highlight` do sistema; o cofre injeta a da marca. */
  spotlight_color: string | null;
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
  /**
   * FASE 10 — SESSÃO SEM LEASE PODE SER OPERADA?
   *
   * Default `false`, e a inversão é a decisão desta fase. Antes o daemon
   * embutia `allow_unleased: true` no código: quem nunca pedisse lease agia à
   * vontade, e a arbitragem só valia contra quem tivesse sido educado o
   * bastante para adquirir um. Um controle que só barra quem já se anunciou não
   * é controle — é etiqueta.
   *
   * Fechado por default, o dono da sessão passa a ser um FATO do runtime: quem
   * cria a sessão recebe lease exclusivo no mesmo ato, e qualquer outro
   * principal é recusado com CONTROL_NOT_OWNED até adquirir, herdar por
   * handoff, ou esperar o lease do outro expirar.
   *
   * `true` continua existindo porque há instalação de agente único que não quer
   * saber de lease algum — mas agora é ESCOLHA ESCRITA, com nome e proveniência
   * na configuração, e não um default escondido no fonte do daemon.
   */
  allow_unleased: boolean;

  // ── FASE 13 — watchdog dentro do runtime ──────────────────────────────────
  //
  // Ligado por default. Um supervisor que nasce desligado é um supervisor que
  // ninguém liga: a falha que ele existe para pegar acontece na madrugada de uma
  // instalação onde ninguém leu a documentação.
  watchdog_enabled: boolean;
  /** Período entre sondagens. Também é a base da deriva que denuncia congelamento. */
  watchdog_interval_ms: number;
  /**
   * Recuperações da MESMA falha dentro da janela antes de DEGRADAR e parar.
   * É o T10 do SECURITY.md: watchdog sem teto transforma falha em negação de
   * serviço local.
   */
  watchdog_max_restarts: number;
  /** Task em RUNNING sem avançar o checkpoint por mais que isto é task estagnada. */
  watchdog_task_stall_ms: number;
  /**
   * Ação EM EXECUÇÃO há mais que isto é worker preso.
   *
   * Limiar PRÓPRIO, e não `action_timeout_ms * 2` como eu tinha derivado. A
   * medição mostrou por quê: os dois prazos servem a coisas diferentes e
   * amarrá-los tornava impossível configurar um sem estragar o outro. O prazo de
   * ação é o que o CLIENTE espera; este é o tempo a partir do qual o trabalho
   * que ficou rodando depois do prazo vira sintoma de travamento.
   */
  watchdog_worker_stall_ms: number;
  upload_root: string | null;
  download_root: string | null;
  /** Raiz do audit log JSONL. */
  sessions_root: string | null;
  audit: boolean;

  // ── FASE 9 — motor de task ────────────────────────────────────────────────
  //
  // Todas configuráveis porque o custo certo depende do alvo: um formulário
  // interno responde em 2 s, um checkout com 3-D Secure leva 40 s, e um teto
  // único faria um dos dois mentir. Os defaults são os da missão.
  /** Tentativas TOTAIS por passo, contando a primeira. 1 desliga a retentativa. */
  task_max_attempts: number;
  /** Prazo de UM passo. Estourado ⇒ TIMEOUT, que é retentável pela política. */
  task_step_timeout_ms: number;
  /** Prazo da task INTEIRA. Existe para que backoff somado não vire espera infinita. */
  task_total_timeout_ms: number;
  task_retry_base_ms: number;
  /** Teto do backoff exponencial. Sem ele, a 12ª tentativa esperaria horas. */
  task_retry_max_ms: number;
  /**
   * Janela para retomar uma task que ficou RECOVERING depois de um crash cuja
   * sessão não pôde ser reconstituída. Passada a janela ela vira FAILED com
   * `last_error` explicando — ver `taskengine.ts#recuperar`.
   */
  task_recover_grace_ms: number;
  /** Raiz dos arquivos de task. `null` ⇒ dentro de `sessions_root`. */
  tasks_root: string | null;
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
  /**
   * FASE 5 — PROVIDERS REAIS NO RUNTIME.
   *
   * Identificador no formato `"<backend>:<modelo>"`, hoje só `ollama`.
   * Ex.: `"ollama:qwen2.5-coder:7b"` (o modelo tem `:` no nome — a divisão é no
   * PRIMEIRO `:`, nunca no último).
   *
   * Default NULO, e isso é a decisão, não um esquecimento: um runtime que nasce
   * falando com um LLM sem o dono ter pedido manda a página que ele está vendo
   * para um processo que ele não escolheu. Configurado, tem de funcionar de
   * verdade; não configurado, `browser.task` falha explícito e o degrau `vision`
   * sai `skipped` com a razão — nunca em silêncio.
   */
  ai_provider: string | null;
  /** Secundário acionado só em DEGRADAÇÃO do principal. Nunca em cancelamento. */
  ai_provider_fallback: string | null;
  ai_timeout_ms: number;
  /**
   * `think` do backend. `null` = deixa o provider decidir (padrão do backend).
   *
   * Medido nesta máquina: `qwen3.5:4b-q8_0` com raciocínio ligado e orçamento
   * curto de tokens gasta TUDO pensando e devolve `response:""`. Quem usa esse
   * modelo precisa de `false`; quem usa `qwen2.5-coder:7b` não precisa de nada.
   */
  ai_think: boolean | null;
  /** Ex.: `"ollama:qwen2.5vl:3b"`. Ausente ⇒ degrau `vision` PULADO, com razão. */
  vision_provider: string | null;
  vision_timeout_ms: number;
  /** Abaixo disto a visão é descartada como palpite. Ver `target.ts`. */
  vision_min_confidence: number;
  /**
   * FASE 6b — passadas de REFINO POR RECORTE (0..2). Default 0, POR MEDIÇÃO.
   *
   * A tabela completa (3 tamanhos × 3 ajustes × 3 execuções) está em
   * `packages/core/src/target.ts`, sobre `DEFAULT_VISION_REFINE_PASSES`, e os
   * dados crus em `evidence/nomos-browser-final-loop/06-cascata/`. O resumo:
   * com `qwen2.5vl:3b`, UMA passada de refino é o PIOR ajuste nos três tamanhos
   * (o alvo de 160x100 sai do alvo em 3 de 3 execuções); duas passadas
   * recuperam e compram ~1px de margem por 3x o custo.
   *
   * A chave existe porque a capacidade é real e outro modelo pode se comportar
   * de outro jeito. O DEFAULT é 0 porque é o que a medição sustenta aqui.
   */
  vision_refine_passes: number;
  /** Lado do recorte = maior lado da caixa grosseira × isto (1.2..6). */
  vision_refine_factor: number;
  /**
   * FASE 6c — ONDE mirar dentro do que a visão devolveu.
   *
   *   box_center      centro da caixa estimada
   *   point           o `point_2d` do modelo; sem ponto, cai no centro da caixa
   *   point_then_box  o ponto quando ele concorda com a caixa; senão, o centro
   *
   * Existe porque a caixa deste modelo vem inflada (~1,8x em largura, medido) e
   * o centro de uma caixa inflada escorrega para fora do alvo — enquanto
   * APONTAR é uma tarefa em que a família Qwen2.5-VL é treinada à parte.
   * A tabela que decidiu o default está em `target.ts`, sobre `AimMode`.
   */
  vision_aim: AimMode;
  /** Backend dos providers. Loopback obrigatório salvo `providers_allow_remote`. */
  providers_base_url: string;
  /**
   * Consentimento explícito para mandar prompt e SCREENSHOT para fora desta
   * máquina. Existe porque a frase "exige loopback salvo allow_remote" precisa
   * de um lugar onde o dono diga "sim, eu sei" — sem isso a regra seria só um
   * bloqueio sem porta, e a primeira necessidade real viraria um patch no fonte.
   */
  providers_allow_remote: boolean;
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
export const DEFAULT_PROVIDERS_BASE_URL = OLLAMA_DEFAULT_BASE;

/**
 * Backends que este runtime sabe construir. Lista FECHADA de propósito: um
 * backend desconhecido tem de virar `ConfigError` no arranque, não um provider
 * que nasce mudo e só se revela quebrado na primeira `browser.task` real.
 */
export const PROVIDER_BACKENDS: readonly string[] = Object.freeze(["ollama"]);

export interface ProviderRef {
  backend: "ollama";
  /** Nome do modelo COMO o backend o conhece — `qwen2.5-coder:7b`, com `:`. */
  model: string;
  /** O texto original, para a trilha dizer o que o dono escreveu. */
  raw: string;
}

/**
 * `"<backend>:<modelo>"` → `ProviderRef`.
 *
 * A divisão é no PRIMEIRO `:` porque o nome do modelo do Ollama contém `:`
 * (`qwen2.5-coder:7b`). Dividir no último devolveria backend `"ollama:qwen2.5-coder"`
 * e modelo `"7b"` — errado nos dois campos, e silenciosamente.
 */
export function parseProviderRef(raw: unknown, field: string, origin = "override"): ProviderRef {
  const s = asString(raw, field, origin);
  const corte = s.indexOf(":");
  if (corte <= 0 || corte === s.length - 1) {
    throw new ConfigError(
      `${field} (${origin}) deve ter o formato "<backend>:<modelo>"; recebido ${JSON.stringify(s)}`,
      { field, origin, raw: s, known: [...PROVIDER_BACKENDS] },
    );
  }
  const backend = s.slice(0, corte).trim().toLowerCase();
  const model = s.slice(corte + 1).trim();
  if (!PROVIDER_BACKENDS.includes(backend)) {
    throw new ConfigError(
      `${field} (${origin}): backend desconhecido ${JSON.stringify(backend)}`,
      { field, origin, backend, known: [...PROVIDER_BACKENDS] },
    );
  }
  if (model === "") {
    throw new ConfigError(`${field} (${origin}): modelo vazio`, { field, origin, raw: s });
  }
  return { backend: backend as "ollama", model, raw: s };
}

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
    allow_unleased: false,
    extension_dir: null,
    spotlight: false,
    spotlight_dwell_ms: 220,
    spotlight_color: null,
    watchdog_enabled: true,
    watchdog_interval_ms: 5_000,
    watchdog_max_restarts: 3,
    watchdog_task_stall_ms: 120_000,
    watchdog_worker_stall_ms: 60_000,
    upload_root: null,
    download_root: null,
    sessions_root: null,
    audit: true,
    task_max_attempts: 3,
    task_step_timeout_ms: 60_000,
    task_total_timeout_ms: 600_000,
    task_retry_base_ms: 500,
    task_retry_max_ms: 30_000,
    task_recover_grace_ms: 30_000,
    tasks_root: null,
    raw_web_content: "withhold_on_detection",
    scroll_into_view: true,
    stability_samples: 3,
    stability_interval_ms: 50,
    click_delivery_check: true,
    device_scale_factor: 1,
    ai_provider: null,
    ai_provider_fallback: null,
    ai_timeout_ms: 120_000,
    ai_think: null,
    vision_provider: null,
    vision_timeout_ms: DEFAULT_VISION_TIMEOUT_MS,
    vision_min_confidence: DEFAULT_VISION_THRESHOLD,
    vision_refine_passes: DEFAULT_VISION_REFINE_PASSES,
    vision_refine_factor: DEFAULT_VISION_REFINE_FACTOR,
    vision_aim: DEFAULT_VISION_AIM,
    providers_base_url: DEFAULT_PROVIDERS_BASE_URL,
    providers_allow_remote: false,
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

/**
 * Fração 0..1 com casa decimal. `asInt` não serve para `vision_min_confidence`:
 * o único valor inteiro no intervalo seria 0 ou 1, e um limiar de confiança que
 * só aceita "tudo" ou "nada" não é limiar.
 */
function asFraction(raw: unknown, field: string, origin: string, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(
      `${field} (${origin}) deve ser número entre ${min} e ${max}; recebido ${JSON.stringify(raw)}`,
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
  extension_dir: "NOMOS_BROWSER_EXTENSION_DIR",
  spotlight: "NOMOS_BROWSER_SPOTLIGHT",
  spotlight_dwell_ms: "NOMOS_BROWSER_SPOTLIGHT_DWELL_MS",
  spotlight_color: "NOMOS_BROWSER_SPOTLIGHT_COLOR",
  max_workers: "NOMOS_BROWSER_MAX_WORKERS",
  max_concurrency: "NOMOS_BROWSER_MAX_CONCURRENCY",
  max_queue: "NOMOS_BROWSER_MAX_QUEUE",
  action_timeout_ms: "NOMOS_BROWSER_ACTION_TIMEOUT_MS",
  observe_limit: "NOMOS_BROWSER_OBSERVE_LIMIT",
  event_buffer: "NOMOS_BROWSER_EVENT_BUFFER",
  max_body_bytes: "NOMOS_BROWSER_MAX_BODY_BYTES",
  default_policy: "NOMOS_BROWSER_POLICY",
  allow_internal_urls: "NOMOS_BROWSER_ALLOW_INTERNAL",
  allow_unleased: "NOMOS_BROWSER_ALLOW_UNLEASED",
  watchdog_enabled: "NOMOS_BROWSER_WATCHDOG_ENABLED",
  watchdog_interval_ms: "NOMOS_BROWSER_WATCHDOG_INTERVAL_MS",
  watchdog_max_restarts: "NOMOS_BROWSER_WATCHDOG_MAX_RESTARTS",
  watchdog_task_stall_ms: "NOMOS_BROWSER_WATCHDOG_TASK_STALL_MS",
  watchdog_worker_stall_ms: "NOMOS_BROWSER_WATCHDOG_WORKER_STALL_MS",
  upload_root: "NOMOS_BROWSER_UPLOAD_ROOT",
  download_root: "NOMOS_BROWSER_DOWNLOAD_ROOT",
  sessions_root: "NOMOS_SESSIONS_ROOT",
  audit: "NOMOS_BROWSER_AUDIT",
  task_max_attempts: "NOMOS_BROWSER_TASK_MAX_ATTEMPTS",
  task_step_timeout_ms: "NOMOS_BROWSER_TASK_STEP_TIMEOUT_MS",
  task_total_timeout_ms: "NOMOS_BROWSER_TASK_TOTAL_TIMEOUT_MS",
  task_retry_base_ms: "NOMOS_BROWSER_TASK_RETRY_BASE_MS",
  task_retry_max_ms: "NOMOS_BROWSER_TASK_RETRY_MAX_MS",
  task_recover_grace_ms: "NOMOS_BROWSER_TASK_RECOVER_GRACE_MS",
  tasks_root: "NOMOS_BROWSER_TASKS_ROOT",
  raw_web_content: "NOMOS_BROWSER_RAW_WEB_CONTENT",
  scroll_into_view: "NOMOS_BROWSER_SCROLL_INTO_VIEW",
  stability_samples: "NOMOS_BROWSER_STABILITY_SAMPLES",
  stability_interval_ms: "NOMOS_BROWSER_STABILITY_INTERVAL_MS",
  click_delivery_check: "NOMOS_BROWSER_CLICK_DELIVERY_CHECK",
  device_scale_factor: "NOMOS_BROWSER_DEVICE_SCALE_FACTOR",
  ai_provider: "NOMOS_BROWSER_AI_PROVIDER",
  ai_provider_fallback: "NOMOS_BROWSER_AI_PROVIDER_FALLBACK",
  ai_timeout_ms: "NOMOS_BROWSER_AI_TIMEOUT_MS",
  ai_think: "NOMOS_BROWSER_AI_THINK",
  vision_provider: "NOMOS_BROWSER_VISION_PROVIDER",
  vision_timeout_ms: "NOMOS_BROWSER_VISION_TIMEOUT_MS",
  vision_min_confidence: "NOMOS_BROWSER_VISION_MIN_CONFIDENCE",
  vision_refine_passes: "NOMOS_BROWSER_VISION_REFINE_PASSES",
  vision_refine_factor: "NOMOS_BROWSER_VISION_REFINE_FACTOR",
  vision_aim: "NOMOS_BROWSER_VISION_AIM",
  providers_base_url: "NOMOS_BROWSER_PROVIDERS_BASE_URL",
  providers_allow_remote: "NOMOS_BROWSER_PROVIDERS_ALLOW_REMOTE",
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
    case "allow_unleased":
      cfg.allow_unleased = asBool(raw, key, origin);
      break;
    case "watchdog_enabled":
      cfg.watchdog_enabled = asBool(raw, key, origin);
      break;
    case "watchdog_interval_ms":
      // Piso 50 ms: abaixo disso o vigia gasta mais CPU do que aquilo que ele
      // vigia, e a deriva do escalonador vira falso positivo de congelamento.
      cfg.watchdog_interval_ms = asInt(raw, key, origin, 50, 3_600_000);
      break;
    case "watchdog_max_restarts":
      // 0 é legítimo: "detecte e reporte, mas nunca tente recuperar sozinho".
      cfg.watchdog_max_restarts = asInt(raw, key, origin, 0, 1_000);
      break;
    case "watchdog_task_stall_ms":
      cfg.watchdog_task_stall_ms = asInt(raw, key, origin, 100, 86_400_000);
      break;
    case "watchdog_worker_stall_ms":
      cfg.watchdog_worker_stall_ms = asInt(raw, key, origin, 100, 86_400_000);
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
    case "extension_dir":
      cfg.extension_dir = asPath(raw, key, origin);
      break;
    case "spotlight":
      cfg.spotlight = asBool(raw, key, origin);
      break;
    case "spotlight_dwell_ms":
      // Teto 5000: destaque mais longo que isso vira atraso de ação, não UX.
      cfg.spotlight_dwell_ms = asInt(raw, key, origin, 0, 5000);
      break;
    case "spotlight_color":
      cfg.spotlight_color = asString(raw, key, origin);
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
    // ── FASE 9 — motor de task ───────────────────────────────────────────────
    case "task_max_attempts":
      // Mínimo 1: zero tentativa não é "sem retry", é "não executa".
      cfg.task_max_attempts = asInt(raw, key, origin, 1, 100);
      break;
    case "task_step_timeout_ms":
      cfg.task_step_timeout_ms = asInt(raw, key, origin, 1, 3_600_000);
      break;
    case "task_total_timeout_ms":
      cfg.task_total_timeout_ms = asInt(raw, key, origin, 1, 86_400_000);
      break;
    case "task_retry_base_ms":
      cfg.task_retry_base_ms = asInt(raw, key, origin, 0, 3_600_000);
      break;
    case "task_retry_max_ms":
      cfg.task_retry_max_ms = asInt(raw, key, origin, 0, 3_600_000);
      break;
    case "task_recover_grace_ms":
      cfg.task_recover_grace_ms = asInt(raw, key, origin, 0, 3_600_000);
      break;
    case "tasks_root":
      cfg.tasks_root = asPath(raw, key, origin);
      break;
    // ── FASE 5 — providers ───────────────────────────────────────────────────
    // Validado NO ARRANQUE, não no primeiro uso: `ai_provider: "gpt4:foo"` tem
    // de derrubar o daemon com mensagem clara, e não virar um `browser.task`
    // que falha meia hora depois com "backend inalcançável".
    case "ai_provider":
      cfg.ai_provider = parseProviderRef(raw, key, origin).raw;
      break;
    case "ai_provider_fallback":
      cfg.ai_provider_fallback = parseProviderRef(raw, key, origin).raw;
      break;
    case "ai_timeout_ms":
      cfg.ai_timeout_ms = asInt(raw, key, origin, 1, 3_600_000);
      break;
    case "ai_think":
      cfg.ai_think = asBool(raw, key, origin);
      break;
    case "vision_provider":
      cfg.vision_provider = parseProviderRef(raw, key, origin).raw;
      break;
    case "vision_timeout_ms":
      cfg.vision_timeout_ms = asInt(raw, key, origin, 1, 3_600_000);
      break;
    case "vision_min_confidence":
      cfg.vision_min_confidence = asFraction(raw, key, origin, 0, 1);
      break;
    case "vision_refine_passes":
      // Teto em MAX_VISION_REFINE_PASSES: cada passada é uma inferência a mais
      // por clique. Sem teto, "melhorar a precisão" viraria um custo sem fundo.
      cfg.vision_refine_passes = asInt(raw, key, origin, 0, MAX_VISION_REFINE_PASSES);
      break;
    case "vision_aim": {
      // Enum FECHADO. `vision_aim: "centro"` não vira `box_center` em silêncio:
      // mirar no lugar errado é a falha mais cara deste degrau.
      const alvo = asString(raw, key, origin);
      if (!(VISION_AIMS as readonly string[]).includes(alvo)) {
        throw new ConfigError(`${key} (${origin}) desconhecido: ${alvo}`, {
          field: key,
          origin,
          known: [...VISION_AIMS],
        });
      }
      cfg.vision_aim = alvo as AimMode;
      break;
    }
    case "vision_refine_factor":
      // Piso 1.2: recorte quase do tamanho da caixa não deixa contexto nenhum e
      // o modelo perde a referência que o faz reconhecer o alvo. Teto 6: acima
      // disso o recorte tende ao viewport inteiro e a 2ª passada repete a 1ª.
      cfg.vision_refine_factor = asFraction(raw, key, origin, 1.2, 6);
      break;
    case "providers_base_url":
      cfg.providers_base_url = asString(raw, key, origin);
      break;
    case "providers_allow_remote":
      cfg.providers_allow_remote = asBool(raw, key, origin);
      break;
    default:
      return false;
  }
  cfg.sources[key] = origin;
  return true;
}

/** Hosts aceitos sem consentimento explícito. `0.0.0.0` fica de fora de propósito. */
const PROVIDER_LOOPBACK: readonly string[] = Object.freeze(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function validarBaseDeProviders(raw: string, allowRemote: boolean, origin: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`providers_base_url (${origin}) não é URL: ${JSON.stringify(raw)}`, { origin, raw });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ConfigError(`providers_base_url (${origin}) deve usar http ou https`, { origin, protocol: u.protocol });
  }
  if (!allowRemote && !PROVIDER_LOOPBACK.includes(u.hostname)) {
    throw new ConfigError(
      `providers_base_url (${origin}) fora do loopback: ${u.hostname} — ligue providers_allow_remote conscientemente`,
      { origin, hostname: u.hostname, loopback: [...PROVIDER_LOOPBACK] },
    );
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export function loadConfig(opts: LoadConfigOptions = {}): DaemonConfig {
  const env = opts.env ?? process.env;
  const cfg = baseDefaults();
  // Proveniência inicial no MESMO vocabulário de `applyKey`: chaves de topo E
  // achatadas. Antes, `viewport.width` nascia SEM proveniência — `sources` só
  // ganhava a entrada depois que alguém a configurava, e "de onde veio a
  // largura?" só tinha resposta quando a resposta não era "de fábrica". Um
  // registro de proveniência com buraco é pior que nenhum: ele parece completo.
  for (const k of Object.keys(cfg)) {
    if (k === "sources") continue;
    cfg.sources[k] = "default";
    const v = (cfg as unknown as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const sub of Object.keys(v as Record<string, unknown>)) cfg.sources[`${k}.${sub}`] = "default";
    }
  }

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
    // FASE 17 — DEFEITO CORRIGIDO: o retorno de `applyKey` era descartado aqui.
    // Uma entrada de `ENV_KEYS` que `applyKey` não trata fazia o operador
    // exportar a variável, o daemon subir, e NADA acontecer — sem erro, sem
    // aviso, sem proveniência. É a mesma família do `--token` silenciosamente
    // ignorado que sobreviveu a 551 testes verdes. Agora é erro de arranque:
    // a tabela e o `switch` divergirem é defeito do produto, não do operador.
    if (!applyKey(cfg, key, raw, `env:${varName}`)) {
      throw new ConfigError(
        `${varName} está declarada em ENV_KEYS mas a chave "${key}" não é aplicável — tabela e applyKey divergiram`,
        { key, env: varName },
      );
    }
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
      // null explícito zera raízes opcionais (upload/download/profiles/sessions)
      // e DESLIGA providers. "Sem provider" é uma escolha legítima e precisa ser
      // dizível por override — é assim que um teste garante que o daemon subiu
      // sem falar com LLM nenhum, mesmo com o ambiente do operador configurado.
      if (
        k === "profiles_root" ||
        k === "upload_root" ||
        k === "download_root" ||
        k === "sessions_root" ||
        k === "tasks_root" ||
        k === "ai_provider" ||
        k === "ai_provider_fallback" ||
        k === "ai_think" ||
        k === "vision_provider"
      ) {
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

  // Loopback do backend de modelos, checado AQUI e não só na construção do
  // provider: o prompt de um `browser.task` e o SCREENSHOT da sessão autenticada
  // do dono são o que viaja nesse endereço. Sair da máquina é exfiltração, e
  // exfiltração não acontece por default de configuração.
  validarBaseDeProviders(cfg.providers_base_url, cfg.providers_allow_remote, cfg.sources.providers_base_url ?? "default");

  // Base maior que o teto faria o backoff ser SEMPRE o teto: a configuração
  // diria "cresça exponencialmente" e o comportamento seria constante. Recusar é
  // melhor que aceitar uma config cujo efeito é o oposto do que ela declara.
  if (cfg.task_retry_base_ms > cfg.task_retry_max_ms) {
    throw new ConfigError("task_retry_base_ms maior que task_retry_max_ms: o backoff nunca cresceria", {
      task_retry_base_ms: cfg.task_retry_base_ms,
      task_retry_max_ms: cfg.task_retry_max_ms,
    });
  }
  // Prazo de passo maior que o da task inteira torna o prazo de passo inalcançável.
  if (cfg.task_step_timeout_ms > cfg.task_total_timeout_ms) {
    throw new ConfigError("task_step_timeout_ms maior que task_total_timeout_ms", {
      task_step_timeout_ms: cfg.task_step_timeout_ms,
      task_total_timeout_ms: cfg.task_total_timeout_ms,
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// FASE 17 — SCHEMA DE CONFIGURAÇÃO
//
// POR QUE ISTO MORA AQUI, e não num arquivo de documentação separado:
//
// Uma tabela de configuração escrita à mão em outro arquivo diverge do código no
// primeiro dia — alguém acrescenta uma chave em `applyKey`, esquece a tabela, e
// a documentação passa a descrever um produto que não existe. Então a única
// coisa DECLARADA aqui é o que o código não sabe dizer sozinho: o TIPO, a FAIXA
// (que hoje só existe dentro de um `asInt(...)`), a SENSIBILIDADE e o resumo.
//
// Tudo o mais é LIDO do próprio módulo, nunca redigitado:
//
//   default → `baseDefaults()`, o mesmo objeto que o daemon usa ao subir
//   env     → `ENV_KEYS`, a mesma tabela que `loadConfig` percorre
//   enums   → `NAMED_POLICIES`, `RAW_WEB_CONTENT_POLICIES`, `VISION_AIMS`
//   tetos   → as constantes importadas (`MAX_VISION_REFINE_PASSES`, …)
//
// E `tests/config-schema.test.ts` fecha a última fresta: ele PROVA a faixa
// declarada empurrando `min-1` e `max+1` contra `applyKey` e exigindo recusa, e
// PROVA a env aplicando `exemplo` por variável de ambiente e exigindo que a
// proveniência saia `env:<VAR>`. Faixa mentirosa e env não tratada param de ser
// possíveis — não por disciplina, por instrumento.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfigTipo = "string" | "boolean" | "inteiro" | "fracao" | "caminho" | "enum" | "provider-ref" | "url";

export interface ConfigKeySpec {
  tipo: ConfigTipo;
  /** Limites INCLUSIVOS de `asInt`/`asFraction`. Provados por `config-schema.test.ts`. */
  min?: number;
  max?: number;
  /** Enum fechado. Vem da constante do módulo dono, nunca redigitado. */
  valores?: readonly string[];
  /** Valor VÁLIDO. O teste o usa para provar que `applyKey` trata a env desta chave. */
  exemplo: string;
  /**
   * Sai `[REDIGIDO]` de `GET /api/v1/config`. Ver `redigirConfig` para o critério.
   */
  sensivel: boolean;
  /** `null` é aceito (raiz opcional desligada, provider ausente). */
  anulavel?: boolean;
  resumo: string;
}

const POLITICAS = Object.freeze(Object.keys(NAMED_POLICIES));

/** Chave de configuração ACHATADA → forma. Mesmo espaço de chaves de `applyKey`. */
export const CONFIG_SCHEMA: Readonly<Record<string, ConfigKeySpec>> = Object.freeze({
  host: { tipo: "string", exemplo: "127.0.0.1", sensivel: false, resumo: "Endereço de bind do daemon. Loopback por default; sair dele é ato explícito." },
  port: { tipo: "inteiro", min: 0, max: 65535, exemplo: "7777", sensivel: false, resumo: "Porta HTTP. 0 = efêmera escolhida pelo SO." },
  version: { tipo: "string", exemplo: "0.2.0", sensivel: false, resumo: "Versão anunciada em /health. Lida do package.json da raiz; sem variável de ambiente de propósito — versão não se configura, se publica." },
  headless: { tipo: "boolean", exemplo: "true", sensivel: false, resumo: "Chromium sem janela. Default false: takeover humano precisa de janela visível." },
  "viewport.width": { tipo: "inteiro", min: 1, max: 20000, exemplo: "1440", sensivel: false, resumo: "Largura CSS do viewport." },
  "viewport.height": { tipo: "inteiro", min: 1, max: 20000, exemplo: "900", sensivel: false, resumo: "Altura CSS do viewport." },
  profiles_root: { tipo: "caminho", exemplo: "/tmp/nomos-perfis", sensivel: true, anulavel: true, resumo: "Raiz dos perfis persistentes do Chromium (cookies e sessão do dono)." },
  extension_dir: { tipo: "caminho", exemplo: "/tmp/nomos-extensao/dist", sensivel: true, anulavel: true, resumo: "Extensão descompactada carregada no Chromium do runtime (side panel NOMOS). null = nenhuma." },
  spotlight: { tipo: "boolean", exemplo: "true", sensivel: false, resumo: "Destaca o alvo NA página antes de clique/digitação. Default false: não altera latência medida sem pedido do dono." },
  spotlight_dwell_ms: { tipo: "inteiro", min: 0, max: 5000, exemplo: "220", sensivel: false, resumo: "Duração do destaque; o gesto espera esse tempo para o humano ver." },
  spotlight_color: { tipo: "string", exemplo: "var-da-marca", sensivel: false, anulavel: true, resumo: "Cor CSS do destaque. null ⇒ Highlight do sistema; o lançador injeta a cor do cofre." },
  max_workers: { tipo: "inteiro", min: 1, max: 1024, exemplo: "8", sensivel: false, resumo: "Teto de sessões vivas no pool." },
  max_concurrency: { tipo: "inteiro", min: 1, max: 1024, exemplo: "4", sensivel: false, resumo: "Ações simultâneas POR SESSÃO." },
  max_queue: { tipo: "inteiro", min: 0, max: 100000, exemplo: "64", sensivel: false, resumo: "Ações aguardando POR SESSÃO. Estourou ⇒ BACKPRESSURE_REJECTED." },
  action_timeout_ms: { tipo: "inteiro", min: 1, max: 3_600_000, exemplo: "30000", sensivel: false, resumo: "Prazo total por ação (fila + execução). Estourou ⇒ TIMEOUT." },
  observe_limit: { tipo: "inteiro", min: 1, max: 100000, exemplo: "200", sensivel: false, resumo: "Teto de elementos devolvidos por browser.observe." },
  event_buffer: { tipo: "inteiro", min: 0, max: 1_000_000, exemplo: "1000", sensivel: false, resumo: "Buffer circular do EventBus (reconexão de WebSocket)." },
  max_body_bytes: { tipo: "inteiro", min: 1, max: 268_435_456, exemplo: "1048576", sensivel: false, resumo: "Teto do corpo de requisição HTTP." },
  default_policy: { tipo: "enum", valores: POLITICAS, exemplo: "observe", sensivel: false, resumo: "Política de capacidades default. `full` não é dizível aqui de propósito." },
  allow_internal_urls: { tipo: "boolean", exemplo: "true", sensivel: false, resumo: "Permitir navegar em 127.0.0.1/rede interna (anti-SSRF). Default false." },
  allow_unleased: { tipo: "boolean", exemplo: "true", sensivel: false, resumo: "Operar sessão sem lease. Default false: quem cria a sessão vira dono no mesmo ato." },
  watchdog_enabled: { tipo: "boolean", exemplo: "false", sensivel: false, resumo: "Vigia interno. Default true — supervisor que nasce desligado é supervisor que ninguém liga." },
  watchdog_interval_ms: { tipo: "inteiro", min: 50, max: 3_600_000, exemplo: "5000", sensivel: false, resumo: "Período entre sondagens. Piso 50 ms: abaixo disso o vigia custa mais que o vigiado." },
  watchdog_max_restarts: { tipo: "inteiro", min: 0, max: 1000, exemplo: "3", sensivel: false, resumo: "Recuperações da MESMA falha antes de DEGRADAR (T10). 0 = detecta e reporta, nunca recupera." },
  watchdog_task_stall_ms: { tipo: "inteiro", min: 100, max: 86_400_000, exemplo: "120000", sensivel: false, resumo: "Task RUNNING sem avançar checkpoint por mais que isto é task estagnada." },
  watchdog_worker_stall_ms: { tipo: "inteiro", min: 100, max: 86_400_000, exemplo: "60000", sensivel: false, resumo: "Ação em execução há mais que isto é worker preso." },
  upload_root: { tipo: "caminho", exemplo: "/tmp/nomos-upload", sensivel: true, anulavel: true, resumo: "Raiz permitida para upload. Fora dela ⇒ UPLOAD_DENIED." },
  download_root: { tipo: "caminho", exemplo: "/tmp/nomos-download", sensivel: true, anulavel: true, resumo: "Raiz permitida para download. Fora dela ⇒ DOWNLOAD_DENIED." },
  sessions_root: { tipo: "caminho", exemplo: "/tmp/nomos-sessoes", sensivel: true, anulavel: true, resumo: "Raiz do audit log JSONL e dos snapshots de sessão." },
  audit: { tipo: "boolean", exemplo: "false", sensivel: false, resumo: "Trilha de auditoria. Default true." },
  task_max_attempts: { tipo: "inteiro", min: 1, max: 100, exemplo: "3", sensivel: false, resumo: "Tentativas TOTAIS por passo, contando a primeira. 1 desliga a retentativa." },
  task_step_timeout_ms: { tipo: "inteiro", min: 1, max: 3_600_000, exemplo: "45000", sensivel: false, resumo: "Prazo de UM passo. Não pode ser maior que task_total_timeout_ms." },
  task_total_timeout_ms: { tipo: "inteiro", min: 1, max: 86_400_000, exemplo: "600000", sensivel: false, resumo: "Prazo da task inteira." },
  task_retry_base_ms: { tipo: "inteiro", min: 0, max: 3_600_000, exemplo: "500", sensivel: false, resumo: "Base do backoff exponencial. Não pode ser maior que task_retry_max_ms." },
  task_retry_max_ms: { tipo: "inteiro", min: 0, max: 3_600_000, exemplo: "30000", sensivel: false, resumo: "Teto do backoff exponencial." },
  task_recover_grace_ms: { tipo: "inteiro", min: 0, max: 3_600_000, exemplo: "30000", sensivel: false, resumo: "Janela para retomar task RECOVERING após crash. Passada ⇒ FAILED com razão." },
  tasks_root: { tipo: "caminho", exemplo: "/tmp/nomos-tasks", sensivel: true, anulavel: true, resumo: "Raiz dos arquivos de task. null ⇒ dentro de sessions_root." },
  raw_web_content: { tipo: "enum", valores: RAW_WEB_CONTENT_POLICIES, exemplo: "always", sensivel: false, resumo: "O que fazer com o texto CRU da web quando há injeção detectada." },
  scroll_into_view: { tipo: "boolean", exemplo: "false", sensivel: false, resumo: "Rolar o alvo para dentro do viewport antes do gesto. Default true." },
  stability_samples: { tipo: "inteiro", min: 2, max: 100, exemplo: "3", sensivel: false, resumo: "Amostras CONSECUTIVAS iguais da bounding box para declará-la assentada. Mínimo 2: com 1 não se compara nada." },
  stability_interval_ms: { tipo: "inteiro", min: 0, max: 10_000, exemplo: "50", sensivel: false, resumo: "Intervalo entre amostras de estabilização." },
  click_delivery_check: { tipo: "boolean", exemplo: "false", sensivel: false, resumo: "Exigir prova de que o evento de clique chegou ao alvo. Default true." },
  device_scale_factor: { tipo: "inteiro", min: 1, max: 8, exemplo: "2", sensivel: false, resumo: "DPR do contexto do Chromium. 1 = tela comum, 2 = retina." },
  ai_provider: { tipo: "provider-ref", exemplo: "ollama:qwen2.5-coder:7b", sensivel: false, anulavel: true, resumo: '"<backend>:<modelo>". Default null: runtime não fala com LLM sem o dono pedir.' },
  ai_provider_fallback: { tipo: "provider-ref", exemplo: "ollama:qwen2.5-coder:7b", sensivel: false, anulavel: true, resumo: "Secundário acionado só em DEGRADAÇÃO do principal. Nunca em cancelamento." },
  ai_timeout_ms: { tipo: "inteiro", min: 1, max: 3_600_000, exemplo: "120000", sensivel: false, resumo: "Prazo de uma inferência de texto." },
  ai_think: { tipo: "boolean", exemplo: "false", sensivel: false, anulavel: true, resumo: "`think` do backend. null = deixa o provider decidir." },
  vision_provider: { tipo: "provider-ref", exemplo: "ollama:qwen2.5vl:3b", sensivel: false, anulavel: true, resumo: "Ausente ⇒ degrau `vision` PULADO, com razão registrada." },
  vision_timeout_ms: { tipo: "inteiro", min: 1, max: 3_600_000, exemplo: "20000", sensivel: false, resumo: "Prazo de uma inferência de visão." },
  vision_min_confidence: { tipo: "fracao", min: 0, max: 1, exemplo: "0.7", sensivel: false, resumo: "Abaixo disto a visão é descartada como palpite." },
  vision_refine_passes: { tipo: "inteiro", min: 0, max: MAX_VISION_REFINE_PASSES, exemplo: "2", sensivel: false, resumo: "Passadas de refino por recorte. Default 0 POR MEDIÇÃO (ver target.ts)." },
  vision_refine_factor: { tipo: "fracao", min: 1.2, max: 6, exemplo: "2.5", sensivel: false, resumo: "Lado do recorte = maior lado da caixa grosseira × isto." },
  vision_aim: { tipo: "enum", valores: VISION_AIMS, exemplo: "box_center", sensivel: false, resumo: "Onde mirar dentro do que a visão devolveu." },
  providers_base_url: { tipo: "url", exemplo: "http://127.0.0.1:11434", sensivel: true, resumo: "Backend dos providers. Loopback obrigatório salvo providers_allow_remote." },
  providers_allow_remote: { tipo: "boolean", exemplo: "true", sensivel: false, resumo: "Consentimento explícito para mandar prompt e SCREENSHOT para fora desta máquina." },
});

/** Uma linha do schema legível: forma + default REAL + env REAL. */
export interface ConfigSchemaEntry {
  chave: string;
  tipo: ConfigTipo;
  /** Valor de fábrica LIDO de `baseDefaults()`. Não é o valor efetivo do daemon. */
  default: unknown;
  /** "0..65535", "box_center|point|point_then_box" ou null quando não há restrição. */
  faixa: string | null;
  /** Variável de ambiente, LIDA de `ENV_KEYS`. null = chave não configurável por env. */
  env: string | null;
  sensivel: boolean;
  anulavel: boolean;
  exemplo: string;
  resumo: string;
}

/** Lê o default achatado de uma chave a partir do objeto de defaults. */
function defaultAchatado(d: DaemonConfig, chave: string): unknown {
  const ponto = chave.indexOf(".");
  if (ponto < 0) return (d as unknown as Record<string, unknown>)[chave];
  const pai = (d as unknown as Record<string, unknown>)[chave.slice(0, ponto)];
  return pai !== null && typeof pai === "object" ? (pai as Record<string, unknown>)[chave.slice(ponto + 1)] : undefined;
}

function faixaDe(spec: ConfigKeySpec): string | null {
  if (spec.valores !== undefined) return spec.valores.join("|");
  if (spec.min !== undefined && spec.max !== undefined) return `${spec.min}..${spec.max}`;
  if (spec.tipo === "boolean") return "true|false|1|0|yes|no|on|off";
  if (spec.tipo === "provider-ref") return `${PROVIDER_BACKENDS.join("|")}:<modelo>`;
  if (spec.tipo === "url") return "http|https, loopback salvo providers_allow_remote";
  return null;
}

/**
 * O schema COMPLETO, montado na hora a partir do código vivo.
 *
 * Nada aqui é uma cópia: `default` sai de `baseDefaults()` e `env` sai de
 * `ENV_KEYS`. Se alguém acrescentar uma chave e esquecer o `CONFIG_SCHEMA`,
 * quem denuncia é `tests/config-schema.test.ts`, não este getter — porque um
 * getter que "conserta" a lacuna sozinho esconderia a lacuna.
 */
export function configSchema(): ConfigSchemaEntry[] {
  const d = baseDefaults();
  return Object.entries(CONFIG_SCHEMA)
    .map(([chave, spec]) => ({
      chave,
      tipo: spec.tipo,
      default: defaultAchatado(d, chave),
      faixa: faixaDe(spec),
      env: ENV_KEYS[chave] ?? null,
      sensivel: spec.sensivel,
      anulavel: spec.anulavel === true,
      exemplo: spec.exemplo,
      resumo: spec.resumo,
    }))
    .sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * REDAÇÃO — o critério, e por que ele é este.
 *
 * Não há token nesta estrutura: a credencial do daemon vive no `AuthManager` e
 * nunca entra em `DaemonConfig`. Então o que há para proteger não é segredo
 * clássico, e sim duas coisas que uma resposta de API entregaria de graça:
 *
 *  1. AS RAÍZES (`profiles_root`, `upload_root`, `download_root`, `sessions_root`,
 *     `tasks_root`). São caminhos ABSOLUTOS na máquina do dono. Publicá-los
 *     entrega o nome da conta (`/Users/<fulano>/…`) e o lugar exato onde moram
 *     os perfis do Chromium — que carregam COOKIE de sessão autenticada — e a
 *     trilha de auditoria, que é justamente o que um atacante quer localizar
 *     para adulterar. É reconhecimento pronto para travessia de caminho.
 *     Decisão: REDIGIR.
 *
 *  2. `providers_base_url`. Uma URL aceita `usuario:senha@host` no userinfo, e
 *     mesmo sem credencial ela nomeia o endpoint interno que recebe prompt e
 *     SCREENSHOT da sessão do dono. Decisão: REDIGIR.
 *
 * `host` e `port` NÃO são redigidos: quem recebeu esta resposta já falou com
 * eles. Redigir o que o cliente acabou de usar é teatro.
 *
 * `null` continua `null`, e isso é deliberado: ausência não é segredo, e trocar
 * `null` por `[REDIGIDO]` faria a resposta mentir sobre a raiz estar desligada —
 * exatamente a pergunta que alguém faz ao diagnosticar "por que não há trilha?".
 */
export const REDACAO = "[REDIGIDO]";

export function redigirConfig(cfg: DaemonConfig): Record<string, unknown> {
  const saida = describeConfig(cfg);
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (!spec.sensivel) continue;
    // Chave achatada sensível dentro de objeto não existe hoje (só `viewport`,
    // que não é sensível); se passar a existir, o teste de divergência acusa.
    if (chave.includes(".")) continue;
    if (saida[chave] === null || saida[chave] === undefined) continue;
    saida[chave] = REDACAO;
  }
  return saida;
}

/**
 * Aplica UMA chave sobre os defaults, isolada.
 *
 * Existe para o verificador de schema poder provar a FAIXA de cada chave sem
 * esbarrar nas validações CRUZADAS de `loadConfig` (base > teto do backoff,
 * passo > total): elas são regras de coerência entre campos e responderiam
 * "inválido" pelo motivo errado, o que faria o teste passar sem provar nada.
 */
export function aplicarChaveIsolada(chave: string, bruto: unknown, origem = "probe"): DaemonConfig {
  const cfg = baseDefaults();
  if (!applyKey(cfg, chave, bruto, origem)) {
    throw new ConfigError(`chave de configuração desconhecida: ${chave}`, { key: chave });
  }
  return cfg;
}

/** Tabela markdown do schema. Renderizador ÚNICO: a rota, o script e o doc gerado usam este. */
export function configSchemaMarkdown(): string {
  const linhas: string[] = [];
  const esc = (s: string): string => s.replace(/\|/g, "\\|");
  const mostra = (v: unknown): string => (v === null ? "`null`" : `\`${String(v)}\``);

  linhas.push("# Configuração do NOMOS Browser Runtime");
  linhas.push("");
  linhas.push("<!-- ARQUIVO GERADO por `node scripts/config-schema.ts --markdown`. Não edite à mão. -->");
  linhas.push("<!-- A fonte é `packages/api/src/config.ts`; `tests/config-schema.test.ts` impede divergência. -->");
  linhas.push("");
  linhas.push(`Precedência: **defaults → arquivo → variáveis de ambiente → overrides do código**.`);
  linhas.push("Nenhuma coerção silenciosa: valor fora da faixa lança `ConfigError` no arranque, com campo, origem e faixa na mensagem.");
  linhas.push("");
  linhas.push("Coluna **sensível**: sai `[REDIGIDO]` em `GET /api/v1/config`. Ver `redigirConfig` para o critério.");
  linhas.push("");
  linhas.push("| chave | tipo | default | faixa / valores | variável de ambiente | sensível | resumo |");
  linhas.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const e of configSchema()) {
    linhas.push(
      `| \`${e.chave}\` | ${e.tipo}${e.anulavel ? " ou `null`" : ""} | ${mostra(e.default)} | ${e.faixa === null ? "—" : `\`${esc(e.faixa)}\``} | ${e.env === null ? "—" : `\`${e.env}\``} | ${e.sensivel ? "**sim**" : "não"} | ${esc(e.resumo)} |`,
    );
  }
  linhas.push("");
  linhas.push("## Variáveis de ambiente");
  linhas.push("");
  linhas.push("Toda variável abaixo é suportada, tem default, tem validação e recusa valor inválido com mensagem nomeando campo, origem e faixa.");
  linhas.push("");
  linhas.push("| variável | chave | default | faixa / valores | exemplo válido |");
  linhas.push("| --- | --- | --- | --- | --- |");
  for (const e of configSchema()) {
    if (e.env === null) continue;
    linhas.push(
      `| \`${e.env}\` | \`${e.chave}\` | ${mostra(e.default)} | ${e.faixa === null ? "—" : `\`${esc(e.faixa)}\``} | \`${esc(e.exemplo)}\` |`,
    );
  }
  linhas.push("");
  linhas.push("Além destas, `NOMOS_BROWSER_CONFIG` aponta para o arquivo de configuração; declarada e ausente é **erro de arranque**, nunca fallback silencioso para os defaults.");
  linhas.push("");
  return linhas.join("\n");
}
