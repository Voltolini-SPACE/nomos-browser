/**
 * FASE 4 — ANTI-BYPASS. Invariantes do plano de controle, provados por execução.
 *
 * Cada invariante tem CONTROLE POSITIVO (o caminho legítimo funciona) e
 * CONTROLE NEGATIVO (o atalho não funciona). Sem o positivo, "bloqueou" pode ser
 * só o produto quebrado; sem o negativo, "funciona" pode ser só ausência de guarda.
 */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const RAIZ = path.resolve(AQUI, "../../..");
const NOMOS = "/Users/AI/.local/bin/nomos";

type R = { id: string; invariante: string; esperado: string; observado: string; ok: boolean };
const R: R[] = [];
function marcar(id: string, invariante: string, ok: boolean, esperado: string, observado: string) {
  R.push({ id, invariante, esperado, observado, ok });
  console.log(`${ok ? "OK   " : "FALHA"} ${id.padEnd(8)} ${invariante.padEnd(52)} ${observado}`);
}

const PAG = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Alvo</title></head><body><h1 id="t">ALVO</h1><p id="fato">CANARIO-ANTIBYPASS-4417</p><button id="b">Agir</button><div id="eco">intocado</div><script>document.getElementById('b').addEventListener('click',()=>{document.getElementById('eco').textContent='CLICADO'});</script></body></html>`;
const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(PAG); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const FURL = `http://127.0.0.1:${(srv.address() as any).port}/`;

