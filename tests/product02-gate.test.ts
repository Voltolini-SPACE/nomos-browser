/**
 * GATE PRODUCT-02 — as três PARCIAIS do PRODUCT-01.
 *
 * A missão é explícita: "Nunca promover PARCIAL → PASS apenas porque a
 * implementação existe." Cada flag aqui só muda de valor por asserção
 * executada contra o sistema real.
 *
 *   VISION_MOUSE_PASS  precisa de imagem real → VisionProvider real → coordenada
 *                      → mouse CDP confiável → efeito observado → verificação
 *                      independente. Mock do provider NÃO fecha esta flag.
 *   MULTI_AI_PASS      precisa de dois providers REAIS e independentes, handoff,
 *                      ownership arbitrado e auditoria que distinga cada agente.
 *   RECOVERY_PASS      precisa da queda do PROCESSO do runtime, não do cliente.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startDaemon, type DaemonHandle } from "../packages/api/src/daemon.ts";
import { OllamaVisionProvider, VisionFallbackPolicy } from "../packages/core/src/vision.ts";
import { OllamaProvider } from "../packages/core/src/providers/ollama.ts";
import { pixelAt, decodePng, colorDistance } from "../packages/observability/src/png.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLLAMA = "http://127.0.0.1:11434";
const MODELO_VISAO = "qwen2.5vl:3b";
const MODELO_A = "qwen3.5:4b-q8_0";
const MODELO_B = "qwen2.5-coder:7b";

const GATE: Record<string, string> = {
  VISION_MOUSE_PASS: "NO",
  MULTI_AI_PASS: "NO",
  RECOVERY_PASS: "NO",
};

/**
 * Fixture com um alvo em <canvas>: sem role, sem texto, sem label. DOM e
 * accessibility não têm por onde pegá-lo — é o único jeito honesto de forçar a
 * cascata até a visão, em vez de desligar os degraus anteriores para "provar"
 * que a visão funciona.
 */
const FIXTURE_CANVAS = `<!doctype html><meta charset="utf-8"><title>alvo em canvas</title>
<style>body{margin:0;background:#fff;font:16px system-ui}#c{display:block}#eco{padding:8px;font-family:monospace}</style>
<body>
<button id="botao-real">Entrar</button>
<canvas id="c" width="900" height="500"></canvas>
<div id="eco" data-hit="nao">nenhum clique no canvas</div>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
x.fillStyle = '#ffffff'; x.fillRect(0,0,900,500);
// Um quadrado verde sólido, bem destacado, em posição conhecida.
const ALVO = {x:520, y:300, w:150, h:110};
x.fillStyle = '#12b886'; x.fillRect(ALVO.x, ALVO.y, ALVO.w, ALVO.h);
// Distrator de outra cor e forma, para o alvo não ser "a única coisa colorida".
x.fillStyle = '#4263eb'; x.beginPath(); x.arc(180, 150, 55, 0, Math.PI*2); x.fill();
window.__ALVO = ALVO;
c.addEventListener('click', (e) => {
  const r = c.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const dentro = px >= ALVO.x && px <= ALVO.x+ALVO.w && py >= ALVO.y && py <= ALVO.y+ALVO.h;
  const eco = document.getElementById('eco');
  eco.dataset.hit = dentro ? 'sim' : 'nao';
  eco.dataset.trusted = String(e.isTrusted);
  eco.textContent = dentro ? 'ACERTOU O ALVO' : 'errou (' + Math.round(px) + ',' + Math.round(py) + ')';
});
</script>`;

let fixtureServer: http.Server;
let FIXTURE_URL = "";
let ollamaVivo = false;

async function ollamaTem(modelo: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    const d = (await r.json()) as { models?: { name: string }[] };
    return (d.models ?? []).some((m) => m.name === modelo);
  } catch {
    return false;
  }
}

/** Devolve a memória do modelo. Sem isto, dois modelos residentes estouram os 16 GB desta máquina. */
async function descarregar(modelo: string): Promise<void> {
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model: modelo, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { /* melhor esforço: falhar aqui não invalida o teste */ }
}

