// ─────────────────────────────────────────────────────────────────────────────
// E2E DO TAKEOVER — FASES 12, 13 e 23.
//
// O que se mede não é "o botão funciona". É a propriedade que o takeover existe
// para garantir:
//
//     enquanto o humano está no controle, AGENT_ACTIONS = 0
//     e ao voltar, o agente OLHA antes de agir
//
// A segunda metade é a que quase todo produto de agente erra. Devolver o
// volante não devolve o CONHECIMENTO: o humano mexeu na página, e continuar do
// modelo mental de antes é clicar no lugar onde o botão ESTAVA.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LA ?? 7796);
const PORTA_FIX = Number(process.env.PORTA_FIX ?? 8909);
const DIR = "/tmp/la-take-runtime";
const SESSOES = "/tmp/la-take-sessoes";

let DAEMON = null;
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let versaoDaPagina = "ORIGINAL";
const html = () => `<!doctype html><html><head><title>Alvo</title></head><body>
<div id="saida">INTOCADO</div>
<div id="versao">${versaoDaPagina}</div>
<button id="alvo" onclick="document.getElementById('saida').textContent='CLICADO'">Continuar</button>
</body></html>`;

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-takeover",
                   authorization: `Bearer ${token}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); } }); });
    q.on("error", reject);
    if (dados) q.write(dados);
    q.end();
  });
}
async function ate(fn, ms, rotulo) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { try { const v = await fn(); if (v) return v; } catch { /* tenta de novo */ } await espera(150); }
  throw new Error(`tempo esgotado: ${rotulo}`);
}

async function main() {
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const fixture = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    r.end(html());
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
  await ate(async () => ((await req("GET", "/health", undefined, token)).status === 200 ? true : null), 20000, "porta abrir");

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "gi", capabilities: { navigate: true, read: true, click: true, type: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  console.log(`# daemon :${PORTA} · sessão ${sid}`);

  const ler = async (sel) => (await req("POST", "/api/v1/browser.extract",
    { session_id: sid, target: { selector: sel }, format: "text" }, token)).corpo?.result?.content;
  const vivo = async () => (await req("GET", `/api/v1/sessions/${sid}/live`, undefined, token)).corpo;

  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" }, token);
  caso("0. sessão governada em AUTO", (await vivo()).autonomy_mode === "AUTO", (await vivo()).autonomy_mode);
  caso("0b. e o agente age normalmente",
    (await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#alvo" } }, token)).status === 200
    && (await ler("#saida")) === "CLICADO", String(await ler("#saida")));

  // ── FASE 12 — ASSUMIR CONTROLE ───────────────────────────────────────────
  const tomada = await req("POST", `/api/v1/sessions/${sid}/takeover`, { actor: "dono" }, token);
  caso("1. ASSUMIR CONTROLE transfere o volante",
    tomada.status === 200 && tomada.corpo.control === "human", `http=${tomada.status} control=${tomada.corpo.control}`);
  const st = await vivo();
  caso("2. e o runtime declara USER_CONTROL", st.runtime_state === "USER_CONTROL", st.runtime_state);

  const tentativas = [
    ["browser.click", { target: { selector: "#alvo" } }],
    ["browser.type", { target: { selector: "#alvo" }, text: "x" }],
    ["browser.reload", {}],
    ["browser.extract", { target: { selector: "#saida" }, format: "text" }],
  ];
  let passou = 0;
  for (const [rota, corpo] of tentativas) {
    const r = await req("POST", `/api/v1/${rota}`, { session_id: sid, ...corpo }, token);
    if (r.status === 200) passou += 1;
  }
  caso("3. AGENT_ACTION_DURING_USER_CONTROL=0 — nem leitura passa",
    passou === 0, `${passou} de ${tentativas.length} passaram`);

  // ── o humano mexe na página ──────────────────────────────────────────────
  versaoDaPagina = "MEXIDA-PELO-HUMANO";

  // ── FASE 13 — DEVOLVER, e a reobservação obrigatória ─────────────────────
  const devolvida = await req("POST", `/api/v1/sessions/${sid}/release`, { actor: "dono" }, token);
  caso("4. DEVOLVER PARA A GI devolve o volante",
    devolvida.status === 200 && devolvida.corpo.control !== "human",
    `http=${devolvida.status} control=${devolvida.corpo.control}`);

  const agirDireto = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#alvo" } }, token);
  caso("5. agir SEM reobservar é recusado — o modelo mental está vencido",
    agirDireto.status === 409 && agirDireto.corpo?.error?.code === "REOBSERVE_REQUIRED",
    `http=${agirDireto.status} code=${agirDireto.corpo?.error?.code}`);

  const observar = await req("POST", "/api/v1/browser.observe", { session_id: sid }, token);
  caso("6. observar é permitido — é justamente o que se exige", observar.status === 200, `http=${observar.status}`);

  const agirDepois = await req("POST", "/api/v1/browser.reload", { session_id: sid }, token);
  caso("7. e DEPOIS de observar o agente volta a agir", agirDepois.status === 200, `http=${agirDepois.status}`);

  await espera(700);
  caso("8. e o que ele vê agora é a página NOVA, não a de antes",
    (await ler("#versao")) === "MEXIDA-PELO-HUMANO", String(await ler("#versao")));

  // ── controle negativo: sessão NÃO governada não é afetada ────────────────
  const outra = await req("POST", "/api/v1/sessions",
    { owner: "legado", capabilities: { navigate: true, read: true, click: true } }, token);
  const sid2 = outra.corpo.session_id ?? outra.corpo.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid2, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  await req("POST", `/api/v1/sessions/${sid2}/takeover`, { actor: "dono" }, token);
  await req("POST", `/api/v1/sessions/${sid2}/release`, { actor: "dono" }, token);
  const legado = await req("POST", "/api/v1/browser.click", { session_id: sid2, target: { selector: "#alvo" } }, token);
  caso("9. CONTROLE NEGATIVO — sessão não governada segue como sempre foi",
    legado.status === 200, `http=${legado.status} (exigência nova não pode mudar quem nunca pediu Live Agent)`);

  await req("DELETE", `/api/v1/sessions/${sid}`, undefined, token);
  await req("DELETE", `/api/v1/sessions/${sid2}`, undefined, token);
  DAEMON.kill("SIGTERM");
  await espera(1200);
  fixture.close();

  console.log("");
  console.log(`FALHAS=${falhas}`);
  console.log(`TAKEOVER_HANDOFF=${falhas === 0 ? "PASS" : "FAIL"}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { if (DAEMON) DAEMON.kill("SIGKILL"); } catch { /* já morto */ }
  process.exit(3);
});