const d: any = await startDaemon({ port: 0, headless: true, allow_internal_urls: true, sessions_root: path.join(OUT, "sessions") } as never);
const BASE = `http://127.0.0.1:${d.port}`;
const ADMIN = d.token as string;
const H = (t: string | null, e: any = {}) => ({ ...(t ? { authorization: `Bearer ${t}` } : {}), ...e });
const req = async (m: string, r: string, b?: any, t: string | null = ADMIN) => {
  const x = await fetch(BASE + r, { method: m, headers: H(t, b === undefined ? {} : { "content-type": "application/json" }), body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: x.status, body: (await x.json().catch(() => null)) as any };
};
const CAPS_LEITURA = { navigate: true, read: true, click: true, type: true, download: false, upload: false, send: false, purchase: false, payment: false, delete: false };

// ── I1. NOMOS é o plano de política: a categoria vem do manifesto, não de quem chama ──
{
  const man = JSON.parse(fs.readFileSync(path.join(RAIZ, "packaging/mcp/manifesto.json"), "utf8"));
  const nivelDe = (t: string) => man.tools[t] ?? man.nivel_padrao;
  const ler = (cat: string, alvo: string) => {
    try { return execFileSync(NOMOS, ["approvals", "testar", cat, alvo], { encoding: "utf8", timeout: 15000 }); }
    catch (e: any) { return String(e?.stdout ?? e?.message ?? e); }
  };
  const mapa: Record<string, string> = { A0: "A0_READ_LOCAL", A1: "A1_WRITE_LOCAL", A2: "A2_NET_EGRESS", A5: "A5_CODE_EXEC" };
  const a0 = ler(mapa[nivelDe("browser_extract")], "mcp:nomos-browser:browser_extract");
  const a2 = ler(mapa[nivelDe("browser_tab_open")], "mcp:nomos-browser:browser_tab_open");
  const okA0 = /ALLOW/.test(a0);
  const okA2 = /REQUIRE_APPROVAL/.test(a2);
  marcar("I1", "NOMOS decide: A0 ALLOW e A2 REQUIRE_APPROVAL", okA0 && okA2,
    "veredito do NOMOS real, por categoria do manifesto",
    `browser_extract(${nivelDe("browser_extract")})=${okA0 ? "ALLOW" : a0.trim().slice(0, 40)} | browser_tab_open(${nivelDe("browser_tab_open")})=${okA2 ? "REQUIRE_APPROVAL" : a2.trim().slice(0, 40)}`);
}

// ── I2. MCP não eleva privilégio: guarda executável + controle negativo ──
{
  // CONSERTO DE INSTRUMENTO: o guarda imprime o veredito de FALHA em stderr.
  // Ler só `stdout` fazia o controle negativo parecer mudo — o teste reprovava
  // um guarda que estava funcionando. Capturo os dois canais.
  const rodarGuarda = (): { saida: string; rc: number } => {
    try {
      const o = execFileSync("node", [path.join(RAIZ, "scripts/verificar-risco-mcp.ts")], { encoding: "utf8", cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"] });
      return { saida: String(o), rc: 0 };
    } catch (e: any) {
      return { saida: `${String(e?.stdout ?? "")}${String(e?.stderr ?? "")}`, rc: e?.status ?? 1 };
    }
  };
  const okRun = rodarGuarda();
  const saidaOk = okRun.saida, rcOk = okRun.rc;
  const manPath = path.join(RAIZ, "packaging/mcp/manifesto.json");
  const original = fs.readFileSync(manPath, "utf8");
  const m = JSON.parse(original); m.tools.browser_tab_open = "A0";
  fs.writeFileSync(manPath, JSON.stringify(m, null, 2) + "\n");
  const malRun = rodarGuarda();
  const saidaMal = malRun.saida, rcMal = malRun.rc;
  fs.writeFileSync(manPath, original);
  const restaurado = fs.readFileSync(manPath, "utf8") === original;
  marcar("I2", "guarda reprova A0 que alcanca egresso (mutacao)", rcOk === 0 && /COHERENT=YES/.test(saidaOk) && rcMal !== 0 && /COHERENT=NO/.test(saidaMal) && restaurado,
    "coerente=YES no manifesto real; NO quando rebaixado",
    `real=${/COHERENT=YES/.test(saidaOk) ? "YES" : "?"} rc=${rcOk} | rebaixado=${/COHERENT=NO/.test(saidaMal) ? "NO" : "?"} rc=${rcMal} | restaurado=${restaurado}`);
}

// ── I3. capability negada continua negada (com controle positivo) ──
{
  const s = await req("POST", "/api/v1/sessions", { owner: "AB-CAP", capabilities: CAPS_LEITURA, headless: true });
  const sid = s.body.session_id ?? s.body.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: FURL });
  const neg = await req("POST", "/api/v1/browser.download", { session_id: sid, url: FURL });
  const pos = await req("POST", "/api/v1/browser.extract", { session_id: sid, target: { selector: "#fato" } });
  const okNeg = neg.status === 403 && neg.body?.error?.code === "CAPABILITY_DENIED";
  const okPos = pos.body?.success === true && String(pos.body?.result?.content ?? "").includes("CANARIO-ANTIBYPASS-4417");
  marcar("I3", "capability negada = 403; a permitida funciona", okNeg && okPos,
    "download 403 CAPABILITY_DENIED e extract 200",
    `download=${neg.status}/${neg.body?.error?.code} extract=${pos.status}/ok=${okPos}`);
  await req("DELETE", `/api/v1/sessions/${sid}`);
}

// ── I4. session allowlist: token de uma sessao nao opera outra (nas ROTAS DE ACAO) ──
{
  const sa = await req("POST", "/api/v1/sessions", { owner: "AB-A", capabilities: CAPS_LEITURA, headless: true });
  const sidA = sa.body.session_id ?? sa.body.id;
  const sb = await req("POST", "/api/v1/sessions", { owner: "AB-B", capabilities: CAPS_LEITURA, headless: true });
  const sidB = sb.body.session_id ?? sb.body.id;
  // CONSERTO DE INSTRUMENTO: nao existe rota HTTP de emissao de token (por
  // desenho — emitir credencial pela rede seria superficie nova). O token
  // restrito nasce do AuthManager, e o segredo mora em `.secret`, nao `.token`.
  let tokenA: string | null = null;
  let via = "AuthManager.issue";
  try {
    const emitido = d.auth.issue({ subject: "AB-A", scopes: ["OBSERVE", "CONTROL", "NAVIGATE"], session_allowlist: [sidA] });
    tokenA = (emitido as any)?.secret ?? null;
  } catch (e) { via = `AuthManager.issue lancou: ${(e as Error).message}`; }
  // O token restrito precisa TAMBEM ser o dono do volante da sessao A: sem
  // lease, a recusa em A seria 409 CONTROL_NOT_OWNED e o controle POSITIVO
  // mediria a falta de lease, nao a allowlist. Duas defesas independentes nao
  // podem ser confundidas uma com a outra.
  await req("POST", `/api/v1/sessions/${sidA}/lease/transfer`, { to: "AB-A" });
  if (tokenA === null) {
    marcar("I4", "session allowlist efetiva nas rotas de acao", false, "token restrito a sessao A", `NAO CONSEGUI EMITIR TOKEN RESTRITO (${via}); status=${emitido?.status}`);
  } else {
    const abriuA = await req("POST", "/api/v1/browser.open", { session_id: sidA, url: FURL }, tokenA);
    const abriuB = await req("POST", "/api/v1/browser.open", { session_id: sidB, url: FURL });
    if (abriuA.body?.success !== true) {
      console.log(`      [diag] open A com token restrito: ${abriuA.status} ${JSON.stringify(abriuA.body?.error ?? abriuA.body).slice(0, 220)}`);
    }
    void abriuB;
    const naA = await req("POST", "/api/v1/browser.extract", { session_id: sidA, target: { selector: "#fato" } }, tokenA);
    const naB = await req("POST", "/api/v1/browser.extract", { session_id: sidB, target: { selector: "#fato" } }, tokenA);
    const okPos = naA.body?.success === true;
    const okNeg = naB.body?.success !== true;
    marcar("I4", "session allowlist efetiva nas rotas de acao", okPos && okNeg,
      "token de A: 200 em A, recusa em B",
      `emitido_via=${via} openA=${abriuA.status} A=${naA.status}/${naA.body?.success} B=${naB.status}/${naB.body?.error?.code ?? naB.body?.success}`);
  }
  await req("DELETE", `/api/v1/sessions/${sidA}`); await req("DELETE", `/api/v1/sessions/${sidB}`);
}

// ── I5. lease obrigatorio: sem o volante, nao age ──
{
  const s = await req("POST", "/api/v1/sessions", { owner: "AB-LEASE", capabilities: CAPS_LEITURA, headless: true });
  const sid = s.body.session_id ?? s.body.id;
  await req("POST", "/api/v1/browser.open", { session_id: sid, url: FURL });
  const antes = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#b" } });
  // CONSERTO DE INSTRUMENTO: `lease.transfer` exige `to`; com `to_holder` a rota
  // devolvia 400 e o lease NUNCA saia — eu media a ausencia da transferencia.
  const tomado = await req("POST", `/api/v1/sessions/${sid}/lease/transfer`, { to: "outro-agente" });
  const depois = await req("POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#b" } });
  const eco = await req("POST", "/api/v1/browser.extract", { session_id: sid, target: { selector: "#eco" } });
  const okPos = antes.body?.success === true;
  const okNeg = depois.body?.success !== true && /CONTROL_NOT_OWNED|CAPABILITY_DENIED/.test(String(depois.body?.error?.code));
  marcar("I5", "lease obrigatorio: perde o volante, para de agir", okPos && okNeg && tomado.status === 200,
    "clique OK com lease; recusa sem lease",
    `com_lease=${antes.body?.success} transfer=${tomado.status} sem_lease=${depois.status}/${depois.body?.error?.code} eco="${String(eco.body?.result?.content ?? "?").trim()}"`);
  await req("DELETE", `/api/v1/sessions/${sid}`);
}

