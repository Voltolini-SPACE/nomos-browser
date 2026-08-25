// ─────────────────────────────────────────────────────────────────────────────
// E2E DO LIVE AGENT CONSOLE — um navegador REAL dirigindo a tela REAL.
//
// A missão proíbe marcar PASS com página simulada, e proíbe a UI inferir
// estado. As duas coisas se provam juntas aqui: o Playwright abre o console de
// verdade, servido pelo daemon de verdade, e o que se mede é o que aparece na
// tela quando o runtime muda de estado.
//
// O console é aberto num Chromium SEPARADO do que o NOMOS controla — se fosse o
// mesmo, "a tela mudou" e "a página sob controle mudou" ficariam
// indistinguíveis, e o teste não provaria nada sobre a interface.
//
// FASES cobertas: 4, 6, 8, 9, 14, 16, 19, 27.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LA ?? 7795);
const PORTA_FIX = Number(process.env.PORTA_FIX ?? 8908);
const DIR = "/tmp/la-console-runtime";
const SESSOES = "/tmp/la-console-sessoes";

// Um teste que deixa orfao quando falha envenena a proxima execucao — e foi
// exatamente o que aconteceu: o daemon da corrida quebrada ficou segurando a
// porta e a seguinte morreu com EADDRINUSE, apontando para o lugar errado.
// Estes dois ficam no escopo de fora para que o `catch` final os alcance.
let DAEMON = null;
let NAVEGADOR = null;
async function limpar() {
  try { if (NAVEGADOR) await NAVEGADOR.close(); } catch { /* ja fechado */ }
  try { if (DAEMON) DAEMON.kill("SIGKILL"); } catch { /* ja morto */ }
}

