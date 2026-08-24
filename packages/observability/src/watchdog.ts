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
