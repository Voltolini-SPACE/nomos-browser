/**
 * FASE 4 — O CLIQUE CHEGOU? (daemon REAL + Chromium REAL)
 *
 * O DEFEITO MEDIDO QUE ORIGINOU ESTE ARQUIVO
 * ------------------------------------------
 *   evidence/.../03-vision/out/scroll-e-clique-vazio.json
 *     { "a5_box": {"x":600,"y":900,...}, "a5_fora_do_viewport": true,
 *       "a5_click_success": true, "a5_recebeu_evento": false }
 *
 * Viewport 1280x800, alvo em y=900. HTTP 200, `success:true`, sem erro — e o
 * elemento nao recebeu clique nenhum. `success` afirmava o DESPACHO, nao a
 * CHEGADA.
 *
 * DUAS DECISOES DE INSTRUMENTO, PORQUE INSTRUMENTO RUIM JA MENTIU AQUI
 * --------------------------------------------------------------------
 *  1. UM <div> DEDICADO POR ALVO (`#rec-<id>`). A validacao anterior usou um
 *     log compartilhado: um clique no elemento ERRADO escrevia no mesmo lugar e
 *     passava por acerto. Aqui, se o clique for para outro lugar, o div do alvo
 *     continua VAZIO e o teste falha.
 *
 *  2. O ERRO DE COORDENADA E MEDIDO CONTRA A VERDADE DA PAGINA, nao contra o
 *     que o runtime relatou. O handler da fixture grava `e.clientX/clientY` e o
 *     `getBoundingClientRect()` do alvo NO INSTANTE DO CLIQUE. Comparar o
 *     relatorio do runtime com ele mesmo nao mede nada.
 *
 * DOIS CONTROLES NEGATIVOS, PARA O ARQUIVO NAO PASSAR POR VACUO
 * -------------------------------------------------------------
 *  - DO TESTE (n. 9): alvo trivial dentro do viewport tem de passar. Se ele
 *    falhasse, os "recusou corretamente" poderiam ser um runtime que recusa tudo.
 *  - DO PRODUTO (n. 10): a MESMA fixture que o runtime recusa por
 *    CLICK_NOT_DELIVERED vira `success:true` num daemon com
 *    `click_delivery_check:false`. E isso que prova que quem pega o caso e a
 *    verificacao de entrega, e nao sorte.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { startDaemon } from "../packages/api/src/daemon.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — uma por cenario, para a falha apontar o cenario e nao "a pagina"
// ─────────────────────────────────────────────────────────────────────────────

/** `extra` roda DEPOIS de os gravadores existirem: um script que remove o alvo
 *  nao corre contra o registro. */
