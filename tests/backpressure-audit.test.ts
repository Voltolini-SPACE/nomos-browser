/**
 * FASE 20b — A RECUSA POR PRESSÃO TEM ONDE SER AUDITADA
 *
 * BLOQUEADOR MEDIDO PELO SOAK DE 100 CICLOS
 * (`evidence/nomos-browser-final-loop/20-soak/`):
 *
 *   "Recusa de POOL não tem onde ser auditada. `BACKPRESSURE_REJECTED` da
 *    `SessionQueue` (ação) vira linha em `actions.jsonl` — provado, 6/6. Mas a
 *    recusa em `POST /sessions` acontece ANTES de a sessão existir (…) as 7
 *    recusas do regime BAIXO só existem no corpo HTTP do cliente."
 *
 * E o segundo furo do mesmo bloqueador: nenhuma rota publicava a profundidade da
 * `SessionQueue` — `/health` publicava workers e sessões, nunca quantas ações
 * estavam presas esperando.
 *
 * Este arquivo mede as duas coisas contra daemon REAL e Chromium REAL.
 *
 * TRÊS CONTROLES IMPEDEM QUE ELE PASSE POR VÁCUO:
 *
 *  1. CONTROLE DE VACUIDADE SEM PRESSÃO (`FOLGA`): um daemon com pool folgado
 *     cria sessão normalmente e NÃO pode produzir uma única linha
 *     `event: "backpressure"`. Sem isto, "a recusa deixa linha" poderia ser
 *     apenas "toda criação deixa essa linha".
 *
 *  2. CONTROLE DE ESPECIFICIDADE COM PRESSÃO DE OUTRO TIPO (`FILA`): esse
 *     daemon sofre pressão REAL — o cliente leva 429 na cara —, mas é pressão de
 *     FILA, não de POOL. Ele também não pode produzir linha
 *     `event: "backpressure"`. Sem isto, a linha nova poderia estar sendo
 *     emitida para qualquer 429 e a distinção pool/fila seria decorativa.
 *
 *  3. A PROFUNDIDADE PUBLICADA É CONFERIDA CONTRA O QUE O CLIENTE OBSERVOU:
 *     `atendidas` (as que a fila aceitou) tem de bater com `running + waiting`
 *     medidos pela rota no MESMO instante. Um número publicado que ninguém
 *     compara com a realidade é decoração.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { startDaemon, type DaemonHandle } from "../packages/api/src/daemon.ts";
import {
  AUDIT_EVENTS,
  AUDIT_FIELDS,
  type AuditEntry,
  type HealthResponse,
} from "../packages/core/src/contract.ts";
import type { SessionInfo } from "../packages/core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: uma página rápida e uma DELIBERADAMENTE lenta.
//
// A lenta é o que segura um worker da fila por tempo suficiente para a
// profundidade ser medida enquanto ela existe. Sem uma ação lenta de verdade, a
// fila nunca teria mais de um item e "waiting" seria sempre 0 — o teste passaria
// medindo o nada.
// ─────────────────────────────────────────────────────────────────────────────

const ATRASO_MS = 2_500;

interface Fixture {
  base: string;
  close: () => Promise<void>;
}

function startFixture(): Promise<Fixture> {
  const html = (t: string) =>
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${t}</title></head><body><h1 id="t">${t}</h1></body></html>`;
  const server = http.createServer((req, res) => {
    const responder = (): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(req.url === "/lento" ? "lento" : "rapido"));
    };
    if ((req.url ?? "/") === "/lento") setTimeout(responder, ATRASO_MS).unref();
    else responder();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("fixture: endereço inválido");
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Infra dos três daemons
// ─────────────────────────────────────────────────────────────────────────────

interface Runtime {
  daemon: DaemonHandle;
  token: string;
  root: string;
}

interface Res<T> {
  status: number;
  body: T;
}

async function chamar<T>(
  rt: Runtime,
  method: string,
  route: string,
  body?: unknown,
  token?: string | null,
): Promise<Res<T>> {
  const cred = token === undefined ? rt.token : token;
  const res = await fetch(`${rt.daemon.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-nomos-client": "teste-backpressure",
      ...(cred !== null ? { authorization: `Bearer ${cred}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`resposta não-JSON em ${method} ${route} (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed as T };
}

/**
 * Sobe um daemon isolado. `agent`/`vision` explicitamente NULOS: esta prova é
 * sobre fila e trilha, e carregar modelo aqui gastaria memória da máquina do
 * dono sem provar nada — ver `scripts/lib-memoria.sh`.
 */
