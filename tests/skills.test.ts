import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNomosSkill, validateSkill, resolveVariables } from "../packages/skills/src/schema.ts";

const EXEMPLO_DA_MISSAO = `
name: se7enpay.get_tpv
version: 1

requirements:
  profile: se7enpay

steps:
  - navigate
  - validate_dashboard
  - select_period
  - extract_tpv

verification:
  - correct_account
  - correct_date
  - currency_value
`;

const COMPLETA = `
name: exemplo.login
version: 2
description: "Entra no painel e extrai o saldo"

requirements:
  profile: sandbox
  capabilities:
    - navigate
    - click
    - type

variables:
  usuario: operador
  periodo: hoje

steps:
  - name: abrir
    action: goto
    value: "https://exemplo.invalid/painel?p=\${periodo}"
    verification:
      kind: URL_CHANGED
      expect: painel
  - name: preencher_usuario
    action: type
    target:
      role: textbox
      label: "Usuário"
    value: "\${usuario}"
    retry:
      max: 2
      backoff_ms: 250
  - name: preencher_senha
    action: type
    target:
      role: textbox
      label: "Senha"
    credential_ref: exemplo/senha
  - name: entrar
    action: click
    target:
      role: button
      text: "Entrar"
      semantic: login
    fallback: abrir
    verification:
      kind: ELEMENT_APPEARED
      expect: "#saldo"

verification:
  - conta_correta
  - valor_monetario
`;

test("parseia a forma curta do exemplo da missão", () => {
  const s = parseNomosSkill(EXEMPLO_DA_MISSAO);
  assert.equal(s.name, "se7enpay.get_tpv");
  assert.equal(s.version, 1);
  assert.equal(s.requirements.profile, "se7enpay");
  assert.deepEqual(s.steps.map((x) => x.action), ["navigate", "validate_dashboard", "select_period", "extract_tpv"]);
  assert.deepEqual(s.verification, ["correct_account", "correct_date", "currency_value"]);
  assert.equal(validateSkill(s).valid, true);
});

test("parseia a forma completa com alvo, retry, fallback e credential_ref", () => {
  const s = parseNomosSkill(COMPLETA);
  assert.equal(s.name, "exemplo.login");
  assert.equal(s.version, 2);
  assert.equal(s.steps.length, 4);
  assert.deepEqual(s.requirements.capabilities, ["navigate", "click", "type"]);
  assert.equal(s.variables.usuario, "operador");

  const senha = s.steps.find((x) => x.name === "preencher_senha")!;
  assert.equal(senha.credential_ref, "exemplo/senha");
  assert.equal(senha.value, undefined, "senha nunca vem como valor literal");

  const entrar = s.steps.find((x) => x.name === "entrar")!;
  assert.deepEqual(entrar.target, { role: "button", text: "Entrar", semantic: "login" });
  assert.equal(entrar.fallback, "abrir");
  assert.equal(entrar.verification?.kind, "ELEMENT_APPEARED");

  const usuario = s.steps.find((x) => x.name === "preencher_usuario")!;
  assert.equal(usuario.retry?.max, 2);

  assert.equal(validateSkill(s).valid, true);
});

test("rejeita segredo literal em vez de credential_ref", () => {
  const s = parseNomosSkill(`
name: ruim.segredo
version: 1
steps:
  - name: senha_do_painel
    action: type
    target:
      label: "Senha"
    value: "hunter2-super-secreto"
verification:
  - ok
`);
  const v = validateSkill(s);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("credential_ref")), `esperava erro de credential_ref, veio: ${v.errors.join(" | ")}`);
});

test("rejeita retry infinito e fallback inexistente", () => {
  const s = parseNomosSkill(`
name: ruim.retry
version: 1
steps:
  - name: um
    action: click
    retry:
      max: 999
    fallback: nao_existe
verification:
  - ok
`);
  const v = validateSkill(s);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("retry.max")));
  assert.ok(v.errors.some((e) => e.includes("não existe")));
});

test("avisa sobre alvo frágil (só selector, só coordenada)", () => {
  const s = parseNomosSkill(`
name: fragil.alvo
version: 1
steps:
  - name: um
    action: click
    target:
      selector: "#btn"
  - name: dois
    action: click
    target:
      coordinates: "120,40"
verification:
  - ok
`);
  const v = validateSkill(s);
  assert.equal(v.valid, true, "alvo frágil é aviso, não erro");
  assert.equal(v.warnings.length, 2, v.warnings.join(" | "));
});

test("avisa quando não há bloco verification", () => {
  const s = parseNomosSkill(`
name: sem.verificacao
version: 1
steps:
  - navigate
`);
  const v = validateSkill(s);
  assert.ok(v.warnings.some((w) => w.includes("verification")));
});

test("nome duplicado de passo é erro (fallback ficaria ambíguo)", () => {
  const s = parseNomosSkill(`
name: dup.passo
version: 1
steps:
  - name: igual
    action: click
  - name: igual
    action: type
verification:
  - ok
`);
  assert.equal(validateSkill(s).valid, false);
});

test("resolveVariables substitui e falha em variável ausente", () => {
  assert.equal(resolveVariables("hoje=${periodo}", { periodo: "24/08" }), "hoje=24/08");
  assert.throws(() => resolveVariables("${faltando}", {}), /não definida/);
});

test("comentário fora de aspas é removido, dentro de aspas é preservado", () => {
  const s = parseNomosSkill(`
name: com.comentario   # isto some
version: 1
description: "valor # com cerquilha"
steps:
  - navigate
verification:
  - ok
`);
  assert.equal(s.name, "com.comentario");
  assert.equal(s.description, "valor # com cerquilha");
});

test("tab na indentação é rejeitado com linha apontada", () => {
  assert.throws(() => parseNomosSkill("name: x\n\tversion: 1\n"), /tab na linha 2/);
});
