/** FASE 9b — visão medida contra verdade conhecida, com controle negativo. */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { OllamaVisionProvider } from "../../../packages/core/src/vision.ts";
import { OllamaProvider } from "../../../packages/core/src/providers/ollama.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const desc = async (m: string) => { try { await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model: m, keep_alive: 0 }), signal: AbortSignal.timeout(20000) }); } catch {} };

// screenshot NOVO, tirado pelo próprio runtime com a página no topo (scroll 0),
// para que a verdade do DOM valha para a imagem entregue ao modelo.
import http from "node:http";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
const HTMLFIX = fs.readFileSync(path.join(AQUI, "../03-vision/alvos.html"));
const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTMLFIX); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FU = `http://127.0.0.1:${(srv.address() as any).port}/`;
const dd: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "shot-sessions") } as never);
const BB = `http://127.0.0.1:${dd.port}`; const TT = dd.token ?? null;
const pp = async (r: string, b: any) => { const x = await fetch(BB + r, { method: "POST", headers: { "content-type": "application/json", ...(TT ? { authorization: `Bearer ${TT}` } : {}) }, body: JSON.stringify(b) }); return await x.json().catch(() => null) as any; };
const ss = await pp("/api/v1/sessions", { owner: "SHOT", capabilities: { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false }, headless: true });
const SSID = ss.session_id ?? ss.id;
await pp("/api/v1/browser.open", { session_id: SSID, url: FU });
const conf = await pp("/api/v1/browser.find", { session_id: SSID, target: { selector: "#a2" } });
await pp("/api/v1/browser.screenshot", { session_id: SSID, scope: "viewport" });
await dd.close(); await new Promise<void>((r) => srv.close(() => r()));
const sdir = path.join(OUT, "shot-sessions", SSID, "screenshots");
const sf = fs.readdirSync(sdir).find((x) => x.endsWith(".png"))!;
const shot = path.join(sdir, sf);
const PNG = fs.readFileSync(shot);
console.log(`screenshot=${shot} bytes=${PNG.length} caixa_do_alvo_no_momento=${JSON.stringify(conf?.result?.box)}`);
const VERDADE = { x: 400, y: 120, w: 160, h: 100, cx: 480, cy: 170 };
const R: any[] = [];
for (const model of ["qwen2.5vl:3b", "moondream:1.8b"]) {
  await desc(model);
  const v = new OllamaVisionProvider({ model, timeout_ms: 120_000 });
  for (const [rotulo, goal, existe] of [["alvo real", "o botao azul escrito COMPRAR", true], ["controle negativo", "o botao verde escrito FINALIZAR PEDIDO AGORA", false]] as const) {
    const t = Date.now(); let o: any = null, erro = "";
    try { o = await v.locate({ screenshot: PNG, goal, viewport: { width: 1280, height: 800 } }); } catch (e) { erro = (e as Error).message; }
    const ms = Date.now() - t;
    const b = o?.box ?? o?.boundingBox ?? null;
    const cx = b ? b.x + b.width / 2 : null, cy = b ? b.y + b.height / 2 : null;
    const err = cx === null ? null : Math.hypot(cx - VERDADE.cx, cy - VERDADE.cy);
    const areaFrac = b ? (b.width * b.height) / (1280 * 800) : null;
    const dentro = cx === null ? null : cx >= VERDADE.x && cx <= VERDADE.x + VERDADE.w && cy! >= VERDADE.y && cy! <= VERDADE.y + VERDADE.h;
    const correto = existe ? dentro === true : o === null || (o?.confidence ?? 0) < 0.7;
    R.push({ model, rotulo, goal, ms, achou: o !== null, confianca: o?.confidence ?? null, box: b, centro: cx === null ? null : { x: Math.round(cx), y: Math.round(cy!) }, erro_px: err === null ? null : Number(err.toFixed(1)), fracao_da_tela: areaFrac === null ? null : Number(areaFrac.toFixed(3)), clicaria_dentro: dentro, comportamento_correto: correto, erro });
    console.log(`${model.padEnd(16)} ${rotulo.padEnd(18)} ${String(ms).padStart(6)}ms achou=${o !== null} conf=${o?.confidence ?? "-"} centro=${cx === null ? "-" : Math.round(cx) + "," + Math.round(cy!)} erro=${err === null ? "-" : err.toFixed(1) + "px"} area=${areaFrac === null ? "-" : (areaFrac * 100).toFixed(0) + "%"} correto=${correto}`);
  }
  await desc(model);
}
// provider de texto com think desligado — controle justo
await desc("qwen3.5:4b-q8_0");
const p = new OllamaProvider({ model: "qwen3.5:4b-q8_0", timeout_ms: 120_000, keep_alive: 0, think: false });
const t0 = Date.now(); const r1 = await p.request({ prompt: "Responda apenas com a palavra PRONTO.", max_tokens: 64, temperature: 0 }); const l1 = Date.now() - t0;
const t1 = Date.now(); const r2 = await p.request({ prompt: "Responda apenas com a palavra PRONTO.", max_tokens: 64, temperature: 0 }); const l2 = Date.now() - t1;
R.push({ model: "qwen3.5:4b-q8_0", rotulo: "texto com think:false", ok1: r1.ok, ok2: r2.ok, frio_ms: l1, quente_ms: l2, erro: r1.ok ? null : (r1 as any).error, classe: r1.ok && r2.ok ? (Math.max(l1, l2) > 60000 ? "PROVIDER_DEGRADED" : "PROVIDER_PASS") : "PROVIDER_FAIL" });
console.log(`qwen3.5 think:false  ok=${r1.ok}/${r2.ok} frio=${l1}ms quente=${l2}ms`);
await desc("qwen3.5:4b-q8_0");
fs.writeFileSync(path.join(OUT, "visao-verdade.json"), JSON.stringify({ verdade: VERDADE, screenshot: shot, resultados: R }, null, 2));
process.exit(0);
