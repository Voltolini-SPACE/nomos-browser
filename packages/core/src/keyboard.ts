/**
 * FASE 11 — KEYBOARD ENGINE
 *
 * Teclado com os mesmos dois backends do PointerEngine ("cdp" cru e
 * "playwright"), e com a mesma política de fallback registrada — nunca
 * silenciosa.
 *
 * Três pontos que exigem cuidado e que o spike da FASE 1 já expôs:
 *
 * 1. O CDP não infere `code`/`windowsVirtualKeyCode` a partir de `key`. Uma
 *    tabela errada faz a página receber keydown com code vazio e quebra
 *    qualquer site que escute `code` — daí a tabela explícita abaixo.
 *
 * 2. `text` só pode ir junto quando a tecla realmente produz caractere. Com
 *    Meta/Control/Alt pressionados a tecla é atalho, não digitação; mandar
 *    `text` faria o Chromium INSERIR a letra do atalho no campo.
 *
 * 3. No macOS, Meta+A não vira "selecionar tudo" só por causa do modificador:
 *    o Chromium executa comandos nativos de edição que precisam viajar no campo
 *    `commands` do Input.dispatchKeyEvent. Sem isso o atalho chega à página mas
 *    não seleciona nada — falha silenciosa clássica.
 *
 * SEGREDO: `type()` nunca devolve nem emite o texto digitado, só o comprimento.
 * O runtime injeta credencial por referência (contrato, SecretProvider) e o
 * valor não pode vazar por telemetria de teclado.
 */
import type { CDPSession, Page } from "playwright";
import type { EventName } from "./contract.ts";
import {
  type InputBackend,
  type InputEngineOptions,
  InputError,
  MODIFIER_BITS,
  canonicalModifier,
  defaultFallback,
  ensureCdpSession,
  makeEmitter,
  pause,
  withBackend,
} from "./pointer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Descrição de tecla
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyDescriptor {
  /** KeyboardEvent.key */
  key: string;
  /** KeyboardEvent.code (layout físico) */
  code: string;
  /** windowsVirtualKeyCode / KeyboardEvent.keyCode */
  keyCode: number;
  /** Texto produzido, ou null para tecla que não gera caractere. */
  text: string | null;
  /** KeyboardEvent.location (1 = esquerda, 3 = numpad). */
  location: number;
  /** Bit em MODIFIER_BITS quando a própria tecla é modificadora; 0 caso contrário. */
  modifier: number;
  /** true quando o caractere exige Shift no layout US. */
  shift: boolean;
}

function named(
  key: string,
  code: string,
  keyCode: number,
  extra: Partial<KeyDescriptor> = {},
): KeyDescriptor {
  return { key, code, keyCode, text: null, location: 0, modifier: 0, shift: false, ...extra };
}

