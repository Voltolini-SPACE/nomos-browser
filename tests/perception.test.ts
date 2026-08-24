/**
 * FASE 12 — testes do PerceptionEngine contra Chromium REAL.
 *
 * Nada aqui é mock. Sobe um servidor local, abre o Chromium do Playwright e
 * confere cada afirmação contra uma medida independente feita dentro da página
 * (`getBoundingClientRect`, `querySelectorAll("*").length`) ou contra os bytes
 * do PNG capturado.
 *
 * Os dois testes de segredo têm CONTROLE NEGATIVO: o servidor registra o que
 * recebeu de fato. Sem isso, "a credencial não vazou para o log" poderia ser
 * verdade só porque a credencial nunca saiu — afirmação vácua.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { PerceptionEngine, REDACTED, PerceptionError, walkAxTree, redactUrl } from "../packages/core/src/perception.ts";
import { decodePng, pixelAt, colorDistance } from "../packages/observability/src/png.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };
const BLOCK_COLOR = { r: 200, g: 30, b: 90, a: 255 };
const COLOR_TOLERANCE = 12;

/** Credenciais falsas. O teste prova que saíram na rede e NÃO entraram no log. */
const FAKE_BEARER = "nomos-fake-bearer-4f9c1a77-DO-NOT-LOG";
const FAKE_QUERY_TOKEN = "nomos-fake-query-token-8b2e-DO-NOT-LOG";
const FAKE_PASSWORD = "nomos-fake-password-c31d-DO-NOT-LOG";

interface Fixture {
  url: string;
  received: { authorization: string | null; url: string | null };
  close: () => Promise<void>;
}

