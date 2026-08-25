/** FASE 3 — pipeline visual e coordenadas, medido contra verdade do DOM. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { pngDimensions } from "../../../packages/observability/src/png.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const HTML = fs.readFileSync(path.join(AQUI, "alvos.html"));
const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}/`;
const d: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "sessions") } as never);
const BASE = `http://127.0.0.1:${d.port}`; const TOKEN = d.token ?? null;
const H = (e: any = {}) => ({ ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...e });
const post = async (r: string, b: any) => { const x = await fetch(BASE + r, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(b) }); return { status: x.status, env: await x.json().catch(() => null) as any }; };
const s = await post("/api/v1/sessions", { owner: "COORD", capabilities: { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false }, headless: true });
const SID = s.env.session_id ?? s.env.id;
await post("/api/v1/browser.open", { session_id: SID, url: FURL });

const medidas: any[] = [];
async function medir(id: string, rotulo: string) {
  const f = await post("/api/v1/browser.find", { session_id: SID, target: { selector: `#${id}` } });
  if (f.env?.success !== true) { medidas.push({ id, rotulo, erro: f.env?.error?.code ?? "find falhou" }); return; }
  const box = f.env.result.box;
  const alvo = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const c = await post("/api/v1/browser.click", { session_id: SID, target: { selector: `#${id}` } });
  const log = await post("/api/v1/browser.extract", { session_id: SID, target: { selector: `#out-${id}` } });
  let ev: any = null; try { ev = JSON.parse(String(log.env?.result?.content ?? "{}")); } catch { /* */ }
  const dx = ev?.clientX !== undefined ? ev.clientX - alvo.x : null;
  const dy = ev?.clientY !== undefined ? ev.clientY - alvo.y : null;
  const dist = dx === null ? null : Math.sqrt(dx * dx + dy * dy);
  medidas.push({ id, rotulo, sem_evento: ev === null || ev.id !== id, ok: c.env?.success === true, box, alvo, evento: ev === null ? null : { clientX: ev.clientX, clientY: ev.clientY, isTrusted: ev.isTrusted, scrollY: ev.scrollY, dpr: ev.dpr, vw: ev.vw, vh: ev.vh }, dx, dy, dist, dentro: ev ? (ev.clientX >= ev.rect.x && ev.clientX <= ev.rect.x + ev.rect.w && ev.clientY >= ev.rect.y && ev.clientY <= ev.rect.y + ev.rect.h) : null });
}
for (const id of ["a1", "a2", "a3", "a6"]) await medir(id, "viewport inicial");
await post("/api/v1/browser.scroll", { session_id: SID, dy: 600 });
for (const id of ["a4"]) await medir(id, "apos scroll 600");
await post("/api/v1/browser.scroll", { session_id: SID, dy: 900 });
for (const id of ["a5"]) await medir(id, "apos scroll 1500");

const shot = await post("/api/v1/browser.screenshot", { session_id: SID, scope: "viewport" });
const ref = shot.env?.result?.screenshot_ref;
const sess = path.join(OUT, "sessions", SID);
const arqs = fs.existsSync(path.join(sess, "screenshots")) ? fs.readdirSync(path.join(sess, "screenshots")) : [];
let dims: any = null;
const png = arqs.find((a) => a.endsWith(".png"));
if (png !== undefined) { try { dims = pngDimensions(fs.readFileSync(path.join(sess, "screenshots", png))); } catch (e) { dims = { erro: (e as Error).message, arquivo: png, bytes: fs.statSync(path.join(sess, "screenshots", png)).size }; } }
else { dims = { erro: "nenhum .png persistido", arquivos: arqs }; }
const ult = medidas.find((m) => m.evento)?.evento ?? {};
const validas = medidas.filter((m) => m.dist !== null && m.dist !== undefined);
const erroMedio = validas.length ? validas.reduce((a, m) => a + m.dist, 0) / validas.length : -1;
const erroMax = validas.length ? Math.max(...validas.map((m) => m.dist)) : -1;
const dentro = medidas.filter((m) => m.dentro === true).length;
const trusted = medidas.filter((m) => m.evento?.isTrusted === true).length;
const rel = {
  alvos: medidas.length, medidos: validas.length,
  erro_medio_px: Number(erroMedio.toFixed(3)), erro_max_px: Number(erroMax.toFixed(3)),
  cliques_dentro_do_alvo: `${dentro}/${medidas.length}`,
  taxa_sucesso: medidas.length ? Number(((dentro / medidas.length) * 100).toFixed(1)) : 0,
  isTrusted_true: `${trusted}/${medidas.length}`,
  dpr: ult.dpr ?? null, viewport: ult.vw ? `${ult.vw}x${ult.vh}` : null,
  screenshot_ref: ref ?? null, screenshot_persistido: arqs.length > 0, screenshot_dims: dims,
  screenshot_bate_com_viewport: dims && ult.vw ? (dims.width === ult.vw * (ult.dpr ?? 1) && dims.height === ult.vh * (ult.dpr ?? 1)) : null,
};
console.log(JSON.stringify({ rel, medidas }, null, 2));
fs.writeFileSync(path.join(OUT, "coordenadas.json"), JSON.stringify({ rel, medidas }, null, 2));
console.log(`\nVISION_COORDINATE_PASS=${rel.taxa_sucesso}%  ERRO_MEDIO=${rel.erro_medio_px}px  ERRO_MAX=${rel.erro_max_px}px`);
console.log(`VISION_ENGINE_CAPABILITY=${rel.taxa_sucesso >= 95 && rel.erro_max_px <= 1 ? "PASS" : "FAIL"}`);
await d.close(); await new Promise<void>((x) => srv.close(() => x())); process.exit(0);
