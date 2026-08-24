/**
 * FASE 10 — POINTER ENGINE
 *
 * Motor de ponteiro com DOIS backends de input real:
 *
 *   "cdp"        — Input.dispatchMouseEvent cru via CDPSession
 *   "playwright" — page.mouse.*
 *
 * Ambos produzem eventos com `isTrusted=true` (o discriminador que o spike da
 * FASE 1 fixou). Um clique sintetizado por JavaScript chega com isTrusted=false
 * e por isso nunca é caminho aceitável aqui — nem como fallback.
 *
 * Este arquivo também hospeda a espinha compartilhada de input (erro tipado,
 * seleção de backend, emissão de evento) porque o KeyboardEngine da FASE 11
 * precisa exatamente das mesmas peças; duplicá-las abriria espaço para as duas
 * metades divergirem em política de fallback — que é justamente a parte que não
 * pode mentir.
 */
import type { CDPSession, Page } from "playwright";
import type { ActionErrorCode, EventName, RuntimeEvent } from "./contract.ts";
import { nowIso } from "./contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Espinha compartilhada de input (usada também por keyboard.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type InputBackend = "cdp" | "playwright";

export interface Point {
  x: number;
  y: number;
}

export type MouseButton = "left" | "right" | "middle";

/**
 * Erro de input com código do contrato acoplado. A camada de API converte isto
 * em `ActionResponse.error` sem precisar adivinhar o código — requisito de
 * "nada de fallback silencioso": todo erro chega ao envelope com identidade.
 */
export class InputError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ActionErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "InputError";
    this.code = code;
    this.detail = detail;
  }
}

/** Bits de modificador do CDP (Input domain). Compartilhado com o teclado. */
export const MODIFIER_BITS: Readonly<Record<string, number>> = Object.freeze({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
});

export function modifierMask(names: readonly string[]): number {
  let mask = 0;
  for (const raw of names) {
    const canonical = canonicalModifier(raw);
    if (canonical === null) {
      throw new InputError("INVALID_REQUEST", `modificador desconhecido: ${JSON.stringify(raw)}`, { modifier: raw });
    }
    mask |= MODIFIER_BITS[canonical]!;
  }
  return mask;
}

/** Aliases aceitos: CMD/Command/Super viram Meta; Option vira Alt; CTRL vira Control. */
export function canonicalModifier(raw: string): "Alt" | "Control" | "Meta" | "Shift" | null {
  switch (raw.trim().toLowerCase()) {
    case "alt":
    case "option":
    case "opt":
      return "Alt";
    case "control":
    case "ctrl":
      return "Control";
    case "meta":
    case "cmd":
    case "command":
    case "super":
    case "win":
      return "Meta";
    case "shift":
      return "Shift";
    default:
      return null;
  }
}

export interface InputEngineOptions {
  page: Page;
  /** Sessão CDP já aberta. Se ausente e o backend for "cdp", é criada sob demanda. */
  cdp?: CDPSession | null;
  /** Backend primário. Default "cdp" (controle mais cru, menos camadas mentindo). */
  backend?: InputBackend;
  /** Backend de socorro. "none" = fail closed, o erro sobe. Default: o outro backend. */
  fallback?: InputBackend | "none";
  session_id?: string | null;
  /** Identidade de quem originou o input. Default "runtime". */
  source?: string;
  onEvent?: (event: RuntimeEvent) => void;
}

/**
 * Cria/reaproveita a sessão CDP. Só o Chromium expõe `newCDPSession`; em outro
 * motor isto falha alto (BROWSER_UNAVAILABLE) para o fallback ser registrado,
 * nunca escondido.
 */