function pagina(corpo: string, extra = ""): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>alvo</title>
<style>
 html,body{margin:0;padding:0}
 body{font:14px system-ui;background:#fff}
 .alvo{position:absolute;background:rgb(20,120,220);color:#fff;border:0;padding:0}
 .rec{position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden}
</style></head><body>
${corpo}
<script>
(function(){
  var alvos = document.querySelectorAll('button.alvo');
  for (var i = 0; i < alvos.length; i++) {
    (function(b){
      var d = document.createElement('div');
      d.className = 'rec'; d.id = 'rec-' + b.id; d.textContent = '';
      document.body.appendChild(d);
      b.addEventListener('click', function(e){
        var r = b.getBoundingClientRect();
        var cab = document.getElementById('cabecalho');
        d.textContent = JSON.stringify({
          id: b.id, clientX: e.clientX, clientY: e.clientY, isTrusted: e.isTrusted,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          scrollY: Math.round(window.scrollY), scrollX: Math.round(window.scrollX),
          dpr: window.devicePixelRatio, vw: document.documentElement.clientWidth,
          vh: document.documentElement.clientHeight,
          cab: cab === null ? null : Math.round(cab.getBoundingClientRect().bottom)
        });
      });
    })(alvos[i]);
  }
})();
${extra}
</script></body></html>`;
}

const BOTAO = (topo: number, esquerda = 300): string =>
  `<button class="alvo" id="alvo" style="left:${esquerda}px;top:${topo}px;width:160px;height:60px">ALVO</button>`;
const ALTURA = (px: number): string => `<div style="height:${px}px"></div>`;

const FIXTURES: Readonly<Record<string, string>> = Object.freeze({
  // 9. controle negativo do teste — alvo trivialmente acionavel.
  "/normal": pagina(`${BOTAO(200)}${ALTURA(1000)}`),

  // 1. acima do viewport (o teste rola para baixo antes).
  "/acima": pagina(`${BOTAO(200)}${ALTURA(3000)}`),

  // 2. abaixo do viewport.
  "/abaixo": pagina(`${BOTAO(2200)}${ALTURA(3000)}`),

  // 3. fora HORIZONTALMENTE, dentro de um conteiner com rolagem lateral.
  "/horizontal": pagina(
    `<div id="faixa" style="position:absolute;left:40px;top:300px;width:400px;height:120px;overflow-x:auto;overflow-y:hidden">
       <div style="position:relative;width:3000px;height:100px">
         <button class="alvo" id="alvo" style="left:2400px;top:20px;width:160px;height:60px">ALVO</button>
       </div>
     </div>${ALTURA(900)}`,
  ),

  // 4. header GRUDADO que cobre o topo do viewport durante o scroll.
  "/sticky": pagina(
    `<header id="cabecalho" style="position:sticky;top:0;height:140px;background:#222;color:#fff;z-index:50">CABECALHO</header>
     <div style="position:relative;height:3000px">${BOTAO(1800)}</div>`,
  ),

  // 5. coberto por overlay fixo.
  "/overlay": pagina(
    `${BOTAO(200)}<div id="capa" style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.2)"></div>${ALTURA(900)}`,
  ),

  // 6. removido do DOM DURANTE a rolagem. O gatilho e o evento `scroll` real
  //    que a rolagem do runtime produz — deterministico, nao temporizado.
  "/some": pagina(
    `${BOTAO(2200)}${ALTURA(3000)}`,
    `window.addEventListener('scroll', function(){ var a = document.getElementById('alvo'); if (a !== null) a.remove(); }, { once: true });`,
  ),

  // 7a. SPA que NUNCA para de mover o alvo. Oscila DENTRO do viewport, para que
  //     a recusa seja "nao assentou" e nao "fora do viewport".
  "/spa-eterno": pagina(
    `${BOTAO(300)}${ALTURA(900)}`,
    `var i = 0; setInterval(function(){ i++; var a = document.getElementById('alvo');
       if (a !== null) a.style.top = (300 + (i % 30) * 9) + 'px'; }, 37);`,
  ),

  // 7b. SPA que move e ASSENTA. Periodo 40ms para nao sincronizar com o
  //     amostrador de 50ms e virar aliasing.
  "/spa-assenta": pagina(
    `${BOTAO(200)}${ALTURA(900)}`,
    `var n = 0; var h = setInterval(function(){ n++; var a = document.getElementById('alvo');
       if (a !== null) a.style.top = (200 + n * 20) + 'px';
       if (n >= 8) clearInterval(h); }, 40);`,
  ),

  // 10b. O alvo se remove no PRIMEIRO mousemove — ou seja, DEPOIS de a
  //      acionabilidade ter aprovado e ANTES de o botao descer. Nenhuma checagem
  //      estatica pega isto; so a prova de que o evento chegou.
  "/some-no-mousemove": pagina(
    `${BOTAO(200)}${ALTURA(900)}`,
    `document.addEventListener('mousemove', function(){ var a = document.getElementById('alvo'); if (a !== null) a.remove(); }, { once: true });`,
  ),

  // 10a. area comprovadamente vazia.
  "/vazio": pagina(`${ALTURA(1000)}`),

  // ── FASE 4b — navegacao como evidencia ────────────────────────────────────
  // Nenhum destes tem `class="alvo"`: o gravador da fixture so cobre botoes, e
  // um gravador destruido pela navegacao nao provaria nada mesmo. A prova aqui e
  // o CONTEUDO DA PAGINA DE DESTINO, lido depois — verdade da pagina, nao
  // relatorio do runtime.
  "/link": pagina(`<p><a id="alvo" href="/destino">ir para o destino</a></p>${ALTURA(600)}`),
  "/destino": pagina(`<h1 id="marca">DESTINO-4B</h1>${ALTURA(400)}`),
  "/ancora": pagina(`<p><a id="alvo" href="#fim">ir para a ancora</a></p>${ALTURA(1600)}<h2 id="fim">fim</h2>`),
  "/blank": pagina(`<p><a id="alvo" href="/destino" target="_blank">abrir em nova aba</a></p>${ALTURA(600)}`),
  "/assign": pagina(
    `${BOTAO(200)}${ALTURA(600)}`,
    `document.getElementById('alvo').addEventListener('click', function(){ location.assign('/destino'); });`,
  ),
  "/link-coberto": pagina(
    `<p><a id="alvo" href="/destino">ir para o destino</a></p><div id="capa" style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.2)"></div>${ALTURA(600)}`,
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Infra
// ─────────────────────────────────────────────────────────────────────────────

interface Daemon {
  base: string;
  token: string | null;
  sid: string;
  raiz: string;
  fechar: () => Promise<void>;
}

let servidor: http.Server;
let FIX = "";
let principal: Daemon;
let dpr2: Daemon;
let semChecagem: Daemon;

async function subir(rotulo: string, over: Record<string, unknown>): Promise<Daemon> {
  const raiz = await mkdtemp(path.join(os.tmpdir(), `nomos-clique-${rotulo}-`));
  const d = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: raiz,
    ...over,
  } as never);
  const base = `http://127.0.0.1:${d.port}`;
  const token = (d as unknown as { token: string | null }).token;
  const r = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ owner: "NOMOS", profile: "sandbox" }),
  });
  const corpo = (await r.json()) as { session_id?: string };
  assert.ok(corpo.session_id, `sessao sem id em ${rotulo}: ${JSON.stringify(corpo)}`);
  return { base, token, sid: corpo.session_id, raiz, fechar: () => d.close() };
}

