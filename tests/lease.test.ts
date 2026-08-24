/**
 * FASE 9 — testes de arbitragem de controle (lease / ownership).
 *
 * Critério de honestidade herdado do spike (ver docs/EVIDENCIA.md): nenhuma
 * afirmação vale por ausência de exceção, e nenhuma prova de ausência vale sem
 * DISCRIMINADOR — um controle negativo que mostra que o instrumento sabe
 * detectar o defeito que ele afirma não existir.
 *
 * Aqui isso aparece em dois pares:
 *
 *   | Implementação                        | 64 acquires concorrentes | Harness |
 *   |--------------------------------------|--------------------------|---------|
 *   | LeaseManager (sem await no meio)     | 1 vencedor               | mesmo   |
 *   | NaiveLease (await entre check e set) | vários vencedores        | mesmo   |
 *
 *   | Implementação                        | transfer com intruso concorrente |
 *   |--------------------------------------|----------------------------------|
 *   | LeaseManager.transfer (um turno)     | intruso negado, dono vira B      |
 *   | NaiveLease.transfer (release+await)  | INTRUSO fica com a sessão        |
 *
 * Sem a linha de baixo de cada tabela, "não houve corrida" seria indistinguível
 * de "o teste não sabe ver corrida".
 *
 * Tempo: relógio INJETADO. Nenhum `sleep` decide resultado neste arquivo. O
 * único `setImmediate` está DENTRO do controle negativo, e ali ele não é espera
 * temporal: é a fronteira microtask→macrotask, cuja ordem é garantida pelo
 * event loop, e serve para reproduzir a janela de I/O que todo check-then-act
 * real tem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACTION_CLASS, type RuntimeEvent } from "../packages/core/src/contract.ts";
import {
  CONTROL_NOT_OWNED,
  CONTROL_NOT_OWNED_CODE,
  DEFAULT_TTL_MS,
  LeaseClockError,
  LeaseError,
  LeaseManager,
  isLease,
  leaseActionError,
  modeSatisfies,
  requiredMode,
  requiredModeForTool,
  type Lease,
  type LeaseResult,
} from "../packages/core/src/lease.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de teste
// ─────────────────────────────────────────────────────────────────────────────

const SID = "ses_teste_fase9";

/** Relógio manual: o tempo só anda quando o teste manda. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
    get value() {
      return t;
    },
  };
}

function mk(opts: Record<string, unknown> = {}) {
  const clock = fakeClock();
  const events: RuntimeEvent[] = [];
  const lm = new LeaseManager({
    now: clock.now,
    onEvent: (e) => {
      events.push(e);
    },
    ...opts,
  });
  return { lm, clock, events };
}

/** Estreita `LeaseResult` para `Lease` e falha com a mensagem real se negou. */
function grant(r: LeaseResult): Lease {
  if (!isLease(r)) assert.fail(`esperava concessão, veio negação: ${r.reason}/${r.cause} — ${r.message}`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLE NEGATIVO — a implementação ingênua que a FASE 9 existe para não ser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check-then-act com uma janela de I/O entre ler e escrever. É o bug que todo
 * gerente de lease escrito às pressas tem. Serve como discriminador: qualquer
 * harness que não pegue ISTO também não provaria nada sobre o LeaseManager.
 */
class NaiveLease {
  #holder: string | null = null;

  async acquire(_session_id: string, holder: string): Promise<{ granted: boolean; holder?: string }> {
    const free = this.#holder === null; // CHECK
    await new Promise((r) => setImmediate(r)); // janela (I/O, disco, rede…)
    if (!free) return { granted: false };
    this.#holder = holder; // ACT
    return { granted: true, holder };
  }

  async transfer(_session_id: string, from: string, to: string): Promise<{ granted: boolean }> {
    if (this.#holder !== from) return { granted: false };
    this.#holder = null; // solta…
    await new Promise((r) => setImmediate(r)); // …e aqui a sessão fica ÓRFÃ
    if (this.#holder !== null) return { granted: false };
    this.#holder = to;
    return { granted: true };
  }

  holderOf(_session_id: string): string | null {
    return this.#holder;
  }
}

/** Mesmo harness para os dois: 64 tentativas em microtasks distintas. */
async function raceAcquire(
  impl: { acquire: (s: string, h: string, o?: { ttl_ms?: number }) => unknown },
  n: number,
): Promise<{ winners: string[]; total: number }> {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      Promise.resolve().then(() => impl.acquire(SID, `agente-${String(i).padStart(2, "0")}`, { ttl_ms: 30_000 })),
    ),
  );
  const winners: string[] = [];
  for (const r of results) {
    const rec = r as { granted?: boolean; holder?: string };
    if (rec.granted === true && typeof rec.holder === "string") winners.push(rec.holder);
  }
  return { winners, total: results.length };
}

/** Mesmo harness para os dois: transfer com um intruso agendado em concorrência. */
async function raceTransfer(impl: {
  acquire: (s: string, h: string, o?: { ttl_ms?: number }) => unknown;
  transfer: (s: string, f: string, t: string) => unknown;
  holderOf: (s: string) => string | null;
}): Promise<{ transferred: boolean; intruderIn: boolean; finalHolder: string | null }> {
  const t = impl.transfer(SID, "A", "B");
  const intruder = Promise.resolve().then(() => impl.acquire(SID, "INTRUSO", { ttl_ms: 30_000 }));
  const [tr, ir] = await Promise.all([t, intruder]);
  return {
    transferred: (tr as { granted?: boolean }).granted === true,
    intruderIn: (ir as { granted?: boolean }).granted === true,
    finalHolder: impl.holderOf(SID),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("FASE 9 — LeaseManager: aquisição e reentrância", () => {
  it("concede lease exclusivo e autoriza o dono a agir", () => {
    const { lm, clock } = mk();
    const lease = grant(lm.acquire(SID, "NOMOS", { ttl_ms: 10_000 }));

    assert.equal(lease.granted, true);
    assert.equal(lease.holder, "NOMOS");
    assert.equal(lease.mode, "exclusive");
    assert.equal(lease.session_id, SID);
    assert.equal(lease.ttl_ms, 10_000);
    assert.equal(lease.reentrant, false);
    assert.equal(lease.renewals, 0);
    assert.equal(lease.fencing_token, 1);
    assert.equal(lease.expires_at_ms, clock.value + 10_000);
    assert.match(lease.lease_id, /^lease_[0-9a-f]{16}$/);

    const c = lm.check(SID, "NOMOS", { class: "ACT" });
    assert.equal(c.allowed, true);
    assert.equal(c.reason, "GRANTED");
    assert.equal(c.current_holder, "NOMOS");
    assert.equal(c.lease_id, lease.lease_id);
    assert.equal(lm.currentHolder(SID), "NOMOS");
  });

  it("modo default é exclusive e ttl default é o do manager", () => {
    const { lm, clock } = mk();
    const lease = grant(lm.acquire(SID, "NOMOS"));
    assert.equal(lease.mode, "exclusive");
    assert.equal(lease.ttl_ms, DEFAULT_TTL_MS);
    assert.equal(lease.expires_at_ms, clock.value + DEFAULT_TTL_MS);
  });

  it("reentrância: o mesmo holder re-adquire sem se auto-bloquear e mantém o lease_id", () => {
    const { lm, clock } = mk();
    const first = grant(lm.acquire(SID, "NOMOS", { ttl_ms: 10_000 }));

    clock.advance(3_000);
    const again = grant(lm.acquire(SID, "NOMOS", { ttl_ms: 10_000 }));

    assert.equal(again.granted, true);
    assert.equal(again.reentrant, true);
    // MESMO lease_id: re-adquirir não pode invalidar o lease em voo do próprio dono.
    assert.equal(again.lease_id, first.lease_id);
    assert.equal(again.fencing_token, first.fencing_token);
    assert.equal(again.renewals, 1);
    assert.equal(again.expires_at_ms, first.expires_at_ms + 3_000);

    // O lease_id original continua válido — não virou obsoleto por reentrância.
    assert.equal(lm.check(SID, "NOMOS", { lease_id: first.lease_id }).allowed, true);
    assert.equal(lm.stats().granted, 1);
    assert.equal(lm.stats().reentrant, 1);
  });

  it("renew estende a partir de agora; renew por outro holder ou lease_id errado é negado", () => {
    const { lm, clock } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    clock.advance(4_000);
    const renewed = grant(lm.renew(SID, "A", a.lease_id));
    assert.equal(renewed.expires_at_ms, clock.value + 10_000);
    assert.equal(renewed.renewals, 1);

    const byOther = lm.renew(SID, "B", a.lease_id);
    assert.equal(byOther.granted, false);
    if (byOther.granted === false) assert.equal(byOther.reason, CONTROL_NOT_OWNED);

    const wrongId = lm.renew(SID, "A", "lease_0000000000000000");
    assert.equal(wrongId.granted, false);
    if (wrongId.granted === false) assert.equal(wrongId.cause, "stale_lease_id");

    // Nenhuma das negações mexeu no lease real.
    assert.equal(lm.currentHolder(SID), "A");
    assert.equal(grant(lm.renew(SID, "A", a.lease_id)).lease_id, a.lease_id);
  });
});

describe("FASE 9 — ausência de corrida (com discriminador)", () => {
  it("as operações de arbitragem são SÍNCRONAS — não há await entre verificar e tomar", () => {
    const { lm } = mk();
    for (const name of ["acquire", "release", "renew", "check", "transfer"] as const) {
      const fn = lm[name] as unknown as (...a: unknown[]) => unknown;
      assert.equal(
        fn.constructor.name,
        "Function",
        `${name} não pode ser AsyncFunction: um await no corpo abre a janela de check-then-act`,
      );
    }
    const r = lm.acquire(SID, "NOMOS", { ttl_ms: 5_000 });
    assert.equal(r instanceof Promise, false, "acquire devolve o lease no mesmo turno, não uma promessa");
  });

  it("64 acquires concorrentes => EXATAMENTE UM vence, e os 63 recebem CONTROL_NOT_OWNED", async () => {
    const { lm } = mk();
    const { winners, total } = await raceAcquire(lm, 64);

    assert.equal(total, 64);
    assert.equal(winners.length, 1, `esperava 1 vencedor, vieram ${winners.length}: ${winners.join(", ")}`);
    assert.equal(lm.currentHolder(SID), winners[0]);
    assert.equal(lm.holders(SID).length, 1);

    const s = lm.stats();
    assert.equal(s.granted, 1);
    assert.equal(s.denied, 63);
    assert.equal(s.live_leases, 1);

    // As negações apontam o vencedor por nome — não é "erro genérico".
    const denial = lm.check(SID, "agente-63", { class: "ACT" });
    assert.equal(denial.allowed, false);
    assert.equal(denial.reason, CONTROL_NOT_OWNED);
    assert.equal(denial.cause, "held_by_other");
    assert.equal(denial.current_holder, winners[0]);
  });

  it("DISCRIMINADOR: o mesmo harness pega a corrida numa implementação com await no meio", async () => {
    const naive = new NaiveLease();
    assert.equal(
      (naive.acquire as unknown as { constructor: { name: string } }).constructor.name,
      "AsyncFunction",
      "o controle negativo precisa mesmo ter a janela que estamos afirmando não existir",
    );

    const { winners } = await raceAcquire(naive, 64);
    assert.ok(
      winners.length > 1,
      `o harness precisa ser capaz de VER a corrida; vencedores no ingênuo: ${winners.length}`,
    );
  });
});

describe("FASE 9 — TTL: o lease não fica preso se o dono somem", () => {
  it("A perde por TTL, B adquire, e A com lease velho é negada por lease obsoleto", () => {
    const { lm, clock } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 5_000 }));
    assert.equal(lm.check(SID, "A").allowed, true);

    // Tempo anda sem sleep: o relógio é injetado.
    clock.advance(5_001);

    const b = grant(lm.acquire(SID, "B", { ttl_ms: 5_000 }));
    assert.equal(b.holder, "B");
    assert.equal(b.fencing_token, 2, "nova concessão tem fencing token maior");
    assert.equal(lm.currentHolder(SID), "B");

    // A volta do além com o lease velho: negado, e o motivo é preciso.
    const stale = lm.check(SID, "A", { lease_id: a.lease_id, class: "ACT" });
    assert.equal(stale.allowed, false);
    assert.equal(stale.reason, CONTROL_NOT_OWNED);
    assert.equal(stale.cause, "expired");
    assert.equal(stale.current_holder, "B");

    // E não consegue renovar nem liberar com ele.
    assert.equal(lm.renew(SID, "A", a.lease_id).granted, false);
    assert.equal(lm.release(SID, "A", a.lease_id).released, false);
    assert.equal(lm.currentHolder(SID), "B", "a tentativa de A não pode derrubar o lease de B");
    assert.equal(lm.stats().expired, 1);
  });

  it("expiração é exatamente no prazo, não antes", () => {
    const { lm, clock } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 1_000 }));

    clock.advance(999);
    assert.equal(lm.check(SID, "A").allowed, true, "999ms < 1000ms: ainda vale");

    clock.advance(1);
    assert.equal(lm.check(SID, "A").allowed, false, "no instante do prazo o lease já não vale");
    assert.equal(lm.holders(SID).length, 0);
  });

  it("sweep() reaproveita o mesmo caminho e é chamável à mão", () => {
    const { lm, clock } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 1_000 }));
    const b = grant(lm.acquire("outra_sessao", "B", { ttl_ms: 9_000 }));

    clock.advance(2_000);
    const dead = lm.sweep();
    assert.deepEqual(dead, [a.lease_id]);
    assert.equal(lm.holders(SID).length, 0);
    assert.equal(lm.currentHolder("outra_sessao"), b.holder);
  });

  it("relógio quebrado aborta a arbitragem em vez de arbitrar errado", () => {
    const lm = new LeaseManager({ now: () => Number.NaN });
    assert.throws(() => lm.acquire(SID, "A"), LeaseClockError);
    const lm2 = new LeaseManager({ now: () => Number.POSITIVE_INFINITY });
    assert.throws(() => lm2.check(SID, "A"), LeaseClockError);
  });
});

