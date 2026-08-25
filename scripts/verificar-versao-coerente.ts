#!/usr/bin/env node
/**
 * FASE 100 — UMA VERSÃO SÓ, DECLARADA NUM LUGAR SÓ.
 *
 * O PROBLEMA QUE ESTE GUARDA EXISTE PARA IMPEDIR: a versão do produto aparecia
 * escrita à mão em TREZE lugares — `package.json` da raiz, os oito pacotes do
 * workspace, `CLI_VERSION`, `SERVER_VERSION`, `SDK_VERSION` e o
 * `pyproject.toml` do SDK Python. Nada obrigava esses treze a concordarem. Um
 * bump esquecido em `SERVER_VERSION` faria o servidor MCP anunciar no
 * `serverInfo` uma versão que não existe, e nenhum teste reprovaria: as
 * asserções eram contra o LITERAL "0.1.0", não contra a coerência. Quer dizer:
 * o teste que deveria pegar a deriva era exatamente o que precisava ser editado
 * a cada bump — e editar um teste para ele voltar a passar é como o defeito
 * entraria.
 *
 * Este guarda inverte isso: a raiz é a fonte, e todo o resto tem de bater com
 * ela. Um bump agora é UMA edição por arquivo declarante, e esquecer qualquer
 * um reprova aqui com o nome do arquivo.
 *
 * Não confere `package-lock.json`: ele é GERADO. Se a raiz mudou e o lock não,
 * quem reprova é `npm ci` (o guarda `deps:lock-em-dia` do `ci.sh fast`), que é
 * onde essa incoerência realmente dói.
 *
 * Controle negativo: `node scripts/verificar-versao-coerente.ts --autoteste`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Declarante {
  arquivo: string;
  como: string;
  ler: (texto: string) => string | null;
}

const JSON_VERSION = (t: string): string | null => {
  const d = JSON.parse(t) as { version?: unknown };
  return typeof d.version === "string" ? d.version : null;
};
const porRegex = (re: RegExp) => (t: string): string | null => re.exec(t)?.[1] ?? null;

export function declarantes(): Declarante[] {
  const pacotes = fs
    .readdirSync(path.join(RAIZ, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(RAIZ, "packages", e.name, "package.json")))
    .map((e) => ({
      arquivo: `packages/${e.name}/package.json`,
      como: '"version"',
      ler: JSON_VERSION,
    }));
  return [
    { arquivo: "package.json", como: '"version"', ler: JSON_VERSION },
    ...pacotes,
    {
      arquivo: "packages/cli/src/main.ts",
      como: "CLI_VERSION",
      ler: porRegex(/export const CLI_VERSION = "([^"]+)"/),
    },
    {
      arquivo: "packages/mcp/src/server.ts",
      como: "SERVER_VERSION",
      ler: porRegex(/export const SERVER_VERSION = "([^"]+)"/),
    },
    {
      arquivo: "sdk-python/nomos_browser/client.py",
      como: "SDK_VERSION",
      ler: porRegex(/^SDK_VERSION = "([^"]+)"/m),
    },
    {
      arquivo: "sdk-python/pyproject.toml",
      como: "version",
      ler: porRegex(/^version = "([^"]+)"/m),
    },
  ];
}

export interface Divergencia {
  arquivo: string;
  como: string;
  achado: string | null;
}

export function conferir(raiz: string, lista: Declarante[]): { esperada: string; divergencias: Divergencia[] } {
  const pkgRaiz = path.join(raiz, "package.json");
  const esperada = JSON_VERSION(fs.readFileSync(pkgRaiz, "utf8"));
  if (esperada === null) throw new Error("package.json da raiz não declara `version`");
  const divergencias: Divergencia[] = [];
  for (const d of lista) {
    const p = path.join(raiz, d.arquivo);
    if (!fs.existsSync(p)) {
      divergencias.push({ arquivo: d.arquivo, como: d.como, achado: null });
      continue;
    }
    const achado = d.ler(fs.readFileSync(p, "utf8"));
    if (achado !== esperada) divergencias.push({ arquivo: d.arquivo, como: d.como, achado });
  }
  return { esperada, divergencias };
}

function autoteste(): void {
  // Clona o mínimo para um diretório temporário e DERIVA um dos declarantes.
  const tmp = fs.mkdtempSync("/tmp/nb-versao-");
  const copiar = (rel: string) => {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, rel), dest);
  };
  copiar("package.json");
  copiar("packages/mcp/src/server.ts");
  const lista = [declarantes().find((d) => d.como === "SERVER_VERSION")!];

  if (conferir(tmp, lista).divergencias.length !== 0) {
    console.error("AUTOTESTE=FALHOU — acusou divergência onde não há.");
    process.exit(1);
  }
  const alvo = path.join(tmp, "packages/mcp/src/server.ts");
  fs.writeFileSync(
    alvo,
    fs.readFileSync(alvo, "utf8").replace(/export const SERVER_VERSION = "[^"]+"/,
      'export const SERVER_VERSION = "9.9.9-derivado"'),
    "utf8");
  const d = conferir(tmp, lista).divergencias;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (d.length !== 1 || d[0]!.achado !== "9.9.9-derivado") {
    console.error(`AUTOTESTE=FALHOU — o guarda NÃO viu a deriva: ${JSON.stringify(d)}`);
    process.exit(1);
  }
  console.log("AUTOTESTE=OK (vê a deriva; não acusa o coerente)");
}

function main(): void {
  if (process.argv.includes("--autoteste")) {
    autoteste();
    return;
  }
  const lista = declarantes();
  const { esperada, divergencias } = conferir(RAIZ, lista);
  if (divergencias.length > 0) {
    console.error(`VERSION_COHERENT=NO (raiz declara ${esperada})`);
    for (const d of divergencias) {
      console.error(`  - ${d.arquivo} (${d.como}): ${d.achado === null ? "AUSENTE" : d.achado}`);
    }
    process.exit(1);
  }
  console.log(`VERSION_COHERENT=YES (${esperada} em ${lista.length} declarantes)`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
