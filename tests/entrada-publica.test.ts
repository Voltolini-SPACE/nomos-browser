// A porta de entrada pública: o que um estranho digita depois de clonar.
//
// Este arquivo nasceu de um defeito real encontrado na sala limpa do lançamento.
// `npm test` declarava `node --test --experimental-strip-types tests/`, passando
// um DIRETÓRIO NU ao runner. Isso funciona no Node 22 e QUEBRA a partir do 23:
// o runner deixa de tratar o argumento como pasta de testes e tenta carregá-lo
// como módulo, morrendo com MODULE_NOT_FOUND antes de rodar um único teste.
//
// O `engines` dizia `>=22.6.0`. Ou seja: a faixa declarada como suportada
// incluía versões onde o comando mais padrão de todo o npm não roda. Quem
// clonasse o repositório público no Node 26 via a suíte inteira falhar sem que
// existisse defeito nenhum no produto.
//
// Medido em v22.23.1 (passa) e v26.0.0 (MODULE_NOT_FOUND). O controle de mutação
// no fim deste arquivo reencena a forma antiga e exige que ela falhe, porque um
// teste que não sabe reprovar a versão quebrada não está guardando nada.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(RAIZ, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};

const MAIOR_ATUAL = Number(process.versions.node.split(".")[0]);
const ALVO = "tests/entrada-publica.test.ts";

// Os testes 3 e 4 reexecutam o runner contra ESTE arquivo. Sem esta trava eles
// se chamariam para sempre. O filho existe para provar que o runner carrega o
// arquivo e emite sumário; os testes 1, 2 e 5 já bastam para isso.
const EH_FILHO = process.env["NOMOS_ENTRADA_PUBLICA_FILHO"] === "1";

// O runner do Node se recusa a rodar dentro de si mesmo: se `NODE_TEST_CONTEXT`
// estiver no ambiente do filho, ele imprime "run() is being called recursively"
// e SAI COM 0 sem executar nada. Medir o runner de dentro do runner sem limpar
// isso mede a trava de recursão, não o produto — e um exit 0 vazio se disfarça
// de sucesso. Este ambiente nasce sem as marcas do processo pai.
function ambienteLimpo(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env["NODE_TEST_CONTEXT"];
  delete env["NODE_TEST_WORKER_ID"];
  return env;
}

test("1. o script `test` não passa um diretório nu para o runner do Node", () => {
  const script = pkg.scripts["test"];
  assert.ok(typeof script === "string" && script.length > 0, "package.json não declara script `test`");

  // A forma proibida é `--test ... <algo>/` — barra final, sem arquivo nem glob.
  const diretorioNu = /--test\b[^|&;]*?\s(?!-)[\w./-]+\/(?=\s|$)/.test(script);
  assert.equal(
    diretorioNu,
    false,
    `\`npm test\` volta a passar diretório nu ao runner: ${script}\n` +
      "Isso quebra a partir do Node 23. Use o executor (scripts/run-suite.sh) ou um glob citado.",
  );
});

test("2. o `engines` declarado não promete uma versão que não sabemos strippar", () => {
  const faixa = pkg.engines.node;
  const m = /(\d+)\.(\d+)/.exec(faixa);
  assert.ok(m !== null, `engines.node ilegível: ${faixa}`);
  const maior = Number(m[1]);
  const menor = Number(m[2]);

  // O executor roda `node --test <arquivo>.ts` SEM `--experimental-strip-types`.
  // Isso só funciona onde o stripping de tipos já vem ligado por padrão: 22.18+.
  // Declarar 22.6 era prometer uma faixa onde o próprio executor não roda.
  const okMinimo = maior > 22 || (maior === 22 && menor >= 18);
  assert.ok(
    okMinimo,
    `engines.node=${faixa} inclui versões sem type stripping por padrão. ` +
      "O executor não passa --experimental-strip-types, então a faixa é falsa.",
  );
});

test("3. a forma declarada em `npm test` executa de verdade neste Node", (t) => {
  if (EH_FILHO) { t.skip("processo filho: não reentra no runner"); return; }
  // Não roda a suíte inteira aqui — isso seria recursão e meia hora. Roda a MESMA
  // forma de invocação do executor contra um arquivo só, e exige sumário real.
  const r = spawnSync(process.execPath, ["--test", ALVO], {
    cwd: RAIZ,
    encoding: "utf8",
    timeout: 120_000,
    env: ambienteLimpo({ NOMOS_ENTRADA_PUBLICA_FILHO: "1" }),
  });

  assert.equal(r.error, undefined, `falha ao invocar o runner: ${String(r.error)}`);
  const saida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.doesNotMatch(
    saida,
    /run\(\) is being called recursively/,
    "o filho herdou a marca de contexto do runner e não executou nada. " +
      "Um exit 0 aqui seria falso: ajuste ambienteLimpo(), não a asserção.",
  );
  assert.doesNotMatch(
    saida,
    /MODULE_NOT_FOUND/,
    `o runner não conseguiu carregar ${ALVO}:\n${saida.slice(0, 800)}`,
  );
  // Sumário presente = rodou de fato. Saída truncada sem sumário é o modo de
  // falha perigoso que o executor foi escrito para expor.
  assert.match(saida, /^[#ℹ] pass \d+/m, `sem linha de sumário — não dá para afirmar que rodou:\n${saida.slice(0, 800)}`);
});

test("4. controle de mutação: a forma antiga (diretório nu) reprova neste Node", (t) => {
  if (EH_FILHO) { t.skip("processo filho: não reentra no runner"); return; }
  if (MAIOR_ATUAL < 23) {
    t.skip(
      `Node ${process.versions.node}: a forma antiga AINDA funciona aqui. ` +
        "O controle só tem sentido em 23+, onde o defeito aparece. " +
        "Reexecute este arquivo em Node >= 23 para exercer a mutação.",
    );
    return;
  }

  const r = spawnSync(process.execPath, ["--test", "tests/"], {
    cwd: RAIZ,
    encoding: "utf8",
    timeout: 120_000,
    env: ambienteLimpo(),
  });
  const saida = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  assert.notEqual(
    r.status,
    0,
    "a forma antiga passou — o defeito que este arquivo guarda não existe mais " +
      "ou o teste 1 está medindo a coisa errada. Reveja antes de relaxar a regra.",
  );
  assert.match(
    saida,
    /MODULE_NOT_FOUND|Cannot find module/,
    `a forma antiga falhou por OUTRO motivo, não pelo que este arquivo documenta:\n${saida.slice(0, 800)}`,
  );
});

test("5. o executor citado pelo script existe e é executável", () => {
  const script = pkg.scripts["test"];
  const m = /([\w./-]*scripts\/[\w.-]+\.sh)/.exec(script);
  assert.ok(m !== null, `script \`test\` não aponta para um executor conhecido: ${script}`);
  const alvo = path.join(RAIZ, m[1]!);
  // `bash -n` analisa sem executar: prova que o arquivo existe e é shell válido.
  execFileSync("bash", ["-n", alvo], { stdio: "pipe" });
});
