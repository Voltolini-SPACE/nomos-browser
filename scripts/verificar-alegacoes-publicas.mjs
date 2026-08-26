#!/usr/bin/env node
// Todo numero que o produto diz em publico tem que sair de uma medicao.
//
// Este verificador existe porque o lancamento encontrou o mesmo fato dito com
// dois numeros diferentes: o README dizia "789 passes / 37 arquivos" e a pagina
// publica dizia "792 testes". Nao da para consertar isso escolhendo um dos dois.
// Ou se mede, ou nao se publica.
//
// Cada alegacao aqui tem uma FONTE executavel. Quando a medicao e impossivel
// agora (a contagem de passes exige a suite rodada), o verificador diz
// NAO_MEDIDO e reprova — em vez de assumir que o numero antigo continua valendo.
//
// Uso:
//   node scripts/verificar-alegacoes-publicas.mjs [--site CAMINHO_HTML] [--corrigir]

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CORRIGIR = args.includes("--corrigir");
const iSite = args.indexOf("--site");
const SITE = iSite >= 0 ? args[iSite + 1] : null;
// A pagina do produto nao e o unico lugar publico que fala numeros do produto.
// O HUB do site tambem tem um cartao do NOMOS Browser, com contagem de testes —
// e ele ficou para tras quando a /browser/ foi corrigida de 792 para 797. O
// verificador nao viu porque nunca tinha sido ensinado a olhar para la. Um
// verificador de alegacoes que so conhece uma pagina da uma sensacao de cobertura
// que ele nao tem.
const iHub = args.indexOf("--hub");
const HUB = iHub >= 0 ? args[iHub + 1] : null;
// A medicao que vale e a da SALA LIMPA, feita a partir do remoto publicado, e
// nao a da minha working tree. `--resumo` deixa a origem do numero explicita em
// vez de deixa-la implicita no diretorio onde eu por acaso rodei.
const iRes = args.indexOf("--resumo");
const RESUMO_ARG = iRes >= 0 ? args[iRes + 1] : null;

const ler = (rel) => readFileSync(path.join(RAIZ, rel), "utf8");

// ── medicoes ────────────────────────────────────────────────────────────────
const medidas = {};
const notas = {};

// arquivos de teste: conta o que existe, nao o que alguem lembrou
{
  const { execFileSync } = await import("node:child_process");
  const saida = execFileSync("git", ["ls-files", "tests/"], { cwd: RAIZ, encoding: "utf8" });
  medidas.arquivos_teste = saida.split("\n").filter((l) => /^tests\/[^/]+\.test\.ts$/.test(l)).length;
}