/** Tabela de teclas nomeadas, indexada por alias em minúsculas. */
const NAMED_KEYS: Readonly<Record<string, KeyDescriptor>> = Object.freeze({
  enter: named("Enter", "Enter", 13, { text: "\r" }),
  return: named("Enter", "Enter", 13, { text: "\r" }),
  numpadenter: named("Enter", "NumpadEnter", 13, { text: "\r", location: 3 }),
  tab: named("Tab", "Tab", 9, { text: "\t" }),
  escape: named("Escape", "Escape", 27),
  esc: named("Escape", "Escape", 27),
  backspace: named("Backspace", "Backspace", 8),
  delete: named("Delete", "Delete", 46),
  del: named("Delete", "Delete", 46),
  insert: named("Insert", "Insert", 45),
  space: named(" ", "Space", 32, { text: " " }),
  arrowup: named("ArrowUp", "ArrowUp", 38),
  up: named("ArrowUp", "ArrowUp", 38),
  arrowdown: named("ArrowDown", "ArrowDown", 40),
  down: named("ArrowDown", "ArrowDown", 40),
  arrowleft: named("ArrowLeft", "ArrowLeft", 37),
  left: named("ArrowLeft", "ArrowLeft", 37),
  arrowright: named("ArrowRight", "ArrowRight", 39),
  right: named("ArrowRight", "ArrowRight", 39),
  home: named("Home", "Home", 36),
  end: named("End", "End", 35),
  pageup: named("PageUp", "PageUp", 33),
  pagedown: named("PageDown", "PageDown", 34),
  capslock: named("CapsLock", "CapsLock", 20),
  shift: named("Shift", "ShiftLeft", 16, { location: 1, modifier: MODIFIER_BITS.Shift! }),
  control: named("Control", "ControlLeft", 17, { location: 1, modifier: MODIFIER_BITS.Control! }),
  ctrl: named("Control", "ControlLeft", 17, { location: 1, modifier: MODIFIER_BITS.Control! }),
  alt: named("Alt", "AltLeft", 18, { location: 1, modifier: MODIFIER_BITS.Alt! }),
  option: named("Alt", "AltLeft", 18, { location: 1, modifier: MODIFIER_BITS.Alt! }),
  opt: named("Alt", "AltLeft", 18, { location: 1, modifier: MODIFIER_BITS.Alt! }),
  meta: named("Meta", "MetaLeft", 91, { location: 1, modifier: MODIFIER_BITS.Meta! }),
  cmd: named("Meta", "MetaLeft", 91, { location: 1, modifier: MODIFIER_BITS.Meta! }),
  command: named("Meta", "MetaLeft", 91, { location: 1, modifier: MODIFIER_BITS.Meta! }),
  super: named("Meta", "MetaLeft", 91, { location: 1, modifier: MODIFIER_BITS.Meta! }),
  win: named("Meta", "MetaLeft", 91, { location: 1, modifier: MODIFIER_BITS.Meta! }),
  f1: named("F1", "F1", 112),
  f2: named("F2", "F2", 113),
  f3: named("F3", "F3", 114),
  f4: named("F4", "F4", 115),
  f5: named("F5", "F5", 116),
  f6: named("F6", "F6", 117),
  f7: named("F7", "F7", 118),
  f8: named("F8", "F8", 119),
  f9: named("F9", "F9", 120),
  f10: named("F10", "F10", 121),
  f11: named("F11", "F11", 122),
  f12: named("F12", "F12", 123),
});

/** Pontuação do layout US: caractere → {code, keyCode, exige Shift}. */
const PUNCTUATION: Readonly<Record<string, { code: string; keyCode: number; shift: boolean }>> = Object.freeze({
  "`": { code: "Backquote", keyCode: 192, shift: false },
  "~": { code: "Backquote", keyCode: 192, shift: true },
  "-": { code: "Minus", keyCode: 189, shift: false },
  _: { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187, shift: false },
  "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219, shift: false },
  "{": { code: "BracketLeft", keyCode: 219, shift: true },
  "]": { code: "BracketRight", keyCode: 221, shift: false },
  "}": { code: "BracketRight", keyCode: 221, shift: true },
  "\\": { code: "Backslash", keyCode: 220, shift: false },
  "|": { code: "Backslash", keyCode: 220, shift: true },
  ";": { code: "Semicolon", keyCode: 186, shift: false },
  ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222, shift: false },
  '"': { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188, shift: false },
  "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190, shift: false },
  ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191, shift: false },
  "?": { code: "Slash", keyCode: 191, shift: true },
});

/** Dígitos com Shift no layout US: ")" é Shift+0, "!" é Shift+1, ... */
const SHIFTED_DIGITS = ")!@#$%^&*(";

/**
 * Resolve UM caractere para descritor. Caractere fora das tabelas (acentuado,
 * emoji) cai num descritor sem `code`/`keyCode`: o Chromium ainda insere pelo
 * campo `text`, e a página vê code:"" — que é a verdade sobre a tecla física
 * inexistente, não um chute.
 */
export function describeChar(ch: string): KeyDescriptor {
  if (ch === "\n" || ch === "\r") return NAMED_KEYS.enter!;
  if (ch === "\t") return NAMED_KEYS.tab!;
  if (ch === " ") return NAMED_KEYS.space!;

  if (ch >= "a" && ch <= "z") {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, location: 0, modifier: 0, shift: false };
  }
  if (ch >= "A" && ch <= "Z") {
    return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, location: 0, modifier: 0, shift: true };
  }
  if (ch >= "0" && ch <= "9") {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, location: 0, modifier: 0, shift: false };
  }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
  if (shiftedDigit >= 0) {
    return { key: ch, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: ch, location: 0, modifier: 0, shift: true };
  }
  const punct = PUNCTUATION[ch];
  if (punct !== undefined) {
    return { key: ch, code: punct.code, keyCode: punct.keyCode, text: ch, location: 0, modifier: 0, shift: punct.shift };
  }
  return { key: ch, code: "", keyCode: 0, text: ch, location: 0, modifier: 0, shift: false };
}

