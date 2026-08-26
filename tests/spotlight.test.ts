/**
 * FASE 10 (missão EMBEDDED_AGENT_UX) — spotlight.
 *
 * O que este arquivo prova, contra Chromium REAL:
 *  1. O destaque aparece na página (moldura + selo "● NOMOS controlando").
 *  2. Ele NÃO interfere no hit-testing: `elementFromPoint` no centro do alvo
 *     continua devolvendo o alvo — pointer-events:none de verdade, medido.
 *  3. Ele se remove sozinho depois do dwell.
 *  4. Falha é silenciosa: página fechada devolve `false`, nunca lança.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { spotlight } from "../packages/core/src/spotlight.ts";

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(
    '<button id="alvo" style="position:absolute;left:100px;top:80px;width:120px;height:40px;">Entrar</button>',
  );
});

after(async () => {
  await browser?.close();
});

test("destaque aparece, com selo, e não rouba o hit-testing", async () => {
  const ok = await spotlight(page, { x: 100, y: 80, width: 120, height: 40 }, {
    dwell_ms: 400,
    label: "clicar",
    color: null,
  });
  assert.equal(ok, true, "spotlight deveria ter desenhado");

  const estado = await page.evaluate(() => {
    const q = document.getElementById("__nomos_spotlight__");
    const selo = document.getElementById("__nomos_selo__");
    const alvo = document.elementFromPoint(160, 100); // centro do botão
    return {
      moldura: q !== null,
      pointer_events: q === null ? null : getComputedStyle(q).pointerEvents,
      selo_texto: selo === null ? null : selo.textContent,
      hit: alvo === null ? null : alvo.id,
    };
  });
  assert.equal(estado.moldura, true, "moldura ausente");
  assert.equal(estado.pointer_events, "none", "moldura interceptaria eventos");
  assert.equal(estado.selo_texto, "● NOMOS controlando");
  assert.equal(estado.hit, "alvo", "o overlay roubou o elementFromPoint do alvo");
});

test("remove-se sozinho depois do dwell", async () => {
  await page.waitForFunction(
    () => document.getElementById("__nomos_spotlight__") === null,
    undefined,
    { timeout: 3000 },
  );
  await page.waitForFunction(
    () => document.getElementById("__nomos_selo__") === null,
    undefined,
    { timeout: 5000 },
  );
});

test("falha silenciosa em página fechada — devolve false, não lança", async () => {
  const p2 = await browser.newPage();
  await p2.close();
  const ok = await spotlight(p2, { x: 0, y: 0, width: 10, height: 10 }, {
    dwell_ms: 100,
    label: "clicar",
    color: null,
  });
  assert.equal(ok, false);
});
