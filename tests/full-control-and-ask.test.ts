/**
 * CONTROLE TOTAL + browser.ask (a Gi RESPONDE).
 *
 * Duas capacidades novas da experiência da Gi, cada uma com sua contra-prova:
 *
 *  - CONTROLE TOTAL: o dono desliga a governança NA SESSÃO e o runtime
 *    auto-aprova o que a matriz mandaria perguntar. Contra-prova: com o modo
 *    DESLIGADO, a mesma ação em ASK trava esperando aprovação (fail-closed).
 *  - browser.ask: perguntar não é agir — responde por leitura, sem aprovação, e
 *    roteia pedido de AÇÃO para `ACAO:`. Depende de provedor de IA local; sem
 *    Ollama, PULA com o motivo (nunca finge verde).
 *
 * Cada teste usa a PRÓPRIA sessão: um freio numa não pode envenenar a outra.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../packages/api/src/daemon.ts";
import { descreverPasso } from "../packages/core/src/taskengine.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = `<!doctype html><title>Relatório de Vendas SE7EN PAY</title><body><a id="e" href="#e">Entrar</a></body>`;

let d: { port: number; close: () => Promise<void> };
let B = "", T = "", FURL = "";
let fx: http.Server;

async function SEM_OLLAMA(): Promise<string | false> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    return r.ok ? false : "Ollama respondeu != 200";
  } catch { return "Ollama local ausente (127.0.0.1:11434) — o teste de resposta da Gi só roda com ele"; }
}

const call = async (p: string, b?: unknown) => {
  const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p: string) => (await fetch(B + p, { headers: { authorization: `Bearer ${T}` } })).json();
async function novaSessao(): Promise<string> {
  const s = await call("/api/v1/sessions", { owner: "t", profile: "sandbox" });
  const sid = s.body.session_id as string;
  await call("/api/v1/browser.goto", { session_id: sid, url: FURL });
  return sid;
}

before(async () => {
  fx = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(PAGE); });
  await new Promise<void>((r) => fx.listen(0, "127.0.0.1", r));
  FURL = `http://127.0.0.1:${(fx.address() as { port: number }).port}/`;
  d = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(RAIZ, "sessions"),
    ai_provider: "ollama:qwen3.5:4b-q8_0", ai_think: false } as never);
  B = `http://127.0.0.1:${d.port}`; T = (d as unknown as { token: string }).token;
});

after(async () => { await d?.close(); await new Promise<void>((r) => fx?.close(() => r())); });

test("CONTRA-PROVA: em ASK, sem controle total, uma navegação TRAVA esperando aprovação", async () => {
  const sid = await novaSessao();
  await call(`/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "t" });
  const corrida = call("/api/v1/browser.open", { session_id: sid, url: FURL + "?ask" });
  const venceu = await Promise.race([
    corrida.then(() => "RESOLVEU"),
    new Promise((r) => setTimeout(() => r("PENDENTE"), 2500)),
  ]);
  assert.equal(venceu, "PENDENTE", "a ação resolveu sozinha sem controle total — o gate não segurou");
  const live = await get(`/api/v1/sessions/${sid}/live`);
  assert.equal(live.controle_total, false, "controle_total deveria estar desligado");
  assert.ok((live.approvals_pending || []).length >= 1, "não havia aprovação pendente");
  // Solta a corrida SEM emergency-stop (que congelaria a sessão): ligar controle
  // total aprova a pendente, e a navegação represada resolve com sucesso.
  await call(`/api/v1/sessions/${sid}/full-control`, { on: true });
  const env = await corrida;
  assert.equal(env.body?.success, true, "a pendente não foi liberada ao ligar controle total");
});

test("CONTROLE TOTAL liga, /live reporta, e a navegação em ASK passa sem travar", async () => {
  const sid = await novaSessao();
  await call(`/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "t" });
  const fc = await call(`/api/v1/sessions/${sid}/full-control`, { on: true });
  assert.equal(fc.body.controle_total, true);
  assert.equal((await get(`/api/v1/sessions/${sid}/live`)).controle_total, true);
  const t0 = Date.now();
  const nav = await call("/api/v1/browser.open", { session_id: sid, url: FURL + "?fc" });
  assert.equal(nav.body?.success, true, "navegação não passou sob controle total");
  assert.ok(Date.now() - t0 < 15000, "demorou como se tivesse esperado humano");
  await call(`/api/v1/sessions/${sid}/full-control`, { on: false });
  assert.equal((await get(`/api/v1/sessions/${sid}/live`)).controle_total, false);
});

test("PROGRESSO HUMANO: descreverPasso dá frase legível, nunca 's1', e não vaza `value`", () => {
  // Com intent do planejador → usa o intent + ordem.
  assert.equal(
    descreverPasso({ id: "s2", intent: "Clicar no botão Entrar", action: "browser.click" } as never, 1, 5),
    "Clicar no botão Entrar (2 de 5)",
  );
  // Sem intent → verbo humano + alvo.
  assert.equal(
    descreverPasso({ id: "s1", intent: "", action: "browser.click", target: { text: "Entrar" } } as never, 0, 3),
    'Clicando em "Entrar" (1 de 3)',
  );
  // NUNCA usa `value` (texto digitado pode ser segredo).
  const d = descreverPasso({ id: "s1", intent: "", action: "browser.type", target: { label: "Senha" }, value: "hunter2" } as never, 0, 1);
  assert.ok(!d.includes("hunter2"), "descrição vazou o texto digitado");
  assert.ok(!/^s\d+$/.test(d), "descrição virou id técnico");
});

test("ATERRAMENTO: answer_only responde o que está na página e RECUSA o que não está", async (t) => {
  const skip = await SEM_OLLAMA();
  if (skip !== false) { t.skip(skip); return; }
  const sid = await novaSessao();
  const ctx = '"Preços SE7EN PAY" — trecho: Plano Básico R$ 29 por mês. Plano Pro R$ 99 por mês.';
  const barato = await call(`/api/v1/sessions/${sid}/ask`, { question: "Qual plano é mais barato?", page_context: ctx, answer_only: true });
  assert.match(String(barato.body.answer || ""), /b[áa]sico/i, "não respondeu com o plano da página");
  assert.match(String(barato.body.answer || ""), /29/, "não trouxe o valor da página");
  // A página NÃO tem telefone: a Gi tem de recusar, não inventar.
  const tel = await call(`/api/v1/sessions/${sid}/ask`, { question: "Qual é o telefone de contato?", page_context: ctx, answer_only: true });
  assert.doesNotMatch(String(tel.body.answer || ""), /\d{4,}/, "inventou um número que a página não tem");
});

test("browser.ask: pergunta vira RESPOSTA; pedido de ação vira ACAO:", async (t) => {
  const skip = await SEM_OLLAMA();
  if (skip !== false) { t.skip(skip); return; }
  const sid = await novaSessao();
  const ctx = '"Relatório de Vendas SE7EN PAY" — trecho: PIX hoje R$ 12.480.';
  const q = await call(`/api/v1/sessions/${sid}/ask`, { question: "Qual é o título desta página?", page_context: ctx });
  assert.equal(q.status, 200);
  assert.equal(q.body.act, null, "uma PERGUNTA não deveria virar ação");
  assert.match(String(q.body.answer || ""), /Relat[óo]rio|SE7EN/i, "a resposta não trouxe o título");
  const a = await call(`/api/v1/sessions/${sid}/ask`, { question: "Abra o portal e clique em Entrar.", page_context: ctx });
  assert.equal(a.body.answer, null, "um PEDIDO DE AÇÃO não deveria virar texto");
  assert.ok(String(a.body.act || "").length > 0, "não roteou para ACAO:");
});
