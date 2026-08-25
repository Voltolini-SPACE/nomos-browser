// ─────────────────────────────────────────────────────────────────────────────
// E2E DO REPLAY — FASE 18, com o gancho da FASE 17.
//
// Três coisas que só uma execução real prova:
//
//   · o histórico é da SESSÃO QUE ACONTECEU (Chromium real, página real,
//     digitação real) — não de um bundle fabricado pelo próprio teste;
//   · o canário digitado num campo de senha NÃO aparece em lugar nenhum do
//     replay, que é a superfície onde uma sessão inteira sai de uma vez;
//   · o painel de histórico da UI, aberto num navegador de verdade, mostra a
//     linha do tempo e NÃO contém nenhum controle que aja.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_RP ?? 7794);
const PORTA_FIX = Number(process.env.PORTA_FIX_RP ?? 8952);
const DIR = "/tmp/la-replay-runtime";
const SESSOES = "/tmp/la-replay-sessoes";
const CANARIO = `CANARIO-REPLAY-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

let DAEMON = null, NAV = null, FIXTURE = null;
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body>
<h1 id="t">Entrar</h1>
<input id="senha" type="password" name="password" placeholder="senha"
       oninput="document.getElementById('eco').textContent=this.value">
<div id="eco"></div>
<button id="ok" onclick="document.getElementById('t').textContent='ENTROU'">Entrar</button>
</body></html>`;

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-replay",
                   authorization: `Bearer ${token}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); } }); });
    q.on("error", reject); if (dados) q.write(dados); q.end();
  });
}

async function limpar() {
  try { await NAV?.close(); } catch { /* já foi */ }
  try { DAEMON?.kill("SIGKILL"); } catch { /* já foi */ }
  try { FIXTURE?.close(); } catch { /* já foi */ }
}

async function main() {
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  FIXTURE = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML); });
  await new Promise((r) => FIXTURE.listen(PORTA_FIX, "127.0.0.1", r));

  DAEMON = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"] });
  DAEMON.stdout.on("data", () => {}); DAEMON.stderr.on("data", () => {});

  let token = "";
  for (let i = 0; i < 40 && token === ""; i += 1) {
    await nap(400);
    try { token = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  for (let i = 0; i < 60; i += 1) { try { if ((await req("GET", "/health", undefined, token)).status === 200) break; } catch { /* de novo */ } await nap(300); }

  // ── sessão REAL: navegar, digitar segredo, clicar ────────────────────────
  const criada = await req("POST", "/api/v1/sessions",
    { owner: "dono", capabilities: { navigate: true, read: true, click: true, type: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" }, token);
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  await req("POST", "/api/v1/browser.type",
    { session_id: sid, target: { selector: "#senha" }, text: CANARIO }, token);
  await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#ok" } }, token);

  // A página REALMENTE recebeu o segredo — sem isto, "não vazou" seria trivial.
  //
  // A confirmação vem da PRÓPRIA PÁGINA, não do runtime: o campo de senha ecoa
  // o que recebe num `<div id="eco">`. Ler `#senha` não serviria — o valor
  // digitado vive na PROPRIEDADE do elemento, e o atributo `value` do HTML
  // continua vazio; foi assim que a primeira versão deste controle falhou, e o
  // controle existe exatamente para pegar esse tipo de vácuo.
  const conferencia = await req("POST", "/api/v1/browser.extract",
    { session_id: sid, selector: "#eco" }, token);
  const chegou = JSON.stringify(conferencia.corpo).includes(CANARIO);
  caso("0. controle: o segredo REALMENTE foi digitado na página",
       chegou, chegou ? "o campo #senha contém o canário" : "o canário nem chegou na página — o resto do teste seria vácuo");

  await req("DELETE", `/api/v1/sessions/${sid}`, undefined, token);

  // ── 1. o replay é da sessão que aconteceu ────────────────────────────────
  const rep = await req("GET", `/api/v1/sessions/${sid}/replay`, undefined, token);
  const rotulos = (rep.corpo.timeline ?? []).map((i) => i.label).join(" | ");
  const temTudo = /browser\.open/.test(rotulos) && /browser\.type/.test(rotulos) && /browser\.click/.test(rotulos);
  caso("1. o histórico é da sessão REAL (open + type + click gravados)",
       rep.status === 200 && temTudo, `${rep.corpo.contagens?.acoes ?? 0} ações · ${rotulos.slice(0, 90)}…`);

  // ── 2. o modo vem do runtime ─────────────────────────────────────────────
  caso("2. o runtime DECLARA o modo somente leitura",
       rep.corpo.read_only === true && rep.corpo.mode === "REPLAY",
       `read_only=${rep.corpo.read_only} mode=${rep.corpo.mode} selado=${rep.corpo.selado}`);

  // ── 3. FASE 17 × 18: nem o replay inteiro carrega o segredo ──────────────
  const bruto = JSON.stringify(rep.corpo);
  caso("3. o canário digitado NÃO aparece no replay inteiro",
       !bruto.includes(CANARIO),
       bruto.includes(CANARIO) ? "VAZOU no corpo do replay" : `${bruto.length} bytes varridos, limpo`);

  // ...nem no que ficou gravado em disco.
  const naTrilha = [];
  const dirSes = path.join(SESSOES, sid);
  for (const f of fs.existsSync(dirSes) ? fs.readdirSync(dirSes) : []) {
    const alvo = path.join(dirSes, f);
    if (!fs.statSync(alvo).isFile()) continue;
    if (fs.readFileSync(alvo, "utf8").includes(CANARIO)) naTrilha.push(f);
  }
  caso("4. nem os arquivos gravados da sessão", naTrilha.length === 0,
       naTrilha.length === 0 ? "nenhum arquivo" : `VAZOU em ${naTrilha.join(", ")}`);

  // ── 5. READ_ONLY é do roteador, não da tela ──────────────────────────────
  const escritas = [];
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await req(m, `/api/v1/sessions/${sid}/replay`, m === "POST" ? {} : undefined, token);
    escritas.push(`${m}=${r.status}`);
  }
  caso("5. nenhum verbo de escrita existe em /replay",
       escritas.every((e) => e.endsWith("=405")), escritas.join(" "));

  // ── 6. o painel da UI, num navegador de verdade ──────────────────────────
  NAV = await chromium.launch({ headless: true });
  const pagina = await NAV.newPage();
  const errosJs = [];
  pagina.on("pageerror", (e) => errosJs.push(String(e.message)));
  await pagina.goto(`http://127.0.0.1:${PORTA}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await pagina.evaluate((s) => { S.sessionId = s; }, sid);
  await pagina.click('[data-tab-hist], [role="tab"][data-aba="history"]').catch(() => {});
  await nap(1200);

  const painel = await pagina.evaluate(() => {
    const p = document.getElementById("p-history");
    return {
      visivel: p !== null && !p.hidden,
      selo: document.getElementById("histSelo")?.dataset.ro,
      meta: document.getElementById("hist-meta")?.textContent ?? "",
      itens: p ? p.querySelectorAll(".hi").length : 0,
      texto: p ? p.textContent : "",
      // O que importa para READ_ONLY: quantas alavancas de AÇÃO o painel tem.
      // O botão "Recarregar" é uma LEITURA; conta-se à parte.
      controles: p ? [...p.querySelectorAll("button, input, select, textarea, a[href]")]
        .map((e) => e.id || e.tagName.toLowerCase()) : [],
    };
  });

  caso("6. o painel de histórico desenha a linha do tempo real",
       painel.visivel && painel.itens > 0, `${painel.itens} itens · ${painel.meta.slice(0, 70)}`);
  caso("7. o selo SOMENTE LEITURA acende pelo runtime",
       painel.selo === "1", `data-ro=${painel.selo}`);

  const queAgem = painel.controles.filter((c) => c !== "histRecarregar");
  caso("8. o painel não contém NENHUM controle que aja",
       queAgem.length === 0,
       queAgem.length === 0 ? "só o botão de recarregar (leitura)" : `alavancas de ação encontradas: ${queAgem.join(", ")}`);

  caso("9. o canário não aparece na tela renderizada",
       !(painel.texto ?? "").includes(CANARIO),
       (painel.texto ?? "").includes(CANARIO) ? "VAZOU no DOM do painel" : "DOM limpo");

  // ── 10. "não existe" não pode virar "não fez nada" ───────────────────────
  //
  // Uma sessão inventada tem exatamente a mesma FORMA de uma sessão real que
  // gravou pouco: linha do tempo vazia, contagens em zero. Se a rota devolvesse
  // 200 para as duas, a tela diria "essa sessão não fez nada" sobre algo que
  // nunca houve. A rota tem que separar as duas — e a tela tem que dizer que
  // não conseguiu ler, em vez de desenhar um histórico vazio convincente.
  const inventada = await req("GET", "/api/v1/sessions/ses_nao_existe_0000/replay", undefined, token);
  caso("10. sessão inexistente é 404, não um replay vazio de 200",
       inventada.status === 404, `HTTP ${inventada.status} · ${inventada.corpo?.error?.code ?? "?"}`);

  await pagina.evaluate(() => { S.sessionId = "ses_nao_existe_0000"; });
  await pagina.evaluate(() => historico());
  await nap(800);
  const semHist = await pagina.evaluate(() => ({
    meta: document.getElementById("hist-meta")?.textContent ?? "",
    selo: document.getElementById("histSelo")?.dataset.ro,
    itens: document.querySelectorAll("#hist-linha .hi").length,
  }));
  const honesto = semHist.itens === 0 && semHist.selo === "0" && /não foi possível/i.test(semHist.meta);
  caso("10b. a tela DIZ que não conseguiu ler, e não acende o selo",
       honesto, `itens=${semHist.itens} selo=${semHist.selo} · "${semHist.meta.slice(0, 60)}"`);

  caso("11. nenhum erro de JS na operação do painel", errosJs.length === 0,
       errosJs.length === 0 ? "console limpo" : errosJs.slice(0, 2).join(" | "));

  console.log(`\nCANARIO=${CANARIO}`);
  console.log(`REPLAY_MODE=${rep.corpo.read_only === true ? "READ_ONLY" : "GRAVAVEL"}`);
  console.log(`SECRET_LEAK_IN_REPLAY=${bruto.includes(CANARIO) || naTrilha.length > 0 ? "SIM" : "0"}`);
  console.log(`FALHAS=${falhas}`);
}

main().then(async () => { await limpar(); process.exit(falhas === 0 ? 0 : 1); })
      .catch(async (e) => { console.error("ERRO DO INSTRUMENTO:", e); await limpar(); process.exit(2); });
