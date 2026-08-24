/**
 * FASE 16/17 — provas negativas de autenticação e autorização.
 *
 * A missão exige que o teste consiga FALHAR: sem credencial, credencial
 * inválida, expirada, escopo insuficiente, token de uma sessão tentando outra.
 * Um teste que só exercita o caminho feliz não prova autenticação nenhuma.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AuthManager,
  ALL_SCOPES,
  SCOPE_PRESETS,
  TOOL_SCOPE,
  ROUTE_SCOPE,
  scopeForTool,
  scopeForRoute,
  readControlToken,
  TOKEN_FILE,
  isScope,
  type Scope,
} from "../packages/api/src/auth.ts";
import { ACTION_CLASS } from "../packages/core/src/contract.ts";

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "nomos-auth-"));
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 16 — autenticação
// ─────────────────────────────────────────────────────────────────────────────

test("sem credencial → DENY", () => {
  const a = new AuthManager();
  a.issue({ subject: "x", preset: "agent" });
  const r = a.authenticate(null);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.failure, "MISSING_CREDENTIAL");
});

test("credencial inválida → DENY", () => {
  const a = new AuthManager();
  a.issue({ subject: "x", preset: "agent" });
  for (const ruim of ["", "lixo", "Bearer nada", "a".repeat(43)]) {
    const r = a.authenticate(ruim);
    assert.equal(r.ok, false, `"${ruim.slice(0, 12)}" deveria ser negado`);
  }
});

test("credencial expirada → DENY, com relógio controlado", () => {
  let agora = 1_000_000;
  const a = new AuthManager({ now: () => agora });
  const t = a.issue({ subject: "efemero", preset: "observe", ttl_ms: 5_000 });

  assert.equal(a.authenticate(t.secret).ok, true, "deveria valer antes de expirar");
  agora += 4_999;
  assert.equal(a.authenticate(t.secret).ok, true, "ainda dentro da validade");
  agora += 1;
  const r = a.authenticate(t.secret);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.failure, "EXPIRED_CREDENTIAL");
});

test("credencial correta → PASS", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "bom", preset: "agent" });
  const r = a.authenticate(t.secret);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.token.subject, "bom");
});

test("revogação corta acesso imediatamente", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "revogavel", preset: "agent" });
  assert.equal(a.authenticate(t.secret).ok, true);
  assert.equal(a.revoke(t.token_id), true);
  const r = a.authenticate(t.secret);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.failure, "REVOKED_CREDENTIAL");
});

test("replay de token continua valendo — e é por isso que o TTL existe", () => {
  // Não há nonce por requisição: o mesmo token serve várias chamadas, como
  // qualquer Bearer. Declarar isso é mais honesto que fingir proteção que não há.
  const a = new AuthManager();
  const t = a.issue({ subject: "replay", preset: "observe" });
  for (let i = 0; i < 5; i++) assert.equal(a.authenticate(t.secret).ok, true);
});

test("token de outro AuthManager não vale (segredo é por instância/arranque)", () => {
  const a1 = new AuthManager();
  const a2 = new AuthManager();
  const t = a1.issue({ subject: "a1", preset: "agent" });
  assert.equal(a2.authenticate(t.secret).ok, false, "reiniciar o daemon tem de invalidar tokens antigos");
});

test("extract lê Bearer, x-nomos-token e ?token=, nesta precedência", () => {
  const u = new URL("http://127.0.0.1:7777/api/v1/browser.observe?token=DAQUERY");
  assert.equal(AuthManager.extract({ authorization: "Bearer DOHEADER" }, u), "DOHEADER");
  assert.equal(AuthManager.extract({ "x-nomos-token": "DOCUSTOM" }, u), "DOCUSTOM");
  assert.equal(AuthManager.extract({}, u), "DAQUERY");
  assert.equal(AuthManager.extract({}, new URL("http://127.0.0.1:7777/")), null);
  assert.equal(AuthManager.extract({ authorization: "Basic xyz" }, new URL("http://127.0.0.1:7777/")), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 17 — autorização
// ─────────────────────────────────────────────────────────────────────────────

test("autenticar NÃO é autorizar: token de observação não recebe CONTROL", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "observador", preset: "observe" });
  const auth = a.authenticate(t.secret);
  assert.equal(auth.ok, true);
  const tok = (auth as { ok: true; token: any }).token;

  assert.equal(a.authorize(tok, "OBSERVE").ok, true);
  for (const negado of ["NAVIGATE", "INPUT", "DOWNLOAD", "UPLOAD", "SECRET", "CONTROL", "ADMIN"] as Scope[]) {
    const r = a.authorize(tok, negado);
    assert.equal(r.ok, false, `observador não pode ${negado}`);
    assert.equal(r.ok === false && r.failure, "SCOPE_DENIED");
  }
});

test("ADMIN não implica os demais escopos (nada de hierarquia implícita)", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "so-admin", scopes: ["ADMIN"] });
  const tok = (a.authenticate(t.secret) as { ok: true; token: any }).token;
  assert.equal(a.authorize(tok, "ADMIN").ok, true);
  assert.equal(a.authorize(tok, "INPUT").ok, false, "ADMIN não pode virar INPUT por herança");
  assert.equal(a.authorize(tok, "OBSERVE").ok, false);
});

test("preset full NÃO inclui ADMIN — takeover é ato do operador humano", () => {
  assert.ok(!SCOPE_PRESETS.full!.includes("ADMIN"));
  assert.ok(SCOPE_PRESETS.admin!.includes("ADMIN"));
});

test("token da sessão A não alcança a sessão B", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "agente-a", preset: "agent", session_allowlist: ["ses_A"] });
  const tok = (a.authenticate(t.secret) as { ok: true; token: any }).token;

  assert.equal(a.authorize(tok, "INPUT", "ses_A").ok, true);
  const r = a.authorize(tok, "INPUT", "ses_B");
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.failure, "SESSION_NOT_OWNED");
});

test("token sem allowlist alcança qualquer sessão — e bindSession não a cria do nada", () => {
  const a = new AuthManager();
  const t = a.issue({ subject: "livre", preset: "agent" });
  const tok = (a.authenticate(t.secret) as { ok: true; token: any }).token;
  assert.equal(a.authorize(tok, "INPUT", "ses_qualquer").ok, true);
  a.bindSession(tok, "ses_nova");
  assert.equal(tok.session_allowlist.size, 0, "bindSession não deve confinar um token que era livre");
});

test("toda ferramenta do contrato tem escopo, e desconhecida cai em ADMIN", () => {
  const semEscopo = Object.keys(ACTION_CLASS).filter((t) => TOOL_SCOPE[t] === undefined);
  assert.deepEqual(semEscopo, [], `ferramentas sem escopo mapeado: ${semEscopo.join(", ")}`);
  // Fail closed: ferramenta inventada não pode cair num escopo brando.
  assert.equal(scopeForTool("browser.detonar"), "ADMIN");
  assert.equal(scopeForRoute("rota.inexistente"), "ADMIN");
});

test("escopos de rota separam leitura de controle e de administração", () => {
  assert.equal(ROUTE_SCOPE["sessions.list"], "OBSERVE");
  assert.equal(ROUTE_SCOPE["sessions.create"], "CONTROL");
  assert.equal(ROUTE_SCOPE["sessions.takeover"], "ADMIN");
  assert.equal(ROUTE_SCOPE["sessions.release"], "ADMIN");
});

test("download e upload não são o mesmo escopo que clicar", () => {
  // Colapsar INPUT e DOWNLOAD daria a quem pode clicar o direito de baixar.
  assert.equal(scopeForTool("browser.click"), "INPUT");
  assert.equal(scopeForTool("browser.download"), "DOWNLOAD");
  assert.equal(scopeForTool("browser.upload"), "UPLOAD");
  assert.notEqual(scopeForTool("browser.click"), scopeForTool("browser.download"));
});

test("escopo inválido na emissão é recusado, não normalizado", () => {
  const a = new AuthManager();
  assert.throws(() => a.issue({ subject: "x", scopes: ["SUPERPODER" as Scope] }), /escopo inválido/);
  assert.ok(isScope("OBSERVE"));
  assert.ok(!isScope("observe"), "escopo é case-sensitive; normalizar esconderia erro de configuração");
});

// ─────────────────────────────────────────────────────────────────────────────
// Arquivo de token
// ─────────────────────────────────────────────────────────────────────────────

test("bootstrap grava o token com permissão 0600 e não o imprime", () => {
  const dir = tmpdir();
  try {
    const a = new AuthManager({ runtime_dir: dir });
    const t = a.bootstrap();
    const alvo = path.join(dir, TOKEN_FILE);
    const modo = statSync(alvo).mode & 0o777;
    assert.equal(modo, 0o600, `esperava 600, veio ${modo.toString(8)}`);
    assert.equal(readFileSync(alvo, "utf8").trim(), t.secret);
    assert.equal(readControlToken(dir), t.secret);
    assert.equal(a.authenticate(t.secret).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arquivo de token com permissão larga é RECUSADO, não corrigido em silêncio", () => {
  const dir = tmpdir();
  try {
    const a = new AuthManager({ runtime_dir: dir });
    a.bootstrap();
    chmodSync(path.join(dir, TOKEN_FILE), 0o644);
    // Corrigir a permissão e seguir usando trataria uma credencial possivelmente
    // já lida por outro processo como se ainda fosse secreta.
    assert.throws(() => readControlToken(dir), /permissão larga/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modo disabled é explícito e concede tudo — existe só para migração", () => {
  const a = new AuthManager({ disabled: true });
  assert.equal(a.disabled, true);
  const r = a.authenticate(null);
  assert.equal(r.ok, true, "com auth desligada, ausência de credencial passa");
  const tok = (r as { ok: true; token: any }).token;
  for (const s of ALL_SCOPES) assert.equal(a.authorize(tok, s).ok, true);
});

test("dois tokens distintos não colidem e são distinguíveis na auditoria", () => {
  const a = new AuthManager();
  const t1 = a.issue({ subject: "agente-a", preset: "agent" });
  const t2 = a.issue({ subject: "agente-b", preset: "agent" });
  assert.notEqual(t1.secret, t2.secret);
  assert.notEqual(t1.token_id, t2.token_id);
  const r1 = a.authenticate(t1.secret);
  const r2 = a.authenticate(t2.secret);
  assert.equal((r1 as { ok: true; token: any }).token.subject, "agente-a");
  assert.equal((r2 as { ok: true; token: any }).token.subject, "agente-b");
});