async function subir(opts: Record<string, unknown>): Promise<Runtime> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomos-bp-"));
  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    headless: true,
    allow_internal_urls: true,
    sessions_root: root,
    env: {},
    read_file: false,
    agent: null,
    vision: null,
    ...opts,
  });
  const token = (daemon as unknown as { token: string | null }).token;
  assert.ok(token !== null, "daemon precisa emitir token de arranque");
  return { daemon, token, root };
}

/** Lê o arquivo cru de uma trilha. `null` quando não existe. */
async function trilhaCrua(root: string, bucket: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, bucket, "actions.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function trilha(root: string, bucket: string): Promise<AuditEntry[]> {
  const cru = await trilhaCrua(root, bucket);
  if (cru === null) return [];
  return cru
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AuditEntry);
}

/** TODA linha de TODOS os baldes de uma raiz — inclusive `_runtime`. */
async function todasAsLinhas(root: string): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    out.push(...(await trilha(root, dir.name)));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

let fixture: Fixture;
/** Pool de UM: a segunda sessão é recusada. */
let PRESSAO: Runtime;
/** Pool folgado, sem pressão nenhuma — controle de vacuidade. */
let FOLGA: Runtime;
/** Pool folgado, FILA de 1+1 — pressão de outro tipo, controle de especificidade. */
let FILA: Runtime;

/** Valores plantados no corpo do pedido que NÃO podem reaparecer na trilha. */
const SEGREDO_CAP = "SEGREDO-CAPABILITY-4242";
const SEGREDO_TOKEN = "SEGREDO-TOKEN-9999";

before(async () => {
  fixture = await startFixture();
  PRESSAO = await subir({ max_workers: 1 });
  FOLGA = await subir({ max_workers: 4 });
  FILA = await subir({ max_workers: 4, max_concurrency: 1, max_queue: 1, action_timeout_ms: 60_000 });
});

