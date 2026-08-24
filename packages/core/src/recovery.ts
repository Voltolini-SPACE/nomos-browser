/**
 * RECOVERY — FASES 11 / 12 / 13 / 14 / 20
 *
 * O PRODUCT-01 cobriu a queda do CLIENTE (detach não mata a sessão). Este módulo
 * cobre o caso que faltava e que é mais duro: a queda do PROCESSO do runtime —
 * `SIGKILL` no daemon, com sessão ativa, sem chance de rodar handler de saída.
 *
 * Depois de um SIGKILL o que sobra é: um diretório em disco e, talvez, um
 * Chromium ainda vivo. O trabalho aqui é decidir o que fazer com isso SEM
 * inventar estado.
 *
 * ── Por que a escrita é atômica ─────────────────────────────────────────────
 * Um SIGKILL no meio de um `write()` deixa `state.json` truncado. Um snapshot
 * pela metade é pior que snapshot nenhum: ele *parece* estado válido. Por isso a
 * gravação é tmp + fsync + rename. `rename(2)` no mesmo filesystem é atômico:
 * o leitor vê o arquivo velho inteiro ou o novo inteiro, nunca metade. O tmp
 * truncado que sobra é inerte — `list()` só reconhece o nome exato `state.json`.
 *
 * ── Por que existem quatro decisões e nenhuma default ────────────────────────
 * Toda sessão encontrada recebe UMA decisão explícita, com motivo registrado:
 *
 *   reattach  — o browser está vivo E responde no CDP E é PROVADAMENTE o mesmo
 *               browser que este runtime gravou. Reata via `connectOverCDP`.
 *   recover   — o browser está alcançável, mas a sessão NÃO pode voltar a ACTIVE
 *               como se nada tivesse acontecido: havia ação em voo, ou a URL/as
 *               abas divergiram do snapshot. Vai para RECOVERING, reobserva.
 *   orphan    — havia um processo e ele não está mais sob nosso controle: pid
 *               morto, pid vivo porém CDP mudo, ou identidade que não confere.
 *               Nada é morto. Um pid gravado antes do crash pode ter sido
 *               reciclado pelo SO para um processo alheio.
 *   terminate — o snapshot não descreve sessão alguma (corrompido, schema
 *               desconhecido, sessão já CLOSED). Retira-se o SNAPSHOT.
 *               `terminate` NUNCA mata processo — ver `retire()`.
 *
 * `browser_pid` morto ⇒ `orphan`, nunca `reattach`. Um snapshot existir não é
 * prova de que há browser atrás dele.
 *
 * ── Por que identidade, e não só "a porta respondeu" ─────────────────────────
 * Porta de CDP é reciclada. Se o Chromium do snapshot morreu e outro Chromium
 * qualquer subiu na mesma porta, "o CDP responde" faria o runtime dirigir o
 * navegador errado — nesta máquina existe Chrome de PRODUÇÃO do nomos-panel com
 * CDP próprio. Então o snapshot grava `browser_id`, o UUID de instância que o
 * Chromium publica em `webSocketDebuggerUrl` (`/devtools/browser/<uuid>`), e o
 * reattach só acontece quando esse UUID confere. Snapshot sem `browser_id` não
 * autoriza conexão nenhuma — fail closed.
 *
 * ── Idempotência de ação destrutiva ─────────────────────────────────────────
 * Uma ação interrompida no meio não pode ser repetida cegamente: o clique em
 * "Confirmar pagamento" pode ter chegado ao servidor no instante do SIGKILL.
 * Por isso `in_flight_action` é gravado ANTES da ação e o recovery a devolve
 * como `UNKNOWN_OUTCOME` — não `failed`, não `ok`. Admitir que não se sabe é a
 * única resposta verdadeira. Só classe OBSERVE é marcada `safe_to_retry`.
 *
 * Este módulo não escreve em stdout/stderr e não devolve URL crua em `detail`
 * (URL carrega token com frequência).
 */
import { chromium, type Browser } from "playwright";
import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  ACTION_CLASS,
  RESTRICTED_CAPABILITIES,
  nowIso,
  type ActionClass,
  type Capabilities,
  type SessionState,
} from "./contract.ts";
import { SESSIONS_ROOT, assertSafeSessionId, sessionDir } from "../../observability/src/audit.ts";

