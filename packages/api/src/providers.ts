/**
 * FASE 5 — FÁBRICA DE PROVIDERS DO RUNTIME
 *
 * O buraco que este arquivo fecha, medido antes de escrever uma linha:
 *
 *   grep -rn "VisionProvider" packages/api/src  →  0 ocorrências
 *   daemon.ts:284  const { agent = null, ... } = opts   // e main() nunca passa
 *
 * Ou seja: o degrau `vision` da cascata de alvo NUNCA executava em produção, e
 * o trace do próprio runtime dizia a verdade sem que ninguém agisse sobre ela —
 * `{"strategy":"vision","outcome":"skipped","reason":"nenhum VisionProvider
 * injetado"}`. O contrato existia, o provider existia, a cascata existia; o que
 * faltava era o fio entre a configuração e o runtime.
 *
 * Três regras que este módulo carrega:
 *
 *  1. DESLIGADO POR DEFAULT. `ai_provider` e `vision_provider` nulos ⇒ nada é
 *     construído. Um runtime que nasce falando com um LLM manda a página que o
 *     dono está vendo para um processo que ele não escolheu.
 *
 *  2. CANCELAR É ORDEM, NÃO FALHA. `ABORTED` jamais aciona o fallback. Um
 *     roteador que "tenta de novo no secundário" depois de um cancelamento
 *     transforma o `AbortSignal` em sugestão — e faz o runtime rodar trabalho
 *     que o dono acabou de mandar parar.
 *
 *  3. DEGRADAÇÃO DEIXA RASTRO. Toda troca para o secundário emite
 *     `provider.degraded` na trilha. Fallback silencioso é a pior forma de
 *     mentira operacional: o sistema continua respondendo, com outro modelo,
 *     outra qualidade e outro custo, e ninguém fica sabendo.
 */
