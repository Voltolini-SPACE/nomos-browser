/**
 * FASE 18/19 — testes de CapabilityEngine e Vault.
 *
 * Critério de honestidade herdado do spike: nada é afirmado por ausência de
 * exceção. A injeção de segredo é provada contra um Chromium real e uma página
 * real — e o teste verifica os DOIS lados da mesma moeda: o valor chegou ao
 * campo da página E não voltou no recibo. Provar só o segundo passaria com uma
 * implementação que não injeta nada.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";

import { OBSERVE_ONLY_CAPABILITIES, RESTRICTED_CAPABILITIES } from "../packages/core/src/contract.ts";
import {
  CapabilityEngine,
  PolicyError,
  checkPath,
  checkUrl,
  fullCapabilities,
  isInternalHost,
  normalizeCapabilities,
  policyFromName,
  toActionError,
} from "../packages/core/src/policy.ts";
import {
  DEFAULT_VAULT_ROOT,
  FileVault,
  SecretLeakError,
  VaultError,
  findSecretIn,
  makeScrubber,
  secretUsageToAuditEntry,
  secretUsageToEvent,
  type SecretUsage,
} from "../packages/core/src/vault.ts";

const PROFILE = "_t_pv_main";
const PROFILE_PERM = "_t_pv_perm";
/** Canário: string improvável de existir por acaso, com espaço e `#` para
 *  exercitar a detecção url-encoded além da crua. Não é credencial real. */
const SECRET = "canario NOMOS#7 nao-e-senha-real";

