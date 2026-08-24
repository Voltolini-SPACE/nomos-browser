/**
 * FASE 27/28 — POLÍTICA DE ARQUIVO (download e upload)
 *
 * Este módulo NÃO reescreve `policy.ts`: importa `checkPath`/`checkUrl` e
 * constrói por cima. O que `policy.ts` já garante (confinamento em raiz,
 * traversal lexical, byte nulo, fuga por symlink) continua sendo decidido lá;
 * aqui entram as regras que só existem quando o arquivo tem NOME e ORIGEM.
 *
 * Três posturas governam o módulo:
 *
 *  1. O NOME VEM DA PÁGINA — logo é dado hostil. O `filename` do
 *     `Content-Disposition` é escolhido por quem serve o arquivo, não pelo dono
 *     da máquina. Ele nunca vira caminho: é sanitizado para um nome de segmento
 *     único, e o nome CRU é preservado em `original_filename` para auditoria.
 *     Descartar o original esconderia a tentativa; usá-lo cru executaria a
 *     tentativa. Guarda-se um, usa-se o outro.
 *
 *  2. O RUNTIME NUNCA EXECUTA O QUE BAIXOU. `auto_open` é literalmente do tipo
 *     `false` — não existe valor de opção, variável de ambiente ou campo de
 *     requisição capaz de torná-lo verdadeiro. Extensão executável exige
 *     autorização explícita só para CHEGAR ao disco, e mesmo autorizada continua
 *     inerte.
 *
 *  3. A PÁGINA NUNCA ESCOLHE O ARQUIVO DE UPLOAD. `origin` precisa ser
 *     `"caller"`; `"page"` tem recusa própria e ruidosa. Ausência de `origin`
 *     também recusa — fail closed, não "assume que veio do chamador".
 *
 * Fail closed em toda dúvida: raiz não configurada nega; nome que não sobrevive
 * à sanitização vira o nome de descarte, não vira caminho relativo; extensão
 * desconhecida em posição de executável é tratada como executável quando o
 * disfarce (bidi, dupla extensão) foi detectado.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newId,
  nowIso,
  type ActionErrorCode,
  type AuditEntry,
  type DownloadRecord,
  type UploadRecord,
} from "./contract.ts";
import { checkPath, checkUrl, type PathDecision, type UrlDecision, type UrlGuardOptions } from "./policy.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Sanitização de nome de arquivo (FASE 27)
// ─────────────────────────────────────────────────────────────────────────────

/** Nome usado quando nada do original sobrevive. Nunca vazio, nunca oculto. */
export const FALLBACK_FILENAME = "download.bin" as const;

/** Teto de caracteres do nome final. Abaixo do limite usual de 255 bytes por
 *  segmento, com folga para o sufixo de desambiguação ` (12)`. */
export const MAX_FILENAME_CHARS = 200;

/** Controle C0/C1 e DEL: cobre NUL, `\n`, `\r`, `\t` e amigos. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Marcas bidirecionais. São INVISÍVEIS e reordenam o que o humano lê:
 * `fatura<U+202E>gnp.exe` aparece como `faturaexe.png` em quase todo gerenciador
 * de arquivos. Remover é obrigatório; sinalizar `deceptive` é o que permite ao
 * runtime tratar o download como hostil mesmo que a extensão real seja inócua.
 */
const BIDI_CHARS = /[\u200B-\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Allowlist de caracteres. Letra/dígito Unicode passam; pontuação exótica não. */
const DISALLOWED_CHARS = /[^\p{L}\p{N}._\-() ]/gu;

/** Nomes de dispositivo do Windows. Criar `CON.txt` lá é escrever no console. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Extensões que o sistema operacional pode EXECUTAR. As oito primeiras são as
 * exigidas pela missão; o resto é endurecimento — a lista é allowlist invertida,
 * então errar para mais só produz um pedido de autorização a mais.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    ".app", ".dmg", ".pkg", ".command", ".sh", ".scpt", ".jar", ".exe",
    ".bat", ".cmd", ".com", ".msi", ".ps1", ".vbs", ".vbe", ".scr", ".hta",
    ".applescript", ".workflow", ".action", ".terminal", ".mobileconfig",
    ".dylib", ".so", ".bash", ".zsh", ".ksh", ".csh", ".py", ".pl", ".rb", ".php",
  ]),
) as ReadonlySet<string>;

/** Extensões "inocentes" usadas como isca em nome de dupla extensão. */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    ".pdf", ".txt", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".zip", ".json", ".md", ".rtf",
  ]),
) as ReadonlySet<string>;

