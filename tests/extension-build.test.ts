/**
 * Extensão NOMOS — build, marca e MENOR PRIVILÉGIO (FASES 18/30/37 da missão).
 *
 * O que se prova aqui:
 *  1. O fonte da extensão não contém token de marca (contrato §6.3) — mesma
 *     regra e mesmo tipo de guarda da NOMOS Web.
 *  2. O manifesto pede o mínimo: sem `<all_urls>`, sem content scripts, sem
 *     host permission fora do loopback, sem permissões além de
 *     sidePanel+storage. Ampliar isso exige editar ESTE teste — e é essa
 *     fricção que mantém o privilégio pequeno.
 *  3. O build injeta os tokens do cofre e produz uma extensão completa.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, pngSolido } from "../packages/extension/build.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(RAIZ, "packages/extension/src");

test("o fonte da extensão não contém NENHUM token de marca", () => {
  for (const f of readdirSync(SRC)) {
    const texto = readFileSync(path.join(SRC, f), "utf8");
    assert.doesNotMatch(
      texto,
      /#[0-9A-Fa-f]{6}\b/,
      `${f}: hex literal — token copiado para fora do cofre`,
    );
  }
});

test("manifesto pede o MÍNIMO — ampliar exige editar este teste", () => {
  const m = JSON.parse(readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["sidePanel", "storage"]);
  assert.deepEqual(m.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"],
    "host permission fora do loopback");
  assert.equal(m.content_scripts, undefined,
    "content script não existe de propósito: o highlight é do RUNTIME (spotlight.ts)");
  assert.equal(m.optional_host_permissions, undefined);
  const texto = readFileSync(path.join(SRC, "manifest.json"), "utf8");
  assert.ok(!texto.includes("<all_urls>"), "<all_urls> é proibido nesta extensão");
});

test("build injeta tokens do cofre e produz extensão completa", () => {
  const r = buildExtension();
  assert.match(r.corMarca, /^#[0-9A-F]{6}$/);
  const html = readFileSync(path.join(r.dist, "sidepanel.html"), "utf8");
  assert.ok(html.includes("--nomos-marca:"), "CSS vars da marca ausentes no dist");
  assert.ok(!html.includes("__NOMOS_FONT_MONO__"), "placeholder sobrou no dist");
  for (const f of ["manifest.json", "background.js", "sidepanel.js", "icons/16.png", "icons/48.png", "icons/128.png"]) {
    assert.ok(existsSync(path.join(r.dist, f)), `dist sem ${f}`);
  }
});

test("os ícones são PNG válidos na cor da marca (assinatura + IHDR)", () => {
  const png = pngSolido(16, "#0A0B0C");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 16); // largura no IHDR
  assert.equal(png.readUInt32BE(20), 16); // altura no IHDR
});

test("o painel não fala com o Chromium: nenhuma API chrome.* de página no fonte", () => {
  const js = readFileSync(path.join(SRC, "sidepanel.js"), "utf8");
  // A ÚNICA API de extensão permitida no painel é storage (guardar URL/token).
  // tabs/scripting/debugger dariam à extensão exatamente a autoridade paralela
  // que a arquitetura proíbe — toda ação passa pelo runtime.
  for (const proibida of ["chrome.tabs", "chrome.scripting", "chrome.debugger", "chrome.cookies", "chrome.webNavigation"]) {
    assert.ok(!js.includes(proibida), `painel usa ${proibida} — autoridade paralela ao runtime`);
  }
});
