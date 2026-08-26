/**
 * FASE 3 / 27 / 28 / 32 — SESSION MANAGER
 *
 * Gerencia sessões, contextos (perfis), páginas e o worker pool.
 *
 * Três invariantes que este módulo existe para sustentar:
 *
 *  1. DETACH NÃO MATA (FASE 3). Desconectar o cliente derruba a *conexão*, não a
 *     sessão. O Chromium continua vivo, a página continua na mesma URL, os
 *     cookies continuam no perfil. A sessão vira órfã (attached_client=null,
 *     status IDLE) e um attach posterior devolve o mesmo estado. Sem isto o
 *     runtime seria mais uma automação de vida curta.
 *
 *  2. PERFIL É FRONTEIRA DE COOKIE (FASE 27). Cada perfil tem seu próprio
 *     userDataDir e seu próprio processo de Chromium (launchPersistentContext).
 *     Dois perfis nunca compartilham jar — nem para o mesmo host. O perfil
 *     "sandbox" é efêmero: dir temporário, apagado no close, e cada sessão
 *     sandbox ganha um contexto só dela.
 *
 *  3. DEVOLVER CONTROLE NÃO É PRESUMIR ESTADO (FASE 32). Depois de um takeover
 *     humano, `release` NÃO volta para ACTIVE: volta para RECOVERING com
 *     needs_reobservation=true. Assumir que a página continua onde o agente
 *     deixou seria mentira — o humano pode ter navegado para qualquer lugar.
 *     Só `markObserved()` (chamado por quem de fato reobservou) libera ACTIVE.
 *
 * Backpressure (FASE 28): o pool tem teto. Estourar devolve BACKPRESSURE_REJECTED
 * imediatamente — não enfileira, não espera, não degrada em silêncio.
 *
 * Este módulo não importa o event bus: recebe um hook `onEvent` opcional que o
 * daemon injeta (art. de desacoplamento).
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CAPABILITY,
  RESTRICTED_CAPABILITIES,
  fail,
  newActionId,
  newId,
  nowIso,
  ok,
  timer,
  type ActionError,
  type ActionErrorCode,
  type ActionResponse,
  type Capabilities,
  type EventName,
  type PageInfo,
  type RuntimeEvent,
  type SessionInfo,
  type SessionState,
} from "./contract.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Raiz normativa dos perfis persistentes: <repo>/profiles/<perfil>/ */
export const DEFAULT_PROFILES_ROOT = path.resolve(HERE, "..", "..", "..", "profiles");

/** Perfil efêmero por definição: não persiste em disco entre execuções. */
export const EPHEMERAL_PROFILE = "sandbox";

export const DEFAULT_PROFILE = "default";

/**
 * Nome de perfil vira caminho em disco. Validar aqui é controle de traversal,
 * não estética: "../../etc" não pode virar userDataDir.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Erro tipado — carrega o ActionErrorCode do contrato até a borda da API
// ─────────────────────────────────────────────────────────────────────────────

export class SessionError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ActionErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.detail = detail;
  }

  toActionError(): ActionError {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isSessionError(e: unknown): e is SessionError {
  return e instanceof SessionError;
}

/**
 * Converte qualquer falha em ActionError. Erro desconhecido não vira "sucesso
 * degradado" nem mensagem genérica: vira INTERNAL com a mensagem original.
 */
