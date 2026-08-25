// ─────────────────────────────────────────────────────────────────────────────
// E2E DOS MODOS DE FALHA — FASE 25.
//
// Um console que só é honesto quando tudo funciona não é honesto: é sortudo.
// O que se mede aqui é o que a tela e o runtime dizem quando as coisas quebram,
// e a regra é sempre a mesma — DIZER O QUE NÃO SE SABE é obrigatório, INVENTAR
// é proibido.
//
// O caso que vale por todos os outros é o 6: quando o estado de autonomia não
// pode ser comprovado, a tela NUNCA pode mostrar AUTO. Um console que, ao
// reconectar, restaura "agir sem perguntar" a partir da própria memória está
// concedendo autonomia que ninguém concedeu naquele instante.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_FL ?? 7795);
const PORTA_FIX = Number(process.env.PORTA_FIX_FL ?? 8971);
const PORTA_MUDA = Number(process.env.PORTA_MUDA_FL ?? 8972);
const DIR = "/tmp/la-falhas-runtime";
const SESSOES = "/tmp/la-falhas-sessoes";

let DAEMON = null, NAV = null, FIXTURE = null, MUDO = null, TOKEN = "";
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Alvo</title></head>
<body><div id="etapa">INICIO</div><button id="ok">Continuar</button></body></html>`;

function req(metodo, rota, corpo, ms = 15000) {
  return new Promise((resolve) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo, timeout: ms,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-falhas",
                   authorization: `Bearer ${TOKEN}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); } }); });
    // Runtime caído é um RESULTADO deste teste, não uma exceção dele.
    q.on("error", (e) => resolve({ status: 0, corpo: { error: { code: "SEM_RUNTIME", message: e.message } } }));
    q.on("timeout", () => { q.destroy(); resolve({ status: 0, corpo: { error: { code: "SEM_RESPOSTA" } } }); });
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

