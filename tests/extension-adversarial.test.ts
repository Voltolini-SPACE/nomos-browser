/**
 * MISSÃO EMBEDDED_AGENT_UX — FASE 27, testes adversariais do painel.
 *
 * O painel sob condições hostis: recarga da página, aprovação que ficou velha,
 * segunda sessão, sessão que morre, runtime que morre. Em TODOS os casos a
 * regra é a mesma: a tela diz a verdade que conseguir comprovar, e nunca
 * inventa um estado melhor do que o que tem.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startDaemon } from "../packages/api/src/daemon.ts";
import { buildExtension } from "../packages/extension/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(path.join(RAIZ, "spike/fixture/index.html"));

// Mesmo padrão do ui-build: sem o cofre de marca (runner limpo), pula com o
// motivo dito — nunca falha fingindo outra causa.
const COFRE_MARCA = path.join(process.env["HOME"] ?? "", ".brand-governance/bin/brand-resolve.sh");
const SEM_COFRE: string | false = existsSync(COFRE_MARCA)
  ? false
  : `cofre de marca ausente em ${COFRE_MARCA} — o adversarial da extensão só roda na máquina com a governança`;

let daemon: { port: number; close: () => Promise<void> } | null = null;
let fixtureServer: http.Server;
let BASE = "";
let TOKEN: string | null = null;
let FIXTURE_URL = "";
let sessionId = "";
let panelCtx: BrowserContext;
let panelUserData = "";
let painel: Page;

const GATE: Record<string, string> = {
  ADV_RELOAD_RECONECTA: "NO",
  ADV_APPROVAL_STALE: "NO",
  ADV_DUAS_SESSOES: "NO",
  ADV_SESSAO_MORTA: "NO",
  ADV_RUNTIME_MORTO: "NO",
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
  const extDir = buildExtension().dist;
  fixtureServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const addr = fixtureServer.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  FIXTURE_URL = `http://127.0.0.1:${addr.port}/`;

  daemon = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
  } as never);
  BASE = `http://127.0.0.1:${daemon.port}`;
  TOKEN = (daemon as unknown as { token: string | null }).token;

  const s = await gestao("/api/v1/sessions", "POST", { owner: "NOMOS", profile: "sandbox" });
  sessionId = s.body.session_id;
  await acao("browser.goto", { url: FIXTURE_URL });

  panelUserData = mkdtempSync(path.join(os.tmpdir(), "nomos-ext-adv-"));
  panelCtx = await chromium.launchPersistentContext(panelUserData, {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = panelCtx.serviceWorkers()[0];
  if (sw === undefined) sw = await panelCtx.waitForEvent("serviceworker", { timeout: 20000 });
  painel = await panelCtx.newPage();
  await painel.goto(`chrome-extension://${sw.url().split("/")[2]}/sidepanel.html`);
  await painel.waitForSelector("#conexao:not([hidden])", { timeout: 10000 });
  await painel.fill("#cUrl", BASE);
  await painel.fill("#cToken", TOKEN ?? "");
  await painel.click("#cConectar");
  await painel.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
});

after(async () => {
  if (SEM_COFRE !== false) return; // nada foi montado
  await panelCtx?.close();
  if (daemon !== null) await daemon.close().catch(() => undefined);
  await new Promise<void>((r) => fixtureServer?.close(() => r()));
  if (panelUserData !== "") rmSync(panelUserData, { recursive: true, force: true });
  process.stderr.write("\n── GATES ADVERSARIAIS (FASE 27) ──\n");
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
});

test("recarregar o painel reconecta sozinho (estado em storage.session, verdade no runtime)", { skip: SEM_COFRE }, async () => {
  await painel.reload();
  await painel.waitForSelector("#chat:not([hidden])", { timeout: 15000 });
  await painel.waitForFunction(
    () => document.getElementById("hSessao")!.textContent!.includes("sessão"),
    undefined,
    { timeout: 15000 },
  );
  GATE.ADV_RELOAD_RECONECTA = "YES";
});

test("aprovação decidida por fora some do painel — e não vira decisão dupla", { skip: SEM_COFRE }, async () => {
  await gestao(`/api/v1/sessions/${sessionId}/autonomy`, "POST", { mode: "ASK", by: "adversarial" });
  const pendente = acao("browser.goto", { url: FIXTURE_URL + "?stale=1" });
  await painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 20000 });

  // Outro cliente (CLI, console) decide ANTES do painel.
  const live = await gestao(`/api/v1/sessions/${sessionId}/live`);
  const apr = live.body.approvals_pending[0];
  assert.ok(apr, "aprovação pendente sumiu antes da hora");
  const dec = await gestao(`/api/v1/approvals/${apr.approval_id}/approve`, "POST", { by: "cli" });
  assert.equal(dec.status, 200);

  const env = await pendente;
  assert.equal(env.success, true);
  // O card tem de FECHAR sozinho: aprovação velha exposta é convite a decidir
  // sobre o que já foi decidido.
  await painel.waitForSelector("#aprovacao[hidden]", { state: "attached", timeout: 15000 });
  GATE.ADV_APPROVAL_STALE = "YES";
});

test("segunda sessão não sequestra o painel", { skip: SEM_COFRE }, async () => {
  const s2 = await gestao("/api/v1/sessions", "POST", { owner: "outro-agente", profile: "sandbox2" });
  assert.ok(s2.body.session_id);
  await new Promise((r) => setTimeout(r, 4500)); // um ciclo do poll de sessões
  const txt = await painel.textContent("#hSessao");
  assert.ok(txt!.includes(sessionId.slice(-6)), `painel trocou de sessão sozinho: "${txt}"`);
  await gestao(`/api/v1/sessions/${s2.body.session_id}`, "DELETE");
  GATE.ADV_DUAS_SESSOES = "YES";
});

test("sessão encerrada: o painel diz, e não finge operar", { skip: SEM_COFRE }, async () => {
  await gestao(`/api/v1/sessions/${sessionId}`, "DELETE");
  await painel.waitForFunction(
    () => document.getElementById("hSessao")!.textContent!.includes("sem sessão"),
    undefined,
    { timeout: 20000 },
  );
  GATE.ADV_SESSAO_MORTA = "YES";
});

test("runtime morto: o indicador cai e o painel declara o inalcançável", { skip: SEM_COFRE }, async () => {
  await daemon!.close();
  daemon = null;
  await painel.waitForFunction(
    () => document.getElementById("vivo")!.dataset.live === "0",
    undefined,
    { timeout: 20000 },
  );
  const txt = await painel.textContent("#hSessao");
  assert.ok(txt!.includes("inalcançável"), `sem declaração de inalcançável: "${txt}"`);
  GATE.ADV_RUNTIME_MORTO = "YES";
});
