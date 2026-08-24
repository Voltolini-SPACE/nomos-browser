/**
 * FASE 6 — `ScriptedProvider`: `AIProvider` determinístico.
 *
 * Existe para que teste de RUNTIME não vire teste de LLM. Um teste que depende
 * de modelo generativo mede duas coisas ao mesmo tempo e não sabe qual falhou;
 * pior, fica vermelho quando a máquina está sob pressão de memória — e um teste
 * que falha por motivo alheio ensina o time a ignorar teste vermelho.
 *
 * Determinismo aqui significa: **mesma entrada ⇒ mesma saída, sempre**. Não há
 * contador que altere a resposta, não há sorteio, não há fila que se consome. As
 * regras são casadas na ordem declarada e a primeira que casa vence. `calls`
 * registra o que passou, mas registrar não muda o que é devolvido.
 *
 * O que este provider NÃO faz de propósito:
 *   - não simula latência (`sleep` como mecanismo é proibido na missão; timeout
 *     é provado contra um servidor HTTP real que não responde);
 *   - não inventa contagem de token: sem backend, `usage` é `unavailable` com
 *     campos `null`, e não `0`;
 *   - não escapa das invariantes de `aiprovider.ts` — passa por `settleResponse`
 *     como qualquer outro provider, então `reply:""` vira `EMPTY_OUTPUT` e não
 *     um sucesso vazio.
 */
import {
  AIProviderError,
  aiFail,
  aiTimer,
  newRequestId,
  settleResponse,
  validateAIRequest,
  type AICapability,
  type AIErrorCode,
  type AIFinishReason,
  type AIHealth,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIUsage,
} from "../aiprovider.ts";
import { nowIso } from "../contract.ts";

export const SCRIPTED_DEFAULT_MODEL = "scripted-v1";

export interface ScriptedRule {
  /**
   * Casa contra o prompt. `string` = substring; `RegExp` = teste.
   * Ausente = casa com tudo (útil como última regra).
   */
  match?: string | RegExp;
  /** Texto devolvido. `""` é legítimo e produz `EMPTY_OUTPUT`. */
  reply?: string;
  /** Se presente, a regra produz erro em vez de texto. */
  error?: { code: AIErrorCode; message: string; detail?: Record<string, unknown> };
  usage?: AIUsage;
  finish_reason?: AIFinishReason;
}

export interface ScriptedCall {
  request_id: string;
  prompt: string;
  system: string | null;
  format: "text" | "json";
  matched: number | null;
  at: string;
}

export interface ScriptedProviderOptions {
  model?: string;
  /** Sobrescreve o id derivado. Use só quando o teste precisa de colisão. */
  provider_id?: string;
  capabilities?: readonly AICapability[];
  rules?: readonly ScriptedRule[];
  /** Resposta quando nenhuma regra casa. */
  default_reply?: string;
  /**
   * Sem regra e sem `default_reply`. `error` (padrão) é fail closed: um prompt
   * não previsto pelo teste tem de aparecer como falha, não como eco plausível.
   */
  on_unmatched?: "error" | "echo";
  /** Estado devolvido por `health()`. */
  health_status?: AIHealth["status"];
  model_present?: boolean;
  health_reason?: string | null;
}

export function scriptedProviderId(model: string): string {
  if (typeof model !== "string" || model.length === 0) {
    throw new AIProviderError("INVALID_REQUEST", "modelo scriptado exige nome não vazio");
  }
  return `scripted:${model}`;
}

function ruleMatches(rule: ScriptedRule, prompt: string): boolean {
  if (rule.match === undefined) return true;
  if (typeof rule.match === "string") return prompt.includes(rule.match);
  // `lastIndex` de regex global tornaria o casamento dependente de chamadas
  // anteriores — exatamente o não-determinismo que este provider existe para
  // não ter. Testa numa cópia sem estado.
  const re = new RegExp(rule.match.source, rule.match.flags.replace(/[gy]/g, ""));
  return re.test(prompt);
}

