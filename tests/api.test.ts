/**
 * FASE 2 / 4 / 5 / 43 / 44 — prova do daemon com Chromium REAL.
 *
 * Mesmo critério de honestidade do spike da FASE 1: nada de mock do navegador.
 * Cada afirmação sobre sessão viva é feita perguntando ao Chromium, não olhando
 * um campo booleano do nosso próprio registro.
 *
 * Onde há risco de asserção vácua, há controle:
 *   - "a sessão sobreviveu ao detach" só vale porque, DEPOIS do detach, uma ação
 *     real (`browser.observe`) volta com a URL da fixture — um `status: "IDLE"`
 *     na listagem provaria apenas que o nosso Map ainda tem a chave;
 *   - "upload é negado" só vale porque a MESMA sessão executa `browser.observe`
 *     com sucesso: se tudo estivesse negado, o 403 não diria nada sobre política;
 *   - "o WebSocket recebe evento" é medido com o socket aberto ANTES da ação,
 *     porque não há replay de histórico na conexão.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { WebSocket } from "ws";
import { startDaemon, SessionQueue, type DaemonHandle } from "../packages/api/src/daemon.ts";
import { ApiError } from "../packages/api/src/handlers.ts";
import { matchRoute, parseEventFilter } from "../packages/api/src/router.ts";
import { loadConfig, parseConfigText } from "../packages/api/src/config.ts";
import { DEFAULT_PROFILES_ROOT } from "../packages/core/src/session.ts";
import { FileVault } from "../packages/core/src/vault.ts";
import type { ActionResponse, RuntimeEvent, SessionInfo } from "../packages/core/src/contract.ts";

const FIXTURE_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>nomos fixture</title>
<style>#rolagem{height:120px;overflow:auto}#rolagem div{height:600px}</style></head>
<body>
  <h1 id="titulo">fixture do daemon</h1>
  <button id="botao">Entrar</button>
  <input id="campo" type="text" placeholder="usuario">
  <input id="arquivo" type="file">
  <div id="painel" hidden>painel secreto</div>
  <div id="rolagem"><div>conteudo alto</div></div>
  <script>
    document.getElementById("botao").addEventListener("click", function () {
      this.textContent = "Autenticado";
      document.getElementById("painel").hidden = false;
      document.body.dataset.state = "autenticado";
      location.hash = "#logado";
    });
  </script>
</body></html>`;

interface Fixture {
  base: string;
  close: () => Promise<void>;
}

/** Servidor local: a prova roda offline, sem rede externa. */
function startFixture(): Promise<Fixture> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("fixture: endereço inválido");
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let fixture: Fixture;
let TOKEN: string | null = null;
let daemon: DaemonHandle;
let sessionsRoot: string;

interface Res<T> {
  status: number;
  body: T;
}

