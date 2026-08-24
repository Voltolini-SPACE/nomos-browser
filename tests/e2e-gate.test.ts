/**
 * FASE 67 — PRIMEIRO GATE EXECUTÁVEL
 *
 * A missão manda provar este cenário ANTES de expandir UI ou features. Cada
 * asserção aqui vale um dos flags do gate. O que este arquivo NÃO cobre está
 * declarado no final, para que a ausência não passe por sucesso.
 *
 * Tudo roda contra o daemon REAL, por HTTP, com Chromium REAL. Nenhum mock.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startDaemon } from "../packages/api/src/daemon.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(path.join(RAIZ, "spike/fixture/index.html"));

let daemon: { port: number; close: () => Promise<void> };
let fixtureServer: http.Server;
let BASE = "";
let FIXTURE_URL = "";

/** Flags do gate. Só viram YES por asserção executada. */
const GATE: Record<string, string> = {
  RUNTIME_INDEPENDENCE_PASS: "NO",
  DOM_PASS: "NO",
  ACCESSIBILITY_PASS: "NO",
  VISION_MOUSE_PASS: "NO",
  MULTI_AI_PASS: "NO",
  HANDOFF_PASS: "NO",
  RECOVERY_PASS: "NO",
  AUDIT_PASS: "NO",
  REPLAY_PASS: "NO",
};

before(async () => {
  fixtureServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const addr = fixtureServer.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  FIXTURE_URL = `http://127.0.0.1:${addr.port}/`;

  daemon = await startDaemon({
    port: 0,
    headless: true,
    // A fixture vive em 127.0.0.1. O flag é explícito de propósito: sem ele o
    // guarda de SSRF bloqueia loopback, que é o comportamento correto em produção.
    allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
  } as never);
  BASE = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon?.close();
  await new Promise<void>((r) => fixtureServer?.close(() => r()));
  // stderr, não stdout: rodando na suíte inteira o `node --test` usa stdout como
  // canal serializado entre processos, e texto solto ali corrompe o protocolo
  // ("Unable to deserialize cloned data"). O arquivo passava sozinho e falhava
  // em conjunto exatamente por isso.
  process.stderr.write("\n── FLAGS DO GATE (FASE 67) ──\n");
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
});