async function subirDaemon() {
  const d = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true",
           NOMOS_BROWSER_ACTION_TIMEOUT_MS: "6000" },
    stdio: ["ignore", "pipe", "pipe"] });
  d.stdout.on("data", () => {}); d.stderr.on("data", () => {});
  TOKEN = "";
  for (let i = 0; i < 50 && TOKEN === ""; i += 1) {
    await nap(400);
    try { TOKEN = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  for (let i = 0; i < 60; i += 1) { if ((await req("GET", "/health")).status === 200) break; await nap(300); }
  return d;
}

/** Espera a condição virar verdadeira na TELA, sem passar de `ms`. */
async function ateNaTela(pagina, fn, ms, rotulo) {
  const fim = Date.now() + ms;
  let ultimo = null;
  while (Date.now() < fim) {
    ultimo = await pagina.evaluate(fn).catch(() => null);
    if (ultimo !== null && ultimo.ok === true) return ultimo;
    await nap(200);
  }
  return ultimo ?? { ok: false, obs: `tempo esgotado: ${rotulo}` };
}

const LER_FAIXA = () => ({
  ok: true,
  status: document.getElementById("f-status")?.dataset.estado,
  statusTexto: document.getElementById("f-status")?.textContent,
  modo: document.getElementById("f-modo")?.dataset.modo,
  modoTexto: document.getElementById("f-modo")?.textContent,
  aviso: document.getElementById("autoAviso")?.textContent ?? "",
  marcados: [...document.querySelectorAll("#autonomia input[name=modo]")].filter((r) => r.checked).map((r) => r.value),
});

async function limpar() {
  try { await NAV?.close(); } catch { /* já foi */ }
  try { DAEMON?.kill("SIGKILL"); } catch { /* já foi */ }
  try { FIXTURE?.close(); } catch { /* já foi */ }
  try { MUDO?.close(); } catch { /* já foi */ }
}

/**
 * Constrói a UI antes de medir.
 *
 * O daemon serve `packages/ui/dist/index.html`, que é ARTEFATO DE BUILD e não
 * entra no git. Editar `src/app.html` e rodar este teste direto mede a versão
 * ANTERIOR da tela — foi assim que uma mutação deliberada na UI "passou" sem
 * derrubar caso nenhum, o que teria feito o teste parecer cego quando o cego
 * era o instrumento. Construir aqui é a diferença entre medir a tela que existe
 * e medir a que existia da última vez que alguém rodou a suíte.
 */
async function construirUI() {
  const { execSync } = await import("node:child_process");
  try {
    execSync("node packages/ui/build.ts", { cwd: RAIZ, stdio: "pipe" });
  } catch (e) {
    console.error("ERRO DO INSTRUMENTO: build da UI falhou —", String(e.stderr ?? e.message).slice(0, 300));
    process.exit(2);
  }
}

async function main() {
  await construirUI();
  for (const p of [PORTA, PORTA_FIX, PORTA_MUDA]) {
    if (!(await portaLivre(p))) {
      console.error(`ERRO DO INSTRUMENTO: porta ${p} ocupada — provável órfão. lsof -ti tcp:${p} | xargs kill -9`);
      process.exit(2);
    }
  }
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  FIXTURE = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML); });
  await new Promise((r) => FIXTURE.listen(PORTA_FIX, "127.0.0.1", r));

  // Servidor que ACEITA a conexão e nunca responde. Não é um servidor lento:
  // é um que nunca termina. Um timeout que só cobre "lento" não cobre isto.
  MUDO = net.createServer(() => { /* segura o socket, sem escrever nada */ });
  await new Promise((r) => MUDO.listen(PORTA_MUDA, "127.0.0.1", r));

  DAEMON = await subirDaemon();
  const BASE = `http://127.0.0.1:${PORTA_FIX}`;

  const criada = await req("POST", "/api/v1/sessions",
    { owner: "dono", capabilities: { navigate: true, read: true, click: true, type: true } });
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" });
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: `${BASE}/` });

  // ── 1. erro de ação: alvo que não existe ─────────────────────────────────
  const semAlvo = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#nao-existe" } });
  const falhouBem = semAlvo.corpo.success === false && typeof semAlvo.corpo.error?.code === "string";
  caso("1. alvo inexistente falha COM CÓDIGO, não em silêncio",
       falhouBem, `http=${semAlvo.status} code=${semAlvo.corpo.error?.code} "${(semAlvo.corpo.error?.message ?? "").slice(0, 60)}"`);

  // Controle: a sessão continua utilizável depois do erro. Um erro que derruba
  // a sessão inteira é outro defeito, e sem este controle ele passaria.
  const depoisDoErro = await req("POST", "/api/v1/browser.extract", { session_id: sid, selector: "#etapa" });
  caso("1b. controle: a sessão sobrevive ao erro de ação",
       depoisDoErro.corpo.success === true, `success=${depoisDoErro.corpo.success}`);

  // ── 2. página que nunca responde ─────────────────────────────────────────
  const t0 = Date.now();
  const pendurada = await req("POST", "/api/v1/browser.goto",
    { session_id: sid, url: `http://127.0.0.1:${PORTA_MUDA}/` }, 40000);
  const gastou = Date.now() - t0;
  caso("2. página que nunca responde vira ERRO COM PRAZO, não travamento",
       pendurada.corpo.success === false && gastou < 35000,
       `${gastou}ms · code=${pendurada.corpo.error?.code}`);

  // ── 3. Chromium morto por baixo ──────────────────────────────────────────
  const antesDoKill = await req("GET", `/api/v1/sessions/${sid}/live`);

  // O Chromium NÃO é achado por `browser_pid` do state.json: aquele campo
  // guarda o pid do DAEMON (o processo que detém o navegador, que é o que o
  // modelo de recuperação precisa saber). Matá-lo seria o caso 5, não este.
  // O navegador é filho do daemon — é assim que se chega nele.
  const { execSync } = await import("node:child_process");
  const filhos = execSync(`pgrep -P ${DAEMON.pid} || true`, { encoding: "utf8" })
    .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const doNavegador = filhos.filter((pid) => {
    try { return /chrom/i.test(execSync(`ps -o command= -p ${pid}`, { encoding: "utf8" })); }
    catch { return false; }
  });

  if (doNavegador.length === 0) {
    caso("3. navegador morto: NÃO MEDIDO — nenhum processo Chromium filho do daemon",
         false, `filhos do daemon ${DAEMON.pid}: [${filhos.join(", ")}]`);
  } else {
    for (const pid of doNavegador) { try { process.kill(pid, "SIGKILL"); } catch { /* já morto */ } }
    await nap(2000);
    const aposKill = await req("POST", "/api/v1/browser.extract", { session_id: sid, selector: "#etapa" });
    caso("3. navegador morto: a ação seguinte falha honestamente, sem inventar resultado",
         aposKill.corpo.success === false && typeof aposKill.corpo.error?.code === "string",
         `matou [${doNavegador.join(", ")}] · success=${aposKill.corpo.success} code=${aposKill.corpo.error?.code}`);

    // Não basta falhar: tem que falhar DIZENDO A COISA CERTA. `TARGET_NOT_FOUND`
    // manda o operador caçar um seletor que está correto; o problema é que a
    // página sumiu. Um `browser.screenshot` — que não tem alvo nenhum —
    // devolvendo "alvo não encontrado" é a prova de que o código estava errado.
    const semAlvoNenhum = await req("POST", "/api/v1/browser.screenshot", { session_id: sid });
    caso("3c. e o código diz NAVEGADOR INDISPONÍVEL, não 'alvo não encontrado'",
         aposKill.corpo.error?.code === "BROWSER_UNAVAILABLE" && semAlvoNenhum.corpo.error?.code === "BROWSER_UNAVAILABLE",
         `extract=${aposKill.corpo.error?.code} screenshot=${semAlvoNenhum.corpo.error?.code}`);

    // E o runtime NÃO continua anunciando a sessão como se nada tivesse
    // acontecido. Um `runtime_state` alegre sobre um navegador morto é a
    // mentira mais fácil de contar aqui.
    const vivoAposKill = await req("GET", `/api/v1/sessions/${sid}/live`);
    caso("3b. e o runtime não anuncia a sessão como se nada tivesse acontecido",
         vivoAposKill.status !== 200 || vivoAposKill.corpo.runtime_state !== antesDoKill.corpo.runtime_state
           || vivoAposKill.corpo.active_url !== antesDoKill.corpo.active_url,
         `antes=${antesDoKill.corpo.runtime_state}/${antesDoKill.corpo.active_url} depois=${vivoAposKill.corpo.runtime_state}/${vivoAposKill.corpo.active_url}`);
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  NAV = await chromium.launch({ headless: true });
  const pagina = await NAV.newPage();
  const errosJs = [];
  pagina.on("pageerror", (e) => errosJs.push(String(e.message)));
  await pagina.goto(`http://127.0.0.1:${PORTA}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: "domcontentloaded" });

  // Sessão nova e saudável, em AUTO, para a tela ter o que mostrar.
  const s2 = await req("POST", "/api/v1/sessions",
    { owner: "dono", capabilities: { navigate: true, read: true, click: true } });
  const sid2 = s2.corpo.session_id ?? s2.corpo.id;
  await req("POST", `/api/v1/sessions/${sid2}/autonomy`, { mode: "AUTO", by: "dono" });
  await req("POST", "/api/v1/browser.open", { session_id: sid2, url: `${BASE}/` });
  await pagina.evaluate((s) => { S.sessionId = s; }, sid2);

  const emAuto = await ateNaTela(pagina, () => {
    const m = document.getElementById("f-modo")?.dataset.modo;
    return { ok: m === "AUTO", modo: m };
  }, 8000, "a tela mostrar AUTO");
  caso("4. controle: com runtime vivo, a tela MOSTRA o modo AUTO real",
       emAuto.ok === true, `modo=${emAuto.modo}`);

  // ── 5. daemon morto com a UI aberta ──────────────────────────────────────
  DAEMON.kill("SIGKILL");
  await nap(500);
  const caido = await ateNaTela(pagina, () => {
    const st = document.getElementById("f-status")?.dataset.estado;
    return { ok: st === "DISCONNECTED", ...{
      status: st,
      modo: document.getElementById("f-modo")?.dataset.modo,
      aviso: document.getElementById("autoAviso")?.textContent ?? "",
      marcados: [...document.querySelectorAll("#autonomia input[name=modo]")].filter((r) => r.checked).map((r) => r.value),
    } };
  }, 12000, "a tela declarar DESCONECTADO");
  caso("5. runtime caído: a tela DIZ que está desconectada",
       caido.ok === true, `status=${caido.status}`);

  // ── 6. O CASO QUE VALE POR TODOS ─────────────────────────────────────────
  caso("6. runtime caído: a tela NUNCA mostra AUTO — cai para desconhecido",
       caido.modo !== "AUTO" && caido.marcados.length === 0,
       `modo=${caido.modo} radios marcados=[${caido.marcados.join(",")}] aviso="${caido.aviso}"`);
  caso("6b. e explica o que vai fazer enquanto não sabe",
       /pergunt/i.test(caido.aviso), `aviso="${caido.aviso}"`);

  // ── 7. reconexão sem ressuscitar autonomia da memória ────────────────────
  //
  // O daemon volta com a MESMA porta e o MESMO diretório, mas a sessão em
  // memória se foi. A tela não pode reaproveitar o AUTO que viu antes da queda:
  // aquele modo foi concedido para uma sessão que não existe mais.
  DAEMON = await subirDaemon();
  await pagina.evaluate((t) => { TOKEN_UI = t; }, TOKEN).catch(() => {});
  await nap(3000);
  const reconectado = await pagina.evaluate(LER_FAIXA);
  caso("7. reconectado: a autonomia NÃO volta a AUTO por memória da tela",
       reconectado.modo !== "AUTO",
       `modo=${reconectado.modo} texto="${reconectado.modoTexto}" status=${reconectado.status}`);

  // ── 8. sessão perdida ────────────────────────────────────────────────────
  const perdida = await pagina.evaluate(LER_FAIXA);
  caso("8. sessão que não existe mais não é pintada como viva",
       perdida.status !== "ACTING" && perdida.status !== "IDLE",
       `status=${perdida.status} texto="${perdida.statusTexto}"`);

  caso("9. nenhum erro de JS durante toda a sequência de falhas",
       errosJs.length === 0, errosJs.length === 0 ? "console limpo" : errosJs.slice(0, 2).join(" | "));

  console.log("");
  console.log(`FAILSAFE_AUTONOMIA=${caido.modo !== "AUTO" && reconectado.modo !== "AUTO" ? "NUNCA_AUTO_SEM_PROVA" : "FALHOU"}`);
  console.log(`FAILURE_MODES_E2E=${falhas === 0 ? "PASS" : "FALHA"}`);
  console.log(`FALHAS=${falhas}`);
}

main().then(async () => { await limpar(); process.exit(falhas === 0 ? 0 : 1); })
      .catch(async (e) => { console.error("ERRO DO INSTRUMENTO:", e); await limpar(); process.exit(2); });
