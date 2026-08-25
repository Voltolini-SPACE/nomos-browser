/**
 * FASE 5 — PROVIDERS REAIS NO RUNTIME (daemon REAL + Chromium REAL)
 *
 * O DEFEITO MEDIDO QUE ORIGINOU ESTE ARQUIVO
 * ------------------------------------------
 *   daemon.ts:284   const { agent = null, ... } = opts
 *   main()          startDaemon({ install_signal_handlers: true })   // sem agent
 *
 * O contrato `AIProvider` existia, `OllamaProvider` existia, `OllamaVisionProvider`
 * existia — e NENHUM deles era construído em produção. `browser.task` falhava
 * sempre com "nenhum AgentProvider injetado" e o degrau `vision` saía sempre
 * `skipped`. A configuração não tinha por onde ligá-los.
 *
 * O INSTRUMENTO
 * -------------
 * Um backend FALSO de Ollama, servido por HTTP de verdade em 127.0.0.1, cujo
 * comportamento é escolhido POR MODELO. Isso importa: é o que permite o
 * principal cair e o secundário responder na MESMA requisição, com dois
 * `OllamaProvider` reais falando HTTP real — nada de duplo de `request()`.
 *
 * Os casos de Ollama REAL estão marcados e são os únicos que carregam modelo.
 * Eles se PULAM com razão declarada quando o backend não existe — nunca fingem
 * sucesso, e nunca rodam junto com outro modelo (ver `scripts/lib-memoria.sh`:
 * dois modelos simultâneos nesta máquina já mataram serviços de produção).
 *
 * Rodar: node --test tests/providers-runtime.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../packages/api/src/daemon.ts";
import { ConfigError, loadConfig } from "../packages/api/src/config.ts";
import { RoutedAiProvider, ehDegradacao, buildAiProvider } from "../packages/api/src/providers.ts";
import { RUNTIME_BUCKET } from "../packages/observability/src/audit.ts";
import type { AIProvider } from "../packages/core/src/aiprovider.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const PRINCIPAL = "falso-principal:1b";
const SECUNDARIO = "falso-secundario:1b";
const VISUAL = "falso-vl:1b";
const OLLAMA_REAL = "http://127.0.0.1:11434";
/** Medido nesta máquina: PROVIDER_PASS, 5,4 s frio / 4,2 s quente. */
const MODELO_REAL = "qwen2.5-coder:7b";

// ─────────────────────────────────────────────────────────────────────────────
// Backend falso de Ollama — comportamento POR MODELO
// ─────────────────────────────────────────────────────────────────────────────

type Modo = "ok" | "vazio" | "lento" | "quebrado" | "erro500" | "erro400";

const modo: Record<string, Modo> = {};
const batidas: Record<string, number> = {};
/** Milissegundos de atraso do modo `lento`. Maior que qualquer timeout testado. */
const ATRASO_LENTO_MS = 4000;

const PLANO = JSON.stringify({
  goal: "clicar no botão e confirmar",
  constraints: [],
  steps: [
    {
      id: "s1",
      intent: "clicar no botão principal",
      action: "browser.click",
      target: { selector: "#botao" },
      verification: { kind: "TEXT_CHANGED", expect: "CLICADO", timeout_ms: 3000 },
    },
  ],
  success_conditions: ["#saida contém CLICADO"],
  failure_conditions: [],
});

const VISAO_ACHOU = JSON.stringify({
  found: true,
  box: { x: 400, y: 120, width: 160, height: 100 },
  confidence: 0.92,
  coordinate_space: "pixels",
  reason: "retângulo vermelho com o texto COMPRAR",
});
const VISAO_NAO_ACHOU = JSON.stringify({ found: false, reason: "não vejo esse alvo na captura" });

let backend: http.Server;
let BASE_FALSA = "";

