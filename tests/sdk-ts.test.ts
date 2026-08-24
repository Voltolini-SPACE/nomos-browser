/**
 * FASE 7 — SDK TypeScript @nomos/browser.
 *
 * Método: sobe um RUNTIME FALSO (node:http + ws) que responde envelopes válidos
 * e registra cada requisição. O que se afirma aqui não é "não lançou exceção" —
 * é o par (requisição observada no servidor, valor devolvido ao chamador).
 * Sem o registro do lado do servidor, um SDK que engolisse a chamada e
 * devolvesse um objeto plausível passaria em todos os testes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { NomosBrowser, NomosBrowserError } from "../packages/sdk/src/index.ts";
import type { ActionResponse, RuntimeEvent, SessionInfo } from "../packages/core/src/contract.ts";
import { RESTRICTED_CAPABILITIES } from "../packages/core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Runtime falso
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface ResponseSpec {
  status?: number;
  json?: unknown;
  /** Nunca responde — usado para provar o timeout do cliente. */
  hang?: boolean;
}

type Responder = (rec: Recorded) => ResponseSpec | undefined;

interface FakeOptions {
  responder?: Responder;
  /** Fecha todo WebSocket assim que ele abre — simula runtime instável. */
  dropWs?: boolean;
}

interface Fake {
  url: string;
  recorded: Recorded[];
  wsUrls: string[];
  broadcast: (ev: RuntimeEvent) => void;
  waitForWs: (n: number) => Promise<void>;
  close: () => Promise<void>;
}

const SESSION: SessionInfo = {
  session_id: "sess_fake_0001",
  owner: "nomos-sdk",
  profile: "default",
  permissions: { ...RESTRICTED_CAPABILITIES },
  created_at: "2026-08-24T12:00:00.000Z",
  last_activity: "2026-08-24T12:00:00.000Z",
  context_id: "ctx_fake_0001",
  pages: [],
  task: null,
  status: "ACTIVE",
  control: "agent",
  attached_client: "nomos-sdk",
};

function envelope<T>(result: T): ActionResponse<T> {
  return {
    success: true,
    action_id: "act_fake_1",
    state: "ACTIVE",
    result,
    error: null,
    timing: { started_at: "2026-08-24T12:00:00.000Z", ended_at: "2026-08-24T12:00:00.010Z", duration_ms: 10 },
  };
}

const PAGE = {
  page_id: "page_1",
  url: "https://example.com/",
  title: "Example Domain",
  active: true,
  opened_at: "2026-08-24T12:00:00.000Z",
};

/** Respostas padrão: o mínimo para as rotas que os testes exercitam. */
function defaultResponder(rec: Recorded): ResponseSpec | undefined {
  if (rec.method === "POST" && rec.path === "/api/v1/sessions") return { json: SESSION };
  if (rec.method === "POST" && rec.path.endsWith("/detach")) return { json: { ...SESSION, attached_client: null } };
  if (rec.method === "DELETE") return { json: { closed: true } };
  if (rec.method === "POST" && rec.path === "/api/v1/browser.goto") return { json: envelope(PAGE) };
  if (rec.method === "POST" && rec.path === "/api/v1/browser.click") {
    return {
      json: envelope({
        target: {
          strategy: "role_text",
          attempted: ["selector", "role_text"],
          box: { x: 10, y: 20, width: 80, height: 30 },
          description: "botão Login",
          healed: true,
        },
        verification: { executed: true, verified: true, confidence: 1, kind: "URL_CHANGED", observed: "/app", retries: 0 },
      }),
    };
  }
  return undefined;
}

