/**
 * REPRODUTOR MÍNIMO — `browser.scroll` responde `success:true` e a página não
 * se move NO INSTANTE seguinte.
 *
 * Pergunta que este arquivo responde, e nenhuma outra: depois de um
 * `browser.scroll` bem-sucedido, `window.scrollY` chega a mudar? Em quanto
 * tempo? Se nunca muda, é defeito do produto; se muda em ~X ms, o instrumento
 * do soak lia cedo demais e o defeito era meu.
 *
 * Uso: node evidence/nomos-browser-final-loop/20-soak/out/repro-scroll.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "repro-scroll-"));
const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>scroll</title></head><body>
<div id="eco-scroll">SCROLL-0</div>
<div style="height:4000px">espaco</div>
<script>
window.addEventListener('scroll', function () {
  document.getElementById('eco-scroll').textContent = 'SCROLL-' + Math.round(window.scrollY);
}, { passive: true });
</script></body></html>`;

const srv = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(PAGINA);
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const rt = path.join(TMP, "rt");
const ss = path.join(TMP, "sessoes");
const pf = path.join(TMP, "perfis");
for (const d of [rt, ss, pf]) fs.mkdirSync(d, { recursive: true });

const proc = spawn(process.execPath, [path.join(RAIZ, "packages/api/src/daemon.ts")], {
  cwd: RAIZ,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    NOMOS_RUNTIME_DIR: rt,
    NOMOS_SESSIONS_ROOT: ss,
    NOMOS_BROWSER_PROFILES_ROOT: pf,
    NOMOS_BROWSER_PORT: "0",
    NOMOS_BROWSER_HOST: "127.0.0.1",
    NOMOS_BROWSER_HEADLESS: "true",
    NOMOS_BROWSER_ALLOW_INTERNAL: "true",
  },
});
let err = "";
const url = await new Promise<string>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`daemon não subiu: ${err.slice(-800)}`)), 120_000);
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (d: string) => {
    err += d;
    const m = /nomos-browser em (http:\/\/\S+)/.exec(err);
    if (m !== null) {
      clearTimeout(t);
      res(m[1]!);
    }
  });
});
const token = fs.readFileSync(path.join(rt, "control-token"), "utf8").trim();
const cab = { "content-type": "application/json", authorization: `Bearer ${token}` };
const post = async (rota: string, corpo: unknown): Promise<any> =>
  (await fetch(`${url}${rota}`, { method: "POST", headers: cab, body: JSON.stringify(corpo) })).json();

const sess = await post("/api/v1/sessions", {
  owner: "REPRO-SCROLL",
  profile: "sandbox",
  headless: true,
  capabilities: { navigate: true, read: true, click: true, type: true },
});
const sid = sess.session_id as string;
await post("/api/v1/browser.open", { session_id: sid, url: base });

const ler = async (): Promise<string> => {
  const r = await post("/api/v1/browser.extract", { session_id: sid, target: { selector: "#eco-scroll" }, format: "text" });
  return String(r.result?.content ?? `ERRO:${JSON.stringify(r.error)}`);
};

console.log(`antes do scroll: ${await ler()}`);
const t0 = Date.now();
const r = await post("/api/v1/browser.scroll", { session_id: sid, dy: 1400 });
console.log(`browser.scroll → success=${String(r.success)} scrolled=${JSON.stringify(r.result?.scrolled)} at=${JSON.stringify(r.result?.at)} backend=${String(r.result?.backend)} em ${Date.now() - t0}ms`);
for (const espera of [0, 50, 100, 250, 500, 1000, 2000, 4000]) {
  await dormir(espera === 0 ? 0 : espera - (Date.now() - t0 - 0));
  console.log(`  t≈${String(Date.now() - t0).padStart(5)}ms  ${await ler()}`);
}

// Segundo scroll, para saber se o PRIMEIRO é especial (foco/gesto inicial).
const t1 = Date.now();
const r2 = await post("/api/v1/browser.scroll", { session_id: sid, dy: 1400 });
console.log(`segundo browser.scroll → success=${String(r2.success)} em ${Date.now() - t1}ms`);
await dormir(1500);
console.log(`  depois do segundo: ${await ler()}`);

await fetch(`${url}/api/v1/sessions/${sid}`, { method: "DELETE", headers: cab, body: JSON.stringify({ reason: "fim" }) });
proc.kill("SIGTERM");
await dormir(2000);
proc.kill("SIGKILL");
srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