function corpoDe(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let bruto = "";
    req.on("data", (c) => {
      bruto += String(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(bruto) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

function abrirBackendFalso(): Promise<void> {
  backend = http.createServer((req, res) => {
    void (async () => {
      const rota = (req.url ?? "/").split("?")[0]!;
      const body = req.method === "POST" ? await corpoDe(req) : {};
      const modelo = typeof body.model === "string" ? body.model : "";

      if (rota === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: PRINCIPAL }, { name: SECUNDARIO }, { name: VISUAL }] }));
        return;
      }
      if (rota === "/api/show") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion"], details: { family: "falso" } }));
        return;
      }
      if (rota !== "/api/generate") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nao encontrado");
        return;
      }

      // `keep_alive:0` sem prompt é descarga, não inferência: não conta batida.
      if (body.prompt === undefined && body.keep_alive === 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: modelo, done: true, done_reason: "unload", response: "" }));
        return;
      }

      batidas[modelo] = (batidas[modelo] ?? 0) + 1;
      const m = modo[modelo] ?? "ok";

      if (m === "erro500") {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("backend sobrecarregado");
        return;
      }
      if (m === "erro400") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("pedido invalido");
        return;
      }
      if (m === "quebrado") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"model":"x","response": ISTO NAO E JSON');
        return;
      }
      if (m === "lento") {
        // Não responde dentro de nenhum timeout testado. `req.on("close")`
        // libera o socket quando o cliente aborta — sem isso o teste seguraria
        // conexões abertas até o fim do processo.
        const t = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ model: modelo, response: "tarde demais", done_reason: "stop" }));
          }
        }, ATRASO_LENTO_MS);
        req.on("close", () => clearTimeout(t));
        return;
      }

      const temImagem = Array.isArray(body.images) && body.images.length > 0;
      const texto =
        m === "vazio"
          ? ""
          : temImagem
            ? (modo[`${modelo}:visao`] as unknown as string) === "nada"
              ? VISAO_NAO_ACHOU
              : VISAO_ACHOU
            : body.format === "json"
              ? PLANO
              : `raciocínio de ${modelo}: o botão principal está visível; clicar nele resolve o objetivo.`;

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: modelo,
          response: texto,
          done: true,
          done_reason: "stop",
          prompt_eval_count: 11,
          eval_count: texto.length,
        }),
      );
    })();
  });
  return new Promise((r) => backend.listen(0, "127.0.0.1", () => r()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures de página e daemons
// ─────────────────────────────────────────────────────────────────────────────

const PAGINA_BOTAO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>alvo</title>
<style>html,body{margin:0;font:14px system-ui}button{padding:10px 16px}</style></head><body>
<button id="botao" type="button">Confirmar</button>
<div id="saida">nada</div>
<script>
document.getElementById('botao').addEventListener('click', function (e) {
  document.getElementById('saida').textContent = 'CLICADO isTrusted=' + e.isTrusted;
});
</script></body></html>`;

let paginas: http.Server;
let FIX = "";

interface Daemon {
  base: string;
  token: string | null;
  sid: string;
  raiz: string;
  handle: any;
  fechar: () => Promise<void>;
}

interface Envelope {
  success: boolean;
  result: any;
  error: { code: string; message: string; detail?: any } | null;
}

async function subir(rotulo: string, over: Record<string, unknown>): Promise<Daemon> {
  const raiz = await mkdtemp(path.join(os.tmpdir(), `nomos-prov-${rotulo}-`));
  const d = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: raiz,
    read_file: false,
    ...over,
  } as never);
  const base = `http://127.0.0.1:${d.port}`;
  const token = (d as unknown as { token: string | null }).token;
  const r = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ owner: "NOMOS-PROVIDERS", profile: "sandbox" }),
  });
  const corpo = (await r.json()) as { session_id?: string };
  assert.ok(corpo.session_id, `sessão sem id em ${rotulo}: ${JSON.stringify(corpo)}`);
  return { base, token, sid: corpo.session_id, raiz, handle: d, fechar: () => d.close() };
}

