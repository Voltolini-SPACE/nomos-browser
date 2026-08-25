/**
 * FASE 15/16/17 — autenticação e autorização do control plane.
 *
 * O `SECURITY.md` do PRODUCT-01 declarava isto como gap aberto (T7): o bind em
 * loopback reduz exposição, mas não autentica. Qualquer processo local — uma aba
 * de navegador que o dono abriu, um script instalado por engano — falava com o
 * runtime e dirigia um navegador com as sessões autenticadas do dono.
 *
 * Duas camadas distintas, deliberadamente separadas:
 *
 *   AUTENTICAÇÃO (FASE 15/16) — quem é você? Token efêmero, gerado a cada
 *   arranque, nunca persistido em fonte, nunca impresso.
 *
 *   AUTORIZAÇÃO (FASE 17) — o que você pode fazer? Escopos por token. Autenticar
 *   não é autorizar: um agente de observação que recebesse `CONTROL` só por ter
 *   um token válido seria exatamente a escalada que esta fase existe para impedir.
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ACTION_CLASS } from "../../core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Escopos
// ─────────────────────────────────────────────────────────────────────────────

export type Scope =
  | "OBSERVE"
  | "NAVIGATE"
  | "INPUT"
  | "DOWNLOAD"
  | "UPLOAD"
  | "SECRET"
  | "CONTROL"
  | "ADMIN";

export const ALL_SCOPES: readonly Scope[] = Object.freeze([
  "OBSERVE", "NAVIGATE", "INPUT", "DOWNLOAD", "UPLOAD", "SECRET", "CONTROL", "ADMIN",
]);

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (ALL_SCOPES as readonly string[]).includes(v);
}

/**
 * Escopo exigido por ferramenta.
 *
 * Derivado à mão, não de `ACTION_CLASS`: a classe diz se a ação muda o mundo,
 * o escopo diz que poder ela exige. São eixos diferentes — `browser.download` é
 * COMMIT e exige DOWNLOAD; `browser.click` é ACT e exige INPUT. Colapsar os dois
 * daria a quem pode clicar o direito de baixar.
 */
export const TOOL_SCOPE: Readonly<Record<string, Scope>> = Object.freeze({
  "browser.observe": "OBSERVE",
  "browser.find": "OBSERVE",
  "browser.extract": "OBSERVE",
  "browser.screenshot": "OBSERVE",
  "browser.network": "OBSERVE",
  "browser.tabs": "OBSERVE",
  "browser.wait": "OBSERVE",
  "browser.open": "NAVIGATE",
  "browser.goto": "NAVIGATE",
  "browser.back": "NAVIGATE",
  "browser.forward": "NAVIGATE",
  "browser.reload": "NAVIGATE",
  "browser.new_tab": "NAVIGATE",
  "browser.switch_tab": "NAVIGATE",
  "browser.close_tab": "NAVIGATE",
  "browser.click": "INPUT",
  "browser.type": "INPUT",
  "browser.press": "INPUT",
  "browser.scroll": "INPUT",
  "browser.drag": "INPUT",
  "browser.download": "DOWNLOAD",
  "browser.upload": "UPLOAD",
  "browser.task": "CONTROL",
});

/** Escopo exigido por rota de gestão de sessão. */
export const ROUTE_SCOPE: Readonly<Record<string, Scope>> = Object.freeze({
  "health": "OBSERVE",
  "sessions.list": "OBSERVE",
  "sessions.get": "OBSERVE",
  "sessions.create": "CONTROL",
  "sessions.delete": "CONTROL",
  "sessions.attach": "CONTROL",
  "sessions.detach": "CONTROL",
  "sessions.handoff": "CONTROL",
  "sessions.takeover": "ADMIN",
  "sessions.release": "ADMIN",
  // FASE 9 — ler o estado de uma task é OBSERVAR; cancelar ou retomar é ATO DE
  // CONTROLE sobre trabalho em curso, no mesmo nível de `sessions.delete`. Sem
  // estas linhas as quatro rotas cairiam no default ADMIN de `scopeForRoute` —
  // fail closed correto, porém rígido demais: um agente com escopo de agente
  // não conseguiria nem consultar a própria task.
  "tasks.list": "OBSERVE",
  "tasks.get": "OBSERVE",
  "tasks.cancel": "CONTROL",
  "tasks.resume": "CONTROL",
  // FASE 10 — lease. Consultar quem manda é OBSERVAR; adquirir, soltar,
  // renovar e transferir são ATOS DE CONTROLE. `takeover` é ADMIN porque
  // arranca o lease de quem o detém sem o consentimento dele — é o mesmo
  // privilégio de `sessions.takeover`, e não pode cair no escopo de agente.
  "lease.get": "OBSERVE",
  "lease.acquire": "CONTROL",
  "lease.release": "CONTROL",
  "lease.renew": "CONTROL",
  "lease.transfer": "CONTROL",
  "lease.takeover": "ADMIN",
  // FASE 12 — verificar integridade de replay é leitura da trilha da sessão.
  "replay.verify": "OBSERVE",
  // Ler a PRÓPRIA credencial é o mínimo que qualquer portador pode fazer.
  "whoami": "OBSERVE",
  "events": "OBSERVE",
});

