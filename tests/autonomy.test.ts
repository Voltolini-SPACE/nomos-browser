import assert from "node:assert/strict";
import test from "node:test";

import {
  classificar,
  decidir,
  LIVE_AGENT_STATES,
  PERFIL_DA_ROTA,
  rotasQueSempreAprovam,
  type AutonomyMode,
} from "../packages/core/src/autonomy.ts";
import { ACTION_CLASS } from "../packages/core/src/contract.ts";

const MODOS: AutonomyMode[] = ["ASK", "AUTO"];

// ─────────────────────────────────────────────────────────────────────────────
// COBERTURA — uma tabela que não cobre uma rota nova é pior que tabela nenhuma:
// ela dá a sensação de proteger.
// ─────────────────────────────────────────────────────────────────────────────

test("1. toda rota do contrato tem perfil de risco declarado", () => {
  const semPerfil = Object.keys(ACTION_CLASS).filter((r) => PERFIL_DA_ROTA[r] === undefined);
  assert.deepEqual(
    semPerfil,
    [],
    `rotas do contrato sem perfil em PERFIL_DA_ROTA: ${semPerfil.join(", ")}`,
  );
});

test("2. nenhum perfil descreve rota que o contrato não conhece", () => {
  const fantasmas = Object.keys(PERFIL_DA_ROTA).filter((r) => ACTION_CLASS[r] === undefined);
  assert.deepEqual(fantasmas, [], `perfis para rotas inexistentes: ${fantasmas.join(", ")}`);
});

