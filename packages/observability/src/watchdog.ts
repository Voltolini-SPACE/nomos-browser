/**
 * WATCHDOG — FASE 20 (ameaça T10 do SECURITY.md)
 *
 * Supervisiona UM processo filho: detecta a morte, distingue parada intencional
 * de crash, e reinicia — com teto.
 *
 * ── Por que existe teto ──────────────────────────────────────────────────────
 * "Reiniciar sempre" é a resposta ingênua. Um daemon que morre no arranque
 * (porta ocupada, config quebrada, disco cheio) reiniciado para sempre vira
 * consumo de CPU, rotação de log e negação de serviço local — a falha original
 * fica ESCONDIDA atrás do loop. Por isso: janela deslizante (N reinícios em
 * W ms) e backoff exponencial COM TETO. Estourado o orçamento, o estado vira
 * `crash_loop`, o watchdog PARA e a causa fica registrada em `stats()`.
 *
 * ── Por que ele só mata o que ele criou ─────────────────────────────────────
 * Nesta máquina há Chromium e serviços NOMOS de PRODUÇÃO. Um watchdog que
 * aceita "mate o pid X" é uma arma apontada para eles: pid é reciclado pelo SO,
 * e um pid guardado há minutos pode ser outro processo agora. Então o único pid
 * sinalizável é o do `ChildProcess` VIVO que este watchdog acabou de criar,
 * confirmado por identidade de objeto — não por número solto. Qualquer outro pid
 * é recusado, contado em `stats().refused_kills` e emitido como `kill_refused`.
 *
 * ── Por que porta ocupada não é crash ───────────────────────────────────────
 * Se a porta já está tomada, subir o filho só produziria um crash imediato e
 * queimaria o orçamento de reinício por um motivo que não é dele. Pior: matar o
 * ocupante seria derrubar o serviço legítimo que já estava ali. Então o
 * watchdog SONDA a porta antes, e ocupada ⇒ estado `port_busy`, sem spawn e sem
 * tocar em quem ocupa.
 *
 * ── Silêncio por padrão ─────────────────────────────────────────────────────
 * stdout/stderr do filho não são capturados nem impressos, salvo
 * `capture_output: true` explícito: a saída de um daemon carrega token e cookie
 * com frequência, e vazá-la para o log do supervisor seria criar o problema que
 * o `redact.ts` existe para evitar.
 *
 * Bind sempre em 127.0.0.1. `0.0.0.0` é recusado na construção.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { nowIso } from "../../core/src/contract.ts";

export type WatchdogState =
  | "idle"
  | "starting"
  | "running"
  | "backoff"
  | "stopped"
  | "crash_loop"
  | "port_busy";

export type WatchdogEventName =
  | "started"
  | "exited"
  | "restarting"
  | "crash_loop"
  | "stopped"
  | "port_busy"
  | "spawn_failed"
  | "kill_refused";

export interface WatchdogEvent {
  name: WatchdogEventName;
  at: string;
  pid: number | null;
  state: WatchdogState;
  detail: Record<string, unknown>;
}

export type CauseKind = "crash" | "intentional" | "port_busy" | "spawn_failed" | "never_started";

export interface WatchdogCause {
  kind: CauseKind;
  at: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  message: string | null;
  /** Só presente com `capture_output: true`. */
  stderr_tail?: string[];
}

export interface WatchdogStats {
  state: WatchdogState;
  pid: number | null;
  /** Reinícios efetivamente executados na vida do watchdog. */
  restarts: number;
  /** Crashes dentro da janela deslizante agora. */
  crashes_in_window: number;
  starts: number;
  last_cause: WatchdogCause | null;
  refused_kills: number;
  started_at: string | null;
  uptime_ms: number | null;
  crash_loop_since: string | null;
}

