// ─────────────────────────────────────────────────────────────────────────────
// E2E DOS MODOS — FASES 20 e 21.
//
// A mesma JORNADA MULTIPASSO real, executada duas vezes: uma em MODO_PERGUNTAR
// e outra em MODO_AGIR_SEM_PERGUNTAR. O que se mede não é "funciona", é a
// diferença EXATA entre os dois modos:
//
//   · o resultado final tem que ser IDÊNTICO. AUTO não faz menos trabalho —
//     faz menos PERGUNTAS. Se a página terminar diferente, o modo mudou o
//     produto, e não era isso que foi prometido ao dono.
//   · em ASK, toda ação que MUDA a página pergunta; nenhuma LEITURA pergunta.
//     Perguntar para ler é ruído, e ruído treina o dono a aprovar sem ler.
//   · em AUTO, nenhuma dessas perguntas aparece — e a ação protegida CONTINUA
//     perguntando. É o AUTO != BYPASS medido dentro de uma jornada inteira,
//     não numa ação isolada.
//
// UNEXPECTED_APPROVAL_PROMPTS conta pergunta fora do lugar NOS DOIS SENTIDOS:
// uma pergunta em AUTO sobre rota que o dono já autorizou, ou uma pergunta em
// qualquer modo sobre uma simples leitura.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const PORTA = Number(process.env.PORTA_MD ?? 7796);
const PORTA_FIX = Number(process.env.PORTA_FIX_MD ?? 8963);
const DIR = "/tmp/la-modos-runtime";
const SESSOES = "/tmp/la-modos-sessoes";