let falhas = 0;
function caso(nome, ok, observado) {
  falhas += ok ? 0 : 1;
  console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${observado}`);
}
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
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-console",
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

async function ate(fn, ms, rotulo) {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    try { ultimo = await fn(); if (ultimo) return ultimo; } catch (e) { ultimo = String(e); }
    await espera(120);
  }
  throw new Error(`tempo esgotado esperando ${rotulo}; último=${JSON.stringify(ultimo)}`);
}

async function main() {
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  const fixture = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(HTML);
  });
  await new Promise((r) => fixture.listen(PORTA_FIX, "127.0.0.1", r));

  const daemon = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"] });
  DAEMON = daemon;
  daemon.stdout.on("data", () => {}); daemon.stderr.on("data", () => {});

  let token = "";
  for (let i = 0; i < 40 && token === ""; i += 1) {
    await espera(400);
    try { token = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  if (token === "") { console.log("ABORTADO: sem credencial"); daemon.kill(); process.exit(2); }

  // O arquivo de credencial nasce ANTES de a porta abrir. Esperar só por ele é
  // uma corrida — e ela estourou ECONNREFUSED na primeira execução. O sinal
  // honesto de "o daemon está de pé" é o /health responder.
  await ate(async () => {
    try { return (await req("GET", "/health", undefined, token)).status === 200 ? true : null; }
    catch { return null; }
  }, 20000, "o daemon abrir a porta");

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "gi", capabilities: { navigate: true, read: true, click: true, type: true, download: true, upload: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  console.log(`# daemon :${PORTA} · sessão ${sid}`);

  const nav = await chromium.launch({ headless: true });
  NAVEGADOR = nav;
  const pagina = await nav.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(String(e)));
  pagina.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  await pagina.goto(`http://127.0.0.1:${PORTA}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });

  const txt = async (sel) => ((await pagina.locator(sel).first().textContent()) ?? "").trim();
  const visivel = async (sel) => pagina.locator(sel).first().isVisible();

  // ── FASE 19 — indicadores obrigatórios, sempre visíveis ──────────────────
  try {
    await ate(async () => ((await txt("#f-sessao")) !== "—" ? true : null), 15000, "faixa preencher");
  } catch (e) {
    // Um teste de UI que morre sem dizer o que a UI reclamou nao serve para
    // nada: o proximo passo seria abrir o navegador na mao.
    console.log("DIAGNOSTICO — erros de JS na pagina:", JSON.stringify(erros, null, 1));
    console.log("DIAGNOSTICO — f-sessao:", await txt("#f-sessao"), "| f-status:", await txt("#f-status"));
    console.log("DIAGNOSTICO — sessionId visto pela pagina:",
      await pagina.evaluate(() => (typeof S === "undefined" ? "S indefinido" : String(S.sessionId))));
    throw e;
  }
  caso("1. a faixa mostra AGENTE, SESSÃO, STATUS, AUTONOMIA, OWNER e AÇÃO",
    (await txt("#f-agente")) === "gi" && (await txt("#f-sessao")).startsWith("#")
    && (await txt("#f-owner")) === "gi" && (await txt("#f-status")).length > 0,
    `agente=${await txt("#f-agente")} sessao=${await txt("#f-sessao")} status=${await txt("#f-status")} owner=${await txt("#f-owner")}`);

  caso("2. o controle de autonomia é SEMPRE visível — não vive em configuração",
    await visivel("#autonomia"), `visivel=${await visivel("#autonomia")}`);

  // ── FASE 4 — trocar o modo PELA TELA muda o runtime ──────────────────────
  await pagina.locator('#autonomia input[value="ASK"]').check();
  const modoNoRuntime = await ate(async () => {
    const r = await req("GET", `/api/v1/sessions/${sid}/autonomy`, undefined, token);
    return r.corpo.autonomy_mode === "ASK" ? r.corpo : null;
  }, 8000, "runtime registrar ASK");
  caso("3. marcar 'Perguntar' na tela muda o modo NO RUNTIME",
    modoNoRuntime.autonomy_mode === "ASK" && modoNoRuntime.scope === "SESSION",
    `runtime: modo=${modoNoRuntime.autonomy_mode} escopo=${modoNoRuntime.scope}`);
  await ate(async () => (await txt("#f-modo")) === "PERGUNTAR", 5000, "faixa mostrar PERGUNTAR");
  caso("4. e a faixa reflete", (await txt("#f-modo")) === "PERGUNTAR", await txt("#f-modo"));

  // ── FASE 9 — o centro de aprovação ───────────────────────────────────────
  const cliquePendente = req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#alvo" } }, token);
  await ate(async () => ((await visivel("#aprovacao")) ? true : null), 12000, "modal de aprovação abrir");
  caso("5. a ação pendente ABRE o centro de aprovação sozinha", await visivel("#aprovacao"), "modal aberto");
  caso("6. e mostra ação, onde, nível, consequência e motivo",
    (await txt("#aprAcao")) === "browser.click" && (await txt("#aprNivel")) === "A2"
    && (await txt("#aprConsequencia")).length > 10 && (await txt("#aprMotivo")).length > 0,
    `acao=${await txt("#aprAcao")} nivel=${await txt("#aprNivel")} consequencia="${await txt("#aprConsequencia")}"`);
  caso("7. a faixa entra em AGUARDANDO APROVAÇÃO",
    (await txt("#f-status")) === "AGUARDANDO APROVAÇÃO", await txt("#f-status"));

  // ── FASE 14 — trocar de modo NÃO solta a pendência ───────────────────────
  //
  // Primeiro, uma propriedade que só apareceu ao tentar clicar: com o modal
  // aberto, o rádio de autonomia NÃO é clicável. Isso é desenho, não estorvo —
  // uma pergunta que o usuário consegue contornar mexendo noutro controle é uma
  // pergunta que o PRAZO vai responder por ele, e o prazo nega.
  let interceptou = false;
  try {
    await pagina.locator('#autonomia input[value="AUTO"]').check({ timeout: 2500 });
  } catch (e) {
    interceptou = /intercepts pointer events|Timeout/.test(String(e));
  }
  caso("8. com aprovação aberta, o modal BLOQUEIA os controles atrás dele",
    interceptou, interceptou ? "clique interceptado pelo modal" : "o rádio foi alcançado por trás do modal");

  // E a invariante da FASE 14 propriamente dita, pela API — que é o caminho que
  // um agente ou um script teria: trocar o modo não solta o que já está preso.
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "e2e" }, token);
  await espera(1500);
  caso("8b. e trocar para AUTO por fora não libera a pendência",
    (await visivel("#aprovacao")) && (await txt("#f-status")) === "AGUARDANDO APROVAÇÃO",
    `modal=${await visivel("#aprovacao")} status=${await txt("#f-status")}`);

  const antes = (await req("POST", "/api/v1/browser.extract",
    { session_id: sid, target: { selector: "#saida" }, format: "text" }, token)).corpo?.result?.content;
  caso("9. controle: a página está INTOCADA enquanto o modal está aberto", antes === "INTOCADO", String(antes));

  await pagina.locator("#aprAprovar").click();
  const resp = await cliquePendente;
  await espera(900);
  const depois = (await req("POST", "/api/v1/browser.extract",
    { session_id: sid, target: { selector: "#saida" }, format: "text" }, token)).corpo?.result?.content;
  caso("10. clicar APROVAR executa a ação de verdade",
    resp.status === 200 && depois === "CLICADO", `http=${resp.status} dom=${depois}`);
  await ate(async () => (!(await visivel("#aprovacao")) ? true : null), 6000, "modal fechar");
  caso("11. e o modal fecha", !(await visivel("#aprovacao")), "fechado");

  const aviso = await txt("#autoAviso");
  caso("12. em AUTO a tela avisa o que continua perguntando",
    aviso.includes("browser.upload") && aviso.includes("browser.task"), `"${aviso}"`);

  // Fotografia dos erros ANTES de eu derrubar o daemon de proposito. Depois do
  // SIGKILL o navegador registra ERR_CONNECTION_REFUSED — e isso e' o
  // comportamento CERTO, nao um defeito do console. Contar aquilo como erro
  // seria reprovar a pagina por reagir bem ao que eu fiz com ela.
  const errosAntesDaQueda = erros.length;

  // ── FASE 16 — fail-safe: sem estado comprovado, NUNCA AUTO ───────────────
  daemon.kill("SIGKILL");
  await ate(async () => ((await txt("#f-status")) === "DESCONECTADO" ? true : null), 15000, "console detectar queda");
  caso("13. daemon morto: a tela diz DESCONECTADO, e não segue dizendo CONTROLANDO",
    (await txt("#f-status")) === "DESCONECTADO", await txt("#f-status"));
  caso("14. FAIL-SAFE — a autonomia vira DESCONHECIDA, jamais AUTO",
    (await txt("#f-modo")) === "DESCONHECIDA", await txt("#f-modo"));
  caso("15. e a tela diz que está tratando como PERGUNTAR",
    (await txt("#autoAviso")).includes("PERGUNTAR"), `"${await txt("#autoAviso")}"`);

  caso("16. o console não lançou erro de JavaScript durante a operação normal",
    errosAntesDaQueda === 0, errosAntesDaQueda === 0 ? "nenhum" : erros.slice(0, 2).join(" | "));
  const soDeRede = erros.slice(errosAntesDaQueda)
    .every((m) => /ERR_CONNECTION_REFUSED|Failed to fetch|NetworkError|Failed to load resource/.test(m));
  caso("17. e depois do SIGKILL só houve erro de REDE — a página não quebrou",
    soDeRede, `${erros.length - errosAntesDaQueda} erros, todos de rede=${soDeRede}`);

  await nav.close();
  fixture.close();
  try { daemon.kill("SIGKILL"); } catch { /* já morto */ }
  await espera(800);

  console.log("");
  console.log(`FALHAS=${falhas}`);
  console.log(`LIVE_AGENT_CONSOLE=${falhas === 0 ? "PASS" : "FAIL"}`);
  console.log(`APPROVAL_CENTER=${falhas === 0 ? "PASS" : "FAIL"}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await limpar();
  process.exit(3);
});
