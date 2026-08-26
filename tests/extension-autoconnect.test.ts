/**
 * MISSÃO GI_SIDEPANEL_REAL — AUTO-CONEXÃO do painel embarcado.
 *
 * O furo que o dono viu: ao abrir o painel, ele caía num formulário "CONECTAR
 * AO RUNTIME / token impresso pelo daemon" — não num chat. A correção: quando o
 * painel roda no Chromium do PRÓPRIO runtime, o daemon injeta um handshake de
 * mesma origem (`local-runtime.json`) dentro do pacote da extensão, e o painel
 * conecta sozinho. `auth.ts` já documentava a intenção ("o daemon injetar na
 * própria UI, mesma origem"); aqui ela é ligada e PROVADA em Chromium real.
 *
 * Três provas, uma delas negativa (FASE 17 — o teste tem de saber falhar):
 *  1. POSITIVA: com o handshake real, o painel mostra o chat SEM ninguém colar
 *     token. É o "clicar → Gi ao lado, já pronta".
 *  2. CONTRA-PROVA: com um handshake de TOKEN FORJADO e storage vazio, o painel
 *     NÃO mostra o chat — volta ao formulário. Se a auto-conexão apenas
 *     "mostrasse o chat" sem validar a credencial, este teste falharia.
 *  3. SEGURANÇA: o handshake NÃO é web_accessible_resource (nenhuma página web
 *     o lê) e nasce 0600 no disco.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startDaemon } from "../packages/api/src/daemon.ts";
import { buildExtension } from "../packages/extension/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(path.join(RAIZ, "spike/fixture/index.html"));

const COFRE_MARCA = path.join(process.env["HOME"] ?? "", ".brand-governance/bin/brand-resolve.sh");
const SEM_COFRE: string | false = existsSync(COFRE_MARCA)
  ? false
  : `cofre de marca ausente em ${COFRE_MARCA} — a auto-conexão da extensão só roda na máquina com a governança`;

let daemon: { port: number; close: () => Promise<void> } | null = null;
let fixtureServer: http.Server;
let BASE = "";
let TOKEN = "";
let extDir = "";
let handshakePath = "";
const contextos: BrowserContext[] = [];
const temporarios: string[] = [];

const GATE: Record<string, string> = {
  AUTOCONNECT_SEM_TOKEN: "NO",
  HANDSHAKE_0600: "NO",
  HANDSHAKE_NAO_WEB_ACCESSIBLE: "NO",
  CONTRAPROVA_TOKEN_FORJADO: "NO",
};

async function abrirPainel(dir: string): Promise<{ ctx: BrowserContext; painel: Page }> {
  const userData = mkdtempSync(path.join(os.tmpdir(), "nomos-ac-"));
  temporarios.push(userData);
  const ctx = await chromium.launchPersistentContext(userData, {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  contextos.push(ctx);
  let sw = ctx.serviceWorkers()[0];
  if (sw === undefined) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2]!;
  const painel = await ctx.newPage();
  await painel.goto(`chrome-extension://${extId}/sidepanel.html`);
  return { ctx, painel };
}

before(async () => {
  if (SEM_COFRE !== false) return;
  extDir = buildExtension().dist;

  fixtureServer = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(FIXTURE);
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const addr = fixtureServer.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  const FIXTURE_URL = `http://127.0.0.1:${addr.port}/`;

  daemon = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
    extension_dir: extDir,
  } as never);
  BASE = `http://127.0.0.1:${daemon.port}`;
  TOKEN = (daemon as unknown as { token: string }).token;
  handshakePath = path.join(extDir, "local-runtime.json");

  const s = await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ owner: "NOMOS", profile: "sandbox" }),
  }).then((r) => r.json());
  const sid = s.session_id ?? s.result?.session_id;
  await fetch(`${BASE}/api/v1/browser.goto`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ session_id: sid, url: FIXTURE_URL }),
  });
});

after(async () => {
  if (SEM_COFRE !== false) return;
  for (const c of contextos) await c.close().catch(() => undefined);
  if (daemon !== null) await daemon.close().catch(() => undefined);
  await new Promise<void>((r) => fixtureServer?.close(() => r()));
  for (const t of temporarios) rmSync(t, { recursive: true, force: true });
  process.stderr.write("\n── GATES AUTO-CONEXÃO ──\n");
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
});

test("o daemon gravou o handshake e ele é 0600 (nunca web_accessible)", { skip: SEM_COFRE }, () => {
  assert.ok(existsSync(handshakePath), "daemon não gravou local-runtime.json");
  const modo = statSync(handshakePath).mode & 0o777;
  assert.equal(modo, 0o600, `handshake em ${modo.toString(8)}, esperado 600`);
  GATE.HANDSHAKE_0600 = "YES";

  const manifest = JSON.parse(readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  // Se um dia alguém expuser o handshake como recurso web-acessível, qualquer
  // página aberta no navegador leria o token. O contrato é: não existe.
  const war = JSON.stringify(manifest.web_accessible_resources ?? []);
  assert.ok(!war.includes("local-runtime"), "handshake exposto como web_accessible_resource");
  assert.equal(manifest.web_accessible_resources, undefined, "extensão não deve declarar web_accessible_resources");
  GATE.HANDSHAKE_NAO_WEB_ACCESSIBLE = "YES";
});

test("POSITIVA — o painel abre JÁ conectado, sem ninguém colar token", { skip: SEM_COFRE }, async () => {
  const { painel } = await abrirPainel(extDir);
  await painel.waitForSelector("#chat:not([hidden])", { timeout: 20000 });
  const conexaoHidden = await painel.$eval("#conexao", (e) => (e as HTMLElement).hidden);
  assert.equal(conexaoHidden, true, "formulário de conexão continuou visível — não auto-conectou");
  const tokenDigitado = await painel.$eval("#cToken", (e) => (e as HTMLInputElement).value);
  assert.equal(tokenDigitado, "", "campo de token foi tocado — não era auto-conexão");
  await painel.waitForFunction(
    () => (document.getElementById("hSessao")?.textContent ?? "").includes("sessão"),
    undefined, { timeout: 15000 },
  );
  GATE.AUTOCONNECT_SEM_TOKEN = "YES";
});

test("CONTRA-PROVA — handshake de token FORJADO NÃO conecta (o teste sabe falhar)", { skip: SEM_COFRE }, async () => {
  // Cópia isolada da extensão, com um handshake apontando o runtime REAL mas
  // com TOKEN inválido. storage vazio (contexto novo). O painel tenta, o
  // /health devolve 401, e ele cai no formulário — não finge conectado.
  const forjadoDir = mkdtempSync(path.join(os.tmpdir(), "nomos-forj-"));
  temporarios.push(forjadoDir);
  cpSync(extDir, forjadoDir, { recursive: true });
  writeFileSync(path.join(forjadoDir, "local-runtime.json"),
    JSON.stringify({ base: BASE, token: "token-forjado-000" }), { mode: 0o600 });

  const { painel } = await abrirPainel(forjadoDir);
  await painel.waitForSelector("#conexao:not([hidden])", { timeout: 20000 });
  const chatHidden = await painel.$eval("#chat", (e) => (e as HTMLElement).hidden);
  assert.equal(chatHidden, true, "chat apareceu com token forjado — auto-conexão não validou a credencial");
  GATE.CONTRAPROVA_TOKEN_FORJADO = "YES";
});