/**
 * Extensão final, em minúsculas, com o ponto. `.env` NÃO tem extensão (é nome
 * oculto inteiro); `arquivo.` também não (ponto final é lixo, não extensão).
 */
export function extensionOf(name: string): string {
  const body = name.startsWith(".") ? name.slice(1) : name;
  const i = body.lastIndexOf(".");
  if (i <= 0 || i === body.length - 1) return "";
  return body.slice(i).toLowerCase();
}

export interface SanitizedFilename {
  /** Nome de SEGMENTO ÚNICO, seguro para virar caminho. */
  safe: string;
  /** Nome cru recebido, preservado para auditoria. Nunca usado como caminho. */
  original: string;
  changed: boolean;
  /** Por que mudou. Vazio ⇔ o original já era seguro. */
  reasons: string[];
  extension: string;
  executable: boolean;
  /** Nome desenhado para enganar o leitor humano (bidi ou dupla extensão). */
  deceptive: boolean;
  truncated: boolean;
}

export interface SanitizeOptions {
  executableExtensions?: ReadonlySet<string>;
  maxChars?: number;
  fallback?: string;
}

/**
 * Converte um nome vindo da rede num nome de arquivo seguro.
 *
 * A ordem importa: controle e bidi saem ANTES do corte por separador, senão
 * `..<NUL>/etc` esconde o traversal atrás de um byte nulo.
 */
