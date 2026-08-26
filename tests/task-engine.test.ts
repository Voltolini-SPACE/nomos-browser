/**
 * FASE 9 — PROVA DO MOTOR DE TASK, contra daemon REAL.
 *
 * REGRA DE HONESTIDADE DESTE ARQUIVO
 * ----------------------------------
 * O plano é scriptado; a FALHA nunca é. Nenhum teste aqui fabrica um código de
 * erro para ver se a política de retentativa sabe lê-lo — isso provaria apenas
 * que o motor consegue ler o campo que ele mesmo escreveu. Cada falha vem do
 * mundo:
 *
 *   CAPABILITY_DENIED  do `CapabilityEngine` real, sobre a política `restricted`;
 *   NAVIGATION_FAILED  de um socket que o servidor de fixture DERRUBA;
 *   TARGET_NOT_FOUND   da cascata de resolução real, contra o DOM real;
 *   TIMEOUT            de um endpoint HTTP real que nunca responde;
 *   BROWSER_UNAVAILABLE de um `BrowserContext` fechado por baixo da sessão;
 *   RUNTIME_CRASH      de um `SIGKILL` real num processo filho real.
 *
 * O LEDGER INDEPENDENTE
 * ---------------------
 * "Não repetiu passo já efetivado" não é medido pelo relatório da própria task —
 * isso seria o réu testemunhando a seu favor. É medido no SERVIDOR DE FIXTURE,
 * que conta quantas vezes cada `/passo/N` foi pedido. Se um resume repetisse um
 * passo, o contador do servidor iria a 2, independentemente do que o motor
 * dissesse sobre si mesmo.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { limparArvores } from "./fixtures/limpeza.ts";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDaemon, type DaemonHandle } from "../packages/api/src/daemon.ts";
import { agenteScriptado, type RoteiroDeAgente } from "./fixtures/task/agente-scriptado.ts";
import {
  TASK_TRANSICOES,
  backoffMs,
  classificarErro,
  estadoFinal,
  podeTransitar,
  retentavel,
  type TaskRecord,
} from "../packages/core/src/taskengine.ts";
import type { PlanStep } from "../packages/core/src/contract.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────────────────────────────────────────────────────────
// Servidor de fixture — e o LEDGER independente
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  base: string;
  /** Todo caminho pedido, na ordem. É o ledger que o motor não controla. */
  pedidos: string[];
  vezes: (caminho: string) => number;
  close: () => Promise<void>;
}

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head><body>${corpo}</body></html>`;
}

const PAGINA_MUTANTE = pagina("mutante", `
  <button id="alvo">Confirmar</button>
  <pre id="log"></pre>
  <script>
    var n = 0;
    document.getElementById("alvo").addEventListener("click", function () {
      n += 1;
      // O alvo MUDA de identidade depois do primeiro clique: é o caso real de
      // uma SPA que re-renderiza. Um runtime que guardasse a coordenada velha
      // clicaria de novo aqui e o log mostraria 2.
      this.id = "alvo-usado-" + n;
      this.textContent = "Confirmado";
      document.getElementById("log").textContent += "clique:" + n + ";";
    });
  </script>`);

function startFixture(): Promise<Fixture> {
  const pedidos: string[] = [];
  const derrubados = new Set<string>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    pedidos.push(url);
    // `Connection: close` em TUDO — e isto não é detalhe de estilo.
    //
    // DEFEITO MEDIDO no primeiro run: o passo instável passava de primeira e o
    // teste da retentativa ficava verde por vacuidade. Causa: com keep-alive, o
    // Chromium REUSA a conexão do passo anterior; quando o servidor a derruba,
    // ele reabre e repete o GET sozinho (comportamento correto dele para
    // requisição idempotente em conexão reusada) e recebe o 200. Ou seja, a
    // falha que o teste queria provocar era absorvida uma camada abaixo do
    // runtime. Com conexão nova a cada pedido, o reset chega ao runtime como
    // ERR_EMPTY_RESPONSE → NAVIGATION_FAILED, que é o fato a ser testado.
    res.setHeader("connection", "close");

    // `/instavel/x` derruba o SOCKET na primeira visita e responde na segunda.
    // Não é um 503 (que o navegador aceitaria como página válida): é um reset de
    // conexão, que produz NAVIGATION_FAILED de verdade no Chromium.
    if (url.startsWith("/instavel/")) {
      if (!derrubados.has(url)) {
        derrubados.add(url);
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pagina("instavel", `<h1 id="ok">estavel agora</h1>`));
      return;
    }

    // Nunca responde. O socket fica aberto e o cliente espera para sempre —
    // é assim que se prova prazo sem usar `sleep` como mecanismo.
    if (url.startsWith("/nunca-responde")) return;

    if (url.startsWith("/mutante")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGINA_MUTANTE);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pagina(url, `<h1 id="titulo">${url}</h1><button id="botao">Entrar</button><div id="marca">${url}</div>`));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("fixture sem endereço");
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        pedidos,
        vezes: (c) => pedidos.filter((p) => p === c).length,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let fixture: Fixture;
let daemon: DaemonHandle;
let raizSessoes: string;
let runtimeDir: string;

/** Roteiro corrente do agente. Mutável: cada teste declara o SEU plano. */
let roteiro: RoteiroDeAgente = { steps: [] };
/** Gancho de `reason()`. Lançar aqui derruba o "provider". */
let aoRaciocinar: (() => void) | null = null;
/** Gancho antes de cada passo. Serve para derrubar o navegador no meio. */
let antesDoPasso: ((step: PlanStep, n: number) => void | Promise<void>) | null = null;

function passo(id: string, action: string, extra: Partial<PlanStep> = {}): PlanStep {
  return { id, intent: `passo ${id}`, action, ...extra };
}

/** Passo que deixa RASTRO no servidor de fixture — a base do ledger. */
function passoGoto(id: string, caminho: string): PlanStep {
  return passo(id, "browser.goto", { value: `${fixture.base}${caminho}` });
}

before(async () => {
  fixture = await startFixture();
  raizSessoes = mkdtempSync(path.join(os.tmpdir(), "nomos-task-sess-"));
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-task-rt-"));

  const agente = agenteScriptado({
    name: "agente-fase9",
    base: () => daemon.url,
    token: () => daemon.token,
    roteiro: () => roteiro,
    onReason: () => {
      if (aoRaciocinar !== null) aoRaciocinar();
    },
    onBeforeStep: async (s, n) => {
      if (antesDoPasso !== null) await antesDoPasso(s, n);
    },
  });

  daemon = await startDaemon({
    agent: agente,
    vision: null,
    host: "127.0.0.1",
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: raizSessoes,
    ai_provider: null,
    ai_provider_fallback: null,
    // Backoff curto: o que se prova aqui é a POLÍTICA (cresce, tem teto, tem
    // jitter), não a duração. `backoffMs` é provado à parte, em unidade.
    task_max_attempts: 3,
    task_retry_base_ms: 20,
    task_retry_max_ms: 120,
    // 2 s contra um endpoint que nunca responde. O prazo do Playwright é 30 s e
    // o da ação é 30 s: se o motor NÃO tivesse prazo próprio, o teste levaria
    // mais de 90 s. É esse contraste que prova de quem é o relógio.
    task_step_timeout_ms: 2_000,
    task_total_timeout_ms: 120_000,
    task_recover_grace_ms: 60_000,
    runtime_dir: runtimeDir,
    read_file: false,
    env: {},
  });
});

after(async () => {
  for (const s of sessoesAbertas.splice(0)) await fecharSessao(s);
  await daemon?.close("fim dos testes");
  await fixture?.close();
  limparArvores(raizSessoes, runtimeDir);
});

interface Resp<T> {
  status: number;
  body: T;
}

async function chamar<T>(method: string, rota: string, body?: unknown): Promise<Resp<T>> {
  const r = await fetch(`${daemon.url}${rota}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-nomos-client": "teste-fase9",
      ...(daemon.token !== null ? { authorization: `Bearer ${daemon.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as T };
}

/**
 * Sessões abertas por este arquivo. O pool tem 4 vagas (`max_workers`) e um
 * teste que abre sem fechar esgota o pool no 5º caso — foi o que aconteceu no
 * primeiro run, e o sintoma (BACKPRESSURE_REJECTED na criação) não tinha nada a
 * ver com o motor de task. Fechar a anterior mantém no máximo uma viva.
 */
const sessoesAbertas: string[] = [];

async function fecharSessao(session_id: string): Promise<void> {
  try {
    await chamar("DELETE", `/api/v1/sessions/${session_id}`, { reason: "fim do caso" });
  } catch {
    // Já fechada (o caso do navegador derrubado por baixo): nada a fazer.
  }
}

async function novaSessao(owner: string): Promise<string> {
  for (const antiga of sessoesAbertas.splice(0)) await fecharSessao(antiga);
  const r = await chamar<{ session_id: string }>("POST", "/api/v1/sessions", { owner, profile: "sandbox" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  sessoesAbertas.push(r.body.session_id);
  return r.body.session_id;
}

interface Envelope<T> {
  success: boolean;
  result: T | null;
  error: { code: string; message: string; detail?: Record<string, unknown> } | null;
}

async function abrirTask(session_id: string, goal: string, extra: Record<string, unknown> = {}): Promise<Resp<Envelope<TaskRecord>>> {
  return chamar<Envelope<TaskRecord>>("POST", "/api/v1/browser.task", { session_id, goal, ...extra });
}

/** Lê o registro persistido — do DISCO, não da memória do daemon. */
async function doDisco(session_id: string, task_id: string): Promise<TaskRecord> {
  const f = path.join(raizSessoes, session_id, "tasks", `${task_id}.json`);
  assert.ok(existsSync(f), `task não foi persistida em ${f}`);
  return JSON.parse(await readFile(f, "utf8")) as TaskRecord;
}

/** Linha do tempo append-only do motor. */
async function linhaDoTempo(session_id: string): Promise<Record<string, unknown>[]> {
  const f = path.join(raizSessoes, session_id, "tasks", "index.jsonl");
  if (!existsSync(f)) return [];
  return (await readFile(f, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Trilha forense da FASE 3. */
async function trilha(session_id: string): Promise<Record<string, unknown>[]> {
  const f = path.join(raizSessoes, session_id, "actions.jsonl");
  if (!existsSync(f)) return [];
  return (await readFile(f, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface BaseDeLease {
  holder: string | null;
  count: number;
  lease_id: string | null;
}

async function capturarLease(sid: string): Promise<BaseDeLease> {
  const r = await chamar<{ current_holder: string | null; leases: { lease_id: string }[] }>(
    "GET", `/api/v1/sessions/${sid}/lease`,
  );
  const ls = Array.isArray(r.body.leases) ? r.body.leases : [];
  return { holder: r.body.current_holder ?? null, count: ls.length, lease_id: ls[0]?.lease_id ?? null };
}

/**
 * A PROPRIEDADE de limpeza quanto ao lease: a task não mexe no controle da sessão.
 *
 * A asserção original era `lease_holder === null && lease_count === 0` e passava
 * por VACUIDADE: com `allow_unleased: true` ninguém adquiria lease algum, então
 * ela media "não sobrou lease" num mundo sem leases. Com a FASE 10 a sessão
 * NASCE com lease exclusivo de quem a criou — lease da SESSÃO, que deve
 * sobreviver ao fim da task —, e exigir `null` reprovaria o comportamento certo.
 *
 * É mais forte que "não cresceu": exige IGUALDADE. Uma task que SOLTASSE o lease
 * da sessão (deixando-a órfã para o próximo agente) passaria em "não cresceu" e
 * é tão defeito quanto vazar um lease novo.
 *
 * Usada pelo caso bom E pelo controle negativo (teste 14b) — é a MESMA função
 * nos dois lados, senão o controle não provaria nada sobre este instrumento.
 */
function leaseIntacto(base: BaseDeLease, d: Record<string, unknown>): { ok: boolean; porque: string } {
  if (base.holder === null || base.count === 0) {
    return { ok: false, porque: "a sessão nasceu SEM lease — a arbitragem não está ligada e a medição seria vácua" };
  }
  if (d.lease_holder !== base.holder) {
    return { ok: false, porque: `holder mudou: ${JSON.stringify(base.holder)} → ${JSON.stringify(d.lease_holder)}` };
  }
  if (Number(d.lease_count) !== base.count) {
    return { ok: false, porque: `contagem mudou: ${base.count} → ${JSON.stringify(d.lease_count)}` };
  }
  return { ok: true, porque: `holder ${base.holder} e contagem ${base.count} preservados` };
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Espera o filho morrer — e aceita que ele JÁ tenha morrido.
 *
 * DEFEITO MEDIDO: `proc.once("exit", ...)` registrado DEPOIS de o processo ter
 * saído nunca dispara, porque o evento já foi emitido. O daemon-filho se mata
 * durante uma requisição HTTP, então quando o `fetch` rejeita ele quase sempre
 * já morreu — e o teste ficava pendurado para sempre num `await` que nunca
 * resolveria. `product02-gate` não tem o problema porque lá o `kill` e o
 * listener acontecem no MESMO tick.
 */
function esperarSaida(proc: ChildProcess, prazo = 30_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("o daemon filho não morreu no prazo")), prazo);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Espera uma condição observável. Nunca é usado como MECANISMO, só como espera. */
async function ate<T>(f: () => Promise<T | null>, prazo = 20_000): Promise<T> {
  const fim = Date.now() + prazo;
  while (Date.now() < fim) {
    const v = await f();
    if (v !== null) return v;
    await dormir(50);
  }
  throw new Error("condição não ocorreu no prazo");
}

// ═════════════════════════════════════════════════════════════════════════════
// 0. A máquina de estados e a classificação — unidade pura
// ═════════════════════════════════════════════════════════════════════════════

test("0a. transição fora da tabela é recusada, e estado final não tem saída", () => {
  assert.equal(podeTransitar("QUEUED", "RUNNING"), true);
  assert.equal(podeTransitar("RUNNING", "COMPLETED"), true);
  assert.equal(podeTransitar("RUNNING", "WAITING"), true);
  // COMPLETED → qualquer coisa é proibido: reabrir uma task destruiria o
  // significado da idempotência.
  for (const s of ["RUNNING", "QUEUED", "FAILED", "CANCELLED", "RECOVERING"] as const) {
    assert.equal(podeTransitar("COMPLETED", s), false, `COMPLETED → ${s} deveria ser proibido`);
    assert.equal(podeTransitar("CANCELLED", s), false, `CANCELLED → ${s} deveria ser proibido`);
  }
  assert.equal(TASK_TRANSICOES.COMPLETED.length, 0);
  assert.equal(TASK_TRANSICOES.FAILED.length, 0);
  assert.equal(TASK_TRANSICOES.CANCELLED.length, 0);
  assert.equal(estadoFinal("COMPLETED") && estadoFinal("FAILED") && estadoFinal("CANCELLED"), true);
  assert.equal(estadoFinal("RECOVERING"), false);
  // QUEUED não pode pular direto para COMPLETED: uma task que "completa" sem
  // nunca ter rodado é o defeito que a tabela existe para tornar impossível.
  assert.equal(podeTransitar("QUEUED", "COMPLETED"), false);
});

test("0b. ação negada por política NUNCA é retentável; desconhecido também não (fail closed)", () => {
  for (const c of ["CAPABILITY_DENIED", "POLICY_BLOCKED", "UPLOAD_DENIED", "INVALID_REQUEST", "ABORTED"]) {
    assert.equal(classificarErro(c), "fatal", `${c} deveria ser fatal`);
    assert.equal(retentavel(c), false, `${c} não pode ser retentado — retry de porta fechada é martelar a porta`);
  }
  for (const c of ["TIMEOUT", "NETWORK", "PROVIDER_DEGRADED", "TARGET_NOT_FOUND", "NAVIGATION_FAILED"]) {
    assert.equal(retentavel(c), true, `${c} deveria ser retentável`);
  }
  // Código que ninguém classificou não vira retry por descuido.
  assert.equal(classificarErro("CODIGO_QUE_NAO_EXISTE"), "desconhecido");
  assert.equal(retentavel("CODIGO_QUE_NAO_EXISTE"), false);
  assert.equal(retentavel(null), false);
});

test("0c. backoff cresce, respeita o teto e o jitter nunca zera a espera", () => {
  const p = { max_attempts: 10, base_ms: 100, max_ms: 1_000, jitter: false };
  assert.equal(backoffMs(1, p), 100);
  assert.equal(backoffMs(2, p), 200);
  assert.equal(backoffMs(3, p), 400);
  assert.equal(backoffMs(50, p), 1_000, "sem teto, a 50ª tentativa esperaria uma eternidade");

  // Jitter: dispersa mas nunca anula. `rnd` fixo nos extremos prova o intervalo.
  const comJitter = { ...p, jitter: true };
  assert.equal(backoffMs(3, comJitter, () => 0), 200, "piso do equal jitter é metade do calculado");
  assert.equal(backoffMs(3, comJitter, () => 1), 400, "teto do equal jitter é o valor calculado");
  // Full jitter devolveria ~0 aqui, o que anularia o próprio backoff.
  assert.ok(backoffMs(3, comJitter, () => 0) > 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Task curta → COMPLETED, persistida, auditada
// ═════════════════════════════════════════════════════════════════════════════

test("1. task de 1 passo completa, é persistida em disco e a auditoria fecha o ciclo", async () => {
  const sid = await novaSessao("DONO-1");
  roteiro = { steps: [passoGoto("p1", "/passo/t1")] };

  const r = await abrirTask(sid, "abrir uma página só");
  assert.equal(r.status, 200, JSON.stringify(r.body.error));
  const t = r.body.result!;
  assert.equal(t.state, "COMPLETED", JSON.stringify(t.last_error));
  assert.equal(t.checkpoint.step_index, 1);
  assert.equal(t.checkpoint.completed.length, 1);
  assert.equal(t.attempt, 0);
  assert.equal(t.retries, 0);

  // O EFEITO aconteceu no mundo, exatamente uma vez.
  assert.equal(fixture.vezes("/passo/t1"), 1, "o passo não agiu, ou agiu duas vezes");

  // Persistência: o arquivo existe e concorda com a resposta.
  const disco = await doDisco(sid, t.task_id);
  assert.equal(disco.state, "COMPLETED");
  assert.equal(disco.task_id, t.task_id);
  assert.equal(disco.checkpoint.step_index, 1);
  assert.ok(disco.outputs !== null, "COMPLETED sem outputs guardados");

  // Linha do tempo do motor: o ciclo inteiro, sem buracos.
  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  const acoes = tl.map((l) => l.action);
  for (const esperada of ["task.created", "task.started", "task.checkpoint", "task.progress", "task.completed", "task.cleanup"]) {
    assert.ok(acoes.includes(esperada), `linha do tempo sem ${esperada}: ${acoes.join(",")}`);
  }
  // `task.cleanup` é a ÚLTIMA: limpeza que acontece antes do fim não é limpeza.
  assert.equal(acoes[acoes.length - 1], "task.cleanup", `última ação foi ${acoes[acoes.length - 1]}`);

  // Trilha forense da FASE 3: as linhas de task carregam provider, owner e o
  // par (step_index, attempt) — sem eles "em que passo isso aconteceu?" ficaria
  // sem resposta depois do cleanup.
  const forense = (await trilha(sid)).filter((l) => l.event === "task" && l.task === t.task_id);
  assert.ok(forense.length >= 5, `trilha forense rala: ${forense.length} linhas`);
  const concluida = forense.find((l) => l.action === "task.completed");
  assert.ok(concluida !== undefined, "task.completed ausente da trilha forense");
  assert.equal(concluida.provider, "agente-fase9");
  assert.equal(concluida.owner, "DONO-1");
  const det = concluida.detail as Record<string, unknown>;
  assert.equal(typeof det.step_index, "number");
  assert.equal(typeof det.attempt, "number");
  assert.equal(det.task_id, t.task_id);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Multi-step → checkpoint A CADA passo
// ═════════════════════════════════════════════════════════════════════════════

test("2. task de 12 passos completa e grava checkpoint a cada passo", async () => {
  const sid = await novaSessao("DONO-2");
  const N = 12;
  roteiro = { steps: Array.from({ length: N }, (_, i) => passoGoto(`m${i}`, `/passo/m${i}`)) };

  const r = await abrirTask(sid, "doze passos");
  const t = r.body.result!;
  assert.equal(t.state, "COMPLETED", JSON.stringify(t.last_error));
  assert.equal(t.checkpoint.step_index, N, "step_index não avançou até o fim");
  assert.equal(t.checkpoint.completed.length, N);
  assert.equal(t.actions.length, N, "nem todo passo virou uma ação real da API");

  // Índices em ordem, sem furo e sem repetição.
  assert.deepEqual(t.checkpoint.completed.map((c) => c.index), Array.from({ length: N }, (_, i) => i));

  // Ledger independente: cada passo tocou o servidor UMA vez.
  for (let i = 0; i < N; i += 1) {
    assert.equal(fixture.vezes(`/passo/m${i}`), 1, `/passo/m${i} foi pedido ${fixture.vezes(`/passo/m${i}`)} vezes`);
  }

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  const checkpoints = tl.filter((l) => l.action === "task.checkpoint");
  // 1 do plano + 1 por passo. Menos que isso significa checkpoint só no fim —
  // e checkpoint só no fim é checkpoint que nunca existe quando importa.
  assert.equal(checkpoints.length, N + 1, `esperava ${N + 1} checkpoints, achei ${checkpoints.length}`);
  // E eles avançam monotonicamente.
  const indices = checkpoints.map((c) => Number((c.detail as Record<string, unknown>).step_index));
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i]! >= indices[i - 1]!, `checkpoint andou para trás: ${indices.join(",")}`);
  }
  assert.equal(indices[indices.length - 1], N);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Erro RETENTÁVEL no meio → RETRYING → sucesso na 2ª tentativa
// ═════════════════════════════════════════════════════════════════════════════

test("3. socket derrubado no passo 3 vira NAVIGATION_FAILED, retenta e completa na 2ª tentativa", async () => {
  const sid = await novaSessao("DONO-3");
  roteiro = {
    steps: [
      passoGoto("r1", "/passo/r1"),
      passoGoto("r2", "/passo/r2"),
      // O servidor DERRUBA o socket na primeira visita a este caminho.
      passoGoto("r3", "/instavel/r3"),
      passoGoto("r4", "/passo/r4"),
    ],
  };

  const r = await abrirTask(sid, "passar por um endpoint instável");
  const t = r.body.result!;
  const diag = () => JSON.stringify({ estado: t.state, retries: t.retries, erro: t.last_error, pedidos: fixture.pedidos.slice(-8) });
  assert.equal(t.state, "COMPLETED", `deveria ter se recuperado: ${diag()}`);

  /**
   * NÃO se afirma "exatamente 1 retentativa" aqui — e a razão é uma medição.
   *
   * Depois de um ERR_EMPTY_RESPONSE o Chromium exibe página de erro e pode
   * recarregar por conta própria; a recarga às vezes colide com o `goto` da
   * tentativa seguinte e o Playwright devolve "navigation interrupted". O
   * resultado é 1 OU 2 falhas antes do sucesso, dependendo de uma corrida
   * interna do NAVEGADOR. Cravar o número mediria o Chromium, não o motor — e
   * um teste que mede a coisa errada fica vermelho por motivo alheio.
   *
   * O que É do motor, e portanto é cravado: houve retentativa; o passo passou na
   * tentativa `retries + 1`; os passos ANTERIORES não foram tocados de novo; e
   * cada retentativa deixou exatamente uma linha, classificada como retentável.
   */
  assert.ok(t.retries >= 1, `nenhuma retentativa aconteceu: ${diag()}`);
  assert.ok(t.retries <= 2, `mais retentativas que o esperado: ${diag()}`);

  const p3 = t.checkpoint.completed.find((c) => c.step_id === "r3");
  assert.ok(p3 !== undefined, "o passo r3 nunca concluiu");
  assert.equal(p3.attempt, t.retries + 1, "o `attempt` do passo não bate com o contador de retentativas da task");
  assert.ok(p3.attempt >= 2, "o passo instável passou de primeira: a falha não chegou ao runtime");

  // Os passos estáveis passaram de primeira e NÃO foram reexecutados.
  for (const id of ["r1", "r2", "r4"]) {
    assert.equal(t.checkpoint.completed.find((c) => c.step_id === id)!.attempt, 1);
  }
  assert.equal(fixture.vezes("/passo/r1"), 1, "o retry reexecutou um passo já efetivado");
  assert.equal(fixture.vezes("/passo/r2"), 1, "o retry reexecutou um passo já efetivado");
  assert.equal(fixture.vezes("/passo/r4"), 1);
  assert.ok(fixture.vezes("/instavel/r3") >= 2, "o endpoint instável só foi visitado uma vez");

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  const retry = tl.filter((l) => l.action === "task.retry");
  assert.equal(retry.length, t.retries, "número de linhas de retry diverge do contador da task");
  for (const linha of retry) {
    const d = linha.detail as Record<string, unknown>;
    assert.equal(d.code, "NAVIGATION_FAILED", `retry por código inesperado: ${JSON.stringify(d)}`);
    assert.equal(d.classe, "retentavel");
  }
  // RETRYING é a decisão; WAITING é o relógio. Os dois são estados observáveis.
  assert.equal(tl.filter((l) => l.action === "task.waiting").length, t.retries, "a espera do backoff não foi registrada");
  assert.ok(tl.some((l) => l.state === "RETRYING"), "a task nunca passou por RETRYING");
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Erro NÃO-retentável → FAILED imediato, ZERO retentativas
// ═════════════════════════════════════════════════════════════════════════════

test("4. CAPABILITY_DENIED real no passo 2 falha na hora, com zero retentativas", async () => {
  const sid = await novaSessao("DONO-4");
  roteiro = {
    steps: [
      passoGoto("c1", "/passo/c1"),
      // `browser.download` é negado pela política `restricted` — a negação vem
      // do CapabilityEngine real, antes de o Chromium ser tocado.
      passo("c2", "browser.download", { target: { selector: "#botao" } }),
      passoGoto("c3", "/passo/c3-nunca"),
    ],
  };

  const r = await abrirTask(sid, "tentar baixar sem permissão");
  assert.equal(r.body.success, false, "ação negada por política não pode devolver sucesso");
  const detalhe = r.body.error!.detail as Record<string, unknown>;
  assert.equal(detalhe.task_code, "CAPABILITY_DENIED", JSON.stringify(detalhe));
  assert.equal(r.body.error!.code, "CAPABILITY_DENIED");

  const t = await doDisco(sid, String(detalhe.task_id));
  assert.equal(t.state, "FAILED");
  assert.equal(t.last_error?.code, "CAPABILITY_DENIED");
  assert.equal(t.last_error?.classe, "fatal");
  assert.equal(t.last_error?.step_index, 1);
  // A prova central: NENHUMA retentativa. Repetir ação negada por política é
  // martelar a porta.
  assert.equal(t.retries, 0, `houve ${t.retries} retentativa(s) de uma ação NEGADA POR POLÍTICA`);
  assert.equal(t.last_error?.attempt, 1, "a falha fatal aconteceu na 1ª tentativa e ali deveria ter parado");

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  assert.equal(tl.filter((l) => l.action === "task.retry").length, 0, "houve linha de retry para erro fatal");
  assert.equal(tl.filter((l) => l.action === "task.waiting").length, 0);

  // E o passo seguinte NÃO rodou.
  assert.equal(fixture.vezes("/passo/c3-nunca"), 0, "a task seguiu executando depois de falhar");
  assert.equal(t.checkpoint.step_index, 1, "o checkpoint avançou por cima de um passo que falhou");
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. max_attempts esgotado → FAILED com last_error
// ═════════════════════════════════════════════════════════════════════════════

test("5. alvo que nunca existe esgota max_attempts e falha com last_error preenchido", async () => {
  const sid = await novaSessao("DONO-5");
  roteiro = {
    steps: [
      passoGoto("e1", "/passo/e1"),
      passo("e2", "browser.click", { target: { selector: "#este-elemento-nao-existe-em-lugar-nenhum" } }),
    ],
  };

  const r = await abrirTask(sid, "clicar no que não existe");
  assert.equal(r.body.success, false);
  const t = await doDisco(sid, String((r.body.error!.detail as Record<string, unknown>).task_id));

  assert.equal(t.state, "FAILED");
  assert.ok(t.last_error !== null, "FAILED sem last_error — o defeito clássico de estado sem causa");
  assert.equal(t.last_error!.classe, "retentavel", "TARGET_NOT_FOUND é transitório por natureza");
  assert.match(t.last_error!.message, /esgotadas 3 de 3 tentativas/);
  // 3 tentativas totais = 2 retentativas.
  assert.equal(t.retries, 2, `esperava 2 retentativas (3 tentativas), houve ${t.retries}`);
  assert.equal(t.last_error!.attempt, 3);
  assert.equal(t.last_error!.step_index, 1);

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  assert.equal(tl.filter((l) => l.action === "task.retry").length, 2);
  assert.equal(tl.filter((l) => l.action === "task.failed").length, 1);
  assert.equal(tl.filter((l) => l.action === "task.cleanup").length, 1, "task final sem limpeza");
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. CRASH do daemon no meio da task → RECOVERING → resume → COMPLETED
//    sem repetir nenhum passo já efetivado
// ═════════════════════════════════════════════════════════════════════════════

test("6. SIGKILL no meio da task: recuperação, resume e ZERO passos repetidos", async () => {
  const raiz = mkdtempSync(path.join(os.tmpdir(), "nomos-crash-sess-"));
  const rt = mkdtempSync(path.join(os.tmpdir(), "nomos-crash-rt-"));
  const roteiroPath = path.join(rt, "roteiro.json");
  const porta = 7793;
  const N = 8;
  const MATAR_EM = 4; // morre ANTES de despachar o 4º passo (índice 3)

  // Passos que deixam rastro NO SERVIDOR: é o ledger que o daemon não controla.
  const passos = Array.from({ length: N }, (_, i) => ({
    id: `k${i}`,
    intent: `passo ${i}`,
    action: "browser.goto",
    value: `${fixture.base}/passo/k${i}`,
  }));
  writeFileSync(roteiroPath, JSON.stringify({ steps: passos }), "utf8");

  const subir = async (matarEm: number | null): Promise<ChildProcess> => {
    const p = spawn(process.execPath, [path.join(RAIZ, "tests/fixtures/task/daemon-filho.ts")], {
      env: {
        ...process.env,
        NOMOS_BROWSER_PORT: String(porta),
        NOMOS_BROWSER_HEADLESS: "true",
        NOMOS_BROWSER_ALLOW_INTERNAL: "true",
        NOMOS_SESSIONS_ROOT: raiz,
        NOMOS_RUNTIME_DIR: rt,
        NOMOS_TESTE_ROTEIRO: roteiroPath,
        NOMOS_BROWSER_TASK_RETRY_BASE_MS: "20",
        NOMOS_BROWSER_TASK_RETRY_MAX_MS: "120",
        // Graça longa: o teste quer ver RECOVERING e retomar à mão. Uma graça
        // curta transformaria a corrida do teste em FAILED antes do resume.
        NOMOS_BROWSER_TASK_RECOVER_GRACE_MS: "60000",
        ...(matarEm !== null ? { NOMOS_TESTE_MATAR_EM: String(matarEm) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const prazo = Date.now() + 60_000;
    while (Date.now() < prazo) {
      try {
        const r = await fetch(`http://127.0.0.1:${porta}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.status === 200 || r.status === 401) return p;
      } catch {
        /* ainda subindo */
      }
      await dormir(250);
    }
    p.kill("SIGKILL");
    throw new Error("daemon filho não subiu a tempo");
  };

  const { readControlToken } = await import("../packages/api/src/auth.ts");
  const H = (tok: string): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${tok}`,
    "x-nomos-client": "teste-crash",
  });

  let proc: ChildProcess | null = null;
  try {
    // ── 1ª vida: cria sessão, abre a task, e o processo se mata no 4º passo ──
    proc = await subir(MATAR_EM);
    const pid1 = proc.pid!;
    const tok1 = readControlToken(rt)!;
    assert.ok(tok1 !== null);

    const s = (await (await fetch(`http://127.0.0.1:${porta}/api/v1/sessions`, {
      method: "POST", headers: H(tok1), body: JSON.stringify({ owner: "DONO-CRASH", profile: "sandbox" }),
    })).json()) as { session_id: string };
    const sid = s.session_id;

    // A chamada morre junto com o daemon: o `catch` é o esperado, não o desvio.
    await fetch(`http://127.0.0.1:${porta}/api/v1/browser.task`, {
      method: "POST",
      headers: H(tok1),
      body: JSON.stringify({ session_id: sid, goal: "oito passos com crash no meio", idempotency_key: "crash-fase9" }),
    }).catch(() => undefined);

    await esperarSaida(proc);
    assert.equal(proc.signalCode, "SIGKILL", `o daemon filho saiu por ${proc.signalCode ?? proc.exitCode} em vez de SIGKILL`);

    // ── o que ficou em disco: RUNNING, e é MENTIRA ──────────────────────────
    const dir = path.join(raiz, sid, "tasks");
    const arquivo = await ate(async () => {
      const { readdirSync } = await import("node:fs");
      try {
        const f = readdirSync(dir).filter((x) => x.endsWith(".json"));
        return f.length > 0 ? path.join(dir, f[0]!) : null;
      } catch {
        return null;
      }
    }, 10_000);
    const antes = JSON.parse(readFileSync(arquivo, "utf8")) as TaskRecord;
    assert.ok(
      ["RUNNING", "RETRYING", "WAITING"].includes(antes.state),
      `esperava o estado mentiroso em disco, achei ${antes.state} — sem ele não há o que recuperar`,
    );
    // ANTI-VACUIDADE: o crash tem de ter acontecido DEPOIS de algum efeito e
    // ANTES do fim. Se o checkpoint estivesse em 0 ou em N, este teste não
    // provaria nada sobre "não repetir o que já teve efeito".
    assert.ok(antes.checkpoint.step_index > 0, "o crash aconteceu antes de qualquer passo: nada a não repetir");
    assert.ok(antes.checkpoint.step_index < N, "o crash aconteceu depois do último passo: nada a retomar");
    const jaFeitos = antes.checkpoint.step_index;

    // O servidor viu exatamente os passos efetivados, uma vez cada.
    for (let i = 0; i < jaFeitos; i += 1) {
      assert.equal(fixture.vezes(`/passo/k${i}`), 1, `/passo/k${i} devia ter sido pedido 1 vez antes do crash`);
    }
    assert.equal(fixture.vezes(`/passo/k${jaFeitos}`), 0, "um passo além do checkpoint já teve efeito");

    // ── 2ª vida: sobe de novo, SEM se matar ─────────────────────────────────
    proc = await subir(null);
    assert.notEqual(proc.pid, pid1, "o pid deveria ser novo");
    const tok2 = readControlToken(rt)!;

    // O daemon varreu o disco no arranque: nada de `RUNNING` mentiroso.
    const depois = (await (await fetch(`http://127.0.0.1:${porta}/api/v1/tasks/${antes.task_id}?session_id=${sid}`, {
      headers: H(tok2),
    })).json()) as TaskRecord;
    assert.equal(depois.state, "RECOVERING", `a task ficou ${depois.state} depois do crash`);
    assert.equal(depois.last_error?.code, "RUNTIME_CRASH");
    assert.equal(depois.checkpoint.step_index, jaFeitos, "o checkpoint mudou sozinho durante a recuperação");
    assert.equal(depois.task_id, antes.task_id);

    // IDEMPOTÊNCIA ENTRE REINÍCIOS: a mesma chave, num processo NOVO, não cria
    // outra task — a reserva está em disco.
    const sNova = (await (await fetch(`http://127.0.0.1:${porta}/api/v1/sessions`, {
      method: "POST", headers: H(tok2), body: JSON.stringify({ owner: "DONO-CRASH", profile: "sandbox" }),
    })).json()) as { session_id: string };

    // ── resume: retoma na sessão NOVA, do checkpoint ────────────────────────
    const retomada = (await (await fetch(`http://127.0.0.1:${porta}/api/v1/tasks/${antes.task_id}/resume`, {
      method: "POST", headers: H(tok2), body: JSON.stringify({ session_id: sNova.session_id }),
    })).json()) as TaskRecord;

    assert.equal(retomada.state, "COMPLETED", `resume não completou: ${JSON.stringify(retomada.last_error)}`);
    assert.equal(retomada.task_id, antes.task_id, "o resume criou outra task");
    assert.equal(retomada.checkpoint.completed.length, N);
    assert.notEqual(retomada.run_id, antes.run_id, "resume é uma EXECUÇÃO nova e deveria ter run_id próprio");

    // ── A PROVA CENTRAL: nenhum passo já efetivado foi repetido ─────────────
    for (let i = 0; i < N; i += 1) {
      assert.equal(
        fixture.vezes(`/passo/k${i}`),
        1,
        `/passo/k${i} foi executado ${fixture.vezes(`/passo/k${i}`)} vezes — o resume repetiu efeito`,
      );
    }

    // A mesma chave depois de COMPLETED devolve a MESMA task, sem reexecutar.
    const antesDoEco = fixture.pedidos.length;
    const eco = (await (await fetch(`http://127.0.0.1:${porta}/api/v1/browser.task`, {
      method: "POST", headers: H(tok2),
      body: JSON.stringify({ session_id: sNova.session_id, goal: "oito passos com crash no meio", idempotency_key: "crash-fase9" }),
    })).json()) as Envelope<TaskRecord>;
    assert.equal(eco.success, true, JSON.stringify(eco.error));
    assert.equal(eco.result!.task_id, antes.task_id, "a chave de idempotência não sobreviveu ao reinício");
    assert.equal(fixture.pedidos.length, antesDoEco, "a chamada idempotente reexecutou passos");
  } finally {
    if (proc !== null && proc.exitCode === null) {
      proc.kill("SIGKILL");
      await dormir(500);
    }
    rmSync(raiz, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Resume de task JÁ COMPLETA → resultado guardado, sem reexecutar
// ═════════════════════════════════════════════════════════════════════════════

test("7. resume de task completa devolve o resultado guardado e não reexecuta nada", async () => {
  const sid = await novaSessao("DONO-7");
  roteiro = { steps: [passoGoto("s1", "/passo/s1"), passoGoto("s2", "/passo/s2")] };

  const r = await abrirTask(sid, "duas paradas");
  const t = r.body.result!;
  assert.equal(t.state, "COMPLETED");
  assert.equal(fixture.vezes("/passo/s1"), 1);

  const pedidosAntes = fixture.pedidos.length;
  const rr = await chamar<TaskRecord>("POST", `/api/v1/tasks/${t.task_id}/resume`, {});
  assert.equal(rr.status, 200, JSON.stringify(rr.body));

  assert.equal(rr.body.task_id, t.task_id);
  assert.equal(rr.body.state, "COMPLETED");
  assert.deepEqual(rr.body.outputs, t.outputs, "o resultado guardado mudou entre a task e o resume");
  assert.equal(rr.body.run_id, t.run_id, "resume de task final não inicia execução nova e não deveria trocar o run_id");
  // A prova de que não reexecutou: o servidor não recebeu NADA a mais.
  assert.equal(fixture.pedidos.length, pedidosAntes, "o resume reexecutou passos de uma task já completa");
  assert.equal(fixture.vezes("/passo/s1"), 1);
  assert.equal(fixture.vezes("/passo/s2"), 1);

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id && l.action === "task.resume");
  assert.equal(tl.length, 1);
  assert.equal((tl[0]!.detail as Record<string, unknown>).replayed, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Idempotência
// ═════════════════════════════════════════════════════════════════════════════

test("8. mesma idempotency_key: duas chamadas simultâneas viram UMA task; depois de COMPLETED, ecoa", async () => {
  const sid = await novaSessao("DONO-8");
  roteiro = { steps: [passoGoto("i1", "/passo/i1"), passoGoto("i2", "/passo/i2")] };
  const chave = `idem-${Date.now()}`;

  // ── simultâneas ─────────────────────────────────────────────────────────
  const [a, b] = await Promise.all([
    abrirTask(sid, "trabalho idempotente", { idempotency_key: chave }),
    abrirTask(sid, "trabalho idempotente", { idempotency_key: chave }),
  ]);
  assert.equal(a.body.success, true, JSON.stringify(a.body.error));
  assert.equal(b.body.success, true, JSON.stringify(b.body.error));
  assert.equal(a.body.result!.task_id, b.body.result!.task_id, "a mesma chave criou DUAS tasks");
  const t = a.body.result!;
  assert.equal(t.state, "COMPLETED");

  // O trabalho aconteceu UMA vez, não duas.
  assert.equal(fixture.vezes("/passo/i1"), 1, "duas chamadas com a mesma chave executaram o passo duas vezes");
  assert.equal(fixture.vezes("/passo/i2"), 1);

  // E existe UM arquivo de task com essa chave nesta sessão.
  const listadas = await chamar<{ tasks: TaskRecord[] }>("GET", `/api/v1/tasks?session_id=${sid}`);
  assert.equal(listadas.status, 200);
  const comAChave = listadas.body.tasks.filter((x) => x.idempotency_key === chave);
  assert.equal(comAChave.length, 1, `a chave ${chave} tem ${comAChave.length} tasks`);

  // ── depois de COMPLETED ─────────────────────────────────────────────────
  const pedidosAntes = fixture.pedidos.length;
  const eco = await abrirTask(sid, "trabalho idempotente", { idempotency_key: chave });
  assert.equal(eco.body.success, true, JSON.stringify(eco.body.error));
  assert.equal(eco.body.result!.task_id, t.task_id, "a chave não devolveu a mesma task depois de COMPLETED");
  assert.deepEqual(eco.body.result!.outputs, t.outputs, "o resultado guardado não foi devolvido");
  assert.equal(fixture.pedidos.length, pedidosAntes, "a chamada idempotente reexecutou o trabalho");

  // CONTROLE: chave DIFERENTE tem de criar task nova e executar de novo. Sem
  // isto, um motor que ignorasse `goal` e devolvesse sempre a primeira task
  // passaria em tudo acima.
  const outra = await abrirTask(sid, "trabalho idempotente", { idempotency_key: `${chave}-outra` });
  assert.equal(outra.body.success, true, JSON.stringify(outra.body.error));
  assert.notEqual(outra.body.result!.task_id, t.task_id, "chave diferente reusou a task antiga");
  assert.equal(fixture.vezes("/passo/i1"), 2, "a task nova não executou o trabalho");
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Cancel no meio → passo em voo abortado, nada depois é executado
// ═════════════════════════════════════════════════════════════════════════════

test("9. cancel no meio aborta o passo em voo e nenhum passo posterior roda", async () => {
  const sid = await novaSessao("DONO-9");
  roteiro = {
    steps: [
      passoGoto("x1", "/passo/x1"),
      // Servidor real que nunca responde: o passo fica genuinamente em voo.
      passoGoto("x2", "/nunca-responde/x2"),
      passoGoto("x3", "/passo/x3-nunca-deve-rodar"),
    ],
  };

  const emVoo = abrirTask(sid, "cancelar no meio");

  // Espera o passo 2 chegar de fato ao servidor — cancelar antes disso provaria
  // menos: o passo precisa estar EM VOO para que abortá-lo signifique algo.
  await ate(async () => (fixture.vezes("/nunca-responde/x2") >= 1 ? true : null), 15_000);
  const lista = await ate(async () => {
    const l = await chamar<{ tasks: TaskRecord[] }>("GET", `/api/v1/tasks?session_id=${sid}`);
    const viva = l.body.tasks.find((x) => !estadoFinal(x.state));
    return viva ?? null;
  }, 10_000);

  const c = await chamar<TaskRecord>("POST", `/api/v1/tasks/${lista.task_id}/cancel`, { reason: "o operador mandou parar" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.state, "CANCELLED", `cancel devolveu ${c.body.state}`);
  assert.equal(c.body.last_error?.code, "CANCELLED");

  const env = await emVoo;
  assert.equal(env.body.success, false, "a task cancelada devolveu sucesso");
  assert.equal((env.body.error!.detail as Record<string, unknown>).task_code, "CANCELLED");

  // NADA depois do cancelamento.
  assert.equal(fixture.vezes("/passo/x3-nunca-deve-rodar"), 0, "um passo rodou DEPOIS do cancelamento");
  const disco = await doDisco(sid, lista.task_id);
  assert.equal(disco.state, "CANCELLED");
  assert.equal(disco.checkpoint.completed.length, 1, "o passo em voo foi contado como concluído");

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === lista.task_id);
  const cancelada = tl.find((l) => l.action === "task.cancelled");
  assert.ok(cancelada !== undefined, "cancelamento sem linha na trilha");
  const limpeza = tl.find((l) => l.action === "task.cleanup");
  assert.ok(limpeza !== undefined, "cancelamento sem limpeza");
  assert.equal((limpeza.detail as Record<string, unknown>).aborted, true);
  // Estado final não aceita mais transição: cancelar de novo é no-op, não erro.
  const denovo = await chamar<TaskRecord>("POST", `/api/v1/tasks/${lista.task_id}/cancel`, {});
  assert.equal(denovo.status, 200);
  assert.equal(denovo.body.state, "CANCELLED");
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Timeout de PASSO → TIMEOUT classificado e retentado pela política
// ═════════════════════════════════════════════════════════════════════════════

test("10. passo contra servidor que nunca responde estoura o prazo DO MOTOR e retenta", async () => {
  const sid = await novaSessao("DONO-10");
  roteiro = { steps: [passoGoto("w1", "/nunca-responde/w1")] };

  const t0 = Date.now();
  const r = await abrirTask(sid, "esperar o que nunca vem");
  const gasto = Date.now() - t0;
  assert.equal(r.body.success, false);
  const t = await doDisco(sid, String((r.body.error!.detail as Record<string, unknown>).task_id));

  assert.equal(t.state, "FAILED");
  assert.equal(t.retries, 2, `esperava 2 retentativas (3 tentativas), houve ${t.retries}`);

  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  const retries = tl.filter((l) => l.action === "task.retry");
  assert.equal(retries.length, 2);
  // A PRIMEIRA falha é do relógio do MOTOR: nada respondeu, nada foi interrompido.
  assert.equal((retries[0]!.detail as Record<string, unknown>).code, "TIMEOUT", `primeira falha: ${JSON.stringify(retries[0]!.detail)}`);
  assert.equal((retries[0]!.detail as Record<string, unknown>).classe, "retentavel");

  /**
   * DE QUEM É O RELÓGIO — o discriminador que impede este teste de ser vácuo.
   *
   * O prazo do motor é 2 s; o do Playwright, 30 s; o da ação, 30 s. Três
   * tentativas contra um servidor mudo levariam mais de 90 s se o motor não
   * tivesse prazo próprio. Terminar em poucos segundos só é possível porque
   * quem cortou foi o motor.
   */
  assert.ok(gasto < 20_000, `a task levou ${gasto} ms: o prazo que cortou não foi o do motor`);
  assert.ok(gasto >= 2_000, `a task levou ${gasto} ms: nem o primeiro prazo de passo foi respeitado`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Provider fora → provider.degraded na trilha e a task FALHA
//
// DECLARAÇÃO EXPLÍCITA (a missão pede que se declare qual): a task FALHA. Não
// há fallback no nível do motor, e é de propósito — o fallback entre modelos
// vive no roteador de providers (`packages/api/src/providers.ts`), uma camada
// abaixo. Um segundo fallback aqui esconderia do operador que o primeiro caiu,
// e a task diria "deu certo" sobre um plano que nenhum modelo saudável fez.
// ═════════════════════════════════════════════════════════════════════════════

test("11. provider fora do ar registra provider.degraded UMA vez e a task falha (sem fallback)", async () => {
  const sid = await novaSessao("DONO-11");
  roteiro = { steps: [passoGoto("d1", "/passo/d1-nunca")] };
  aoRaciocinar = () => {
    throw new Error("backend de modelos inalcançável");
  };
  try {
    const r = await abrirTask(sid, "planejar com o modelo fora");
    assert.equal(r.body.success, false, "provider caído não pode devolver sucesso");

    const forense = (await trilha(sid)).filter((l) => l.event === "provider" && l.action === "provider.degraded");
    assert.equal(forense.length, 1, `esperava 1 provider.degraded, achei ${forense.length}`);
    assert.equal(forense[0]!.provider, "agente-fase9");
    assert.equal(forense[0]!.result, "error");
    assert.equal((forense[0]!.detail as Record<string, unknown>).etapa, "reason");

    // PLANEJAR NÃO É RETENTADO: se fosse, haveria 3 linhas de degradação para a
    // mesma falha e três inferências gastas contra um modelo que já disse estar fora.
    const t = await doDisco(sid, String((r.body.error!.detail as Record<string, unknown>).task_id));
    assert.equal(t.state, "FAILED");
    assert.equal(t.retries, 0, "o planejamento foi retentado");
    assert.ok(t.last_error !== null, "FAILED sem causa registrada");
    assert.equal(t.checkpoint.plan, null, "guardou um plano que nunca existiu");

    // Nenhum passo foi executado: falhou ANTES de tocar o navegador.
    assert.equal(fixture.vezes("/passo/d1-nunca"), 0);
  } finally {
    aoRaciocinar = null;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Navegador derrubado POR BAIXO → a task não fica RUNNING mentindo
// ═════════════════════════════════════════════════════════════════════════════

test("12. BrowserContext fechado no meio da task encerra a task; nada fica RUNNING", async () => {
  const sid = await novaSessao("DONO-12");
  roteiro = {
    steps: [
      passoGoto("b1", "/passo/b1"),
      passoGoto("b2", "/passo/b2"),
      passoGoto("b3", "/passo/b3"),
      passoGoto("b4", "/passo/b4"),
    ],
  };
  // Ancorado no ID DO PASSO, não num contador: identidade não depende de quantos
  // outros casos já rodaram antes neste mesmo daemon.
  antesDoPasso = async (s) => {
    if (s.id !== "b3") return;
    // Fecha o CONTEXTO por baixo da sessão: o runtime não é avisado, exatamente
    // como num Chromium que morre. Não é `closeSession`, que seria um
    // encerramento limpo e não provaria nada.
    const page = daemon.sessions.getPage(sid);
    await page.context().close();
  };
  try {
    const r = await abrirTask(sid, "sobreviver ao navegador morrendo");
    assert.equal(r.body.success, false, "a task disse ter completado com o navegador morto");

    const task_id = String((r.body.error!.detail as Record<string, unknown>).task_id);
    const t = await doDisco(sid, task_id);
    // O ponto inteiro: estado FINAL e honesto, com causa. Nunca `RUNNING`.
    assert.ok(estadoFinal(t.state), `a task ficou em ${t.state} com o navegador morto`);
    assert.equal(t.state, "FAILED");
    assert.ok(t.last_error !== null, "FAILED sem last_error");
    assert.ok(t.checkpoint.step_index >= 2, "o crash aconteceu cedo demais para provar retomabilidade");
    assert.ok(t.checkpoint.step_index < 4, "a task completou apesar do navegador morto");

    // E a API concorda com o disco — não há dois estados divergentes.
    const via = await chamar<TaskRecord>("GET", `/api/v1/tasks/${task_id}`);
    assert.equal(via.body.state, "FAILED");

    const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === task_id);
    assert.equal(tl.filter((l) => l.action === "task.cleanup").length, 1, "task morta sem limpeza");
  } finally {
    antesDoPasso = null;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Alvo muda entre passos → falha e entra na política; nunca clica coordenada velha
// ═════════════════════════════════════════════════════════════════════════════

test("13. alvo que muda de identidade entre passos falha e NUNCA é clicado de novo por coordenada", async () => {
  const sid = await novaSessao("DONO-13");
  roteiro = {
    steps: [
      passoGoto("t1", "/mutante"),
      // Primeiro clique: existe, funciona — e a página renomeia o elemento.
      passo("t2", "browser.click", { target: { selector: "#alvo" } }),
      // Segundo clique no MESMO seletor: o alvo já não existe com essa identidade.
      passo("t3", "browser.click", { target: { selector: "#alvo" } }),
    ],
  };

  const r = await abrirTask(sid, "clicar duas vezes num alvo que se renomeia");
  assert.equal(r.body.success, false, "clicou num alvo que não existe mais");
  const t = await doDisco(sid, String((r.body.error!.detail as Record<string, unknown>).task_id));

  assert.equal(t.state, "FAILED");
  assert.equal(t.last_error?.step_index, 2, "a falha não foi no passo do alvo mudado");
  assert.equal(t.last_error?.code, "TARGET_NOT_FOUND");
  // Entrou na política de retentativa (alvo sumido é transitório por natureza:
  // um spinner some, um modal fecha) e só desistiu ao esgotar as tentativas.
  assert.equal(t.last_error?.classe, "retentavel");
  assert.equal(t.retries, 2, `esperava 2 retentativas, houve ${t.retries}`);
  assert.equal(t.checkpoint.completed.length, 2, "o passo que falhou entrou no checkpoint");

  /**
   * A PROVA: a própria página conta quantos cliques recebeu. Um runtime que
   * reusasse a coordenada resolvida no passo anterior clicaria de novo no mesmo
   * pixel — o elemento continua lá, só mudou de id — e o log mostraria 2. Ele
   * mostra 1 porque cada tentativa parte do `TargetDescriptor` e refaz a cascata
   * de resolução do zero.
   */
  const log = await chamar<Envelope<{ content: string }>>("POST", "/api/v1/browser.extract", {
    session_id: sid,
    target: { selector: "#log" },
  });
  assert.equal(log.body.success, true, JSON.stringify(log.body.error));
  assert.equal(
    log.body.result!.content.trim(),
    "clique:1;",
    `a página recebeu cliques a mais: ${log.body.result!.content} — alguém reusou coordenada velha`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. Cleanup: sem processo residual, sem aba órfã, sem lease pendurado
// ═════════════════════════════════════════════════════════════════════════════

test("14. depois do estado final não sobra processo, aba órfã nem lease", async () => {
  const sid = await novaSessao("DONO-14");
  // FASE 10 — de quem é o volante ANTES da task. A sessão passa a nascer com
  // lease exclusivo do principal que a criou (`allow_unleased` virou `false`
  // por default), então este valor é o ponto de comparação do fim.
  const baseLease = await capturarLease(sid);
  const donoDoLease = baseLease.holder;
  assert.ok(donoDoLease !== null, "a sessão nasceu sem lease — a arbitragem da FASE 10 não está ligada");
  assert.equal(baseLease.count, 1, "a sessão deveria nascer com exatamente um lease exclusivo");
  roteiro = {
    steps: [
      passoGoto("l1", "/passo/l1"),
      passo("l2", "browser.new_tab", {}),
      passoGoto("l3", "/passo/l3"),
    ],
  };
  const r = await abrirTask(sid, "abrir aba e terminar limpo");
  const t = r.body.result!;
  assert.equal(t.state, "COMPLETED", JSON.stringify(t.last_error));

  // ── a linha de limpeza carrega EVIDÊNCIA, não um "ok" decorativo ─────────
  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === t.task_id);
  const limpeza = tl.find((l) => l.action === "task.cleanup");
  assert.ok(limpeza !== undefined, "estado final sem task.cleanup");
  const d = limpeza.detail as Record<string, unknown>;
  assert.equal(d.released, true);
  assert.equal(d.aborted, true, "o AbortController da task não foi abortado no fim");
  // A asserção anterior era `lease_holder === null && lease_count === 0`. Ela
  // passava por VACUIDADE: com `allow_unleased: true`, ninguém adquiria lease
  // nenhum e "zero lease no fim" era o estado de sempre, task ou não. Com a
  // FASE 10 a sessão nasce com dono, e a pergunta certa fica mais forte: a task
  // MEXEU no lease? Holder igual ao do início e contagem exatamente 1 provam
  // que ela não adquiriu lease próprio nem derrubou o de quem a chamou.
  assert.equal(d.lease_holder, donoDoLease, "a task trocou o dono do lease da sessão");
  assert.equal(d.lease_count, 1, "a task deixou lease EXTRA pendurado na sessão");
  const leaseDepois = await chamar<{ current_holder: string | null; leases: unknown[] }>(
    "GET",
    `/api/v1/sessions/${sid}/lease`,
  );
  assert.equal(leaseDepois.body.current_holder, donoDoLease, "o holder mudou entre o início e o fim da task");
  assert.equal(leaseDepois.body.leases.length, 1, "sobrou mais de um lease vivo na sessão");
  // A MESMA função que o controle negativo (14b) usa para REPROVAR.
  const vereditoLease = leaseIntacto(baseLease, d);
  assert.equal(vereditoLease.ok, true, `a limpeza mexeu no lease: ${vereditoLease.porque}`);
  // Identidade do lease, não só do holder: soltar e readquirir devolveria o
  // mesmo holder com outro `lease_id` e escaparia da igualdade de nome.
  assert.equal(
    (leaseDepois.body.leases[0] as { lease_id?: string } | undefined)?.lease_id,
    baseLease.lease_id,
    "o lease foi solto e readquirido no meio — mesmo holder, outro lease_id",
  );
  assert.equal(d.queue_waiting, 0, "sobrou trabalho enfileirado depois do fim da task");
  assert.equal(typeof d.pages_open, "number", "a limpeza não mediu as abas — sem número não há prova");

  // ── nenhuma aba órfã: a sessão tem exatamente o que o plano abriu ────────
  const info = await chamar<{ pages: { page_id: string }[] }>("GET", `/api/v1/sessions/${sid}`);
  assert.equal(info.body.pages.length, d.pages_open, "a contagem de abas da limpeza não bate com a sessão");
  assert.equal(info.body.pages.length, 2, "a sessão tem abas além da inicial e da que o plano abriu");

  // ── fechada a sessão, o pool volta a zero ────────────────────────────────
  await fecharSessao(sid);
  sessoesAbertas.splice(0);
  const saude = daemon.health();
  assert.equal(saude.sessions.active, 0, "sobrou sessão ativa depois do fechamento");
  assert.equal(daemon.sessions.poolStats().contexts, 0, "sobrou BrowserContext no pool");

  // ── nenhum processo residual do teste de crash ───────────────────────────
  const { execFileSync } = await import("node:child_process");
  const resto = (() => {
    try {
      return execFileSync("/usr/bin/pgrep", ["-f", "daemon-filho"], { encoding: "utf8" }).trim();
    } catch {
      return ""; // pgrep sai com 1 quando não acha nada: é o resultado desejado
    }
  })();
  assert.equal(resto, "", `sobrou processo do daemon-filho: ${resto}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 14b. CONTROLE DE VACUIDADE DO LEASE — um vazamento REAL tem de REPROVAR
//
// Sem este caso, "nenhum lease vazou" poderia ser verdade apenas porque o
// instrumento não sabe olhar — que foi exatamente o defeito da versão anterior
// (`lease_holder === null` num mundo onde ninguém adquiria lease).
//
// Aqui o lease é DE FATO desviado para um holder de task, no meio de uma task
// viva, pela rota REAL de transferência. Nada é simulado: o desvio acontece no
// LeaseManager de verdade, e a MESMA função que aprova o caminho bom (teste 14)
// tem de reprovar este.
// ═════════════════════════════════════════════════════════════════════════════

test("14b. lease desviado para um delegado de task no meio: o instrumento REPROVA", async () => {
  const sid = await novaSessao("DONO-14B");
  const base = await capturarLease(sid);
  assert.ok(base.holder !== null, "a sessão nasceu sem lease — nada a vazar, o controle seria vácuo");

  const DELEGADO = "delegado-de-task-vazado";
  roteiro = {
    steps: [
      passoGoto("z1", "/passo/z1"),
      // Pendura o passo para dar tempo do desvio acontecer COM a task viva.
      passoGoto("z2", "/nunca-responde/z2"),
      passoGoto("z3", "/passo/z3-nunca"),
    ],
  };

  const emVoo = abrirTask(sid, "vazar um lease de propósito");
  await ate(async () => (fixture.vezes("/nunca-responde/z2") >= 1 ? true : null), 15_000);

  // O desvio REAL, pela rota de produção.
  const t = await chamar<{ holder?: string }>("POST", `/api/v1/sessions/${sid}/lease/transfer`, { to: DELEGADO });
  assert.equal(t.status, 200, `a transferência não aconteceu: ${JSON.stringify(t.body)}`);

  const env = await emVoo;
  assert.equal(env.body.success, false, "perder o volante no meio não pode terminar em sucesso");

  const task_id = String((env.body.error!.detail as Record<string, unknown>).task_id);
  const tl = (await linhaDoTempo(sid)).filter((l) => l.task_id === task_id);
  const limpeza = tl.find((l) => l.action === "task.cleanup");
  assert.ok(limpeza !== undefined, "nem com o lease desviado a task deixou de ser limpa");
  const d = limpeza.detail as Record<string, unknown>;

  // O vazamento ACONTECEU de verdade — sem isto o controle seria encenação.
  assert.equal(d.lease_holder, DELEGADO, `o desvio não chegou ao cleanup: ${JSON.stringify(d)}`);

  // E A PROVA: a MESMA função do teste 14 reprova.
  const veredito = leaseIntacto(base, d);
  assert.equal(veredito.ok, false, "o instrumento ACEITOU um lease desviado para um delegado de task");
  assert.match(veredito.porque, /holder mudou/);

  // Perder o volante é FATAL, nunca retentável: martelar a porta de quem tomou
  // o controle é o comportamento que a política existe para proibir.
  const disco = await doDisco(sid, task_id);
  assert.equal(disco.state, "FAILED");
  assert.equal(disco.last_error?.classe, "fatal", `perder o lease virou ${disco.last_error?.classe}`);
  assert.equal(fixture.vezes("/passo/z3-nunca"), 0, "a task seguiu agindo depois de perder o volante");
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. CONTROLE NEGATIVO — o instrumento reprova quando deve
// ═════════════════════════════════════════════════════════════════════════════

test("15. controle negativo: a task que deve falhar falha, e o instrumento reprova o contrário", async () => {
  const sid = await novaSessao("DONO-15");

  // (a) o caminho feliz existe — sem isto, "falhou" não diria nada, porque tudo
  //     poderia estar falhando.
  roteiro = { steps: [passoGoto("n1", "/passo/n1")] };
  const bom = await abrirTask(sid, "controle positivo");
  assert.equal(bom.body.success, true, JSON.stringify(bom.body.error));
  assert.equal(bom.body.result!.state, "COMPLETED");

  // (b) a task que DEVE falhar, falha — e falha pelo motivo declarado.
  roteiro = { steps: [passo("n2", "browser.click", { target: { selector: "#nada-aqui-jamais" } })] };
  const ruim = await abrirTask(sid, "controle negativo");
  assert.equal(ruim.body.success, false, "a task que deveria falhar passou");
  const t = await doDisco(sid, String((ruim.body.error!.detail as Record<string, unknown>).task_id));
  assert.equal(t.state, "FAILED");

  // (c) O INSTRUMENTO. Se `assert.equal(t.state, "COMPLETED")` NÃO lançasse
  //     aqui, todas as asserções de estado deste arquivo seriam decorativas —
  //     é a prova de que o teste não passa por vácuo.
  let reprovou = false;
  try {
    assert.equal(t.state, "COMPLETED");
  } catch {
    reprovou = true;
  }
  assert.equal(reprovou, true, "o instrumento aceitou um estado errado: as asserções deste arquivo não valem nada");

  // (d) E o mesmo para o ledger: pedir um caminho que ninguém pediu conta zero.
  assert.equal(fixture.vezes("/passo/caminho-que-ninguem-pediu"), 0);
  assert.equal(fixture.vezes("/passo/n1"), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// FASES 20/21 — os PASSOS de uma task passam pelo mesmo portão que uma ação
// pedida à mão.
//
// Esta é a pergunta que decide se o modo de autonomia vale alguma coisa numa
// tarefa multipasso. `browser.task` é `SEMPRE_APROVAR` (A5, irreversibilidade
// alta): o dono aprova UMA vez, "faça isso". Se essa aprovação valesse como
// autorização geral para tudo que o plano resolvesse fazer, ela seria um
// cheque em branco — e `AUTO != BYPASS` estaria protegendo a porta da frente
// enquanto a dos fundos ficou aberta.
//
// O executor de passo fala com a PRÓPRIA API por loopback justamente para não
// abrir esse caminho privilegiado. Aqui isso deixa de ser um comentário no
// código e vira medida.
// ─────────────────────────────────────────────────────────────────────────────

interface PendenciaDeAprovacao {
  approval_id: string;
  rota: string;
  estado: string;
  nivel: string;
}

async function pendentes(session_id: string): Promise<PendenciaDeAprovacao[]> {
  const r = await chamar<PendenciaDeAprovacao[] | { pendentes?: PendenciaDeAprovacao[] }>(
    "GET",
    `/api/v1/sessions/${session_id}/approvals`,
  );
  const lista = Array.isArray(r.body) ? r.body : (r.body.pendentes ?? []);
  return lista.filter((p) => p.estado === "PENDENTE");
}

/**
 * Aprova tudo o que aparecer, até a promessa terminar, anotando CADA rota que
 * perguntou. É o "dono atento" — o que interessa não é ele aprovar, é a LISTA
 * do que lhe foi perguntado.
 */
async function aprovandoTudo<T>(
  session_id: string,
  emCurso: Promise<T>,
): Promise<{ valor: T; perguntou: string[] }> {
  const perguntou: string[] = [];
  let vivo = true;
  const acabou = emCurso.then((v) => { vivo = false; return v; });

  while (vivo) {
    const corrida = await Promise.race([
      acabou.then(() => "fim" as const),
      new Promise<"segue">((r) => setTimeout(() => r("segue"), 60)),
    ]);
    if (corrida === "fim") break;
    for (const p of await pendentes(session_id)) {
      perguntou.push(p.rota);
      await chamar("POST", `/api/v1/approvals/${p.approval_id}/approve`, { by: "dono-do-teste" });
    }
  }
  return { valor: await acabou, perguntou };
}

test("FASES 20/21 — em AUTO, o dono aprova a TASK e os passos correm sozinhos", async () => {
  const s = await novaSessao("dono-auto");
  await chamar("POST", `/api/v1/sessions/${s}/autonomy`, { mode: "AUTO", by: "dono-do-teste" });
  roteiro = { steps: [passoGoto("p1", "/a"), passoGoto("p2", "/b")] };

  // Sem await: `browser.task` fica pendurada esperando a decisão do dono, que é
  // exatamente o comportamento sob teste.
  const { valor: r, perguntou } = await aprovandoTudo(s, abrirTask(s, "visitar duas páginas"));

  assert.equal(r.body.success, true, JSON.stringify(r.body.error));
  assert.deepEqual(
    perguntou,
    ["browser.task"],
    `em AUTO só a própria task deveria perguntar; perguntou: ${perguntou.join(", ")}`,
  );

  // Controle: os passos ACONTECERAM. Sem isto, "nenhuma pergunta" seria
  // verdade trivial sobre um plano que não rodou.
  const feitos = (await trilha(s)).filter((l) => l.action === "browser.goto");
  assert.ok(feitos.length >= 2, `os passos não rodaram: ${feitos.length} goto na trilha`);
});

test("FASES 20/21 — em ASK, aprovar a task NÃO é cheque em branco para os passos", async () => {
  const s = await novaSessao("dono-ask");
  await chamar("POST", `/api/v1/sessions/${s}/autonomy`, { mode: "ASK", by: "dono-do-teste" });
  roteiro = { steps: [passoGoto("p1", "/a"), passoGoto("p2", "/b")] };

  const { valor: r, perguntou } = await aprovandoTudo(s, abrirTask(s, "visitar duas páginas"));

  assert.equal(r.body.success, true, JSON.stringify(r.body.error));
  assert.equal(perguntou[0], "browser.task", "a primeira pergunta tem que ser a própria task");

  // O ponto: DEPOIS de a task ser aprovada, cada passo que muda estado ainda
  // passou pelo portão. Se os passos herdassem a aprovação da task, esta lista
  // teria um item só.
  const passosQuePerguntaram = perguntou.filter((rota) => rota === "browser.goto");
  assert.equal(
    passosQuePerguntaram.length,
    2,
    `os passos do plano não reentraram no portão — perguntou: ${perguntou.join(", ")}`,
  );
});