async function call<T>(method: string, route: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${daemon.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-nomos-client": "teste-api",
      // FASE 15: o control plane passou a exigir credencial. O token de arranque
      // vem do próprio handle — nunca de arquivo, para o teste não depender do
      // ambiente do operador.
      ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Corpo não-JSON é FALHA do daemon (ex.: página de erro do Node). O teste
    // precisa ver o texto cru para que a mensagem não vire "undefined".
    throw new Error(`resposta não-JSON em ${method} ${route} (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed as T };
}

function act<T>(tool: string, payload: Record<string, unknown>): Promise<Res<ActionResponse<T>>> {
  return call<ActionResponse<T>>("POST", `/api/v1/${tool}`, payload);
}

/** Envelope bem formado, independentemente de sucesso ou erro. */
function assertEnvelope(env: ActionResponse<unknown>): void {
  assert.equal(typeof env.action_id, "string");
  assert.equal(typeof env.success, "boolean");
  assert.equal(typeof env.state, "string");
  assert.ok("result" in env && "error" in env, "envelope precisa ter result e error");
  assert.equal(typeof env.timing.started_at, "string");
  assert.equal(typeof env.timing.ended_at, "string");
  assert.equal(typeof env.timing.duration_ms, "number");
  assert.ok(env.timing.duration_ms >= 0, `duration_ms deve ser >= 0, veio ${env.timing.duration_ms}`);
}

before(async () => {
  fixture = await startFixture();
  sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "nomos-api-audit-"));
  daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    headless: true,
    // A fixture vive em 127.0.0.1: navegar para host interno é ato explícito
    // (anti-SSRF da FASE 40), nunca inferido de a origem ser local.
    allow_internal_urls: true,
    sessions_root: sessionsRoot,
    action_timeout_ms: 60_000,
    // Ambiente vazio + sem arquivo: a config do operador não pode contaminar a prova.
    env: {},
    read_file: false,
  });
  TOKEN = (daemon as unknown as { token: string | null }).token;
});

after(async () => {
  await daemon?.close("teste");
  await fixture?.close();
  if (sessionsRoot !== undefined) await rm(sessionsRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. /health
// ─────────────────────────────────────────────────────────────────────────────

test("1) GET /health responde 200 com contract=1", async () => {
  const { status, body } = await call<Record<string, unknown>>("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.contract, "1");
  assert.equal(body.runtime, "ok");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.uptime_s, "number");
  assert.ok((body.uptime_s as number) >= 0);
  const workers = body.workers as { active: number; max: number };
  assert.equal(workers.max, daemon.config.max_workers);
  const s = body.sessions as { total: number; active: number; idle: number; paused: number };
  for (const k of ["total", "active", "idle", "paused"] as const) assert.equal(typeof s[k], "number");
  assert.ok(["ok", "starting", "down"].includes(body.browser as string));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sessões
// ─────────────────────────────────────────────────────────────────────────────

let sessionId = "";

test("2) POST /api/v1/sessions cria sessão e GET a lista", async () => {
  const created = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "teste-api",
    // sandbox = perfil efêmero: dir temporário apagado no close, nada em profiles/.
    profile: "sandbox",
    headless: true,
    client: "teste-api",
  });
  assert.equal(created.status, 201, `criação falhou: ${JSON.stringify(created.body)}`);
  assert.equal(typeof created.body.session_id, "string");
  assert.ok(created.body.session_id.startsWith("ses_"));
  assert.equal(created.body.owner, "teste-api");
  assert.equal(created.body.profile, "sandbox");
  assert.equal(created.body.control, "agent");
  assert.equal(created.body.attached_client, "teste-api");
  // Política default é RESTRITA: o que muda o mundo lá fora nasce negado.
  assert.equal(created.body.permissions.upload, false);
  assert.equal(created.body.permissions.read, true);
  sessionId = created.body.session_id;

  const listed = await call<SessionInfo[]>("GET", "/api/v1/sessions");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body));
  const found = listed.body.find((s) => s.session_id === sessionId);
  assert.ok(found !== undefined, "sessão criada tem de aparecer em GET /api/v1/sessions");

  const one = await call<SessionInfo>("GET", `/api/v1/sessions/${sessionId}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.session_id, sessionId);

  const health = await call<Record<string, unknown>>("GET", "/health");
  assert.equal((health.body.sessions as { total: number }).total, 1);
  assert.equal(health.body.browser, "ok", "com sessão viva o Chromium está aberto");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. goto + observe
// ─────────────────────────────────────────────────────────────────────────────

test("3) browser.goto na fixture e browser.observe devolvem envelope com sucesso", async () => {
  const goto = await act<{ url: string; title: string }>("browser.goto", {
    session_id: sessionId,
    url: `${fixture.base}/`,
  });
  assert.equal(goto.status, 200, `goto falhou: ${JSON.stringify(goto.body.error)}`);
  assertEnvelope(goto.body);
  assert.equal(goto.body.success, true);
  assert.equal(goto.body.error, null);
  assert.ok(goto.body.result !== null);
  assert.ok(goto.body.result!.url.startsWith(fixture.base), `URL inesperada: ${goto.body.result!.url}`);

  const obs = await act<{
    url: string;
    title: string;
    elements: { tag: string; text: string | null }[];
    total_elements: number;
    truncated: boolean;
  }>("browser.observe", { session_id: sessionId, limit: 50 });
  assert.equal(obs.status, 200, `observe falhou: ${JSON.stringify(obs.body.error)}`);
  assertEnvelope(obs.body);
  assert.equal(obs.body.success, true);
  assert.ok(obs.body.timing.duration_ms >= 0);
  const observation = obs.body.result!;
  assert.equal(observation.title, "nomos fixture");
  assert.ok(observation.total_elements > 0, "a fixture tem elementos; total_elements zero seria varredura morta");
  // Controle: a observação vem do DOM REAL, então o botão da fixture está lá.
  const botao = observation.elements.find((e) => (e.text ?? "").includes("Entrar"));
  assert.ok(botao !== undefined, "observe tem de enxergar o botão da fixture");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. capability negada
// ─────────────────────────────────────────────────────────────────────────────

test("4) browser.upload sob política restricted devolve 403 CAPABILITY_DENIED", async () => {
  const denied = await act<never>("browser.upload", {
    session_id: sessionId,
    target: { selector: "#arquivo" },
    path: "/etc/passwd",
  });
  assert.equal(denied.status, 403);
  assertEnvelope(denied.body);
  assert.equal(denied.body.success, false);
  assert.equal(denied.body.result, null);
  assert.equal(denied.body.error?.code, "CAPABILITY_DENIED");
  assert.equal(denied.body.error?.detail?.required, "upload");

  // CONTROLE POSITIVO: a mesma sessão faz uma ação PERMITIDA. Sem isto, o 403
  // acima poderia ser "tudo está quebrado" em vez de "a política decidiu".
  const allowed = await act<{ url: string }>("browser.observe", { session_id: sessionId, limit: 5 });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.success, true);

  // E a negação acontece ANTES do navegador: o caminho nem chega a ser checado.
  assert.notEqual(denied.body.error?.code, "UPLOAD_DENIED");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. detach não mata a sessão (FASE 3 / 44)
// ─────────────────────────────────────────────────────────────────────────────

test("5) detach do cliente deixa a sessão viva, órfã e reatável", async () => {
  const detached = await call<SessionInfo>("POST", `/api/v1/sessions/${sessionId}/detach`, {});
  assert.equal(detached.status, 200);
  assert.equal(detached.body.attached_client, null, "detach solta o cliente");
  assert.equal(detached.body.status, "IDLE");

  const listed = await call<SessionInfo[]>("GET", "/api/v1/sessions");
  const still = listed.body.find((s) => s.session_id === sessionId);
  assert.ok(still !== undefined, "sessão órfã continua listada");
  assert.equal(still.attached_client, null);

  // PROVA DE VIDA: continuar na lista é o nosso Map falando de si. O que prova
  // que o Chromium respira é uma ação real voltar com a URL da fixture.
  const obs = await act<{ url: string; title: string }>("browser.observe", { session_id: sessionId, limit: 5 });
  assert.equal(obs.status, 200, `observe após detach falhou: ${JSON.stringify(obs.body.error)}`);
  assert.equal(obs.body.success, true);
  assert.ok(obs.body.result!.url.startsWith(fixture.base), "a página continua onde estava");
  assert.equal(obs.body.result!.title, "nomos fixture");

  const reattached = await call<SessionInfo>("POST", `/api/v1/sessions/${sessionId}/attach`, { client: "teste-api-2" });
  assert.equal(reattached.status, 200);
  assert.equal(reattached.body.attached_client, "teste-api-2");
  assert.equal(reattached.body.status, "ACTIVE");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WebSocket /events
// ─────────────────────────────────────────────────────────────────────────────

test("6) WebSocket /events entrega ao menos um RuntimeEvent após uma ação", async () => {
  const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/events?session_id=${sessionId}${TOKEN !== null ? `&token=${encodeURIComponent(TOKEN)}` : ""}`);
  const frames: RuntimeEvent[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const gotFrame = new Promise<RuntimeEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nenhum evento chegou em 20s")), 20_000);
    ws.on("message", (data: Buffer | string) => {
      const parsed = JSON.parse(String(data)) as RuntimeEvent;
      frames.push(parsed);
      clearTimeout(timer);
      resolve(parsed);
    });
  });

  // Ação só DEPOIS do socket aberto: não há replay de histórico na conexão, e
  // esperar evento anterior à assinatura seria testar algo que não existe.
  const obs = await act("browser.observe", { session_id: sessionId, limit: 5 });
  assert.equal(obs.body.success, true);

  const first = await gotFrame;
  assert.equal(typeof first.timestamp, "string");
  assert.equal(first.session_id, sessionId, "filtro ?session_id= tem de valer");
  assert.equal(typeof first.event, "string");
  assert.ok("payload" in first);

  ws.close();
  await new Promise<void>((r) => ws.once("close", () => r()));

  // O socket morreu; a SESSÃO não. É o requisito da FASE 44.
  const alive = await act<{ url: string }>("browser.observe", { session_id: sessionId, limit: 5 });
  assert.equal(alive.status, 200);
  assert.equal(alive.body.success, true);
  assert.ok(alive.body.result!.url.startsWith(fixture.base));
});

test("6b) filtro ?events= com nome desconhecido fecha o socket em vez de calar", async () => {
  const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/events?events=nao.existe${TOKEN !== null ? `&token=${encodeURIComponent(TOKEN)}` : ""}`);
  const code = await new Promise<number>((resolve, reject) => {
    ws.once("close", (c: number) => resolve(c));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("socket não fechou em 5s")), 5000).unref();
  });
  assert.equal(code, 1008, "nome inválido devolve silêncio se não fechar — silêncio é a mentira aqui");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. rota inexistente
// ─────────────────────────────────────────────────────────────────────────────

test("7) rota inexistente devolve 404 com envelope, não HTML de stack trace", async () => {
  const res = await fetch(`${daemon.url}/api/v1/rota-que-nao-existe`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const text = await res.text();
  assert.ok(!text.includes("<html"), "resposta não pode ser HTML");
  assert.ok(!/\bat .*\.ts:\d+/.test(text), "resposta não pode conter stack trace");
  const env = JSON.parse(text) as ActionResponse<unknown>;
  assertEnvelope(env);
  assert.equal(env.success, false);
  assert.equal(env.result, null);
  assert.equal(env.error?.code, "INVALID_REQUEST");

  // Método errado em caminho existente é 405 — distinto de "não existe".
  const wrong = await fetch(`${daemon.url}/health`, { method: "DELETE" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
  const wrongEnv = (await wrong.json()) as ActionResponse<unknown>;
  assertEnvelope(wrongEnv);
});

test("7b) sessão inexistente e session_id ausente saem no envelope", async () => {
  const missing = await act<never>("browser.observe", { session_id: "ses_naoexiste" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error?.code, "SESSION_NOT_FOUND");
  assertEnvelope(missing.body);

  const noSession = await act<never>("browser.observe", {});
  assert.equal(noSession.status, 400);
  assert.equal(noSession.body.error?.code, "INVALID_REQUEST");
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 43 — fila, concorrência e prazo (unidade pura, sem navegador)
// ─────────────────────────────────────────────────────────────────────────────

test("FASE 43) SessionQueue respeita concorrência e recusa fila cheia com BACKPRESSURE_REJECTED", async () => {
  const q = new SessionQueue(2, 3);
  const releases: (() => void)[] = [];
  const started: number[] = [];
  const submit = (id: number): Promise<number> =>
    q.submit(async () => {
      started.push(id);
      await new Promise<void>((r) => releases.push(r));
      return id;
    }, 5000);

  // 2 executando + 3 aguardando = teto exato.
  const jobs = [submit(1), submit(2), submit(3), submit(4), submit(5)];
  assert.equal(q.running, 2, "só a concorrência configurada roda de fato");
  assert.equal(q.waiting, 3);
  assert.deepEqual(started, [1, 2], "os demais não podem ter começado");

  // A sexta estoura: recusa IMEDIATA, não espera silenciosa.
  await assert.rejects(
    submit(6),
    (e: unknown) => e instanceof ApiError && e.code === "BACKPRESSURE_REJECTED",
    "fila cheia tem de recusar com BACKPRESSURE_REJECTED",
  );

  for (const r of releases.splice(0)) r();
  await new Promise<void>((r) => setImmediate(r));
  for (const r of releases.splice(0)) r();
  await new Promise<void>((r) => setImmediate(r));
  for (const r of releases.splice(0)) r();
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4, 5]);
});

test("FASE 43) prazo estourado devolve TIMEOUT e admite que a ação segue correndo", async () => {
  const q = new SessionQueue(1, 4);
  let liberou = false;
  const lenta = q.submit(async () => {
    await new Promise<void>((r) => setTimeout(r, 300));
    liberou = true;
    return "tarde demais";
  }, 40);

  await assert.rejects(lenta, (e: unknown) => {
    if (!(e instanceof ApiError)) return false;
    assert.equal(e.code, "TIMEOUT");
    // Honestidade: o Playwright não oferece cancelamento cooperativo aqui, então
    // o envelope NÃO pode sugerir que a ação parou.
    assert.equal(e.detail?.still_running, true);
    return true;
  });
  assert.equal(liberou, false, "no instante do TIMEOUT a ação ainda não tinha terminado");
});

// ─────────────────────────────────────────────────────────────────────────────
// Unidades puras: roteador e configuração
// ─────────────────────────────────────────────────────────────────────────────

test("roteador distingue rota ausente de método errado e conhece as ações do contrato", () => {
  assert.equal(matchRoute("GET", "/health").kind, "match");
  assert.equal(matchRoute("POST", "/health").kind, "method_not_allowed");
  assert.equal(matchRoute("GET", "/nao/existe").kind, "not_found");

  const action = matchRoute("POST", "/api/v1/browser.click");
  assert.equal(action.kind, "match");
  if (action.kind === "match") {
    assert.equal(action.route.name, "action");
    assert.equal(action.route.tool, "browser.click");
    assert.equal(action.route.envelope, true);
  }
  // Verbo que não está em ACTION_CLASS não vira rota — fail closed no roteador.
  assert.equal(matchRoute("POST", "/api/v1/browser.formatar_disco").kind, "not_found");

  const withId = matchRoute("POST", "/api/v1/sessions/ses_abc/takeover");
  assert.equal(withId.kind, "match");
  if (withId.kind === "match") assert.equal(withId.route.params.id, "ses_abc");
});

test("parseEventFilter separa evento conhecido de desconhecido", () => {
  const f = parseEventFilter(new URLSearchParams("session_id=ses_1&events=mouse.clicked,task.progress,inventado"));
  assert.equal(f.session_id, "ses_1");
  assert.deepEqual(f.events, ["mouse.clicked", "task.progress"]);
  assert.deepEqual(f.unknown, ["inventado"]);
});

test("config: ambiente vence arquivo, override vence ambiente, lixo não é coagido", () => {
  const cfg = loadConfig({
    read_file: false,
    env: { NOMOS_BROWSER_PORT: "9123", NOMOS_BROWSER_HEADLESS: "true" },
  });
  assert.equal(cfg.port, 9123);
  assert.equal(cfg.headless, true);
  assert.equal(cfg.sources.port, "env:NOMOS_BROWSER_PORT");

  const overridden = loadConfig({ read_file: false, env: { NOMOS_BROWSER_PORT: "9123" }, port: 0 });
  assert.equal(overridden.port, 0);
  assert.equal(overridden.sources.port, "override");

  // Coerção silenciosa é o defeito: "abc" NÃO pode virar 7777.
  assert.throws(() => loadConfig({ read_file: false, env: { NOMOS_BROWSER_PORT: "abc" } }), /inteiro entre/);
  // "full" não se conquista escrevendo uma string na configuração.
  assert.throws(() => loadConfig({ read_file: false, env: { NOMOS_BROWSER_POLICY: "full" } }), /desconhecida/);

  const parsed = parseConfigText("# comentário\nhost: 0.0.0.0\nviewport:\n  width: 800\n", "teste");
  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed["viewport.width"], "800");
});

// ─────────────────────────────────────────────────────────────────────────────
// Cobertura das demais rotas de `docs/API.md`
//
// Sessão própria e descartável: um teste que dependesse da ordem em relação aos
// anteriores mediria a ordem, não a rota.
// ─────────────────────────────────────────────────────────────────────────────

test("rotas de ação restantes operam contra o Chromium real", async (t) => {
  const created = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "teste-rotas",
    profile: "sandbox",
    headless: true,
    client: "teste-rotas",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sid = created.body.session_id;

  try {
    await act("browser.goto", { session_id: sid, url: `${fixture.base}/` });

    await t.test("browser.find resolve o alvo e diz por qual estratégia", async () => {
      const found = await act<{ strategy: string; box: { width: number }; handle?: unknown }>("browser.find", {
        session_id: sid,
        target: { role: "button", text: "Entrar" },
      });
      assert.equal(found.status, 200, JSON.stringify(found.body.error));
      assert.equal(found.body.success, true);
      assert.ok(found.body.result!.box.width > 0, "caixa de área zero seria alvo não renderizado");
      // O handle é opaco e NÃO atravessa a fronteira da API (contrato).
      assert.ok(!("handle" in found.body.result!), "handle não pode vazar no JSON");
    });

    await t.test("browser.click muda a página de verdade e a verificação confirma", async () => {
      const clicked = await act<{ verification: { verified: boolean; kind: string; confidence: number } }>(
        "browser.click",
        {
          session_id: sid,
          target: { selector: "#botao" },
          verification: { kind: "URL_CHANGED", timeout_ms: 3000 },
        },
      );
      assert.equal(clicked.status, 200, JSON.stringify(clicked.body.error));
      assert.equal(clicked.body.success, true);
      assert.equal(clicked.body.result!.verification.kind, "URL_CHANGED");
      assert.equal(clicked.body.result!.verification.verified, true, "o hash da fixture muda no clique");

      // EVIDÊNCIA INDEPENDENTE da verificação: o DOM mudou. Sem isto, um
      // verificador complacente faria o teste passar sem clique nenhum.
      const texto = await act<{ content: string }>("browser.extract", {
        session_id: sid,
        target: { selector: "#botao" },
      });
      assert.equal(texto.body.result!.content.trim(), "Autenticado");
    });

    await t.test("browser.wait espera condição verificável, não duração fixa", async () => {
      const visible = await act<{ waited_ms: number; satisfied: boolean }>("browser.wait", {
        session_id: sid,
        condition: "element_visible",
        value: "#painel",
        timeout_ms: 3000,
      });
      assert.equal(visible.status, 200, JSON.stringify(visible.body.error));
      assert.equal(visible.body.result!.satisfied, true);

      // Condição que NUNCA acontece tem de estourar como TIMEOUT — se qualquer
      // espera "desse certo", a rota não estaria verificando nada.
      const nunca = await act<never>("browser.wait", {
        session_id: sid,
        condition: "element_visible",
        value: "#nao-existe-jamais",
        timeout_ms: 300,
      });
      assert.equal(nunca.status, 504);
      assert.equal(nunca.body.error?.code, "TIMEOUT");
    });

    await t.test("browser.type escreve no campo e browser.press dispara tecla", async () => {
      const typed = await act<{ typed_length: number }>("browser.type", {
        session_id: sid,
        target: { selector: "#campo" },
        text: "nomos-operador",
      });
      assert.equal(typed.status, 200, JSON.stringify(typed.body.error));
      assert.equal(typed.body.result!.typed_length, "nomos-operador".length);

      // Prova de que o texto entrou: lê de volta do DOM.
      const valor = await act<{ content: string }>("browser.extract", {
        session_id: sid,
        target: { selector: "#campo" },
        format: "value",
      });
      assert.equal(valor.body.result!.content, "nomos-operador");

      const pressed = await act<{ pressed: string[] }>("browser.press", { session_id: sid, key: "Backspace" });
      assert.equal(pressed.status, 200, JSON.stringify(pressed.body.error));
      const depois = await act<{ content: string }>("browser.extract", {
        session_id: sid,
        target: { selector: "#campo" },
        format: "value",
      });
      assert.equal(depois.body.result!.content, "nomos-operado", "Backspace tem de apagar um caractere");
    });

    await t.test("browser.scroll rola o contêiner alvo", async () => {
      const scrolled = await act<{ scrolled: { dx: number; dy: number } }>("browser.scroll", {
        session_id: sid,
        target: { selector: "#rolagem" },
        dy: 200,
      });
      assert.equal(scrolled.status, 200, JSON.stringify(scrolled.body.error));
      assert.equal(scrolled.body.result!.scrolled.dy, 200);
    });

    await t.test("browser.screenshot devolve referência e dimensões lidas do PNG", async () => {
      const shot = await act<{ screenshot_ref: string; width: number; height: number; bytes: number }>(
        "browser.screenshot",
        { session_id: sid, scope: "viewport" },
      );
      assert.equal(shot.status, 200, JSON.stringify(shot.body.error));
      assert.ok(shot.body.result!.width > 0 && shot.body.result!.height > 0);
      assert.ok(shot.body.result!.bytes > 1000, "PNG de viewport não cabe em 1 kB");

      const elemento = await act<{ width: number; height: number }>("browser.screenshot", {
        session_id: sid,
        scope: "element",
        target: { selector: "#botao" },
      });
      assert.equal(elemento.status, 200, JSON.stringify(elemento.body.error));
      assert.ok(elemento.body.result!.width > 0);
    });

    await t.test("abas: tabs, new_tab, switch_tab, close_tab", async () => {
      const antes = await act<{ page_id: string; active: boolean }[]>("browser.tabs", { session_id: sid });
      assert.equal(antes.status, 200, JSON.stringify(antes.body.error));
      assert.equal(antes.body.result!.length, 1);
      const primeira = antes.body.result![0]!.page_id;

      const nova = await act<{ page_id: string }>("browser.new_tab", { session_id: sid, url: `${fixture.base}/dois` });
      assert.equal(nova.status, 200, JSON.stringify(nova.body.error));
      const segunda = nova.body.result!.page_id;
      assert.notEqual(segunda, primeira);

      const duas = await act<{ page_id: string }[]>("browser.tabs", { session_id: sid });
      assert.equal(duas.body.result!.length, 2);

      const trocou = await act<{ page_id: string; active: boolean }>("browser.switch_tab", {
        session_id: sid,
        page_id: primeira,
      });
      assert.equal(trocou.status, 200, JSON.stringify(trocou.body.error));
      assert.equal(trocou.body.result!.active, true);

      const fechou = await act<{ closed: boolean }>("browser.close_tab", { session_id: sid, page_id: segunda });
      assert.equal(fechou.status, 200, JSON.stringify(fechou.body.error));
      const final = await act<unknown[]>("browser.tabs", { session_id: sid });
      assert.equal(final.body.result!.length, 1);
    });

    await t.test("histórico: back, forward, reload", async () => {
      await act("browser.goto", { session_id: sid, url: `${fixture.base}/a` });
      await act("browser.goto", { session_id: sid, url: `${fixture.base}/b` });

      const back = await act<{ url: string }>("browser.back", { session_id: sid });
      assert.equal(back.status, 200, JSON.stringify(back.body.error));
      assert.ok(back.body.result!.url.endsWith("/a"), `voltou para ${back.body.result!.url}`);

      const fwd = await act<{ url: string }>("browser.forward", { session_id: sid });
      assert.equal(fwd.status, 200, JSON.stringify(fwd.body.error));
      assert.ok(fwd.body.result!.url.endsWith("/b"));

      const reload = await act<{ url: string }>("browser.reload", { session_id: sid });
      assert.equal(reload.status, 200, JSON.stringify(reload.body.error));
      assert.ok(reload.body.result!.url.endsWith("/b"));
    });

    await t.test("browser.network registra tráfego e declara o que descartou", async () => {
      // A primeira chamada ANEXA o log; só depois dela há o que contar. Afirmar
      // tráfego antes disso mediria o instante do attach, não a rede.
      const primeiro = await act<{ requests: unknown[]; attached: boolean }>("browser.network", { session_id: sid });
      assert.equal(primeiro.status, 200, JSON.stringify(primeiro.body.error));
      assert.equal(primeiro.body.result!.attached, true);

      await act("browser.reload", { session_id: sid });
      const depois = await act<{ requests: { url: string; method: string }[]; dropped: number; total: number }>(
        "browser.network",
        { session_id: sid, limit: 50 },
      );
      assert.ok(depois.body.result!.requests.length > 0, "um reload gera pelo menos um pedido");
      assert.equal(typeof depois.body.result!.dropped, "number");
      assert.ok(depois.body.result!.requests.some((r) => r.url.startsWith(fixture.base)));
    });

    await t.test("browser.download é negado por capability antes de tocar o disco", async () => {
      const denied = await act<never>("browser.download", { session_id: sid, url: `${fixture.base}/arquivo` });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error?.code, "CAPABILITY_DENIED");
      assert.equal(denied.body.error?.detail?.required, "download");
    });

    await t.test("browser.task sem AgentProvider falha explicitamente, não devolve QUEUED decorativo", async () => {
      const task = await act<never>("browser.task", { session_id: sid, goal: "fazer algo" });
      assert.equal(task.status, 400);
      assert.equal(task.body.error?.code, "INVALID_REQUEST");
      assert.match(task.body.error?.message ?? "", /AgentProvider/);
      assert.equal(task.body.result, null, "não pode vir uma task fingindo estar enfileirada");
    });

    await t.test("alvo inexistente e ambíguo saem com o código certo", async () => {
      const naoExiste = await act<never>("browser.click", {
        session_id: sid,
        target: { selector: "#jamais-existiu" },
      });
      assert.equal(naoExiste.status, 404);
      assert.equal(naoExiste.body.error?.code, "TARGET_NOT_FOUND");

      const invalido = await act<never>("browser.click", { session_id: sid, target: { chave_inventada: "x" } });
      assert.equal(invalido.status, 400);
      assert.equal(invalido.body.error?.code, "INVALID_REQUEST");
    });

    await t.test("takeover congela o agente com 409 e release exige reobservação", async () => {
      const took = await call<SessionInfo>("POST", `/api/v1/sessions/${sid}/takeover`, {});
      assert.equal(took.status, 200);
      assert.equal(took.body.control, "human");
      assert.equal(took.body.status, "PAUSED");

      const blocked = await act<never>("browser.observe", { session_id: sid });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error?.code, "CONTROL_HELD_BY_HUMAN");

      const released = await call<SessionInfo>("POST", `/api/v1/sessions/${sid}/release`, {});
      assert.equal(released.status, 200);
      assert.equal(released.body.control, "agent");
      assert.equal(released.body.status, "RECOVERING", "release NÃO presume que a página continua onde estava");

      // Quem reobserva de fato é quem libera ACTIVE.
      const obs = await act<{ url: string }>("browser.observe", { session_id: sid, limit: 5 });
      assert.equal(obs.status, 200, JSON.stringify(obs.body.error));
      const agora = await call<SessionInfo>("GET", `/api/v1/sessions/${sid}`);
      assert.equal(agora.body.status, "ACTIVE");
    });

    await t.test("handoff troca o dono preservando URL e abas", async () => {
      const antes = await call<SessionInfo>("GET", `/api/v1/sessions/${sid}`);
      const urlAntes = antes.body.pages.find((p) => p.active)?.url;
      const handed = await call<SessionInfo>("POST", `/api/v1/sessions/${sid}/handoff`, { to_owner: "outro-agente" });
      assert.equal(handed.status, 200, JSON.stringify(handed.body));
      assert.equal(handed.body.owner, "outro-agente");
      assert.equal(handed.body.pages.find((p) => p.active)?.url, urlAntes);
    });

    await t.test("URL de esquema proibido é bloqueada antes da navegação (anti-SSRF)", async () => {
      const bloqueada = await act<never>("browser.goto", { session_id: sid, url: "file:///etc/passwd" });
      assert.equal(bloqueada.status, 403);
      assert.equal(bloqueada.body.error?.code, "POLICY_BLOCKED");
    });
  } finally {
    await call("DELETE", `/api/v1/sessions/${sid}`, {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 18 — segredo injetado por referência não aparece em resposta, evento ou trilha
// ─────────────────────────────────────────────────────────────────────────────

test("browser.type com credential_ref injeta sem vazar em resposta, evento ou audit", async () => {
  const SEGREDO = "S3nh4-SUPER-secreta-nomos-9f2a";
  const perfil = `tst-vault-${Math.random().toString(36).slice(2, 8)}`;
  const perfilDir = path.join(DEFAULT_PROFILES_ROOT, perfil);
  await new FileVault(perfil).put("senha_teste", SEGREDO);

  const created = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "teste-vault",
    profile: perfil,
    headless: true,
    client: "teste-vault",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sid = created.body.session_id;

  // Socket aberto ANTES da injeção: evento emitido depois é o que interessa.
  const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/events?session_id=${sid}${TOKEN !== null ? `&token=${encodeURIComponent(TOKEN)}` : ""}`);
  const eventos: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (data: Buffer | string) => eventos.push(String(data)));

  try {
    await act("browser.goto", { session_id: sid, url: `${fixture.base}/` });

    const typed = await act<{ credential_ref: string; injected: boolean; secret_verified: boolean }>("browser.type", {
      session_id: sid,
      target: { selector: "#campo" },
      credential_ref: "senha_teste",
    });
    assert.equal(typed.status, 200, JSON.stringify(typed.body.error));
    assert.equal(typed.body.result!.credential_ref, "senha_teste");
    assert.equal(typed.body.result!.injected, true);

    // CONTROLE POSITIVO. "não achei o segredo no log" só significa alguma coisa
    // se o segredo tiver de fato existido: aqui ele é lido de volta do DOM real.
    const valor = await act<{ content: string }>("browser.extract", {
      session_id: sid,
      target: { selector: "#campo" },
      format: "value",
    });
    assert.equal(valor.body.result!.content, SEGREDO, "sem isto, o teste de vazamento seria vácuo");

    // 1. A resposta da injeção não carrega valor, comprimento nem prefixo.
    assert.ok(!JSON.stringify(typed.body).includes(SEGREDO), "segredo vazou no envelope de browser.type");

    // 2. Nenhum evento do bus carrega o valor.
    await new Promise<void>((r) => setTimeout(r, 200));
    const usou = eventos.filter((e) => e.includes('"secret.used"'));
    assert.ok(usou.length > 0, "a injeção tem de emitir secret.used — auditar o uso é o ponto");
    for (const frame of eventos) {
      assert.ok(!frame.includes(SEGREDO), `segredo vazou num RuntimeEvent: ${frame.slice(0, 160)}`);
    }

    // 3. A trilha JSONL no disco também não.
    const trilha = path.join(sessionsRoot, sid, "actions.jsonl");
    const conteudo = await readFile(trilha, "utf8");
    assert.ok(conteudo.length > 0, "a ação tem de ter deixado trilha");
    assert.ok(conteudo.includes("browser.type"), "a trilha tem de registrar a ação");
    assert.ok(!conteudo.includes(SEGREDO), "segredo vazou no audit log");

    // 4. Referência inexistente falha explicitamente, sem cair em digitação vazia.
    const inexistente = await act<never>("browser.type", {
      session_id: sid,
      target: { selector: "#campo" },
      credential_ref: "nao_existe",
    });
    assert.equal(inexistente.body.success, false);
    assert.equal(inexistente.body.error?.code, "INVALID_REQUEST");
  } finally {
    ws.close();
    await call("DELETE", `/api/v1/sessions/${sid}`, {});
    await rm(perfilDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Encerramento: nenhum Chromium fica para trás
// ─────────────────────────────────────────────────────────────────────────────

test("encerramento fecha a sessão e o pool volta a zero", async () => {
  const del = await call<{ closed: boolean }>("DELETE", `/api/v1/sessions/${sessionId}`, {});
  assert.equal(del.status, 200);
  assert.equal(del.body.closed, true);

  const listed = await call<SessionInfo[]>("GET", "/api/v1/sessions");
  assert.equal(
    listed.body.find((s) => s.session_id === sessionId),
    undefined,
    "sessão fechada sai da listagem padrão",
  );
  const health = await call<Record<string, unknown>>("GET", "/health");
  assert.equal((health.body.sessions as { total: number }).total, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 17 — configuração como contrato consultável
//
// Duas rotas, dois riscos diferentes, dois escopos diferentes. Os testes abaixo
// provam a diferença COM UMA SEGUNDA IDENTIDADE de escopo baixo — não por
// leitura da tabela `ROUTE_SCOPE`, que provaria apenas que uma constante é
// igual a si mesma.
// ─────────────────────────────────────────────────────────────────────────────

/** Chamada com um token QUALQUER, para poder falar como um portador limitado. */
async function callComToken<T>(method: string, route: string, token: string): Promise<Res<T>> {
  const res = await fetch(`${daemon.url}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-nomos-client": "teste-api", authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as T };
}

test("GET /api/v1/config/schema devolve a FORMA e nenhum valor efetivo", async () => {
  const res = await call<{ versao_schema: number; valores_efetivos: boolean; chaves: Record<string, unknown>[] }>(
    "GET",
    "/api/v1/config/schema",
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.valores_efetivos, false, "a rota de schema não pode se anunciar como valores efetivos");
  assert.ok(res.body.chaves.length >= 50, `schema raso demais: ${res.body.chaves.length} chaves`);

  const porChave = new Map(res.body.chaves.map((c) => [c.chave as string, c]));
  const porta = porChave.get("port");
  assert.ok(porta !== undefined, "port não está no schema");
  assert.equal(porta.faixa, "0..65535");
  assert.equal(porta.env, "NOMOS_BROWSER_PORT");
  // Este daemon subiu com `port: 0` (efêmera) e está numa porta real. Se o
  // schema carregasse ESTADO, `default` seria a porta viva; ele carrega o valor
  // de fábrica, que é o contrato.
  assert.equal(porta.default, 7777);
  assert.notEqual(porta.default, daemon.port);

  // `sessions_root` deste daemon é um diretório temporário real. Nem o caminho
  // nem o /tmp podem aparecer numa resposta que promete "só a forma".
  assert.ok(!JSON.stringify(res.body).includes(sessionsRoot), "o schema vazou o sessions_root efetivo");
});

test("GET /api/v1/config devolve valores EFETIVOS com os sensíveis redigidos", async () => {
  const res = await call<{
    valores_efetivos: boolean;
    redacao: string;
    valores: Record<string, unknown>;
    runtime: { port: number; bind: string };
  }>("GET", "/api/v1/config");
  assert.equal(res.status, 200);
  assert.equal(res.body.valores_efetivos, true);

  // `valores` é o que foi CONFIGURADO: este daemon pediu porta efêmera (0).
  assert.equal(res.body.valores.port, 0);
  assert.equal(res.body.valores.headless, true);
  // `runtime` é o que está EM VIGOR — e as duas coisas são diferentes de
  // propósito. Uma rota que só publicasse o pedido mentiria ao se anunciar
  // efetiva; uma que só publicasse o resultado apagaria o pedido do operador.
  assert.equal(res.body.runtime.port, daemon.port);
  assert.notEqual(res.body.runtime.port, res.body.valores.port);
  assert.equal(res.body.runtime.bind, `${daemon.host}:${daemon.port}`);

  // E o caminho do dono NÃO viaja.
  assert.equal(res.body.valores.sessions_root, res.body.redacao, "sessions_root saiu em claro");
  assert.ok(!JSON.stringify(res.body).includes(sessionsRoot), "o caminho absoluto vazou apesar da redação");

  // A proveniência continua respondendo "por que está assim?" — nomeia a
  // origem, nunca o conteúdo dela.
  const fontes = res.body.valores.sources as Record<string, string>;
  assert.equal(fontes.sessions_root, "override");
  assert.equal(fontes.allow_unleased, "default");
});

test("um portador de escopo OBSERVE lê o schema mas é BARRADO nos valores", async () => {
  // A segunda identidade: só OBSERVE, nada de ADMIN.
  const { secret } = daemon.auth.issue({ subject: "curioso", preset: "observe" });

  const forma = await callComToken<{ chaves: unknown[] }>("GET", "/api/v1/config/schema", secret);
  assert.equal(forma.status, 200, "OBSERVE deveria poder ler a FORMA da configuração");
  assert.ok(Array.isArray(forma.body.chaves));

  const valores = await callComToken<{ error?: { code?: string } }>("GET", "/api/v1/config", secret);
  assert.equal(valores.status, 403, "OBSERVE não pode ler os valores efetivos");
  assert.equal(valores.body.error?.code, "CAPABILITY_DENIED");

  // Controle: o MESMO pedido com o token ADMIN do daemon passa. Sem isto, o 403
  // acima poderia vir de a rota simplesmente não existir.
  const comAdmin = await call<{ valores_efetivos: boolean }>("GET", "/api/v1/config");
  assert.equal(comAdmin.status, 200);
});

test("as rotas de configuração recusam método errado sem virar 404", async () => {
  // 404 num caminho que existe esconderia do cliente que a rota está lá.
  const res = await fetch(`${daemon.url}/api/v1/config/schema`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 18 — REPLAY SOMENTE LEITURA
//
// "Somente leitura" é fácil de afirmar e fácil de perder. Aqui ela é medida em
// três camadas independentes, porque cada uma falha de um jeito diferente:
//
//   1. ROTEAMENTO — não existe verbo de escrita em `/replay`. Uma tela pode
//      esquecer de esconder um botão; uma rota que não existe não pode ser
//      chamada. Esta é a camada que não depende de ninguém lembrar de nada.
//   2. RESSURREIÇÃO — ler o histórico de uma sessão encerrada não a traz de
//      volta. Sem isto, "read only" seria verdade sobre a ROTA e mentira sobre
//      o SISTEMA: bastaria ler o replay e depois agir na sessão que voltou.
//   3. HONESTIDADE — o replay relata o que não conseguiu ler, em vez de
//      devolver uma linha do tempo mais curta que se apresenta como completa.
// ─────────────────────────────────────────────────────────────────────────────

interface RespostaReplay {
  session_id: string;
  read_only: boolean;
  mode: string;
  selado: boolean;
  leitura: { linhas_corrompidas: number; fontes_ausentes: string[]; result_erro: string | null };
  contagens: { acoes: number; eventos: number; rede: number; screenshots: number };
  timeline: { source: string; label: string; action_id: string | null }[];
}

/** Sessão real, ação real, encerrada — o insumo honesto do replay. */
async function sessaoGravadaEEncerrada(): Promise<string> {
  const criada = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "teste-replay",
    capabilities: { navigate: true, read: true },
  });
  const sid = criada.body.session_id;
  await act("browser.open", { session_id: sid, url: fixture.base });
  await act("browser.observe", { session_id: sid });
  await call("DELETE", `/api/v1/sessions/${sid}`);
  return sid;
}

test("FASE 18 — o replay devolve a linha do tempo REAL da sessão encerrada", async () => {
  const sid = await sessaoGravadaEEncerrada();
  const res = await call<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`);
  assert.equal(res.status, 200);
  assert.equal(res.body.session_id, sid);

  // O MODO vem do runtime, não é deduzido pela tela.
  assert.equal(res.body.read_only, true);
  assert.equal(res.body.mode, "REPLAY");

  // Asserção vácua seria conferir só o formato. O que prova que isto é replay
  // de ALGO é a ação real aparecer na linha do tempo com o rótulo dela.
  assert.ok(res.body.contagens.acoes > 0, "nenhuma ação gravada — o replay está vazio");
  const rotulos = res.body.timeline.map((i) => i.label).join(" | ");
  assert.ok(/browser\.open/.test(rotulos), `browser.open não apareceu no replay: ${rotulos}`);
  assert.ok(/browser\.observe/.test(rotulos), `browser.observe não apareceu no replay: ${rotulos}`);

  // Honestidade da leitura: sem linhas corrompidas nesta sessão íntegra.
  assert.equal(res.body.leitura.linhas_corrompidas, 0);
});

test("FASE 18 — READ_ONLY é propriedade da TABELA DE ROTAS, não da interface", async () => {
  const sid = await sessaoGravadaEEncerrada();
  // Nenhum verbo de escrita existe neste caminho. 405 (não 404) porque negar a
  // existência da rota esconderia do cliente o que está lá.
  for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`${daemon.url}/api/v1/sessions/${sid}/replay`, {
      method: metodo,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 405, `${metodo} /replay deveria ser 405, veio ${res.status}`);
    assert.equal(res.headers.get("allow"), "GET", `${metodo} /replay: Allow errado`);
  }
  // Controle: o GET no MESMO caminho passa. Sem ele, os 405 acima poderiam vir
  // de o caminho não existir.
  const leitura = await call<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`);
  assert.equal(leitura.status, 200);
});

test("FASE 18 — ler o replay NÃO ressuscita a sessão", async () => {
  const sid = await sessaoGravadaEEncerrada();
  await call<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`);

  // Depois de ler o histórico inteiro, agir sobre aquela sessão continua sendo
  // agir sobre algo que não existe.
  const tentativa = await act("browser.observe", { session_id: sid });
  assert.equal(tentativa.body.success, false, "a sessão do replay aceitou uma ação");

  // O código é `CAPABILITY_DENIED`, não `SESSION_NOT_FOUND`, e isso foi MEDIDO,
  // não presumido: o gate de lease roda antes da busca da sessão, e uma sessão
  // encerrada não tem lease. A recusa acontece no portão MAIS CEDO possível —
  // que é a ordem certa para um gate de segurança, ainda que o código diga
  // menos sobre a causa do que "essa sessão não existe mais" diria.
  //
  // A asserção fixa o código de propósito: se um dia esta chamada passar a
  // devolver sucesso — ou um erro que o cliente trate como "tente de novo" —
  // o teste cai.
  assert.equal(tentativa.body.error?.code, "CAPABILITY_DENIED");
  assert.equal(
    (tentativa.body.error?.detail as { reason?: string } | undefined)?.reason,
    "CONTROL_NOT_OWNED",
  );

  // E ela não voltou para a listagem de sessões vivas.
  const listadas = await call<SessionInfo[]>("GET", "/api/v1/sessions");
  assert.equal(listadas.body.find((s) => s.session_id === sid), undefined);
});

test("FASE 18 — o replay relata o que não conseguiu ler, em vez de encurtar a linha do tempo", async () => {
  const sid = await sessaoGravadaEEncerrada();
  const antes = await call<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`);
  assert.equal(antes.body.leitura.linhas_corrompidas, 0);

  // A sessão curta grava `actions.jsonl` e mais nada — `events.jsonl`,
  // `network.jsonl`, `screenshots` e `result.json` nem existem, e o replay já
  // os declara em `fontes_ausentes` em vez de fingir uma sessão completa.
  assert.ok(
    antes.body.leitura.fontes_ausentes.length > 0,
    "esta sessão curta não grava todas as fontes — o replay deveria dizê-lo",
  );

  // Corrompe UMA linha da trilha que EXISTE. O modo de falha perigoso seria o
  // replay engolir a linha quebrada e devolver 200 com uma linha do tempo
  // silenciosamente incompleta — indistinguível de uma sessão que fez menos.
  const trilha = path.join(sessionsRoot, sid, "actions.jsonl");
  const original = await readFile(trilha, "utf8");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(trilha, `${original}{isto nao e json\n`, "utf8");

  const depois = await call<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`);
  assert.equal(depois.status, 200, "corrupção não deve derrubar a leitura — deve ser RELATADA");
  assert.ok(
    depois.body.leitura.linhas_corrompidas > 0,
    "o replay engoliu a linha corrompida e se apresentou como íntegro",
  );

  await writeFile(trilha, original, "utf8");
});

test("FASE 18 — \"não existe\" não vira \"não fez nada\"", async () => {
  // Uma sessão inventada e uma sessão real que gravou pouco têm exatamente a
  // MESMA forma no bundle: arrays vazios e todas as fontes ausentes. Devolver
  // 200 para as duas faria a tela afirmar "essa sessão não fez nada" sobre algo
  // que nunca houve — uma mentira que parece um dado.
  const inventada = await call<{ error?: { code?: string } }>(
    "GET",
    "/api/v1/sessions/ses_nunca_existiu_0000/replay",
  );
  assert.equal(inventada.status, 404);
  assert.equal(inventada.body.error?.code, "SESSION_NOT_FOUND");

  // Controle: uma sessão que EXISTE e gravou pouco continua sendo 200, com a
  // ausência das fontes declarada em vez de escondida. Sem este controle, o 404
  // acima poderia estar recusando todo replay.
  const real = await sessaoGravadaEEncerrada();
  const ok = await call<RespostaReplay>("GET", `/api/v1/sessions/${real}/replay`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.leitura.fontes_ausentes.length > 0);
});

test("FASE 18 — quem pode LER o replay não pode APROVAR, delegar modo nem retomar", async () => {
  const sid = await sessaoGravadaEEncerrada();
  const { secret } = daemon.auth.issue({ subject: "auditor", preset: "observe" });

  // A trilha é o que torna auditável o que o agente fez. Trancá-la em ADMIN
  // empurraria o auditor para fora, então OBSERVE lê.
  const leitura = await callComToken<RespostaReplay>("GET", `/api/v1/sessions/${sid}/replay`, secret);
  assert.equal(leitura.status, 200, "OBSERVE deveria poder auditar o replay");
  assert.equal(leitura.body.read_only, true);

  // Mas o mesmo portador não alcança nenhuma alavanca do dono. Este é o eixo
  // inteiro do AUTO != BYPASS: quem age nunca é quem autoriza.
  const proibidas: [string, string][] = [
    ["POST", `/api/v1/approvals/apr_qualquer/approve`],
    ["POST", `/api/v1/sessions/${sid}/autonomy`],
    ["POST", `/api/v1/autonomy/default`],
    ["POST", `/api/v1/sessions/${sid}/resume`],
  ];
  for (const [metodo, rota] of proibidas) {
    const res = await callComToken<{ error?: { code?: string } }>(metodo, rota, secret);
    assert.equal(res.status, 403, `${rota} deveria ser 403 para OBSERVE, veio ${res.status}`);
    assert.equal(res.body.error?.code, "CAPABILITY_DENIED");
  }

  // Controle: PARAR nunca pode ser mais difícil que agir — e o token de AGENTE
  // (não o de leitura) alcança o freio.
  const agente = daemon.auth.issue({ subject: "agente", preset: "agent" });
  const freio = await callComToken<unknown>("POST", `/api/v1/sessions/${sid}/pause`, agente.secret);
  assert.notEqual(freio.status, 403, "o perfil de agente não alcança o próprio freio");
});

// ─────────────────────────────────────────────────────────────────────────────
// FECHAR, SELAR E LER — três defeitos que a bateria de demos encontrou
//
// Os três tinham o mesmo formato: o produto se comportava bem e o VERIFICADOR
// dizia que não. Em nenhum deles o verificador estava errado.
// ─────────────────────────────────────────────────────────────────────────────

interface RelatorioVerificacao {
  integro: boolean;
  contagens: { erros: number; avisos: number };
  problemas: { codigo: string; severidade: string; arquivo?: string }[];
}

test("fechar a sessão grava result.json e o bundle nasce ÍNTEGRO", async () => {
  const criada = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "dono-selo",
    capabilities: { navigate: true, read: true },
  });
  const sid = criada.body.session_id;
  await act("browser.open", { session_id: sid, url: fixture.base });
  await call("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });

  // Antes: o caminho de fechamento chamava `selarSessao()` direto e nunca
  // escrevia `result.json`. O bundle nascia selado porém incompleto, e TODA
  // sessão fechada pela API reprovava com "a sessão nunca fechou" — sobre uma
  // sessão que tinha fechado.
  const r = await call<RelatorioVerificacao>("GET", `/api/v1/sessions/${sid}/replay/verify`);
  assert.equal(r.status, 200);
  const erros = r.body.problemas.filter((p) => p.severidade !== "aviso");
  assert.deepEqual(
    erros.map((p) => p.codigo),
    [],
    `bundle recém-fechado deveria nascer íntegro; veio: ${JSON.stringify(erros)}`,
  );
  assert.equal(r.body.integro, true);
});

test("LER o replay não pode quebrar o selo do que ele lê", async () => {
  const criada = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "dono-leitura",
    capabilities: { navigate: true, read: true },
  });
  const sid = criada.body.session_id;
  await act("browser.open", { session_id: sid, url: fixture.base });
  await call("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });

  const trilha = path.join(sessionsRoot, sid, "actions.jsonl");
  const antes = (await readFile(trilha, "utf8")).length;

  // Ler e verificar, várias vezes. Uma rota somente leitura que muda aquilo que
  // lê é a contradição que o replay existe para não cometer — e ela era real:
  // `replay.read` era anotado no `actions.jsonl` DA SESSÃO, depois do selo.
  await call("GET", `/api/v1/sessions/${sid}/replay`);
  await call("GET", `/api/v1/sessions/${sid}/replay/verify`);
  await call("GET", `/api/v1/sessions/${sid}/replay`);

  const depois = (await readFile(trilha, "utf8")).length;
  assert.equal(depois, antes, "ler o replay alterou a trilha selada da sessão");

  const r = await call<RelatorioVerificacao>("GET", `/api/v1/sessions/${sid}/replay/verify`);
  const divergencias = r.body.problemas.filter((p) => p.codigo === "SELO_DIVERGENTE");
  assert.deepEqual(divergencias, [], "o selo foi quebrado por quem só deveria ler");
  assert.equal(r.body.integro, true);
});

test("aprovar não é trocar de dono: sessão com aprovações verifica limpa", async () => {
  const criada = await call<SessionInfo>("POST", "/api/v1/sessions", {
    owner: "dono-aprova",
    capabilities: { navigate: true, read: true, click: true },
  });
  const sid = criada.body.session_id;
  // A ordem importa: `browser.open` é A2 e, em ASK, ficaria pendurada esperando
  // uma aprovação que ninguém daria. Abre-se a página ANTES de ligar o modo.
  await act("browser.open", { session_id: sid, url: fixture.base });
  await call("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "o-dono-humano" });

  // Dispara sem esperar e aprova: em ASK a chamada fica pendurada até a decisão.
  const emCurso = act("browser.click", { session_id: sid, target: { selector: "#botao" } });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 60));
    const fila = await call<{ pendentes: { approval_id: string; estado: string }[] }>(
      "GET",
      `/api/v1/sessions/${sid}/approvals`,
    );
    const pend = (fila.body.pendentes ?? []).filter((p) => p.estado === "PENDENTE");
    if (pend.length === 0) continue;
    await call("POST", `/api/v1/approvals/${pend[0]!.approval_id}/approve`, { by: "o-dono-humano" });
    break;
  }
  await emCurso;
  await call("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });

  // O ator de uma DECISÃO é o humano; o de uma AÇÃO é o agente. Essa alternância
  // é a separação de poderes do produto, não uma troca de mãos — e o verificador
  // acusava 14 `TROCA_DE_DONO_SEM_EVENTO` numa sessão que funcionava como
  // projetado.
  const r = await call<RelatorioVerificacao>("GET", `/api/v1/sessions/${sid}/replay/verify`);
  const trocas = r.body.problemas.filter((p) => p.codigo === "TROCA_DE_DONO_SEM_EVENTO");
  assert.deepEqual(trocas, [], "aprovação humana foi lida como troca de dono");
  assert.equal(r.body.integro, true, JSON.stringify(r.body.problemas.filter((p) => p.severidade !== "aviso")));
});