export class ScriptedProvider implements AIProvider {
  readonly provider_id: string;
  readonly model: string;
  readonly capabilities: readonly AICapability[];
  readonly rules: readonly ScriptedRule[];
  readonly calls: ScriptedCall[] = [];
  readonly #defaultReply: string | undefined;
  readonly #onUnmatched: "error" | "echo";
  readonly #healthStatus: AIHealth["status"];
  readonly #modelPresent: boolean;
  readonly #healthReason: string | null;

  constructor(opts: ScriptedProviderOptions = {}) {
    this.model = opts.model ?? SCRIPTED_DEFAULT_MODEL;
    this.provider_id = opts.provider_id ?? scriptedProviderId(this.model);
    this.capabilities = Object.freeze([...(opts.capabilities ?? ["text", "chat", "json"])]);
    this.rules = Object.freeze([...(opts.rules ?? [])]);
    this.#defaultReply = opts.default_reply;
    this.#onUnmatched = opts.on_unmatched ?? "error";
    this.#healthStatus = opts.health_status ?? "ok";
    this.#modelPresent = opts.model_present ?? this.#healthStatus !== "down";
    this.#healthReason = opts.health_reason ?? null;
  }

  async health(): Promise<AIHealth> {
    const t = aiTimer();
    return {
      provider_id: this.provider_id,
      model: this.model,
      status: this.#healthStatus,
      model_present: this.#modelPresent,
      models: [this.model],
      models_total: 1,
      reason: this.#healthReason,
      latency_ms: t.ms(),
      checked_at: nowIso(),
    };
  }

  async request(ctx: AIRequest): Promise<AIResponse> {
    const request_id = newRequestId();
    const t = aiTimer();
    const ident = { provider_id: this.provider_id, model: this.model, request_id };

    const rejection = validateAIRequest(ctx, this.capabilities);
    if (rejection) {
      // Requisição inválida não entra em `calls`: ela não chegou ao "modelo".
      return aiFail({ ...ident, latency_ms: t.ms(), ...rejection });
    }

    let matched: number | null = null;
    for (let i = 0; i < this.rules.length; i += 1) {
      if (ruleMatches(this.rules[i], ctx.prompt)) {
        matched = i;
        break;
      }
    }

    this.calls.push({
      request_id,
      prompt: ctx.prompt,
      system: ctx.system ?? null,
      format: ctx.format ?? "text",
      matched,
      at: nowIso(),
    });

    if (matched !== null) {
      const rule = this.rules[matched];
      if (rule.error) {
        return aiFail({
          ...ident,
          latency_ms: t.ms(),
          code: rule.error.code,
          message: rule.error.message,
          detail: { ...(rule.error.detail ?? {}), rule: matched },
        });
      }
      return settleResponse({
        ...ident,
        latency_ms: t.ms(),
        text: rule.reply ?? "",
        usage: rule.usage,
        finish_reason: rule.finish_reason,
        meta: { model_echo: this.model, done_reason: "stop" },
      });
    }

    if (this.#defaultReply !== undefined) {
      return settleResponse({
        ...ident,
        latency_ms: t.ms(),
        text: this.#defaultReply,
        meta: { model_echo: this.model, done_reason: "stop" },
      });
    }

    if (this.#onUnmatched === "echo") {
      return settleResponse({
        ...ident,
        latency_ms: t.ms(),
        text: ctx.prompt,
        meta: { model_echo: this.model, done_reason: "stop" },
      });
    }

    return aiFail({
      ...ident,
      latency_ms: t.ms(),
      code: "UNSUPPORTED",
      message: "nenhuma regra do script casou com o prompt",
      // Sem o prompt aqui (I5): só o tamanho e quantas regras existiam.
      detail: { rules: this.rules.length, prompt_chars: ctx.prompt.length },
    });
  }

  /** Limpa só o registro de chamadas. As regras são imutáveis. */
  reset(): void {
    this.calls.length = 0;
  }

  /** Última chamada registrada, ou `null`. Conveniência para asserção. */
  lastCall(): ScriptedCall | null {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1] : null;
  }
}

/** Provider mínimo que sempre devolve o mesmo texto. */
export function constantProvider(reply: string, model = SCRIPTED_DEFAULT_MODEL): ScriptedProvider {
  return new ScriptedProvider({ model, default_reply: reply });
}