describe("FASE 9 — release", () => {
  it("release por quem NÃO é dono é negado e não solta o lease do dono real", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    // B tenta soltar apresentando até o lease_id correto de A.
    const attempt = lm.release(SID, "B", a.lease_id);
    assert.equal(attempt.released, false);
    assert.equal(attempt.reason, CONTROL_NOT_OWNED);
    assert.equal(attempt.code, CONTROL_NOT_OWNED_CODE);
    assert.equal(attempt.current_holder, "A");

    assert.equal(lm.currentHolder(SID), "A", "o lease do dono real continua de pé");
    assert.equal(lm.check(SID, "A", { lease_id: a.lease_id }).allowed, true);
    assert.equal(lm.stats().released, 0);
  });

  it("release com lease_id obsoleto do próprio holder é negado", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    const bad = lm.release(SID, "A", "lease_ffffffffffffffff");
    assert.equal(bad.released, false);
    assert.equal(bad.cause, "stale_lease_id");
    assert.equal(lm.currentHolder(SID), "A");

    const good = lm.release(SID, "A", a.lease_id);
    assert.equal(good.released, true);
    assert.equal(good.reason, "RELEASED");
    assert.equal(good.current_holder, null);

    // Depois de solto, o lease_id fica APOSENTADO: não vira "nunca teve".
    const after = lm.check(SID, "A", { lease_id: a.lease_id });
    assert.equal(after.allowed, false);
    assert.equal(after.cause, "stale_lease_id");
  });

  it("release exige lease_id — soltar por nome seria derrubar o lease novo com o velho", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));
    const r = lm.release(SID, "A", "" as unknown as string);
    assert.equal(r.released, false);
    assert.equal(r.reason, "INVALID_REQUEST");
    assert.equal(lm.currentHolder(SID), "A");
  });

  it("releaseAll revoga tudo da sessão e forget só passa com a sessão vazia", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    grant(lm.acquire(SID, "B", { ttl_ms: 10_000, mode: "shared" }));
    assert.equal(lm.holders(SID).length, 2);

    assert.throws(() => lm.forget(SID), LeaseError);

    const revoked = lm.releaseAll(SID, "session_closed");
    assert.equal(revoked.length, 2);
    assert.equal(lm.holders(SID).length, 0);
    assert.equal(lm.forget(SID), true);
    assert.equal(lm.sessions().includes(SID), false);
  });
});