/** Resolve um nome de tecla (alias, caractere único) para descritor. */
export function describeKey(spec: string): KeyDescriptor {
  if (spec.length === 0) {
    throw new InputError("INVALID_REQUEST", "tecla vazia", { key: spec });
  }
  if (spec.length === 1) return describeChar(spec);
  const found = NAMED_KEYS[spec.toLowerCase()];
  if (found !== undefined) return found;
  throw new InputError("INVALID_REQUEST", `tecla desconhecida: ${JSON.stringify(spec)}`, { key: spec });
}

/**
 * Comandos nativos de edição do macOS. Sem eles o Chromium recebe o atalho e
 * não faz nada — ver cabeçalho, ponto 3.
 * Chave = modificadores em ordem canônica Meta,Control,Alt,Shift + "+" + key.
 */
const MAC_EDITING_COMMANDS: Readonly<Record<string, string[]>> = Object.freeze({
  "Meta+a": ["selectAll"],
  "Meta+c": ["copy"],
  "Meta+v": ["paste"],
  "Meta+x": ["cut"],
  "Meta+z": ["undo"],
  "Meta+Shift+z": ["redo"],
  "Meta+ArrowLeft": ["moveToBeginningOfLine"],
  "Meta+ArrowRight": ["moveToEndOfLine"],
  "Meta+ArrowUp": ["moveToBeginningOfDocument"],
  "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Meta+Shift+ArrowLeft": ["moveToBeginningOfLineAndModifySelection"],
  "Meta+Shift+ArrowRight": ["moveToEndOfLineAndModifySelection"],
  "Meta+Backspace": ["deleteToBeginningOfLine"],
  "Alt+ArrowLeft": ["moveWordLeft"],
  "Alt+ArrowRight": ["moveWordRight"],
  "Alt+Shift+ArrowLeft": ["moveWordLeftAndModifySelection"],
  "Alt+Shift+ArrowRight": ["moveWordRightAndModifySelection"],
  "Alt+Backspace": ["deleteWordBackward"],
  "Alt+Delete": ["deleteWordForward"],
});