export function sanitizeFilename(raw: unknown, opts: SanitizeOptions = {}): SanitizedFilename {
  const execSet = opts.executableExtensions ?? EXECUTABLE_EXTENSIONS;
  const maxChars = opts.maxChars ?? MAX_FILENAME_CHARS;
  const fallback = opts.fallback ?? FALLBACK_FILENAME;
  const reasons: string[] = [];
  let deceptive = false;
  let truncated = false;

  const original = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw);
  if (typeof raw !== "string") reasons.push("nome_nao_e_string");

  // Entrada que não é string é malformada, não é "quase um nome": vai direto
  // para o de descarte. Coagir com String() produziria `[object Object]` ou
  // `42` — nomes que ninguém pediu, saídos de um campo que veio errado.
  let s = typeof raw === "string" ? raw : "";

  const semControle = s.replace(CONTROL_CHARS, "");
  if (semControle !== s) {
    reasons.push("controle_removido");
    s = semControle;
  }

  const semBidi = s.replace(BIDI_CHARS, "");
  if (semBidi !== s) {
    reasons.push("bidi_removido");
    deceptive = true;
    s = semBidi;
  }

  // Percent-encoding é a forma mais comum de esconder `/` e `..` num
  // Content-Disposition. Decodifica ANTES de cortar por separador.
  if (/%[0-9a-fA-F]{2}/.test(s)) {
    let decoded = s;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      // Percent-encoding inválido: segue com o texto cru em vez de estourar.
      decoded = s;
    }
    if (decoded !== s) {
      reasons.push("percent_decodificado");
      s = decoded.replace(CONTROL_CHARS, "").replace(BIDI_CHARS, "");
    }
  }

  if (/[/\\]/.test(s)) reasons.push("separador_removido");
  if (/(^|[/\\])\.\.([/\\]|$)/.test(s)) reasons.push("traversal_detectado");

  // Último segmento não-vazio: `../../etc/passwd` → `passwd`; `a/b/` → `b`.
  const segments = s.split(/[/\\]+/).filter((p) => p !== "");
  s = segments.length === 0 ? "" : segments[segments.length - 1]!;

  s = s.trim();

  if (s === "") reasons.push("nome_vazio");
  if (s !== "" && /^\.+$/.test(s)) {
    reasons.push("apenas_pontos");
    s = "";
  }

  // Ponto inicial cria arquivo oculto na raiz de download — o dono não veria o
  // que chegou. `.` some; o resto do nome fica.
  const semPontoInicial = s.replace(/^\.+/, "");
  if (semPontoInicial !== s) {
    reasons.push("ponto_inicial_removido");
    s = semPontoInicial;
  }

  const filtrado = s.replace(DISALLOWED_CHARS, "_");
  if (filtrado !== s) {
    reasons.push("caractere_substituido");
    s = filtrado;
  }

  s = s.replace(/_{2,}/g, "_").replace(/ {2,}/g, " ");
  // Espaço e ponto FINAIS são silenciosamente descartados pelo Windows, o que
  // faz `virus.exe.` virar `virus.exe` depois da checagem. Tira aqui.
  s = s.replace(/[. ]+$/, "").trim();

  if (s === "") {
    if (!reasons.includes("nome_vazio")) reasons.push("nome_vazio_apos_sanitizacao");
    s = fallback;
  }

  if (WINDOWS_RESERVED.test(s)) {
    reasons.push("nome_reservado");
    s = `_${s}`;
  }

  if ([...s].length > maxChars) {
    const ext = extensionOf(s);
    const chars = [...s];
    const keep = Math.max(1, maxChars - ext.length);
    s = `${chars.slice(0, keep).join("")}${ext}`;
    reasons.push("nome_truncado");
    truncated = true;
  }

  const extension = extensionOf(s);
  const executable = extension !== "" && execSet.has(extension);

  // Dupla extensão só é enganosa quando a isca é de documento e o fim é
  // executável: `fatura.pdf.exe`. `arquivo.tar.gz` não dispara.
  if (executable) {
    const body = s.startsWith(".") ? s.slice(1) : s;
    const semUltima = body.slice(0, body.length - extension.length);
    const anterior = extensionOf(semUltima);
    if (anterior !== "" && DOCUMENT_EXTENSIONS.has(anterior)) {
      deceptive = true;
      reasons.push("dupla_extensao");
    }
  }

  return {
    safe: s,
    original,
    changed: s !== original,
    reasons,
    extension,
    executable,
    deceptive,
    truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DownloadPolicy (FASE 27)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 3;

export interface DownloadPolicyOptions {
  /** Raiz de download. Ausente ⇒ todo download é negado (fail closed). */
  root?: string;
  maxBytes?: number;
  maxConcurrent?: number;
  executableExtensions?: Iterable<string>;
  /**
   * Verifica o esquema da URL de origem com `checkUrl`. Default `false`:
   * o Chromium emite `blob:` para muitos downloads legítimos, e `checkUrl` só
   * admite http/https — ligar por padrão negaria download real. Fica explícito
   * para quem sabe que a origem é sempre http(s).
   */
  checkSourceUrl?: boolean;
  urlGuard?: UrlGuardOptions;
  /** Sobrescreve destino existente em vez de desambiguar com ` (n)`. */
  overwrite?: boolean;
}

export interface DownloadRequest {
  session_id?: string | null;
  /** `filename` do Content-Disposition — escolhido pela PÁGINA. Não confiável. */
  suggested_filename?: unknown;
  /** URL de origem, para registro (e verificação quando `checkSourceUrl`). */
  url?: unknown;
  mime?: string | null;
  /** Tamanho anunciado (Content-Length). `null` quando desconhecido. */
  size?: number | null;
  /** true quando ESTE download foi pedido por uma ação do chamador. */
  expected?: boolean;
  /** Autorização explícita do dono para conteúdo executável. */
  authorized?: boolean;
  download_id?: string;
}

export interface DownloadDecision {
  allowed: boolean;
  reason: string;
  code: ActionErrorCode | null;
  download_id: string;
  session_id: string | null;
  /** Nome sanitizado — o ÚNICO que toca o disco. */
  filename: string;
  /** Nome cru recebido da página. Registrado, jamais usado como caminho. */
  original_filename: string;
  sanitized: SanitizedFilename;
  /** Conteúdo executável: precisa de ato explícito do dono. */
  requires_authorization: boolean;
  executable: boolean;
  deceptive: boolean;
  expected: boolean;
  authorized: boolean;
  resolved_path: string | null;
  root: string | null;
  size: number | null;
  max_bytes: number;
  /** Downloads em voo no instante da decisão. */
  concurrent: number;
  max_concurrent: number;
  source: string | null;
  mime: string | null;
  /** Invariante do runtime: nada baixado é aberto. O tipo proíbe o contrário. */
  auto_open: false;
  path_decision: PathDecision | null;
  url_decision: UrlDecision | null;
  decided_at: string;
}

interface InFlight {
  download_id: string;
  filename: string;
  destination: string;
  bytes: number;
  started_at: string;
  session_id: string | null;
}

export interface ProgressVerdict {
  ok: boolean;
  reason: string;
  bytes: number;
  max_bytes: number;
  /** true quando a política manda abortar a transferência em curso. */
  abort: boolean;
}

/**
 * Guarda de download. Estado mínimo e explícito: só o conjunto de transferências
 * em voo, que é o que a regra de concorrência e a de tamanho precisam saber.
 */
export class DownloadPolicy {
  readonly root: string | null;
  readonly maxBytes: number;
  readonly maxConcurrent: number;
  readonly executableExtensions: ReadonlySet<string>;
  readonly checkSourceUrl: boolean;
  readonly overwrite: boolean;
  readonly #urlGuard: UrlGuardOptions;
  readonly #inflight = new Map<string, InFlight>();
  /** Destinos já prometidos a um download em voo — evita dois arquivos no mesmo nome. */
  readonly #reserved = new Set<string>();

  constructor(opts: DownloadPolicyOptions = {}) {
    this.root = typeof opts.root === "string" && opts.root.trim() !== "" ? path.resolve(opts.root) : null;
    this.maxBytes = Number.isFinite(opts.maxBytes) && (opts.maxBytes as number) > 0
      ? Math.floor(opts.maxBytes as number)
      : DEFAULT_MAX_DOWNLOAD_BYTES;
    this.maxConcurrent = Number.isInteger(opts.maxConcurrent) && (opts.maxConcurrent as number) > 0
      ? (opts.maxConcurrent as number)
      : DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    this.executableExtensions = opts.executableExtensions === undefined
      ? EXECUTABLE_EXTENSIONS
      : new Set([...opts.executableExtensions].map((e) => e.toLowerCase()));
    this.checkSourceUrl = opts.checkSourceUrl === true;
    this.overwrite = opts.overwrite === true;
    this.#urlGuard = opts.urlGuard ?? {};
  }

  inFlight(): number {
    return this.#inflight.size;
  }

  active(): readonly string[] {
    return [...this.#inflight.keys()];
  }

  /** Nome livre dentro da raiz: `x.pdf` → `x (1).pdf` quando já existe. */
  #freeName(root: string, filename: string): string {
    if (this.overwrite) return filename;
    const ext = extensionOf(filename);
    const base = ext === "" ? filename : filename.slice(0, filename.length - ext.length);
    for (let i = 0; i < 1000; i += 1) {
      const cand = i === 0 ? filename : `${base} (${i})${ext}`;
      const full = path.join(root, cand);
      if (!this.#reserved.has(full) && !fs.existsSync(full)) return cand;
    }
    return `${base} (${Date.now().toString(36)})${ext}`;
  }

  /**
   * Decide sem reservar nada. `begin()` é quem consome slot de concorrência —
   * `check` pode ser chamado à vontade para diagnóstico.
   */
  check(req: DownloadRequest = {}): DownloadDecision {
    const sanitized = sanitizeFilename(req.suggested_filename, {
      executableExtensions: this.executableExtensions,
    });
    const expected = req.expected === true;
    const authorized = req.authorized === true;
    const size = typeof req.size === "number" && Number.isFinite(req.size) ? req.size : null;
    const source = typeof req.url === "string" ? req.url : null;
    // Executável, ou disfarçado de documento: os dois exigem ato do dono.
    const requires_authorization = sanitized.executable || sanitized.deceptive;

    const base: DownloadDecision = {
      allowed: false,
      reason: "",
      code: "DOWNLOAD_DENIED",
      download_id: typeof req.download_id === "string" && req.download_id !== "" ? req.download_id : newId("dl"),
      session_id: typeof req.session_id === "string" ? req.session_id : null,
      filename: sanitized.safe,
      original_filename: sanitized.original,
      sanitized,
      requires_authorization,
      executable: sanitized.executable,
      deceptive: sanitized.deceptive,
      expected,
      authorized,
      resolved_path: null,
      root: this.root,
      size,
      max_bytes: this.maxBytes,
      concurrent: this.#inflight.size,
      max_concurrent: this.maxConcurrent,
      source,
      mime: typeof req.mime === "string" ? req.mime : null,
      auto_open: false,
      path_decision: null,
      url_decision: null,
      decided_at: nowIso(),
    };

    if (this.root === null) {
      return { ...base, reason: "raiz de download não configurada; download negado (fail closed)" };
    }

    if (this.checkSourceUrl) {
      const u = checkUrl(req.url, this.#urlGuard);
      if (!u.allowed) {
        return { ...base, url_decision: u, reason: `origem de download recusada: ${u.reason}` };
      }
      base.url_decision = u;
    }

    // Confinamento primeiro: é a regra estrutural. Delegada a policy.ts, que já
    // resolve symlink e compara por segmento.
    const filename = this.#freeName(this.root, sanitized.safe);
    const pd = checkPath(filename, "download", { root: this.root, mustExist: false });
    const withPath: DownloadDecision = {
      ...base,
      filename,
      path_decision: pd,
      resolved_path: pd.resolved,
      root: pd.root ?? this.root,
    };
    if (!pd.allowed) {
      return { ...withPath, code: pd.code ?? "DOWNLOAD_DENIED", reason: `destino recusado: ${pd.reason}` };
    }

    if (!expected) {
      return {
        ...withPath,
        reason: "download não solicitado por ação do chamador — registrado e bloqueado por padrão",
      };
    }

    if (requires_authorization && !authorized) {
      const motivo = sanitized.executable
        ? `extensão executável "${sanitized.extension}"`
        : "nome desenhado para enganar (bidi ou dupla extensão)";
      return {
        ...withPath,
        reason: `${motivo}: exige autorização explícita do dono; o runtime nunca abre o que baixou`,
      };
    }

    if (size !== null && size > this.maxBytes) {
      return {
        ...withPath,
        reason: `tamanho anunciado ${size} excede o limite de ${this.maxBytes} bytes`,
      };
    }

    if (this.#inflight.size >= this.maxConcurrent) {
      return {
        ...withPath,
        code: "BACKPRESSURE_REJECTED",
        reason: `limite de ${this.maxConcurrent} downloads simultâneos atingido`,
      };
    }

    return {
      ...withPath,
      allowed: true,
      code: null,
      reason: requires_authorization
        ? "download autorizado explicitamente; permanece inerte (auto_open=false)"
        : "download permitido e confinado na raiz",
    };
  }

  /** `check` + reserva de slot e de nome. Só o permitido reserva. */
  begin(req: DownloadRequest = {}): DownloadDecision {
    const d = this.check(req);
    if (!d.allowed || d.resolved_path === null) return d;
    this.#inflight.set(d.download_id, {
      download_id: d.download_id,
      filename: d.filename,
      destination: d.resolved_path,
      bytes: 0,
      started_at: d.decided_at,
      session_id: d.session_id,
    });
    this.#reserved.add(d.resolved_path);
    return d;
  }

  /**
   * Contabiliza bytes já transferidos. Existe porque `Content-Length` mente (ou
   * falta): um limite conferido só no início não é limite.
   */
  progress(download_id: string, bytes: number): ProgressVerdict {
    const f = this.#inflight.get(download_id);
    if (f === undefined) {
      return { ok: false, reason: `download desconhecido: ${download_id}`, bytes: 0, max_bytes: this.maxBytes, abort: true };
    }
    if (!Number.isFinite(bytes) || bytes < 0) {
      return { ok: false, reason: "contagem de bytes inválida", bytes: f.bytes, max_bytes: this.maxBytes, abort: true };
    }
    f.bytes = Math.max(f.bytes, Math.floor(bytes));
    if (f.bytes > this.maxBytes) {
      this.#release(download_id);
      return {
        ok: false,
        reason: `transferência excedeu ${this.maxBytes} bytes; abortada`,
        bytes: f.bytes,
        max_bytes: this.maxBytes,
        abort: true,
      };
    }
    return { ok: true, reason: "dentro do limite", bytes: f.bytes, max_bytes: this.maxBytes, abort: false };
  }

  #release(download_id: string): InFlight | null {
    const f = this.#inflight.get(download_id);
    if (f === undefined) return null;
    this.#inflight.delete(download_id);
    this.#reserved.delete(f.destination);
    return f;
  }

  /** Libera o slot. Devolve o estado final da transferência, ou `null`. */
  complete(download_id: string): InFlight | null {
    return this.#release(download_id);
  }

  /** Igual a `complete`; nome separado para a auditoria distinguir os casos. */
  fail(download_id: string): InFlight | null {
    return this.#release(download_id);
  }
}

