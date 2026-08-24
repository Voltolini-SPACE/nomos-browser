/**
 * FASE 13/14/15 — smoke test de TargetResolver + ActionVerifier
 *
 * Chromium REAL, fixture REAL servida por HTTP local. Nada é mockado: se o
 * resolvedor mentisse sobre a estratégia vencedora, ou o verificador dissesse
 * "verificado" sem sinal, o teste não teria como perceber a partir de um duplo.
 *
 * Rodar: node --test tests/target-verifier.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { TargetDescriptor, VisionProvider } from "../packages/core/src/contract.ts";
import {
  CASCADE,
  TargetResolver,
  TargetResolutionError,
  intentFor,
  isTargetResolutionError,
  normalize,
} from "../packages/core/src/target.ts";
import {
  ActionVerifier,
  MAX_VERIFICATION_ATTEMPTS,
  attachNetworkRecorder,
  capture,
  retryStrategy,
  verify,
} from "../packages/core/src/verifier.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };

let server: http.Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  const html = readFileSync(path.join(HERE, "fixtures", "target-verifier.html"));
  server = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!.split("#")[0]!;
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else if (p === "/api/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("teste: endereço inválido");
  baseUrl = `http://127.0.0.1:${addr.port}/`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page = await context.newPage();
});

after(async () => {
  await context?.close();
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fresh(): Promise<void> {
  // goto na mesma URL não recarrega quando só o hash difere — força o estado limpo.
  await page.goto("about:blank");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
}

async function expectResolutionError(d: TargetDescriptor, code: string): Promise<TargetResolutionError> {
  try {
    await TargetResolver.resolve(page, d);
  } catch (e) {
    assert.ok(isTargetResolutionError(e), `esperado TargetResolutionError, veio ${String(e)}`);
    assert.equal((e as TargetResolutionError).code, code);
    return e as TargetResolutionError;
  }
  throw new Error(`resolveu quando deveria falhar com ${code}`);
}

// ─────────────────────────────────────────────────────────────────────────────

test("cascata é exatamente a normativa da FASE 13", () => {
  assert.deepEqual([...CASCADE], ["selector", "role_text", "accessibility", "semantic", "vision", "coordinates"]);
});

test("1. selector válido resolve com strategy=selector e healed=false", async () => {
  await fresh();
  const r = await TargetResolver.resolve(page, { selector: "#login-btn" });
  assert.equal(r.strategy, "selector");
  assert.equal(r.healed, false);
  assert.deepEqual(r.attempted, ["selector"]);
  assert.ok(r.box.width > 0 && r.box.height > 0, `caixa vazia: ${JSON.stringify(r.box)}`);
  assert.match(r.description, /login-btn/);
});

test("2. selector QUEBRADO + text válido cura para role_text (healed=true, attempted contém selector)", async () => {
  await fresh();
  const { target, trace } = await TargetResolver.resolveDetailed(page, {
    selector: "#login-btn-que-o-front-renomeou",
    text: "Entrar",
  });
  assert.equal(target.strategy, "role_text");
  assert.equal(target.healed, true);
  assert.ok(target.attempted.includes("selector"), `attempted=${JSON.stringify(target.attempted)}`);
  assert.equal(target.attempted[0], "selector");
  assert.equal(target.attempted[1], "role_text");
  assert.equal(trace[0]?.strategy, "selector");
  assert.equal(trace[0]?.outcome, "miss");
  assert.equal(trace.at(-1)?.outcome, "hit");
  // A armadilha #oculto tem o mesmo texto e está escondida: não pode virar ambiguidade.
  assert.match(target.description, /button#login-btn/);
});

test("3. semantic \"login\" acha o botão \"Entrar\"", async () => {
  await fresh();
  const r = await TargetResolver.resolve(page, { semantic: "login" });
  assert.equal(r.strategy, "semantic");
  assert.equal(r.healed, false);
  assert.deepEqual(r.attempted, ["semantic"]);
  assert.match(r.description, /button#login-btn/);
});

test("3b. sinônimos pt+en caem na mesma intenção; desconhecido vira termo literal", () => {
  assert.equal(intentFor("login").key, "login");
  assert.equal(intentFor("Sign In").key, "login");
  assert.equal(intentFor("Acessar").key, "login");
  assert.equal(intentFor("logout").key, "logout");
  assert.equal(intentFor("zzz-inexistente").key, "literal");
  assert.equal(normalize("Não-Aceito"), "nao aceito");
});

test("3c. semantic \"sign in\" e \"acessar\" também acham o botão Entrar", async () => {
  await fresh();
  for (const s of ["sign in", "acessar", "autenticar"]) {
    const r = await TargetResolver.resolve(page, { semantic: s });
    assert.match(r.description, /button#login-btn/, `semantic=${s}`);
  }
});

test("4. dois botões com o mesmo texto e sem nth ⇒ TARGET_AMBIGUOUS", async () => {
  await fresh();
  const err = await expectResolutionError({ text: "Duplicado" }, "TARGET_AMBIGUOUS");
  const detail = err.toActionError().detail as Record<string, unknown>;
  assert.equal((detail.candidates as number) >= 2, true, `candidates=${String(detail.candidates)}`);
  assert.ok(Array.isArray(detail.samples) && (detail.samples as string[]).length >= 2);
  // Ambiguidade encerra a cascata — não pode ter caído para semantic/coordinates.
  assert.deepEqual(err.attempted, ["role_text"]);
});

test("4b. o mesmo alvo com nth resolve sem ambiguidade", async () => {
  await fresh();
  const a = await TargetResolver.resolve(page, { text: "Duplicado", nth: 0 });
  const b = await TargetResolver.resolve(page, { text: "Duplicado", nth: 1 });
  assert.equal(a.strategy, "role_text");
  assert.equal(b.strategy, "role_text");
  assert.notEqual(a.box.x, b.box.x, "nth=0 e nth=1 apontaram para o MESMO elemento");
});

test("4c. nth fora do intervalo não escolhe outro elemento em silêncio", async () => {
  await fresh();
  const err = await expectResolutionError({ text: "Duplicado", nth: 9 }, "TARGET_NOT_FOUND");
  assert.match(JSON.stringify(err.trace), /fora do intervalo/);
});

test("5. accessibility cura quando só há placeholder", async () => {
  await fresh();
  const r = await TargetResolver.resolve(page, { selector: "#nao-existe", placeholder: "sua senha" });
  assert.equal(r.strategy, "accessibility");
  assert.equal(r.healed, true);
  assert.deepEqual(r.attempted, ["selector", "accessibility"]);
  assert.match(r.description, /input#pwd/);
});

test("6. vision é PULADA e registrada quando nenhum VisionProvider é injetado", async () => {
  await fresh();
  const err = await expectResolutionError(
    { selector: "#nao-existe", semantic: "zzz-nao-existe-nesta-pagina" },
    "TARGET_NOT_FOUND",
  );
  assert.deepEqual(err.attempted, ["selector", "semantic", "vision"]);
  const visionTrace = err.trace.find((t) => t.strategy === "vision");
  assert.equal(visionTrace?.outcome, "skipped");
  assert.match(String(visionTrace?.reason), /nenhum VisionProvider injetado/);
});

test("6b. VisionProvider injetado vence quando as demais falham (healed=true)", async () => {
  await fresh();
  let chamadas = 0;
  const provider: VisionProvider = {
    name: "fake-vision",
    async locate(input) {
      chamadas += 1;
      assert.ok(input.screenshot.length > 1000, "screenshot vazio chegou ao provider");
      assert.equal(input.viewport.width, VIEWPORT.width);
      assert.equal(input.goal, "zzz-nao-existe-nesta-pagina");
      return { box: { x: 11, y: 22, width: 33, height: 44 }, confidence: 0.91 };
    },
  };
  const r = await TargetResolver.resolve(
    page,
    { selector: "#nao-existe", semantic: "zzz-nao-existe-nesta-pagina" },
    { vision: provider },
  );
  assert.equal(chamadas, 1);
  assert.equal(r.strategy, "vision");
  assert.equal(r.healed, true);
  assert.deepEqual(r.box, { x: 11, y: 22, width: 33, height: 44 });
});

test("6c. vision abaixo da confiança mínima NÃO resolve", async () => {
  await fresh();
  const provider: VisionProvider = {
    name: "fake-vision-insegura",
    async locate() {
      return { box: { x: 1, y: 1, width: 1, height: 1 }, confidence: 0.2 };
    },
  };
  try {
    await TargetResolver.resolve(page, { selector: "#nao-existe", semantic: "zzz-nao-existe" }, { vision: provider });
    assert.fail("resolveu com confiança 0.2");
  } catch (e) {
    assert.ok(isTargetResolutionError(e));
    assert.match(JSON.stringify((e as TargetResolutionError).trace), /abaixo do mínimo/);
  }
});

test("7. coordenada NUNCA vence quando outra estratégia estava disponível", async () => {
  await fresh();
  const comAlvo = await TargetResolver.resolve(page, { selector: "#login-btn", coordinates: { x: 5, y: 5 } });
  assert.equal(comAlvo.strategy, "selector");

  const soCoord = await TargetResolver.resolve(page, { selector: "#nao-existe", coordinates: { x: 5, y: 5 } });
  assert.equal(soCoord.strategy, "coordinates");
  assert.equal(soCoord.healed, true);
  assert.deepEqual(soCoord.attempted, ["selector", "coordinates"]);
  assert.match(soCoord.description, /último recurso/);
});

test("8. descriptor vazio é INVALID_REQUEST, não um chute", async () => {
  await fresh();
  await expectResolutionError({}, "INVALID_REQUEST");
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 14 — ActionVerifier
// ─────────────────────────────────────────────────────────────────────────────

test("9. URL_CHANGED verifica true após clique que muda o hash", async () => {
  await fresh();
  const spec = { kind: "URL_CHANGED" as const, expect: "#logado", timeout_ms: 3000 };
  const before = await capture(page, spec);
  await page.locator("#login-btn").click();
  const r = await verify(page, spec, before);
  assert.equal(r.executed, true);
  assert.equal(r.verified, true);
  assert.equal(r.confidence, 1);
  assert.equal(r.kind, "URL_CHANGED");
  assert.match(String(r.observed), /#logado/);
});

test("10. URL_CHANGED verifica false quando nada muda (controle negativo)", async () => {
  await fresh();
  const spec = { kind: "URL_CHANGED" as const, timeout_ms: 400 };
  const before = await capture(page, spec);
  await page.locator("#quieto").click();
  const r = await verify(page, spec, before);
  assert.equal(r.executed, true);
  assert.equal(r.verified, false);
  assert.equal(r.confidence, 0);
  assert.equal(r.waited_out, true);
});

test("11. confidence de uma verificação NONE não é 1.0", async () => {
  await fresh();
  const spec = { kind: "NONE" as const };
  const before = await capture(page, spec);
  const r = await verify(page, spec, before);
  assert.notEqual(r.confidence, 1);
  assert.equal(r.confidence, 0.5);
  assert.equal(r.verified, false);
  assert.equal(r.executed, false);
  assert.equal(r.signals.length, 0);
});

test("12. ELEMENT_APPEARED exige a TRANSIÇÃO (ausente antes, visível depois)", async () => {
  await fresh();
  const spec = { kind: "ELEMENT_APPEARED" as const, expect: "#painel", timeout_ms: 3000 };
  const before = await capture(page, spec);
  assert.equal(before.element_visible, false);
  await page.locator("#login-btn").click();
  const r = await verify(page, spec, before);
  assert.equal(r.verified, true);
  assert.equal(r.confidence, 1);

  // Segundo turno: já estava visível ⇒ não "apareceu" por causa desta ação.
  const before2 = await capture(page, spec);
  assert.equal(before2.element_visible, true);
  const r2 = await verify(page, spec, before2, { timeout_ms: 300 });
  assert.equal(r2.verified, false);
  assert.equal(r2.confidence, 0.5);
});

test("13. ELEMENT_DISAPPEARED confirma remoção real", async () => {
  await fresh();
  const spec = { kind: "ELEMENT_DISAPPEARED" as const, expect: "#efemero", timeout_ms: 3000 };
  const before = await capture(page, spec);
  assert.equal(before.element_visible, true);
  await page.locator("#some").click();
  const r = await verify(page, spec, before);
  assert.equal(r.verified, true);
  assert.equal(r.confidence, 1);
});

test("14. ELEMENT_APPEARED sem `expect` sai não-executado, não sai verificado", async () => {
  await fresh();
  const spec = { kind: "ELEMENT_APPEARED" as const, timeout_ms: 200 };
  const before = await capture(page, spec);
  const r = await verify(page, spec, before);
  assert.equal(r.executed, false);
  assert.equal(r.verified, false);
  assert.equal(r.confidence, 0);
  assert.match(String(r.observed), /exige `expect`/);
});

test("15. TEXT_CHANGED escopado ao alvo, com corroboração", async () => {
  await fresh();
  const spec = { kind: "TEXT_CHANGED" as const, expect: "#status", timeout_ms: 3000 };
  const before = await capture(page, spec);
  assert.equal(before.text, "estado: inicial");
  await page.locator("#login-btn").click();
  const r = await verify(page, spec, before, { expected_text: "autenticado" });
  assert.equal(r.verified, true);
  assert.equal(r.confidence, 1);
  assert.equal(r.signals.length, 2);
});

test("16. DOM_CHANGED usa MutationObserver e deriva confiança dos sinais", async () => {
  await fresh();
  const spec = { kind: "DOM_CHANGED" as const, timeout_ms: 3000 };
  const before = await capture(page, spec);
  await page.locator("#muda-dom").click();
  const r = await verify(page, spec, before);
  assert.equal(r.verified, true);
  assert.equal(r.confidence, 1);

  const spec2 = { kind: "DOM_CHANGED" as const, timeout_ms: 400 };
  const before2 = await capture(page, spec2);
  await page.locator("#quieto").click();
  const r2 = await verify(page, spec2, before2);
  assert.equal(r2.verified, false);
  assert.equal(r2.confidence, 0);
});

test("17. NETWORK_SUCCESS sem gravador acoplado NÃO passa", async () => {
  await fresh();
  const spec = { kind: "NETWORK_SUCCESS" as const, expect: "/api/ok", timeout_ms: 300 };
  const before = await capture(page, spec);
  const r = await verify(page, spec, before);
  assert.equal(r.executed, false);
  assert.equal(r.verified, false);
  assert.equal(r.confidence, 0);
  assert.match(String(r.observed), /NetworkRecorder/);
});

test("18. NETWORK_SUCCESS com gravador confirma resposta 200 e redige a query", async () => {
  await fresh();
  const recorder = attachNetworkRecorder(page);
  try {
    const spec = { kind: "NETWORK_SUCCESS" as const, expect: "/api/ok", timeout_ms: 5000 };
    const before = await capture(page, spec, { recorder });
    await page.evaluate((u: string) => fetch(`${u}api/ok?token=SEGREDO_NAO_PODE_VAZAR`), baseUrl);
    const r = await verify(page, spec, before, { recorder });
    assert.equal(r.verified, true);
    assert.equal(r.confidence, 1);
    assert.doesNotMatch(String(r.observed), /SEGREDO_NAO_PODE_VAZAR/, "segredo vazou em observed");
    assert.match(String(r.observed), /\?…/);
  } finally {
    recorder.detach();
  }
});

test("19. snapshot de kind diferente é recusado (não se verifica com a régua errada)", async () => {
  await fresh();
  const before = await capture(page, { kind: "URL_CHANGED" });
  const r = await verify(page, { kind: "DOM_CHANGED" }, before);
  assert.equal(r.executed, false);
  assert.equal(r.confidence, 0);
});

test("20. retryStrategy tem backoff limitado e proíbe retry infinito", () => {
  const spec = { kind: "URL_CHANGED" as const };
  // MAX_VERIFICATION_ATTEMPTS=3 ⇒ tentativas 0,1,2. Só as duas primeiras pedem repetição.
  const d0 = retryStrategy(spec, 0);
  const d1 = retryStrategy(spec, 1);
  const d2 = retryStrategy(spec, 2);
  assert.equal(d0.retry, true);
  assert.equal(d0.delay_ms, 150);
  assert.equal(d1.retry, true);
  assert.equal(d1.delay_ms, 300, "backoff deveria dobrar");
  assert.equal(d2.retry, false, "deveria parar ao atingir o limite de tentativas");
  assert.match(d2.motivo, /retry infinito é proibido/);

  for (let a = 0; a < 50; a += 1) {
    const d = retryStrategy(spec, a);
    assert.ok(d.delay_ms <= 2000, `delay ${d.delay_ms} acima do teto`);
    if (a + 1 >= MAX_VERIFICATION_ATTEMPTS) assert.equal(d.retry, false, `tentativa ${a} ainda pedia retry`);
  }

  assert.equal(retryStrategy({ kind: "NONE" }, 0).retry, false);
  assert.equal(retryStrategy(spec, -1).retry, false);
  assert.equal(retryStrategy(spec, 1.5).retry, false);
});

test("21. superfície pública dos dois módulos está montada", () => {
  assert.equal(typeof TargetResolver.resolve, "function");
  assert.equal(typeof TargetResolver.resolveDetailed, "function");
  assert.equal(typeof ActionVerifier.capture, "function");
  assert.equal(typeof ActionVerifier.verify, "function");
  assert.equal(typeof ActionVerifier.retryStrategy, "function");
  assert.equal(ActionVerifier.MAX_VERIFICATION_ATTEMPTS, MAX_VERIFICATION_ATTEMPTS);
});
