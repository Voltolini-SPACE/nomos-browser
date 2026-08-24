/**
 * FASE 9 — ARBITRAGEM DE CONTROLE ENTRE AGENTES (LEASE / OWNERSHIP)
 *
 * `session.handoff()` troca o DONO da sessão — mas trocar o dono não impede
 * ninguém de agir. Entre o handoff e a primeira ação de B, o agente A continua
 * podendo mandar um clique, e nada no runtime recusa. Esta é a lacuna que este
 * módulo fecha: um lease é o direito de agir sobre uma sessão, com prazo, com
 * dono único e com identidade verificável.
 *
 * Cinco decisões que definem o valor da arbitragem:
 *
 *  1. SEM JANELA DE CHECK-THEN-ACT. `acquire`, `release`, `renew`, `check` e
 *     `transfer` são SÍNCRONOS por construção. Não existe `await` entre "vi que
 *     estava livre" e "tomei" — que é exatamente onde a corrida nasce. Em JS
 *     single-thread um corpo sem `await` é um turno indivisível. Isso só vale
 *     como evidência porque o teste traz o controle negativo: a MESMA bateria de
 *     64 tentativas contra uma implementação com um await no meio produz vários
 *     vencedores. Sem esse par, "não houve corrida" seria indistinguível de
 *     "o teste não sabe detectar corrida".
 *
 *  2. RELÓGIO INJETÁVEL. O TTL existe para o lease não ficar preso quando o dono
 *     some. Verificar expiração com `Date.now()` direto tornaria o teste refém de
 *     sleep. O relógio entra por `options.now`; um relógio que devolve algo que
 *     não é número finito ABORTA a arbitragem em vez de arbitrar errado.
 *
 *  3. FENCING TOKEN + APOSENTADORIA DE lease_id. Cada nova concessão numa sessão
 *     recebe um número monotônico. `lease_id` expirado, liberado ou transferido é
 *     aposentado e nunca mais vale — quem chega com ele é negado por
 *     `stale_lease_id`/`expired`, e não confundido com "nunca teve lease".
 *
 *  4. TRANSFER É UM ÚNICO TURNO. Não é `release()` seguido de `acquire()`: seria
 *     um instante com zero donos, e um terceiro poderia entrar nele. O `transfer`
 *     revoga e concede na mesma volta e emite UM evento.
 *
 *  5. FAIL CLOSED. Sessão sem lease nega por padrão; ferramenta desconhecida
 *     exige `exclusive`; classe ausente é tratada como ACT; entrada inválida não
 *     concede nada; hook quebrado não solta o lease de ninguém.
 *
 * FRONTEIRA COM O CONTRATO v1 — `CONTROL_NOT_OWNED` **não** existe em
 * `ActionErrorCode`. O enum é fechado e `contract.ts` não se edita. Então o nome
 * próprio é constante DESTE módulo e vai para a API mapeado em
 * `CAPABILITY_DENIED`, preservado em `detail.lease_reason`. Promover
 * `CONTROL_NOT_OWNED` a código de primeira classe exige contrato v2.
 *
 * Idem para eventos: `EventName` também é fechado, então a arbitragem reaproveita
 * `control.taken` / `control.returned` / `session.handoff` / `action.failed` com
 * `payload.kind = "lease"`. Uma família `lease.*` também exige v2.
 *
 * Este módulo não importa o event bus (art. de desacoplamento): recebe um hook
 * `onEvent` opcional, como `session.ts`.
 */
import {
  ACTION_CLASS,
  newId,
  type ActionClass,
  type ActionError,
  type ActionErrorCode,
  type EventName,
  type RuntimeEvent,
} from "./contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Nome próprio e sua tradução para o contrato v1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Motivo de recusa de quem tenta agir sem deter o lease. É o nome exigido pela
 * FASE 9 e NÃO é um `ActionErrorCode` — ver `CONTROL_NOT_OWNED_CODE`.
 */
export const CONTROL_NOT_OWNED = "CONTROL_NOT_OWNED" as const;
export type ControlNotOwned = typeof CONTROL_NOT_OWNED;

/** Código do contrato v1 usado na fronteira da API para `CONTROL_NOT_OWNED`. */
export const CONTROL_NOT_OWNED_CODE: ActionErrorCode = "CAPABILITY_DENIED";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `exclusive` — um único holder, exigido para ACT/COMMIT.
 * `shared`    — vários holders simultâneos, admissível só para OBSERVE.
 */
export type LeaseMode = "exclusive" | "shared";

export type LeaseReason =
  | "GRANTED"
  | "REENTRANT"
  | "RELEASED"
  | ControlNotOwned
  | "INVALID_REQUEST";

/** Detalhe do motivo. `reason` diz o que aconteceu; `cause` diz por quê. */
export type LeaseCause =
  | "unleased"
  | "held_by_other"
  | "shared_conflict"
  | "mode_insufficient"
  | "expired"
  | "stale_lease_id"
  | "invalid_input";

