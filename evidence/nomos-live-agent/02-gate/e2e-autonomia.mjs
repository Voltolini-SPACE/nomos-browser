// ─────────────────────────────────────────────────────────────────────────────
// E2E DO GATE DE AUTONOMIA — daemon real, Chromium real, nenhum mock.
//
// FASES 20, 21, 22 e 14 da missão, medidas contra o runtime de verdade:
//
//   ASK  — a ação NÃO acontece antes da aprovação, e isso é provado pelo
//          EFEITO no navegador, não pela resposta HTTP
//   AUTO — a mesma ação passa direto, sem pergunta
//   LIMITE — em AUTO, uma ação protegida AINDA para (o gate crítico)
//   TROCA — mudar de modo não solta uma pendência que já existe
//
// A prova de "não executou" é sempre a mesma e é a única que vale: o DOM da
// página antes e depois. Resposta HTTP dizendo "negado" com o efeito na tela
// seria exatamente o tipo de mentira que esta bateria existe para pegar.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LA ?? 7794);
const DIR = "/tmp/la-e2e-runtime";
const SESSOES = "/tmp/la-e2e-sessoes";
const PORTA_FIX = Number(process.env.PORTA_FIX ?? 8907);

let falhas = 0;
const casos = [];
function caso(nome, ok, observado) {
  casos.push({ nome, ok, observado });
  falhas += ok ? 0 : 1;
  console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${observado}`);
}

// ── fixture: uma página com um botão que ANUNCIA quando é clicado ───────────
const HTML = `<!doctype html><html><head><title>Alvo</title></head><body>
<div id="saida">INTOCADO</div>
<button id="alvo" onclick="document.getElementById('saida').textContent='CLICADO'">Continuar</button>
<input id="campo" oninput="document.getElementById('saida').textContent='DIGITADO:'+this.value">
</body></html>`;

const fixture = http.createServer((_q, r) => {
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  r.end(HTML);
});

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-live-agent",
                   authorization: `Bearer ${token}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => {
        let b = "";
        res.on("data", (c) => { b += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); }
        });
      });
    q.on("error", reject);
    if (dados) q.write(dados);
    q.end();
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(SESSOES, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(SESSOES, { recursive: true });
  await new Promise((r) => fixture.listen(PORTA_FIX, "127.0.0.1", r));
  console.log(`# fixture em http://127.0.0.1:${PORTA_FIX}/`);

  const daemon = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES,
           NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", () => {});
  daemon.stderr.on("data", () => {});

  let token = "";
  for (let i = 0; i < 40 && token === ""; i += 1) {
    await espera(400);
    try { token = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* ainda não */ }
  }
  if (token === "") { console.log("ABORTADO: daemon não publicou credencial"); daemon.kill(); process.exit(2); }
  console.log(`# daemon em :${PORTA}`);

  const criada = await req("POST", "/api/v1/sessions", { owner: "gi", capabilities: { navigate: true, read: true, click: true, type: true, download: true, upload: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  if (!sid) { console.log(`ABORTADO: sessão não criada: ${JSON.stringify(criada.corpo).slice(0, 200)}`); daemon.kill(); process.exit(2); }
  console.log(`# sessão ${sid}`);

  const abrir = await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  caso("0. preparo — a fixture abriu", abrir.status === 200, `http=${abrir.status}`);

  const ler = async () => {
    const r = await req("POST", "/api/v1/browser.extract",
      { session_id: sid, target: { selector: "#saida" }, format: "text" }, token);
    return r.corpo?.result?.content ?? "?";
  };
  caso("0b. controle — a saída começa INTOCADO", (await ler()) === "INTOCADO", await ler());

  await rodar({ sid, token, ler });

  await req("DELETE", `/api/v1/sessions/${sid}`, undefined, token);
  daemon.kill("SIGTERM");
  await espera(1500);
  fixture.close();

  console.log("");
  console.log(`CASOS=${casos.length}`);
  console.log(`FALHAS=${falhas}`);
  console.log(`ASK_MODE_E2E=${falhas === 0 ? "PASS" : "FAIL"}`);
  process.exit(falhas === 0 ? 0 : 1);
}

async function rodar({ sid, token, ler }) {
  const clicar = () => req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#alvo" } }, token);
  const estado = async () => (await req("GET", `/api/v1/sessions/${sid}/live`, undefined, token)).corpo;

  // ── FASE 20 — MODO PERGUNTAR ──────────────────────────────────────────────
  const setAsk = await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" }, token);
  caso("1. ASK ligado", setAsk.status === 200 && setAsk.corpo.autonomy_mode === "ASK",
    `http=${setAsk.status} modo=${setAsk.corpo.autonomy_mode} scope=${setAsk.corpo.scope}`);

  // O clique fica PARADO esperando aprovação. Não dá para aguardar a resposta:
  // ela só chega depois da decisão. Disparamos e observamos o mundo.
  const cliquePendente = clicar();
  await espera(1200);

  const st = await estado();
  caso("2. o runtime declara WAITING_APPROVAL", st.runtime_state === "WAITING_APPROVAL",
    `runtime_state=${st.runtime_state} approval_required=${st.approval_required}`);
  caso("3. e diz QUAL ação e QUAL nível", st.current_action === "browser.click" && st.action_level === "A2",
    `current_action=${st.current_action} action_level=${st.action_level}`);

  const pend = st.approvals_pending ?? [];
  caso("4. há exatamente uma pendência, com consequência legível",
    pend.length === 1 && typeof pend[0]?.consequencia === "string" && pend[0].consequencia.length > 10,
    `n=${pend.length} consequencia="${pend[0]?.consequencia ?? ""}"`);

  // A PROVA QUE IMPORTA: o navegador não se moveu.
  caso("5. o NAVEGADOR não se moveu enquanto espera", (await ler()) === "INTOCADO", await ler());

  // ── FASE 14 — trocar de modo NÃO solta a pendência ────────────────────────
  const troca = await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" }, token);
  await espera(500);
  const st2 = await estado();
  caso("6. TROCA ASK→AUTO não libera a pendência que já existia",
    troca.status === 200 && st2.runtime_state === "WAITING_APPROVAL" && (st2.approvals_pending ?? []).length === 1,
    `modo=${st2.autonomy_mode} runtime_state=${st2.runtime_state} pendentes=${(st2.approvals_pending ?? []).length}`);
  caso("7. e o navegador continua intocado depois da troca", (await ler()) === "INTOCADO", await ler());

  // Aprovar.
  const apr = await req("POST", `/api/v1/approvals/${pend[0].approval_id}/approve`, { by: "dono" }, token);
  const resp = await cliquePendente;
  await espera(800);
  caso("8. aprovada: a ação acontece", apr.status === 200 && resp.status === 200,
    `aprovacao=${apr.status} acao=${resp.status}`);
  caso("9. e o EFEITO está na página", (await ler()) === "CLICADO", await ler());

  // ── FASE 21/22 — AUTO, e o limite dele ───────────────────────────────────
  // Agora estamos em AUTO (trocado no caso 6). Um clique tem de passar direto.
  await req("POST", "/api/v1/browser.reload", { session_id: sid }, token);
  await espera(600);
  caso("10. controle — a página voltou a INTOCADO", (await ler()) === "INTOCADO", await ler());

  const t0 = Date.now();
  const auto = await clicar();
  const dt = Date.now() - t0;
  const stAuto = await estado();
  caso("11. AUTO: clique passa direto, sem pendência",
    auto.status === 200 && (stAuto.approvals_pending ?? []).length === 0,
    `http=${auto.status} pendentes=${(stAuto.approvals_pending ?? []).length} ${dt}ms`);
  caso("12. e o efeito está lá", (await ler()) === "CLICADO", await ler());

  // O GATE CRÍTICO: em AUTO, uma ação protegida AINDA para.
  const upload = req("POST", "/api/v1/browser.upload",
    { session_id: sid, target: { selector: "#campo" }, path: "/tmp/nao-existe.txt" }, token);
  await espera(1200);
  const stProt = await estado();
  const pendProt = stProt.approvals_pending ?? [];
  caso("13. AUTO + ação protegida = WAITING_APPROVAL (o gate crítico)",
    stProt.runtime_state === "WAITING_APPROVAL" && pendProt.length === 1 && pendProt[0].rota === "browser.upload",
    `modo=${stProt.autonomy_mode} runtime_state=${stProt.runtime_state} rota=${pendProt[0]?.rota}`);
  caso("14. e o motivo declarado é o fator de risco, não o nível",
    (pendProt[0]?.motivo ?? "").includes("fora"),
    `motivo="${pendProt[0]?.motivo ?? ""}"`);

  // Negar, e conferir que negar NEGA.
  const neg = await req("POST", `/api/v1/approvals/${pendProt[0].approval_id}/deny`, { by: "dono" }, token);
  const respUp = await upload;
  caso("15. negada: a ação é recusada com APPROVAL_DENIED",
    neg.status === 200 && respUp.status === 403 && respUp.corpo?.error?.code === "APPROVAL_DENIED",
    `negacao=${neg.status} acao=${respUp.status} code=${respUp.corpo?.error?.code}`);

  const stFim = await estado();
  caso("16. e a fila volta a zero", (stFim.approvals_pending ?? []).length === 0,
    `pendentes=${(stFim.approvals_pending ?? []).length} runtime_state=${stFim.runtime_state}`);

  // ── FASE 15 — kill switch, no backend ────────────────────────────────────
  const parar = await req("POST", `/api/v1/sessions/${sid}/emergency-stop`, { by: "dono" }, token);
  caso("17. PARAR TUDO congela o agente e tira o volante",
    parar.status === 200 && parar.corpo.parado === true && parar.corpo.control === "human",
    `http=${parar.status} control=${parar.corpo.control}`);

  const depoisDoStop = await clicar();
  caso("18. e depois do PARAR, ação nenhuma passa",
    depoisDoStop.status === 409 && depoisDoStop.corpo?.error?.code === "CONTROL_HELD_BY_HUMAN",
    `http=${depoisDoStop.status} code=${depoisDoStop.corpo?.error?.code}`);
}

main().catch((e) => { console.error(e); process.exit(3); });
