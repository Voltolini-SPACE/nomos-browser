/**
 * FASE 2/3/4 — VisionProvider desacoplado, política de fallback e provas negativas.
 *
 * Este arquivo é escrito para PODER FALHAR. Cada código de `VisionOutcome` tem
 * pelo menos uma asserção que só passa se o runtime realmente recusou a agir.
 *
 * Duas separações deliberadas:
 *
 *   - A POLÍTICA é testada com `ScriptedVisionProvider` (determinístico). Testar
 *     a política contra um modelo real mediria o modelo, não a política, e o
 *     mesmo teste daria resultados diferentes entre execuções.
 *
 *   - O `OllamaVisionProvider` é testado no PARSING, com respostas gravadas. A
 *     chamada de rede real é um teste à parte que se PULA explicitamente
 *     (`t.skip`) quando 11434 não responde — nunca finge verde.
 *
 * Rodar: node --test tests/vision.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ActionErrorCode, BoundingBox, VisionProvider } from "../packages/core/src/contract.ts";
import { TargetResolver } from "../packages/core/src/target.ts";
import { colorDistance, decodePng, pixelAt } from "../packages/observability/src/png.ts";
import {
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_THRESHOLD,
  MIN_BOX_SIDE_PX,
  OllamaVisionProvider,
  ScriptedVisionProvider,
  VISION_CASCADE,
  VISION_OUTCOME_TO_ACTION_ERROR,
  Vision,
  VisionError,
  VisionFallbackPolicy,
  actionErrorCodeFor,
  centerOf,
  checkViewport,
  extractJsonCandidates,
  parseVisionResponse,
  readBox,
  scrubExcerpt,
  sha256Hex,
  stripModelNoise,
  type ParseContext,
  type PolicyResolution,
  type VisionOutcome,
} from "../packages/core/src/vision.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };
const OLLAMA = "http://127.0.0.1:11434";

let server: http.Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
/** Preenchido em `before`: null quando 11434 não respondeu. */
let ollamaModels: string[] | null = null;

const PARSE_CTX: ParseContext = {
  goal: "botão azul",
  viewport: VIEWPORT,
  image_hash: "hash-de-teste",
  provider: "ollama",
  model: "moondream:1.8b",
  latency_ms: 42,
};

before(async () => {
  const html = readFileSync(path.join(HERE, "fixtures", "canvas-alvo.html"));
  server = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!.split("#")[0]!;
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  // Porta efêmera em loopback. A 9337 é do nomos-panel de produção e não é tocada.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("teste: endereço inválido");
  baseUrl = `http://127.0.0.1:${addr.port}/`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page = await context.newPage();

  // Sonda de vida do Ollama. Duas tentativas com orçamento generoso: o servidor
  // pode estar carregando/descarregando um modelo, e um PULO por impaciência
  // seria tão mentiroso quanto um verde inventado.
  for (let tentativa = 0; tentativa < 2 && ollamaModels === null; tentativa += 1) {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const body = (await r.json()) as { models?: { name?: string }[] };
        ollamaModels = (body.models ?? []).map((m) => String(m.name ?? "")).filter((s) => s !== "");
      }
    } catch {
      ollamaModels = null; // ausência declarada; o teste de rede se PULA
    }
  }
});

after(async () => {
  await context?.close();
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fresh(): Promise<void> {
  await page.goto("about:blank");
  await page.goto(baseUrl, { waitUntil: "load" });
  // Sem espera arbitrária: a fixture desenha o canvas de forma síncrona no
  // script inline, então `load` já garante o retângulo pintado. A condição
  // verificável é a própria caixa devolvida pela fixture.
  const box = await page.evaluate(() => (window as unknown as { __alvoBox: () => BoundingBox }).__alvoBox());
  assert.ok(box.width > 0 && box.height > 0, "fixture não expôs a caixa do alvo");
}

async function alvoBox(): Promise<BoundingBox> {
  return await page.evaluate(() => (window as unknown as { __alvoBox: () => BoundingBox }).__alvoBox());
}

function scriptedFor(box: BoundingBox, over: Partial<Parameters<ScriptedVisionProvider["set"]>[1]> = {}): ScriptedVisionProvider {
  const p = new ScriptedVisionProvider();
  p.set("retangulo azul do canvas", { box, confidence: 0.93, reason: "retângulo sólido azul", ...over });
  return p;
}

const CANVAS_TARGET = { semantic: "retangulo azul do canvas" } as const;

// ═════════════════════════════════════════════════════════════════════════════
// GRUPO A — parsing defensivo (sem rede, sem navegador)
// ═════════════════════════════════════════════════════════════════════════════

test("A1. JSON limpo vira observação com todos os campos exigidos pela FASE 2", () => {
  const r = parseVisionResponse(
    { response: JSON.stringify({ found: true, box: { x: 10, y: 20, width: 100, height: 40 }, confidence: 0.88, reason: "botao azul a esquerda" }) },
    PARSE_CTX,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const o = r.observation;
  assert.deepEqual(o.boundingBox, { x: 10, y: 20, width: 100, height: 40 });
  assert.deepEqual(o.box, o.boundingBox, "box (contrato v1) precisa espelhar boundingBox");
  assert.equal(o.confidence, 0.88);
  assert.match(o.reason, /botao azul/);
  assert.equal(o.provider, "ollama");
  assert.equal(o.model, "moondream:1.8b");
  assert.equal(o.latency_ms, 42);
  assert.equal(o.image_hash, "hash-de-teste");
  assert.equal(o.coordinate_space, "pixels");
  assert.equal(o.candidates.length, 1);
  assert.equal(typeof o.observed_at, "string");
});

test("A2. texto livre em volta e cerca markdown não impedem o parsing", () => {
  const raw =
    'Claro! Analisando a imagem, encontrei o alvo.\n```json\n{"box": {"x": 5, "y": 6, "width": 7, "height": 8}, "confidence": 0.75}\n```\nEspero ter ajudado.';
  const r = parseVisionResponse({ response: raw }, PARSE_CTX);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.observation.boundingBox, { x: 5, y: 6, width: 7, height: 8 });
});

test("A3. bloco <think> do qwen3.5 é descartado antes do parsing", () => {
  const raw = '<think>O usuário quer o botão. Vou olhar {isto não é JSON</think>\n{"box":{"x":1,"y":2,"width":3,"height":4},"confidence":0.9}';
  assert.doesNotMatch(stripModelNoise(raw), /<think>/);
  const r = parseVisionResponse({ response: raw }, PARSE_CTX);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.observation.boundingBox, { x: 1, y: 2, width: 3, height: 4 });
});

test("A4. convenções de canto nomeadas são convertidas para x/y/width/height", () => {
  const casos: [Record<string, number>, BoundingBox][] = [
    [{ x0: 10, y0: 20, x1: 60, y1: 50 }, { x: 10, y: 20, width: 50, height: 30 }],
    [{ x1: 10, y1: 20, x2: 60, y2: 50 }, { x: 10, y: 20, width: 50, height: 30 }],
    [{ left: 10, top: 20, right: 60, bottom: 50 }, { x: 10, y: 20, width: 50, height: 30 }],
    [{ xmin: 10, ymin: 20, xmax: 60, ymax: 50 }, { x: 10, y: 20, width: 50, height: 30 }],
  ];
  for (const [entrada, esperado] of casos) {
    const read = readBox(entrada);
    assert.equal(read.ok, true, `não leu ${JSON.stringify(entrada)}`);
    if (read.ok) assert.deepEqual(read.box, esperado, JSON.stringify(entrada));
  }
});

test("A5. caixa normalizada 0..1 é escalada pela viewport e declarada como tal", () => {
  const r = parseVisionResponse(
    { response: JSON.stringify({ box: { x: 0.1, y: 0.25, width: 0.2, height: 0.1 }, confidence: 0.8 }) },
    PARSE_CTX,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.observation.coordinate_space, "normalized");
  assert.deepEqual(r.observation.boundingBox, { x: 128, y: 200, width: 256, height: 80 });
});

test("A5b. dica explícita coordinate_space=pixels vence a heurística de 0..1", () => {
  const r = parseVisionResponse(
    { response: JSON.stringify({ coordinate_space: "pixels", box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }, confidence: 0.9 }) },
    PARSE_CTX,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.observation.coordinate_space, "pixels");
  assert.equal(r.observation.boundingBox.x, 0.5);
});