describe("FASE 9 — transfer atômico", () => {
  it("transfer troca o dono num único turno: nenhum instante observado com dois donos", () => {
    const { lm, events } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    // Amostragem NO INSTANTE do evento: o hook roda dentro da própria operação,
    // então cada amostra é o estado visível a um observador durante a troca.
    const samples: string[][] = [];
    lm.onEvent = (e) => {
      events.push(e);
      samples.push(lm.holders(SID));
    };

    const b = grant(lm.transfer(SID, "A", "B"));

    assert.equal(b.holder, "B");
    assert.equal(b.fencing_token, a.fencing_token + 1);
    assert.notEqual(b.lease_id, a.lease_id);

    assert.equal(samples.length, 1, "transfer emite UM evento — release+acquire seriam dois, com um vão no meio");
    assert.deepEqual(samples[0], ["B"], "no instante da emissão já existe exatamente um dono, e é o novo");

    // O lease de A morre no mesmo turno em que o de B nasce.
    const oldA = lm.check(SID, "A", { lease_id: a.lease_id });
    assert.equal(oldA.allowed, false);
    assert.equal(oldA.cause, "stale_lease_id");
    assert.equal(lm.check(SID, "B", { lease_id: b.lease_id, class: "ACT" }).allowed, true);

    const handoff = events.filter((e) => e.event === "session.handoff");
    assert.equal(handoff.length, 1);
    assert.equal(handoff[0]!.payload.from_holder, "A");
    assert.equal(handoff[0]!.payload.to_holder, "B");
    assert.equal(handoff[0]!.payload.revoked_lease_id, a.lease_id);
    assert.equal(lm.stats().transferred, 1);

    // Invariante sobre TODOS os instantes amostrados no teste, não só o do transfer.
    assert.ok(samples.length >= 2, "houve mais de um instante amostrado");
    for (const s of samples) assert.ok(s.length <= 1, `dois donos simultâneos observados: ${s.join(", ")}`);
  });

  it("intruso concorrente NÃO entra durante o transfer", async () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 30_000 }));

    const r = await raceTransfer({
      acquire: (s, h, o) => lm.acquire(s, h, o),
      transfer: (s, f, t) => lm.transfer(s, f, t),
      holderOf: (s) => lm.currentHolder(s),
    });

    assert.equal(r.transferred, true);
    assert.equal(r.intruderIn, false, "não existe vão entre revogar e conceder");
    assert.equal(r.finalHolder, "B");
  });

  it("DISCRIMINADOR: transfer ingênuo (release + await + acquire) entrega a sessão ao intruso", async () => {
    const naive = new NaiveLease();
    await naive.acquire(SID, "A");

    const r = await raceTransfer(naive);

    // O ingênuo REPORTA sucesso e ainda assim perde a sessão — é exatamente o
    // modo de falha que o transfer atômico existe para impedir.
    assert.equal(r.transferred, true);
    assert.equal(r.intruderIn, true);
    assert.equal(r.finalHolder, "INTRUSO", "o harness enxerga o vão quando ele existe");
  });

  it("transfer por quem não detém, com lease_id obsoleto, ou para si mesmo é negado", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    const byOther = lm.transfer(SID, "C", "B");
    assert.equal(byOther.granted, false);
    if (byOther.granted === false) assert.equal(byOther.reason, CONTROL_NOT_OWNED);

    const stale = lm.transfer(SID, "A", "B", { lease_id: "lease_1111111111111111" });
    assert.equal(stale.granted, false);
    if (stale.granted === false) assert.equal(stale.cause, "stale_lease_id");

    const self = lm.transfer(SID, "A", "A");
    assert.equal(self.granted, false);
    if (self.granted === false) assert.equal(self.reason, "INVALID_REQUEST");

    assert.equal(lm.currentHolder(SID), "A");
    assert.equal(grant(lm.renew(SID, "A", a.lease_id)).lease_id, a.lease_id);
  });

  it("transfer com outros holders shared na sessão é negado (não seria atômico)", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    grant(lm.acquire(SID, "OBS", { ttl_ms: 10_000, mode: "shared" }));

    const t = lm.transfer(SID, "A", "B");
    assert.equal(t.granted, false);
    if (t.granted === false) assert.equal(t.cause, "shared_conflict");
    assert.deepEqual(lm.holders(SID).sort(), ["A", "OBS"]);
  });
});