/** `DownloadRecord` do contrato a partir da decisão. `destination` é o caminho SEGURO. */
export function toDownloadRecord(d: DownloadDecision, status: DownloadRecord["status"] = "started"): DownloadRecord {
  return {
    download_id: d.download_id,
    session_id: d.session_id ?? "",
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    status,
    source: d.source ?? "",
    destination: d.resolved_path ?? "",
    created_at: d.decided_at,
  };
}

/** `AuditEntry` do contrato. Download bloqueado também vira linha — nunca some. */
export function downloadAuditEntry(d: DownloadDecision, action_id: string | null = null): AuditEntry {
  return {
    timestamp: d.decided_at,
    session: d.session_id,
    actor: "runtime",
    action: "browser.download",
    target: d.source,
    result: d.allowed ? "ok" : "denied",
    verified: false,
    action_id,
    detail: {
      download_id: d.download_id,
      filename: d.filename,
      original_filename: d.original_filename,
      sanitize_reasons: d.sanitized.reasons,
      executable: d.executable,
      deceptive: d.deceptive,
      requires_authorization: d.requires_authorization,
      expected: d.expected,
      authorized: d.authorized,
      auto_open: d.auto_open,
      size: d.size,
      destination: d.resolved_path,
      reason: d.reason,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadPolicy (FASE 28)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Segmentos de caminho proibidos em QUALQUER posição — inclusive dentro da raiz
 * permitida. Uma raiz de upload que contenha um `.ssh/` (por link, por cópia ou
 * por descuido) não vira permissão de enviar chave privada.
 */
export const UPLOAD_DENIED_SEGMENTS: ReadonlySet<string> = Object.freeze(
  new Set([
    ".ssh", ".aws", ".gnupg", ".gpg", "keychains", ".brand-governance",
    "brandbooks_oficiais", ".password-store", ".docker", ".kube", ".chef",
  ]),
) as ReadonlySet<string>;

/** Basenames proibidos, comparados em minúsculas. */
export const UPLOAD_DENIED_BASENAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    ".env", "vault.json", "id_rsa", "id_rsa.pub", "id_dsa", "id_ecdsa",
    "id_ed25519", "id_ed25519.pub", ".netrc", "_netrc", ".git-credentials",
    ".npmrc", ".pypirc", ".pgpass", ".htpasswd", "credentials", "authorized_keys",
    "known_hosts", "secrets.json", "shadow", "master.key",
  ]),
) as ReadonlySet<string>;

