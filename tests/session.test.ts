/**
 * FASE 3 / 27 / 28 / 32 — prova do SessionManager com Chromium REAL.
 *
 * Critério de honestidade (mesmo do spike da FASE 1): nada aqui é mock. Cada
 * afirmação vem de um browser vivo — cookie lido do jar do Chromium, JS avaliado
 * na página depois do detach, dir de perfil olhado no disco.
 *
 * Onde há risco de asserção vácua, existe controle positivo:
 *   - "B não tem o cookie" só vale se A TIVER o cookie (senão a escrita falhou);
 *   - "sessão sobreviveu ao detach" só vale se a página responder a um evaluate
 *     (isClosed()==false não prova que o processo respira).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Page } from "playwright";
import {
  DEFAULT_PROFILES_ROOT,
  SessionManager,
  canTransition,
  isSessionError,
  normalizeCapabilities,
} from "../packages/core/src/session.ts";
import type { RuntimeEvent, SessionInfo } from "../packages/core/src/contract.ts";

const COOKIE_NAME = "nomos_probe";
const COOKIE_VALUE = "valor_do_perfil_A";

/** Sufixo único: perfil reaproveitado de execução anterior contaminaria a prova. */
const RUN = Math.random().toString(36).slice(2, 8);
const PROFILE_A = `tst-alpha-${RUN}`;
const PROFILE_B = `tst-beta-${RUN}`;
const PROFILE_C = `tst-gama-${RUN}`;
const PROFILE_DIRS = [PROFILE_A, PROFILE_B, PROFILE_C].map((p) => path.join(DEFAULT_PROFILES_ROOT, p));

interface Fixture {
  base: string;
  close: () => Promise<void>;
}