describe("FASE 9 — sequência da missão", () => {
  it("A tem lease → B clica e leva CONTROL_NOT_OWNED → A libera → B adquire → B age", () => {
    const { lm, events } = mk();

    // 1. A tem o lease.
    const a = grant(lm.acquire(SID, "AGENTE-A", { ttl_ms: 30_000 }));
    assert.equal(lm.check(SID, "AGENTE-A", { tool: "browser.click" }).allowed, true);

    // 2. B tenta clicar.
    const bClick = lm.check(SID, "AGENTE-B", { tool: "browser.click" });
    assert.equal(bClick.allowed, false);
    assert.equal(bClick.reason, CONTROL_NOT_OWNED);
    assert.equal(bClick.current_holder, "AGENTE-A");
    assert.equal(bClick.required_mode, "exclusive");

    // ...e na fronteira da API isso vira um código legal do contrato v1.
    const apiError = leaseActionError(bClick);
    assert.equal(apiError.code, "CAPABILITY_DENIED");
    assert.equal(apiError.detail?.lease_reason, CONTROL_NOT_OWNED);
    assert.equal(apiError.detail?.current_holder, "AGENTE-A");

    // 3. A libera.
    assert.equal(lm.release(SID, "AGENTE-A", a.lease_id).released, true);
    assert.equal(lm.currentHolder(SID), null);

    // 4. B adquire.
    const b = grant(lm.acquire(SID, "AGENTE-B", { ttl_ms: 30_000 }));
    assert.equal(b.fencing_token, a.fencing_token + 1);

    // 5. B age.
    const bNow = lm.check(SID, "AGENTE-B", { tool: "browser.click", lease_id: b.lease_id });
    assert.equal(bNow.allowed, true);
    assert.equal(bNow.current_holder, "AGENTE-B");

    // ...e agora é A quem não pode mais agir.
    const aNow = lm.check(SID, "AGENTE-A", { tool: "browser.click", lease_id: a.lease_id });
    assert.equal(aNow.allowed, false);
    assert.equal(aNow.cause, "stale_lease_id");

    const names = events.map((e) => e.event);
    assert.deepEqual(names, [
      "control.taken", // A adquire
      "action.failed", // B negado
      "control.returned", // A libera
      "control.taken", // B adquire
      "action.failed", // A negado com lease velho
    ]);
  });
});