before(async () => {
  fixtureServer = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(FIXTURE_CANVAS);
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const a = fixtureServer.address();
  if (a === null || typeof a === "string") throw new Error("fixture sem porta");
  FIXTURE_URL = `http://127.0.0.1:${a.port}/`;
  ollamaVivo = await ollamaTem(MODELO_VISAO);

  // Devolve a memória antes de começar.
  //
  // Rodando este arquivo ISOLADO, o modelo de visão responde em ~1 s. Rodando na
  // suíte inteira, `vision.test.ts` e `aiprovider.test.ts` deixam modelos de 5 e
  // 7 GB residentes, e neste M2 de 16 GB com swap no teto o carregamento estoura
  // o timeout de 120 s — o provider devolve null e o gate falha por RECURSO, não
  // por correção. Foi exatamente o que aconteceu na primeira execução completa.
  for (const m of [MODELO_A, MODELO_B, "moondream:1.8b"]) await descarregar(m);
});

after(async () => {
  await new Promise<void>((r) => fixtureServer?.close(() => r()));
  await descarregar(MODELO_VISAO);
  process.stderr.write("\n── GATE PRODUCT-02 ──\n");
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 3/4/5 — VISION_MOUSE_PASS
// ═════════════════════════════════════════════════════════════════════════════

test("FASE 5 — visão REAL: imagem → alvo → coordenada → mouse confiável → efeito", async (t) => {
  if (!ollamaVivo) {
    t.skip(`${MODELO_VISAO} indisponível em ${OLLAMA} — pulado explicitamente, não fingido`);
    return;
  }

  const daemon: DaemonHandle = await startDaemon({
    port: 0, headless: true, allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
  } as never);
  const TOKEN = daemon.token;
  const H = { "content-type": "application/json", ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}) };
  const acao = async (tool: string, corpo: unknown): Promise<any> =>
    (await fetch(`${daemon.url}/api/v1/${tool}`, { method: "POST", headers: H, body: JSON.stringify(corpo) })).json();

  try {
    const s = await (await fetch(`${daemon.url}/api/v1/sessions`, {
      method: "POST", headers: H, body: JSON.stringify({ owner: "NOMOS", profile: "sandbox" }),
    })).json();
    const sid = s.session_id;
    assert.ok(sid, "sessão não criada");

    await acao("browser.goto", { session_id: sid, url: FIXTURE_URL });

    // 1. O alvo em canvas NÃO é resolvível pelos degraus anteriores. Se fosse,
    //    a cascata pararia antes e a visão nunca seria exercitada — e o teste
    //    estaria provando outra coisa.
    const porDom = await acao("browser.find", { session_id: sid, target: { selector: "#alvo-verde" } });
    assert.equal(porDom.success, false, "o alvo do canvas não pode ser resolvível por seletor");
    const porAx = await acao("browser.find", { session_id: sid, target: { role: "button", text: "quadrado verde" } });
    assert.equal(porAx.success, false, "o alvo do canvas não pode ser resolvível por accessibility");

    // 2. Screenshot real da página.
    const shot = await acao("browser.screenshot", { session_id: sid, scope: "viewport" });
    assert.equal(shot.success, true, JSON.stringify(shot.error));
    const png = readFileSync(path.join(RAIZ, "sessions", sid, "screenshots", `${shot.result.screenshot_ref}.png`));

    // 3. VisionProvider REAL localiza o alvo. Nenhum mock a partir daqui.
    const provider = new OllamaVisionProvider({ endpoint: OLLAMA, model: MODELO_VISAO, timeout_ms: 120_000 });
    const achado = await provider.locate({
      screenshot: png,
      goal: "the solid green rectangle",
      viewport: { width: shot.result.width, height: shot.result.height },
    });
    assert.ok(achado !== null, "o provider de visão não localizou o alvo");
    assert.ok(achado.confidence > 0, "confiança precisa ser derivada, não zero");
    process.stderr.write(`[VISAO] provider=${provider.name} box=${JSON.stringify(achado.box)} conf=${achado.confidence}\n`);

    // 4. A caixa da visão precisa cair sobre o alvo VERDADEIRO, conhecido só
    //    pelo canvas. É a diferença entre "o modelo respondeu" e "o modelo acertou".
    const alvoReal = await acao("browser.extract", { session_id: sid, target: { selector: "#c" } });
    assert.equal(alvoReal.success, true);
    const cx = achado.box.x + achado.box.width / 2;
    const cy = achado.box.y + achado.box.height / 2;

    // 5. Conferência independente do canal do modelo: o pixel do screenshot na
    //    coordenada escolhida tem de ser a cor do alvo. Se a visão errasse e o
    //    clique acertasse por sorte, isto pegaria.
    const dec = decodePng(png);
    const escala = dec.width / shot.result.width;
    const cor = pixelAt(dec, cx * escala, cy * escala);
    const dist = colorDistance(cor, { r: 0x12, g: 0xb8, b: 0x86, a: 255 });
    process.stderr.write(`[VISAO] pixel no centro=${JSON.stringify(cor)} distancia=${dist.toFixed(1)}\n`);
    assert.ok(dist <= 40, `a coordenada da visão não caiu sobre a cor do alvo (distância ${dist.toFixed(1)})`);

    // 6. Clique por coordenada, via mouse do runtime (CDP → isTrusted).
    const clique = await acao("browser.click", { session_id: sid, target: { coordinates: { x: cx, y: cy } } });
    assert.equal(clique.success, true, JSON.stringify(clique.error));
    assert.equal(clique.result.target.strategy, "coordinates");

    // 7. Efeito observado NA PÁGINA, não no retorno da ação.
    const eco = await acao("browser.extract", { session_id: sid, target: { selector: "#eco" } });
    assert.match(String(eco.result.content), /ACERTOU O ALVO/, `a página não confirmou o acerto: ${eco.result.content}`);

    const trusted = await acao("browser.observe", { session_id: sid, limit: 300 });
    const elEco = (trusted.result.elements as any[]).find((e) => e.attributes?.id === "eco");
    assert.equal(elEco?.attributes?.["data-hit"], "sim", "data-hit não confirmou");
    assert.equal(elEco?.attributes?.["data-trusted"], "true", "o clique não chegou como evento confiável");

    // 8. Screenshot pós-ação como evidência.
    const depois = await acao("browser.screenshot", { session_id: sid, scope: "viewport" });
    assert.equal(depois.success, true);
    assert.equal(depois.result.persisted, true, "sem screenshot pós-ação não há evidência visual");

    GATE.VISION_MOUSE_PASS = "YES";
  } finally {
    await daemon.close();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 6-10 — MULTI_AI_PASS
// ═════════════════════════════════════════════════════════════════════════════

test("FASE 10 — dois providers REAIS, ownership arbitrado, handoff e auditoria", async (t) => {
  const temA = await ollamaTem(MODELO_A);
  const temB = await ollamaTem(MODELO_B);
  if (!temA || !temB) {
    t.skip(`providers indisponíveis (A=${temA} B=${temB}) — pulado explicitamente`);
    return;
  }

  const daemon: DaemonHandle = await startDaemon({
    port: 0, headless: true, allow_internal_urls: true,
    sessions_root: path.join(RAIZ, "sessions"),
  } as never);
  const TOKEN = daemon.token;
  const hdr = (cliente: string): Record<string, string> => ({
    "content-type": "application/json",
    "x-nomos-client": cliente,
    ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}),
  });
  const acaoComo = async (cliente: string, tool: string, corpo: unknown): Promise<{ status: number; env: any }> => {
    const r = await fetch(`${daemon.url}/api/v1/${tool}`, { method: "POST", headers: hdr(cliente), body: JSON.stringify(corpo) });
    return { status: r.status, env: await r.json() };
  };

  try {
    const s = await (await fetch(`${daemon.url}/api/v1/sessions`, {
      method: "POST", headers: hdr("AI-A"), body: JSON.stringify({ owner: "AI-A", profile: "sandbox" }),
    })).json();
    const sid = s.session_id;
    await acaoComo("AI-A", "browser.goto", { session_id: sid, url: FIXTURE_URL });

    // ── Dois providers REAIS, em série (memória) ────────────────────────────
    const pergunta = "Responda apenas com o número: quanto é 2+2?";

    const A = new OllamaProvider({ endpoint: OLLAMA, model: MODELO_A, timeout_ms: 300_000 });
    const rA = await A.request({ prompt: pergunta });
    assert.equal(rA.provider_id, `ollama:${MODELO_A}`);
    assert.ok(rA.text.length > 0, "provider A não respondeu");
    await descarregar(MODELO_A);

    const B = new OllamaProvider({ endpoint: OLLAMA, model: MODELO_B, timeout_ms: 300_000 });
    const rB = await B.request({ prompt: pergunta });
    assert.equal(rB.provider_id, `ollama:${MODELO_B}`);
    assert.ok(rB.text.length > 0, "provider B não respondeu");
    await descarregar(MODELO_B);

    process.stderr.write(`[MULTI-AI] A=${rA.provider_id} lat=${rA.latency_ms}ms | B=${rB.provider_id} lat=${rB.latency_ms}ms\n`);

    // A identidade tem de vir do TRANSPORTE, nunca do texto: os dois modelos
    // respondem "4" à mesma pergunta convergente. Diversidade de saída não prova
    // que são duas IAs.
    assert.notEqual(rA.provider_id, rB.provider_id, "providers indistinguíveis");
    assert.notEqual(rA.model, rB.model);

    // ── Ownership: A detém o lease, B é barrado ─────────────────────────────
    const lease = daemon.leases.acquire(sid, "AI-A", { ttl_ms: 60_000 });
    assert.ok("lease_id" in lease, `AI-A não conseguiu o lease: ${JSON.stringify(lease)}`);

    const bTenta = await acaoComo("AI-B", "browser.click", { session_id: sid, target: { selector: "#botao-real" } });
    assert.equal(bTenta.status, 409, `AI-B deveria ser barrado, veio ${bTenta.status}`);
    assert.equal(bTenta.env.error.detail?.lease, "CONTROL_NOT_OWNED");
    assert.equal(bTenta.env.error.detail?.current_holder, "AI-A");

    // A continua podendo agir enquanto detém.
    const aAge = await acaoComo("AI-A", "browser.click", { session_id: sid, target: { selector: "#botao-real" } });
    assert.equal(aAge.env.success, true, JSON.stringify(aAge.env.error));

    // ── A solta, B adquire, B age ───────────────────────────────────────────
    const solto = daemon.leases.release(sid, "AI-A", (lease as { lease_id: string }).lease_id);
    assert.equal(solto.released, true);
    const leaseB = daemon.leases.acquire(sid, "AI-B", { ttl_ms: 60_000 });
    assert.ok("lease_id" in leaseB, `AI-B não conseguiu o lease após liberação: ${JSON.stringify(leaseB)}`);

    const bAge = await acaoComo("AI-B", "browser.click", { session_id: sid, target: { selector: "#botao-real" } });
    assert.equal(bAge.env.success, true, JSON.stringify(bAge.env.error));

    // ── Handoff preserva o estado ───────────────────────────────────────────
    const h = await (await fetch(`${daemon.url}/api/v1/sessions/${sid}/handoff`, {
      method: "POST", headers: hdr("AI-B"), body: JSON.stringify({ to_owner: "AI-A" }),
    })).json();
    assert.equal(h.owner, "AI-A", "handoff não trocou o dono");
    assert.match(String(h.pages?.[0]?.url ?? ""), /127\.0\.0\.1/, "handoff perdeu a URL");

    // ── Auditoria distingue cada agente INEQUIVOCAMENTE ─────────────────────
    const jsonl = path.join(RAIZ, "sessions", sid, "actions.jsonl");
    assert.ok(existsSync(jsonl), "sem audit não há como atribuir ação a agente");
    const atores = new Set(
      readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l).actor as string),
    );
    assert.ok(atores.has("AI-A"), `audit não registrou AI-A; atores=${[...atores].join(",")}`);
    assert.ok(atores.has("AI-B"), `audit não registrou AI-B; atores=${[...atores].join(",")}`);

    GATE.MULTI_AI_PASS = "YES";
  } finally {
    await daemon.close();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 11-14 — RECOVERY_PASS (queda do PROCESSO, não do cliente)
// ═════════════════════════════════════════════════════════════════════════════

test("FASE 14 — SIGKILL no processo do daemon, reinício e decisão explícita", async () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-crash-"));
  const sessionsRoot = mkdtempSync(path.join(os.tmpdir(), "nomos-sess-"));
  const porta = 7791;

  /** Sobe o daemon como PROCESSO SEPARADO — é a única forma de matá-lo de verdade. */
  const subir = async (): Promise<ChildProcess> => {
    const p = spawn(process.execPath, [path.join(RAIZ, "packages/api/src/daemon.ts")], {
      env: {
        ...process.env,
        NOMOS_BROWSER_PORT: String(porta),
        NOMOS_BROWSER_HEADLESS: "true",
        NOMOS_BROWSER_ALLOW_INTERNAL: "true",
        NOMOS_SESSIONS_ROOT: sessionsRoot,
        NOMOS_RUNTIME_DIR: runtimeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const prazo = Date.now() + 60_000;
    while (Date.now() < prazo) {
      try {
        const r = await fetch(`http://127.0.0.1:${porta}/health`, { signal: AbortSignal.timeout(1500) });
        // 401 já prova que o servidor está de pé — a credencial é outro assunto.
        if (r.status === 200 || r.status === 401) return p;
      } catch { /* ainda subindo */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("daemon não subiu a tempo");
  };

  let proc: ChildProcess | null = null;
  try {
    proc = await subir();
    const pid1 = proc.pid!;
    assert.ok(pid1 > 0);

    const { readControlToken } = await import("../packages/api/src/auth.ts");
    const tok1 = readControlToken(runtimeDir);
    assert.ok(tok1 !== null, "token do daemon não foi gravado");
    const H1 = { "content-type": "application/json", authorization: `Bearer ${tok1}` };

    const s = await (await fetch(`http://127.0.0.1:${porta}/api/v1/sessions`, {
      method: "POST", headers: H1, body: JSON.stringify({ owner: "NOMOS", profile: "sandbox" }),
    })).json();
    const sid = s.session_id;
    await fetch(`http://127.0.0.1:${porta}/api/v1/browser.goto`, {
      method: "POST", headers: H1, body: JSON.stringify({ session_id: sid, url: FIXTURE_URL }),
    });

    // ── Matar o PROCESSO. Não o cliente, não o WebSocket: o runtime. ────────
    process.kill(pid1, "SIGKILL");
    await new Promise<void>((r) => proc!.once("exit", () => r()));
    assert.equal(proc.killed || proc.exitCode !== null || proc.signalCode !== null, true, "o daemon não morreu");

    // O runtime está morto: quem chamar precisa falhar de forma limpa, não pendurar.
    let caiu = false;
    try {
      await fetch(`http://127.0.0.1:${porta}/health`, { signal: AbortSignal.timeout(3000) });
    } catch { caiu = true; }
    assert.equal(caiu, true, "o daemon respondeu depois de morto");

    // ── Reinício ────────────────────────────────────────────────────────────
    proc = await subir();
    assert.notEqual(proc.pid, pid1, "o pid deveria ser novo");

    // Token novo a cada arranque: o antigo tem de deixar de valer.
    const tok2 = readControlToken(runtimeDir);
    assert.ok(tok2 !== null);
    assert.notEqual(tok2, tok1, "token deveria ser efêmero por arranque");
    const velho = await fetch(`http://127.0.0.1:${porta}/health`, { headers: { authorization: `Bearer ${tok1}` } });
    assert.equal(velho.status, 401, "token de antes do crash continuou valendo");

    const H2 = { "content-type": "application/json", authorization: `Bearer ${tok2}` };
    const h = await (await fetch(`http://127.0.0.1:${porta}/health`, { headers: H2 })).json();
    assert.equal(h.runtime, "ok", "runtime não voltou saudável");

    // ── A decisão sobre a sessão órfã tem de ser EXPLÍCITA ──────────────────
    const { RecoveryManager } = await import("../packages/core/src/recovery.ts");
    const rec = new RecoveryManager({ root: sessionsRoot });
    const decisoes = await rec.scan();
    process.stderr.write(`[RECOVERY] decisões=${JSON.stringify(decisoes.map((d: any) => ({ s: d.session_id, d: d.decision, m: d.reason })))}\n`);

    // ANTI-VACUIDADE. Na primeira execução deste gate o `scan()` devolveu lista
    // VAZIA — o daemon não gravava snapshot — e o laço abaixo passou sem
    // percorrer nada. O flag ficou verde sem que uma única sessão tivesse sido
    // recuperada. Exigir ao menos uma decisão é o que impede este teste de
    // "passar" justamente quando o recovery não existe.
    assert.ok(
      decisoes.length >= 1,
      "scan() não achou nenhuma sessão: sem snapshot em disco não há recovery, e este teste passaria por vacuidade",
    );
    const daSessao = (decisoes as any[]).find((d) => d.session_id === sid);
    assert.ok(daSessao !== undefined, `a sessão ${sid} criada antes do crash não apareceu no scan()`);

    // O ponto não é qual decisão saiu, e sim que TODA sessão tenha uma, com
    // motivo. Um snapshot sem decisão seria estado inventado.
    for (const d of decisoes as any[]) {
      assert.ok(["reattach", "recover", "orphan", "terminate"].includes(d.decision), `decisão inválida: ${d.decision}`);
      assert.ok(typeof d.reason === "string" && d.reason.length > 0, "decisão sem motivo");
    }

    // O Chromium do daemon morto não pode ter sido adotado às cegas: o processo
    // filho morre junto com o pai no SIGKILL, então reattach seria mentira.
    const reattachCego = (decisoes as any[]).filter((d) => d.decision === "reattach");
    for (const d of reattachCego) {
      assert.ok(d.verified === true, `reattach sem verificação de identidade: ${JSON.stringify(d)}`);
    }

    GATE.RECOVERY_PASS = "YES";
  } finally {
    if (proc !== null && proc.exitCode === null) {
      proc.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
  }
});