export interface Lease {
  /** Discriminante da união `Lease | LeaseDenied`. */
  readonly granted: true;
  lease_id: string;
  session_id: string;
  holder: string;
  mode: LeaseMode;
  ttl_ms: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  /** Epoch ms — comparar prazo sem reparsear ISO a cada checagem. */
  expires_at_ms: number;
  /** Quantas vezes ESTE lease_id foi renovado ou re-adquirido. */
  renewals: number;
  /** true quando esta concessão foi re-aquisição pelo mesmo holder. */
  reentrant: boolean;
  /** Monotônico por sessão: cresce a cada NOVA concessão, nunca a cada renovação. */
  fencing_token: number;
}

export interface LeaseDenied {
  readonly granted: false;
  reason: LeaseReason;
  cause: LeaseCause;
  message: string;
  session_id: string;
  /** Quem detém o controle exclusivo agora; `null` em regime shared ou sem lease. */
  current_holder: string | null;
  holders: string[];
  mode: LeaseMode | null;
  expires_at: string | null;
  /** Código do contrato v1 — já traduzido para a fronteira da API. */
  code: ActionErrorCode;
}

export type LeaseResult = Lease | LeaseDenied;

export interface LeaseRelease {
  released: boolean;
  reason: LeaseReason;
  cause: LeaseCause | null;
  message: string;
  session_id: string;
  holder: string;
  lease_id: string;
  current_holder: string | null;
  holders: string[];
  code: ActionErrorCode | null;
}

export interface LeaseCheck {
  allowed: boolean;
  reason: LeaseReason;
  cause: LeaseCause | null;
  message: string;
  session_id: string;
  holder: string;
  current_holder: string | null;
  holders: string[];
  /** Modo que o holder de fato detém; `null` quando não detém nada. */
  mode: LeaseMode | null;
  /** Modo exigido pela ação consultada. */
  required_mode: LeaseMode;
  lease_id: string | null;
  expires_at: string | null;
  code: ActionErrorCode | null;
}

export interface LeaseSnapshot {
  session_id: string;
  /** Regime vigente: `exclusive` se alguém tem exclusivo, `shared` se há shared. */
  mode: LeaseMode | null;
  current_holder: string | null;
  holders: string[];
  leases: Lease[];
  fencing_token: number;
}

export interface LeaseStats {
  granted: number;
  reentrant: number;
  denied: number;
  released: number;
  renewed: number;
  transferred: number;
  expired: number;
  /** Exceções lançadas pelo hook `onEvent` — contadas, nunca engolidas. */
  hook_errors: number;
  sessions: number;
  live_leases: number;
}

export interface AcquireOptions {
  ttl_ms?: number;
  mode?: LeaseMode;
}

export interface CheckOptions {
  /** Precedência: `mode` > `tool` > `class` > ACT (fail closed). */
  mode?: LeaseMode;
  tool?: string;
  class?: ActionClass;
  /** Quando informado, tem de bater com o lease corrente do holder. */
  lease_id?: string;
}

export interface TransferOptions {
  /** Quando informado, tem de bater com o lease corrente de `from`. */
  lease_id?: string;
  ttl_ms?: number;
  mode?: LeaseMode;
}

export interface LeaseManagerOptions {
  /** Relógio injetável. Default `Date.now`. Nada neste módulo chama Date.now direto. */
  now?: () => number;
  default_ttl_ms?: number;
  max_ttl_ms?: number;
  /**
   * Sessão SEM lease algum: negar (default, fail closed) ou permitir.
   * Existe para migração de chamador que ainda não adquire lease, e é um ato
   * explícito e visível — nunca inferido, como `allow_internal` em policy.ts.
   */
  allow_unleased?: boolean;
  onEvent?: (event: RuntimeEvent) => void;
  /** Quantos lease_id aposentados ficam memorizados por sessão. */
  max_retired_per_session?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LEASE_MODE: LeaseMode = "exclusive";
export const DEFAULT_TTL_MS = 60_000;
/** Teto de TTL: lease de 30 dias é lease preso com outro nome. */
export const MAX_TTL_MS = 86_400_000;
export const DEFAULT_RETIRED_MEMORY = 64;
/** Nome/id vindos de fora viram chave de Map: limitar é controle de memória. */
export const MAX_NAME_LENGTH = 128;

const REASON_CODE: Readonly<Record<LeaseReason, ActionErrorCode | null>> = Object.freeze({
  GRANTED: null,
  REENTRANT: null,
  RELEASED: null,
  CONTROL_NOT_OWNED: CONTROL_NOT_OWNED_CODE,
  INVALID_REQUEST: "INVALID_REQUEST",
});

// ─────────────────────────────────────────────────────────────────────────────
// Modo exigido por classe de ação — a fonte é o contrato, não uma tabela nova
// ─────────────────────────────────────────────────────────────────────────────

/** OBSERVE aceita `shared`; ACT/COMMIT e classe desconhecida exigem `exclusive`. */
export function requiredMode(klass: ActionClass | null | undefined): LeaseMode {
  return klass === "OBSERVE" ? "shared" : "exclusive";
}

/**
 * Modo exigido por ferramenta da API v1. Ferramenta que não consta em
 * `ACTION_CLASS` exige `exclusive` — fail closed, igual ao policy engine.
 * `Object.hasOwn` é obrigatório: acesso indexado acharia `Object.prototype` e
 * uma "ferramenta" chamada `toString` receberia uma função truthy como classe.
 */
export function requiredModeForTool(tool: unknown): LeaseMode {
  if (typeof tool !== "string" || !Object.hasOwn(ACTION_CLASS, tool)) return "exclusive";
  return requiredMode(ACTION_CLASS[tool]);
}

/** Um lease `exclusive` satisfaz qualquer exigência; `shared` só satisfaz `shared`. */
export function modeSatisfies(held: LeaseMode, needed: LeaseMode): boolean {
  return held === "exclusive" || needed === "shared";
}

// ─────────────────────────────────────────────────────────────────────────────
// Erros
// ─────────────────────────────────────────────────────────────────────────────

/** Erro lançado por `assertControl` — carrega a recusa inteira até a borda da API. */
export class LeaseError extends Error {
  readonly code: ActionErrorCode;
  readonly lease_reason: LeaseReason;
  readonly lease_cause: LeaseCause | null;
  readonly denial: LeaseDenied | LeaseCheck;