/** Extensões proibidas. `.pem/.key/.p12/.keychain` vêm da missão; o resto endurece. */
export const UPLOAD_DENIED_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([".pem", ".key", ".p12", ".pfx", ".p8", ".pkcs12", ".keychain", ".keychain-db", ".ppk", ".jks", ".kdbx", ".asc"]),
) as ReadonlySet<string>;

/** Prefixos de basename proibidos: pega `.env.local`, `.env.production`. */
const UPLOAD_DENIED_PREFIXES: readonly string[] = Object.freeze([".env", "id_rsa", "id_ed25519", "id_ecdsa"]);

/** Diretórios ancorados no `$HOME` do dono. Redundante com os segmentos — de
 *  propósito: duas regras independentes negando a mesma coisa. */
const HOME_DENIED_DIRS: readonly string[] = Object.freeze([
  ".ssh", ".aws", ".gnupg", ".brand-governance", ".password-store",
  "Library/Keychains", "Documents/BRANDBOOKS_OFICIAIS",
]);

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface UploadPolicyOptions {
  /** Raiz permitida. Ausente ⇒ todo upload é negado (fail closed). */
  root?: string;
  maxBytes?: number;
  extraDeniedSegments?: Iterable<string>;
  extraDeniedBasenames?: Iterable<string>;
  extraDeniedExtensions?: Iterable<string>;
  /** `$HOME` usado nas regras ancoradas em `~`. Default `os.homedir()`. */
  home?: string;
}

