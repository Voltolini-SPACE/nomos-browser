/**
 * FASE 13 — O WATCHDOG LIGADO AO PRODUTO
 *
 * O QUE ESTAVA ERRADO
 * -------------------
 * `packages/observability/src/watchdog.ts` tinha 557 linhas — backoff, janela
 * deslizante, trava de crash-loop, recusa de matar pid alheio — e ZERO
 * instanciações no runtime. `tests/recovery-watchdog.test.ts` provava a CLASSE;
 * ninguém provava que o daemon a usava, porque ele não usava. Consequência
 * medida: com o Chromium morto por baixo de uma sessão, `/health` continuava
 * respondendo `browser: "ok"` e `contexts: 1`, porque a contagem vinha do nosso
 * próprio mapa e não do navegador.
 *
 * O QUE ESTA SUÍTE EXIGE
 * ----------------------
 * Falha REAL provocada em cada caso. Nada de `if (teste) finja que morreu`:
 *   · navegador morto      → o BrowserContext é fechado POR BAIXO do manager
 *   · worker preso         → uma ação de verdade trava num servidor que aceita
 *                            a conexão e nunca responde
 *   · task estagnada       → um passo real que não avança o checkpoint
 *   · congelamento         → o event loop é BLOQUEADO de verdade (busy wait)
 *   · crash-loop           → a MESMA falha real repetida até o vigia degradar
 *
 * `watchdog.tick()` é chamado explicitamente em vez de esperar o timer: provocar
 * a falha e mandar olhar AGORA é determinístico; dormir e torcer é flakiness com
 * outro nome.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startDaemon, type DaemonHandle } from "../packages/api/src/daemon.ts";
import { HealthWatchdog } from "../packages/observability/src/watchdog.ts";
import { loadConfig } from "../packages/api/src/config.ts";
import { agenteScriptado, type RoteiroDeAgente } from "./fixtures/task/agente-scriptado.ts";

const GATE: Record<string, string> = {
  WATCHDOG_WIRED: "FAIL",
  WATCHDOG_HANG_RECOVERY: "FAIL",
  WATCHDOG_CRASH_LOOP_PROTECTION: "FAIL",
  WATCHDOG_TASK_STALL: "FAIL",
  WATCHDOG_BROWSER_DEAD: "FAIL",
  WATCHDOG_WORKER_STUCK: "FAIL",
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: um servidor que responde, e um que ACEITA e nunca responde
// ─────────────────────────────────────────────────────────────────────────────

let servidorOk: http.Server;
let baseOk = "";
/** Aceita a conexão TCP e nunca escreve resposta. Trava o cliente de verdade. */
let poco: net.Server;
let basePoco = "";
const socketsDoPoco: net.Socket[] = [];

let daemon: DaemonHandle;
let raizSessoes = "";
let runtimeDir = "";
let roteiro: RoteiroDeAgente = { steps: [] };

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(async () => {
  servidorOk = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end("<!doctype html><html><body><h1 id=t>ok</h1></body></html>");
  });
  await new Promise<void>((r) => servidorOk.listen(0, "127.0.0.1", () => r()));
  baseOk = `http://127.0.0.1:${(servidorOk.address() as net.AddressInfo).port}`;

  poco = net.createServer((sock: net.Socket) => {
    // Sem `end()`, sem `write()`: o cliente fica pendurado no aguardo do status.
    socketsDoPoco.push(sock);
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => poco.listen(0, "127.0.0.1", () => r()));
  basePoco = `http://127.0.0.1:${(poco.address() as net.AddressInfo).port}`;

  raizSessoes = mkdtempSync(path.join(os.tmpdir(), "nomos-wd-sess-"));
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-wd-rt-"));

  const agente = agenteScriptado({
    name: "agente-fase13",
    base: () => daemon.url,
    token: () => daemon.token,
    roteiro: () => roteiro,
  });

  daemon = await startDaemon({
    agent: agente,
    vision: null,
    host: "127.0.0.1",
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: raizSessoes,
    runtime_dir: runtimeDir,
    ai_provider: null,
    ai_provider_fallback: null,
    vision_provider: null,
    // Prazos curtos: o que se prova é a POLÍTICA (detectou, tentou, degradou),
    // não a duração. Com os defaults de produção este arquivo levaria minutos.
    // O prazo de AÇÃO precisa ser MAIOR que o limiar de estagnação, senão a
    // ação morre antes de a task chegar a estagnar e o caso 5 mediria o
    // timeout da fila em vez do vigia. Foi assim que ele falhou na primeira
    // execução: a task ia a FAILED em 400 ms e nunca ficava parada em RUNNING.
    action_timeout_ms: 6_000,
    task_step_timeout_ms: 15_000,
    task_total_timeout_ms: 40_000,
    task_max_attempts: 1,
    watchdog_enabled: true,
    watchdog_interval_ms: 100,
    watchdog_max_restarts: 2,
    watchdog_task_stall_ms: 400,
    watchdog_worker_stall_ms: 800,
    read_file: false,
    env: {},
  });
});

