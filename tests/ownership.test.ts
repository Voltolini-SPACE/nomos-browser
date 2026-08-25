/**
 * FASE 10 — OWNERSHIP E LEASE
 *
 * O que esta suíte existe para provar, e por que ela não existia antes.
 *
 * O `lease.test.ts` já provava a ARBITRAGEM em unidade: 37 casos contra o
 * `LeaseManager` isolado. O que ninguém provava era o FIO — que a arbitragem
 * chega à fronteira HTTP e barra alguém de verdade. E não chegava: o daemon
 * embutia `allow_unleased: true`, então uma sessão que ninguém tivesse leaseado
 * ficava aberta a qualquer chamador. A `FINAL_REPORT` registrou isso como
 * ressalva ao lado de um `NO_DOUBLE_OWNER=PASS` que, na prática, só valia contra
 * quem tivesse sido educado o bastante para adquirir um lease primeiro.
 *
 * DUAS DECISÕES DE DESENHO QUE ESTA SUÍTE MEDE
 * -------------------------------------------
 *  1. `allow_unleased` virou `false` POR DEFAULT e saiu do fonte para a
 *     configuração. Quem cria a sessão recebe lease exclusivo no mesmo ato.
 *
 *  2. O principal de controle é o SUJEITO DO TOKEN — não `x-nomos-client`.
 *     Header auto-declarado não é identidade: se a arbitragem confiasse nele,
 *     qualquer processo local escreveria "sou a IA-A" e herdaria o volante dela.
 *     Por isso cada IA desta suíte tem CREDENCIAL PRÓPRIA, e "a IA-B foi
 *     barrada" é uma afirmação sobre credencial, não sobre etiqueta.
 *
 * Nada aqui é simulado na borda: o daemon é real, o Chromium é real, as recusas
 * saem do envelope HTTP de verdade e as linhas conferidas são as do audit log
 * gravado em disco.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { startDaemon, type DaemonHandle } from "../packages/api/src/daemon.ts";
import { loadConfig } from "../packages/api/src/config.ts";
import { agenteScriptado, type RoteiroDeAgente } from "./fixtures/task/agente-scriptado.ts";
import type { PlanStep } from "../packages/core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Placar dos portões desta fase. Impresso no fim, verbatim.
// ─────────────────────────────────────────────────────────────────────────────
const GATE: Record<string, string> = {
  ALLOW_UNLEASED_DEFAULT: "?",
  NO_DOUBLE_OWNER: "FAIL",
  LEASE_EXPIRY: "FAIL",
  HANDOFF: "FAIL",
  TAKEOVER: "FAIL",
  MULTI_AI_PASS: "FAIL",
  SIMULTANEOUS_CONFLICT: "FAIL",
  DEAD_OWNER_RECOVERY: "FAIL",
  TASK_ON_OWNER_CHANGE: "FAIL",
  IMPERSONATION_BLOCKED: "FAIL",
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture HTTP local — páginas triviais, servidas em loopback.
// ─────────────────────────────────────────────────────────────────────────────
interface Fixture {
  base: string;
  close: () => Promise<void>;
}

function startFixture(): Promise<Fixture> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = (req.url ?? "/").split("?")[0]!;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1 id="t">${p}</h1><button id="b">ok</button></body></html>`);
    });
    srv.listen(0, "127.0.0.1", () => {
      const porta = (srv.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${porta}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

let fixture: Fixture;
let daemon: DaemonHandle;
let raizSessoes: string;
let runtimeDir: string;

/** Credencial por identidade. A chave é o SUJEITO do token, e é ele que arbitra. */
const CRED: Record<string, string> = {};

/** Roteiro corrente do agente scriptado (só o caso da task o usa). */
let roteiro: RoteiroDeAgente = { steps: [] };
let antesDoPasso: ((step: PlanStep, n: number) => void | Promise<void>) | null = null;