export interface UploadRequest {
  session_id?: string | null;
  /** Caminho pedido. Só do CHAMADOR — a página não escolhe arquivo. */
  path?: unknown;
  /** Quem escolheu o arquivo. Apenas `"caller"` é aceito. */
  origin?: string;
  /** Ato explícito de autorização do chamador. */
  authorized?: boolean;
  destination_site?: string;
  upload_id?: string;
  task?: string | null;
}

export interface UploadDecision {
  allowed: boolean;
  reason: string;
  code: ActionErrorCode | null;
  /** Caminho real (symlinks resolvidos) quando permitido; senão o que deu para resolver. */
  resolved_path: string | null;
  upload_id: string;
  session_id: string | null;
  root: string | null;
  /** Regra que negou, legível: `segmento_proibido:.ssh`, `extensao_proibida:.pem`… */
  rule: string | null;
  origin: string;
  authorized: boolean;
  size: number | null;
  max_bytes: number;
  destination_site: string | null;
  path_decision: PathDecision | null;
  decided_at: string;
}

export class UploadPolicy {
  readonly root: string | null;
  readonly maxBytes: number;
  readonly home: string;
  readonly deniedSegments: ReadonlySet<string>;
  readonly deniedBasenames: ReadonlySet<string>;
  readonly deniedExtensions: ReadonlySet<string>;