// ─────────────────────────────────────────────────────────────────────────────
// 1–3. CapabilityEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("FASE 19 — CapabilityEngine", () => {
  it("1. ferramenta desconhecida é NEGADA (fail closed)", () => {
    const engine = new CapabilityEngine();
    const d = engine.check("browser.detonar", fullCapabilities());
    assert.equal(d.allowed, false, "browser.detonar não pode ser permitida");
    assert.equal(d.required, null);
    assert.equal(d.class, null);
    assert.equal(d.code, "CAPABILITY_DENIED");
    assert.match(d.reason, /desconhecida/);

    // Negada mesmo com TODAS as capabilities: a negativa vem de o contrato não
    // conhecer a ferramenta, não de faltar permissão.
    const err = toActionError(d);
    assert.equal(err.code, "CAPABILITY_DENIED");
  });

  it("1b. chave herdada de Object.prototype não vira ferramenta válida", () => {
    const engine = new CapabilityEngine();
    for (const bogus of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const d = engine.check(bogus, fullCapabilities());
      assert.equal(d.allowed, false, `${bogus} não pode ser permitida`);
      assert.equal(d.required, null, `${bogus} não pode ter capability herdada`);
    }
    assert.equal(engine.check("", fullCapabilities()).code, "INVALID_REQUEST");
    assert.equal(engine.check(null, fullCapabilities()).code, "INVALID_REQUEST");
  });

  it("2. política restricted nega browser.upload e permite browser.observe", () => {
    const engine = new CapabilityEngine(); // default = restricted
    assert.deepEqual({ ...engine.defaults }, { ...RESTRICTED_CAPABILITIES });

    const up = engine.check("browser.upload");
    assert.equal(up.allowed, false);
    assert.equal(up.required, "upload");
    assert.equal(up.class, "COMMIT");
    assert.equal(up.code, "CAPABILITY_DENIED");
    assert.equal(up.source, "default");

    const obs = engine.check("browser.observe");
    assert.equal(obs.allowed, true);
    assert.equal(obs.required, "read");
    assert.equal(obs.class, "OBSERVE");
    assert.equal(obs.code, null);

    // Toda a família COMMIT nasce negada sob restricted.
    for (const t of ["browser.upload", "browser.download"]) {
      assert.equal(engine.check(t).allowed, false, `${t} devia ser negada sob restricted`);
    }
  });

  it("2b. observe nega click/type; full só por chamada explícita", () => {
    const engine = new CapabilityEngine({ defaultPolicy: "observe" });
    assert.deepEqual({ ...engine.defaults }, { ...OBSERVE_ONLY_CAPABILITIES });
    assert.equal(engine.check("browser.click").allowed, false);
    assert.equal(engine.check("browser.type").allowed, false);
    assert.equal(engine.check("browser.observe").allowed, true);

    // "full" vindo de string (rede) tem de ser recusado.
    assert.throws(() => policyFromName("full"), (e: unknown) => e instanceof PolicyError && (e as PolicyError).code === "POLICY_BLOCKED");
    assert.throws(() => policyFromName("root"), (e: unknown) => e instanceof PolicyError);
    // ...mas a chamada explícita no código funciona.
    assert.equal(new CapabilityEngine({ defaultPolicy: fullCapabilities() }).check("browser.upload").allowed, true);
  });

  it("2c. capabilities de JSON só concedem com `true` em propriedade própria", () => {
    const hostil = JSON.parse('{"upload":"true","download":1,"read":true}') as Record<string, unknown>;
    const caps = normalizeCapabilities(hostil);
    assert.equal(caps.upload, false, '"true" (string) não concede');
    assert.equal(caps.download, false, "1 não concede");
    assert.equal(caps.read, true);
    assert.equal(normalizeCapabilities(null).click, false);
    assert.equal(normalizeCapabilities("full" as unknown).navigate, false);
  });

  it("3. agente A com capability custom não afeta agente B", () => {
    const engine = new CapabilityEngine();
    engine.registerAgent("A", { ...RESTRICTED_CAPABILITIES, upload: true });

    const a = engine.check("browser.upload", null, "A");
    assert.equal(a.allowed, true, "agente A tem upload concedido");
    assert.equal(a.source, "agent");

    const b = engine.check("browser.upload", null, "B");
    assert.equal(b.allowed, false, "agente B NÃO herda o upload de A");
    assert.equal(b.source, "default", "agente não registrado cai no default, não em A");

    const anon = engine.check("browser.upload");
    assert.equal(anon.allowed, false);

    // Registrar B com observe não retroage sobre A.
    engine.registerAgent("B", "observe");
    assert.equal(engine.check("browser.upload", null, "A").allowed, true);
    assert.equal(engine.check("browser.click", null, "B").allowed, false);
    assert.equal(engine.check("browser.click", null, "A").allowed, true);

    // Revogar A não toca B.
    engine.revokeAgent("A");
    assert.equal(engine.check("browser.upload", null, "A").allowed, false);
    assert.equal(engine.hasAgent("B"), true);

    // O objeto passado no registro não é aliasado: mutar a fonte não escala.
    const fonte = { ...RESTRICTED_CAPABILITIES, upload: true };
    engine.registerAgent("C", fonte);
    fonte.delete = true;
    assert.equal(engine.check("browser.upload", null, "C").allowed, true);
    assert.equal(engine.capabilitiesFor("C").delete, false, "mutação externa não vaza para o registro");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Guarda de URL — anti-SSRF
// ─────────────────────────────────────────────────────────────────────────────

describe("FASE 40 — guarda de URL", () => {
  it("4. file:// e metadata link-local são bloqueados", () => {
    const f = checkUrl("file:///etc/passwd");
    assert.equal(f.allowed, false, "file:///etc/passwd tem de ser bloqueado");
    assert.equal(f.code, "POLICY_BLOCKED");
    assert.equal(f.scheme, "file:");

    const meta = checkUrl("http://169.254.169.254/");
    assert.equal(meta.allowed, false, "169.254.169.254 sem allow_internal tem de ser bloqueado");
    assert.equal(meta.code, "POLICY_BLOCKED");
    assert.equal(meta.internal, true);
    assert.match(meta.reason, /allow_internal/);

    // ...e continua bloqueado mesmo com capability de navegação total.
    const engine = new CapabilityEngine({ defaultPolicy: fullCapabilities() });
    assert.equal(engine.check("browser.goto").allowed, true, "capability passa");
    assert.equal(engine.checkUrl("http://169.254.169.254/").allowed, false, "URL ainda assim é barrada");
  });

  it("4b. esquemas perigosos e formas ofuscadas de loopback", () => {
    for (const u of [
      "about:config",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,<b>x",
      "view-source:http://example.com",
      "blob:http://example.com/abc",
      "ftp://example.com/f",
    ]) {
      const d = checkUrl(u);
      assert.equal(d.allowed, false, `${u} tem de ser bloqueado`);
      assert.equal(d.code, "POLICY_BLOCKED");
    }
    assert.equal(checkUrl("about:blank").allowed, true, "about:blank é a exceção legítima");

    // Formas que a URL WHATWG normaliza — a checagem tem de ser numérica, não textual.
    for (const u of [
      "http://2130706433/", // 127.0.0.1 decimal
      "http://0x7f.0.0.1/", // hexadecimal
      "http://127.1/", // forma curta
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped, exibido em hex pelo parser
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://10.1.2.3/",
      "http://172.20.0.1/",
      "http://192.168.0.1/",
      "http://0.0.0.0/",
      "http://LocalHost:3000/",
      "http://impressora.local/",
      "http://localhost./",
    ]) {
      assert.equal(checkUrl(u).allowed, false, `${u} devia ser reconhecido como interno`);
    }

    // Controle do instrumento: o guarda tem de ser capaz de PERMITIR.
    // Sem isto, um guarda que negasse tudo passaria em todas as asserções acima.
    assert.equal(checkUrl("https://example.com/a?b=1").allowed, true);
    assert.equal(isInternalHost("example.com"), false);
    assert.equal(checkUrl("http://172.32.0.1/").allowed, true, "172.32 está FORA da faixa privada 172.16/12");

    // Credencial embutida vaza em log/Referer.
    assert.equal(checkUrl("http://user:pw@example.com/").allowed, false);
    assert.equal(checkUrl("naoeurl").code, "INVALID_REQUEST");
    assert.equal(checkUrl(undefined).code, "INVALID_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guarda de path — upload/download
// ─────────────────────────────────────────────────────────────────────────────

describe("FASE 21/22 — guarda de path", () => {
  let root = "";
  let fora = "";

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomos-pathguard-")));
    fora = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomos-pathfora-")));
    fs.writeFileSync(path.join(root, "ok.txt"), "conteudo");
    fs.writeFileSync(path.join(fora, "segredo.txt"), "conteudo");
    fs.symlinkSync(path.join(fora, "segredo.txt"), path.join(root, "atalho.txt"));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fora, { recursive: true, force: true });
  });

  it("rejeita traversal, symlink de fuga e raiz não configurada", () => {
    const engine = new CapabilityEngine({ uploadRoot: root, downloadRoot: root });

    assert.equal(engine.checkPath("ok.txt", "upload").allowed, true, "arquivo dentro da raiz passa");
    assert.equal(engine.checkPath(path.join(root, "ok.txt"), "upload").allowed, true, "caminho absoluto dentro da raiz passa");

    const trav = engine.checkPath("../../../../etc/passwd", "upload");
    assert.equal(trav.allowed, false);
    assert.equal(trav.code, "UPLOAD_DENIED");
    assert.match(trav.reason, /traversal/);

    assert.equal(engine.checkPath("/etc/passwd", "upload").allowed, false, "absoluto fora da raiz é negado");
    assert.equal(engine.checkPath(path.join(fora, "segredo.txt"), "download").code, "DOWNLOAD_DENIED");

    const link = engine.checkPath("atalho.txt", "upload");
    assert.equal(link.allowed, false, "symlink que escapa da raiz é negado");
    assert.match(link.reason, /symlink/);

    assert.equal(engine.checkPath("nao-existe.txt", "upload").allowed, false, "upload exige arquivo existente");
    assert.equal(engine.checkPath("novo.bin", "download").allowed, true, "download aceita destino inexistente");
    assert.equal(engine.checkPath("a\0b", "upload").allowed, false, "byte nulo é negado");

    // Sem raiz configurada: nega em vez de cair no disco inteiro.
    const semRaiz = new CapabilityEngine();
    const d = semRaiz.checkPath(path.join(root, "ok.txt"), "upload");
    assert.equal(d.allowed, false);
    assert.match(d.reason, /não configurada/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–7. Vault + injeção real
// ─────────────────────────────────────────────────────────────────────────────

describe("FASE 18 — Vault", () => {
  let server: http.Server;
  let baseUrl = "";
  let browser: Browser | null = null;
  const usos: SecretUsage[] = [];
  const vault = new FileVault(PROFILE, { onSecretUsed: (u) => void usos.push(u) });

  before(async () => {
    await vault.put("banco:senha", SECRET);
    const html = `<!doctype html><meta charset="utf-8"><title>fixture</title>
      <form><input id="user" name="user"><input id="pass" type="password" name="pass"></form>`;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("fixture sem endereço");
    baseUrl = `http://127.0.0.1:${addr.port}/`;
  });

  after(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(path.join(DEFAULT_VAULT_ROOT, PROFILE), { recursive: true, force: true });
    fs.rmSync(path.join(DEFAULT_VAULT_ROOT, PROFILE_PERM), { recursive: true, force: true });
  });

  it("5. http://127.0.0.1:PORTA/ passa COM allow_internal (e falha sem ele)", () => {
    const engine = new CapabilityEngine();

    const sem = engine.checkUrl(baseUrl);
    assert.equal(sem.allowed, false, "loopback sem allow_internal é bloqueado");
    assert.equal(sem.internal, true);

    const com = engine.checkUrl(baseUrl, { allow_internal: true });
    assert.equal(com.allowed, true, `${baseUrl} devia passar com allow_internal`);
    assert.equal(com.internal, true);
    assert.equal(com.host, "127.0.0.1");
    assert.match(com.reason, /allow_internal explícito/);

    // allow_internal libera loopback, NÃO libera esquema proibido.
    assert.equal(engine.checkUrl("file:///etc/passwd", { allow_internal: true }).allowed, false);
  });

  it("vault grava em profiles/<perfil>/vault.json com modo 0600", async () => {
    assert.equal(vault.path, path.join(DEFAULT_VAULT_ROOT, PROFILE, "vault.json"));
    const mode = fs.statSync(vault.path).mode & 0o777;
    assert.equal(mode.toString(8), "600", "vault.json tem de estar 0600");

    assert.equal(await vault.has("banco:senha"), true);
    assert.equal(await vault.has("nao-existe"), false);
    assert.deepEqual(await vault.list(), ["banco:senha"], "list devolve só referências");
    assert.equal(await vault.resolve("banco:senha"), SECRET, "resolve é a porta interna do valor");

    // Ausente lança em vez de devolver "" — sem fallback silencioso.
    await assert.rejects(() => vault.resolve("nao-existe"), (e: unknown) => e instanceof VaultError && (e as VaultError).code === "SECRET_NOT_FOUND");
    await assert.rejects(() => vault.resolve("../../etc/passwd"), (e: unknown) => (e as VaultError).code === "INVALID_REF");
    await assert.rejects(() => vault.resolve("__proto__"), (e: unknown) => (e as VaultError).code === "INVALID_REF");
    assert.throws(() => new FileVault("../fuga"), (e: unknown) => (e as VaultError).code === "INVALID_PROFILE");
  });

  it("vault com permissão larga é RECUSADO, não corrigido em silêncio", async () => {
    const v = new FileVault(PROFILE_PERM);
    await v.put("x", "valor-qualquer");
    fs.chmodSync(v.path, 0o644);
    await assert.rejects(
      () => v.resolve("x"),
      (e: unknown) => e instanceof VaultError && (e as VaultError).code === "VAULT_INSECURE_PERMISSIONS",
    );
    fs.chmodSync(v.path, 0o600);
    assert.equal(await v.resolve("x"), "valor-qualquer", "volta a funcionar com 0600");
  });

  it("6. injeta o segredo na página REAL e o retorno NÃO contém o valor", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const recibo = await vault.injectSecret(page, "#pass", "banco:senha", { session: "sess_teste" });

    // Lado A — a injeção ACONTECEU de verdade. Sem isto, uma implementação que
    // não injeta nada passaria trivialmente na verificação de vazamento.
    const naPagina = await page.locator("#pass").inputValue();
    assert.equal(naPagina, SECRET, "o campo da página tem de conter o segredo");
    assert.equal(recibo.verified, true, "verified só pode ser true se o campo bate");
    assert.equal(recibo.injected, true);
    assert.equal(recibo.ref, "banco:senha");
    assert.equal(recibo.destino, "selector:#pass");

    // Lado B — o valor NÃO voltou. Serializar o recibo inteiro pega qualquer
    // campo novo que alguém venha a acrescentar sem pensar.
    const serial = JSON.stringify(recibo);
    assert.equal(findSecretIn(serial, SECRET), null, `recibo não pode conter o segredo: ${serial}`);
    assert.deepEqual(Object.keys(recibo).sort(), ["at", "destino", "injected", "ref", "verified"]);
    assert.equal(
      Object.values(recibo).some((v) => v === SECRET.length),
      false,
      "nem o comprimento do segredo pode vazar",
    );

    // Auditoria: registrou a REFERÊNCIA, jamais o valor.
    assert.equal(usos.length, 1);
    assert.equal(usos[0].ref, "banco:senha");
    assert.equal(usos[0].session, "sess_teste");
    assert.equal(usos[0].destino, "selector:#pass");
    assert.equal(findSecretIn(JSON.stringify(usos[0]), SECRET), null, "hook de auditoria não pode ver o valor");

    const entry = secretUsageToAuditEntry(usos[0], "act_1");
    assert.equal(entry.action, "secret.used");
    assert.equal(entry.detail?.credential_ref, "banco:senha");
    assert.equal(findSecretIn(JSON.stringify(entry), SECRET), null);

    const ev = secretUsageToEvent(usos[0], "agente-x");
    assert.equal(ev.event, "secret.used");
    assert.equal(findSecretIn(JSON.stringify(ev), SECRET), null);

    // Modo "type" (tecla a tecla) no outro campo, com Locator em vez de seletor.
    const r2 = await vault.injectSecret(page, page.locator("#user"), "banco:senha", { mode: "type", destino: "campo-user" });
    assert.equal(await page.locator("#user").inputValue(), SECRET);
    assert.equal(r2.verified, true);
    assert.equal(findSecretIn(JSON.stringify(r2), SECRET), null);

    // Falha de injeção aparece como erro (nada de fallback silencioso) e a
    // mensagem passa pela redação antes de ser propagada.
    await assert.rejects(
      () => vault.injectSecret(page, "#nao-existe", "banco:senha", { timeout_ms: 800 }),
      (e: unknown) => {
        const err = e as VaultError;
        assert.equal(err.code, "INJECTION_FAILED");
        assert.equal(findSecretIn(err.message, SECRET), null, "mensagem de erro não pode conter o segredo");
        return true;
      },
    );
    await assert.rejects(() => vault.injectSecret(page, "#pass", "ref-inexistente"), (e: unknown) => (e as VaultError).code === "SECRET_NOT_FOUND");
  });

  it("7. assertNoSecretLeak lança quando o segredo está no texto", async () => {
    const refs = ["banco:senha"];

    // Texto limpo: passa.
    await vault.assertNoSecretLeak("POST /login 200 credential_ref=banco:senha", refs);

    // Valor cru no texto: lança.
    await assert.rejects(
      () => vault.assertNoSecretLeak(`log: pass=${SECRET} enviado`, refs),
      (e: unknown) => e instanceof SecretLeakError && (e as SecretLeakError).ref === "banco:senha",
    );

    // A própria exceção não pode carregar o valor.
    try {
      await vault.assertNoSecretLeak(SECRET, refs);
      assert.fail("devia ter lançado");
    } catch (e) {
      assert.equal(findSecretIn((e as Error).message, SECRET), null, "SecretLeakError não pode citar o valor");
    }

    // Formas codificadas: url-encoded numa query string e base64 num header.
    await assert.rejects(
      () => vault.assertNoSecretLeak(`GET /?p=${encodeURIComponent(SECRET)}`, refs),
      (e: unknown) => e instanceof SecretLeakError && (e as SecretLeakError).encoding === "url",
    );
    await assert.rejects(
      () => vault.assertNoSecretLeak(`Authorization: Basic ${Buffer.from(SECRET).toString("base64")}`, refs),
      (e: unknown) => e instanceof SecretLeakError && (e as SecretLeakError).encoding === "base64",
    );

    // Ref não pedida não é escaneada — o chamador declara o escopo.
    await vault.assertNoSecretLeak(SECRET, []);

    // Scrubber para o caminho quente de log: redige em vez de lançar.
    const scrub = await vault.scrubber(refs);
    const redigido = scrub.redact(`pass=${SECRET} e de novo ${encodeURIComponent(SECRET)}`);
    assert.equal(findSecretIn(redigido, SECRET), null, "redact tem de remover todas as codificações");
    assert.match(redigido, /«banco:senha»/);

    // Controle do instrumento: o detector tem de ser capaz de dizer "não achei".
    assert.equal(findSecretIn("nada aqui", SECRET), null);
    assert.equal(makeScrubber([["r", "abc"]]).contains("xxabcxx")?.ref, "r");
    assert.equal(makeScrubber([["r", "abc"]]).contains("xxx"), null);
  });
});