async function gestao(rota: string, metodo = "GET", corpo?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: corpo === undefined ? undefined : { "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function acao(tool: string, corpo: Record<string, unknown>): Promise<{ status: number; env: any }> {
  const r = await fetch(`${BASE}/api/v1/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, env: await r.json() };
}

/** Envelope válido é pré-condição de tudo: sem ele não há como distinguir erro de sucesso. */
function envelopeOk(env: any, onde: string): void {
  assert.equal(typeof env.action_id, "string", `${onde}: sem action_id`);
  assert.equal(typeof env.timing?.duration_ms, "number", `${onde}: sem timing`);
  assert.ok("result" in env && "error" in env, `${onde}: envelope incompleto`);
  assert.equal(env.success, true, `${onde}: ${JSON.stringify(env.error)}`);
}

let sessionId = "";

test("1-4. runtime sobe, health responde e o agente cria sessão", async () => {
  const h = await gestao("/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.contract, "1");
  assert.equal(h.body.runtime, "ok");

  const s = await gestao("/api/v1/sessions", "POST", { owner: "NOMOS", profile: "sandbox" });
  // 201 Created é a resposta correta para criação de recurso; 200 é aceito por
  // compatibilidade. Exigir só 200 seria o teste impondo um contrato pior.
  assert.ok(s.status === 201 || s.status === 200, `criação devolveu ${s.status}: ${JSON.stringify(s.body)}`);
  sessionId = s.body.session_id ?? s.body.result?.session_id;
  assert.ok(sessionId, `sessão sem id: ${JSON.stringify(s.body)}`);
});

test("5-6. navega e opera a página por DOM", async () => {
  const g = await acao("browser.goto", { session_id: sessionId, url: FIXTURE_URL });
  envelopeOk(g.env, "goto");

  const o = await acao("browser.observe", { session_id: sessionId, limit: 200 });
  envelopeOk(o.env, "observe");
  const obs = o.env.result;
  assert.ok(obs.elements.length > 0, "observe não trouxe elemento");
  assert.equal(typeof obs.total_elements, "number");
  // Truncamento silencioso faria a página parecer menor do que é.
  assert.equal(typeof obs.truncated, "boolean");

  const f = await acao("browser.find", { session_id: sessionId, target: { role: "button", text: "Entrar" } });
  envelopeOk(f.env, "find");
  assert.ok(f.env.result.box.width > 0, "alvo sem caixa");

  const c = await acao("browser.click", {
    session_id: sessionId,
    target: { role: "button", text: "Entrar" },
    verification: { kind: "URL_CHANGED", expect: "logado" },
  });
  envelopeOk(c.env, "click");
  assert.equal(c.env.result.verification.verified, true, "clique não verificado");
  assert.ok(c.env.result.verification.confidence > 0.5, "confiança baixa demais para verificado");

  const e = await acao("browser.extract", { session_id: sessionId, target: { selector: "#result" } });
  envelopeOk(e.env, "extract");
  assert.match(String(e.env.result.content), /autenticado/, "DOM não refletiu o clique");

  GATE.DOM_PASS = "YES";
});

test("7. opera por accessibility tree", async () => {
  await acao("browser.goto", { session_id: sessionId, url: FIXTURE_URL });
  const o = await acao("browser.observe", { session_id: sessionId, accessibility: true });
  envelopeOk(o.env, "observe(accessibility)");
  const ax = o.env.result.accessibility;
  assert.ok(ax !== null, "árvore de acessibilidade ausente");

  const achouBotao = (function busca(n: any): boolean {
    if (n === null || n === undefined) return false;
    if (n.role === "button" && typeof n.name === "string" && n.name.includes("Entrar")) return true;
    return (n.children ?? []).some(busca);
  })(ax);
  assert.ok(achouBotao, "botão não encontrado na árvore de acessibilidade");

  // Resolver por role/label é o caminho de accessibility do TargetResolver.
  const t = await acao("browser.type", {
    session_id: sessionId,
    target: { role: "textbox", label: "Usuário" },
    text: "operador-nomos",
  });
  envelopeOk(t.env, "type por role/label");

  const e = await acao("browser.extract", { session_id: sessionId, target: { selector: "#user" }, format: "value" });
  envelopeOk(e.env, "extract value");
  assert.match(String(e.env.result.content), /operador-nomos/);

  GATE.ACCESSIBILITY_PASS = "YES";
});

test("8-9. opera por coordenada + mouse, com cursor observável no event bus", async () => {
  await acao("browser.goto", { session_id: sessionId, url: FIXTURE_URL });

  const f = await acao("browser.find", { session_id: sessionId, target: { selector: "#login-btn" } });
  envelopeOk(f.env, "find para coordenada");
  const box = f.env.result.box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Coordenada pura é o último degrau da cascata — o mesmo caminho que a visão
  // usaria depois de devolver uma caixa.
  const ev: any[] = [];
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/events?session_id=${sessionId}`);
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.on("message", (m) => { try { ev.push(JSON.parse(String(m))); } catch { /* frame inválido */ } });

  const c = await acao("browser.click", {
    session_id: sessionId,
    target: { coordinates: { x: cx, y: cy } },
    verification: { kind: "URL_CHANGED", expect: "logado" },
  });
  envelopeOk(c.env, "click por coordenada");
  assert.equal(c.env.result.target.strategy, "coordinates", "não usou a estratégia de coordenada");
  assert.equal(c.env.result.verification.verified, true, "clique por coordenada não verificado");

  const s = await acao("browser.screenshot", { session_id: sessionId, scope: "viewport" });
  envelopeOk(s.env, "screenshot");
  assert.ok(s.env.result.width > 0 && s.env.result.height > 0, "screenshot sem dimensão");

  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  // O cursor visual da NOMOS Web é alimentado por estes eventos. Sem eles a UI
  // desenharia um cursor que não corresponde ao que o runtime fez.
  const mouse = ev.filter((e) => e.event === "mouse.clicked" || e.event === "mouse.moved");
  assert.ok(mouse.length > 0, `nenhum evento de mouse no bus; recebidos: ${ev.map((e) => e.event).join(",")}`);
  for (const e of mouse) {
    assert.equal(e.session_id, sessionId, "evento vazou de outra sessão");
    assert.ok(typeof e.timestamp === "string" && typeof e.source === "string", "envelope de evento incompleto");
  }

  GATE.VISION_MOUSE_PASS = "PARCIAL(coordenada+mouse; sem VisionProvider)";
});

