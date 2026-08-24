/**
 * FASE 10/11 — smoke test do PointerEngine e do KeyboardEngine.
 *
 * Chromium REAL, fixture local, servidor efêmero. Nenhuma asserção depende de
 * "não deu exceção": cada uma lê o que a PÁGINA registrou. `isTrusted` é o
 * discriminador — clique sintetizado por JS chega false, e há um controle
 * negativo explícito provando que o discriminador é capaz de valer false.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { RuntimeEvent } from "../packages/core/src/contract.ts";
import { InputError, PointerEngine, interpolatePath } from "../packages/core/src/pointer.ts";
import { KeyboardEngine, describeKey, macEditingCommands } from "../packages/core/src/keyboard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pointer-keyboard.html");
const VIEWPORT = { width: 1280, height: 800 };

interface Rec {
  seq: number;
  type: string;
  isTrusted: boolean;
  target: string | null;
  x: number | null;
  y: number | null;
  key: string | null;
  code: string | null;
  meta: boolean;
  shift: boolean;
  button: number | null;
  scrollTop?: number;
  submitted?: boolean;
  value_length?: number | null;
}

let server: http.Server;
let baseUrl = "";
let browser: Browser;

before(async () => {
  const html = readFileSync(FIXTURE);
  server = http.createServer((req, res) => {
    if (req.url === "/" || req.url!.startsWith("/?") || req.url!.startsWith("/#")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("teste: endereço do servidor inválido");
  baseUrl = `http://127.0.0.1:${addr.port}/`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rig {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  events: RuntimeEvent[];
  log(): Promise<Rec[]>;
  rect(sel: string): Promise<{ x: number; y: number; width: number; height: number; cx: number; cy: number }>;
  close(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const events: RuntimeEvent[] = [];
  return {
    context,
    page,
    cdp,
    events,
    log: () => page.evaluate(() => (globalThis as unknown as { __nomos: Rec[] }).__nomos),
    rect: async (sel: string) => {
      const r = await page.evaluate(
        (s) => (globalThis as unknown as { __nomosRect: (x: string) => unknown }).__nomosRect(s),
        sel,
      );
      if (r === null) throw new Error(`teste: seletor sem retângulo: ${sel}`);
      return r as { x: number; y: number; width: number; height: number; cx: number; cy: number };
    },
    close: () => context.close(),
  };
}

function pointer(r: Rig, backend: "cdp" | "playwright", extra: Record<string, unknown> = {}): PointerEngine {
  return new PointerEngine({
    page: r.page,
    cdp: r.cdp,
    backend,
    fallback: "none",
    session_id: "sess_test",
    source: "test",
    onEvent: (e) => r.events.push(e),
    ...extra,
  });
}

function keyboard(r: Rig, backend: "cdp" | "playwright", extra: Record<string, unknown> = {}): KeyboardEngine {
  return new KeyboardEngine({
    page: r.page,
    cdp: r.cdp,
    backend,
    fallback: "none",
    session_id: "sess_test",
    source: "test",
    onEvent: (e) => r.events.push(e),
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("PointerEngine", () => {
  for (const backend of ["cdp", "playwright"] as const) {
    it(`click via backend ${backend} chega na página com isTrusted=true`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const box = await r.rect("#hit");
      const p = pointer(r, backend);

      const res = await p.click({ x: box.cx, y: box.cy });

      await r.page.waitForFunction(
        () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "click" && e.target === "hit"),
        null,
        { timeout: 5000 },
      );
      const log = await r.log();
      const click = log.find((e) => e.type === "click" && e.target === "hit");

      assert.ok(click, "a página não registrou click em #hit");
      assert.equal(click.isTrusted, true, "click não é input real (isTrusted=false)");
      assert.equal(res.backend, backend, "resultado não registrou o backend que agiu");
      assert.equal(res.requested_backend, backend);
      assert.equal(res.fallback_used, false);
      assert.equal(res.action, "click");
      assert.equal(res.click_count, 1);
      assert.equal(res.button, "left");
      assert.ok(res.duration_ms >= 0);
      assert.deepEqual(res.to, { x: box.cx, y: box.cy });
      // Coordenada entregue == coordenada recebida pela página (±1px).
      assert.ok(Math.abs(click.x! - box.cx) <= 1, `dx=${Math.abs(click.x! - box.cx)}`);
      assert.ok(Math.abs(click.y! - box.cy) <= 1, `dy=${Math.abs(click.y! - box.cy)}`);
      assert.deepEqual(p.position, { x: box.cx, y: box.cy }, "engine não guardou a posição do cursor");
      // O evento do contrato foi emitido pelo hook.
      assert.ok(r.events.some((e) => e.event === "mouse.clicked"), "hook não recebeu mouse.clicked");
      assert.ok(r.events.some((e) => e.event === "mouse.moved"), "hook não recebeu mouse.moved");
    });
  }

  it("controle negativo: clique sintetizado por JS chega isTrusted=false", async (t) => {
    // Sem isto, todo `isTrusted === true` acima seria decorativo.
    const r = await rig();
    t.after(() => r.close());
    await r.page.evaluate(() => document.getElementById("hit")!.click());
    const log = await r.log();
    const click = log.find((e) => e.type === "click" && e.target === "hit");
    assert.ok(click, "clique sintético não registrado");
    assert.equal(click.isTrusted, false, "isTrusted nunca vale false — discriminador é vácuo");
  });

  for (const backend of ["cdp", "playwright"] as const) {
    it(`drag via ${backend} produz mousedown → mousemove(s) → mouseup nessa ordem`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const box = await r.rect("#drag");
      const p = pointer(r, backend, { steps: 8 });
      const from = { x: box.x + 40, y: box.cy };
      const to = { x: box.x + box.width - 40, y: box.cy };

      await r.page.evaluate(() => (globalThis as unknown as { __nomosReset: () => void }).__nomosReset());
      const res = await p.drag(from, to);

      await r.page.waitForFunction(
        () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "mouseup" && e.target === "drag"),
        null,
        { timeout: 5000 },
      );
      const log = (await r.log()).filter((e) => e.target === "drag");
      const down = log.find((e) => e.type === "mousedown");
      const up = log.find((e) => e.type === "mouseup");
      assert.ok(down, "sem mousedown em #drag");
      assert.ok(up, "sem mouseup em #drag");
      const moves = log.filter((e) => e.type === "mousemove" && e.seq > down.seq && e.seq < up.seq);
      assert.ok(moves.length >= 2, `esperado >=2 mousemove entre down e up, veio ${moves.length}`);
      assert.ok(down.seq < moves[0]!.seq, "mousedown não veio antes do primeiro mousemove");
      assert.ok(moves[moves.length - 1]!.seq < up.seq, "último mousemove não veio antes do mouseup");
      assert.equal(down.isTrusted, true);
      assert.equal(up.isTrusted, true);
      // Chegou onde foi mandado.
      assert.ok(Math.abs(up.x! - to.x) <= 1, `mouseup em x=${up.x}, esperado ${to.x}`);
      assert.equal(res.action, "drag");
      assert.equal(res.backend, backend);
      assert.deepEqual(res.from, from);
      assert.deepEqual(res.to, to);
      assert.ok(res.steps >= 2);
      assert.ok(r.events.some((e) => e.event === "mouse.dragged"), "hook não recebeu mouse.dragged");
    });
  }

  for (const backend of ["cdp", "playwright"] as const) {
    it(`scroll via ${backend} altera scrollTop do contêiner`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const box = await r.rect("#scroller");
      const p = pointer(r, backend);

      const before = await r.page.evaluate(() => document.getElementById("scroller")!.scrollTop);
      assert.equal(before, 0, "contêiner já começava rolado");

      const res = await p.scroll({ dy: 300 }, { at: { x: box.cx, y: box.cy } });

      await r.page.waitForFunction(() => document.getElementById("scroller")!.scrollTop > 0, null, { timeout: 5000 });
      const afterTop = await r.page.evaluate(() => document.getElementById("scroller")!.scrollTop);
      assert.ok(afterTop > 0, `scrollTop continuou ${afterTop}`);
      assert.equal(res.action, "scroll");
      assert.equal(res.backend, backend);
      assert.deepEqual(res.delta, { dx: 0, dy: 300 });
      assert.ok(r.events.some((e) => e.event === "mouse.scrolled"), "hook não recebeu mouse.scrolled");
    });
  }

  it("doubleClick gera dblclick e rightClick gera contextmenu (backend cdp)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const box = await r.rect("#hit");
    const p = pointer(r, "cdp");

    await p.doubleClick({ x: box.cx, y: box.cy });
    await r.page.waitForFunction(
      () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "dblclick"),
      null,
      { timeout: 5000 },
    );
    await p.rightClick({ x: box.cx, y: box.cy });
    await r.page.waitForFunction(
      () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "contextmenu"),
      null,
      { timeout: 5000 },
    );

    const log = await r.log();
    const dbl = log.find((e) => e.type === "dblclick");
    const ctx = log.find((e) => e.type === "contextmenu");
    assert.ok(dbl && dbl.isTrusted === true, "dblclick ausente ou não confiável");
    assert.ok(ctx && ctx.isTrusted === true, "contextmenu ausente ou não confiável");
    assert.equal(ctx.button, 2, "contextmenu não veio do botão direito");
  });

  it("hover posiciona o cursor sobre o elemento (mouseover real)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const box = await r.rect("#hover-zone");
    const p = pointer(r, "cdp");
    const res = await p.hover({ x: box.cx, y: box.cy });
    await r.page.waitForFunction(
      () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "mouseover" && e.target === "hover-zone"),
      null,
      { timeout: 5000 },
    );
    const over = (await r.log()).find((e) => e.type === "mouseover" && e.target === "hover-zone");
    assert.ok(over && over.isTrusted === true);
    assert.equal(res.action, "hover");
    assert.deepEqual(p.position, { x: box.cx, y: box.cy });
  });

  it("movimento humanizado emite posições intermediárias (FASE 31 precisa delas)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const p = pointer(r, "cdp", { human_steps: 10 });
    const res = await p.move({ x: 500, y: 400 }, { humanize: true, curve: 20 });
    const moved = r.events.filter((e) => e.event === "mouse.moved");
    assert.equal(res.steps, 10);
    assert.equal(moved.length, 10, `esperados 10 mouse.moved, vieram ${moved.length}`);
    const first = moved[0]!.payload as { x: number; y: number };
    assert.ok(first.x !== 500 || first.y !== 400, "primeiro passo já estava no destino: houve teleporte");
    assert.deepEqual(p.position, { x: 500, y: 400 }, "aterrissagem não foi exata");
  });

  it("interpolatePath: 1 passo é teleporte, N passos aterrissam exatamente no alvo", () => {
    assert.deepEqual(interpolatePath({ x: 0, y: 0 }, { x: 10, y: 20 }, 1), [{ x: 10, y: 20 }]);
    const path = interpolatePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 5, 12);
    assert.equal(path.length, 5);
    assert.deepEqual(path[4], { x: 100, y: 0 });
    assert.ok(Math.abs(path[2]!.y) > 1, "curvatura pedida não produziu desvio perpendicular");
  });

  it("mouseDown/mouseUp compõem um drag manual sem perder o botão segurado", async (t) => {
    // mouseDown/mouseUp existem para o chamador compor gestos. Se um `move`
    // intermediário zerasse a máscara de botão, o mousemove chegaria à página
    // com buttons=0 e o site trataria como hover, não como arraste.
    const r = await rig();
    t.after(() => r.close());
    const box = await r.rect("#drag");
    const p = pointer(r, "cdp", { steps: 4 });

    await p.mouseDown({ x: box.x + 40, y: box.cy });
    assert.deepEqual(p.pressedButtons, ["left"], "botão não ficou registrado como pressionado");
    await p.move({ x: box.x + 200, y: box.cy });
    assert.deepEqual(p.pressedButtons, ["left"], "move avulso perdeu o botão segurado");
    await p.mouseUp({ x: box.x + 300, y: box.cy });
    assert.deepEqual(p.pressedButtons, [], "mouseUp não soltou o botão");

    const log = (await r.log()).filter((e) => e.target === "drag");
    const down = log.find((e) => e.type === "mousedown");
    const up = log.find((e) => e.type === "mouseup");
    assert.ok(down && up && down.seq < up.seq);
    const moves = log.filter((e) => e.type === "mousemove" && e.seq > down.seq && e.seq < up.seq);
    assert.ok(moves.length >= 2, `esperados mousemove entre down e up, veio ${moves.length}`);
  });

  it("coordenada não-finita é rejeitada (fail closed, não NaN silencioso)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const p = pointer(r, "cdp");
    await assert.rejects(
      () => p.move({ x: Number.NaN, y: 10 }),
      (err: unknown) => err instanceof InputError && err.code === "INVALID_REQUEST",
    );
  });
});

describe("PointerEngine — fallback de backend", () => {
  it("fallback registra no resultado qual backend agiu e por quê", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const box = await r.rect("#hit");
    // CDP quebrado de propósito: força a troca para playwright.
    const brokenCdp = {
      send: async () => {
        throw new Error("cdp fora do ar (injetado pelo teste)");
      },
    } as unknown as CDPSession;
    const p = new PointerEngine({
      page: r.page,
      cdp: brokenCdp,
      backend: "cdp",
      fallback: "playwright",
      onEvent: (e) => r.events.push(e),
    });

    const res = await p.click({ x: box.cx, y: box.cy });

    assert.equal(res.requested_backend, "cdp");
    assert.equal(res.backend, "playwright", "não registrou o backend que realmente agiu");
    assert.equal(res.fallback_used, true);
    assert.match(res.fallback_reason ?? "", /cdp fora do ar/, "motivo do fallback não foi propagado");

    const click = (await r.log()).find((e) => e.type === "click" && e.target === "hit");
    assert.ok(click && click.isTrusted === true, "fallback não produziu clique real");
  });

  it('fallback:"none" falha fechado com InputError tipado', async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const brokenCdp = {
      send: async () => {
        throw new Error("cdp fora do ar (injetado pelo teste)");
      },
    } as unknown as CDPSession;
    const p = new PointerEngine({ page: r.page, cdp: brokenCdp, backend: "cdp", fallback: "none" });
    await assert.rejects(
      () => p.click({ x: 10, y: 10 }),
      (err: unknown) => err instanceof InputError && err.code === "INTERNAL" && /cdp fora do ar/.test(err.message),
    );
  });
});

describe("KeyboardEngine", () => {
  for (const backend of ["cdp", "playwright"] as const) {
    it(`hotkey CMD+A via ${backend} seleciona todo o texto do input`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const k = keyboard(r, backend);
      await r.page.locator("#sel").focus();
      // Cursor no fim: se a seleção já fosse total, o teste não provaria nada.
      await r.page.evaluate(() => {
        const el = document.getElementById("sel") as HTMLInputElement;
        el.setSelectionRange(el.value.length, el.value.length);
      });
      const antes = await r.page.evaluate(
        () => (globalThis as unknown as { __nomosSelection: (s: string) => unknown }).__nomosSelection("#sel"),
      );
      assert.deepEqual(antes, { start: 36, end: 36, length: 36 }, "estado inicial de seleção inesperado");

      const res = await k.hotkey(["Meta", "a"]);

      const sel = (await r.page.evaluate(
        () => (globalThis as unknown as { __nomosSelection: (s: string) => unknown }).__nomosSelection("#sel"),
      )) as { start: number; end: number; length: number };
      assert.equal(sel.start, 0, "selectionStart não foi para 0");
      assert.equal(sel.end, sel.length, "selectionEnd não chegou ao fim do valor");
      assert.ok(sel.length > 0);
      assert.equal(res.backend, backend);
      assert.deepEqual(res.keys, ["Meta", "a"]);
      // A página tem de ter visto a tecla com metaKey ligada.
      const kd = (await r.log()).find((e) => e.type === "keydown" && e.key === "a");
      assert.ok(kd, "keydown de 'a' não chegou à página");
      assert.equal(kd.isTrusted, true);
      assert.equal(kd.meta, true, "keydown chegou sem metaKey");
      assert.equal(kd.code, "KeyA", "code não foi mapeado");
      assert.ok(r.events.some((e) => e.event === "keyboard.pressed"), "hook não recebeu keyboard.pressed");
    });
  }

  for (const backend of ["cdp", "playwright"] as const) {
    it(`press("Enter") via ${backend} dispara submit do form`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const k = keyboard(r, backend);
      await r.page.locator("#form-input").focus();
      await k.type("valor");
      await r.page.evaluate(() => (globalThis as unknown as { __nomosReset: () => void }).__nomosReset());

      const res = await k.press("Enter");

      await r.page.waitForFunction(
        () => (globalThis as unknown as { __nomos: Rec[] }).__nomos.some((e) => e.type === "submit"),
        null,
        { timeout: 5000 },
      );
      const log = await r.log();
      const submit = log.find((e) => e.type === "submit");
      assert.ok(submit, "form não submeteu");
      assert.equal(submit.isTrusted, true, "submit não foi consequência de input real");
      assert.equal(res.action, "press");
      assert.deepEqual(res.keys, ["Enter"]);
      assert.equal(res.backend, backend);
      const kd = log.find((e) => e.type === "keydown" && e.key === "Enter");
      assert.ok(kd && kd.code === "Enter" && kd.isTrusted === true);
    });
  }

  for (const backend of ["cdp", "playwright"] as const) {
    it(`type() via ${backend} digita com eventos reais e NÃO devolve o texto`, async (t) => {
      const r = await rig();
      t.after(() => r.close());
      const k = keyboard(r, backend);
      await r.page.locator("#typed").focus();
      const secret = "NOMOS-7 br@wser_Key!";

      const res = await k.type(secret);

      const value = await r.page.evaluate(
        () => (globalThis as unknown as { __nomosValue: (s: string) => string | null }).__nomosValue("#typed"),
      );
      assert.equal(value, secret, "texto digitado não chegou ao input");
      assert.equal(res.text_length, secret.length);
      assert.equal(res.keys.length, 0);
      // Nada do texto pode vazar no resultado nem no evento (pode ser credencial).
      const asJson = JSON.stringify({ res, events: r.events });
      assert.ok(!asJson.includes("br@wser_Key"), "texto digitado vazou em resultado/evento");
      const typedEvent = r.events.find((e) => e.event === "keyboard.typed");
      assert.ok(typedEvent, "hook não recebeu keyboard.typed");
      assert.equal((typedEvent.payload as { length: number }).length, secret.length);
      const kd = (await r.log()).find((e) => e.type === "keydown" && e.key === "N");
      assert.ok(kd && kd.isTrusted === true && kd.shift === true, "maiúscula não veio com Shift real");
    });
  }

  it("teclas nomeadas: Backspace, Tab, Escape e setas aplicam efeito real (cdp)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const k = keyboard(r, "cdp");
    await r.page.locator("#typed").focus();
    await k.type("abcd");
    await k.press("Backspace");
    assert.equal(
      await r.page.evaluate(() => (globalThis as unknown as { __nomosValue: (s: string) => string }).__nomosValue("#typed")),
      "abc",
      "Backspace não apagou",
    );
    await k.press("ArrowLeft");
    await k.type("X");
    assert.equal(
      await r.page.evaluate(() => (globalThis as unknown as { __nomosValue: (s: string) => string }).__nomosValue("#typed")),
      "abXc",
      "ArrowLeft não moveu o caret",
    );
    await k.press("Escape");
    await k.press("Tab");
    const log = await r.log();
    for (const key of ["Backspace", "ArrowLeft", "Escape", "Tab"]) {
      const ev = log.find((e) => e.type === "keydown" && e.key === key);
      assert.ok(ev, `keydown ${key} não chegou`);
      assert.equal(ev.isTrusted, true, `${key} não é input real`);
      assert.equal(ev.code, key, `${key} chegou com code errado: ${ev.code}`);
    }
    const focused = await r.page.evaluate(() => document.activeElement?.id ?? "");
    assert.notEqual(focused, "typed", "Tab não moveu o foco para fora de #typed");
  });

  it("down/up mantêm estado de modificador e releaseAll limpa (cdp)", async (t) => {
    const r = await rig();
    t.after(() => r.close());
    const k = keyboard(r, "cdp");
    await r.page.locator("#typed").focus();
    await k.down("Shift");
    assert.deepEqual(k.heldKeys, ["Shift"]);
    assert.equal(k.modifiers, 8);
    await k.press("a");
    const kd = (await r.log()).find((e) => e.type === "keydown" && e.key === "a");
    assert.ok(kd && kd.shift === true, "Shift segurado não apareceu no keydown da página");
    const released = await k.releaseAll();
    assert.deepEqual(released, ["Shift"]);
    assert.equal(k.modifiers, 0);
    assert.deepEqual(k.heldKeys, []);
  });

  it("mapeamento de tecla é explícito e tecla desconhecida falha fechado", () => {
    assert.deepEqual(describeKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", location: 0, modifier: 0, shift: false });
    assert.deepEqual(describeKey("cmd"), { key: "Meta", code: "MetaLeft", keyCode: 91, text: null, location: 1, modifier: 4, shift: false });
    assert.equal(describeKey("a").code, "KeyA");
    assert.equal(describeKey("A").shift, true);
    assert.equal(describeKey("7").code, "Digit7");
    assert.equal(describeKey("!").code, "Digit1");
    assert.equal(describeKey("!").shift, true);
    assert.throws(
      () => describeKey("TeclaQueNaoExiste"),
      (err: unknown) => err instanceof InputError && err.code === "INVALID_REQUEST",
    );
  });

  it("controle: sem `commands` nativos, CMD+A chega à página e NÃO seleciona nada", async (t) => {
    // Este é o controle que dá sentido ao teste de CMD+A: se desligar os
    // comandos de edição do macOS ainda selecionasse tudo, o campo `commands`
    // seria decorativo e a afirmação sobre ele seria falsa. Ele não é.
    const r = await rig();
    t.after(() => r.close());
    const k = keyboard(r, "cdp", { mac_editing_commands: false });
    await r.page.locator("#sel").focus();
    await r.page.evaluate(() => {
      const el = document.getElementById("sel") as HTMLInputElement;
      el.setSelectionRange(el.value.length, el.value.length);
    });

    const res = await k.hotkey(["Meta", "a"]);

    assert.deepEqual(res.editing_commands, [], "comandos deveriam estar desligados");
    const sel = (await r.page.evaluate(
      () => (globalThis as unknown as { __nomosSelection: (s: string) => unknown }).__nomosSelection("#sel"),
    )) as { start: number; end: number; length: number };
    assert.equal(sel.start, sel.length, "selecionou sem os comandos nativos: o teste de CMD+A seria vácuo");
    // ...mas o atalho CHEGOU à página. Falha silenciosa, não ausência de input.
    const kd = (await r.log()).find((e) => e.type === "keydown" && e.key === "a");
    assert.ok(kd && kd.meta === true && kd.isTrusted === true, "atalho nem chegou à página");
  });

  it("comandos nativos de edição do macOS são resolvidos para o combo certo", () => {
    assert.deepEqual(macEditingCommands(4, "a"), ["selectAll"]);
    assert.deepEqual(macEditingCommands(4, "c"), ["copy"]);
    assert.deepEqual(macEditingCommands(4, "v"), ["paste"]);
    assert.deepEqual(macEditingCommands(12, "z"), ["redo"]);
    assert.deepEqual(macEditingCommands(0, "a"), [], "sem modificador não há comando de edição");
    assert.deepEqual(macEditingCommands(4, "q"), [], "combo sem comando conhecido devolve vazio");
  });
});