/** Servidor local: a prova tem de rodar offline, sem rede externa. */
function startFixture(): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/set") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=600; SameSite=Lax`,
      });
      res.end("<!doctype html><title>set</title><p id=p>cookie gravado</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>nomos ${pathname}</title><p id=p>${pathname}</p>`);
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

function activeUrl(info: SessionInfo): string | null {
  return info.pages.find((p) => p.active)?.url ?? null;
}

let fixture: Fixture;
let manager: SessionManager;
let pool: SessionManager;
const events: RuntimeEvent[] = [];
const trackedPages: Page[] = [];

let sessionA = "";
let sessionB = "";

before(async () => {
  fixture = await startFixture();
  manager = new SessionManager({ headless: true, onEvent: (e) => events.push(e) });
});

after(async () => {
  // Rede de segurança: se um teste explodir antes do encerramento explícito,
  // nenhum Chromium fica órfão nesta máquina.
  await manager?.closeAll().catch(() => undefined);
  await pool?.closeAll().catch(() => undefined);
  await fixture?.close();
  for (const dir of PROFILE_DIRS) await rm(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

test("capabilities nascem restritas e só true literal concede (fail closed)", () => {
  const c = normalizeCapabilities({ payment: true, download: "sim" as unknown as boolean, click: false });
  assert.equal(c.payment, true, "true explícito concede");
  assert.equal(c.download, false, "truthy não-booleano NÃO concede");
  assert.equal(c.click, false);
  assert.equal(c.send, false);
  assert.equal(c.delete, false);
  assert.equal(normalizeCapabilities().navigate, true);
  assert.equal(normalizeCapabilities().purchase, false);
});

test("perfis persistentes moram em <repo>/profiles/<perfil>", () => {
  assert.equal(DEFAULT_PROFILES_ROOT, path.resolve(import.meta.dirname, "..", "profiles"));
  assert.equal(manager.profileDir(PROFILE_A), path.join(DEFAULT_PROFILES_ROOT, PROFILE_A));
  // Traversal de perfil é recusado antes de virar caminho em disco.
  assert.throws(
    () => manager.profileDir("../../etc"),
    (e: unknown) => isSessionError(e) && e.code === "INVALID_REQUEST",
  );
});

test("1. dois perfis diferentes NÃO compartilham cookie", async () => {
  const a = await manager.createSession({ owner: "agent-a", profile: PROFILE_A, client: "cli-a" });
  sessionA = a.session_id;
  assert.equal(a.profile, PROFILE_A);
  assert.equal(a.status, "ACTIVE");
  assert.equal(a.pages.length, 1);

  await manager.goto(sessionA, `${fixture.base}/set`);
  await manager.goto(sessionA, `${fixture.base}/home`);

  // CONTROLE POSITIVO: sem isto, "B não tem o cookie" seria afirmação vazia.
  const cookieA = await manager.getPage(sessionA).evaluate(() => document.cookie);
  assert.ok(cookieA.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`), `perfil A deveria ter o cookie, veio: ${JSON.stringify(cookieA)}`);

  const b = await manager.createSession({ owner: "agent-b", profile: PROFILE_B, client: "cli-b" });
  sessionB = b.session_id;
  await manager.goto(sessionB, `${fixture.base}/home`);

  const cookieB = await manager.getPage(sessionB).evaluate(() => document.cookie);
  assert.ok(
    !cookieB.includes(COOKIE_NAME),
    `perfil B NÃO pode ver o cookie do perfil A — veio: ${JSON.stringify(cookieB)}`,
  );

  // E o cookie de A continua lá: a ausência em B não é "o cookie morreu".
  const cookieA2 = await manager.getPage(sessionA).evaluate(() => document.cookie);
  assert.ok(cookieA2.includes(COOKIE_NAME), "cookie de A evaporou — prova seria inconclusiva");

  // CONTROLE DO INSTRUMENTO: a sonda `document.cookie` só serve de prova se for
  // CAPAZ de enxergar compartilhamento. Segunda sessão no MESMO perfil TEM de
  // ver o cookie — sem isto, a ausência em B poderia ser cegueira da sonda.
  const a2 = await manager.createSession({ owner: "agent-a2", profile: PROFILE_A });
  await manager.goto(a2.session_id, `${fixture.base}/home`);
  const cookieA2mesmo = await manager.getPage(a2.session_id).evaluate(() => document.cookie);
  assert.ok(
    cookieA2mesmo.includes(COOKIE_NAME),
    `sonda cega: mesmo perfil deveria compartilhar cookie, veio ${JSON.stringify(cookieA2mesmo)}`,
  );
  assert.equal(a2.context_id, a.context_id, "mesmo perfil = mesmo contexto");
  await manager.closeSession(a2.session_id);

  const ctxA = manager.contextInfo(sessionA);
  const ctxB = manager.contextInfo(sessionB);
  assert.notEqual(ctxA.context_id, ctxB.context_id, "perfis distintos exigem contextos distintos");
  assert.notEqual(ctxA.user_data_dir, ctxB.user_data_dir);
  assert.equal(existsSync(ctxA.user_data_dir), true, "perfil persistente tem de existir em disco");
  assert.equal(manager.poolStats().contexts, 2);

  trackedPages.push(manager.getPage(sessionA), manager.getPage(sessionB));
});

test("2. detach mantém a sessão VIVA e preserva a URL; attach devolve o mesmo estado", async () => {
  const marker = `${fixture.base}/orfa-viva`;
  await manager.goto(sessionA, marker);
  const antes = await manager.observe(sessionA);
  assert.equal(activeUrl(antes), marker);

  const solta = manager.detach(sessionA);
  assert.equal(solta.attached_client, null, "detach solta o cliente");
  assert.equal(solta.status, "IDLE", "órfã fica IDLE, não CLOSED");
  assert.equal(activeUrl(solta), marker, "URL preservada no detach");

  // O browser tem de estar RESPIRANDO, não só "não fechado": um evaluate
  // atravessa o CDP até o processo do Chromium e volta.
  const page = manager.getPage(sessionA);
  assert.equal(page.isClosed(), false);
  assert.equal(await page.evaluate(() => 6 * 7), 42, "página órfã tem de responder JS");
  assert.equal(await page.evaluate(() => document.getElementById("p")?.textContent), "/orfa-viva");
  assert.equal(page.url(), marker);

  const depois = manager.attach(sessionA, "cli-a2");
  assert.equal(depois.status, "ACTIVE");
  assert.equal(depois.attached_client, "cli-a2");
  assert.equal(depois.session_id, antes.session_id, "mesma sessão, não recriada");
  assert.equal(depois.context_id, antes.context_id, "mesmo contexto — cookies intactos");
  assert.equal(activeUrl(depois), marker, "attach devolve a mesma URL");
  assert.equal(depois.created_at, antes.created_at);

  // Cookie do perfil A sobreviveu ao ciclo detach/attach.
  const cookie = await manager.getPage(sessionA).evaluate(() => document.cookie);
  assert.ok(cookie.includes(COOKIE_NAME), "detach/attach não pode perder cookie");

  // Attach sobre sessão já atada é recusado sem force (dois clientes calados = bug invisível).
  assert.throws(
    () => manager.attach(sessionA, "cli-intruso"),
    (e: unknown) => isSessionError(e) && e.code === "INVALID_REQUEST",
  );
});

test("3. handoff troca o dono preservando URL, abas, task e cookies", async () => {
  const marker = `${fixture.base}/handoff-alvo`;
  await manager.goto(sessionA, marker);
  manager.setTask(sessionA, "conferir extrato");
  const antes = await manager.observe(sessionA);
  assert.equal(antes.owner, "agent-a");

  const n = events.length;
  const depois = await manager.handoff(sessionA, "agent-omega");

  assert.equal(depois.owner, "agent-omega", "dono trocou");
  assert.equal(activeUrl(depois), marker, "URL preservada");
  assert.equal(depois.pages.length, antes.pages.length, "abas preservadas");
  assert.equal(depois.task, "conferir extrato", "task preservada");
  assert.equal(depois.context_id, antes.context_id);
  assert.equal(depois.session_id, sessionA);

  const cookie = await manager.getPage(sessionA).evaluate(() => document.cookie);
  assert.ok(cookie.includes(COOKIE_NAME), "cookies preservados no handoff");

  const emitido = events.slice(n).find((e) => e.event === "session.handoff");
  assert.ok(emitido !== undefined, "handoff tem de emitir session.handoff");
  assert.equal(emitido.session_id, sessionA);
  assert.equal(emitido.payload.from_owner, "agent-a");
  assert.equal(emitido.payload.to_owner, "agent-omega");
  assert.equal(emitido.payload.url, marker);
});

test("4. estourar max_workers devolve BACKPRESSURE_REJECTED (sem fila infinita)", async () => {
  pool = new SessionManager({ max_workers: 2, headless: true });

  const s1 = await pool.createSession({ owner: "agent-pool", profile: PROFILE_C });
  const s2 = await pool.createSession({ owner: "agent-pool", profile: PROFILE_C });
  assert.equal(pool.poolStats().workers.active, 2);
  assert.equal(pool.poolStats().workers.max, 2);
  assert.equal(pool.poolStats().contexts, 1, "mesmo perfil = um contexto só");

  await assert.rejects(
    () => pool.createSession({ owner: "agent-pool", profile: PROFILE_C }),
    (e: unknown) => isSessionError(e) && e.code === "BACKPRESSURE_REJECTED",
    "terceira sessão além do teto tem de ser recusada",
  );

  // O erro também tem de aparecer no envelope ActionResponse — nada de falha muda.
  const env = await pool.createSessionEnvelope({ owner: "agent-pool", profile: PROFILE_C });
  assert.equal(env.success, false);
  assert.equal(env.result, null);
  assert.equal(env.error?.code, "BACKPRESSURE_REJECTED");
  assert.equal(env.error?.detail?.max, 2);
  assert.ok(env.timing.duration_ms >= 0);

  // Rejeição não pode virar trava permanente: liberar slot volta a aceitar.
  await pool.closeSession(s2.session_id);
  assert.equal(pool.poolStats().workers.active, 1);
  const s3 = await pool.createSession({ owner: "agent-pool", profile: PROFILE_C });
  assert.ok(s3.session_id.startsWith("ses_"));
  assert.equal(s3.context_id, s1.context_id, "reusa o contexto do perfil");
  assert.equal(pool.poolStats().workers.active, 2);
});

test("idle_timeout recicla órfã ociosa, mas poupa sessão com cliente atado", async () => {
  const alvo = pool.list();
  assert.equal(alvo.length, 2, "pool deveria ter duas sessões vivas");
  assert.ok(alvo.every((s) => s.status === "IDLE" && s.attached_client === null));

  pool.attach(alvo[0]!.session_id, "cli-vivo");
  const fechadas = await pool.sweepIdle(Date.now() + 10 ** 9);

  assert.deepEqual(fechadas, [alvo[1]!.session_id], "só a órfã ociosa pode ser reciclada");
  assert.equal(pool.get(alvo[1]!.session_id).status, "CLOSED");
  assert.equal(pool.get(alvo[0]!.session_id).status, "ACTIVE", "sessão com cliente atado é intocável");
  assert.equal(pool.poolStats().workers.active, 1);
  assert.equal(pool.poolStats().contexts, 1, "contexto sobrevive enquanto uma sessão o usa");

  // Sem estourar o timeout, ninguém é reciclado.
  assert.deepEqual(await pool.sweepIdle(Date.now()), []);
});

test("takeover congela o agente; release exige reobservação antes de ACTIVE", async () => {
  const t = manager.takeover(sessionA, "dono");
  assert.equal(t.control, "human");
  assert.equal(t.status, "PAUSED");
  assert.throws(
    () => manager.assertAgentControl(sessionA),
    (e: unknown) => isSessionError(e) && e.code === "CONTROL_HELD_BY_HUMAN",
  );

  // Humano navega por fora — release NÃO pode fingir que a página é a mesma.
  const outra = `${fixture.base}/o-humano-navegou`;
  await manager.getPage(sessionA).goto(outra, { waitUntil: "domcontentloaded" });

  const r = await manager.release(sessionA, "dono");
  assert.equal(r.control, "agent");
  assert.equal(r.status, "RECOVERING", "release não devolve ACTIVE de graça");
  assert.equal(manager.needsReobservation(sessionA), true);
  assert.equal(activeUrl(r), outra, "release releu a URL real do browser");

  const evento = events.filter((e) => e.event === "control.returned").at(-1);
  assert.ok(evento !== undefined);
  assert.equal(evento.payload.needs_reobservation, true);
  assert.equal(evento.payload.url_changed_under_human, true);

  const obs = manager.markObserved(sessionA);
  assert.equal(obs.status, "ACTIVE");
  assert.equal(manager.needsReobservation(sessionA), false);
});

test("transição de estado inválida lança erro claro", () => {
  assert.equal(canTransition("ACTIVE", "IDLE"), true);
  assert.equal(canTransition("CLOSED", "ACTIVE"), false);
  assert.equal(canTransition("ACTIVE", "CREATED"), false);
  assert.throws(
    () => manager.transition(sessionA, "CREATED"),
    (e: unknown) =>
      isSessionError(e) && e.code === "INVALID_REQUEST" && /ACTIVE → CREATED/.test(e.message),
  );
  assert.equal(manager.get(sessionA).status, "ACTIVE", "tentativa inválida não pode alterar o estado");
});

test("capability sensível é fail closed", () => {
  manager.assertCapability(sessionA, "browser.click");
  assert.throws(
    () => manager.assertCapability(sessionA, "browser.download"),
    (e: unknown) => isSessionError(e) && e.code === "CAPABILITY_DENIED",
  );
  // Ferramenta sem entrada em REQUIRED_CAPABILITY é negada, não liberada.
  assert.throws(
    () => manager.assertCapability(sessionA, "browser.inventada"),
    (e: unknown) => isSessionError(e) && e.code === "CAPABILITY_DENIED",
  );
});

test("perfil sandbox é efêmero: dir temporário, apagado no close", async () => {
  const s = await manager.createSession({ owner: "agent-sbx", profile: "sandbox" });
  const ctx = manager.contextInfo(s.session_id);
  assert.equal(ctx.ephemeral, true);
  assert.equal(existsSync(ctx.user_data_dir), true);
  assert.ok(
    !ctx.user_data_dir.startsWith(DEFAULT_PROFILES_ROOT),
    "sandbox não pode gravar em profiles/ — é efêmero",
  );
  await manager.goto(s.session_id, `${fixture.base}/sandbox`);
  const cookie = await manager.getPage(s.session_id).evaluate(() => document.cookie);
  assert.ok(!cookie.includes(COOKIE_NAME), "sandbox não herda cookie de perfil nenhum");

  await manager.closeSession(s.session_id);
  assert.equal(existsSync(ctx.user_data_dir), false, "dir efêmero tem de sumir no close");
  assert.equal(manager.get(s.session_id).status, "CLOSED");
});

test("encerramento: nenhum Chromium vaza", async () => {
  for (const info of manager.list()) trackedPages.push(manager.getPage(info.session_id));
  for (const info of pool.list()) trackedPages.push(pool.getPage(info.session_id));
  const vivas = trackedPages.filter((p) => !p.isClosed());
  assert.ok(vivas.length >= 3, `esperava páginas vivas antes do shutdown, tinha ${vivas.length}`);

  await manager.closeAll();
  await pool.closeAll();

  assert.equal(manager.poolStats().contexts, 0, "nenhum contexto de manager sobrou");
  assert.equal(pool.poolStats().contexts, 0, "nenhum contexto de pool sobrou");
  assert.equal(manager.poolStats().workers.active, 0);
  assert.equal(pool.poolStats().workers.active, 0);
  assert.equal(manager.list().length, 0);

  for (const p of trackedPages) {
    assert.equal(p.isClosed(), true, `página ficou aberta após closeAll: ${p.url()}`);
  }

  // Perfis persistentes SOBREVIVEM ao close — é o ponto de serem persistentes.
  assert.equal(existsSync(path.join(DEFAULT_PROFILES_ROOT, PROFILE_A)), true);
  assert.equal(existsSync(path.join(DEFAULT_PROFILES_ROOT, PROFILE_B)), true);
  assert.equal(manager.poolStats().hook_errors, 0, "hook onEvent não pode ter quebrado");
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 25 — "a página sumiu" não é "o alvo não foi encontrado"
//
// `getPage()` cobria três situações com o MESMO código de erro, e duas delas
// não eram erro de alvo nenhum. Medido no E2E de modos de falha: matando o
// Chromium, `browser.extract` E `browser.screenshot` voltavam `TARGET_NOT_FOUND`
// — e um screenshot não TEM alvo. Quem lesse a trilha iria caçar um seletor que
// estava correto, enquanto a verdade era que a página tinha morrido.
//
// A distinção que estes testes travam:
//   · página fechou / não há página  ⇒ BROWSER_UNAVAILABLE (condição do runtime)
//   · page_id que não é desta sessão ⇒ TARGET_NOT_FOUND    (erro de quem pediu)
// ─────────────────────────────────────────────────────────────────────────────

test("FASE 25 — página fechada por baixo vira BROWSER_UNAVAILABLE, não TARGET_NOT_FOUND", async () => {
  const s = await manager.createSession({ owner: "dono-pagina", profile: PROFILE_A });
  const page = manager.getPage(s.session_id);
  const idDaAba = manager.pageIdOf(page);
  await page.goto(fixture.base);

  // Controle positivo: com a página viva, `getPage` devolve a página. Sem ele,
  // o erro abaixo poderia vir de a sessão nunca ter funcionado.
  assert.equal(manager.getPage(s.session_id).isClosed(), false);

  // A página morre por baixo — como quando o Chromium é morto.
  await page.close();

  // Sem `page_id`: a sessão ficou sem aba nenhuma.
  //
  // A mensagem é asserida EXATAMENTE. Um regex frouxo (`/fechada|página aberta/`)
  // aceitava os dois ramos do `getPage`, e por isso não percebeu que este teste
  // nunca tocava o ramo que eu pensava estar cobrindo — a mutação passou verde.
  // Asserção que aceita duas causas diferentes não distingue nenhuma delas.
  assert.throws(
    () => manager.getPage(s.session_id),
    (e: unknown) =>
      isSessionError(e) &&
      e.code === "BROWSER_UNAVAILABLE" &&
      /não tem página aberta/.test(e.message),
    "sessão sem aba é condição do navegador, não erro de alvo",
  );

  // COM o `page_id` da aba que morreu: o cliente que guardou o id recebia
  // "não pertence à sessão" — que soa como bug dele. A sessão lembra quais abas
  // foram suas, então a resposta agora é "era sua e fechou".
  assert.throws(
    () => manager.getPage(s.session_id, idDaAba!),
    (e: unknown) =>
      isSessionError(e) && e.code === "BROWSER_UNAVAILABLE" && /era desta sessão e já fechou/.test(e.message),
    "aba que morreu não pode ser reportada como aba de outra pessoa",
  );

  await manager.closeSession(s.session_id, "fim do caso");
});

test("FASE 25 — mas page_id de outra sessão CONTINUA sendo erro de quem pediu", async () => {
  const a = await manager.createSession({ owner: "dono-a", profile: PROFILE_A });
  const b = await manager.createSession({ owner: "dono-b", profile: PROFILE_B });
  const paginaDeB = manager.pageIdOf(manager.getPage(b.session_id));
  assert.ok(paginaDeB !== null && paginaDeB !== undefined, "sessão B precisa ter uma página");

  // Pedir a aba de OUTRA sessão é erro do chamador — e tem que continuar
  // dizendo isso. Se a correção acima tivesse virado um renomeio geral, este
  // teste cairia, e é para isso que ele existe.
  assert.throws(
    () => manager.getPage(a.session_id, paginaDeB),
    (e: unknown) => isSessionError(e) && e.code === "TARGET_NOT_FOUND",
    "aba de outra sessão é erro de alvo, não do navegador",
  );

  await manager.closeSession(a.session_id, "fim do caso");
  await manager.closeSession(b.session_id, "fim do caso");
});