test("A6. array cru de 4 números é RECUSADO (xywh e corners apontam lugares diferentes)", () => {
  const read = readBox([10, 20, 30, 40]);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.code, "AMBIGUOUS_ARRAY");

  const r = parseVisionResponse({ response: '{"box": [10, 20, 30, 40], "confidence": 0.99}' }, PARSE_CTX);
  assert.equal(r.ok, false, "array ambíguo virou clique");
  if (r.ok) return;
  assert.equal(r.rejection.code, "AMBIGUOUS_ARRAY");
});

test("A7. string vazia, ruído puro e resposta não textual não viram coordenada", () => {
  for (const [entrada, code] of [
    [{ response: "" }, "EMPTY"],
    [{ response: "   \n  " }, "EMPTY"],
    [{ response: "<think></think>" }, "EMPTY"],
    [{ nada: 1 }, "NOT_JSON"],
    [42, "NOT_JSON"],
  ] as [unknown, string][]) {
    const r = parseVisionResponse(entrada, PARSE_CTX);
    assert.equal(r.ok, false, `aceitou ${JSON.stringify(entrada)}`);
    if (!r.ok) assert.equal(r.rejection.code, code, JSON.stringify(entrada));
  }
});

test("A8. modelo que declara ausência é respeitado — nunca convertido em palpite", () => {
  for (const texto of ["I could not find the button in this screenshot.", "Não encontrei o alvo pedido.", "not found"]) {
    const r = parseVisionResponse({ response: texto }, PARSE_CTX);
    assert.equal(r.ok, false, `aceitou "${texto}"`);
    if (!r.ok) assert.equal(r.rejection.code, "NO_BOX", texto);
  }
  const r2 = parseVisionResponse({ response: '{"found": false, "reason": "alvo ausente"}' }, PARSE_CTX);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.rejection.code, "NO_BOX");
});

test("A9. JSON quebrado é recusado, não remendado", () => {
  const r = parseVisionResponse({ response: '{"box": {"x": 1, "y": 2, "width": ' }, PARSE_CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.code, "NOT_JSON");
});

test("A10. caixa degenerada (área não positiva ou cantos invertidos) é recusada", () => {
  const casos: [string, string][] = [
    ['{"box":{"x":1,"y":2,"width":0,"height":10},"confidence":0.9}', "DEGENERATE_BOX"],
    ['{"box":{"x":1,"y":2,"width":-5,"height":10},"confidence":0.9}', "DEGENERATE_BOX"],
    ['{"box":{"x0":60,"y0":50,"x1":10,"y1":20},"confidence":0.9}', "DEGENERATE_BOX"],
  ];
  for (const [entrada, code] of casos) {
    const r = parseVisionResponse({ response: entrada }, PARSE_CTX);
    assert.equal(r.ok, false, `aceitou ${entrada}`);
    if (!r.ok) assert.equal(r.rejection.code, code, entrada);
  }
});

test("A11. número inválido não vira 0 nem NaN silencioso", () => {
  for (const entrada of [
    '{"box":{"x":"abc","y":2,"width":10,"height":10},"confidence":0.9}',
    '{"box":{"x":"12px","y":2,"width":10,"height":10},"confidence":0.9}',
    '{"box":{"y":2,"width":10,"height":10},"confidence":0.9}',
  ]) {
    const r = parseVisionResponse({ response: entrada }, PARSE_CTX);
    assert.equal(r.ok, false, `aceitou ${entrada}`);
    if (!r.ok) assert.equal(r.rejection.code, "BAD_NUMBER", entrada);
  }
});

