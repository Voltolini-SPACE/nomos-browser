/**
 * FASE 18 — VAULT DE SEGREDOS
 *
 * O agente pede por REFERÊNCIA (`credential_ref`); o runtime injeta o valor na
 * página. O valor não volta para o chamador, não entra em `ActionResponse`, não
 * entra em log e não aparece em mensagem de erro.
 *
 * Três mecanismos sustentam isso, e nenhum depende de disciplina do chamador:
 *
 *   1. `resolve()` é a única porta para o valor e é de uso interno do runtime
 *      (`SecretProvider` no contrato diz isso; aqui é o que o código faz).
 *   2. `injectSecret()` devolve um recibo — `{injected, ref, destino, verified}` —
 *      onde nada é derivado do valor. Nem o comprimento: comprimento de senha é
 *      informação de ataque.
 *   3. `assertNoSecretLeak()` / `redactSecrets()` blindam qualquer texto antes
 *      de virar log, incluindo mensagens de exceção do Playwright.
 *
 * Armazenamento: `profiles/<perfil>/vault.json`, modo 0600, formato `{ref: valor}`.
 * Arquivo com permissão mais larga é RECUSADO — não corrigido em silêncio: se o
 * segredo esteve legível por outro usuário, ele já deve ser considerado vazado.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElementHandle, Locator, Page } from "playwright";
import { nowIso, type AuditEntry, type RuntimeEvent, type SecretProvider } from "./contract.ts";

/** `packages/core/src/vault.ts` → raiz do repo → `profiles/`. */
export const DEFAULT_VAULT_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "profiles",
);

export const VAULT_FILENAME = "vault.json" as const;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type VaultErrorCode =
  | "INVALID_PROFILE"
  | "INVALID_REF"
  | "SECRET_NOT_FOUND"
  | "VAULT_UNREADABLE"
  | "VAULT_INSECURE_PERMISSIONS"
  | "INJECTION_FAILED"
  | "INVALID_TARGET";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: VaultErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.detail = detail;
  }
}

