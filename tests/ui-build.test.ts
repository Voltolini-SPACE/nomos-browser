import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveBrand, lerTokens } from "../packages/ui/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTE_UI = path.join(RAIZ, "packages/ui/src/app.html");

// O cofre de marca e da MAQUINA DO DONO, nao do repositorio: `~/.brand-governance`
// nao e versionado e nunca vai existir num runner publico. `packages/ui/build.ts`
// falha FECHADO sem ele, e isso e o comportamento certo do build.
//
// O que estava errado era transformar esse acerto em vermelho. Este arquivo
// derrubou a CI publica em TODAS as execucoes desde a primeira: `ci.sh` ja
// marcava o passo `build:ui` como PULADO com a razao impressa, mas o TESTE
// chamava `build()` assim mesmo e reprovava por uma ausencia que nao e defeito.
//
// A regra da casa: nunca verde por impossibilidade, e tampouco vermelho por
// impossibilidade. O que nao pode rodar aqui se pula dizendo por que. O primeiro
// teste deste arquivo — o que prova que o fonte nao tem token de marca copiado —
// e hermetico e continua rodando em qualquer lugar, que e justamente o guarda que
// mais importa manter vivo num runner publico.
const COFRE_MARCA = path.join(process.env["HOME"] ?? "", ".brand-governance/bin/brand-resolve.sh");
const SEM_COFRE: string | false = existsSync(COFRE_MARCA)
  ? false
  : `cofre de marca ausente em ${COFRE_MARCA} — este guarda so roda na maquina que tem a governanca de marca`;

test("o fonte da UI não contém NENHUM token de marca (contrato §6.3)", () => {
  const src = readFileSync(FONTE_UI, "utf8");

  // Um hex de 6 dígitos no fonte significaria token copiado para arquivo
  // intermediário — a proibição que este projeto precisa provar que respeita.
  const hexes = src.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
  assert.deepEqual(hexes, [], `cor literal encontrada no fonte da UI: ${hexes.join(", ")}`);

  for (const fonte of ["JetBrains Mono", "IBM Plex Mono", "SF Mono", "Menlo", "Consolas"]) {
    assert.ok(!src.includes(fonte), `família de fonte da marca literal no fonte: ${fonte}`);
  }
});

test("resolveBrand usa o resolvedor oficial e reporta rc e oficialidade", { skip: SEM_COFRE }, () => {
  const r = resolveBrand("NOMOS");
  assert.equal(r.marca, "NOMOS");
  assert.ok(r.versao.startsWith("v"), `versão inesperada: ${r.versao}`);
  assert.ok(existsSync(r.fonte), `fonte do cofre não existe: ${r.fonte}`);
  assert.equal(typeof r.oficial, "boolean");
  // Estado apurado hoje: vigente sem congelamento. Se isto passar a falhar é
  // porque o dono congelou a marca — e aí a UI deixa de sair PROPOSTA.
  assert.equal(r.oficial, r.rc === 0);
});

test("marca inexistente falha fechado, não devolve paleta inventada", { skip: SEM_COFRE }, () => {
  assert.throws(() => resolveBrand("MARCA_QUE_NAO_EXISTE_XYZ"), /não resolveu|sem caminho/);
});

test("tokens vêm do cofre com integridade conferida e sem colisão de chave", { skip: SEM_COFRE }, () => {
  const { tokens, integridade } = lerTokens(resolveBrand("NOMOS").fonte);

  assert.ok(Object.keys(tokens.cores).length >= 8, "esperava ao menos 8 cores no brandbook");
  assert.ok(integridade.verificado, "SHA256SUMS deveria cobrir o brandbook");
  assert.match(integridade.sha256, /^[0-9a-f]{64}$/);

  // Rosa e Ciano compartilham o uso "acento": chavear por uso perderia uma delas.
  assert.ok(tokens.cores.rosa !== undefined && tokens.cores.ciano !== undefined, "cores de acento perdidas");
  assert.notEqual(tokens.cores.rosa, tokens.cores.ciano, "duas cores distintas colapsaram na mesma chave");

  // Apelidos semânticos usados pelo CSS precisam existir.
  for (const alias of ["fundo", "caixas", "marca", "texto", "aviso", "erro"]) {
    assert.match(tokens.cores[alias] ?? "", /^#[0-9A-F]{6}$/, `alias semântico ausente: ${alias}`);
  }
  assert.ok(tokens.fontes.mono.length > 0, "fonte mono não extraída");
});

test("build injeta os tokens, marca PROPOSTA e não deixa placeholder", { skip: SEM_COFRE }, () => {
  const r = build();
  const html = readFileSync(r.saida, "utf8");

  // Guarda específico: o `__NOMOS_` cru também casa com `window.__NOMOS_TOKEN`,
  // que o daemon injeta em tempo de execução e é legítimo. O guarda genérico
  // passou a acusar o próprio produto.
  for (const ph of [
    "/*__NOMOS_CORES__*/",
    "__NOMOS_FONT_MONO__",
    "__NOMOS_SELO__",
    "__NOMOS_TAGLINE__",
    "__NOMOS_ASSINATURA__",
    "__NOMOS_INTEGRIDADE__",
  ]) {
    assert.ok(!html.includes(ph), `sobrou placeholder no HTML gerado: ${ph}`);
  }
  assert.match(html, /--nomos-marca:\s*#[0-9A-F]{6}/, "variável de cor da marca ausente no build");
  assert.match(html, /--nomos-mono:[^;]+mono/i, "família mono ausente no build");

  // LEI art. 1.3 + estado rc=3: a peça declara marca, versão e condição.
  assert.match(html, /NOMOS v1\.0/, "peça não declara marca e versão");
  if (!r.resolucao.oficial) {
    assert.match(html, /PROPOSTA/, "marca não oficial exige selo PROPOSTA na peça");
  }
});

test("dist não é versionado — o artefato com token não pode entrar no git", () => {
  const ignore = readFileSync(path.join(RAIZ, ".gitignore"), "utf8");
  assert.ok(
    ignore.split("\n").some((l) => l.trim() === "dist/" || l.trim() === "packages/ui/dist/"),
    "dist/ precisa estar no .gitignore: ele contém tokens de marca",
  );
});