  constructor(opts: UploadPolicyOptions = {}) {
    this.root = typeof opts.root === "string" && opts.root.trim() !== "" ? path.resolve(opts.root) : null;
    this.maxBytes = Number.isFinite(opts.maxBytes) && (opts.maxBytes as number) > 0
      ? Math.floor(opts.maxBytes as number)
      : DEFAULT_MAX_UPLOAD_BYTES;
    this.home = path.resolve(typeof opts.home === "string" && opts.home !== "" ? opts.home : os.homedir());
    this.deniedSegments = new Set([
      ...UPLOAD_DENIED_SEGMENTS,
      ...[...(opts.extraDeniedSegments ?? [])].map((s) => s.toLowerCase()),
    ]);
    this.deniedBasenames = new Set([
      ...UPLOAD_DENIED_BASENAMES,
      ...[...(opts.extraDeniedBasenames ?? [])].map((s) => s.toLowerCase()),
    ]);
    this.deniedExtensions = new Set([
      ...UPLOAD_DENIED_EXTENSIONS,
      ...[...(opts.extraDeniedExtensions ?? [])].map((s) => s.toLowerCase()),
    ]);
  }

  /** Primeira regra de conteúdo violada por este caminho, ou `null`. */
  deniedRuleFor(candidate: string): string | null {
    const abs = path.resolve(candidate);

    for (const dir of HOME_DENIED_DIRS) {
      const root = path.resolve(this.home, dir);
      if (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
        return `diretorio_do_dono_proibido:~/${dir}`;
      }
    }

    for (const seg of abs.split(path.sep)) {
      if (seg === "") continue;
      if (this.deniedSegments.has(seg.toLowerCase())) return `segmento_proibido:${seg}`;
    }

    const base = path.basename(abs);
    const lower = base.toLowerCase();
    if (this.deniedBasenames.has(lower)) return `arquivo_proibido:${base}`;
    for (const p of UPLOAD_DENIED_PREFIXES) {
      if (lower === p || lower.startsWith(`${p}.`)) return `prefixo_proibido:${p}`;
    }

    const ext = extensionOf(base);
    if (ext !== "" && this.deniedExtensions.has(ext)) return `extensao_proibida:${ext}`;

    return null;
  }

