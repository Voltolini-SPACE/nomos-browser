/**
 * FASE 7 — `OllamaProvider`: `AIProvider` sobre um backend Ollama LOCAL.
 *
 * Postura, herdada do SECURITY.md:
 *
 *   - Só loopback. Um backend de LLM remoto receberia o prompt inteiro, e o
 *     prompt é o lugar mais provável de carregar dado do dono. `base_url`
 *     não-loopback é recusada na construção, salvo `allow_remote` explícito —
 *     o mesmo padrão do `allow_internal` de `policy.ts`: flag do dono, nunca
 *     inferência.
 *   - Nenhum prompt em log, em `error.detail` ou em `meta` (I5 do aiprovider).
 *     O corpo de erro devolvido pelo backend é filtrado antes de virar detalhe:
 *     se o backend ecoar o prompt, o eco é descartado.
 *   - Modelo ausente é `degraded`, nunca exceção de construtor (I6). O dono tem
 *     de conseguir declarar o provider antes de o modelo existir na máquina.
 *
 * Latência: nesta máquina (16 GB, swap alto) um modelo de ~5 GB leva dezenas de
 * segundos para carregar na PRIMEIRA chamada. Por isso o timeout padrão é 180 s
 * e `latency_ms` é ponta a ponta — inclui a carga fria, e `meta.load_duration_ns`
 * permite separar as duas coisas depois.
 */
import {
  AIProviderError,
  aiFail,
  aiTimer,
  newRequestId,
  normalizeUsage,
  settleResponse,
  validateAIRequest,
  HEALTH_MODELS_SAMPLE,
  type AICapability,
  type AIFinishReason,
  type AIHealth,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from "../aiprovider.ts";
import { nowIso } from "../contract.ts";

export const OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434";
/** Carga fria de um modelo de ~5 GB nesta máquina. Não encolher sem medir. */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 180_000;
export const OLLAMA_HEALTH_TIMEOUT_MS = 5_000;
export const OLLAMA_RELEASE_TIMEOUT_MS = 30_000;
export const OLLAMA_ERROR_BODY_CHARS = 400;

/** Hosts aceitos sem `allow_remote`. `0.0.0.0` fica de fora de propósito. */
const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);

/** Nome de modelo do Ollama: `familia:tag`, com `/` para namespaces. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/;

/**
 * `provider_id` DERIVADO do modelo — não escolhido à mão. Dois modelos
 * diferentes no mesmo backend produzem ids diferentes por construção, que é o
 * que a auditoria usa para dizer quem gerou o quê.
 */
export function ollamaProviderId(model: string): string {
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    throw new AIProviderError("INVALID_REQUEST", "nome de modelo inválido para Ollama", {
      received: typeof model === "string" ? model.slice(0, 64) : typeof model,
    });
  }
  return `ollama:${model}`;
}

