import assert from "node:assert/strict";
import test from "node:test";

import { impressaoDeArgs, RegistroDeAprovacoes } from "../packages/core/src/approvals.ts";

const BASE = {
  session_id: "ses_a",
  action_id: "act_1",
  rota: "browser.click",
  args: { target: { selector: "#confirmar" } },
  args_visiveis: { target: { selector: "#confirmar" } },
  nivel: "A2",
  motivo: "nível A2",
  consequencia: "clica num elemento da página",
  recurso: "página atual",
  autonomy_mode: "ASK",
};

function reg(ttl = 300_000, relogio?: { t: number }) {
  return new RegistroDeAprovacoes({
    ttl_ms: ttl,
    ...(relogio ? { agora: () => relogio.t } : {}),
  });
}

function vinculoDe(p: typeof BASE) {
  return { session_id: p.session_id, action_id: p.action_id, rota: p.rota, args: p.args };
}

// ─────────────────────────────────────────────────────────────────────────────
// O CAMINHO FELIZ, e o controle que o torna significativo
// ─────────────────────────────────────────────────────────────────────────────

test("1. aprovada e consumida: a ação libera exatamente uma vez", () => {
  const r = reg();
  const p = r.propor(BASE);
  assert.equal(p.estado, "PENDENTE");
  r.decidir(p.approval_id, "APROVADA", "dono");
  const uso = r.consumir(p.approval_id, vinculoDe(BASE));
  assert.equal(uso.ok, true);
});

test("2. SINGLE-USE — a segunda vez não passa", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  assert.equal(r.consumir(p.approval_id, vinculoDe(BASE)).ok, true);
  const segunda = r.consumir(p.approval_id, vinculoDe(BASE));
  assert.equal(segunda.ok, false);
  assert.match((segunda as { motivo: string }).motivo, /single-use/);
});

test("3. NON-STICKY — a próxima ação equivalente precisa de aprovação nova", () => {
  const r = reg();
  const p1 = r.propor(BASE);
  r.decidir(p1.approval_id, "APROVADA", "dono");
  r.consumir(p1.approval_id, vinculoDe(BASE));

  // Mesma rota, mesmos argumentos, outra ação: continua pendente.
  const p2 = r.propor({ ...BASE, action_id: "act_2" });
  assert.equal(p2.estado, "PENDENTE");
  const uso = r.consumir(p2.approval_id, { ...vinculoDe(BASE), action_id: "act_2" });
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /ainda não foi decidida/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTION-BOUND — o cheque em branco que este teste impede
// ─────────────────────────────────────────────────────────────────────────────

test("4. aprovar um clique NÃO aprova outro clique", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  // O agente tenta usar a aprovação de "#confirmar" para clicar em outro lugar.
  const uso = r.consumir(p.approval_id, {
    ...vinculoDe(BASE),
    args: { target: { selector: "#comprar-agora" } },
  });
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /argumentos mudaram/);
});

test("5. nem serve para outra ROTA", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  const uso = r.consumir(p.approval_id, { ...vinculoDe(BASE), rota: "browser.upload" });
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /browser\.click.*browser\.upload/);
});

test("6. SESSION-BOUND — aprovação de uma sessão não serve em outra", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  const uso = r.consumir(p.approval_id, { ...vinculoDe(BASE), session_id: "ses_b" });
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /outra sessão/);
});

test("7. nem para outra AÇÃO da mesma sessão", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  const uso = r.consumir(p.approval_id, { ...vinculoDe(BASE), action_id: "act_99" });
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /outra ação/);
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED — a ausência de resposta nunca é consentimento
// ─────────────────────────────────────────────────────────────────────────────

test("8. prazo esgotado vira EXPIRADA, e EXPIRADA não executa", () => {
  const relogio = { t: 1_000_000 };
  const r = reg(60_000, relogio);
  const p = r.propor(BASE);
  relogio.t += 60_001;
  assert.equal(r.obter(p.approval_id)!.estado, "EXPIRADA");
  const uso = r.consumir(p.approval_id, vinculoDe(BASE));
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /expirou/);
});

test("9. e o controle: DENTRO do prazo continua pendente, não expira sozinha", () => {
  const relogio = { t: 1_000_000 };
  const r = reg(60_000, relogio);
  const p = r.propor(BASE);
  relogio.t += 59_000;
  assert.equal(r.obter(p.approval_id)!.estado, "PENDENTE");
});

test("10. negada não executa, e diz que foi negada", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "NEGADA", "dono");
  const uso = r.consumir(p.approval_id, vinculoDe(BASE));
  assert.equal(uso.ok, false);
  assert.match((uso as { motivo: string }).motivo, /negada/);
});

test("11. pendente NÃO executa — o estado inicial é fechado", () => {
  const r = reg();
  const p = r.propor(BASE);
  assert.equal(r.consumir(p.approval_id, vinculoDe(BASE)).ok, false);
});