after(async () => {
  await PRESSAO?.daemon.close("teste");
  await FOLGA?.daemon.close("teste");
  await FILA?.daemon.close("teste");
  await fixture?.close();
  for (const r of [PRESSAO, FOLGA, FILA]) {
    if (r !== undefined) await rm(r.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pool cheio: o cliente é recusado E a trilha registra
// ─────────────────────────────────────────────────────────────────────────────

let recusa: AuditEntry;
let recusaAction_id: string;

test("1. pool cheio recusa POST /sessions com 429 e DEIXA linha auditável", async () => {
  const primeira = await chamar<SessionInfo>(PRESSAO, "POST", "/api/v1/sessions", {
    owner: "dono-que-coube",
    profile: "sandbox",
    headless: true,
  });
  assert.equal(primeira.status, 201, `primeira sessão devia caber: ${JSON.stringify(primeira.body)}`);

  // CONTROLE: antes da recusa não pode existir linha nenhuma dessa família — se
  // existisse, o que o próximo passo encontra não seria efeito da recusa.
  assert.equal(
    (await trilha(PRESSAO.root, "_runtime")).filter((l) => l.event === "backpressure").length,
    0,
    "a linha de recusa não pode existir antes de haver recusa",
  );

  const segunda = await chamar<{ error: { code: string; message: string }; action_id: string }>(
    PRESSAO,
    "POST",
    "/api/v1/sessions",
    {
      owner: "dono-recusado",
      profile: "sandbox",
      headless: true,
      // Chaves que NÃO são capability entram de propósito: `normalizeCapabilities`
      // tem de descartá-las antes de a trilha ver qualquer coisa.
      capabilities: { upload: true, api_key: SEGREDO_CAP, token: SEGREDO_TOKEN },
    },
  );
  assert.equal(segunda.status, 429, `pool cheio devia recusar com 429: ${JSON.stringify(segunda.body)}`);
  assert.equal(segunda.body.error.code, "BACKPRESSURE_REJECTED");
  recusaAction_id = segunda.body.action_id;
  assert.equal(typeof recusaAction_id, "string");

  const linhas = (await trilha(PRESSAO.root, "_runtime")).filter((l) => l.event === "backpressure");
  assert.equal(linhas.length, 1, `a recusa tem de deixar UMA linha, veio ${linhas.length}`);
  recusa = linhas[0]!;
});

test("2. a linha da recusa segue o schema de 19 campos da FASE 3", () => {
  for (const campo of AUDIT_FIELDS) {
    assert.ok(Object.hasOwn(recusa, campo), `chave "${campo}" AUSENTE: ${JSON.stringify(recusa)}`);
  }
  assert.equal(
    Object.keys(recusa).length,
    AUDIT_FIELDS.length,
    `linha com chave extra: ${JSON.stringify(recusa)}`,
  );
  assert.ok(AUDIT_EVENTS.includes(recusa.event), `event não declarado: ${recusa.event}`);
});

test("3. a linha responde QUEM, O QUÊ e SOB QUE PRESSÃO", () => {
  assert.equal(recusa.event, "backpressure");
  assert.equal(recusa.action, "session.rejected");
  // Sem sessão: a recusa acontece ANTES de a sessão existir. `null` aqui é a
  // resposta honesta, e é o que manda a linha para o balde `_runtime`.
  assert.equal(recusa.session, null);
  assert.equal(recusa.owner, "dono-recusado", "o dono PEDIDO tem de estar registrado");
  assert.equal(recusa.actor, "teste-backpressure", "o ator não pode ser genérico");
  assert.notEqual(recusa.actor, "unknown");
  assert.equal(recusa.result, "denied", "o pedido foi RECUSADO, não quebrou");
  // NENHUMA política foi consultada: quem recusou foi o teto de capacidade.
  // Marcar `deny` faria toda busca por negação de política devolver este caso.
  assert.equal(recusa.policy_decision, "not_applicable");
  assert.equal(recusa.policy_reason, null);
  assert.equal(recusa.capability, null);
  assert.equal(recusa.verified, false);
  assert.ok(recusa.error !== null, "recusa sem `error` não diz por quê");
  assert.equal(recusa.error.code, "BACKPRESSURE_REJECTED");
  assert.ok(recusa.error.message.length > 0);
  // Correlaciona com a resposta que o cliente recebeu. Sem isto, casar o 429 do
  // cliente com a linha exigiria correlação por timestamp — que é exatamente o
  // que falha quando várias recusas caem no mesmo segundo.
  assert.equal(recusa.action_id, recusaAction_id);

  const d = recusa.detail as Record<string, unknown>;
  assert.equal(d.route, "sessions.create");
  assert.equal(d.http_status, 429);
  assert.equal(d.workers_max, 1, "o teto que foi batido");
  assert.equal(d.workers_ativos, 1, "quantos worker estavam em uso no instante da recusa");
  assert.equal(d.sessoes_vivas, 1);
  assert.equal(d.owner_solicitado, "dono-recusado");
  assert.equal(d.profile_solicitado, "sandbox");
  assert.equal(typeof d.max_concurrency, "number");
  assert.equal(typeof d.max_queue, "number");
  assert.equal(typeof d.fila_running, "number");
  assert.equal(typeof d.fila_waiting, "number");
});

test("4. as capabilities pedidas entram NORMALIZADAS — nada de eco do corpo cru", () => {
  const caps = (recusa.detail as Record<string, unknown>).capabilities_solicitadas as Record<string, unknown>;
  assert.ok(caps !== null && typeof caps === "object", "capabilities pedidas têm de estar na linha");
  // O que o cliente PEDIU sobreviveu…
  assert.equal(caps.upload, true, "a capability de fato pedida tem de aparecer");
  assert.equal(caps.navigate, true);
  assert.equal(caps.purchase, false);
  // …e o que ele enfiou junto NÃO. `normalizeCapabilities` só copia as chaves do
  // conjunto fechado; a trilha nunca ecoa entrada não validada.
  assert.ok(!("api_key" in caps), `chave estranha vazou para a trilha: ${JSON.stringify(caps)}`);
  assert.ok(!("token" in caps), `chave estranha vazou para a trilha: ${JSON.stringify(caps)}`);
  for (const [k, v] of Object.entries(caps)) {
    assert.equal(typeof v, "boolean", `capability ${k} não é booleana: ${String(v)}`);
  }
});

test("5. a trilha da recusa não carrega credencial nem valor sensível", async () => {
  const cru = await trilhaCrua(PRESSAO.root, "_runtime");
  assert.ok(cru !== null && cru.length > 0, "sem trilha não há o que verificar");
  // CONTROLE POSITIVO: o texto que DEVE estar lá está — senão as ausências
  // abaixo seriam verdadeiras num arquivo vazio.
  assert.ok(cru.includes("BACKPRESSURE_REJECTED"), "controle: a recusa tem de estar no arquivo");
  for (const proibido of [SEGREDO_CAP, SEGREDO_TOKEN, PRESSAO.token]) {
    assert.ok(!cru.includes(proibido), `valor sensível vazou para a trilha: ${proibido.slice(0, 12)}…`);
  }
  for (const cabecalho of ["authorization", "Bearer ", "set-cookie"]) {
    assert.ok(!cru.includes(cabecalho), `cabeçalho de credencial vazou: ${cabecalho}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLE DE VACUIDADE — sem pressão, a linha não aparece
// ─────────────────────────────────────────────────────────────────────────────

test("6. CONTROLE: sem pressão de pool, nenhuma linha `backpressure` é escrita", async () => {
  const criada = await chamar<SessionInfo>(FOLGA, "POST", "/api/v1/sessions", {
    owner: "dono-folgado",
    profile: "sandbox",
    headless: true,
  });
  assert.equal(criada.status, 201, `criação devia passar: ${JSON.stringify(criada.body)}`);

  const linhas = await todasAsLinhas(FOLGA.root);
  // CONTROLE POSITIVO: houve trilha de verdade — senão "zero recusas" seria
  // apenas "zero linhas", e o teste não diria nada.
  assert.ok(linhas.length >= 3, `trilha rasa demais para o controle valer: ${linhas.length} linhas`);
  assert.ok(
    linhas.some((l) => l.event === "control" && l.action === "session.created"),
    "controle: a criação bem-sucedida tem de estar registrada",
  );
  const recusas = linhas.filter((l) => l.event === "backpressure");
  assert.equal(recusas.length, 0, `linha de recusa sem recusa: ${JSON.stringify(recusas[0] ?? null)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Profundidade da fila publicada × realidade observada pelo cliente
// ─────────────────────────────────────────────────────────────────────────────

interface FilaPorSessao {
  session_id: string;
  running: number;
  waiting: number;
  max_concurrency: number;
  max_queue: number;
  oldest_running_ms: number | null;
}
interface RespostaQueues {
  workers: { active: number; max: number };
  aggregate: HealthResponse["queues"];
  sessions: FilaPorSessao[];
}

let filaSessao = "";
let amostraQueues: RespostaQueues;
let amostraHealth: HealthResponse;
let atendidas = 0;
let recusadas = 0;

test("7. a profundidade publicada bate com o que o cliente observa sob pressão", async () => {
  const criada = await chamar<SessionInfo>(FILA, "POST", "/api/v1/sessions", {
    owner: "dono-da-fila",
    profile: "sandbox",
    headless: true,
  });
  assert.equal(criada.status, 201, `criação devia passar: ${JSON.stringify(criada.body)}`);
  filaSessao = criada.body.session_id;

  const teto = FILA.daemon.config.max_concurrency + FILA.daemon.config.max_queue;
  assert.equal(teto, 2, "a prova depende de 1 em execução + 1 aguardando");

  // Cinco ações LENTAS de uma vez: 2 cabem (1 executando + 1 aguardando), 3 são
  // recusadas na hora. `allSettled` porque a rejeição é resposta, não exceção.
  const disparos = Array.from({ length: 5 }, () =>
    chamar<{ success: boolean; error: { code: string } | null }>(FILA, "POST", "/api/v1/browser.goto", {
      session_id: filaSessao,
      url: `${fixture.base}/lento`,
    }),
  );

  // Amostra TOMADA COM AS AÇÕES EM VOO. Fora dessa janela a fila está vazia e a
  // medição não diria nada. 400ms é folga de sobra: a ação lenta segura 2.5s.
  await new Promise<void>((r) => setTimeout(r, 400));
  const q = await chamar<RespostaQueues>(FILA, "GET", "/api/v1/queues");
  const h = await chamar<HealthResponse>(FILA, "GET", "/health");
  assert.equal(q.status, 200, `/queues falhou: ${JSON.stringify(q.body)}`);
  assert.equal(h.status, 200);
  amostraQueues = q.body;
  amostraHealth = h.body;

  const respostas = await Promise.all(disparos);
  atendidas = respostas.filter((r) => r.status === 200).length;
  recusadas = respostas.filter((r) => r.body.error?.code === "BACKPRESSURE_REJECTED").length;

  assert.equal(atendidas, teto, `a fila devia atender exatamente ${teto}: ${atendidas}`);
  assert.equal(recusadas, 5 - teto, `as demais deviam ser recusadas: ${recusadas}`);
});

test("8. `GET /api/v1/queues` publica a fila POR SESSÃO com os tetos", () => {
  const s = amostraQueues.sessions.find((x) => x.session_id === filaSessao);
  assert.ok(s !== undefined, `sessão ${filaSessao} ausente de /queues`);
  assert.equal(s.max_concurrency, 1);
  assert.equal(s.max_queue, 1);
  assert.equal(s.running, 1, "uma ação em execução — o teto de concorrência");
  assert.equal(s.waiting, 1, "uma ação aguardando — o teto de fila");
  // O que o cliente observou como ATENDIDO é exatamente o que a rota publicou
  // como ocupado no mesmo instante. É esta igualdade que impede o número
  // publicado de ser decoração.
  assert.equal(s.running + s.waiting, atendidas);
  assert.ok(
    typeof s.oldest_running_ms === "number" && s.oldest_running_ms >= 0,
    `idade do trabalho mais antigo ausente: ${String(s.oldest_running_ms)}`,
  );
  assert.equal(amostraQueues.workers.max, FILA.daemon.config.max_workers);
});

test("9. `/health` publica o AGREGADO — e só o agregado", () => {
  const q = amostraHealth.queues;
  assert.ok(q !== undefined && q !== null, "/health tem de publicar `queues`");
  assert.equal(q.running, 1);
  assert.equal(q.waiting, 1);
  assert.equal(q.sessions_with_queue, 1);
  assert.equal(q.max_concurrency, FILA.daemon.config.max_concurrency);
  assert.equal(q.max_queue, FILA.daemon.config.max_queue);
  assert.equal(q.running + q.waiting, atendidas, "o agregado tem de bater com o observado");
  // A DECISÃO DE PRIVACIDADE, MEDIDA: `/health` responde a qualquer token
  // OBSERVE — inclusive um limitado a UMA sessão, porque a rota não nomeia
  // sessão. Publicar `session_id` aqui entregaria a atividade alheia.
  const cru = JSON.stringify(amostraHealth);
  assert.ok(!cru.includes(filaSessao), `/health vazou identidade de sessão: ${cru.slice(0, 200)}`);
  assert.ok(!cru.includes("ses_"), "/health não pode nomear sessão nenhuma");
});

test("10. CONTROLE DE ESPECIFICIDADE: pressão de FILA não vira linha de recusa de POOL", async () => {
  const linhas = await todasAsLinhas(FILA.root);
  // CONTROLE POSITIVO: a pressão aconteceu MESMO — as recusas da fila estão na
  // trilha da sessão, como linha de AÇÃO com o código do contrato.
  const recusasDeFila = linhas.filter(
    (l) => l.event === "action" && l.error !== null && l.error.code === "BACKPRESSURE_REJECTED",
  );
  assert.equal(
    recusasDeFila.length,
    recusadas,
    `a trilha da sessão devia ter ${recusadas} recusa(s) de fila, tem ${recusasDeFila.length}`,
  );
  // E MESMO ASSIM nenhuma linha da família nova: ela é da recusa de POOL, e pool
  // nenhum foi estourado aqui. Sem este controle, `event: "backpressure"` estaria
  // marcando qualquer 429 e a distinção não existiria.
  const recusasDePool = linhas.filter((l) => l.event === "backpressure");
  assert.equal(
    recusasDePool.length,
    0,
    `pressão de fila produziu linha de recusa de pool: ${JSON.stringify(recusasDePool[0] ?? null)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A rota nova é AUTENTICADA e exige ADMIN
// ─────────────────────────────────────────────────────────────────────────────

test("11. `GET /api/v1/queues` recusa sem credencial e recusa com escopo insuficiente", async () => {
  const semCredencial = await chamar<{ error: { code: string } }>(FILA, "GET", "/api/v1/queues", undefined, null);
  assert.equal(semCredencial.status, 401, "sem credencial a rota tem de recusar");
  assert.equal(semCredencial.body.error.code, "CAPABILITY_DENIED");

  // OBSERVE não basta: o detalhe por sessão é mapa de atividade, no mesmo nível
  // de `config.get`.
  const { secret: observador } = FILA.daemon.auth.issue({ subject: "curioso", preset: "observe" });
  const comObserve = await chamar<{ error: { code: string } }>(
    FILA,
    "GET",
    "/api/v1/queues",
    undefined,
    observador,
  );
  assert.equal(comObserve.status, 403, "OBSERVE não pode ler a fila por sessão");
  assert.equal(comObserve.body.error.code, "CAPABILITY_DENIED");

  // CONTROLE: o MESMO token OBSERVE lê `/health` — se ele estivesse barrado em
  // tudo, o 403 acima não diria nada sobre ESTA rota.
  const health = await chamar<HealthResponse>(FILA, "GET", "/health", undefined, observador);
  assert.equal(health.status, 200, "controle: OBSERVE tem de continuar lendo /health");
  assert.ok(health.body.queues !== undefined, "o agregado continua público para OBSERVE");
});

// ─────────────────────────────────────────────────────────────────────────────
// Todo evento EMITIDO está DECLARADO
//
// A varredura é de RUNTIME, sobre o que de fato foi para o disco, e não um grep
// no fonte. Medido: `packages/core/src/vault.ts:219` tem `event: "secret.used"`
// num `RuntimeEvent` — um grep por `event: "…"` não distingue esse literal do de
// um `AuditEntry` e acusaria falso positivo eterno. O compilador já cobre o lado
// estático (`AuditEventCobertura` em `contract.ts`, `EventCoverage` em
// `router.ts`); o que faltava era conferir o que sai na prática.
// ─────────────────────────────────────────────────────────────────────────────

test("12. todo `event` que chegou ao disco está declarado em AUDIT_EVENTS", async () => {
  const vistos = new Set<string>();
  let total = 0;
  for (const root of [PRESSAO.root, FOLGA.root, FILA.root]) {
    for (const l of await todasAsLinhas(root)) {
      total += 1;
      vistos.add(String(l.event));
      assert.ok(
        AUDIT_EVENTS.includes(l.event),
        `event não declarado em AUDIT_EVENTS: ${String(l.event)} — ${JSON.stringify(l)}`,
      );
    }
  }
  // Piso, não alvo: 20 linhas foi o medido nesta bateria (3 daemons). O que o
  // piso impede é a varredura passar sobre um punhado de linhas ou sobre nada.
  assert.ok(total > 15, `varredura rasa demais para valer: ${total} linhas`);
  // CONTROLE: a varredura viu classes DIFERENTES. Uma trilha de um único valor
  // faria a asserção acima passar sem exercitar nada.
  assert.ok(vistos.size >= 3, `poucas classes de evento na varredura: ${[...vistos].join(", ")}`);
  assert.ok(vistos.has("backpressure"), "a família nova tem de ter sido exercitada");
});

test("13. AUDIT_EVENTS é a lista congelada e declara a família nova", () => {
  assert.ok(Object.isFrozen(AUDIT_EVENTS), "a lista tem de ser congelada");
  assert.ok(AUDIT_EVENTS.includes("backpressure"));
  for (const esperado of ["action", "policy", "control", "recovery", "task", "provider"] as const) {
    assert.ok(AUDIT_EVENTS.includes(esperado), `classe histórica sumiu da lista: ${esperado}`);
  }
});
