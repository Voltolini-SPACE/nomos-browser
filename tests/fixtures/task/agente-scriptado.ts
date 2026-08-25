/**
 * FASE 9 — `AgentProvider` DETERMINÍSTICO para os testes do motor de task.
 *
 * POR QUE NÃO USAR UM LLM AQUI
 * ----------------------------
 * Um teste de motor de task que dependesse de modelo generativo mediria duas
 * coisas ao mesmo tempo e não saberia qual falhou — e ficaria vermelho quando a
 * máquina estivesse sob pressão de memória, ensinando o time a ignorar teste
 * vermelho. É a mesma razão pela qual `packages/core/src/providers/scripted.ts`
 * existe para o papel de MODELO; este arquivo faz o equivalente para o papel de
 * AGENTE (os cinco verbos de `AgentProvider`).
 *
 * O QUE ELE NÃO SIMULA — E ISSO É O PONTO
 * ---------------------------------------
 * O plano é scriptado. A EXECUÇÃO não é: `act()` chama a PRÓPRIA API do daemon
 * por loopback, autenticado, exatamente como o executor de produção
 * (`daemon.ts#executarPasso`) faz. Consequência: quando um passo falha nestes
 * testes, ele falha pelo motivo REAL —
 *
 *   CAPABILITY_DENIED   veio do `CapabilityEngine` de verdade;
 *   TARGET_NOT_FOUND    veio da cascata de resolução de verdade, contra o DOM;
 *   NAVIGATION_FAILED   veio de um socket que o servidor de fixture derrubou;
 *   TIMEOUT             veio de um servidor HTTP real que não responde.
 *
 * Nada disso é um `if (teste) return erro`. Um provider que fabricasse os
 * códigos de erro provaria apenas que a política de retentativa sabe ler o campo
 * que ela mesma escreveu.
 */
import {
  fail,
  timer,
  type ActionResponse,
  type AgentProvider,
  type Observation,
  type Plan,
  type PlanStep,
  type VerificationResult,
} from "../../../packages/core/src/contract.ts";

/**
 * Mesma tabela de `daemon.ts`. Duplicada de propósito: o teste não deve importar
 * um detalhe privado do daemon, e uma cópia que divergisse faria o teste passar
 * enquanto a produção quebra — então ela é curta e explícita.
 */
const CHAVE_DO_VALOR: Readonly<Record<string, string>> = Object.freeze({
  "browser.open": "url",
  "browser.goto": "url",
  "browser.type": "text",
  "browser.press": "key",
  "browser.wait": "value",
});

export interface RoteiroDeAgente {
  /** Passos do plano, na ordem. */
  steps: PlanStep[];
  goal?: string;
  constraints?: string[];
  success_conditions?: string[];
  failure_conditions?: string[];
}

export interface AgenteScriptadoOptions {
  name?: string;
  /**
   * URL do daemon. Aceita função porque, no daemon-filho, a URL e o token só
   * existem DEPOIS de `startDaemon()` — e `startDaemon()` exige o agente pronto.
   * Resolver na hora do uso quebra essa circularidade sem duplicar o daemon.
   */
  base: string | (() => string);
  token: string | null | (() => string | null);
  /** Plano fixo, ou uma função que o produz (para planos dependentes do estado). */
  roteiro: RoteiroDeAgente | (() => RoteiroDeAgente);
  /**
   * Gancho chamado em `reason()`. Lançar aqui simula um PROVIDER FORA DO AR —
   * é o mesmo caminho que `viaProvider("reason", ...)` audita como
   * `provider.degraded` em produção.
   */
  onReason?: () => void | Promise<void>;
  /** Gancho chamado ANTES de cada passo. Serve para derrubar o navegador no meio. */
  onBeforeStep?: (step: PlanStep, n: number) => void | Promise<void>;
  /** Registro de tudo que foi DESPACHADO — a prova de que um resume não repete. */
  despachados?: string[];
}

export function agenteScriptado(opts: AgenteScriptadoOptions): AgentProvider & { despachados: string[] } {
  const despachados = opts.despachados ?? [];
  let n = 0;

  const agente = {
    name: opts.name ?? "agente-scriptado",
    despachados,

    async observe(ctx: { session_id: string; observation: Observation }): Promise<Observation> {
      // Igual ao adaptador real: a percepção é do RUNTIME, não do agente.
      return ctx.observation;
    },

    async reason(): Promise<string> {
      if (opts.onReason !== undefined) await opts.onReason();
      return "roteiro determinístico: nenhum raciocínio é inventado aqui";
    },

    async plan(ctx: { goal: string }): Promise<Plan> {
      // O contador de passos é POR PLANO, não por vida do processo.
      //
      // DEFEITO MEDIDO: com um contador cumulativo, um gancho "aja no 3º passo"
      // funcionava quando o caso rodava sozinho e nunca disparava na suíte
      // inteira, porque `n` já valia 40. O teste passava isolado e falhava junto
      // — o pior dos dois mundos, porque parece flakiness e não é.
      n = 0;
      const r = typeof opts.roteiro === "function" ? opts.roteiro() : opts.roteiro;
      return {
        goal: r.goal ?? ctx.goal,
        constraints: r.constraints ?? [],
        steps: r.steps,
        success_conditions: r.success_conditions ?? [],
        failure_conditions: r.failure_conditions ?? [],
      };
    },

    async act(ctx: { session_id: string; step: PlanStep }): Promise<ActionResponse> {
      const t = timer();
      const step = ctx.step;
      n += 1;
      if (opts.onBeforeStep !== undefined) await opts.onBeforeStep(step, n);
      despachados.push(step.id);

      const base = typeof opts.base === "function" ? opts.base() : opts.base;
      const token = typeof opts.token === "function" ? opts.token() : opts.token;
      const corpo: Record<string, unknown> = { session_id: ctx.session_id };
      if (step.target !== undefined) corpo.target = step.target;
      if (step.verification !== undefined) corpo.verification = step.verification;
      const chave = CHAVE_DO_VALOR[step.action];
      if (chave !== undefined && step.value !== undefined) corpo[chave] = step.value;

      try {
        const r = await fetch(`${base}/api/v1/${step.action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nomos-client": agente.name,
            ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(corpo),
        });
        return (await r.json()) as ActionResponse;
      } catch (e) {
        // O daemon caiu por baixo (é um dos cenários). Devolver um envelope
        // falho é mais honesto que lançar: o motor classifica o código.
        return fail(`act_${step.id}`, "FAILED", "BROWSER_UNAVAILABLE", `passo não chegou à API: ${(e as Error).message}`, t.done(), {
          step: step.id,
          action: step.action,
        });
      }
    },

    async verify(ctx: { step: PlanStep; response: ActionResponse }): Promise<VerificationResult> {
      // O que o RUNTIME verificou, não o que o agente acha. Ausência de
      // verificação é `verified:false`, que não é o mesmo que verificado-falso.
      const v = (ctx.response.result as { verification?: VerificationResult } | null)?.verification;
      if (v !== undefined && v !== null) return v;
      return {
        executed: ctx.response.success,
        verified: false,
        confidence: 0,
        kind: ctx.step.verification?.kind ?? "NONE",
        observed: null,
        retries: 0,
      };
    },
  };
  return agente;
}