async function acao(d: Daemon, tool: string, corpo: Record<string, unknown>): Promise<{ status: number; env: Envelope }> {
  const r = await fetch(`${d.base}/api/v1/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(d.token !== null ? { authorization: `Bearer ${d.token}` } : {}),
    },
    body: JSON.stringify({ session_id: d.sid, ...corpo }),
  });
  return { status: r.status, env: (await r.json()) as Envelope };
}

async function trilhaDe(d: Daemon, balde: string): Promise<any[]> {
  const bruto = await readFile(path.join(d.raiz, balde, "actions.jsonl"), "utf8").catch(() => "");
  return bruto
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

let comProvider: Daemon;
let semBackend: Daemon;
let semProvider: Daemon;
let comVisao: Daemon;

before(async () => {
  await abrirBackendFalso();
  const a = backend.address();
  if (a === null || typeof a === "string") throw new Error("backend falso sem porta");
  BASE_FALSA = `http://127.0.0.1:${a.port}`;

  const canvas = readFileSync(path.join(AQUI, "fixtures", "cascata", "vision.html"));
  paginas = http.createServer((req, res) => {
    const rota = (req.url ?? "/").split("?")[0]!;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(rota === "/canvas" ? canvas : PAGINA_BOTAO);
  });
  await new Promise<void>((r) => paginas.listen(0, "127.0.0.1", r));
  const b = paginas.address();
  if (b === null || typeof b === "string") throw new Error("fixture sem porta");
  FIX = `http://127.0.0.1:${b.port}`;

  comProvider = await subir("com-provider", {
    providers_base_url: BASE_FALSA,
    ai_provider: `ollama:${PRINCIPAL}`,
    ai_provider_fallback: `ollama:${SECUNDARIO}`,
    ai_timeout_ms: 1500,
  });

  // Porta MORTA de propósito: o servidor de páginas está vivo, então o daemon
  // continua tendo o que fazer — o que morre é só o backend de modelos.
  semBackend = await subir("sem-backend", {
    providers_base_url: "http://127.0.0.1:1",
    ai_provider: `ollama:${PRINCIPAL}`,
    ai_timeout_ms: 1500,
  });

  // Controle negativo: o produto como ele nasce, sem provider nenhum.
  semProvider = await subir("sem-provider", {});

  comVisao = await subir("com-visao", {
    providers_base_url: BASE_FALSA,
    vision_provider: `ollama:${VISUAL}`,
    vision_timeout_ms: 4000,
    vision_min_confidence: 0.7,
  });
});

