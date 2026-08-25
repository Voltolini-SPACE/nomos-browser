// ─────────────────────────────────────────────────────────────────────────────
// LATÊNCIA REAL — FASE 26.
//
// Cinco caminhos, medidos com relógio de verdade nas duas pontas reais. Nada de
// número sintético: cada amostra é um evento que aconteceu, num Chromium que
// existe, numa tela que está aberta.
//
// A estatística NÃO é reimplementada aqui: usa `computeStats` do módulo de
// bench, que já recusa imprimir um percentil que a amostra não sustenta. Com 30
// amostras, p99 sai `null` e entra em `insufficient` — é o comportamento certo,
// e deixá-lo aparecer no relatório é mais honesto do que escolher um N que
// esconda a regra.
//
// O que cada número INCLUI está escrito junto. Latência sem fronteira declarada
// é propaganda: dá para fazer qualquer caminho parecer rápido escolhendo onde
// começar a contar.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { computeStats } from "../../../packages/observability/src/bench.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_LT ?? 7799);
const PORTA_FIX = Number(process.env.PORTA_FIX_LT ?? 8981);
const DIR = "/tmp/la-lat-runtime";
const SESSOES = "/tmp/la-lat-sessoes";
const N = Number(process.env.N_AMOSTRAS ?? 30);

let DAEMON = null, NAV = null, FIXTURE = null, TOKEN = "";
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Alvo</title></head>
<body><div id="etapa">INICIO</div>
<button id="ok" onclick="document.getElementById('etapa').textContent='CLICADO'">Continuar</button>
</body></html>`;

function req(metodo, rota, corpo) {
  return new Promise((resolve) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "medir-latencia",
                   authorization: `Bearer ${TOKEN}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); } }); });
    q.on("error", (e) => resolve({ status: 0, corpo: { error: { message: e.message } } }));
    if (dados) q.write(dados); q.end();
  });
}

