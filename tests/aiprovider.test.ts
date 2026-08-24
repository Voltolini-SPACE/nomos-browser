/**
 * FASE 6/7 — contrato `AIProvider` + dois provedores locais REAIS.
 *
 * Critério de honestidade herdado do resto da suíte: nada é afirmado por
 * ausência de exceção, e todo par afirmação/controle-negativo anda junto.
 *
 * Três blocos, com dependências diferentes de propósito:
 *
 *   A. contrato e adaptador — `ScriptedProvider`, zero rede, determinístico.
 *   B. `OllamaProvider` contra servidores HTTP EFÊMEROS em 127.0.0.1 que eu
 *      controlo: porta morta, HTTP 500, 404, socket que nunca responde,
 *      `/api/tags` sem o modelo. Isso prova os caminhos de erro sem depender de
 *      LLM nenhum — o que um teste que só chama o modelo feliz nunca prova.
 *   C. FASE 7 — os dois modelos de verdade, EM SÉRIE, com descarga entre eles.
 *      Se o Ollama não responder, `t.skip` explícito. Nunca fingir.
 *
 * Nenhum servidor deste arquivo escuta fora de 127.0.0.1, e todos usam porta
 * efêmera (`listen(0)`) — a 9337 do nomos-panel de produção não é tocada.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  ACTION_CLASS,
  type Observation,
  type ObservedElement,
  type PlanStep,
} from "../packages/core/src/contract.ts";
import {
  AIProviderError,
  DEFAULT_AGENT_SYSTEM,
  MAX_PROMPT_CHARS,
  NO_USAGE,
  agentFromAIProvider,
  assertAIProvider,
  extractJsonObject,
  isAICapability,
  leaksInto,
  normalizeUsage,
  parsePlan,
  settleResponse,
  summarizeObservation,
  validateAIRequest,
} from "../packages/core/src/aiprovider.ts";
import {
  OllamaProvider,
  assertOllamaBase,
  ollamaProviderId,
  ollamaProviders,
} from "../packages/core/src/providers/ollama.ts";
import { ScriptedProvider, constantProvider } from "../packages/core/src/providers/scripted.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades locais
// ─────────────────────────────────────────────────────────────────────────────

/** Canário longo o bastante para `leaksInto` (>= LEAK_MIN_LEN) e improvável. */
const CANARIO = "canario-AIPROVIDER-7f3a-nao-e-segredo-real";

const log = (...parts: unknown[]): void => {
  // stderr de propósito: `console.log` no canal do `node --test` já corrompeu a
  // suíte uma vez (ver EVIDENCIA.md, defeito 5 da integração).
  process.stderr.write(`${parts.map(String).join(" ")}\n`);
};