/** Normaliza e recusa base não-loopback. Devolve a base sem barra final. */
export function assertOllamaBase(raw: string, allowRemote = false): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AIProviderError("INVALID_REQUEST", "base_url inválida", { base_url: String(raw).slice(0, 120) });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AIProviderError("INVALID_REQUEST", "base_url deve usar http ou https", { protocol: u.protocol });
  }
  if (!allowRemote && !LOOPBACK_HOSTS.includes(u.hostname)) {
    throw new AIProviderError(
      "INVALID_REQUEST",
      "base_url do provider de modelo deve ser loopback; use allow_remote para sair disso conscientemente",
      { hostname: u.hostname },
    );
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Ficha declarada pelo backend em `/api/show`. Nada aqui vem do modelo. */
export interface OllamaModelCard {
  model: string;
  capabilities: string[];
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
}

export interface OllamaProviderOptions {
  model: string;
  base_url?: string;
  timeout_ms?: number;
  health_timeout_ms?: number;
  /** Repassado ao backend. `0` descarrega assim que a resposta sai. */
  keep_alive?: string | number;
  /** Declaração do dono. `vision` NÃO é inferida do nome do modelo. */
  capabilities?: readonly AICapability[];
  allow_remote?: boolean;
  /**
   * Raciocínio interno do backend (campo `think` do Ollama).
   *
   * MEDIDO nesta máquina em 2026-08-24 com `qwen3.5:4b-q8_0`:
   *   sem `think`      → `response:""`, `thinking` com 24 tokens, `done_reason:"length"`
   *   com `think:false` → `response:"4"`, `eval_count:2`, `done_reason:"stop"`
   *
   * Ou seja: um modelo com raciocínio ligado e orçamento curto de tokens gasta
   * TUDO pensando e devolve resposta vazia. Deixar `undefined` mantém o padrão
   * do backend; `false` é o que se quer quando `max_tokens` é apertado.
   */
  think?: boolean;
  /** Injeção para teste. Padrão: `globalThis.fetch`. */
  fetch?: FetchLike;
}

interface FetchOutcome {
  /** `null` quando não houve resposta HTTP nenhuma. */
  status: number | null;
  ok: boolean;
  /** Corpo CRU, já lido dentro da janela de timeout. */
  body: string;
  /** Falha ao ler o corpo que não foi timeout nem abort (stream quebrado). */
  bodyError: string | null;
  errorCode: "TIMEOUT" | "ABORTED" | "NETWORK" | null;
  errorMessage: string;
}

/**
 * Faz a chamada com timeout e devolve o erro CLASSIFICADO em vez de lançar.
 * Distinguir TIMEOUT de NETWORK importa: um diz "a máquina está lenta", o outro
 * diz "não tem ninguém do outro lado". Tratar os dois como "falhou" apagaria o
 * único sinal útil.
 *
 * O CORPO é lido aqui dentro, com o timer ainda armado. Ler depois seria um
 * caminho sem teto: um backend que manda os cabeçalhos e depois trava no corpo
 * penduraria o chamador para sempre, porque o `AbortController` já teria sido
 * desarmado. Vale para `/api/generate` com `stream:false`, onde o corpo só
 * chega no fim da geração.
 */
async function fetchClassified(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    let body = "";
    let bodyError: string | null = null;
    try {
      body = await res.text();
    } catch (e) {
      // Timeout/abort durante a leitura sobe para o catch externo, que sabe
      // classificar. Só o resto vira `bodyError`.
      if (timedOut || ctrl.signal.aborted) throw e;
      bodyError = e instanceof Error ? e.message : String(e);
    }
    return { status: res.status, ok: res.ok, body, bodyError, errorCode: null, errorMessage: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const base = { status: null, ok: false, body: "", bodyError: null };
    if (timedOut) return { ...base, errorCode: "TIMEOUT", errorMessage: `timeout após ${timeoutMs} ms` };
    if (external?.aborted) return { ...base, errorCode: "ABORTED", errorMessage: "cancelado pelo chamador" };
    return { ...base, errorCode: "NETWORK", errorMessage: msg };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

/** Parse tolerante: devolve o valor OU a razão, nunca lança. */
function parseJson(body: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(body), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * O backend pode ecoar trecho do pedido na mensagem de erro. Se o prompt
 * aparecer ali, o corpo inteiro é descartado — melhor perder diagnóstico do que
 * gravar prompt num campo que vai para log e auditoria (I5).
 */
function safeErrorBody(body: string, prompt: string): string {
  const cut = body.slice(0, OLLAMA_ERROR_BODY_CHARS);
  if (prompt.length >= 8) {
    const head = prompt.slice(0, Math.min(48, prompt.length));
    if (cut.includes(head)) return "[corpo omitido: ecoava o prompt]";
  }
  return cut;
}

function finishFrom(doneReason: unknown): AIFinishReason {
  if (doneReason === "stop") return "stop";
  if (doneReason === "length") return "length";
  return "unknown";
}

function nsOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export class OllamaProvider implements AIProvider {
  readonly provider_id: string;
  readonly model: string;
  readonly capabilities: readonly AICapability[];
  readonly base_url: string;
  readonly timeout_ms: number;
  readonly health_timeout_ms: number;
  readonly keep_alive: string | number | undefined;
  readonly think: boolean | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: OllamaProviderOptions) {
    if (opts === null || typeof opts !== "object") {
      throw new AIProviderError("INVALID_REQUEST", "OllamaProvider exige opções");
    }
    // Deriva o id ANTES de qualquer outra coisa: nome de modelo inválido é erro
    // de programação do dono e tem de aparecer na construção.
    this.provider_id = ollamaProviderId(opts.model);
    this.model = opts.model;
    this.base_url = assertOllamaBase(opts.base_url ?? OLLAMA_DEFAULT_BASE, opts.allow_remote === true);
    this.timeout_ms = opts.timeout_ms ?? OLLAMA_DEFAULT_TIMEOUT_MS;
    this.health_timeout_ms = opts.health_timeout_ms ?? OLLAMA_HEALTH_TIMEOUT_MS;
    this.keep_alive = opts.keep_alive;
    this.think = opts.think;
    this.capabilities = Object.freeze([...(opts.capabilities ?? ["text", "chat", "json"])]);
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof f !== "function") {
      throw new AIProviderError("INTERNAL", "fetch indisponível neste runtime");
    }
    this.#fetch = f;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // health — nunca lança (I6)
  // ───────────────────────────────────────────────────────────────────────────

  async health(opts: { timeout_ms?: number; signal?: AbortSignal } = {}): Promise<AIHealth> {
    const t = aiTimer();
    const base = {
      provider_id: this.provider_id,
      model: this.model,
      models: [] as string[],
      models_total: 0,
      model_present: false,
    };
    const out = await fetchClassified(
      this.#fetch,
      `${this.base_url}/api/tags`,
      { method: "GET", headers: { accept: "application/json" } },
      opts.timeout_ms ?? this.health_timeout_ms,
      opts.signal,
    );
    if (out.errorCode !== null) {
      return {
        ...base,
        status: "down",
        reason: `backend inalcançável (${out.errorCode}): ${out.errorMessage}`,
        latency_ms: t.ms(),
        checked_at: nowIso(),
      };
    }
    if (!out.ok) {
      return {
        ...base,
        status: "down",
        reason: `backend respondeu HTTP ${out.status}`,
        latency_ms: t.ms(),
        checked_at: nowIso(),
      };
    }
    const parsedTags = parseJson(out.body);
    if (parsedTags.error !== null || out.bodyError !== null) {
      return {
        ...base,
        status: "down",
        reason: `/api/tags devolveu JSON inválido: ${out.bodyError ?? parsedTags.error}`,
        latency_ms: t.ms(),
        checked_at: nowIso(),
      };
    }
    const list = (parsedTags.value as { models?: unknown })?.models;
    if (!Array.isArray(list)) {
      return {
        ...base,
        status: "down",
        reason: "/api/tags não devolveu a lista `models`",
        latency_ms: t.ms(),
        checked_at: nowIso(),
      };
    }
    const names: string[] = [];
    for (const m of list) {
      const rec = m as Record<string, unknown>;
      if (typeof rec?.name === "string") names.push(rec.name);
      else if (typeof rec?.model === "string") names.push(rec.model);
    }
    const present = names.includes(this.model);
    return {
      provider_id: this.provider_id,
      model: this.model,
      status: present ? "ok" : "degraded",
      model_present: present,
      models: names.slice(0, HEALTH_MODELS_SAMPLE),
      models_total: names.length,
      // Backend vivo + modelo ausente = degradado. Não é `down` (o backend
      // responde) e não é `ok` (a requisição vai falhar).
      reason: present ? null : `modelo ausente no backend: ${this.model}`,
      latency_ms: t.ms(),
      checked_at: nowIso(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // request — nunca lança (I1)
  // ───────────────────────────────────────────────────────────────────────────

  async request(ctx: AIRequest): Promise<AIResponse> {
    const request_id = newRequestId();
    const t = aiTimer();
    const ident = { provider_id: this.provider_id, model: this.model, request_id };

    const rejection = validateAIRequest(ctx, this.capabilities);
    if (rejection) {
      return aiFail({ ...ident, latency_ms: t.ms(), ...rejection });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      prompt: ctx.prompt,
      stream: false,
    };
    if (ctx.system !== undefined) body.system = ctx.system;
    if (ctx.format === "json") body.format = "json";
    if (ctx.images && ctx.images.length > 0) body.images = [...ctx.images];
    if (this.keep_alive !== undefined) body.keep_alive = this.keep_alive;
    if (this.think !== undefined) body.think = this.think;
    const options: Record<string, unknown> = {};
    if (ctx.temperature !== undefined) options.temperature = ctx.temperature;
    if (ctx.max_tokens !== undefined) options.num_predict = ctx.max_tokens;
    if (ctx.seed !== undefined) options.seed = ctx.seed;
    if (ctx.stop !== undefined && ctx.stop.length > 0) options.stop = [...ctx.stop];
    if (Object.keys(options).length > 0) body.options = options;

    const out = await fetchClassified(
      this.#fetch,
      `${this.base_url}/api/generate`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ctx.timeout_ms ?? this.timeout_ms,
      ctx.signal,
    );

    if (out.errorCode !== null) {
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        code: out.errorCode,
        message: out.errorMessage,
        // Sem prompt aqui — só endereço e modelo.
        detail: { base_url: this.base_url, model: this.model },
      });
    }

    if (!out.ok) {
      const safe = safeErrorBody(out.body, ctx.prompt);
      // 404 do Ollama para modelo não puxado. Classificar como MODEL_NOT_FOUND
      // deixa o chamador distinguir "instale o modelo" de "o backend quebrou".
      const missing = out.status === 404 && /not found|no such model|pull/i.test(out.body);
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        code: missing ? "MODEL_NOT_FOUND" : "HTTP_ERROR",
        message: missing ? `modelo não encontrado no backend: ${this.model}` : `backend respondeu HTTP ${out.status}`,
        detail: { status: out.status, body: safe, model: this.model },
      });
    }

    if (out.bodyError !== null) {
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        code: "BAD_RESPONSE",
        message: `leitura do corpo falhou: ${out.bodyError}`,
        detail: { model: this.model },
      });
    }

    const parsedGen = parseJson(out.body);
    if (parsedGen.error !== null || parsedGen.value === null || typeof parsedGen.value !== "object") {
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        code: "BAD_RESPONSE",
        message: `resposta do backend não é JSON: ${parsedGen.error ?? "corpo não é objeto"}`,
        detail: { model: this.model },
      });
    }
    const parsed = parsedGen.value as Record<string, unknown>;

    if (typeof parsed?.error === "string") {
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        code: "BAD_RESPONSE",
        message: "backend devolveu erro no corpo",
        detail: { body: safeErrorBody(parsed.error, ctx.prompt), model: this.model },
      });
    }

    const text = typeof parsed?.response === "string" ? parsed.response : "";
    const usage = normalizeUsage({
      prompt_tokens: parsed?.prompt_eval_count,
      completion_tokens: parsed?.eval_count,
    });
    // `thinking` e `context` do Ollama NÃO atravessam esta fronteira.
    // `thinking` foi observado repetindo o prompt literalmente ("Input: ...") e
    // `context` é o prompt tokenizado — devolver qualquer um dos dois seria
    // reintroduzir o prompt na resposta que vai para log e auditoria (I5).
    const thinking = typeof parsed?.thinking === "string" ? parsed.thinking : "";
    const meta = {
      model_echo: typeof parsed?.model === "string" ? parsed.model : null,
      done_reason: typeof parsed?.done_reason === "string" ? parsed.done_reason : null,
      total_duration_ns: nsOrNull(parsed?.total_duration),
      load_duration_ns: nsOrNull(parsed?.load_duration),
      eval_duration_ns: nsOrNull(parsed?.eval_duration),
    };

    // Diagnóstico específico: houve geração, mas ela toda foi para o raciocínio
    // interno. Reportar só "saída vazia" mandaria o dono procurar no lugar
    // errado — o conserto é `think:false` ou mais `max_tokens`, não outro modelo.
    if (text.trim().length === 0 && thinking.length > 0) {
      return aiFail({
        ...ident,
        latency_ms: t.ms(),
        usage,
        meta,
        code: "EMPTY_OUTPUT",
        message:
          "modelo gastou o orçamento de tokens no raciocínio interno e não emitiu resposta; use think:false ou aumente max_tokens",
        detail: { thinking_chars: thinking.length, done_reason: meta.done_reason, model: this.model },
      });
    }

    // `settleResponse` decide `ok`. Texto vazio vira EMPTY_OUTPUT lá, não aqui —
    // a invariante tem um dono só.
    return settleResponse({
      ...ident,
      latency_ms: t.ms(),
      text,
      usage,
      finish_reason: finishFrom(parsed?.done_reason),
      meta,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ciclo de vida do modelo no backend
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Descarrega o modelo (`keep_alive: 0`). Nunca lança: é limpeza, e limpeza que
   * derruba o chamador é pior que limpeza que falha. Use `resident()` para
   * VERIFICAR que saiu — não confie no retorno desta chamada.
   */
  async release(): Promise<void> {
    await fetchClassified(
      this.#fetch,
      `${this.base_url}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, keep_alive: 0 }),
      },
      OLLAMA_RELEASE_TIMEOUT_MS,
    );
  }

  /**
   * Ficha do modelo declarada PELO BACKEND (`/api/show`). Não carrega o modelo,
   * então é barato e não compete por memória.
   *
   * Serve a dois propósitos:
   *   1. decidir `think` por evidência em vez de por lista chumbada no código —
   *      `capabilities` inclui `"thinking"` quando o modelo raciocina;
   *   2. dar à auditoria um discriminador de identidade que NÃO vem do modelo
   *      se auto-declarar. Medido em 2026-08-24:
   *        qwen3.5:4b-q8_0  → família `qwen35`, [completion, vision, tools, thinking]
   *        qwen2.5-coder:7b → família `qwen2`,  [completion, tools, insert]
   *
   * `null` = não deu para consultar. Não confundir com "modelo sem capacidades".
   */
  async describeModel(timeout_ms = OLLAMA_HEALTH_TIMEOUT_MS): Promise<OllamaModelCard | null> {
    const out = await fetchClassified(
      this.#fetch,
      `${this.base_url}/api/show`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model }),
      },
      timeout_ms,
    );
    if (out.errorCode !== null || !out.ok) return null;
    const { value, error } = parseJson(out.body);
    if (error !== null || value === null || typeof value !== "object") return null;
    const body = value as Record<string, unknown>;
    const caps = Array.isArray(body.capabilities)
      ? body.capabilities.filter((c): c is string => typeof c === "string")
      : [];
    const d = (body.details ?? {}) as Record<string, unknown>;
    return {
      model: this.model,
      capabilities: caps,
      family: typeof d.family === "string" ? d.family : null,
      parameter_size: typeof d.parameter_size === "string" ? d.parameter_size : null,
      quantization_level: typeof d.quantization_level === "string" ? d.quantization_level : null,
    };
  }

  /**
   * Modelos residentes agora (`/api/ps`). `null` = não deu para consultar —
   * distinto de `[]`, que afirma "nenhum residente". Confundir os dois faria um
   * backend morto parecer um backend limpo.
   */
  async resident(timeout_ms = OLLAMA_HEALTH_TIMEOUT_MS): Promise<string[] | null> {
    const out = await fetchClassified(
      this.#fetch,
      `${this.base_url}/api/ps`,
      { method: "GET", headers: { accept: "application/json" } },
      timeout_ms,
    );
    if (out.errorCode !== null || !out.ok) return null;
    const { value, error } = parseJson(out.body);
    if (error !== null) return null;
    const models = (value as { models?: unknown })?.models;
    if (!Array.isArray(models)) return null;
    return models
      .map((m) => (m as Record<string, unknown>)?.name)
      .filter((n): n is string => typeof n === "string");
  }

  /** Espera o modelo sumir de `/api/ps`. Condição verificável, não sleep cego. */
  async waitUnloaded(opts: { timeout_ms?: number; interval_ms?: number } = {}): Promise<boolean> {
    const deadline = Date.now() + (opts.timeout_ms ?? 20_000);
    const interval = opts.interval_ms ?? 500;
    for (;;) {
      const names = await this.resident();
      if (names !== null && !names.includes(this.model)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

/** Açúcar: um provider por modelo, ids derivados e distintos por construção. */
export function ollamaProviders(
  models: readonly string[],
  shared: Omit<OllamaProviderOptions, "model"> = {},
): OllamaProvider[] {
  return models.map((model) => new OllamaProvider({ ...shared, model }));
}