test("A12. confiança ausente ou fora de [0,1] vira 0 — não se inventa a régua do modelo", () => {
  const semConf = parseVisionResponse({ response: '{"box":{"x":1,"y":1,"width":10,"height":10}}' }, PARSE_CTX);
  assert.equal(semConf.ok, true);
  if (semConf.ok) {
    assert.equal(semConf.observation.confidence, 0);
    assert.match(semConf.observation.reason, /não declarou confiança/);
  }
  for (const c of [85, -1, 1.5, "alta"]) {
    const r = parseVisionResponse({ response: `{"box":{"x":1,"y":1,"width":10,"height":10},"confidence":${JSON.stringify(c)}}` }, PARSE_CTX);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.observation.confidence, 0, `confidence=${String(c)} não foi zerada`);
  }
});

test("A13. dois candidatos são preservados — o primeiro NÃO é escolhido no parser", () => {
  const r = parseVisionResponse(
    {
      response: JSON.stringify({
        candidates: [
          { box: { x: 10, y: 10, width: 50, height: 20 }, confidence: 0.9, label: "botao A" },
          { box: { x: 400, y: 10, width: 50, height: 20 }, confidence: 0.88, label: "botao B" },
        ],
      }),
    },
    PARSE_CTX,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.observation.candidates.length, 2);
  assert.notDeepEqual(r.observation.candidates[0]!.box, r.observation.candidates[1]!.box);
});

test("A14. excerpt é escrubado: credencial some, dígito longo vira [NUM]", () => {
  assert.equal(scrubExcerpt("a senha do usuario e xyz"), "[REDACTED]");
  assert.equal(scrubExcerpt("Bearer eyJhbGciOi"), "[REDACTED]");
  assert.equal(scrubExcerpt("o numero 4111111111111111 aparece"), "o numero [NUM] aparece");
  assert.equal(scrubExcerpt("x".repeat(500)).length, 161);
  const r = parseVisionResponse({ response: "minha senha esta na tela e nao ha json" }, PARSE_CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.excerpt, "[REDACTED]", "trecho com credencial não foi escrubado");
});

test("A15. extractJsonCandidates respeita string e escape (chave dentro de string não conta)", () => {
  const blocos = extractJsonCandidates('lixo {"a": "}{", "b": {"c": 1}} fim');
  assert.equal(blocos.length >= 1, true);
  assert.doesNotThrow(() => JSON.parse(blocos[0]!));
  assert.deepEqual(JSON.parse(blocos[0]!), { a: "}{", b: { c: 1 } });
});

test("A16. image_hash é sha256 real do PNG, conferido contra um cálculo independente", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const esperado = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256Hex(bytes), esperado);
  assert.equal(esperado.length, 64);
});

