/**
 * FASE 1 — SPIKE DE CONTROLE REAL
 *
 * Prova mecanicamente três camadas de controle sobre o Chromium:
 *   A. DOM         — localizar, clicar, preencher, extrair
 *   B. CDP          — Input.dispatchMouseEvent / dispatchKeyEvent crus
 *   C. SCREENSHOT   — captura + validação coordenada<->pixel
 *
 * Critério de honestidade: nenhuma camada pode ser apenas simulada.
 * A fixture registra `isTrusted` em cada evento. Um clique sintetizado por
 * JavaScript chega com isTrusted=false. Só o motor de input do Chromium
 * produz isTrusted=true. Esse é o discriminador que separa controle real de
 * teatro — e é ele que o spike afirma, não a ausência de exceção.
 *
 * Saída: JSON em stdout + evidências em spike/evidence/.
 */
import { chromium, type Browser, type Page, type CDPSession } from "playwright";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodePng, pixelAt, colorDistance, pngDimensions } from "../packages/observability/src/png.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(HERE, "evidence");
const VIEWPORT = { width: 1280, height: 800 };
const TARGET_COLOR = { r: 200, g: 30, b: 90, a: 255 };
/** Tolerância de cor. 12 absorve compressão/perfil de cor sem deixar passar cor errada. */
const COLOR_TOLERANCE = 12;

interface Check {
  id: string;
  camada: "DOM" | "CDP" | "SCREENSHOT";
  descricao: string;
  esperado: unknown;
  observado: unknown;
  pass: boolean;
}

const checks: Check[] = [];
function check(
  id: string,
  camada: Check["camada"],
  descricao: string,
  esperado: unknown,
  observado: unknown,
  pass: boolean,
): void {
  checks.push({ id, camada, descricao, esperado, observado, pass });
  const tag = pass ? "PASS" : "FAIL";
  console.error(`  [${tag}] ${id} — ${descricao} | esperado=${JSON.stringify(esperado)} observado=${JSON.stringify(observado)}`);
}

/** Servidor local. Sem rede externa: o spike tem de rodar em clean-room offline. */
function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = readFileSync(path.join(HERE, "fixture", "index.html"));
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/#") || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("spike: endereço do servidor inválido");
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

interface RecordedEvent {
  type: string;
  isTrusted: boolean;
  target: string | null;
  x: number | null;
  y: number | null;
  key: string | null;
  value?: string;
  scrollTop?: number;
}

async function events(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(() => (window as unknown as { __nomosEvents: RecordedEvent[] }).__nomosEvents);
}