  check(req: UploadRequest = {}): UploadDecision {
    const origin = typeof req.origin === "string" ? req.origin : "";
    const authorized = req.authorized === true;
    const base: UploadDecision = {
      allowed: false,
      reason: "",
      code: "UPLOAD_DENIED",
      resolved_path: null,
      upload_id: typeof req.upload_id === "string" && req.upload_id !== "" ? req.upload_id : newId("up"),
      session_id: typeof req.session_id === "string" ? req.session_id : null,
      root: this.root,
      rule: null,
      origin,
      authorized,
      size: null,
      max_bytes: this.maxBytes,
      destination_site: typeof req.destination_site === "string" ? req.destination_site : null,
      path_decision: null,
      decided_at: nowIso(),
    };

    // A página é a origem hostil por definição: ela escolheria o arquivo do
    // dono. Recusa própria, para a auditoria não confundir com falta de flag.
    if (origin === "page") {
      return {
        ...base,
        rule: "pagina_escolheu_arquivo",
        reason: "a página não escolhe arquivo de upload; só caminho vindo do chamador é aceito",
      };
    }
    if (origin !== "caller") {
      return {
        ...base,
        rule: "origem_nao_e_chamador",
        reason: `origem "${origin === "" ? "(ausente)" : origin}" não é "caller" — upload negado (fail closed)`,
      };
    }
    if (!authorized) {
      return {
        ...base,
        rule: "sem_autorizacao",
        reason: "upload exige autorização explícita do chamador",
      };
    }

    if (this.root === null) {
      return { ...base, rule: "sem_raiz", reason: "raiz de upload não configurada; upload negado (fail closed)" };
    }

    // Traversal, byte nulo, existência e fuga por symlink: tudo já é policy.ts.
    const pd = checkPath(req.path, "upload", { root: this.root, mustExist: true });
    const withPath: UploadDecision = {
      ...base,
      path_decision: pd,
      resolved_path: pd.resolved,
      root: pd.root ?? this.root,
    };
    if (!pd.allowed) {
      return { ...withPath, code: pd.code ?? "UPLOAD_DENIED", rule: "fora_da_raiz", reason: pd.reason };
    }

    const real = pd.resolved as string;
    // Confere o caminho PEDIDO e o REAL: um symlink dentro da raiz apontando
    // para outro arquivo da raiz não lava o nome proibido de nenhum dos dois.
    const rule =
      this.deniedRuleFor(real) ??
      this.deniedRuleFor(path.resolve(this.root, String(req.path)));
    if (rule !== null) {
      return { ...withPath, rule, reason: `arquivo sensível bloqueado por regra ${rule}` };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      return { ...withPath, rule: "stat_falhou", reason: `não foi possível inspecionar o arquivo: ${(err as Error).name}` };
    }
    if (!stat.isFile()) {
      return { ...withPath, rule: "nao_e_arquivo", reason: "caminho não é arquivo regular" };
    }
    if (stat.size > this.maxBytes) {
      return {
        ...withPath,
        size: stat.size,
        rule: "tamanho_excedido",
        reason: `arquivo de ${stat.size} bytes excede o limite de ${this.maxBytes}`,
      };
    }

    return {
      ...withPath,
      allowed: true,
      code: null,
      size: stat.size,
      reason: "upload permitido: caminho do chamador, autorizado, confinado na raiz e sem regra de segredo violada",
    };
  }
}

/** `UploadRecord` do contrato a partir da decisão permitida. */
export function toUploadRecord(d: UploadDecision, req: UploadRequest = {}): UploadRecord {
  return {
    upload_id: d.upload_id,
    session_id: d.session_id ?? "",
    filename: d.resolved_path === null ? "" : path.basename(d.resolved_path),
    destination_site: d.destination_site ?? "",
    task: req.task ?? null,
    created_at: d.decided_at,
  };
}

/** `AuditEntry` do contrato. Upload negado também vira linha. */
export function uploadAuditEntry(d: UploadDecision, action_id: string | null = null): AuditEntry {
  return {
    timestamp: d.decided_at,
    session: d.session_id,
    actor: "runtime",
    action: "browser.upload",
    target: d.destination_site,
    result: d.allowed ? "ok" : "denied",
    verified: false,
    action_id,
    detail: {
      upload_id: d.upload_id,
      origin: d.origin,
      authorized: d.authorized,
      rule: d.rule,
      // Nome do arquivo, não o caminho inteiro: o caminho do dono é dado de casa.
      filename: d.resolved_path === null ? null : path.basename(d.resolved_path),
      size: d.size,
      reason: d.reason,
    },
  };
}
