/**
 * FASE 6 — CASCATA DE PERCEPÇÃO REAL (daemon REAL + Chromium REAL)
 *
 * O DEFEITO MEDIDO QUE ORIGINOU ESTE ARQUIVO
 * ------------------------------------------
 *   grep -rn "VisionProvider" packages/api/src  →  0 ocorrências
 *
 * A cascata tinha seis degraus no papel e cinco na prática: `handlers.ts`
 * chamava `resolveDetailed()` sem `vision`, e TODA resolução que chegava ao 5º
 * degrau terminava assim, no trace do próprio runtime:
 *
 *   {"strategy":"vision","outcome":"skipped","reason":"nenhum VisionProvider injetado"}
 *
 * Honesto — e imutável. Não havia configuração, chave ou injeção que fizesse a
 * visão executar em produção.
 *
 * O QUE ESTE ARQUIVO PROVA, E O QUE ELE NÃO PROVA
 * -----------------------------------------------
 * PROVA: o FIO. Que cada fixture cai no degrau certo, que os degraus anteriores
 * foram TENTADOS e registrados com razão, que a visão não é consultada quando o
 * DOM resolve (contagem de chamadas num espião), que sem provider o degrau sai
 * `skipped` — e que a caixa devolvida pela visão vira gesto real, com
 * `isTrusted:true`, dentro do alvo.
 *
 * NÃO PROVA: que um modelo multimodal ACERTA. Isso não se prova com espião —
 * prova-se com o modelo, e está em
 * `evidence/nomos-browser-final-loop/06-cascata/e2e-visao.ts`, que sobe o daemon
 * com `vision_provider: "ollama:qwen2.5vl:3b"` e mede o erro do clique em px.
 * Os dois são necessários: o espião é determinístico e roda em CI; o e2e mede a
 * realidade e custa 3,2 GB de RAM.
 *
 * Rodar: node --test tests/cascata-percepcao.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../packages/api/src/daemon.ts";
import type { BoundingBox, VisionProvider } from "../packages/core/src/contract.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXDIR = path.join(AQUI, "fixtures", "cascata");

/** VERDADE da fixture de canvas. A página desenha exatamente isto. */
const ALVO_CANVAS: BoundingBox = { x: 400, y: 120, width: 160, height: 100 };

// ─────────────────────────────────────────────────────────────────────────────
// Espião de visão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O que um provider RICO devolve: a caixa do contrato v1 mais o `point_2d`.
 * `point` opcional de propósito — um provider do contrato v1 não aponta, e o
 * runtime tem de continuar funcionando com ele.
 */
interface RespostaDaVisao {
  box: BoundingBox;
  point?: { x: number; y: number } | null;
  confidence: number;
}

interface ChamadaVisao {
  goal: string;
  viewport: { width: number; height: number };
  bytes: number;
}

/**
 * Provider de visão DETERMINÍSTICO que conta chamadas.
 *
 * A contagem é o instrumento central desta fase: "a visão não é chamada quando
 * o DOM resolve" é uma afirmação sobre o que NÃO aconteceu, e a única forma
 * honesta de provar não-acontecimento é medir zero num contador que sabemos
 * incrementar (os testes do degrau 5 mostram que ele incrementa).
 */
class VisaoEspia implements VisionProvider {
  readonly name = "espia";
  readonly chamadas: ChamadaVisao[] = [];
  /**
   * Política de refino que o resolvedor lê deste provider
   * (`ComPoliticaDeRefino` em `target.ts`). Mutável para o teste alternar 0/1/2
   * sem subir outro daemon.
   */
  refine_passes: number | undefined = undefined;
  refine_factor: number | undefined = undefined;
  /** Política de MIRA (FASE 6c), lida por `target.ts` como `ComPoliticaDeMira`. */
  aim: "box_center" | "point" | "point_then_box" | undefined = undefined;
  /**
   * Trocada por teste. Recebe a chamada INTEIRA porque o refino faz perguntas
   * sobre imagens diferentes (tela cheia e recorte), e a resposta certa depende
   * de qual delas chegou — é o `viewport` que distingue as duas.
   */
  resposta: (c: ChamadaVisao) => RespostaDaVisao | null = () => null;

  async locate(input: {
    screenshot: Buffer;
    goal: string;
    viewport: { width: number; height: number };
  }): Promise<RespostaDaVisao | null> {
    const c: ChamadaVisao = { goal: input.goal, viewport: input.viewport, bytes: input.screenshot.length };
    this.chamadas.push(c);
    return this.resposta(c);
  }

  zerar(): void {
    this.chamadas.length = 0;
    this.resposta = () => null;
    this.refine_passes = undefined;
    this.refine_factor = undefined;
    this.aim = undefined;
  }
}

const espia = new VisaoEspia();

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

interface Envelope {
  success: boolean;
  result: any;
  error: { code: string; message: string; detail?: any } | null;
}

const PAGINAS: Record<string, Buffer> = {};
let servidor: http.Server;
let FIX = "";
let comVisao: Daemon;
let semVisao: Daemon;
let retina: Daemon;