async function rectOf(page: Page, selector: string) {
  return page.evaluate(
    (sel) => (window as unknown as { __nomosRect: (s: string) => { x: number; y: number; width: number; height: number; cx: number; cy: number } | null }).__nomosRect(sel),
    selector,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. DOM
// ─────────────────────────────────────────────────────────────────────────────
async function camadaDOM(page: Page, url: string): Promise<void> {
  console.error("\n── A. DOM ──");
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const btn = page.locator("#login-btn");
  const encontrado = await btn.count();
  check("DOM-01", "DOM", "localizar elemento por seletor", 1, encontrado, encontrado === 1);

  const textoAntes = (await btn.textContent())?.trim();
  check("DOM-02", "DOM", "extrair conteúdo textual", "Entrar", textoAntes, textoAntes === "Entrar");

  const porTexto = await page.getByRole("button", { name: "Entrar" }).count();
  check("DOM-03", "DOM", "localizar por role+nome acessível", 1, porTexto, porTexto === 1);

  await btn.click();
  const textoDepois = (await btn.textContent())?.trim();
  check("DOM-04", "DOM", "clique altera o DOM", "Autenticado", textoDepois, textoDepois === "Autenticado");

  const estado = await page.locator("#result").getAttribute("data-state");
  check("DOM-05", "DOM", "efeito colateral observável (data-state)", "autenticado", estado, estado === "autenticado");

  const hash = new URL(page.url()).hash;
  check("DOM-06", "DOM", "navegação alterou a URL", "#logado", hash, hash === "#logado");

  const painelVisivel = await page.locator("#painel-secreto").isVisible();
  check("DOM-07", "DOM", "elemento apareceu após ação", true, painelVisivel, painelVisivel === true);

  await page.locator("#user").fill("nomos-operador");
  const valor = await page.locator("#user").inputValue();
  check("DOM-08", "DOM", "preencher input e ler de volta", "nomos-operador", valor, valor === "nomos-operador");

  const evs = await events(page);
  const clique = evs.find((e) => e.type === "click" && e.target === "login-btn");
  check(
    "DOM-09",
    "DOM",
    "clique do Playwright chega como evento REAL (isTrusted)",
    { isTrusted: true },
    { isTrusted: clique?.isTrusted ?? null },
    clique?.isTrusted === true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. CDP — protocolo cru, sem passar pela API de alto nível do Playwright
// ─────────────────────────────────────────────────────────────────────────────
async function camadaCDP(page: Page, cdp: CDPSession, url: string): Promise<void> {
  console.error("\n── B. CDP (Input domain cru) ──");
  await page.goto(url, { waitUntil: "domcontentloaded" }); // reset de estado

  const r = await rectOf(page, "#login-btn");
  if (r === null) throw new Error("spike: #login-btn sem retângulo");

  // mouse.move
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx, y: r.cy, button: "none", buttons: 0 });
  // mouse.down
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.cx, y: r.cy, button: "left", buttons: 1, clickCount: 1 });
  // mouse.up  → o par down+up é o que o Chromium promove a `click`
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.cx, y: r.cy, button: "left", buttons: 0, clickCount: 1 });

  await page.waitForFunction(() => document.getElementById("login-btn")?.textContent === "Autenticado", null, { timeout: 5000 });

  const evs = await events(page);
  const down = evs.find((e) => e.type === "mousedown");
  const up = evs.find((e) => e.type === "mouseup");
  const click = evs.find((e) => e.type === "click");

  check("CDP-01", "CDP", "Input.dispatchMouseEvent mousePressed gerou mousedown", true, down !== undefined, down !== undefined);
  check("CDP-02", "CDP", "Input.dispatchMouseEvent mouseReleased gerou mouseup", true, up !== undefined, up !== undefined);
  check("CDP-03", "CDP", "down+up promovidos a click pelo motor", true, click !== undefined, click !== undefined);
  check(
    "CDP-04",
    "CDP",
    "eventos CDP são isTrusted=true (input real, não sintetizado)",
    { down: true, up: true, click: true },
    { down: down?.isTrusted, up: up?.isTrusted, click: click?.isTrusted },
    down?.isTrusted === true && up?.isTrusted === true && click?.isTrusted === true,
  );

  const dx = Math.abs((click?.x ?? -999) - r.cx);
  const dy = Math.abs((click?.y ?? -999) - r.cy);
  check(
    "CDP-05",
    "CDP",
    "coordenada entregue ao CDP == coordenada recebida pela página (±1px)",
    { dx: "<=1", dy: "<=1" },
    { dx: Number(dx.toFixed(2)), dy: Number(dy.toFixed(2)) },
    dx <= 1 && dy <= 1,
  );

  // teclado cru — keyDown + char + keyUp por caractere
  await page.locator("#user").focus();
  for (const ch of "NB7") {
    const code = ch >= "0" && ch <= "9" ? `Digit${ch}` : `Key${ch.toUpperCase()}`;
    const vk = ch.toUpperCase().charCodeAt(0);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: vk });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk });
  }
  const digitado = await page.locator("#user").inputValue();
  check("CDP-06", "CDP", "Input.dispatchKeyEvent digitou texto", "NB7", digitado, digitado === "NB7");

  const evs2 = await events(page);
  const keydown = evs2.find((e) => e.type === "keydown" && e.target === "user");
  check(
    "CDP-07",
    "CDP",
    "teclado CDP é isTrusted=true",
    { isTrusted: true },
    { isTrusted: keydown?.isTrusted ?? null },
    keydown?.isTrusted === true,
  );

  // Tecla nomeada (não-caractere)
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  const aposBackspace = await page.locator("#user").inputValue();
  check("CDP-08", "CDP", "tecla nomeada (Backspace) aplicada", "NB", aposBackspace, aposBackspace === "NB");

  // CONTROLE NEGATIVO DO INSTRUMENTO.
  // CDP-04 só significa alguma coisa se isTrusted for capaz de valer false.
  // Um clique sintetizado por JS tem de chegar com isTrusted=false — caso
  // contrário o discriminador é vácuo e todos os PASS acima seriam decorativos.
  await page.evaluate(() => document.getElementById("login-btn")!.click());
  const evsSint = await events(page);
  const sintetico = evsSint.filter((e) => e.type === "click" && e.target === "login-btn").at(-1);
  check(
    "CDP-10",
    "CDP",
    "controle do instrumento: clique sintetizado por JS chega isTrusted=false",
    { isTrusted: false },
    { isTrusted: sintetico?.isTrusted ?? null },
    sintetico?.isTrusted === false,
  );

  // scroll via mouseWheel
  const sr = await rectOf(page, "#scroller");
  if (sr === null) throw new Error("spike: #scroller sem retângulo");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sr.cx, y: sr.cy, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: sr.cx, y: sr.cy, button: "none", buttons: 0, deltaX: 0, deltaY: 240 });
  await page.waitForFunction(() => (document.getElementById("scroller")?.scrollTop ?? 0) > 0, null, { timeout: 5000 });
  const scrollTop = await page.evaluate(() => document.getElementById("scroller")!.scrollTop);
  check("CDP-09", "CDP", "mouseWheel rolou o contêiner", "> 0", scrollTop, scrollTop > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. SCREENSHOT — captura + validação coordenada<->pixel
// ─────────────────────────────────────────────────────────────────────────────
async function camadaScreenshot(page: Page, cdp: CDPSession, url: string): Promise<void> {
  console.error("\n── C. SCREENSHOT ──");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.fonts.status === "loaded" || document.readyState === "complete", null, { timeout: 5000 });

  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, "base64");
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, "viewport.png"), buf);

  const dims = pngDimensions(buf);
  check("SHOT-01", "SCREENSHOT", "PNG decodificável e não vazio", "> 1000 bytes", buf.length, buf.length > 1000);

  // O screenshot pode vir em pixels de dispositivo. A escala é derivada, não assumida.
  const scale = dims.width / VIEWPORT.width;
  check(
    "SHOT-02",
    "SCREENSHOT",
    "dimensões coerentes com o viewport (escala uniforme)",
    { width: VIEWPORT.width * scale, height: VIEWPORT.height * scale },
    dims,
    Math.abs(dims.height - VIEWPORT.height * scale) <= 1,
  );

  const png = decodePng(buf);
  const rect = await rectOf(page, "#target-block");
  if (rect === null) throw new Error("spike: #target-block sem retângulo");

  // ESTE é o teste que importa: a coordenada CSS do DOM tem de apontar para o
  // pixel correto dentro da imagem capturada. Se falhar, toda a camada de visão
  // e o Pointer Engine estariam operando sobre um mapa mentiroso.
  const centro = pixelAt(png, rect.cx * scale, rect.cy * scale);
  const dist = colorDistance(centro, TARGET_COLOR);
  check(
    "SHOT-03",
    "SCREENSHOT",
    "pixel no centro do retângulo DOM == cor do elemento (mapeamento coordenada<->pixel)",
    { cor: TARGET_COLOR, tolerancia: COLOR_TOLERANCE },
    { cor: centro, distancia: Number(dist.toFixed(2)), coord: { x: Math.round(rect.cx * scale), y: Math.round(rect.cy * scale) } },
    dist <= COLOR_TOLERANCE,
  );

  // Controle negativo: fora do bloco a cor tem de ser DIFERENTE. Sem isto, um
  // decodificador quebrado que devolvesse sempre a mesma cor passaria em SHOT-03.
  const fora = pixelAt(png, (rect.x - 20) * scale, rect.cy * scale);
  const distFora = colorDistance(fora, TARGET_COLOR);
  check(
    "SHOT-04",
    "SCREENSHOT",
    "controle negativo: pixel fora do bloco NÃO é a cor do bloco",
    { distancia: `> ${COLOR_TOLERANCE}` },
    { cor: fora, distancia: Number(distFora.toFixed(2)) },
    distFora > COLOR_TOLERANCE,
  );

  // Screenshot de elemento (clip) — usado pelo Perception Engine
  const clip = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const clipBuf = Buffer.from(clip.data, "base64");
  writeFileSync(path.join(EVIDENCE, "element.png"), clipBuf);
  const clipPng = decodePng(clipBuf);
  const clipCentro = pixelAt(clipPng, clipPng.width / 2, clipPng.height / 2);
  const clipDist = colorDistance(clipCentro, TARGET_COLOR);
  check(
    "SHOT-05",
    "SCREENSHOT",
    "captura por região (clip) enquadra o elemento certo",
    { cor: TARGET_COLOR, dims: { width: rect.width, height: rect.height } },
    { cor: clipCentro, dims: { width: clipPng.width, height: clipPng.height }, distancia: Number(clipDist.toFixed(2)) },
    clipDist <= COLOR_TOLERANCE && Math.abs(clipPng.width - rect.width) <= 1,
  );

  // Full page — altura tem de exceder o viewport
  const full = await page.screenshot({ fullPage: true });
  writeFileSync(path.join(EVIDENCE, "fullpage.png"), full);
  const fullDims = pngDimensions(full);
  check("SHOT-06", "SCREENSHOT", "captura de página inteira produz PNG válido", "> 0", fullDims.height, fullDims.height > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  const fixture = await startFixtureServer();
  console.error(`fixture em ${fixture.url}`);

  let browser: Browser | null = null;
  const t0 = Date.now();
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");

    await camadaDOM(page, fixture.url);
    await camadaCDP(page, cdp, fixture.url);
    await camadaScreenshot(page, cdp, fixture.url);

    const porCamada = (c: Check["camada"]): boolean => checks.filter((k) => k.camada === c).every((k) => k.pass);
    const resultado = {
      spike: "FASE_1_CONTROLE_REAL",
      chromium: browser.version(),
      executavel: chromium.executablePath(),
      playwright: "1.62.1",
      duracao_ms: Date.now() - t0,
      DOM_CONTROL_PASS: porCamada("DOM") ? "YES" : "NO",
      CDP_MOUSE_PASS: porCamada("CDP") ? "YES" : "NO",
      SCREENSHOT_PASS: porCamada("SCREENSHOT") ? "YES" : "NO",
      total: checks.length,
      falhas: checks.filter((c) => !c.pass).length,
      checks,
    };
    writeFileSync(path.join(EVIDENCE, "fase1_result.json"), JSON.stringify(resultado, null, 2));
    console.log(JSON.stringify(resultado, null, 2));
    process.exitCode = resultado.falhas === 0 ? 0 : 1;
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

await main();