before(async () => {
  servidor = http.createServer((req, res) => {
    const rota = (req.url ?? "/").split("?")[0]!;
    const html = Object.hasOwn(FIXTURES, rota) ? FIXTURES[rota]! : pagina("<p>404</p>");
    res.writeHead(Object.hasOwn(FIXTURES, rota) ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const addr = servidor.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  FIX = `http://127.0.0.1:${addr.port}`;

  principal = await subir("principal", {});
  // 8. DPR 2 de verdade — nao simulado, nao afirmado.
  dpr2 = await subir("dpr2", { device_scale_factor: 2 });
  // 10. controle negativo DO PRODUTO: a defesa desligada por configuracao.
  //     Nao existe chave de corpo para desligar isto por chamada, de proposito:
  //     um cliente nao pode desarmar a prova de entrega pedindo bonitinho.
  semChecagem = await subir("sem-checagem", { click_delivery_check: false });
});

after(async () => {
  for (const d of [principal, dpr2, semChecagem]) {
    if (d === undefined) continue;
    await d.fechar().catch(() => undefined);
    await rm(d.raiz, { recursive: true, force: true }).catch(() => undefined);
  }
  await new Promise<void>((r) => servidor?.close(() => r()));
});

interface Envelope {
  success: boolean;
  result: any;
  error: { code: string; message: string; detail?: any } | null;
}

async function acao(
  d: Daemon,
  tool: string,
  corpo: Record<string, unknown>,
): Promise<{ status: number; env: Envelope }> {
  const r = await fetch(`${d.base}/api/v1/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(d.token !== null ? { authorization: `Bearer ${d.token}` } : {}) },
    body: JSON.stringify({ session_id: d.sid, ...corpo }),
  });
  return { status: r.status, env: (await r.json()) as Envelope };
}

async function abrir(d: Daemon, rota: string): Promise<void> {
  const r = await acao(d, "browser.goto", { url: `${FIX}${rota}` });
  assert.equal(r.env.success, true, `goto ${rota}: ${JSON.stringify(r.env.error)}`);
}

interface Registro {
  id: string;
  clientX: number;
  clientY: number;
  isTrusted: boolean;
  rect: { x: number; y: number; w: number; h: number };
  scrollY: number;
  scrollX: number;
  dpr: number;
  vw: number;
  vh: number;
  cab: number | null;
}

/** Le o div DEDICADO do alvo. `null` = nenhum clique chegou a ele. */
async function registro(d: Daemon, id = "alvo"): Promise<Registro | null> {
  const r = await acao(d, "browser.extract", { target: { selector: `#rec-${id}` } });
  const bruto = String(r.env.result?.content ?? "").trim();
  if (bruto === "") return null;
  try {
    return JSON.parse(bruto) as Registro;
  } catch {
    return null;
  }
}

/**
 * Erro de mira em px, medido contra a caixa que a PAGINA viu no instante do
 * clique. Independente de tudo que o runtime relatou.
 */
function erroPx(reg: Registro): number {
  const cx = reg.rect.x + reg.rect.w / 2;
  const cy = reg.rect.y + reg.rect.h / 2;
  return Number(Math.hypot(reg.clientX - cx, reg.clientY - cy).toFixed(3));
}

/** Toda entrega comprovada tem de ser input REAL e mira exata. */
function entregaBemFormada(env: Envelope, reg: Registro | null, onde: string): void {
  assert.equal(env.success, true, `${onde}: ${JSON.stringify(env.error)}`);
  assert.equal(env.result.detail.actionable, true, `${onde}: actionable`);
  assert.equal(env.result.detail.delivery_checked, true, `${onde}: a checagem tem de estar ligada`);
  assert.equal(env.result.detail.delivery_verified, true, `${onde}: delivery_verified`);
  assert.equal(env.result.detail.is_trusted, true, `${onde}: isTrusted no registro do runtime`);
  assert.ok(reg !== null, `${onde}: o div DEDICADO do alvo ficou vazio — o clique foi para outro lugar`);
  assert.equal(reg.isTrusted, true, `${onde}: isTrusted no evento da propria pagina`);
  assert.equal(erroPx(reg), 0, `${onde}: erro de mira ${erroPx(reg)}px`);
}

async function trilha(d: Daemon): Promise<Record<string, any>[]> {
  const cru = await readFile(path.join(d.raiz, d.sid, "actions.jsonl"), "utf8").catch(() => "");
  return cru
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, any>);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CONTROLE NEGATIVO DO TESTE — vem primeiro de proposito
// ─────────────────────────────────────────────────────────────────────────────

test("9. controle negativo do teste: alvo trivial dentro do viewport passa", async () => {
  await abrir(principal, "/normal");
  assert.equal(await registro(principal), null, "o gravador tem de comecar VAZIO");

  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "normal");
  assert.deepEqual(c.env.result.detail.scrolled, { dx: 0, dy: 0 }, "alvo ja visivel nao deveria rolar nada");
  assert.equal(c.env.result.detail.backend, "none", "sem rolagem, nenhum backend agiu");
  assert.equal(c.env.result.detail.elemento_no_ponto, "button#alvo.alvo");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1–2. Fora do viewport na vertical
// ─────────────────────────────────────────────────────────────────────────────

test("1. alvo ACIMA do viewport: rola de volta, clica, erro 0px", async () => {
  await abrir(principal, "/acima");
  const s = await acao(principal, "browser.scroll", { dy: 2000 });
  assert.equal(s.env.success, true, JSON.stringify(s.env.error));

  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "acima");

  const d = c.env.result.detail;
  assert.ok(d.box_antes.y < 0, `alvo tinha de estar ACIMA do viewport (y=${d.box_antes.y})`);
  assert.ok(d.scrolled.dy < 0, `rolagem tinha de ser para CIMA (dy=${d.scrolled.dy})`);
  assert.equal(d.dentro_do_viewport, true);
  assert.ok(d.box_depois.y >= 0 && d.box_depois.y < reg!.vh, "caixa remedida tem de estar visivel");
});

test("2. alvo ABAIXO do viewport: rola e clica, erro 0px", async () => {
  await abrir(principal, "/abaixo");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "abaixo");

  const d = c.env.result.detail;
  assert.ok(d.box_antes.y > reg!.vh, `alvo tinha de estar ABAIXO do viewport (y=${d.box_antes.y})`);
  assert.ok(d.scrolled.dy > 0, `rolagem tinha de ser para BAIXO (dy=${d.scrolled.dy})`);
  assert.ok(reg!.scrollY > 0, "a pagina tinha de ter rolado de verdade");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fora na horizontal, em conteiner com rolagem lateral
// ─────────────────────────────────────────────────────────────────────────────

test("3. fora HORIZONTALMENTE em conteiner lateral: o correto e CLICAR, nao recusar", async () => {
  // COMPORTAMENTO CORRETO DECLARADO: clicar.
  //
  // Um humano diante desse conteiner rola a faixa e clica — o alvo e alcancavel
  // sem mudar nada na pagina. Recusar seria inventar fracasso: o runtime teria
  // desistido de algo que tinha como fazer. A recusa fica reservada para o que e
  // REALMENTE inalcancavel (coberto, removido, em movimento perpetuo), e os
  // testes 5/6/7a provam que ela continua acontecendo la.
  await abrir(principal, "/horizontal");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "horizontal");

  const d = c.env.result.detail;
  assert.ok(d.box_antes.x > reg!.vw, `alvo tinha de comecar fora a direita (x=${d.box_antes.x})`);
  assert.ok(d.box_depois.x < reg!.vw, `alvo tinha de terminar dentro (x=${d.box_depois.x})`);
  assert.notEqual(d.backend, "none", "algum backend tinha de ter rolado");
  // A JANELA nao rolou: quem rolou foi o conteiner. E por isso que `scrolled`
  // (deslocamento da janela) pode ser 0 enquanto box_antes != box_depois.
  assert.equal(reg!.scrollX, 0, "a janela nao deveria ter rolado lateralmente");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Header grudado
// ─────────────────────────────────────────────────────────────────────────────

test("4. header GRUDADO: rola o suficiente para descobrir e clica", async () => {
  // O QUE ACONTECE, PROVADO: o runtime CENTRALIZA o alvo em vez de rolar o
  // minimo. Rolar o minimo deixaria o alvo colado no topo — exatamente sob o
  // header grudado — e produziria TARGET_NOT_ACTIONABLE por cobertura. Ao
  // centralizar, o alvo aterrissa longe do header e o clique chega.
  await abrir(principal, "/sticky");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "sticky");

  assert.ok(reg!.cab !== null && reg!.cab > 0, "o header tinha de estar grudado no topo no instante do clique");
  assert.ok(
    reg!.clientY > reg!.cab!,
    `o clique (y=${reg!.clientY}) tinha de cair ABAIXO da borda do header (y=${reg!.cab})`,
  );
  assert.equal(c.env.result.detail.elemento_no_ponto, "button#alvo.alvo", "o header nao podia estar no ponto");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–6. Recusas
// ─────────────────────────────────────────────────────────────────────────────

test("5. coberto por overlay fixo: TARGET_NOT_ACTIONABLE e o overlay e nomeado", async () => {
  await abrir(principal, "/overlay");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, false, "clique sob overlay nao pode dar sucesso");
  assert.equal(c.status, 409, "TARGET_NOT_ACTIONABLE e 409");
  assert.equal(c.env.error!.code, "TARGET_NOT_ACTIONABLE");
  const d = c.env.error!.detail;
  assert.equal(d.elemento_no_ponto, "div#capa", `elemento_no_ponto=${d.elemento_no_ponto}`);
  assert.equal(d.actionable, false);
  assert.equal(d.dentro_do_viewport, true, "estava visivel — o problema e cobertura, nao posicao");
  assert.match(String(d.motivo), /coberto/);
  assert.equal(await registro(principal), null, "nenhum clique podia ter chegado ao alvo");
});

test("6. removido do DOM DURANTE a rolagem: TARGET_NOT_ACTIONABLE, nunca sucesso", async () => {
  await abrir(principal, "/some");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, false, "alvo que sumiu nao pode virar sucesso");
  assert.equal(c.status, 409);
  assert.equal(c.env.error!.code, "TARGET_NOT_ACTIONABLE");
  assert.equal(c.env.error!.detail.actionable, false);
  assert.match(String(c.env.error!.detail.motivo), /DOM|assentou/);
  assert.equal(await registro(principal), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. SPA que move o alvo
// ─────────────────────────────────────────────────────────────────────────────

test("7a. SPA em movimento PERPETUO: recusa; nunca clica em coordenada velha", async () => {
  await abrir(principal, "/spa-eterno");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, false, "alvo que nunca para nao pode virar sucesso");
  assert.equal(c.status, 409);
  assert.equal(c.env.error!.code, "TARGET_NOT_ACTIONABLE");
  assert.match(String(c.env.error!.detail.motivo), /assentou|movimento/);
  assert.ok(c.env.error!.detail.amostras_ate_estabilizar >= 3, "o amostrador tinha de ter tentado antes de desistir");
  assert.equal(await registro(principal), null, "nao podia ter clicado em coordenada nenhuma");
});

test("7b. SPA que ASSENTA: espera, remede e acerta com erro 0px", async () => {
  await abrir(principal, "/spa-assenta");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "spa-assenta");
  // Prova de que NAO clicou na coordenada velha: o alvo nasce em top=200 e para
  // em top=360. Erro 0px contra a caixa do instante do clique ja diz isso; a
  // asercao abaixo diz que ele de fato se moveu antes.
  assert.ok(reg!.rect.y >= 360, `alvo tinha de ter terminado o movimento (y=${reg!.rect.y})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DPR > 1
// ─────────────────────────────────────────────────────────────────────────────

test("8. deviceScaleFactor 2: coordenada continua exata", async () => {
  await abrir(dpr2, "/normal");
  const c = await acao(dpr2, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(dpr2);
  entregaBemFormada(c.env, reg, "dpr2");
  assert.equal(reg!.dpr, 2, "a sessao tinha de estar mesmo em DPR 2");
  // A coordenada do runtime e CSS px; o DPR so muda a densidade do bitmap. Se
  // houvesse conversao indevida, o erro seria ~metade ou ~o dobro da caixa.
  assert.equal(erroPx(reg!), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CONTROLE NEGATIVO DO PRODUTO
// ─────────────────────────────────────────────────────────────────────────────

test("10a. click_delivery_check:false — coordenada vazia nao traz prova nenhuma", async () => {
  await abrir(semChecagem, "/vazio");
  const c = await acao(semChecagem, "browser.click", { target: { coordinates: { x: 5, y: 700 } } });

  // A COORDENADA VAZIA E ENTREGA HONESTA: o clique chega ao <body>. Recusa-lo
  // seria inventar fracasso. O que a checagem desligada apaga e a PROVA — e e
  // essa diferenca que este teste fixa.
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  assert.equal(c.env.result.detail.delivery_checked, false);
  assert.equal(c.env.result.detail.delivery_verified, null, "sem checagem nao ha o que afirmar");
  assert.equal(c.env.result.detail.elemento_que_recebeu, null);

  // Com a checagem LIGADA, o mesmo clique volta com prova nomeada.
  await abrir(principal, "/vazio");
  const p = await acao(principal, "browser.click", { target: { coordinates: { x: 5, y: 700 } } });
  assert.equal(p.env.success, true, JSON.stringify(p.env.error));
  assert.equal(p.env.result.detail.delivery_verified, true);
  assert.match(String(p.env.result.detail.elemento_que_recebeu), /^(body|html|div)/);
  assert.equal(p.env.result.detail.is_trusted, true);
});

test("10b. mesma fixture: com checagem = CLICK_NOT_DELIVERED; sem checagem = sucesso falso", async () => {
  await abrir(principal, "/some-no-mousemove");
  const com = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  assert.equal(com.env.success, false, "o clique nao chegou ao alvo e nao pode dar sucesso");
  assert.equal(com.status, 500, "CLICK_NOT_DELIVERED e 500");
  assert.equal(com.env.error!.code, "CLICK_NOT_DELIVERED");
  assert.equal(com.env.error!.detail.actionable, true, "era acionavel quando conferimos — sumiu depois");
  assert.equal(com.env.error!.detail.delivery_verified, false);
  assert.equal(await registro(principal), null);

  await abrir(semChecagem, "/some-no-mousemove");
  const sem = await acao(semChecagem, "browser.click", { target: { selector: "#alvo" } });
  assert.equal(
    sem.env.success,
    true,
    "sem a checagem, o runtime volta a devolver o SUCESSO FALSO — e isso que ela pega",
  );
  assert.equal(sem.env.result.detail.delivery_verified, null);
  assert.equal(await registro(semChecagem), null, "e o alvo continua sem ter recebido nada");
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. isTrusted + auditoria
// ─────────────────────────────────────────────────────────────────────────────

test("11. isTrusted===true em todo clique entregue, e a trilha registra a mira", async () => {
  await abrir(principal, "/abaixo");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  const reg = await registro(principal);
  entregaBemFormada(c.env, reg, "isTrusted");

  const linhas = await trilha(principal);
  const cliques = linhas.filter((l) => l.action === "browser.click" && l.event === "action");
  assert.ok(cliques.length > 0, "a trilha tem de ter linhas de browser.click");

  const okLinha = cliques.filter((l) => l.result === "ok").at(-1);
  assert.ok(okLinha !== undefined, "faltou linha de clique bem-sucedido");
  assert.equal(okLinha.detail.delivery_verified, true, "audit sem delivery_verified");
  assert.equal(okLinha.detail.actionable, true, "audit sem actionable");
  assert.ok(typeof okLinha.detail.stabilized_after === "number", "audit sem stabilized_after");
  assert.ok(okLinha.detail.scrolled !== undefined, "audit sem scrolled");

  // A recusa por MIRA (testes 5/6/7a) carrega `actionable:false`.
  const naoAcionavel = cliques.filter((l) => l.error?.code === "TARGET_NOT_ACTIONABLE").at(-1);
  assert.ok(naoAcionavel !== undefined, "faltou linha de TARGET_NOT_ACTIONABLE na trilha");
  assert.equal(naoAcionavel.detail.actionable, false, "a recusa tambem tem de carregar a mira");
  assert.ok(naoAcionavel.detail.scrolled !== undefined, "recusa sem scrolled");

  // A recusa por ENTREGA (teste 10b) e o caso oposto e tem de aparecer assim na
  // trilha: a mira estava certa (`actionable:true`) e o evento nao chegou. Se as
  // duas recusas fossem indistinguiveis no audit, o operador nao saberia se o
  // problema foi a pagina ou o runtime.
  const naoEntregue = cliques.filter((l) => l.error?.code === "CLICK_NOT_DELIVERED").at(-1);
  assert.ok(naoEntregue !== undefined, "faltou linha de CLICK_NOT_DELIVERED na trilha");
  assert.equal(naoEntregue.detail.actionable, true);
  assert.equal(naoEntregue.detail.delivery_verified, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 4b — NAVEGACAO E EVIDENCIA DE PRIMEIRA CLASSE
//
// A FASE 4 reprovava o gesto mais comum de um navegador: clicar num link. A
// navegacao destroi o contexto de JS e leva o registro da sonda junto, e a
// leitura perdia a corrida — CLICK_NOT_DELIVERED num clique que funcionou.
//
// O que estes testes fixam, e que nao pode ser afrouxado depois:
//  - link que navega passa E o destino e conferido pelo CONTEUDO da pagina;
//  - ancora (`#fim`) NAO destroi contexto e continua provada pela SONDA — se a
//    navegacao tivesse precedencia, trocariamos prova forte por fraca;
//  - overlay sobre link continua TARGET_NOT_ACTIONABLE: "navegacao" nunca pode
//    virar desculpa para um clique que nem foi despachado;
//  - clique sem navegacao e sem sonda continua CLICK_NOT_DELIVERED.
// ─────────────────────────────────────────────────────────────────────────────

/** URL da aba ativa, lida do registro de abas — nao do relatorio do clique. */
async function urlAtiva(d: Daemon): Promise<string> {
  const t = await acao(d, "browser.tabs", {});
  const abas = (t.env.result ?? []) as { url: string; active: boolean }[];
  return String(abas.find((p) => p.active)?.url ?? abas[0]?.url ?? "");
}

test("4b-1. link mesma origem que NAVEGA: success + delivery_evidence=navegacao", async () => {
  await abrir(principal, "/link");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, true, `link deveria entregar: ${JSON.stringify(c.env.error)}`);
  const d = c.env.result.detail;
  assert.equal(d.actionable, true);
  assert.equal(d.delivery_verified, true);
  assert.equal(d.delivery_evidence, "navegacao", `evidencia=${d.delivery_evidence}`);
  assert.match(String(d.url_antes), /\/link$/);
  assert.match(String(d.url_depois), /\/destino$/, "url_depois tem de registrar o destino");

  // PROVA INDEPENDENTE do relatorio: o conteudo da pagina de destino.
  const marca = await acao(principal, "browser.extract", { target: { selector: "#marca" } });
  assert.equal(String(marca.env.result?.content ?? "").trim(), "DESTINO-4B", "a navegacao nao aconteceu de fato");
});

test("4b-2. link que navega para outra rota: browser.back continua funcionando depois", async () => {
  await abrir(principal, "/link");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  assert.match(await urlAtiva(principal), /\/destino$/);

  const b = await acao(principal, "browser.back", {});
  assert.equal(b.env.success, true, `back falhou: ${JSON.stringify(b.env.error)}`);
  assert.match(String(b.env.result.url), /\/link$/, "back nao voltou para a origem");
  assert.match(await urlAtiva(principal), /\/link$/);
});

test('4b-3. <a target="_blank">: delivery_evidence=nova_aba e a aba aparece em browser.tabs', async () => {
  await abrir(principal, "/blank");
  const antes = ((await acao(principal, "browser.tabs", {})).env.result ?? []).length;

  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const d = c.env.result.detail;
  assert.equal(d.delivery_verified, true);
  assert.equal(d.delivery_evidence, "nova_aba", `evidencia=${d.delivery_evidence}`);
  assert.equal(d.nova_aba, true);
  // A aba nova nao substitui a atual: a origem continua onde estava.
  assert.equal(d.url_antes, d.url_depois, "a aba de origem nao podia ter navegado");

  // A ABA E ADOTADA PELO REGISTRO DA SESSAO DE FORMA ASSINCRONA (o Chromium
  // cria a pagina, o Playwright emite `page`, o SessionManager adota). Sondar
  // com prazo mede o resultado; um `assert` imediato mediria o agendador.
  let abas: { url: string }[] = [];
  const limite = Date.now() + 3000;
  do {
    abas = ((await acao(principal, "browser.tabs", {})).env.result ?? []) as { url: string }[];
    if (abas.length > antes) break;
  } while (Date.now() < limite);

  assert.equal(abas.length, antes + 1, `browser.tabs nao registrou a aba nova (${abas.length} vs ${antes})`);
  assert.ok(
    abas.some((p) => /\/destino$/.test(p.url)),
    `a aba nova deveria estar no destino: ${JSON.stringify(abas.map((p) => p.url))}`,
  );

  // Devolve a sessao ao estado de uma aba so — teste que suja o ambiente dos
  // seguintes mede a ordem de execucao, nao o produto.
  const nova = abas.find((p) => /\/destino$/.test(p.url)) as { page_id?: string } | undefined;
  if (nova?.page_id !== undefined) {
    await acao(principal, "browser.close_tab", { page_id: nova.page_id });
  }
});

test('4b-4. link "#ancora" NAO destroi contexto: a prova continua sendo a SONDA', async () => {
  await abrir(principal, "/ancora");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const d = c.env.result.detail;
  assert.equal(d.delivery_verified, true);
  // ESTE E O PONTO: navegacao de MESMO DOCUMENTO tambem dispara `framenavigated`.
  // Se o sinal tivesse precedencia sobre a sonda, a ancora passaria a ser
  // "provada" por navegacao — trocando prova forte (o evento chegou NESTE
  // elemento) por prova fraca (algo navegou) sem necessidade nenhuma.
  assert.equal(d.delivery_evidence, "listener", `evidencia=${d.delivery_evidence}`);
  assert.equal(d.elemento_que_recebeu, "a#alvo");
  assert.equal(d.is_trusted, true);
  assert.equal(d.contexto_destruido, false, "ancora nao pode destruir contexto");
  assert.match(String(d.url_depois), /#fim$/, "a ancora tinha de mudar o fragmento");
});

test("4b-5. <button> que chama location.assign(): sonda E navegacao, nenhuma vira falso positivo", async () => {
  await abrir(principal, "/assign");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const d = c.env.result.detail;
  assert.equal(d.delivery_verified, true);
  // As DUAS provas existem e a corrida entre elas nao e deterministica: a sonda
  // grava na fase de captura (antes do handler) e o handler navega logo depois.
  // Fixar uma das duas seria fixar o escalonador, nao o comportamento.
  assert.ok(
    d.delivery_evidence === "listener" || d.delivery_evidence === "navegacao",
    `evidencia inesperada: ${d.delivery_evidence}`,
  );
  // NENHUMA das duas pode ser falso positivo:
  //  - se foi a sonda, o elemento que recebeu tem de ser o botao;
  //  - de qualquer forma, a navegacao tem de ter acontecido de verdade.
  if (d.delivery_evidence === "listener") {
    assert.equal(d.elemento_que_recebeu, "button#alvo.alvo");
    assert.equal(d.is_trusted, true);
  }
  assert.match(await urlAtiva(principal), /\/destino$/, "location.assign nao levou ao destino");
  const marca = await acao(principal, "browser.extract", { target: { selector: "#marca" } });
  assert.equal(String(marca.env.result?.content ?? "").trim(), "DESTINO-4B");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLES NEGATIVOS DA 4b — o que NAO pode virar "navegacao"
// ─────────────────────────────────────────────────────────────────────────────

test("4b-6. CONTROLE NEGATIVO: overlay sobre um LINK continua TARGET_NOT_ACTIONABLE", async () => {
  await abrir(principal, "/link-coberto");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, false, "clique sob overlay nao pode dar sucesso so porque o alvo era um link");
  assert.equal(c.status, 409);
  assert.equal(c.env.error!.code, "TARGET_NOT_ACTIONABLE");
  assert.equal(c.env.error!.detail.elemento_no_ponto, "div#capa");
  assert.equal(c.env.error!.detail.actionable, false);
  // A recusa acontece ANTES do despacho: nao existe entrega para avaliar, e a
  // ausencia deste campo e a prova de que a 4b nao virou desculpa universal.
  assert.equal(c.env.error!.detail.delivery_evidence, undefined, "nem chegou a clicar");
  assert.match(await urlAtiva(principal), /\/link-coberto$/, "nada podia ter navegado");
});

test("4b-7. CONTROLE NEGATIVO 2: coordenada vazia em pagina que NAO navega nao vira 'navegacao'", async () => {
  await abrir(principal, "/vazio");
  const c = await acao(principal, "browser.click", { target: { coordinates: { x: 4, y: 700 } } });

  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const d = c.env.result.detail;
  assert.equal(d.delivery_checked, true);
  assert.notEqual(d.delivery_evidence, "navegacao", "sem navegacao nenhuma, a evidencia nao pode ser navegacao");
  assert.equal(d.delivery_evidence, "listener");
  assert.equal(d.navegou, false);
  assert.equal(d.nova_aba, false);
  assert.equal(d.contexto_destruido, false);
  assert.equal(d.url_antes, d.url_depois);
});

test("4b-8. o caso REAL de nao-entrega continua reprovando (nao navegou, nao chegou)", async () => {
  // Mesma fixture do teste 10b: o alvo some no primeiro mousemove. Aqui o que
  // se prova e o complemento da 4b — nenhuma das evidencias novas socorre um
  // clique que de fato nao chegou.
  await abrir(principal, "/some-no-mousemove");
  const c = await acao(principal, "browser.click", { target: { selector: "#alvo" } });

  assert.equal(c.env.success, false);
  assert.equal(c.status, 500);
  assert.equal(c.env.error!.code, "CLICK_NOT_DELIVERED");
  const d = c.env.error!.detail;
  assert.equal(d.delivery_verified, false);
  assert.notEqual(d.delivery_evidence, "navegacao");
  assert.notEqual(d.delivery_evidence, "nova_aba");
  assert.equal(d.navegou, false, "nada navegou — nao ha o que creditar ao clique");
  assert.equal(d.url_antes, d.url_depois);
});