test("10-12. segunda IA assume a mesma sessão, age, e NOMOS reassume", async () => {
  const antes = await gestao(`/api/v1/sessions/${sessionId}`);
  const urlAntes = antes.body.pages?.find((p: any) => p.active)?.url ?? antes.body.pages?.[0]?.url;

  const h1 = await gestao(`/api/v1/sessions/${sessionId}/handoff`, "POST", { to_owner: "AGENTE-B" });
  assert.equal(h1.status, 200, JSON.stringify(h1.body));
  assert.equal(h1.body.owner, "AGENTE-B", "handoff não trocou o dono");

  // A segunda IA executa uma ação real na sessão herdada.
  const a = await acao("browser.type", {
    session_id: sessionId,
    target: { selector: "#user" },
    text: "agente-b",
  });
  envelopeOk(a.env, "ação do AGENTE-B");

  const h2 = await gestao(`/api/v1/sessions/${sessionId}/handoff`, "POST", { to_owner: "NOMOS" });
  assert.equal(h2.body.owner, "NOMOS", "NOMOS não reassumiu");

  const depois = await gestao(`/api/v1/sessions/${sessionId}`);
  const urlDepois = depois.body.pages?.find((p: any) => p.active)?.url ?? depois.body.pages?.[0]?.url;
  assert.equal(urlDepois, urlAntes, "handoff perdeu a URL");

  const e = await acao("browser.extract", { session_id: sessionId, target: { selector: "#user" }, format: "value" });
  assert.match(String(e.env.result.content), /agente-b/, "handoff perdeu o estado da página");

  GATE.HANDOFF_PASS = "YES";
  // Dois donos distintos operaram a MESMA sessão pela mesma API universal. O que
  // falta para MULTI_AI pleno é um segundo provedor de LLM real conectado.
  GATE.MULTI_AI_PASS = "PARCIAL(dois donos via API universal; sem 2o provedor LLM real)";
});

test("13-16. cliente morre, runtime sobrevive, reconecta e o estado é restaurado", async () => {
  const antes = await gestao(`/api/v1/sessions/${sessionId}`);
  const urlAntes = antes.body.pages?.find((p: any) => p.active)?.url ?? antes.body.pages?.[0]?.url;

  const d = await gestao(`/api/v1/sessions/${sessionId}/detach`, "POST", {});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.attached_client, null, "detach não soltou o cliente");

  // O requisito crítico: sem cliente, a sessão continua VIVA e listada.
  const lista = await gestao("/api/v1/sessions");
  assert.ok(lista.body.some((s: any) => s.session_id === sessionId), "sessão sumiu após detach");
  const h = await gestao("/health");
  assert.equal(h.body.runtime, "ok", "runtime caiu junto com o cliente");

  const a = await gestao(`/api/v1/sessions/${sessionId}/attach`, "POST", { client: "NOMOS-reconectado" });
  assert.equal(a.status, 200);
  assert.equal(a.body.attached_client, "NOMOS-reconectado");

  const depois = await gestao(`/api/v1/sessions/${sessionId}`);
  const urlDepois = depois.body.pages?.find((p: any) => p.active)?.url ?? depois.body.pages?.[0]?.url;
  assert.equal(urlDepois, urlAntes, "estado não preservado na reconexão");

  const e = await acao("browser.extract", { session_id: sessionId, target: { selector: "#user" }, format: "value" });
  assert.match(String(e.env.result.content), /agente-b/, "conteúdo da página perdido na reconexão");

  GATE.RUNTIME_INDEPENDENCE_PASS = "YES";
  GATE.RECOVERY_PASS = "PARCIAL(queda de cliente; queda do processo do runtime NÃO coberta)";
});

test("capability sensível é negada mesmo com sessão válida (fail closed)", async () => {
  const u = await acao("browser.upload", {
    session_id: sessionId,
    target: { selector: "#user" },
    path: "/etc/passwd",
  });
  assert.equal(u.status, 403, `upload deveria ser negado, veio ${u.status}`);
  assert.equal(u.env.success, false);
  assert.equal(u.env.error.code, "CAPABILITY_DENIED");
  // Envelope preservado no erro: quem chama distingue "negado" de "quebrou".
  assert.equal(typeof u.env.action_id, "string");
});

test("URL interna e esquema perigoso são bloqueados pelo guarda", async () => {
  const f = await acao("browser.goto", { session_id: sessionId, url: "file:///etc/passwd" });
  assert.equal(f.env.success, false, "file:// deveria ser bloqueado");
  assert.equal(f.env.error.code, "POLICY_BLOCKED");
});