function startFake(opts: FakeOptions = {}): Promise<Fake> {
  const responder = opts.responder ?? (() => undefined);
  const recorded: Recorded[] = [];
  const wsUrls: string[] = [];
  const live = new Set<WsSocket>();
  const wsWaiters: Array<{ n: number; resolve: () => void }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const rec: Recorded = {
        method: req.method ?? "?",
        path: req.url ?? "?",
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null,
      };
      recorded.push(rec);
      const spec = responder(rec) ?? defaultResponder(rec);
      if (spec === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rota não registrada no runtime falso", path: rec.path }));
        return;
      }
      if (spec.hang === true) return; // deliberadamente sem resposta
      res.writeHead(spec.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(spec.json ?? {}));
    });
  });

  const wss = new WebSocketServer({ server, path: "/events" });
  wss.on("connection", (socket, req) => {
    wsUrls.push(req.url ?? "?");
    for (const w of [...wsWaiters]) {
      if (wsUrls.length >= w.n) {
        wsWaiters.splice(wsWaiters.indexOf(w), 1);
        w.resolve();
      }
    }
    if (opts.dropWs === true) {
      socket.close();
      return;
    }
    live.add(socket);
    socket.on("close", () => live.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("runtime falso sem porta");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        recorded,
        wsUrls,
        broadcast: (ev) => {
          for (const s of live) s.send(JSON.stringify(ev));
        },
        waitForWs: (n) =>
          wsUrls.length >= n ? Promise.resolve() : new Promise<void>((r) => wsWaiters.push({ n, resolve: r })),
        close: async () => {
          for (const s of live) s.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. createSession + goto + click emitem as requisições certas
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-01 createSession + goto + click emitem método, rota e corpo corretos", async () => {
  const fake = await startFake();
  try {
    const browser = new NomosBrowser({ url: fake.url, owner: "agente-x" });
    const session = await browser.createSession();
    assert.equal(session.id, "sess_fake_0001");

    const page = await session.goto("https://example.com");
    assert.equal(page.url, "https://example.com/");

    const clicked = await session.click({ text: "Login" });
    assert.equal(clicked.target.strategy, "role_text");
    assert.equal(clicked.verification.verified, true);

    assert.deepEqual(
      fake.recorded.map((r) => `${r.method} ${r.path}`),
      ["POST /api/v1/sessions", "POST /api/v1/browser.goto", "POST /api/v1/browser.click"],
    );
    assert.deepEqual(fake.recorded[0].body, { owner: "agente-x" });
    assert.deepEqual(fake.recorded[1].body, { session_id: "sess_fake_0001", url: "https://example.com" });
    assert.deepEqual(fake.recorded[2].body, { session_id: "sess_fake_0001", target: { text: "Login" } });
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. envelope success=false vira NomosBrowserError com o código preservado
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-02 envelope com success=false vira NomosBrowserError preservando code/actionId/timing", async () => {
  const falha: ActionResponse<never> = {
    success: false,
    action_id: "act_falha_9",
    state: "ACTIVE",
    result: null,
    error: { code: "TARGET_AMBIGUOUS", message: "3 elementos casam com text=Login", detail: { matches: 3 } },
    timing: { started_at: "2026-08-24T12:00:01.000Z", ended_at: "2026-08-24T12:00:01.120Z", duration_ms: 120 },
  };
  const fake = await startFake({
    responder: (rec) => (rec.path === "/api/v1/browser.click" ? { status: 404, json: falha } : undefined),
  });
  try {
    const browser = new NomosBrowser({ url: fake.url });
    const session = await browser.createSession();
    const capturado = await session.click({ text: "Login" }).then(
      () => null,
      (e: unknown) => e as NomosBrowserError,
    );
    assert.ok(capturado instanceof NomosBrowserError);
    assert.equal(capturado.code, "TARGET_AMBIGUOUS");
    assert.equal(capturado.actionId, "act_falha_9");
    assert.equal(capturado.timing?.duration_ms, 120);
    assert.equal(capturado.httpStatus, 404);
    assert.deepEqual(capturado.detail, { matches: 3 });
    assert.match(capturado.message, /3 elementos casam/);
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. detach() NÃO fecha a sessão — nenhum DELETE trafega
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-03 detach() solta o cliente sem enviar DELETE; close() é que envia", async () => {
  const fake = await startFake();
  try {
    const browser = new NomosBrowser({ url: fake.url });
    const session = await browser.createSession();

    const info = await session.detach();
    assert.equal(info.attached_client, null);
    assert.equal(info.session_id, "sess_fake_0001");

    const metodos = fake.recorded.map((r) => r.method);
    assert.equal(metodos.includes("DELETE"), false, "detach() não pode emitir DELETE");
    assert.deepEqual(
      fake.recorded.map((r) => `${r.method} ${r.path}`),
      ["POST /api/v1/sessions", "POST /api/v1/sessions/sess_fake_0001/detach"],
    );
    assert.equal(fake.recorded[1].body, null);

    // Controle do instrumento: se DELETE jamais fosse emitido, o teste acima
    // seria vácuo. close() prova que o servidor falso VÊ o DELETE quando existe.
    const fechado = await session.close();
    assert.deepEqual(fechado, { closed: true });
    assert.deepEqual(fake.recorded.at(-1), {
      method: "DELETE",
      path: "/api/v1/sessions/sess_fake_0001",
      body: null,
    });
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. events() entrega um RuntimeEvent emitido pelo WebSocket falso
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-04 events() entrega RuntimeEvent do WebSocket e aplica o filtro na query", async () => {
  const fake = await startFake();
  const browser = new NomosBrowser({ url: fake.url });
  const stream = browser.events({ session_id: "sess_fake_0001", events: ["mouse.clicked", "task.progress"] });
  try {
    await fake.waitForWs(1);
    assert.equal(fake.wsUrls[0], "/events?session_id=sess_fake_0001&events=mouse.clicked%2Ctask.progress");

    const emitido: RuntimeEvent = {
      timestamp: "2026-08-24T12:00:02.000Z",
      session_id: "sess_fake_0001",
      action_id: "act_fake_1",
      source: "runtime",
      event: "mouse.clicked",
      payload: { x: 120, y: 340 },
    };
    const proximo = stream.next();
    fake.broadcast(emitido);
    const recebido = await proximo;
    assert.equal(recebido.done, false);
    assert.deepEqual(recebido.value, emitido);

    // `for await` também funciona e `break` fecha o socket.
    const segundo: RuntimeEvent = { ...emitido, event: "task.progress", payload: { pct: 42 } };
    const colhidos: RuntimeEvent[] = [];
    const iter = (async () => {
      for await (const ev of stream) {
        colhidos.push(ev);
        break;
      }
    })();
    fake.broadcast(segundo);
    await iter;
    assert.deepEqual(colhidos, [segundo]);
  } finally {
    await stream.close();
    await browser.close();
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. timeout de rede vira NomosBrowserError code TIMEOUT
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-05 servidor que não responde vira NomosBrowserError code TIMEOUT", async () => {
  const fake = await startFake({
    responder: (rec) => (rec.path === "/api/v1/browser.observe" ? { hang: true } : undefined),
  });
  try {
    const browser = new NomosBrowser({ url: fake.url, timeout_ms: 250 });
    const session = await browser.createSession();
    const t0 = Date.now();
    const erro = await session.observe().then(
      () => null,
      (e: unknown) => e as NomosBrowserError,
    );
    const decorrido = Date.now() - t0;
    assert.ok(erro instanceof NomosBrowserError, "esperado NomosBrowserError");
    assert.equal(erro.code, "TIMEOUT");
    assert.match(erro.message, /excedeu 250 ms/);
    assert.ok(decorrido >= 200 && decorrido < 5_000, `abortou em ${decorrido} ms`);
    // A requisição CHEGOU ao servidor: o timeout é da resposta, não de rota errada.
    assert.equal(fake.recorded.at(-1)?.path, "/api/v1/browser.observe");
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. reconexão com teto — nunca loop infinito
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-06 stream reconecta com backoff e para no teto, sem loop infinito", async () => {
  const fake = await startFake({ dropWs: true });
  const browser = new NomosBrowser({ url: fake.url });
  const stream = browser.events({ max_reconnects: 2, backoff_base_ms: 10, backoff_max_ms: 40 });
  try {
    const erro = await stream.next().then(
      () => null,
      (e: unknown) => e as NomosBrowserError,
    );
    assert.ok(erro instanceof NomosBrowserError, "o stream tem de falhar, não pendurar");
    assert.equal(erro.code, "INTERNAL");
    assert.match(erro.message, /teto de 2 reconexões/);
    assert.equal(stream.reconnects, 2);
    // 1 conexão inicial + 2 reconexões = 3 handshakes vistos pelo servidor.
    assert.equal(fake.wsUrls.length, 3);
  } finally {
    await stream.close();
    await browser.close();
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. superfície: todos os verbos de docs/API.md existem e batem na rota certa
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-07 cada método mapeia para a rota da tabela normativa", async () => {
  const fake = await startFake({ responder: (rec) => (rec.path.startsWith("/api/v1/browser.") ? { json: envelope({}) } : undefined) });
  try {
    const browser = new NomosBrowser({ url: fake.url });
    const session = await browser.createSession();

    await session.back();
    await session.forward();
    await session.reload();
    await session.observe({ accessibility: true, limit: 50 });
    await session.find({ role: "button", text: "Login" });
    await session.type({ label: "Senha" }, { credential_ref: "vault://se7en/senha" });
    await session.press("Enter");
    await session.press(["Control", "a"]);
    await session.scroll({ dy: 400 });
    await session.drag({ text: "A" }, { text: "B" });
    await session.extract({ format: "markdown" });
    await session.screenshot({ scope: "full" });
    await session.tabs();
    await session.newTab("https://example.org");
    await session.switchTab("page_2");
    await session.closeTab("page_2");
    await session.download({ url: "https://example.com/f.csv" });
    await session.upload({ target: { label: "Arquivo" }, path: "/tmp/f.csv" });
    await session.wait({ condition: "url_contains", value: "/app", timeout_ms: 1_000 });
    await session.network({ limit: 20 });
    await session.task({ goal: "extrair TPV" });

    const rotas = fake.recorded.slice(1).map((r) => r.path);
    assert.deepEqual(rotas, [
      "/api/v1/browser.back",
      "/api/v1/browser.forward",
      "/api/v1/browser.reload",
      "/api/v1/browser.observe",
      "/api/v1/browser.find",
      "/api/v1/browser.type",
      "/api/v1/browser.press",
      "/api/v1/browser.press",
      "/api/v1/browser.scroll",
      "/api/v1/browser.drag",
      "/api/v1/browser.extract",
      "/api/v1/browser.screenshot",
      "/api/v1/browser.tabs",
      "/api/v1/browser.new_tab",
      "/api/v1/browser.switch_tab",
      "/api/v1/browser.close_tab",
      "/api/v1/browser.download",
      "/api/v1/browser.upload",
      "/api/v1/browser.wait",
      "/api/v1/browser.network",
      "/api/v1/browser.task",
    ]);

    // O segredo vai por REFERÊNCIA: nenhum corpo carrega valor de credencial.
    const corpoType = fake.recorded.find((r) => r.path === "/api/v1/browser.type")?.body;
    assert.deepEqual(corpoType, {
      session_id: "sess_fake_0001",
      target: { label: "Senha" },
      credential_ref: "vault://se7en/senha",
    });
    const corpoPressLista = fake.recorded.filter((r) => r.path === "/api/v1/browser.press").at(-1)?.body;
    assert.deepEqual(corpoPressLista, { session_id: "sess_fake_0001", keys: ["Control", "a"] });
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. resposta sem envelope não vira sucesso silencioso
// ─────────────────────────────────────────────────────────────────────────────

test("SDK-08 resposta de ação sem envelope falha em vez de devolver null", async () => {
  const fake = await startFake({
    responder: (rec) => (rec.path === "/api/v1/browser.tabs" ? { json: [{ page_id: "page_1" }] } : undefined),
  });
  try {
    const browser = new NomosBrowser({ url: fake.url });
    const session = await browser.createSession();
    const erro = await session.tabs().then(
      () => null,
      (e: unknown) => e as NomosBrowserError,
    );
    assert.ok(erro instanceof NomosBrowserError);
    assert.equal(erro.code, "INTERNAL");
    assert.match(erro.message, /envelope ausente ou inválido/);
  } finally {
    await fake.close();
  }
});
