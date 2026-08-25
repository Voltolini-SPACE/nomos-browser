/**
 * DIAGNÓSTICO — de quem é a culpa quando a visão erra o alvo?
 *
 * A primeira execução do `e2e-visao.ts` deu `strategy=vision` (o fio funciona)
 * mas caixa {462,165,392,112} para uma verdade de {400,120,160,100}: centro
 * (658,221), 185px fora. A evidência anterior (09-llm) tinha medido 41,7px de
 * erro e clique DENTRO — mas sobre outra imagem: `03-vision/alvos.html`, com
 * botões de DOM de verdade, texto centralizado e seis alvos dando escala.
 *
 * Duas hipóteses, e elas pedem consertos opostos:
 *   (H1) a IMAGEM é o fator — uma fixture de canvas com um retângulo solitário
 *        e texto à esquerda é mais difícil que uma página com botões reais;
 *   (H2) o PROMPT é o fator — a redação do `goal` muda o resultado.
 *
 * Este script mede as duas contra o MESMO modelo, uma carga só.
 *
 * Rodar: node evidence/nomos-browser-final-loop/06-cascata/diag-visao.ts
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { OllamaVisionProvider } from "../../../packages/core/src/vision.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });
const OLLAMA = "http://127.0.0.1:11434";
const MODELO = "qwen2.5vl:3b";
const VERDADE = { x: 400, y: 120, w: 160, h: 100, cx: 480, cy: 170 };

const descarregar = async (): Promise<void> => {
  await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, keep_alive: 0 }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
};

/** Tira um screenshot de viewport da fixture pelo próprio runtime. */
async function capturar(arquivo: string, rotulo: string): Promise<Buffer> {
  const html = fs.readFileSync(arquivo);
  const srv = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(html);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  const raiz = path.join(OUT, `shots-${rotulo}`);
  const d: any = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    read_file: false,
    sessions_root: raiz,
  } as never);
  const base = `http://127.0.0.1:${d.port}`;
  const tok = d.token ?? null;
  const p = async (rota: string, b: unknown): Promise<any> => {
    const x = await fetch(base + rota, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok !== null ? { authorization: `Bearer ${tok}` } : {}) },
      body: JSON.stringify(b),
    });
    return await x.json();
  };
  const s = await p("/api/v1/sessions", { owner: "DIAG", headless: true });
  const sid = s.session_id;
  await p("/api/v1/browser.open", { session_id: sid, url });
  await p("/api/v1/browser.screenshot", { session_id: sid, scope: "viewport" });
  await d.close();
  await new Promise<void>((r) => srv.close(() => r()));
  const dir = path.join(raiz, sid, "screenshots");
  const png = fs.readdirSync(dir).find((x) => x.endsWith(".png"))!;
  return fs.readFileSync(path.join(dir, png));
}

const GOALS = [
  "o botao vermelho escrito COMPRAR",
  "o botao azul escrito COMPRAR",
  "o retangulo vermelho com o texto COMPRAR",
  "COMPRAR",
];

const canvasNovo = await capturar(path.join(RAIZ, "tests/fixtures/cascata/vision.html"), "canvas");
const domAntigo = await capturar(path.join(RAIZ, "evidence/nomos-browser-final-validation/03-vision/alvos.html"), "dom");
process.stdout.write(`canvas.png=${canvasNovo.length}B  dom.png=${domAntigo.length}B  verdade=${JSON.stringify(VERDADE)}\n\n`);

await descarregar();
const v = new OllamaVisionProvider({ model: MODELO, timeout_ms: 180_000 });
const linhas: any[] = [];
for (const [rotuloImg, png] of [
  ["canvas(novo)", canvasNovo],
  ["dom(evidencia)", domAntigo],
] as const) {
  for (const goal of GOALS) {
    const t = Date.now();
    let o: any = null;
    let err = "";
    try {
      o = await v.locate({ screenshot: png, goal, viewport: { width: 1280, height: 800 } });
    } catch (e) {
      err = (e as Error).message;
    }
    const ms = Date.now() - t;
    const b = o?.box ?? null;
    const cx = b === null ? null : b.x + b.width / 2;
    const cy = b === null ? null : b.y + b.height / 2;
    const erro = cx === null ? null : Math.hypot(cx - VERDADE.cx, cy! - VERDADE.cy);
    const dentro =
      cx === null ? null : cx >= VERDADE.x && cx <= VERDADE.x + VERDADE.w && cy! >= VERDADE.y && cy! <= VERDADE.y + VERDADE.h;
    linhas.push({ imagem: rotuloImg, goal, ms, box: b, centro: cx === null ? null : { x: Math.round(cx), y: Math.round(cy!) }, conf: o?.confidence ?? null, erro_px: erro === null ? null : Number(erro.toFixed(1)), dentro, erro: err });
    process.stdout.write(
      `${rotuloImg.padEnd(15)} ${goal.padEnd(42)} ${String(ms).padStart(6)}ms conf=${o?.confidence ?? "-"} ` +
        `box=${b === null ? "-" : `${b.x},${b.y},${b.width},${b.height}`} centro=${cx === null ? "-" : `${Math.round(cx)},${Math.round(cy!)}`} ` +
        `erro=${erro === null ? "-" : `${erro.toFixed(1)}px`} DENTRO=${dentro === null ? "-" : dentro ? "SIM" : "NAO"}${err === "" ? "" : ` ERRO=${err}`}\n`,
    );
  }
}
await descarregar();
fs.writeFileSync(path.join(OUT, "diag-visao.json"), JSON.stringify({ verdade: VERDADE, modelo: MODELO, linhas }, null, 2));
process.exit(0);