let DAEMON = null, FIXTURE = null, TOKEN = "";
let falhas = 0;
function caso(nome, ok, obs) { falhas += ok ? 0 : 1; console.log(`[${ok ? "PASS" : "FALHA"}] ${nome} — ${obs}`); }
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixture de duas páginas ─────────────────────────────────────────────────
function pagina(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head>
<body><div id="etapa">INICIO</div>${corpo}</body></html>`;
}
const PAGINAS = {
  "/": pagina("Entrar", `
    <input id="usuario" type="text" placeholder="usuario">
    <button id="entrar" onclick="document.getElementById('etapa').textContent='LOGADO'">Entrar</button>`),
  "/painel": pagina("Painel", `
    <div id="saldo">R$ 42,00</div>
    <button id="exportar" onclick="document.getElementById('etapa').textContent='EXPORTADO'">Exportar</button>`),
};

function req(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request(
      { host: "127.0.0.1", port: PORTA, path: rota, method: metodo,
        headers: { "content-type": "application/json", "x-nomos-client": "e2e-modos",
                   authorization: `Bearer ${TOKEN}`,
                   ...(dados ? { "content-length": Buffer.byteLength(dados) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => { b += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(b || "{}") }); }
          catch { resolve({ status: res.statusCode, corpo: { bruto: b } }); } }); });
    q.on("error", reject); if (dados) q.write(dados); q.end();
  });
}

// ── A JORNADA ───────────────────────────────────────────────────────────────
//
// `muda` diz se a ação altera a página. É a expectativa DECLARADA do teste,
// escrita à mão a partir do contrato — não lida de `PERFIL_DA_ROTA`. Ler a
// mesma tabela que o produto lê provaria só que uma constante é igual a si
// mesma; um erro na tabela passaria despercebido dos dois lados.
function jornada(base) {
  return [
    { rota: "browser.open",    corpo: { url: `${base}/` },                                muda: true  },
    { rota: "browser.extract", corpo: { selector: "#etapa" },                             muda: false, espera: "INICIO" },
    { rota: "browser.type",    corpo: { target: { selector: "#usuario" }, text: "dono" },  muda: true  },
    { rota: "browser.click",   corpo: { target: { selector: "#entrar" } },                 muda: true  },
    { rota: "browser.extract", corpo: { selector: "#etapa" },                             muda: false, espera: "LOGADO" },
    { rota: "browser.goto",    corpo: { url: `${base}/painel` },                           muda: true  },
    { rota: "browser.click",   corpo: { target: { selector: "#exportar" } },               muda: true  },
    { rota: "browser.extract", corpo: { selector: "#etapa" },                             muda: false, espera: "EXPORTADO" },
  ];
}

/**
 * Dispara a ação SEM esperar, vigia a fila de aprovação, decide, e só então
 * colhe o resultado.
 *
 * O disparo não pode ser aguardado antes de decidir: em ASK a chamada FICA
 * PENDURADA até a decisão do dono, que é justamente o comportamento sob teste.
 */
async function executar(sid, passo, aprovar) {
  const promessa = req("POST", `/api/v1/${passo.rota}`, { session_id: sid, ...passo.corpo });
  let perguntou = null;

  for (let i = 0; i < 60; i += 1) {
    const corrida = await Promise.race([promessa.then(() => "TERMINOU"), nap(120).then(() => "AINDA")]);
    if (corrida === "TERMINOU") break;
    const fila = await req("GET", `/api/v1/sessions/${sid}/approvals`);
    const lista = Array.isArray(fila.corpo) ? fila.corpo : (fila.corpo.pendentes ?? fila.corpo.aprovacoes ?? []);
    const pend = lista.filter((p) => p.estado === "PENDENTE");
    if (pend.length === 0) continue;
    perguntou = pend[0];
    await req("POST", `/api/v1/approvals/${perguntou.approval_id}/${aprovar ? "approve" : "deny"}`, { by: "dono" });
    break;
  }

  // Teto duro. Um instrumento que pode pendurar para sempre é pior do que um
  // que falha: o operador não distingue "está pensando" de "morreu". Isto foi
  // acrescentado depois de uma MUTAÇÃO pendurar esta função — sob o produto
  // correto o caminho nunca é usado, e é justamente por isso que ele precisa
  // existir.
  const resposta = await Promise.race([
    promessa,
    nap(20_000).then(() => ({ status: 0, corpo: { error: { code: "INSTRUMENTO_PENDURADO" } } })),
  ]);
  return { resposta, perguntou };
}

async function lerEtapa(sid) {
  // Pelo mesmo caminho da jornada, não por `req` cru: se a leitura passar a
  // exigir aprovação, esta função aprova e segue em vez de pendurar o teste.
  const { resposta: r } = await executar(sid, { rota: "browser.extract", corpo: { selector: "#etapa" }, muda: false }, true);
  const t = JSON.stringify(r.corpo);
  for (const v of ["EXPORTADO", "LOGADO", "INICIO"]) if (t.includes(v)) return v;
  return `?${t.slice(0, 60)}`;
}

/** Roda a jornada inteira num modo e devolve o que aconteceu. */
async function rodar(modo, base) {
  const criada = await req("POST", "/api/v1/sessions",
    { owner: "dono", capabilities: { navigate: true, read: true, click: true, type: true, upload: true } });
  const sid = criada.corpo.session_id ?? criada.corpo.id;
  await req("POST", `/api/v1/sessions/${sid}/autonomy`, { mode: modo, by: "dono" });

  const perguntas = [];
  const erros = [];
  for (const passo of jornada(base)) {
    const { resposta, perguntou } = await executar(sid, passo, true);
    if (perguntou !== null) perguntas.push({ rota: passo.rota, muda: passo.muda, nivel: perguntou.nivel });
    if (resposta.status !== 200 || resposta.corpo.success === false) {
      erros.push(`${passo.rota} → ${resposta.status} ${resposta.corpo?.error?.code ?? ""}`);
    }
    if (passo.espera !== undefined && !JSON.stringify(resposta.corpo).includes(passo.espera)) {
      erros.push(`${passo.rota} esperava "${passo.espera}"`);
    }
  }
  return { sid, perguntas, erros, fim: await lerEtapa(sid) };
}

async function limpar() {
  try { DAEMON?.kill("SIGKILL"); } catch { /* já foi */ }
  try { FIXTURE?.close(); } catch { /* já foi */ }
}

/**
 * Recusa subir se a porta já estiver ocupada.
 *
 * Sem isto, um daemon órfão de uma execução anterior atende as chamadas, o
 * token novo não vale para ele, e a bateria inteira volta 401 — oito casos
 * vermelhos que não dizem nada sobre o produto. Já aconteceu; o teste passou a
 * checar antes em vez de descobrir depois.
 */
function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(porta, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function main() {
  for (const porta of [PORTA, PORTA_FIX]) {
    if (!(await portaLivre(porta))) {
      console.error(`ERRO DO INSTRUMENTO: a porta ${porta} já está ocupada — provável daemon órfão.`);
      console.error(`  lsof -ti tcp:${porta} | xargs kill -9`);
      process.exit(2);
    }
  }
  for (const d of [DIR, SESSOES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  FIXTURE = http.createServer((q, r) => {
    const corpo = PAGINAS[(q.url ?? "/").split("?")[0]] ?? PAGINAS["/"];
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(corpo);
  });
  await new Promise((r) => FIXTURE.listen(PORTA_FIX, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${PORTA_FIX}`;

  DAEMON = spawn("node", ["packages/api/src/daemon.ts"], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_PORT: String(PORTA), NOMOS_BROWSER_HEADLESS: "true",
           NOMOS_RUNTIME_DIR: DIR, NOMOS_SESSIONS_ROOT: SESSOES, NOMOS_BROWSER_ALLOW_INTERNAL: "true" },
    stdio: ["ignore", "pipe", "pipe"] });
  DAEMON.stdout.on("data", () => {}); DAEMON.stderr.on("data", () => {});
  for (let i = 0; i < 40 && TOKEN === ""; i += 1) {
    await nap(400);
    try { TOKEN = fs.readFileSync(path.join(DIR, "control-token"), "utf8").trim(); } catch { /* espera */ }
  }
  for (let i = 0; i < 60; i += 1) { try { if ((await req("GET", "/health")).status === 200) break; } catch { /* de novo */ } await nap(300); }

  const MUDAM = jornada(BASE).filter((p) => p.muda).length;
  const LEEM = jornada(BASE).filter((p) => !p.muda).length;

  // ── FASE 20 — MODO PERGUNTAR ─────────────────────────────────────────────
  const ask = await rodar("ASK", BASE);
  caso("1. ASK: a jornada inteira completa depois das aprovações",
       ask.erros.length === 0 && ask.fim === "EXPORTADO", `fim=${ask.fim} erros=[${ask.erros.join("; ")}]`);

  const askMudam = ask.perguntas.filter((p) => p.muda).length;
  caso("2. ASK: TODA ação que muda a página perguntou",
       askMudam === MUDAM, `${askMudam}/${MUDAM} perguntaram`);

  const askLeituras = ask.perguntas.filter((p) => !p.muda);
  caso("3. ASK: NENHUMA leitura perguntou", askLeituras.length === 0,
       askLeituras.length === 0 ? `${LEEM} leituras passaram diretas`
                                : `perguntou para ler: ${askLeituras.map((p) => p.rota).join(", ")}`);

  // ── FASE 21 — MODO AGIR SEM PERGUNTAR ────────────────────────────────────
  const auto = await rodar("AUTO", BASE);
  caso("4. AUTO: a jornada inteira completa sozinha",
       auto.erros.length === 0 && auto.fim === "EXPORTADO", `fim=${auto.fim} erros=[${auto.erros.join("; ")}]`);

  caso("5. AUTO: nenhuma pergunta na jornada que o dono já autorizou",
       auto.perguntas.length === 0,
       auto.perguntas.length === 0 ? `0 perguntas em ${MUDAM + LEEM} passos`
                                   : `perguntou: ${auto.perguntas.map((p) => p.rota).join(", ")}`);

  // O ponto que separa "modo" de "produto diferente".
  caso("6. o RESULTADO é idêntico nos dois modos",
       ask.fim === auto.fim && ask.fim === "EXPORTADO", `ASK=${ask.fim} AUTO=${auto.fim}`);

  // ── o gate crítico, DENTRO da jornada ────────────────────────────────────
  //
  // Mesma sessão, mesmo modo AUTO, logo depois de oito passos sem uma pergunta:
  // a ação protegida CONTINUA perguntando. Se este caso falhar, AUTO virou
  // BYPASS e todo o resto perde o sentido.
  const anexo = "/tmp/la-modos-anexo.txt";
  fs.writeFileSync(anexo, "anexo de teste\n", "utf8");
  const protegida = await executar(auto.sid,
    { rota: "browser.upload", corpo: { target: { selector: "#usuario" }, files: [anexo] }, muda: true }, false);
  caso("7. AUTO != BYPASS: a ação protegida perguntou mesmo em AUTO",
       protegida.perguntou !== null,
       protegida.perguntou === null ? "PASSOU DIRETO — o modo automático removeu uma aprovação obrigatória"
                                    : `perguntou · nível ${protegida.perguntou.nivel} · "${protegida.perguntou.motivo}"`);
  caso("8. e negada, ela é recusada",
       protegida.resposta.corpo?.error?.code === "APPROVAL_DENIED",
       `http=${protegida.resposta.status} code=${protegida.resposta.corpo?.error?.code}`);

  // ── contadores da missão ─────────────────────────────────────────────────
  const inesperadasAuto = auto.perguntas.length;
  const inesperadasAsk = askLeituras.length;
  const inesperadas = inesperadasAuto + inesperadasAsk;

  console.log("");
  console.log(`PASSOS_DA_JORNADA=${MUDAM + LEEM} (mudam=${MUDAM} leem=${LEEM})`);
  console.log(`ASK_PROMPTS=${ask.perguntas.length}`);
  console.log(`AUTO_PROMPTS=${auto.perguntas.length}`);
  console.log(`UNEXPECTED_APPROVAL_PROMPTS=${inesperadas}`);
  console.log(`RESULTADO_IDENTICO=${ask.fim === auto.fim ? "SIM" : "NAO"}`);
  console.log(`AUTO_NAO_E_BYPASS=${protegida.perguntou !== null ? "SIM" : "NAO"}`);
  console.log(`ASK_MODE_E2E=${ask.erros.length === 0 && askMudam === MUDAM && inesperadasAsk === 0 ? "PASS" : "FALHA"}`);
  console.log(`AUTO_MODE_E2E=${auto.erros.length === 0 && inesperadasAuto === 0 && protegida.perguntou !== null ? "PASS" : "FALHA"}`);
  console.log(`FALHAS=${falhas}`);
}

main().then(async () => { await limpar(); process.exit(falhas === 0 ? 0 : 1); })
      .catch(async (e) => { console.error("ERRO DO INSTRUMENTO:", e); await limpar(); process.exit(2); });