export async function ensureCdpSession(page: Page, existing: CDPSession | null): Promise<CDPSession> {
  if (existing !== null) return existing;
  const context = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<CDPSession> };
  if (typeof context.newCDPSession !== "function") {
    throw new InputError("BROWSER_UNAVAILABLE", "backend cdp indisponível: contexto não expõe newCDPSession", {
      backend: "cdp",
    });
  }
  try {
    return await context.newCDPSession(page);
  } catch (err) {
    throw new InputError("BROWSER_UNAVAILABLE", `backend cdp indisponível: ${errText(err)}`, { backend: "cdp" });
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BackendOutcome<T> {
  backend: InputBackend;
  requested_backend: InputBackend;
  fallback_used: boolean;
  fallback_reason: string | null;
  value: T;
}

/**
 * Executa o gesto no backend primário e, se ele falhar, no backend de socorro.
 *
 * O gesto INTEIRO é reexecutado no fallback — um drag que morreu depois do
 * mousedown pode, portanto, deixar efeito parcial antes da segunda tentativa.
 * Por isso `fallback_reason` volta preenchido: quem chamou tem de conseguir ver
 * que houve troca de backend e por quê. Fallback que não aparece no resultado
 * seria exatamente o "fallback silencioso" proibido pela missão.
 */
export async function withBackend<T>(
  cfg: { primary: InputBackend; fallback: InputBackend | "none" },
  run: (backend: InputBackend) => Promise<T>,
): Promise<BackendOutcome<T>> {
  try {
    const value = await run(cfg.primary);
    return {
      backend: cfg.primary,
      requested_backend: cfg.primary,
      fallback_used: false,
      fallback_reason: null,
      value,
    };
  } catch (primaryErr) {
    const primaryReason = errText(primaryErr);
    if (cfg.fallback === "none" || cfg.fallback === cfg.primary) {
      if (primaryErr instanceof InputError) throw primaryErr;
      throw new InputError("INTERNAL", `backend ${cfg.primary} falhou: ${primaryReason}`, {
        backend: cfg.primary,
        fallback: cfg.fallback,
      });
    }
    try {
      const value = await run(cfg.fallback);
      return {
        backend: cfg.fallback,
        requested_backend: cfg.primary,
        fallback_used: true,
        fallback_reason: primaryReason,
        value,
      };
    } catch (fallbackErr) {
      throw new InputError(
        "INTERNAL",
        `ambos os backends de input falharam (${cfg.primary}: ${primaryReason}) (${cfg.fallback}: ${errText(fallbackErr)})`,
        {
          primary_backend: cfg.primary,
          primary_error: primaryReason,
          fallback_backend: cfg.fallback,
          fallback_error: errText(fallbackErr),
        },
      );
    }
  }
}

export function defaultFallback(primary: InputBackend): InputBackend {
  return primary === "cdp" ? "playwright" : "cdp";
}

export function makeEmitter(opts: InputEngineOptions): (
  event: EventName,
  payload: Record<string, unknown>,
  action_id?: string | null,
) => void {
  const hook = opts.onEvent;
  const session_id = opts.session_id ?? null;
  const source = opts.source ?? "runtime";
  return (event, payload, action_id = null) => {
    if (hook === undefined) return;
    const runtimeEvent: RuntimeEvent = {
      timestamp: nowIso(),
      session_id,
      action_id,
      source,
      event,
      payload,
    };
    hook(runtimeEvent);
  };
}

function assertFinitePoint(p: Point, label: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new InputError("INVALID_REQUEST", `coordenada inválida em ${label}`, { point: p });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pointer
// ─────────────────────────────────────────────────────────────────────────────

export type PointerAction =
  | "move"
  | "hover"
  | "click"
  | "double_click"
  | "right_click"
  | "mouse_down"
  | "mouse_up"
  | "drag"
  | "scroll";

export interface PointerResult {
  action: PointerAction;
  /** Backend que REALMENTE agiu. Pode diferir de `requested_backend`. */
  backend: InputBackend;
  requested_backend: InputBackend;
  fallback_used: boolean;
  /** Motivo textual da troca de backend. null quando não houve troca. */
  fallback_reason: string | null;
  from: Point;
  to: Point;
  duration_ms: number;
  /** Passos de interpolação efetivamente dispatchados (1 = teleporte). */
  steps: number;
  button: MouseButton | null;
  click_count: number | null;
  delta: { dx: number; dy: number } | null;
}

export interface MoveOptions {
  /** Passos de interpolação. >1 humaniza o traço. */
  steps?: number;
  /** Atalho para `steps = human_steps` do engine. */
  humanize?: boolean;
  /** Curvatura em px (deslocamento perpendicular no meio do traço). 0 = reta. */
  curve?: number;
  /** Pausa entre passos. Default 0 — sleep aqui é cosmético, nunca mecanismo. */
  step_delay_ms?: number;
  modifiers?: readonly string[];
  action_id?: string | null;
}

export interface ClickOptions extends MoveOptions {
  button?: MouseButton;
  /** Pausa entre press e release. Default 0. */
  hold_ms?: number;
}

export interface DragOptions extends MoveOptions {
  button?: MouseButton;
}

export interface ScrollOptions extends MoveOptions {
  /** Onde posicionar o cursor antes de rolar. Default: posição corrente. */
  at?: Point;
}

export interface PointerEngineOptions extends InputEngineOptions {
  /** Passos default de todo movimento. 1 = teleporte. */
  steps?: number;
  /** Passos usados quando a chamada pede `humanize: true`. Default 12. */
  human_steps?: number;
  curve?: number;
  /** Posição inicial conhecida do cursor. O CDP não guarda estado de mouse. */
  position?: Point;
}

const BUTTON_BIT: Readonly<Record<MouseButton, number>> = Object.freeze({ left: 1, right: 2, middle: 4 });
const DEFAULT_HUMAN_STEPS = 12;

function maskToButton(mask: number): "none" | MouseButton {
  if ((mask & BUTTON_BIT.left) !== 0) return "left";
  if ((mask & BUTTON_BIT.right) !== 0) return "right";
  if ((mask & BUTTON_BIT.middle) !== 0) return "middle";
  return "none";
}

/**
 * Interpolação com easing cúbico e curvatura opcional. DETERMINÍSTICA de
 * propósito: humanizar com ruído aleatório tornaria o motor impossível de
 * testar, e a propriedade que interessa (existir posição intermediária, tanto
 * para não teleportar o cursor quanto para o cursor visual da FASE 31 animar)
 * não depende de aleatoriedade.
 */
export function interpolatePath(from: Point, to: Point, steps: number, curve = 0): Point[] {
  const n = Math.max(1, Math.floor(steps));
  if (n === 1) return [{ x: to.x, y: to.y }];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  // Normal unitária ao traço; com len 0 não há direção e a curvatura é ignorada.
  const nx = len === 0 ? 0 : -dy / len;
  const ny = len === 0 ? 0 : dx / len;
  const path: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const bow = curve * Math.sin(Math.PI * t);
    path.push({ x: from.x + dx * e + nx * bow, y: from.y + dy * e + ny * bow });
  }
  // Garante aterrissagem exata no alvo — easing acumula erro de ponto flutuante.
  path[path.length - 1] = { x: to.x, y: to.y };
  return path;
}

export class PointerEngine {
  readonly page: Page;
  #cdp: CDPSession | null;
  #backend: InputBackend;
  #fallback: InputBackend | "none";
  #steps: number;
  #humanSteps: number;
  #curve: number;
  #position: Point;
  /** Máscara de botões pressionados. O CDP não guarda estado — nós guardamos. */
  #buttons = 0;
  #emit: ReturnType<typeof makeEmitter>;

  constructor(opts: PointerEngineOptions) {
    this.page = opts.page;
    this.#cdp = opts.cdp ?? null;
    this.#backend = opts.backend ?? "cdp";
    this.#fallback = opts.fallback ?? defaultFallback(this.#backend);
    this.#steps = Math.max(1, Math.floor(opts.steps ?? 1));
    this.#humanSteps = Math.max(1, Math.floor(opts.human_steps ?? DEFAULT_HUMAN_STEPS));
    this.#curve = opts.curve ?? 0;
    this.#position = { x: opts.position?.x ?? 0, y: opts.position?.y ?? 0 };
    this.#emit = makeEmitter(opts);
  }

  get backend(): InputBackend {
    return this.#backend;
  }

  /** Posição corrente do cursor mantida pelo engine (cópia, não referência). */
  get position(): Point {
    return { x: this.#position.x, y: this.#position.y };
  }

  /** Botões pressionados agora, para diagnóstico e para o takeover da FASE 32. */
  get pressedButtons(): MouseButton[] {
    return (Object.keys(BUTTON_BIT) as MouseButton[]).filter((b) => (this.#buttons & BUTTON_BIT[b]) !== 0);
  }

  /** Ressincroniza a posição sem dispatchar input (ex.: após takeover humano). */
  setPosition(p: Point): void {
    assertFinitePoint(p, "setPosition");
    this.#position = { x: p.x, y: p.y };
  }

  async move(to: Point, opts: MoveOptions = {}): Promise<PointerResult> {
    return this.#travel("move", to, opts, "mouse.moved");
  }

  async hover(to: Point, opts: MoveOptions = {}): Promise<PointerResult> {
    return this.#travel("hover", to, opts, "mouse.moved");
  }

  async click(to: Point | null = null, opts: ClickOptions = {}): Promise<PointerResult> {
    return this.#clickLike("click", to, 1, opts.button ?? "left", opts);
  }

  async doubleClick(to: Point | null = null, opts: ClickOptions = {}): Promise<PointerResult> {
    return this.#clickLike("double_click", to, 2, opts.button ?? "left", opts);
  }

  async rightClick(to: Point | null = null, opts: ClickOptions = {}): Promise<PointerResult> {
    return this.#clickLike("right_click", to, 1, opts.button ?? "right", opts);
  }

  async mouseDown(to: Point | null = null, opts: ClickOptions = {}): Promise<PointerResult> {
    return this.#buttonEdge("mouse_down", to, opts);
  }

  async mouseUp(to: Point | null = null, opts: ClickOptions = {}): Promise<PointerResult> {
    return this.#buttonEdge("mouse_up", to, opts);
  }

  async drag(from: Point, to: Point, opts: DragOptions = {}): Promise<PointerResult> {
    assertFinitePoint(from, "drag.from");
    assertFinitePoint(to, "drag.to");
    const button = opts.button ?? "left";
    const steps = this.#resolveSteps(opts);
    const curve = opts.curve ?? this.#curve;
    const modifiers = modifierMask(opts.modifiers ?? []);
    const origin = this.position;
    const buttonsBefore = this.#buttons;
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      // Estado é REBOBINADO ao de antes do gesto a cada tentativa: se o primário
      // morreu no meio, o fallback não pode herdar máscara de botão suja — nem
      // zerar um botão que o chamador segurava de propósito (mouseDown avulso).
      this.#buttons = buttonsBefore;
      this.#position = { x: origin.x, y: origin.y };
      await this.#dispatchMove(backend, interpolatePath(origin, from, steps, curve), modifiers, opts.step_delay_ms ?? 0);
      await this.#dispatchDown(backend, from, button, 1, modifiers);
      const path = interpolatePath(from, to, steps, curve);
      await this.#dispatchMove(backend, path, modifiers, opts.step_delay_ms ?? 0);
      await this.#dispatchUp(backend, to, button, 1, modifiers);
      return path;
    });

    const duration_ms = Date.now() - t0;
    for (let i = 0; i < outcome.value.length; i += 1) {
      const p = outcome.value[i]!;
      this.#emit(
        "mouse.moved",
        { x: p.x, y: p.y, step: i + 1, steps: outcome.value.length, backend: outcome.backend, action: "drag" },
        opts.action_id ?? null,
      );
    }
    this.#emit(
      "mouse.dragged",
      {
        from,
        to,
        button,
        steps: outcome.value.length,
        backend: outcome.backend,
        fallback_used: outcome.fallback_used,
      },
      opts.action_id ?? null,
    );

    return {
      action: "drag",
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      duration_ms,
      steps: outcome.value.length,
      button,
      click_count: null,
      delta: null,
    };
  }

  async scroll(delta: { dx?: number; dy?: number }, opts: ScrollOptions = {}): Promise<PointerResult> {
    const dx = delta.dx ?? 0;
    const dy = delta.dy ?? 0;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new InputError("INVALID_REQUEST", "delta de scroll inválido", { delta });
    }
    const at = opts.at ?? this.position;
    assertFinitePoint(at, "scroll.at");
    const steps = this.#resolveSteps(opts);
    const curve = opts.curve ?? this.#curve;
    const modifiers = modifierMask(opts.modifiers ?? []);
    const origin = this.position;
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#position = { x: origin.x, y: origin.y };
      const path = interpolatePath(origin, at, steps, curve);
      await this.#dispatchMove(backend, path, modifiers, opts.step_delay_ms ?? 0);
      if (backend === "cdp") {
        const cdp = await ensureCdpSession(this.page, this.#cdp);
        this.#cdp = cdp;
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          button: "none",
          buttons: this.#buttons,
          deltaX: dx,
          deltaY: dy,
          modifiers,
        });
      } else {
        // page.mouse.wheel rola na posição interna do Playwright, que pode ter
        // divergido da nossa se o gesto anterior rodou em CDP. Reposiciona antes.
        await this.page.mouse.move(at.x, at.y);
        await this.page.mouse.wheel(dx, dy);
      }
      return path;
    });

    const duration_ms = Date.now() - t0;
    this.#emit(
      "mouse.scrolled",
      { x: at.x, y: at.y, dx, dy, backend: outcome.backend, fallback_used: outcome.fallback_used },
      opts.action_id ?? null,
    );

    return {
      action: "scroll",
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      from: { x: origin.x, y: origin.y },
      to: { x: at.x, y: at.y },
      duration_ms,
      steps: outcome.value.length,
      button: null,
      click_count: null,
      delta: { dx, dy },
    };
  }

  // ── internos ───────────────────────────────────────────────────────────────

  #resolveSteps(opts: MoveOptions): number {
    if (opts.steps !== undefined) return Math.max(1, Math.floor(opts.steps));
    if (opts.humanize === true) return this.#humanSteps;
    return this.#steps;
  }

  async #travel(
    action: "move" | "hover",
    to: Point,
    opts: MoveOptions,
    event: EventName,
  ): Promise<PointerResult> {
    assertFinitePoint(to, `${action}.to`);
    const origin = this.position;
    const steps = this.#resolveSteps(opts);
    const curve = opts.curve ?? this.#curve;
    const modifiers = modifierMask(opts.modifiers ?? []);
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#position = { x: origin.x, y: origin.y };
      const path = interpolatePath(origin, to, steps, curve);
      await this.#dispatchMove(backend, path, modifiers, opts.step_delay_ms ?? 0);
      return path;
    });

    const duration_ms = Date.now() - t0;
    for (let i = 0; i < outcome.value.length; i += 1) {
      const p = outcome.value[i]!;
      this.#emit(
        event,
        { x: p.x, y: p.y, step: i + 1, steps: outcome.value.length, backend: outcome.backend, action },
        opts.action_id ?? null,
      );
    }

    return {
      action,
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      from: origin,
      to: { x: to.x, y: to.y },
      duration_ms,
      steps: outcome.value.length,
      button: null,
      click_count: null,
      delta: null,
    };
  }

  async #clickLike(
    action: "click" | "double_click" | "right_click",
    to: Point | null,
    clicks: number,
    button: MouseButton,
    opts: ClickOptions,
  ): Promise<PointerResult> {
    if (to !== null) assertFinitePoint(to, `${action}.to`);
    const target = to ?? this.position;
    const origin = this.position;
    const steps = this.#resolveSteps(opts);
    const curve = opts.curve ?? this.#curve;
    const modifiers = modifierMask(opts.modifiers ?? []);
    const hold = opts.hold_ms ?? 0;
    const buttonsBefore = this.#buttons;
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#buttons = buttonsBefore;
      this.#position = { x: origin.x, y: origin.y };
      const path = interpolatePath(origin, target, steps, curve);
      await this.#dispatchMove(backend, path, modifiers, opts.step_delay_ms ?? 0);
      // clickCount cresce a cada par down/up: é assim que o Chromium promove o
      // segundo par a `dblclick`. Enviar direto clickCount=2 não gera o primeiro.
      for (let n = 1; n <= clicks; n += 1) {
        await this.#dispatchDown(backend, target, button, n, modifiers);
        if (hold > 0) await pause(hold);
        await this.#dispatchUp(backend, target, button, n, modifiers);
      }
      return path;
    });

    const duration_ms = Date.now() - t0;
    for (let i = 0; i < outcome.value.length; i += 1) {
      const p = outcome.value[i]!;
      this.#emit(
        "mouse.moved",
        { x: p.x, y: p.y, step: i + 1, steps: outcome.value.length, backend: outcome.backend, action },
        opts.action_id ?? null,
      );
    }
    this.#emit(
      "mouse.clicked",
      {
        x: target.x,
        y: target.y,
        button,
        click_count: clicks,
        phase: "click",
        backend: outcome.backend,
        fallback_used: outcome.fallback_used,
      },
      opts.action_id ?? null,
    );

    return {
      action,
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      from: origin,
      to: { x: target.x, y: target.y },
      duration_ms,
      steps: outcome.value.length,
      button,
      click_count: clicks,
      delta: null,
    };
  }

  async #buttonEdge(
    action: "mouse_down" | "mouse_up",
    to: Point | null,
    opts: ClickOptions,
  ): Promise<PointerResult> {
    if (to !== null) assertFinitePoint(to, `${action}.to`);
    const target = to ?? this.position;
    const origin = this.position;
    const button = opts.button ?? "left";
    const steps = this.#resolveSteps(opts);
    const curve = opts.curve ?? this.#curve;
    const modifiers = modifierMask(opts.modifiers ?? []);
    const buttonsBefore = this.#buttons;
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#buttons = buttonsBefore;
      this.#position = { x: origin.x, y: origin.y };
      const path = interpolatePath(origin, target, steps, curve);
      await this.#dispatchMove(backend, path, modifiers, opts.step_delay_ms ?? 0);
      if (action === "mouse_down") await this.#dispatchDown(backend, target, button, 1, modifiers);
      else await this.#dispatchUp(backend, target, button, 1, modifiers);
      return path;
    });

    const duration_ms = Date.now() - t0;
    // O contrato não tem EventName para meio-clique; `phase` no payload preserva
    // a distinção sem inventar evento fora do enum fechado (art. contract v1).
    this.#emit(
      "mouse.clicked",
      {
        x: target.x,
        y: target.y,
        button,
        phase: action === "mouse_down" ? "down" : "up",
        backend: outcome.backend,
        fallback_used: outcome.fallback_used,
      },
      opts.action_id ?? null,
    );

    return {
      action,
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      from: origin,
      to: { x: target.x, y: target.y },
      duration_ms,
      steps: outcome.value.length,
      button,
      click_count: null,
      delta: null,
    };
  }

  async #dispatchMove(backend: InputBackend, path: Point[], modifiers: number, stepDelay: number): Promise<void> {
    for (const p of path) {
      if (backend === "cdp") {
        const cdp = await ensureCdpSession(this.page, this.#cdp);
        this.#cdp = cdp;
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x,
          y: p.y,
          button: maskToButton(this.#buttons),
          buttons: this.#buttons,
          modifiers,
        });
      } else {
        await this.page.mouse.move(p.x, p.y);
      }
      this.#position = { x: p.x, y: p.y };
      if (stepDelay > 0) await pause(stepDelay);
    }
  }

  async #dispatchDown(
    backend: InputBackend,
    at: Point,
    button: MouseButton,
    clickCount: number,
    modifiers: number,
  ): Promise<void> {
    this.#buttons |= BUTTON_BIT[button];
    if (backend === "cdp") {
      const cdp = await ensureCdpSession(this.page, this.#cdp);
      this.#cdp = cdp;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: at.x,
        y: at.y,
        button,
        buttons: this.#buttons,
        clickCount,
        modifiers,
      });
    } else {
      await this.page.mouse.down({ button, clickCount });
    }
  }

  async #dispatchUp(
    backend: InputBackend,
    at: Point,
    button: MouseButton,
    clickCount: number,
    modifiers: number,
  ): Promise<void> {
    this.#buttons &= ~BUTTON_BIT[button];
    if (backend === "cdp") {
      const cdp = await ensureCdpSession(this.page, this.#cdp);
      this.#cdp = cdp;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button,
        buttons: this.#buttons,
        clickCount,
        modifiers,
      });
    } else {
      await this.page.mouse.up({ button, clickCount });
    }
  }
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