export function macEditingCommands(mask: number, key: string): string[] {
  const parts: string[] = [];
  if ((mask & MODIFIER_BITS.Meta!) !== 0) parts.push("Meta");
  if ((mask & MODIFIER_BITS.Control!) !== 0) parts.push("Control");
  if ((mask & MODIFIER_BITS.Alt!) !== 0) parts.push("Alt");
  if ((mask & MODIFIER_BITS.Shift!) !== 0) parts.push("Shift");
  if (parts.length === 0) return [];
  parts.push(key);
  return MAC_EDITING_COMMANDS[parts.join("+")] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

export type KeyboardAction = "type" | "press" | "down" | "up" | "hotkey";

export interface KeyResult {
  action: KeyboardAction;
  /** Backend que REALMENTE agiu. */
  backend: InputBackend;
  requested_backend: InputBackend;
  fallback_used: boolean;
  fallback_reason: string | null;
  /** Teclas envolvidas (KeyboardEvent.key). Para `type` fica vazio: ver text_length. */
  keys: string[];
  /** Comprimento do texto. O TEXTO NUNCA sai daqui — pode ser credencial. */
  text_length: number | null;
  duration_ms: number;
  /** Comandos nativos de edição enviados (macOS). Vazio quando não aplicável. */
  editing_commands: string[];
  /** Máscara de modificadores segurada no momento da ação. */
  modifiers: number;
}

export interface TypeOptions {
  /** Pausa entre teclas. Default 0 — sleep aqui é cosmético, não mecanismo. */
  delay_ms?: number;
  action_id?: string | null;
}

export interface PressOptions extends TypeOptions {
  /** Modificadores extras só para esta tecla. */
  modifiers?: readonly string[];
}

export interface KeyboardEngineOptions extends InputEngineOptions {
  delay_ms?: number;
  /**
   * Enviar comandos nativos de edição do macOS no backend CDP.
   * Default: true quando o Chromium roda em darwin.
   */
  mac_editing_commands?: boolean;
}

export class KeyboardEngine {
  readonly page: Page;
  #cdp: CDPSession | null;
  #backend: InputBackend;
  #fallback: InputBackend | "none";
  #delay: number;
  #mac: boolean;
  #emit: ReturnType<typeof makeEmitter>;
  /** Teclas seguradas agora (KeyboardEvent.key), na ordem em que desceram. */
  #held: string[] = [];
  #modifiers = 0;

  constructor(opts: KeyboardEngineOptions) {
    this.page = opts.page;
    this.#cdp = opts.cdp ?? null;
    this.#backend = opts.backend ?? "cdp";
    this.#fallback = opts.fallback ?? defaultFallback(this.#backend);
    this.#delay = Math.max(0, opts.delay_ms ?? 0);
    this.#mac = opts.mac_editing_commands ?? process.platform === "darwin";
    this.#emit = makeEmitter(opts);
  }

  get backend(): InputBackend {
    return this.#backend;
  }

  get heldKeys(): string[] {
    return [...this.#held];
  }

  get modifiers(): number {
    return this.#modifiers;
  }

  /**
   * Digita texto caractere a caractere com eventos reais de tecla.
   * O texto não aparece no resultado nem no evento — só o comprimento.
   */
  async type(text: string, opts: TypeOptions = {}): Promise<KeyResult> {
    if (typeof text !== "string") {
      throw new InputError("INVALID_REQUEST", "type() exige string", {});
    }
    const delay = opts.delay_ms ?? this.#delay;
    const modsBefore = this.#modifiers;
    const heldBefore = [...this.#held];
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#modifiers = modsBefore;
      this.#held = [...heldBefore];
      // Shift é segurado ao longo de uma sequência de caracteres maiúsculos ou
      // simbólicos em vez de subir e descer a cada tecla — é o que um humano faz
      // e é o que a página observa em `event.shiftKey`.
      //
      // Por que NÃO usamos `page.keyboard.type()` no backend playwright: ele
      // entrega o texto certo mas com shiftKey=false em maiúscula (medido). Isso
      // faria o mesmo `type()` ser observado de forma diferente conforme o
      // backend que agiu — um fallback mudaria o comportamento visto pelo site.
      const shiftDesc = NAMED_KEYS.shift!;
      let shiftHeld = false;
      for (const ch of text) {
        const d = describeChar(ch);
        if (d.shift && !shiftHeld) {
          await this.#dispatchKey(backend, "down", shiftDesc, this.#modifiers | MODIFIER_BITS.Shift!);
          shiftHeld = true;
        } else if (!d.shift && shiftHeld) {
          await this.#dispatchKey(backend, "up", shiftDesc, this.#modifiers & ~MODIFIER_BITS.Shift!);
          shiftHeld = false;
        }
        await this.#dispatchKey(backend, "down", d, this.#modifiers);
        await this.#dispatchKey(backend, "up", d, this.#modifiers);
        if (delay > 0) await pause(delay);
      }
      if (shiftHeld) await this.#dispatchKey(backend, "up", shiftDesc, this.#modifiers & ~MODIFIER_BITS.Shift!);
    });

    const duration_ms = Date.now() - t0;
    this.#emit(
      "keyboard.typed",
      {
        // Deliberadamente só o comprimento: o valor pode ser credencial resolvida
        // por SecretProvider e não pode entrar em log nem em stream de eventos.
        length: text.length,
        backend: outcome.backend,
        fallback_used: outcome.fallback_used,
      },
      opts.action_id ?? null,
    );

    return this.#result("type", outcome, [], text.length, duration_ms, []);
  }

  async press(key: string, opts: PressOptions = {}): Promise<KeyResult> {
    const d = describeKey(key);
    const extra = maskOf(opts.modifiers ?? []);
    const modsBefore = this.#modifiers;
    const heldBefore = [...this.#held];
    const mask = modsBefore | extra;
    const commands = this.#mac ? macEditingCommands(mask, d.key) : [];
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#modifiers = modsBefore;
      this.#held = [...heldBefore];
      // down/up explícito em vez de `press("Meta+a")` do Playwright: o parser de
      // combo dele quebra em teclas cujo próprio nome contém "+".
      const mods = (opts.modifiers ?? []).map(requireModifier);
      for (const m of mods) {
        const md = describeKey(m);
        await this.#dispatchKey(backend, "down", md, this.#modifiers | md.modifier);
      }
      await this.#dispatchKey(backend, "down", d, this.#modifiers, commands);
      if (opts.delay_ms !== undefined && opts.delay_ms > 0) await pause(opts.delay_ms);
      await this.#dispatchKey(backend, "up", d, this.#modifiers);
      for (const m of [...mods].reverse()) {
        const md = describeKey(m);
        await this.#dispatchKey(backend, "up", md, this.#modifiers & ~md.modifier);
      }
    });

    const duration_ms = Date.now() - t0;
    this.#emit(
      "keyboard.pressed",
      { keys: [d.key], phase: "press", modifiers: mask, backend: outcome.backend, fallback_used: outcome.fallback_used },
      opts.action_id ?? null,
    );
    return this.#result("press", outcome, [d.key], null, duration_ms, commands);
  }

  async down(key: string, opts: TypeOptions = {}): Promise<KeyResult> {
    const d = describeKey(key);
    const modsBefore = this.#modifiers;
    const heldBefore = [...this.#held];
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#modifiers = modsBefore;
      this.#held = [...heldBefore];
      await this.#dispatchKey(backend, "down", d, this.#modifiers | d.modifier);
    });

    const duration_ms = Date.now() - t0;
    this.#emit(
      "keyboard.pressed",
      { keys: [d.key], phase: "down", modifiers: this.#modifiers, backend: outcome.backend, fallback_used: outcome.fallback_used },
      opts.action_id ?? null,
    );
    return this.#result("down", outcome, [d.key], null, duration_ms, []);
  }

  async up(key: string, opts: TypeOptions = {}): Promise<KeyResult> {
    const d = describeKey(key);
    const modsBefore = this.#modifiers;
    const heldBefore = [...this.#held];
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#modifiers = modsBefore;
      this.#held = [...heldBefore];
      await this.#dispatchKey(backend, "up", d, this.#modifiers & ~d.modifier);
    });

    const duration_ms = Date.now() - t0;
    this.#emit(
      "keyboard.pressed",
      { keys: [d.key], phase: "up", modifiers: this.#modifiers, backend: outcome.backend, fallback_used: outcome.fallback_used },
      opts.action_id ?? null,
    );
    return this.#result("up", outcome, [d.key], null, duration_ms, []);
  }

  /**
   * Atalho: desce todas as teclas na ordem, sobe na ordem inversa.
   * Funciona para CMD+A, CMD+C, CMD+V e combos de três (CMD+SHIFT+Z).
   */
  async hotkey(keys: readonly string[], opts: TypeOptions = {}): Promise<KeyResult> {
    if (keys.length === 0) {
      throw new InputError("INVALID_REQUEST", "hotkey() exige ao menos uma tecla", {});
    }
    const descriptors = keys.map(describeKey);
    const last = descriptors[descriptors.length - 1]!;
    const comboMask = descriptors.slice(0, -1).reduce((m, d) => m | d.modifier, 0);
    const modsBefore = this.#modifiers;
    const heldBefore = [...this.#held];
    const commands = this.#mac ? macEditingCommands(modsBefore | comboMask, last.key) : [];
    const t0 = Date.now();

    const outcome = await withBackend({ primary: this.#backend, fallback: this.#fallback }, async (backend) => {
      this.#modifiers = modsBefore;
      this.#held = [...heldBefore];
      for (let i = 0; i < descriptors.length; i += 1) {
        const d = descriptors[i]!;
        const isLast = i === descriptors.length - 1;
        await this.#dispatchKey(backend, "down", d, this.#modifiers | d.modifier, isLast ? commands : []);
      }
      for (let i = descriptors.length - 1; i >= 0; i -= 1) {
        const d = descriptors[i]!;
        await this.#dispatchKey(backend, "up", d, this.#modifiers & ~d.modifier);
      }
    });

    const duration_ms = Date.now() - t0;
    const names = descriptors.map((d) => d.key);
    this.#emit(
      "keyboard.pressed",
      {
        keys: names,
        phase: "hotkey",
        modifiers: comboMask,
        editing_commands: commands,
        backend: outcome.backend,
        fallback_used: outcome.fallback_used,
      },
      opts.action_id ?? null,
    );
    return this.#result("hotkey", outcome, names, null, duration_ms, commands);
  }

  /** Solta tudo que ficou segurado (ex.: recuperação após erro no meio de um combo). */
  async releaseAll(): Promise<string[]> {
    const released: string[] = [];
    for (const key of [...this.#held].reverse()) {
      await this.up(key);
      released.push(key);
    }
    this.#held = [];
    this.#modifiers = 0;
    return released;
  }

  // ── internos ───────────────────────────────────────────────────────────────

  #result(
    action: KeyboardAction,
    outcome: { backend: InputBackend; requested_backend: InputBackend; fallback_used: boolean; fallback_reason: string | null },
    keys: string[],
    text_length: number | null,
    duration_ms: number,
    editing_commands: string[],
  ): KeyResult {
    return {
      action,
      backend: outcome.backend,
      requested_backend: outcome.requested_backend,
      fallback_used: outcome.fallback_used,
      fallback_reason: outcome.fallback_reason,
      keys,
      text_length,
      duration_ms,
      editing_commands,
      modifiers: this.#modifiers,
    };
  }

  #track(phase: "down" | "up", d: KeyDescriptor): void {
    if (phase === "down") {
      if (!this.#held.includes(d.key)) this.#held.push(d.key);
      this.#modifiers |= d.modifier;
    } else {
      this.#held = this.#held.filter((k) => k !== d.key);
      this.#modifiers &= ~d.modifier;
    }
  }

  /**
   * Ponto único de saída de tecla. Os dois backends passam por aqui para que a
   * mesma chamada produza o mesmo observável na página — se o fallback trocasse
   * o comportamento visto pelo site, o fallback seria uma mentira.
   */
  async #dispatchKey(
    backend: InputBackend,
    phase: "down" | "up",
    d: KeyDescriptor,
    mask: number,
    commands: string[] = [],
  ): Promise<void> {
    if (backend === "cdp") {
      await this.#cdpKey(phase, d, mask, commands);
    } else if (phase === "down") {
      // O Playwright deriva modificadores e comandos de edição do próprio estado
      // interno, alimentado pelos down/up que emitimos na mesma ordem.
      await this.page.keyboard.down(d.key);
    } else {
      await this.page.keyboard.up(d.key);
    }
    this.#track(phase, d);
  }

  async #cdpKey(phase: "down" | "up", d: KeyDescriptor, mask: number, commands: string[] = []): Promise<void> {
    const cdp = await ensureCdpSession(this.page, this.#cdp);
    this.#cdp = cdp;

    // Com Meta/Control/Alt segurados a tecla é atalho: mandar `text` faria o
    // Chromium inserir o caractere do atalho no campo focado.
    const shortcutMask = MODIFIER_BITS.Meta! | MODIFIER_BITS.Control! | MODIFIER_BITS.Alt!;
    const isShortcut = (mask & shortcutMask) !== 0;
    const text = phase === "down" && !isShortcut ? d.text : null;

    const params: Record<string, unknown> = {
      // rawKeyDown para tecla sem texto: evita keypress espúrio que "keyDown"
      // geraria para teclas de controle.
      type: phase === "up" ? "keyUp" : text !== null ? "keyDown" : "rawKeyDown",
      modifiers: mask,
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.keyCode,
      nativeVirtualKeyCode: d.keyCode,
      location: d.location,
      isKeypad: d.location === 3,
    };
    if (text !== null) {
      params.text = text;
      params.unmodifiedText = text;
    }
    if (phase === "down" && commands.length > 0) params.commands = commands;

    await cdp.send("Input.dispatchKeyEvent", params);
  }
}

function requireModifier(raw: string): "Alt" | "Control" | "Meta" | "Shift" {
  const canonical = canonicalModifier(raw);
  if (canonical === null) {
    throw new InputError("INVALID_REQUEST", `modificador desconhecido: ${JSON.stringify(raw)}`, { modifier: raw });
  }
  return canonical;
}

function maskOf(names: readonly string[]): number {
  return names.reduce((m, n) => m | MODIFIER_BITS[requireModifier(n)]!, 0);
}

/** Reexportado para quem consome só o teclado não precisar conhecer pointer.ts. */
export { InputError, MODIFIER_BITS };
export type { InputBackend };
export type KeyboardEventName = Extract<EventName, "keyboard.typed" | "keyboard.pressed">;