test("12. id inventado não executa", () => {
  const r = reg();
  assert.equal(r.consumir("apr_inventado", vinculoDe(BASE)).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRIDADE DA DECISÃO
// ─────────────────────────────────────────────────────────────────────────────

test("13. não se decide duas vezes", () => {
  const r = reg();
  const p = r.propor(BASE);
  r.decidir(p.approval_id, "APROVADA", "dono");
  assert.throws(() => r.decidir(p.approval_id, "NEGADA", "outro"), /já está/);
});

test("14. a decisão registra QUEM decidiu e QUANDO", () => {
  const r = reg();
  const p = r.propor(BASE);
  const d = r.decidir(p.approval_id, "APROVADA", "dono@maquina");
  assert.equal(d.decidido_por, "dono@maquina");
  assert.ok(d.decidido_em !== null && !Number.isNaN(Date.parse(d.decidido_em)));
});

test("14b. a impressão distingue diferenças ANINHADAS — o defeito real que o teste 4 pegou", () => {
  // A primeira versão de `impressaoDeArgs` usava o segundo argumento do
  // `JSON.stringify` achando que era "ordem das chaves". É um REPLACER: uma
  // lista de permissão aplicada em TODOS os níveis. Com `["target"]`, o
  // `selector` lá dentro sumia, e os dois cliques abaixo tinham a MESMA
  // impressão — uma aprovação para "Cancelar" liberava "Confirmar compra".
  const cancelar = impressaoDeArgs({ target: { selector: "#cancelar" } });
  const comprar = impressaoDeArgs({ target: { selector: "#comprar-agora" } });
  assert.notEqual(cancelar, comprar, "impressões iguais para alvos diferentes: action-bound não existe");

  // E fundo de verdade, não só um nível.
  const f1 = impressaoDeArgs({ a: { b: { c: { d: 1 } } } });
  const f2 = impressaoDeArgs({ a: { b: { c: { d: 2 } } } });
  assert.notEqual(f1, f2, "diferença a quatro níveis de profundidade passou despercebida");

  // Arrays também: trocar a ORDEM de um array muda o significado.
  assert.notEqual(impressaoDeArgs({ xs: [1, 2] }), impressaoDeArgs({ xs: [2, 1] }));
});

test("15. a impressão dos args não depende da ordem das chaves", () => {
  // Sem isto, o mesmo pedido com as chaves em outra ordem seria recusado — e o
  // usuário veria uma aprovação legítima falhar sem motivo visível.
  assert.equal(impressaoDeArgs({ a: 1, b: 2 }), impressaoDeArgs({ b: 2, a: 1 }));
  // Inclusive aninhado — normalizar só o topo seria meia solução.
  assert.equal(
    impressaoDeArgs({ t: { x: 1, y: 2 } }),
    impressaoDeArgs({ t: { y: 2, x: 1 } }),
  );
  assert.notEqual(impressaoDeArgs({ a: 1 }), impressaoDeArgs({ a: 2 }));
});

// ─────────────────────────────────────────────────────────────────────────────
// KILL SWITCH E FILA
// ─────────────────────────────────────────────────────────────────────────────

test("16. negarPendentes limpa a fila — kill switch que deixa pendência não para nada", () => {
  const r = reg();
  const p1 = r.propor(BASE);
  const p2 = r.propor({ ...BASE, action_id: "act_2" });
  assert.equal(r.pendentesDe("ses_a").length, 2);

  r.negarPendentes("ses_a", "emergency_stop");
  assert.equal(r.pendentesDe("ses_a").length, 0);
  for (const id of [p1.approval_id, p2.approval_id]) {
    assert.equal(r.obter(id)!.estado, "NEGADA");
    assert.equal(r.consumir(id, vinculoDe(BASE)).ok, false);
  }
});

test("17. a fila tem teto — um agente em laço não pode afogar a tela de aprovação", () => {
  const r = new RegistroDeAprovacoes({ max_pendentes_por_sessao: 3 });
  for (let i = 0; i < 3; i += 1) r.propor({ ...BASE, action_id: `act_${i}` });
  assert.throws(() => r.propor({ ...BASE, action_id: "act_x" }), /fila de aprovações cheia/);
});

test("18. o teto é POR SESSÃO — uma sessão cheia não trava a outra", () => {
  const r = new RegistroDeAprovacoes({ max_pendentes_por_sessao: 2 });
  r.propor({ ...BASE, action_id: "a1" });
  r.propor({ ...BASE, action_id: "a2" });
  assert.throws(() => r.propor({ ...BASE, action_id: "a3" }), /cheia/);
  const outra = r.propor({ ...BASE, session_id: "ses_b", action_id: "b1" });
  assert.equal(outra.estado, "PENDENTE");
});

test("19. o pedido carrega o que o usuário precisa para decidir", () => {
  const r = reg();
  const p = r.propor(BASE);
  // Sem consequência e recurso, a tela de aprovação vira "permitir? [sim/não]"
  // sobre uma coisa que o usuário não sabe o que é.
  assert.ok(p.consequencia.length > 0);
  assert.ok(p.recurso.length > 0);
  assert.equal(p.nivel, "A2");
  assert.equal(p.rota, "browser.click");
  assert.deepEqual(p.args_visiveis, BASE.args_visiveis);
});