function startFixtureServer(): Promise<Fixture> {
  const html = readFileSync(path.join(HERE, "fixtures", "perception.html"));
  const received: Fixture["received"] = { authorization: null, url: null };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/echo")) {
      // Controle negativo: guarda o que CHEGOU no fio, em claro.
      received.authorization = (req.headers.authorization as string | undefined) ?? null;
      received.url = url;
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `sessao=${FAKE_BEARER}; Path=/`,
        "x-api-key": FAKE_BEARER,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/" || url.startsWith("/#") || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("teste: endereço inválido");
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let fixture: Fixture;
let browser: Browser;
let context: BrowserContext;
const engine = new PerceptionEngine();

before(async () => {
  fixture = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
  // deviceScaleFactor 1 + scale "css" no engine: px do DOM == px do PNG.
  context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
});

after(async () => {
  await context?.close();
  await browser?.close();
  await fixture?.close();
});

async function openFixture(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  return page;
}

function rectOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. observe() encontra o botão com role e text corretos
// ─────────────────────────────────────────────────────────────────────────────
test("observe() encontra o botão conhecido com role e text corretos", async () => {
  const page = await openFixture();
  try {
    const obs = await engine.observe(page);

    assert.equal(obs.url, fixture.url);
    assert.equal(obs.title, "NOMOS · fixture de percepção");
    assert.ok(obs.page_id.length > 0, "page_id vazio");
    assert.match(obs.observed_at, /^\d{4}-\d{2}-\d{2}T/);

    const btn = obs.elements.find((e) => e.attributes.id === "login-btn");
    assert.ok(btn !== undefined, `botão não observado; refs=${obs.elements.map((e) => e.ref).join(",")}`);
    assert.equal(btn.tag, "button");
    assert.equal(btn.role, "button");
    assert.equal(btn.text, "Entrar");
    assert.equal(btn.visible, true);
    assert.equal(btn.enabled, true);
    assert.match(btn.ref, /^e\d+$/);

    // Botão desabilitado tem de aparecer como enabled=false — não some da lista.
    const off = obs.elements.find((e) => e.attributes.id === "btn-bloqueado");
    assert.ok(off !== undefined, "botão desabilitado não observado");
    assert.equal(off.enabled, false);

    // Ref é estável: observar de novo devolve o MESMO ref para o mesmo elemento.
    const obs2 = await engine.observe(page);
    const btn2 = obs2.elements.find((e) => e.attributes.id === "login-btn");
    assert.equal(btn2?.ref, btn.ref);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. box do observe bate com getBoundingClientRect (±1px)
// ─────────────────────────────────────────────────────────────────────────────
test("box do observe bate com getBoundingClientRect (tolerância 1px)", async () => {
  const page = await openFixture();
  try {
    const obs = await engine.observe(page);
    const btn = obs.elements.find((e) => e.attributes.id === "login-btn");
    assert.ok(btn !== undefined);

    const rect = await rectOf(page, "#login-btn");
    assert.ok(rect !== null, "fixture sem #login-btn");

    for (const k of ["x", "y", "width", "height"] as const) {
      const delta = Math.abs(btn.box[k] - rect[k]);
      assert.ok(delta <= 1, `box.${k} divergiu ${delta}px (observe=${btn.box[k]} dom=${rect[k]})`);
    }
    // Controle do instrumento: a caixa não pode ser degenerada.
    assert.ok(btn.box.width > 0 && btn.box.height > 0, "caixa degenerada");
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. limit=3 devolve 3 elementos, total_elements > 3, truncated=true
// ─────────────────────────────────────────────────────────────────────────────
test("limit=3 devolve 3 elementos mas declara total_elements e truncated", async () => {
  const page = await openFixture();
  try {
    const cortado = await engine.observe(page, { limit: 3 });
    assert.equal(cortado.elements.length, 3);
    assert.ok(cortado.total_elements > 3, `total_elements=${cortado.total_elements}`);
    assert.equal(cortado.truncated, true);

    // Medida independente: o total tem de ser o número REAL de elementos do DOM.
    const domTotal = await page.evaluate(() => document.querySelectorAll("*").length);
    assert.equal(cortado.total_elements, domTotal);

    // O elemento invisível e o decorativo não entram na lista, mas estão na conta.
    const cheio = await engine.observe(page, { limit: 1000 });
    assert.equal(cheio.total_elements, domTotal);
    assert.ok(cheio.elements.length < domTotal, "filtro não descartou nada — filtro inerte");
    assert.equal(cheio.truncated, true);
    assert.equal(cheio.elements.some((e) => e.attributes.id === "oculto"), false, "elemento display:none vazou");
    assert.equal(cheio.elements.some((e) => e.attributes.id === "decorativo"), false, "wrapper decorativo vazou");

    // includeHidden traz o invisível de volta, marcado como invisível.
    const comOcultos = await engine.observe(page, { limit: 1000, includeHidden: true });
    const oculto = comOcultos.elements.find((e) => e.attributes.id === "oculto");
    assert.ok(oculto !== undefined, "includeHidden não trouxe o elemento oculto");
    assert.equal(oculto.visible, false);

    // limit inválido falha explicitamente, não silenciosamente.
    await assert.rejects(
      () => engine.observe(page, { limit: 0 }),
      (err: unknown) => err instanceof PerceptionError && err.code === "INVALID_REQUEST",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. accessibilityTree traz o botão com role button
// ─────────────────────────────────────────────────────────────────────────────
test("accessibilityTree() traz o botão com role button", async () => {
  const page = await openFixture();
  try {
    const tree = await engine.accessibilityTree(page);
    assert.ok(tree !== null, "árvore de acessibilidade nula");

    const nodes = [...walkAxTree(tree)];
    assert.ok(nodes.length > 1, `árvore rasa demais: ${nodes.length} nós`);

    const botao = nodes.find((n) => n.role === "button" && n.name === "Entrar");
    assert.ok(botao !== undefined, `botão ausente na árvore. roles=${nodes.map((n) => `${n.role}:${n.name}`).join(" | ")}`);

    // A árvore também tem de conter a mesma observação via observe(accessibility:true).
    const obs = await engine.observe(page, { accessibility: true, limit: 5 });
    assert.ok(obs.accessibility !== null, "observe(accessibility:true) devolveu null");
    assert.ok([...walkAxTree(obs.accessibility)].some((n) => n.role === "button" && n.name === "Entrar"));

    // Sem pedir, não vem — observação não paga custo que ninguém pediu.
    const semAx = await engine.observe(page, { limit: 5 });
    assert.equal(semAx.accessibility, null);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. screenshot scope 'element' devolve PNG com as dimensões do elemento
// ─────────────────────────────────────────────────────────────────────────────
test("screenshot scope=element devolve PNG com as dimensões reais do elemento", async () => {
  const page = await openFixture();
  try {
    const rect = await rectOf(page, "#target-block");
    assert.ok(rect !== null);

    const shot = await engine.capture(page, { scope: "element", target: "#target-block" });
    assert.equal(shot.scope, "element");
    assert.ok(shot.bytes > 100, `PNG minúsculo: ${shot.bytes} bytes`);

    assert.ok(Math.abs(shot.width - rect.width) <= 1, `largura ${shot.width} != ${rect.width}`);
    assert.ok(Math.abs(shot.height - rect.height) <= 1, `altura ${shot.height} != ${rect.height}`);

    // As dimensões vieram do PNG, não do pedido: confere decodificando de novo.
    const png = decodePng(shot.buffer);
    assert.equal(png.width, shot.width);
    assert.equal(png.height, shot.height);

    // Enquadrou o elemento CERTO: o centro tem a cor do bloco.
    const centro = pixelAt(png, png.width / 2, png.height / 2);
    const dist = colorDistance(centro, BLOCK_COLOR);
    assert.ok(dist <= COLOR_TOLERANCE, `cor central ${JSON.stringify(centro)} distante ${dist.toFixed(2)}`);

    // Contraste com o viewport inteiro — prova que 'element' recortou de verdade.
    const viewport = await engine.capture(page, { scope: "viewport" });
    assert.equal(viewport.width, VIEWPORT.width);
    assert.equal(viewport.height, VIEWPORT.height);
    assert.ok(viewport.width > shot.width && viewport.height > shot.height);

    // Ref guardado resolve para a MESMA captura.
    const guardado = engine.getScreenshot(shot.screenshot_ref);
    assert.equal(guardado?.width, shot.width);
    assert.equal(engine.getScreenshot("shot_inexistente"), null);

    // Region também mede o que capturou.
    const regiao = await engine.capture(page, { scope: "region", region: { x: 40, y: 240, width: 100, height: 60 } });
    assert.equal(regiao.width, 100);
    assert.equal(regiao.height, 60);

    // Fail closed: scope=element sem alvo e alvo inexistente são erros tipados.
    await assert.rejects(
      () => engine.capture(page, { scope: "element" }),
      (e: unknown) => e instanceof PerceptionError && e.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => engine.capture(page, { scope: "element", target: "#nao-existe" }),
      (e: unknown) => e instanceof PerceptionError && e.code === "TARGET_NOT_FOUND",
    );
    await assert.rejects(
      () => engine.capture(page, { scope: "element", target: "button" }),
      (e: unknown) => e instanceof PerceptionError && e.code === "TARGET_AMBIGUOUS",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. networkLog capta a requisição e redige a credencial
// ─────────────────────────────────────────────────────────────────────────────
test("networkLog capta a requisição e Authorization aparece como [REDACTED]", async () => {
  // Anexa ANTES de navegar: um log que só escuta depois do goto perderia o
  // documento e mentiria por omissão sobre o que a página pediu.
  const page = await context.newPage();
  try {
    const log = engine.networkLog(page);
    assert.equal(log.attached, true);
    assert.equal(engine.networkLog(page), log, "anexar duas vezes criou dois logs");
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });

    const alvo = `/echo?token=${FAKE_QUERY_TOKEN}&modo=teste`;
    const status = await page.evaluate(
      async (args) => {
        const r = await fetch(args.url, { headers: { Authorization: `Bearer ${args.bearer}` } });
        return r.status;
      },
      { url: alvo, bearer: FAKE_BEARER },
    );
    assert.equal(status, 200);

    // Espera por EVENTO, não por sleep.
    const entry = await log.waitFor((e) => e.phase === "response" && e.url.includes("/echo"), { timeout_ms: 10_000 });

    assert.equal(entry.method, "GET");
    assert.equal(entry.status, 200);
    assert.equal(entry.status_text, "OK");
    assert.ok(entry.duration_ms !== null && entry.duration_ms >= 0, "timing ausente");
    assert.ok(entry.started_at.length > 0 && entry.ended_at !== null);

    // CONTROLE NEGATIVO: o segredo REALMENTE trafegou. Sem isto, "não vazou"
    // poderia ser verdade apenas porque nada foi enviado.
    assert.equal(fixture.received.authorization, `Bearer ${FAKE_BEARER}`, "o servidor não recebeu o bearer — teste vácuo");
    assert.ok(fixture.received.url?.includes(FAKE_QUERY_TOKEN), "o servidor não recebeu o token na query — teste vácuo");

    // E o log NÃO tem o valor.
    assert.equal(entry.request_headers.authorization, REDACTED);
    assert.equal(new URL(entry.url).searchParams.get("token"), REDACTED);
    assert.equal(new URL(entry.url).searchParams.get("modo"), "teste", "param inocente foi redigido à toa");
    assert.ok(entry.response_headers !== null);
    for (const [k, v] of Object.entries(entry.response_headers)) {
      if (/cookie|api-key/i.test(k)) assert.equal(v, REDACTED, `header ${k} não redigido`);
    }

    // Varredura total: o segredo não pode existir em NENHUM lugar do log.
    const dump = JSON.stringify(log.entries());
    assert.equal(dump.includes(FAKE_BEARER), false, "bearer vazou no log de rede");
    assert.equal(dump.includes(FAKE_QUERY_TOKEN), false, "token de query vazou no log de rede");

    // O log também viu o documento HTML da fixture.
    assert.ok(log.entries().some((e) => e.resource_type === "document"), "documento não registrado");
    assert.ok(log.size() >= 2, `log com ${log.size()} entradas`);
    assert.equal(log.dropped(), 0);

    // Falha de rede vira entrada 'failed' — não some.
    await page.evaluate(() => fetch("http://127.0.0.1:9/inalcancavel").catch(() => null));
    const falha = await log.waitFor((e) => e.phase === "failed", { timeout_ms: 10_000 });
    assert.ok(falha.failure !== null && falha.failure.length > 0, "falha sem errorText");

    log.detach();
    assert.equal(log.attached, false);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra: valor de campo sensível não entra na observação
// ─────────────────────────────────────────────────────────────────────────────
test("valor de campo de senha nunca entra na Observation", async () => {
  const page = await openFixture();
  try {
    await page.fill("#pwd", FAKE_PASSWORD);
    // Controle negativo: a senha ESTÁ no DOM.
    assert.equal(await page.inputValue("#pwd"), FAKE_PASSWORD);

    const obs = await engine.observe(page, { limit: 1000, includeHidden: true, includeDecorative: true });
    const campo = obs.elements.find((e) => e.attributes.id === "pwd");
    assert.ok(campo !== undefined, "campo de senha não observado");
    assert.equal(campo.tag, "input");
    assert.equal(campo.text, null, "texto do campo de senha foi capturado");

    assert.equal(JSON.stringify(obs).includes(FAKE_PASSWORD), false, "senha vazou na Observation");
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra: redactUrl é unitário e determinístico
// ─────────────────────────────────────────────────────────────────────────────
test("redactUrl redige credencial em query, fragmento e userinfo", () => {
  const u1 = new URL(redactUrl("https://ex.com/p?access_token=abc&page=2"));
  assert.equal(u1.searchParams.get("access_token"), REDACTED);
  assert.equal(u1.searchParams.get("page"), "2");

  const u2 = redactUrl("https://user:senha123@ex.com/p");
  assert.equal(u2.includes("senha123"), false);

  const u3 = redactUrl("https://ex.com/cb#id_token=xyz&state=1");
  assert.equal(u3.includes("xyz"), false);
  assert.equal(u3.includes("state=1"), true);
});