export interface WatchdogOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Ambiente do filho. Não é logado nem devolvido por `stats()`. */
  env?: Record<string, string>;
  /** Porta que o filho vai ocupar. Sondada antes de cada spawn. */
  port?: number;
  /** Só loopback. Qualquer outro valor é recusado na construção. */
  host?: string;
  /** Reinícios permitidos dentro de `window_ms`. Default 3. */
  max_restarts?: number;
  window_ms?: number;
  /** Base do backoff exponencial. */
  backoff_ms?: number;
  /** TETO do backoff. Sem teto, o intervalo cresce até virar "nunca". */
  backoff_max_ms?: number;
  /** Espera entre SIGTERM e SIGKILL no `stop()`. */
  stop_grace_ms?: number;
  /** Captura stderr/stdout do filho em memória. Default false — ver cabeçalho. */
  capture_output?: boolean;
  /** Linhas retidas quando `capture_output`. */
  output_tail?: number;
  onEvent?: (e: WatchdogEvent) => void;
}

interface StateWaiter {
  state: WatchdogState;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export class Watchdog {
  readonly command: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number | null;
  readonly max_restarts: number;
  readonly window_ms: number;
  readonly backoff_ms: number;
  readonly backoff_max_ms: number;
  readonly stop_grace_ms: number;
  readonly capture_output: boolean;

  #cwd: string | undefined;
  #env: Record<string, string> | undefined;
  #outputTail: number;
  #onEvent: ((e: WatchdogEvent) => void) | null;

  #state: WatchdogState = "idle";
  #child: ChildProcess | null = null;
  /** pid do filho VIVO criado por nós. Único pid que este watchdog sinaliza. */
  #ownedPid: number | null = null;
  #stopping = false;
  #disposed = false;
  #crashes: number[] = [];
  #restarts = 0;
  #starts = 0;
  #refusedKills = 0;
  #cause: WatchdogCause | null = null;
  #startedAt: number | null = null;
  #crashLoopSince: string | null = null;
  #backoffTimer: ReturnType<typeof setTimeout> | null = null;
  #tail: string[] = [];
  #waiters: StateWaiter[] = [];
  #exitWaiters: (() => void)[] = [];

  constructor(opts: WatchdogOptions) {
    if (typeof opts.command !== "string" || opts.command.trim() === "") {
      throw new Error("watchdog: command é obrigatório");
    }
    this.command = opts.command;
    this.args = [...(opts.args ?? [])];
    this.host = opts.host ?? "127.0.0.1";
    if (!LOOPBACK.has(this.host)) {
      // Sondar/expor fora de loopback abriria a superfície de controle (T7).
      throw new Error(`watchdog: host ${JSON.stringify(this.host)} recusado — só loopback`);
    }
    if (opts.port !== undefined) {
      if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
        throw new Error(`watchdog: porta inválida ${String(opts.port)}`);
      }
      this.port = opts.port;
    } else {
      this.port = null;
    }
    this.max_restarts = opts.max_restarts ?? 3;
    if (!Number.isInteger(this.max_restarts) || this.max_restarts < 0) {
      throw new Error(`watchdog: max_restarts inválido ${String(opts.max_restarts)}`);
    }
    this.window_ms = opts.window_ms ?? 60_000;
    this.backoff_ms = opts.backoff_ms ?? 250;
    this.backoff_max_ms = opts.backoff_max_ms ?? 10_000;
    if (this.backoff_max_ms < this.backoff_ms) {
      throw new Error("watchdog: backoff_max_ms menor que backoff_ms — teto abaixo da base");
    }
    this.stop_grace_ms = opts.stop_grace_ms ?? 2_000;
    this.capture_output = opts.capture_output ?? false;
    this.#outputTail = opts.output_tail ?? 20;
    this.#cwd = opts.cwd;
    this.#env = opts.env;
    this.#onEvent = opts.onEvent ?? null;
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  get state(): WatchdogState {
    return this.#state;
  }

  get pid(): number | null {
    return this.#ownedPid;
  }

  stats(): WatchdogStats {
    return {
      state: this.#state,
      pid: this.#ownedPid,
      restarts: this.#restarts,
      crashes_in_window: this.#pruneCrashes().length,
      starts: this.#starts,
      last_cause: this.#cause === null ? null : { ...this.#cause },
      refused_kills: this.#refusedKills,
      started_at: this.#startedAt === null ? null : new Date(this.#startedAt).toISOString(),
      uptime_ms: this.#startedAt === null || this.#child === null ? null : Date.now() - this.#startedAt,
      crash_loop_since: this.#crashLoopSince,
    };
  }

  /** Últimas linhas capturadas. Vazio quando `capture_output` é false. */
  tail(): string[] {
    return [...this.#tail];
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  /**
   * Sobe o filho. Devolve o estado resultante em vez de lançar: porta ocupada e
   * falha de spawn são CONDIÇÕES REPORTADAS, não exceções — quem supervisiona
   * precisa do estado, não de um stack trace.
   */
  async start(): Promise<WatchdogState> {
    if (this.#disposed) throw new Error("watchdog: já descartado");
    if (this.#child !== null) return this.#state;
    this.#stopping = false;
    return this.#spawn();
  }

  async #spawn(): Promise<WatchdogState> {
    if (this.#disposed || this.#stopping) return this.#state;

    if (this.port !== null) {
      const busy = await this.#portBusy();
      if (busy.busy) {
        this.#setState("port_busy");
        this.#cause = {
          kind: "port_busy",
          at: nowIso(),
          code: null,
          signal: null,
          message: `porta ${this.host}:${this.port} ocupada por outro processo — não subimos e NÃO matamos o ocupante`,
        };
        this.#emit("port_busy", null, { host: this.host, port: this.port, errno: busy.code });
        return this.#state;
      }
    }

    this.#setState("starting");
    let child: ChildProcess;
    try {
      child = spawn(this.command, [...this.args], {
        cwd: this.#cwd,
        env: this.#env,
        stdio: this.capture_output ? ["ignore", "pipe", "pipe"] : "ignore",
        detached: false,
      });
    } catch (e) {
      this.#setState("idle");
      this.#cause = {
        kind: "spawn_failed",
        at: nowIso(),
        code: null,
        signal: null,
        message: e instanceof Error ? e.message : String(e),
      };
      this.#emit("spawn_failed", null, { message: this.#cause.message });
      return this.#state;
    }

    this.#child = child;
    this.#ownedPid = child.pid ?? null;
    this.#starts += 1;
    this.#startedAt = Date.now();

    if (this.capture_output) {
      child.stdout?.on("data", (b: Buffer) => this.#pushTail(b));
      child.stderr?.on("data", (b: Buffer) => this.#pushTail(b));
    }

    // "error" sem "spawn": binário inexistente, permissão. Não é crash do filho.
    child.once("error", (err: Error) => {
      if (this.#child !== child) return;
      this.#cause = { kind: "spawn_failed", at: nowIso(), code: null, signal: null, message: err.message };
      this.#emit("spawn_failed", child.pid ?? null, { message: err.message });
    });

    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#onExit(code, signal);
    });

    this.#setState("running");
    this.#emit("started", this.#ownedPid, { command: this.command, starts: this.#starts });
    return this.#state;
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const pid = this.#ownedPid;
    this.#child = null;
    this.#ownedPid = null;
    this.#startedAt = null;
    for (const w of this.#exitWaiters.splice(0)) w();

    if (this.#stopping) {
      // Parada INTENCIONAL: pedimos, ele saiu. Não conta crash, não reinicia.
      this.#cause = { kind: "intentional", at: nowIso(), code, signal, message: "parada pedida por stop()" };
      this.#setState("stopped");
      this.#emit("exited", pid, { code, signal, intentional: true });
      this.#emit("stopped", pid, { code, signal });
      return;
    }

    // Saída não pedida é CRASH — inclusive exit 0. Um daemon que devia estar de
    // pé e saiu limpo continua sendo indisponibilidade; tratar 0 como "tudo bem"
    // esconderia justamente a falha de arranque silenciosa.
    const cause: WatchdogCause = {
      kind: "crash",
      at: nowIso(),
      code,
      signal,
      message: signal !== null ? `morto por ${signal}` : `saiu com código ${String(code)}`,
    };
    if (this.capture_output) cause.stderr_tail = [...this.#tail];
    this.#cause = cause;
    this.#emit("exited", pid, { code, signal, intentional: false });

    const crashes = this.#pruneCrashes();
    crashes.push(Date.now());
    this.#crashes = crashes;

    const already = crashes.length - 1; // reinícios já gastos nesta janela
    if (already >= this.max_restarts) {
      this.#crashLoopSince = nowIso();
      this.#setState("crash_loop");
      this.#emit("crash_loop", null, {
        crashes_in_window: crashes.length,
        max_restarts: this.max_restarts,
        window_ms: this.window_ms,
        cause: { code, signal, message: cause.message },
      });
      return;
    }

    const delay = Math.min(this.backoff_max_ms, this.backoff_ms * 2 ** already);
    this.#restarts += 1;
    this.#setState("backoff");
    this.#emit("restarting", null, { attempt: this.#restarts, delay_ms: delay, code, signal });
    const t = setTimeout(() => {
      this.#backoffTimer = null;
      void this.#spawn();
    }, delay);
    // O timer de backoff não é motivo para o processo seguir vivo.
    t.unref();
    this.#backoffTimer = t;
  }

  /**
   * Parada intencional. SIGTERM no filho que criamos; se não sair na carência,
   * SIGKILL — ainda no MESMO objeto de filho, nunca num pid solto.
   */
  async stop(): Promise<WatchdogState> {
    this.#stopping = true;
    if (this.#backoffTimer !== null) {
      clearTimeout(this.#backoffTimer);
      this.#backoffTimer = null;
    }
    const child = this.#child;
    if (child === null) {
      this.#setState("stopped");
      if (this.#cause === null) {
        this.#cause = { kind: "never_started", at: nowIso(), code: null, signal: null, message: "stop() sem filho vivo" };
      }
      return this.#state;
    }

    const exited = new Promise<void>((resolve) => this.#exitWaiters.push(resolve));
    this.#signalOwned(child, "SIGTERM");

    let hardened = false;
    const grace = setTimeout(() => {
      hardened = true;
      if (this.#child === child) this.#signalOwned(child, "SIGKILL");
    }, this.stop_grace_ms);
    grace.unref();
    try {
      await exited;
    } finally {
      clearTimeout(grace);
    }
    if (hardened) {
      this.#emit("stopped", null, { escalated_to_sigkill: true, grace_ms: this.stop_grace_ms });
    }
    return this.#state;
  }

  /**
   * Zera o orçamento de reinícios. É ato EXPLÍCITO de quem opera: sair de
   * `crash_loop` sozinho, por tempo, devolveria o laço infinito pela porta dos
   * fundos — só que mais devagar.
   */
  reset(): void {
    this.#crashes = [];
    this.#crashLoopSince = null;
    if (this.#state === "crash_loop") this.#setState("idle");
  }

  /** Para e desarma. Depois disto o watchdog não sobe mais nada. */
  async dispose(): Promise<void> {
    await this.stop();
    this.#disposed = true;
    for (const w of this.#waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  // ── Matar: só o que é nosso ───────────────────────────────────────────────

  /**
   * Sinaliza um pid SE E SOMENTE SE for o filho vivo criado por este watchdog.
   * Qualquer outro número é recusado — inclusive um pid que já foi nosso, porque
   * depois da morte o SO pode tê-lo entregado a outro processo.
   *
   * ATENÇÃO: isto NÃO é parada intencional. A morte resultante entra pelo mesmo
   * caminho de um crash e dispara reinício, consumindo orçamento da janela.
   * Para parar de propósito existe `stop()`.
   */
  killOwned(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      // pid<=0 em process.kill atinge o GRUPO de processos. Nunca.
      this.#refuse(pid, "pid inválido");
      return false;
    }
    const child = this.#child;
    if (child === null || child.pid !== pid || this.#ownedPid !== pid) {
      this.#refuse(pid, "pid não pertence a este watchdog");
      return false;
    }
    return this.#signalOwned(child, signal);
  }

  /** true só para o pid do filho vivo que este watchdog criou. */
  owns(pid: number): boolean {
    return Number.isInteger(pid) && pid > 0 && this.#child !== null && this.#child.pid === pid;
  }

  #refuse(pid: number, why: string): void {
    this.#refusedKills += 1;
    this.#emit("kill_refused", this.#ownedPid, { refused_pid: pid, why });
  }

  #signalOwned(child: ChildProcess, signal: NodeJS.Signals): boolean {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      // Sinaliza pelo OBJETO do filho, não por número reconstruído.
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  // ── Porta ─────────────────────────────────────────────────────────────────

  /**
   * Sonda por bind: é a mesma pergunta que o filho fará ("consigo escutar?").
   * Corrida residual e assumida: entre fechar a sonda e o filho subir, alguém
   * pode tomar a porta — aí o filho morre e vira crash normal, com teto.
   */
  async #portBusy(): Promise<{ busy: boolean; code: string | null }> {
    const port = this.port;
    if (port === null) return { busy: false, code: null };
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", (e: NodeJS.ErrnoException) => {
        resolve({ busy: e.code === "EADDRINUSE" || e.code === "EACCES", code: e.code ?? null });
      });
      srv.listen({ host: this.host, port, exclusive: true }, () => {
        srv.close(() => resolve({ busy: false, code: null }));
      });
    });
  }

  // ── Espera por condição (evita sleep em quem consome) ─────────────────────

  /**
   * Resolve quando o estado for atingido. REJEITA no timeout: um watchdog que
   * nunca chega ao estado esperado tem de falhar alto, não pendurar o chamador.
   */
  waitForState(state: WatchdogState, timeout_ms = 10_000): Promise<void> {
    if (this.#state === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`watchdog: timeout esperando estado "${state}" (atual "${this.#state}")`));
      }, timeout_ms);
      timer.unref();
      this.#waiters.push({ state, resolve, timer });
    });
  }

