import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveBrand, lerTokens } from "../packages/ui/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTE_UI = path.join(RAIZ, "packages/ui/src/app.html");

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

test("resolveBrand usa o resolvedor oficial e reporta rc e oficialidade", () => {
  const r = resolveBrand("NOMOS");
  assert.equal(r.marca, "NOMOS");
  assert.ok(r.versao.startsWith("v"), `versão inesperada: ${r.versao}`);
  assert.ok(existsSync(r.fonte), `fonte do cofre não existe: ${r.fonte}`);
  assert.equal(typeof r.oficial, "boolean");
  // Estado apurado hoje: vigente sem congelamento. Se isto passar a falhar é
  // porque o dono congelou a marca — e aí a UI deixa de sair PROPOSTA.
  assert.equal(r.oficial, r.rc === 0);
});

test("marca inexistente falha fechado, não devolve paleta inventada", () => {
  assert.throws(() => resolveBrand("MARCA_QUE_NAO_EXISTE_XYZ"), /não resolveu|sem caminho/);
});

test("tokens vêm do cofre com integridade conferida e sem colisão de chave", () => {
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

test("build injeta os tokens, marca PROPOSTA e não deixa placeholder", () => {
  const r = build();
  const html = readFileSync(r.saida, "utf8");

  assert.ok(!html.includes("__NOMOS_"), "sobrou placeholder no HTML gerado");
  assert.ok(!html.includes("/*__NOMOS_CORES__*/"), "bloco de cores não substituído");
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