test("FASE 32 — takeover congela TUDO, inclusive observação", async () => {
  const t = await gestao(`/api/v1/sessions/${sessionId}/takeover`, "POST", {});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.control, "human");

  // Congelar ACT é o óbvio. Congelar OBSERVE é o que protege o humano: ele
  // assume o controle justamente para digitar o que não quer delegar, e ler o
  // DOM nesse instante seria o vazamento que o takeover existe para impedir.
  for (const [tool, corpo] of [
    ["browser.click", { target: { selector: "#login-btn" } }],
    ["browser.screenshot", { scope: "viewport" }],
    ["browser.observe", { limit: 5 }],
  ] as const) {
    const r = await acao(tool, { session_id: sessionId, ...corpo });
    assert.equal(r.status, 409, `${tool} deveria ser 409 sob controle humano, veio ${r.status}`);
    assert.equal(r.env.error.code, "CONTROL_HELD_BY_HUMAN");
  }

  const r = await gestao(`/api/v1/sessions/${sessionId}/release`, "POST", {});
  assert.equal(r.body.control, "agent", "release não devolveu o controle");
  // A página pode ter mudado enquanto o humano dirigia; presumir o contrário
  // seria mentira, então a sessão sai em RECOVERING até alguém reobservar.
  assert.equal(r.body.status, "RECOVERING", "release presumiu que a página não mudou");

  const o = await acao("browser.observe", { session_id: sessionId, limit: 5 });
  envelopeOk(o.env, "observe após release");
  const agora = await gestao(`/api/v1/sessions/${sessionId}`);
  assert.equal(agora.body.status, "ACTIVE", "reobservação não liberou a sessão");
});

test("17-20. audit log e replay reconstroem a sessão", async () => {
  const dir = path.join(RAIZ, "sessions", sessionId);
  assert.ok(existsSync(dir), `diretório de sessão ausente: ${dir}`);

  const jsonl = path.join(dir, "actions.jsonl");
  assert.ok(existsSync(jsonl), "actions.jsonl ausente");
  const linhas = readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "");
  assert.ok(linhas.length >= 5, `audit com poucas linhas: ${linhas.length}`);

  const entradas = linhas.map((l) => JSON.parse(l));
  for (const e of entradas) {
    assert.ok(typeof e.timestamp === "string" && typeof e.action === "string", "entrada de audit incompleta");
  }
  assert.ok(entradas.some((e) => String(e.action).includes("click")), "clique não foi auditado");

  // Nenhum segredo nem cookie pode ter entrado no audit.
  const bruto = readFileSync(jsonl, "utf8").toLowerCase();
  for (const proibido of ["set-cookie", "authorization:", '"cookie"']) {
    assert.ok(!bruto.includes(proibido), `audit contém material sensível: ${proibido}`);
  }
  GATE.AUDIT_PASS = "YES";

  const { loadReplay, replaySummary } = await import("../packages/observability/src/replay.ts");
  // `ReplayOptions` é objeto: passar a raiz como string cru passaria no teste
  // por acidente, caindo no default. Isso testaria o default, não o argumento.
  const opts = { root: path.join(RAIZ, "sessions") };
  const rep = await loadReplay(sessionId, opts);
  assert.ok(rep.actions.length > 0, "replay sem ações");
  const linha = await replaySummary(sessionId, opts);
  assert.ok(linha.length > 0, "linha do tempo vazia");
  for (let i = 1; i < linha.length; i++) {
    assert.ok(linha[i]!.timestamp >= linha[i - 1]!.timestamp, "linha do tempo fora de ordem");
  }
  GATE.REPLAY_PASS = "YES";
});

test("screenshots foram gravados como evidência da sessão", async () => {
  const dir = path.join(RAIZ, "sessions", sessionId, "screenshots");
  if (!existsSync(dir)) {
    // Falha declarada, não escondida: sem screenshot não há evidência visual do replay.
    assert.fail("diretório de screenshots ausente — replay visual não é possível");
  }
  const arquivos = readdirSync(dir).filter((f) => f.endsWith(".png"));
  assert.ok(arquivos.length > 0, "nenhum screenshot gravado");

  const { pngDimensions } = await import("../packages/observability/src/png.ts");
  const d = pngDimensions(readFileSync(path.join(dir, arquivos[0]!)));
  assert.ok(d.width > 0 && d.height > 0, "screenshot gravado é inválido");
});

test("sessão fecha e some da lista", async () => {
  const r = await gestao(`/api/v1/sessions/${sessionId}`, "DELETE");
  assert.equal(r.status, 200);
  const lista = await gestao("/api/v1/sessions");
  assert.ok(!lista.body.some((s: any) => s.session_id === sessionId), "sessão continuou listada após close");
});