import {
  AIProviderError,
  NO_META,
  NO_USAGE,
  newRequestId,
  aiTimer,
  type AICapability,
  type AIError,
  type AIErrorCode,
  type AIHealth,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from "../../core/src/aiprovider.ts";
import { OllamaProvider } from "../../core/src/providers/ollama.ts";
import { OllamaVisionProvider, type RichVisionProvider } from "../../core/src/vision.ts";
import { nowIso, type VisionProvider } from "../../core/src/contract.ts";
import { parseProviderRef, type DaemonConfig } from "./config.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Classificação de degradação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Códigos que significam "o backend principal não está entregando" — e só eles
 * autorizam o secundário.
 *
 * O que ficou de FORA, e por quê:
 *
 *   ABORTED        cancelamento é ordem do dono (regra 2 acima).
 *   INVALID_REQUEST/UNSUPPORTED  o erro é nosso, não do backend; repetir no
 *                  secundário só gastaria o dobro para errar igual.
 *   BAD_RESPONSE   o backend RESPONDEU — mal, mas respondeu. Trocar de modelo
 *                  não conserta JSON quebrado, e a FASE 5 pede que resposta
 *                  malformada seja CLASSIFICADA e não derrube nada; nunca pediu
 *                  que ela custasse uma segunda inferência.
 *   INTERNAL       defeito nosso; esconder atrás de fallback atrasa o conserto.
 */
export const CODIGOS_DE_DEGRADACAO: readonly AIErrorCode[] = Object.freeze([
  "TIMEOUT",
  "NETWORK",
  "EMPTY_OUTPUT",
  "MODEL_NOT_FOUND",
]);

/** HTTP 5xx é backend quebrado; 4xx é pedido errado e não vira fallback. */
export function ehDegradacao(err: AIError | null): boolean {
  if (err === null) return false;
  if (err.code === "HTTP_ERROR") {
    const status = err.detail?.status;
    return typeof status === "number" && status >= 500;
  }
  return CODIGOS_DE_DEGRADACAO.includes(err.code);
}

/** O que a trilha registra quando o principal cede o lugar. */
export interface Degradacao {
  provider_id: string;
  motivo: string;
  fallback_usado: boolean;
  code: AIErrorCode;
  fallback_provider_id: string | null;
  /** `null` quando não houve fallback a tentar. */
  fallback_ok: boolean | null;
  latency_ms: number;
}

export const MAX_DEGRADACOES_MEMORIZADAS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// RoutedAiProvider
// ─────────────────────────────────────────────────────────────────────────────

export interface RoutedAiProviderOptions {
  primary: AIProvider;
  fallback: AIProvider | null;
  /** Chamado a cada degradação. Nunca deve lançar — o roteador engole e segue. */
  onDegraded?: (d: Degradacao) => void;
}

/**
 * Um `AIProvider` que fala por dois.
 *
 * Não reescreve a `AIResponse` de quem respondeu: `provider_id` e `model` da
 * resposta continuam sendo os do backend que de fato produziu o texto. É essa
 * propriedade — e não um campo novo — que faz a auditoria conseguir dizer
 * "quem gerou isto" sem confiar em nada que o modelo diga de si mesmo.
 */
export class RoutedAiProvider implements AIProvider {
  readonly provider_id: string;
  readonly model: string;
  readonly capabilities: readonly AICapability[];
  readonly primary: AIProvider;
  readonly fallback: AIProvider | null;
  /** Histórico curto para teste e diagnóstico. Nunca contém prompt (I5). */
  readonly degradacoes: Degradacao[] = [];
  readonly #onDegraded: ((d: Degradacao) => void) | undefined;

  constructor(opts: RoutedAiProviderOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.#onDegraded = opts.onDegraded;
    this.provider_id =
      opts.fallback === null
        ? opts.primary.provider_id
        : `routed:${opts.primary.provider_id}|${opts.fallback.provider_id}`;
    this.model = opts.primary.model;
    // INTERSEÇÃO, não união. Declarar uma capability que só o principal tem
    // faria o chamador pedir `format:"json"` e receber do secundário um erro
    // `UNSUPPORTED` — exatamente no momento em que o principal já caiu.
    const doFallback = new Set(opts.fallback?.capabilities ?? opts.primary.capabilities);
    this.capabilities = Object.freeze(opts.primary.capabilities.filter((c) => doFallback.has(c)));
  }

  #registrar(d: Degradacao): void {
    this.degradacoes.push(d);
    if (this.degradacoes.length > MAX_DEGRADACOES_MEMORIZADAS) this.degradacoes.shift();
    try {
      this.#onDegraded?.(d);
    } catch {
      // Trilha quebrada não pode derrubar a inferência — mas também não some:
      // `degradacoes` continua tendo o registro em memória.
    }
  }

  async request(ctx: AIRequest): Promise<AIResponse> {
    const primeira = await this.primary.request(ctx);
    if (primeira.ok) return primeira;

    // Cancelamento NUNCA vira fallback. Duas checagens porque são dois fatos
    // distintos: o provider classificou o erro como ABORTED, ou o sinal do
    // chamador já está abortado (provider que classificou mal não ganha o
    // direito de fazer o runtime desobedecer).
    if (primeira.error?.code === "ABORTED" || ctx.signal?.aborted === true) return primeira;

    if (!ehDegradacao(primeira.error)) return primeira;

    const motivo = primeira.error?.message ?? "sem mensagem";
    const code = primeira.error?.code ?? "INTERNAL";

    if (this.fallback === null) {
      // Degradação SEM secundário continua sendo degradação. Registrar só o
      // caso com fallback esconderia justamente a instalação de provider único,
      // que é a mais comum e a que mais precisa do aviso.
      this.#registrar({
        provider_id: this.primary.provider_id,
        motivo,
        fallback_usado: false,
        code,
        fallback_provider_id: null,
        fallback_ok: null,
        latency_ms: primeira.latency_ms,
      });
      return primeira;
    }

    const segunda = await this.fallback.request(ctx);
    this.#registrar({
      provider_id: this.primary.provider_id,
      motivo,
      fallback_usado: true,
      code,
      fallback_provider_id: this.fallback.provider_id,
      fallback_ok: segunda.ok,
      latency_ms: primeira.latency_ms + segunda.latency_ms,
    });
    // Se o secundário também falhou, devolvemos a falha DELE: é a última coisa
    // que de fato aconteceu, e o motivo do primeiro já está na trilha.
    return segunda;
  }

  async health(opts: { timeout_ms?: number; signal?: AbortSignal } = {}): Promise<AIHealth> {
    const t = aiTimer();
    const p = await this.primary.health(opts);
    if (this.fallback === null) return { ...p, provider_id: this.provider_id, latency_ms: t.ms() };
    const f = await this.fallback.health(opts);
    // Principal ok ⇒ ok. Principal fora mas secundário de pé ⇒ DEGRADED, não
    // "ok": o serviço responde, e responde pior. Os dois fora ⇒ down.
    const status: AIHealth["status"] = p.status === "ok" ? "ok" : f.status === "ok" ? "degraded" : "down";
    return {
      provider_id: this.provider_id,
      model: this.model,
      status,
      model_present: p.model_present || f.model_present,
      models: [...new Set([...p.models, ...f.models])],
      models_total: Math.max(p.models_total, f.models_total),
      reason:
        status === "ok"
          ? null
          : `principal(${p.provider_id})=${p.status}${p.reason === null ? "" : `: ${p.reason}`}; ` +
            `fallback(${f.provider_id})=${f.status}${f.reason === null ? "" : `: ${f.reason}`}`,
      latency_ms: t.ms(),
      checked_at: nowIso(),
    };
  }

  async release(): Promise<void> {
    // Libera OS DOIS. Descarregar só o principal deixaria o secundário residente
    // na RAM desta máquina — que é exatamente o cenário que mata os serviços de
    // produção por jetsam quando dois modelos coexistem.
    await this.primary.release?.().catch(() => undefined);
    await this.fallback?.release?.().catch(() => undefined);
  }
}

