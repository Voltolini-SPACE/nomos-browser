/**
 * CLI `nomos-web` — FASE 9
 *
 * A CLI é um cliente HTTP. Testá-la em processo provaria pouco: o que o
 * chamador enxerga é o PROCESSO — stdout, stderr e código de saída. Por isso
 * cada caso aqui sobe um runtime FALSO em node:http (+ WebSocket real via `ws`)
 * e executa `node packages/cli/src/main.ts …` como subprocesso de verdade.
 *
 * O ponto sensível é a distinção 1 × 3: "o runtime disse não" (falha de negócio)
 * contra "não encontrei o runtime". Um script que trate os dois igual reage
 * errado a queda, então essa diferença é medida com porta REALMENTE fechada, não
 * com mock de erro.
 *
 * Sem sleep: espera-se por evento verificável (`listening`, `close` do processo,
 * `--max` de frames no WebSocket).
 *
 * Roda com: node --test tests/cli.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import type { HealthResponse, RuntimeEvent, SessionInfo } from "../packages/core/src/contract.ts";
import { RESTRICTED_CAPABILITIES, makeAuditEntry } from "../packages/core/src/contract.ts";
import { SessionRecorder } from "../packages/observability/src/replay.ts";
import { CLI_VERSION, EXIT, eventsWsUrl, normalizeBaseUrl, parseArgs, UsageError } from "../packages/cli/src/main.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "packages", "cli", "src", "main.ts");

/** PNG 1x1 real — o `screenshot --out` tem de copiar bytes, não fingir. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// ─────────────────────────────────────────────────────────────────────────────
// Runtime falso
// ─────────────────────────────────────────────────────────────────────────────

interface SeenRequest {
  method: string;
  url: string;
  body: unknown;
}

interface FakeRuntime {
  origin: string;
  port: number;
  seen: SeenRequest[];
  /** Frames que todo cliente novo do /events recebe assim que conecta. */
  frames: RuntimeEvent[];
  close(): Promise<void>;
}

const SESSION: SessionInfo = {
  session_id: "sess_cli_1",
  owner: "cli:nomos-web",
  profile: "default",
  permissions: { ...RESTRICTED_CAPABILITIES },
  created_at: "2026-08-24T10:00:00.000Z",
  last_activity: "2026-08-24T10:00:05.000Z",
  context_id: "ctx_1",
  pages: [
    { page_id: "pg_1", url: "https://exemplo.test/inicio", title: "Início", active: true, opened_at: "2026-08-24T10:00:01.000Z" },
  ],
  task: null,
  status: "ACTIVE",
  control: "agent",
  attached_client: "cli",
};

const HEALTH: HealthResponse = {
  runtime: "ok",
  browser: "ok",
  workers: { active: 1, max: 4 },
  sessions: { total: 1, active: 1, idle: 0, paused: 0 },
  // FASE 20b — `queues` e obrigatorio no contrato de `/health`. O fixture da CLI
  // acompanha o contrato; deixa-lo opcional so para nao mexer aqui faria a rota
  // poder parar de publicar a profundidade sem nada reprovar.
  queues: { running: 0, waiting: 0, sessions_with_queue: 1, max_concurrency: 4, max_queue: 64 },
  version: "0.2.0-rc.1",
  contract: "1",
  uptime_s: 42,
};

const TIMING = { started_at: "2026-08-24T10:00:00.000Z", ended_at: "2026-08-24T10:00:00.120Z", duration_ms: 120 };

function envelopeOk(result: unknown): unknown {
  return { success: true, action_id: "act_ok_1", state: "ACTIVE", result, error: null, timing: TIMING };
}

function envelopeFail(code: string, message: string): unknown {
  return {
    success: false,
    action_id: "act_bad_1",
    state: "ACTIVE",
    result: null,
    error: { code, message, detail: { tool: "browser.task" } },
    timing: TIMING,
  };
}