describe("FASE 9 — modos exclusive / shared", () => {
  it("shared coexiste para OBSERVE; agir exige exclusive", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    const b = grant(lm.acquire(SID, "B", { ttl_ms: 10_000, mode: "shared" }));

    assert.equal(a.mode, "shared");
    assert.equal(b.mode, "shared");
    assert.deepEqual(lm.holders(SID).sort(), ["A", "B"]);
    assert.equal(lm.currentHolder(SID), null, "regime shared não tem dono exclusivo");

    for (const tool of ["browser.observe", "browser.screenshot", "browser.extract"]) {
      assert.equal(lm.check(SID, "A", { tool }).allowed, true, `${tool} é OBSERVE e cabe em shared`);
    }
    for (const tool of ["browser.click", "browser.type", "browser.download"]) {
      const d = lm.check(SID, "A", { tool });
      assert.equal(d.allowed, false, `${tool} não é OBSERVE`);
      assert.equal(d.reason, CONTROL_NOT_OWNED);
      assert.equal(d.cause, "mode_insufficient");
      assert.equal(d.mode, "shared");
      assert.equal(d.required_mode, "exclusive");
    }
  });

  it("exclusive bloqueia shared e shared bloqueia exclusive", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "exclusive" }));
    const shared = lm.acquire(SID, "B", { ttl_ms: 10_000, mode: "shared" });
    assert.equal(shared.granted, false);
    if (shared.granted === false) assert.equal(shared.cause, "held_by_other");

    const { lm: lm2 } = mk();
    grant(lm2.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    const excl = lm2.acquire(SID, "B", { ttl_ms: 10_000, mode: "exclusive" });
    assert.equal(excl.granted, false);
    if (excl.granted === false) assert.equal(excl.cause, "shared_conflict");
  });

  it("holder único pode promover shared→exclusive; com outro shared ativo, não", () => {
    const { lm } = mk();
    const s = grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    const up = grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "exclusive" }));
    assert.equal(up.mode, "exclusive");
    assert.equal(up.lease_id, s.lease_id);
    assert.equal(lm.check(SID, "A", { class: "COMMIT" }).allowed, true);

    // Rebaixa e traz um segundo observador: agora a promoção tem de falhar.
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    grant(lm.acquire(SID, "OBS", { ttl_ms: 10_000, mode: "shared" }));
    const blocked = lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "exclusive" });
    assert.equal(blocked.granted, false);
    if (blocked.granted === false) assert.equal(blocked.cause, "shared_conflict");
  });

  it("exclusive satisfaz OBSERVE; a tabela de modos vem de ACTION_CLASS do contrato", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));
    assert.equal(lm.check(SID, "A", { tool: "browser.observe" }).allowed, true);

    assert.equal(requiredMode("OBSERVE"), "shared");
    assert.equal(requiredMode("ACT"), "exclusive");
    assert.equal(requiredMode("COMMIT"), "exclusive");
    assert.equal(requiredMode(null), "exclusive", "classe desconhecida exige exclusive (fail closed)");
    assert.equal(requiredModeForTool("browser.observe"), "shared");
    assert.equal(requiredModeForTool("browser.upload"), "exclusive");
    assert.equal(requiredModeForTool("browser.inexistente"), "exclusive");
    assert.equal(requiredModeForTool("toString"), "exclusive", "chave herdada de Object.prototype não é ferramenta");
    assert.equal(requiredModeForTool(undefined), "exclusive");

    // Toda ferramenta do contrato tem modo definido — nenhuma cai em "sem regra".
    for (const tool of Object.keys(ACTION_CLASS)) {
      const m = requiredModeForTool(tool);
      assert.ok(m === "shared" || m === "exclusive");
      assert.equal(m, ACTION_CLASS[tool] === "OBSERVE" ? "shared" : "exclusive");
    }
    assert.equal(modeSatisfies("exclusive", "shared"), true);
    assert.equal(modeSatisfies("shared", "exclusive"), false);
  });
});

