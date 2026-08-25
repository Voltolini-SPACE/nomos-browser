/**
 * BATERIA E2E INDEPENDENTE — validação final do NOMOS Browser.
 * Não usa nenhum helper da suíte do repositório. Sobe o daemon REAL, fala HTTP
 * REAL, dirige Chromium REAL. Cada cenário registra comando, esperado e observado.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(AQUI, "fixtures");
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });
const DL = path.join(OUT, "downloads");
fs.mkdirSync(DL, { recursive: true });

type Res = { id: string; nome: string; esperado: string; observado: string; passou: boolean; comando: string; ms: number };
const R: Res[] = [];
let BASE = "", TOKEN: string | null = null, FURL = "";

const H = (extra: Record<string, string> = {}) => ({
  ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}), ...extra,
});
async function gestao(rota: string, metodo = "GET", corpo?: unknown) {
  const r = await fetch(BASE + rota, { method: metodo, headers: H(corpo === undefined ? {} : { "content-type": "application/json" }), body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function acao(tool: string, corpo: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/v1/${tool}`, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(corpo) });
  return { status: r.status, env: (await r.json().catch(() => null)) as any };
}
async function cenario(id: string, nome: string, esperado: string, comando: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  let observado = "", passou = false;
  try { observado = await fn(); passou = true; }
  catch (e) { observado = `ERRO: ${(e as Error).message}`; passou = false; }
  const ms = Date.now() - t0;
  R.push({ id, nome, esperado, observado, passou, comando, ms });
  process.stdout.write(`${passou ? "PASS" : "FAIL"}  ${id}  ${nome}  (${ms}ms)\n      esperado: ${esperado}\n      observado: ${observado}\n`);
}
function exigir(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

// ── servidor de fixtures ──
const srv = http.createServer((req, res) => {
  const u = (req.url ?? "/").split("?")[0];
  const nome = u === "/" ? "/loja.html" : u;
  const p = path.join(FIX, path.basename(nome));
  if (!fs.existsSync(p)) { res.writeHead(404); res.end("nao encontrado"); return; }
  const ct = p.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  const extra = p.endsWith(".txt") ? { "content-disposition": 'attachment; filename="nomos-e2e.txt"' } : {};
  res.writeHead(200, { "content-type": ct, ...extra });
  res.end(fs.readFileSync(p));
});

const daemon: any = await (async () => {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const a = srv.address() as any; FURL = `http://127.0.0.1:${a.port}`;
  return await startDaemon({
    port: 0, headless: true, allow_internal_urls: true,
    sessions_root: path.join(OUT, "sessions"),
    download_root: DL, upload_root: FIX,
  } as never);
})();
BASE = `http://127.0.0.1:${daemon.port}`;
TOKEN = daemon.token ?? null;
process.stdout.write(`daemon=${BASE} fixtures=${FURL} token=${TOKEN === null ? "NENHUM" : "presente"}\n\n`);

const CAPS = { navigate: true, read: true, click: true, type: true, download: true, upload: true, send: false, purchase: false, payment: false, delete: false };
const s = await gestao("/api/v1/sessions", "POST", { owner: "VALIDACAO-FINAL", capabilities: CAPS, headless: true });
exigir(s.status === 201 || s.status === 200, `criar sessão devolveu ${s.status}: ${JSON.stringify(s.body).slice(0, 300)}`);
const SID: string = s.body.session_id ?? s.body.id;
process.stdout.write(`sessao=${SID}\n\n`);

// ── E2E-01: abrir → localizar → clicar → validar resultado ──
await cenario("E2E-01", "abrir site, localizar elemento, clicar, validar", "carrinho passa a '1 item' e isTrusted=true",
  `POST /api/v1/browser.open {url:${FURL}/loja.html} ; browser.find ; browser.click ; browser.extract`, async () => {
    const o = await acao("browser.open", { session_id: SID, url: `${FURL}/loja.html` });
    exigir(o.status === 200 && o.env.success === true, `open ${o.status} ${JSON.stringify(o.env?.error)}`);
    const f = await acao("browser.find", { session_id: SID, target: { role: "button", label: "Adicionar ao carrinho" } });
    exigir(f.env.success === true, `find falhou: ${JSON.stringify(f.env?.error)}`);
    const c = await acao("browser.click", { session_id: SID, target: { role: "button", label: "Adicionar ao carrinho" }, verification: { kind: "TEXT_CHANGED", expect: "1 item", timeout_ms: 4000 } });
    exigir(c.env.success === true, `click falhou: ${JSON.stringify(c.env?.error)}`);
    exigir(c.env.result?.verification?.verified === true, `verificacao NAO confirmou: ${JSON.stringify(c.env.result?.verification)}`);
    const x = await acao("browser.extract", { session_id: SID, target: { selector: "#resultado" } });
    const txt = String(x.env?.result?.content ?? "");
    exigir(txt.includes("1 item"), `extract devolveu: ${txt}`);
    exigir(txt.includes("isTrusted=true"), `EVENTO NAO CONFIAVEL: ${txt}`);
    return `find.verified=${f.env.result?.verified} click.verified=${c.env.result?.verification?.verified} extract="${txt}"`;
  });

// ── E2E-02: pesquisar, navegar por resultados, extrair ──
await cenario("E2E-02", "navegar por resultados e extrair informação", "extrai NOMOS-E2E-ARTIGO-7391 do artigo",
  `browser.goto busca.html ; browser.click #r1 ; browser.extract #fato`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/busca.html` });
    const c = await acao("browser.click", { session_id: SID, target: { selector: "#r1" } });
    exigir(c.env.success === true, `click ${JSON.stringify(c.env?.error)}`);
    await acao("browser.wait", { session_id: SID, condition: "text_present", value: "NOMOS-E2E-ARTIGO", timeout_ms: 5000 }).catch(() => null);
    const x = await acao("browser.extract", { session_id: SID, target: { selector: "#fato" } });
    const txt = String(x.env?.result?.content ?? "");
    exigir(txt.includes("NOMOS-E2E-ARTIGO-7391"), `extract: ${txt}`);
    const b = await acao("browser.back", { session_id: SID });
    exigir(String(b.env?.result?.url ?? "").includes("busca.html"), `back foi para ${b.env?.result?.url}`);
    return `artigo="${txt.slice(0, 70)}" back.url=${b.env?.result?.url}`;
  });

// ── E2E-03: preencher formulário, validar, cancelar antes de qualquer ação externa ──
await cenario("E2E-03", "preencher formulário, validar campos, cancelar", "campos preenchidos e depois CANCELADO, sem envio",
  `browser.goto formulario.html ; browser.type #nome ; browser.type #email ; browser.click #cancelar`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/formulario.html` });
    const t1 = await acao("browser.type", { session_id: SID, target: { selector: "#nome" }, text: "Validacao Final", verification: { kind: "DOM_CHANGED", timeout_ms: 3000 } });
    exigir(t1.env.success === true, `type nome ${JSON.stringify(t1.env?.error)}`);
    const t2 = await acao("browser.type", { session_id: SID, target: { selector: "#email" }, text: "teste@nomos.local" });
    exigir(t2.env.success === true, `type email ${JSON.stringify(t2.env?.error)}`);
    const v1 = await acao("browser.extract", { session_id: SID, target: { selector: "#nome" }, format: "value" });
    const c = await acao("browser.click", { session_id: SID, target: { selector: "#cancelar" } });
    exigir(c.env.success === true, `cancelar ${JSON.stringify(c.env?.error)}`);
    const saida = String((await acao("browser.extract", { session_id: SID, target: { selector: "#saida" } })).env?.result?.content ?? "");
    exigir(saida.trim() === "CANCELADO", `saida=${saida}`);
    return `nome.verified=${t1.env.result?.verification?.verified} valor_lido=${JSON.stringify(v1.env?.result?.content)} saida=${saida.trim()}`;
  });

// ── E2E-04: página dinâmica / SPA ──
await cenario("E2E-04", "SPA com conteúdo tardio", "wait resolve e o conteúdo tardio aparece",
  `browser.goto spa.html ; browser.click #ir ; browser.wait text_present`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/spa.html` });
    const c = await acao("browser.click", { session_id: SID, target: { selector: "#ir" } });
    exigir(c.env.success === true, `click ${JSON.stringify(c.env?.error)}`);
    const w = await acao("browser.wait", { session_id: SID, condition: "text_present", value: "NOMOS-SPA-OK", timeout_ms: 8000 });
    exigir(w.env.success === true, `wait ${JSON.stringify(w.env?.error)}`);
    const txt = String((await acao("browser.extract", { session_id: SID, target: { selector: "#app" } })).env?.result?.content ?? "");
    exigir(txt.includes("NOMOS-SPA-OK"), `app=${txt}`);
    return `wait=${w.env.result?.waited_ms}ms app="${txt}"`;
  });

// ── E2E-05: multi-aba ──
await cenario("E2E-05", "multi-aba: abrir, listar, trocar, fechar", "2 abas, troca preserva estado, fecha volta a 1",
  `browser.new_tab ; browser.tabs ; browser.switch_tab ; browser.close_tab`, async () => {
    const antes = (await acao("browser.tabs", { session_id: SID })).env?.result ?? [];
    const nt = await acao("browser.new_tab", { session_id: SID, url: `${FURL}/artigo.html` });
    exigir(nt.env.success === true, `new_tab ${JSON.stringify(nt.env?.error)}`);
    const novoId = nt.env.result.page_id;
    const lista = (await acao("browser.tabs", { session_id: SID })).env?.result ?? [];
    exigir(lista.length === antes.length + 1, `abas: ${antes.length} -> ${lista.length}`);
    const primeiro = antes[0]?.page_id ?? lista[0].page_id;
    const sw = await acao("browser.switch_tab", { session_id: SID, page_id: primeiro });
    exigir(sw.env.success === true, `switch ${JSON.stringify(sw.env?.error)}`);
    const sw2 = await acao("browser.switch_tab", { session_id: SID, page_id: novoId });
    const txt = String((await acao("browser.extract", { session_id: SID, target: { selector: "#fato" } })).env?.result?.content ?? "");
    exigir(txt.includes("7391"), `aba nova perdeu estado: ${txt}`);
    const cl = await acao("browser.close_tab", { session_id: SID, page_id: novoId });
    exigir(cl.env.success === true, `close ${JSON.stringify(cl.env?.error)}`);
    const depois = (await acao("browser.tabs", { session_id: SID })).env?.result ?? [];
    exigir(depois.length === antes.length, `abas apos fechar: ${depois.length}`);
    return `abas ${antes.length}->${lista.length}->${depois.length}; switch_volta.url=${sw2.env?.result?.url}`;
  });

// ── E2E-06: download real ──
await cenario("E2E-06", "download real para dentro da raiz permitida", "arquivo gravado em download_root com o conteúdo certo",
  `browser.goto loja.html ; browser.download {target:#baixar}`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/loja.html` });
    const d = await acao("browser.download", { session_id: SID, target: { selector: "#baixar" }, timeout_ms: 20000 });
    exigir(d.env.success === true, `download ${d.status} ${JSON.stringify(d.env?.error)}`);
    const dest = d.env.result.destination as string;
    exigir(fs.existsSync(dest), `destino inexistente: ${dest}`);
    const conteudo = fs.readFileSync(dest, "utf8").trim();
    exigir(conteudo.includes("NOMOS-E2E-DOWNLOAD-OK"), `conteudo=${conteudo}`);
    exigir(path.resolve(dest).startsWith(path.resolve(DL)), `gravou FORA da raiz: ${dest}`);
    return `destino=${dest} bytes=${fs.statSync(dest).size} conteudo="${conteudo}"`;
  });

// ── E2E-07: upload com fixture ──
await cenario("E2E-07", "upload de arquivo de fixture", "input recebe o arquivo e a página confirma o nome",
  `browser.goto formulario.html ; browser.upload {path:upload-fixture.txt, target:#arquivo}`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/formulario.html` });
    const u = await acao("browser.upload", { session_id: SID, target: { selector: "#arquivo" }, path: path.join(FIX, "upload-fixture.txt") });
    exigir(u.env.success === true, `upload ${u.status} ${JSON.stringify(u.env?.error)}`);
    const nome = String((await acao("browser.extract", { session_id: SID, target: { selector: "#nomearquivo" } })).env?.result?.content ?? "");
    exigir(nome.includes("upload-fixture.txt"), `pagina viu: ${nome}`);
    return `upload_id=${u.env.result.upload_id} pagina="${nome.trim()}"`;
  });

// ── E2E-07b: upload FORA da raiz deve ser negado ──
await cenario("E2E-07b", "upload fora da raiz é negado (controle negativo)", "erro UPLOAD_DENIED, nenhum arquivo enviado",
  `browser.upload {path:/etc/hosts}`, async () => {
    const u = await acao("browser.upload", { session_id: SID, target: { selector: "#arquivo" }, path: "/etc/hosts" });
    exigir(u.env.success !== true, `ACEITOU upload fora da raiz: ${JSON.stringify(u.env)}`);
    return `status=${u.status} code=${u.env?.error?.code}`;
  });

// ── E2E-08: falha durante a tarefa → continuidade ──
await cenario("E2E-08", "falha no meio da tarefa e continuidade da sessão", "erro tratado e sessão segue utilizável",
  `browser.click alvo inexistente ; depois browser.click alvo válido`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/loja.html` });
    const ruim = await acao("browser.click", { session_id: SID, target: { selector: "#nao-existe-mesmo" }, timeout_ms: 3000 });
    exigir(ruim.env.success !== true, `clicou em alvo inexistente: ${JSON.stringify(ruim.env)}`);
    const info = await gestao(`/api/v1/sessions/${SID}`);
    const bom = await acao("browser.click", { session_id: SID, target: { role: "button", label: "Adicionar ao carrinho" } });
    exigir(bom.env.success === true, `sessão nao se recuperou: ${JSON.stringify(bom.env?.error)}`);
    const txt = String((await acao("browser.extract", { session_id: SID, target: { selector: "#resultado" } })).env?.result?.content ?? "");
    exigir(txt.includes("1 item"), `pos-falha: ${txt}`);
    return `falha.code=${ruim.env?.error?.code} sessao.state=${info.body?.state} recuperou=SIM resultado="${txt}"`;
  });

// ── E2E-09: NOMOS/Gi → browser ──
await cenario("E2E-09", "caminho NOMOS/Gi → runtime → resultado", "existe um cliente NOMOS que dirige o runtime",
  `busca por adaptador NOMOS no código de produção`, async () => {
    const raiz = path.resolve(AQUI, "../../..");
    const { execSync } = await import("node:child_process");
    const saida = execSync(
      `grep -rniE "(fetch|axios|http\\.request|new WebSocket|connect)\\(" ${raiz}/packages --include='*.ts' | grep -viE "127\\.0\\.0\\.1:11434|localhost|test" | head -20 || true`,
      { encoding: "utf8" });
    const adaptador = fs.existsSync(path.join(raiz, "packages/nomos")) || fs.existsSync(path.join(raiz, "packages/integrations"));
    exigir(adaptador, `nenhum pacote de integração NOMOS/Gi existe. Chamadas externas encontradas: ${saida.trim().slice(0, 300) || "(nenhuma)"}`);
    return "adaptador encontrado";
  });

// ── E2E-10: visão quando o DOM não basta ──
await cenario("E2E-10", "visão quando DOM/acessibilidade não bastam", "runtime resolve alvo em <canvas> pelo degrau `vision` e clica dentro dele",
  `browser.goto vision.html ; browser.find {semantic:'botao vermelho COMPRAR'} (cascata deve chegar em vision)`, async () => {
    await acao("browser.goto", { session_id: SID, url: `${FURL}/vision.html` });
    const f = await acao("browser.find", { session_id: SID, target: { semantic: "o botao vermelho escrito COMPRAR" }, timeout_ms: 60000 });
    const det = JSON.stringify(f.env?.error?.detail ?? f.env?.result ?? {});
    if (f.env.success !== true) throw new Error(`cascata nao resolveu o alvo visual. status=${f.status} code=${f.env?.error?.code} detalhe=${det.slice(0, 400)}`);
    exigir(f.env.result?.strategy === "vision", `resolveu por '${f.env.result?.strategy}', nao por visao`);
    const c = await acao("browser.click", { session_id: SID, target: { semantic: "o botao vermelho escrito COMPRAR" }, timeout_ms: 60000 });
    exigir(c.env.success === true, `click por visão: ${JSON.stringify(c.env?.error)}`);
    const txt = String((await acao("browser.extract", { session_id: SID, target: { selector: "#clicado" } })).env?.result?.content ?? "");
    const m = txt.match(/clique em (\d+),(\d+)/);
    exigir(m !== null, `nao registrou clique: ${txt}`);
    const [x, y] = [Number(m[1]), Number(m[2])];
    exigir(x >= 400 && x <= 560 && y >= 120 && y <= 220, `clique caiu FORA do alvo (400..560, 120..220): ${x},${y}`);
    return `estrategia=${f.env.result?.strategy} clique=${x},${y} dentro=SIM`;
  });

// ── auditoria da bateria ──
const sessDir = path.join(OUT, "sessions", SID);
const audit = path.join(sessDir, "actions.jsonl");
const linhas = fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean) : [];
await cenario("E2E-AUD", "trilha auditável da bateria inteira", "actions.jsonl com todas as ações e sem segredo",
  `leitura de ${audit}`, async () => {
    exigir(linhas.length > 20, `audit tem só ${linhas.length} linhas`);
    const bruto = linhas.join("\n").toLowerCase();
    exigir(!bruto.includes("set-cookie") && !bruto.includes("authorization"), "audit contem cabecalho sensivel");
    const campos = JSON.parse(linhas[0]);
    return `linhas=${linhas.length} campos=[${Object.keys(campos).join(",")}]`;
  });

fs.writeFileSync(path.join(OUT, "e2e-resultados.json"), JSON.stringify({ base: BASE, sessao: SID, quando: new Date().toISOString(), resultados: R }, null, 2));
const ok = R.filter((r) => r.passou).length;
process.stdout.write(`\nE2E_TOTAL=${R.length} E2E_PASS=${ok} E2E_FAIL=${R.length - ok}\n`);
process.stdout.write(`BROWSER_E2E_SUITE=${ok === R.length ? "PASS" : "FAIL"}\n`);
for (const r of R) if (!r.passou) process.stdout.write(`FALHOU ${r.id}: ${r.observado}\n`);
await gestao(`/api/v1/sessions/${SID}`, "DELETE").catch(() => null);
await daemon.close();
await new Promise<void>((r) => srv.close(() => r()));
process.exit(ok === R.length ? 0 : 1);
