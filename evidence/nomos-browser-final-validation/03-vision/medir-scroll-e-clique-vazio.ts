/** Isola duas perguntas: (a) o erro de coordenada após scroll assentado; (b) clique em área vazia devolve success=true? */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const HTML = fs.readFileSync(path.join(AQUI, "alvos.html"));
const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(HTML); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}/`;
const d: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "sessions2") } as never);
const BASE = `http://127.0.0.1:${d.port}`; const TOKEN = d.token ?? null;
const H = (e: any = {}) => ({ ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...e });
const post = async (r: string, b: any) => { const x = await fetch(BASE + r, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(b) }); return { status: x.status, env: await x.json().catch(() => null) as any }; };
const s = await post("/api/v1/sessions", { owner: "COORD2", capabilities: { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false }, headless: true });
const SID = s.env.session_id ?? s.env.id;
await post("/api/v1/browser.open", { session_id: SID, url: FURL });
const box = async (id: string) => (await post("/api/v1/browser.find", { session_id: SID, target: { selector: `#${id}` } })).env?.result?.box;
const saida = async (id: string) => { const r = await post("/api/v1/browser.extract", { session_id: SID, target: { selector: `#out-${id}` } }); try { return JSON.parse(String(r.env?.result?.content ?? "")); } catch { return null; } };

// (a) scroll assentado
const sc = await post("/api/v1/browser.scroll", { session_id: SID, dy: 600 });
let antes = await box("a4"), estavel = 0, tent = 0;
while (tent++ < 40) { await new Promise((r) => setTimeout(r, 100)); const b2 = await box("a4"); if (b2 && antes && b2.y === antes.y) { if (++estavel >= 3) break; } else estavel = 0; antes = b2; }
const bA4 = await box("a4");
const cA4 = await post("/api/v1/browser.click", { session_id: SID, target: { selector: "#a4" } });
const eA4 = await saida("a4");
const alvoA4 = { x: bA4.x + bA4.width / 2, y: bA4.y + bA4.height / 2 };
const dA4 = eA4 ? Math.hypot(eA4.clientX - alvoA4.x, eA4.clientY - alvoA4.y) : null;

// (b) clique em coordenada comprovadamente vazia
const vazio = await post("/api/v1/browser.click", { session_id: SID, target: { coordinates: { x: 5, y: 795 } } });
const contagem = await post("/api/v1/browser.extract", { session_id: SID, target: { selector: "#log" } });

// (c) clique em alvo fora do viewport, sem scroll — o runtime deveria rolar ou recusar
const bA5 = await box("a5");
const cA5 = await post("/api/v1/browser.click", { session_id: SID, target: { selector: "#a5" } });
const eA5 = await saida("a5");

const r = {
  scroll_resposta: sc.env?.result ?? sc.env?.error,
  a4_box_apos_assentar: bA4, a4_click_success: cA4.env?.success, a4_evento: eA4 ? { clientX: eA4.clientX, clientY: eA4.clientY, isTrusted: eA4.isTrusted, scrollY: eA4.scrollY } : null,
  a4_erro_px: dA4 === null ? null : Number(dA4.toFixed(3)),
  clique_em_area_vazia_success: vazio.env?.success, clique_em_area_vazia_status: vazio.status, clique_em_area_vazia_verified: vazio.env?.result?.verification?.verified, clique_em_area_vazia_erro: vazio.env?.error?.code ?? null,
  log_apos_clique_vazio: String(contagem.env?.result?.content ?? "").slice(0, 90),
  a5_box: bA5, a5_fora_do_viewport: bA5 ? bA5.y > 800 : null, a5_click_success: cA5.env?.success, a5_recebeu_evento: eA5 !== null,
};
console.log(JSON.stringify(r, null, 2));
fs.writeFileSync(path.join(OUT, "scroll-e-clique-vazio.json"), JSON.stringify(r, null, 2));
await d.close(); await new Promise<void>((x) => srv.close(() => x())); process.exit(0);
