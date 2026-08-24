/**
 * OBSERVABILIDADE — FASES 9 / 23 / 24 / 25
 *
 * Testes puros de Node: sem Chromium, sem rede, sem sleep. Onde há assincronia
 * a espera é por condição verificável (`bus.drain()`, promessa de append), nunca
 * por temporizador — um `sleep` esconde exatamente a corrida que o teste deveria
 * pegar.
 *
 * Roda com: node --test tests/observability.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeAuditEntry } from "../packages/core/src/contract.ts";
import type { AuditEntry, RuntimeEvent } from "../packages/core/src/contract.ts";
import {
  REDACTED,
  isSensitiveField,
  redactHeaders,
  redactObject,
  redactUrl,
} from "../packages/observability/src/redact.ts";
import { EventBus } from "../packages/observability/src/eventbus.ts";
import { AuditLog, SESSIONS_ROOT, assertSafeSessionId } from "../packages/observability/src/audit.ts";
import {
  SessionRecorder,
  loadReplay,
  replaySummary,
  screenshotPath,
} from "../packages/observability/src/replay.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** PNG 1x1 válido — serve para provar que saveScreenshot decodifica de verdade. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ROOT = "";

before(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "nomos-obs-"));
});

after(async () => {
  if (ROOT !== "") await rm(ROOT, { recursive: true, force: true });
});

function evt(over: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    timestamp: "2026-08-24T10:00:00.000Z",
    session_id: null,
    action_id: null,
    source: "runtime",
    event: "action.started",
    payload: {},
    ...over,
  } as RuntimeEvent;
}

function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return makeAuditEntry({
    timestamp: "2026-08-24T10:00:00.000Z",
    session: null,
    actor: "agent",
    action: "browser.click",
    target: "#login",
    result: "ok",
    verified: true,
    action_id: "act_1",
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("redact (FASE 23)", () => {
  it("1. objeto aninhado: esconde Authorization e mantém os demais campos intactos", () => {
    const input = {
      url: "https://api.exemplo.com/pay",
      method: "POST",
      headers: {
        Authorization: "Bearer sk_live_ABC123",
        Cookie: "sid=xyz",
        "Content-Type": "application/json",
      },
      nivel1: {
        nivel2: {
          password: "hunter2",
          senha: "correria",
          client_secret: "cs_9",
          usuario: "operador",
          nivel3: [
            { "x-api-key": "k1", ordem: 7 },
            { access_token: "at", refresh_token: "rt", ok: true },
          ],
        },
      },
      // Deve SOBREVIVER: o contrato audita a referência do segredo, não o valor.
      credential_ref: "vault://se7en/pix",
      token_count: 4210,
      tokenizer: "bpe",
    };

    const out = redactObject(input);

    // Escondido
    assert.equal(out.headers.Authorization, REDACTED);
    assert.equal(out.headers.Cookie, REDACTED);
    assert.equal(out.nivel1.nivel2.password, REDACTED);
    assert.equal(out.nivel1.nivel2.senha, REDACTED);
    assert.equal(out.nivel1.nivel2.client_secret, REDACTED);
    assert.equal(out.nivel1.nivel2.nivel3[0]!["x-api-key"], REDACTED);
    assert.equal(out.nivel1.nivel2.nivel3[1]!.access_token, REDACTED);
    assert.equal(out.nivel1.nivel2.nivel3[1]!.refresh_token, REDACTED);

    // Intacto
    assert.equal(out.url, "https://api.exemplo.com/pay");
    assert.equal(out.method, "POST");
    assert.equal(out.headers["Content-Type"], "application/json");
    assert.equal(out.nivel1.nivel2.usuario, "operador");
    assert.equal(out.nivel1.nivel2.nivel3[0]!.ordem, 7);
    assert.equal(out.nivel1.nivel2.nivel3[1]!.ok, true);
    assert.equal(out.credential_ref, "vault://se7en/pix");
    assert.equal(out.token_count, 4210);
    assert.equal(out.tokenizer, "bpe");

    // O original não pode ter sido mutado — redação devolve cópia.
    assert.equal(input.headers.Authorization, "Bearer sk_live_ABC123");

    // Nenhum segredo sobrou em lugar nenhum da serialização.
    const serial = JSON.stringify(out);
    for (const leak of ["sk_live_ABC123", "hunter2", "correria", "cs_9", "k1", "sid=xyz"]) {
      assert.equal(serial.includes(leak), false, `vazou: ${leak}`);
    }
  });

  it("case-insensitive e insensível a separador", () => {
    assert.equal(isSensitiveField("AUTHORIZATION"), true);
    assert.equal(isSensitiveField("X-Api-Key"), true);
    assert.equal(isSensitiveField("x_api_key"), true);
    assert.equal(isSensitiveField("Set-Cookie"), true);
    assert.equal(isSensitiveField("Proxy-Authorization"), true);
    assert.equal(isSensitiveField("BEARER"), true);
    // Falsos positivos que NÃO podem acontecer:
    assert.equal(isSensitiveField("token_count"), false);
    assert.equal(isSensitiveField("credential_ref"), false);
    assert.equal(isSensitiveField("keyword"), false);
  });

  it("2. redactUrl esconde ?token=… mas preserva o resto da URL", () => {
    const url =
      "https://api.se7en.com.br/v1/cobranca?valor=10.50&token=SEGREDO_VIVO&pagina=2&api_key=AK99&nome=Jo%C3%A3o#recibo";
    const out = redactUrl(url);

    assert.equal(
      out,
      `https://api.se7en.com.br/v1/cobranca?valor=10.50&token=${REDACTED}&pagina=2&api_key=${REDACTED}&nome=Jo%C3%A3o#recibo`,
    );
    assert.equal(out.includes("SEGREDO_VIVO"), false);
    assert.equal(out.includes("AK99"), false);
    // Preservado: host, caminho, params não sensíveis, encoding e fragmento.
    assert.equal(out.startsWith("https://api.se7en.com.br/v1/cobranca?"), true);
    assert.equal(out.includes("valor=10.50"), true);
    assert.equal(out.includes("pagina=2"), true);
    assert.equal(out.includes("nome=Jo%C3%A3o"), true);
    assert.equal(out.endsWith("#recibo"), true);
  });

  it("redactUrl não inventa barra nem toca URL sem query", () => {
    assert.equal(redactUrl("https://exemplo.com"), "https://exemplo.com");
    assert.equal(redactUrl("https://exemplo.com/a/b#x"), "https://exemplo.com/a/b#x");
    assert.equal(redactUrl("/local?q=1"), "/local?q=1");
    assert.equal(redactUrl("https://u:p@h/x"), `https://u:${REDACTED}@h/x`);
  });

  it("redactHeaders preserva o NOME do cabeçalho e destrói só o valor", () => {
    const out = redactHeaders({
      authorization: "Bearer abc",
      "set-cookie": ["a=1", "b=2"],
      accept: "application/json",
      "content-length": 42,
    });
    assert.deepEqual(out, {
      authorization: REDACTED,
      "set-cookie": [REDACTED, REDACTED],
      accept: "application/json",
      "content-length": 42,
    });
  });

  it("anti-regressão: ciclo, binário e Error não derrubam nem viram {}", () => {
    const cyclic: Record<string, unknown> = { nome: "raiz" };
    cyclic.eu = cyclic;
    const out = redactObject({
      cyclic,
      shot: Buffer.from([1, 2, 3, 4]),
      boom: new Error("falhou com token=abc"),
      // `as unknown as`: redactObject declara devolver T, mas Buffer vira string
      // e Error vira objeto — a mudança de forma é o comportamento documentado.
    }) as unknown as Record<string, Record<string, unknown>>;

    assert.equal(out.cyclic!.nome, "raiz");
    assert.equal(out.cyclic!.eu, "[CIRCULAR]");
    assert.equal(out.shot, "[BINARY:4 bytes]");
    assert.equal(out.boom!.name, "Error");
    assert.equal(typeof out.boom!.message, "string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("eventbus (FASE 9)", () => {
  it("3. entrega ao assinante certo e NÃO entrega ao filtro de outra sessão", async () => {
    const bus = new EventBus({ bufferSize: 50 });
    const s1: RuntimeEvent[] = [];
    const s2: RuntimeEvent[] = [];
    const todos: RuntimeEvent[] = [];
    const soClique: RuntimeEvent[] = [];

    bus.subscribe({ session_id: "sess_A" }, (e) => void s1.push(e));
    bus.subscribe({ session_id: "sess_B" }, (e) => void s2.push(e));
    bus.on("*", (e) => void todos.push(e));
    bus.subscribe({ session_id: "sess_A", events: ["mouse.clicked"] }, (e) => void soClique.push(e));

    bus.emit(evt({ session_id: "sess_A", event: "mouse.clicked" }));
    bus.emit(evt({ session_id: "sess_A", event: "page.loaded" }));
    bus.emit(evt({ session_id: "sess_B", event: "mouse.clicked" }));
    bus.emit(evt({ session_id: null, event: "runtime.started" }));

    await bus.drain();

    assert.equal(s1.length, 2, "assinante de sess_A recebe os 2 eventos dela");
    assert.deepEqual(s1.map((e) => e.session_id), ["sess_A", "sess_A"]);
    assert.equal(s2.length, 1, "assinante de sess_B NÃO recebe evento de sess_A");
    assert.deepEqual(s2.map((e) => e.session_id), ["sess_B"]);
    assert.equal(todos.length, 4, "curinga recebe tudo");
    assert.equal(soClique.length, 1, "filtro sessão+evento recebe só o clique de sess_A");
    assert.equal(soClique[0]!.event, "mouse.clicked");

    // Buffer circular alimenta cliente que reconecta, com o mesmo filtro.
    assert.equal(bus.history({ session_id: "sess_A" }).length, 2);
    assert.equal(bus.history().length, 4);
    bus.close();
  });

  it("4. evento com header Authorization sai do bus já redigido", async () => {
    const bus = new EventBus();
    const recebidos: RuntimeEvent[] = [];
    bus.subscribe({ session_id: "sess_X" }, (e) => void recebidos.push(e));

    const devolvido = bus.emit(
      evt({
        session_id: "sess_X",
        event: "network.request",
        payload: {
          url: "https://banco.example/pix?access_token=VIVO",
          headers: { Authorization: "Bearer sk_live_SEGREDO", Accept: "application/json" },
          body: { senha: "1234", valor: 99 },
        },
      }),
    );

    await bus.drain();

    assert.equal(recebidos.length, 1);
    const payload = recebidos[0]!.payload as {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    assert.equal(payload.headers.Authorization, REDACTED);
    assert.equal(payload.headers.Accept, "application/json", "cabeçalho inocente sobrevive");
    assert.equal(payload.body.senha, REDACTED);
    assert.equal(payload.body.valor, 99);
    assert.equal(payload.url, `https://banco.example/pix?access_token=${REDACTED}`);

    // Nada de segredo em NENHUM caminho de saída: assinante, retorno e buffer.
    for (const alvo of [recebidos[0], devolvido, bus.history()[0]]) {
      const serial = JSON.stringify(alvo);
      assert.equal(serial.includes("sk_live_SEGREDO"), false);
      assert.equal(serial.includes("VIVO"), false);
      assert.equal(serial.includes("1234"), false);
    }
    bus.close();
  });

  it("backpressure: handler lento não bloqueia o emit; drops são contados", async () => {
    const bus = new EventBus({ maxQueuePerSubscriber: 2 });
    let iniciou = 0;
    let abrir: () => void = () => {};
    const portao = new Promise<void>((r) => {
      abrir = r;
    });

    bus.subscribe({}, async () => {
      iniciou += 1;
      await portao;
    });

    for (let i = 0; i < 10; i += 1) bus.emit(evt({ event: "task.progress", payload: { i } }));

    // Ainda no MESMO tick: emit devolveu 10 vezes sem esperar handler nenhum.
    assert.equal(iniciou, 0, "emit não chamou handler de forma síncrona");
    assert.equal(bus.stats().emitted, 10);
    assert.equal(bus.stats().delivered, 0, "emit não bloqueou esperando entrega");
    assert.equal(bus.stats().dropped, 8, "fila de 2 descartou os 8 excedentes");

    abrir();
    await bus.drain();

    const st = bus.stats();
    assert.equal(st.delivered, 2);
    assert.equal(st.delivered + st.dropped, 10, "todo evento é entregue OU contado como drop");
    assert.equal(st.per_subscriber[0]!.dropped, 8);
    bus.close();
  });

  it("handler que estoura é contabilizado e não derruba os outros assinantes", async () => {
    const vistos: unknown[] = [];
    const bus = new EventBus({ onHandlerError: (e, ev) => vistos.push([e, ev.event]) });
    const bons: RuntimeEvent[] = [];

    bus.on("*", () => {
      throw new Error("handler ruim");
    });
    bus.on("*", (e) => void bons.push(e));

    bus.emit(evt({ event: "action.failed" }));
    await bus.drain();

    assert.equal(bus.stats().handler_errors, 1);
    assert.equal(vistos.length, 1, "erro de handler é relatado, não engolido");
    assert.equal(bons.length, 1, "assinante saudável continua recebendo");
    bus.close();
  });

  it("off cancela o par (seletor, handler)", async () => {
    const bus = new EventBus();
    const got: RuntimeEvent[] = [];
    const h = (e: RuntimeEvent): void => void got.push(e);
    bus.on("mouse.clicked", h);
    bus.emit(evt({ event: "mouse.clicked" }));
    await bus.drain();
    assert.equal(got.length, 1);

    assert.equal(bus.off("mouse.clicked", h), true);
    bus.emit(evt({ event: "mouse.clicked" }));
    await bus.drain();
    assert.equal(got.length, 1, "após off não chega mais nada");
    assert.equal(bus.off("mouse.clicked", h), false, "off idempotente reporta false");
    bus.close();
  });

  it("buffer circular retém apenas os últimos N", async () => {
    const bus = new EventBus({ bufferSize: 3 });
    for (let i = 0; i < 7; i += 1) bus.emit(evt({ event: "task.progress", payload: { i } }));
    const hist = bus.history();
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.map((e) => (e.payload as { i: number }).i), [4, 5, 6]);
    assert.equal(bus.stats().buffered, 3);
    bus.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("audit (FASE 24)", () => {
  it("5. escreve JSONL e lê de volta; linha corrompida no meio não impede ler as boas", async () => {
    const log = new AuditLog({ root: ROOT, fsync: true });
    const sid = "sess_audit_1";

    await log.append(auditEntry({ session: sid, action: "browser.open", action_id: "act_a" }));
    await log.append(auditEntry({ session: sid, action: "browser.click", action_id: "act_b" }));

    // Corrupção REAL no meio do arquivo: JSON truncado, como num crash de processo.
    await appendFile(log.file(sid), '{"timestamp":"2026-08-24T10:00:02.000Z","act\n', "utf8");

    await log.append(
      auditEntry({
        session: sid,
        action: "browser.type",
        action_id: "act_c",
        detail: { credential_ref: "vault://x", password: "NAO_PODE_VAZAR", campo: "#user" },
      }),
    );

    const lido = await log.read(sid);

    assert.equal(lido.exists, true);
    assert.equal(lido.entries.length, 3, "as 3 linhas boas foram lidas apesar da corrompida");
    assert.deepEqual(lido.entries.map((e) => e.action_id), ["act_a", "act_b", "act_c"]);
    assert.equal(lido.errors.length, 1, "a linha inválida foi REPORTADA, não escondida");
    assert.equal(lido.errors[0]!.line, 3, "reporta o número da linha corrompida");
    assert.equal(typeof lido.errors[0]!.error, "string");

    // Redação também na trilha em disco.
    assert.equal(lido.entries[2]!.detail!.password, REDACTED);
    assert.equal(lido.entries[2]!.detail!.credential_ref, "vault://x");
    const bruto = await readFile(log.file(sid), "utf8");
    assert.equal(bruto.includes("NAO_PODE_VAZAR"), false, "segredo não tocou o disco");

    // Append-only: uma linha física por entrada + a linha corrompida.
    assert.equal(bruto.split("\n").filter((l) => l.trim().length > 0).length, 4);
  });

  /**
   * O que este teste mede — e o que NÃO mede.
   *
   * Não-atomicidade de bytes foi descartada como hipótese: um probe com 12
   * escritas concorrentes de 4 MB via O_APPEND no APFS não produziu UMA linha
   * híbrida. Ou seja, "nenhuma linha corrompida" seria verdade mesmo sem a
   * cadeia de serialização — asserção decorativa.
   *
   * O que a cadeia realmente garante é a ORDEM. Sem ela, 60 appends concorrentes
   * chegam ao disco embaralhados (medido: 0,3,1,4,7,2,8,5,6,9,14,10…), porque o
   * mkdir/open de cada um compete no threadpool do libuv. Numa trilha de
   * auditoria, ordem trocada é evidência falsificada. É isso que se afirma aqui.
   */
  it("caminho é sessions/<id>/actions.jsonl e appends concorrentes gravam NA ORDEM DE CHAMADA", async () => {
    const log = new AuditLog({ root: ROOT });
    const sid = "sess_audit_2";
    assert.equal(log.file(sid), path.join(ROOT, sid, "actions.jsonl"));

    const N = 60;
    await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        log.append(auditEntry({ session: sid, action_id: `act_${i}`, target: "x".repeat(5000) })),
      ),
    );

    const lido = await log.read(sid);
    assert.equal(lido.errors.length, 0);
    assert.equal(lido.entries.length, N, "nenhuma entrada perdida ou sobrescrita");
    assert.deepEqual(
      lido.entries.map((e) => e.action_id),
      Array.from({ length: N }, (_v, i) => `act_${i}`),
      "ordem no disco == ordem de chamada",
    );
  });

  it("sessão inexistente responde exists:false em vez de estourar", async () => {
    const log = new AuditLog({ root: ROOT });
    const lido = await log.read("sess_que_nunca_existiu");
    assert.equal(lido.exists, false);
    assert.deepEqual(lido.entries, []);
    assert.deepEqual(lido.errors, []);
  });

  it("fail closed: session_id com travessia de caminho é RECUSADO", () => {
    for (const mau of ["../../etc", "a/b", "..", "", "sess id", "/abs"]) {
      assert.throws(() => assertSafeSessionId(mau), /session_id inválido/, `deveria recusar ${JSON.stringify(mau)}`);
    }
    assert.equal(assertSafeSessionId("sess_ok-1.2"), "sess_ok-1.2");
  });

  it("raiz padrão é <repo>/sessions e o arquivo nasce lá", async (t) => {
    if (process.env.NOMOS_SESSIONS_ROOT !== undefined) {
      t.skip("NOMOS_SESSIONS_ROOT sobrescreve a raiz padrão neste ambiente");
      return;
    }
    assert.equal(SESSIONS_ROOT, path.join(REPO, "sessions"));

    const sid = `sess_selftest_${process.pid}`;
    const log = new AuditLog();
    try {
      await log.append(auditEntry({ session: sid }));
      const esperado = path.join(REPO, "sessions", sid, "actions.jsonl");
      assert.equal(log.file(sid), esperado);
      assert.equal((await stat(esperado)).isFile(), true);
    } finally {
      await rm(path.join(REPO, "sessions", sid), { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay (FASE 25)", () => {
  it("6. recorder + loadReplay reconstroem a linha do tempo na ordem de timestamp", async () => {
    const sid = "sess_replay_1";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.init();

    const T1 = "2026-08-24T10:00:01.000Z";
    const T2 = "2026-08-24T10:00:02.000Z";
    const T3 = "2026-08-24T10:00:03.000Z";
    const T4 = "2026-08-24T10:00:04.000Z";

    // Gravado FORA de ordem de propósito: se a fusão não ordenar, o teste quebra.
    await rec.recordAction(auditEntry({ session: sid, timestamp: T3, action: "browser.click", action_id: "act_3" }));
    await rec.recordEvent(evt({ timestamp: T1, session_id: sid, event: "page.loaded", payload: { url: "https://x/y" } }));
    await rec.recordAction(
      auditEntry({
        session: sid,
        timestamp: T4,
        action: "browser.type",
        action_id: "act_4",
        detail: { credential_ref: "vault://pix", password: "NAO_VAZA_AQUI" },
      }),
    );
    await rec.recordNetwork({
      timestamp: T2,
      url: "https://api.x/v1/pay?token=SEGREDO_REDE",
      method: "post",
      status: 200,
      request_headers: { Authorization: "Bearer zzz", Accept: "*/*" },
    });

    const ref = await rec.saveScreenshot(PNG_1X1);
    const resultado = await rec.finish({ ok: true, mensagem: "cobrança criada" });

    // ── linha do tempo ──
    const linha = await replaySummary(sid, { root: ROOT });
    assert.equal(linha.length, 4);
    assert.deepEqual(linha.map((i) => i.timestamp), [T1, T2, T3, T4]);
    assert.deepEqual(linha.map((i) => i.source), ["event", "network", "action", "action"]);
    assert.equal(linha[0]!.label, "page.loaded");
    assert.equal(linha[1]!.label.startsWith("POST 200 https://api.x/v1/pay"), true);
    assert.equal(linha[2]!.label, "browser.click → ok");
    assert.equal(linha[3]!.label, "browser.type → ok");

    // ── bundle completo ──
    const bundle = await loadReplay(sid, { root: ROOT });
    assert.equal(bundle.actions.length, 2);
    assert.equal(bundle.events.length, 1);
    assert.equal(bundle.network.length, 1);
    assert.equal(bundle.errors.length, 0);
    assert.equal(bundle.result_error, null);
    assert.deepEqual(bundle.missing, []);

    // screenshot: ref devolvida, arquivo no disco, dimensões vindas do PNG real
    assert.equal(bundle.screenshots.length, 1);
    assert.equal(bundle.screenshots[0]!.ref, ref);
    assert.equal(bundle.screenshots[0]!.width, 1);
    assert.equal(bundle.screenshots[0]!.height, 1);
    assert.equal(bundle.screenshots[0]!.bytes, PNG_1X1.length);
    assert.equal(bundle.screenshots[0]!.orphan, undefined);
    const shotFile = path.join(ROOT, sid, "screenshots", bundle.screenshots[0]!.file);
    assert.equal((await stat(shotFile)).size, PNG_1X1.length);
    // screenshotPath resolve tanto pelo record quanto pela referência crua.
    assert.equal(screenshotPath(sid, bundle.screenshots[0]!, { root: ROOT }), shotFile);
    assert.equal(screenshotPath(sid, ref, { root: ROOT }), shotFile);

    // result.json
    assert.notEqual(bundle.result, null);
    assert.equal(bundle.result!.session_id, sid);
    assert.deepEqual(bundle.result!.recorded, { actions: 2, events: 1, network: 1, screenshots: 1 });
    assert.deepEqual(bundle.result!.result, { ok: true, mensagem: "cobrança criada" });
    assert.equal(resultado.finished_at, bundle.result!.finished_at);

    // ── redação sobreviveu à ida e volta do disco ──
    const typed = bundle.actions.find((a) => a.action_id === "act_4")!;
    assert.equal(typed.detail!.password, REDACTED);
    assert.equal(typed.detail!.credential_ref, "vault://pix");
    assert.equal(bundle.network[0]!.url, `https://api.x/v1/pay?token=${REDACTED}`);
    assert.equal(bundle.network[0]!.request_headers!.Authorization, REDACTED);
    assert.equal(bundle.network[0]!.request_headers!.Accept, "*/*");

    for (const arquivo of ["actions.jsonl", "events.jsonl", "network.jsonl"]) {
      const bruto = await readFile(path.join(ROOT, sid, arquivo), "utf8");
      assert.equal(bruto.includes("NAO_VAZA_AQUI"), false);
      assert.equal(bruto.includes("SEGREDO_REDE"), false);
      assert.equal(bruto.includes("Bearer zzz"), false);
    }
  });

  it("linha corrompida em events.jsonl aparece em errors sem perder as boas", async () => {
    const sid = "sess_replay_2";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.recordEvent(evt({ timestamp: "2026-08-24T11:00:00.000Z", session_id: sid, event: "browser.started" }));
    await appendFile(path.join(ROOT, sid, "events.jsonl"), "{lixo binário\n", "utf8");
    await rec.recordEvent(evt({ timestamp: "2026-08-24T11:00:01.000Z", session_id: sid, event: "browser.closed" }));

    const bundle = await loadReplay(sid, { root: ROOT });
    assert.equal(bundle.events.length, 2);
    assert.equal(bundle.errors.length, 1);
    assert.equal(bundle.errors[0]!.source, "event");
    assert.equal(bundle.errors[0]!.error.line, 2);

    const linha = await replaySummary(sid, { root: ROOT });
    assert.deepEqual(linha.map((i) => i.label), ["browser.started", "browser.closed"]);
  });

  it("sessão sem nada gravada devolve bundle vazio com missing explícito", async () => {
    const bundle = await loadReplay("sess_vazia_99", { root: ROOT });
    assert.deepEqual(bundle.actions, []);
    assert.deepEqual(bundle.events, []);
    assert.deepEqual(bundle.network, []);
    assert.deepEqual(bundle.screenshots, []);
    assert.equal(bundle.result, null);
    assert.equal(bundle.missing.length, 5, "as 5 fontes ausentes são declaradas");
    assert.deepEqual(await replaySummary("sess_vazia_99", { root: ROOT }), []);
  });

  it("recordFrom liga o recorder ao EventBus e finish desliga", async () => {
    const sid = "sess_replay_3";
    const bus = new EventBus();
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.init();
    rec.recordFrom(bus, { session_id: sid });

    bus.emit(evt({ timestamp: "2026-08-24T12:00:00.000Z", session_id: sid, event: "mouse.clicked" }));
    bus.emit(evt({ timestamp: "2026-08-24T12:00:01.000Z", session_id: "outra", event: "mouse.clicked" }));
    await bus.drain();
    await rec.flush();

    let bundle = await loadReplay(sid, { root: ROOT });
    assert.equal(bundle.events.length, 1, "só o evento da sessão do recorder foi gravado");

    await rec.finish({ ok: true });
    bus.emit(evt({ timestamp: "2026-08-24T12:00:02.000Z", session_id: sid, event: "mouse.clicked" }));
    await bus.drain();
    await rec.flush();

    bundle = await loadReplay(sid, { root: ROOT });
    assert.equal(bundle.events.length, 1, "após finish o recorder não grava mais");
    bus.close();
  });

  it("saveScreenshot registra o erro quando o buffer não é PNG, em vez de fingir", async () => {
    const sid = "sess_replay_4";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.saveScreenshot(Buffer.from("isto nao e um png"));
    await rec.flush();

    const bundle = await loadReplay(sid, { root: ROOT });
    assert.equal(bundle.screenshots.length, 1);
    assert.equal(bundle.screenshots[0]!.width, null);
    assert.equal(typeof bundle.screenshots[0]!.decode_error, "string");
    assert.equal(bundle.screenshots[0]!.file.endsWith(".bin"), true);

    // O record leva o nome REAL do arquivo; a referência crua assumiria .png.
    const viaRecord = screenshotPath(sid, bundle.screenshots[0]!, { root: ROOT });
    assert.equal(viaRecord.endsWith(".bin"), true);
    assert.equal((await stat(viaRecord)).isFile(), true);

    await assert.rejects(() => rec.saveScreenshot(Buffer.alloc(0)), /buffer vazio/);
  });
});
