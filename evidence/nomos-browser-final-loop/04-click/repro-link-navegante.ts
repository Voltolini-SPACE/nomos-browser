/**
 * REPRODUTOR MINIMO — FASE 4b
 *
 * Regressao introduzida pela FASE 4: clicar num `<a href>` que NAVEGA devolve
 * CLICK_NOT_DELIVERED mesmo tendo funcionado. A prova de entrega (listener de
 * captura em `document`) perde a corrida com a destruicao do contexto de
 * execucao provocada pela propria navegacao.
 *
 * Quatro casos, um por linha do relatorio:
 *   LINK_NAVEGA   `<a href="/destino.html">`  — TEM de entregar
 *   LINK_ANCORA   `<a href="#fim">`           — nao destroi contexto: a SONDA
 *                                               tem de continuar sendo a prova
 *   LINK_BLANK    `<a target="_blank">`       — abre aba: TEM de entregar
 *   VAZIO_SEM_NAV clique em coordenada vazia numa pagina que NAO navega —
 *                 CONTROLE NEGATIVO: nao pode virar "navegacao"
 *
 * Nao altera nada do produto; so mede.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });

const PAGINAS: Record<string, string> = {
  "/origem.html": `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>origem</title></head><body>
<h1>Origem</h1>
<p><a id="link" href="/destino.html">ir para o destino</a></p>
<p><a id="ancora" href="#fim">ir para a ancora</a></p>
<p><a id="blank" href="/destino.html" target="_blank">abrir em nova aba</a></p>
<div style="height:1600px"></div><h2 id="fim">fim</h2>
</body></html>`,
  "/destino.html": `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>destino</title></head><body>
<h1 id="marca">CHEGUEI-NO-DESTINO</h1></body></html>`,
  "/parada.html": `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>parada</title></head><body>
<h1>pagina que nao navega</h1><div style="height:400px"></div></body></html>`,
};

const srv = http.createServer((q, r) => {
  const rota = (q.url ?? "/").split("?")[0]!.split("#")[0]!;
  const html = PAGINAS[rota];
  r.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
  r.end(html ?? "<p>404</p>");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}`;

const d: any = await startDaemon({
  port: 0,
  headless: true,
  allow_internal_urls: true,
  sessions_root: path.join(OUT, "sessions"),
} as never);

const BASE = `http://127.0.0.1:${d.port}`;
const TOKEN = d.token ?? null;
const post = async (rota: string, corpo: unknown): Promise<{ status: number; env: any }> => {
  const x = await fetch(BASE + rota, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(corpo),
  });
  return { status: x.status, env: await x.json().catch(() => null) };
};

const s = await post("/api/v1/sessions", { owner: "REPRO-4B", profile: "sandbox" });
const SID = s.env.session_id;

async function clicar(rota: string, alvo: unknown): Promise<any> {
  await post("/api/v1/browser.goto", { session_id: SID, url: `${FURL}${rota}` });
  const c = await post("/api/v1/browser.click", { session_id: SID, target: alvo });
  const det = c.env?.result?.detail ?? c.env?.error?.detail ?? {};
  return {
    status: c.status,
    success: c.env?.success,
    error_code: c.env?.error?.code ?? null,
    message: c.env?.error?.message ?? null,
    delivery_verified: det.delivery_verified ?? null,
    delivery_evidence: det.delivery_evidence ?? null,
    actionable: det.actionable ?? null,
    elemento_no_ponto: det.elemento_no_ponto ?? null,
    elemento_que_recebeu: det.elemento_que_recebeu ?? null,
    url_antes: det.url_antes ?? null,
    url_depois: det.url_depois ?? null,
  };
}

const LINK_NAVEGA = await clicar("/origem.html", { selector: "#link" });
const abasApos = (await post("/api/v1/browser.tabs", { session_id: SID })).env?.result ?? [];
const urlAtiva = String(abasApos.find((p: any) => p.active)?.url ?? abasApos[0]?.url ?? "");

const LINK_ANCORA = await clicar("/origem.html", { selector: "#ancora" });
const LINK_BLANK = await clicar("/origem.html", { selector: "#blank" });
const abasBlank = (await post("/api/v1/browser.tabs", { session_id: SID })).env?.result ?? [];

const VAZIO_SEM_NAV = await clicar("/parada.html", { coordinates: { x: 4, y: 700 } });

const r = {
  LINK_NAVEGA,
  url_da_aba_ativa_apos_link: urlAtiva,
  chegou_no_destino: urlAtiva.includes("destino.html"),
  LINK_ANCORA,
  LINK_BLANK,
  abas_apos_blank: abasBlank.length,
  VAZIO_SEM_NAV,
  VEREDITO:
    LINK_NAVEGA.success === true &&
    LINK_ANCORA.success === true &&
    LINK_BLANK.success === true &&
    VAZIO_SEM_NAV.success === true &&
    VAZIO_SEM_NAV.delivery_evidence !== "navegacao"
      ? "PASS"
      : "FAIL",
};
console.log(JSON.stringify(r, null, 2));
fs.writeFileSync(path.join(OUT, "repro-link-navegante.json"), JSON.stringify(r, null, 2));
console.log(`\nREPRO_LINK_NAVEGANTE=${r.VEREDITO}`);
await d.close();
await new Promise<void>((x) => srv.close(() => x()));
process.exit(0);