  constructor(denial: LeaseDenied | LeaseCheck) {
    super(denial.message);
    this.name = "LeaseError";
    this.code = denial.code ?? CONTROL_NOT_OWNED_CODE;
    this.lease_reason = denial.reason;
    this.lease_cause = denial.cause;
    this.denial = denial;
  }

  toActionError(): ActionError {
    return leaseActionError(this.denial);
  }
}

/**
 * Relógio injetado devolveu lixo. Não é caminho de usuário: é defeito de quem
 * montou o manager. Arbitrar com um relógio inválido seria pior que abortar.
 */
export class LeaseClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseClockError";
  }
}

/**
 * Traduz a recusa para o envelope do contrato. O código é sempre um
 * `ActionErrorCode` legal; o nome próprio sobrevive em `detail.lease_reason`.
 */
export function leaseActionError(d: LeaseDenied | LeaseCheck): ActionError {
  return {
    code: d.code ?? CONTROL_NOT_OWNED_CODE,
    message: d.message,
    detail: {
      lease_reason: d.reason,
      lease_cause: d.cause,
      session_id: d.session_id,
      current_holder: d.current_holder,
      holders: [...d.holders],
      mode: d.mode,
    },
  };
}

export function isLease(r: LeaseResult): r is Lease {
  return r.granted === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estruturas internas
// ─────────────────────────────────────────────────────────────────────────────

interface LeaseRecord {
  lease_id: string;
  session_id: string;
  holder: string;
  mode: LeaseMode;
  ttl_ms: number;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
  renewals: number;
  fencing_token: number;
}

type RetiredKind = "expired" | "revoked";

interface SessionEntry {
  session_id: string;
  /** Um lease por holder. Re-aquisição é reentrante, não empilha. */
  holders: Map<string, LeaseRecord>;
  /** Monotônico: nunca reinicia, nem quando a sessão fica sem holder. */
  counter: number;
  /** lease_id aposentados, em ordem de aposentadoria (Map preserva inserção). */
  retired: Map<string, RetiredKind>;
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_NAME_LENGTH;
}

// ─────────────────────────────────────────────────────────────────────────────

export class LeaseManager {
  readonly default_ttl_ms: number;
  readonly max_ttl_ms: number;
  readonly allow_unleased: boolean;

  #clock: () => number;
  #sessions = new Map<string, SessionEntry>();
  #onEvent: ((event: RuntimeEvent) => void) | null;
  #maxRetired: number;
  #stats = {
    granted: 0,
    reentrant: 0,
    denied: 0,
    released: 0,
    renewed: 0,
    transferred: 0,
    expired: 0,
    hook_errors: 0,
  };

  constructor(opts: LeaseManagerOptions = {}) {
    this.#clock = opts.now ?? Date.now;
    if (typeof this.#clock !== "function") {
      throw new LeaseClockError("options.now deve ser função que devolve epoch ms");
    }
    this.default_ttl_ms = normalizeTtlOrThrow(opts.default_ttl_ms ?? DEFAULT_TTL_MS, "default_ttl_ms");
    this.max_ttl_ms = normalizeTtlOrThrow(opts.max_ttl_ms ?? MAX_TTL_MS, "max_ttl_ms");
    if (this.default_ttl_ms > this.max_ttl_ms) {
      throw new LeaseClockError(
        `default_ttl_ms (${this.default_ttl_ms}) não pode exceder max_ttl_ms (${this.max_ttl_ms})`,
      );
    }
    this.allow_unleased = opts.allow_unleased === true;
    this.#onEvent = opts.onEvent ?? null;
    this.#maxRetired = Math.max(1, opts.max_retired_per_session ?? DEFAULT_RETIRED_MEMORY);
  }

  /** Hook injetado depois da construção — o bus não é importado aqui. */
  set onEvent(hook: ((event: RuntimeEvent) => void) | null) {
    this.#onEvent = hook;
  }

  // ── acquire ───────────────────────────────────────────────────────────────

  /**
   * Toma o lease. SÍNCRONO de propósito: sem `await` entre a verificação e a
   * escrita não existe janela para dois vencedores.
   * Nunca lança por entrada ruim — devolve `LeaseDenied` com `INVALID_REQUEST`.
   */
  acquire(session_id: string, holder: string, opts: AcquireOptions = {}): LeaseResult {
    const bad = this.#validate(session_id, holder, "acquire");
    if (bad !== null) return bad;

    const mode = opts.mode ?? DEFAULT_LEASE_MODE;
    if (mode !== "exclusive" && mode !== "shared") {
      return this.#invalid(session_id, `modo de lease inválido: ${JSON.stringify(opts.mode)}`, "acquire");
    }
    const ttl = this.#ttl(opts.ttl_ms);
    if (ttl === null) {
      return this.#invalid(
        session_id,
        `ttl_ms inválido: ${String(opts.ttl_ms)} — exigido inteiro em (0, ${this.max_ttl_ms}]`,
        "acquire",
      );
    }

    const now = this.#nowMs();
    const entry = this.#entry(session_id);
    this.#reapEntry(entry, now);

    const mine = entry.holders.get(holder);
    const others = [...entry.holders.values()].filter((r) => r.holder !== holder);

    if (mine !== undefined) {
      // REENTRÂNCIA: o mesmo holder não pode se auto-bloquear. Mantém o MESMO
      // lease_id de propósito — invalidar o próprio lease em voo do dono seria
      // fabricar um `stale_lease_id` contra quem já tinha o direito.
      if (mode === "exclusive" && others.length > 0) {
        return this.#deny(entry, holder, "shared_conflict", mode, "acquire");
      }
      mine.mode = mode;
      mine.ttl_ms = ttl;
      mine.renewed_at_ms = now;
      mine.expires_at_ms = now + ttl;
      mine.renewals += 1;
      this.#stats.reentrant += 1;
      return this.#toLease(mine, true);
    }

    if (others.length > 0) {
      const exclusiveHeld = others.some((r) => r.mode === "exclusive");
      if (exclusiveHeld || mode === "exclusive") {
        return this.#deny(entry, holder, exclusiveHeld ? "held_by_other" : "shared_conflict", mode, "acquire");
      }
      // shared + shared coexistem: é o caso OBSERVE.
    }

    entry.counter += 1;
    const rec: LeaseRecord = {
      lease_id: newId("lease"),
      session_id,
      holder,
      mode,
      ttl_ms: ttl,
      acquired_at_ms: now,
      renewed_at_ms: now,
      expires_at_ms: now + ttl,
      renewals: 0,
      fencing_token: entry.counter,
    };
    entry.holders.set(holder, rec);
    this.#stats.granted += 1;

    const lease = this.#toLease(rec, false);
    this.#emit("control.taken", session_id, holder, {
      kind: "lease",
      op: "acquire",
      lease_id: rec.lease_id,
      holder,
      mode,
      ttl_ms: ttl,
      expires_at: lease.expires_at,
      fencing_token: rec.fencing_token,
    });
    return lease;
  }

  // ── release ───────────────────────────────────────────────────────────────

  /**
   * Devolve o lease. `lease_id` é OBRIGATÓRIO: soltar por nome de holder deixaria
   * um lease velho derrubar o lease novo do mesmo agente após uma expiração.
   * Quem não é dono é negado e NADA é removido.
   */
  release(session_id: string, holder: string, lease_id: string): LeaseRelease {
    const bad = this.#validate(session_id, holder, "release");
    if (bad !== null) {
      // Entrada inválida não pode vazar `null`/número para dentro do recibo:
      // um recibo com holder mentiroso é pior que um recibo vazio.
      return this.#releaseFrom(
        bad,
        typeof holder === "string" ? holder : "",
        typeof lease_id === "string" ? lease_id : "",
      );
    }
    if (!isName(lease_id)) {
      return this.#releaseFrom(
        this.#invalid(session_id, "lease_id é obrigatório no release", "release"),
        holder,
        "",
      );
    }

    const now = this.#nowMs();
    const entry = this.#entryOrEmpty(session_id);
    this.#reapEntry(entry, now);

    const mine = entry.holders.get(holder);
    if (mine === undefined) {
      return this.#releaseFrom(this.#deny(entry, holder, this.#absentCause(entry, lease_id), null, "release"), holder, lease_id);
    }
    if (mine.lease_id !== lease_id) {
      return this.#releaseFrom(this.#deny(entry, holder, "stale_lease_id", null, "release"), holder, lease_id);
    }

    entry.holders.delete(holder);
    this.#retire(entry, mine.lease_id, "revoked");
    this.#stats.released += 1;
    this.#emit("control.returned", session_id, holder, {
      kind: "lease",
      op: "release",
      lease_id: mine.lease_id,
      holder,
      mode: mine.mode,
      fencing_token: mine.fencing_token,
    });

    return {
      released: true,
      reason: "RELEASED",
      cause: null,
      message: `lease ${mine.lease_id} liberado por ${holder}`,
      session_id,
      holder,
      lease_id,
      current_holder: this.#currentHolder(entry),
      holders: [...entry.holders.keys()],
      code: null,
    };
  }

  // ── renew ─────────────────────────────────────────────────────────────────

  /** Estende o prazo A PARTIR DE AGORA. Lease expirado não renova — já morreu. */
  renew(session_id: string, holder: string, lease_id: string, opts: { ttl_ms?: number } = {}): LeaseResult {
    const bad = this.#validate(session_id, holder, "renew");
    if (bad !== null) return bad;
    if (!isName(lease_id)) return this.#invalid(session_id, "lease_id é obrigatório no renew", "renew");

    const ttl = opts.ttl_ms === undefined ? null : this.#ttl(opts.ttl_ms);
    if (opts.ttl_ms !== undefined && ttl === null) {
      return this.#invalid(session_id, `ttl_ms inválido no renew: ${String(opts.ttl_ms)}`, "renew");
    }

    const now = this.#nowMs();
    const entry = this.#entryOrEmpty(session_id);
    this.#reapEntry(entry, now);

    const mine = entry.holders.get(holder);
    if (mine === undefined) {
      return this.#deny(entry, holder, this.#absentCause(entry, lease_id), null, "renew");
    }
    if (mine.lease_id !== lease_id) {
      return this.#deny(entry, holder, "stale_lease_id", null, "renew");
    }

    if (ttl !== null) mine.ttl_ms = ttl;
    mine.renewed_at_ms = now;
    mine.expires_at_ms = now + mine.ttl_ms;
    mine.renewals += 1;
    this.#stats.renewed += 1;
    return this.#toLease(mine, true);
  }

  // ── check ─────────────────────────────────────────────────────────────────

  /**
   * "Este holder pode agir agora?" — a pergunta que a fronteira de ação faz.
   * Default é ACT (exige `exclusive`): consultar sem dizer a classe não pode
   * render mais permissão do que dizer.
   */
  check(session_id: string, holder: string, opts: CheckOptions = {}): LeaseCheck {
    const needed: LeaseMode =
      opts.mode ??
      (opts.tool !== undefined ? requiredModeForTool(opts.tool) : requiredMode(opts.class ?? "ACT"));

    const bad = this.#validate(session_id, holder, "check");
    if (bad !== null) return this.#checkFrom(bad, typeof holder === "string" ? holder : "", needed, null);

    const now = this.#nowMs();
    const entry = this.#entryOrEmpty(session_id);
    this.#reapEntry(entry, now);

    const mine = entry.holders.get(holder);

    if (mine === undefined) {
      if (entry.holders.size === 0 && this.allow_unleased && !this.#isRetired(entry, opts.lease_id)) {
        return {
          allowed: true,
          reason: "GRANTED",
          cause: null,
          message: `sessão ${session_id} sem lease e allow_unleased ligado explicitamente`,
          session_id,
          holder,
          current_holder: null,
          holders: [],
          mode: null,
          required_mode: needed,
          lease_id: null,
          expires_at: null,
          code: null,
        };
      }
      return this.#checkFrom(
        this.#deny(entry, holder, this.#absentCause(entry, opts.lease_id), needed, "check"),
        holder,
        needed,
        null,
      );
    }

    if (opts.lease_id !== undefined && opts.lease_id !== mine.lease_id) {
      return this.#checkFrom(this.#deny(entry, holder, "stale_lease_id", needed, "check"), holder, needed, mine);
    }
    if (!modeSatisfies(mine.mode, needed)) {
      return this.#checkFrom(this.#deny(entry, holder, "mode_insufficient", needed, "check"), holder, needed, mine);
    }

    return {
      allowed: true,
      reason: "GRANTED",
      cause: null,
      message: `${holder} detém lease ${mine.mode} da sessão ${session_id}`,
      session_id,
      holder,
      current_holder: this.#currentHolder(entry),
      holders: [...entry.holders.keys()],
      mode: mine.mode,
      required_mode: needed,
      lease_id: mine.lease_id,
      expires_at: iso(mine.expires_at_ms),
      code: null,
    };
  }

  /** `check` que lança `LeaseError` — atalho para a camada de API. */
  assertControl(session_id: string, holder: string, opts: CheckOptions = {}): LeaseCheck {
    const d = this.check(session_id, holder, opts);
    if (!d.allowed) throw new LeaseError(d);
    return d;
  }

  // ── transfer ──────────────────────────────────────────────────────────────

  /**
   * Handoff explícito. Revoga o lease de `from` e concede a `to` NO MESMO TURNO:
   * não existe instante observável com dois donos — nem com zero, que é o furo
   * por onde um terceiro entraria. Emite UM evento, não dois.
   */
  transfer(session_id: string, from: string, to: string, opts: TransferOptions = {}): LeaseResult {
    const badFrom = this.#validate(session_id, from, "transfer");
    if (badFrom !== null) return badFrom;
    if (!isName(to)) {
      return this.#invalid(session_id, `destinatário inválido no transfer: ${JSON.stringify(to)}`, "transfer");
    }
    if (from === to) {
      return this.#invalid(session_id, "transfer para o próprio holder não é handoff — use renew", "transfer");
    }
    const mode = opts.mode ?? "exclusive";
    if (mode !== "exclusive" && mode !== "shared") {
      return this.#invalid(session_id, `modo de lease inválido: ${JSON.stringify(opts.mode)}`, "transfer");
    }
    const ttlRequested = opts.ttl_ms === undefined ? undefined : this.#ttl(opts.ttl_ms);
    if (opts.ttl_ms !== undefined && ttlRequested === null) {
      return this.#invalid(session_id, `ttl_ms inválido no transfer: ${String(opts.ttl_ms)}`, "transfer");
    }

    const now = this.#nowMs();
    const entry = this.#entryOrEmpty(session_id);
    this.#reapEntry(entry, now);

    const mine = entry.holders.get(from);
    if (mine === undefined) {
      return this.#deny(entry, from, this.#absentCause(entry, opts.lease_id), mode, "transfer");
    }
    if (opts.lease_id !== undefined && opts.lease_id !== mine.lease_id) {
      return this.#deny(entry, from, "stale_lease_id", mode, "transfer");
    }
    if (entry.holders.size > 1) {
      // Com outros holders shared na sessão, "transferir o controle" não seria
      // atômico: sobraria gente com direito de observar sob o novo dono sem que
      // o novo dono tenha concordado. Fail closed.
      return this.#deny(entry, from, "shared_conflict", mode, "transfer");
    }

    // `mine !== undefined` só é possível numa entrada REGISTRADA — mas reafirmar
    // isso aqui impede que uma refatoração futura escreva o novo lease num
    // objeto transitório, que sumiria em silêncio.
    if (this.#sessions.get(session_id) !== entry) {
      return this.#invalid(session_id, "estado de lease inconsistente no transfer — abortado", "transfer");
    }

    const ttl = ttlRequested ?? mine.ttl_ms;
    entry.counter += 1;
    const rec: LeaseRecord = {
      lease_id: newId("lease"),
      session_id,
      holder: to,
      mode,
      ttl_ms: ttl,
      acquired_at_ms: now,
      renewed_at_ms: now,
      expires_at_ms: now + ttl,
      renewals: 0,
      fencing_token: entry.counter,
    };

    // Mutação completa ANTES de qualquer emissão: hook nunca observa meio-estado.
    entry.holders.delete(from);
    this.#retire(entry, mine.lease_id, "revoked");
    entry.holders.set(to, rec);
    this.#stats.transferred += 1;

    const lease = this.#toLease(rec, false);
    this.#emit("session.handoff", session_id, to, {
      kind: "lease",
      op: "transfer",
      from_holder: from,
      to_holder: to,
      revoked_lease_id: mine.lease_id,
      lease_id: rec.lease_id,
      mode,
      ttl_ms: ttl,
      expires_at: lease.expires_at,
      fencing_token: rec.fencing_token,
    });
    return lease;
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  /** Holder do lease EXCLUSIVO; `null` em regime shared ou sessão sem lease. */
  currentHolder(session_id: string): string | null {
    if (!isName(session_id)) return null;
    const entry = this.#sessions.get(session_id);
    if (entry === undefined) return null;
    this.#reapEntry(entry, this.#nowMs());
    return this.#currentHolder(entry);
  }

  holders(session_id: string): string[] {
    if (!isName(session_id)) return [];
    const entry = this.#sessions.get(session_id);
    if (entry === undefined) return [];
    this.#reapEntry(entry, this.#nowMs());
    return [...entry.holders.keys()];
  }

  snapshot(session_id: string): LeaseSnapshot | null {
    if (!isName(session_id)) return null;
    const entry = this.#sessions.get(session_id);
    if (entry === undefined) return null;
    this.#reapEntry(entry, this.#nowMs());
    const leases = [...entry.holders.values()].map((r) => this.#toLease(r, false));
    return {
      session_id,
      mode: leases.length === 0 ? null : leases.some((l) => l.mode === "exclusive") ? "exclusive" : "shared",
      current_holder: this.#currentHolder(entry),
      holders: [...entry.holders.keys()],
      leases,
      fencing_token: entry.counter,
    };
  }

  sessions(): string[] {
    return [...this.#sessions.keys()];
  }

  stats(): LeaseStats {
    let live = 0;
    for (const entry of this.#sessions.values()) live += entry.holders.size;
    return { ...this.#stats, sessions: this.#sessions.size, live_leases: live };
  }

  // ── Manutenção ────────────────────────────────────────────────────────────

  /**
   * Reap explícito de tudo que expirou. Chamável à mão — a expiração NÃO depende
   * de timer de fundo, então o teste controla o tempo sem sleep.
   */
  sweep(): string[] {
    const now = this.#nowMs();
    const out: string[] = [];
    for (const entry of this.#sessions.values()) out.push(...this.#reapEntry(entry, now));
    return out;
  }

  /** Revoga todos os leases da sessão (uso do daemon ao fechar a sessão). */
  releaseAll(session_id: string, reason = "session_closed"): string[] {
    if (!isName(session_id)) return [];
    const entry = this.#sessions.get(session_id);
    if (entry === undefined) return [];
    const revoked: string[] = [];
    for (const rec of [...entry.holders.values()]) {
      entry.holders.delete(rec.holder);
      this.#retire(entry, rec.lease_id, "revoked");
      revoked.push(rec.lease_id);
      this.#stats.released += 1;
      this.#emit("control.returned", session_id, rec.holder, {
        kind: "lease",
        op: "release_all",
        lease_id: rec.lease_id,
        holder: rec.holder,
        mode: rec.mode,
        reason,
        fencing_token: rec.fencing_token,
      });
    }
    return revoked;
  }

  /** Esquece a sessão inteira, inclusive o fencing token. Só após `releaseAll`. */
  forget(session_id: string): boolean {
    if (!isName(session_id)) return false;
    const entry = this.#sessions.get(session_id);
    if (entry === undefined) return false;
    if (entry.holders.size > 0) {
      throw new LeaseError(this.#deny(entry, "runtime", "held_by_other", null, "forget"));
    }
    return this.#sessions.delete(session_id);
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  #nowMs(): number {
    const t = this.#clock();
    if (typeof t !== "number" || !Number.isFinite(t)) {
      // Arbitrar com relógio quebrado produziria expiração aleatória: abortar é
      // a única resposta honesta.
      throw new LeaseClockError(`relógio injetado devolveu ${String(t)} — arbitragem abortada (fail closed)`);
    }
    return t;
  }

  /** Cria e REGISTRA a sessão. Só `acquire`/`transfer` têm direito a isto. */
  #entry(session_id: string): SessionEntry {
    let entry = this.#sessions.get(session_id);
    if (entry === undefined) {
      entry = { session_id, holders: new Map(), counter: 0, retired: new Map() };
      this.#sessions.set(session_id, entry);
    }
    return entry;
  }

  /**
   * Leitura sem efeito colateral. `check` de um session_id qualquer NÃO pode
   * criar entrada: seria um vetor de crescimento de memória movido por quem só
   * consulta — e consultar não é adquirir.
   */
  #entryOrEmpty(session_id: string): SessionEntry {
    return this.#sessions.get(session_id) ?? { session_id, holders: new Map(), counter: 0, retired: new Map() };
  }

  /** Remove os expirados. Devolve os lease_id que morreram nesta passada. */
  #reapEntry(entry: SessionEntry, now: number): string[] {
    const dead: string[] = [];
    for (const rec of [...entry.holders.values()]) {
      if (rec.expires_at_ms > now) continue;
      entry.holders.delete(rec.holder);
      this.#retire(entry, rec.lease_id, "expired");
      this.#stats.expired += 1;
      dead.push(rec.lease_id);
      this.#emit("control.returned", entry.session_id, rec.holder, {
        kind: "lease",
        op: "expire",
        lease_id: rec.lease_id,
        holder: rec.holder,
        mode: rec.mode,
        expires_at: iso(rec.expires_at_ms),
        fencing_token: rec.fencing_token,
      });
    }
    return dead;
  }

  #retire(entry: SessionEntry, lease_id: string, kind: RetiredKind): void {
    entry.retired.set(lease_id, kind);
    while (entry.retired.size > this.#maxRetired) {
      const oldest = entry.retired.keys().next().value;
      if (oldest === undefined) break;
      entry.retired.delete(oldest);
    }
  }

  #isRetired(entry: SessionEntry, lease_id: string | undefined): boolean {
    return lease_id !== undefined && entry.retired.has(lease_id);
  }

  /**
   * Por que este holder não tem lease? Distinguir "expirou" de "nunca teve" é o
   * que transforma um erro genérico em diagnóstico: com o lease_id em mãos dá
   * para dizer que ele foi aposentado, e por qual motivo.
   */
  #absentCause(entry: SessionEntry, lease_id: string | undefined): LeaseCause {
    const retired = lease_id === undefined ? undefined : entry.retired.get(lease_id);
    if (retired === "expired") return "expired";
    if (retired === "revoked") return "stale_lease_id";
    if (entry.holders.size > 0) return "held_by_other";
    return "unleased";
  }

  #currentHolder(entry: SessionEntry): string | null {
    for (const rec of entry.holders.values()) {
      if (rec.mode === "exclusive") return rec.holder;
    }
    return null;
  }

  #toLease(rec: LeaseRecord, reentrant: boolean): Lease {
    // Cópia congelada: quem recebe o lease não pode esticar o próprio prazo
    // mexendo no objeto devolvido.
    return Object.freeze({
      granted: true as const,
      lease_id: rec.lease_id,
      session_id: rec.session_id,
      holder: rec.holder,
      mode: rec.mode,
      ttl_ms: rec.ttl_ms,
      acquired_at: iso(rec.acquired_at_ms),
      renewed_at: iso(rec.renewed_at_ms),
      expires_at: iso(rec.expires_at_ms),
      expires_at_ms: rec.expires_at_ms,
      renewals: rec.renewals,
      reentrant,
      fencing_token: rec.fencing_token,
    });
  }

  #ttl(raw: unknown): number | null {
    if (raw === undefined) return this.default_ttl_ms;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > this.max_ttl_ms) return null;
    return raw;
  }

  #validate(session_id: unknown, holder: unknown, op: string): LeaseDenied | null {
    if (!isName(session_id)) {
      return this.#invalid(
        typeof session_id === "string" ? session_id : "",
        `session_id inválido: ${JSON.stringify(session_id)}`,
        op,
      );
    }
    if (!isName(holder)) {
      return this.#invalid(session_id, `holder inválido: ${JSON.stringify(holder)}`, op);
    }
    return null;
  }

  #invalid(session_id: string, message: string, op: string): LeaseDenied {
    this.#stats.denied += 1;
    const denied: LeaseDenied = {
      granted: false,
      reason: "INVALID_REQUEST",
      cause: "invalid_input",
      message,
      session_id,
      current_holder: null,
      holders: [],
      mode: null,
      expires_at: null,
      code: REASON_CODE.INVALID_REQUEST!,
    };
    this.#emitDenial(denied, op, null);
    return denied;
  }

  #deny(
    entry: SessionEntry,
    holder: string,
    cause: LeaseCause,
    requested: LeaseMode | null,
    op: string,
  ): LeaseDenied {
    this.#stats.denied += 1;
    const current = this.#currentHolder(entry);
    const holders = [...entry.holders.keys()];
    const mine = entry.holders.get(holder);
    const blocking = mine ?? (current === null ? undefined : entry.holders.get(current));
    const denied: LeaseDenied = {
      granted: false,
      reason: CONTROL_NOT_OWNED,
      cause,
      message: messageFor(entry.session_id, holder, cause, current, holders, requested),
      session_id: entry.session_id,
      current_holder: current,
      holders,
      mode: blocking?.mode ?? null,
      expires_at: blocking === undefined ? null : iso(blocking.expires_at_ms),
      code: CONTROL_NOT_OWNED_CODE,
    };
    this.#emitDenial(denied, op, holder);
    return denied;
  }

  #releaseFrom(d: LeaseDenied, holder: string, lease_id: string): LeaseRelease {
    return {
      released: false,
      reason: d.reason,
      cause: d.cause,
      message: d.message,
      session_id: d.session_id,
      holder,
      lease_id,
      current_holder: d.current_holder,
      holders: d.holders,
      code: d.code,
    };
  }

  #checkFrom(d: LeaseDenied, holder: string, needed: LeaseMode, mine: LeaseRecord | null): LeaseCheck {
    return {
      allowed: false,
      reason: d.reason,
      cause: d.cause,
      message: d.message,
      session_id: d.session_id,
      holder,
      current_holder: d.current_holder,
      holders: d.holders,
      mode: mine?.mode ?? null,
      required_mode: needed,
      lease_id: mine?.lease_id ?? null,
      expires_at: mine === null ? null : iso(mine.expires_at_ms),
      code: d.code,
    };
  }

  #emitDenial(d: LeaseDenied, op: string, holder: string | null): void {
    // Recusa de controle é fato de segurança: some do log só por decisão, nunca
    // por omissão. `action.failed` é o mais próximo no enum fechado do contrato.
    this.#emit("action.failed", d.session_id === "" ? null : d.session_id, holder ?? "runtime", {
      kind: "lease",
      op,
      denied: true,
      reason: d.reason,
      cause: d.cause,
      holder,
      current_holder: d.current_holder,
      holders: d.holders,
    });
  }

  #emit(event: EventName, session_id: string | null, source: string, payload: Record<string, unknown>): void {
    const hook = this.#onEvent;
    if (hook === null) return;
    const e: RuntimeEvent = {
      timestamp: iso(this.#nowMs()),
      session_id,
      action_id: null,
      source,
      event,
      payload,
    };
    try {
      hook(e);
    } catch (err) {
      // Hook quebrado não pode soltar o lease de ninguém nem derrubar a
      // arbitragem — mas também não some: fica em stats().hook_errors.
      this.#stats.hook_errors += 1;
      console.error(`[lease] hook onEvent lançou em ${event}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares de módulo
// ─────────────────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizeTtlOrThrow(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LeaseClockError(`${field} inválido: ${String(value)} — exigido inteiro positivo em ms`);
  }
  return value;
}

function messageFor(
  session_id: string,
  holder: string,
  cause: LeaseCause,
  current: string | null,
  holders: string[],
  requested: LeaseMode | null,
): string {
  const alvo = `sessão ${session_id}`;
  switch (cause) {
    case "held_by_other":
      return `${holder} não detém o lease de ${alvo} — controle é de ${current ?? holders.join(", ")}`;
    case "shared_conflict":
      return `${holder} pediu lease ${requested ?? "exclusive"} em ${alvo}, mas há lease shared ativo de ${holders.join(", ")}`;
    case "mode_insufficient":
      return `${holder} detém lease shared em ${alvo}; a ação pedida exige exclusive`;
    case "expired":
      return `lease de ${holder} em ${alvo} expirou por TTL e não vale mais`;
    case "stale_lease_id":
      return `lease_id apresentado por ${holder} em ${alvo} está obsoleto (aposentado)`;
    case "unleased":
      return `${alvo} não tem lease e allow_unleased está desligado (fail closed)`;
    default:
      return `controle não pertence a ${holder} em ${alvo}`;
  }
}
