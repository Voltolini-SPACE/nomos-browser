/** FASE 11 — soak e concorrência contra o daemon REAL. Mede vazamento, órfãos e leases. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { execSync } from "node:child_process"; import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(AQUI, "../10-e2e/fixtures");
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
let BASE = "", TOKEN: string | null = null, FURL = "";
const H = (e: Record<string,string> = {}) => ({ ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...e });
const gestao = async (r: string, m = "GET", b?: unknown) => { const x = await fetch(BASE + r, { method: m, headers: H(b === undefined ? {} : { "content-type": "application/json" }), body: b === undefined ? undefined : JSON.stringify(b) }); return { status: x.status, body: (await x.json().catch(() => null)) as any }; };
const acao = async (t: string, b: Record<string, unknown>) => { const x = await fetch(`${BASE}/api/v1/${t}`, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(b) }); return { status: x.status, env: (await x.json().catch(() => null)) as any }; };
const srv = http.createServer((req, res) => { const p = path.join(FIX, path.basename((req.url ?? "/loja.html").split("?")[0] || "loja.html")); if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(p)); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
FURL = `http://127.0.0.1:${(srv.address() as any).port}`;
const daemon: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "sessions") } as never);
BASE = `http://127.0.0.1:${daemon.port}`; TOKEN = daemon.token ?? null;
const PID = process.pid;
const rssMB = () => Math.round(Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) / 1024);
const filhos = () => Number(execSync(`pgrep -P ${PID} 2>/dev/null | wc -l`).toString().trim());
const chromiums = () => Number(execSync(`ps -Ao command | grep -c "[C]hromium.app/Contents/MacOS/Chromium --" || true`).toString().trim() || "0");
const CAPS = { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false };
const amostras: any[] = [];
async function ciclo(tag: string) {
  const s = await gestao("/api/v1/sessions", "POST", { owner: tag, capabilities: CAPS, headless: true });
  const sid = s.body?.session_id ?? s.body?.id; if (!sid) throw new Error(`sem sessão: ${s.status} ${JSON.stringify(s.body)}`);
  await acao("browser.open", { session_id: sid, url: `${FURL}/loja.html` });
  await acao("browser.click", { session_id: sid, target: { role: "button", label: "Adicionar ao carrinho" } });
  await acao("browser.screenshot", { session_id: sid, scope: "viewport" });
  await acao("browser.extract", { session_id: sid, target: { selector: "#resultado" } });
  await gestao(`/api/v1/sessions/${sid}`, "DELETE");
  return sid;
}
process.stdout.write(`daemon=${BASE}\nSOAK: 15 ciclos sequenciais\n`);
const base0 = { rss: rssMB(), filhos: filhos(), chromium: chromiums() };
process.stdout.write(`t0 rss=${base0.rss}MB filhos=${base0.filhos} chromium=${base0.chromium}\n`);
for (let i = 1; i <= 15; i++) {
  const t0 = Date.now(); await ciclo(`soak-${i}`); const ms = Date.now() - t0;
  const a = { ciclo: i, ms, rss: rssMB(), filhos: filhos(), chromium: chromiums(), sessoes_vivas: (await gestao("/api/v1/sessions")).body?.length ?? -1 };
  amostras.push(a); process.stdout.write(`  ciclo ${String(i).padStart(2)} ${String(ms).padStart(5)}ms rss=${a.rss}MB filhos=${a.filhos} chromium=${a.chromium} sessoes=${a.sessoes_vivas}\n`);
}
const cresc = amostras[amostras.length - 1].rss - amostras[0].rss;
const chromResto = amostras[amostras.length - 1].chromium - base0.chromium;
process.stdout.write(`\nSOAK_RSS_INICIO=${amostras[0].rss}MB SOAK_RSS_FIM=${amostras[amostras.length-1].rss}MB DELTA=${cresc}MB\n`);
process.stdout.write(`SOAK_CHROMIUM_RESIDUAL=${chromResto} SOAK_SESSOES_VIVAS_FIM=${amostras[amostras.length-1].sessoes_vivas}\n`);
process.stdout.write(`\nCONCORRENCIA: 4 sessões simultâneas x 5 ações\n`);
const t1 = Date.now();
const conc = await Promise.allSettled([0,1,2,3].map(async (n) => {
  const s = await gestao("/api/v1/sessions", "POST", { owner: `conc-${n}`, capabilities: CAPS, headless: true });
  const sid = s.body?.session_id ?? s.body?.id; if (!sid) throw new Error(`sessão ${n}: ${s.status}`);
  await acao("browser.open", { session_id: sid, url: `${FURL}/loja.html` });
  for (let k = 0; k < 5; k++) { const c = await acao("browser.click", { session_id: sid, target: { role: "button", label: "Adicionar ao carrinho" } }); if (c.env?.success !== true) throw new Error(`sessão ${n} ação ${k}: ${JSON.stringify(c.env?.error)}`); }
  const txt = String((await acao("browser.extract", { session_id: sid, target: { selector: "#resultado" } })).env?.result?.content ?? "");
  await gestao(`/api/v1/sessions/${sid}`, "DELETE");
  return { n, sid, txt };
}));
const okC = conc.filter((c) => c.status === "fulfilled").length;
process.stdout.write(`CONCURRENCY_OK=${okC}/4 em ${Date.now()-t1}ms\n`);
for (const c of conc) if (c.status === "rejected") process.stdout.write(`  falhou: ${(c as any).reason?.message}\n`);
const fim = { rss: rssMB(), filhos: filhos(), chromium: chromiums(), sessoes: (await gestao("/api/v1/sessions")).body?.length ?? -1 };
process.stdout.write(`FIM rss=${fim.rss}MB filhos=${fim.filhos} chromium=${fim.chromium} sessoes_vivas=${fim.sessoes}\n`);
fs.writeFileSync(path.join(OUT, "soak.json"), JSON.stringify({ base0, amostras, conc_ok: okC, fim }, null, 2));
await daemon.close();
await new Promise<void>((r) => srv.close(() => r()));
const depoisFechar = { chromium: chromiums(), filhos: filhos() };
process.stdout.write(`APOS_CLOSE chromium=${depoisFechar.chromium} filhos=${depoisFechar.filhos}\n`);
process.stdout.write(`SOAK_TEST=${cresc < 200 && fim.sessoes === 0 ? "PASS" : "FAIL"} CONCURRENCY_TEST=${okC === 4 ? "PASS" : "FAIL"}\n`);
process.exit(0);