function sha(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/** Quanto duas saídas coincidem do começo. Mede o quão fraco é o texto como
 *  discriminador: `!==` só diz "diferem", não diz "diferem POUCO". */
function prefixoComum(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

interface Fake {
  url: string;
  close: () => Promise<void>;
  /** Requisições recebidas — permite provar o que FOI enviado ao backend. */
  seen: { path: string; body: string }[];
}

/** Servidor HTTP efêmero em 127.0.0.1. Handler decide a resposta por rota. */
async function fakeBackend(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Fake> {
  const seen: { path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Porta que ninguém escuta: abre, lê a porta, fecha. Recusa de conexão real. */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function obs(elements: ObservedElement[], extra: Partial<Observation> = {}): Observation {
  return {
    url: "http://127.0.0.1/fixture",
    title: "fixture",
    page_id: "pg_1",
    elements,
    accessibility: null,
    screenshot_ref: null,
    observed_at: new Date().toISOString(),
    total_elements: elements.length,
    truncated: false,
    ...extra,
  };
}

function el(over: Partial<ObservedElement>): ObservedElement {
  return {
    ref: "e1",
    tag: "button",
    role: "button",
    text: "Entrar",
    attributes: {},
    box: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
    enabled: true,
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// BLOCO A — contrato, invariantes e provider determinístico
// ═════════════════════════════════════════════════════════════════════════════

describe("FASE 6 — contrato AIProvider", () => {
  it("A1. ScriptedProvider satisfaz a forma exigida", () => {
    const p = new ScriptedProvider({ rules: [{ reply: "ok" }] });
    assertAIProvider(p);
    assert.equal(p.provider_id, "scripted:scripted-v1");
    assert.equal(p.model, "scripted-v1");
    assert.ok(p.capabilities.length > 0);
    for (const c of p.capabilities) assert.ok(isAICapability(c), `capability inválida: ${c}`);
  });

  it("A2. assertAIProvider REJEITA o que não satisfaz (controle negativo)", () => {
    // Sem este par, A1 passaria com um assert que não checa nada.
    const casos: [unknown, RegExp][] = [
      [null, /não é objeto/],
      [{}, /provider_id/],
      [{ provider_id: "x" }, /model/],
      [{ provider_id: "x", model: "m" }, /capabilities/],
      [{ provider_id: "x", model: "m", capabilities: ["telepatia"] }, /capability desconhecida/],
      [{ provider_id: "x", model: "m", capabilities: [] }, /health/],
      [{ provider_id: "x", model: "m", capabilities: [], health: () => {} }, /request/],
      [
        { provider_id: "x", model: "m", capabilities: [], health: () => {}, request: () => {}, release: 1 },
        /release não é função/,
      ],
    ];
    for (const [valor, re] of casos) {
      assert.throws(() => assertAIProvider(valor), (e: unknown) => e instanceof AIProviderError && re.test((e as Error).message), `deveria rejeitar: ${JSON.stringify(valor)}`);
    }
  });

  it("A3. resposta de sucesso carrega text, usage, latency_ms, provider_id e model", async () => {
    const p = new ScriptedProvider({ model: "m-a3", rules: [{ match: "oi", reply: "olá" }] });
    const r = await p.request({ prompt: "oi mundo" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.text, "olá");
    assert.equal(r.provider_id, "scripted:m-a3");
    assert.equal(r.model, "m-a3");
    assert.equal(typeof r.latency_ms, "number");
    assert.ok(r.latency_ms >= 0);
    assert.equal(r.error, null);
    assert.equal(r.finish_reason, "stop");
    assert.ok(r.request_id.startsWith("ai_"));
    // I4: sem backend não há contagem — `null`, jamais `0`.
    assert.deepEqual(r.usage, { ...NO_USAGE });
    assert.equal(r.usage.prompt_tokens, null);
    assert.notEqual(r.usage.prompt_tokens, 0);
  });

  it("A4. DETERMINISMO: mesma entrada, mesma saída, e o log não altera a saída", async () => {
    const p = new ScriptedProvider({
      model: "m-a4",
      rules: [
        { match: /^calcule/i, reply: "42" },
        { match: "oi", reply: "olá" },
      ],
      default_reply: "n/a",
    });
    const a = await p.request({ prompt: "calcule tudo" });
    const b = await p.request({ prompt: "calcule tudo" });
    const c = await p.request({ prompt: "calcule tudo" });
    assert.equal(a.text, b.text);
    assert.equal(b.text, c.text);
    assert.equal(a.text, "42");
    // A ordem das regras decide, não a ordem das chamadas.
    assert.equal((await p.request({ prompt: "oi" })).text, "olá");
    assert.equal((await p.request({ prompt: "calcule tudo" })).text, "42");
    assert.equal(p.calls.length, 5);
    // Regex global não pode carregar `lastIndex` entre chamadas.
    const g = new ScriptedProvider({ rules: [{ match: /ab/g, reply: "casou" }], on_unmatched: "error" });
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await g.request({ prompt: "abab" })).text, "casou", `chamada ${i}`);
    }
  });

  it("A5. I2/I3: não existe sucesso vazio, e erro zera o texto", async () => {
    const vazio = new ScriptedProvider({ model: "m-a5", rules: [{ reply: "   " }] });
    const r = await vazio.request({ prompt: "qualquer" });
    assert.equal(r.ok, false);
    assert.equal(r.text, "");
    assert.equal(r.error?.code, "EMPTY_OUTPUT");
    assert.equal(r.finish_reason, "error");
    // Identidade e latência sobrevivem ao erro: sem isso, falha é inauditável.
    assert.equal(r.provider_id, "scripted:m-a5");
    assert.equal(r.model, "m-a5");
    assert.ok(r.latency_ms >= 0);

    // settleResponse é o único dono da regra: texto presente + erro ⇒ texto vai fora.
    const s = settleResponse({
      provider_id: "p",
      model: "m",
      request_id: "ai_x",
      latency_ms: 1,
      text: "saída parcial que não pode vazar",
      error: { code: "TIMEOUT", message: "estourou" },
    });
    assert.equal(s.ok, false);
    assert.equal(s.text, "");
    assert.equal(s.error?.code, "TIMEOUT");
  });

  it("A6. regra de erro produz resposta tipada, nunca exceção", async () => {
    const p = new ScriptedProvider({
      model: "m-a6",
      rules: [{ match: "explode", error: { code: "HTTP_ERROR", message: "500 simulado" } }],
    });
    const r = await p.request({ prompt: "explode agora" });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "HTTP_ERROR");
    assert.equal(r.error?.detail?.rule, 0);
  });

  it("A7. prompt não previsto FALHA fechado em vez de virar eco plausível", async () => {
    const fechado = new ScriptedProvider({ rules: [{ match: "previsto", reply: "ok" }] });
    const r = await fechado.request({ prompt: CANARIO });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "UNSUPPORTED");
    // I5: nem no detalhe do erro o prompt aparece.
    assert.equal(leaksInto(r, CANARIO), false, "prompt vazou na resposta de erro");
    assert.equal(r.error?.detail?.prompt_chars, CANARIO.length);

    const eco = new ScriptedProvider({ rules: [], on_unmatched: "echo" });
    assert.equal((await eco.request({ prompt: CANARIO })).text, CANARIO);
  });

  it("A8. validação: request nunca lança e recusa entrada inválida", async () => {
    const p = constantProvider("ok", "m-a8");
    const casos: [unknown, string][] = [
      [{ prompt: "" }, "INVALID_REQUEST"],
      [{ prompt: 7 }, "INVALID_REQUEST"],
      [{}, "INVALID_REQUEST"],
      [{ prompt: "x", temperature: 9 }, "INVALID_REQUEST"],
      [{ prompt: "x", temperature: -1 }, "INVALID_REQUEST"],
      [{ prompt: "x", max_tokens: 0 }, "INVALID_REQUEST"],
      [{ prompt: "x", max_tokens: 1.5 }, "INVALID_REQUEST"],
      [{ prompt: "x", timeout_ms: 0 }, "INVALID_REQUEST"],
      [{ prompt: "x", stop: [1] }, "INVALID_REQUEST"],
      [{ prompt: "x", format: "yaml" }, "INVALID_REQUEST"],
      [{ prompt: "x", system: 3 }, "INVALID_REQUEST"],
      [{ prompt: "a".repeat(MAX_PROMPT_CHARS + 1), }, "INVALID_REQUEST"],
    ];
    for (const [ctx, code] of casos) {
      const r = await p.request(ctx as never);
      assert.equal(r.ok, false, `deveria recusar: ${JSON.stringify(ctx).slice(0, 60)}`);
      assert.equal(r.error?.code, code, JSON.stringify(ctx).slice(0, 60));
    }
    assert.equal((await p.request({ prompt: "válido" })).ok, true);
  });

  it("A9. capability ausente NEGA em vez de tentar em silêncio", async () => {
    const semVisao = new ScriptedProvider({ capabilities: ["text"] });
    const rImg = await semVisao.request({ prompt: "veja", images: ["QUJD"] });
    assert.equal(rImg.ok, false);
    assert.equal(rImg.error?.code, "UNSUPPORTED");
    const rJson = await semVisao.request({ prompt: "estruture", format: "json" });
    assert.equal(rJson.error?.code, "UNSUPPORTED");

    const comVisao = new ScriptedProvider({ capabilities: ["text", "vision"], default_reply: "vi" });
    assert.equal((await comVisao.request({ prompt: "veja", images: ["QUJD"] })).ok, true);
    // Lista de imagens VAZIA não exige a capability — nada foi pedido.
    assert.equal(validateAIRequest({ prompt: "x", images: [] }, ["text"]), null);
  });

  it("A10. normalizeUsage: não reportado é null, nunca zero; total é derivado", () => {
    assert.deepEqual(normalizeUsage(undefined), { ...NO_USAGE });
    assert.deepEqual(normalizeUsage({}), { ...NO_USAGE });
    assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4 }), {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      source: "provider",
    });
    // Zero legítimo é preservado e marcado como reportado — diferente de ausente.
    const zero = normalizeUsage({ completion_tokens: 0 });
    assert.equal(zero.completion_tokens, 0);
    assert.equal(zero.source, "provider");
    assert.equal(normalizeUsage({ prompt_tokens: -3 }).prompt_tokens, null);
    assert.equal(normalizeUsage({ prompt_tokens: "12" }).source, "unavailable");
  });

  it("A11. leaksInto pega cru, url-encoded e base64; ignora agulha curta", () => {
    const alvo = { a: { b: CANARIO } };
    assert.equal(leaksInto(alvo, CANARIO), true);
    assert.equal(leaksInto({ q: encodeURIComponent(CANARIO) }, CANARIO), true);
    assert.equal(leaksInto({ q: Buffer.from(CANARIO).toString("base64") }, CANARIO), true);
    assert.equal(leaksInto({ a: 1 }, CANARIO), false);
    // Agulha curta é ignorada de propósito: casaria por acaso e viraria ruído.
    assert.equal(leaksInto({ msg: "tudo ok" }, "ok"), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCO A2 — adaptador AIProvider → AgentProvider
// ═════════════════════════════════════════════════════════════════════════════

describe("FASE 6 — adaptador AIProvider → AgentProvider", () => {
  const PLANO_BOM = JSON.stringify({
    goal: "entrar",
    constraints: ["não usar senha literal"],
    steps: [
      { id: "s1", intent: "clicar em entrar", action: "browser.click", target: { role: "button", text: "Entrar" } },
      { intent: "ler resultado", action: "browser.observe" },
    ],
    success_conditions: ["url mudou"],
    failure_conditions: ["erro visível"],
  });

  it("B1. cinco verbos presentes e nome derivado do provider", () => {
    const agent = agentFromAIProvider(constantProvider("ok", "m-b1"));
    for (const verbo of ["observe", "reason", "plan", "act", "verify"] as const) {
      assert.equal(typeof agent[verbo], "function", `verbo ausente: ${verbo}`);
    }
    assert.equal(agent.name, "agent:scripted:m-b1");
    assert.equal(agentFromAIProvider(constantProvider("ok"), { name: "AGENTE-B" }).name, "AGENTE-B");
  });

  it("B2. observe é no-op honesto: devolve a observação do runtime intacta", async () => {
    const agent = agentFromAIProvider(constantProvider("ok"));
    const o = obs([el({ ref: "e9" })]);
    const saida = await agent.observe({ session_id: "s1", observation: o });
    assert.equal(saida, o, "a observação não pode ser recriada nem enriquecida pelo modelo");
    await assert.rejects(() => agent.observe({ session_id: "s1", observation: null as never }), AIProviderError);
  });

  it("B3. reason devolve o texto do modelo e LANÇA quando o modelo falha", async () => {
    const bom = new ScriptedProvider({ rules: [{ reply: "clicar em Entrar porque é o único botão" }] });
    const agent = agentFromAIProvider(bom);
    const texto = await agent.reason({ goal: "entrar", observation: obs([el({})]) });
    assert.match(texto, /Entrar/);

    // Sem canal de erro no retorno (`string`), devolver a mensagem de erro faria
    // o chamador tratá-la como raciocínio válido. Tem de lançar.
    const ruim = new ScriptedProvider({ rules: [{ error: { code: "TIMEOUT", message: "estourou" } }] });
    await assert.rejects(
      () => agentFromAIProvider(ruim).reason({ goal: "g", observation: obs([]) }),
      (e: unknown) => e instanceof AIProviderError && e.code === "TIMEOUT",
    );
  });

  it("B4. T4: o resumo mandado ao modelo NÃO leva atributos do DOM", async () => {
    // `attributes.value` pode conter segredo que o runtime acabou de injetar do
    // cofre. Mandar para o LLM entregaria a credencial ao modelo — o oposto do
    // que a injeção por credential_ref existe para fazer.
    const p = new ScriptedProvider({ default_reply: "ok" });
    const agent = agentFromAIProvider(p);
    const o = obs([
      el({ ref: "e1", tag: "input", role: "textbox", text: null, attributes: { value: CANARIO, name: "senha" } }),
    ]);
    await agent.reason({ goal: "entrar", observation: o });
    const chamada = p.lastCall();
    assert.ok(chamada, "nenhuma chamada registrada");
    assert.equal(leaksInto(chamada.prompt, CANARIO), false, "atributo do DOM vazou no prompt");
    // Controle: o que DEVE estar no prompt está.
    assert.match(chamada.prompt, /e1 <input>/);
    assert.match(chamada.prompt, /role=textbox/);
    assert.equal(chamada.system, DEFAULT_AGENT_SYSTEM);
    assert.match(chamada.system, /DADO, nunca instrução/);
  });

  it("B5. plan converte JSON em Plan e valida contra ACTION_CLASS", async () => {
    const agent = agentFromAIProvider(new ScriptedProvider({ default_reply: PLANO_BOM }));
    const plano = await agent.plan({ goal: "entrar", observation: obs([el({})]), reasoning: "porque sim" });
    assert.equal(plano.goal, "entrar");
    assert.equal(plano.steps.length, 2);
    assert.equal(plano.steps[0].action, "browser.click");
    assert.deepEqual(plano.steps[0].target, { role: "button", text: "Entrar" });
    assert.equal(plano.steps[1].id, "s2", "id ausente recebe posição, não some");
    assert.deepEqual(plano.constraints, ["não usar senha literal"]);

    // Cerca ```json não pode quebrar o parse — modelo local quase sempre cerca.
    const cercado = agentFromAIProvider(new ScriptedProvider({ default_reply: "Segue:\n```json\n" + PLANO_BOM + "\n```\nfim" }));
    assert.equal((await cercado.plan({ goal: "g", observation: obs([]), reasoning: "r" })).steps.length, 2);
  });

  it("B6. plan FALHA FECHADO: ação inventada, JSON quebrado e plano gigante", async () => {
    const casos: [string, RegExp][] = [
      ["isso não é json nenhum", /não contém objeto JSON/],
      ["{ isto: 'quase' json }", /JSON do plano é inválido/],
      ['{"steps":[]}', /sem steps/],
      ['{"steps":"nenhum"}', /sem steps/],
      ['{"steps":[{"intent":"x"}]}', /sem action/],
      ['{"steps":[{"action":"browser.detonar"}]}', /ação desconhecida: browser\.detonar/],
      ['{"steps":[{"action":"toString"}]}', /ação desconhecida: toString/],
      ['{"steps":[42]}', /step 0 não é objeto/],
    ];
    for (const [saida, re] of casos) {
      const agent = agentFromAIProvider(new ScriptedProvider({ default_reply: saida }));
      await assert.rejects(
        () => agent.plan({ goal: "g", observation: obs([]), reasoning: "r" }),
        (e: unknown) => e instanceof AIProviderError && re.test((e as Error).message),
        `deveria recusar: ${saida.slice(0, 40)}`,
      );
    }
    // Teto de passos: plano com 41 passos é recusado, com 40 passa.
    const passo = '{"action":"browser.observe"}';
    const gigante = `{"steps":[${Array(41).fill(passo).join(",")}]}`;
    assert.throws(() => parsePlan(gigante, "g"), /excede o número máximo/);
    const noLimite = `{"steps":[${Array(40).fill(passo).join(",")}]}`;
    assert.equal(parsePlan(noLimite, "g").steps.length, 40);
    // Controle positivo: `browser.detonar` falha porque NÃO está no contrato.
    assert.equal(Object.hasOwn(ACTION_CLASS, "browser.detonar"), false);
    assert.equal(Object.hasOwn(ACTION_CLASS, "browser.observe"), true);
  });

  it("B6b. verificação de kind desconhecido LANÇA em vez de sumir em silêncio", () => {
    // O perigo aqui não é o kind inválido: é o passo rodar SEM verificação
    // enquanto o plano afirma que verifica. Descartar em silêncio seria pior
    // que recusar.
    assert.throws(
      () => parsePlan('{"steps":[{"action":"browser.click","verification":{"kind":"VIBRAÇÃO_COSMICA"}}]}', "g"),
      (e: unknown) => e instanceof AIProviderError && /verificação desconhecida/.test((e as Error).message),
    );
    assert.throws(() => parsePlan('{"steps":[{"action":"browser.click","verification":{"kind":7}}]}', "g"), /verificação desconhecida/);

    // Controle: todos os kinds do contrato passam, e ausência de `kind` é
    // simplesmente "sem verificação" — não é erro.
    for (const kind of ["URL_CHANGED", "ELEMENT_APPEARED", "ELEMENT_DISAPPEARED", "NETWORK_SUCCESS", "TEXT_CHANGED", "DOM_CHANGED", "NONE"]) {
      const p = parsePlan(`{"steps":[{"action":"browser.click","verification":{"kind":"${kind}","expect":"/ok","timeout_ms":900}}]}`, "g");
      assert.equal(p.steps[0].verification?.kind, kind);
      assert.equal(p.steps[0].verification?.expect, "/ok");
      assert.equal(p.steps[0].verification?.timeout_ms, 900);
    }
    assert.equal(parsePlan('{"steps":[{"action":"browser.click"}]}', "g").steps[0].verification, undefined);
    assert.equal(parsePlan('{"steps":[{"action":"browser.click","verification":{}}]}', "g").steps[0].verification, undefined);
  });

  it("B7. act SEM executor é negado; COM executor delega", async () => {
    const agent = agentFromAIProvider(constantProvider("ok", "m-b7"));
    const step: PlanStep = { id: "s1", intent: "clicar", action: "browser.click" };
    const r = await agent.act({ session_id: "s1", step });
    assert.equal(r.success, false, "modelo de texto não clica em nada");
    assert.equal(r.error?.code, "CAPABILITY_DENIED");
    assert.equal(r.result, null);
    assert.equal(r.error?.detail?.provider_id, "scripted:m-b7");
    assert.equal(typeof r.timing.duration_ms, "number");

    let visto: string | null = null;
    const comExec = agentFromAIProvider(constantProvider("ok"), {
      execute: async (ctx) => {
        visto = ctx.step.id;
        return { success: true, action_id: "a1", state: "ACTIVE", result: { clicked: true }, error: null, timing: { started_at: "", ended_at: "", duration_ms: 1 } };
      },
    });
    assert.equal((await comExec.act({ session_id: "s1", step })).success, true);
    assert.equal(visto, "s1");
  });

  it("B8. verify SEM verificador devolve NÃO-verificado com confiança 0", async () => {
    const agent = agentFromAIProvider(constantProvider("ok"));
    const step: PlanStep = { id: "s1", intent: "clicar", action: "browser.click", verification: { kind: "URL_CHANGED" } };
    const resposta = { success: true, action_id: "a1", state: "ACTIVE" as const, result: {}, error: null, timing: { started_at: "", ended_at: "", duration_ms: 1 } };
    const v = await agent.verify({ step, response: resposta });
    assert.equal(v.verified, false, "não verificado NÃO é verificado-verdadeiro");
    assert.equal(v.confidence, 0);
    assert.equal(v.executed, true, "executed reflete a ação, não a verificação");
    assert.equal(v.kind, "URL_CHANGED");
    assert.equal(v.observed, null);

    const comCheck = agentFromAIProvider(constantProvider("ok"), {
      check: async () => ({ executed: true, verified: true, confidence: 1, kind: "URL_CHANGED", observed: "/ok", retries: 0 }),
    });
    assert.equal((await comCheck.verify({ step, response: resposta })).confidence, 1);
  });

  it("B9. summarizeObservation reporta truncamento em vez de escondê-lo", () => {
    const muitos = Array.from({ length: 90 }, (_, i) => el({ ref: `e${i}` }));
    const s = summarizeObservation(obs(muitos), 10);
    assert.match(s, /ELEMENTOS: 10 de 90 \(lista truncada\)/);
    assert.equal(s.split("\n").filter((l) => l.startsWith("- ")).length, 10);
    assert.match(summarizeObservation(obs([el({})]), 10), /ELEMENTOS: 1 de 1$/m);
  });

  it("B10. extractJsonObject respeita chaves dentro de string", () => {
    assert.equal(extractJsonObject('lixo {"a":"}{"} fim'), '{"a":"}{"}');
    assert.equal(extractJsonObject('{"a":"\\""}'), '{"a":"\\""}');
    assert.equal(extractJsonObject("sem json"), null);
    assert.equal(extractJsonObject('{"a":1'), null, "objeto não fechado não vira plano");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCO B — OllamaProvider: identidade, guardas e TODOS os caminhos de erro
// ═════════════════════════════════════════════════════════════════════════════

describe("FASE 7 — OllamaProvider: identidade e guardas", () => {
  it("C1. provider_id é DERIVADO do modelo e distingue modelos", () => {
    assert.equal(ollamaProviderId("qwen3.5:4b-q8_0"), "ollama:qwen3.5:4b-q8_0");
    assert.equal(ollamaProviderId("qwen2.5-coder:7b"), "ollama:qwen2.5-coder:7b");
    assert.notEqual(ollamaProviderId("qwen3.5:4b-q8_0"), ollamaProviderId("qwen2.5-coder:7b"));
    const [a, b] = ollamaProviders(["qwen3.5:4b-q8_0", "qwen2.5-coder:7b"]);
    assert.notEqual(a.provider_id, b.provider_id);
    assert.notEqual(a.model, b.model);
    for (const ruim of ["", " ", "a b", "modelo\nquebrado", "-comeca-com-traco", 7, null]) {
      assert.throws(() => ollamaProviderId(ruim as never), AIProviderError, `deveria recusar: ${String(ruim)}`);
    }
  });

  it("C2. base_url não-loopback é RECUSADA na construção", () => {
    for (const ok of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
      assert.equal(typeof assertOllamaBase(ok), "string", ok);
    }
    for (const mau of ["http://10.0.0.5:11434", "http://0.0.0.0:11434", "https://api.exemplo.com", "http://192.168.1.9:11434"]) {
      assert.throws(() => assertOllamaBase(mau), /loopback/, `deveria recusar: ${mau}`);
    }
    assert.throws(() => assertOllamaBase("ftp://127.0.0.1"), /http ou https/);
    assert.throws(() => assertOllamaBase("nao é url"), /base_url inválida/);
    // Sair do loopback exige ato explícito, nunca inferência.
    assert.equal(assertOllamaBase("http://10.0.0.5:11434", true), "http://10.0.0.5:11434");
    assert.throws(() => new OllamaProvider({ model: "m:1", base_url: "http://8.8.8.8:11434" }), /loopback/);
    assert.equal(assertOllamaBase("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  });

  it("C3. backend MORTO: health degrada para down e request devolve NETWORK — sem lançar", async () => {
    const porta = await deadPort();
    const p = new OllamaProvider({ model: "qualquer:1b", base_url: `http://127.0.0.1:${porta}`, timeout_ms: 4000, health_timeout_ms: 2000 });

    const h = await p.health();
    assert.equal(h.status, "down");
    assert.equal(h.model_present, false);
    assert.equal(h.models_total, 0);
    assert.match(h.reason ?? "", /inalcançável/);
    assert.equal(h.provider_id, "ollama:qualquer:1b");

    const r = await p.request({ prompt: CANARIO });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "NETWORK", JSON.stringify(r.error));
    assert.equal(r.text, "");
    // Identidade e latência preservadas no erro — senão a falha é inauditável.
    assert.equal(r.provider_id, "ollama:qualquer:1b");
    assert.equal(r.model, "qualquer:1b");
    assert.ok(r.latency_ms >= 0);
    // I5: o prompt não pode aparecer em lugar nenhum da resposta de erro.
    assert.equal(leaksInto(r, CANARIO), false, "prompt vazou na resposta de erro de rede");
  });

  it("C4. modelo AUSENTE no backend é degraded, NÃO exceção", async () => {
    const fake = await fakeBackend((req, res) => {
      if (req.url === "/api/tags") json(res, 200, { models: [{ name: "outro:1b" }, { model: "so-model:2b" }] });
      else json(res, 404, { error: "model 'ausente:9b' not found, try pulling it first" });
    });
    try {
      // Construir com modelo ausente NÃO pode lançar (I6).
      const p = new OllamaProvider({ model: "ausente:9b", base_url: fake.url, health_timeout_ms: 3000 });
      const h = await p.health();
      assert.equal(h.status, "degraded", "backend vivo + modelo ausente não é down nem ok");
      assert.equal(h.model_present, false);
      assert.equal(h.models_total, 2);
      assert.deepEqual(h.models, ["outro:1b", "so-model:2b"]);
      assert.match(h.reason ?? "", /modelo ausente/);

      // E a chamada devolve MODEL_NOT_FOUND, distinto de HTTP_ERROR genérico.
      const r = await p.request({ prompt: "oi", timeout_ms: 4000 });
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "MODEL_NOT_FOUND", JSON.stringify(r.error));

      // Controle: modelo presente ⇒ ok.
      const presente = new OllamaProvider({ model: "outro:1b", base_url: fake.url, health_timeout_ms: 3000 });
      const h2 = await presente.health();
      assert.equal(h2.status, "ok");
      assert.equal(h2.model_present, true);
    } finally {
      await fake.close();
    }
  });

  it("C5. HTTP 500 e JSON corrompido viram erro tipado, não sucesso vazio", async () => {
    const quinhentos = await fakeBackend((req, res) => {
      if (req.url === "/api/tags") json(res, 500, { error: "explodiu" });
      else {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("erro interno do backend");
      }
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: quinhentos.url, timeout_ms: 4000, health_timeout_ms: 2000 });
      assert.equal((await p.health()).status, "down");
      const r = await p.request({ prompt: "oi" });
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "HTTP_ERROR");
      assert.equal(r.error?.detail?.status, 500);
      assert.match(String(r.error?.detail?.body), /erro interno/);
    } finally {
      await quinhentos.close();
    }

    const corrompido = await fakeBackend((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{isto não fecha");
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: corrompido.url, timeout_ms: 4000 });
      const r = await p.request({ prompt: "oi" });
      assert.equal(r.error?.code, "BAD_RESPONSE", JSON.stringify(r.error));
    } finally {
      await corrompido.close();
    }
  });

  it("C6. HTTP 200 com response vazio é EMPTY_OUTPUT, jamais ok", async () => {
    const fake = await fakeBackend((_req, res) => json(res, 200, { model: "m:1", response: "", done_reason: "stop" }));
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: fake.url, timeout_ms: 4000 });
      const r = await p.request({ prompt: "oi" });
      assert.equal(r.ok, false, "200 com corpo vazio não é sucesso");
      assert.equal(r.error?.code, "EMPTY_OUTPUT");
    } finally {
      await fake.close();
    }
  });

  it("C7. `thinking` que come o orçamento é diagnosticado, e não atravessa a fronteira", async () => {
    // Reproduz o que qwen3.5 fez de verdade: gerou 24 tokens, todos internos,
    // `response` vazio. E o `thinking` observado ECOAVA O PROMPT.
    const fake = await fakeBackend((_req, res) =>
      json(res, 200, {
        model: "pensador:1b",
        response: "",
        thinking: `Thinking Process: Input: "${CANARIO}" ...`,
        context: [1, 2, 3],
        done_reason: "length",
        prompt_eval_count: 28,
        eval_count: 24,
      }),
    );
    try {
      const p = new OllamaProvider({ model: "pensador:1b", base_url: fake.url, timeout_ms: 4000 });
      const r = await p.request({ prompt: CANARIO });
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "EMPTY_OUTPUT");
      assert.match(String(r.error?.message), /think:false|max_tokens/);
      assert.equal(r.error?.detail?.thinking_chars, `Thinking Process: Input: "${CANARIO}" ...`.length);
      // O que importa: nem `thinking` nem `context` atravessam.
      assert.equal(leaksInto(r, CANARIO), false, "thinking vazou o prompt para a resposta");
      assert.equal(JSON.stringify(r).includes("Thinking Process"), false);
      assert.equal(JSON.stringify(r).includes("context"), false);
      // Uso continua sendo reportado: houve gasto real de token.
      assert.equal(r.usage.completion_tokens, 24);
      assert.equal(r.meta.done_reason, "length");
    } finally {
      await fake.close();
    }
  });

  it("C8. corpo de erro que ECOA o prompt é descartado", async () => {
    const fake = await fakeBackend((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`pedido inválido: ${CANARIO}`);
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: fake.url, timeout_ms: 4000 });
      const r = await p.request({ prompt: CANARIO });
      assert.equal(r.error?.code, "HTTP_ERROR");
      assert.equal(r.error?.detail?.body, "[corpo omitido: ecoava o prompt]");
      assert.equal(leaksInto(r, CANARIO), false);
    } finally {
      await fake.close();
    }
  });

  it("C9. TIMEOUT é distinguido de NETWORK contra socket que nunca responde", async () => {
    // Condição verificável, não sleep como mecanismo: o servidor aceita a
    // conexão e NUNCA responde; quem termina o teste é o AbortController.
    const mudo = await fakeBackend(() => {
      /* segura a conexão de propósito */
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: mudo.url, timeout_ms: 700 });
      const t0 = Date.now();
      const r = await p.request({ prompt: CANARIO });
      const gasto = Date.now() - t0;
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "TIMEOUT", JSON.stringify(r.error));
      assert.match(String(r.error?.message), /timeout após 700 ms/);
      assert.ok(gasto >= 600 && gasto < 8000, `timeout fora da janela: ${gasto} ms`);
      assert.ok(r.latency_ms >= 600, `latência medida: ${r.latency_ms}`);
      assert.equal(leaksInto(r, CANARIO), false);
      // health tem timeout PRÓPRIO, mais curto: 180s de request não pode
      // travar um healthcheck.
      const h = await p.health({ timeout_ms: 400 });
      assert.equal(h.status, "down");
      assert.match(h.reason ?? "", /TIMEOUT/);
    } finally {
      await mudo.close();
    }
  });

  it("C9b. cabeçalhos rápidos + CORPO que nunca fecha também estouram o timeout", async () => {
    // Caminho distinto do C9: aqui o backend RESPONDE (200 + cabeçalhos) e só
    // depois trava. Se o timer fosse desarmado ao receber o `Response`, este
    // pedido penduraria para sempre — e `/api/generate` com `stream:false` é
    // exatamente isso: cabeçalho na hora, corpo só no fim da geração.
    const meioMudo = await fakeBackend((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"model":"m:1","resp');
      // sem `end()` de propósito
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: meioMudo.url, timeout_ms: 700 });
      const t0 = Date.now();
      const r = await p.request({ prompt: CANARIO });
      const gasto = Date.now() - t0;
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "TIMEOUT", JSON.stringify(r.error));
      assert.ok(gasto >= 600 && gasto < 8000, `não estourou na janela: ${gasto} ms`);
      assert.equal(leaksInto(r, CANARIO), false);
      // O mesmo vale para health(), que lê /api/tags.
      const h = await p.health({ timeout_ms: 500 });
      assert.equal(h.status, "down");
      assert.match(h.reason ?? "", /TIMEOUT/);
    } finally {
      await meioMudo.close();
    }
  });

  it("C10. ABORTED pelo chamador é distinto de TIMEOUT", async () => {
    const mudo = await fakeBackend(() => {});
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: mudo.url, timeout_ms: 30_000 });
      const ac = new AbortController();
      const pedido = p.request({ prompt: "oi", signal: ac.signal });
      ac.abort();
      const r = await pedido;
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "ABORTED", JSON.stringify(r.error));
    } finally {
      await mudo.close();
    }
  });

  it("C11. o corpo enviado ao backend é o esperado (options, think, keep_alive, format)", async () => {
    const fake = await fakeBackend((req, res) => {
      if (req.url === "/api/tags") json(res, 200, { models: [{ name: "m:1" }] });
      else json(res, 200, { model: "m:1", response: "{}", done_reason: "stop", prompt_eval_count: 3, eval_count: 1 });
    });
    try {
      const p = new OllamaProvider({ model: "m:1", base_url: fake.url, timeout_ms: 4000, keep_alive: 0, think: false });
      const r = await p.request({ prompt: "oi", system: "sys", temperature: 0, max_tokens: 16, seed: 7, stop: ["FIM"], format: "json" });
      assert.equal(r.ok, true, JSON.stringify(r.error));
      const enviado = JSON.parse(fake.seen.at(-1)?.body ?? "{}");
      assert.equal(fake.seen.at(-1)?.path, "/api/generate");
      assert.equal(enviado.model, "m:1");
      assert.equal(enviado.stream, false, "stream tem de ser false: o contrato não é streaming");
      assert.equal(enviado.system, "sys");
      assert.equal(enviado.format, "json");
      assert.equal(enviado.think, false);
      assert.equal(enviado.keep_alive, 0);
      assert.deepEqual(enviado.options, { temperature: 0, num_predict: 16, seed: 7, stop: ["FIM"] });
      // Sem opções, o campo nem é enviado — não inventar default do backend.
      await p.request({ prompt: "oi" });
      assert.equal(JSON.parse(fake.seen.at(-1)?.body ?? "{}").options, undefined);
      // meta e usage vêm do backend, não do cliente.
      assert.equal(r.meta.model_echo, "m:1");
      assert.equal(r.usage.source, "provider");
      assert.equal(r.usage.total_tokens, 4);
    } finally {
      await fake.close();
    }
  });

  it("C12. resident() distingue 'não consegui consultar' de 'nada residente'", async () => {
    const vivo = await fakeBackend((req, res) => {
      if (req.url === "/api/ps") json(res, 200, { models: [{ name: "a:1" }] });
      else json(res, 404, {});
    });
    try {
      const p = new OllamaProvider({ model: "a:1", base_url: vivo.url });
      assert.deepEqual(await p.resident(2000), ["a:1"]);
    } finally {
      await vivo.close();
    }
    const porta = await deadPort();
    const morto = new OllamaProvider({ model: "a:1", base_url: `http://127.0.0.1:${porta}` });
    assert.equal(await morto.resident(1500), null, "backend morto não pode parecer backend limpo");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCO C — FASE 7: DOIS provedores locais REAIS, em série
// ═════════════════════════════════════════════════════════════════════════════

const MODELO_A = "qwen3.5:4b-q8_0";
const MODELO_B = "qwen2.5-coder:7b";
/** Convergente de propósito: os dois DEVEM responder a mesma coisa. */
const PROMPT_CONVERGENTE = "Responda APENAS com o algarismo, sem nenhuma palavra: quanto é 2+2?";
/** Aberto: aqui a saída idêntica seria praticamente impossível. */
const PROMPT_ABERTO = "Em uma frase curta, diga por que um teste automatizado precisa de controle negativo.";

interface Medida {
  provider_id: string;
  model: string;
  model_echo: string | null;
  family: string | null;
  backend_caps: string[];
  convergente: string;
  aberto: string;
  latency_convergente_ms: number;
  latency_aberto_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  descarregado: boolean;
}

describe("FASE 7 — dois modelos locais REAIS, executados em série", () => {
  let VIVO = false;
  let MOTIVO = "";
  let RESIDENTE_ANTES: string[] = [];
  const medidas = new Map<string, Medida>();

  /** Provider por modelo. `think` decidido pela ficha do backend, não chumbado. */
  async function providerPara(model: string): Promise<{ p: OllamaProvider; caps: string[]; family: string | null }> {
    const sonda = new OllamaProvider({ model });
    const card = await sonda.describeModel();
    const caps = card?.capabilities ?? [];
    return {
      p: new OllamaProvider({
        model,
        timeout_ms: 180_000, // carga fria de vários GB nesta máquina
        // `think:false` só onde o backend declara raciocínio interno.
        think: caps.includes("thinking") ? false : undefined,
      }),
      caps,
      family: card?.family ?? null,
    };
  }

  /** Roda um modelo inteiro e o descarrega. Nunca dois residentes ao mesmo tempo. */
  async function rodar(model: string): Promise<Medida> {
    const { p, caps, family } = await providerPara(model);
    const c = await p.request({ prompt: PROMPT_CONVERGENTE, temperature: 0, max_tokens: 32 });
    assert.equal(c.ok, true, `${model} falhou no prompt convergente: ${JSON.stringify(c.error)}`);
    const a = await p.request({ prompt: PROMPT_ABERTO, temperature: 0, max_tokens: 120 });
    assert.equal(a.ok, true, `${model} falhou no prompt aberto: ${JSON.stringify(a.error)}`);

    await p.release();
    const descarregado = await p.waitUnloaded({ timeout_ms: 25_000 });

    const m: Medida = {
      provider_id: p.provider_id,
      model,
      model_echo: c.meta.model_echo,
      family,
      backend_caps: caps,
      convergente: c.text.trim(),
      aberto: a.text.trim(),
      latency_convergente_ms: c.latency_ms,
      latency_aberto_ms: a.latency_ms,
      prompt_tokens: c.usage.prompt_tokens,
      completion_tokens: c.usage.completion_tokens,
      descarregado,
    };
    medidas.set(model, m);
    log(
      `[FASE7] ${p.provider_id} echo=${m.model_echo} family=${family} caps=${caps.join("|")} ` +
        `lat=${m.latency_convergente_ms}/${m.latency_aberto_ms}ms tok=${m.prompt_tokens}/${m.completion_tokens} ` +
        `descarregado=${descarregado} conv=${JSON.stringify(m.convergente.slice(0, 40))} ` +
        `aberto_sha=${sha(m.aberto)} aberto=${JSON.stringify(m.aberto.slice(0, 90))}`,
    );
    return m;
  }

  before(async () => {
    const sonda = new OllamaProvider({ model: MODELO_A, health_timeout_ms: 4000 });
    const h = await sonda.health();
    if (h.status === "down") {
      MOTIVO = `Ollama inalcançável em 127.0.0.1:11434 — ${h.reason}`;
      return;
    }
    const faltando = [MODELO_A, MODELO_B].filter((m) => !h.models.includes(m));
    if (faltando.length > 0) {
      MOTIVO = `modelo ausente no backend: ${faltando.join(", ")} (não baixar: ato do dono)`;
      return;
    }
    RESIDENTE_ANTES = (await sonda.resident()) ?? [];
    VIVO = true;
    log(`[FASE7] backend vivo, ${h.models_total} modelos; residentes ANTES: ${JSON.stringify(RESIDENTE_ANTES)}`);
  });

  after(async () => {
    if (!VIVO) return;
    // Devolver a máquina ao estado em que a encontrei. `qwen3.5:4b-q8_0` é o
    // cérebro soberano desta máquina e costuma estar quente: descarregar e ir
    // embora deixaria a próxima chamada de produção pagando carga fria.
    for (const model of RESIDENTE_ANTES) {
      if (!medidas.has(model)) continue; // só recarrego o que EU descarreguei
      const { p } = await providerPara(model);
      const r = await p.request({ prompt: "ok", max_tokens: 4 });
      log(`[FASE7] residência restaurada: ${model} ok=${r.ok} lat=${r.latency_ms}ms`);
    }
    const final = (await new OllamaProvider({ model: MODELO_A }).resident()) ?? [];
    log(`[FASE7] residentes DEPOIS: ${JSON.stringify(final)}`);
  });

  it("D1. health real: backend vivo e os DOIS modelos presentes", { timeout: 60_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    for (const model of [MODELO_A, MODELO_B]) {
      const h = await new OllamaProvider({ model, health_timeout_ms: 5000 }).health();
      assert.equal(h.status, "ok", `${model}: ${h.reason}`);
      assert.equal(h.model_present, true);
      assert.equal(h.provider_id, `ollama:${model}`);
      assert.ok(h.models_total >= 2);
      assert.ok(h.latency_ms >= 0);
    }
    // Controle negativo contra o backend REAL: modelo que não existe é
    // degraded, provando que D1 não passaria com um health que sempre diz ok.
    const fantasma = await new OllamaProvider({ model: "modelo-que-nao-existe:0b", health_timeout_ms: 5000 }).health();
    assert.equal(fantasma.status, "degraded");
    assert.equal(fantasma.model_present, false);
  });

  it(`D2. ${MODELO_A} responde de verdade (e é descarregado depois)`, { timeout: 420_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    const m = await rodar(MODELO_A);
    assert.equal(m.provider_id, `ollama:${MODELO_A}`);
    assert.equal(m.model_echo, MODELO_A, "o SERVIDOR tem de ecoar o modelo pedido");
    assert.ok(m.convergente.length > 0);
    assert.ok(m.aberto.length > 0);
    assert.ok((m.completion_tokens ?? 0) > 0, "usage real do backend");
    assert.ok(m.latency_convergente_ms > 0);
    assert.equal(m.family, "qwen35", "família declarada pelo backend");
    assert.equal(m.descarregado, true, "modelo continuou residente após release()");
  });

  it(`D3. ${MODELO_B} responde de verdade (e é descarregado depois)`, { timeout: 420_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    // Garantia de SÉRIE do meu lado: o modelo anterior saiu antes deste entrar.
    // A asserção é sobre o que EU descarreguei, não sobre a residência ambiente:
    // o Ollama é compartilhado com outros processos desta máquina, e exigir que
    // `/api/ps` esteja limpo mediria o comportamento alheio, não o meu.
    // A residência ambiente vai para o log como observação.
    const anterior = medidas.get(MODELO_A);
    assert.ok(anterior, "D2 precisa ter rodado antes");
    assert.equal(anterior.descarregado, true, `${MODELO_A} não foi descarregado por mim antes de carregar ${MODELO_B}`);
    const ambiente = (await new OllamaProvider({ model: MODELO_B }).resident()) ?? [];
    log(`[FASE7] residência ambiente antes de ${MODELO_B}: ${JSON.stringify(ambiente)}`);

    const m = await rodar(MODELO_B);
    assert.equal(m.provider_id, `ollama:${MODELO_B}`);
    assert.equal(m.model_echo, MODELO_B);
    assert.ok(m.convergente.length > 0);
    assert.ok(m.aberto.length > 0);
    assert.ok((m.completion_tokens ?? 0) > 0);
    assert.equal(m.family, "qwen2", "família diferente da do modelo A");
    assert.equal(m.descarregado, true, "modelo continuou residente após release()");
  });

  it("D4. os dois são distinguidos INEQUIVOCAMENTE pela identidade", { timeout: 60_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    const a = medidas.get(MODELO_A);
    const b = medidas.get(MODELO_B);
    assert.ok(a && b, "D2/D3 precisam ter rodado");

    // Estas são as chaves que a auditoria usa. Nenhuma delas vem do modelo se
    // auto-declarar — todas vêm do servidor ou da derivação do nome.
    assert.notEqual(a.provider_id, b.provider_id);
    assert.notEqual(a.model, b.model);
    assert.notEqual(a.model_echo, b.model_echo);
    assert.equal(a.model_echo, a.model);
    assert.equal(b.model_echo, b.model);
    assert.notEqual(a.family, b.family, "qwen35 vs qwen2: famílias diferentes");
    assert.notDeepEqual(a.backend_caps.slice().sort(), b.backend_caps.slice().sort());
    // Instâncias independentes: um provider não sabe do outro.
    const [pa, pb] = ollamaProviders([MODELO_A, MODELO_B]);
    assert.notEqual(pa, pb);
    assert.notEqual(pa.provider_id, pb.provider_id);
    log(`[FASE7] identidade A=${a.provider_id}/${a.family}  B=${b.provider_id}/${b.family}`);
  });

  it("D5. REFUTAÇÃO: o TEXTO da resposta não é discriminador de identidade", { timeout: 60_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    const a = medidas.get(MODELO_A);
    const b = medidas.get(MODELO_B);
    assert.ok(a && b, "D2/D3 precisam ter rodado");

    const convIgual = a.convergente === b.convergente;
    const abertoIgual = a.aberto === b.aberto;
    const prefixo = prefixoComum(a.aberto, b.aberto);
    log(
      `[FASE7][REFUTACAO] convergente A=${JSON.stringify(a.convergente)} B=${JSON.stringify(b.convergente)} ` +
        `iguais=${convIgual} | aberto sha A=${sha(a.aberto)} B=${sha(b.aberto)} iguais=${abertoIgual} ` +
        `prefixo_comum=${prefixo.length} chars ${JSON.stringify(prefixo)}`,
    );

    // Hipótese testada: "dá para saber qual modelo respondeu olhando a saída".
    // Num prompt convergente os dois acertam a MESMA resposta — logo a hipótese
    // é FALSA, e a identidade tem de vir de provider_id/model/echo (D4).
    assert.ok(a.convergente.includes("4"), `A não respondeu 4: ${a.convergente}`);
    assert.ok(b.convergente.includes("4"), `B não respondeu 4: ${b.convergente}`);

    // No prompt ABERTO a divergência é esperada. Se der igual, é achado — e o
    // teste falha alto em vez de arredondar para verde.
    assert.notEqual(
      a.aberto,
      b.aberto,
      "ACHADO: dois modelos de famílias diferentes produziram texto IDÊNTICO no prompt aberto",
    );
  });

  it("D6. adaptador de agente roda sobre um provider REAL", { timeout: 420_000 }, async (t) => {
    if (!VIVO) return t.skip(MOTIVO);
    // Usa o modelo que o `after` vai restaurar de qualquer forma, para não
    // acrescentar uma terceira carga fria à suíte.
    const { p } = await providerPara(MODELO_A);
    const agent = agentFromAIProvider(p, { max_tokens: 200, temperature: 0 });
    const observacao = obs([
      el({ ref: "e1", tag: "button", role: "button", text: "Entrar" }),
      el({ ref: "e2", tag: "input", role: "textbox", text: null, attributes: { value: CANARIO } }),
    ]);
    const texto = await agent.reason({ goal: "fazer login", observation: observacao });
    assert.ok(texto.trim().length > 0, "modelo real devolveu raciocínio vazio");
    assert.equal(leaksInto(texto, CANARIO), false, "modelo real ecoou atributo do DOM — o resumo vazou");
    log(`[FASE7] reason() real: ${JSON.stringify(texto.slice(0, 140))}`);

    // `act` continua negado mesmo com modelo real conectado: modelo não clica.
    const r = await agent.act({ session_id: "s1", step: { id: "s1", intent: "clicar", action: "browser.click" } });
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "CAPABILITY_DENIED");
    // Descarrega sempre. Quem decide o que fica residente é o `after`, olhando
    // o baseline capturado no `before` — não este teste chutando o estado.
    await p.release();
    await p.waitUnloaded({ timeout_ms: 25_000 });
  });
});
