/**
 * Marca uma versão nova em TODOS os declarantes de uma vez.
 *
 * Por que existe: a versão do NOMOS Browser vive em 13 lugares (raiz, oito
 * workspaces, `CLI_VERSION`, `SERVER_VERSION`, o cliente Python e o
 * `pyproject.toml`). Bater em cada um à mão é como se perde a coerência — e a
 * incoerência é silenciosa: o `--version` da CLI diria uma coisa, o
 * `package.json` outra, e o usuário não teria como saber qual acreditar.
 *
 * A lista NÃO é redigitada aqui: vem de `declarantes()` do próprio verificador.
 * Duas listas divergiriam no dia em que um pacote novo nascesse, e o bug seria
 * "o verificador reprova mas o marcador não sabe o que corrigir".
 *
 * Uso:
 *   node scripts/marcar-versao.ts 0.3.0-rc.1        aplica
 *   node scripts/marcar-versao.ts 0.3.0-rc.1 --seco mostra o que faria
 *   node scripts/marcar-versao.ts --autoteste       prova em cópia temporária
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { declarantes } from "./verificar-versao-coerente.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** SemVer com pré-lançamento opcional. Recusa o que não for versão. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Troca a versão no texto do arquivo, preservando tudo o mais.
 *
 * Substituição CIRÚRGICA, nunca global: um `replace` do valor antigo em todo o
 * arquivo trocaria também qualquer menção casual àquele número — por exemplo um
 * comentário citando "0.2.0" como versão histórica, que passaria a mentir.
 */
function trocar(texto: string, como: string, nova: string): string | null {
  if (como === '"version"') {
    const d = JSON.parse(texto) as Record<string, unknown>;
    if (typeof d.version !== "string") return null;
    // Regex ancorada na CHAVE, para não tocar em version de dependência.
    return texto.replace(/("version"\s*:\s*")[^"]+(")/, `$1${nova}$2`);
  }
  if (como === "CLI_VERSION" || como === "SERVER_VERSION" || como === "SDK_VERSION") {
    const re = new RegExp(`(${como} = ")[^"]+(")`);
    return re.test(texto) ? texto.replace(re, `$1${nova}$2`) : null;
  }
  if (como === "version") {
    const re = /^(version = ")[^"]+(")/m;
    return re.test(texto) ? texto.replace(re, `$1${nova}$2`) : null;
  }
  return null;
}

export function marcar(raiz: string, nova: string, seco: boolean): { arquivo: string; de: string | null }[] {
  const tocados: { arquivo: string; de: string | null }[] = [];
  for (const d of declarantes()) {
    const alvo = path.join(raiz, d.arquivo);
    if (!fs.existsSync(alvo)) continue;
    const texto = fs.readFileSync(alvo, "utf8");
    const de = d.ler(texto);
    const novoTexto = trocar(texto, d.como, nova);
    if (novoTexto === null) {
      throw new Error(`versão: não soube trocar ${d.como} em ${d.arquivo} — abortando para não deixar meia troca`);
    }
    if (!seco) fs.writeFileSync(alvo, novoTexto, "utf8");
    tocados.push({ arquivo: d.arquivo, de });
  }
  return tocados;
}

/**
 * Autoteste com CONTROLE NEGATIVO.
 *
 * Um marcador que não marcasse nada e devolvesse sucesso passaria num teste que
 * só verifica "não explodiu". Aqui a cópia é lida DEPOIS e tem que ter mudado —
 * e o controle confirma que ela começou diferente.
 */
function autoteste(): number {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-versao-"));
  try {
    const alvo = path.join(tmp, "package.json");
    fs.mkdirSync(path.join(tmp, "packages"), { recursive: true });
    fs.writeFileSync(alvo, JSON.stringify({ name: "x", version: "0.0.1", dependencies: { ws: "0.0.1" } }, null, 2));

    const antes = JSON.parse(fs.readFileSync(alvo, "utf8")) as { version: string; dependencies: Record<string, string> };
    if (antes.version !== "0.0.1") throw new Error("autoteste: controle falhou, a cópia não começou em 0.0.1");

    const texto = trocar(fs.readFileSync(alvo, "utf8"), '"version"', "9.9.9");
    if (texto === null) throw new Error("autoteste: trocar() devolveu null");
    fs.writeFileSync(alvo, texto);

    const depois = JSON.parse(fs.readFileSync(alvo, "utf8")) as { version: string; dependencies: Record<string, string> };
    if (depois.version !== "9.9.9") throw new Error(`autoteste: versão não trocou (${depois.version})`);
    // O que separa "trocou a versão" de "trocou toda ocorrência do número":
    if (depois.dependencies.ws !== "0.0.1") {
      throw new Error("autoteste: a troca vazou para a versão de uma DEPENDÊNCIA");
    }
    console.log("AUTOTESTE_MARCAR_VERSAO=PASS (troca a chave certa e não toca em dependência)");
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--autoteste")) {
  process.exit(autoteste());
}

const nova = argv.find((a) => !a.startsWith("--"));
if (nova === undefined || !SEMVER.test(nova)) {
  console.error("uso: node scripts/marcar-versao.ts <semver> [--seco]");
  console.error("     node scripts/marcar-versao.ts --autoteste");
  if (nova !== undefined) console.error(`\n"${nova}" não é SemVer válido.`);
  process.exit(2);
}
const seco = argv.includes("--seco");
const tocados = marcar(RAIZ, nova, seco);
for (const t of tocados) console.log(`  ${seco ? "marcaria" : "marcou"}  ${t.de ?? "?"} → ${nova}  ${t.arquivo}`);
console.log(`\nVERSAO_MARCADA=${nova} em ${tocados.length} declarantes${seco ? " (ENSAIO SECO, nada escrito)" : ""}`);
