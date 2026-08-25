// ─────────────────────────────────────────────────────────────────────────────
// E2E DOS CONTROLES — FASES 10, 11, 15, 24.
//
// PAUSAR, CANCELAR e PARAR TUDO. O que se mede aqui é o que separa um controle
// de verdade de um botão que só muda a cor de si mesmo:
//
//   · pausar impede AÇÃO mas mantém OBSERVAÇÃO (a tela precisa seguir viva
//     para o operador decidir se retoma)
//   · o kill switch roda INTEIRO no backend — provado abandonando a conexão
//     no meio e conferindo que a interrupção termina sozinha
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LA ?? 7797);
const PORTA_FIX = Number(process.env.PORTA_FIX ?? 8910);
const DIR = "/tmp/la-ctrl-runtime";
const SESSOES = "/tmp/la-ctrl-sessoes";

let DAEMON = null;
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>Alvo</title></head><body>
<div id="saida">INTOCADO</div>
<button id="alvo" onclick="document.getElementById('saida').textContent='CLICADO'">Continuar</button>
</body></html>`;

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-controles",
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
  while (Date.now() < fim) { try { const v = await fn(); if (v) return v; } catch { /* de novo */ } await espera(150); }
  throw new Error(`tempo esgotado: ${rotulo}`);
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
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" }, token);
  console.log(`# daemon :${PORTA} · sessão ${sid}`);

  const vivo = async () => (await req("GET", `/api/v1/sessions/${sid}/live`, undefined, token)).corpo;
  const clicar = () => req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#alvo" } }, token);
  const observar = () => req("POST", "/api/v1/browser.observe", { session_id: sid }, token);
  const ler = async () => (await req("POST", "/api/v1/browser.extract",
    { session_id: sid, target: { selector: "#saida" }, format: "text" }, token)).corpo?.result?.content;

  caso("0. linha de base — o agente age", (await clicar()).status === 200 && (await ler()) === "CLICADO", String(await ler()));
  await req("POST", "/api/v1/browser.reload", { session_id: sid }, token);
  await espera(600);

  // ── FASE 10 — PAUSAR ─────────────────────────────────────────────────────
  const pausa = await req("POST", `/api/v1/sessions/${sid}/pause`, { by: "dono" }, token);
  caso("1. PAUSAR responde e marca a sessão", pausa.status === 200 && pausa.corpo.paused === true,
    `http=${pausa.status} paused=${pausa.corpo.paused}`);
  caso("2. o runtime declara PAUSED", (await vivo()).runtime_state === "PAUSED", (await vivo()).runtime_state);

  const acaoPausada = await clicar();
  caso("3. nenhuma AÇÃO nova começa",
    acaoPausada.status === 409 && acaoPausada.corpo?.error?.code === "AGENT_PAUSED",
    `http=${acaoPausada.status} code=${acaoPausada.corpo?.error?.code}`);
  caso("4. e o navegador não se moveu", (await ler()) === "INTOCADO", String(await ler()));

  const obsPausada = await observar();
  caso("5. mas OBSERVAR continua — a tela precisa seguir viva para você decidir",
    obsPausada.status === 200, `http=${obsPausada.status}`);

  const retoma = await req("POST", `/api/v1/sessions/${sid}/resume`, { by: "dono" }, token);
  caso("6. RETOMAR exige ação explícita e devolve o agente",
    retoma.status === 200 && retoma.corpo.paused === false && (await clicar()).status === 200,
    `http=${retoma.status}`);

  // ── FASE 15 — PARAR TUDO, com o cliente abandonando a conexão ────────────
  await req("POST", "/api/v1/browser.reload", { session_id: sid }, token);
  await espera(600);
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" }, token);
  const pendurada = clicar();
  pendurada.catch(() => {});
  await ate(async () => ((((await vivo()).approvals_pending) || []).length > 0 ? true : null), 12000, "pendência nascer");
  caso("7. há uma aprovação pendente antes do PARAR",
    (((await vivo()).approvals_pending) || []).length === 1, "1 pendente");

  // A leitura do DOM tem de ser AGORA, antes do PARAR: o kill switch tira o
  // volante, e sob controle humano ate' `browser.extract` congela — de
  // proposito, porque e' nesse instante que alguem digita senha. Ler depois
  // devolveria `undefined` e eu leria isso como "o teste falhou" em vez de "o
  // produto fez o certo".
  caso("7b. o navegador nao se moveu enquanto a aprovacao esperava",
    (await ler()) === "INTOCADO", String(await ler()));

  const abandonado = req("POST", `/api/v1/sessions/${sid}/emergency-stop`, { by: "dono" }, token);
  abandonado.catch(() => {});

  await ate(async () => {
    const v = await vivo();
    return ((v.approvals_pending || []).length === 0 && v.control === "human") ? v : null;
  }, 15000, "o backend concluir a parada sozinho");
  const depois = await vivo();
  caso("8. o kill switch termina no BACKEND mesmo sem ninguém ler a resposta",
    (depois.approvals_pending || []).length === 0 && depois.control === "human",
    `pendentes=${(depois.approvals_pending || []).length} control=${depois.control}`);

  const respPendurada = await pendurada;
  caso("9. e a ação que estava pendurada foi NEGADA, não liberada",
    respPendurada.status === 403 && respPendurada.corpo?.error?.code === "APPROVAL_DENIED",
    `http=${respPendurada.status} code=${respPendurada.corpo?.error?.code}`);
  const leituraDepois = await req("POST", "/api/v1/browser.extract",
    { session_id: sid, target: { selector: "#saida" }, format: "text" }, token);
  caso("10. depois do PARAR nem LEITURA passa — o volante e' do humano",
    leituraDepois.status === 409 && leituraDepois.corpo?.error?.code === "CONTROL_HELD_BY_HUMAN",
    `http=${leituraDepois.status} code=${leituraDepois.corpo?.error?.code}`);

  const depoisDoStop = await clicar();
  caso("11. e depois do PARAR nenhuma ação passa",
    depoisDoStop.status === 409, `http=${depoisDoStop.status} code=${depoisDoStop.corpo?.error?.code}`);

  await req("DELETE", `/api/v1/sessions/${sid}`, undefined, token);
  DAEMON.kill("SIGTERM");
  await espera(1200);
  fixture.close();

  console.log("");
  console.log(`FALHAS=${falhas}`);
  console.log(`PAUSE=${falhas === 0 ? "PASS" : "FAIL"}`);
  console.log(`EMERGENCY_STOP=${falhas === 0 ? "PASS" : "FAIL"}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { if (DAEMON) DAEMON.kill("SIGKILL"); } catch { /* já morto */ }
  process.exit(3);
});