before(async () => {
  fixture = await startFixture();
  raizSessoes = mkdtempSync(path.join(os.tmpdir(), "nomos-own-sess-"));
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-own-rt-"));

  const agente = agenteScriptado({
    name: "agente-fase10",
    base: () => daemon.url,
    // O agente scriptado age com o token RAIZ (é o que o executor de produção
    // também usa). O que muda de dono no meio do caminho é o LEASE — e é a
    // recusa daí que este teste quer ver.
    token: () => daemon.token,
    roteiro: () => roteiro,
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
    runtime_dir: runtimeDir,
    ai_provider: null,
    ai_provider_fallback: null,
    vision_provider: null,
    task_max_attempts: 1,
    task_step_timeout_ms: 10_000,
    task_total_timeout_ms: 60_000,
    // Não herdar a config do operador: o que se mede aqui é o DEFAULT do
    // produto, e um `nomos-browser.config.json` na raiz o contradiria em
    // silêncio.
    read_file: false,
    env: {},
  });

  CRED["IA-A"] = daemon.auth.issue({ subject: "IA-A", preset: "agent" }).secret;
  CRED["IA-B"] = daemon.auth.issue({ subject: "IA-B", preset: "agent" }).secret;
  CRED["OPERADOR"] = daemon.auth.issue({ subject: "OPERADOR", preset: "admin" }).secret;
  CRED["daemon-root"] = daemon.token!;
});