  #setState(next: WatchdogState): void {
    this.#state = next;
    const keep: StateWaiter[] = [];
    for (const w of this.#waiters) {
      if (w.state === next) {
        clearTimeout(w.timer);
        w.resolve();
      } else {
        keep.push(w);
      }
    }
    this.#waiters = keep;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  #pruneCrashes(): number[] {
    const cutoff = Date.now() - this.window_ms;
    return this.#crashes.filter((t) => t >= cutoff);
  }

  #pushTail(chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.#tail.push(line);
    }
    while (this.#tail.length > this.#outputTail) this.#tail.shift();
  }

  #emit(name: WatchdogEventName, pid: number | null, detail: Record<string, unknown>): void {
    const hook = this.#onEvent;
    if (hook === null) return;
    try {
      hook({ name, at: nowIso(), pid, state: this.#state, detail });
    } catch {
      // Hook quebrado não derruba supervisão. Também não vira log — a exceção do
      // chamador é dele; engolir aqui é preferível a matar o filho por causa dela.
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE 13 — WATCHDOG DENTRO DO RUNTIME
//
// POR QUE UMA SEGUNDA CLASSE, E NÃO A `Watchdog` ACIMA
// ---------------------------------------------------
// A `Watchdog` acima supervisiona um PROCESSO FILHO: ela dá spawn, observa a
// saída, reinicia com backoff e trava em `crash_loop`. É a peça certa para o
// supervisor de fora (FASE 14) e a peça errada para dentro do daemon: um
// processo não se dá spawn a si mesmo, e fingir que sim produziria um watchdog
// decorativo — que era exatamente o problema desta fase (557 linhas escritas,
// zero instanciações no runtime).
//
// O que o daemon precisa é de um SUPERVISOR DE SUBSISTEMAS: bater o próprio
// pulso, sondar navegador, worker e task, agir sobre o que consegue consertar, e
// PARAR de agir quando insistir vira dano. A política de backoff, janela
// deslizante e trava de crash-loop é a MESMA — e por isso mora neste arquivo,
// junto da outra, em vez de virar uma segunda implementação divergente.
//
// A REGRA QUE ESTA CLASSE EXISTE PARA NÃO QUEBRAR (T10 do SECURITY.md)
// -------------------------------------------------------------------
// "Um watchdog que reinicia sem teto transforma falha em negação de serviço
// local." Depois de `max_restarts` recuperações da MESMA falha dentro da janela,
// ele vai para `degraded` e PARA. Degradado é um estado terminal declarado, com
// linha na trilha — não um watchdog que desistiu em silêncio.
// ═════════════════════════════════════════════════════════════════════════════

export type FalhaKind =
  | "daemon_frozen"
  | "browser_dead"
  | "worker_stuck"
  | "heartbeat_expired"
  | "task_stalled";

export type HealthState = "idle" | "running" | "degraded" | "stopped";

export interface HealthEvent {
  name: "tick" | "detected" | "recovered" | "recover_failed" | "degraded" | "started" | "stopped";
  at: string;
  state: HealthState;
  kind: FalhaKind | null;
  detail: Record<string, unknown>;
}

/**
 * Uma sonda. `check` NUNCA tem efeito colateral — é chamada em laço. `recover`
 * tem, e por isso passa pelo contador de tentativas e pelo backoff.
 */
export interface HealthProbe {
  kind: FalhaKind;
  check: () => Promise<{ ok: boolean; detail?: Record<string, unknown> }>;
  /** Ausente ⇒ a falha é REPORTADA e não há o que reiniciar (ex.: congelamento já passou). */
  recover?: (detail: Record<string, unknown>) => Promise<void>;
}

export interface HealthWatchdogOptions {
  interval_ms: number;
  /** Recuperações da MESMA falha dentro de `window_ms` antes de degradar. */
  max_restarts: number;
  window_ms?: number;
  backoff_ms?: number;
  backoff_max_ms?: number;
  /**
   * Atraso do laço a partir do qual o daemon é declarado CONGELADO.
   *
   * Detecção por DERIVA, e não por um timer que "deveria" ter disparado: quando
   * o event loop está travado, nenhum timer dispara — inclusive o que fiscalizaria
   * o travamento. O que dá para observar é que o tique seguinte chegou muito
   * depois do que devia, e isso prova que o loop ESTEVE bloqueado.
   */
  heartbeat_timeout_ms?: number;
  probes?: HealthProbe[];
  now?: () => number;
  onEvent?: (e: HealthEvent) => void;
}

export interface HealthStats {
  state: HealthState;
  ticks: number;
  last_tick_at: string | null;
  /** Maior atraso já observado entre dois tiques, em ms. */
  max_drift_ms: number;
  /**
   * Quantas vezes o laço ficou travado além do limite, e por quanto na última.
   *
   * Existe porque `frozen` medido no instante da leitura é inútil na prática:
   * enquanto o event loop está travado, o servidor HTTP também está, e ninguém
   * consegue perguntar. Quando a resposta finalmente sai, o tique atrasado já
   * correu e o relógio já parece normal. O CONTADOR sobrevive ao episódio — é
   * ele que responde "este daemon travou hoje?".
   */
  freezes: number;
  last_freeze_ms: number | null;
  last_freeze_at: string | null;
  detected: Record<string, number>;
  recovered: Record<string, number>;
  failed_recoveries: Record<string, number>;
  degraded_by: FalhaKind | null;
  degraded_since: string | null;
}

export class HealthWatchdog {
  readonly interval_ms: number;
  readonly max_restarts: number;
  readonly window_ms: number;
  readonly backoff_ms: number;
  readonly backoff_max_ms: number;
  readonly heartbeat_timeout_ms: number;

  #probes: HealthProbe[];
  #now: () => number;
  #onEvent: ((e: HealthEvent) => void) | null;
  #state: HealthState = "idle";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticks = 0;
  #lastTick: number | null = null;
  #maxDrift = 0;
  /** Instantes das recuperações tentadas, por tipo de falha (janela deslizante). */
  #tentativas = new Map<FalhaKind, number[]>();
  /** Até quando esta falha está em backoff. */
  #esperaAte = new Map<FalhaKind, number>();
  #detected = new Map<FalhaKind, number>();
  #recovered = new Map<FalhaKind, number>();
  #falhasDeRecuperacao = new Map<FalhaKind, number>();
  #freezes = 0;
  #lastFreezeMs: number | null = null;
  #lastFreezeAt: string | null = null;
  #degradedBy: FalhaKind | null = null;
  #degradedSince: string | null = null;
  #emVoo = false;

  constructor(opts: HealthWatchdogOptions) {
    if (!Number.isInteger(opts.interval_ms) || opts.interval_ms < 10) {
      throw new Error(`health watchdog: interval_ms inválido ${String(opts.interval_ms)}`);
    }
    if (!Number.isInteger(opts.max_restarts) || opts.max_restarts < 0) {
      throw new Error(`health watchdog: max_restarts inválido ${String(opts.max_restarts)}`);
    }
    this.interval_ms = opts.interval_ms;
    this.max_restarts = opts.max_restarts;
    this.window_ms = opts.window_ms ?? Math.max(60_000, opts.interval_ms * 20);
    this.backoff_ms = opts.backoff_ms ?? Math.max(100, Math.floor(opts.interval_ms / 2));
    this.backoff_max_ms = opts.backoff_max_ms ?? Math.max(this.backoff_ms, opts.interval_ms * 8);
    if (this.backoff_max_ms < this.backoff_ms) {
      throw new Error("health watchdog: backoff_max_ms menor que backoff_ms — teto abaixo da base");
    }
    // 3x o intervalo: um tique atrasado por escalonamento normal do SO não pode
    // ser confundido com daemon travado, ou o alarme vira ruído e é desligado.
    this.heartbeat_timeout_ms = opts.heartbeat_timeout_ms ?? opts.interval_ms * 3;
    this.#probes = [...(opts.probes ?? [])];
    this.#now = opts.now ?? (() => Date.now());
    this.#onEvent = opts.onEvent ?? null;
  }

  get state(): HealthState {
    return this.#state;
  }

  addProbe(p: HealthProbe): void {
    this.#probes.push(p);
  }

  stats(): HealthStats {
    const mapa = (m: Map<FalhaKind, number>): Record<string, number> => Object.fromEntries(m);
    return {
      state: this.#state,
      ticks: this.#ticks,
      last_tick_at: this.#lastTick === null ? null : new Date(this.#lastTick).toISOString(),
      max_drift_ms: this.#maxDrift,
      freezes: this.#freezes,
      last_freeze_ms: this.#lastFreezeMs,
      last_freeze_at: this.#lastFreezeAt,
      detected: mapa(this.#detected),
      recovered: mapa(this.#recovered),
      failed_recoveries: mapa(this.#falhasDeRecuperacao),
      degraded_by: this.#degradedBy,
      degraded_since: this.#degradedSince,
    };
  }

  start(): void {
    if (this.#state === "running" || this.#state === "degraded") return;
    this.#state = "running";
    this.#lastTick = this.#now();
    this.#emit("started", null, { interval_ms: this.interval_ms, probes: this.#probes.map((p) => p.kind) });
    this.#agendar();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#state !== "stopped") {
      this.#state = this.#state === "degraded" ? "degraded" : "stopped";
      this.#emit("stopped", null, {});
    }
  }

  #agendar(): void {
    if (this.#state !== "running") return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#agendar());
    }, this.interval_ms);
    // `unref` para que o watchdog não segure o processo vivo sozinho: um daemon
    // que não morre porque o vigia dele está de plantão é o vigia virando defeito.
    this.#timer.unref?.();
  }

  /**
   * Um ciclo. Exposto porque teste de watchdog que depende de `setTimeout` real
   * é teste lento e instável — e porque provocar a falha e mandar olhar AGORA é
   * mais honesto do que dormir e torcer.
   */
  async tick(): Promise<HealthStats> {
    if (this.#emVoo) return this.stats();
    if (this.#state === "stopped") return this.stats();
    this.#emVoo = true;
    try {
      const agora = this.#now();
      // ── pulso ──────────────────────────────────────────────────────────────
      if (this.#lastTick !== null) {
        const decorrido = agora - this.#lastTick;
        const deriva = decorrido - this.interval_ms;
        if (deriva > this.#maxDrift) this.#maxDrift = deriva;
        if (decorrido > this.heartbeat_timeout_ms) {
          // O loop ESTEVE travado. Não há o que reiniciar — o congelamento já
          // passou —, mas ficar calado esconderia o único sintoma disponível.
          this.#freezes += 1;
          this.#lastFreezeMs = decorrido;
          this.#lastFreezeAt = new Date(agora).toISOString();
          this.#contar(this.#detected, "heartbeat_expired");
          this.#emit("detected", "heartbeat_expired", {
            decorrido_ms: decorrido,
            esperado_ms: this.interval_ms,
            limite_ms: this.heartbeat_timeout_ms,
            diagnostico: "o event loop ficou bloqueado entre dois tiques",
          });
        }
      }
      this.#lastTick = agora;
      this.#ticks += 1;

      // ── sondas ─────────────────────────────────────────────────────────────
      for (const probe of this.#probes) {
        if (this.#state === "degraded") break;
        let r: { ok: boolean; detail?: Record<string, unknown> };
        try {
          r = await probe.check();
        } catch (e) {
          // Sonda que lança é sonda quebrada: reportar como falha do subsistema
          // seria acusar o inocente.
          this.#emit("recover_failed", probe.kind, { fase: "check", erro: (e as Error).message });
          continue;
        }
        if (r.ok) continue;

        const detalhe = r.detail ?? {};
        this.#contar(this.#detected, probe.kind);
        this.#emit("detected", probe.kind, detalhe);

        if (probe.recover === undefined) continue;

        // Backoff: enquanto está esperando, não tenta de novo.
        const espera = this.#esperaAte.get(probe.kind) ?? 0;
        if (agora < espera) continue;

        const janela = this.#janela(probe.kind, agora);
        if (janela.length >= this.max_restarts) {
          this.#degradar(probe.kind, { tentativas: janela.length, janela_ms: this.window_ms, ...detalhe });
          break;
        }
        janela.push(agora);
        this.#tentativas.set(probe.kind, janela);
        // Backoff exponencial COM TETO. Sem teto, a enésima espera vira "nunca",
        // e "nunca" com cara de "em breve" é pior que degradar explicitamente.
        const atraso = Math.min(this.backoff_max_ms, this.backoff_ms * 2 ** (janela.length - 1));
        this.#esperaAte.set(probe.kind, agora + atraso);

        try {
          await probe.recover(detalhe);
          this.#contar(this.#recovered, probe.kind);
          this.#emit("recovered", probe.kind, { tentativa: janela.length, proximo_backoff_ms: atraso, ...detalhe });
        } catch (e) {
          this.#contar(this.#falhasDeRecuperacao, probe.kind);
          this.#emit("recover_failed", probe.kind, {
            fase: "recover",
            tentativa: janela.length,
            erro: (e as Error).message,
          });
        }
      }
      this.#emit("tick", null, { ticks: this.#ticks });
      return this.stats();
    } finally {
      this.#emVoo = false;
    }
  }

  #janela(kind: FalhaKind, agora: number): number[] {
    const todas = this.#tentativas.get(kind) ?? [];
    const vivas = todas.filter((t) => agora - t <= this.window_ms);
    this.#tentativas.set(kind, vivas);
    return vivas;
  }

  #degradar(kind: FalhaKind, detalhe: Record<string, unknown>): void {
    if (this.#state === "degraded") return;
    this.#state = "degraded";
    this.#degradedBy = kind;
    this.#degradedSince = new Date(this.#now()).toISOString();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#emit("degraded", kind, {
      ...detalhe,
      max_restarts: this.max_restarts,
      // A frase é para quem lê a trilha às 3 da manhã.
      decisao: "parei de tentar recuperar: insistir além do teto vira negação de serviço local",
    });
  }

  #contar(m: Map<FalhaKind, number>, k: FalhaKind): void {
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  #emit(name: HealthEvent["name"], kind: FalhaKind | null, detail: Record<string, unknown>): void {
    const hook = this.#onEvent;
    if (hook === null) return;
    try {
      hook({ name, at: nowIso(), state: this.#state, kind, detail });
    } catch (err) {
      // Hook que lança não pode derrubar o vigia.
      console.error(`[health-watchdog] hook lançou em ${name}:`, err instanceof Error ? err.message : String(err));
    }
  }
}
