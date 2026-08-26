/**
 * MISSÃO EMBEDDED_AGENT_UX — E2E da extensão em Chromium REAL.
 *
 * Dois navegadores de verdade, nenhum mock:
 *
 *  - o Chromium DO RUNTIME (daemon real, sessão real, fixture real), lançado
 *    com `extension_dir` — provamos pelos argumentos do processo que a
 *    extensão embarcou;
 *  - um Chromium DO TESTE com a extensão construída do cofre, onde o painel
 *    (sidepanel.html) roda como página e é operado por Playwright como um
 *    humano operaria: conectar com token, conversar, alternar ASK/AUTO,
 *    aprovar, negar, pausar, assumir, parar, auditar.
 *
 * O painel fala com o daemon EXCLUSIVAMENTE por HTTP/WS com token — o mesmo
 * caminho de qualquer cliente da API v1. Se algo aqui passar sem o daemon,
 * é defeito do teste, não feature.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startDaemon } from "../packages/api/src/daemon.ts";
import { buildExtension } from "../packages/extension/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(path.join(RAIZ, "spike/fixture/index.html"));

// Mesmo padrão do ui-build: o cofre de marca é da máquina do dono, não do
// runner. Sem ele a extensão não constrói — os testes PULAM com o motivo dito,
// nunca falham fingindo outra causa.
const COFRE_MARCA = path.join(process.env["HOME"] ?? "", ".brand-governance/bin/brand-resolve.sh");
const SEM_COFRE: string | false = existsSync(COFRE_MARCA)
  ? false
  : `cofre de marca ausente em ${COFRE_MARCA} — o E2E da extensão só roda na máquina com a governança`;

let daemon: { port: number; close: () => Promise<void> };
let fixtureServer: http.Server;
let BASE = "";
let TOKEN: string | null = null;
let FIXTURE_URL = "";
let sessionId = "";
let extDir = "";
let panelCtx: BrowserContext;
let panelUserData = "";
let painel: Page;

const GATE: Record<string, string> = {
  SIDE_PANEL: "NO",
  EMBEDDED_CHAT: "NO",
  LIVE_ACTIVITY: "NO",
  ASK_MODE: "NO",
  AUTO_MODE: "NO",
  APPROVAL_UI: "NO",
  ACTION_HIGHLIGHT: "NO",
  STOP: "NO",
  PAUSE: "NO",
  TAKEOVER: "NO",
  AUDIT_UI: "NO",
  REPLAY_UI: "NO",
  TAB_CONTROL: "NO",
  OWNERSHIP: "NO",
  SECURE_BRIDGE: "NO",
  EXTENSION_AUTH: "NO",
  RUNTIME_CHROMIUM_CARREGA_EXTENSAO: "NO",
};

async function gestao(rota: string, metodo = "GET", corpo?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: {
      ...(corpo === undefined ? {} : { "content-type": "application/json" }),
      ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function acao(tool: string, corpo: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${BASE}/api/v1/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ session_id: sessionId, ...corpo }),
  });
  return r.json();
}

before(async () => {
  if (SEM_COFRE !== false) return; // testes pulados; nada a montar
  // 1. extensão nasce do cofre — o mesmo build de produção.
  extDir = buildExtension().dist;

  // 2. fixture HTTP real.
  fixtureServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const addr = fixtureServer.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  FIXTURE_URL = `http://127.0.0.1:${addr.port}/`;

  // 3. daemon real com a experiência embutida ligada.
  daemon = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
    extension_dir: extDir,
    spotlight: true,
    spotlight_dwell_ms: 60,
  } as never);
  BASE = `http://127.0.0.1:${daemon.port}`;
  TOKEN = (daemon as unknown as { token: string | null }).token;

  // Este E2E exercita o caminho MANUAL/avançado (runtime informado à mão, token
  // explícito colado no formulário). O daemon embarcado também grava um
  // handshake de auto-conexão em `extDir`; removê-lo aqui força o painel ao
  // formulário. A auto-conexão tem cobertura própria e adversarial em
  // tests/extension-autoconnect.test.ts — os dois caminhos são reais e ambos
  // precisam continuar de pé.
  rmSync(path.join(extDir, "local-runtime.json"), { force: true });

  // 4. sessão real + página real.
  const s = await gestao("/api/v1/sessions", "POST", { owner: "NOMOS", profile: "sandbox" });
  sessionId = s.body.session_id ?? s.body.result?.session_id;
  if (!sessionId) throw new Error(`sessão não criada: ${JSON.stringify(s.body)}`);
  const g = await acao("browser.goto", { url: FIXTURE_URL });
  if (g.success !== true) throw new Error(`goto inicial falhou: ${JSON.stringify(g.error)}`);

  // 5. Chromium do teste com a extensão carregada (canal chromium: o único em
  //    que headless aceita extensão; Chrome/Edge de marca removeram o flag).
  panelUserData = mkdtempSync(path.join(os.tmpdir(), "nomos-ext-e2e-"));
  panelCtx = await chromium.launchPersistentContext(panelUserData, {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = panelCtx.serviceWorkers()[0];
  if (sw === undefined) sw = await panelCtx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2]!;
  painel = await panelCtx.newPage();
  await painel.goto(`chrome-extension://${extId}/sidepanel.html`);
});

after(async () => {
  if (SEM_COFRE !== false) return; // nada foi montado
  await panelCtx?.close();
  await daemon?.close();
  await new Promise<void>((r) => fixtureServer?.close(() => r()));
  if (panelUserData !== "") rmSync(panelUserData, { recursive: true, force: true });
  process.stderr.write("\n── GATES EMBEDDED_AGENT_UX (E2E) ──\n");
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
});

// ─────────────────────────────────────────────────────────────────────────────

test("o Chromium do RUNTIME subiu com a extensão embarcada (prova: argv do processo)", { skip: SEM_COFRE }, () => {
  const ps = execSync("ps ax -o command", { encoding: "utf8" });
  const linhas = ps.split("\n").filter((l) => l.includes(`--load-extension=${extDir}`));
  assert.ok(linhas.length > 0, "nenhum Chromium com --load-extension apontando para a extensão construída");
  GATE.RUNTIME_CHROMIUM_CARREGA_EXTENSAO = "YES";
});

test("credencial errada é recusada — o painel diz, não engole", { skip: SEM_COFRE }, async () => {
  await painel.waitForSelector("#conexao:not([hidden])", { timeout: 10000 });
  await painel.fill("#cUrl", BASE);
  await painel.fill("#cToken", "token-forjado-000");
  await painel.click("#cConectar");
  await painel.waitForFunction(
    () => document.getElementById("cErro")!.textContent!.includes("credencial recusada"),
    undefined,
    { timeout: 10000 },
  );
  GATE.EXTENSION_AUTH = "YES";
});

test("painel conecta com o token real e mostra a sessão viva", { skip: SEM_COFRE }, async () => {
  await painel.fill("#cToken", TOKEN ?? "");
  await painel.click("#cConectar");
  await painel.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
  await painel.waitForFunction(
    () => document.getElementById("hSessao")!.textContent!.includes("sessão"),
    undefined,
    { timeout: 15000 },
  );
  const live = await painel.getAttribute("#vivo", "data-live");
  assert.equal(live, "1", "indicador de runtime vivo não acendeu");
  GATE.SIDE_PANEL = "YES";
  GATE.SECURE_BRIDGE = "YES";
});

test("abas do agente aparecem, com posse declarada", { skip: SEM_COFRE }, async () => {
  await painel.waitForFunction(
    () => document.querySelectorAll("#abas .aba").length > 0,
    undefined,
    { timeout: 15000 },
  );
  const posse = await painel.textContent("#abas .aba .posse");
  assert.equal(posse, "agente");
  GATE.TAB_CONTROL = "YES";
});

test("ASK e AUTO alternam pelo painel e o estado volta do runtime, não da tela", { skip: SEM_COFRE }, async () => {
  await painel.click("#mAsk");
  await painel.waitForFunction(
    () => document.getElementById("mAsk")!.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 10000 },
  );
  GATE.ASK_MODE = "YES";

  await painel.click("#mAuto");
  await painel.waitForFunction(
    () => document.getElementById("mAuto")!.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 10000 },
  );
  GATE.AUTO_MODE = "YES";

  // AUTO != BYPASS: o aviso "mesmo em AUTO, ainda pergunto" tem de citar as
  // rotas de SEMPRE_APROVAR — o runtime as fornece, a tela só repete.
  const aviso = await painel.textContent("#mAviso");
  assert.ok(aviso!.includes("ainda pergunto"), `aviso de SEMPRE_APROVAR ausente: "${aviso}"`);

  await painel.click("#mAsk");
  await painel.waitForFunction(
    () => document.getElementById("mAsk")!.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 10000 },
  );
});

test("em ASK, uma navegação pede aprovação no painel; PERMITIR libera exatamente ela", { skip: SEM_COFRE }, async () => {
  // O teste faz o papel do agente: dispara a ação SEM aguardar.
  const pendente = acao("browser.goto", { url: FIXTURE_URL + "?aprovada=1" });

  await painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 20000 });
  const acaoTxt = await painel.textContent("#aprAcao");
  assert.ok(acaoTxt!.includes("goto"), `card de aprovação sem a rota: "${acaoTxt}"`);
  const nivel = await painel.textContent("#aprNivel");
  assert.ok(nivel !== "—", "card sem nível de risco");

  await painel.click("#aprPermitir");
  const env = await pendente;
  assert.equal(env.success, true, `ação aprovada deveria executar: ${JSON.stringify(env.error)}`);
  GATE.APPROVAL_UI = "YES";
});

test("NEGAR nega — e a aprovação anterior não é reutilizável", { skip: SEM_COFRE }, async () => {
  const pendente = acao("browser.goto", { url: FIXTURE_URL + "?negada=1" });
  await painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 20000 });
  await painel.click("#aprNegar");
  const env = await pendente;
  assert.equal(env.success, false, "ação negada não pode ter executado");
  const abasEnv = await acao("browser.tabs", {});
  assert.equal(abasEnv.success, true);
  const ativa = (abasEnv.result as Array<{ active: boolean; url: string }>).find((t) => t.active);
  assert.ok(
    ativa !== undefined && !ativa.url.includes("negada=1"),
    "a aba navegou mesmo com a negativa",
  );
});

test("clique com spotlight ligado continua entregue e verificado", { skip: SEM_COFRE }, async () => {
  // Em ASK o clique pede aprovação; o teste aprova PELO PAINEL, como o dono.
  const pendente = acao("browser.click", { target: { selector: "#login-btn" } });
  await painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 20000 });
  await painel.click("#aprPermitir");
  const env = await pendente;
  assert.equal(env.success, true, `clique falhou: ${JSON.stringify(env.error)}`);
  assert.equal(env.result?.detail?.delivery_verified, true, "spotlight interferiu na entrega");
  GATE.ACTION_HIGHLIGHT = "YES";
});

test("feed de atividade registra o que o agente fez", { skip: SEM_COFRE }, async () => {
  await painel.waitForFunction(
    () => document.querySelectorAll("#feed .ev").length > 0,
    undefined,
    { timeout: 15000 },
  );
  GATE.LIVE_ACTIVITY = "YES";
});

test("chat embutido envia a intenção ao control plane — e repete a recusa do runtime com honestidade", { skip: SEM_COFRE }, async () => {
  // AUTO para o que é rebaixável: a intenção flui sem aprovação manual aqui.
  // (Se browser.task for SEMPRE_APROVAR, o card aparece e o teste decide.)
  await painel.click("#mAuto");
  await painel.waitForFunction(
    () => document.getElementById("mAuto")!.getAttribute("aria-pressed") === "true",
    undefined,
    { timeout: 10000 },
  );
  await painel.fill("#texto", "Gi, encontre as transações de ontem.");
  await painel.click("#enviar");
  // Se o runtime pedir consentimento mesmo em AUTO, o dono decide no painel.
  painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 5000 })
    .then(() => painel.click("#aprPermitir"))
    .catch(() => { /* sem aprovação pendente — caminho normal */ });
  await painel.waitForFunction(
    () => [...document.querySelectorAll(".msg.user")].some((m) =>
      m.textContent!.includes("transações de ontem")),
    undefined,
    { timeout: 10000 },
  );
  // Este daemon de teste NÃO tem ai_provider — o caminho honesto é a Gi dizer
  // isso, nunca fingir que trabalha. (Com Ollama configurado, o mesmo fluxo
  // vira task real; o que este teste fixa é que a intenção passa pelo runtime.)
  await painel.waitForFunction(
    () => [...document.querySelectorAll(".msg.gi")].some((m) => {
      const t = m.textContent!;
      return t.includes("provedor de IA") || t.includes("recusou") || t.includes("task ");
    }),
    undefined,
    { timeout: 15000 },
  );
  GATE.EMBEDDED_CHAT = "YES";
});

