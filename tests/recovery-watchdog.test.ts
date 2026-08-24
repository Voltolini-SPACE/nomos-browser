/**
 * RECOVERY + WATCHDOG — FASES 11 / 12 / 13 / 14 / 20
 *
 * O gap declarado no `EVIDENCIA.md`: "Sessão sobrevivendo à queda do processo do
 * runtime (FASE 26 só cobre queda de cliente)". Aqui o processo morre de verdade
 * — `SIGKILL`, sem handler, sem chance de salvar nada — e o que se mede é o que
 * sobrou no disco e no sistema operacional.
 *
 * Regras que este arquivo segue para não mentir:
 *
 *  - Nada de `sleep` como mecanismo. Onde há espera, a espera é por CONDIÇÃO
 *    verificável (linha no arquivo, pid morto, estado atingido). Os dois lugares
 *    com prazo fixo são ASSERÇÕES DE AUSÊNCIA: exigem que a promessa REJEITE por
 *    timeout, que é a forma honesta de provar "não reiniciou".
 *  - Controle negativo em toda afirmação forte. "A porta estava ocupada" só vale
 *    porque, liberada a porta, o mesmo watchdog sobe o filho.
 *  - Chromium REAL para o reattach. `connectOverCDP` contra um servidor HTTP de
 *    mentira provaria apenas que sabemos escrever um mock.
 *  - Nenhuma porta fixa, nenhum bind fora de 127.0.0.1, nada perto de :9337
 *    (Chrome de produção do nomos-panel). Tudo em porta efêmera.
 *
 * Roda com: node --test tests/recovery-watchdog.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { RESTRICTED_CAPABILITIES } from "../packages/core/src/contract.ts";
import {
  RecoveryManager,
  SNAPSHOT_SCHEMA,
  STATE_FILE,
  actionClassOf,
  pidAlive,
  probeCdp,
  type RecoveryVerdict,
  type SessionSnapshotInput,
} from "../packages/core/src/recovery.ts";
import { Watchdog, type WatchdogEvent } from "../packages/observability/src/watchdog.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "watchdog-child.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Utilitários de espera — sempre por condição, nunca por relógio
// ─────────────────────────────────────────────────────────────────────────────

async function waitUntil(cond: () => boolean | Promise<boolean>, label: string, timeout_ms = 15_000): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) throw new Error(`timeout (${timeout_ms}ms) esperando: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitValue<T>(fn: () => Promise<T | null>, label: string, timeout_ms = 20_000): Promise<T> {
  const deadline = Date.now() + timeout_ms;
  let last = "";
  for (;;) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) throw new Error(`timeout (${timeout_ms}ms) esperando ${label}: ${last}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Porta efêmera livre: abre em :0, lê o número, fecha. Sempre loopback. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen({ host: "127.0.0.1", port: 0 }, () => res()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

async function startCount(marker: string): Promise<number> {
  try {
    const txt = await readFile(marker, "utf8");
    return txt.split("\n").filter((l) => l.includes('"event":"start"')).length;
  } catch {
    return 0;
  }
}

async function markerLines(marker: string): Promise<Record<string, unknown>[]> {
  try {
    const txt = await readFile(marker, "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function spawnAlien(mode: string, marker: string): ChildProcess {
  return spawn(process.execPath, [FIXTURE], {
    stdio: "ignore",
    env: { ...process.env, NOMOS_FIXTURE_MODE: mode, NOMOS_FIXTURE_MARKER: marker },
  });
}

let ROOT = "";

before(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "nomos-recovery-"));
});

after(async () => {
  if (ROOT !== "") await rm(ROOT, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// WATCHDOG
// ═════════════════════════════════════════════════════════════════════════════

describe("watchdog — crash, reinício e teto (FASE 20 / T10)", () => {
  it("1. um crash → reinicia; a contagem vem do DISCO, não do contador interno", async () => {
    const marker = path.join(ROOT, "wd1.jsonl");
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "crash_once", NOMOS_FIXTURE_MARKER: marker },
      max_restarts: 3,
      backoff_ms: 10,
      backoff_max_ms: 40,
      stop_grace_ms: 500,
    });

    assert.equal(await wd.start(), "running");
    await waitUntil(async () => (await startCount(marker)) >= 2 && wd.state === "running", "segundo arranque");

    const s = wd.stats();
    assert.equal(s.restarts, 1, "exatamente um reinício");
    assert.equal(s.starts, 2);
    assert.equal(s.crashes_in_window, 1);
    assert.equal(s.state, "running");
    assert.equal(s.last_cause?.kind, "crash");
    assert.equal(s.last_cause?.code, 7, "código de saída do fixture preservado");
    assert.equal(await startCount(marker), 2, "o disco confirma 2 arranques");

    await wd.stop();
    assert.equal(wd.state, "stopped");
    assert.equal(wd.stats().last_cause?.kind, "intentional", "stop() não é crash");
    await wd.dispose();
  });

  it("2. três crashes rápidos → crash_loop, PARA de reiniciar e registra a causa", async () => {
    const marker = path.join(ROOT, "wd2.jsonl");
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "crash", NOMOS_FIXTURE_MARKER: marker, NOMOS_FIXTURE_EXIT_CODE: "9" },
      max_restarts: 2,
      window_ms: 60_000,
      backoff_ms: 10,
      backoff_max_ms: 30,
    });

    await wd.start();
    await wd.waitForState("crash_loop", 10_000);

    const s = wd.stats();
    assert.equal(s.state, "crash_loop");
    assert.equal(s.restarts, 2, "gastou exatamente o orçamento (2 reinícios)");
    assert.equal(s.starts, 3, "3 arranques = 1 original + 2 reinícios");
    assert.equal(s.crashes_in_window, 3);
    assert.equal(s.pid, null, "nenhum filho vivo");
    assert.equal(s.last_cause?.kind, "crash");
    assert.equal(s.last_cause?.code, 9, "a causa registrada é o código real de saída");
    assert.ok(s.crash_loop_since !== null, "carimba quando entrou em crash_loop");

    // Prova de que PAROU: exigir que o estado "running" nunca mais chegue.
    const antes = await startCount(marker);
    await assert.rejects(
      () => wd.waitForState("running", 400),
      /timeout esperando estado "running"/,
      "não pode voltar a subir depois do crash_loop",
    );
    assert.equal(await startCount(marker), antes, "nenhum arranque novo no disco");
    assert.equal(antes, 3);

    // Controle negativo do próprio mecanismo: reset() explícito devolve o orçamento.
    wd.reset();
    assert.equal(wd.state, "idle");
    assert.equal(wd.stats().crashes_in_window, 0);
    await wd.dispose();
  });

  it("3. stop() manual → parada INTENCIONAL, não reinicia, não conta crash", async () => {
    const marker = path.join(ROOT, "wd3.jsonl");
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "stay", NOMOS_FIXTURE_MARKER: marker },
      max_restarts: 3,
      backoff_ms: 10,
      backoff_max_ms: 30,
      stop_grace_ms: 1_000,
    });

    await wd.start();
    await waitUntil(async () => (await startCount(marker)) === 1, "primeiro arranque");
    const pid = wd.pid;
    assert.ok(pid !== null && pid > 0);

    await wd.stop();
    const s = wd.stats();
    assert.equal(s.state, "stopped");
    assert.equal(s.restarts, 0, "parada intencional NÃO gera reinício");
    assert.equal(s.crashes_in_window, 0, "parada intencional NÃO conta como crash");
    assert.equal(s.last_cause?.kind, "intentional");
    assert.equal(s.last_cause?.code, 0, "saiu 0 depois do SIGTERM");

    await assert.rejects(() => wd.waitForState("running", 300), /timeout/);
    assert.equal(await startCount(marker), 1, "nenhum reinício após stop()");

    const linhas = await markerLines(marker);
    assert.ok(
      linhas.some((l) => l.event === "signal" && l.signal === "SIGTERM"),
      "o filho recebeu SIGTERM (parada graciosa), não SIGKILL",
    );
    assert.ok(!pidAlive(pid), "o pid do filho está morto");
    await wd.dispose();
  });

  it("4. filho que ignora SIGTERM → escala para SIGKILL, e só no próprio filho", async () => {
    const marker = path.join(ROOT, "wd4.jsonl");
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "ignore_term", NOMOS_FIXTURE_MARKER: marker },
      stop_grace_ms: 250,
    });
    await wd.start();
    await waitUntil(async () => (await startCount(marker)) === 1, "arranque");
    const pid = wd.pid!;

    await wd.stop();
    const s = wd.stats();
    assert.equal(s.state, "stopped");
    assert.equal(s.last_cause?.kind, "intentional", "escalar para SIGKILL não transforma parada em crash");
    assert.equal(s.last_cause?.signal, "SIGKILL");
    const linhas = await markerLines(marker);
    assert.ok(linhas.some((l) => l.event === "ignored"), "o filho de fato ignorou o SIGTERM");
    assert.ok(!pidAlive(pid));
    await wd.dispose();
  });

  it("5. backoff cresce mas tem TETO — o intervalo nunca vira 'nunca'", async () => {
    const marker = path.join(ROOT, "wd5.jsonl");
    const delays: number[] = [];
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "crash", NOMOS_FIXTURE_MARKER: marker },
      max_restarts: 5,
      backoff_ms: 20,
      backoff_max_ms: 60,
      onEvent: (e: WatchdogEvent) => {
        if (e.name === "restarting") delays.push(e.detail.delay_ms as number);
      },
    });
    await wd.start();
    await wd.waitForState("crash_loop", 10_000);

    assert.equal(delays.length, 5, "cinco reinícios, cinco intervalos");
    assert.deepEqual(delays, [20, 40, 60, 60, 60], "20 → 40 → 60 e para de crescer no teto");
    assert.ok(Math.max(...delays) <= 60, "nenhum intervalo passa do teto");
    await wd.dispose();
  });

  it("5b. a janela é DESLIZANTE — crash antigo sai da conta e o orçamento volta", async () => {
    const marker = path.join(ROOT, "wd5b.jsonl");
    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "crash_once", NOMOS_FIXTURE_MARKER: marker },
      max_restarts: 1,
      window_ms: 150,
      backoff_ms: 10,
      backoff_max_ms: 20,
      stop_grace_ms: 500,
    });

    await wd.start();
    await waitUntil(async () => (await startCount(marker)) >= 2 && wd.state === "running", "reinício após o crash");
    assert.equal(wd.stats().crashes_in_window, 1, "o crash está na janela agora");

    // Espera pela CONDIÇÃO (a janela esvaziar), não por um relógio arbitrário.
    await waitUntil(() => wd.stats().crashes_in_window === 0, "janela deslizar", 5_000);
    assert.equal(wd.state, "running", "e o filho seguiu de pé o tempo todo");
    assert.equal(wd.stats().restarts, 1, "o histórico de reinícios NÃO é apagado pela janela");

    await wd.dispose();
  });
});

describe("watchdog — nunca mata o que não iniciou", () => {
  it("6. pid alheio: recusado, contado, e o processo continua vivo", async () => {
    const marker = path.join(ROOT, "wd6.jsonl");
    const alienMarker = path.join(ROOT, "wd6-alien.jsonl");
    const alien = spawnAlien("stay", alienMarker);
    await waitUntil(async () => (await startCount(alienMarker)) === 1, "processo alheio de pé");
    const alienPid = alien.pid!;
    assert.ok(pidAlive(alienPid));

    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, NOMOS_FIXTURE_MODE: "stay", NOMOS_FIXTURE_MARKER: marker },
      stop_grace_ms: 1_000,
    });
    await wd.start();
    await waitUntil(async () => (await startCount(marker)) === 1, "filho do watchdog de pé");
    const ownPid = wd.pid!;
    assert.notEqual(ownPid, alienPid);

    assert.equal(wd.owns(alienPid), false, "não reivindica processo alheio");
    assert.equal(wd.killOwned(alienPid), false, "recusa matar processo alheio");
    assert.ok(pidAlive(alienPid), "o processo alheio continua VIVO");

    // pid <= 0 em process.kill atingiria o GRUPO inteiro de processos.
    assert.equal(wd.killOwned(0), false);
    assert.equal(wd.killOwned(-1), false);
    assert.equal(wd.killOwned(1.5), false);
    assert.equal(wd.stats().refused_kills, 4, "toda recusa é contada, nenhuma silenciosa");

    assert.equal(wd.owns(ownPid), true, "reconhece o próprio filho");

    await wd.dispose();
    assert.ok(!pidAlive(ownPid), "o próprio filho foi parado");
    assert.ok(pidAlive(alienPid), "o alheio SOBREVIVE ao dispose() do watchdog");

    // Depois de morto, o pid que já foi nosso também é recusado: o SO recicla pid.
    assert.equal(wd.killOwned(ownPid), false);

    alien.kill("SIGKILL");
    await waitUntil(() => !pidAlive(alienPid), "limpeza do processo alheio");
  });

  it("7. porta ocupada → port_busy, sem spawn e sem tocar no ocupante", async () => {
    const marker = path.join(ROOT, "wd7.jsonl");
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen({ host: "127.0.0.1", port: 0 }, () => res()));
    const port = (srv.address() as net.AddressInfo).port;

    const wd = new Watchdog({
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ...process.env,
        NOMOS_FIXTURE_MODE: "listen",
        NOMOS_FIXTURE_MARKER: marker,
        NOMOS_FIXTURE_PORT: String(port),
      },
      port,
      stop_grace_ms: 1_000,
    });

    assert.equal(await wd.start(), "port_busy");
    assert.equal(wd.pid, null, "não chegou a subir filho nenhum");
    assert.equal(await startCount(marker), 0, "o disco confirma: zero arranques");
    assert.equal(wd.stats().last_cause?.kind, "port_busy");
    assert.match(String(wd.stats().last_cause?.message), /NÃO matamos o ocupante/);
    assert.equal(srv.listening, true, "o ocupante continua escutando");
    assert.equal(wd.stats().crashes_in_window, 0, "porta ocupada não queima orçamento de reinício");

    // Controle negativo: liberada a porta, o MESMO watchdog sobe. Sem isto,
    // "port_busy" poderia ser só um watchdog que nunca funciona.
    await new Promise<void>((res) => srv.close(() => res()));
    assert.equal(await wd.start(), "running");
    await waitUntil(async () => (await startCount(marker)) === 1, "arranque após liberar a porta");
    await wd.dispose();
  });

  it("8. host fora de loopback é recusado na construção", () => {
    assert.throws(
      () => new Watchdog({ command: process.execPath, host: "0.0.0.0", port: 12345 }),
      /recusado — só loopback/,
    );
    assert.throws(() => new Watchdog({ command: "" }), /command é obrigatório/);
    assert.throws(() => new Watchdog({ command: "x", backoff_ms: 500, backoff_max_ms: 100 }), /teto abaixo da base/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECOVERY — snapshot em disco
// ═════════════════════════════════════════════════════════════════════════════

function snapshotInput(over: Partial<SessionSnapshotInput> = {}): SessionSnapshotInput {
  return {
    session_id: "ses_teste",
    owner: "agente-a",
    profile: "sandbox",
    url: "about:blank",
    page_ids: ["pg_1"],
    context_id: "ctx_1",
    capabilities: { ...RESTRICTED_CAPABILITIES },
    cdp_endpoint: null,
    browser_pid: null,
    browser_id: null,
    status: "ACTIVE",
    ephemeral: true,
    ...over,
  };
}

describe("recovery — snapshot atômico e snapshot corrompido", () => {
  let root = "";
  let rec: RecoveryManager;

  before(async () => {
    root = await mkdtemp(path.join(ROOT, "snap-"));
    rec = new RecoveryManager({ root });
  });

  it("9. save() é atômico: nenhum .tmp sobrevive e o leitor nunca vê meio arquivo", async () => {
    const id = "ses_atomic";
    await rec.save(snapshotInput({ session_id: id, url: "https://exemplo.invalid/a" }));

    const dir = path.join(root, id);
    assert.deepEqual(await readdir(dir), [STATE_FILE], "só o arquivo final fica no diretório");

    // 40 gravações concorrentes com 40 leituras entremeadas. Nenhuma leitura
    // pode enxergar JSON truncado — é isso que tmp+rename compra.
    const writes: Promise<unknown>[] = [];
    const reads: Promise<string>[] = [];
    for (let i = 0; i < 40; i += 1) {
      writes.push(rec.save(snapshotInput({ session_id: id, url: `https://exemplo.invalid/${"x".repeat(i * 50)}` })));
      reads.push(rec.load(id).then((l) => (l.ok ? "ok" : (l.error ?? "?"))));
    }
    await Promise.all(writes);
    const results = await Promise.all(reads);
    const ruins = results.filter((r) => r !== "ok");
    assert.deepEqual(ruins, [], `nenhuma leitura parcial; observado: ${JSON.stringify(results)}`);
    assert.deepEqual(await readdir(dir), [STATE_FILE], "nenhum .tmp vazado depois de 40 escritas");

    // ── CONTROLE NEGATIVO ───────────────────────────────────────────────────
    // Sem isto, "0 leituras parciais" poderia ser só um padrão de concorrência
    // fraco demais para expor qualquer coisa. Mesmo número de escritas e
    // leituras, mesma máquina, mas com writeFile direto (sem tmp+rename): tem
    // de aparecer leitura parcial. É o par CDP-04/CDP-10 do spike da FASE 1.
    const cru = path.join(dir, "controle-negativo.json");
    await writeFile(cru, JSON.stringify({ n: 0 }), "utf8");
    const w2: Promise<unknown>[] = [];
    const r2: Promise<string>[] = [];
    for (let i = 0; i < 40; i += 1) {
      w2.push(writeFile(cru, `${JSON.stringify({ n: i, pad: "x".repeat(i * 50) })}\n`, "utf8"));
      r2.push(
        readFile(cru, "utf8").then(
          (t) => {
            try {
              JSON.parse(t);
              return "ok";
            } catch {
              return "PARCIAL";
            }
          },
          () => "ausente",
        ),
      );
    }
    await Promise.all(w2);
    const parciais = (await Promise.all(r2)).filter((x) => x === "PARCIAL").length;
    assert.ok(
      parciais > 0,
      `o controle negativo precisa expor leitura parcial, senão o teste não discrimina (parciais=${parciais})`,
    );
    await rm(cru, { force: true });
  });

  it("10. sobra de .tmp do crash é INERTE — não é lida nem listada", async () => {
    const id = "ses_tmpleft";
    const bom = await rec.save(snapshotInput({ session_id: id, owner: "dono-bom" }));
    // Exatamente o que um SIGKILL no meio da escrita deixaria para trás.
    await writeFile(path.join(root, id, `${STATE_FILE}.tmp-99999-deadbeef`), '{"schema":1,"owner":"dono-la', "utf8");

    const listed = await rec.list();
    assert.ok(listed.includes(id));
    const load = await rec.load(id);
    assert.equal(load.ok, true, "o snapshot bom continua legível");
    assert.equal(load.snapshot?.owner, "dono-bom");
    assert.equal(load.snapshot?.criado_em, bom.criado_em);
  });

  it("11. state.json TRUNCADO → terminate/snapshot_corrupted, e o pid vivo lá dentro é IGNORADO", async () => {
    const marker = path.join(ROOT, "rec11.jsonl");
    const vivo = spawnAlien("stay", marker);
    await waitUntil(async () => (await startCount(marker)) === 1, "processo de mentira vivo");
    const pid = vivo.pid!;
    assert.ok(pidAlive(pid));

    const id = "ses_truncado";
    const cheio = JSON.stringify(
      { ...snapshotInput({ session_id: id, browser_pid: pid }), schema: SNAPSHOT_SCHEMA },
      null,
      2,
    );
    // Corta DEPOIS do browser_pid: o texto contém um pid vivo de verdade.
    const corte = cheio.indexOf(`"browser_pid": ${pid}`) + `"browser_pid": ${pid},`.length;
    assert.ok(corte > 20, "o corte precisa cair depois do browser_pid");
    const meio = cheio.slice(0, corte);
    assert.match(meio, new RegExp(`"browser_pid": ${pid}`), "o arquivo truncado realmente carrega o pid vivo");
    await rec.save(snapshotInput({ session_id: id, browser_pid: pid }));
    // Sobrescreve o arquivo bom pelo pedaço: é o que o SIGKILL deixaria se a
    // escrita NÃO fosse atômica.
    await writeFile(path.join(root, id, STATE_FILE), meio, "utf8");

    const v = await rec.decide(id);
    assert.equal(v.decision, "terminate");
    assert.equal(v.reason, "snapshot_corrupted");
    assert.equal(v.snapshot, null, "nada é aproveitado de um snapshot pela metade");
    assert.equal(v.needs_reobservation, false);
    assert.ok((v.detail.bytes as number) > 0);

    // E o processo cujo pid estava no texto truncado continua vivo: terminate
    // retira SNAPSHOT, não mata processo.
    await rec.retire(id);
    assert.ok(pidAlive(pid), "terminate/retire não matou ninguém");
    assert.equal((await readdir(path.join(root, id))).includes(STATE_FILE), false);

    vivo.kill("SIGKILL");
    await waitUntil(() => !pidAlive(pid), "limpeza");
  });

  it("12. schema desconhecido, campo faltando e sessão CLOSED → terminate com motivo distinto", async () => {
    const casos: [string, string, string][] = [];

    await rec.save(snapshotInput({ session_id: "ses_schema" }));
    const f = path.join(root, "ses_schema", STATE_FILE);
    const obj = JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>;
    await writeFile(f, JSON.stringify({ ...obj, schema: 99 }), "utf8");
    let v = await rec.decide("ses_schema");
    casos.push(["ses_schema", v.decision, v.reason]);
    assert.equal(v.decision, "terminate");
    assert.equal(v.reason, "schema_unknown");

    await rec.save(snapshotInput({ session_id: "ses_falta" }));
    const f2 = path.join(root, "ses_falta", STATE_FILE);
    const obj2 = JSON.parse(await readFile(f2, "utf8")) as Record<string, unknown>;
    delete obj2.owner;
    await writeFile(f2, JSON.stringify(obj2), "utf8");
    v = await rec.decide("ses_falta");
    casos.push(["ses_falta", v.decision, v.reason]);
    assert.equal(v.decision, "terminate");
    assert.equal(v.reason, "snapshot_invalid");
    assert.match(String(v.detail.message), /owner/);

    await rec.save(snapshotInput({ session_id: "ses_fechada", status: "CLOSED" }));
    v = await rec.decide("ses_fechada");
    casos.push(["ses_fechada", v.decision, v.reason]);
    assert.equal(v.decision, "terminate");
    assert.equal(v.reason, "session_closed");

    // Motivos distintos: três terminates que NÃO são o mesmo diagnóstico.
    assert.equal(new Set(casos.map((c) => c[2])).size, 3);
  });

  it("13. patch em snapshot ausente LANÇA — não recria estado do nada", async () => {
    await assert.rejects(() => rec.patch("ses_inexistente", {}), /snapshot de ses_inexistente indisponível/);
    await assert.equal(await rec.retire("ses_inexistente"), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECOVERY — decisões sobre processos REAIS
// ═════════════════════════════════════════════════════════════════════════════

describe("recovery — pid vivo, pid morto, CDP mudo", () => {
  let root = "";
  let rec: RecoveryManager;
  const filhos: ChildProcess[] = [];

  before(async () => {
    root = await mkdtemp(path.join(ROOT, "proc-"));
    rec = new RecoveryManager({ root, probe_timeout_ms: 800 });
  });

  after(() => {
    for (const c of filhos) if (c.pid !== undefined && pidAlive(c.pid)) c.kill("SIGKILL");
  });

  it("14. browser_pid MORTO (SIGKILL real) → orphan, jamais reattach", async () => {
    const marker = path.join(ROOT, "rec14.jsonl");
    const c = spawnAlien("stay", marker);
    filhos.push(c);
    await waitUntil(async () => (await startCount(marker)) === 1, "processo vivo");
    const pid = c.pid!;
    const port = await freePort();

    const id = "ses_morto";
    await rec.save(
      snapshotInput({
        session_id: id,
        browser_pid: pid,
        browser_id: "0b783d73-0115-4b34-ab66-023530a23883",
        cdp_endpoint: `http://127.0.0.1:${port}`,
      }),
    );

    // Com o pid VIVO e o CDP mudo, a decisão já não pode ser reattach.
    let v = await rec.decide(id);
    assert.equal(v.decision, "orphan");
    assert.equal(v.reason, "cdp_unreachable");
    assert.ok(pidAlive(pid), "decidir NÃO mata o processo sondado");

    // SIGKILL de verdade — sem handler, sem chance de salvar nada.
    c.kill("SIGKILL");
    await waitUntil(() => !pidAlive(pid), "pid morto após SIGKILL");

    v = await rec.decide(id);
    assert.equal(v.decision, "orphan", "pid morto NUNCA vira reattach");
    assert.equal(v.reason, "browser_pid_dead");
    assert.equal(v.detail.browser_pid, pid);
    assert.equal(v.needs_reobservation, true);

    const r = await rec.reattach(v);
    assert.equal(r.connected, false, "reattach recusa veredito orphan");
    assert.match(String(r.error), /orphan não autoriza reattach/);
  });

  it("15. browser_pid ausente → orphan/browser_pid_unknown", async () => {
    const id = "ses_sempid";
    await rec.save(snapshotInput({ session_id: id, browser_pid: null, cdp_endpoint: "http://127.0.0.1:1" }));
    const v = await rec.decide(id);
    assert.equal(v.decision, "orphan");
    assert.equal(v.reason, "browser_pid_unknown");
    assert.equal(v.snapshot?.session_id, id, "o snapshot íntegro é devolvido junto do veredito");
  });

  it("16. endpoint de CDP fora de loopback é recusado ANTES de qualquer requisição (T2)", async () => {
    for (const hostil of [
      "http://169.254.169.254:9222",
      "http://10.0.0.5:9222",
      "https://evil.example.com",
      "file:///etc/passwd",
      "http://127.0.0.1.evil.com:9222",
      "",
    ]) {
      const t0 = performance.now();
      const p = await probeCdp(hostil);
      const dt = performance.now() - t0;
      assert.equal(p.rejected, true, `deveria recusar: ${JSON.stringify(hostil)}`);
      assert.equal(p.reachable, false);
      // A recusa é ANTES da rede: um fetch de verdade para 169.254.169.254
      // penduraria até o timeout. Voltar em ~0ms é a prova de que não saiu daqui.
      assert.ok(dt < 20, `recusa deve ser anterior a qualquer requisição (levou ${dt.toFixed(2)}ms)`);
    }
    // Controle negativo: loopback legítimo NÃO é recusado (só inalcançável).
    const ok = await probeCdp(`http://127.0.0.1:${await freePort()}`);
    assert.equal(ok.rejected, false);
    assert.equal(ok.reachable, false);
    assert.match(String(ok.error), /ECONNREFUSED|fetch failed/, "inalcançável é diferente de recusado");

    const id = "ses_ssrf";
    const marker = path.join(ROOT, "rec16.jsonl");
    const c = spawnAlien("stay", marker);
    filhos.push(c);
    await waitUntil(async () => (await startCount(marker)) === 1, "processo vivo");
    await rec.save(
      snapshotInput({
        session_id: id,
        browser_pid: c.pid!,
        browser_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cdp_endpoint: "http://169.254.169.254:9222",
      }),
    );
    const v = await rec.decide(id);
    assert.equal(v.decision, "orphan");
    assert.equal(v.reason, "cdp_endpoint_rejected");

    // Veredito FORJADO dizendo "reattach": `RecoveryVerdict` é objeto simples e
    // pode chegar montado à mão. Conectar é o ato perigoso, então reattach()
    // revalida o endpoint em vez de confiar na decisão que recebeu.
    const forjado: RecoveryVerdict = {
      session_id: id,
      decision: "reattach",
      reason: "cdp_alive",
      detail: {},
      snapshot: (await rec.load(id)).snapshot,
      in_flight: null,
      needs_reobservation: false,
      decided_at: new Date().toISOString(),
    };
    const rf = await rec.reattach(forjado);
    assert.equal(rf.connected, false, "não conecta em endpoint hostil nem com veredito favorável");
    assert.equal(rf.decision, "orphan");
    assert.equal(rf.reason, "cdp_endpoint_rejected");
  });

  it("17. scan() decide TODAS as sessões — nenhuma fica sem decisão e sem motivo", async () => {
    const vereditos = await rec.scan();
    const ids = new Set(vereditos.map((v) => v.session_id));
    for (const esperado of ["ses_morto", "ses_sempid", "ses_ssrf"]) {
      assert.ok(ids.has(esperado), `scan() precisa cobrir ${esperado}`);
    }
    for (const v of vereditos) {
      assert.ok(["reattach", "recover", "orphan", "terminate"].includes(v.decision), `decisão inválida: ${v.decision}`);
      assert.ok(typeof v.reason === "string" && v.reason.length > 0, "todo veredito carrega motivo");
      assert.ok(typeof v.decided_at === "string" && v.decided_at.endsWith("Z"));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECOVERY — Chromium REAL, reattach por CDP e SIGKILL do browser
// ═════════════════════════════════════════════════════════════════════════════

describe("recovery — reattach contra Chromium REAL", () => {
  let root = "";
  let rec: RecoveryManager;
  let udd = "";
  let proc: ChildProcess | null = null;
  let pid = 0;
  let endpoint = "";
  let browserId = "";

  const ID = "ses_chromium";
  const URL_A = "data:text/html,<title>alfa</title><h1>alfa</h1>";
  const URL_B = "data:text/html,<title>beta</title><h1>beta</h1>";

  before(async () => {
    root = await mkdtemp(path.join(ROOT, "cdp-"));
    rec = new RecoveryManager({ root, probe_timeout_ms: 2_000 });
    udd = await mkdtemp(path.join(tmpdir(), "nomos-cdp-udd-"));

    // Chromium do próprio playwright, porta EFÊMERA (:0) escolhida por ele e
    // publicada em DevToolsActivePort. Nada de porta fixa, nada perto de :9337.
    proc = spawn(
      chromium.executablePath(),
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${udd}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    pid = proc.pid!;

    const port = await waitValue(async () => {
      const txt = await readFile(path.join(udd, "DevToolsActivePort"), "utf8");
      const first = txt.split("\n")[0]!.trim();
      return first === "" ? null : Number(first);
    }, "DevToolsActivePort");
    endpoint = `http://127.0.0.1:${port}`;

    const probe = await waitValue(async () => {
      const p = await probeCdp(endpoint, 1_000);
      return p.reachable ? p : null;
    }, "/json/version");
    browserId = probe.browser_id!;
    assert.ok(browserId.length > 8, "identidade de instância do Chromium capturada");

    // Estado inicial: uma aba em URL_A.
    const b = await chromium.connectOverCDP(endpoint);
    const pg = b.contexts()[0]!.pages()[0] ?? (await b.contexts()[0]!.newPage());
    await pg.goto(URL_A);
    await b.close();

    await rec.save(
      snapshotInput({
        session_id: ID,
        profile: "default",
        ephemeral: false,
        url: URL_A,
        page_ids: ["pg_alfa"],
        browser_pid: pid,
        browser_id: browserId,
        cdp_endpoint: endpoint,
      }),
    );
  });

  after(async () => {
    if (pid > 0 && pidAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitUntil(() => !pidAlive(pid), "limpeza do Chromium", 5_000).catch(() => undefined);
    }
    if (udd !== "") await rm(udd, { recursive: true, force: true });
  });

  it("18. CDP vivo + identidade confere → reattach, e a verificação confirma a URL", async () => {
    const v = await rec.decide(ID);
    assert.equal(v.decision, "reattach");
    assert.equal(v.reason, "cdp_alive");
    assert.match(String(v.detail.browser), /^Chrome\//, "o veredito registra qual browser respondeu");
    assert.equal(v.needs_reobservation, false);

    const r = await rec.reattach(v);
    assert.equal(r.connected, true, "connectOverCDP contra Chromium real");
    assert.equal(r.decision, "reattach");
    assert.equal(r.url_matches, true);
    assert.equal(r.pages_observed, 1);
    assert.equal(r.pages_expected, 1);
    assert.equal(r.needs_reobservation, false, "URL e cardinalidade batem: nada a reobservar");
    assert.deepEqual(r.observed_urls, [URL_A]);

    // Fechar a CONEXÃO não mata o Chromium — é o que torna a verificação segura.
    await r.browser!.close();
    assert.ok(pidAlive(pid), "o processo do browser sobrevive ao fim da conexão de CDP");
  });

  it("19. URL divergiu sob o crash → recover + needs_reobservation, NUNCA 'assume que continua lá'", async () => {
    const b = await chromium.connectOverCDP(endpoint);
    await b.contexts()[0]!.pages()[0]!.goto(URL_B);
    await b.close();

    const v = await rec.decide(ID);
    assert.equal(v.decision, "reattach", "no nível do CDP o browser continua o mesmo");

    const r = await rec.reattach(v);
    assert.equal(r.connected, true);
    assert.equal(r.decision, "recover", "a verificação REBAIXA a decisão");
    assert.equal(r.reason, "url_divergent");
    assert.equal(r.url_matches, false);
    assert.equal(r.needs_reobservation, true);
    assert.equal(r.expected_url, URL_A);
    assert.deepEqual(r.observed_urls, [URL_B], "reporta o que observou, não o que esperava");
    await r.browser!.close();
  });

  it("20. número de abas divergiu → recover/pages_divergent", async () => {
    const b = await chromium.connectOverCDP(endpoint);
    const ctx = b.contexts()[0]!;
    await ctx.pages()[0]!.goto(URL_A); // volta a URL para isolar a causa
    const extra = await ctx.newPage();
    await extra.goto(URL_B);
    await b.close();

    const v = await rec.decide(ID);
    const r = await rec.reattach(v);
    assert.equal(r.connected, true);
    assert.equal(r.url_matches, true, "a URL esperada existe...");
    assert.equal(r.decision, "recover", "...mas apareceu uma aba a mais");
    assert.equal(r.reason, "pages_divergent");
    assert.equal(r.pages_expected, 1);
    assert.equal(r.pages_observed, 2);
    assert.equal(r.needs_reobservation, true);
    await r.browser!.close();

    // Restaura para 1 aba em URL_A — os testes seguintes medem outra coisa.
    const b2 = await chromium.connectOverCDP(endpoint);
    const ctx2 = b2.contexts()[0]!;
    for (const p of ctx2.pages().slice(1)) await p.close();
    await ctx2.pages()[0]!.goto(URL_A);
    await b2.close();
    const conf = await rec.reattach(await rec.decide(ID));
    assert.equal(conf.decision, "reattach", "estado restaurado antes de seguir");
    await conf.browser!.close();
  });

  it("21. ação destrutiva em voo → UNKNOWN_OUTCOME: nem sucesso, nem falha, nem repetição cega", async () => {
    await rec.markInFlight(ID, {
      action_id: "act_pagamento",
      tool: "browser.download",
      target: "#confirmar",
      started_at: new Date().toISOString(),
    });

    const v = await rec.decide(ID);
    assert.equal(v.decision, "recover", "com ação em voo a sessão NÃO volta a ACTIVE");
    assert.equal(v.reason, "in_flight_unknown_outcome");
    assert.equal(v.needs_reobservation, true);
    assert.equal(v.in_flight?.outcome, "UNKNOWN_OUTCOME");
    assert.equal(v.in_flight?.action_class, "COMMIT");
    assert.equal(v.in_flight?.safe_to_retry, false, "COMMIT interrompido nunca é repetido automaticamente");
    assert.equal(v.in_flight?.requires_human_decision, true);
    assert.equal(v.in_flight?.action_id, "act_pagamento");

    const r = await rec.reattach(v);
    assert.equal(r.connected, true, "reata para PODER reobservar");
    assert.equal(r.decision, "recover");
    assert.equal(r.url_matches, true, "a URL até bate — o que impede o reattach limpo é a ação em voo");
    assert.equal(r.needs_reobservation, true);
    assert.equal(r.in_flight?.safe_to_retry, false);
    await r.browser!.close();

    // Ferramenta desconhecida é COMMIT por fail closed, não OBSERVE por omissão.
    assert.equal(actionClassOf("browser.observe"), "OBSERVE");
    assert.equal(actionClassOf("browser.click"), "ACT");
    assert.equal(actionClassOf("browser.download"), "COMMIT");
    assert.equal(actionClassOf("ferramenta.inventada"), "COMMIT");

    // Leitura em voo: continua sem presumir desfecho, mas é repetível.
    await rec.markInFlight(ID, {
      action_id: "act_leitura",
      tool: "browser.observe",
      target: null,
      started_at: new Date().toISOString(),
    });
    const v2 = await rec.decide(ID);
    assert.equal(v2.in_flight?.outcome, "UNKNOWN_OUTCOME", "nem OBSERVE ganha desfecho inventado");
    assert.equal(v2.in_flight?.action_class, "OBSERVE");
    assert.equal(v2.in_flight?.safe_to_retry, true);
    assert.equal(v2.in_flight?.requires_human_decision, false);

    const limpo = await rec.clearInFlight(ID);
    assert.equal(limpo.in_flight_action, null);
    assert.equal((await rec.decide(ID)).decision, "reattach", "sem ação em voo, volta a reattach");
  });

  it("22. porta reciclada por OUTRO Chromium (identidade não confere) → orphan, sem conectar", async () => {
    const original = (await rec.load(ID)).snapshot!.browser_id;
    await rec.patch(ID, { browser_id: "00000000-1111-2222-3333-444444444444" });

    const v = await rec.decide(ID);
    assert.equal(v.decision, "orphan", "CDP responde, pid vive — e ainda assim NÃO reata");
    assert.equal(v.reason, "cdp_identity_mismatch");
    assert.equal(v.detail.expected_browser_id, "00000000-1111-2222-3333-444444444444");
    assert.equal(v.detail.observed_browser_id, browserId);

    const r = await rec.reattach(v);
    assert.equal(r.connected, false, "não abre conexão com browser de identidade desconhecida");

    // Sem identidade gravada também não há reattach — fail closed, não "tenta".
    await rec.patch(ID, { browser_id: null });
    const v2 = await rec.decide(ID);
    assert.equal(v2.decision, "orphan");
    assert.equal(v2.reason, "cdp_identity_unknown");

    await rec.patch(ID, { browser_id: original });
    assert.equal((await rec.decide(ID)).decision, "reattach", "restaurada a identidade, volta a reatar");
  });

  it("23. SIGKILL no Chromium com sessão ativa → orphan/browser_pid_dead, e nada é inventado", async () => {
    assert.ok(pidAlive(pid), "pré-condição: o browser está vivo");
    assert.equal((await rec.decide(ID)).decision, "reattach");

    // A queda que o PRODUCT-01 não cobria: processo morto sem aviso.
    process.kill(pid, "SIGKILL");
    await waitUntil(() => !pidAlive(pid), "Chromium morto", 10_000);

    const v = await rec.decide(ID);
    assert.equal(v.decision, "orphan");
    assert.equal(v.reason, "browser_pid_dead");
    assert.equal(v.needs_reobservation, true);
    assert.equal(v.snapshot?.url, URL_A, "o snapshot sobreviveu ao SIGKILL, íntegro");
    assert.equal(v.snapshot?.browser_pid, pid);

    const r = await rec.reattach(v);
    assert.equal(r.connected, false);
    assert.equal(r.url_matches, false);
    assert.deepEqual(r.observed_urls, [], "não inventa aba que não observou");

    // A porta do CDP também morreu junto: sonda confirma, sem adivinhação.
    const p = await probeCdp(endpoint, 800);
    assert.equal(p.reachable, false);
  });
});
