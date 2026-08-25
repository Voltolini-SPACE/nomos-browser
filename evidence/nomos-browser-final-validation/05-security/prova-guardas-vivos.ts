/** FASE 5 — bateria adversarial contra o daemon REAL (não contra a biblioteca). */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const FIX = path.join(AQUI, "../10-e2e/fixtures");
const DL = path.join(OUT, "dl"); fs.mkdirSync(DL, { recursive: true });
const srv = http.createServer((q, r) => {
  const u = (q.url ?? "/").split("?")[0];
  if (u === "/redirect-interno") { r.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); r.end(); return; }
  const p = path.join(FIX, path.basename(u === "/" ? "loja.html" : u));
  if (!fs.existsSync(p)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain", ...(p.endsWith(".txt") ? { "content-disposition": 'attachment; filename="ok.txt"' } : {}) });
  r.end(fs.readFileSync(p));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}`;
// SEM allow_internal: postura de produção.
const d: any = await startDaemon({ port: 0, headless: true, sessions_root: path.join(OUT, "sessions"), download_root: DL, upload_root: FIX } as never);
const BASE = `http://127.0.0.1:${d.port}`; const TOKEN = d.token ?? null;
const H = (e: any = {}) => ({ ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...e });
const post = async (r: string, b: any, tok = TOKEN) => { const x = await fetch(BASE + r, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b) }); return { status: x.status, env: await x.json().catch(() => null) as any }; };
const CAPS = { navigate: true, read: true, click: true, type: true, download: true, upload: true, send: false, purchase: false, payment: false, delete: false };
const s = await post("/api/v1/sessions", { owner: "ADVERSARIO", capabilities: CAPS, headless: true });
const SID = s.env.session_id ?? s.env.id;
const R: any[] = [];
const bloqueado = (r: any) => r.env?.success !== true;
async function caso(nome: string, esperado: string, fn: () => Promise<any>) {
  let r: any, obs = "", ok = false;
  try { r = await fn(); ok = bloqueado(r); obs = `status=${r.status} code=${r.env?.error?.code ?? "(sem erro)"} success=${r.env?.success}`; }
  catch (e) { ok = true; obs = `lançou: ${(e as Error).message}`; }
  R.push({ nome, esperado, observado: obs, bloqueado: ok });
  console.log(`${ok ? "BLOQUEOU " : "PASSOU!! "} ${nome.padEnd(46)} ${obs}`);
}
await caso("navegar para file:///etc/passwd", "bloqueado", () => post("/api/v1/browser.open", { session_id: SID, url: "file:///etc/passwd" }));
await caso("navegar para javascript: URL", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "javascript:alert(1)" }));
await caso("navegar para chrome://settings", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "chrome://settings" }));
await caso("navegar para devtools://devtools", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "devtools://devtools/bundled/inspector.html" }));
await caso("navegar para data: URL", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "data:text/html,<h1>x" }));
await caso("SSRF metadata 169.254.169.254", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "http://169.254.169.254/latest/meta-data/" }));
await caso("SSRF RFC1918 10.0.0.1", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "http://10.0.0.1/" }));
await caso("SSRF localhost (sem allow_internal)", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: `${FURL}/loja.html` }));
await caso("SSRF via .local", "bloqueado", () => post("/api/v1/browser.goto", { session_id: SID, url: "http://roteador.local/" }));
await caso("upload path traversal ../../etc/passwd", "bloqueado", () => post("/api/v1/browser.upload", { session_id: SID, target: { selector: "#arquivo" }, path: "../../../../etc/passwd" }));
await caso("upload caminho absoluto fora da raiz", "bloqueado", () => post("/api/v1/browser.upload", { session_id: SID, target: { selector: "#arquivo" }, path: "/etc/hosts" }));
await caso("download com url file://", "bloqueado", () => post("/api/v1/browser.download", { session_id: SID, url: "file:///etc/passwd" }));
await caso("capability negada: send", "bloqueado", () => post("/api/v1/browser.send", { session_id: SID }));
await caso("token ausente", "bloqueado", () => post("/api/v1/browser.tabs", { session_id: SID }, null));
await caso("token errado", "bloqueado", () => post("/api/v1/browser.tabs", { session_id: SID }, "token-invalido-123"));
await caso("session_id de outra sessão inexistente", "bloqueado", () => post("/api/v1/browser.tabs", { session_id: "ses_naoexiste" }));
const passou = R.filter((r) => !r.bloqueado);
fs.writeFileSync(path.join(OUT, "guardas.json"), JSON.stringify(R, null, 2));
console.log(`\nADVERSARIAL_TOTAL=${R.length} BLOQUEADOS=${R.length - passou.length} PASSARAM=${passou.length}`);
console.log(`SECURITY_LIVE_GUARDS=${passou.length === 0 ? "PASS" : "FAIL"}`);
for (const p of passou) console.log(`  NAO BLOQUEOU: ${p.nome} -> ${p.observado}`);
await d.close(); await new Promise<void>((x) => srv.close(() => x())); process.exit(0);
