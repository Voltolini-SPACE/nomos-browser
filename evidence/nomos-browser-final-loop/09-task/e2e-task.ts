/**
 * FASE 9 — PROVA E2E DO MOTOR DE TASK.
 *
 * Uma task REAL de 12 passos (navegar → localizar → clicar → preencher →
 * validar → nova aba → extrair → voltar → …) contra um daemon REAL, com um
 * SIGKILL no meio e retomada — mais as provas laterais de retentativa,
 * idempotência, cancelamento e limpeza.
 *
 * REGRAS QUE ESTE ARQUIVO SEGUE
 * -----------------------------
 *  1. O daemon é PROCESSO SEPARADO. Não há como matar de verdade um daemon que
 *     roda dentro do próprio processo que julga o resultado.
 *  2. O ledger é do SERVIDOR DE FIXTURE, não do relatório da task. "Não repetiu
 *     passo" é medido contando requisições HTTP — o motor não tem como
 *     influenciar esse número.
 *  3. Toda flag só vira PASS com evidência positiva. Uma flag que virasse PASS
 *     por ausência de erro seria PASS por vacuidade, e é o defeito que este
 *     projeto inteiro existe para não repetir.
 *
 * Uso: node evidence/nomos-browser-final-loop/09-task/e2e-task.ts
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readControlToken } from "../../../packages/api/src/auth.ts";
import { estadoFinal, type TaskRecord } from "../../../packages/core/src/taskengine.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PORTA = 7794;

// ─────────────────────────────────────────────────────────────────────────────
// Flags
// ─────────────────────────────────────────────────────────────────────────────

type Flag =
  | "TASK_CHECKPOINT" | "TASK_RETRY" | "TASK_RESUME" | "TASK_IDEMPOTENCY"
  | "TASK_CANCEL" | "TASK_CRASH_RECOVERY" | "TASK_CLEANUP" | "TASK_ENGINE";

const FLAGS: Record<Flag, "PASS" | "FAIL"> = {
  TASK_CHECKPOINT: "FAIL",
  TASK_RETRY: "FAIL",
  TASK_RESUME: "FAIL",
  TASK_IDEMPOTENCY: "FAIL",
  TASK_CANCEL: "FAIL",
  TASK_CRASH_RECOVERY: "FAIL",
  TASK_CLEANUP: "FAIL",
  TASK_ENGINE: "FAIL",
};

const notas: string[] = [];
function nota(txt: string): void {
  notas.push(txt);
  process.stderr.write(`  · ${txt}\n`);
}
/** Marca PASS só quando a condição é verdadeira; senão registra POR QUÊ. */
function marcar(f: Flag, ok: boolean, porque: string): boolean {
  FLAGS[f] = ok ? "PASS" : "FAIL";
  nota(`${f}=${FLAGS[f]} — ${porque}`);
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: um "app" de verdade, com formulário, painel e segunda página
// ─────────────────────────────────────────────────────────────────────────────

const pedidos: string[] = [];
const derrubados = new Set<string>();
const vezes = (c: string): number => pedidos.filter((p) => p === c).length;

const APP = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>app</title></head><body>
  <h1 id="titulo">painel nomos</h1>
  <button id="entrar">Entrar</button>
  <input id="usuario" type="text" placeholder="usuario">
  <div id="painel" hidden>area restrita</div>
  <pre id="saida"></pre>
  <script>
    document.getElementById("entrar").addEventListener("click", function () {
      document.getElementById("painel").hidden = false;
      document.getElementById("saida").textContent = "ENTROU";
    });
  </script></body></html>`;

const SEGUNDA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>segunda</title></head><body>
  <div id="marca">SEGUNDA-ABA-OK</div></body></html>`;

function subirFixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const u = req.url ?? "/";
    pedidos.push(u);
    // Conexão nova por pedido: com keep-alive o Chromium reabsorve um reset de
    // socket sozinho e a falha nunca chega ao runtime (medido na FASE 9).
    res.setHeader("connection", "close");

    if (u.startsWith("/instavel/")) {
      if (!derrubados.has(u)) {
        derrubados.add(u);
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(APP);
      return;
    }
    if (u.startsWith("/nunca-responde")) return; // socket aberto, sem resposta
    if (u.startsWith("/segunda")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SEGUNDA);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP);
  });
  return new Promise((r) => {
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address() as { port: number };
      r({
        base: `http://127.0.0.1:${a.port}`,
        close: () => new Promise<void>((rr) => {
          srv.closeAllConnections();
          srv.close(() => rr());
        }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ate<T>(f: () => Promise<T | null>, prazo: number, oque: string): Promise<T> {
  const fim = Date.now() + prazo;
  while (Date.now() < fim) {
    const v = await f();
    if (v !== null) return v;
    await dormir(60);
  }
  throw new Error(`prazo esgotado esperando: ${oque}`);
}

let token: string | null = null;
const H = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-nomos-client": "e2e-task",
  ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
});

async function api<T>(method: string, rota: string, body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${PORTA}${rota}`, {
    method,
    headers: H(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()) as T;
}

interface Env<T> {
  success: boolean;
  result: T | null;
  error: { code: string; message: string; detail?: Record<string, unknown> } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon filho
// ─────────────────────────────────────────────────────────────────────────────

const raizSessoes = mkdtempSync(path.join(os.tmpdir(), "nomos-e2e9-sess-"));
const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-e2e9-rt-"));
const roteiroPath = path.join(runtimeDir, "roteiro.json");

function escreverRoteiro(steps: Record<string, unknown>[]): void {
  writeFileSync(roteiroPath, JSON.stringify({ steps }), "utf8");
}

async function subirDaemon(matarEm: number | null): Promise<ChildProcess> {
  const p = spawn(process.execPath, [path.join(RAIZ, "tests/fixtures/task/daemon-filho.ts")], {
    env: {
      ...process.env,
      NOMOS_BROWSER_PORT: String(PORTA),
      NOMOS_BROWSER_HEADLESS: "true",
      NOMOS_BROWSER_ALLOW_INTERNAL: "true",
      NOMOS_SESSIONS_ROOT: raizSessoes,
      NOMOS_RUNTIME_DIR: runtimeDir,
      NOMOS_TESTE_ROTEIRO: roteiroPath,
      NOMOS_BROWSER_TASK_RETRY_BASE_MS: "20",
      NOMOS_BROWSER_TASK_RETRY_MAX_MS: "150",
      NOMOS_BROWSER_TASK_STEP_TIMEOUT_MS: "2500",
      NOMOS_BROWSER_TASK_RECOVER_GRACE_MS: "60000",
      ...(matarEm !== null ? { NOMOS_TESTE_MATAR_EM: String(matarEm) } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stderr.on("data", () => undefined); // ruído do filho não polui a prova
  const prazo = Date.now() + 90_000;
  while (Date.now() < prazo) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200 || r.status === 401) {
        token = readControlToken(runtimeDir);
        return p;
      }
    } catch { /* ainda subindo */ }
    await dormir(250);
  }
  p.kill("SIGKILL");
  throw new Error("daemon filho não subiu");
}

/** Espera a saída aceitando que o processo JÁ possa ter morrido. */
function esperarSaida(p: ChildProcess, prazo = 30_000): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("o filho não morreu no prazo")), prazo);
    p.once("exit", () => {
      clearTimeout(t);
      res();
    });
  });
}

function taskDoDisco(sid: string, task_id: string): TaskRecord {
  return JSON.parse(readFileSync(path.join(raizSessoes, sid, "tasks", `${task_id}.json`), "utf8")) as TaskRecord;
}

/**
 * Linha do tempo de UMA task, varrendo TODAS as sessões.
 *
 * Uma task retomada em sessão nova (o caso do crash) escreve as linhas finais no
 * `index.jsonl` da sessão NOVA — comportamento correto do produto, e o
 * instrumento tem de acompanhar. Olhar só a sessão original faria o teste
 * acusar "sem cleanup" numa task que foi limpa direitinho.
 */
function linhaDoTempoDaTask(task_id: string): Record<string, unknown>[] {
  const todas: Record<string, unknown>[] = [];
  let sessoes: string[] = [];
  try {
    sessoes = readdirSync(raizSessoes);
  } catch {
    return todas;
  }
  for (const s of sessoes) todas.push(...linhaDoTempo(s).filter((l) => l.task_id === task_id));
  return todas.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function linhaDoTempo(sid: string): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(raizSessoes, sid, "tasks", "index.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Estado do lease de uma sessão, medido pela API — fonte INDEPENDENTE da task.
 *
 * A linha de base TEM de vir daqui e não da linha do tempo do motor. Um remendo
 * anterior tentou reconstruí-la varrendo `index.jsonl` atrás de `lease_holder`,
 * e isso é circular: a ÚNICA linha que carrega esse campo é a própria
 * `task.cleanup` que se quer julgar. Medido: 11 linhas na timeline, 1 com
 * `lease_holder`, e ela é o cleanup.
 */
interface BaseDeLease {
  holder: string | null;
  count: number;
  lease_id: string | null;
}

const baseDeLease = new Map<string, BaseDeLease>();

async function capturarLease(sid: string): Promise<BaseDeLease> {
  const l = await api<{ current_holder: string | null; leases: { lease_id: string }[] }>(
    "GET", `/api/v1/sessions/${sid}/lease`,
  );
  return {
    holder: l.current_holder ?? null,
    count: Array.isArray(l.leases) ? l.leases.length : 0,
    lease_id: Array.isArray(l.leases) && l.leases.length > 0 ? l.leases[0]!.lease_id : null,
  };
}

/**
 * A PROPRIEDADE: a task não pode mexer no controle da sessão.
 *
 * Ao fim do cleanup, o volante é EXATAMENTE o mesmo de antes de a task começar —
 * mesmo holder, mesma contagem. Nada foi adquirido em nome da task, nada do que
 * já existia foi derrubado por ela.
 *
 * Por que não "lease_holder === null", como antes: sob `allow_unleased: false`
 * (FASE 10) a sessão NASCE com lease exclusivo de quem a criou, e esse lease é
 * da SESSÃO — ele deve sobreviver ao fim da task e só cair quando a sessão
 * fechar. Exigir `null` reprovaria o comportamento correto; e sob o default
 * antigo (`true`) ninguém adquiria lease nenhum, então a asserção passava por
 * VACUIDADE — media "não sobrou lease" num mundo sem leases.
 *
 * Por que é MAIS FORTE que "não cresceu": exige IGUALDADE. Uma task que
 * SOLTASSE o lease da sessão (deixando-a órfã para o próximo agente) passaria
 * num teste de "não cresceu" e é tão defeito quanto vazar.
 */
function leaseIntacto(base: BaseDeLease | undefined, d: Record<string, unknown>): { ok: boolean; porque: string } {
  if (base === undefined) return { ok: false, porque: "sem linha de base independente para esta sessão" };
  // Guarda de vacuidade embutida: se a sessão não nasceu com lease, a medição
  // não vale nada e tem de REPROVAR em vez de passar de graça.
  if (base.holder === null || base.count === 0) {
    return { ok: false, porque: "a sessão nasceu SEM lease — a arbitragem não está ligada e a medição seria vácua" };
  }
  if (d.lease_holder !== base.holder) {
    return { ok: false, porque: `holder mudou: ${JSON.stringify(base.holder)} → ${JSON.stringify(d.lease_holder)}` };
  }
  if (Number(d.lease_count) !== base.count) {
    return { ok: false, porque: `contagem de leases mudou: ${base.count} → ${JSON.stringify(d.lease_count)}` };
  }
  return { ok: true, porque: `holder ${base.holder} e contagem ${base.count} preservados` };
}

async function novaSessao(owner: string): Promise<string> {
  const s = await api<{ session_id: string }>("POST", "/api/v1/sessions", { owner, profile: "sandbox" });
  // Linha de base capturada AQUI, antes de qualquer task tocar a sessão.
  baseDeLease.set(s.session_id, await capturarLease(s.session_id));
  return s.session_id;
}

// ═════════════════════════════════════════════════════════════════════════════

let fixture: { base: string; close: () => Promise<void> };
let proc: ChildProcess | null = null;
let erroFatal: string | null = null;

/** Os 12 passos da task real. */
function doze(base: string): Record<string, unknown>[] {
  return [
    { id: "e01", intent: "navegar até o app", action: "browser.goto", value: `${base}/app` },
    { id: "e02", intent: "localizar o botão de entrada", action: "browser.find", target: { selector: "#entrar" } },
    { id: "e03", intent: "clicar em entrar", action: "browser.click", target: { selector: "#entrar" } },
    { id: "e04", intent: "preencher o usuário", action: "browser.type", target: { selector: "#usuario" }, value: "nomos" },
    { id: "e05", intent: "validar que o painel apareceu", action: "browser.find", target: { selector: "#painel" } },
    { id: "e06", intent: "extrair a saída", action: "browser.extract", target: { selector: "#saida" } },
    { id: "e07", intent: "abrir nova aba", action: "browser.new_tab" },
    { id: "e08", intent: "navegar na nova aba", action: "browser.goto", value: `${base}/segunda` },
    { id: "e09", intent: "extrair da nova aba", action: "browser.extract", target: { selector: "#marca" } },
    { id: "e10", intent: "voltar para o app", action: "browser.goto", value: `${base}/app/volta` },
    { id: "e11", intent: "revalidar o título", action: "browser.find", target: { selector: "#titulo" } },
    { id: "e12", intent: "extrair o título", action: "browser.extract", target: { selector: "#titulo" } },
  ];
}

try {
  fixture = await subirFixture();
  process.stderr.write(`\n── FASE 9 — prova E2E do motor de task ─────────────────────\n`);
  process.stderr.write(`fixture em ${fixture.base}\n\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // A. Task de 12 passos com CRASH no passo 7, recuperação e resume
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("A) 12 passos, SIGKILL no 7º, recuperação e resume\n");
  const passos = doze(fixture.base);
  escreverRoteiro(passos);
  proc = await subirDaemon(7);

  const sid1 = await novaSessao("E2E-DONO");
  const CHAVE = "e2e-fase9-doze-passos";
  await fetch(`http://127.0.0.1:${PORTA}/api/v1/browser.task`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ session_id: sid1, goal: "doze passos com crash", idempotency_key: CHAVE }),
  }).catch(() => undefined);

  await esperarSaida(proc);
  const morreu = proc.signalCode === "SIGKILL";

  // O que ficou no disco tem de ser o estado MENTIROSO — sem ele não há
  // recuperação a provar.
  const dir1 = path.join(raizSessoes, sid1, "tasks");
  const arq = await ate(async () => {
    try {
      const f = readdirSync(dir1).filter((x) => x.endsWith(".json"));
      return f.length > 0 ? f[0]! : null;
    } catch {
      return null;
    }
  }, 15_000, "arquivo da task em disco");
  const taskId = arq.replace(/\.json$/, "");
  const antes = taskDoDisco(sid1, taskId);
  const feitosAntes = antes.checkpoint.step_index;

  marcar(
    "TASK_CHECKPOINT",
    feitosAntes > 0 && feitosAntes < passos.length &&
      antes.checkpoint.completed.length === feitosAntes &&
      antes.checkpoint.completed.every((c, i) => c.index === i) &&
      linhaDoTempo(sid1).filter((l) => l.action === "task.checkpoint").length >= feitosAntes,
    `crash com checkpoint em ${feitosAntes}/${passos.length}, ${antes.checkpoint.completed.length} passos confirmados e ${linhaDoTempo(sid1).filter((l) => l.action === "task.checkpoint").length} linhas de checkpoint`,
  );

  // ── reinício ───────────────────────────────────────────────────────────────
  proc = await subirDaemon(null);
  const depois = await api<TaskRecord>("GET", `/api/v1/tasks/${taskId}?session_id=${sid1}`);
  marcar(
    "TASK_CRASH_RECOVERY",
    morreu && depois.state === "RECOVERING" && depois.last_error?.code === "RUNTIME_CRASH" &&
      depois.checkpoint.step_index === feitosAntes,
    `SIGKILL confirmado; ao subir, a task está ${depois.state} (last_error=${depois.last_error?.code}) e o checkpoint continua em ${depois.checkpoint.step_index} — nenhum RUNNING mentiroso`,
  );

  // ── resume numa sessão nova ────────────────────────────────────────────────
  const sid2 = await novaSessao("E2E-DONO");
  const retomada = await api<TaskRecord>("POST", `/api/v1/tasks/${taskId}/resume`, { session_id: sid2 });

  const repetidos: string[] = [];
  for (const p of passos) {
    const v = p.value;
    if (typeof v !== "string") continue;
    const caminho = v.slice(fixture.base.length);
    if (vezes(caminho) > 1) repetidos.push(`${caminho}×${vezes(caminho)}`);
  }
  marcar(
    "TASK_RESUME",
    retomada.state === "COMPLETED" && retomada.task_id === taskId &&
      retomada.checkpoint.completed.length === passos.length &&
      retomada.run_id !== antes.run_id && repetidos.length === 0,
    `retomada do passo ${feitosAntes} até ${retomada.checkpoint.completed.length}/${passos.length}, estado ${retomada.state}, run_id novo, e NENHUM passo repetido no servidor${repetidos.length > 0 ? ` (repetidos: ${repetidos.join(", ")})` : ""}`,
  );

  // ── idempotência através do reinício ───────────────────────────────────────
  const antesEco = pedidos.length;
  const eco = await api<Env<TaskRecord>>("POST", "/api/v1/browser.task", {
    session_id: sid2, goal: "doze passos com crash", idempotency_key: CHAVE,
  });
  // Medido AQUI, antes da task de controle: a de controle EXECUTA os 12 passos
  // de novo (é esse o ponto dela) e faria o contador crescer legitimamente.
  const depoisEco = pedidos.length;
  const nova = await api<Env<TaskRecord>>("POST", "/api/v1/browser.task", {
    session_id: sid2, goal: "doze passos com crash", idempotency_key: `${CHAVE}-diferente`,
  });
  marcar(
    "TASK_IDEMPOTENCY",
    eco.success && eco.result?.task_id === taskId && depoisEco === antesEco &&
      pedidos.length > depoisEco &&
      nova.success === true && nova.result?.task_id !== taskId,
    `a mesma chave num processo NOVO devolveu ${eco.result?.task_id === taskId ? "a mesma task" : "OUTRA task"} sem reexecutar (0 pedidos novos); chave diferente criou task nova (controle)`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // B. Retentativa: socket derrubado no meio, task se recupera
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\nB) retentativa contra endpoint que derruba o socket\n");
  const sid3 = await novaSessao("E2E-RETRY");
  escreverRoteiro([
    { id: "r1", intent: "abrir", action: "browser.goto", value: `${fixture.base}/app/r1` },
    { id: "r2", intent: "passar pelo instável", action: "browser.goto", value: `${fixture.base}/instavel/e2e` },
    { id: "r3", intent: "confirmar", action: "browser.find", target: { selector: "#titulo" } },
  ]);
  const comRetry = await api<Env<TaskRecord>>("POST", "/api/v1/browser.task", {
    session_id: sid3, goal: "atravessar um endpoint instável",
  });
  const tr = comRetry.result;
  const linhasRetry = linhaDoTempo(sid3).filter((l) => l.action === "task.retry");
  marcar(
    "TASK_RETRY",
    comRetry.success === true && tr?.state === "COMPLETED" && tr.retries >= 1 &&
      linhasRetry.length === tr.retries &&
      linhasRetry.every((l) => (l.detail as Record<string, unknown>).classe === "retentavel") &&
      vezes("/app/r1") === 1,
    `NAVIGATION_FAILED real classificado como retentável, ${tr?.retries} retentativa(s), task ${tr?.state}, e o passo anterior NÃO foi reexecutado`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // C. Cancelamento no meio
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\nC) cancelamento com passo em voo\n");
  const sid4 = await novaSessao("E2E-CANCEL");
  escreverRoteiro([
    { id: "c1", intent: "abrir", action: "browser.goto", value: `${fixture.base}/app/c1` },
    { id: "c2", intent: "pendurar", action: "browser.goto", value: `${fixture.base}/nunca-responde/e2e` },
    { id: "c3", intent: "NUNCA deve rodar", action: "browser.goto", value: `${fixture.base}/app/c3-proibido` },
  ]);
  const emVoo = fetch(`http://127.0.0.1:${PORTA}/api/v1/browser.task`, {
    method: "POST", headers: H(), body: JSON.stringify({ session_id: sid4, goal: "cancelar no meio" }),
  }).then((r) => r.json() as Promise<Env<TaskRecord>>).catch(() => null);

  await ate(async () => (vezes("/nunca-responde/e2e") >= 1 ? true : null), 20_000, "o passo pendurado chegar ao servidor");
  const viva = await ate(async () => {
    const l = await api<{ tasks: TaskRecord[] }>("GET", `/api/v1/tasks?session_id=${sid4}`);
    return l.tasks.find((x) => !estadoFinal(x.state)) ?? null;
  }, 15_000, "a task aparecer viva na listagem");
  const cancelada = await api<TaskRecord>("POST", `/api/v1/tasks/${viva.task_id}/cancel`, { reason: "prova E2E" });
  await emVoo;
  marcar(
    "TASK_CANCEL",
    cancelada.state === "CANCELLED" && cancelada.last_error?.code === "CANCELLED" &&
      vezes("/app/c3-proibido") === 0 && cancelada.checkpoint.completed.length === 1,
    `passo em voo abortado, task ${cancelada.state}, e o passo seguinte foi pedido ${vezes("/app/c3-proibido")} vezes (tem de ser 0)`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // D. Limpeza: linha de cleanup com evidência, sem aba órfã, sem processo
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\nD) limpeza depois dos estados finais\n");
  const finais: Record<string, string> = {};
  let cleanupsOk = true;
  let comEvidencia = 0;
  const porqueLease: string[] = [];

  for (const tid of [taskId, tr?.task_id ?? "", viva.task_id]) {
    if (tid === "") continue;
    const tl = linhaDoTempoDaTask(tid);
    const fim = tl.filter((l) => ["task.completed", "task.failed", "task.cancelled"].includes(String(l.action)));
    const limpeza = tl.filter((l) => l.action === "task.cleanup");
    finais[tid] = `${fim.map((f) => f.action).join("/")}→${limpeza.length} cleanup`;
    if (fim.length === 0 || limpeza.length === 0) cleanupsOk = false;
    // `task.cleanup` tem de ser a ÚLTIMA linha da task: limpeza antes do fim
    // não é limpeza.
    if (tl[tl.length - 1]?.action !== "task.cleanup") cleanupsOk = false;
    for (const l of limpeza) {
      const d = l.detail as Record<string, unknown>;
      if (d.released !== true || d.aborted !== true) cleanupsOk = false;
      // O campo é `session_id` — NÃO `session`. O remendo anterior lia `l.session`,
      // recebia `undefined`, e caía sempre no ramo estrito. Medido nas chaves
      // reais da linha: at, action, task_id, run_id, session_id, state,
      // step_index, attempt, result, error, detail.
      const sidDaLinha = String(l.session_id ?? "");
      const v = leaseIntacto(baseDeLease.get(sidDaLinha), d);
      if (!v.ok) cleanupsOk = false;
      porqueLease.push(`${tid.slice(0, 12)}@${sidDaLinha.slice(0, 12)}: ${v.porque}`);
      if (typeof d.pages_open === "number") comEvidencia += 1;
    }
  }

  // O lease VIVO (não só o registrado no cleanup) continua sendo o mesmo objeto:
  // mesmo `lease_id` prova que ninguém soltou-e-readquiriu pelas costas — coisa
  // que a igualdade de holder sozinha não pegaria.
  let leaseIdIntacto = true;
  // Sessões de vida CONTÍNUA: o lease tem de ser o MESMO objeto do início.
  for (const sid of [sid2, sid3, sid4]) {
    const base = baseDeLease.get(sid);
    const agora = await capturarLease(sid);
    if (base === undefined || base.lease_id === null || agora.lease_id !== base.lease_id) {
      leaseIdIntacto = false;
      porqueLease.push(`lease_id de ${sid.slice(0, 12)} mudou: ${base?.lease_id} → ${agora.lease_id}`);
    } else {
      porqueLease.push(`lease_id de ${sid.slice(0, 12)} intacto (${base.lease_id.slice(0, 16)})`);
    }
  }
  /**
   * `sid1` é o caso do CRASH e recebe a asserção OPOSTA — não uma isenção.
   *
   * O lease é arbitragem viva, em memória; o processo que a guardava foi morto
   * com SIGKILL de propósito e a sessão morreu junto. Exigir o mesmo `lease_id`
   * aqui reprovaria o comportamento correto. Mas SALTAR a sessão seria abrir um
   * buraco no instrumento, então o que se cobra é o que TEM de ser verdade: o
   * lease não sobreviveu ao crash. Um lease "vivo" para uma sessão que já não
   * existe seria uma reivindicação fantasma bloqueando o próximo agente.
   */
  const aposCrash = await capturarLease(sid1);
  if (aposCrash.holder !== null || aposCrash.lease_id !== null || aposCrash.count !== 0) {
    leaseIdIntacto = false;
    porqueLease.push(`lease FANTASMA sobreviveu ao SIGKILL em ${sid1.slice(0, 12)}: holder=${aposCrash.holder} count=${aposCrash.count}`);
  } else {
    porqueLease.push(`lease de ${sid1.slice(0, 12)} (sessão morta no SIGKILL) não deixou reivindicação fantasma`);
  }

  // ── CONTROLE DE VACUIDADE: um vazamento REAL tem de REPROVAR ──────────────
  //
  // Sem isto, "nenhum lease vazou" poderia ser verdade só porque o instrumento
  // não sabe olhar. Aqui um lease é de fato desviado para um holder de task no
  // meio de uma task viva — via a rota real de transferência — e a MESMA função
  // que aprova o caminho bom tem de reprovar este.
  process.stderr.write("\n   controle de vacuidade: vazando um lease de propósito\n");
  const sid5 = await novaSessao("E2E-VAZAMENTO");
  const base5 = baseDeLease.get(sid5)!;
  escreverRoteiro([
    { id: "v1", intent: "abrir", action: "browser.goto", value: `${fixture.base}/app/v1` },
    { id: "v2", intent: "pendurar para dar tempo do desvio", action: "browser.goto", value: `${fixture.base}/nunca-responde/vaz` },
    { id: "v3", intent: "nao deve rodar", action: "browser.goto", value: `${fixture.base}/app/v3` },
  ]);
  const tarefaVaz = fetch(`http://127.0.0.1:${PORTA}/api/v1/browser.task`, {
    method: "POST", headers: H(), body: JSON.stringify({ session_id: sid5, goal: "vazar um lease de proposito" }),
  }).then((r) => r.json() as Promise<Env<TaskRecord>>).catch(() => null);

  await ate(async () => (vezes("/nunca-responde/vaz") >= 1 ? true : null), 20_000, "o passo pendurado do vazamento");
  const DELEGADO_VAZADO = "delegado-de-task-vazado";
  await api("POST", `/api/v1/sessions/${sid5}/lease/transfer`, { to: DELEGADO_VAZADO });
  await tarefaVaz;

  const vazTask = await ate(async () => {
    const l = await api<{ tasks: TaskRecord[] }>("GET", `/api/v1/tasks?session_id=${sid5}`);
    return l.tasks.find((x) => estadoFinal(x.state)) ?? null;
  }, 20_000, "a task do vazamento terminar");
  const limpezaVaz = linhaDoTempoDaTask(vazTask.task_id).filter((l) => l.action === "task.cleanup");
  const detVaz = (limpezaVaz[limpezaVaz.length - 1]?.detail ?? {}) as Record<string, unknown>;
  const vereditoVaz = leaseIntacto(base5, detVaz);
  const vazamentoAconteceu = detVaz.lease_holder === DELEGADO_VAZADO;
  const instrumentoReprova = vazamentoAconteceu && vereditoVaz.ok === false;
  nota(
    `controle de vacuidade: lease desviado para ${JSON.stringify(detVaz.lease_holder)} (era ${JSON.stringify(base5.holder)}); ` +
    `a MESMA função ${instrumentoReprova ? "REPROVOU" : "NÃO reprovou"} → ${vereditoVaz.porque}`,
  );
  await api("DELETE", `/api/v1/sessions/${sid5}`, { reason: "fim do controle" }).catch(() => undefined);

  // Nenhuma sessão nem aba fica para trás depois do fechamento.
  for (const sid of [sid1, sid2, sid3, sid4]) {
    await api("DELETE", `/api/v1/sessions/${sid}`, { reason: "fim da prova" }).catch(() => undefined);
  }
  const restantes = await api<{ length?: number }>("GET", "/api/v1/sessions");
  const vivas = Array.isArray(restantes) ? (restantes as unknown as unknown[]).length : -1;

  proc.kill("SIGKILL");
  await esperarSaida(proc, 15_000).catch(() => undefined);
  proc = null;
  await dormir(800);
  const { execFileSync } = await import("node:child_process");
  const residual = (() => {
    try {
      return execFileSync("/usr/bin/pgrep", ["-f", "daemon-filho"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();

  marcar(
    "TASK_CLEANUP",
    cleanupsOk && leaseIdIntacto && instrumentoReprova && comEvidencia >= 3 && vivas === 0 && residual === "",
    `cleanup é a última linha de cada task com evidência medida (${comEvidencia} linhas); o lease da SESSÃO ficou intacto ` +
    `(mesmo holder, mesma contagem, mesmo lease_id) e nada ficou pendurado em nome da task; ` +
    `o instrumento ${instrumentoReprova ? "REPROVA" : "NÃO reprova"} um vazamento real; ` +
    `${vivas} sessão(ões) viva(s); processo residual: ${residual === "" ? "nenhum" : residual}`,
  );
  for (const l of porqueLease) nota(`  lease: ${l}`);
  nota(`finais por task: ${JSON.stringify(finais)}`);
} catch (e) {
  erroFatal = (e as Error)?.stack ?? String(e);
  process.stderr.write(`\nERRO FATAL: ${erroFatal}\n`);
} finally {
  if (proc !== null) {
    try {
      proc.kill("SIGKILL");
    } catch { /* já morto */ }
  }
  await fixture!?.close().catch(() => undefined);
  rmSync(raizSessoes, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Veredito
// ─────────────────────────────────────────────────────────────────────────────

// TASK_ENGINE é conjunção: uma flag vermelha reprova o conjunto. Um "resumo"
// que passasse com sete de oito seria exatamente o relatório complacente que
// esta fase existe para não produzir.
const parciais: Flag[] = ["TASK_CHECKPOINT", "TASK_RETRY", "TASK_RESUME", "TASK_IDEMPOTENCY", "TASK_CANCEL", "TASK_CRASH_RECOVERY", "TASK_CLEANUP"];
FLAGS.TASK_ENGINE = erroFatal === null && parciais.every((f) => FLAGS[f] === "PASS") ? "PASS" : "FAIL";

process.stderr.write("\n");
for (const f of [...parciais, "TASK_ENGINE" as Flag]) process.stdout.write(`${f}=${FLAGS[f]}\n`);
process.exit(FLAGS.TASK_ENGINE === "PASS" ? 0 : 1);
