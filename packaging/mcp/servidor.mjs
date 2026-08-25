#!/usr/bin/env node
// FASE 7 — LANCADOR DO CONECTOR MCP PARA O NOMOS.
//
// Por que existe um lancador e nao `["node", "../../packages/mcp/src/server.ts"]`
// direto no manifesto: o `comando` do manifesto entra no SHA-256 de confianca
// (mcp_catalogo.impressao) e o NOMOS o executa com `cwd` = diretorio do
// manifesto. Um caminho com `../..` no manifesto amarra a confianca ao LAYOUT do
// repositorio: mover a pasta muda o comando, muda o hash e derruba a confianca
// que o dono ja aprovou. Este arquivo fica AO LADO do manifesto, e resolve o
// servidor a partir do PROPRIO caminho (import.meta.url), nao do cwd.
//
// O lancador nao decide nada: nao injeta credencial, nao escolhe sessao, nao
// mexe em politica. Ele so arranca o `server.ts` no modo stdio.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SERVIDOR = path.resolve(AQUI, "../../packages/mcp/src/server.ts");

// CREDENCIAL — OPT-IN EXPLICITO, NUNCA ADIVINHADA.
//
// O caminho normal e `NOMOS_BROWSER_TOKEN` no ambiente. `NOMOS_BROWSER_TOKEN_FILE`
// existe porque `nomos mcp chamar` herda o ambiente do terminal do dono, e
// exportar segredo em shell o deixa no historico. O que este bloco NAO faz:
// procurar `~/.nomos-browser/control-token` por conta propria. Ler o cofre do
// dono sem que ele tenha pedido seria o adaptador se autoconceder credencial —
// e a recusa por falta de token (MCP_NO_CREDENTIAL) deixaria de ser provavel.
if (
  (process.env.NOMOS_BROWSER_TOKEN === undefined || process.env.NOMOS_BROWSER_TOKEN === "") &&
  typeof process.env.NOMOS_BROWSER_TOKEN_FILE === "string" &&
  process.env.NOMOS_BROWSER_TOKEN_FILE !== ""
) {
  try {
    const t = readFileSync(process.env.NOMOS_BROWSER_TOKEN_FILE, "utf8").trim();
    if (t !== "") process.env.NOMOS_BROWSER_TOKEN = t;
  } catch (err) {
    // stdout carrega SOMENTE JSON-RPC. Diagnostico vai para stderr — que o
    // ClienteMCP do NOMOS manda para DEVNULL, entao isto e para quem roda a mao.
    process.stderr.write(
      `[nomos-browser-mcp] NOMOS_BROWSER_TOKEN_FILE ilegivel: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

const { createMcpServer, startStdio } = await import(pathToFileURL(SERVIDOR).href);

try {
  startStdio(createMcpServer());
} catch (err) {
  process.stderr.write(`[nomos-browser-mcp] arranque falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
