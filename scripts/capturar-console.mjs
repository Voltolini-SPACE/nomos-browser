// ─────────────────────────────────────────────────────────────────────────────
// CAPTURA DO LIVE AGENT CONSOLE — o produto real, não uma maquete.
//
// A missão de presença pública proíbe "interface fictícia somente para
// marketing" e exige "screenshots reais do console". Então isto não desenha
// nada: sobe o daemon de verdade, cria uma sessão de verdade, coloca o agente
// num estado que EXIGE aprovação, e fotografa a tela que o produto serve.
//
// O estado escolhido não é decorativo. Uma foto do console ocioso não mostra o
// que o produto faz de diferente; a foto que importa é a do momento em que o
// agente PARA e pergunta — é ali que "AUTO != BYPASS" deixa de ser uma frase de
// README e vira uma coisa na tela.
//
// Uso: node scripts/capturar-console.mjs [--out DIR]
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const RAIZ = path.resolve(import.meta.dirname, "..");
const i = process.argv.indexOf("--out");
const OUT = i >= 0 ? process.argv[i + 1] : path.join(RAIZ, "evidence/nomos-public-presence/01-console");
const PORTA = Number(process.env.PORTA_CAP ?? 7811);
const PORTA_FIX = Number(process.env.PORTA_FIX_CAP ?? 8912);
const DIR = "/tmp/cap-console-runtime";
const SESSOES = "/tmp/cap-console-sessoes";

let DAEMON = null;
let NAV = null;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function limpar() {
  try { if (NAV) await NAV.close(); } catch { /* já fechado */ }
  try { if (DAEMON) DAEMON.kill("SIGKILL"); } catch { /* já morto */ }
}

// Porta ocupada não se limpa: se recusa a começar. Matar por porta foi como eu
// derrubei um serviço de terceiro numa missão anterior, e a regra que ficou é
// NO_KILL_WITHOUT_OWNERSHIP_PROOF.
function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(porta, "127.0.0.1");
  });
}

async function ate(fn, ms, oque) {
  const limite = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > limite) throw new Error(`tempo esgotado esperando ${oque}`);
    await espera(250);
  }
}

function req(metodo, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "captura",
                   ...(token ? { authorization: `Bearer ${token}` } : {}) } },
      (r) => { let b = ""; r.on("data", (c) => (b += c));
               r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* não-JSON */ }
                                   resolve({ status: r.statusCode, corpo: j ?? b }); }); });
    q.on("error", reject);
    if (dados !== null) q.write(dados);
    q.end();
  });
}

const HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Portal do fornecedor</title><style>
body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1a1d21}
.topo{background:#fff;border-bottom:1px solid #e3e6ea;padding:14px 28px;font-weight:600}
.caixa{max-width:520px;margin:44px auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:28px}
h1{font-size:19px;margin:0 0 6px}p.sub{color:#5b6470;margin:0 0 22px;font-size:13.5px}
label{display:block;font-size:12.5px;color:#5b6470;margin:14px 0 5px}
input{width:100%;padding:10px 12px;border:1px solid #ccd2d9;border-radius:7px;font-size:14px;box-sizing:border-box}
button{margin-top:22px;width:100%;padding:11px;border:0;border-radius:7px;background:#1a6ef5;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
</style></head><body>
<div class="topo">Portal do fornecedor</div>
<div class="caixa">
  <h1>Confirmar pagamento</h1>
  <p class="sub">Fatura 2026-0841 · vencimento hoje</p>
  <label for="user">Usuário</label><input id="user" name="user" value="operacoes@exemplo.com">
  <label for="pass">Senha</label><input id="pass" name="pass" type="password">
  <button id="alvo">Confirmar pagamento</button>
</div></body></html>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const p of [PORTA, PORTA_FIX]) {
    if (!(await portaLivre(p))) {
      console.error(`ABORTADO: porta ${p} ocupada. Não limpo porta que não é comprovadamente minha.`);
      process.exit(2);
    }
  }

  // A UI é artefato de build e não é versionada. Sem construir, a captura
  // fotografaria uma tela velha — já aconteceu de eu medir uma UI que não
  // existia mais.
  execFileSync("node", ["packages/ui/build.ts"], { cwd: RAIZ, stdio: "pipe" });

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
  for (let k = 0; k < 40 && token === ""; k += 1) {
    await espera(400);
    try { token = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  if (token === "") { console.error("ABORTADO: sem credencial de controle"); await limpar(); process.exit(2); }
  await ate(async () => {
    try { return (await req("GET", "/health", undefined, token)).status === 200 ? true : null; } catch { return null; }
  }, 20000, "o daemon abrir a porta");

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "gi", capabilities: { navigate: true, read: true, click: true, type: true } }, token);
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `http://127.0.0.1:${PORTA_FIX}/` }, token);
  // O corpo pede `mode`, nao `autonomy_mode`. Mandando a chave errada a rota
  // aceita, o modo NAO muda, e o clique passa direto — a captura entao esperava
  // para sempre por uma aprovacao que nunca ia existir. Por isso o modo e
  // CONFERIDO logo abaixo em vez de assumido: estado que se supoe e estado que
  // se erra.
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" }, token);
  const modo = await req("GET", `/api/v1/sessions/${sid}/autonomy`, undefined, token);
  if (modo.corpo?.autonomy_mode !== "ASK") {
    console.error(`ABORTADO: o modo nao virou ASK (veio ${JSON.stringify(modo.corpo?.autonomy_mode)}). ` +
                  "Sem ASK nao existe aprovacao pendente, e a foto nao provaria nada.");
    await limpar(); process.exit(2);
  }

  // A ação que PARA. Sem `await`: em ASK ela fica pendurada esperando a decisão
  // humana, e é exatamente essa espera que a foto precisa mostrar.
  req("POST", "/api/v1/browser.click",
      { session_id: sid, target: { selector: "#alvo" } }, token).catch(() => {});

  await ate(async () => {
    // A rota e por sessao. Na primeira versao eu inventei `?session_id=`, que
    // responde 200 com lista vazia — e lista vazia e indistinguivel de "ainda
    // nao chegou". Errar a rota aqui produz um tempo esgotado que parece
    // defeito do produto e e defeito do instrumento.
    const r = await req("GET", `/api/v1/sessions/${sid}/approvals`, undefined, token);
    const p = (r.corpo?.pendentes ?? []).filter((x) => x.estado === "PENDENTE");
    return p.length > 0 ? p : null;
  }, 20000, "a aprovação aparecer no runtime");

  NAV = await chromium.launch({ headless: true });
  const pag = await NAV.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await pag.goto(`http://127.0.0.1:${PORTA}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await ate(async () => (((await pag.locator("#f-sessao").first().textContent()) ?? "").trim() !== "—" ? true : null),
            15000, "a faixa de estado preencher");
  // A tela só serve se o pedido de aprovação estiver VISÍVEL nela. Fotografar
  // antes disso produziria uma imagem que não prova nada.
  await ate(async () => (await pag.locator("text=/aprova|aprovação|APROVAR/i").first().isVisible().catch(() => false)) ? true : null,
            15000, "o pedido de aprovação aparecer na tela");
  // O ESPELHO tem de estar cheio antes da foto. A primeira captura saiu com o
  // palco preto e eu quase reportei isso como defeito do produto — "a página
  // espelhada não aparece durante a aprovação". Medido depois: o espelho enche
  // em ~1,45 s e CONTINUA visível com aprovação pendente. O preto era a minha
  // foto disparando aos 900 ms, antes do primeiro quadro. Esperar pelo elemento,
  // em vez de dormir um tempo arbitrário, é o que impede a repetição disso.
  await ate(async () => (await pag.locator("#tela").isVisible().catch(() => false)) ? true : null,
            20000, "o espelho da página receber o primeiro quadro");
  await espera(600);

  const desktop = path.join(OUT, "console-aprovacao-desktop.png");
  await pag.screenshot({ path: desktop });

  const og = path.join(OUT, "console-og.png");
  await pag.setViewportSize({ width: 1200, height: 630 });
  await espera(500);
  await pag.screenshot({ path: og });

  const movel = path.join(OUT, "console-mobile.png");
  await pag.setViewportSize({ width: 390, height: 844 });
  await espera(500);
  await pag.screenshot({ path: movel, fullPage: false });

  await limpar();
  await new Promise((r) => fixture.close(r));

  for (const f of [desktop, og, movel]) {
    console.log(`  ${path.basename(f)}  ${fs.statSync(f).size} bytes`);
  }
  console.log(`CAPTURA_CONSOLE=OK  sessao=${sid}  dir=${OUT}`);
}

main().catch(async (e) => { console.error("FALHA:", e.message); await limpar(); process.exit(1); });