test("A17. nenhum caminho de parsing escreve em stdout/stderr", () => {
  const capturado: string[] = [];
  const outW = process.stdout.write.bind(process.stdout);
  const errW = process.stderr.write.bind(process.stderr);
  // @ts-expect-error patch temporário para provar silêncio
  process.stdout.write = (c: unknown) => (capturado.push(String(c)), true);
  // @ts-expect-error patch temporário para provar silêncio
  process.stderr.write = (c: unknown) => (capturado.push(String(c)), true);
  try {
    parseVisionResponse({ response: "" }, PARSE_CTX);
    parseVisionResponse({ response: "lixo total sem json" }, PARSE_CTX);
    parseVisionResponse({ response: '{"box":[1,2,3,4]}' }, PARSE_CTX);
    parseVisionResponse({ response: '{"box":{"x":1,"y":1,"width":9,"height":9},"confidence":0.9}' }, PARSE_CTX);
  } finally {
    process.stdout.write = outW;
    process.stderr.write = errW;
  }
  assert.deepEqual(capturado, [], `parsing escreveu: ${capturado.join("")}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// GRUPO B — OllamaVisionProvider
// ═════════════════════════════════════════════════════════════════════════════

const PNG_FALSO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function fetchQueDevolve(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("B1. endpoint fora do loopback é recusado na construção (fail closed)", () => {
  assert.throws(
    () => new OllamaVisionProvider({ endpoint: "http://10.0.0.5:11434" }),
    (e: unknown) => e instanceof VisionError && /fora do loopback/.test((e as Error).message),
  );
  assert.throws(() => new OllamaVisionProvider({ endpoint: "http://0.0.0.0:11434" }), VisionError);
  // Só com consentimento explícito.
  assert.doesNotThrow(() => new OllamaVisionProvider({ endpoint: "http://10.0.0.5:11434", allow_remote: true }));
  assert.doesNotThrow(() => new OllamaVisionProvider({ endpoint: "http://127.0.0.1:11434" }));
});

test("B2. resposta boa via fetch injetado produz observação completa", async () => {
  const p = new OllamaVisionProvider({
    model: "moondream:1.8b",
    fetchImpl: fetchQueDevolve({ response: '{"box":{"x":3,"y":4,"width":50,"height":25},"confidence":0.81,"reason":"quadrado"}' }),
  });
  const obs = await p.observe(PNG_FALSO, { goal: "quadrado", viewport: VIEWPORT });
  assert.notEqual(obs, null);
  assert.deepEqual(obs!.boundingBox, { x: 3, y: 4, width: 50, height: 25 });
  assert.equal(obs!.provider, "ollama");
  assert.equal(obs!.model, "moondream:1.8b");
  assert.equal(obs!.image_hash, sha256Hex(PNG_FALSO));
  assert.equal(obs!.latency_ms >= 0, true);
  assert.equal(p.rejectionLog().length, 0);
});

test("B3. HTTP 500 devolve null e fica registrado — nunca vira caixa", async () => {
  const p = new OllamaVisionProvider({ fetchImpl: fetchQueDevolve({ error: "model not found" }, 500) });
  const obs = await p.observe(PNG_FALSO, { goal: "x", viewport: VIEWPORT });
  assert.equal(obs, null);
  const log = p.rejectionLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.code, "HTTP");
  assert.match(log[0]!.reason, /HTTP 500/);
});

test("B4. falha de transporte e timeout são distinguidos e registrados", async () => {
  const semRede = new OllamaVisionProvider({
    fetchImpl: (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  assert.equal(await semRede.observe(PNG_FALSO, { goal: "x", viewport: VIEWPORT }), null);
  assert.equal(semRede.rejectionLog()[0]!.code, "TRANSPORT");

  const lento = new OllamaVisionProvider({
    fetchImpl: (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch,
  });
  assert.equal(await lento.observe(PNG_FALSO, { goal: "x", viewport: VIEWPORT }), null);
  assert.equal(lento.rejectionLog()[0]!.code, "TIMEOUT");
});

test("B5. texto livre do modelo através do provider inteiro devolve null e registra", async () => {
  const p = new OllamaVisionProvider({
    fetchImpl: fetchQueDevolve({ response: "Olha, eu acho que o botao esta mais ou menos no meio da tela." }),
  });
  assert.equal(await p.observe(PNG_FALSO, { goal: "botao", viewport: VIEWPORT }), null);
  assert.equal(p.rejectionLog()[0]!.code, "NOT_JSON");
});

const OUTCOMES_LEGAIS: readonly VisionOutcome[] = [
  "RESOLVED", "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "STALE_OBSERVATION", "VISION_UNCERTAIN",
  "BOX_OUT_OF_VIEWPORT", "OVERLAY_OBSTRUCTED", "HUMAN_REQUIRED", "PROVIDER_ERROR",
  "PROVIDER_TIMEOUT", "INVALID_REQUEST",
];

test("B6. modelo REAL do Ollama atravessando a política — pulada se 11434 não responder", async (t) => {
  if (ollamaModels === null) {
    t.skip("Ollama em 127.0.0.1:11434 não respondeu — nenhuma chamada de rede foi feita");
    return;
  }
  // Preferência: o modelo que o módulo declara como padrão. Testar um modelo
  // diferente do default seria provar um caminho que ninguém usa em produção.
  const visual =
    ollamaModels.find((m) => m === DEFAULT_VISION_MODEL) ??
    ollamaModels.find((m) => /llava|vision|qwen[\d.]*vl|moondream/i.test(m));
  if (visual === undefined) {
    t.skip(`nenhum modelo multimodal entre os instalados (${ollamaModels.join(", ")}) — nada foi baixado`);
    return;
  }

  // Viewport menor só para este teste: menos tokens de imagem, mesma prova.
  // MEDIDO nesta máquina: 1280x800 custa ~55–95s por chamada; 640x400 custa
  // ~14–25s. O que se prova não muda com o tamanho.
  const vpMenor = { width: 640, height: 400 };
  const ctxMenor = await browser.newContext({ viewport: vpMenor, deviceScaleFactor: 1 });
  const pageMenor = await ctxMenor.newPage();
  try {
    await pageMenor.goto(baseUrl, { waitUntil: "load" });
    const provider = new OllamaVisionProvider({ model: visual, timeout_ms: 90_000 });
    const pol = new VisionFallbackPolicy({ vision: provider, vision_timeout_ms: 95_000 });

    const t0 = Date.now();
    const r = await pol.resolve(pageMenor, CANVAS_TARGET);
    const ms = Date.now() - t0;

    // INVARIANTE, não medição do modelo. O que um modelo de 1.8B/3B responde
    // varia; o que NÃO pode variar é: outcome dentro do vocabulário, e
    // "RESOLVED" só com caixa mecanicamente verificada dentro da viewport.
    assert.ok(OUTCOMES_LEGAIS.includes(r.outcome), `outcome fora do vocabulário: ${r.outcome}`);
    if (r.outcome === "RESOLVED") {
      assert.notEqual(r.target, null);
      assert.equal(checkViewport(r.target!.box, vpMenor).ok, true, "política aceitou caixa que ela mesma reprova");
      assert.equal(r.vision!.image_hash, r.image_hash, "observação de outra imagem passou");
      assert.notEqual(r.anchor, null, "resolvido sem âncora: o guard ficaria indeterminável");
      assert.equal(r.error, null);
    } else {
      assert.equal(r.target, null, "devolveu alvo clicável junto com uma recusa");
      assert.ok(CODIGOS_DO_CONTRATO.includes(r.error!.code), `código fora do contrato: ${r.error!.code}`);
    }

    const alvo = await pageMenor.evaluate(() => (window as unknown as { __alvoBox: () => BoundingBox }).__alvoBox());
    t.diagnostic(`${visual} @ ${vpMenor.width}x${vpMenor.height}: ${r.outcome} em ${ms}ms — ${r.reason}`);
    t.diagnostic(`alvo realmente desenhado: ${JSON.stringify(alvo)}`);
    if (r.vision !== null) t.diagnostic(`caixa alegada pelo modelo: ${JSON.stringify(r.vision.boundingBox)} conf=${r.vision.confidence}`);
    for (const rej of provider.rejectionLog()) t.diagnostic(`recusa registrada: ${rej.code} — ${rej.reason} | ${rej.excerpt}`);
  } finally {
    await ctxMenor.close();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GRUPO C — política de fallback (Chromium real + fixture real)
// ═════════════════════════════════════════════════════════════════════════════

test("C0. cascata da FASE 3 é exatamente DOM → accessibility → semantic → vision → human", () => {
  assert.deepEqual([...VISION_CASCADE], ["dom", "accessibility", "semantic", "vision", "human"]);
  assert.equal(DEFAULT_VISION_THRESHOLD, 0.7);
});

test("C1. DOM existe ⇒ resolve no 1º degrau e a visão NEM é consultada", async () => {
  await fresh();
  const visao = scriptedFor({ x: 0, y: 0, width: 10, height: 10 });
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, { role: "button", text: "Confirmar" });

  assert.equal(r.outcome, "RESOLVED");
  assert.equal(r.rung, "dom");
  assert.equal(r.human_required, false);
  assert.equal(r.error, null);
  assert.equal(visao.calls, 0, "visão foi consultada mesmo com DOM disponível");
  assert.equal(r.vision, null);
  assert.match(String(r.target?.description), /btn-real/);
  assert.equal(r.attempts[0]!.rung, "dom");
  assert.equal(r.attempts[0]!.outcome, "hit");
});

test("C2. alvo só-pixel no <canvas> só é alcançado no 4º degrau, e a caixa aponta para os pixels certos", async () => {
  await fresh();
  const box = await alvoBox();
  const visao = scriptedFor(box);
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, CANVAS_TARGET);

  assert.equal(r.outcome, "RESOLVED", r.reason);
  assert.equal(r.rung, "vision");
  assert.equal(visao.calls, 1);
  assert.deepEqual(r.target?.box, box);
  assert.equal(r.target?.healed, true);
  assert.equal(r.vision?.confidence, 0.93);
  assert.equal(r.anchor, "canvas#tela@0", `âncora inesperada: ${String(r.anchor)}`);
  assert.equal(typeof r.image_hash, "string");
  assert.equal(r.region_hash !== null, true);

  // Degraus 1–3 tentaram e falharam ANTES — o rastro precisa provar isso.
  const semantic = r.attempts.find((a) => a.rung === "semantic");
  assert.equal(semantic?.outcome, "miss", `semantic não foi tentado: ${JSON.stringify(r.attempts)}`);

  // Prova MEDIDA de que a caixa é o retângulo desenhado, e não uma coordenada
  // qualquer que "parece certa": decodifica o recorte e compara o pixel central.
  const recorte = await page.screenshot({ type: "png", scale: "css", clip: box });
  const png = decodePng(recorte);
  const px = pixelAt(png, Math.floor(png.width / 2), Math.floor(png.height / 2));
  const dist = colorDistance(px, { r: 0x00, g: 0x57, b: 0xff, a: 255 });
  assert.ok(dist < 12, `pixel central ${JSON.stringify(px)} distante ${dist.toFixed(2)} do azul do alvo`);

  // Controle negativo do próprio instrumento: fora do retângulo a cor é outra.
  const foraPng = decodePng(await page.screenshot({ type: "png", scale: "css", clip: { x: box.x - 40, y: box.y, width: 20, height: 20 } }));
  const fora = pixelAt(foraPng, 10, 10);
  assert.ok(colorDistance(fora, { r: 0x00, g: 0x57, b: 0xff, a: 255 }) > 50, "controle negativo tem a cor do alvo");
});

test("C3. alvo inexistente ⇒ TARGET_NOT_FOUND + escalada ao 5º degrau", async () => {
  await fresh();
  const visao = new ScriptedVisionProvider({ "coisa que nao existe": { absent: true } });
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, { semantic: "coisa que nao existe" });

  assert.equal(r.outcome, "TARGET_NOT_FOUND");
  assert.equal(r.rung, "human");
  assert.equal(r.human_required, true, "não escalou ao humano depois de esgotar os 4 degraus");
  assert.equal(r.target, null);
  assert.equal(visao.calls, 1);
  assert.equal(r.error?.code, "TARGET_NOT_FOUND");
  assert.equal((r.error?.detail as Record<string, unknown>).vision_outcome, "TARGET_NOT_FOUND");
});

test("C3b. sem VisionProvider injetado, o 4º degrau é PULADO e registrado como tal", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({ vision: null });
  const r = await pol.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "TARGET_NOT_FOUND");
  assert.equal(r.human_required, true);
  const v = r.attempts.find((a) => a.rung === "vision");
  assert.equal(v?.outcome, "skipped");
  assert.match(String(v?.detail), /nenhum VisionProvider injetado/);
});

test("C4. dois alvos idênticos no DOM ⇒ TARGET_AMBIGUOUS e a cascata PARA (visão não é consultada)", async () => {
  await fresh();
  const visao = scriptedFor({ x: 1, y: 1, width: 10, height: 10 });
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, { text: "Gemeo" });

  assert.equal(r.outcome, "TARGET_AMBIGUOUS");
  assert.equal(r.rung, "dom");
  assert.equal(r.target, null, "escolheu um dos gêmeos em silêncio");
  assert.equal(visao.calls, 0, "ambiguidade foi lavada descendo para a visão");
  assert.equal(r.error?.code, "TARGET_AMBIGUOUS");
});

test("C5. visão que vê DOIS alvos parecidos ⇒ TARGET_AMBIGUOUS, sem pegar o primeiro", async () => {
  await fresh();
  const box = await alvoBox();
  const irmao: BoundingBox = { x: box.x + 300, y: box.y, width: box.width, height: box.height };
  const visao = new ScriptedVisionProvider({
    "retangulo azul do canvas": {
      confidence: 0.95,
      candidates: [
        { box, confidence: 0.95, label: "esquerdo" },
        { box: irmao, confidence: 0.94, label: "direito" },
      ],
    },
  });
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, CANVAS_TARGET);

  assert.equal(r.outcome, "TARGET_AMBIGUOUS");
  assert.equal(r.rung, "vision");
  assert.equal(r.target, null, "escolheu o primeiro candidato da visão");
  assert.equal((r.error?.detail as Record<string, unknown>).candidates, 2);
  assert.equal(r.error?.code, "TARGET_AMBIGUOUS");
  // A observação fica anexada como evidência, mesmo em falha.
  assert.equal(r.vision?.candidates.length, 2);
});

test("C6. confiança abaixo do limiar ⇒ VISION_UNCERTAIN (e o limiar é configurável)", async () => {
  await fresh();
  const box = await alvoBox();

  const visao = scriptedFor(box, { confidence: 0.42 });
  const estrito = new VisionFallbackPolicy({ vision: visao, threshold: 0.7 });
  const r = await estrito.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "VISION_UNCERTAIN");
  assert.equal(r.target, null);
  assert.equal(r.error?.code, "TARGET_NOT_FOUND", "VISION_UNCERTAIN precisa mapear para um código do contrato v1");
  assert.equal((r.error?.detail as Record<string, unknown>).vision_outcome, "VISION_UNCERTAIN");
  assert.match(r.reason, /abaixo do limiar/);

  const frouxo = new VisionFallbackPolicy({ vision: scriptedFor(box, { confidence: 0.42 }), threshold: 0.3 });
  const r2 = await frouxo.resolve(page, CANVAS_TARGET);
  assert.equal(r2.outcome, "RESOLVED", "limiar de 0.3 deveria aceitar confiança 0.42");

  // Limiar exatamente igual passa (>=), e limiar inválido é recusado na construção.
  const limite = new VisionFallbackPolicy({ vision: scriptedFor(box, { confidence: 0.7 }), threshold: 0.7 });
  assert.equal((await limite.resolve(page, CANVAS_TARGET)).outcome, "RESOLVED");
  assert.throws(() => new VisionFallbackPolicy({ threshold: 1.7 }), VisionError);
  assert.throws(() => new VisionFallbackPolicy({ threshold: -0.1 }), VisionError);
});

test("C7. caixa fora da viewport NUNCA vira clique", async () => {
  await fresh();
  const casos: [string, BoundingBox][] = [
    ["à direita da tela", { x: 5000, y: 10, width: 40, height: 20 }],
    ["abaixo da tela", { x: 10, y: 9000, width: 40, height: 20 }],
    ["origem negativa", { x: -30, y: 10, width: 40, height: 20 }],
    ["extrapola pela direita", { x: VIEWPORT.width - 10, y: 10, width: 40, height: 20 }],
    ["largura zero", { x: 10, y: 10, width: 0, height: 20 }],
    ["não finita", { x: Number.NaN, y: 10, width: 40, height: 20 }],
  ];
  for (const [nome, box] of casos) {
    const pol = new VisionFallbackPolicy({ vision: scriptedFor(box, { confidence: 0.99 }) });
    const r = await pol.resolve(page, CANVAS_TARGET);
    assert.equal(r.outcome, "BOX_OUT_OF_VIEWPORT", `${nome}: outcome ${r.outcome}`);
    assert.equal(r.target, null, `${nome}: devolveu alvo clicável fora da tela`);
    assert.equal(r.error?.code, "TARGET_NOT_FOUND");
  }
});

test("C7b. caixa que cobre a viewport inteira é palpite, não alvo ⇒ VISION_UNCERTAIN", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({
    vision: scriptedFor({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }, { confidence: 0.99 }),
  });
  const r = await pol.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "VISION_UNCERTAIN");
  assert.match(r.reason, /cobre 100\.0% da viewport/);

  // checkViewport isolado: mesma régua, incluindo o controle positivo.
  assert.equal(checkViewport({ x: 10, y: 10, width: 50, height: 20 }, VIEWPORT).ok, true);
  assert.equal(checkViewport({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }, VIEWPORT).outcome, "VISION_UNCERTAIN");
});

test("C7c. caixa sub-pixel do moondream real (0.8x0.8 declarada em 'pixels') não vira clique", async () => {
  await fresh();
  // Regressão de um caso OBSERVADO: moondream:1.8b devolveu, de forma
  // reprodutível, {"x":0,"y":0,"width":0.8,"height":0.8,"coordinate_space":"pixels"}
  // — número normalizado com espaço declarado como pixels, ecoando o template
  // do prompt. Sem o piso de lado mínimo isso seria um clique em (0.4, 0.4).
  const eco = parseVisionResponse(
    { response: '{"found": true, "box": {"x": 0, "y": 0, "width": 0.8, "height": 0.8}, "coordinate_space": "pixels", "confidence": 0.8}' },
    { ...PARSE_CTX, viewport: VIEWPORT },
  );
  assert.equal(eco.ok, true, "o parser deve RELATAR o que o modelo disse");
  if (!eco.ok) return;
  assert.equal(eco.observation.coordinate_space, "pixels");
  assert.deepEqual(eco.observation.boundingBox, { x: 0, y: 0, width: 0.8, height: 0.8 });

  // …e a POLÍTICA é quem recusa.
  assert.equal(checkViewport(eco.observation.boundingBox, VIEWPORT).outcome, "VISION_UNCERTAIN");
  const pol = new VisionFallbackPolicy({ vision: scriptedFor({ x: 0, y: 0, width: 0.8, height: 0.8 }, { confidence: 0.8 }) });
  const r = await pol.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "VISION_UNCERTAIN");
  assert.equal(r.target, null);
  assert.match(r.reason, /lado mínimo clicável/);

  // O piso vale exatamente no limite, e não estrangula alvo pequeno legítimo.
  assert.equal(checkViewport({ x: 5, y: 5, width: MIN_BOX_SIDE_PX, height: MIN_BOX_SIDE_PX }, VIEWPORT).ok, true);
  assert.equal(checkViewport({ x: 5, y: 5, width: MIN_BOX_SIDE_PX - 0.1, height: 10 }, VIEWPORT).ok, false);

  // Um modelo refutado por medição não pode ser o padrão do módulo.
  assert.notEqual(DEFAULT_VISION_MODEL, "moondream:1.8b", "o default aponta para um modelo que não produz caixa");
});

test("C8. observação com image_hash de OUTRA imagem ⇒ STALE_OBSERVATION", async () => {
  await fresh();
  const box = await alvoBox();
  const visao = scriptedFor(box, { image_hash: "0".repeat(64) });
  const pol = new VisionFallbackPolicy({ vision: visao });
  const r = await pol.resolve(page, CANVAS_TARGET);

  assert.equal(r.outcome, "STALE_OBSERVATION");
  assert.equal(r.target, null);
  assert.equal(r.error?.code, "VERIFICATION_FAILED", "STALE_OBSERVATION precisa mapear para VERIFICATION_FAILED");
  assert.equal((r.error?.detail as Record<string, unknown>).observed, "0".repeat(64));
});

test("C9. assertObservationCurrent: verde quando nada muda, STALE quando a tela muda", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({});
  const png = await page.screenshot({ type: "png", scale: "css" });
  const obs = { image_hash: sha256Hex(png) };

  // CONTROLE POSITIVO: sem esse par, "detecta mudança" seria indistinguível de
  // "grita lobo sempre" — bastaria o PNG não ser determinístico.
  const antes = await pol.assertObservationCurrent(page, obs);
  assert.equal(antes.ok, true, `recapturar a mesma tela deu ${antes.outcome}: ${antes.reason}`);

  await page.evaluate(() => (window as unknown as { __mudaPixels: () => boolean }).__mudaPixels());
  const depois = await pol.assertObservationCurrent(page, obs);
  assert.equal(depois.ok, false);
  assert.equal(depois.outcome, "STALE_OBSERVATION");
  assert.notEqual((depois.detail as Record<string, unknown>).observed, obs.image_hash);
});

test("C10. página muda entre a percepção e o clique ⇒ guard devolve STALE_OBSERVATION", async () => {
  await fresh();
  const box = await alvoBox();
  const pol = new VisionFallbackPolicy({ vision: scriptedFor(box) });
  const r = await pol.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "RESOLVED");

  const antes = await pol.guard(page, r);
  assert.equal(antes.ok, true, `guard reprovou uma página intacta: ${antes.outcome} — ${antes.reason}`);

  // Muda SÓ os pixels do canvas: nenhuma mutação de DOM, nenhum elemento novo.
  // Só um hash de imagem detecta isso.
  await page.evaluate(() => (window as unknown as { __mudaPixels: () => boolean }).__mudaPixels());
  const depois = await pol.guard(page, r);
  assert.equal(depois.ok, false, "clique liberado sobre pixels que já mudaram");
  assert.equal(depois.outcome, "STALE_OBSERVATION");
  assert.equal(actionErrorCodeFor(depois.outcome), "VERIFICATION_FAILED");
});

test("C11. overlay sobre o alvo DOM é detectado por elementFromPoint ⇒ OVERLAY_OBSTRUCTED + humano", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({ vision: scriptedFor({ x: 1, y: 1, width: 5, height: 5 }) });

  const limpo = await pol.resolve(page, { role: "button", text: "Confirmar" });
  assert.equal(limpo.outcome, "RESOLVED", "controle positivo falhou: botão descoberto já dava obstruído");

  await page.evaluate(() => (window as unknown as { __cobreBotao: () => boolean }).__cobreBotao());
  const coberto = await pol.resolve(page, { role: "button", text: "Confirmar" });

  assert.equal(coberto.outcome, "OVERLAY_OBSTRUCTED");
  assert.equal(coberto.human_required, true);
  assert.equal(coberto.error?.code, "VERIFICATION_FAILED");
  assert.match(String((coberto.error?.detail as Record<string, unknown>).topmost), /cobre-botao/);
  // O alvo continua anexado como evidência — o que se recusa é AGIR sobre ele.
  assert.notEqual(coberto.target, null);
});

test("C12. overlay que aparece DEPOIS da resolução por visão é pego pelo guard", async () => {
  await fresh();
  const box = await alvoBox();
  const pol = new VisionFallbackPolicy({ vision: scriptedFor(box) });
  const r = await pol.resolve(page, CANVAS_TARGET);
  assert.equal(r.outcome, "RESOLVED");
  assert.equal(r.anchor, "canvas#tela@0");

  await page.evaluate(() => (window as unknown as { __cobreCanvas: () => boolean }).__cobreCanvas());
  const g = await pol.guard(page, r);
  assert.equal(g.ok, false, "clique liberado sobre uma caixa coberta por overlay");
  assert.equal(g.outcome, "OVERLAY_OBSTRUCTED");
  assert.match(String((g.detail as Record<string, unknown>).topmost), /cobertura/);
});

test("C13. provedor que lança ⇒ PROVIDER_ERROR; provedor lento ⇒ PROVIDER_TIMEOUT", async () => {
  await fresh();
  const explode = new ScriptedVisionProvider({ "retangulo azul do canvas": { throws: "modelo caiu" } });
  const pol1 = new VisionFallbackPolicy({ vision: explode });
  const r1 = await pol1.resolve(page, CANVAS_TARGET);
  assert.equal(r1.outcome, "PROVIDER_ERROR");
  assert.equal(r1.error?.code, "INTERNAL");
  assert.match(r1.reason, /modelo caiu/);

  const box = await alvoBox();
  const lento = scriptedFor(box, { latency_ms: 600 });
  const pol2 = new VisionFallbackPolicy({ vision: lento, vision_timeout_ms: 60 });
  const r2 = await pol2.resolve(page, CANVAS_TARGET);
  assert.equal(r2.outcome, "PROVIDER_TIMEOUT");
  assert.equal(r2.error?.code, "TIMEOUT");
  assert.equal(r2.target, null);
});

test("C14. descritor sem campo utilizável ⇒ INVALID_REQUEST, nunca chute", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({ vision: scriptedFor({ x: 1, y: 1, width: 5, height: 5 }) });
  assert.equal((await pol.resolve(page, {})).outcome, "INVALID_REQUEST");
  // `coordinates` NÃO é degrau desta cascata: sozinha, não pode curto-circuitar
  // o takeover humano.
  const soCoord = await pol.resolve(page, { coordinates: { x: 100, y: 100 } });
  assert.equal(soCoord.outcome, "INVALID_REQUEST");
  assert.equal(soCoord.target, null);
});

test("C15. guard recusa proteger uma resolução que não resolveu", async () => {
  await fresh();
  const pol = new VisionFallbackPolicy({ vision: new ScriptedVisionProvider({ zzz: { absent: true } }) });
  const r = await pol.resolve(page, { semantic: "zzz" });
  assert.equal(r.outcome, "TARGET_NOT_FOUND");
  const g = await pol.guard(page, r);
  assert.equal(g.ok, false);
  assert.equal(g.outcome, "INVALID_REQUEST");
});

test("C16. oclusão indeterminável NÃO é liberada (fail closed)", async () => {
  await fresh();
  const box = await alvoBox();
  const pol = new VisionFallbackPolicy({ vision: scriptedFor(box) });
  const r = await pol.resolve(page, CANVAS_TARGET);
  const semEvidencia: PolicyResolution = { ...r, anchor: null, target: { ...r.target!, handle: undefined } };
  const g = await pol.guard(page, semEvidencia);
  assert.equal(g.ok, false, "sem handle e sem âncora, o guard liberou o clique");
  assert.equal(g.outcome, "HUMAN_REQUIRED");
});

// ═════════════════════════════════════════════════════════════════════════════
// GRUPO D — fronteira com o contrato v1
// ═════════════════════════════════════════════════════════════════════════════

const CODIGOS_DO_CONTRATO: readonly ActionErrorCode[] = [
  "SESSION_NOT_FOUND", "SESSION_NOT_ACTIVE", "CONTROL_HELD_BY_HUMAN", "CAPABILITY_DENIED",
  "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "VERIFICATION_FAILED", "NAVIGATION_FAILED",
  "TIMEOUT", "BACKPRESSURE_REJECTED", "POLICY_BLOCKED", "BROWSER_UNAVAILABLE",
  "UPLOAD_DENIED", "DOWNLOAD_DENIED", "INVALID_REQUEST", "INTERNAL",
];

test("D1. todo VisionOutcome (menos RESOLVED) mapeia para um ActionErrorCode que EXISTE no contrato v1", () => {
  const outcomes: Exclude<VisionOutcome, "RESOLVED">[] = [
    "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "STALE_OBSERVATION", "VISION_UNCERTAIN",
    "BOX_OUT_OF_VIEWPORT", "OVERLAY_OBSTRUCTED", "HUMAN_REQUIRED", "PROVIDER_ERROR",
    "PROVIDER_TIMEOUT", "INVALID_REQUEST",
  ];
  assert.deepEqual(Object.keys(VISION_OUTCOME_TO_ACTION_ERROR).sort(), [...outcomes].sort());
  for (const o of outcomes) {
    const code = actionErrorCodeFor(o);
    assert.ok(CODIGOS_DO_CONTRATO.includes(code), `${o} → ${code} não é um ActionErrorCode do contrato`);
  }
  // Os quatro códigos que a FASE 4 exige e que o v1 não tem são justamente os
  // que perdem granularidade aqui. O `detail` é quem preserva.
  assert.equal(VISION_OUTCOME_TO_ACTION_ERROR.STALE_OBSERVATION, "VERIFICATION_FAILED");
  assert.equal(VISION_OUTCOME_TO_ACTION_ERROR.VISION_UNCERTAIN, "TARGET_NOT_FOUND");
  assert.equal(VISION_OUTCOME_TO_ACTION_ERROR.BOX_OUT_OF_VIEWPORT, "TARGET_NOT_FOUND");
  assert.equal(VISION_OUTCOME_TO_ACTION_ERROR.OVERLAY_OBSTRUCTED, "VERIFICATION_FAILED");
  assert.throws(() => actionErrorCodeFor("RESOLVED"), VisionError);
});

test("D2. toActionError preserva o outcome original em detail (tradução lossy só no código)", () => {
  const e = Vision.toActionError({ outcome: "STALE_OBSERVATION", reason: "x", detail: { a: 1 } });
  assert.equal(e?.code, "VERIFICATION_FAILED");
  assert.equal((e?.detail as Record<string, unknown>).vision_outcome, "STALE_OBSERVATION");
  assert.equal((e?.detail as Record<string, unknown>).a, 1);
  assert.equal(Vision.toActionError({ outcome: "RESOLVED", reason: "" }), null);
});

test("D3. RichVisionProvider satisfaz o VisionProvider do contrato — TargetResolver o aceita sem adaptador", async () => {
  await fresh();
  const box = await alvoBox();
  const rico = scriptedFor(box);
  // Atribuição ao tipo do contrato: se `RichVisionProvider` tivesse REDEFINIDO
  // em vez de estendido, esta linha não compilaria e o resolvedor da FASE 13
  // precisaria de um adaptador.
  const comoContrato: VisionProvider = rico;
  assert.equal(comoContrato.name, "scripted");

  const r = await TargetResolver.resolve(page, { selector: "#nao-existe", semantic: "retangulo azul do canvas" }, { vision: comoContrato });
  assert.equal(r.strategy, "vision");
  assert.equal(r.healed, true);
  assert.deepEqual(r.box, box);
  assert.equal(rico.calls, 1);
});

test("D4. centerOf e o veredito de viewport concordam com a caixa real da fixture", async () => {
  await fresh();
  const box = await alvoBox();
  const c = centerOf(box);
  assert.equal(c.x, box.x + box.width / 2);
  assert.equal(c.y, box.y + box.height / 2);
  assert.equal(checkViewport(box, VIEWPORT).ok, true);
  assert.equal(await Vision.topmostAt(page, c.x, c.y), "canvas#tela@0");
});

test("D5. superfície pública do módulo está montada", () => {
  assert.equal(typeof Vision.Policy, "function");
  assert.equal(typeof Vision.Ollama, "function");
  assert.equal(typeof Vision.Scripted, "function");
  assert.equal(typeof Vision.parse, "function");
  assert.equal(typeof Vision.checkOcclusion, "function");
  assert.equal(typeof Vision.checkViewport, "function");
  assert.equal(Vision.OUTCOME_MAP, VISION_OUTCOME_TO_ACTION_ERROR);
  assert.equal(Object.isFrozen(VISION_OUTCOME_TO_ACTION_ERROR), true);
  assert.equal(Object.isFrozen(VISION_CASCADE), true);
});