/** Lançado quando um valor de segredo é encontrado num texto prestes a ser logado. */
export class SecretLeakError extends Error {
  readonly ref: string;
  /** Como o valor apareceu (cru, url-encoded, base64, json-escaped). Nunca o valor. */
  readonly encoding: SecretEncoding;
  constructor(ref: string, encoding: SecretEncoding) {
    super(`vazamento de segredo detectado: referência "${ref}" apareceu no texto (codificação ${encoding})`);
    this.name = "SecretLeakError";
    this.ref = ref;
    this.encoding = encoding;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de nomes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Primeiro caractere não pode ser `.` (viraria arquivo/pasta oculta, e abre a
 * porta para `..`) nem `-` (seria lido como flag por qualquer CLI que receba o
 * nome). `_` inicial é convenção legítima de perfil interno e não tem risco.
 */
const PROFILE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** `:` é permitido porque referências costumam ser `site:campo` (`bank:password`). */
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
/** Nomes que colidiriam com a cadeia de protótipos do objeto JSON. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isValidProfile(name: unknown): name is string {
  return typeof name === "string" && PROFILE_RE.test(name) && !name.includes("..");
}

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === "string" && REF_RE.test(ref) && !FORBIDDEN_KEYS.has(ref) && !ref.includes("..");
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de vazamento
// ─────────────────────────────────────────────────────────────────────────────

export type SecretEncoding = "raw" | "url" | "base64" | "json";

/**
 * Formas em que um segredo costuma reaparecer num log: cru, dentro de uma query
 * string, num header `Authorization: Basic`, ou dentro de um JSON com escapes.
 * Checar só a forma crua deixaria as outras três passarem.
 */
function encodingsOf(value: string): [SecretEncoding, string][] {
  const forms: [SecretEncoding, string][] = [["raw", value]];
  const url = encodeURIComponent(value);
  if (url !== value) forms.push(["url", url]);
  const b64 = Buffer.from(value, "utf8").toString("base64");
  forms.push(["base64", b64]);
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) forms.push(["json", json]);
  return forms;
}

/** Primeira codificação em que `value` aparece em `text`, ou `null`. */
export function findSecretIn(text: string, value: string): SecretEncoding | null {
  if (value === "") return null;
  for (const [enc, form] of encodingsOf(value)) {
    if (form !== "" && text.includes(form)) return enc;
  }
  return null;
}

/** Substitui todas as ocorrências do valor por `«ref»`, em todas as codificações. */
function redactValue(text: string, ref: string, value: string): string {
  let out = text;
  for (const [, form] of encodingsOf(value)) {
    if (form === "") continue;
    out = out.split(form).join(`«${ref}»`);
  }
  return out;
}

/**
 * Scrubber com os valores presos num closure. Serve para o caminho quente de
 * log: resolve os segredos uma vez e depois só compara, sem voltar ao disco.
 */
export interface SecretScrubber {
  readonly refs: readonly string[];
  assert(text: string): void;
  redact(text: string): string;
  contains(text: string): { ref: string; encoding: SecretEncoding } | null;
}

export function makeScrubber(entries: readonly [string, string][]): SecretScrubber {
  const pairs = entries.filter(([, v]) => typeof v === "string" && v !== "");
  const contains = (text: string): { ref: string; encoding: SecretEncoding } | null => {
    if (typeof text !== "string" || text === "") return null;
    for (const [ref, value] of pairs) {
      const enc = findSecretIn(text, value);
      if (enc !== null) return { ref, encoding: enc };
    }
    return null;
  };
  return {
    refs: Object.freeze(pairs.map(([r]) => r)),
    contains,
    assert(text: string): void {
      const hit = contains(text);
      if (hit !== null) throw new SecretLeakError(hit.ref, hit.encoding);
    },
    redact(text: string): string {
      if (typeof text !== "string") return text;
      let out = text;
      for (const [ref, value] of pairs) out = redactValue(out, ref, value);
      return out;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria
// ─────────────────────────────────────────────────────────────────────────────

export interface SecretUsage {
  /** A REFERÊNCIA. O valor nunca aparece nesta estrutura. */
  ref: string;
  session: string | null;
  /** Descrição do alvo: seletor, `handle` ou rótulo dado pelo chamador. */
  destino: string;
  timestamp: string;
  /** O campo continha o segredo depois da injeção (comparação feita na página). */
  verified: boolean;
  provider: string;
}

export type SecretUsedHook = (usage: SecretUsage) => void | Promise<void>;

/** Converte o uso no `AuditEntry` do contrato (FASE 24). */
export function secretUsageToAuditEntry(u: SecretUsage, action_id: string | null = null): AuditEntry {
  return {
    timestamp: u.timestamp,
    session: u.session,
    actor: u.provider,
    action: "secret.used",
    target: u.destino,
    result: u.verified ? "ok" : "error",
    verified: u.verified,
    action_id,
    detail: { credential_ref: u.ref },
  };
}

/** Converte o uso no `RuntimeEvent` `secret.used` (FASE 5). */
export function secretUsageToEvent(
  u: SecretUsage,
  source: string,
  action_id: string | null = null,
): RuntimeEvent<{ credential_ref: string; destino: string; verified: boolean }> {
  return {
    timestamp: u.timestamp,
    session_id: u.session,
    action_id,
    source,
    event: "secret.used",
    payload: { credential_ref: u.ref, destino: u.destino, verified: u.verified },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injeção
// ─────────────────────────────────────────────────────────────────────────────

export type InjectionTarget = string | Locator | ElementHandle;

export interface InjectSecretOptions {
  session?: string | null;
  /** `fill` grava de uma vez; `type` emite tecla a tecla (formulários que escutam keydown). */
  mode?: "fill" | "type";
  /** Rótulo de auditoria quando o alvo é um handle opaco. */
  destino?: string;
  timeout_ms?: number;
}

/**
 * Recibo da injeção. Repare no que NÃO existe aqui: valor, comprimento, prefixo,
 * hash. Só a referência e se a página passou a conter o segredo.
 */
export interface InjectSecretReceipt {
  injected: boolean;
  ref: string;
  destino: string;
  verified: boolean;
  at: string;
}

interface FillableTarget {
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  focus(options?: { timeout?: number }): Promise<void>;
  evaluate(fn: (node: unknown) => number): Promise<number>;
  pressSequentially?(value: string, options?: { timeout?: number }): Promise<void>;
  type?(value: string, options?: { timeout?: number }): Promise<void>;
}

function resolveTarget(page: Page, target: InjectionTarget, destino?: string): { el: FillableTarget; destino: string } {
  if (typeof target === "string") {
    if (target.trim() === "") throw new VaultError("INVALID_TARGET", "seletor vazio");
    return { el: page.locator(target) as unknown as FillableTarget, destino: destino ?? `selector:${target}` };
  }
  const cand = target as unknown as Partial<FillableTarget>;
  if (cand !== null && typeof cand === "object" && typeof cand.fill === "function") {
    return { el: cand as FillableTarget, destino: destino ?? "handle" };
  }
  throw new VaultError("INVALID_TARGET", "alvo não é seletor, Locator nem ElementHandle");
}

/**
 * Injeta o segredo `ref` no alvo. Assinatura conforme a missão:
 * `injectSecret(page, targetHandleOrSelector, ref)` — o provider entra primeiro
 * porque é ele que detém o valor e o hook de auditoria.
 */
export async function injectSecret(
  provider: SecretProvider & { onSecretUsed?: SecretUsedHook },
  page: Page,
  target: InjectionTarget,
  ref: string,
  opts: InjectSecretOptions = {},
): Promise<InjectSecretReceipt> {
  if (!isValidRef(ref)) throw new VaultError("INVALID_REF", `referência inválida: ${String(ref)}`, { ref: String(ref) });
  const { el, destino } = resolveTarget(page, target, opts.destino);

  // resolve() é a ÚNICA leitura do valor; a partir daqui ele só existe nesta
  // variável local e nos argumentos do Playwright.
  const value = await provider.resolve(ref);
  if (typeof value !== "string" || value === "") {
    throw new VaultError("SECRET_NOT_FOUND", `segredo vazio ou ausente para "${ref}"`, { ref });
  }

  const timeout = opts.timeout_ms ?? 10_000;
  let verified = false;
  try {
    await el.focus({ timeout });
    if (opts.mode === "type") {
      if (typeof el.pressSequentially === "function") await el.pressSequentially(value, { timeout });
      else if (typeof el.type === "function") await el.type(value, { timeout });
      else await el.fill(value, { timeout });
    } else {
      await el.fill(value, { timeout });
    }

    // Verificação sem vazamento: a comparação acontece DENTRO da página e só o
    // booleano atravessa a fronteira. Trazer `node.value` para cá para comparar
    // seria devolver o segredo ao processo pela porta dos fundos.
    const expected = value;
    const matched = await (el.evaluate as unknown as (
      fn: (node: unknown, expected: string) => boolean,
      arg: string,
    ) => Promise<boolean>)((node: unknown, exp: string) => {
      const n = node as { value?: unknown; isContentEditable?: boolean; textContent?: string | null };
      if (typeof n.value === "string") return n.value === exp;
      if (n.isContentEditable === true) return (n.textContent ?? "") === exp;
      return false;
    }, expected);
    verified = matched === true;
  } catch (err) {
    // Mensagem de erro do Playwright pode citar o valor (ex.: em `type`).
    // Redigir ANTES de propagar é o único momento em que dá para garantir isso.
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new VaultError("INJECTION_FAILED", `falha ao injetar "${ref}": ${redactValue(raw, ref, value)}`, { ref, destino });
  }

  const usage: SecretUsage = {
    ref,
    session: opts.session ?? null,
    destino,
    timestamp: nowIso(),
    verified,
    provider: provider.name,
  };
  if (typeof provider.onSecretUsed === "function") await provider.onSecretUsed(usage);

  return { injected: true, ref, destino, verified, at: usage.timestamp };
}

/**
 * Lança se algum valor de segredo aparecer no texto. É a blindagem de log:
 * `await vault.assertNoSecretLeak(linha, refsDaSessao)` antes de escrever.
 */
export async function assertNoSecretLeak(
  provider: SecretProvider,
  texto: string,
  refs: readonly string[],
): Promise<void> {
  const scrubber = await scrubberFor(provider, refs);
  scrubber.assert(texto);
}

async function scrubberFor(provider: SecretProvider, refs: readonly string[]): Promise<SecretScrubber> {
  const entries: [string, string][] = [];
  for (const ref of refs) {
    if (!isValidRef(ref)) continue; // ref inválida não corresponde a segredo algum
    if (!(await provider.has(ref))) continue;
    entries.push([ref, await provider.resolve(ref)]);
  }
  return makeScrubber(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// FileVault
// ─────────────────────────────────────────────────────────────────────────────

export interface FileVaultOptions {
  /** Raiz dos perfis. Default: `<repo>/profiles`. */
  root?: string;
  onSecretUsed?: SecretUsedHook;
}

export class FileVault implements SecretProvider {
  readonly name = "file-vault";
  readonly profile: string;
  readonly root: string;
  readonly path: string;
  readonly onSecretUsed?: SecretUsedHook;

  constructor(profile: string, opts: FileVaultOptions = {}) {
    if (!isValidProfile(profile)) {
      throw new VaultError("INVALID_PROFILE", `perfil inválido: ${String(profile)}`, { profile: String(profile) });
    }
    this.profile = profile;
    this.root = path.resolve(opts.root ?? DEFAULT_VAULT_ROOT);
    this.path = path.join(this.root, profile, VAULT_FILENAME);
    this.onSecretUsed = opts.onSecretUsed;
  }

  /** Lê o arquivo. Ausente ⇒ mapa vazio (mas `resolve` continua lançando). */
  #read(): Record<string, string> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path);
    } catch {
      return Object.create(null) as Record<string, string>;
    }
    // Permissão larga significa que o segredo esteve legível por terceiros.
    // Corrigir o modo aqui esconderia o incidente; recusar o torna visível.
    if ((stat.mode & 0o077) !== 0) {
      throw new VaultError(
        "VAULT_INSECURE_PERMISSIONS",
        `vault com permissão insegura (${(stat.mode & 0o777).toString(8)}); esperado 600`,
        { path: this.path, mode: (stat.mode & 0o777).toString(8) },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new VaultError("VAULT_UNREADABLE", `vault ilegível: ${(err as Error).name}`, { path: this.path });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new VaultError("VAULT_UNREADABLE", "vault não é um objeto {ref: valor}", { path: this.path });
    }
    const out = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidRef(k) && typeof v === "string") out[k] = v;
    }
    return out;
  }

  #write(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: DIR_MODE });
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
    // `mode` do writeFileSync só vale na CRIAÇÃO; um arquivo preexistente
    // manteria a permissão antiga. O chmod explícito fecha essa brecha.
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, this.path);
    fs.chmodSync(this.path, FILE_MODE);
    fs.chmodSync(path.dirname(this.path), DIR_MODE);
  }

  async has(ref: string): Promise<boolean> {
    if (!isValidRef(ref)) return false;
    return Object.hasOwn(this.#read(), ref);
  }

  /** Uso INTERNO do runtime. Não existe rota da API v1 que chegue aqui. */
  async resolve(ref: string): Promise<string> {
    if (!isValidRef(ref)) throw new VaultError("INVALID_REF", `referência inválida: ${String(ref)}`, { ref: String(ref) });
    const data = this.#read();
    if (!Object.hasOwn(data, ref)) {
      throw new VaultError("SECRET_NOT_FOUND", `segredo não encontrado: "${ref}"`, { ref, profile: this.profile });
    }
    return data[ref];
  }

  /** Só as REFERÊNCIAS. Não existe método que liste valores. */
  async list(): Promise<string[]> {
    return Object.keys(this.#read()).sort();
  }

  /** Grava um segredo. É ato do dono do perfil, não do agente. */
  async put(ref: string, value: string): Promise<void> {
    if (!isValidRef(ref)) throw new VaultError("INVALID_REF", `referência inválida: ${String(ref)}`, { ref: String(ref) });
    if (typeof value !== "string" || value === "") {
      throw new VaultError("INVALID_REF", `valor de "${ref}" deve ser string não vazia`, { ref });
    }
    const data = this.#read();
    data[ref] = value;
    this.#write(data);
  }

  async remove(ref: string): Promise<boolean> {
    if (!isValidRef(ref)) return false;
    const data = this.#read();
    if (!Object.hasOwn(data, ref)) return false;
    delete data[ref];
    this.#write(data);
    return true;
  }

  /** `injectSecret(page, alvo, ref)` — assinatura da missão. */
  async injectSecret(
    page: Page,
    target: InjectionTarget,
    ref: string,
    opts: InjectSecretOptions = {},
  ): Promise<InjectSecretReceipt> {
    return injectSecret(this, page, target, ref, opts);
  }

  /** `assertNoSecretLeak(texto, refs)` — assinatura da missão. */
  async assertNoSecretLeak(texto: string, refs: readonly string[]): Promise<void> {
    return assertNoSecretLeak(this, texto, refs);
  }

  /** Scrubber pronto para blindar logs sem reabrir o arquivo a cada linha. */
  async scrubber(refs: readonly string[]): Promise<SecretScrubber> {
    return scrubberFor(this, refs);
  }
}
