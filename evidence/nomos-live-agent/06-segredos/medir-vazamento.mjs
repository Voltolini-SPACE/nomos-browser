// ─────────────────────────────────────────────────────────────────────────────
// FASE 17 — SEGREDO NA TELA E NA TRILHA. Medir ANTES de corrigir.
//
// O canário é uma string única. Depois de mandar digitá-lo num campo de senha,
// o teste procura por ele em TODAS as superfícies que o Live Agent criou:
//
//   · o pedido de aprovação (o que o usuário vê antes de decidir)
//   · o estado ao vivo (`/live`, que a tela consulta a cada 700 ms)
//   · a lista de aprovações
//   · a trilha de auditoria em disco, e o diretório de runtime inteiro
//
// Procurar o canário é diferente de "conferir se a redação funciona": a segunda
// pergunta pressupõe saber onde olhar. A primeira encontra o vazamento em
// lugares que ninguém pensou em blindar.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LA ?? 7798);
const PORTA_FIX = Number(process.env.PORTA_FIX ?? 8911);
const DIR = "/tmp/la-seg-runtime";
const SESSOES = "/tmp/la-seg-sessoes";
const CANARIO = "CANARIO-SEGREDO-" + Math.random().toString(36).slice(2, 10).toUpperCase();

let DAEMON = null;
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "VAZOU"}] ${nome} — ${obs}`); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>Login</title></head><body>
<input id="usuario" type="text">
<input id="senha" type="password">
<div id="saida">INTOCADO</div>
</body></html>`;

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-segredos",
                   authorization: `Bearer ${token}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}"), bruto: b }); }
          catch { resolve({ status: res.statusCode, corpo: {}, bruto: b }); } }); });
    q.on("error", reject);
    if (dados) q.write(dados);
    q.end();
  });
}
async function ate(fn, ms, rotulo) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { try { const v = await fn(); if (v) return v; } catch { /* de novo */ } await espera(150); }
  throw new Error(`tempo esgotado: ${rotulo}`);
}
function varrer(dir) {
  const achados = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { andar(p); continue; }
      let txt = "";
      try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (txt.includes(CANARIO)) achados.push(p);
    }
  };
  try { andar(dir); } catch { /* dir some */ }
  return achados;
}

async function main() {
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const fixture = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML);
  });
  await new Promise((r) => fixture.listen(PORTA_FIX, "127.0.0.1", r));

  DAEMON = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"] });
  DAEMON.stdout.on("data", () => {}); DAEMON.stderr.on("data", () => {});

  let token = "";
  for (let i = 0; i < 40 && token === ""; i += 1) {
    await espera(400);
    try { token = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  await ate(async () => ((await req("GET", "/health", undefined, token)).status === 200 ? true : null), 20000, "porta");

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "gi", capabilities: { navigate: true, read: true, click: true, type: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" }, token);
  console.log(`# daemon :${PORTA} · sessão ${sid} · canário ${CANARIO}`);

  const digitar = req("POST", "/api/v1/browser.type",
    { session_id: sid, target: { selector: "#senha" }, text: CANARIO }, token);
  digitar.catch(() => {});

  const estado = await ate(async () => {
    const v = await req("GET", `/api/v1/sessions/${sid}/live`, undefined, token);
    return ((v.corpo.approvals_pending || []).length > 0) ? v : null;
  }, 12000, "pendência nascer");

  const visto = (estado.corpo.approvals_pending || [])[0]?.args_visiveis?.text;
  caso("1. o pedido de aprovação não mostra o segredo em claro",
    !estado.bruto.includes(CANARIO), `args_visiveis.text = ${JSON.stringify(visto)}`);

  const lista = await req("GET", `/api/v1/sessions/${sid}/approvals`, undefined, token);
  caso("2. a lista de aprovações também não", !lista.bruto.includes(CANARIO),
    lista.bruto.includes(CANARIO) ? "VAZOU" : "limpo");

  const pend = (estado.corpo.approvals_pending || [])[0];
  await req("POST", `/api/v1/approvals/${pend.approval_id}/deny`, { by: "dono" }, token);
  await digitar;
  await espera(900);

  const naTrilha = varrer(SESSOES);
  caso("3. a trilha de auditoria em disco não guarda o segredo",
    naTrilha.length === 0, naTrilha.length === 0 ? "nenhum arquivo" : naTrilha.join(", "));

  const noRuntime = varrer(DIR);
  caso("4. nem o diretório de runtime", noRuntime.length === 0,
    noRuntime.length === 0 ? "nenhum arquivo" : noRuntime.join(", "));

  await req("DELETE", `/api/v1/sessions/${sid}`, undefined, token);
  DAEMON.kill("SIGTERM");
  await espera(1200);
  fixture.close();

  console.log("");
  console.log(`CANARIO=${CANARIO}`);
  console.log(`SECRET_LEAK_IN_UI=${falhas > 0 ? "SIM" : "0"}`);
  console.log(`SECRET_LEAK_IN_AUDIT=${naTrilha.length > 0 ? "SIM" : "0"}`);
  console.log(`VAZAMENTOS=${falhas}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { if (DAEMON) DAEMON.kill("SIGKILL"); } catch { /* já morto */ }
  process.exit(3);
});