test("3. rota desconhecida é fail-closed, nos dois modos", () => {
  for (const modo of MODOS) {
    const d = decidir("browser.rota_que_nao_existe", modo);
    assert.equal(d.efeito, "PEDIR_APROVACAO", `modo ${modo}`);
    assert.equal(d.classe, "SEMPRE_APROVAR");
    assert.equal(d.fator, "desconhecida");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// A INVARIANTE DE SEGURANÇA — `AUTO != BYPASS`
//
// Este é o gate que a missão chama de principal. Não é sobre uma rota: é sobre
// TODAS, e por isso o teste varre a tabela inteira em vez de escolher exemplos.
// ─────────────────────────────────────────────────────────────────────────────

test("4. AUTO nunca rebaixa uma rota SEMPRE_APROVAR — varrendo a tabela inteira", () => {
  const vazou: string[] = [];
  for (const rota of Object.keys(PERFIL_DA_ROTA)) {
    if (classificar(PERFIL_DA_ROTA[rota]).classe !== "SEMPRE_APROVAR") continue;
    if (decidir(rota, "AUTO").efeito !== "PEDIR_APROVACAO") vazou.push(rota);
  }
  assert.deepEqual(vazou, [], `AUTO liberou rota de aprovação obrigatória: ${vazou.join(", ")}`);
});

test("5. e existe ao menos uma rota assim — senão o teste 4 é vacuoso", () => {
  const sempre = rotasQueSempreAprovam();
  assert.ok(sempre.length >= 1, "nenhuma rota exige aprovação obrigatória; o teste 4 não prova nada");
  // As duas que a tabela classifica hoje, nomeadas para que uma mudança
  // silenciosa apareça no diff em vez de passar despercebida.
  assert.deepEqual(sempre, ["browser.task", "browser.upload"]);
});

test("6. a classe não enxerga o modo — é a mesma em ASK e em AUTO", () => {
  // `classificar` nem recebe o modo. Este teste existe para que, se alguém um
  // dia lhe passar o modo, a mudança quebre aqui e não em produção.
  for (const rota of Object.keys(PERFIL_DA_ROTA)) {
    const a = decidir(rota, "ASK");
    const b = decidir(rota, "AUTO");
    assert.equal(a.classe, b.classe, `${rota}: classe mudou com o modo`);
    assert.equal(a.motivo, b.motivo, `${rota}: motivo mudou com o modo`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// A DIREÇÃO DA FRICÇÃO — AUTO só pode tirar perguntas, nunca criar
// ─────────────────────────────────────────────────────────────────────────────

test("7. o que executa em ASK executa em AUTO (AUTO nunca é mais restritivo)", () => {
  for (const rota of Object.keys(PERFIL_DA_ROTA)) {
    if (decidir(rota, "ASK").efeito !== "EXECUTAR") continue;
    assert.equal(decidir(rota, "AUTO").efeito, "EXECUTAR", `${rota}: ASK executa mas AUTO pergunta`);
  }
});

test("8. leitura pura (A0) nunca pergunta, em modo nenhum", () => {
  for (const [rota, perfil] of Object.entries(PERFIL_DA_ROTA)) {
    if (perfil.nivel !== "A0") continue;
    assert.equal(perfil.efeito_colateral, false, `${rota}: A0 com efeito colateral é contradição`);
    for (const modo of MODOS) {
      assert.equal(decidir(rota, modo).efeito, "EXECUTAR", `${rota} em ${modo}`);
    }
  }
});

test("9. ASK pergunta em tudo que muta — senão ASK não significa nada", () => {
  const mutantesQueNaoPerguntam: string[] = [];
  for (const [rota, perfil] of Object.entries(PERFIL_DA_ROTA)) {
    if (!perfil.efeito_colateral) continue;
    if (decidir(rota, "ASK").efeito !== "PEDIR_APROVACAO") mutantesQueNaoPerguntam.push(rota);
  }
  assert.deepEqual(mutantesQueNaoPerguntam, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// OS FATORES ANTES DO NÍVEL
// ─────────────────────────────────────────────────────────────────────────────

test("10. um fator de risco promove, mesmo com nível baixo", () => {
  // `browser.upload` é A2 — o mesmo nível de `browser.scroll`. O que separa as
  // duas não é o nível: é `envio_externo`.
  assert.equal(PERFIL_DA_ROTA["browser.upload"]!.nivel, "A2");
  assert.equal(PERFIL_DA_ROTA["browser.scroll"]!.nivel, "A2");
  assert.equal(decidir("browser.scroll", "AUTO").efeito, "EXECUTAR");
  assert.equal(decidir("browser.upload", "AUTO").efeito, "PEDIR_APROVACAO");
  assert.equal(decidir("browser.upload", "AUTO").fator, "envio_externo");
});

test("11. o fator declarado bate com o motivo — a trilha não pode mentir", () => {
  const d = decidir("browser.task", "AUTO");
  assert.equal(d.classe, "SEMPRE_APROVAR");
  assert.equal(d.nivel, "A5");
  assert.ok(d.motivo.length > 0);
  assert.ok(d.perfil !== null && d.perfil.consequencia.length > 0,
    "toda rota precisa de uma consequência legível: é o texto que o usuário lê antes de decidir");
});

test("12. toda rota tem consequência escrita em português", () => {
  const semTexto = Object.entries(PERFIL_DA_ROTA)
    .filter(([, p]) => !p.consequencia || p.consequencia.trim().length < 10)
    .map(([r]) => r);
  assert.deepEqual(semTexto, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILIDADE — sessão não governada
// ─────────────────────────────────────────────────────────────────────────────

test("13. sessão sem modo declarado mantém o comportamento de sempre", () => {
  for (const rota of Object.keys(PERFIL_DA_ROTA)) {
    const d = decidir(rota, null);
    assert.equal(d.efeito, "EXECUTAR", `${rota}: sessão não governada deixou de executar`);
    assert.equal(d.nao_governada, true);
  }
});

test("14. e `nao_governada` distingue isso de uma decisão de verdade", () => {
  // Sem esta marca, "executou porque é A0" e "executou porque ninguém governa"
  // ficariam idênticos na trilha — e são coisas muito diferentes.
  assert.equal(decidir("browser.extract", null).nao_governada, true);
  assert.equal(decidir("browser.extract", "AUTO").nao_governada, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO DE ESTADO
// ─────────────────────────────────────────────────────────────────────────────

test("15. os doze estados do contrato existem e são únicos", () => {
  assert.equal(LIVE_AGENT_STATES.length, 12);
  assert.equal(new Set(LIVE_AGENT_STATES).size, 12);
  for (const e of ["IDLE", "OBSERVING", "THINKING", "ACTING", "WAITING_APPROVAL", "PAUSED",
    "USER_CONTROL", "CANCELLING", "CANCELLED", "COMPLETED", "ERROR", "DISCONNECTED"]) {
    assert.ok((LIVE_AGENT_STATES as readonly string[]).includes(e), `falta o estado ${e}`);
  }
});