/** Resposta sintética para quando não há provider nenhum a chamar. */
export function respostaSemProvider(request_id = newRequestId()): AIResponse {
  return {
    ok: false,
    request_id,
    provider_id: "none",
    model: "none",
    text: "",
    usage: NO_USAGE,
    latency_ms: 0,
    finish_reason: "error",
    error: { code: "UNSUPPORTED", message: "nenhum AIProvider configurado" },
    created_at: nowIso(),
    meta: NO_META,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fábricas
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildProviderOptions {
  onDegraded?: (d: Degradacao) => void;
  /** Injeção de `fetch` para teste — nunca usada em produção. */
  fetchImpl?: typeof fetch;
}

function construirUm(ref: string, campo: string, cfg: DaemonConfig, opts: BuildProviderOptions): AIProvider {
  const { backend, model } = parseProviderRef(ref, campo, cfg.sources[campo] ?? "config");
  switch (backend) {
    case "ollama":
      return new OllamaProvider({
        model,
        base_url: cfg.providers_base_url,
        timeout_ms: cfg.ai_timeout_ms,
        allow_remote: cfg.providers_allow_remote,
        // `keep_alive: 0` NÃO é default aqui de propósito: quem opera decide se
        // paga carga fria a cada chamada. O que esta máquina exige está em
        // `scripts/lib-memoria.sh`, e é o teste que o aplica — não o produto.
        ...(cfg.ai_think !== null ? { think: cfg.ai_think } : {}),
        ...(opts.fetchImpl !== undefined ? { fetch: opts.fetchImpl as never } : {}),
      });
    default: {
      // Inalcançável enquanto `PROVIDER_BACKENDS` tiver só `ollama`; existe para
      // que ADICIONAR um backend à lista sem implementá-lo aqui quebre alto.
      const _exaustivo: never = backend;
      throw new AIProviderError("UNSUPPORTED", `backend sem implementação: ${String(_exaustivo)}`);
    }
  }
}

/**
 * `AIProvider` do runtime, já roteado, ou `null` quando o dono não pediu.
 *
 * Lança `ConfigError` (via `parseProviderRef`) em identificador inválido — no
 * ARRANQUE, que é onde o dono ainda está olhando.
 */
export function buildAiProvider(cfg: DaemonConfig, opts: BuildProviderOptions = {}): AIProvider | null {
  if (cfg.ai_provider === null) return null;
  const primary = construirUm(cfg.ai_provider, "ai_provider", cfg, opts);
  const fallback =
    cfg.ai_provider_fallback === null ? null : construirUm(cfg.ai_provider_fallback, "ai_provider_fallback", cfg, opts);
  // Sem secundário o roteador seria uma camada que não roteia. Devolver o
  // provider cru mantém `provider_id` igual ao do backend e uma indireção a menos.
  if (fallback === null && opts.onDegraded === undefined) return primary;
  return new RoutedAiProvider({
    primary,
    fallback,
    ...(opts.onDegraded !== undefined ? { onDegraded: opts.onDegraded } : {}),
  });
}

/** `VisionProvider` do runtime, ou `null` quando o dono não pediu. */
export function buildVisionProvider(cfg: DaemonConfig, opts: BuildProviderOptions = {}): RichVisionProvider | null {
  if (cfg.vision_provider === null) return null;
  const { backend, model } = parseProviderRef(
    cfg.vision_provider,
    "vision_provider",
    cfg.sources.vision_provider ?? "config",
  );
  switch (backend) {
    case "ollama":
      return new OllamaVisionProvider({
        model,
        endpoint: cfg.providers_base_url,
        timeout_ms: cfg.vision_timeout_ms,
        allow_remote: cfg.providers_allow_remote,
        // A política de refino viaja NO PROVIDER: é ele que o resolvedor de alvo
        // consulta (`ComPoliticaDeRefino` em `target.ts`). Sem isto as chaves
        // `vision_refine_*` seriam configuração morta.
        refine_passes: cfg.vision_refine_passes,
        refine_factor: cfg.vision_refine_factor,
        // Mesma razão: a mira (`point_then_box` por default, medida como a melhor
        // em 9/9 células) é decisão do dono, não constante de código. Sem esta
        // linha `vision_aim` seria configuração morta — o log da medição chegou a
        // denunciar exatamente isso: `aim=box_center ... mirou=point`.
        aim: cfg.vision_aim,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
    default: {
      const _exaustivo: never = backend;
      throw new AIProviderError("UNSUPPORTED", `backend de visão sem implementação: ${String(_exaustivo)}`);
    }
  }
}

/** Uma linha para stderr. Silêncio sobre qual modelo está ligado é inaceitável. */
export function descreverProviders(cfg: DaemonConfig, ai: AIProvider | null, vision: VisionProvider | null): string {
  const partes: string[] = [];
  partes.push(
    ai === null
      ? "sem AIProvider"
      : `AIProvider=${ai.provider_id}` +
          (cfg.ai_provider_fallback !== null ? ` (fallback ${cfg.ai_provider_fallback})` : "") +
          ` timeout=${cfg.ai_timeout_ms}ms`,
  );
  partes.push(
    vision === null
      ? "sem VisionProvider"
      : `VisionProvider=${vision.name}:${cfg.vision_provider?.split(":").slice(1).join(":") ?? "?"} ` +
          `min_conf=${cfg.vision_min_confidence} timeout=${cfg.vision_timeout_ms}ms`,
  );
  if (ai !== null || vision !== null) partes.push(`backend=${cfg.providers_base_url}`);
  return partes.join(" | ");
}