test("PAUSAR congela no runtime; retomar exige e usa o escopo certo", { skip: SEM_COFRE }, async () => {
  await painel.click("#btPausar");
  await painel.waitForFunction(
    () => document.getElementById("aEstado")!.dataset.estado === "PAUSED",
    undefined,
    { timeout: 15000 },
  );
  await painel.click("#btPausar"); // retomar (token raiz tem ADMIN)
  await painel.waitForFunction(
    () => document.getElementById("aEstado")!.dataset.estado !== "PAUSED",
    undefined,
    { timeout: 15000 },
  );
  GATE.PAUSE = "YES";
});

test("ASSUMIR CONTROLE congela o agente até a devolução — inclusive para observar", { skip: SEM_COFRE }, async () => {
  await painel.click("#btControle");
  await painel.waitForFunction(
    () => document.body.dataset.controle === "human",
    undefined,
    { timeout: 15000 },
  );
  const bloqueado = await acao("browser.observe", {});
  assert.equal(bloqueado.success, false, "agente agiu sob controle humano");
  assert.equal(bloqueado.error?.code, "CONTROL_HELD_BY_HUMAN");
  GATE.OWNERSHIP = "YES";

  await painel.click("#btControle"); // devolver
  await painel.waitForFunction(
    () => document.body.dataset.controle === "agent",
    undefined,
    { timeout: 15000 },
  );
  GATE.TAKEOVER = "YES";
});