// ferramentas MCP: nomes declarados no registro, deduplicados
{
  const s = ler("packages/mcp/src/tools.ts");
  const nomes = new Set([...s.matchAll(/name:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  medidas.ferramentas_mcp = nomes.size;
}

// comandos da CLI: as chaves do registro COMMANDS.
// `replay verify` NAO conta como comando separado — o proprio codigo diz que a
// CLI "nao tem subcomandos de verdade". Contar a linha de ajuda em vez da chave
// era o que produzia "9".
{
  const s = ler("packages/cli/src/main.ts");
  const i = s.indexOf("const COMMANDS");
  const bloco = s.slice(i, i + 6000);
  const chaves = [...bloco.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*\{/gm)].map((m) => m[1]);
  medidas.comandos_cli = new Set(chaves).size;
  notas.comandos_cli = "chaves de COMMANDS; `replay verify` e forma de invocacao, nao comando";
}

// demos: os casos declarados no executor de demos
{
  const s = ler("demos/rodar-demos.mjs");
  // As demos se anunciam chamando demo("A", ...). Contar a CHAMADA e contar o
  // que roda; contar um array de configuracao contaria o que alguem escreveu.
  const ids = new Set([...s.matchAll(/^\s*demo\("([A-Z])"/gm)].map((m) => m[1]));
  medidas.demos = ids.size;
}

// passes da suite: so existe se a suite rodou. Sem resumo, NAO_MEDIDO.
{
  const resumo = RESUMO_ARG ?? path.join(RAIZ, ".suite", "resumo.tsv");
  if (existsSync(resumo)) {
    // A primeira linha e cabecalho. Conta-la como arquivo produzia um
    // "1 arquivo ruim" que nunca existiu — o instrumento acusando a si mesmo.
    const todas = readFileSync(resumo, "utf8").trim().split("\n").filter(Boolean);
    const linhas = todas[0]?.startsWith("arquivo\t") ? todas.slice(1) : todas;
    let pass = 0, fail = 0, ruins = 0, arquivos = 0;
    for (const l of linhas) {
      const [, status, p, f] = l.split("\t");
      arquivos += 1;
      pass += Number(p) || 0;
      fail += Number(f) || 0;
      if (status !== "OK") ruins += 1;
    }
    // Um resumo com MENOS arquivos do que existem em tests/ esta incompleto:
    // ou a suite ainda esta rodando, ou alguem a esta reescrevendo agora. Ja
    // aconteceu duas vezes nesta missao — o verificador leu um arquivo do qual
    // outro processo era dono e devolveu `medido=0` contra `declarado=797`, que
    // parece contradicao de alegacao e nao e. Numero parcial e pior do que
    // numero nenhum, porque tem cara de medicao.
    if (arquivos < medidas.arquivos_teste) {
      medidas.suite_pass = null;
      medidas.suite_fail = null;
      medidas.suite_arquivos = arquivos;
      medidas.suite_arquivos_ruins = null;
      notas.suite_pass =
        `NAO_MEDIDO: resumo com ${arquivos} arquivo(s) para ${medidas.arquivos_teste} em tests/. ` +
        "Incompleto ou sendo reescrito. Espere a suite terminar e meca de novo.";
    } else {
      medidas.suite_pass = pass;
      medidas.suite_fail = fail;
      medidas.suite_arquivos = arquivos;
      medidas.suite_arquivos_ruins = ruins;
    }
  } else {
    medidas.suite_pass = null;
    notas.suite_pass = "NAO_MEDIDO: .suite/resumo.tsv ausente. Rode `npm test` antes de publicar numero de teste.";
  }
}

// ── alegacoes declaradas nos textos publicos ────────────────────────────────
const alegacoes = [];
function declara(arquivo, rotulo, regex, medida) {
  if (!existsSync(path.join(RAIZ, arquivo)) && !arquivo.startsWith("/")) return;
  const texto = arquivo.startsWith("/") ? readFileSync(arquivo, "utf8") : ler(arquivo);
  const m = regex.exec(texto);
  if (m === null) {
    alegacoes.push({ arquivo, rotulo, declarado: null, medido: medidas[medida], ok: null,
      obs: "alegacao nao encontrada — o texto mudou de forma; o verificador ficou cego aqui" });
    return;
  }
  const declarado = Number(m[1]);
  const medido = medidas[medida];
  const ok = medido === null || medido === undefined ? null : declarado === medido;
  alegacoes.push({ arquivo, rotulo, declarado, medido, ok, obs: notas[medida] ?? "" });
}

declara("README.md", "ferramentas MCP (tabela)", /\*\*23 verbos, (\d+) ferramentas MCP\*\*/, "ferramentas_mcp");
declara("README.md", "ferramentas MCP (secao)", /^(\d+) ferramentas, sem acoplamento a modelo:/m, "ferramentas_mcp");
declara("PRODUCT_MANIFEST.md", "ferramentas MCP", /### MCP — (\d+) ferramentas/, "ferramentas_mcp");
declara("PRODUCT_MANIFEST.md", "comandos CLI", /### CLI — `nomos-web` \((\d+) comandos\)/, "comandos_cli");
declara("README.md", "arquivos de teste", /(\d+)\/\d+ arquivos/, "arquivos_teste");
declara("README.md", "passes da suite", /suíte TypeScript\s+(\d+) passes/, "suite_pass");

if (SITE !== null && existsSync(SITE)) {
  const t = readFileSync(SITE, "utf8");
  const push = (rotulo, re, medida) => {
    const m = re.exec(t);
    const medido = medidas[medida];
    alegacoes.push({
      arquivo: SITE, rotulo,
      declarado: m === null ? null : Number(m[1]),
      medido, ok: m === null || medido === null || medido === undefined ? null : Number(m[1]) === medido,
      obs: m === null ? "alegacao nao encontrada na pagina" : (notas[medida] ?? ""),
    });
  };
  push("site · passes da suite", /<div class="big">(\d+)<\/div><div class="lbl">testes automatizados/, "suite_pass");
  push("site · arquivos de teste", /testes automatizados, (\d+) arquivos/, "arquivos_teste");
  push("site · demos", /<div class="big">(\d+)<\/div><div class="lbl">demos/, "demos");
  push("site · ferramentas MCP", /MCP<\/h3><p>(\d+) ferramentas/, "ferramentas_mcp");
  // "nove comandos" por extenso: o verificador tem que enxergar a palavra.
  const porExtenso = { oito: 8, nove: 9, dez: 10, sete: 7 };
  const mc = /<code>nomos-web<\/code> com (\w+) comandos/.exec(t);
  alegacoes.push({
    arquivo: SITE, rotulo: "site · comandos CLI",
    declarado: mc === null ? null : (porExtenso[mc[1]] ?? NaN),
    medido: medidas.comandos_cli,
    ok: mc === null ? null : (porExtenso[mc[1]] ?? NaN) === medidas.comandos_cli,
    obs: notas.comandos_cli ?? "",
  });
}

if (HUB !== null && existsSync(HUB)) {
  const t = readFileSync(HUB, "utf8");
  const m = /<span class="contador" data-alvo="(\d+)"><\/span>?\s*testes automatizados e (\d+) casos ponta a ponta/.exec(t)
        ?? /data-alvo="(\d+)">0<\/span> testes automatizados e (\d+) casos ponta a ponta/.exec(t);
  alegacoes.push({
    arquivo: HUB, rotulo: "hub · passes da suite",
    declarado: m === null ? null : Number(m[1]),
    medido: medidas.suite_pass,
    ok: m === null || medidas.suite_pass === null ? null : Number(m[1]) === medidas.suite_pass,
    obs: m === null ? "cartao do NOMOS Browser nao encontrado no hub — o texto mudou de forma" : "",
  });
}

// ── relatorio ───────────────────────────────────────────────────────────────
console.log("ALEGACOES_PUBLICAS");
console.log(`fonte_da_medicao_da_suite=${medidas.suite_pass === null ? "AUSENTE" : (RESUMO_ARG ?? ".suite/resumo.tsv")}`);
console.log("");
console.log("medido:");
for (const [k, v] of Object.entries(medidas)) {
  console.log(`  ${k.padEnd(22)} ${v === null ? "NAO_MEDIDO" : v}${notas[k] ? `   (${notas[k]})` : ""}`);
}
console.log("");
console.log("declarado vs medido:");
let ruins = 0, cegas = 0;
for (const a of alegacoes) {
  const marca = a.ok === true ? "ok  " : a.ok === false ? "RUIM" : "??  ";
  if (a.ok === false) ruins += 1;
  if (a.ok === null) cegas += 1;
  console.log(
    `  ${marca} ${a.rotulo.padEnd(28)} declarado=${String(a.declarado).padEnd(6)} medido=${String(a.medido)}` +
      `${a.obs ? `\n         ${a.obs}` : ""}`,
  );
}
console.log("");
console.log(`ALEGACOES_CONTRADITORIAS=${ruins}`);
console.log(`ALEGACOES_NAO_VERIFICAVEIS=${cegas}`);
console.log(`UNPROVEN_PUBLIC_CLAIMS=${ruins + cegas}`);
process.exit(ruins + cegas === 0 ? 0 : 1);