async function subir(rotulo: string, over: Record<string, unknown>): Promise<Daemon> {
  const raiz = await mkdtemp(path.join(os.tmpdir(), `nomos-cascata-${rotulo}-`));
  const d = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: raiz,
    // Sem arquivo de config: o ambiente do operador não pode decidir o
    // resultado de um teste que existe para medir configuração.
    read_file: false,
    ...over,
  } as never);
  const base = `http://127.0.0.1:${d.port}`;
  const token = (d as unknown as { token: string | null }).token;
  const r = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ owner: "NOMOS-CASCATA", profile: "sandbox" }),
  });
  const corpo = (await r.json()) as { session_id?: string };
  assert.ok(corpo.session_id, `sessão sem id em ${rotulo}: ${JSON.stringify(corpo)}`);
  return { base, token, sid: corpo.session_id, raiz, fechar: () => d.close() };
}

before(async () => {
  for (const nome of ["dom", "ax", "semantic", "vision", "nenhum"]) {
    PAGINAS[`/${nome}`] = readFileSync(path.join(FIXDIR, `${nome}.html`));
  }
  servidor = http.createServer((req, res) => {
    const rota = (req.url ?? "/").split("?")[0]!;
    const html = PAGINAS[rota];
    if (html === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("nao encontrado");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const addr = servidor.address();
  if (addr === null || typeof addr === "string") throw new Error("fixture sem porta");
  FIX = `http://127.0.0.1:${addr.port}`;

  comVisao = await subir("com-visao", { vision: espia, vision_min_confidence: 0.7 });
  // Controle: MESMO produto, MESMAS fixtures, sem o 5º degrau. É o par que faz
  // "a visão resolveu" significar alguma coisa.
  semVisao = await subir("sem-visao", { vision: null });
  // DPR 2 de VERDADE, não simulado: é a única forma de o teste 9 medir o que o
  // modelo recebe em vez de afirmar.
  retina = await subir("retina", { vision: espia, vision_min_confidence: 0.7, device_scale_factor: 2 });
});

after(async () => {
  for (const d of [comVisao, semVisao, retina]) {
    if (d === undefined) continue;
    await d.fechar().catch(() => undefined);
    await rm(d.raiz, { recursive: true, force: true }).catch(() => undefined);
  }
  await new Promise<void>((r) => servidor?.close(() => r()));
});

async function acao(d: Daemon, tool: string, corpo: Record<string, unknown>): Promise<{ status: number; env: Envelope }> {
  const r = await fetch(`${d.base}/api/v1/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(d.token !== null ? { authorization: `Bearer ${d.token}` } : {}),
    },
    body: JSON.stringify({ session_id: d.sid, ...corpo }),
  });
  return { status: r.status, env: (await r.json()) as Envelope };
}

async function abrir(d: Daemon, rota: string): Promise<void> {
  const o = await acao(d, "browser.open", { url: `${FIX}${rota}` });
  assert.equal(o.env.success, true, `open ${rota}: ${JSON.stringify(o.env.error)}`);
}

async function trilha(d: Daemon): Promise<any[]> {
  const arq = path.join(d.raiz, d.sid, "actions.jsonl");
  const bruto = await readFile(arq, "utf8").catch(() => "");
  return bruto
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

/** Degrau do trace, por estratégia. `undefined` quando o degrau nem foi tentado. */
function degrau(trace: any[], estrategia: string): any {
  return (trace ?? []).find((t: any) => t.strategy === estrategia);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Degrau 1 — DOM (selector)
// ─────────────────────────────────────────────────────────────────────────────

test("1. dom.html resolve por `selector` e NÃO consulta a visão", async () => {
  espia.zerar();
  espia.resposta = () => {
    throw new Error("a visão foi chamada num caso que o DOM resolve");
  };
  await abrir(comVisao, "/dom");

  const f = await acao(comVisao, "browser.find", { target: { selector: "#alvo-unico" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(f.env.result.strategy, "selector");
  assert.deepEqual(f.env.result.attempted, ["selector"], "a cascata desceu degraus que não precisava");
  assert.equal(f.env.result.healed, false);
  assert.equal(espia.chamadas.length, 0, "visão consultada com o DOM resolvendo");

  // Um descritor RICO (seletor + texto + semântico) continua parando no 1º
  // degrau. Sem isto, "attempted tem um item" poderia ser só falta de campo.
  const rico = await acao(comVisao, "browser.find", {
    target: { selector: "#alvo-unico", text: "Confirmar pedido", semantic: "confirmar" },
  });
  assert.equal(rico.env.success, true, JSON.stringify(rico.env.error));
  assert.equal(rico.env.result.strategy, "selector");
  assert.deepEqual(rico.env.result.attempted, ["selector"]);
  assert.equal(espia.chamadas.length, 0, "visão consultada mesmo com o seletor acertando");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Degrau 3 — acessibilidade
// ─────────────────────────────────────────────────────────────────────────────

test("2. ax.html resolve por `accessibility` depois de `role_text` falhar", async () => {
  espia.zerar();
  espia.resposta = () => {
    throw new Error("a visão foi chamada num caso que a acessibilidade resolve");
  };
  await abrir(comVisao, "/ax");

  // Só `text`: sem `role`, o Playwright não casa nome acessível em role_text —
  // e é isso que empurra a resolução para o degrau que a fixture exercita.
  const f = await acao(comVisao, "browser.find", { target: { text: "Enviar formulario agora" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(f.env.result.strategy, "accessibility");
  assert.deepEqual(
    f.env.result.attempted,
    ["role_text", "accessibility"],
    "o degrau anterior não consta do rastro",
  );
  assert.equal(f.env.result.healed, true, "resolver fora da 1ª estratégia pedida é cura e tem de ser marcado");
  assert.equal(espia.chamadas.length, 0, "visão consultada com a acessibilidade resolvendo");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Degrau 4 — semântico
// ─────────────────────────────────────────────────────────────────────────────

test("3. semantic.html resolve por `semantic` — 'avançar' encontra 'Prosseguir'", async () => {
  espia.zerar();
  espia.resposta = () => {
    throw new Error("a visão foi chamada num caso que o semântico resolve");
  };
  await abrir(comVisao, "/semantic");

  const f = await acao(comVisao, "browser.find", {
    // Seletor MORTO de propósito: é o caso real de cura, e é o que faz o degrau
    // 1 ser tentado e falhar em vez de nem constar do rastro.
    target: { selector: "#alvo-que-sumiu", semantic: "avançar" },
  });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(f.env.result.strategy, "semantic");
  assert.deepEqual(f.env.result.attempted, ["selector", "semantic"]);
  assert.equal(f.env.result.healed, true);
  assert.equal(espia.chamadas.length, 0, "visão consultada com o semântico resolvendo");

  // Clicou no botão CERTO — não em "o primeiro botão da página".
  const c = await acao(comVisao, "browser.click", { target: { semantic: "avançar" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const recibo = await acao(comVisao, "browser.extract", { target: { selector: "#recibo" } });
  assert.match(String(recibo.env.result?.content ?? ""), /"Prosseguir"/);
  assert.match(String(recibo.env.result?.content ?? ""), /isTrusted=true/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Degrau 5 — visão, com provider injetado
// ─────────────────────────────────────────────────────────────────────────────

test("4. vision.html resolve por `vision` — e só com VisionProvider injetado", async () => {
  espia.zerar();
  espia.resposta = () => ({ box: { ...ALVO_CANVAS }, confidence: 0.93 });
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(f.env.result.strategy, "vision", `resolveu por ${f.env.result.strategy}`);
  assert.deepEqual(f.env.result.attempted, ["semantic", "vision"], "o degrau semântico não foi tentado antes");
  assert.equal(espia.chamadas.length, 1, `visão chamada ${espia.chamadas.length}x`);
  assert.ok(espia.chamadas[0]!.bytes > 1000, "screenshot vazio chegou ao provider");
  assert.equal(espia.chamadas[0]!.viewport.width, 1280);

  // A caixa da visão vira GESTO REAL: clique dentro do alvo, evento confiável.
  const c = await acao(comVisao, "browser.click", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const txt = String((await acao(comVisao, "browser.extract", { target: { selector: "#clicado" } })).env.result?.content ?? "");
  const m = txt.match(/clique em (\d+),(\d+) isTrusted=(true|false)/);
  assert.ok(m !== null, `canvas não registrou clique: ${txt}`);
  const [x, y] = [Number(m![1]), Number(m![2])];
  assert.equal(m![3], "true", "evento sintético — o clique não veio do navegador");
  assert.ok(
    x >= ALVO_CANVAS.x && x <= ALVO_CANVAS.x + ALVO_CANVAS.width,
    `clique fora do alvo no eixo x: ${x} não está em [${ALVO_CANVAS.x}, ${ALVO_CANVAS.x + ALVO_CANVAS.width}]`,
  );
  assert.ok(
    y >= ALVO_CANVAS.y && y <= ALVO_CANVAS.y + ALVO_CANVAS.height,
    `clique fora do alvo no eixo y: ${y} não está em [${ALVO_CANVAS.y}, ${ALVO_CANVAS.y + ALVO_CANVAS.height}]`,
  );
});

test("5. confiança abaixo do mínimo é DESCARTADA — palpite não vira alvo", async () => {
  espia.zerar();
  // 0,55 < `vision_min_confidence` = 0,7. A caixa está CERTA; o que reprova é a
  // confiança. Sem esta prova, o limiar seria um número decorativo na config.
  espia.resposta = () => ({ box: { ...ALVO_CANVAS }, confidence: 0.55 });
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, false, "aceitou um palpite abaixo do limiar");
  assert.equal(f.env.error?.code, "TARGET_NOT_FOUND");
  const d = degrau(f.env.error?.detail?.trace, "vision");
  assert.ok(d !== undefined, "degrau de visão ausente do rastro");
  assert.equal(d.outcome, "miss");
  assert.match(String(d.reason), /confian[çc]a 0\.55 abaixo do m[íi]nimo 0\.70/);
  assert.equal(espia.chamadas.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Degrau 5 SEM provider — `skipped` com razão, nunca em silêncio
// ─────────────────────────────────────────────────────────────────────────────

test("6. sem VisionProvider, o degrau `vision` sai `skipped` COM razão explícita", async () => {
  await abrir(semVisao, "/vision");
  const f = await acao(semVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });

  assert.equal(f.env.success, false, "resolveu alvo só-pixel sem provider de visão nenhum");
  assert.equal(f.env.error?.code, "TARGET_NOT_FOUND");
  assert.deepEqual(f.env.error?.detail?.attempted, ["semantic", "vision"]);
  const d = degrau(f.env.error?.detail?.trace, "vision");
  assert.ok(d !== undefined, "o degrau pulado sumiu do rastro — pular em silêncio é o defeito");
  assert.equal(d.outcome, "skipped");
  assert.equal(d.reason, "nenhum VisionProvider injetado");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Controle negativo — nenhum degrau resolve, nenhum inventa
// ─────────────────────────────────────────────────────────────────────────────

test("7. nenhum.html falha limpo: TARGET_NOT_FOUND, rastro completo, zero coordenada inventada", async () => {
  espia.zerar();
  // A visão é CONSULTADA e responde honestamente "não vi". É o caso que separa
  // "não achou" de "não olhou".
  espia.resposta = () => null;
  await abrir(comVisao, "/nenhum");

  const f = await acao(comVisao, "browser.find", {
    target: { selector: "#nao-existe-mesmo", semantic: "finalizar compra" },
  });
  assert.equal(f.env.success, false, "devolveu sucesso para alvo que não existe na página");
  assert.equal(f.env.error?.code, "TARGET_NOT_FOUND");

  const trace = f.env.error?.detail?.trace ?? [];
  assert.deepEqual(f.env.error?.detail?.attempted, ["selector", "semantic", "vision"]);
  for (const e of ["selector", "semantic", "vision"]) {
    const d = degrau(trace, e);
    assert.ok(d !== undefined, `degrau ${e} ausente do rastro`);
    assert.ok(["miss", "skipped"].includes(d.outcome), `degrau ${e} com outcome ${d.outcome}`);
    assert.ok(typeof d.reason === "string" && d.reason.length > 0, `degrau ${e} sem razão`);
  }
  assert.equal(espia.chamadas.length, 1, "a visão não foi consultada antes de desistir");

  // `coordinates` NÃO consta do rastro: sem coordenada no descritor o degrau 6
  // não é aplicável, e o runtime não pode fabricar uma para "conseguir agir".
  assert.equal(degrau(trace, "coordinates"), undefined, "runtime inventou um degrau de coordenada");
  assert.equal(f.env.result, null);

  // Clicar no mesmo alvo também falha — e falha ANTES de qualquer gesto.
  const c = await acao(comVisao, "browser.click", {
    target: { selector: "#nao-existe-mesmo", semantic: "finalizar compra" },
  });
  assert.equal(c.env.success, false, "clicou em alvo inexistente");
  assert.equal(c.env.error?.code, "TARGET_NOT_FOUND");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DPR — o que o modelo RECEBE e o que o runtime FAZ com a resposta
// ─────────────────────────────────────────────────────────────────────────────

test("8. em DPR 2 o modelo é informado do tamanho REAL da imagem e a caixa volta em CSS px", async () => {
  espia.zerar();
  // O provider responde no referencial da IMAGEM — que é o único referencial
  // que ele tem, porque é o único que ele vê.
  espia.resposta = () => ({
    box: { x: ALVO_CANVAS.x * 2, y: ALVO_CANVAS.y * 2, width: ALVO_CANVAS.width * 2, height: ALVO_CANVAS.height * 2 },
    confidence: 0.95,
  });
  await abrir(retina, "/vision");

  const f = await acao(retina, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(f.env.result.strategy, "vision");

  // (a) O QUE O MODELO RECEBEU. `page.screenshot()` devolve pixels de
  //     DISPOSITIVO: em DPR 2 a imagem tem 2560x1600. Dizer-lhe "1280x800",
  //     como o runtime fazia, era mentir sobre a própria evidência entregue.
  assert.equal(espia.chamadas.length, 1);
  assert.equal(espia.chamadas[0]!.viewport.width, 2560, "o provider foi informado de um tamanho que não é o da imagem");
  assert.equal(espia.chamadas[0]!.viewport.height, 1600);

  // (b) O QUE O RUNTIME FEZ COM A RESPOSTA. A caixa volta em CSS px — o mesmo
  //     espaço em que Pointer e Perception trabalham. Sem a conversão, o alvo
  //     sairia em (800,240) e o clique cairia longe.
  assert.equal(f.env.result.box.x, ALVO_CANVAS.x, JSON.stringify(f.env.result.box));
  assert.equal(f.env.result.box.y, ALVO_CANVAS.y);
  assert.equal(f.env.result.box.width, ALVO_CANVAS.width);
  assert.equal(f.env.result.box.height, ALVO_CANVAS.height);

  // (c) O GESTO. O clique tem de cair dentro do alvo em coordenadas de PÁGINA,
  //     que é o único teste que o DPR não consegue enganar.
  const c = await acao(retina, "browser.click", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const txt = String((await acao(retina, "browser.extract", { target: { selector: "#clicado" } })).env.result?.content ?? "");
  const m = txt.match(/clique em (\d+),(\d+) isTrusted=(true|false)/);
  assert.ok(m !== null, `canvas não registrou clique: ${txt}`);
  const [x, y] = [Number(m![1]), Number(m![2])];
  assert.equal(m![3], "true");
  assert.ok(
    x >= ALVO_CANVAS.x && x <= ALVO_CANVAS.x + ALVO_CANVAS.width && y >= ALVO_CANVAS.y && y <= ALVO_CANVAS.y + ALVO_CANVAS.height,
    `clique fora do alvo em DPR 2: (${x},${y})`,
  );

  // Controle negativo do próprio conserto: em DPR 1 nada é convertido, e o
  // provider continua recebendo o tamanho do viewport CSS.
  espia.zerar();
  espia.resposta = () => ({ box: { ...ALVO_CANVAS }, confidence: 0.95 });
  await abrir(comVisao, "/vision");
  const f1 = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f1.env.success, true, JSON.stringify(f1.env.error));
  assert.equal(espia.chamadas[0]!.viewport.width, 1280);
  assert.equal(f1.env.result.box.x, ALVO_CANVAS.x);
  assert.equal(f1.env.result.box.width, ALVO_CANVAS.width);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. O rastro é AUDITÁVEL
// ─────────────────────────────────────────────────────────────────────────────

test("9. a cascata que chega na visão deixa `target.cascade` na trilha, com trace", async () => {
  const linhas = await trilha(comVisao);
  const cascatas = linhas.filter((l) => l.action === "target.cascade");
  assert.ok(cascatas.length >= 3, `esperava várias linhas de cascata, achei ${cascatas.length}`);

  const resolvida = cascatas.find((l) => l.detail?.strategy === "vision");
  assert.ok(resolvida !== undefined, "a resolução por visão não deixou linha na trilha");
  assert.equal(resolvida.event, "action");
  assert.equal(resolvida.provider, "espia", "a trilha não diz QUEM olhou");
  assert.equal(resolvida.verified, true);
  assert.equal(resolvida.detail.vision_outcome, "hit");
  assert.equal(resolvida.detail.vision_min_confidence, 0.7);
  assert.ok(Array.isArray(resolvida.detail.trace) && resolvida.detail.trace.length >= 2, "trace ausente da trilha");
  assert.equal(resolvida.detail.trace[0].strategy, "semantic");
  assert.equal(resolvida.detail.trace[0].outcome, "miss");
  assert.ok(typeof resolvida.detail.trace[0].reason === "string");

  // A cascata que FALHOU também deixa linha: é ela que responde "por que não
  // achou?" sem depender de alguém ter guardado o corpo da resposta HTTP.
  const falhada = cascatas.find((l) => l.result === "error");
  assert.ok(falhada !== undefined, "cascata falhada não deixou linha");
  assert.equal(falhada.detail.strategy, null);
  assert.ok(Array.isArray(falhada.detail.trace));

  // Nenhuma resolução por DOM polui a trilha com trace: o degrau `vision` é o
  // critério, e as buscas do teste 1 não chegaram nele.
  for (const l of cascatas) {
    assert.ok(
      (l.detail.trace as any[]).some((t) => t.strategy === "vision"),
      "linha de cascata sem degrau de visão — o filtro da trilha não é o que dissemos",
    );
  }

  // Controle: o daemon SEM visão registra a mesma cascata, com o degrau pulado.
  const semTrilha = await trilha(semVisao);
  const pulada = semTrilha.find((l) => l.action === "target.cascade");
  assert.ok(pulada !== undefined, "cascata pulada não deixou linha no daemon sem visão");
  assert.equal(pulada.detail.vision_outcome, "skipped");
  assert.equal(pulada.detail.vision_provider, null);
  assert.equal(pulada.detail.vision_reason, "nenhum VisionProvider injetado");
});

// ─────────────────────────────────────────────────────────────────────────────
// 10-13. REFINO POR RECORTE (FASE 6b)
//
// O QUE ESTES TESTES PROVAM, E O QUE ELES DELIBERADAMENTE NÃO PROVAM
// -------------------------------------------------------------------
// PROVAM: a mecânica. Que o recorte é pedido, que a imagem entregue ao provider
// corresponde à região declarada no rastro, que o mapeamento recorte→viewport é
// EXATO, que a guarda de aceite rejeita um refinamento que não cabe no próprio
// recorte, e que a convergência para cedo em vez de gastar inferência à toa.
//
// NÃO PROVAM que o refino melhora a precisão de um modelo real — porque a
// medição diz que, com `qwen2.5vl:3b`, ele NÃO melhora. A tabela completa está
// em `evidence/nomos-browser-final-loop/06-cascata/medir-refino.ts` e resumida
// sobre `DEFAULT_VISION_REFINE_PASSES` em `target.ts`. Escrever aqui um teste
// verde afirmando "o refino melhora" seria fabricar a conclusão que a medição
// recusou — exatamente o que um espião determinístico permite fazer sem que
// ninguém perceba, e por isso não foi feito.
// ─────────────────────────────────────────────────────────────────────────────

/** Caixa grosseira que imita o viés MEDIDO: +12 em x, +30 em y, largura 1,8x. */
const B0_ENVIESADA: BoundingBox = {
  x: ALVO_CANVAS.x + 12,
  y: ALVO_CANVAS.y + 30,
  width: ALVO_CANVAS.width * 1.8,
  height: ALVO_CANVAS.height,
};

/** Último `RefinoTrace` gravado na trilha do daemon. */
async function ultimoRefino(d: Daemon): Promise<any> {
  const linhas = await trilha(d);
  const casc = [...linhas].reverse().find((l) => l.action === "target.cascade");
  return ((casc?.detail?.trace ?? []) as any[]).find((t) => t.strategy === "vision")?.detail ?? null;
}

test("10. refino DESLIGADO: uma inferência, e o rastro diz que foi escolha", async () => {
  espia.zerar();
  espia.refine_passes = 0;
  espia.resposta = () => ({ box: { ...B0_ENVIESADA }, confidence: 0.9 });
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(espia.chamadas.length, 1, "gastou inferência com o refino desligado");
  assert.deepEqual(f.env.result.box, B0_ENVIESADA, "a caixa devolvida não é a da 1ª passada");

  const r = await ultimoRefino(comVisao);
  assert.ok(r !== null, "degrau de visão sem RefinoTrace");
  assert.equal(r.refino, "desligado");
  assert.equal(r.passadas, 0);
  assert.equal(r.inferencias, 1);
  assert.equal(r.motivo, "vision_refine_passes = 0");
  assert.equal(r.regiao_de_recorte, null);
});

test("11. refino LIGADO: recorta, e o mapeamento recorte→viewport é EXATO", async () => {
  espia.zerar();
  espia.refine_passes = 1;
  // A 2ª pergunta chega com o tamanho do RECORTE, e é assim que o espião sabe
  // que está olhando o recorte: nenhuma outra informação distingue as duas.
  const NO_RECORTE: BoundingBox = { x: 37, y: 61, width: 160, height: 100 };
  espia.resposta = (c) =>
    c.viewport.width === 1280
      ? { box: { ...B0_ENVIESADA }, confidence: 0.9 }
      : { box: { ...NO_RECORTE }, confidence: 0.95 };
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(espia.chamadas.length, 2, `esperava 2 inferências, houve ${espia.chamadas.length}`);

  const r = await ultimoRefino(comVisao);
  assert.equal(r.refino, "usado");
  assert.equal(r.passadas, 1);
  assert.equal(r.inferencias, 2);
  const R = r.regiao_de_recorte;
  assert.ok(R !== null, "refino usado sem região de recorte no rastro");

  // (a) A REGIÃO É SÃ, e isso é verificado contra a página — não contra a
  //     fórmula do produto repetida no teste.
  assert.ok(R.width < 1280 && R.height < 800, `recorte não é menor que o viewport: ${JSON.stringify(R)}`);
  assert.equal(R.width, R.height, "recorte deveria ser quadrado");
  assert.ok(R.x >= 0 && R.y >= 0 && R.x + R.width <= 1280 && R.y + R.height <= 800, "recorte saiu do viewport");
  const cxB0 = B0_ENVIESADA.x + B0_ENVIESADA.width / 2;
  const cyB0 = B0_ENVIESADA.y + B0_ENVIESADA.height / 2;
  assert.ok(
    cxB0 >= R.x && cxB0 <= R.x + R.width && cyB0 >= R.y && cyB0 <= R.y + R.height,
    "o recorte não está em volta da estimativa grosseira",
  );

  // (b) A IMAGEM ENTREGUE corresponde à região declarada. Sem isto, o rastro
  //     poderia dizer uma coisa e o modelo ter visto outra.
  assert.equal(espia.chamadas[1]!.viewport.width, R.width, "o provider recebeu imagem de tamanho diferente do recorte");
  assert.equal(espia.chamadas[1]!.viewport.height, R.height);

  // (c) O MAPEAMENTO. É o cálculo que, errado, faria o clique cair em qualquer
  //     lugar — e o degrau continuaria dizendo `hit`.
  assert.deepEqual(f.env.result.box, {
    x: R.x + NO_RECORTE.x,
    y: R.y + NO_RECORTE.y,
    width: NO_RECORTE.width,
    height: NO_RECORTE.height,
  });
  assert.deepEqual(r.box_p1, B0_ENVIESADA, "o rastro perdeu a caixa da 1ª passada");
  assert.notDeepEqual(r.box_refinada, r.box_p1);
  assert.ok(r.deslocamento_px > 0, "refino aceito sem deslocamento algum");
  assert.ok(r.area_ratio_p1_p2 > 1, "a caixa refinada deveria ser menor que a grosseira aqui");
});

test("12. GUARDA: refinamento que não cabe no recorte é REJEITADO e vale a 1ª passada", async () => {
  espia.zerar();
  espia.refine_passes = 1;
  // Caixa que começa quase na borda do recorte e transborda. É o caso REAL
  // medido com fator 1.5: o modelo infla a largura e o resultado não cabe.
  espia.resposta = (c) =>
    c.viewport.width === 1280
      ? { box: { ...B0_ENVIESADA }, confidence: 0.9 }
      : { box: { x: c.viewport.width - 20, y: 0, width: 300, height: 60 }, confidence: 0.99 };
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(espia.chamadas.length, 2, "a guarda não pode economizar a inferência que ela julga");

  // A resposta é a da 1ª passada — que ao menos viu a página inteira. Aceitar o
  // refinamento aqui seria trocar uma estimativa ruim por uma pior, com
  // confiança 0,99 dizendo o contrário.
  assert.deepEqual(f.env.result.box, B0_ENVIESADA, "a caixa transbordante foi aceita");
  const r = await ultimoRefino(comVisao);
  assert.equal(r.refino, "rejeitado");
  assert.equal(r.passadas, 0);
  assert.match(String(r.motivo), /não cabe na região recortada/);
  assert.equal(r.deslocamento_px, 0);
});

test("13. CONVERGÊNCIA: 2ª passada que não move nada para cedo em vez de gastar a 3ª", async () => {
  espia.zerar();
  espia.refine_passes = 2;

  // B0 NO MIOLO DO VIEWPORT, e isso importa: quando o recorte encosta numa
  // borda ele é preso ali, e o próprio ato de recortar desloca o centro. Esse
  // deslocamento é legítimo (a região tem de caber na tela) mas NÃO é
  // convergência — testar convergência com o alvo colado na borda mediria o
  // clamp, não a parada antecipada. `B0_ENVIESADA` fica em y=150 com recorte de
  // 720px: encostaria no topo.
  const B0_MIOLO: BoundingBox = { x: 540, y: 340, width: 200, height: 120 };
  // No recorte, o espião devolve a MESMA caixa centrada: não há o que refinar,
  // e insistir só queimaria a 3ª inferência.
  espia.resposta = (c) => {
    if (c.viewport.width === 1280) return { box: { ...B0_MIOLO }, confidence: 0.9 };
    const lado = c.viewport.width;
    return {
      box: {
        x: (lado - B0_MIOLO.width) / 2,
        y: (lado - B0_MIOLO.height) / 2,
        width: B0_MIOLO.width,
        height: B0_MIOLO.height,
      },
      confidence: 0.95,
    };
  };
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(espia.chamadas.length, 2, `parou tarde: ${espia.chamadas.length} inferências com teto de 3`);

  const r = await ultimoRefino(comVisao);
  assert.equal(r.refino, "usado");
  assert.equal(r.passadas, 1);
  assert.equal(r.inferencias, 2);
  assert.match(String(r.motivo), /convergiu/);
  // Convergir significa "a 2ª leitura concorda com a 1ª" — e o rastro tem de
  // mostrar isso, não só afirmá-lo.
  assert.ok(r.deslocamento_px < 2, `convergiu mas o centro moveu ${r.deslocamento_px}px`);
});

test("14. refino em DPR 2: o mapeamento sobrevive à conversão de pixels de imagem", async () => {
  espia.zerar();
  espia.refine_passes = 1;
  const NO_RECORTE_CSS: BoundingBox = { x: 40, y: 50, width: 160, height: 100 };
  // Em DPR 2 o provider responde no referencial da IMAGEM, que tem o dobro do
  // lado do recorte em CSS px. As duas conversões (imagem→CSS e recorte→viewport)
  // têm de compor sem sobrar fator 2 em lugar nenhum.
  espia.resposta = (c) =>
    c.viewport.width === 2560
      ? {
          box: {
            x: B0_ENVIESADA.x * 2,
            y: B0_ENVIESADA.y * 2,
            width: B0_ENVIESADA.width * 2,
            height: B0_ENVIESADA.height * 2,
          },
          confidence: 0.9,
        }
      : {
          box: {
            x: NO_RECORTE_CSS.x * 2,
            y: NO_RECORTE_CSS.y * 2,
            width: NO_RECORTE_CSS.width * 2,
            height: NO_RECORTE_CSS.height * 2,
          },
          confidence: 0.95,
        };
  await abrir(retina, "/vision");

  const f = await acao(retina, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.equal(espia.chamadas.length, 2);

  const r = await ultimoRefino(retina);
  assert.equal(r.refino, "usado");
  const R = r.regiao_de_recorte;
  // A imagem do recorte tem o dobro do lado declarado: o rastro fala CSS px, o
  // provider recebe pixels de dispositivo, e os dois têm de continuar batendo.
  assert.equal(espia.chamadas[1]!.viewport.width, R.width * 2, "o recorte em DPR 2 não veio em pixels de dispositivo");
  assert.deepEqual(f.env.result.box, {
    x: R.x + NO_RECORTE_CSS.x,
    y: R.y + NO_RECORTE_CSS.y,
    width: NO_RECORTE_CSS.width,
    height: NO_RECORTE_CSS.height,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15-17. MIRA: onde o gesto cai dentro do que a visão devolveu (FASE 6c)
//
// Testes de MECÂNICA, e valem qualquer que seja o modo vencedor: o espião
// devolve ponto e caixa DIVERGENTES de propósito, e cada modo tem de mirar onde
// promete. A medição com modelo real (que escolheu o default) está em
// `evidence/nomos-browser-final-loop/06-cascata/medir-refino.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** Caixa deslocada do alvo; seu centro cai FORA do alvo verdadeiro. */
const CAIXA_TORTA: BoundingBox = { x: 470, y: 160, width: 280, height: 100 };
/** Ponto dentro da caixa torta E dentro do alvo verdadeiro — as duas leituras discordam. */
const PONTO_BOM = { x: 480, y: 170 };

function centroDe(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test("15. aim=box_center mira o centro da caixa, mesmo havendo ponto melhor", async () => {
  espia.zerar();
  espia.aim = "box_center";
  espia.resposta = () => ({ box: { ...CAIXA_TORTA }, point: { ...PONTO_BOM }, confidence: 0.9 });
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  // A caixa devolvida é a CRUA: nada foi recentrado.
  assert.deepEqual(f.env.result.box, CAIXA_TORTA);
  assert.deepEqual(centroDe(f.env.result.box), centroDe(CAIXA_TORTA));

  const r = await ultimoRefino(comVisao);
  assert.equal(r.aim_modo, "box_center");
  assert.equal(r.aim, "box_center");
  assert.match(String(r.aim_motivo), /configuração pede o centro/);
  // O ponto CRU fica no rastro mesmo sem ter sido usado: quem auditar precisa
  // poder ver que havia uma alternativa e que ela foi descartada por política.
  assert.deepEqual(r.aim_point, PONTO_BOM);
  assert.deepEqual(r.aim_box_bruta, CAIXA_TORTA);
});

test("16. aim=point recentra no ponto — e o clique cai no ponto, não no centro da caixa", async () => {
  espia.zerar();
  espia.aim = "point";
  espia.resposta = () => ({ box: { ...CAIXA_TORTA }, point: { ...PONTO_BOM }, confidence: 0.9 });
  await abrir(comVisao, "/vision");

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  // A extensão continua sendo a estimativa do modelo; o que mudou é ONDE ela
  // está centrada. É essa recentragem que faz o gesto cair no ponto sem que o
  // caminho do clique precise saber que "mira" existe.
  assert.deepEqual(centroDe(f.env.result.box), PONTO_BOM);
  assert.equal(f.env.result.box.width, CAIXA_TORTA.width);
  assert.equal(f.env.result.box.height, CAIXA_TORTA.height);

  const r = await ultimoRefino(comVisao);
  assert.equal(r.aim, "point");
  assert.equal(r.aim_motivo, null);
  assert.deepEqual(r.aim_box_bruta, CAIXA_TORTA, "o rastro perdeu a caixa crua");

  // O GESTO. Prova de que a recentragem chega ao navegador: o centro da caixa
  // torta (610,210) cai FORA do alvo (400..560, 120..220); o ponto cai dentro.
  const c = await acao(comVisao, "browser.click", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const txt = String((await acao(comVisao, "browser.extract", { target: { selector: "#clicado" } })).env.result?.content ?? "");
  const m = txt.match(/clique em (\d+),(\d+) isTrusted=(true|false)/);
  assert.ok(m !== null, `canvas não registrou clique: ${txt}`);
  assert.equal(Number(m![1]), PONTO_BOM.x);
  assert.equal(Number(m![2]), PONTO_BOM.y);
  assert.equal(m![3], "true");
});

test("17. aim=point_then_box: usa o ponto quando concorda com a caixa, e recua quando não", async () => {
  // (a) CONCORDA — ponto dentro da caixa ⇒ mira o ponto.
  espia.zerar();
  espia.aim = "point_then_box";
  espia.resposta = () => ({ box: { ...CAIXA_TORTA }, point: { ...PONTO_BOM }, confidence: 0.9 });
  await abrir(comVisao, "/vision");
  let f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.deepEqual(centroDe(f.env.result.box), PONTO_BOM);
  let r = await ultimoRefino(comVisao);
  assert.equal(r.aim, "point");

  // (b) DISCORDA — o modelo aponta para fora da própria caixa. Duas leituras
  //     incompatíveis da mesma tela: prevalece a que delimita.
  espia.zerar();
  espia.aim = "point_then_box";
  espia.resposta = () => ({ box: { ...CAIXA_TORTA }, point: { x: 100, y: 700 }, confidence: 0.9 });
  await abrir(comVisao, "/vision");
  f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.deepEqual(f.env.result.box, CAIXA_TORTA, "seguiu um ponto que o próprio modelo contradiz");
  r = await ultimoRefino(comVisao);
  assert.equal(r.aim, "box_center");
  assert.match(String(r.aim_motivo), /fora da bbox_2d/);
  assert.deepEqual(r.aim_point, { x: 100, y: 700 }, "o ponto rejeitado sumiu do rastro");

  // (c) SEM PONTO — provider do contrato v1, que não aponta. Cai na caixa sem
  //     falhar: exigir `point_2d` de todo provider quebraria o contrato.
  espia.zerar();
  espia.aim = "point_then_box";
  espia.resposta = () => ({ box: { ...CAIXA_TORTA }, confidence: 0.9 });
  await abrir(comVisao, "/vision");
  f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.deepEqual(f.env.result.box, CAIXA_TORTA);
  r = await ultimoRefino(comVisao);
  assert.equal(r.aim, "box_center");
  assert.equal(r.aim_point, null);
  assert.match(String(r.aim_motivo), /não devolveu point_2d/);
});

test("18. o ponto sofre as MESMAS conversões da caixa (DPR 2 e recorte)", async () => {
  // Um ponto convertido pela metade, ou não convertido, mira a 1/4 da tela de
  // distância — e com confiança alta. É o mesmo defeito de DPR da FASE 6,
  // aplicado ao campo novo.
  espia.zerar();
  espia.aim = "point";
  espia.resposta = () => ({
    box: {
      x: CAIXA_TORTA.x * 2,
      y: CAIXA_TORTA.y * 2,
      width: CAIXA_TORTA.width * 2,
      height: CAIXA_TORTA.height * 2,
    },
    point: { x: PONTO_BOM.x * 2, y: PONTO_BOM.y * 2 },
    confidence: 0.9,
  });
  await abrir(retina, "/vision");

  const f = await acao(retina, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  assert.deepEqual(centroDe(f.env.result.box), PONTO_BOM, "o ponto não foi convertido de pixels de imagem para CSS px");
  const r = await ultimoRefino(retina);
  assert.deepEqual(r.aim_point, PONTO_BOM);
});