test("Audit e Replay abrem somente leitura — a alavanca não existe", { skip: SEM_COFRE }, async () => {
  await painel.click("#btAudit");
  await painel.waitForFunction(
    () => document.querySelectorAll("#histLinha .hi").length > 0,
    undefined,
    { timeout: 15000 },
  );
  GATE.AUDIT_UI = "YES";

  await painel.click("#btReplay"); // alterna para a linha do tempo completa
  await painel.waitForFunction(
    () => document.getElementById("historico")!.dataset.filtro === "replay" &&
      document.querySelectorAll("#histLinha .hi").length > 0,
    undefined,
    { timeout: 15000 },
  );
  const alavancas = await painel.evaluate(
    () => document.querySelectorAll("#histLinha button, #histLinha input, #histLinha select, #histLinha textarea, #histLinha a[href]").length,
  );
  assert.equal(alavancas, 0, "o replay do painel contém controle que age");
  GATE.REPLAY_UI = "YES";
});

test("PARAR é parada de emergência no backend", { skip: SEM_COFRE }, async () => {
  await painel.click("#btParar");
  await painel.waitForFunction(
    () => [...document.querySelectorAll("#feed .ev")].some((e) =>
      e.textContent!.includes("PARADA DE EMERGÊNCIA")),
    undefined,
    { timeout: 15000 },
  );
  GATE.STOP = "YES";
});