after(async () => {
  for (const d of [comProvider, semBackend, semProvider, comVisao]) {
    if (d === undefined) continue;
    await d.fechar().catch(() => undefined);
    await rm(d.raiz, { recursive: true, force: true }).catch(() => undefined);
  }
  await new Promise<void>((r) => paginas?.close(() => r()));
  await new Promise<void>((r) => backend?.close(() => r()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Provider disponível → browser.task ponta a ponta
// ─────────────────────────────────────────────────────────────────────────────

test("1. provider disponível: browser.task observa, raciocina, planeja, AGE e verifica", async () => {
  modo[PRINCIPAL] = "ok";
  const o = await acao(comProvider, "browser.open", { url: `${FIX}/botao` });
  assert.equal(o.env.success, true, JSON.stringify(o.env.error));

  const t = await acao(comProvider, "browser.task", { goal: "clicar no botão e confirmar" });
  assert.equal(t.env.success, true, `task falhou: ${JSON.stringify(t.env.error)}`);
  assert.equal(t.env.result.state, "COMPLETED", JSON.stringify(t.env.result));
  assert.equal(t.env.result.plan.steps.length, 1);
  assert.equal(t.env.result.plan.steps[0].action, "browser.click");

  // O PASSO AGIU DE VERDADE — a prova está na página, não no relatório da task.
  const saida = await acao(comProvider, "browser.extract", { target: { selector: "#saida" } });
  const txt = String(saida.env.result?.content ?? "");
  assert.match(txt, /CLICADO/, `o plano não chegou a agir: ${txt}`);
  assert.match(txt, /isTrusted=true/, "evento sintético — o clique não veio do navegador");

  // A trilha diz QUEM agiu: o passo foi executado sob a identidade do modelo.
  const linhas = await trilhaDe(comProvider, comProvider.sid);
  const clique = linhas.filter((l) => l.action === "browser.click");
  assert.ok(clique.length >= 1, "o clique do plano não deixou linha na trilha");
  assert.ok(
    clique.some((l) => String(l.actor).includes(PRINCIPAL)),
    `a trilha não atribui o clique ao modelo: ${clique.map((l) => l.actor).join(",")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Provider indisponível → degrada, não derruba
// ─────────────────────────────────────────────────────────────────────────────

test("2. backend fora do ar: erro classificado, daemon vivo, ações determinísticas intactas", async () => {
  const saude = await semBackend.handle.ai.health();
  assert.equal(saude.status, "down", JSON.stringify(saude));
  assert.match(String(saude.reason), /inalcan|HTTP/i);

  const o = await acao(semBackend, "browser.open", { url: `${FIX}/botao` });
  assert.equal(o.env.success, true, "o daemon caiu junto com o backend de modelos");

  const t = await acao(semBackend, "browser.task", { goal: "clicar no botão" });
  assert.equal(t.env.success, false, "task devolveu sucesso com o backend fora");
  assert.ok(
    ["INTERNAL", "PROVIDER_ERROR", "TIMEOUT", "INVALID_REQUEST"].includes(String(t.env.error?.code)),
    `código não classificado: ${JSON.stringify(t.env.error)}`,
  );

  // AS AÇÕES DETERMINÍSTICAS CONTINUAM. É o ponto todo: o modelo é um degrau,
  // não o alicerce.
  const f = await acao(semBackend, "browser.find", { target: { selector: "#botao" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  const c = await acao(semBackend, "browser.click", { target: { selector: "#botao" } });
  assert.equal(c.env.success, true, JSON.stringify(c.env.error));
  const x = await acao(semBackend, "browser.extract", { target: { selector: "#saida" } });
  assert.match(String(x.env.result?.content ?? ""), /CLICADO/);
  const obs = await acao(semBackend, "browser.observe", {});
  assert.equal(obs.env.success, true, JSON.stringify(obs.env.error));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Timeout
// ─────────────────────────────────────────────────────────────────────────────

test("3. timeout do provider vira TIMEOUT e é respeitado dentro da margem", async () => {
  modo[PRINCIPAL] = "lento";
  modo[SECUNDARIO] = "lento";
  const t0 = Date.now();
  const r = await comProvider.handle.ai.request({ prompt: "diga oi", timeout_ms: 400 });
  const gasto = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "TIMEOUT", JSON.stringify(r.error));
  assert.equal(r.text, "", "resposta com ok:false tem de vir com texto vazio (I3)");
  // Duas tentativas de 400 ms (principal + secundário, ambos lentos) mais folga
  // de agendamento. O teto existe para que "respeitou o timeout" não signifique
  // "esperou os 4 s do servidor e depois desistiu".
  assert.ok(gasto < 2000, `timeout não foi respeitado: ${gasto}ms para um teto de 400ms`);
  modo[PRINCIPAL] = "ok";
  modo[SECUNDARIO] = "ok";
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cancelamento — ordem, não falha
// ─────────────────────────────────────────────────────────────────────────────

test("4. cancelar devolve ABORTED e NÃO aciona o fallback", async () => {
  modo[PRINCIPAL] = "lento";
  modo[SECUNDARIO] = "ok";
  const antes = batidas[SECUNDARIO] ?? 0;
  const routed = comProvider.handle.ai as RoutedAiProvider;
  const degradacoesAntes = routed.degradacoes.length;

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const r = await comProvider.handle.ai.request({ prompt: "isto vai ser cancelado", signal: ac.signal });

  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "ABORTED", JSON.stringify(r.error));
  assert.equal(
    batidas[SECUNDARIO] ?? 0,
    antes,
    "cancelamento acionou o secundário — cancelar virou sugestão em vez de ordem",
  );
  assert.equal(routed.degradacoes.length, degradacoesAntes, "cancelamento foi contado como degradação");
  modo[PRINCIPAL] = "ok";
});

// ─────────────────────────────────────────────────────────────────────────────
// 5/7. EMPTY_OUTPUT aciona o fallback, e a degradação vai para a trilha
// ─────────────────────────────────────────────────────────────────────────────

test("5. saída vazia é classificada como EMPTY_OUTPUT e aciona o secundário", async () => {
  modo[PRINCIPAL] = "vazio";
  modo[SECUNDARIO] = "ok";
  const antes = batidas[SECUNDARIO] ?? 0;

  const r = await comProvider.handle.ai.request({ prompt: "responda alguma coisa" });
  assert.equal(r.ok, true, `secundário não respondeu: ${JSON.stringify(r.error)}`);
  // A RESPOSTA DIZ QUEM RESPONDEU. Sem isto, a auditoria atribuiria ao
  // principal um texto que ele nunca produziu.
  assert.equal(r.provider_id, `ollama:${SECUNDARIO}`);
  assert.equal(r.model, SECUNDARIO);
  assert.equal(batidas[SECUNDARIO] ?? 0, antes + 1);

  const routed = comProvider.handle.ai as RoutedAiProvider;
  const ultima = routed.degradacoes.at(-1)!;
  assert.equal(ultima.code, "EMPTY_OUTPUT");
  assert.equal(ultima.fallback_usado, true);
  assert.equal(ultima.provider_id, `ollama:${PRINCIPAL}`);
  assert.equal(ultima.fallback_provider_id, `ollama:${SECUNDARIO}`);
  assert.equal(ultima.fallback_ok, true);
  modo[PRINCIPAL] = "ok";
});

test("7. a degradação deixa `provider.degraded` na trilha, com motivo e fallback", async () => {
  // A linha é do PROVIDER, não de uma sessão: vai para o balde `_runtime`.
  //
  // A escrita da trilha é deliberadamente FIRE-AND-FORGET (auditoria não pode
  // bloquear inferência), então o teste ESPERA a linha aparecer em vez de supor
  // que ela já está lá — e procura a degradação POR CÓDIGO, não pela última
  // linha do arquivo: o caso do timeout, testado antes, também degrada.
  let degradadas: any[] = [];
  let d: any;
  const limite = Date.now() + 5000;
  do {
    const linhas = await trilhaDe(comProvider, RUNTIME_BUCKET);
    degradadas = linhas.filter((l) => l.event === "provider" && l.action === "provider.degraded");
    d = degradadas.find((l) => l.detail?.code === "EMPTY_OUTPUT" && l.detail?.fallback_usado === true);
    if (d === undefined) await new Promise((r) => setTimeout(r, 50));
  } while (d === undefined && Date.now() < limite);

  assert.ok(degradadas.length >= 1, "nenhuma linha de degradação na trilha");
  assert.ok(d !== undefined, `degradação por EMPTY_OUTPUT ausente; achei: ${degradadas.map((l) => l.detail?.code).join(",")}`);
  // O timeout (teste 3) também tem de constar: degradação sem fallback ainda é
  // degradação, e registrar só a que teve secundário esconderia a instalação de
  // provider único — a mais comum e a que mais precisa do aviso.
  assert.ok(
    degradadas.some((l) => l.detail?.code === "TIMEOUT"),
    "timeout do principal não deixou linha de degradação",
  );
  assert.equal(d.provider, `ollama:${PRINCIPAL}`);
  assert.equal(d.result, "error");
  assert.equal(d.detail.fallback_usado, true);
  assert.equal(d.detail.fallback_provider_id, `ollama:${SECUNDARIO}`);
  assert.equal(d.detail.code, "EMPTY_OUTPUT");
  assert.ok(typeof d.detail.motivo === "string" && d.detail.motivo.length > 0, "degradação sem motivo");
  assert.equal(d.session, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Resposta malformada
// ─────────────────────────────────────────────────────────────────────────────

test("6. JSON quebrado vira BAD_RESPONSE, não derruba, e NÃO gasta o secundário", async () => {
  modo[PRINCIPAL] = "quebrado";
  modo[SECUNDARIO] = "ok";
  const antes = batidas[SECUNDARIO] ?? 0;

  const r = await comProvider.handle.ai.request({ prompt: "responda" });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "BAD_RESPONSE", JSON.stringify(r.error));
  assert.equal(r.text, "");
  // Backend que RESPONDEU — mal — não é backend caído. Uma segunda inferência
  // não conserta JSON quebrado; só dobra o custo para errar igual.
  assert.equal(batidas[SECUNDARIO] ?? 0, antes, "malformação acionou o fallback");
  assert.equal(ehDegradacao(r.error), false);

  // Daemon inteiro: uma resposta podre do modelo não pode contaminar o resto.
  const f = await acao(comProvider, "browser.find", { target: { selector: "#botao" } });
  assert.equal(f.env.success, true, JSON.stringify(f.env.error));
  modo[PRINCIPAL] = "ok";
});

test("6b. HTTP 5xx degrada e 4xx não — pedido errado não vira fallback", async () => {
  modo[PRINCIPAL] = "erro500";
  modo[SECUNDARIO] = "ok";
  let antes = batidas[SECUNDARIO] ?? 0;
  const cinco = await comProvider.handle.ai.request({ prompt: "responda" });
  assert.equal(cinco.ok, true, "5xx do principal não acionou o secundário");
  assert.equal(cinco.provider_id, `ollama:${SECUNDARIO}`);
  assert.equal(batidas[SECUNDARIO] ?? 0, antes + 1);

  modo[PRINCIPAL] = "erro400";
  antes = batidas[SECUNDARIO] ?? 0;
  const quatro = await comProvider.handle.ai.request({ prompt: "responda" });
  assert.equal(quatro.ok, false);
  assert.equal(quatro.error?.code, "HTTP_ERROR");
  assert.equal(batidas[SECUNDARIO] ?? 0, antes, "4xx acionou o fallback");
  modo[PRINCIPAL] = "ok";
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Recuperação
// ─────────────────────────────────────────────────────────────────────────────

test("8. principal volta ao ar e volta a ser usado — a degradação não é permanente", async () => {
  modo[PRINCIPAL] = "vazio";
  modo[SECUNDARIO] = "ok";
  const caido = await comProvider.handle.ai.request({ prompt: "primeiro" });
  assert.equal(caido.provider_id, `ollama:${SECUNDARIO}`);

  modo[PRINCIPAL] = "ok";
  const antesSec = batidas[SECUNDARIO] ?? 0;
  const voltou = await comProvider.handle.ai.request({ prompt: "segundo" });
  assert.equal(voltou.ok, true, JSON.stringify(voltou.error));
  assert.equal(voltou.provider_id, `ollama:${PRINCIPAL}`, "ficou preso no secundário depois da recuperação");
  assert.equal(batidas[SECUNDARIO] ?? 0, antesSec, "consultou o secundário com o principal de pé");

  const saude = await comProvider.handle.ai.health();
  assert.equal(saude.status, "ok", JSON.stringify(saude));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9/10. Visão ligada por CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

test("10. visão configurada resolve o alvo só-pixel pelo degrau `vision`", async () => {
  modo[`${VISUAL}:visao`] = "achou" as Modo;
  const o = await acao(comVisao, "browser.open", { url: `${FIX}/canvas` });
  assert.equal(o.env.success, true, JSON.stringify(o.env.error));

  const f = await acao(comVisao, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, true, `cascata não chegou à visão: ${JSON.stringify(f.env.error)}`);
  assert.equal(f.env.result.strategy, "vision");
  assert.deepEqual(f.env.result.attempted, ["semantic", "vision"]);
  // Caixa dentro da verdade da fixture — a visão não devolveu a página inteira.
  assert.ok(f.env.result.box.width <= 200 && f.env.result.box.height <= 140, JSON.stringify(f.env.result.box));
});

test("9. visão que não vê o alvo devolve null — e o runtime NÃO inventa coordenada", async () => {
  modo[`${VISUAL}:visao`] = "nada" as Modo;
  await acao(comVisao, "browser.open", { url: `${FIX}/canvas` });

  const f = await acao(comVisao, "browser.find", { target: { semantic: "um elefante roxo de smoking" } });
  assert.equal(f.env.success, false, "inventou alvo que o provider disse não ver");
  assert.equal(f.env.error?.code, "TARGET_NOT_FOUND");
  assert.equal(f.env.result, null);
  const trace = (f.env.error?.detail?.trace ?? []) as any[];
  const visao = trace.find((t) => t.strategy === "vision");
  assert.ok(visao !== undefined, "degrau de visão ausente do rastro");
  assert.equal(visao.outcome, "miss");
  assert.match(String(visao.reason), /não localizou|nao localizou/);
  assert.equal(
    trace.find((t) => t.strategy === "coordinates"),
    undefined,
    "runtime desceu para coordenada sem coordenada pedida",
  );
  modo[`${VISUAL}:visao`] = "achou" as Modo;
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Configuração inválida
// ─────────────────────────────────────────────────────────────────────────────

test("11. identificador de backend desconhecido é ConfigError NO ARRANQUE", async () => {
  await assert.rejects(
    () => startDaemon({ port: 0, headless: true, read_file: false, ai_provider: "gpt4:foo" } as never),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError, `esperava ConfigError, veio ${(e as Error).name}`);
      assert.match((e as Error).message, /backend desconhecido/);
      assert.match((e as Error).message, /gpt4/);
      assert.deepEqual((e as ConfigError).detail.known, ["ollama"]);
      return true;
    },
  );

  // Formato sem `:` também não passa — e a mensagem diz o formato esperado.
  assert.throws(
    () => loadConfig({ read_file: false, vision_provider: "qwen2.5vl" } as never),
    /formato "<backend>:<modelo>"/,
  );

  // O nome do modelo do Ollama TEM `:`. A divisão é no primeiro, nunca no
  // último — foi o erro que teria transformado `ollama:qwen2.5-coder:7b` em
  // backend `ollama:qwen2.5-coder`.
  const cfg = loadConfig({ read_file: false, ai_provider: "ollama:qwen2.5-coder:7b" } as never);
  const p = buildAiProvider(cfg) as AIProvider;
  assert.equal(p.model, "qwen2.5-coder:7b");
  assert.equal(p.provider_id, "ollama:qwen2.5-coder:7b");

  // Backend de modelos fora do loopback exige consentimento explícito: prompt e
  // screenshot da sessão do dono saindo da máquina é exfiltração.
  assert.throws(
    () => loadConfig({ read_file: false, providers_base_url: "http://modelos.exemplo.com" } as never),
    /fora do loopback/,
  );
  const remoto = loadConfig({
    read_file: false,
    providers_base_url: "http://modelos.exemplo.com",
    providers_allow_remote: true,
  } as never);
  assert.equal(remoto.providers_base_url, "http://modelos.exemplo.com");
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Controle negativo — o produto como ele nasce
// ─────────────────────────────────────────────────────────────────────────────

test("12. sem provider configurado: nada é construído e o degrau `vision` sai `skipped`", async () => {
  const cru = loadConfig({ read_file: false });
  assert.equal(cru.ai_provider, null, "o runtime nasceria falando com um LLM sem o dono pedir");
  assert.equal(cru.vision_provider, null);
  assert.equal(cru.vision_min_confidence, 0.7);
  assert.equal(cru.providers_base_url, "http://127.0.0.1:11434");

  assert.equal(semProvider.handle.ai, null);
  assert.equal(semProvider.handle.vision, null);

  const o = await acao(semProvider, "browser.open", { url: `${FIX}/canvas` });
  assert.equal(o.env.success, true, JSON.stringify(o.env.error));

  const f = await acao(semProvider, "browser.find", { target: { semantic: "o botao vermelho escrito COMPRAR" } });
  assert.equal(f.env.success, false);
  assert.equal(f.env.error?.code, "TARGET_NOT_FOUND");
  const visao = ((f.env.error?.detail?.trace ?? []) as any[]).find((t) => t.strategy === "vision");
  assert.ok(visao !== undefined, "o degrau pulado sumiu do rastro");
  assert.equal(visao.outcome, "skipped");
  assert.equal(visao.reason, "nenhum VisionProvider injetado");

  // `browser.task` continua falhando EXPLICITAMENTE (fail closed), não fingindo.
  const t = await acao(semProvider, "browser.task", { goal: "fazer qualquer coisa" });
  assert.equal(t.env.success, false);
  assert.equal(t.env.error?.code, "INVALID_REQUEST");
  assert.match(String(t.env.error?.message), /AgentProvider/);
});

// ─────────────────────────────────────────────────────────────────────────────
// OLLAMA REAL — o único bloco que carrega modelo nesta máquina
// ─────────────────────────────────────────────────────────────────────────────

async function ollamaTem(modelo: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_REAL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const d = (await r.json()) as { models?: { name?: string }[] };
    return (d.models ?? []).some((m) => m.name === modelo);
  } catch {
    return false;
  }
}

test(`[OLLAMA REAL] provider construído da config fala com ${MODELO_REAL} e é descarregado depois`, async (t) => {
  if (!(await ollamaTem(MODELO_REAL))) {
    // Pular COM RAZÃO. Um teste de LLM que "passa" sem backend é o pior
    // resultado possível: verde e vazio.
    t.skip(`backend Ollama em ${OLLAMA_REAL} sem o modelo ${MODELO_REAL} — nada foi medido`);
    return;
  }
  const cfg = loadConfig({ read_file: false, ai_provider: `ollama:${MODELO_REAL}`, ai_timeout_ms: 180_000 } as never);
  const p = buildAiProvider(cfg)!;

  const saude = await p.health();
  assert.equal(saude.status, "ok", JSON.stringify(saude));
  assert.equal(saude.model_present, true);

  const r = await p.request({ prompt: "Responda apenas com o número: 2+2=", max_tokens: 16, temperature: 0 });
  assert.equal(r.ok, true, `provider real falhou: ${JSON.stringify(r.error)}`);
  assert.equal(r.provider_id, `ollama:${MODELO_REAL}`);
  // Âncora de auditoria: o nome vem do SERVIDOR, não do que o modelo diz de si.
  assert.equal(r.meta.model_echo, MODELO_REAL);
  assert.match(r.text, /4/, `resposta inesperada: ${r.text.slice(0, 80)}`);

  // Descarrega. Deixar 4,7 GB residentes é o cenário medido que mata os
  // serviços vizinhos desta máquina por jetsam.
  await p.release?.();
});