/** Perfis nomeados. `full` NÃO inclui ADMIN — takeover é ato do operador humano. */
export const SCOPE_PRESETS: Readonly<Record<string, readonly Scope[]>> = Object.freeze({
  observe: Object.freeze(["OBSERVE"] as Scope[]),
  navigate: Object.freeze(["OBSERVE", "NAVIGATE"] as Scope[]),
  agent: Object.freeze(["OBSERVE", "NAVIGATE", "INPUT", "CONTROL"] as Scope[]),
  full: Object.freeze(["OBSERVE", "NAVIGATE", "INPUT", "DOWNLOAD", "UPLOAD", "SECRET", "CONTROL"] as Scope[]),
  admin: Object.freeze([...ALL_SCOPES]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Token
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenRecord {
  token_id: string;
  subject: string;
  scopes: readonly Scope[];
  created_at: string;
  expires_at: number | null;
  /** Sessões que este token pode tocar. Vazio = todas as que ele criar. */
  session_allowlist: Set<string>;
  revoked: boolean;
}

export type AuthFailure =
  | "MISSING_CREDENTIAL"
  | "INVALID_CREDENTIAL"
  | "EXPIRED_CREDENTIAL"
  | "REVOKED_CREDENTIAL"
  | "SCOPE_DENIED"
  | "SESSION_NOT_OWNED";

export interface AuthOk {
  ok: true;
  token: TokenRecord;
}

export interface AuthDenied {
  ok: false;
  failure: AuthFailure;
  /** Legível para humano; nunca contém o token nem parte dele. */
  reason: string;
  required?: Scope;
}

export type AuthResult = AuthOk | AuthDenied;

const TOKEN_BYTES = 32;

/** sha256 do token. O runtime guarda o hash, nunca o segredo em claro na memória de longo prazo. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Comparação em tempo constante.
 *
 * `a === b` vaza o comprimento do prefixo comum pelo tempo de execução. Contra um
 * atacante local, que consegue medir com precisão e repetir à vontade, isso é
 * suficiente para reconstruir o token byte a byte.
 */
function equalsConstantTime(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual exige mesmo comprimento; compara-se o hash, que sempre tem.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface IssueOptions {
  subject: string;
  scopes?: readonly Scope[];
  preset?: keyof typeof SCOPE_PRESETS;
  ttl_ms?: number | null;
  session_allowlist?: readonly string[];
}

export interface IssuedToken {
  /** O segredo. Devolvido UMA vez, na emissão. Nunca recuperável depois. */
  secret: string;
  token_id: string;
  scopes: readonly Scope[];
  expires_at: number | null;
}

export interface AuthManagerOptions {
  /** Relógio injetável — o teste precisa expirar token sem esperar de verdade. */
  now?: () => number;
  /** Diretório do arquivo de token do daemon. */
  runtime_dir?: string;
  /** Desliga a exigência de credencial. Só para migração; nunca em produção. */
  disabled?: boolean;
}

export const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), ".nomos-browser");
export const TOKEN_FILE = "control-token";

export class AuthManager {
  readonly #tokens = new Map<string, TokenRecord>(); // hash → registro
  readonly #now: () => number;
  readonly #runtimeDir: string;
  readonly disabled: boolean;
  #rootSecret: string | null = null;
  #tokenPath: string | null = null;

  constructor(opts: AuthManagerOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#runtimeDir = opts.runtime_dir ?? DEFAULT_RUNTIME_DIR;
    this.disabled = opts.disabled === true;
  }

  /**
   * Token raiz do daemon, gerado a cada arranque e gravado com permissão 0600.
   *
   * Efêmero por decisão: um segredo persistido vira credencial de longo prazo em
   * disco, e a primeira coisa que um atacante local procura. Ao reiniciar, tudo
   * que tinha o token velho perde acesso — o que é o comportamento correto.
   */
  bootstrap(): IssuedToken {
    const emitido = this.issue({ subject: "daemon-root", preset: "admin" });
    this.#rootSecret = emitido.secret;
    mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    const alvo = path.join(this.#runtimeDir, TOKEN_FILE);
    // Remove antes de escrever: reescrever um arquivo existente preservaria a
    // permissão antiga, que pode estar larga.
    if (existsSync(alvo)) unlinkSync(alvo);
    writeFileSync(alvo, `${emitido.secret}\n`, { mode: 0o600 });
    chmodSync(alvo, 0o600);
    this.#tokenPath = alvo;
    return emitido;
  }

  get tokenPath(): string | null {
    return this.#tokenPath;
  }

  /** Só para o daemon injetar na própria UI (mesma origem). Nunca vai para log. */
  get rootSecret(): string | null {
    return this.#rootSecret;
  }

  issue(opts: IssueOptions): IssuedToken {
    const secret = randomBytes(TOKEN_BYTES).toString("base64url");
    const scopes = opts.scopes ?? (opts.preset !== undefined ? SCOPE_PRESETS[opts.preset]! : SCOPE_PRESETS.observe!);
    for (const s of scopes) {
      if (!isScope(s)) throw new Error(`auth: escopo inválido "${String(s)}"`);
    }
    const token_id = `tok_${randomBytes(8).toString("hex")}`;
    const expires_at = opts.ttl_ms === undefined || opts.ttl_ms === null ? null : this.#now() + opts.ttl_ms;
    this.#tokens.set(hashToken(secret), {
      token_id,
      subject: opts.subject,
      scopes: Object.freeze([...scopes]),
      created_at: new Date(this.#now()).toISOString(),
      expires_at,
      session_allowlist: new Set(opts.session_allowlist ?? []),
      revoked: false,
    });
    return { secret, token_id, scopes: Object.freeze([...scopes]), expires_at };
  }

  revoke(token_id: string): boolean {
    for (const rec of this.#tokens.values()) {
      if (rec.token_id === token_id) {
        rec.revoked = true;
        return true;
      }
    }
    return false;
  }

  /** Extrai credencial de `Authorization: Bearer`, `x-nomos-token` ou `?token=`. */
  static extract(headers: Record<string, string | string[] | undefined>, url: URL): string | null {
    const auth = headers["authorization"];
    if (typeof auth === "string" && /^bearer /i.test(auth)) {
      const v = auth.slice(7).trim();
      if (v !== "") return v;
    }
    const h = headers["x-nomos-token"];
    if (typeof h === "string" && h.trim() !== "") return h.trim();
    const q = url.searchParams.get("token");
    if (q !== null && q.trim() !== "") return q.trim();
    return null;
  }

  /** Autentica. Não decide o que pode ser feito — isso é `authorize`. */
  authenticate(raw: string | null): AuthResult {
    if (this.disabled) {
      return { ok: true, token: { token_id: "tok_disabled", subject: "auth-desligada", scopes: ALL_SCOPES, created_at: new Date(this.#now()).toISOString(), expires_at: null, session_allowlist: new Set(), revoked: false } };
    }
    if (raw === null || raw === "") {
      return { ok: false, failure: "MISSING_CREDENTIAL", reason: "credencial ausente" };
    }
    const hash = hashToken(raw);
    let achado: TokenRecord | null = null;
    // Percorre TODOS os registros comparando em tempo constante, sem sair no
    // primeiro acerto: um `Map.get` direto responderia mais rápido para hash
    // inexistente do que para existente.
    for (const [h, rec] of this.#tokens) {
      if (equalsConstantTime(h, hash)) achado = rec;
    }
    if (achado === null) {
      return { ok: false, failure: "INVALID_CREDENTIAL", reason: "credencial inválida" };
    }
    if (achado.revoked) {
      return { ok: false, failure: "REVOKED_CREDENTIAL", reason: "credencial revogada" };
    }
    if (achado.expires_at !== null && this.#now() >= achado.expires_at) {
      return { ok: false, failure: "EXPIRED_CREDENTIAL", reason: "credencial expirada" };
    }
    return { ok: true, token: achado };
  }

  /**
   * Autoriza uma operação para um token já autenticado.
   *
   * `ADMIN` NÃO implica os demais escopos. Hierarquia implícita é como um token
   * de observação acaba com poder de controle: basta alguém decidir, meses
   * depois, que "admin pode tudo". Quem precisa de vários escopos recebe vários.
   */
  authorize(token: TokenRecord, required: Scope, session_id?: string | null): AuthResult {
    if (this.disabled) return { ok: true, token };
    if (!token.scopes.includes(required)) {
      return { ok: false, failure: "SCOPE_DENIED", reason: `escopo ${required} não concedido a ${token.subject}`, required };
    }
    if (session_id !== undefined && session_id !== null && token.session_allowlist.size > 0 && !token.session_allowlist.has(session_id)) {
      return { ok: false, failure: "SESSION_NOT_OWNED", reason: "token não tem acesso a esta sessão" };
    }
    return { ok: true, token };
  }

  /** Amarra um token a uma sessão criada por ele. */
  bindSession(token: TokenRecord, session_id: string): void {
    if (token.session_allowlist.size > 0) token.session_allowlist.add(session_id);
  }

  stats(): { tokens: number; revogados: number; expirados: number } {
    let revogados = 0;
    let expirados = 0;
    const agora = this.#now();
    for (const r of this.#tokens.values()) {
      if (r.revoked) revogados++;
      if (r.expires_at !== null && agora >= r.expires_at) expirados++;
    }
    return { tokens: this.#tokens.size, revogados, expirados };
  }
}

/**
 * FASE 10 — DELEGAÇÃO DE IDENTIDADE.
 *
 * O executor de passo de `browser.task` mora DENTRO do daemon e fala com a
 * própria API por loopback com o token raiz. Sob `allow_unleased: false` isso o
 * faria agir como `daemon-root`, e não como o agente cujo plano ele executa —
 * e aí ou a task seria barrada (o dono é outro), ou passaria por um caminho
 * privilegiado que nenhum cliente tem. As duas saídas são erradas.
 *
 * Este header resolve dizendo a verdade: "sou o daemon, agindo POR fulano".
 * Só um token ADMIN pode usá-lo — do contrário qualquer portador de token de
 * agente escolheria de quem ser, e a arbitragem de lease viraria decoração.
 */
export const DELEGATION_HEADER = "x-nomos-on-behalf-of" as const;

export type PrincipalResult =
  | { ok: true; holder: string; delegated: boolean }
  | { ok: false; reason: string; failure: AuthFailure };

/**
 * Quem, para efeito de LEASE, está pedindo isto.
 *
 * NÃO é `x-nomos-client`. Aquele header é auto-declarado e não passa por
 * verificação alguma: usá-lo como identidade de arbitragem deixaria qualquer
 * processo local dizer "eu sou o agente-A" e herdar o controle da sessão dele.
 * A identidade de controle é o SUJEITO DO TOKEN, que é a única coisa aqui que
 * alguém precisou provar. `x-nomos-client` continua valendo como rótulo de
 * auditoria — dizer quem agiu é diferente de decidir quem pode.
 */
export function principalFor(
  token: TokenRecord,
  headers: Record<string, string | string[] | undefined>,
): PrincipalResult {
  const cru = headers[DELEGATION_HEADER];
  const pedido = typeof cru === "string" ? cru.trim() : "";
  if (pedido === "") return { ok: true, holder: token.subject, delegated: false };
  if (!token.scopes.includes("ADMIN")) {
    return {
      ok: false,
      failure: "SCOPE_DENIED",
      reason: `delegação via ${DELEGATION_HEADER} exige escopo ADMIN; ${token.subject} não o tem`,
    };
  }
  return { ok: true, holder: pedido, delegated: true };
}

/** Escopo exigido por uma ferramenta. Desconhecida ⇒ ADMIN (fail closed). */
export function scopeForTool(tool: string): Scope {
  const s = TOOL_SCOPE[tool];
  if (s !== undefined) return s;
  // Ferramenta que existe no contrato mas ninguém mapeou não pode cair num
  // escopo brando por descuido.
  return ACTION_CLASS[tool] === "OBSERVE" ? "OBSERVE" : "ADMIN";
}

/** Escopo exigido por uma rota de gestão. Desconhecida ⇒ ADMIN (fail closed). */
export function scopeForRoute(route: string): Scope {
  return ROUTE_SCOPE[route] ?? "ADMIN";
}

/** Lê o token do daemon do disco. Usado por CLI e SDK locais. */
export function readControlToken(runtime_dir: string = DEFAULT_RUNTIME_DIR): string | null {
  const alvo = path.join(runtime_dir, TOKEN_FILE);
  if (!existsSync(alvo)) return null;
  const st = statSync(alvo);
  // Arquivo de credencial legível por outros é credencial comprometida. Recusar
  // é mais honesto que corrigir a permissão em silêncio e seguir usando.
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`auth: ${alvo} tem permissão larga (${(st.mode & 0o777).toString(8)}); esperado 600`);
  }
  const v = readFileSync(alvo, "utf8").trim();
  return v === "" ? null : v;
}