function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(porta, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function construirUI() {
  const { execSync } = await import("node:child_process");
  try { execSync("node packages/ui/build.ts", { cwd: RAIZ, stdio: "pipe" }); }
  catch (e) { console.error("ERRO DO INSTRUMENTO: build da UI falhou —", String(e.stderr ?? e.message).slice(0, 200)); process.exit(2); }
}

/** Relatório de um caminho medido. */
function relatar(rotulo, fronteira, amostras) {
  const s = computeStats(amostras);
  const faltando = s.insufficient.map((i) => `${i.percentile} (precisa de ${i.n_required}, tem ${i.n})`).join(", ");
  console.log(`\n── ${rotulo}`);
  console.log(`   fronteira: ${fronteira}`);
  console.log(`   n=${s.n}  min=${fmt(s.min_ms)}  p50=${fmt(s.p50_ms)}  p95=${fmt(s.p95_ms)}  p99=${fmt(s.p99_ms)}  max=${fmt(s.max_ms)}`);
  if (faltando !== "") console.log(`   percentil que a amostra NÃO sustenta: ${faltando}`);
  return s;
}
const fmt = (v) => (v === null ? "—" : `${v.toFixed(1)}ms`);

async function limpar() {
  try { await NAV?.close(); } catch { /* já foi */ }
  try { DAEMON?.kill("SIGKILL"); } catch { /* já foi */ }
  try { FIXTURE?.close(); } catch { /* já foi */ }
}

async function main() {
  for (const p of [PORTA, PORTA_FIX]) {
    if (!(await portaLivre(p))) {
      console.error(`ERRO DO INSTRUMENTO: porta ${p} ocupada. lsof -ti tcp:${p} | xargs kill -9`);
      process.exit(2);
    }
  }
  await construirUI();
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  FIXTURE = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML); });
  await new Promise((r) => FIXTURE.listen(PORTA_FIX, "127.0.0.1", r));

  DAEMON = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"] });
  DAEMON.stdout.on("data", () => {}); DAEMON.stderr.on("data", () => {});
  for (let i = 0; i < 50 && TOKEN === ""; i += 1) {
    await nap(400);
    try { TOKEN = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  for (let i = 0; i < 60; i += 1) { if ((await req("GET", "/health")).status === 200) break; await nap(300); }

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "dono", capabilities: { navigate: true, read: true, click: true, type: true } });
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" });
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` });

  NAV = await chromium.launch({ headless: true });
  const pagina = await NAV.newPage();
  await pagina.goto(`http://127.0.0.1:${PORTA}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: "domcontentloaded" });
  await pagina.evaluate((s) => { S.sessionId = s; }, sid);
  await nap(1500);

  // Sonda passiva no MESMO socket que a UI usa. Não substitui o handler da
  // aplicação: escuta ao lado dele.
  const sondaPronta = await pagina.evaluate(() => {
    window.__lat = { eventos: [], espelho: [] };
    if (!S.ws || S.ws.readyState !== 1) return false;
    S.ws.addEventListener("message", (m) => {
      const chegou = Date.now();
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (typeof ev.timestamp === "string") {
        const emitido = Date.parse(ev.timestamp);
        if (Number.isFinite(emitido)) window.__lat.eventos.push({ nome: ev.event, ms: chegou - emitido });
      }
    });
    return true;
  });
  caso("0. controle: a UI tem WebSocket vivo para medir",
       sondaPronta === true, sondaPronta ? "socket aberto, sonda instalada" : "sem socket — a medida A seria vácua");

  // ── A. evento do runtime → UI (WebSocket) ────────────────────────────────
  for (let i = 0; i < N; i += 1) {
    await req("POST", "/api/v1/browser.extract", { session_id: sid, selector: "#etapa" });
    await nap(40);
  }
  await nap(600);
  const eventos = await pagina.evaluate(() => window.__lat.eventos.map((e) => e.ms));
  const amostrasA = eventos.filter((v) => Number.isFinite(v) && v >= 0);
  caso("A0. controle: chegaram eventos suficientes para medir",
       amostrasA.length >= 10, `${amostrasA.length} amostras de ${eventos.length} eventos`);
  const A = relatar(
    "A. evento do runtime → UI (WebSocket)",
    "do `timestamp` que o runtime carimba no evento até o `onmessage` da página. Inclui serialização, socket e loop de eventos do navegador.",
    amostrasA,
  );

  // ── B. quadro do navegador → UI (espelho) ────────────────────────────────
  // O espelho é um caminho de DOIS passos, e é assim que a UI o percorre:
  // `browser.screenshot` devolve `screenshot_url` (id opaco não serve), e só
  // então o PNG é buscado. Medir um GET direto mediria outra coisa.
  const amostrasB = await pagina.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = Date.now();
      let r;
      try { r = await acao("browser.screenshot", { scope: "viewport" }); } catch { r = null; }
      if (!r || !r.screenshot_url) { await new Promise((s) => setTimeout(s, 40)); continue; }
      const ok = await new Promise((s) => {
        const img = new Image();
        img.onload = () => s(true);
        img.onerror = () => s(false);
        img.src = BASE + r.screenshot_url + "?t=" + Date.now() +
                  (TOKEN !== null ? "&token=" + encodeURIComponent(TOKEN) : "");
      });
      if (ok) out.push(Date.now() - t0);
      await new Promise((s) => setTimeout(s, 40));
    }
    return out;
  }, N).catch(() => []);

  let B = null;
  if (amostrasB.length < 10) {
    // Honestidade: o espelho da UI não é servido por GET de imagem nesta versão
    // — ele vem por outro caminho. Dizer "não medido" é obrigatório; inventar um
    // número plausível seria o oposto do que esta fase existe para fazer.
    caso("B. quadro do navegador → UI: NÃO MEDIDO por este instrumento",
         false, `${amostrasB.length} amostras`);
  } else {
    caso("B0. controle: quadros suficientes medidos", true, `${amostrasB.length}/${N} amostras`);
    B = relatar("B. quadro do navegador → UI (espelho)",
            "do pedido do quadro (`browser.screenshot`) até o `onload` da imagem na página. Inclui captura no Chromium, gravação, transporte e decodificação — os dois passos que a UI de fato percorre.",
            amostrasB);
  }

  // ── C. clique de APROVAR na tela → runtime ───────────────────────────────
  //
  // Fronteira honesta: começa no `Date.now()` do próprio clique dentro da
  // página e termina no `decidido_em` que o RUNTIME carimba. As duas pontas são
  // relógios da mesma máquina.
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" });
  const amostrasC = [];
  for (let i = 0; i < N; i += 1) {
    const acao = req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#ok" } });
    let pend = [];
    for (let k = 0; k < 40 && pend.length === 0; k += 1) {
      await nap(50);
      const f = await req("GET", `/api/v1/sessions/${sid}/approvals`);
      const lista = Array.isArray(f.corpo) ? f.corpo : (f.corpo.pendentes ?? []);
      pend = lista.filter((p) => p.estado === "PENDENTE");
    }
    if (pend.length === 0) { await acao; continue; }
    const id = pend[0].approval_id;
    const tClique = await pagina.evaluate(async (args) => {
      const t = Date.now();
      await fetch(BASE + "/api/v1/approvals/" + args.id + "/approve", {
        method: "POST", headers: comAuth({ "content-type": "application/json" }),
        body: JSON.stringify({ by: "dono" }),
      });
      return t;
    }, { id });
    await acao;
    // `approvals.list` devolve `{pendentes, todas}`. Depois de aprovada, a
    // pendência SAI de `pendentes` — procurá-la lá era garantir zero amostras.
    const todas = await req("GET", `/api/v1/sessions/${sid}/approvals`);
    const lista = Array.isArray(todas.corpo) ? todas.corpo : (todas.corpo.todas ?? []);
    const alvo = lista.find((p) => p.approval_id === id);
    const decidido = alvo?.decidido_em ? Date.parse(alvo.decidido_em) : NaN;
    if (Number.isFinite(decidido) && decidido - tClique >= 0) amostrasC.push(decidido - tClique);
  }
  caso("C0. controle: aprovações suficientes medidas",
       amostrasC.length >= 10, `${amostrasC.length}/${N} amostras`);
  const C = amostrasC.length >= 2
    ? relatar("C. clique de APROVAR na tela → runtime",
              "do `Date.now()` do clique dentro da página até o `decidido_em` carimbado pelo runtime. Inclui fetch, fila e registro.",
              amostrasC)
    : null;

  // ── D. cancelamento pedido pela tela → runtime ───────────────────────────
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" });
  const amostrasD = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = await pagina.evaluate(async () => {
      const t = Date.now();
      await fetch(BASE + "/api/v1/sessions/" + S.sessionId + "/pause", { method: "POST", headers: comAuth({}) });
      return t;
    });
    const st = await req("GET", `/api/v1/sessions/${sid}/live`);
    const t1 = Date.now();
    if (st.corpo.runtime_state === "PAUSED") amostrasD.push(t1 - t0);
    await pagina.evaluate(async () => {
      await fetch(BASE + "/api/v1/sessions/" + S.sessionId + "/resume", { method: "POST", headers: comAuth({}) });
    });
    await nap(30);
  }
  caso("D0. controle: pausas suficientes medidas",
       amostrasD.length >= 10, `${amostrasD.length}/${N} amostras`);
  const D = amostrasD.length >= 2
    ? relatar("D. freio pedido pela tela → runtime PAUSADO",
              "do clique na página até o runtime declarar PAUSED numa leitura seguinte. INCLUI a ida ao runtime para confirmar, então é um teto, não o tempo interno do freio.",
              amostrasD)
    : null;

  // ── E. transferência de posse ────────────────────────────────────────────
  const amostrasE = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = Date.now();
    await req("POST", `/api/v1/sessions/${sid}/takeover`, { by: "dono" });
    const st = await req("GET", `/api/v1/sessions/${sid}/live`);
    if (st.corpo.control === "human") amostrasE.push(Date.now() - t0);
    await req("POST", `/api/v1/sessions/${sid}/release`, { by: "dono" });
    await nap(20);
  }
  caso("E0. controle: transferências suficientes medidas",
       amostrasE.length >= 10, `${amostrasE.length}/${N} amostras`);
  const E = amostrasE.length >= 2
    ? relatar("E. tomada de controle → runtime com o volante no humano",
              "do pedido de takeover até uma leitura confirmar `control=human`. Inclui as duas idas ao runtime.",
              amostrasE)
    : null;

  // ── a fronteira que NÃO é latência de transporte ─────────────────────────
  console.log("\n── nota obrigatória sobre o painel de estado");
  console.log("   A faixa de estado da UI (`/live`) é lida por POLLING de 700 ms, não por evento.");
  console.log("   Uma mudança de estado aparece na tela em até 700 ms POR PROJETO, e nenhum");
  console.log("   número acima descreve esse caminho. Reportar a latência do WebSocket como se");
  console.log("   fosse a da faixa faria o console parecer ~10x mais rápido do que ele mostra.");

  console.log("");
  console.log(`AMOSTRAS_POR_CAMINHO=${N}`);
  console.log(`EVENTO_RUNTIME_UI_P50_MS=${fmt(A.p50_ms)}`);
  console.log(`QUADRO_NAVEGADOR_UI_P50_MS=${B === null ? "NAO_MEDIDO" : fmt(B.p50_ms)}`);
  console.log(`APROVACAO_CLIQUE_RUNTIME_P50_MS=${C === null ? "NAO_MEDIDO" : fmt(C.p50_ms)}`);
  console.log(`FREIO_CLIQUE_RUNTIME_P50_MS=${D === null ? "NAO_MEDIDO" : fmt(D.p50_ms)}`);
  console.log(`POSSE_TRANSFERENCIA_P50_MS=${E === null ? "NAO_MEDIDO" : fmt(E.p50_ms)}`);
  console.log(`FAIXA_DE_ESTADO_E_POLLING_MS=700`);
  console.log(`LATENCY_MEASURED=${falhas === 0 ? "PASS" : "PARCIAL"}`);
  console.log(`FALHAS=${falhas}`);
}

main().then(async () => { await limpar(); process.exit(falhas === 0 ? 0 : 1); })
      .catch(async (e) => { console.error("ERRO DO INSTRUMENTO:", e); await limpar(); process.exit(2); });