after(async () => {
  await daemon?.close("fim dos testes de watchdog");
  for (const s of socketsDoPoco) s.destroy();
  await new Promise<void>((r) => poco.close(() => r()));
  await new Promise<void>((r) => servidorOk.close(() => r()));
  rmSync(raizSessoes, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

async function chamar<T>(method: string, rota: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${daemon.url}${rota}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(daemon.token !== null ? { authorization: `Bearer ${daemon.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function novaSessao(owner: string): Promise<string> {
  const r = await chamar<{ session_id: string }>("POST", "/api/v1/sessions", { owner, profile: "sandbox" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.session_id;
}

function trilha(): Record<string, unknown>[] {
  const linhas: Record<string, unknown>[] = [];
  const runtime = path.join(raizSessoes, "_runtime", "actions.jsonl");
  for (const f of [runtime]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (l.trim() !== "") linhas.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return linhas;
}

/**
 * PIDs do navegador do Playwright que SÃO DESCENDENTES deste processo de teste.
 *
 * A restrição a descendentes não é zelo excessivo: esta máquina roda serviços de
 * produção e aplicativos do dono que também são Chromium. Um `pkill -f chrome`
 * mataria o navegador do usuário, ou pior. Só se mata o que este processo
 * mesmo criou, e a checagem é por ancestralidade, não por nome.
 */
function navegadoresDesteProcesso(): number[] {
  const saida = execFileSync("/bin/ps", ["-Ao", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 64_000_000 });
  const linhas = saida.split("\n").slice(1);
  const pai = new Map<number, number>();
  const cmd = new Map<number, string>();
  for (const l of linhas) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m === null) continue;
    pai.set(Number(m[1]), Number(m[2]));
    cmd.set(Number(m[1]), m[3]!);
  }
  const meus: number[] = [];
  for (const [pid, comando] of cmd) {
    if (!comando.includes("ms-playwright")) continue;
    // sobe a árvore até achar (ou não) o nosso pid
    let atual = pid;
    for (let i = 0; i < 40; i += 1) {
      const p = pai.get(atual);
      if (p === undefined || p <= 1) break;
      if (p === process.pid) {
        meus.push(pid);
        break;
      }
      atual = p;
    }
  }
  return meus;
}

/** Bloqueia o event loop DE VERDADE por `ms`. Não é `await sleep`. */
function congelar(ms: number): void {
  const fim = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < fim) {
    // Ocupação real: nenhum timer dispara enquanto isto roda, inclusive o do
    // próprio watchdog. É o que "daemon congelado" significa.
  }
}

// ═════════════════════════════════════════════════════════════════════════════

test("1. o daemon INSTANCIA o watchdog e o publica no /health", async () => {
  assert.ok(daemon.watchdog !== null, "o daemon subiu sem watchdog — a FASE 13 não está ligada");
  assert.equal(daemon.watchdog.state, "running");

  const h = await chamar<{ watchdog?: Record<string, unknown> }>("GET", "/health");
  assert.equal(h.status, 200);
  assert.ok(h.body.watchdog !== undefined, "/health não conta nada sobre o vigia");
  assert.equal(h.body.watchdog.enabled, true);
  assert.equal(h.body.watchdog.state, "running");

  // A configuração é do produto, com nome e default declarados.
  const padrao = loadConfig({ read_file: false, env: {} });
  assert.equal(padrao.watchdog_enabled, true, "o watchdog não nasce ligado");
  assert.equal(padrao.watchdog_interval_ms, 5_000);
  assert.equal(padrao.watchdog_max_restarts, 3);
  assert.equal(padrao.watchdog_task_stall_ms, 120_000);
  assert.equal(padrao.sources.watchdog_enabled, "default");
  const porEnv = loadConfig({ read_file: false, env: { NOMOS_BROWSER_WATCHDOG_ENABLED: "false" } });
  assert.equal(porEnv.watchdog_enabled, false);
  assert.equal(porEnv.sources.watchdog_enabled, "env:NOMOS_BROWSER_WATCHDOG_ENABLED");

  GATE.WATCHDOG_WIRED = "PASS";
});

test("2. NAVEGADOR MORTO por baixo: SIGKILL real, sessão FAILED e nada pendurado", async () => {
  const sid = await novaSessao("DONO-BROWSER");
  const abrir = await chamar<{ success: boolean }>("POST", "/api/v1/browser.goto", {
    session_id: sid,
    url: `${baseOk}/a`,
  });
  assert.equal(abrir.body.success, true, JSON.stringify(abrir.body));
  assert.equal(daemon.leases.currentHolder(sid), "daemon-root", "a sessão não nasceu com dono");
  // Linha de base ANTES de provocar a falha.
  //
  // O watchdog está VIVO com tique de 100 ms: entre matar o navegador e chamar
  // `tick()` à mão, o tique dele pode passar e já ter recuperado. Comparar com
  // um retrato tirado antes da falha é a única forma de atribuir a ele o que
  // aconteceu — comparar com o estado "logo antes do meu tick" media a corrida,
  // não o produto.
  const base = daemon.watchdog!.stats();

  // ── a falha REAL: SIGKILL no processo do navegador ────────────────────────
  const pids = navegadoresDesteProcesso();
  assert.ok(pids.length > 0, "não achei o processo do navegador deste teste — o caso não mediria nada");
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Já morto (processos filhos do Chromium caem junto): não é falha.
    }
  }
  // Espera o Playwright perceber a queda e propagar `context.on("close")`.
  for (let i = 0; i < 40 && daemon.sessions.get(sid).status !== "FAILED"; i += 1) await dormir(100);

  // O `SessionManager` já fazia esta parte, e ela continua valendo.
  assert.equal(daemon.sessions.get(sid).status, "FAILED", "a sessão continuou se dizendo viva sobre um navegador morto");

  // ── e AQUI está o que ninguém fazia ──────────────────────────────────────
  // A sessão morta continuava DONA do lease. Sem navegador não há mais nada que
  // expire, então o `session_id` ficaria preso a esse dono para sempre — e o
  // ÚNICO componente que solta esse lease é o watchdog. Se ele não rodasse,
  // `currentHolder` continuaria "daemon-root" no fim deste caso.
  await daemon.watchdog!.tick();
  const depois = daemon.watchdog!.stats();
  assert.ok(
    (depois.detected.browser_dead ?? 0) > (base.detected.browser_dead ?? 0),
    `o watchdog não detectou o navegador morto: ${JSON.stringify(depois.detected)}`,
  );
  assert.ok(
    (depois.recovered.browser_dead ?? 0) > (base.recovered.browser_dead ?? 0),
    "detectou e não agiu",
  );
  assert.equal(daemon.leases.currentHolder(sid), null, "o lease sobreviveu à morte do navegador");

  // A trilha registra — recuperação em silêncio é inauditável.
  const linhas = trilha().filter((l) => String(l.action).startsWith("watchdog."));
  assert.ok(linhas.length > 0, "o watchdog agiu sem deixar linha no audit");
  assert.ok(
    linhas.some((l) => (l.detail as Record<string, unknown>)?.kind === "browser_dead"),
    `nenhuma linha de browser_dead: ${linhas.map((l) => String((l.detail as any)?.kind)).join(",")}`,
  );
  GATE.WATCHDOG_BROWSER_DEAD = "PASS";
  await chamar("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });
});

test("3. WORKER PRESO numa ação real que trava é detectado", async () => {
  const sid = await novaSessao("DONO-WORKER");
  // Ação de verdade contra um servidor que ACEITA a conexão e nunca responde.
  // Não se espera a resposta: o ponto é justamente que o trabalho FICA rodando.
  const presa = chamar<{ success: boolean; error?: { code: string } }>("POST", "/api/v1/browser.goto", {
    session_id: sid,
    url: `${basePoco}/nunca-responde`,
  }).catch(() => ({ status: 0, body: { success: false } }));

  await dormir(1_100); // > watchdog_worker_stall_ms (800 ms)
  await daemon.watchdog!.tick();
  const st = daemon.watchdog!.stats();
  assert.ok((st.detected.worker_stuck ?? 0) >= 1, `worker preso não foi detectado: ${JSON.stringify(st.detected)}`);
  // Sem recuperação automática, de propósito: destravar daqui seria abandonar um
  // gesto no meio sem saber se ele chegou à página.
  assert.equal(st.recovered.worker_stuck ?? 0, 0, "o watchdog tentou 'consertar' um worker preso");
  GATE.WATCHDOG_WORKER_STUCK = "PASS";

  await chamar("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });
  await presa;
});

test("4. DAEMON CONGELADO: o event loop bloqueado é denunciado por deriva", async () => {
  const wd = daemon.watchdog!;
  await wd.tick();
  const antes = wd.stats();

  // Congelamento REAL: nenhum timer dispara enquanto este laço roda — nem o do
  // próprio watchdog. É por isso que a detecção é por DERIVA, DEPOIS do fato:
  // um vigia que dependesse de um timer para notar o travamento estaria travado
  // junto, e um `/health` consultado durante o congelamento não responderia —
  // o servidor HTTP está no mesmo event loop.
  congelar(wd.heartbeat_timeout_ms + 300);
  await wd.tick();

  const st = wd.stats();
  assert.ok(
    (st.detected.heartbeat_expired ?? 0) > (antes.detected.heartbeat_expired ?? 0),
    "a deriva do pulso não foi denunciada",
  );
  assert.ok(st.freezes > antes.freezes, "o congelamento não foi contado");
  assert.ok(
    (st.last_freeze_ms ?? 0) > wd.heartbeat_timeout_ms,
    `o congelamento medido (${String(st.last_freeze_ms)}ms) não bate com o limite (${wd.heartbeat_timeout_ms}ms)`,
  );
  assert.ok(st.max_drift_ms > 0, "nenhuma deriva foi medida");

  // O CONTADOR sobrevive ao episódio e sai no /health — é ele que responde
  // "este daemon travou hoje?" depois que o travamento já passou.
  const h = await chamar<{ watchdog?: { freezes?: number; last_freeze_ms?: number | null; state?: string } }>("GET", "/health");
  assert.ok((h.body.watchdog?.freezes ?? 0) >= 1, `/health não conta congelamento: ${JSON.stringify(h.body.watchdog)}`);
  assert.ok((h.body.watchdog?.last_freeze_ms ?? 0) > wd.heartbeat_timeout_ms);
  // E o daemon segue operando: congelamento passado não é estado terminal.
  assert.equal(h.body.watchdog?.state, "running");
  GATE.WATCHDOG_HANG_RECOVERY = "PASS";
});

test("5. TASK ESTAGNADA é pausada de forma declarada, nunca abandonada em RUNNING", async () => {
  const sid = await novaSessao("DONO-TASK");
  // Um passo REAL que não avança: o servidor aceita e não responde. O motor de
  // task não tem como saber sozinho — quem parou foi o passo, não ele.
  roteiro = {
    steps: [
      { id: "t1", intent: "primeiro", action: "browser.goto", value: `${baseOk}/t1` },
      { id: "t2", intent: "trava aqui", action: "browser.goto", value: `${basePoco}/trava` },
    ],
  };

  const base5 = daemon.watchdog!.stats();
  const emVoo = chamar<{ success: boolean; result: { state: string } | null; error?: { detail?: Record<string, unknown> } }>(
    "POST",
    "/api/v1/browser.task",
    { session_id: sid, goal: "travar no segundo passo" },
  );

  // Espera o segundo passo entrar em execução e o limiar (400 ms) vencer.
  await dormir(1_600);
  await daemon.watchdog!.tick();
  const st = daemon.watchdog!.stats();
  // Mesma razão do caso 2: o vigia está vivo e pode ter agido antes do meu
  // `tick()`. O que se compara é com o retrato de ANTES da task existir.
  assert.ok(
    (st.detected.task_stalled ?? 0) > (base5.detected.task_stalled ?? 0),
    `task estagnada não foi detectada: ${JSON.stringify(st.detected)}`,
  );
  assert.ok(
    (st.recovered.task_stalled ?? 0) > (base5.recovered.task_stalled ?? 0),
    "detectou a task parada e não fez nada",
  );

  const fim = await emVoo;
  const corpo = fim.body;
  const estado = corpo.result?.state ?? (corpo.error?.detail?.state as string | undefined);
  assert.ok(
    estado !== "RUNNING" && estado !== "COMPLETED",
    `a task terminou em ${String(estado)} — estagnada não pode virar concluída nem seguir RUNNING`,
  );

  const linhas = trilha().filter((l) => l.action === "watchdog.recovered");
  assert.ok(
    linhas.some((l) => (l.detail as Record<string, unknown>)?.kind === "task_stalled"),
    "a pausa por estagnação não entrou na trilha",
  );
  GATE.WATCHDOG_TASK_STALL = "PASS";
  await chamar("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });
});

test("6. CRASH-LOOP: depois do teto o vigia DEGRADA e para de tentar", async () => {
  // Este caso usa uma instância PRÓPRIA do `HealthWatchdog` com relógio
  // injetado. Não é para fugir da falha real — a falha real (navegador morto)
  // já foi provada no caso 2. É porque o que se mede AQUI é a POLÍTICA: quantas
  // vezes ele tenta, se o backoff cresce, e se ele para. Com relógio de parede
  // isso viraria um teste que dorme segundos e ainda assim mede impreciso.
  let agora = 1_000_000;
  const tentativas: number[] = [];
  const eventos: { name: string; kind: string | null }[] = [];

  const wd = new HealthWatchdog({
    interval_ms: 100,
    max_restarts: 2,
    window_ms: 60_000,
    backoff_ms: 100,
    backoff_max_ms: 800,
    now: () => agora,
    onEvent: (e) => eventos.push({ name: e.name, kind: e.kind }),
    probes: [
      {
        kind: "browser_dead",
        // Falha PERMANENTE: o subsistema não volta, faça o que fizer. É o
        // cenário em que um watchdog ingênuo gira para sempre.
        check: async () => ({ ok: false, detail: { motivo: "morto e não volta" } }),
        recover: async () => {
          tentativas.push(agora);
        },
      },
    ],
  });

  // Muitos tiques, com folga de tempo entre eles para o backoff nunca ser a
  // razão de não tentar: o que tem de parar é o CONTADOR, não o relógio.
  for (let i = 0; i < 12; i += 1) {
    agora += 5_000;
    await wd.tick();
  }

  assert.equal(wd.state, "degraded", `o vigia continuou tentando: estado ${wd.state}`);
  assert.equal(tentativas.length, 2, `tentou ${tentativas.length} vezes com teto 2 — o teto não segurou`);
  assert.equal(wd.stats().degraded_by, "browser_dead");
  assert.ok(wd.stats().degraded_since !== null);
  assert.equal(eventos.filter((e) => e.name === "degraded").length, 1, "degradou mais de uma vez");

  // Depois de degradado ele não volta a tentar, nem com mais tiques.
  const antes = tentativas.length;
  for (let i = 0; i < 5; i += 1) {
    agora += 60_000;
    await wd.tick();
  }
  assert.equal(tentativas.length, antes, "degradado e ainda assim tentou de novo");

  // ── controle positivo: com o subsistema CURÁVEL, ele conserta e NÃO degrada
  // Sem isto, "degradou" seria indistinguível de "o watchdog está quebrado".
  let doente = true;
  const wd2 = new HealthWatchdog({
    interval_ms: 100,
    max_restarts: 2,
    backoff_ms: 100,
    backoff_max_ms: 800,
    now: () => agora,
    probes: [
      {
        kind: "browser_dead",
        check: async () => ({ ok: !doente }),
        recover: async () => {
          doente = false;
        },
      },
    ],
  });
  agora += 60_000;
  await wd2.tick();
  agora += 60_000;
  await wd2.tick();
  assert.notEqual(wd2.state, "degraded", "degradou uma falha que foi consertada na primeira tentativa");
  assert.equal(wd2.stats().recovered.browser_dead, 1);

  GATE.WATCHDOG_CRASH_LOOP_PROTECTION = "PASS";
});

test("7. watchdog_enabled:false desliga de verdade — e isso é dito no /health", async () => {
  const d2 = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    headless: true,
    watchdog_enabled: false,
    sessions_root: raizSessoes,
    runtime_dir: runtimeDir,
    agent: null,
    vision: null,
    ai_provider: null,
    vision_provider: null,
    read_file: false,
    env: {},
  });
  try {
    assert.equal(d2.watchdog, null);
    const r = await fetch(`${d2.url}/health`, {
      headers: { ...(d2.token !== null ? { authorization: `Bearer ${d2.token}` } : {}) },
    });
    const h = (await r.json()) as { watchdog?: { enabled: boolean } };
    // "Desligado" é uma resposta e vai para o /health. Omitir o campo faria o
    // leitor não distinguir "desligado" de "esta versão não tem watchdog".
    assert.equal(h.watchdog?.enabled, false);
  } finally {
    await d2.close("fim do caso 7");
  }
});

test("99. portões da FASE 13", () => {
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
  assert.deepEqual(Object.entries(GATE).filter(([, v]) => v !== "PASS"), []);
});
