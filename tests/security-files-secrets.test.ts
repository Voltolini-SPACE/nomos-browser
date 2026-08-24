/**
 * FASE 27/28/31 — download, upload e não-exfiltração de segredo.
 *
 * Critério de honestidade herdado do resto da suíte: nenhuma afirmação vale por
 * ausência de exceção, e toda varredura tem CONTROLE NEGATIVO. Um teste que só
 * diz "o canário não apareceu" passa igualzinho quando o detector está quebrado
 * ou quando o vault está vazio — por isso aqui, antes de afirmar que nada vazou,
 * o teste prova que:
 *
 *   a) o canário REALMENTE está no cookie do navegador, no header Authorization
 *      da requisição capturada e no vault (senão a varredura é sobre o vazio);
 *   b) a mesma varredura, apontada para um artefato deliberadamente NÃO redigido,
 *      ACUSA o canário (senão a varredura está sempre passando por estar cega).
 *
 * Nada aqui usa sleep como mecanismo: as esperas são `await` de operação real ou
 * predicado sobre o log de rede.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  DownloadPolicy,
  EXECUTABLE_EXTENSIONS,
  FALLBACK_FILENAME,
  MAX_FILENAME_CHARS,
  UploadPolicy,
  downloadAuditEntry,
  extensionOf,
  sanitizeFilename,
  toDownloadRecord,
  toUploadRecord,
  uploadAuditEntry,
} from "../packages/core/src/filepolicy.ts";
import { PerceptionEngine, REDACTED, type NetworkEntry } from "../packages/core/src/perception.ts";
import { FileVault, SecretLeakError, makeScrubber, type SecretScrubber } from "../packages/core/src/vault.ts";
import { ACTIONS_FILE, AuditLog } from "../packages/observability/src/audit.ts";
import { EVENTS_FILE, SessionRecorder, loadReplay } from "../packages/observability/src/replay.ts";
import type { Observation } from "../packages/core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Raízes temporárias — nada toca `profiles/` nem `sessions/` do repositório
// ─────────────────────────────────────────────────────────────────────────────

let TMP = "";
let DOWNLOAD_ROOT = "";
let UPLOAD_ROOT = "";
let SESSIONS_ROOT = "";
let PROFILES_ROOT = "";
let FORA = "";

before(() => {
  // `realpathSync`: em macOS `os.tmpdir()` é symlink para `/private/var/...` e
  // comparar caminho lexical com caminho real produziria falso negativo.
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomos-f273128-")));
  DOWNLOAD_ROOT = path.join(TMP, "downloads");
  UPLOAD_ROOT = path.join(TMP, "uploads");
  SESSIONS_ROOT = path.join(TMP, "sessions");
  PROFILES_ROOT = path.join(TMP, "profiles");
  FORA = path.join(TMP, "fora-da-raiz");
  for (const d of [DOWNLOAD_ROOT, UPLOAD_ROOT, SESSIONS_ROOT, PROFILES_ROOT, FORA]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

after(() => {
  if (TMP !== "") fs.rmSync(TMP, { recursive: true, force: true });
});

const pedido = (extra: Record<string, unknown> = {}) => ({ expected: true, ...extra });

// ═════════════════════════════════════════════════════════════════════════════
// FASE 27 — DOWNLOAD
// ═════════════════════════════════════════════════════════════════════════════

describe("FASE 27 — nome de arquivo malicioso", () => {
  it("1. path traversal no filename vira basename e fica dentro da raiz", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    const d = pol.check(pedido({ suggested_filename: "../../../../etc/passwd" }));

    assert.equal(d.allowed, true, d.reason);
    assert.equal(d.filename, "passwd");
    assert.equal(d.original_filename, "../../../../etc/passwd", "o nome CRU tem de ser registrado");
    assert.ok(d.sanitized.reasons.includes("traversal_detectado"));
    assert.ok(d.sanitized.reasons.includes("separador_removido"));
    assert.equal(d.resolved_path, path.join(DOWNLOAD_ROOT, "passwd"));
    assert.notEqual(d.resolved_path, "/etc/passwd");
    assert.ok(d.resolved_path!.startsWith(DOWNLOAD_ROOT + path.sep), "destino fora da raiz");
  });

  it("2. traversal percent-encoded também é desarmado", () => {
    const s = sanitizeFilename("..%2F..%2Fetc%2Fshadow");
    assert.equal(s.safe, "shadow");
    assert.ok(s.reasons.includes("percent_decodificado"));
    assert.ok(s.reasons.includes("separador_removido"));
  });

  it("3. NUL, newline e barra somem do nome", () => {
    const s = sanitizeFilename("rela\u0000tor\nio/\\..\\nota.pdf");
    assert.ok(!s.safe.includes("\u0000"));
    assert.ok(!s.safe.includes("\n"));
    assert.ok(!s.safe.includes("/"));
    assert.ok(!s.safe.includes("\\"));
    assert.equal(s.safe, "nota.pdf");
    assert.ok(s.reasons.includes("controle_removido"));
  });

  it("4. nome vazio e nome só com pontos caem no nome de descarte", () => {
    for (const cru of ["", "   ", ".", "..", "....", null, undefined, 42]) {
      const s = sanitizeFilename(cru);
      assert.equal(s.safe, FALLBACK_FILENAME, `nome ${JSON.stringify(cru)} não caiu no fallback`);
      assert.ok(!s.safe.startsWith("."), "nome de descarte não pode ser arquivo oculto");
    }
    assert.ok(sanitizeFilename("..").reasons.includes("apenas_pontos"));
  });

  it("5. ponto inicial não cria arquivo oculto na raiz de download", () => {
    const s = sanitizeFilename(".bashrc");
    assert.equal(s.safe, "bashrc");
    assert.ok(s.reasons.includes("ponto_inicial_removido"));
  });

  it("6. nome longuíssimo é truncado preservando a extensão", () => {
    const cru = `${"a".repeat(5000)}.pdf`;
    const s = sanitizeFilename(cru);
    assert.equal(s.truncated, true);
    assert.ok([...s.safe].length <= MAX_FILENAME_CHARS, `nome com ${[...s.safe].length} chars`);
    assert.equal(s.extension, ".pdf");
    assert.ok(s.safe.endsWith(".pdf"), "extensão perdida no truncamento");
  });

  it("7. RTL override que faz `txt.exe` parecer `exe.txt` é desmascarado", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE): o gerenciador de arquivos mostra
    // "relatorioexe.txt"; o byte real termina em .exe.
    const cru = "relatorio\u202Etxt.exe";
    const s = sanitizeFilename(cru);

    assert.equal(s.safe, "relatoriotxt.exe");
    assert.equal(s.deceptive, true, "bidi tem de marcar o nome como enganoso");
    assert.equal(s.executable, true);
    assert.equal(s.extension, ".exe");
    assert.ok(s.reasons.includes("bidi_removido"));
    assert.ok(!s.safe.includes("\u202E"));

    // E o disfarce, sozinho, já exige autorização — mesmo sem extensão executável.
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    const disfarce = pol.check(pedido({ suggested_filename: "nota\u202Efdp.txt" }));
    assert.equal(disfarce.sanitized.executable, false, "controle: a extensão real é inócua");
    assert.equal(disfarce.deceptive, true);
    assert.equal(disfarce.allowed, false, "nome enganoso não passa sem autorização");
    assert.equal(disfarce.requires_authorization, true);
  });

  it("8. dupla extensão `fatura.pdf.exe` é marcada como enganosa", () => {
    const s = sanitizeFilename("fatura.pdf.exe");
    assert.equal(s.executable, true);
    assert.equal(s.deceptive, true);
    assert.ok(s.reasons.includes("dupla_extensao"));

    // Controle negativo: extensão composta legítima NÃO é enganosa.
    const legit = sanitizeFilename("backup.tar.gz");
    assert.equal(legit.executable, false);
    assert.equal(legit.deceptive, false);
  });

  it("9. nome benigno atravessa sem alteração (controle negativo da sanitização)", () => {
    const s = sanitizeFilename("Relatorio Mensal 2026-08.pdf");
    assert.equal(s.safe, "Relatorio Mensal 2026-08.pdf");
    assert.equal(s.changed, false);
    assert.deepEqual(s.reasons, []);
    assert.equal(s.executable, false);
    assert.equal(s.deceptive, false);
  });
});

describe("FASE 27 — executável nunca é aberto", () => {
  const MISSAO = [".app", ".dmg", ".pkg", ".command", ".sh", ".scpt", ".jar", ".exe"];

  it("10. toda extensão executável da missão exige autorização", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    for (const ext of MISSAO) {
      assert.ok(EXECUTABLE_EXTENSIONS.has(ext), `${ext} fora da lista de executáveis`);
      const d = pol.check(pedido({ suggested_filename: `instalador${ext}` }));
      assert.equal(d.executable, true, `${ext} não foi classificado como executável`);
      assert.equal(d.requires_authorization, true, `${ext} sem requires_authorization`);
      assert.equal(d.allowed, false, `${ext} passou sem autorização`);
      assert.equal(d.code, "DOWNLOAD_DENIED");
      assert.equal(d.auto_open, false);
      assert.match(d.reason, /autoriza/i);
    }
  });

  it("11. mesmo AUTORIZADO o executável continua inerte (auto_open=false)", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    for (const ext of MISSAO) {
      const d = pol.check(pedido({ suggested_filename: `instalador${ext}`, authorized: true }));
      assert.equal(d.allowed, true, `${ext}: ${d.reason}`);
      assert.equal(d.requires_authorization, true, "a marca não pode sumir por ter sido autorizado");
      assert.equal(d.auto_open, false, "o runtime NUNCA executa o que baixou");
    }
  });

  it("12. arquivo comum não exige autorização (controle negativo)", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    const d = pol.check(pedido({ suggested_filename: "boleto.pdf" }));
    assert.equal(d.allowed, true, d.reason);
    assert.equal(d.executable, false);
    assert.equal(d.requires_authorization, false);
    assert.equal(d.auto_open, false);
  });
});

describe("FASE 27 — download inesperado, tamanho e concorrência", () => {
  it("13. download não pedido por ação é BLOQUEADO e REGISTRADO", async () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    const d = pol.check({ suggested_filename: "surpresa.zip", session_id: "t-f27-audit", url: "https://exemplo.invalido/x" });

    assert.equal(d.allowed, false);
    assert.equal(d.expected, false);
    assert.match(d.reason, /não solicitado/i);

    // Bloquear sem registrar seria um download invisível — o oposto do exigido.
    const log = new AuditLog({ root: SESSIONS_ROOT });
    const escrito = await log.append(downloadAuditEntry(d));
    await log.flush("t-f27-audit");
    const lido = await log.read("t-f27-audit");

    assert.equal(lido.errors.length, 0);
    assert.equal(lido.entries.length, 1);
    const e = lido.entries[0]!;
    assert.equal(e.action, "browser.download");
    assert.equal(e.result, "denied");
    assert.equal((e.detail as Record<string, unknown>).original_filename, "surpresa.zip");
    assert.equal((e.detail as Record<string, unknown>).auto_open, false);
    assert.equal(escrito.result, "denied");
  });

  it("14. tamanho anunciado acima do limite é negado", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, maxBytes: 1000 });
    assert.equal(pol.check(pedido({ suggested_filename: "grande.bin", size: 1001 })).allowed, false);
    assert.equal(pol.check(pedido({ suggested_filename: "ok.bin", size: 1000 })).allowed, true);
  });

  it("15. o limite também vale DURANTE a transferência (Content-Length mente)", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, maxBytes: 1000 });
    const d = pol.begin(pedido({ suggested_filename: "streaming.bin", size: null }));
    assert.equal(d.allowed, true, d.reason);
    assert.equal(pol.inFlight(), 1);

    assert.equal(pol.progress(d.download_id, 500).ok, true);
    const estouro = pol.progress(d.download_id, 5000);
    assert.equal(estouro.ok, false);
    assert.equal(estouro.abort, true);
    assert.equal(pol.inFlight(), 0, "transferência abortada tem de liberar o slot");
  });

  it("16. limite de downloads simultâneos", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, maxConcurrent: 2 });
    const a = pol.begin(pedido({ suggested_filename: "a.pdf" }));
    const b = pol.begin(pedido({ suggested_filename: "b.pdf" }));
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(pol.inFlight(), 2);

    const c = pol.check(pedido({ suggested_filename: "c.pdf" }));
    assert.equal(c.allowed, false);
    assert.equal(c.code, "BACKPRESSURE_REJECTED");

    pol.complete(a.download_id);
    assert.equal(pol.inFlight(), 1);
    assert.equal(pol.check(pedido({ suggested_filename: "c.pdf" })).allowed, true);
  });

  it("17. dois downloads do mesmo nome não se sobrescrevem", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, maxConcurrent: 5 });
    const a = pol.begin(pedido({ suggested_filename: "colisao.pdf" }));
    const b = pol.begin(pedido({ suggested_filename: "colisao.pdf" }));
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.notEqual(a.resolved_path, b.resolved_path);
    assert.equal(b.filename, "colisao (1).pdf");
    pol.complete(a.download_id);
    pol.complete(b.download_id);
  });
});

describe("FASE 27 — confinamento do destino", () => {
  it("18. raiz não configurada nega tudo (fail closed)", () => {
    const pol = new DownloadPolicy({});
    const d = pol.check(pedido({ suggested_filename: "x.pdf" }));
    assert.equal(d.allowed, false);
    assert.match(d.reason, /raiz de download não configurada/);
    assert.equal(d.resolved_path, null);
  });

  it("19. symlink dentro da raiz apontando para fora é recusado", () => {
    const alvo = path.join(FORA, "segredo-do-dono.txt");
    fs.writeFileSync(alvo, "conteudo fora da raiz\n");
    const link = path.join(DOWNLOAD_ROOT, "evil.pdf");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(alvo, link);

    // `overwrite:true` para o teste exercitar a checagem de confinamento em vez
    // de desviar para `evil (1).pdf`: o caminho adversarial é o do symlink.
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, overwrite: true });
    const d = pol.check(pedido({ suggested_filename: "evil.pdf" }));

    assert.equal(d.allowed, false, "symlink que escapa da raiz tem de ser negado");
    assert.match(d.reason, /symlink/i);
    assert.equal(d.path_decision?.allowed, false);
    fs.rmSync(link, { force: true });
  });

  it("20. DownloadRecord do contrato aponta para dentro da raiz", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT });
    const d = pol.check(
      pedido({ suggested_filename: "..\\..\\nota.pdf", session_id: "t-f27-rec", url: "https://exemplo.invalido/nota", mime: "application/pdf", size: 10 }),
    );
    assert.equal(d.allowed, true, d.reason);
    const rec = toDownloadRecord(d, "started");
    assert.equal(rec.filename, "nota.pdf");
    assert.equal(rec.session_id, "t-f27-rec");
    assert.equal(rec.mime, "application/pdf");
    assert.ok(rec.destination.startsWith(DOWNLOAD_ROOT + path.sep), `destino ${rec.destination} fora da raiz`);
  });

  it("21. origem com esquema proibido é negada quando checkSourceUrl está ligado", () => {
    const pol = new DownloadPolicy({ root: DOWNLOAD_ROOT, checkSourceUrl: true });
    const d = pol.check(pedido({ suggested_filename: "x.pdf", url: "file:///etc/passwd" }));
    assert.equal(d.allowed, false);
    assert.match(d.reason, /esquema bloqueado/);
    assert.equal(pol.check(pedido({ suggested_filename: "x.pdf", url: "https://exemplo.invalido/x.pdf" })).allowed, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 28 — UPLOAD
// ═════════════════════════════════════════════════════════════════════════════

describe("FASE 28 — a página nunca escolhe o arquivo", () => {
  const arquivoOk = () => {
    const p = path.join(UPLOAD_ROOT, "relatorio.pdf");
    fs.writeFileSync(p, "conteudo publico\n");
    return p;
  };

  it("22. origem `page` tem recusa própria e ruidosa", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const d = pol.check({ path: arquivoOk(), origin: "page", authorized: true });
    assert.equal(d.allowed, false);
    assert.equal(d.rule, "pagina_escolheu_arquivo");
    assert.equal(d.code, "UPLOAD_DENIED");
    assert.match(d.reason, /página não escolhe/i);
  });

  it("23. origem ausente ou de agente é negada (fail closed)", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    for (const origin of [undefined, "", "agent", "runtime", "CALLER"]) {
      const d = pol.check({ path: arquivoOk(), origin, authorized: true });
      assert.equal(d.allowed, false, `origem ${JSON.stringify(origin)} passou`);
      assert.equal(d.rule, "origem_nao_e_chamador");
    }
  });

  it("24. sem autorização explícita não há upload", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const d = pol.check({ path: arquivoOk(), origin: "caller" });
    assert.equal(d.allowed, false);
    assert.equal(d.rule, "sem_autorizacao");
  });

  it("25. caminho do chamador, autorizado e dentro da raiz é PERMITIDO (controle negativo)", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const p = arquivoOk();
    const d = pol.check({ path: p, origin: "caller", authorized: true, session_id: "t-f28", destination_site: "https://exemplo.invalido" });
    assert.equal(d.allowed, true, d.reason);
    assert.equal(d.resolved_path, fs.realpathSync(p));
    assert.equal(d.rule, null);
    assert.ok(typeof d.size === "number" && d.size > 0);

    const rec = toUploadRecord(d, { task: "enviar relatorio" });
    assert.equal(rec.filename, "relatorio.pdf");
    assert.equal(rec.session_id, "t-f28");
    assert.equal(rec.task, "enviar relatorio");
  });

  it("26. traversal, byte nulo e raiz ausente são negados", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const fora = path.join(FORA, "alheio.txt");
    fs.writeFileSync(fora, "x\n");

    const t = pol.check({ path: "../../../../etc/passwd", origin: "caller", authorized: true });
    assert.equal(t.allowed, false);
    assert.equal(t.rule, "fora_da_raiz");

    const abs = pol.check({ path: fora, origin: "caller", authorized: true });
    assert.equal(abs.allowed, false, "caminho absoluto fora da raiz passou");

    const nul = pol.check({ path: `${UPLOAD_ROOT}/rela\u0000torio.pdf`, origin: "caller", authorized: true });
    assert.equal(nul.allowed, false);

    const semRaiz = new UploadPolicy({ home: TMP }).check({ path: fora, origin: "caller", authorized: true });
    assert.equal(semRaiz.allowed, false);
    assert.equal(semRaiz.rule, "sem_raiz");
  });

  it("27. symlink que escapa da raiz é negado (resolve o caminho real)", () => {
    const alvo = path.join(FORA, "chave-do-dono.txt");
    fs.writeFileSync(alvo, "material sensivel de teste\n");
    const link = path.join(UPLOAD_ROOT, "inocente.txt");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(alvo, link);

    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const d = pol.check({ path: link, origin: "caller", authorized: true });
    assert.equal(d.allowed, false, "symlink para fora da raiz passou");
    assert.match(d.reason, /symlink/i);
    fs.rmSync(link, { force: true });
  });
});

describe("FASE 28 — bloqueio duro DENTRO da raiz permitida", () => {
  /** Cria o arquivo dentro da raiz de upload e devolve o caminho. */
  const dentro = (rel: string): string => {
    const p = path.join(UPLOAD_ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "material de teste — nao e segredo real\n");
    return p;
  };

  const CASOS: [string, string][] = [
    [".ssh/id_rsa", "segmento_proibido:.ssh"],
    [".aws/credentials", "segmento_proibido:.aws"],
    [".gnupg/secring.gpg", "segmento_proibido:.gnupg"],
    ["Library/Keychains/login.keychain-db", "segmento_proibido:Keychains"],
    [".brand-governance/registro.json", "segmento_proibido:.brand-governance"],
    ["Documents/BRANDBOOKS_OFICIAIS/LEI_DA_MARCA.md", "segmento_proibido:BRANDBOOKS_OFICIAIS"],
    ["certificados/servidor.pem", "extensao_proibida:.pem"],
    ["certificados/privada.key", "extensao_proibida:.key"],
    ["certificados/pacote.p12", "extensao_proibida:.p12"],
    ["certificados/login.keychain", "extensao_proibida:.keychain"],
    // `.env` e `id_rsa` batem no nome exato; a regra de PREFIXO existe para as
    // variantes (`.env.production`), que o nome exato não pegaria.
    ["app/.env", "arquivo_proibido:.env"],
    ["app/.env.production", "prefixo_proibido:.env"],
    ["perfil/vault.json", "arquivo_proibido:vault.json"],
    ["chaves/id_rsa", "arquivo_proibido:id_rsa"],
    ["chaves/id_ed25519.chave-antiga", "prefixo_proibido:id_ed25519"],
    ["casa/.netrc", "arquivo_proibido:.netrc"],
    ["casa/.git-credentials", "arquivo_proibido:.git-credentials"],
  ];

  it("28. cada arquivo sensível é negado, com motivo legível", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    for (const [rel, regra] of CASOS) {
      const p = dentro(rel);
      // Pré-condição: o arquivo EXISTE e está dentro da raiz. Sem isso a recusa
      // poderia ser só "arquivo não existe" e o teste seria vazio.
      assert.ok(fs.existsSync(p), `${rel} não foi criado`);
      assert.ok(fs.realpathSync(p).startsWith(fs.realpathSync(UPLOAD_ROOT) + path.sep));

      const d = pol.check({ path: p, origin: "caller", authorized: true });
      assert.equal(d.allowed, false, `${rel} passou pelo bloqueio`);
      assert.equal(d.rule, regra, `${rel}: regra esperada ${regra}, veio ${d.rule}`);
      assert.equal(d.code, "UPLOAD_DENIED");
      assert.ok(typeof d.reason === "string" && d.reason.length > 0);
    }
  });

  it("29. symlink dentro da raiz para arquivo proibido dentro da raiz também é negado", () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const alvo = dentro("perfil/vault.json");
    const link = path.join(UPLOAD_ROOT, "planilha.csv");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(alvo, link);

    const d = pol.check({ path: link, origin: "caller", authorized: true });
    assert.equal(d.allowed, false, "renomear o segredo via symlink não pode liberar o envio");
    assert.equal(d.rule, "arquivo_proibido:vault.json");
    fs.rmSync(link, { force: true });
  });

  it("30. diretório não é arquivo; e o negado vira linha de auditoria", async () => {
    const pol = new UploadPolicy({ root: UPLOAD_ROOT, home: TMP });
    const dir = path.join(UPLOAD_ROOT, "uma-pasta");
    fs.mkdirSync(dir, { recursive: true });
    const d = pol.check({ path: dir, origin: "caller", authorized: true, session_id: "t-f28-audit" });
    assert.equal(d.allowed, false);
    assert.equal(d.rule, "nao_e_arquivo");

    const log = new AuditLog({ root: SESSIONS_ROOT });
    await log.append(uploadAuditEntry(d));
    await log.flush("t-f28-audit");
    const lido = await log.read("t-f28-audit");
    assert.equal(lido.entries.length, 1);
    assert.equal(lido.entries[0]!.action, "browser.upload");
    assert.equal(lido.entries[0]!.result, "denied");
  });

  it("31. extensionOf trata `.env` e `arquivo.` como sem extensão", () => {
    assert.equal(extensionOf(".env"), "");
    assert.equal(extensionOf("arquivo."), "");
    assert.equal(extensionOf("a.TAR.GZ"), ".gz");
    assert.equal(extensionOf("semponto"), "");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 31 — HONEYPOT DE EXFILTRAÇÃO
// ═════════════════════════════════════════════════════════════════════════════

/** Canário sem espaço: sobrevive a cookie e a header sem precisar de aspas. */
const CANARY = "NOMOS-CANARIO-F31-e7c1a9d4b2f80356-nao-e-segredo-real";
/** Segundo canário COM espaço, aspas e `#`: exercita url/base64/json na detecção. */
const CANARY2 = 'CANARIO FRASE "F31" #a7f3 nao-e-segredo-real';
const REF1 = "canary:cookie";
const REF2 = "canary:frase";
const REFS = [REF1, REF2] as const;

const SID = "t-f31-honeypot";
const SID_CONTROLE = "t-f31-controle";

describe("FASE 31 — canário no cookie, no header e no vault não vaza", () => {
  let server: http.Server;
  let porta = 0;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let vault: FileVault;
  let scrubber: SecretScrubber;
  let observation: Observation;
  let entradasRede: NetworkEntry[] = [];

  const HTML = `<!doctype html>
<html><head><title>Honeypot F31</title></head>
<body>
  <h1>honeypot</h1>
  <form>
    <input type="password" id="pw" name="password" value="__CANARY__">
    <input type="hidden" id="csrf" name="csrf" value="__CANARY__">
    <div role="note" id="marca" data-api-token="__CANARY__">nota visivel sem segredo</div>
    <button type="button" id="ok">enviar</button>
  </form>
</body></html>`;

  before(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname === "/api") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `nomos_canary=${CANARY}; Path=/`,
      });
      res.end(HTML.split("__CANARY__").join(CANARY));
    });
    // Somente loopback, porta efêmera — nunca 0.0.0.0, nunca 9337.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    porta = (server.address() as AddressInfo).port;

    vault = new FileVault("_t_f31", { root: PROFILES_ROOT });
    await vault.put(REF1, CANARY);
    await vault.put(REF2, CANARY2);
    scrubber = makeScrubber([
      [REF1, CANARY],
      [REF2, CANARY2],
    ]);

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    const perception = new PerceptionEngine();
    const log = perception.networkLog(page);
    await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: "load" });

    // Requisição com o canário no header Authorization E no query param.
    await page.evaluate(
      async ([c1, c2]) => {
        await fetch(`/api?access_token=${encodeURIComponent(c2 as string)}`, {
          headers: { Authorization: `Bearer ${c1 as string}`, "X-Nota": "sem segredo aqui" },
        });
      },
      [CANARY, CANARY2],
    );
    // Condição verificável, não sleep: espera a resposta do /api entrar no log.
    await log.waitFor((e) => e.url.includes("/api") && e.phase === "response", { timeout_ms: 15_000 });

    observation = await perception.observe(page, { includeHidden: true, accessibility: true });
    const shot = await perception.capture(page, { scope: "viewport" });
    entradasRede = log.entries();

    // ── Grava as quatro superfícies de disco ──────────────────────────────
    const rec = new SessionRecorder(SID, { root: SESSIONS_ROOT });
    await rec.init();
    await rec.recordAction({
      timestamp: new Date().toISOString(),
      session: SID,
      actor: "agente-de-teste",
      action: "browser.type",
      target: "#pw",
      result: "ok",
      verified: true,
      action_id: "act_f31_1",
      // `credential_ref` é a REFERÊNCIA (tem de sobreviver); `authorization`
      // carrega o valor e tem de ser destruído pela redação.
      detail: { credential_ref: REF1, authorization: `Bearer ${CANARY}`, session_token: CANARY2 },
    });
    const dl = new DownloadPolicy({ root: DOWNLOAD_ROOT }).check({
      suggested_filename: "extrato\u202Efdp.exe",
      session_id: SID,
      url: `http://127.0.0.1:${porta}/x?access_token=${encodeURIComponent(CANARY2)}`,
    });
    await rec.recordAction(downloadAuditEntry(dl, "act_f31_2"));
    await rec.recordEvent({
      timestamp: new Date().toISOString(),
      session_id: SID,
      action_id: "act_f31_1",
      source: "runtime",
      event: "secret.used",
      payload: { credential_ref: REF1, destino: "#pw", verified: true },
    });
    await rec.recordEvent({
      timestamp: new Date().toISOString(),
      session_id: SID,
      action_id: null,
      source: "runtime",
      event: "network.response",
      payload: {
        cookie: `nomos_canary=${CANARY}`,
        "set-cookie": `nomos_canary=${CANARY}`,
        authorization: `Bearer ${CANARY}`,
        session_token: CANARY2,
      },
    });
    await rec.recordNetwork({
      url: `http://127.0.0.1:${porta}/api?access_token=${encodeURIComponent(CANARY2)}`,
      method: "GET",
      status: 200,
      request_headers: { authorization: `Bearer ${CANARY}`, cookie: `nomos_canary=${CANARY}` },
      response_headers: { "set-cookie": `nomos_canary=${CANARY}` },
    });
    await rec.saveScreenshot(shot.buffer);
    await rec.finish({ ok: true, credential_ref: REF1, token: CANARY, api_secret: CANARY2 });

    // ── Controle negativo: sessão com vazamento DE PROPÓSITO ──────────────
    const ctl = new SessionRecorder(SID_CONTROLE, { root: SESSIONS_ROOT });
    await ctl.init();
    await ctl.recordEvent({
      timestamp: new Date().toISOString(),
      session_id: SID_CONTROLE,
      action_id: null,
      source: "runtime",
      // `observacao` NÃO é nome sensível: a redação por nome de campo não pega,
      // e é exatamente esse buraco que a varredura tem de enxergar.
      event: "task.progress",
      payload: { observacao: `o campo continha ${CANARY}`, nota: CANARY2 },
    });
    await ctl.flush();
  });

  after(async () => {
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Varredura: duas detecções independentes sobre o mesmo texto. */
  const semCanario = async (rotulo: string, texto: string): Promise<void> => {
    await vault.assertNoSecretLeak(texto, REFS);
    const hit = scrubber.contains(texto);
    assert.equal(hit, null, `${rotulo}: canário vazou (ref=${hit?.ref}, codificação=${hit?.encoding})`);
  };

  it("32. pré-condição: o canário está MESMO no cookie, no header e no vault", async () => {
    // Sem esta prova, "não vazou" poderia significar "nunca esteve lá".
    assert.equal(await vault.has(REF1), true, "vault sem o canário: varredura seria vazia");
    assert.equal(await vault.has(REF2), true);
    assert.equal(await vault.resolve(REF1), CANARY);

    const cookies = await context.cookies();
    const c = cookies.find((x) => x.name === "nomos_canary");
    assert.ok(c !== undefined, "cookie do canário não foi ao navegador");
    assert.equal(c!.value, CANARY, "o cookie tem de carregar o canário CRU");

    const doDom = await page.evaluate(() => document.cookie);
    assert.ok(doDom.includes(CANARY), "a própria página enxerga o canário no cookie");

    const api = entradasRede.find((e) => e.url.includes("/api") && e.phase === "response");
    assert.ok(api !== undefined, "a requisição com Authorization não foi capturada");
    assert.equal(api!.request_headers.authorization, REDACTED, "o header foi capturado E redigido");
    assert.match(api!.url, /access_token=(%5BREDACTED%5D|\[REDACTED\])/i);
  });

  it("33. a observação sanitizada não contém o canário — e redige onde deveria", async () => {
    const pw = observation.elements.find((e) => e.attributes.id === "pw");
    const csrf = observation.elements.find((e) => e.attributes.id === "csrf");
    const marca = observation.elements.find((e) => e.attributes.id === "marca");

    // Discriminadores: os elementos EXISTEM e o valor saiu como [REDACTED].
    assert.ok(pw !== undefined, "campo de senha não observado");
    assert.equal(pw!.attributes.value, REDACTED);
    assert.equal(pw!.text, null, "valor de senha não pode virar texto observado");
    assert.ok(csrf !== undefined, "campo hidden não observado");
    assert.equal(csrf!.attributes.value, REDACTED);
    assert.ok(marca !== undefined, "div com data-api-token não observada");
    assert.equal(marca!.attributes["data-api-token"], REDACTED);

    await semCanario("observation", JSON.stringify(observation));
    await semCanario("network entries", JSON.stringify(entradasRede));
  });

  it("34. audit JSONL não contém o canário — mas contém a REFERÊNCIA", async () => {
    const arquivo = path.join(SESSIONS_ROOT, SID, ACTIONS_FILE);
    const bruto = fs.readFileSync(arquivo, "utf8");
    assert.ok(bruto.length > 0);
    assert.ok(bruto.includes(REF1), "a referência do segredo tem de sobreviver: é a prova de uso");
    assert.ok(bruto.includes("[REDACTED]"), "nada foi redigido — a trilha não é a esperada");
    await semCanario("actions.jsonl", bruto);
  });

  it("35. events JSONL não contém o canário", async () => {
    const arquivo = path.join(SESSIONS_ROOT, SID, EVENTS_FILE);
    const bruto = fs.readFileSync(arquivo, "utf8");
    assert.ok(bruto.includes("secret.used"), "evento de uso de segredo ausente");
    assert.ok(bruto.includes(REF1));
    await semCanario("events.jsonl", bruto);
  });

  it("36. o replay bundle inteiro não contém o canário", async () => {
    const bundle = await loadReplay(SID, { root: SESSIONS_ROOT });
    assert.equal(bundle.errors.length, 0, JSON.stringify(bundle.errors));
    assert.ok(bundle.actions.length >= 2, "trilha de ações vazia");
    assert.ok(bundle.events.length >= 2, "trilha de eventos vazia");
    assert.ok(bundle.network.length >= 1, "trilha de rede vazia");
    assert.ok(bundle.screenshots.length >= 1, "nenhum screenshot no bundle");
    assert.notEqual(bundle.result, null, "result.json ausente");

    await semCanario("replay bundle", JSON.stringify(bundle));

    // E o disco cru, não só o que o leitor devolve.
    for (const f of ["actions.jsonl", "events.jsonl", "network.jsonl", "result.json"]) {
      const p = path.join(SESSIONS_ROOT, SID, f);
      await semCanario(`arquivo ${f}`, fs.readFileSync(p, "utf8"));
    }
  });

  it("37. CONTROLE NEGATIVO — a mesma varredura ACUSA o vazamento plantado", async () => {
    const arquivo = path.join(SESSIONS_ROOT, SID_CONTROLE, EVENTS_FILE);
    const bruto = fs.readFileSync(arquivo, "utf8");
    assert.ok(bruto.includes(CANARY), "o vazamento plantado não chegou ao disco — controle inválido");

    await assert.rejects(
      () => vault.assertNoSecretLeak(bruto, REFS),
      (err: unknown) => err instanceof SecretLeakError && err.ref === REF1,
      "assertNoSecretLeak não detectou o canário plantado",
    );

    const bundle = await loadReplay(SID_CONTROLE, { root: SESSIONS_ROOT });
    await assert.rejects(() => vault.assertNoSecretLeak(JSON.stringify(bundle), REFS));

    const hit = scrubber.contains(bruto);
    assert.notEqual(hit, null, "o scrubber local também tem de acusar");
    assert.equal(hit!.ref, REF1);

    // E a varredura tem de morder o mesmo texto quando ele é o argumento das
    // asserções positivas — senão os testes 33–36 passariam por estarem cegos.
    await assert.rejects(() => semCanario("controle", bruto));
  });

  it("38. CONTROLE NEGATIVO — canário codificado (base64/url/json) também é acusado", async () => {
    const b64 = Buffer.from(CANARY, "utf8").toString("base64");
    const url = encodeURIComponent(CANARY2);
    const json = JSON.stringify(CANARY2).slice(1, -1);

    assert.equal(scrubber.contains(`payload=${b64}`)?.encoding, "base64");
    assert.equal(scrubber.contains(`?q=${url}`)?.encoding, "url");
    assert.equal(scrubber.contains(`{"x":"${json}"}`)?.ref, REF2);
    await assert.rejects(() => vault.assertNoSecretLeak(`payload=${b64}`, REFS));

    // Controle do controle: texto sem canário não pode acusar nada.
    assert.equal(scrubber.contains("relatorio comum sem segredo algum"), null);
    await vault.assertNoSecretLeak("relatorio comum sem segredo algum", REFS);
  });
});