export const STATE_FILE = "state.json";

/** Versão do formato em disco. Schema desconhecido não é lido "na esperança". */
export const SNAPSHOT_SCHEMA = 1 as const;

/** Só CDP em loopback. Um snapshot adulterado não vira SSRF (SECURITY.md T2). */
const CDP_ENDPOINT_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?\/?$/;

/** `ws://127.0.0.1:PORT/devtools/browser/<uuid>` → `<uuid>`. */
const BROWSER_ID_RE = /\/devtools\/browser\/([0-9a-fA-F-]{8,})$/;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/** Ação gravada ANTES de executar. Existe para admitir "não sei o que houve". */
export interface InFlightAction {
  action_id: string;
  /** Ferramenta da API v1, ex.: "browser.click". */
  tool: string;
  target: string | null;
  started_at: string;
}

export interface SessionSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  session_id: string;
  owner: string;
  profile: string;
  url: string | null;
  page_ids: string[];
  context_id: string;
  capabilities: Capabilities;
  cdp_endpoint: string | null;
  browser_pid: number | null;
  /** UUID de instância do Chromium; sem ele não há reattach. */
  browser_id: string | null;
  criado_em: string;
  ultima_atividade: string;
  status: SessionState;
  /** Perfil efêmero (sandbox): o userDataDir não sobrevive ao processo. */
  ephemeral: boolean;
  in_flight_action: InFlightAction | null;
}

export type SessionSnapshotInput = Omit<
  SessionSnapshot,
  "schema" | "criado_em" | "ultima_atividade" | "in_flight_action"
> &
  Partial<Pick<SessionSnapshot, "criado_em" | "ultima_atividade" | "in_flight_action">>;

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

export type SnapshotLoadError =
  | "snapshot_missing"
  | "snapshot_unreadable"
  | "snapshot_corrupted"
  | "snapshot_invalid"
  | "schema_unknown";

