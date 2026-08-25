// ─────────────────────────────────────────────────────────────────────────────
// DEMOS REPRODUZÍVEIS — A a F.
//
// Cada demo é um roteiro que um usuário pode seguir à mão. Este arquivo executa
// os mesmos passos contra um runtime e um Chromium REAIS e grava a saída, para
// que a documentação não descreva um comportamento que ninguém observou.
//
// Um roteiro de demo sem execução é uma promessa. Com execução, é uma prova que
// caduca — e caducar é bom: no dia em que o produto mudar, esta bateria falha.
//
// Uso:  node demos/rodar-demos.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "..");
const PORTA = Number(process.env.PORTA_DEMO ?? 7801);
const PORTA_FIX = Number(process.env.PORTA_FIX_DEMO ?? 8991);
const DIR = "/tmp/la-demo-runtime";
const SESSOES = "/tmp/la-demo-sessoes";

let DAEMON = null, FIXTURE = null, TOKEN = "";
let falhas = 0;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

function demo(letra, titulo) { console.log(`\n${"─".repeat(72)}\nDEMO ${letra} — ${titulo}\n${"─".repeat(72)}`); }
function passo(desc, ok, obs) {
  falhas += ok ? 0 : 1;
  console.log(`  [${ok ? "OK" : "FALHA"}] ${desc}${obs ? ` — ${obs}` : ""}`);
}

const PAGINAS = {
  "/": `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Entrar</title></head>
<body><h1 id="titulo">Entrar</h1><div id="etapa">INICIO</div>
<input id="usuario" type="text"><input id="senha" type="password">
<button id="entrar" onclick="document.getElementById('etapa').textContent='LOGADO'">Entrar</button>
</body></html>`,
  "/painel": `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Painel</title></head>
<body><div id="etapa">LOGADO</div><div id="saldo">R$ 42,00</div>
<button id="exportar" onclick="document.getElementById('etapa').textContent='EXPORTADO'">Exportar</button>
</body></html>`,
};