// ── I6. Gi nao fala com o browser sem passar pelo NOMOS ──
{
  const giDir = "/Users/AI/Projects/pocket-assistant/backend";
  const mod = path.join(giDir, "gi_nomos", "browser.py");
  const existe = fs.existsSync(mod);
  const fonte = existe ? fs.readFileSync(mod, "utf8") : "";
  // O modulo tem de consultar o NOMOS antes de executar, e nao pode ter rota direta ao runtime
  const consultaNomos = /approvals\s*["',\s]+testar|approvals", "testar/.test(fonte) || /NOMOS_BIN/.test(fonte);
  // CONSERTO DE INSTRUMENTO: procurar a URL era falso positivo. O modulo LE
  // `NOMOS_BROWSER_URL` para REPASSAR ao subprocesso do conector — quem fala com
  // o runtime e o servidor MCP, nao a Gi. Bypass de verdade seria um CLIENTE
  // HTTP no processo da Gi.
  const rotaDireta = /\b(requests|httpx|aiohttp|urllib\.request|http\.client)\b/.test(fonte);
  // varredura do resto do backend: ninguem mais pode falar com o runtime
  let bypassOutros = "";
  try {
    bypassOutros = execFileSync("bash", ["-c", `grep -rlE "(requests|httpx|aiohttp|urllib\\.request|http\\.client)[^\n]{0,80}(7777|/api/v1/browser)" '${giDir}' --include='*.py' 2>/dev/null | head -5`], { encoding: "utf8" }).trim();
  } catch { bypassOutros = ""; }
  marcar("I6", "Gi: veredito do NOMOS antes de agir; sem rota direta", existe && consultaNomos && !rotaDireta && bypassOutros === "",
    "browser.py consulta o NOMOS e nao chama o runtime direto",
    `modulo=${existe} consulta_nomos=${consultaNomos} rota_direta_no_modulo=${rotaDireta} outros_com_rota_direta=[${bypassOutros.replace(/\n/g, ",")}]`);
}

const falhas = R.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, "anti-bypass.json"), JSON.stringify(R, null, 2));
console.log(`\nINVARIANTES=${R.length} OK=${R.length - falhas.length} FALHAS=${falhas.length}`);
console.log(`CONTROL_PLANE_INVARIANTS=${falhas.length === 0 ? "PASS" : "FAIL"}`);
for (const f of falhas) console.log(`  FALHOU ${f.id}: ${f.observado}`);
await d.close(); await new Promise<void>((r) => srv.close(() => r()));
process.exit(falhas.length === 0 ? 0 : 1);