export interface SnapshotLoad {
  session_id: string;
  file: string;
  ok: boolean;
  snapshot: SessionSnapshot | null;
  error: SnapshotLoadError | null;
  message: string | null;
  /** Bytes lidos — evidência de truncamento, não conteúdo. */
  bytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sonda de CDP
// ─────────────────────────────────────────────────────────────────────────────

export interface CdpProbe {
  endpoint: string;
  /** Endpoint recusado pela política (não-loopback, esquema errado). */
  rejected: boolean;
  reachable: boolean;
  browser: string | null;
  browser_id: string | null;
  error: string | null;
}

/**
 * GET `<endpoint>/json/version`. Leitura pura: não abre sessão de CDP, não
 * envia comando. Serve para decidir se vale a pena conectar.
 */
export async function probeCdp(endpoint: string | null, timeout_ms = 1_500): Promise<CdpProbe> {
  const shown = endpoint ?? "";
  if (typeof endpoint !== "string" || !CDP_ENDPOINT_RE.test(endpoint)) {
    return {
      endpoint: shown,
      rejected: true,
      reachable: false,
      browser: null,
      browser_id: null,
      error: "endpoint de CDP recusado: só http em 127.0.0.1/localhost",
    };
  }
  const base = endpoint.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeout_ms) });
    if (!res.ok) {
      return { endpoint: base, rejected: false, reachable: false, browser: null, browser_id: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const ws = typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : "";
    const id = BROWSER_ID_RE.exec(ws);
    return {
      endpoint: base,
      rejected: false,
      reachable: true,
      browser: typeof body.Browser === "string" ? body.Browser : null,
      browser_id: id === null ? null : id[1]!,
      error: null,
    };
  } catch (e) {
    return {
      endpoint: base,
      rejected: false,
      reachable: false,
      browser: null,
      browser_id: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * `process.kill(pid, 0)` não envia sinal: só consulta. ESRCH = morto;
 * EPERM = vivo e de outro dono. pid <= 0 é recusado — `kill(0, …)` atingiria o
 * GRUPO de processos inteiro, e este módulo nunca sinaliza ninguém.
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Veredito
// ─────────────────────────────────────────────────────────────────────────────

export type RecoveryDecision = "reattach" | "recover" | "orphan" | "terminate";

export type RecoveryReason =
  | "cdp_alive"
  | "in_flight_unknown_outcome"
  | "url_divergent"
  | "pages_divergent"
  | "browser_pid_dead"
  | "browser_pid_unknown"
  | "cdp_endpoint_missing"
  | "cdp_endpoint_rejected"
  | "cdp_unreachable"
  | "cdp_identity_unknown"
  | "cdp_identity_mismatch"
  | "reattach_failed"
  | "session_closed"
  | SnapshotLoadError;

export interface InFlightVerdict {
  action_id: string;
  tool: string;
  action_class: ActionClass;
  /** Único valor honesto: o processo morreu sem saber o desfecho. */
  outcome: "UNKNOWN_OUTCOME";
  /** Só OBSERVE. ACT e COMMIT nunca são repetidos por decisão automática. */
  safe_to_retry: boolean;
  requires_human_decision: boolean;
  started_at: string;
}

export interface RecoveryVerdict {
  session_id: string;
  decision: RecoveryDecision;
  reason: RecoveryReason;
  /** Nunca contém URL crua nem valor de segredo. */
  detail: Record<string, unknown>;
  snapshot: SessionSnapshot | null;
  in_flight: InFlightVerdict | null;
  needs_reobservation: boolean;
  decided_at: string;
}

export interface ReattachResult {
  session_id: string;
  connected: boolean;
  /** Decisão FINAL, já considerando a verificação pós-conexão. */
  decision: RecoveryDecision;
  reason: RecoveryReason;
  expected_url: string | null;
  observed_urls: string[];
  url_matches: boolean;
  pages_expected: number;
  pages_observed: number;
  needs_reobservation: boolean;
  in_flight: InFlightVerdict | null;
  /** Conexão viva quando `connected`. Fechá-la NÃO mata o Chromium. */
  browser: Browser | null;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fato de recuperação observável de fora (FASE 3 forense).
 *
 * O `RecoveryManager` decidia e reatava em silêncio: quem lesse a trilha depois
 * de uma queda não encontrava NADA sobre a recuperação — nem que ela começou,
 * nem como terminou. O hook existe para que o daemon transforme cada tentativa
 * em linha de `actions.jsonl`.
 */
export interface RecoveryProgress {
  phase: "start" | "complete";
  session_id: string;
  decision: RecoveryDecision | null;
  reason: RecoveryReason | null;
  connected: boolean | null;
  error: string | null;
}

export type RecoveryHook = (progress: RecoveryProgress) => void;

export interface RecoveryManagerOptions {
  /** Raiz das sessões. Default: a mesma de `audit.ts`. */
  root?: string;
  /** Observador das tentativas de reattach. Falha dele não derruba a recuperação. */
  onRecovery?: RecoveryHook;
  /** Timeout da sonda HTTP do CDP. */
  probe_timeout_ms?: number;
  /** Timeout do `connectOverCDP`. */
  connect_timeout_ms?: number;
}

export class RecoveryManager {
  readonly root: string;
  readonly probe_timeout_ms: number;
  readonly connect_timeout_ms: number;

  /** Uma cadeia de escrita por arquivo: dois saves não intercalam rename. */
  #chains = new Map<string, Promise<unknown>>();

  readonly #onRecovery: RecoveryHook | null;

  constructor(opts: RecoveryManagerOptions = {}) {
    this.root = opts.root ?? SESSIONS_ROOT;
    this.probe_timeout_ms = opts.probe_timeout_ms ?? 1_500;
    this.connect_timeout_ms = opts.connect_timeout_ms ?? 5_000;
    this.#onRecovery = opts.onRecovery ?? null;
  }

  /** Avisa o observador. Um hook que estoura não pode abortar a recuperação. */
  #progress(progress: RecoveryProgress): void {
    if (this.#onRecovery === null) return;
    try {
      this.#onRecovery(progress);
    } catch (e) {
      console.error("[recovery] hook falhou:", (e as Error).message);
    }
  }

  file(session_id: string): string {
    return path.join(sessionDir(session_id, this.root), STATE_FILE);
  }

  // ── Escrita ───────────────────────────────────────────────────────────────

  /** Grava (ou regrava) o snapshot. Atômico: tmp + fsync + rename. */
  async save(input: SessionSnapshotInput): Promise<SessionSnapshot> {
    assertSafeSessionId(input.session_id);
    const now = nowIso();
    const snap: SessionSnapshot = {
      schema: SNAPSHOT_SCHEMA,
      session_id: input.session_id,
      owner: input.owner,
      profile: input.profile,
      url: input.url,
      page_ids: [...input.page_ids],
      context_id: input.context_id,
      capabilities: { ...RESTRICTED_CAPABILITIES, ...input.capabilities },
      cdp_endpoint: input.cdp_endpoint,
      browser_pid: input.browser_pid,
      browser_id: input.browser_id,
      criado_em: input.criado_em ?? now,
      ultima_atividade: input.ultima_atividade ?? now,
      status: input.status,
      ephemeral: input.ephemeral,
      in_flight_action: input.in_flight_action ?? null,
    };
    await this.#writeAtomic(this.file(input.session_id), snap);
    return snap;
  }

  /**
   * Lê-modifica-grava serializado. Snapshot ausente/ilegível NÃO é recriado do
   * nada: lança. Inventar o estado que faltou é o defeito que este módulo evita.
   */
  async patch(session_id: string, patch: Partial<SessionSnapshot>): Promise<SessionSnapshot> {
    const file = this.file(session_id);
    return this.#serialize(file, async () => {
      const load = await this.#load(session_id);
      if (!load.ok || load.snapshot === null) {
        throw new Error(`recovery: snapshot de ${session_id} indisponível (${load.error ?? "desconhecido"})`);
      }
      const next: SessionSnapshot = {
        ...load.snapshot,
        ...patch,
        schema: SNAPSHOT_SCHEMA,
        session_id: load.snapshot.session_id,
        ultima_atividade: patch.ultima_atividade ?? nowIso(),
      };
      await this.#writeAtomicRaw(file, next);
      return next;
    });
  }

  touch(session_id: string): Promise<SessionSnapshot> {
    return this.patch(session_id, {});
  }

  /** Chamado ANTES da ação. Depois do crash é isto que sustenta UNKNOWN_OUTCOME. */
  markInFlight(session_id: string, action: InFlightAction): Promise<SessionSnapshot> {
    return this.patch(session_id, { in_flight_action: action });
  }

  /**
   * Chamado DEPOIS que a ação terminou com desfecho conhecido. Não recebe
   * "outcome": o snapshot só distingue "em voo" de "não há ação em voo" — quem
   * registra desfecho é o audit log.
   */
  clearInFlight(session_id: string): Promise<SessionSnapshot> {
    return this.patch(session_id, { in_flight_action: null });
  }

  /**
   * Retira o snapshot. NÃO mata processo — nem quando `browser_pid` está vivo:
   * um pid gravado antes do crash pode ter sido reciclado pelo SO, e matar por
   * pid velho é como este runtime derrubaria um serviço alheio.
   */
  async retire(session_id: string): Promise<boolean> {
    try {
      await unlink(this.file(session_id));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  // ── Leitura ───────────────────────────────────────────────────────────────

  /** Sessões com `state.json`. Sobras `state.json.tmp-*` são ignoradas. */
  async list(): Promise<string[]> {
    let dirs: string[];
    try {
      dirs = (await readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: string[] = [];
    for (const name of dirs.sort()) {
      try {
        assertSafeSessionId(name);
      } catch {
        continue;
      }
      const entries = await readdir(path.join(this.root, name)).catch(() => [] as string[]);
      if (entries.includes(STATE_FILE)) out.push(name);
    }
    return out;
  }

  load(session_id: string): Promise<SnapshotLoad> {
    return this.#load(session_id);
  }

  async #load(session_id: string): Promise<SnapshotLoad> {
    const file = this.file(session_id);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        session_id,
        file,
        ok: false,
        snapshot: null,
        error: code === "ENOENT" ? "snapshot_missing" : "snapshot_unreadable",
        message: code ?? (e instanceof Error ? e.message : String(e)),
        bytes: 0,
      };
    }
    const bytes = Buffer.byteLength(raw, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Exatamente o SIGKILL no meio da escrita: JSON pela metade.
      return {
        session_id,
        file,
        ok: false,
        snapshot: null,
        error: "snapshot_corrupted",
        message: e instanceof Error ? e.message : String(e),
        bytes,
      };
    }
    const check = validateSnapshot(parsed, session_id);
    if (check.error !== null || check.snapshot === null) {
      return {
        session_id,
        file,
        ok: false,
        snapshot: null,
        error: check.error ?? "snapshot_invalid",
        message: check.message,
        bytes,
      };
    }
    return { session_id, file, ok: true, snapshot: check.snapshot, error: null, message: null, bytes };
  }

  // ── Decisão ───────────────────────────────────────────────────────────────

  /** Um veredito por sessão encontrada. Nenhuma fica sem decisão. */
  async scan(): Promise<RecoveryVerdict[]> {
    const ids = await this.list();
    const out: RecoveryVerdict[] = [];
    for (const id of ids) out.push(await this.decide(id));
    return out;
  }

  async decide(session_id: string): Promise<RecoveryVerdict> {
    const load = await this.#load(session_id);
    const base = { session_id, decided_at: nowIso() };

    if (!load.ok || load.snapshot === null) {
      // Snapshot que não se pode ler não descreve sessão nenhuma. Retirar o
      // ARQUIVO é o único ato cabível — não há sequer pid confiável nele.
      return {
        ...base,
        decision: "terminate",
        reason: (load.error ?? "snapshot_invalid") as RecoveryReason,
        detail: { file: load.file, bytes: load.bytes, message: load.message },
        snapshot: null,
        in_flight: null,
        needs_reobservation: false,
      };
    }

    const snap = load.snapshot;
    const in_flight = inFlightVerdict(snap.in_flight_action);

    if (snap.status === "CLOSED") {
      return {
        ...base,
        decision: "terminate",
        reason: "session_closed",
        detail: { status: snap.status },
        snapshot: snap,
        in_flight,
        needs_reobservation: false,
      };
    }

    const orphan = (reason: RecoveryReason, detail: Record<string, unknown>): RecoveryVerdict => ({
      ...base,
      decision: "orphan",
      reason,
      detail,
      snapshot: snap,
      in_flight,
      // Órfã não é reatada; se um dia for reconstruída, será do zero.
      needs_reobservation: true,
    });

    if (snap.browser_pid === null || !Number.isInteger(snap.browser_pid) || snap.browser_pid <= 0) {
      return orphan("browser_pid_unknown", { browser_pid: snap.browser_pid });
    }
    if (!pidAlive(snap.browser_pid)) {
      return orphan("browser_pid_dead", { browser_pid: snap.browser_pid });
    }
    if (snap.cdp_endpoint === null) {
      return orphan("cdp_endpoint_missing", { browser_pid: snap.browser_pid });
    }
    if (snap.browser_id === null || snap.browser_id === "") {
      // Sem identidade gravada não há como provar que aquele CDP é o NOSSO.
      return orphan("cdp_identity_unknown", { browser_pid: snap.browser_pid });
    }

    const probe = await probeCdp(snap.cdp_endpoint, this.probe_timeout_ms);
    if (probe.rejected) {
      return orphan("cdp_endpoint_rejected", { browser_pid: snap.browser_pid, error: probe.error });
    }
    if (!probe.reachable) {
      return orphan("cdp_unreachable", { browser_pid: snap.browser_pid, error: probe.error });
    }
    if (probe.browser_id !== snap.browser_id) {
      // Porta reciclada por outro Chromium. Conectar aqui seria dirigir o
      // navegador errado — possivelmente um de produção.
      return orphan("cdp_identity_mismatch", {
        browser_pid: snap.browser_pid,
        expected_browser_id: snap.browser_id,
        observed_browser_id: probe.browser_id,
        observed_browser: probe.browser,
      });
    }

    if (in_flight !== null) {
      // Browser alcançável, mas a sessão não volta a ACTIVE de graça.
      return {
        ...base,
        decision: "recover",
        reason: "in_flight_unknown_outcome",
        detail: { browser_pid: snap.browser_pid, browser: probe.browser, tool: in_flight.tool },
        snapshot: snap,
        in_flight,
        needs_reobservation: true,
      };
    }

    return {
      ...base,
      decision: "reattach",
      reason: "cdp_alive",
      detail: { browser_pid: snap.browser_pid, browser: probe.browser },
      snapshot: snap,
      in_flight,
      needs_reobservation: false,
    };
  }

  // ── Reattach ──────────────────────────────────────────────────────────────

  /**
   * Reata via `connectOverCDP` e VERIFICA. Aceita apenas vereditos `reattach` e
   * `recover` — para os demais devolve `connected:false` em vez de tentar.
   *
   * A verificação compara a URL esperada e a cardinalidade de abas. `page_ids`
   * do snapshot são ids do runtime morto, não ids de target do CDP: identidade
   * de aba NÃO é reestabelecível, só cardinalidade. Dizer que é seria inventar.
   * Qualquer divergência rebaixa a decisão para `recover` com
   * `needs_reobservation`, nunca "assume que continua onde estava".
   */
  async reattach(verdict: RecoveryVerdict): Promise<ReattachResult> {
    this.#progress({
      phase: "start",
      session_id: verdict.session_id,
      decision: verdict.decision,
      reason: verdict.reason,
      connected: null,
      error: null,
    });
    const out = await this.#reattach(verdict);
    this.#progress({
      phase: "complete",
      session_id: out.session_id,
      decision: out.decision,
      reason: out.reason,
      connected: out.connected,
      error: out.error,
    });
    return out;
  }

  async #reattach(verdict: RecoveryVerdict): Promise<ReattachResult> {
    const snap = verdict.snapshot;
    const shell: ReattachResult = {
      session_id: verdict.session_id,
      connected: false,
      decision: verdict.decision,
      reason: verdict.reason,
      expected_url: snap?.url ?? null,
      observed_urls: [],
      url_matches: false,
      pages_expected: snap?.page_ids.length ?? 0,
      pages_observed: 0,
      needs_reobservation: true,
      in_flight: verdict.in_flight,
      browser: null,
      error: null,
    };

    if (snap === null || (verdict.decision !== "reattach" && verdict.decision !== "recover")) {
      shell.error = `veredito ${verdict.decision} não autoriza reattach`;
      return shell;
    }
    // Guarda própria em vez de confiar no veredito: um `RecoveryVerdict` é um
    // objeto simples e pode chegar montado à mão. Conectar é o ato perigoso —
    // revalida aqui, não presume que quem chamou já validou.
    const endpoint = snap.cdp_endpoint;
    if (endpoint === null || !CDP_ENDPOINT_RE.test(endpoint)) {
      shell.decision = "orphan";
      shell.reason = "cdp_endpoint_rejected";
      shell.error = "endpoint de CDP ausente ou fora de loopback";
      return shell;
    }

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: this.connect_timeout_ms });
    } catch (e) {
      shell.decision = "orphan";
      shell.reason = "reattach_failed";
      shell.error = e instanceof Error ? e.message : String(e);
      return shell;
    }

    const pages = browser.contexts().flatMap((c) => c.pages());
    const urls = pages.map((p) => p.url());
    const url_matches = snap.url === null ? pages.length > 0 : urls.includes(snap.url);
    const pages_match = pages.length === snap.page_ids.length;
    const diverged = !url_matches || !pages_match;

    shell.connected = true;
    shell.browser = browser;
    shell.observed_urls = urls;
    shell.url_matches = url_matches;
    shell.pages_observed = pages.length;

    if (diverged) {
      shell.decision = "recover";
      shell.reason = url_matches ? "pages_divergent" : "url_divergent";
      shell.needs_reobservation = true;
      return shell;
    }
    if (verdict.in_flight !== null) {
      shell.decision = "recover";
      shell.reason = "in_flight_unknown_outcome";
      shell.needs_reobservation = true;
      return shell;
    }

    shell.decision = "reattach";
    shell.reason = "cdp_alive";
    shell.needs_reobservation = false;
    return shell;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  #serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  #writeAtomic(file: string, snap: SessionSnapshot): Promise<void> {
    return this.#serialize(file, () => this.#writeAtomicRaw(file, snap));
  }

  async #writeAtomicRaw(file: string, snap: SessionSnapshot): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const body = `${JSON.stringify(snap, null, 2)}\n`;
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(body, "utf8");
        // fsync ANTES do rename: sem isto o rename pode ganhar a corrida contra
        // os bytes e publicar um arquivo vazio depois de uma queda de energia.
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    // fsync do DIRETÓRIO: o rename já é visível para qualquer leitor desta
    // instância do SO (é isso que blinda contra SIGKILL, o caso desta fase), mas
    // só a entrada de diretório sincronizada sobrevive a uma queda de energia.
    // Best-effort de propósito: há filesystem que recusa abrir diretório para
    // sync, e falhar aqui reprovaria uma gravação que de fato foi concluída.
    try {
      const dir = await open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      /* durabilidade contra queda de energia não obtida; a atomicidade, sim */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Classe da ferramenta. Ferramenta desconhecida ⇒ COMMIT: o mais restritivo. */
export function actionClassOf(tool: string): ActionClass {
  return ACTION_CLASS[tool] ?? "COMMIT";
}

export function inFlightVerdict(action: InFlightAction | null): InFlightVerdict | null {
  if (action === null) return null;
  const action_class = actionClassOf(action.tool);
  return {
    action_id: action.action_id,
    tool: action.tool,
    action_class,
    outcome: "UNKNOWN_OUTCOME",
    // Repetir cegamente um ACT/COMMIT interrompido é o defeito. Só leitura é segura.
    safe_to_retry: action_class === "OBSERVE",
    requires_human_decision: action_class === "COMMIT",
    started_at: action.started_at,
  };
}

interface SnapshotCheck {
  /** null sempre que `error !== null`. Não existe snapshot "meio válido". */
  snapshot: SessionSnapshot | null;
  error: SnapshotLoadError | null;
  message: string | null;
}

const CAP_KEYS = Object.keys(RESTRICTED_CAPABILITIES) as (keyof Capabilities)[];

/** Validação estrutural. Campo faltando é `snapshot_invalid`, não default silencioso. */
export function validateSnapshot(value: unknown, expected_id?: string): SnapshotCheck {
  const bad = (message: string, error: SnapshotLoadError = "snapshot_invalid"): SnapshotCheck => ({
    snapshot: null,
    error,
    message,
  });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("snapshot não é objeto");
  const o = value as Record<string, unknown>;
  if (o.schema !== SNAPSHOT_SCHEMA) return bad(`schema ${String(o.schema)} ≠ ${SNAPSHOT_SCHEMA}`, "schema_unknown");

  const str = (k: string): boolean => typeof o[k] === "string" && (o[k] as string).length > 0;
  for (const k of ["session_id", "owner", "profile", "context_id", "criado_em", "ultima_atividade", "status"]) {
    if (!str(k)) return bad(`campo "${k}" ausente ou vazio`);
  }
  if (expected_id !== undefined && o.session_id !== expected_id) {
    return bad(`session_id do arquivo (${String(o.session_id)}) ≠ diretório (${expected_id})`);
  }
  if (o.url !== null && typeof o.url !== "string") return bad('campo "url" deve ser string ou null');
  if (!Array.isArray(o.page_ids) || o.page_ids.some((p) => typeof p !== "string")) {
    return bad('campo "page_ids" deve ser string[]');
  }
  if (o.cdp_endpoint !== null && typeof o.cdp_endpoint !== "string") return bad('"cdp_endpoint" deve ser string ou null');
  if (o.browser_pid !== null && typeof o.browser_pid !== "number") return bad('"browser_pid" deve ser number ou null');
  if (o.browser_id !== null && typeof o.browser_id !== "string") return bad('"browser_id" deve ser string ou null');
  if (typeof o.ephemeral !== "boolean") return bad('"ephemeral" deve ser boolean');

  const caps = o.capabilities;
  if (typeof caps !== "object" || caps === null) return bad('"capabilities" ausente');
  for (const k of CAP_KEYS) {
    if (typeof (caps as Record<string, unknown>)[k] !== "boolean") return bad(`capability "${k}" ausente ou não-booleana`);
  }

  const inflight = o.in_flight_action;
  if (inflight !== null) {
    if (typeof inflight !== "object" || Array.isArray(inflight)) return bad('"in_flight_action" deve ser objeto ou null');
    const f = inflight as Record<string, unknown>;
    for (const k of ["action_id", "tool", "started_at"]) {
      if (typeof f[k] !== "string" || (f[k] as string).length === 0) {
        return bad(`in_flight_action."${k}" ausente`);
      }
    }
  }

  return { snapshot: o as unknown as SessionSnapshot, error: null, message: null };
}
