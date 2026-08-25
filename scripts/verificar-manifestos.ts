#!/usr/bin/env node
/**
 * FASE 17 — TODO PACOTE TEM MANIFESTO, E TODO MANIFESTO É COERENTE.
 *
 * Antes desta fase só `cli`, `mcp` e `sdk` tinham `package.json`: `api`, `core`,
 * `observability`, `skills` e `ui` eram diretórios dentro de um workspace
 * `packages/*` sem nome, sem licença e sem `exports`. Isso não é cosmético —
 * é o que faz `npm ci` tratar meio repositório como pasta anônima e o que
 * transformaria o primeiro empacotamento numa arqueologia.
 *
 * Este verificador é o instrumento que impede a volta do estado anterior: um
 * pacote NOVO sem manifesto reprova o estágio `fast` no mesmo dia em que nasce.
 *
 * Sobre `repository`: este repositório NÃO tem remote (`git remote -v` é vazio).
 * Escrever uma URL de GitHub no manifesto seria declarar um fato inexistente,
 * então os manifestos usam `git+file:../..` — que diz a verdade (o repositório é
 * esta árvore) e não vaza o caminho absoluto do dono. Quando houver remote, este
 * verificador é o lugar onde a exigência muda.
 *
 * Uso: node scripts/verificar-manifestos.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LICENCA = "SEE LICENSE IN LICENSE";

interface Manifesto {
  name?: unknown; version?: unknown; type?: unknown; license?: unknown;
  engines?: unknown; repository?: unknown; files?: unknown; exports?: unknown;
  main?: unknown; bin?: unknown; dependencies?: unknown; private?: unknown;
}

const problemas: string[] = [];
const p = (msg: string): void => { problemas.push(msg); };

const raiz = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")) as Manifesto & {
  version: string; engines: Record<string, string>; dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>; workspaces?: string[];
};

const depsRaiz: Record<string, string> = { ...(raiz.dependencies ?? {}), ...(raiz.devDependencies ?? {}) };

const dir = path.join(RAIZ, "packages");
const pacotes = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

if (pacotes.length === 0) p("packages/ está vazio — verificador no lugar errado?");

const nomes = new Map<string, string>();

for (const nome of pacotes) {
  const base = path.join(dir, nome);
  const arq = path.join(base, "package.json");
  if (!fs.existsSync(arq)) {
    // O defeito que este verificador existe para pegar.
    p(`packages/${nome}: SEM package.json — é membro de workspaces "packages/*" e não tem manifesto`);
    continue;
  }
  let m: Manifesto;
  try {
    m = JSON.parse(fs.readFileSync(arq, "utf8")) as Manifesto;
  } catch (e) {
    p(`packages/${nome}/package.json não é JSON válido: ${(e as Error).message}`);
    continue;
  }
  const q = (msg: string): void => p(`packages/${nome}: ${msg}`);

  if (typeof m.name !== "string" || !m.name.startsWith("@nomos/")) q(`name deve ter escopo @nomos/, veio ${JSON.stringify(m.name)}`);
  else if (nomes.has(m.name)) q(`name "${m.name}" já usado por ${nomes.get(m.name)}`);
  else nomes.set(m.name, nome);

  // Versão coerente com a raiz: um pacote com versão própria num monorepo sem
  // build vira duas verdades sobre "que versão está rodando".
  if (m.version !== raiz.version) q(`version ${JSON.stringify(m.version)} diverge da raiz (${raiz.version})`);
  if (m.type !== "module") q(`type deve ser "module", veio ${JSON.stringify(m.type)}`);
  if (m.license !== LICENCA) q(`license deve ser ${JSON.stringify(LICENCA)}, veio ${JSON.stringify(m.license)}`);

  const eng = m.engines as Record<string, string> | undefined;
  if (eng === undefined || eng.node !== raiz.engines.node) q(`engines.node deve ser ${JSON.stringify(raiz.engines.node)}, veio ${JSON.stringify(eng?.node)}`);

  const rep = m.repository as { type?: unknown; url?: unknown; directory?: unknown } | undefined;
  if (rep === undefined || rep.type !== "git" || typeof rep.url !== "string" || rep.url === "") q("repository ausente ou sem type/url");
  else if (rep.directory !== `packages/${nome}`) q(`repository.directory deve ser "packages/${nome}", veio ${JSON.stringify(rep.directory)}`);

  if (!Array.isArray(m.files) || m.files.length === 0) q("files ausente ou vazio");
  else for (const f of m.files as string[]) {
    if (!fs.existsSync(path.join(base, f))) q(`files aponta para "${f}", que não existe`);
  }

  // `exports` tem de apontar para arquivo REAL. Não há build: o alvo é o .ts.
  const alvos: [string, string][] = [];
  const colher = (chave: string, valor: unknown): void => {
    if (typeof valor === "string") alvos.push([chave, valor]);
    else if (valor !== null && typeof valor === "object") {
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) colher(`${chave}${k}`, v);
    }
  };
  if (m.exports === undefined) q("exports ausente");
  else colher("", m.exports);
  if (typeof m.main === "string") alvos.push(["main", m.main]);
  if (m.bin !== undefined && typeof m.bin === "object") {
    for (const [k, v] of Object.entries(m.bin as Record<string, string>)) alvos.push([`bin.${k}`, v]);
  }

  for (const [chave, alvo] of alvos) {
    if (alvo.includes("*")) {
      // Curinga: o que dá para conferir é o DIRETÓRIO e que ele tenha .ts.
      const pasta = path.join(base, path.dirname(alvo.replace("*", "x")));
      if (!fs.existsSync(pasta) || !fs.readdirSync(pasta).some((f) => f.endsWith(".ts"))) {
        q(`exports "${chave}" aponta para ${alvo}, e ${path.relative(base, pasta)} não tem .ts`);
      }
      continue;
    }
    if (!alvo.endsWith(".ts")) q(`exports/main "${chave}" aponta para ${alvo} — não há build neste repositório, o alvo tem de ser o .ts real`);
    if (!fs.existsSync(path.join(base, alvo))) q(`exports/main "${chave}" aponta para ${alvo}, que não existe`);
  }

  // Dependência declarada tem de estar PINADA e bater com a da raiz — senão o
  // workspace instala uma versão e o pacote promete outra.
  for (const [dep, ver] of Object.entries((m.dependencies ?? {}) as Record<string, string>)) {
    if (/^[\^~]|latest/.test(ver)) q(`dependência não pinada: ${dep}@${ver}`);
    if (depsRaiz[dep] !== undefined && depsRaiz[dep] !== ver) q(`${dep}@${ver} diverge da raiz (${depsRaiz[dep]})`);
  }
}

// Diretório vazio dentro de `packages/` é membro de workspace sem manifesto:
// npm o trata como pacote anônimo. O caso real foi `packages/native`, que nem
// existia no HEAD (git não versiona diretório vazio) — removido, não "reservado":
// reservar exigiria ACRESCENTAR um arquivo para descrever um pacote inexistente.
for (const nome of pacotes) {
  const conteudo = fs.readdirSync(path.join(dir, nome));
  if (conteudo.length === 0) p(`packages/${nome}: diretório vazio dentro do workspace`);
}

if (problemas.length > 0) {
  console.error("PACKAGE_MANIFESTS_COMPLETE=NO");
  for (const x of problemas) console.error(`  - ${x}`);
  process.exit(1);
}
console.log(`PACKAGE_MANIFESTS_COMPLETE=YES (${pacotes.length} pacotes: ${pacotes.join(", ")})`);
