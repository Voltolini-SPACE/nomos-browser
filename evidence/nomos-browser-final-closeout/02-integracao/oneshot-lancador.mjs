#!/usr/bin/env node
// SOMBRA NÃO-CANÔNICA da prova. Existe por UM motivo: enquanto o manifesto está
// experimental, `nomos mcp chamar` recusa tudo (NOMOS-E002, comportamento certo)
// e a prova não teria como mostrar se a correção da sessão durável funciona.
//
// O que este arquivo NÃO é: um cliente MCP reimplementado com regalias. Ele faz
// exatamente o que o `ClienteMCP` do NOMOS faz na forma one-shot — sobe o
// `comando` DO MANIFESTO (`node servidor.mjs`, com cwd = diretório do
// manifesto), manda `initialize` + `tools/call` e encerra o processo. Nenhuma
// política é consultada aqui, e é por isso que toda saída sua é rotulada
// `via=lancador-direto (NAO-CANONICO)` e não vale PASS de gate nenhum.
//
// uso: node oneshot-lancador.mjs <tool> '<json-args>'
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR_MANIFESTO = path.resolve(AQUI, "../../../packaging/mcp");

const tool = process.argv[2];
const args = process.argv[3] ?? "{}";
if (tool === undefined) {
  process.stderr.write("uso: node oneshot-lancador.mjs <tool> '<json-args>'\n");
  process.exit(2);
}

const filho = spawn("node", ["servidor.mjs"], { cwd: DIR_MANIFESTO, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const respostas = [];
filho.stdout.setEncoding("utf8");
filho.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const linha = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (linha !== "") respostas.push(JSON.parse(linha));
  }
});
filho.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prova-closeout2" } } })}\n`);
filho.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(args) } })}\n`);
filho.stdin.end();
filho.on("close", () => {
  const r = respostas.find((x) => x.id === 2);
  if (r === undefined) {
    process.stdout.write("SEM_RESPOSTA\n");
    process.exit(1);
  }
  if (r.error !== undefined) {
    process.stdout.write(`RPC_ERROR code=${r.error.code} message=${r.error.message}\n`);
    process.exit(0);
  }
  const texto = (r.result?.content ?? []).map((c) => c.text).join("\n");
  process.stdout.write(`${texto}\n`);
  process.stdout.write(`isError=${r.result?.isError === true}\n`);
});