after(async () => {
  await daemon?.close("fim dos testes de ownership");
  await fixture?.close();
  rmSync(raizSessoes, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chamadas
// ─────────────────────────────────────────────────────────────────────────────

interface Resp<T> {
  status: number;
  body: T;
}

async function como<T>(
  quem: string,
  method: string,
  rota: string,
  body?: unknown,
  headersExtra: Record<string, string> = {},
): Promise<Resp<T>> {
  const r = await fetch(`${daemon.url}${rota}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-nomos-client": quem,
      ...(CRED[quem] !== undefined ? { authorization: `Bearer ${CRED[quem]}` } : {}),
      ...headersExtra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as T };
}

interface Envelope<T = unknown> {
  success: boolean;
  result: T | null;
  error: { code: string; message: string; detail?: Record<string, unknown> } | null;
}

const abertas: string[] = [];

async function novaSessaoComo(quem: string, owner = quem): Promise<string> {
  const r = await como<{ session_id: string }>("" + quem, "POST", "/api/v1/sessions", { owner, profile: "sandbox" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  abertas.push(r.body.session_id);
  return r.body.session_id;
}

async function fechar(sid: string): Promise<void> {
  try {
    await como("daemon-root", "DELETE", `/api/v1/sessions/${sid}`, { reason: "fim do caso" });
  } catch {
    // Já fechada.
  }
}

async function leaseDe(sid: string): Promise<{ current_holder: string | null; leases: unknown[] }> {
  const r = await como<{ current_holder: string | null; leases: unknown[] }>(
    "daemon-root",
    "GET",
    `/api/v1/sessions/${sid}/lease`,
  );
  return r.body;
}

function trilha(sid: string): Record<string, unknown>[] {
  const f = path.join(raizSessoes, sid, "actions.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
// 1. O DEFAULT
// ═════════════════════════════════════════════════════════════════════════════

test("1. allow_unleased nasce FALSE e só vira true por ato escrito", () => {
  const padrao = loadConfig({ read_file: false, env: {} });
  assert.equal(padrao.allow_unleased, false, "o default do produto voltou a ser permissivo");
  assert.equal(padrao.sources.allow_unleased, "default");

  // Modo permissivo continua existindo — mas agora tem nome, variável e
  // proveniência. É a diferença entre uma escolha e um esquecimento.
  const porAmbiente = loadConfig({ read_file: false, env: { NOMOS_BROWSER_ALLOW_UNLEASED: "true" } });
  assert.equal(porAmbiente.allow_unleased, true);
  assert.equal(porAmbiente.sources.allow_unleased, "env:NOMOS_BROWSER_ALLOW_UNLEASED");

  // Coerção silenciosa não existe aqui, como em nenhuma outra chave.
  assert.throws(
    () => loadConfig({ read_file: false, env: { NOMOS_BROWSER_ALLOW_UNLEASED: "talvez" } }),
    /não é booleano/,
  );

  // E o daemon que está de pé nesta suíte é o que a config diz.
  assert.equal(daemon.config.allow_unleased, false);
  assert.equal(daemon.leases.allow_unleased, false);
  GATE.ALLOW_UNLEASED_DEFAULT = "FALSE";
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. DONO ÚNICO
// ═════════════════════════════════════════════════════════════════════════════

test("2. quem cria a sessão recebe o lease, e o segundo agente é barrado", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    const l = await leaseDe(sid);
    assert.equal(l.current_holder, "IA-A", "a sessão não nasceu com dono");
    assert.equal(l.leases.length, 1);

    // A age.
    const aAge = await como<Envelope>("IA-A", "POST", "/api/v1/browser.goto", {
      session_id: sid,
      url: `${fixture.base}/a`,
    });
    assert.equal(aAge.body.success, true, JSON.stringify(aAge.body.error));

    // B tenta agir na sessão de A. Recusa com o código do contrato e 409.
    const bAge = await como<Envelope>("IA-B", "POST", "/api/v1/browser.click", {
      session_id: sid,
      target: { selector: "#b" },
    });
    assert.equal(bAge.status, 409, `IA-B deveria ser barrada, veio ${bAge.status}`);
    assert.equal(bAge.body.error?.code, "CAPABILITY_DENIED");
    assert.equal(bAge.body.error?.detail?.lease, "CONTROL_NOT_OWNED");
    assert.equal(bAge.body.error?.detail?.current_holder, "IA-A");

    // Nem OBSERVAR: um lease exclusivo é sobre a sessão inteira. Ler o DOM da
    // sessão autenticada de outro agente é o vazamento, não o clique.
    const bOlha = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(bOlha.status, 409, "IA-B leu a sessão de IA-A");

    // E B também não consegue ADQUIRIR enquanto A detém.
    const bPede = await como<Envelope>("IA-B", "POST", `/api/v1/sessions/${sid}/lease`, {});
    assert.equal(bPede.status, 403, JSON.stringify(bPede.body));
    assert.equal(bPede.body.error?.detail?.current_holder, "IA-A");

    // A NEGAÇÃO DEIXA RASTRO. Um barrado silencioso é indistinguível de um
    // ataque que não aconteceu.
    const negadas = trilha(sid).filter((l) => l.action === "policy.deny");
    assert.ok(
      negadas.some((l) => (l.detail as Record<string, unknown>)?.lease === "CONTROL_NOT_OWNED"),
      "a recusa de arbitragem não entrou no audit",
    );
    GATE.NO_DOUBLE_OWNER = "PASS";
  } finally {
    await fechar(sid);
  }
});

test("3. sessão sem lease algum é recusada — fail closed, não permissiva", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    const l = await leaseDe(sid);
    const leaseId = (l.leases[0] as { lease_id: string }).lease_id;

    // A solta o próprio lease: a sessão fica SEM DONO.
    const solto = await como<{ released: boolean }>("IA-A", "DELETE", `/api/v1/sessions/${sid}/lease`, {
      lease_id: leaseId,
    });
    assert.equal(solto.status, 200, JSON.stringify(solto.body));
    assert.equal((await leaseDe(sid)).current_holder, null);

    // Agora NINGUÉM age — nem quem acabou de soltar. É este caso que o default
    // antigo deixava passar: sessão sem lease era sessão de todo mundo.
    const aTenta = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(aTenta.status, 409, "sessão sem lease continuou operável — fail closed não está ligado");
    assert.equal(aTenta.body.error?.detail?.lease, "CONTROL_NOT_OWNED");

    // Readquirir devolve o direito. A porta é trancada, não emparedada.
    const readq = await como<{ lease_id: string }>("IA-A", "POST", `/api/v1/sessions/${sid}/lease`, {});
    assert.equal(readq.status, 200, JSON.stringify(readq.body));
    const volta = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(volta.body.success, true, JSON.stringify(volta.body.error));
  } finally {
    await fechar(sid);
  }
});

test("4. sessão inexistente responde 404, não 409 — recusa não vaza existência", async () => {
  const r = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: "ses_naoexiste" });
  assert.equal(r.status, 404, "a arbitragem passou na frente da existência e revelou sessão que não há");
  assert.equal(r.body.error?.code, "SESSION_NOT_FOUND");
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. IDENTIDADE: header não é credencial
// ═════════════════════════════════════════════════════════════════════════════

test("5. x-nomos-client não confere controle, e delegação exige ADMIN", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    // B se apresenta como "IA-A" no header auto-declarado. Se a arbitragem
    // olhasse para ele, isto seria um sequestro de sessão de uma linha.
    const forjado = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: sid }, {
      "x-nomos-client": "IA-A",
    });
    assert.equal(forjado.status, 409, "x-nomos-client forjado conferiu controle — isso é sequestro de sessão");
    assert.equal(forjado.body.error?.detail?.current_holder, "IA-A");

    // O header de DELEGAÇÃO existe, mas é privilégio de ADMIN. Um token de
    // agente que o use é recusado antes de qualquer efeito.
    const delegaSemAdmin = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: sid }, {
      "x-nomos-on-behalf-of": "IA-A",
    });
    assert.equal(delegaSemAdmin.status, 403, "token de agente conseguiu delegar identidade");
    assert.match(String(delegaSemAdmin.body.error?.message), /ADMIN/);

    // Com token ADMIN a delegação vale — é assim que o executor de passo do
    // daemon age em nome do dono da task sem inventar um caminho privilegiado.
    const delegaAdmin = await como<Envelope>("OPERADOR", "POST", "/api/v1/browser.observe", { session_id: sid }, {
      "x-nomos-on-behalf-of": "IA-A",
    });
    assert.equal(delegaAdmin.body.success, true, JSON.stringify(delegaAdmin.body.error));

    // …e delegar para quem NÃO tem o lease continua sendo recusado: delegação
    // empresta identidade, não privilégio.
    const delegaErrado = await como<Envelope>("OPERADOR", "POST", "/api/v1/browser.observe", { session_id: sid }, {
      "x-nomos-on-behalf-of": "IA-B",
    });
    assert.equal(delegaErrado.status, 409, "delegar para quem não detém o lease passou");
    GATE.IMPERSONATION_BLOCKED = "PASS";
  } finally {
    await fechar(sid);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. EXPIRAÇÃO E DONO MORTO
// ═════════════════════════════════════════════════════════════════════════════

test("6. lease expirado libera a sessão; o dono morto não segura o volante", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    const l = await leaseDe(sid);
    const leaseId = (l.leases[0] as { lease_id: string }).lease_id;
    // A solta e readquire com prazo curto. Depois "morre": não renova mais.
    await como("IA-A", "DELETE", `/api/v1/sessions/${sid}/lease`, { lease_id: leaseId });
    const curto = await como<{ lease_id: string; expires_at: string }>(
      "IA-A",
      "POST",
      `/api/v1/sessions/${sid}/lease`,
      { ttl_ms: 900 },
    );
    assert.equal(curto.status, 200, JSON.stringify(curto.body));

    // Enquanto vale, B continua barrada.
    const cedo = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(cedo.status, 409, "B entrou antes do prazo de A vencer");

    // O cliente de A some. Ninguém renova. O prazo vence.
    await dormir(1_200);

    const tarde = await como<{ lease_id: string; holder: string }>("IA-B", "POST", `/api/v1/sessions/${sid}/lease`, {});
    assert.equal(tarde.status, 200, `B não assumiu depois da expiração: ${JSON.stringify(tarde.body)}`);
    assert.equal(tarde.body.holder, "IA-B");

    const bAge = await como<Envelope>("IA-B", "POST", "/api/v1/browser.goto", {
      session_id: sid,
      url: `${fixture.base}/b`,
    });
    assert.equal(bAge.body.success, true, JSON.stringify(bAge.body.error));

    // E A, que "morreu", não volta a agir por inércia.
    const aVolta = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(aVolta.status, 409, "o dono expirado seguiu agindo");
    assert.equal(aVolta.body.error?.detail?.current_holder, "IA-B");

    // RECUPERAÇÃO: a sessão sobreviveu à troca — mesmo navegador, estado de pé.
    const info = await como<{ status: string; pages: { url: string; active: boolean }[] }>(
      "OPERADOR",
      "GET",
      `/api/v1/sessions/${sid}`,
    );
    assert.equal(info.body.status, "ACTIVE", "a troca de dono derrubou a sessão");
    assert.match(String(info.body.pages.find((p) => p.active)?.url ?? ""), /127\.0\.0\.1/);

    GATE.LEASE_EXPIRY = "PASS";
    GATE.DEAD_OWNER_RECOVERY = "PASS";
  } finally {
    await fechar(sid);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. HANDOFF E TAKEOVER
// ═════════════════════════════════════════════════════════════════════════════

test("7. handoff entrega o volante a quem foi nomeado, e só a ele", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    const t = await como<{ holder: string; lease_id: string }>("IA-A", "POST", `/api/v1/sessions/${sid}/lease/transfer`, {
      to: "IA-B",
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.holder, "IA-B");
    assert.equal((await leaseDe(sid)).current_holder, "IA-B");

    // Não existe instante com dois donos: A perde no MESMO ato em que B ganha.
    const aDepois = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(aDepois.status, 409, "o antigo dono continuou operando depois do handoff");
    const bDepois = await como<Envelope>("IA-B", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(bDepois.body.success, true, JSON.stringify(bDepois.body.error));

    // `sessions.handoff` troca o RÓTULO de dono. O volante só se move quando o
    // chamador diz para quem — e a trilha registra que não moveu, quando não moveu.
    const so_owner = await como<{ owner: string }>("IA-B", "POST", `/api/v1/sessions/${sid}/handoff`, {
      to_owner: "TIME-C",
    });
    assert.equal(so_owner.status, 200, JSON.stringify(so_owner.body));
    assert.equal(so_owner.body.owner, "TIME-C");
    assert.equal((await leaseDe(sid)).current_holder, "IA-B", "handoff sem to_holder moveu o lease para um rótulo");
    const semTroca = trilha(sid).filter((l) => l.action === "lease.transferred").at(-1)!;
    assert.equal((semTroca.detail as Record<string, unknown>).moved, false);

    // Com `to_holder`, muda tudo junto.
    const completo = await como<{ owner: string }>("IA-B", "POST", `/api/v1/sessions/${sid}/handoff`, {
      to_owner: "IA-A",
      to_holder: "IA-A",
    });
    assert.equal(completo.status, 200, JSON.stringify(completo.body));
    assert.equal((await leaseDe(sid)).current_holder, "IA-A");
    const aVolta = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(aVolta.body.success, true, JSON.stringify(aVolta.body.error));
    GATE.HANDOFF = "PASS";
  } finally {
    await fechar(sid);
  }
});

test("8. takeover arranca o lease — e é privilégio de ADMIN, não de agente", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    // Um agente NÃO toma o volante de outro. Se tomasse, o lease não valeria nada.
    const bTenta = await como<Envelope>("IA-B", "POST", `/api/v1/sessions/${sid}/lease/takeover`, {});
    assert.equal(bTenta.status, 403, "agente comum executou takeover");
    assert.equal((await leaseDe(sid)).current_holder, "IA-A");

    // O operador humano toma.
    const op = await como<{ holder: string; previous_holder: string; revoked_lease_ids: string[] }>(
      "OPERADOR",
      "POST",
      `/api/v1/sessions/${sid}/lease/takeover`,
      {},
    );
    assert.equal(op.status, 200, JSON.stringify(op.body));
    assert.equal(op.body.previous_holder, "IA-A");
    assert.equal(op.body.holder, "OPERADOR");
    assert.equal(op.body.revoked_lease_ids.length, 1);

    const aDepois = await como<Envelope>("IA-A", "POST", "/api/v1/browser.observe", { session_id: sid });
    assert.equal(aDepois.status, 409, "o dono anterior sobreviveu ao takeover");

    const linha = trilha(sid).filter((l) => l.action === "lease.takeover").at(-1);
    assert.ok(linha !== undefined, "takeover não deixou linha no audit");
    assert.equal((linha.detail as Record<string, unknown>).previous_holder, "IA-A");
    GATE.TAKEOVER = "PASS";
  } finally {
    await fechar(sid);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. DUAS IAs E CONFLITO SIMULTÂNEO
// ═════════════════════════════════════════════════════════════════════════════

test("9. duas IAs disputam a mesma sessão: uma vence, a outra é recusada e registrada", async () => {
  const sid = await novaSessaoComo("IA-A");
  try {
    await como("IA-A", "POST", "/api/v1/browser.goto", { session_id: sid, url: `${fixture.base}/disputa` });

    // Rajada SIMULTÂNEA: as duas mandam gesto no mesmo instante.
    const [rA, rB] = await Promise.all([
      como<Envelope>("IA-A", "POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#b" } }),
      como<Envelope>("IA-B", "POST", "/api/v1/browser.click", { session_id: sid, target: { selector: "#b" } }),
    ]);
    assert.equal(rA.body.success, true, `o dono foi barrado: ${JSON.stringify(rA.body.error)}`);
    assert.equal(rB.status, 409, "as duas IAs agiram na mesma sessão");

    // Dez tentativas concorrentes de ADQUIRIR sobre uma sessão sem dono:
    // exatamente uma pode vencer. Empate seria dois donos.
    const l = await leaseDe(sid);
    await como("IA-A", "DELETE", `/api/v1/sessions/${sid}/lease`, {
      lease_id: (l.leases[0] as { lease_id: string }).lease_id,
    });
    const corrida = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        como<{ holder?: string }>(i % 2 === 0 ? "IA-A" : "IA-B", "POST", `/api/v1/sessions/${sid}/lease`, {}),
      ),
    );
    const vencedores = new Set(corrida.filter((r) => r.status === 200).map((r) => r.body.holder));
    assert.equal(vencedores.size, 1, `mais de um dono saiu da corrida: ${[...vencedores].join(",")}`);
    const dono = [...vencedores][0]!;
    // As demais respostas 200 são REENTRANTES do próprio vencedor — não um
    // segundo dono. As do perdedor têm de ser recusa explícita.
    for (const r of corrida) {
      if (r.status === 200) assert.equal(r.body.holder, dono);
      else assert.equal(r.status, 403, `recusa saiu com status inesperado ${r.status}`);
    }

    // A trilha distingue as duas IAs inequivocamente — pela credencial.
    const atores = new Set(trilha(sid).map((x) => x.actor as string));
    assert.ok(atores.has("IA-A"), `audit não registrou IA-A: ${[...atores].join(",")}`);
    assert.ok(atores.has("IA-B"), `audit não registrou IA-B: ${[...atores].join(",")}`);

    GATE.MULTI_AI_PASS = "PASS";
    GATE.SIMULTANEOUS_CONFLICT = "PASS";
  } finally {
    await fechar(sid);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. TASK EM ANDAMENTO DURANTE A TROCA DE DONO
// ═════════════════════════════════════════════════════════════════════════════

test("10. task em curso PARA quando o dono muda — não segue agindo pelo dono antigo", async () => {
  const sid = await novaSessaoComo("daemon-root", "DONO-TASK");
  try {
    const visitados: string[] = [];
    roteiro = {
      steps: [
        { id: "p1", intent: "primeiro", action: "browser.goto", value: `${fixture.base}/p1` },
        { id: "p2", intent: "segundo", action: "browser.goto", value: `${fixture.base}/p2` },
        { id: "p3", intent: "terceiro", action: "browser.goto", value: `${fixture.base}/p3` },
      ],
    };

    // O TAKEOVER acontece DEPOIS do primeiro passo, com a task em voo. É o
    // instante exato em que um runtime ingênuo continuaria clicando em nome de
    // quem já não manda.
    antesDoPasso = async (step, n) => {
      visitados.push(step.id);
      if (n === 2) {
        const op = await como<{ holder: string }>("OPERADOR", "POST", `/api/v1/sessions/${sid}/lease/takeover`, {});
        assert.equal(op.status, 200, JSON.stringify(op.body));
      }
    };

    const r = await como<Envelope<{ state: string }>>(
      "daemon-root",
      "POST",
      "/api/v1/browser.task",
      { session_id: sid, goal: "três navegações seguidas" },
    );

    // A task que perde o dono no meio termina em ENVELOPE FALHO — e é isso que
    // se quer: `browser.task` só devolve `success:true` para task que chegou ao
    // fim. O estado e a causa vêm em `error.detail`, não em `result`.
    assert.equal(r.body.success, false, "a task terminou com sucesso apesar de ter perdido o dono");
    const err = r.body.error;
    assert.ok(err !== null, "task parou sem envelope de erro");
    const det = (err.detail ?? {}) as Record<string, unknown>;

    // DECLARADA: a task não fica RUNNING mentindo, nem termina COMPLETED.
    assert.ok(
      det.state === "FAILED" || det.state === "PAUSED" || det.state === "WAITING",
      `task continuou em ${String(det.state)} depois de perder o dono`,
    );
    assert.equal(err.code, "CAPABILITY_DENIED", JSON.stringify(err));
    assert.equal(det.task_code, "CAPABILITY_DENIED", JSON.stringify(det));
    // Parou NO PASSO em que o dono mudou — não um passo depois.
    assert.equal(det.step_index, 1, `a task parou no passo errado: ${String(det.step_index)}`);
    assert.match(err.message, /lease|controle|CONTROL_NOT_OWNED/i);

    // E ela PAROU de fato: o terceiro passo nunca foi despachado.
    assert.deepEqual(visitados, ["p1", "p2"], `a task seguiu agindo: passos ${visitados.join(",")}`);

    // A recusa está na trilha, ligada à sessão e à task.
    const negacao = trilha(sid).filter(
      (l) => (l.detail as Record<string, unknown>)?.lease === "CONTROL_NOT_OWNED",
    );
    assert.ok(negacao.length > 0, "a recusa do passo não entrou no audit");
    GATE.TASK_ON_OWNER_CHANGE = "PASS";
  } finally {
    antesDoPasso = null;
    await fechar(sid);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PLACAR
// ═════════════════════════════════════════════════════════════════════════════

test("99. portões da FASE 10", () => {
  for (const [k, v] of Object.entries(GATE)) {
    process.stderr.write(`${k}=${v}\n`);
  }
  const falhos = Object.entries(GATE).filter(([, v]) => v !== "PASS" && v !== "FALSE");
  assert.deepEqual(falhos, [], `portões não atingidos: ${falhos.map(([k]) => k).join(", ")}`);
});