describe("FASE 9 — fail closed", () => {
  it("sessão sem lease nenhum é negada por padrão", () => {
    const { lm } = mk();
    const d = lm.check("ses_nunca_vista", "A", { class: "OBSERVE" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, CONTROL_NOT_OWNED);
    assert.equal(d.cause, "unleased");
    // Consultar não pode criar sessão: seria crescimento de memória por leitura.
    assert.equal(lm.sessions().includes("ses_nunca_vista"), false);
  });

  it("allow_unleased é ato explícito e continua recusando lease_id aposentado", () => {
    const { lm } = mk({ allow_unleased: true });
    assert.equal(lm.check(SID, "A", { class: "ACT" }).allowed, true);

    const a = grant(lm.acquire(SID, "A", { ttl_ms: 5_000 }));
    assert.equal(lm.check(SID, "B", { class: "ACT" }).allowed, false, "com lease ativo, allow_unleased não vale nada");

    lm.release(SID, "A", a.lease_id);
    // Sessão voltou a ficar sem lease — mas quem chega com o lease APOSENTADO
    // não é tratado como "chegou limpo".
    assert.equal(lm.check(SID, "B", { class: "ACT" }).allowed, true);
    const withOld = lm.check(SID, "A", { class: "ACT", lease_id: a.lease_id });
    assert.equal(withOld.allowed, false);
    assert.equal(withOld.cause, "stale_lease_id");
  });

  it("check sem classe assume ACT — consultar de menos não pode render mais permissão", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    const d = lm.check(SID, "A");
    assert.equal(d.required_mode, "exclusive");
    assert.equal(d.allowed, false);
    assert.equal(d.cause, "mode_insufficient");
  });

  it("entrada inválida não concede nada e não lança", () => {
    const { lm } = mk();
    const casos: Array<[string, LeaseResult]> = [
      ["session vazio", lm.acquire("", "A")],
      ["session não-string", lm.acquire(42 as unknown as string, "A")],
      ["holder vazio", lm.acquire(SID, "   ")],
      ["holder não-string", lm.acquire(SID, null as unknown as string)],
      ["nome longo demais", lm.acquire(SID, "x".repeat(129))],
      ["ttl zero", lm.acquire(SID, "A", { ttl_ms: 0 })],
      ["ttl negativo", lm.acquire(SID, "A", { ttl_ms: -1 })],
      ["ttl fracionário", lm.acquire(SID, "A", { ttl_ms: 1.5 })],
      ["ttl NaN", lm.acquire(SID, "A", { ttl_ms: Number.NaN })],
      ["ttl Infinity", lm.acquire(SID, "A", { ttl_ms: Number.POSITIVE_INFINITY })],
      ["ttl acima do teto", lm.acquire(SID, "A", { ttl_ms: 86_400_001 })],
      ["modo inventado", lm.acquire(SID, "A", { mode: "eventual" as unknown as "shared" })],
    ];
    for (const [nome, r] of casos) {
      assert.equal(r.granted, false, `${nome} não pode conceder`);
      if (r.granted === false) {
        assert.equal(r.reason, "INVALID_REQUEST", nome);
        assert.equal(r.code, "INVALID_REQUEST", nome);
      }
    }
    assert.equal(lm.holders(SID).length, 0);
    assert.equal(lm.stats().granted, 0);
    assert.equal(lm.stats().live_leases, 0);
  });

  it("entrada inválida em check/release/renew/transfer também não lança nem concede", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));

    const c = lm.check(SID, null as unknown as string);
    assert.equal(c.allowed, false);
    assert.equal(c.reason, "INVALID_REQUEST");
    assert.equal(c.holder, "", "holder não-string não vira holder mentiroso no recibo");

    const r = lm.release(SID, 7 as unknown as string, a.lease_id);
    assert.equal(r.released, false);
    assert.equal(r.reason, "INVALID_REQUEST");
    assert.equal(r.holder, "");

    assert.equal(lm.renew("", "A", a.lease_id).granted, false);
    assert.equal(lm.transfer(SID, "A", "" as unknown as string).granted, false);
    assert.equal(lm.transfer(SID, "A", "B", { ttl_ms: -3 }).granted, false);

    // Nenhuma dessas tentativas encostou no lease real.
    assert.equal(lm.currentHolder(SID), "A");
    assert.equal(lm.check(SID, "A", { lease_id: a.lease_id }).allowed, true);
  });

  it("construtor recusa TTL default/teto inválidos", () => {
    assert.throws(() => new LeaseManager({ default_ttl_ms: 0 }), LeaseClockError);
    assert.throws(() => new LeaseManager({ max_ttl_ms: -5 }), LeaseClockError);
    assert.throws(() => new LeaseManager({ default_ttl_ms: 10_000, max_ttl_ms: 1_000 }), LeaseClockError);
  });

  it("assertControl lança LeaseError com o código do contrato e o nome próprio preservado", () => {
    const { lm } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));
    assert.doesNotThrow(() => lm.assertControl(SID, "A", { tool: "browser.click" }));

    try {
      lm.assertControl(SID, "B", { tool: "browser.click" });
      assert.fail("assertControl tinha de lançar para quem não detém o lease");
    } catch (e) {
      assert.ok(e instanceof LeaseError);
      assert.equal(e.code, CONTROL_NOT_OWNED_CODE);
      assert.equal(e.code, "CAPABILITY_DENIED");
      assert.equal(e.lease_reason, CONTROL_NOT_OWNED);
      assert.equal(e.lease_cause, "held_by_other");
      const ae = e.toActionError();
      assert.equal(ae.code, "CAPABILITY_DENIED");
      assert.equal(ae.detail?.lease_reason, "CONTROL_NOT_OWNED");
      assert.equal(ae.detail?.current_holder, "A");
    }
  });

  it("o lease devolvido é congelado — o portador não estica o próprio prazo", () => {
    const { lm } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 1_000 }));
    assert.equal(Object.isFrozen(a), true);
    assert.throws(() => {
      (a as unknown as { expires_at_ms: number }).expires_at_ms = Number.MAX_SAFE_INTEGER;
    }, TypeError);
    assert.equal(lm.snapshot(SID)!.leases[0]!.expires_at_ms, a.expires_at_ms);
  });
});