async function startFakeRuntime(): Promise<FakeRuntime> {
  const seen: SeenRequest[] = [];
  const frames: RuntimeEvent[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => void chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      seen.push({ method: req.method ?? "?", url: req.url ?? "/", body });

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      const url = new URL(req.url ?? "/", "http://runtime.local");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") return void send(200, HEALTH);
      if (route === "GET /api/v1/sessions") return void send(200, [SESSION]);
      if (route === "POST /api/v1/sessions") return void send(201, SESSION);
      if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/sessions/")) {
        return void send(200, { closed: true });
      }

      if (route === "POST /api/v1/browser.open") {
        const alvo = (body as { url?: string } | null)?.url ?? "";
        if (alvo.includes("quebrada")) {
          return void send(200, envelopeFail("NAVIGATION_FAILED", `não carregou ${alvo}`));
        }
        return void send(
          200,
          envelopeOk({ page_id: "pg_1", url: alvo, title: "Página de teste", active: true, opened_at: TIMING.started_at }),
        );
      }

      if (route === "POST /api/v1/browser.screenshot") {
        return void send(200, envelopeOk({ screenshot_ref: "shot_do_teste", width: 1, height: 1 }));
      }

      if (route === "POST /api/v1/browser.task") {
        const goal = (body as { goal?: string } | null)?.goal ?? "";
        if (goal.startsWith("comprar")) {
          // HTTP 403 mantendo o envelope — regra 4 de docs/API.md.
          return void send(403, envelopeFail("CAPABILITY_DENIED", "purchase negado pela política restrita"));
        }
        return void send(
          200,
          envelopeOk({
            task_id: "task_1",
            session_id: (body as { session_id?: string } | null)?.session_id ?? "?",
            goal,
            state: "RUNNING",
            plan: { goal, constraints: [], steps: [{ id: "s1", intent: "abrir", action: "browser.open" }], success_conditions: [], failure_conditions: [] },
            actions: ["act_ok_1"],
            retries: 0,
            evidence: [],
            result: null,
            created_at: TIMING.started_at,
            updated_at: TIMING.ended_at,
          }),
        );
      }

      // Prefixo que responde HTML em QUALQUER rota: simula `--url` apontando
      // para um servidor que não é o runtime (proxy, painel, porta trocada).
      if (url.pathname.startsWith("/html")) {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("<html><body>isto não é o runtime</body></html>");
      }

      send(404, { error: { code: "INVALID_REQUEST", message: `rota desconhecida: ${route}` } });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://runtime.local");
    if (url.pathname !== "/events") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Frame ilegível PRIMEIRO, de propósito: a CLI tem de avisar e seguir,
      // sem contá-lo como evento. Se viesse por último, `--max` cortaria antes
      // e o teste não mediria nada.
      ws.send("{isto nao e json");
      const wanted = url.searchParams.get("session_id");
      for (const frame of frames) {
        if (wanted !== null && frame.session_id !== wanted) continue;
        ws.send(JSON.stringify(frame));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("runtime falso sem porta");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    seen,
    frames,
    close: async () => {
      for (const client of wss.clients) (client as WebSocket).terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Porta que ninguém escuta: abre, descobre o número e fecha antes de usar. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("sonda sem porta");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execução da CLI como subprocesso REAL
// ─────────────────────────────────────────────────────────────────────────────

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCliProcess(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => void (stdout += d));
    child.stderr.on("data", (d: string) => void (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * Como `runCliProcess`, mas devolve o filho vivo e uma promessa do desfecho.
 * Usado para provar o Ctrl-C: o comando `events` só termina por sinal.
 */
function spawnCliProcess(args: readonly string[]): {
  child: ReturnType<typeof spawn>;
  primeiraLinha: Promise<string>;
  terminou: Promise<Run>;
} {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: REPO,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");

  let resolvePrimeira: (line: string) => void = () => {};
  const primeiraLinha = new Promise<string>((resolve) => {
    resolvePrimeira = resolve;
  });

  child.stdout!.on("data", (d: string) => {
    stdout += d;
    const quebra = stdout.indexOf("\n");
    if (quebra !== -1) resolvePrimeira(stdout.slice(0, quebra));
  });
  child.stderr!.on("data", (d: string) => void (stderr += d));

  const terminou = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  return { child, primeiraLinha, terminou };
}

/** Stack cru nunca chega ao usuário: nem `  at f (…)` nem "Error:" nu. */
function semStackTrace(stderr: string): boolean {
  return !/\n\s+at\s/.test(stderr) && !/^\s*(TypeError|ReferenceError|Error):/m.test(stderr);
}

// ─────────────────────────────────────────────────────────────────────────────

let runtime: FakeRuntime;
let ROOT = "";
let PORTA_FECHADA = 0;

before(async () => {
  runtime = await startFakeRuntime();
  ROOT = await mkdtemp(path.join(tmpdir(), "nomos-cli-"));
  PORTA_FECHADA = await closedPort();
});

after(async () => {
  await runtime.close();
  if (ROOT !== "") await rm(ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("parser de argumentos (sem dependência)", () => {
  it("separa comando, posicionais e flags nas três formas", () => {
    const p = parseArgs(["task", "--session", "sess_1", "--json", "pagar boleto", "--url=127.0.0.1:9999"]);
    assert.equal(p.command, "task");
    assert.deepEqual(p.args, ["pagar boleto"]);
    assert.equal(p.flags.get("session"), "sess_1");
    assert.equal(p.flags.get("json"), true);
    assert.equal(p.flags.get("url"), "127.0.0.1:9999");
  });

  it("`--` encerra o parsing: objetivo pode começar com hífen", () => {
    const p = parseArgs(["task", "--session", "s", "--", "--isto-e-o-objetivo"]);
    assert.deepEqual(p.args, ["--isto-e-o-objetivo"]);
    assert.equal(p.flags.has("isto-e-o-objetivo"), false);
  });

  it("flag booleana não engole o posicional seguinte", () => {
    const p = parseArgs(["screenshot", "--json", "sess_cli_1"]);
    assert.equal(p.flags.get("json"), true);
    assert.deepEqual(p.args, ["sess_cli_1"]);
  });

  it("--no-headless nega; --headless afirma", () => {
    assert.equal(parseArgs(["open", "u", "--no-headless"]).flags.get("headless"), false);
    assert.equal(parseArgs(["open", "u", "--headless"]).flags.get("headless"), true);
  });

  it("fail closed: flag desconhecida e valor faltando são erro de uso", () => {
    assert.throws(() => parseArgs(["health", "--inventada"]), UsageError);
    assert.throws(() => parseArgs(["health", "--url"]), UsageError);
    assert.throws(() => parseArgs(["health", "--url", "--json"]), UsageError);
  });

  it("normalizeBaseUrl aceita host:porta e recusa esquema não-HTTP", () => {
    assert.equal(normalizeBaseUrl("127.0.0.1:7777"), "http://127.0.0.1:7777");
    assert.equal(normalizeBaseUrl("https://runtime.local/"), "https://runtime.local");
    assert.throws(() => normalizeBaseUrl("ftp://x"), UsageError);
  });

  it("eventsWsUrl deriva ws/wss e carrega os filtros", () => {
    assert.equal(eventsWsUrl("http://127.0.0.1:7777", null, null), "ws://127.0.0.1:7777/events");
    assert.equal(
      eventsWsUrl("https://h:1/", "sess_1", "mouse.clicked"),
      "wss://h:1/events?session_id=sess_1&events=mouse.clicked",
    );
  });

  it("CLI_VERSION casa com packages/cli/package.json", async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO, "packages", "cli", "package.json"), "utf8")) as {
      name: string;
      version: string;
      bin: Record<string, string>;
    };
    assert.equal(pkg.name, "@nomos/browser-cli");
    assert.equal(pkg.version, CLI_VERSION);
    assert.equal(pkg.bin["nomos-web"], "src/main.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI contra runtime falso (subprocesso real)", () => {
  it("1. `health` imprime o estado e sai 0", async () => {
    const r = await runCliProcess(["health", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /runtime\s+ok/);
    assert.match(r.stdout, /browser\s+ok/);
    assert.match(r.stdout, /contract\s+1/);
    assert.match(r.stdout, /workers\s+1\/4/);
    assert.equal(r.stderr, "");
  });

  it("1b. `health --json` devolve o HealthResponse cru", async () => {
    const r = await runCliProcess(["health", "--url", runtime.origin, "--json"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const health = JSON.parse(r.stdout) as HealthResponse;
    assert.equal(health.runtime, "ok");
    assert.equal(health.uptime_s, 42);
  });

  it("2. `sessions --json` imprime JSON parseável em stdout", async () => {
    const r = await runCliProcess(["sessions", "--url", runtime.origin, "--json"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const sessions = JSON.parse(r.stdout) as SessionInfo[];
    assert.equal(Array.isArray(sessions), true);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.session_id, "sess_cli_1");
    assert.equal(sessions[0]!.permissions.purchase, false);
  });

  it("2b. `sessions` sem --json imprime tabela legível com o cabeçalho", async () => {
    const r = await runCliProcess(["sessions", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /SESSION_ID/);
    assert.match(r.stdout, /sess_cli_1/);
    assert.match(r.stdout, /ACTIVE/);
    assert.equal(r.stdout.includes("{"), false, "sem --json não sai JSON");
  });

  it("3. envelope success=false ⇒ exit 1, com code e message em stderr", async () => {
    const antes = runtime.seen.length;
    const r = await runCliProcess([
      "task",
      "--session",
      "sess_cli_1",
      "comprar passagem para Lisboa",
      "--url",
      runtime.origin,
    ]);
    assert.equal(r.code, EXIT.FAILURE, `stderr=${r.stderr}`);
    assert.match(r.stderr, /erro: CAPABILITY_DENIED: purchase negado/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);

    // O corpo enviado é o do contrato — session_id + goal, nada mais.
    const enviado = runtime.seen.slice(antes).find((s) => s.url === "/api/v1/browser.task");
    assert.notEqual(enviado, undefined);
    assert.deepEqual(enviado!.body, { session_id: "sess_cli_1", goal: "comprar passagem para Lisboa" });
  });

  it("3b. `--json` numa falha: envelope inteiro em stdout, erro em stderr, exit 1", async () => {
    const r = await runCliProcess([
      "task",
      "--session",
      "sess_cli_1",
      "comprar café",
      "--url",
      runtime.origin,
      "--json",
    ]);
    assert.equal(r.code, EXIT.FAILURE);
    const envelope = JSON.parse(r.stdout) as { success: boolean; error: { code: string } };
    assert.equal(envelope.success, false);
    assert.equal(envelope.error.code, "CAPABILITY_DENIED");
    assert.match(r.stderr, /erro: CAPABILITY_DENIED/);
  });

  it("4. runtime desligado ⇒ exit 3, sem stack trace", async () => {
    const r = await runCliProcess(["health", "--url", `127.0.0.1:${PORTA_FECHADA}`, "--timeout", "3000"]);
    assert.equal(r.code, EXIT.UNREACHABLE, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /RUNTIME_UNREACHABLE/);
    assert.match(r.stderr, /ECONNREFUSED/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);
    assert.equal(r.stdout, "", "nada de saída útil quando não houve conversa");
  });

  it("4b. exit 3 é transporte, não HTTP: rota 404 do runtime dá 1, não 3", async () => {
    const r = await runCliProcess(["close", "sess_qualquer", "--url", `${runtime.origin}/rota-que-nao-existe`]);
    assert.notEqual(r.code, EXIT.UNREACHABLE);
    assert.equal(r.code, EXIT.FAILURE, r.stderr);
    assert.match(r.stderr, /erro: INVALID_REQUEST/);
  });

  it("5. comando desconhecido ⇒ exit 2 com mensagem de uso", async () => {
    const r = await runCliProcess(["voar", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /erro: USAGE: comando desconhecido: "voar"/);
    assert.match(r.stderr, /uso: nomos-web <comando>/);
    assert.match(r.stderr, /0 sucesso {3}1 falha de negócio {3}2 erro de uso {3}3 runtime inalcançável/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);
  });

  it("5b. flag fora do comando e argumento faltando também são exit 2", async () => {
    const semArgumento = await runCliProcess(["close", "--url", runtime.origin]);
    assert.equal(semArgumento.code, EXIT.USAGE);
    assert.match(semArgumento.stderr, /exige 1 argumento/);

    const flagErrada = await runCliProcess(["health", "--out", "x.png", "--url", runtime.origin]);
    assert.equal(flagErrada.code, EXIT.USAGE);
    assert.match(flagErrada.stderr, /--out não se aplica a "health"/);

    const semSessao = await runCliProcess(["task", "objetivo qualquer", "--url", runtime.origin]);
    assert.equal(semSessao.code, EXIT.USAGE);
    assert.match(semSessao.stderr, /exige --session/);

    const semNada = await runCliProcess([]);
    assert.equal(semNada.code, EXIT.USAGE);
    assert.match(semNada.stderr, /nenhum comando informado/);
  });

  it("6. `open` cria sessão e NÃO pede capability sensível nenhuma", async () => {
    const antes = runtime.seen.length;
    const r = await runCliProcess(["open", "https://exemplo.test/loja", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /session\s+sess_cli_1/);
    assert.match(r.stdout, /url\s+https:\/\/exemplo\.test\/loja/);

    const criacao = runtime.seen.slice(antes).find((s) => s.method === "POST" && s.url === "/api/v1/sessions");
    assert.notEqual(criacao, undefined);
    const corpo = criacao!.body as Record<string, unknown>;
    assert.equal(corpo.owner, "cli:nomos-web");
    assert.equal("capabilities" in corpo, false, "a CLI não concede capability — isso é ato do dono");
  });

  it("6b. `open` com sessão informada não cria sessão nova", async () => {
    const antes = runtime.seen.length;
    const r = await runCliProcess([
      "open",
      "https://exemplo.test/painel",
      "--session",
      "sess_cli_1",
      "--url",
      runtime.origin,
    ]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const criacoes = runtime.seen.slice(antes).filter((s) => s.method === "POST" && s.url === "/api/v1/sessions");
    assert.equal(criacoes.length, 0);
  });

  it("6c. `open` com URL sem esquema é erro de uso, não adivinhação", async () => {
    const r = await runCliProcess(["open", "exemplo.test", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /URL inválida/);
  });

  it("6d. navegação falhada propaga o code do runtime e sai 1", async () => {
    const r = await runCliProcess(["open", "https://exemplo.test/quebrada", "--session", "sess_cli_1", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.FAILURE);
    assert.match(r.stderr, /erro: NAVIGATION_FAILED/);
  });

  it("7. `close` confirma o fechamento e sai 0", async () => {
    const r = await runCliProcess(["close", "sess_cli_1", "--url", runtime.origin]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /sessão sess_cli_1 fechada/);
  });

  it("8. `screenshot --out` grava os bytes reais do PNG da trilha", async () => {
    const sid = "sess_cli_1";
    const recorder = new SessionRecorder(sid, { root: ROOT });
    await recorder.init();
    await recorder.saveScreenshot(PNG_1X1, "shot_do_teste");
    await recorder.flush();

    const destino = path.join(ROOT, "saida", "captura.png");
    const r = await runCliProcess([
      "screenshot",
      sid,
      "--out",
      destino,
      "--sessions-root",
      ROOT,
      "--url",
      runtime.origin,
    ]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /screenshot_ref\s+shot_do_teste/);
    assert.match(r.stdout, /dimensões\s+1x1/);
    assert.deepEqual(await readFile(destino), PNG_1X1);
  });

  it("8b. binário ausente é reportado, não inventado: exit 1", async () => {
    const vazio = await mkdtemp(path.join(tmpdir(), "nomos-cli-vazio-"));
    try {
      const r = await runCliProcess([
        "screenshot",
        "sess_cli_1",
        "--out",
        path.join(vazio, "x.png"),
        "--sessions-root",
        vazio,
        "--url",
        runtime.origin,
      ]);
      assert.equal(r.code, EXIT.FAILURE, r.stdout);
      assert.match(r.stderr, /erro: ARTIFACT_NOT_FOUND/);
    } finally {
      await rm(vazio, { recursive: true, force: true });
    }
  });

  it("8c. sem --out o comando não toca disco e sai 0", async () => {
    const r = await runCliProcess(["screenshot", "sess_cli_1", "--sessions-root", ROOT, "--url", runtime.origin, "--json"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const saida = JSON.parse(r.stdout) as { file: string | null; response: { success: boolean } };
    assert.equal(saida.file, null);
    assert.equal(saida.response.success, true);
  });

  it("9. `replay` reconstrói a linha do tempo gravada", async () => {
    const sid = "sess_replay_cli";
    const recorder = new SessionRecorder(sid, { root: ROOT });
    await recorder.init();
    await recorder.recordEvent({
      timestamp: "2026-08-24T10:00:01.000Z",
      session_id: sid,
      action_id: null,
      source: "runtime",
      event: "page.loaded",
      payload: { url: "https://exemplo.test/" },
    });
    await recorder.recordAction(makeAuditEntry({
      timestamp: "2026-08-24T10:00:02.000Z",
      session: sid,
      actor: "agent",
      action: "browser.click",
      target: "#entrar",
      result: "ok",
      verified: true,
      action_id: "act_9",
    }));
    await recorder.flush();

    const r = await runCliProcess(["replay", sid, "--sessions-root", ROOT]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /page\.loaded/);
    assert.match(r.stdout, /browser\.click → ok/);
    assert.match(r.stdout, /act_9/);
    assert.match(r.stdout, /linhas corrompidas\s+0/);

    const rj = await runCliProcess(["replay", sid, "--sessions-root", ROOT, "--json"]);
    assert.equal(rj.code, EXIT.OK, rj.stderr);
    const bundle = JSON.parse(rj.stdout) as { total: number; timeline: { label: string }[] };
    assert.equal(bundle.total, 2);
    assert.deepEqual(bundle.timeline.map((t) => t.label), ["page.loaded", "browser.click → ok"]);
  });

  it("9b. sessão sem trilha nenhuma é falha declarada, não '0 itens' alegre", async () => {
    const r = await runCliProcess(["replay", "sess_que_nunca_existiu", "--sessions-root", ROOT]);
    assert.equal(r.code, EXIT.FAILURE);
    assert.match(r.stderr, /erro: SESSION_NOT_RECORDED/);
  });

  it("9c. session_id com travessia de caminho é recusado (exit 2)", async () => {
    const r = await runCliProcess(["replay", "../../etc", "--sessions-root", ROOT]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /session_id inválido/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);
  });

  it("10. `events` segue o WebSocket e avisa sobre frame ilegível", async () => {
    runtime.frames.length = 0;
    runtime.frames.push(
      { timestamp: "2026-08-24T10:00:00.000Z", session_id: "sess_cli_1", action_id: null, source: "runtime", event: "session.created", payload: {} },
      { timestamp: "2026-08-24T10:00:01.000Z", session_id: "sess_cli_1", action_id: "act_1", source: "agent", event: "mouse.clicked", payload: { x: 10, y: 20 } },
      { timestamp: "2026-08-24T10:00:02.000Z", session_id: "outra_sessao", action_id: null, source: "agent", event: "page.loaded", payload: {} },
    );

    const r = await runCliProcess(["events", "--url", runtime.origin, "--max", "2", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const linhas = r.stdout.trim().split("\n");
    assert.equal(linhas.length, 2, `--max 2 tem de cortar em 2 linhas, veio: ${r.stdout}`);
    assert.deepEqual(
      linhas.map((l) => (JSON.parse(l) as RuntimeEvent).event),
      ["session.created", "mouse.clicked"],
    );
    // O frame corrompido foi ANUNCIADO em stderr e não poluiu o stdout JSON.
    assert.match(r.stderr, /aviso: frame não-JSON ignorado/);
  });

  it("10b. `events --session` repassa o filtro ao runtime", async () => {
    const r = await runCliProcess([
      "events",
      "--url",
      runtime.origin,
      "--session",
      "outra_sessao",
      "--max",
      "1",
      "--json",
    ]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const evento = JSON.parse(r.stdout.trim()) as RuntimeEvent;
    assert.equal(evento.session_id, "outra_sessao");
    assert.equal(evento.event, "page.loaded");
  });

  it("10c. `events` sem --max segue até Ctrl-C e encerra em 0 (SIGINT REAL)", async () => {
    runtime.frames.length = 0;
    runtime.frames.push({
      timestamp: "2026-08-24T10:00:00.000Z",
      session_id: "sess_cli_1",
      action_id: null,
      source: "runtime",
      event: "runtime.started",
      payload: {},
    });

    const corrida = spawnCliProcess(["events", "--url", runtime.origin, "--json"]);
    // Espera por CONDIÇÃO (o primeiro evento saiu), não por temporizador.
    const primeira = await corrida.primeiraLinha;
    assert.equal((JSON.parse(primeira) as RuntimeEvent).event, "runtime.started");

    corrida.child.kill("SIGINT");
    const r = await corrida.terminou;
    assert.equal(r.signal, null, "SIGINT foi TRATADO, o processo não morreu pelo sinal");
    assert.equal(r.code, EXIT.OK, `stderr=${r.stderr}`);
  });

  it("10d. `events` contra porta fechada também sai 3, sem stack", async () => {
    const r = await runCliProcess(["events", "--url", `127.0.0.1:${PORTA_FECHADA}`, "--max", "1"]);
    assert.equal(r.code, EXIT.UNREACHABLE, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /RUNTIME_UNREACHABLE/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);
  });

  it("11. resposta não-JSON vira INVALID_RESPONSE (exit 1), não crash", async () => {
    const r = await runCliProcess(["health", "--url", `${runtime.origin}/html`]);
    assert.equal(r.code, EXIT.FAILURE, r.stderr);
    assert.match(r.stderr, /erro: INVALID_RESPONSE/);
    assert.equal(semStackTrace(r.stderr), true, r.stderr);
  });

  it("12. `--help` e `--version` saem 0 por stdout", async () => {
    const ajuda = await runCliProcess(["--help"]);
    assert.equal(ajuda.code, EXIT.OK);
    assert.match(ajuda.stdout, /uso: nomos-web <comando>/);
    assert.equal(ajuda.stderr, "");

    const versao = await runCliProcess(["--version"]);
    assert.equal(versao.code, EXIT.OK);
    assert.equal(versao.stdout.trim(), `nomos-web ${CLI_VERSION}`);
  });
});
