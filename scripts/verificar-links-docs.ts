/**
 * Guarda de links da documentação.
 *
 * Um README que promete um documento inexistente é pior do que um README curto:
 * ele gasta a confiança de quem clica. Esta guarda percorre os markdown do
 * repositório e confere que todo link RELATIVO aponta para arquivo que existe.
 *
 * Links externos (http/https) não são buscados: a rede não é responsabilidade
 * desta guarda, e um teste que depende dela falha por motivo errado.
 *
 * Cuidado extra que vale explicar: a comparação de nome é SENSÍVEL A MAIÚSCULA,
 * mesmo no macOS. `docs/security.md` e `docs/SECURITY.md` são o mesmo arquivo
 * aqui e arquivos DIFERENTES no GitHub — um link que só funciona na máquina de
 * quem escreveu é um link quebrado que ninguém vê.
 *
 * Uso:  node scripts/verificar-links-docs.ts [--autoteste]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `evidence/` fica de fora de propósito: é REGISTRO do que foi medido, não
// navegação. Uma cópia arquivada de um README antigo tem links relativos a
// outra profundidade, e reportá-los afogaria os quebrados que importam.
const IGNORAR = new Set(["node_modules", ".git", "dist", ".suite", "_gerado", "evidence"]);

function markdowns(dir: string, achados: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const alvo = path.join(dir, e.name);
    if (e.isDirectory()) markdowns(alvo, achados);
    else if (e.name.endsWith(".md")) achados.push(alvo);
  }
  return achados;
}

/** Lista real do diretório: é o que torna a checagem sensível a maiúscula. */
const cacheDir = new Map<string, Set<string>>();
function existeExato(alvo: string): boolean {
  const dir = path.dirname(alvo);
  if (!cacheDir.has(dir)) {
    try { cacheDir.set(dir, new Set(fs.readdirSync(dir))); }
    catch { cacheDir.set(dir, new Set()); }
  }
  return cacheDir.get(dir)!.has(path.basename(alvo));
}

export interface LinkQuebrado { arquivo: string; link: string; resolvido: string; }

export function quebrados(raiz: string): LinkQuebrado[] {
  const fora: LinkQuebrado[] = [];
  for (const arquivo of markdowns(raiz)) {
    const texto = fs.readFileSync(arquivo, "utf8");
    for (const m of texto.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const cru = m[1]!;
      if (/^(https?:|mailto:|#)/.test(cru)) continue;
      const semAncora = cru.split("#")[0]!;
      if (semAncora === "") continue;
      const resolvido = path.resolve(path.dirname(arquivo), decodeURIComponent(semAncora));
      if (!existeExato(resolvido)) {
        fora.push({ arquivo: path.relative(raiz, arquivo), link: cru, resolvido: path.relative(raiz, resolvido) });
      }
    }
  }
  return fora;
}

/** Autoteste com CONTROLE: um link bom passa, um link quebrado é pego. */
function autoteste(): number {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-links-"));
  try {
    fs.writeFileSync(path.join(tmp, "existe.md"), "# ok\n");
    fs.writeFileSync(path.join(tmp, "a.md"), "[bom](existe.md) e [ruim](nao-existe.md)\n");
    const r = quebrados(tmp);
    if (r.length !== 1) throw new Error(`autoteste: esperava 1 quebrado, achou ${r.length}`);
    if (r[0]!.link !== "nao-existe.md") throw new Error(`autoteste: pegou o link errado (${r[0]!.link})`);

    // Controle de maiúscula: no macOS o arquivo abre, mas o NOME não bate.
    fs.writeFileSync(path.join(tmp, "b.md"), "[caixa errada](EXISTE.md)\n");
    const r2 = quebrados(tmp).filter((x) => x.link === "EXISTE.md");
    if (r2.length !== 1) throw new Error("autoteste: link com caixa errada passou despercebido");

    console.log("AUTOTESTE_LINKS=PASS (pega link ausente e caixa divergente)");
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--autoteste")) process.exit(autoteste());

const r = quebrados(RAIZ);
for (const q of r) console.error(`  QUEBRADO  ${q.arquivo}  →  ${q.link}`);
console.log(`\nDOCS_LINKS_OK=${r.length === 0 ? "YES" : "NO"} (${r.length} quebrado(s))`);
process.exit(r.length === 0 ? 0 : 1);
