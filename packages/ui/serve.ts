/**
 * Servidor estático de desenvolvimento para a NOMOS Web.
 *
 * Em produção quem serve a UI é o próprio daemon (packages/api). Este script
 * existe para inspecionar a peça sem subir o runtime inteiro — e porque ele
 * roda o build antes de servir, garantindo que o que aparece na tela veio do
 * cofre agora, não de um dist velho com token defasado.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOMOS_UI_PORT ?? 7788);

const r = build();
console.log(`build: ${r.saida}`);
console.log(`marca: ${r.selo}`);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url?.startsWith("/index.html") || req.url?.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(path.join(HERE, "dist", "index.html")));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`NOMOS Web (dev) em http://127.0.0.1:${PORT}`);
});