describe("FASE 9 — observabilidade", () => {
  it("emite control.taken / control.returned / session.handoff e marca a expiração", () => {
    const { lm, clock, events } = mk();
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 1_000 }));
    clock.advance(2_000);
    lm.sweep();
    const b = grant(lm.acquire(SID, "B", { ttl_ms: 5_000 }));
    grant(lm.transfer(SID, "B", "C"));
    lm.releaseAll(SID);

    assert.deepEqual(
      events.map((e) => e.event),
      ["control.taken", "control.returned", "control.taken", "session.handoff", "control.returned"],
    );
    assert.equal(events[1]!.payload.op, "expire");
    assert.equal(events[1]!.payload.lease_id, a.lease_id);
    assert.equal(events[2]!.payload.lease_id, b.lease_id);
    assert.equal(events[4]!.payload.op, "release_all");
    for (const e of events) {
      assert.equal(e.payload.kind, "lease");
      assert.equal(e.session_id, SID);
      assert.equal(e.action_id, null);
      // Timestamp sai do relógio INJETADO, não de Date.now.
      assert.equal(Date.parse(e.timestamp) <= clock.value, true);
    }
  });

  it("negação de controle é registrada — recusa de segurança não some por omissão", () => {
    const { lm, events } = mk();
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));
    lm.check(SID, "B", { tool: "browser.click" });

    const failed = events.filter((e) => e.event === "action.failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.payload.kind, "lease");
    assert.equal(failed[0]!.payload.op, "check");
    assert.equal(failed[0]!.payload.reason, CONTROL_NOT_OWNED);
    assert.equal(failed[0]!.payload.current_holder, "A");
    assert.equal(failed[0]!.source, "B");
  });

  it("hook que lança não derruba a arbitragem nem solta o lease de ninguém", () => {
    const { lm } = mk();
    lm.onEvent = () => {
      throw new Error("assinante quebrado");
    };
    const a = grant(lm.acquire(SID, "A", { ttl_ms: 10_000 }));
    assert.equal(lm.currentHolder(SID), "A");
    assert.equal(lm.check(SID, "B").allowed, false);
    assert.equal(lm.check(SID, "A", { lease_id: a.lease_id }).allowed, true);
    assert.ok(lm.stats().hook_errors >= 2, "o erro do hook fica contado, não engolido");
  });

  it("snapshot descreve o estado sem permitir mexer nele", () => {
    const { lm } = mk();
    assert.equal(lm.snapshot("ses_inexistente"), null);
    grant(lm.acquire(SID, "A", { ttl_ms: 10_000, mode: "shared" }));
    grant(lm.acquire(SID, "B", { ttl_ms: 10_000, mode: "shared" }));

    const snap = lm.snapshot(SID)!;
    assert.equal(snap.mode, "shared");
    assert.equal(snap.current_holder, null);
    assert.deepEqual(snap.holders.sort(), ["A", "B"]);
    assert.equal(snap.leases.length, 2);
    assert.equal(snap.fencing_token, 2);

    snap.holders.push("INVENTADO");
    assert.deepEqual(lm.holders(SID).sort(), ["A", "B"]);
  });
});
