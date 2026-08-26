/**
 * FASE 32 — screenshots REAIS do painel funcionando. Nada de mock: daemon
 * real, sessão real, extensão construída do cofre, Chromium real. Cada imagem
 * é a tela que o teste E2E também vê.
 *
 *   node evidence/embedded-agent-ux/capturar-screenshots.ts
 */
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDaemon } from "../../packages/api/src/daemon.ts";
import { buildExtension } from "../../packages/extension/build.ts";
import { spotlight } from "../../packages/core/src/spotlight.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../..");
const OUT = path.join(AQUI, "screenshots");
mkdirSync(OUT, { recursive: true });

const FIXTURE = readFileSync(path.join(RAIZ, "spike/fixture/index.html"));
const ext = buildExtension();

const fixtureServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
const addr = fixtureServer.address();
if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
const FIXTURE_URL = `http://127.0.0.1:${addr.port}/`;

const daemon = await startDaemon({
  port: 0,
  headless: true,
  allow_internal_urls: true,
  sessions_root: path.join(RAIZ, "sessions"),
  extension_dir: ext.dist,
  spotlight: true,
  spotlight_color: ext.corMarca,
} as never);
const BASE = `http://127.0.0.1:${daemon.port}`;
const TOKEN = (daemon as unknown as { token: string | null }).token;
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };

const s = await (await fetch(`${BASE}/api/v1/sessions`, {
  method: "POST", headers: H, body: JSON.stringify({ owner: "NOMOS", profile: "sandbox" }),
})).json();
const sid = s.session_id;
const acao = (tool: string, corpo: Record<string, unknown>) =>
  fetch(`${BASE}/api/v1/${tool}`, {
    method: "POST", headers: H, body: JSON.stringify({ session_id: sid, ...corpo }),
  }).then((r) => r.json());
await acao("browser.goto", { url: FIXTURE_URL });

const ud = mkdtempSync(path.join(os.tmpdir(), "nomos-shots-"));
const ctx = await chromium.launchPersistentContext(ud, {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${ext.dist}`, `--load-extension=${ext.dist}`],
  viewport: { width: 400, height: 720 },
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const painel = await ctx.newPage();
await painel.setViewportSize({ width: 400, height: 720 });
await painel.goto(`chrome-extension://${sw.url().split("/")[2]}/sidepanel.html`);

// 1. tela de conexão
await painel.waitForSelector("#conexao:not([hidden])");
await painel.fill("#cUrl", BASE);
await painel.screenshot({ path: path.join(OUT, "01-conexao.png") });

// 2. conectado — chat, AGORA, abas
await painel.fill("#cToken", TOKEN ?? "");
await painel.click("#cConectar");
await painel.waitForSelector("#chat:not([hidden])");
await painel.waitForFunction(() => document.querySelectorAll("#abas .aba").length > 0, undefined, { timeout: 15000 });
await painel.fill("#texto", "Gi, encontre as transações de ontem.");
await painel.screenshot({ path: path.join(OUT, "02-chat.png") });

// 3. AUTO com o aviso "mesmo em automático, ainda pergunto"
await painel.click("#mAuto");
await painel.waitForFunction(() => document.getElementById("mAuto")!.getAttribute("aria-pressed") === "true", undefined, { timeout: 10000 });
await painel.screenshot({ path: path.join(OUT, "03-auto.png") });

// 4. aprovação pendente (ASK + navegação)
await painel.click("#mAsk");
await painel.waitForFunction(() => document.getElementById("mAsk")!.getAttribute("aria-pressed") === "true", undefined, { timeout: 10000 });
const pendente = acao("browser.goto", { url: FIXTURE_URL + "?aprovacao=1" });
await painel.waitForSelector("#aprovacao:not([hidden])", { timeout: 20000 });
await painel.screenshot({ path: path.join(OUT, "04-aprovacao.png") });
await painel.click("#aprPermitir");
await pendente;

// 5. histórico somente leitura
await painel.click("#btAudit");
await painel.waitForFunction(() => document.querySelectorAll("#histLinha .hi").length > 0, undefined, { timeout: 15000 });
await painel.screenshot({ path: path.join(OUT, "05-audit.png") });

// 6. spotlight na página — a MESMA função que o runtime usa, numa página real
const demo = await ctx.newPage();
await demo.setViewportSize({ width: 900, height: 600 });
await demo.goto(FIXTURE_URL);
const alvo = await demo.locator("#login-btn").boundingBox();
if (alvo !== null) {
  await spotlight(demo, alvo, { dwell_ms: 5000, label: "clicar", color: ext.corMarca });
  await demo.screenshot({ path: path.join(OUT, "06-spotlight.png") });
}

await ctx.close();
await daemon.close();
await new Promise<void>((r) => fixtureServer.close(() => r()));
rmSync(ud, { recursive: true, force: true });
console.log(`screenshots reais em ${OUT}`);