export function toActionError(e: unknown): ActionError {
  if (isSessionError(e)) return e.toActionError();
  const message = e instanceof Error ? e.message : String(e);
  return { code: "INTERNAL", message, detail: { kind: e instanceof Error ? e.name : typeof e } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Máquina de estados
// ─────────────────────────────────────────────────────────────────────────────

/** Transições legais. Fora desta tabela = erro explícito, nunca coerção. */
export const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = Object.freeze({
  CREATED: ["ACTIVE", "IDLE", "PAUSED", "FAILED", "CLOSED"],
  ACTIVE: ["IDLE", "PAUSED", "RECOVERING", "FAILED", "CLOSED"],
  IDLE: ["ACTIVE", "PAUSED", "RECOVERING", "FAILED", "CLOSED"],
  PAUSED: ["ACTIVE", "IDLE", "RECOVERING", "FAILED", "CLOSED"],
  // PAUSED entra aqui pela missão EMBEDDED_AGENT_UX: takeover (e a parada de
  // emergência, que congela via takeover) precisam funcionar TAMBÉM enquanto a
  // reobservação está pendente. O E2E do painel achou o buraco: release deixava
  // a sessão em RECOVERING e o botão PARAR falhava com "transição inválida" —
  // um freio que depende do estado do agente não é um freio.
  RECOVERING: ["ACTIVE", "IDLE", "PAUSED", "FAILED", "CLOSED"],
  FAILED: ["RECOVERING", "CLOSED"],
  CLOSED: [],
} as Record<SessionState, readonly SessionState[]>);

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return from !== "CLOSED";
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Opções
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  owner: string;
  profile?: string;
  capabilities?: Partial<Capabilities>;
  headless?: boolean;
  /** Cliente já conectado no ato da criação; null = sessão nasce órfã. */
  client?: string | null;
  task?: string | null;
  /** URL inicial. Falha de navegação derruba a criação (sem sessão meia-viva). */
  url?: string;
}

export interface SessionManagerOptions {
  /** Teto do worker pool. Sessão viva ocupa um slot. */
  max_workers?: number;
  /** Janela de ociosidade para reaping. Só tem efeito com reap_idle=true. */
  idle_timeout_ms?: number;
  /**
   * Default false DE PROPÓSITO: reaping automático mataria exatamente a sessão
   * órfã que a FASE 3 exige manter viva. Quem quiser reciclar liga explicitamente.
   */
  reap_idle?: boolean;
  sweep_interval_ms?: number;
  profiles_root?: string;
  /** Default do produto: headful — takeover humano precisa de janela visível. */
  headless?: boolean;
  viewport?: { width: number; height: number };
  /**
   * DPR do contexto (`deviceScaleFactor`). Default 1. As coordenadas do runtime
   * são CSS px em qualquer DPR — o que muda é só a resolução do bitmap. Isto
   * está aqui para que essa afirmação possa ser MEDIDA contra um Chromium de
   * DPR 2 de verdade (tests/click-entrega.test.ts), em vez de assumida.
   */
  device_scale_factor?: number;
  /**
   * Missão EMBEDDED_AGENT_UX: extensão descompactada carregada no Chromium do
   * runtime (`--load-extension`). A extensão é UI — cliente da API v1 com
   * token, como o console. Ela NÃO ganha autoridade por morar dentro da janela.
   */
  extension_dir?: string | null;
  onEvent?: (event: RuntimeEvent) => void;
  /** Quantas sessões CLOSED ficam consultáveis antes da poda. */
  max_closed_retained?: number;
}

export interface PoolStats {
  workers: { active: number; max: number };
  sessions: { total: number; active: number; idle: number; paused: number };
  contexts: number;
  /** Erros lançados pelo hook onEvent do daemon — visíveis, não engolidos. */
  hook_errors: number;
}

export interface ContextInfo {
  context_id: string;
  profile: string;
  user_data_dir: string;
  ephemeral: boolean;
  headless: boolean;
  sessions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estruturas internas
// ─────────────────────────────────────────────────────────────────────────────

interface PageRecord {
  info: PageInfo;
  page: Page;
}

interface ContextEntry {
  key: string;
  context_id: string;
  profile: string;
  context: BrowserContext;
  user_data_dir: string;
  ephemeral: boolean;
  headless: boolean;
  sessions: Set<string>;
  /** Guard para distinguir close nosso de morte do browser. */
  closing: boolean;
  /** Sessão a quem atribuir a próxima página criada por nós. */
  pending_for: string | null;
  /** Fila que serializa criação de página por contexto (evita atribuição trocada). */
  queue: Promise<void>;
}

interface SessionRecord {
  session_id: string;
  owner: string;
  profile: string;
  permissions: Capabilities;
  created_at: string;
  last_activity: string;
  context_key: string;
  context_id: string;
  task: string | null;
  status: SessionState;
  control: "agent" | "human";
  attached_client: string | null;
  pages: Map<string, PageRecord>;
  /**
   * Abas que FORAM desta sessão e já fecharam.
   *
   * Existe para separar duas perguntas que, sem ela, têm a mesma resposta:
   * "esta aba morreu" e "esta aba nunca foi sua". Um cliente que guardou um
   * `page_id` e o usa depois de o navegador cair recebia "não pertence à
   * sessão" — que soa como bug dele, quando o que houve foi o navegador morrer.
   *
   * Limitada a `MAX_ABAS_FECHADAS`: memória de aba morta é conveniência de
   * diagnóstico, não registro histórico, e não pode crescer sem teto numa
   * sessão longa que abre e fecha abas.
   */
  closed_pages: Set<string>;
  active_page_id: string | null;
  needs_reobservation: boolean;
}

/** Teto da memória de abas fechadas por sessão. */
const MAX_ABAS_FECHADAS = 64;

// ─────────────────────────────────────────────────────────────────────────────

export class SessionManager {
  readonly max_workers: number;
  readonly profiles_root: string;

  #sessions = new Map<string, SessionRecord>();
  #contexts = new Map<string, ContextEntry>();
  /** Launch em voo por chave de contexto — dedupe de corrida. */
  #launching = new Map<string, Promise<ContextEntry>>();
  #pageIds = new WeakMap<Page, string>();
  #reserved = 0;
  #idleTimeoutMs: number;
  #reapIdle: boolean;
  #sweepIntervalMs: number;
  #sweeper: ReturnType<typeof setInterval> | null = null;
  #headless: boolean;
  #viewport: { width: number; height: number };
  #deviceScaleFactor: number;
  #extensionDir: string | null;
  #onEvent: ((event: RuntimeEvent) => void) | null;
  #hookErrors: unknown[] = [];
  #maxClosedRetained: number;
  #closedOrder: string[] = [];

  constructor(opts: SessionManagerOptions = {}) {
    this.max_workers = opts.max_workers ?? 4;
    if (!Number.isInteger(this.max_workers) || this.max_workers < 1) {
      throw new SessionError("INVALID_REQUEST", `max_workers inválido: ${String(opts.max_workers)}`);
    }
    this.profiles_root = opts.profiles_root ?? DEFAULT_PROFILES_ROOT;
    this.#idleTimeoutMs = opts.idle_timeout_ms ?? 900_000;
    this.#reapIdle = opts.reap_idle ?? false;
    this.#sweepIntervalMs = opts.sweep_interval_ms ?? 30_000;
    this.#headless = opts.headless ?? false;
    this.#viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.#deviceScaleFactor = opts.device_scale_factor ?? 1;
    this.#extensionDir = opts.extension_dir ?? null;
    this.#onEvent = opts.onEvent ?? null;
    this.#maxClosedRetained = opts.max_closed_retained ?? 200;

    if (this.#reapIdle) {
      this.#sweeper = setInterval(() => {
        void this.sweepIdle().catch((e: unknown) => {
          console.error("[session] sweepIdle falhou:", toActionError(e).message);
        });
      }, this.#sweepIntervalMs);
      // unref: o reaper não é motivo para o processo continuar vivo.
      this.#sweeper.unref();
    }
  }

  /** Hook injetado pelo daemon depois da construção (o bus não é importado aqui). */
  set onEvent(hook: ((event: RuntimeEvent) => void) | null) {
    this.#onEvent = hook;
  }

  // ── Perfis ────────────────────────────────────────────────────────────────

  profileDir(profile: string): string {
    this.#assertProfileName(profile);
    return path.join(this.profiles_root, profile);
  }

  #assertProfileName(profile: string): void {
    if (!PROFILE_NAME_RE.test(profile) || profile === "." || profile === "..") {
      throw new SessionError("INVALID_REQUEST", `nome de perfil inválido: ${JSON.stringify(profile)}`, { profile });
    }
  }

  // ── Criação ───────────────────────────────────────────────────────────────

  /**
   * Cria sessão. Lança SessionError — inclusive BACKPRESSURE_REJECTED quando o
   * pool está no teto. Use createSessionEnvelope() para receber ActionResponse.
   */
  async createSession(opts: CreateSessionOptions): Promise<SessionInfo> {
    if (typeof opts.owner !== "string" || opts.owner.trim() === "") {
      throw new SessionError("INVALID_REQUEST", "owner é obrigatório e não pode ser vazio");
    }
    const profile = opts.profile ?? DEFAULT_PROFILE;
    this.#assertProfileName(profile);
    const headless = opts.headless ?? this.#headless;

    // Checagem + reserva acontecem sem await no meio: em JS single-thread isso é
    // atômico, então duas criações concorrentes não furam o teto.
    const inUse = this.#liveCount() + this.#reserved;
    if (inUse >= this.max_workers) {
      throw new SessionError(
        "BACKPRESSURE_REJECTED",
        `worker pool cheio: ${inUse}/${this.max_workers} — sessão recusada em vez de enfileirada`,
        { active: inUse, max: this.max_workers },
      );
    }
    this.#reserved += 1;

    const session_id = newId("ses");
    let entry: ContextEntry | null = null;
    try {
      entry = await this.#acquireContext(profile, session_id, headless);
      entry.sessions.add(session_id);

      const rec: SessionRecord = {
        session_id,
        owner: opts.owner,
        profile,
        permissions: normalizeCapabilities(opts.capabilities),
        closed_pages: new Set<string>(),
        created_at: nowIso(),
        last_activity: nowIso(),
        context_key: entry.key,
        context_id: entry.context_id,
        task: opts.task ?? null,
        status: "CREATED",
        control: "agent",
        attached_client: opts.client ?? null,
        pages: new Map(),
        active_page_id: null,
        needs_reobservation: false,
      };
      this.#sessions.set(session_id, rec);

      // Contexto persistente já nasce com uma página; reusa em vez de abrir duas.
      const existing = entry.context.pages().filter((p) => !this.#pageIds.has(p));
      if (existing.length > 0 && entry.sessions.size === 1) {
        this.#registerPage(rec, existing[0]!);
      } else {
        await this.#createPage(entry, rec);
      }

      if (rec.pages.size === 0) {
        throw new SessionError("BROWSER_UNAVAILABLE", "sessão criada sem página utilizável", { session_id });
      }

      rec.status = opts.client != null ? "ACTIVE" : "IDLE";
      this.#emit("session.created", session_id, {
        owner: rec.owner,
        profile: rec.profile,
        context_id: rec.context_id,
        headless: entry.headless,
        ephemeral: entry.ephemeral,
      }, rec.owner);

      if (opts.url !== undefined) {
        // Rollback total se a navegação inicial falhar: melhor nenhuma sessão do
        // que uma sessão que finge estar na URL pedida.
        try {
          await this.goto(session_id, opts.url);
        } catch (e) {
          await this.closeSession(session_id, "initial_navigation_failed").catch(() => undefined);
          const err = toActionError(e);
          throw new SessionError("NAVIGATION_FAILED", `navegação inicial falhou: ${err.message}`, { url: opts.url });
        }
      }

      await this.#refreshPages(rec);
      return this.#snapshot(rec);
    } catch (e) {
      // Limpeza: sessão que não chegou a existir não pode segurar contexto.
      const rec = this.#sessions.get(session_id);
      if (rec !== undefined && rec.status !== "CLOSED") {
        this.#sessions.delete(session_id);
      }
      if (entry !== null && entry.sessions.delete(session_id) && entry.sessions.size === 0) {
        await this.#destroyContext(entry).catch(() => undefined);
      }
      throw e;
    } finally {
      this.#reserved -= 1;
    }
  }

  /** Mesma criação, embrulhada em ActionResponse — o erro aparece no envelope. */
  async createSessionEnvelope(opts: CreateSessionOptions): Promise<ActionResponse<SessionInfo>> {
    const t = timer();
    const action_id = newActionId();
    try {
      const info = await this.createSession(opts);
      return ok(action_id, info.status, info, t.done());
    } catch (e) {
      const err = toActionError(e);
      return fail(action_id, "FAILED", err.code, err.message, t.done(), err.detail);
    }
  }

  // ── Contextos ─────────────────────────────────────────────────────────────

  /**
   * Um contexto por perfil (cookies compartilhados dentro do MESMO perfil, nunca
   * entre perfis). O perfil sandbox foge à regra: contexto exclusivo por sessão,
   * em dir temporário, porque efêmero significa não guardar nada — nem para si.
   */
  async #acquireContext(profile: string, session_id: string, headless: boolean): Promise<ContextEntry> {
    const ephemeral = profile === EPHEMERAL_PROFILE;
    const key = ephemeral ? `${EPHEMERAL_PROFILE}#${session_id}` : `profile:${profile}`;

    const live = this.#contexts.get(key);
    if (live !== undefined) {
      if (live.headless !== headless) {
        throw new SessionError(
          "INVALID_REQUEST",
          `perfil "${profile}" já está aberto em modo headless=${String(live.headless)}; ` +
            `criar sessão headless=${String(headless)} exigiria segundo Chromium sobre o mesmo userDataDir`,
          { profile, running_headless: live.headless, requested_headless: headless },
        );
      }
      return live;
    }

    const inFlight = this.#launching.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#launchContext(key, profile, ephemeral, headless);
    this.#launching.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#launching.delete(key);
    }
  }

  async #launchContext(key: string, profile: string, ephemeral: boolean, headless: boolean): Promise<ContextEntry> {
    let user_data_dir: string;
    if (ephemeral) {
      user_data_dir = await mkdtemp(path.join(os.tmpdir(), "nomos-sandbox-"));
    } else {
      user_data_dir = this.profileDir(profile);
      mkdirSync(user_data_dir, { recursive: true });
    }

    let context: BrowserContext;
    try {
      // Flags de extensão só quando o dono configurou extension_dir. O par
      // `--disable-extensions-except` + `--load-extension` é o documentado pelo
      // Playwright; Chrome/Edge de marca removeram esse side-loading — por isso
      // este caminho vale para o Chromium do runtime, não para o Chrome do dono.
      const args: string[] = [];
      if (this.#extensionDir !== null) {
        args.push(
          `--disable-extensions-except=${this.#extensionDir}`,
          `--load-extension=${this.#extensionDir}`,
        );
      }
      context = await chromium.launchPersistentContext(user_data_dir, {
        headless,
        viewport: this.#viewport,
        deviceScaleFactor: this.#deviceScaleFactor,
        ...(args.length > 0 ? { args } : {}),
      });
    } catch (e) {
      if (ephemeral) await rm(user_data_dir, { recursive: true, force: true }).catch(() => undefined);
      const err = toActionError(e);
      throw new SessionError("BROWSER_UNAVAILABLE", `falha ao abrir Chromium para o perfil "${profile}": ${err.message}`, {
        profile,
        user_data_dir,
      });
    }

    const entry: ContextEntry = {
      key,
      context_id: newId("ctx"),
      profile,
      context,
      user_data_dir,
      ephemeral,
      headless,
      sessions: new Set(),
      closing: false,
      pending_for: null,
      queue: Promise.resolve(),
    };

    // Páginas abertas pelo próprio site (window.open) entram por aqui.
    context.on("page", (page) => {
      const target = entry.pending_for;
      void this.#adoptPage(entry, page, target);
    });

    context.on("close", () => {
      if (entry.closing) return;
      // Browser morreu sem ordem nossa: as sessões viram FAILED, não somem.
      this.#contexts.delete(entry.key);
      for (const sid of entry.sessions) {
        const rec = this.#sessions.get(sid);
        if (rec === undefined || rec.status === "CLOSED") continue;
        rec.status = "FAILED";
        rec.pages.clear();
        rec.active_page_id = null;
      }
      this.#emit("browser.closed", null, { context_id: entry.context_id, profile: entry.profile, unexpected: true });
    });

    this.#contexts.set(key, entry);
    this.#emit("browser.started", null, {
      context_id: entry.context_id,
      profile,
      headless,
      ephemeral,
      user_data_dir: ephemeral ? "<tmp>" : user_data_dir,
    });
    return entry;
  }

  async #destroyContext(entry: ContextEntry): Promise<void> {
    entry.closing = true;
    this.#contexts.delete(entry.key);
    await entry.context.close().catch(() => undefined);
    if (entry.ephemeral) {
      await rm(entry.user_data_dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#emit("browser.closed", null, { context_id: entry.context_id, profile: entry.profile, unexpected: false });
  }

  // ── Páginas ───────────────────────────────────────────────────────────────

  async #createPage(entry: ContextEntry, rec: SessionRecord): Promise<Page> {
    // Serializa por contexto: sem isso, dois newPage() concorrentes fariam o
    // handler de "page" atribuir a página à sessão errada.
    const prev = entry.queue;
    let release!: () => void;
    entry.queue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    entry.pending_for = rec.session_id;
    try {
      const page = await entry.context.newPage();
      if (!rec.pages.has(this.#pageIds.get(page) ?? "")) this.#registerPage(rec, page);
      return page;
    } finally {
      entry.pending_for = null;
      release();
    }
  }

  async #adoptPage(entry: ContextEntry, page: Page, session_id: string | null): Promise<void> {
    if (this.#pageIds.has(page)) return;
    let owner_id = session_id;
    if (owner_id === null) {
      // Popup: herda a sessão de quem abriu. Sem opener conhecido, a página fica
      // órfã — e isso é EMITIDO, não escondido.
      const opener = await page.opener().catch(() => null);
      const opener_id = opener === null ? undefined : this.#pageIds.get(opener);
      if (opener_id !== undefined) {
        for (const rec of this.#sessions.values()) {
          if (rec.pages.has(opener_id)) {
            owner_id = rec.session_id;
            break;
          }
        }
      }
    }
    const rec = owner_id === null ? undefined : this.#sessions.get(owner_id);
    if (rec === undefined || rec.status === "CLOSED") {
      this.#emit("page.opened", null, { context_id: entry.context_id, url: page.url(), orphan: true });
      return;
    }
    this.#registerPage(rec, page);
  }

  #registerPage(rec: SessionRecord, page: Page): string {
    const page_id = newId("pg");
    this.#pageIds.set(page, page_id);
    const info: PageInfo = {
      page_id,
      url: page.url(),
      title: "",
      active: rec.active_page_id === null,
      opened_at: nowIso(),
    };
    rec.pages.set(page_id, { info, page });
    if (rec.active_page_id === null) rec.active_page_id = page_id;

    page.on("close", () => {
      rec.pages.delete(page_id);
      rec.closed_pages.add(page_id);
      // FIFO simples: o mais antigo sai quando o teto estoura.
      if (rec.closed_pages.size > MAX_ABAS_FECHADAS) {
        const maisAntigo = rec.closed_pages.values().next().value;
        if (maisAntigo !== undefined) rec.closed_pages.delete(maisAntigo);
      }
      if (rec.active_page_id === page_id) {
        rec.active_page_id = rec.pages.keys().next().value ?? null;
      }
      this.#emit("page.closed", rec.session_id, { page_id });
    });

    this.#emit("page.opened", rec.session_id, { page_id, url: info.url });
    return page_id;
  }

  /** Reobserva URL/título direto das páginas vivas — não confia no cache. */
  async #refreshPages(rec: SessionRecord): Promise<void> {
    for (const [page_id, pr] of [...rec.pages.entries()]) {
      if (pr.page.isClosed()) {
        rec.pages.delete(page_id);
        rec.closed_pages.add(page_id);
        continue;
      }
      pr.info.url = pr.page.url();
      try {
        pr.info.title = await pr.page.title();
      } catch {
        // Título é metadado cosmético; navegação em voo pode recusá-lo.
        // Mantém o anterior em vez de inventar string.
      }
      pr.info.active = page_id === rec.active_page_id;
    }
    if (rec.active_page_id !== null && !rec.pages.has(rec.active_page_id)) {
      rec.active_page_id = rec.pages.keys().next().value ?? null;
    }
  }

  /**
   * Devolve a Page do Playwright para os demais módulos (pointer, perception…).
   * Sem page_id, devolve a página ativa.
   */
  getPage(session_id: string, page_id?: string): Page {
    const rec = this.#require(session_id);
    if (rec.status === "CLOSED") {
      throw new SessionError("SESSION_NOT_ACTIVE", `sessão ${session_id} está CLOSED`, { session_id });
    }
    // TRÊS situações diferentes moravam no mesmo código de erro, e isso mandava
    // o operador caçar o bug errado.
    //
    // "não tem página aberta" e "a página fechou" NÃO são erro de alvo: são o
    // navegador tendo sumido por baixo da sessão. Medido na FASE 25: matando o
    // Chromium, `browser.extract` E `browser.screenshot` voltavam
    // `TARGET_NOT_FOUND` — e screenshot não TEM alvo. Quem lesse a trilha
    // concluiria "meu seletor está errado" quando a verdade era "a página que
    // você estava vendo não existe mais".
    //
    // `BROWSER_UNAVAILABLE` (503) já é o código dessa condição neste mesmo
    // arquivo, duas funções abaixo, para "contexto não está mais vivo". O que
    // continua sendo `TARGET_NOT_FOUND` é só o caso em que o CHAMADOR pediu uma
    // aba que não é dele — esse, sim, é erro de quem pediu.
    const id = page_id ?? rec.active_page_id;
    if (id === null || id === undefined) {
      throw new SessionError("BROWSER_UNAVAILABLE", `sessão ${session_id} não tem página aberta`, { session_id });
    }
    const pr = rec.pages.get(id);
    if (pr === undefined) {
      // Era desta sessão e morreu ⇒ condição do navegador. Nunca foi ⇒ erro de
      // quem pediu. Mesma ausência no mapa, causas opostas, e mandar as duas
      // para o mesmo código faz o cliente caçar o bug errado.
      if (rec.closed_pages.has(id)) {
        throw new SessionError("BROWSER_UNAVAILABLE", `page_id ${id} era desta sessão e já fechou`, {
          session_id,
          page_id: id,
        });
      }
      throw new SessionError("TARGET_NOT_FOUND", `page_id ${id} não pertence à sessão ${session_id}`, {
        session_id,
        page_id: id,
      });
    }
    if (pr.page.isClosed()) {
      rec.pages.delete(id);
      throw new SessionError("BROWSER_UNAVAILABLE", `page_id ${id} já está fechada`, { session_id, page_id: id });
    }
    rec.last_activity = nowIso();
    return pr.page;
  }

  pageIdOf(page: Page): string | null {
    return this.#pageIds.get(page) ?? null;
  }

  async newPage(session_id: string, url?: string): Promise<PageInfo> {
    const rec = this.#requireLive(session_id);
    const entry = this.#contextOf(rec);
    const page = await this.#createPage(entry, rec);
    const page_id = this.#pageIds.get(page);
    if (page_id === undefined) throw new SessionError("INTERNAL", "página criada sem registro de id");
    rec.active_page_id = page_id;
    if (url !== undefined) await this.goto(session_id, url, page_id);
    await this.#refreshPages(rec);
    const pr = rec.pages.get(page_id);
    if (pr === undefined) throw new SessionError("INTERNAL", "página desapareceu logo após criação");
    return { ...pr.info, active: true };
  }

  async closePage(session_id: string, page_id: string): Promise<void> {
    const rec = this.#requireLive(session_id);
    const pr = rec.pages.get(page_id);
    if (pr === undefined) {
      throw new SessionError("TARGET_NOT_FOUND", `page_id ${page_id} não pertence à sessão ${session_id}`, {
        session_id,
        page_id,
      });
    }
    await pr.page.close();
    rec.last_activity = nowIso();
  }

  switchPage(session_id: string, page_id: string): SessionInfo {
    const rec = this.#requireLive(session_id);
    if (!rec.pages.has(page_id)) {
      throw new SessionError("TARGET_NOT_FOUND", `page_id ${page_id} não pertence à sessão ${session_id}`, {
        session_id,
        page_id,
      });
    }
    rec.active_page_id = page_id;
    rec.last_activity = nowIso();
    return this.#snapshot(rec);
  }

  /** Navegação básica. Módulos de navegação mais ricos usam getPage() direto. */
  async goto(session_id: string, url: string, page_id?: string): Promise<PageInfo> {
    const rec = this.#requireLive(session_id);
    const page = this.getPage(session_id, page_id);
    const id = page_id ?? rec.active_page_id!;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      const err = toActionError(e);
      throw new SessionError("NAVIGATION_FAILED", `goto(${url}) falhou: ${err.message}`, { url, session_id });
    }
    await this.#refreshPages(rec);
    this.#emit("page.loaded", session_id, { page_id: id, url: page.url() }, rec.owner);
    const pr = rec.pages.get(id);
    if (pr === undefined) throw new SessionError("TARGET_NOT_FOUND", `page_id ${id} fechou durante a navegação`);
    return { ...pr.info };
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  get(session_id: string): SessionInfo {
    return this.#snapshot(this.#require(session_id));
  }

  /** Snapshot com URL/título relidos do browser — custa uma ida ao Chromium. */
  async observe(session_id: string): Promise<SessionInfo> {
    const rec = this.#require(session_id);
    await this.#refreshPages(rec);
    return this.#snapshot(rec);
  }

  list(opts: { include_closed?: boolean; owner?: string; profile?: string } = {}): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const rec of this.#sessions.values()) {
      if (rec.status === "CLOSED" && opts.include_closed !== true) continue;
      if (opts.owner !== undefined && rec.owner !== opts.owner) continue;
      if (opts.profile !== undefined && rec.profile !== opts.profile) continue;
      out.push(this.#snapshot(rec));
    }
    return out;
  }

  has(session_id: string): boolean {
    return this.#sessions.has(session_id);
  }

  needsReobservation(session_id: string): boolean {
    return this.#require(session_id).needs_reobservation;
  }

  contextInfo(session_id: string): ContextInfo {
    const rec = this.#require(session_id);
    const entry = this.#contexts.get(rec.context_key);
    if (entry === undefined) {
      throw new SessionError("BROWSER_UNAVAILABLE", `contexto da sessão ${session_id} não está mais vivo`, {
        session_id,
      });
    }
    return {
      context_id: entry.context_id,
      profile: entry.profile,
      user_data_dir: entry.user_data_dir,
      ephemeral: entry.ephemeral,
      headless: entry.headless,
      sessions: entry.sessions.size,
    };
  }

  poolStats(): PoolStats {
    let active = 0;
    let idle = 0;
    let paused = 0;
    let total = 0;
    for (const rec of this.#sessions.values()) {
      if (rec.status === "CLOSED") continue;
      total += 1;
      if (rec.status === "ACTIVE") active += 1;
      else if (rec.status === "IDLE") idle += 1;
      else if (rec.status === "PAUSED") paused += 1;
    }
    return {
      workers: { active: total + this.#reserved, max: this.max_workers },
      sessions: { total, active, idle, paused },
      contexts: this.#contexts.size,
      hook_errors: this.#hookErrors.length,
    };
  }

  /**
   * FASE 13 — SONDA DE VIDA DO NAVEGADOR.
   *
   * `poolStats().contexts` conta o que o MAPA tem, não o que está VIVO. Depois
   * de o Chromium morrer por baixo (crash, OOM, `kill -9` no processo do
   * browser), a entrada continua no mapa e a contagem segue dizendo que está
   * tudo bem. Esta sonda pergunta ao Playwright — `browser.isConnected()` e um
   * toque no contexto — em vez de consultar a nossa própria contabilidade.
   *
   * Não fecha nem recria nada: quem decide o que fazer com um contexto morto é o
   * watchdog, e uma sonda que tem efeito colateral não pode ser chamada em laço.
   */
  async probeContexts(): Promise<{ vivos: number; mortos: { context_id: string; sessions: string[]; motivo: string }[] }> {
    let vivos = 0;
    const mortos: { context_id: string; sessions: string[]; motivo: string }[] = [];
    for (const entry of [...this.#contexts.values()]) {
      if (entry.closing) continue;
      let motivo: string | null = null;
      try {
        const navegador = entry.context.browser();
        if (navegador !== null && !navegador.isConnected()) {
          motivo = "browser desconectado";
        } else {
          // TOQUE REAL, e não `pages()`.
          //
          // Medido: depois de o contexto morrer, `pages()` devolve `[]` sem
          // lançar — a sonda ficaria verde sobre um navegador morto, que é
          // exatamente o defeito que ela existe para pegar. `cookies()` vai até
          // o alvo e lança "Target page, context or browser has been closed".
          await entry.context.cookies();
        }
      } catch (e) {
        motivo = (e as Error).message;
      }
      if (motivo === null) vivos += 1;
      else mortos.push({ context_id: entry.context_id, sessions: [...entry.sessions], motivo });
    }
    return { vivos, mortos };
  }

  /**
   * FASE 13 — marca como FAILED as sessões cujo contexto morreu.
   *
   * É a AÇÃO que o watchdog toma sobre o que a sonda achou. Não tenta ressuscitar
   * o Chromium: a sessão do dono (cookies, abas, formulário meio preenchido)
   * morreu com ele, e recriar um contexto vazio com o mesmo `session_id`
   * entregaria ao agente uma sessão que PARECE a dele e não é. Marcar FAILED faz
   * o cliente saber que precisa recomeçar — que é a verdade.
   */
  async reapDeadContexts(): Promise<string[]> {
    const { mortos } = await this.probeContexts();
    const afetadas: string[] = [];
    for (const morto of mortos) {
      for (const sid of morto.sessions) {
        const rec = this.#sessions.get(sid);
        if (rec === undefined || rec.status === "CLOSED" || rec.status === "FAILED") continue;
        this.#setState(rec, "FAILED");
        afetadas.push(sid);
        this.#emit("browser.closed", sid, { reason: "watchdog: contexto morto", motivo: morto.motivo });
      }
      const entry = this.#contexts.get(morto.context_id) ?? [...this.#contexts.values()].find((c) => c.context_id === morto.context_id);
      if (entry !== undefined) this.#contexts.delete(entry.key);
    }
    return afetadas;
  }

  // ── Attach / detach — o coração da FASE 3 ─────────────────────────────────

  /**
   * Reconecta um cliente. Não recria nada: a sessão nunca morreu.
   * `force` é necessário para roubar sessão já colada a outro cliente — dois
   * clientes silenciosamente no mesmo browser seria bug difícil de ver.
   */
  attach(session_id: string, client: string, opts: { force?: boolean } = {}): SessionInfo {
    const rec = this.#requireLive(session_id);
    if (typeof client !== "string" || client.trim() === "") {
      throw new SessionError("INVALID_REQUEST", "client é obrigatório no attach");
    }
    if (rec.attached_client !== null && rec.attached_client !== client && opts.force !== true) {
      throw new SessionError(
        "INVALID_REQUEST",
        `sessão ${session_id} já está atada ao cliente ${rec.attached_client}; use force para assumir`,
        { session_id, attached_client: rec.attached_client },
      );
    }
    rec.attached_client = client;
    // PAUSED/RECOVERING não são revogados por attach: quem manda ali é o humano
    // (FASE 32) ou a reobservação pendente.
    if (rec.status === "CREATED" || rec.status === "IDLE") this.#setState(rec, "ACTIVE");
    rec.last_activity = nowIso();
    this.#emit("session.resumed", session_id, { client, url: this.#activeUrl(rec) }, rec.owner);
    return this.#snapshot(rec);
  }

  /**
   * Desconecta o cliente. NÃO fecha browser, contexto nem páginas: a sessão vira
   * órfã porém VIVA (IDLE, attached_client=null). Este é o requisito da FASE 3.
   *
   * Não há evento de detach no contrato v1 (EventName é enum fechado) — inventar
   * um seria violar o contrato, então o daemon observa a mudança via SessionInfo.
   */
  detach(session_id: string): SessionInfo {
    const rec = this.#requireLive(session_id);
    rec.attached_client = null;
    if (rec.status === "ACTIVE" || rec.status === "CREATED") this.#setState(rec, "IDLE");
    rec.last_activity = nowIso();
    return this.#snapshot(rec);
  }

  // ── Handoff (FASE 27) ─────────────────────────────────────────────────────

  /**
   * Troca o dono preservando tudo: URL, abas, cookies (o contexto nem é tocado)
   * e a task em curso. O cliente atado só muda se o chamador disser — quem
   * decide isso é o daemon, não o gerente.
   */
  async handoff(session_id: string, to_owner: string, opts: { client?: string | null } = {}): Promise<SessionInfo> {
    const rec = this.#requireLive(session_id);
    if (typeof to_owner !== "string" || to_owner.trim() === "") {
      throw new SessionError("INVALID_REQUEST", "to_owner é obrigatório no handoff");
    }
    const from_owner = rec.owner;
    await this.#refreshPages(rec);
    const url_before = this.#activeUrl(rec);
    const tabs_before = rec.pages.size;

    rec.owner = to_owner;
    if (opts.client !== undefined) rec.attached_client = opts.client;
    rec.last_activity = nowIso();

    const url_after = this.#activeUrl(rec);
    if (url_after !== url_before || rec.pages.size !== tabs_before) {
      throw new SessionError("INTERNAL", "handoff alterou URL/abas — estado não foi preservado", {
        url_before,
        url_after,
        tabs_before,
        tabs_after: rec.pages.size,
      });
    }

    this.#emit("session.handoff", session_id, {
      from_owner,
      to_owner,
      url: url_after,
      tabs: tabs_before,
      task: rec.task,
      profile: rec.profile,
    }, to_owner);
    return this.#snapshot(rec);
  }

  setTask(session_id: string, task: string | null): SessionInfo {
    const rec = this.#requireLive(session_id);
    rec.task = task;
    rec.last_activity = nowIso();
    return this.#snapshot(rec);
  }

  // ── Takeover / release (FASE 32) ──────────────────────────────────────────

  /** Humano assume: agente congela (PAUSED) até `release`. */
  takeover(session_id: string, actor = "human"): SessionInfo {
    const rec = this.#requireLive(session_id);
    if (rec.control === "human") {
      throw new SessionError("CONTROL_HELD_BY_HUMAN", `sessão ${session_id} já está sob controle humano`, {
        session_id,
      });
    }
    rec.control = "human";
    this.#setState(rec, "PAUSED");
    rec.last_activity = nowIso();
    this.#emit("control.taken", session_id, { actor, url: this.#activeUrl(rec) }, actor);
    return this.#snapshot(rec);
  }

  /**
   * Humano devolve. Vai para RECOVERING, não ACTIVE: o humano pode ter navegado,
   * fechado abas, logado em outra conta. Quem reobservar chama markObserved().
   */
  async release(session_id: string, actor = "human"): Promise<SessionInfo> {
    const rec = this.#requireLive(session_id);
    if (rec.control !== "human") {
      throw new SessionError("INVALID_REQUEST", `sessão ${session_id} não está sob controle humano`, { session_id });
    }
    const url_before = this.#activeUrl(rec);
    await this.#refreshPages(rec);
    rec.control = "agent";
    rec.needs_reobservation = true;
    this.#setState(rec, "RECOVERING");
    rec.last_activity = nowIso();
    const url_after = this.#activeUrl(rec);
    this.#emit("control.returned", session_id, {
      actor,
      needs_reobservation: true,
      url_before_takeover: url_before,
      url_now: url_after,
      url_changed_under_human: url_before !== url_after,
    }, actor);
    return this.#snapshot(rec);
  }

  /** Chamado por quem de fato reobservou a página. Só então volta a ACTIVE. */
  markObserved(session_id: string): SessionInfo {
    const rec = this.#requireLive(session_id);
    rec.needs_reobservation = false;
    if (rec.status === "RECOVERING") this.#setState(rec, "ACTIVE");
    rec.last_activity = nowIso();
    return this.#snapshot(rec);
  }

  // ── Guardas para os demais módulos ────────────────────────────────────────

  /** Fail closed: ferramenta sem entrada em REQUIRED_CAPABILITY é negada. */
  assertCapability(session_id: string, tool: string): void {
    const rec = this.#require(session_id);
    const need = REQUIRED_CAPABILITY[tool];
    if (need === undefined) {
      throw new SessionError("CAPABILITY_DENIED", `ferramenta "${tool}" não declara capability — negada (fail closed)`, {
        tool,
      });
    }
    if (rec.permissions[need] !== true) {
      throw new SessionError("CAPABILITY_DENIED", `capability "${need}" negada para a sessão ${session_id}`, {
        tool,
        capability: need,
      });
    }
  }

  /** Bloqueia o agente enquanto o humano tem o volante. */
  assertAgentControl(session_id: string): void {
    const rec = this.#require(session_id);
    if (rec.control === "human") {
      throw new SessionError("CONTROL_HELD_BY_HUMAN", `sessão ${session_id} está sob controle humano`, { session_id });
    }
  }

  // ── Estados ───────────────────────────────────────────────────────────────

  transition(session_id: string, to: SessionState): SessionInfo {
    const rec = this.#require(session_id);
    this.#setState(rec, to);
    return this.#snapshot(rec);
  }

  #setState(rec: SessionRecord, to: SessionState): void {
    const from = rec.status;
    if (from === to) {
      if (from === "CLOSED") {
        throw new SessionError("SESSION_NOT_ACTIVE", `sessão ${rec.session_id} já está CLOSED`, {
          session_id: rec.session_id,
        });
      }
      return;
    }
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new SessionError(
        "INVALID_REQUEST",
        `transição de sessão inválida ${from} → ${to} (permitidas de ${from}: ${ALLOWED_TRANSITIONS[from].join(", ") || "nenhuma"})`,
        { session_id: rec.session_id, from, to, allowed: [...ALLOWED_TRANSITIONS[from]] },
      );
    }
    rec.status = to;
  }

  // ── Encerramento ──────────────────────────────────────────────────────────

  async closeSession(session_id: string, reason = "requested"): Promise<SessionInfo> {
    const rec = this.#require(session_id);
    if (rec.status === "CLOSED") {
      throw new SessionError("SESSION_NOT_ACTIVE", `sessão ${session_id} já está CLOSED`, { session_id });
    }
    const entry = this.#contexts.get(rec.context_key);
    const pages = [...rec.pages.values()];
    rec.pages.clear();
    rec.active_page_id = null;

    if (entry !== undefined) {
      entry.sessions.delete(session_id);
      if (entry.sessions.size === 0) {
        await this.#destroyContext(entry);
      } else {
        // Perfil compartilhado por outra sessão: fecha só as páginas desta.
        for (const pr of pages) {
          if (!pr.page.isClosed()) await pr.page.close().catch(() => undefined);
        }
      }
    }

    rec.status = "CLOSED";
    rec.control = "agent";
    rec.attached_client = null;
    rec.needs_reobservation = false;
    rec.last_activity = nowIso();
    this.#emit("session.closed", session_id, { reason, owner: rec.owner, profile: rec.profile }, rec.owner);
    this.#retainClosed(session_id);
    return this.#snapshot(rec);
  }

  /** Fecha tudo. Nenhum Chromium fica para trás. */
  async closeAll(reason = "shutdown"): Promise<number> {
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    let n = 0;
    for (const rec of [...this.#sessions.values()]) {
      if (rec.status === "CLOSED") continue;
      await this.closeSession(rec.session_id, reason).catch(() => undefined);
      n += 1;
    }
    // Contextos sem sessão (criação abortada no meio) também são derrubados.
    for (const entry of [...this.#contexts.values()]) {
      await this.#destroyContext(entry).catch(() => undefined);
    }
    return n;
  }

  /**
   * Reciclagem de órfãs por ociosidade. Determinístico e chamável à mão — não
   * depende do relógio de fundo para ser testado.
   */
  async sweepIdle(now = Date.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const rec of [...this.#sessions.values()]) {
      if (rec.status !== "IDLE" || rec.attached_client !== null) continue;
      if (now - Date.parse(rec.last_activity) < this.#idleTimeoutMs) continue;
      await this.closeSession(rec.session_id, "idle_timeout");
      closed.push(rec.session_id);
    }
    return closed;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  #liveCount(): number {
    let n = 0;
    for (const rec of this.#sessions.values()) if (rec.status !== "CLOSED") n += 1;
    return n;
  }

  #require(session_id: string): SessionRecord {
    const rec = this.#sessions.get(session_id);
    if (rec === undefined) {
      throw new SessionError("SESSION_NOT_FOUND", `sessão ${session_id} não existe`, { session_id });
    }
    return rec;
  }

  #requireLive(session_id: string): SessionRecord {
    const rec = this.#require(session_id);
    if (rec.status === "CLOSED") {
      throw new SessionError("SESSION_NOT_ACTIVE", `sessão ${session_id} está CLOSED`, { session_id });
    }
    if (rec.status === "FAILED") {
      throw new SessionError("SESSION_NOT_ACTIVE", `sessão ${session_id} está FAILED (browser caiu)`, { session_id });
    }
    return rec;
  }

  #contextOf(rec: SessionRecord): ContextEntry {
    const entry = this.#contexts.get(rec.context_key);
    if (entry === undefined) {
      throw new SessionError("BROWSER_UNAVAILABLE", `contexto da sessão ${rec.session_id} não está vivo`, {
        session_id: rec.session_id,
      });
    }
    return entry;
  }

  #activeUrl(rec: SessionRecord): string | null {
    if (rec.active_page_id === null) return null;
    return rec.pages.get(rec.active_page_id)?.info.url ?? null;
  }

  #retainClosed(session_id: string): void {
    this.#closedOrder.push(session_id);
    while (this.#closedOrder.length > this.#maxClosedRetained) {
      const old = this.#closedOrder.shift();
      if (old !== undefined) this.#sessions.delete(old);
    }
  }

  #snapshot(rec: SessionRecord): SessionInfo {
    return {
      session_id: rec.session_id,
      owner: rec.owner,
      profile: rec.profile,
      permissions: { ...rec.permissions },
      created_at: rec.created_at,
      last_activity: rec.last_activity,
      context_id: rec.context_id,
      pages: [...rec.pages.values()].map((pr) => ({ ...pr.info, active: pr.info.page_id === rec.active_page_id })),
      task: rec.task,
      status: rec.status,
      control: rec.control,
      attached_client: rec.attached_client,
    };
  }

  #emit(event: EventName, session_id: string | null, payload: Record<string, unknown>, source = "runtime"): void {
    const hook = this.#onEvent;
    if (hook === null) return;
    const e: RuntimeEvent = { timestamp: nowIso(), session_id, action_id: null, source, event, payload };
    try {
      hook(e);
    } catch (err) {
      // Hook quebrado não pode derrubar gestão de sessão — mas também não some:
      // fica contado em poolStats().hook_errors e vai para stderr.
      this.#hookErrors.push(err);
      console.error(`[session] hook onEvent lançou em ${event}:`, toActionError(err).message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fail closed em capability sensível: parte da política RESTRITA e só promove o
 * que veio como `true` booleano literal. Truthy ("yes", 1) não concede nada.
 */
export function normalizeCapabilities(partial?: Partial<Capabilities>): Capabilities {
  const out: Capabilities = { ...RESTRICTED_CAPABILITIES };
  if (partial === undefined || partial === null) return out;
  for (const key of Object.keys(out) as (keyof Capabilities)[]) {
    const v = partial[key];
    if (v === undefined) continue;
    out[key] = v === true;
  }
  return out;
}
