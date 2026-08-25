/** FASE 6 — o que a trilha permite (e não permite) reconstruir. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const FIX = path.join(AQUI, "../10-e2e/fixtures");
const srv = http.createServer((q, r) => { const p = path.join(FIX, path.basename((q.url ?? "/loja.html").split("?")[0] || "loja.html")); if (!fs.existsSync(p)) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(fs.readFileSync(p)); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}`;
const d: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "sessions") } as never);
const BASE = `http://127.0.0.1:${d.port}`; const TOKEN = d.token ?? null;
const H = (e: any = {}) => ({ ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...e });
const post = async (r: string, b: any) => { const x = await fetch(BASE + r, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(b) }); return { status: x.status, env: await x.json().catch(() => null) as any }; };
const CAPS = { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false };
const s = await post("/api/v1/sessions", { owner: "AUDITOR-A", capabilities: CAPS, headless: true });
const SID = s.env.session_id ?? s.env.id;
await post("/api/v1/browser.open", { session_id: SID, url: `${FURL}/loja.html` });
// 1) ação negada por capability (deve virar linha de auditoria de decisão de política)
const neg = await post("/api/v1/browser.download", { session_id: SID, url: `${FURL}/arquivo.txt` });
// 2) multi-aba: qual página recebeu a ação?
const nt = await post("/api/v1/browser.new_tab", { session_id: SID, url: `${FURL}/artigo.html` });
await post("/api/v1/browser.extract", { session_id: SID, target: { selector: "#fato" } });
// 3) handoff e takeover
const ho = await post(`/api/v1/sessions/${SID}/handoff`, { to_owner: "AUDITOR-B" });
const tk = await post(`/api/v1/sessions/${SID}/takeover`, { by: "humano" });
const rl = await post(`/api/v1/sessions/${SID}/release`, {});
await post("/api/v1/browser.click", { session_id: SID, target: { selector: "#comprar" } });
await new Promise((r) => setTimeout(r, 400));
const arq = path.join(OUT, "sessions", SID, "actions.jsonl");
const linhas = fs.existsSync(arq) ? fs.readFileSync(arq, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const bruto = JSON.stringify(linhas);
const rel = {
  linhas: linhas.length,
  chaves: [...new Set(linhas.flatMap((o: any) => Object.keys(o)))],
  actor_distintos: [...new Set(linhas.map((o: any) => o.actor))],
  reconstrui_task: linhas.some((o: any) => String(o.action).includes("task")),
  reconstrui_sessao: linhas.every((o: any) => o.session === SID),
  reconstrui_navegador: /"browser"|"context"|browser_id|context_id/.test(bruto),
  reconstrui_pagina: /page_id|"page"/.test(bruto),
  reconstrui_acao: linhas.every((o: any) => typeof o.action === "string"),
  reconstrui_target: linhas.some((o: any) => o.target !== null),
  reconstrui_resultado: linhas.every((o: any) => o.result !== undefined),
  reconstrui_erro: linhas.some((o: any) => o.result === "error" && o.detail?.code),
  reconstrui_timestamp: linhas.every((o: any) => typeof o.timestamp === "string"),
  reconstrui_actor_provider: linhas.some((o: any) => o.actor && o.actor !== "unknown"),
  reconstrui_policy_decision: linhas.some((o: any) => /CAPABILITY_DENIED/.test(JSON.stringify(o))),
  reconstrui_recovery: /recover|RECOVERING/i.test(bruto),
  reconstrui_handoff: /handoff|takeover|release|control\./i.test(bruto),
  capability_negada_http: neg.status, capability_negada_code: neg.env?.error?.code,
  handoff_http: ho.status, takeover_http: tk.status, release_http: rl.status,
  aba_nova: nt.env?.result?.page_id ?? null,
};
console.log(JSON.stringify(rel, null, 2));
fs.writeFileSync(path.join(OUT, "auditoria.json"), JSON.stringify({ relatorio: rel, linhas }, null, 2));
const faltando = Object.entries(rel).filter(([k, v]) => k.startsWith("reconstrui_") && v === false).map(([k]) => k.replace("reconstrui_", ""));
console.log(`\nAUDIT_CAMPOS_FALTANDO=[${faltando.join(", ")}]`);
console.log(`AUDIT_COMPLETE=${faltando.length === 0 ? "PASS" : "FAIL"}`);
await d.close(); await new Promise<void>((x) => srv.close(() => x())); process.exit(0);