function req(metodo, rota, corpo) {
  return new Promise((resolve) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "demos",
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

/** Dispara sem esperar, decide o que aparecer, devolve o que foi perguntado. */
async function comAprovacao(sid, rota, corpo, aprovar = true) {
  const promessa = req("POST", `/api/v1/${rota}`, { session_id: sid, ...corpo });
  let perguntou = null;
  for (let i = 0; i < 50; i += 1) {
    const fim = await Promise.race([promessa.then(() => "fim"), nap(100).then(() => "segue")]);
    if (fim === "fim") break;
    const f = await req("GET", `/api/v1/sessions/${sid}/approvals`);
    const pend = (f.corpo.pendentes ?? []).filter((p) => p.estado === "PENDENTE");
    if (pend.length === 0) continue;
    perguntou = pend[0];
    await req("POST", `/api/v1/approvals/${perguntou.approval_id}/${aprovar ? "approve" : "deny"}`, { by: "dono" });
    break;
  }
  const resposta = await Promise.race([
    promessa,
    nap(20000).then(() => ({ status: 0, corpo: { error: { code: "PENDUROU" } } })),
  ]);
  return { resposta, perguntou };
}

async function limpar() {
  try { DAEMON?.kill("SIGKILL"); } catch { /* já foi */ }
  try { FIXTURE?.close(); } catch { /* já foi */ }
}

async function main() {
  for (const p of [PORTA, PORTA_FIX]) {
    if (!(await portaLivre(p))) {
      console.error(`ERRO: porta ${p} ocupada. lsof -ti tcp:${p} | xargs kill -9`);
      process.exit(2);
    }
  }
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  FIXTURE = http.createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(PAGINAS[(q.url ?? "/").split("?")[0]] ?? PAGINAS["/"]);
  });
  await new Promise((r) => FIXTURE.listen(PORTA_FIX, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${PORTA_FIX}`;

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

  // ── DEMO A — controle de navegador básico ────────────────────────────────
  demo("A", "controle de navegador básico");
  const saude = await req("GET", "/health");
  passo("o runtime responde /health", saude.status === 200 && saude.corpo.runtime === "ok",
        `contract=${saude.corpo.contract} browser=${saude.corpo.browser}`);

  const criada = await req("POST", "/api/v1/sessions",
    // `upload: true` é deliberado: sem ele, a DEMO C não provaria nada sobre
    // autonomia. O portão de capability roda ANTES do de autonomia, então um
    // upload sem capability é negado com `CAPABILITY_DENIED` e nunca chega a
    // pedir aprovação — foi o que aconteceu na primeira execução desta bateria.
    // Aqui a capability é concedida justamente para que quem recuse seja o
    // portão de AUTONOMIA, que é o que a demo quer mostrar.
    { owner: "demo", capabilities: { navigate: true, read: true, click: true, type: true, upload: true } });
  const sid = criada.corpo.session_id;
  passo("sessão criada", criada.status === 201 && typeof sid === "string", sid);

  const aberta = await req("POST", "/api/v1/browser.open", { session_id: sid, url: `${BASE}/` });
  passo("página aberta num Chromium real", aberta.corpo.success === true,
        `título="${aberta.corpo.result?.title ?? "?"}"`);

  const lida = await req("POST", "/api/v1/browser.extract", { session_id: sid, selector: "#etapa" });
  passo("conteúdo extraído", JSON.stringify(lida.corpo).includes("INICIO"), "#etapa = INICIO");

  const semAlvo = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#nao-existe" } });
  passo("alvo inexistente falha COM CÓDIGO, não em silêncio",
        semAlvo.corpo.success === false, `code=${semAlvo.corpo.error?.code}`);

  // ── DEMO B — modo ASK ────────────────────────────────────────────────────
  demo("B", "modo ASK: o agente pergunta antes de mudar a página");
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "ASK", by: "dono" });

  const leitura = await comAprovacao(sid, "browser.extract", { selector: "#etapa" });
  passo("LEITURA não pergunta", leitura.perguntou === null,
        "perguntar para ler treina o dono a aprovar sem ler");

  const clique = await comAprovacao(sid, "browser.click", { target: { selector: "#entrar" } });
  passo("AÇÃO pergunta", clique.perguntou !== null,
        clique.perguntou ? `nível ${clique.perguntou.nivel} · "${clique.perguntou.consequencia}"` : "não perguntou");
  passo("aprovada, a ação acontece", clique.resposta.corpo.success === true);

  const conferir = await comAprovacao(sid, "browser.extract", { selector: "#etapa" });
  passo("o efeito está na página", JSON.stringify(conferir.resposta.corpo).includes("LOGADO"), "#etapa = LOGADO");

  // ── DEMO C — modo AUTO ───────────────────────────────────────────────────
  demo("C", "modo AUTO: age sozinho, mas não é bypass");
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: "AUTO", by: "dono" });

  const auto = await comAprovacao(sid, "browser.goto", { url: `${BASE}/painel` });
  passo("navegação passa direto em AUTO", auto.perguntou === null && auto.resposta.corpo.success === true);

  const anexo = "/tmp/la-demo-anexo.txt";
  fs.writeFileSync(anexo, "anexo de demonstração\n", "utf8");
  const protegida = await comAprovacao(sid, "browser.upload",
    { target: { selector: "#usuario" }, files: [anexo] }, false);
  passo("AUTO != BYPASS: upload AINDA pergunta", protegida.perguntou !== null,
        protegida.perguntou ? `"${protegida.perguntou.motivo}"` : "PASSOU DIRETO — seria o defeito");
  passo("negada, é recusada", protegida.resposta.corpo?.error?.code === "APPROVAL_DENIED",
        `code=${protegida.resposta.corpo?.error?.code}`);

  // ── DEMO D — task multipasso ─────────────────────────────────────────────
  demo("D", "task multipasso: aprovar o objetivo não é cheque em branco");
  const perfil = await req("GET", `/api/v1/sessions/${sid}/autonomy`);
  passo("modo corrente é AUTO", perfil.corpo.autonomy_mode === "AUTO", `modo=${perfil.corpo.autonomy_mode}`);

  const tarefa = await comAprovacao(sid, "browser.task", { goal: "conferir o saldo exibido" }, false);
  passo("browser.task pede aprovação MESMO em AUTO", tarefa.perguntou !== null,
        tarefa.perguntou ? `nível ${tarefa.perguntou.nivel} · "${tarefa.perguntou.consequencia}"` : "não perguntou");
  console.log("       (em ASK, cada PASSO do plano reentra no portão — ver tests/task-engine.test.ts)");

  // ── DEMO E — console acompanhando ────────────────────────────────────────
  demo("E", "Live Agent Console: o estado que a tela mostra vem do runtime");
  const vivo = await req("GET", `/api/v1/sessions/${sid}/live`);
  passo("/live devolve estado canônico", vivo.status === 200,
        `runtime_state=${vivo.corpo.runtime_state} autonomy_mode=${vivo.corpo.autonomy_mode} control=${vivo.corpo.control}`);
  passo("declara quais rotas ainda perguntam em AUTO",
        Array.isArray(vivo.corpo.sempre_aprovam) && vivo.corpo.sempre_aprovam.length > 0,
        (vivo.corpo.sempre_aprovam ?? []).join(", "));

  const pausa = await req("POST", `/api/v1/sessions/${sid}/pause`, {});
  const vivoPausado = await req("GET", `/api/v1/sessions/${sid}/live`);
  passo("pausar é um controle REAL no backend",
        pausa.status === 200 && vivoPausado.corpo.runtime_state === "PAUSED",
        `runtime_state=${vivoPausado.corpo.runtime_state}`);
  const durantePausa = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#exportar" } });
  passo("pausado, a ação é recusada", durantePausa.corpo.success === false, `code=${durantePausa.corpo.error?.code}`);
  const leituraPausa = await req("POST", "/api/v1/browser.extract", { session_id: sid, selector: "#etapa" });
  passo("mas OBSERVAR continua permitido", leituraPausa.corpo.success === true,
        "a tela precisa seguir viva para o operador decidir");
  await req("POST", `/api/v1/sessions/${sid}/resume`, {});

  // ── DEMO F — auditoria e replay ──────────────────────────────────────────
  demo("F", "auditoria e replay somente leitura");
  await req("DELETE", `/api/v1/sessions/${sid}`);
  const rep = await req("GET", `/api/v1/sessions/${sid}/replay`);
  passo("replay da sessão encerrada", rep.status === 200 && rep.corpo.contagens?.acoes > 0,
        `${rep.corpo.contagens?.acoes} ações · selado=${rep.corpo.selado}`);
  passo("o runtime DECLARA somente leitura", rep.corpo.read_only === true && rep.corpo.mode === "REPLAY");

  const escritas = [];
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    escritas.push(`${m}=${(await req(m, `/api/v1/sessions/${sid}/replay`, m === "POST" ? {} : undefined)).status}`);
  }
  passo("não existe verbo de escrita em /replay", escritas.every((e) => e.endsWith("=405")), escritas.join(" "));

  const inventada = await req("GET", "/api/v1/sessions/ses_nunca_existiu/replay");
  passo('"não existe" não vira "não fez nada"', inventada.status === 404,
        `HTTP ${inventada.status} · ${inventada.corpo.error?.code}`);

  const verif = await req("GET", `/api/v1/sessions/${sid}/replay/verify`);
  const errosReais = (verif.corpo.problemas ?? []).filter((x) => x.severidade !== "aviso");
  passo("integridade do replay verificada", verif.status === 200 && verif.corpo.integro === true,
        `integro=${verif.corpo.integro} erros=${verif.corpo.contagens?.erros}` +
        (errosReais.length > 0 ? ` :: ${errosReais.slice(0, 3).map((x) => x.codigo + " " + x.arquivo).join(" | ")}` : ""));

  console.log(`\n${"═".repeat(72)}`);
  console.log(`DEMOS_EXECUTADAS=6`);
  console.log(`FALHAS=${falhas}`);
  console.log(`DEMOS_REPRODUZIVEIS=${falhas === 0 ? "PASS" : "FALHA"}`);
}

main().then(async () => { await limpar(); process.exit(falhas === 0 ? 0 : 1); })
      .catch(async (e) => { console.error("ERRO DO INSTRUMENTO:", e); await limpar(); process.exit(2); });
