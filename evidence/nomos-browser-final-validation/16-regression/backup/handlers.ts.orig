/**
 * FASE 4 — HANDLERS DAS ROTAS DE AÇÃO
 *
 * Cada handler recebe a requisição já validada e devolve APENAS o `result` do
 * envelope. Quem monta `ActionResponse` é o daemon — assim nenhum handler tem a
 * chance de devolver `success: true` sem timing, e o erro nunca escapa do envelope.
 *
 * Regras que este arquivo carrega:
 *
 *  - NADA de lógica de navegador aqui (art. da arquitetura). Handler é cola: pede
 *    ao SessionManager a Page, ao TargetResolver o alvo, ao Pointer/Keyboard o
 *    input, ao Verifier a prova. Se um comportamento novo for preciso, ele nasce
 *    no `core`, não nesta camada.
 *
 *  - NADA de fallback silencioso. Alvo não resolvido lança TargetResolutionError e
 *    o código sobe no envelope. Verificação que não confirmou volta
 *    `verified:false` — nunca `success:true` otimista.
 *
 *  - NENHUM SEGREDO SAI DAQUI. `browser.type` com `credential_ref` injeta pelo
 *    vault: o valor não passa pelo handler, não vai para o resultado e não vai
 *    para o evento. O que sai é a referência e o recibo.
 */
import path from "node:path";
import type { Download, ElementHandle, Locator, Page } from "playwright";
import {
  newActionId,
  newId,
  nowIso,
  type ActionError,
  type ActionErrorCode,
  type AgentProvider,
  type AuditEntry,
  type BrowserTask,
  type DownloadRecord,
  type EventName,
  type Observation,
  type PageInfo,
  type Plan,
  type PlanStep,
  type ResolvedTarget,
  type RuntimeEvent,
  type TargetDescriptor,
  type UploadRecord,
  type VerificationResult,
  type VerificationSpec,
} from "../../core/src/contract.ts";
import { SessionManager, isSessionError, toActionError as sessionToActionError } from "../../core/src/session.ts";
import { InputError, PointerEngine, type Point } from "../../core/src/pointer.ts";
import { KeyboardEngine } from "../../core/src/keyboard.ts";
import {
  PerceptionEngine,
  PerceptionError,
  type NetworkLog,
  type ScreenshotScope,
} from "../../core/src/perception.ts";
import { isTargetResolutionError, resolveDetailed } from "../../core/src/target.ts";
import { capture as captureSnapshot, verify as verifyAction } from "../../core/src/verifier.ts";
import { CapabilityEngine, PolicyError, checkPath, checkUrl } from "../../core/src/policy.ts";
import { FileVault, VaultError } from "../../core/src/vault.ts";
import { AuditLog } from "../../observability/src/audit.ts";
import { SessionRecorder } from "../../observability/src/replay.ts";
import { EventBus } from "../../observability/src/eventbus.ts";
import type { DaemonConfig } from "./config.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Erro da camada de API
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  constructor(code: ActionErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

/** Códigos do vault → códigos do contrato. Nenhum vira sucesso, nenhum some. */
const VAULT_CODE_MAP: Readonly<Record<string, ActionErrorCode>> = Object.freeze({
  INVALID_PROFILE: "INVALID_REQUEST",
  INVALID_REF: "INVALID_REQUEST",
  INVALID_TARGET: "TARGET_NOT_FOUND",
  SECRET_NOT_FOUND: "INVALID_REQUEST",
  VAULT_UNREADABLE: "POLICY_BLOCKED",
  VAULT_INSECURE_PERMISSIONS: "POLICY_BLOCKED",
  INJECTION_FAILED: "INTERNAL",
});

/**
 * Traduz qualquer exceção para `ActionError`. É a única porta: um erro que não
 * case com nenhum tipo conhecido vira INTERNAL com a mensagem original — nunca
 * uma mensagem genérica que apagaria a causa.
 */
export function toActionError(e: unknown): ActionError {
  if (e instanceof ApiError) return { code: e.code, message: e.message, detail: e.detail };
  if (isSessionError(e)) return e.toActionError();
  if (isTargetResolutionError(e)) return e.toActionError();
  if (e instanceof PolicyError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof PerceptionError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof InputError) return { code: e.code, message: e.message, detail: e.detail };
  if (e instanceof VaultError) {
    const code = Object.hasOwn(VAULT_CODE_MAP, e.code) ? VAULT_CODE_MAP[e.code]! : "INTERNAL";
    return { code, message: e.message, detail: { ...e.detail, vault_code: e.code } };
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return { code: "TIMEOUT", message: e.message, detail: { kind: "playwright_timeout" } };
  }
  return sessionToActionError(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura estrita do corpo
// ─────────────────────────────────────────────────────────────────────────────

export type Body = Record<string, unknown>;

/** String opcional. Presente porém vazia/não-string é ERRO, não ausência. */
function str(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v === "") {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser string não vazia`, { field: key });
  }
  return v;
}

function reqStr(body: Body, key: string): string {
  const v = str(body, key);
  if (v === null) throw new ApiError("INVALID_REQUEST", `campo obrigatório ausente: ${key}`, { field: key });
  return v;
}

function num(body: Body, key: string, fallback: number | null = null): number | null {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser número finito`, { field: key });
  }
  return v;
}

function bool(body: Body, key: string, fallback: boolean): boolean {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    throw new ApiError("INVALID_REQUEST", `campo ${key} deve ser booleano`, { field: key });
  }
  return v;
}

/** Aceita só as chaves de `TargetDescriptor`; chave estranha é erro, não ruído. */
export function readTarget(raw: unknown, field = "target"): TargetDescriptor {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_REQUEST", `${field} deve ser um objeto TargetDescriptor`, { field });
  }
  const src = raw as Record<string, unknown>;
  const out: TargetDescriptor = {};
  const textual = ["selector", "text", "role", "label", "placeholder", "semantic"] as const;
  for (const k of textual) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") {
      throw new ApiError("INVALID_REQUEST", `${field}.${k} deve ser string não vazia`, { field: `${field}.${k}` });
    }
    out[k] = v;
  }
  if (src.nth !== undefined) {
    if (typeof src.nth !== "number" || !Number.isInteger(src.nth) || src.nth < 0) {
      throw new ApiError("INVALID_REQUEST", `${field}.nth deve ser inteiro >= 0`, { field: `${field}.nth` });
    }
    out.nth = src.nth;
  }
  if (src.coordinates !== undefined) {
    const c = src.coordinates as { x?: unknown; y?: unknown };
    if (c === null || typeof c !== "object" || typeof c.x !== "number" || typeof c.y !== "number") {
      throw new ApiError("INVALID_REQUEST", `${field}.coordinates deve ser {x:number,y:number}`, { field });
    }
    out.coordinates = { x: c.x, y: c.y };
  }
  for (const k of Object.keys(src)) {
    if (!Object.hasOwn(out, k) && !["selector", "text", "role", "label", "placeholder", "semantic", "nth", "coordinates"].includes(k)) {
      throw new ApiError("INVALID_REQUEST", `${field}.${k} não é campo de TargetDescriptor`, { field: `${field}.${k}` });
    }
  }
  if (Object.keys(out).length === 0) {
    throw new ApiError("INVALID_REQUEST", `${field} vazio: informe ao menos um critério`, { field });
  }
  return out;
}

const VERIFICATION_KINDS = [
  "URL_CHANGED",
  "ELEMENT_APPEARED",
  "ELEMENT_DISAPPEARED",
  "NETWORK_SUCCESS",
  "TEXT_CHANGED",
  "DOM_CHANGED",
  "NONE",
] as const;

export function readVerification(raw: unknown): VerificationSpec {
  if (raw === undefined || raw === null) return { kind: "NONE" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("INVALID_REQUEST", "verification deve ser um objeto VerificationSpec");
  }
  const src = raw as Record<string, unknown>;
  const kind = src.kind;
  if (typeof kind !== "string" || !(VERIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError("INVALID_REQUEST", `verification.kind inválido: ${String(kind)}`, {
      allowed: [...VERIFICATION_KINDS],
    });
  }
  const spec: VerificationSpec = { kind: kind as VerificationSpec["kind"] };
  if (src.expect !== undefined) {
    if (typeof src.expect !== "string") throw new ApiError("INVALID_REQUEST", "verification.expect deve ser string");
    spec.expect = src.expect;
  }
  if (src.timeout_ms !== undefined) {
    if (typeof src.timeout_ms !== "number" || !Number.isInteger(src.timeout_ms) || src.timeout_ms < 0) {
      throw new ApiError("INVALID_REQUEST", "verification.timeout_ms deve ser inteiro >= 0");
    }
    spec.timeout_ms = src.timeout_ms;
  }
  return spec;
}

/** `handle` é opaco e NÃO atravessa a fronteira da API (contrato, ResolvedTarget). */
export function publicTarget(t: ResolvedTarget): Omit<ResolvedTarget, "handle"> {
  const { handle, ...rest } = t;
  void handle;
  return rest;
}

function centerOf(t: ResolvedTarget): Point {
  // Alvo por coordenada vem com caixa de área zero: o centro é a própria coordenada.
  return { x: t.box.x + t.box.width / 2, y: t.box.y + t.box.height / 2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serviços compartilhados pelos handlers
// ─────────────────────────────────────────────────────────────────────────────

interface PageEngines {
  page: Page;
  pointer: PointerEngine;
  keyboard: KeyboardEngine;
  network: NetworkLog;
}

export interface RuntimeServicesOptions {
  config: DaemonConfig;
  sessions: SessionManager;
  bus: EventBus;
  perception?: PerceptionEngine;
  policy?: CapabilityEngine;
  audit?: AuditLog | null;
  /** FASE 33/34. Ausente ⇒ `browser.task` falha explicitamente (fail closed). */
  agent?: AgentProvider | null;
}

export class RuntimeServices {
  readonly config: DaemonConfig;
  readonly sessions: SessionManager;
  readonly bus: EventBus;
  readonly perception: PerceptionEngine;
  readonly policy: CapabilityEngine;
  readonly audit: AuditLog | null;
  readonly agent: AgentProvider | null;

  /** Um par pointer/keyboard por sessão, refeito quando a página ativa muda. */
  readonly #engines = new Map<string, PageEngines>();
  readonly #vaults = new Map<string, FileVault>();
  readonly #tasks = new Map<string, BrowserTask>();
  readonly #recorders = new Map<string, SessionRecorder>();

  constructor(opts: RuntimeServicesOptions) {
    this.config = opts.config;
    this.sessions = opts.sessions;
    this.bus = opts.bus;
    this.perception = opts.perception ?? new PerceptionEngine({ observeLimit: opts.config.observe_limit });
    this.policy =
      opts.policy ??
      new CapabilityEngine({
        defaultPolicy: opts.config.default_policy,
        ...(opts.config.upload_root !== null ? { uploadRoot: opts.config.upload_root } : {}),
        ...(opts.config.download_root !== null ? { downloadRoot: opts.config.download_root } : {}),
      });
    this.audit = opts.audit ?? null;
    this.agent = opts.agent ?? null;
  }

  emit(event: EventName, session_id: string | null, action_id: string | null, payload: Record<string, unknown>, source = "runtime"): void {
    this.bus.publish(event, { session_id, action_id, source, payload });
  }

  /**
   * Gravador de replay da sessão (FASE 25).
   *
   * Existe porque a captura sozinha não é evidência: um `screenshot_ref` que só
   * vive na memória do processo desaparece com ele, e `nomos-web replay` teria
   * uma linha do tempo sem nenhuma imagem. O bundle só é reconstituível se o
   * PNG chegar ao disco em `sessions/<id>/screenshots/`.
   */
  recorderFor(session_id: string): SessionRecorder | null {
    if (this.audit === null) return null; // observabilidade desligada por config
    const existente = this.#recorders.get(session_id);
    if (existente !== undefined) return existente;
    const feito = new SessionRecorder(
      session_id,
      this.config.sessions_root !== null ? { root: this.config.sessions_root } : {},
    );
    this.#recorders.set(session_id, feito);
    return feito;
  }

  /**
   * Engines ligados à página ATIVA da sessão. O log de rede é anexado aqui: ele
   * só enxerga tráfego a partir do momento em que passa a escutar, e por isso a
   * primeira ação da sessão já o instala em vez de esperar `browser.network`.
   */
  enginesFor(session_id: string, page: Page): PageEngines {
    const cached = this.#engines.get(session_id);
    if (cached !== undefined && cached.page === page && !page.isClosed()) return cached;
    if (cached !== undefined && cached.page !== page) cached.network.detach();

    const onEvent = (e: RuntimeEvent): void => {
      this.bus.emit(e);
    };
    const made: PageEngines = {
      page,
      pointer: new PointerEngine({ page, session_id, source: "agent", onEvent }),
      keyboard: new KeyboardEngine({ page, session_id, source: "agent", onEvent }),
      network: this.perception.networkLog(page),
    };
    this.#engines.set(session_id, made);
    return made;
  }

  vaultFor(profile: string): FileVault {
    const cached = this.#vaults.get(profile);
    if (cached !== undefined) return cached;
    const vault = new FileVault(profile, {
      onSecretUsed: (usage) => {
        // Só a REFERÊNCIA e o destino viajam. Nenhum campo do vault carrega valor.
        this.emit("secret.used", usage.session, null, {
          ref: usage.ref,
          destino: usage.destino,
          verified: usage.verified,
          provider: usage.provider,
        }, "runtime");
      },
    });
    this.#vaults.set(profile, vault);
    return vault;
  }

  task(task_id: string): BrowserTask | null {
    return this.#tasks.get(task_id) ?? null;
  }

  registerTask(task: BrowserTask): void {
    this.#tasks.set(task.task_id, task);
  }

  async record(entry: AuditEntry): Promise<void> {
    if (this.audit === null) return;
    try {
      await this.audit.append(entry);
    } catch (e) {
      // Auditoria quebrada não pode derrubar a ação, mas também não pode sumir.
      console.error("[api] audit.append falhou:", toActionError(e).message);
    }
  }

  /** Solta engines e log de rede de uma sessão encerrada. */
  forget(session_id: string): void {
    const e = this.#engines.get(session_id);
    if (e !== undefined) {
      try {
        e.network.detach();
      } catch {
        // Página já morta: nada a desanexar.
      }
      this.#engines.delete(session_id);
    }
  }

  disposeAll(): void {
    for (const id of [...this.#engines.keys()]) this.forget(id);
    this.#vaults.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ActionRequest {
  tool: string;
  action_id: string;
  session_id: string;
  body: Body;
  /** Identidade de quem chamou (header `x-nomos-client`). */
  client: string | null;
}

export type ActionHandler = (svc: RuntimeServices, req: ActionRequest) => Promise<unknown>;

function pageOf(svc: RuntimeServices, req: ActionRequest): Page {
  const page_id = str(req.body, "page_id");
  return svc.sessions.getPage(req.session_id, page_id ?? undefined);
}

function urlGuard(svc: RuntimeServices, url: string): string {
  const d = checkUrl(url, { allow_internal: svc.config.allow_internal_urls });
  if (!d.allowed) {
    throw new ApiError(d.code ?? "POLICY_BLOCKED", d.reason, { url: d.url, scheme: d.scheme, host: d.host, internal: d.internal });
  }
  return d.url ?? url;
}

async function resolveOn(svc: RuntimeServices, page: Page, descriptor: TargetDescriptor, timeout_ms: number | null): Promise<ResolvedTarget> {
  const res = await resolveDetailed(page, descriptor, {
    timeout_ms: timeout_ms ?? 0,
    max_candidates: 60,
  });
  if (res.target.healed) {
    svc.emit("target.healed", null, null, {
      strategy: res.target.strategy,
      attempted: res.target.attempted,
      description: res.target.description,
    });
  }
  return res.target;
}

async function pageInfoOf(svc: RuntimeServices, session_id: string, page: Page): Promise<PageInfo> {
  const info = await svc.sessions.observe(session_id);
  const page_id = svc.sessions.pageIdOf(page);
  const found = info.pages.find((p) => p.page_id === page_id);
  if (found !== undefined) return found;
  // Página existe no Playwright mas não no registro: estado inconsistente, não
  // um detalhe cosmético. Melhor gritar do que inventar um PageInfo.
  throw new ApiError("INTERNAL", "página ativa não consta no registro da sessão", { session_id, page_id });
}

/** Ciclo padrão de uma ação que muda a página: snapshot → agir → verificar. */
async function withVerification<T>(
  page: Page,
  spec: VerificationSpec,
  act: () => Promise<T>,
): Promise<{ value: T; verification: VerificationResult }> {
  const before = await captureSnapshot(page, spec);
  const value = await act();
  const outcome = await verifyAction(page, spec, before, { attempt: 0 });
  const verification: VerificationResult = {
    executed: outcome.executed,
    verified: outcome.verified,
    confidence: outcome.confidence,
    kind: outcome.kind,
    observed: outcome.observed,
    retries: outcome.retries,
  };
  return { value, verification };
}

// ─────────────────────────────────────────────────────────────────────────────
// Navegação
// ─────────────────────────────────────────────────────────────────────────────

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const;
type WaitUntil = (typeof WAIT_UNTIL)[number];

function readWaitUntil(body: Body): WaitUntil {
  const raw = body.wait_until;
  if (raw === undefined || raw === null) return "domcontentloaded";
  if (typeof raw !== "string" || !(WAIT_UNTIL as readonly string[]).includes(raw)) {
    throw new ApiError("INVALID_REQUEST", `wait_until inválido: ${String(raw)}`, { allowed: [...WAIT_UNTIL] });
  }
  return raw as WaitUntil;
}

const handleGoto: ActionHandler = async (svc, req) => {
  const url = urlGuard(svc, reqStr(req.body, "url"));
  const waitUntil = readWaitUntil(req.body);
  const page = pageOf(svc, req);
  try {
    await page.goto(url, { waitUntil });
  } catch (e) {
    throw new ApiError("NAVIGATION_FAILED", `goto(${url}) falhou: ${(e as Error).message}`, { url });
  }
  svc.emit("page.loaded", req.session_id, req.action_id, { url: page.url() }, "agent");
  return pageInfoOf(svc, req.session_id, page);
};

const handleOpen: ActionHandler = async (svc, req) => {
  const url = urlGuard(svc, reqStr(req.body, "url"));
  return svc.sessions.newPage(req.session_id, url);
};

function historyHandler(kind: "back" | "forward" | "reload"): ActionHandler {
  return async (svc, req) => {
    const page = pageOf(svc, req);
    const waitUntil = readWaitUntil(req.body);
    try {
      if (kind === "back") {
        const r = await page.goBack({ waitUntil });
        if (r === null) throw new ApiError("NAVIGATION_FAILED", "não há entrada anterior no histórico");
      } else if (kind === "forward") {
        const r = await page.goForward({ waitUntil });
        if (r === null) throw new ApiError("NAVIGATION_FAILED", "não há entrada seguinte no histórico");
      } else {
        await page.reload({ waitUntil });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("NAVIGATION_FAILED", `${kind} falhou: ${(e as Error).message}`);
    }
    svc.emit("page.loaded", req.session_id, req.action_id, { url: page.url(), via: kind }, "agent");
    return pageInfoOf(svc, req.session_id, page);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Percepção
// ─────────────────────────────────────────────────────────────────────────────

const handleObserve: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const limit = num(req.body, "limit");
  const observation: Observation = await svc.perception.observe(page, {
    accessibility: bool(req.body, "accessibility", false),
    screenshot: bool(req.body, "screenshot", false),
    ...(limit !== null ? { limit } : {}),
    includeHidden: bool(req.body, "include_hidden", false),
    includeDecorative: bool(req.body, "include_decorative", false),
    ...(svc.sessions.pageIdOf(page) !== null ? { page_id: svc.sessions.pageIdOf(page)! } : {}),
  });
  // FASE 32: quem reobservou de fato é quem pode liberar RECOVERING → ACTIVE.
  if (svc.sessions.needsReobservation(req.session_id)) svc.sessions.markObserved(req.session_id);
  return observation;
};

const handleFind: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const resolved = await resolveOn(svc, page, target, num(req.body, "timeout_ms"));
  svc.emit("element.found", req.session_id, req.action_id, {
    strategy: resolved.strategy,
    attempted: resolved.attempted,
    healed: resolved.healed,
    box: resolved.box,
  }, "agent");
  return publicTarget(resolved);
};

const EXTRACT_FORMATS = ["text", "html", "value"] as const;

const handleExtract: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const rawFormat = req.body.format;
  const format = rawFormat === undefined || rawFormat === null ? "text" : rawFormat;
  if (typeof format !== "string" || !(EXTRACT_FORMATS as readonly string[]).includes(format)) {
    throw new ApiError("INVALID_REQUEST", `format inválido: ${String(format)}`, { allowed: [...EXTRACT_FORMATS] });
  }

  if (req.body.target === undefined || req.body.target === null) {
    const content =
      format === "html"
        ? await page.content()
        : await page.evaluate(() => document.body?.innerText ?? "");
    if (format === "value") {
      throw new ApiError("INVALID_REQUEST", 'format "value" exige um target (é o valor de um campo)');
    }
    return { content, scope: "document", format };
  }

  const resolved = await resolveOn(svc, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
  const loc = resolved.handle as Locator | undefined;
  if (loc === undefined) {
    throw new ApiError("TARGET_NOT_FOUND", "alvo resolvido por coordenada não tem conteúdo extraível", {
      strategy: resolved.strategy,
    });
  }
  const content =
    format === "html" ? await loc.innerHTML() : format === "value" ? await loc.inputValue() : ((await loc.textContent()) ?? "");
  return { content, scope: "element", format, target: publicTarget(resolved) };
};

const SCREENSHOT_SCOPES = ["viewport", "full", "element", "region"] as const;

const handleScreenshot: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const rawScope = req.body.scope;
  const scope = rawScope === undefined || rawScope === null ? "viewport" : rawScope;
  if (typeof scope !== "string" || !(SCREENSHOT_SCOPES as readonly string[]).includes(scope)) {
    throw new ApiError("INVALID_REQUEST", `scope inválido: ${String(scope)}`, { allowed: [...SCREENSHOT_SCOPES] });
  }

  let elementTarget: ElementHandle<Element> | undefined;
  let resolvedForResult: Omit<ResolvedTarget, "handle"> | null = null;
  if (scope === "element") {
    if (req.body.target === undefined) {
      throw new ApiError("INVALID_REQUEST", "scope=element exige target");
    }
    const resolved = await resolveOn(svc, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    const loc = resolved.handle as Locator | undefined;
    if (loc === undefined) throw new ApiError("TARGET_NOT_FOUND", "alvo sem elemento para capturar");
    const handle = await loc.elementHandle();
    if (handle === null) throw new ApiError("TARGET_NOT_FOUND", "elemento desapareceu antes da captura");
    elementTarget = handle as ElementHandle<Element>;
    resolvedForResult = publicTarget(resolved);
  }

  let region: { x: number; y: number; width: number; height: number } | undefined;
  if (scope === "region") {
    const r = req.body.region as Record<string, unknown> | undefined;
    if (r === undefined || r === null || typeof r !== "object") {
      throw new ApiError("INVALID_REQUEST", "scope=region exige region {x,y,width,height}");
    }
    for (const k of ["x", "y", "width", "height"]) {
      if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number)) {
        throw new ApiError("INVALID_REQUEST", `region.${k} deve ser número finito`);
      }
    }
    region = { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
  }

  const shot = await svc.perception.capture(page, {
    scope: scope as ScreenshotScope,
    ...(elementTarget !== undefined ? { target: elementTarget } : {}),
    ...(region !== undefined ? { region } : {}),
    devicePixels: bool(req.body, "device_pixels", false),
  });
  // Persistir é parte da captura, não um extra. Uma falha ao gravar é reportada
  // em `persisted:false` — nunca silenciada, nunca fatal para a ação em si.
  let persisted = false;
  let persist_error: string | undefined;
  const recorder = svc.recorderFor(req.session_id);
  if (recorder !== null) {
    try {
      await recorder.saveScreenshot(shot.buffer, shot.screenshot_ref);
      persisted = true;
    } catch (e) {
      persist_error = toActionError(e).message;
      console.error("[api] saveScreenshot falhou:", persist_error);
    }
  }

  return {
    screenshot_ref: shot.screenshot_ref,
    // URL só existe quando o PNG chegou ao disco. Devolver um link para arquivo
    // inexistente seria pior que não devolver: o cliente exibiria imagem quebrada
    // achando que a captura funcionou.
    ...(persisted ? { screenshot_url: `/screenshots/${req.session_id}/${shot.screenshot_ref}.png` } : {}),
    width: shot.width,
    height: shot.height,
    bytes: shot.bytes,
    scope: shot.scope,
    captured_at: shot.captured_at,
    persisted,
    ...(persist_error !== undefined ? { persist_error } : {}),
    ...(resolvedForResult !== null ? { target: resolvedForResult } : {}),
  };
};

const handleNetwork: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const engines = svc.enginesFor(req.session_id, page);
  const limit = num(req.body, "limit");
  const entries = engines.network.entries(limit ?? undefined);
  return {
    requests: entries,
    total: engines.network.size(),
    // Corte visível: sem isto, um buffer que já girou pareceria "a página só fez N pedidos".
    dropped: engines.network.dropped(),
    attached: engines.network.attached,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Abas
// ─────────────────────────────────────────────────────────────────────────────

const handleTabs: ActionHandler = async (svc, req) => {
  const info = await svc.sessions.observe(req.session_id);
  return info.pages;
};

const handleNewTab: ActionHandler = async (svc, req) => {
  const url = str(req.body, "url");
  if (url === null) return svc.sessions.newPage(req.session_id);
  return svc.sessions.newPage(req.session_id, urlGuard(svc, url));
};

const handleSwitchTab: ActionHandler = async (svc, req) => {
  const page_id = reqStr(req.body, "page_id");
  const info = svc.sessions.switchPage(req.session_id, page_id);
  const found = info.pages.find((p) => p.page_id === page_id);
  if (found === undefined) throw new ApiError("TARGET_NOT_FOUND", `page_id ${page_id} sumiu após a troca`);
  return found;
};

const handleCloseTab: ActionHandler = async (svc, req) => {
  const page_id = reqStr(req.body, "page_id");
  await svc.sessions.closePage(req.session_id, page_id);
  return { closed: true, page_id };
};

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

const handleClick: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const spec = readVerification(req.body.verification);
  const resolved = await resolveOn(svc, page, target, num(req.body, "timeout_ms"));
  const { pointer } = svc.enginesFor(req.session_id, page);
  const button = req.body.button;
  if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") {
    throw new ApiError("INVALID_REQUEST", `button inválido: ${String(button)}`);
  }

  const { value, verification } = await withVerification(page, spec, () =>
    pointer.click(centerOf(resolved), {
      action_id: req.action_id,
      ...(button !== undefined ? { button: button as "left" | "right" | "middle" } : {}),
      ...(bool(req.body, "humanize", false) ? { humanize: true } : {}),
    }),
  );

  return {
    target: publicTarget(resolved),
    verification,
    pointer: { backend: value.backend, fallback_used: value.fallback_used, fallback_reason: value.fallback_reason },
  };
};

const handleType: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const target = readTarget(req.body.target);
  const spec = readVerification(req.body.verification);
  const text = str(req.body, "text");
  const credential_ref = str(req.body, "credential_ref");
  if ((text === null) === (credential_ref === null)) {
    throw new ApiError("INVALID_REQUEST", "informe exatamente um entre `text` e `credential_ref`");
  }

  const resolved = await resolveOn(svc, page, target, num(req.body, "timeout_ms"));
  const { pointer, keyboard } = svc.enginesFor(req.session_id, page);
  const info = svc.sessions.get(req.session_id);

  const run = async (): Promise<Record<string, unknown>> => {
    if (credential_ref !== null) {
      const vault = svc.vaultFor(info.profile);
      const loc = resolved.handle as Locator | undefined;
      if (loc === undefined) {
        throw new ApiError("TARGET_NOT_FOUND", "injeção de segredo exige elemento; alvo por coordenada não serve", {
          strategy: resolved.strategy,
        });
      }
      const receipt = await vault.injectSecret(page, loc, credential_ref, {
        session: req.session_id,
        mode: "fill",
        destino: resolved.description,
      });
      // O recibo NÃO carrega valor, comprimento nem prefixo — é o contrato do vault.
      return { credential_ref: receipt.ref, injected: receipt.injected, secret_verified: receipt.verified };
    }
    await pointer.click(centerOf(resolved), { action_id: req.action_id });
    if (bool(req.body, "clear", false)) {
      const loc = resolved.handle as Locator | undefined;
      if (loc !== undefined) await loc.fill("");
    }
    const r = await keyboard.type(text!, { action_id: req.action_id });
    return { typed_length: r.text_length, backend: r.backend, fallback_used: r.fallback_used };
  };

  const { value, verification } = await withVerification(page, spec, run);
  return { target: publicTarget(resolved), verification, ...value };
};

const handlePress: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { keyboard } = svc.enginesFor(req.session_id, page);
  const key = str(req.body, "key");
  const rawKeys = req.body.keys;
  if (key === null && rawKeys === undefined) {
    throw new ApiError("INVALID_REQUEST", "informe `key` ou `keys[]`");
  }
  if (key !== null && rawKeys !== undefined) {
    throw new ApiError("INVALID_REQUEST", "informe `key` OU `keys[]`, não os dois");
  }

  if (key !== null) {
    const r = await keyboard.press(key, { action_id: req.action_id });
    return { pressed: r.keys, backend: r.backend, editing_commands: r.editing_commands };
  }
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.some((k) => typeof k !== "string" || k === "")) {
    throw new ApiError("INVALID_REQUEST", "keys deve ser array não vazio de strings");
  }
  const r = await keyboard.hotkey(rawKeys as string[], { action_id: req.action_id });
  return { pressed: r.keys, backend: r.backend, editing_commands: r.editing_commands };
};

const handleScroll: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { pointer } = svc.enginesFor(req.session_id, page);
  const dx = num(req.body, "dx", 0)!;
  const dy = num(req.body, "dy", 0)!;
  if (dx === 0 && dy === 0) throw new ApiError("INVALID_REQUEST", "scroll exige dx ou dy diferente de zero");

  let at: Point | undefined;
  if (req.body.target !== undefined && req.body.target !== null) {
    const resolved = await resolveOn(svc, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    at = centerOf(resolved);
  }
  const r = await pointer.scroll({ dx, dy }, { action_id: req.action_id, ...(at !== undefined ? { at } : {}) });
  return { scrolled: r.delta, at: r.to, backend: r.backend };
};

const handleDrag: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const { pointer } = svc.enginesFor(req.session_id, page);
  const from = await resolveOn(svc, page, readTarget(req.body.from, "from"), num(req.body, "timeout_ms"));
  const to = await resolveOn(svc, page, readTarget(req.body.to, "to"), num(req.body, "timeout_ms"));
  const spec = readVerification(req.body.verification);
  const { value, verification } = await withVerification(page, spec, () =>
    pointer.drag(centerOf(from), centerOf(to), { action_id: req.action_id, steps: 12 }),
  );
  return {
    dragged: { from: value.from, to: value.to, steps: value.steps },
    verification,
    from_target: publicTarget(from),
    to_target: publicTarget(to),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Espera — condição verificável, nunca duração fixa (docs/API.md)
// ─────────────────────────────────────────────────────────────────────────────

const WAIT_CONDITIONS = ["url_contains", "element_visible", "element_hidden", "network_idle", "text_present"] as const;

const handleWait: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const condition = reqStr(req.body, "condition");
  if (!(WAIT_CONDITIONS as readonly string[]).includes(condition)) {
    throw new ApiError("INVALID_REQUEST", `condition inválida: ${condition}`, { allowed: [...WAIT_CONDITIONS] });
  }
  const timeout = num(req.body, "timeout_ms", 15_000)!;
  const value = str(req.body, "value");
  const t0 = Date.now();

  const needValue = (): string => {
    if (value === null) throw new ApiError("INVALID_REQUEST", `condition=${condition} exige \`value\``);
    return value;
  };

  const selectorFor = (): string => {
    if (value !== null) return value;
    if (req.body.target !== undefined) {
      const t = readTarget(req.body.target);
      if (typeof t.selector === "string") return t.selector;
    }
    throw new ApiError("INVALID_REQUEST", `condition=${condition} exige \`value\` (seletor) ou target.selector`);
  };

  try {
    if (condition === "url_contains") {
      const needle = needValue();
      await page.waitForFunction((v: string) => window.location.href.includes(v), needle, { timeout });
    } else if (condition === "element_visible") {
      await page.locator(selectorFor()).first().waitFor({ state: "visible", timeout });
    } else if (condition === "element_hidden") {
      await page.locator(selectorFor()).first().waitFor({ state: "hidden", timeout });
    } else if (condition === "network_idle") {
      await page.waitForLoadState("networkidle", { timeout });
    } else {
      const needle = needValue();
      await page.waitForFunction(
        (v: string) => (document.body?.innerText ?? "").includes(v),
        needle,
        { timeout },
      );
    }
  } catch (e) {
    throw new ApiError("TIMEOUT", `condição "${condition}" não foi satisfeita em ${timeout}ms`, {
      condition,
      timeout_ms: timeout,
      waited_ms: Date.now() - t0,
      cause: (e as Error).message,
    });
  }
  return { waited_ms: Date.now() - t0, condition, satisfied: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// Download / Upload — COMMIT, fail closed em toda etapa
// ─────────────────────────────────────────────────────────────────────────────

const handleDownload: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const root = svc.config.download_root;
  if (root === null) {
    // Sem raiz configurada não existe "fora da raiz"; salvar em qualquer lugar
    // seria exatamente o fallback silencioso que a política proíbe.
    throw new ApiError("DOWNLOAD_DENIED", "download_root não configurado — download negado (fail closed)");
  }
  const url = str(req.body, "url");
  const hasTarget = req.body.target !== undefined && req.body.target !== null;
  if ((url === null) === !hasTarget) {
    throw new ApiError("INVALID_REQUEST", "informe exatamente um entre `url` e `target`");
  }

  const waiter: Promise<Download> = page.waitForEvent("download", { timeout: num(req.body, "timeout_ms", 30_000)! });
  svc.emit("download.started", req.session_id, req.action_id, { via: url !== null ? "url" : "target" }, "agent");

  if (url !== null) {
    const safe = urlGuard(svc, url);
    // Navegar para um recurso baixável dispara o evento e aborta a navegação.
    await page.goto(safe).catch(() => undefined);
  } else {
    const resolved = await resolveOn(svc, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
    const { pointer } = svc.enginesFor(req.session_id, page);
    await pointer.click(centerOf(resolved), { action_id: req.action_id });
  }

  let dl: Download;
  try {
    dl = await waiter;
  } catch (e) {
    throw new ApiError("TIMEOUT", `nenhum download iniciou: ${(e as Error).message}`);
  }

  const suggested = dl.suggestedFilename();
  const decision = checkPath(suggested, "download", { root, mustExist: false });
  if (!decision.allowed) {
    await dl.cancel().catch(() => undefined);
    throw new ApiError(decision.code ?? "DOWNLOAD_DENIED", decision.reason, { filename: suggested, root: decision.root });
  }
  const destination = decision.resolved!;
  await dl.saveAs(destination);

  const record: DownloadRecord = {
    download_id: newId("dl"),
    session_id: req.session_id,
    filename: path.basename(destination),
    mime: null,
    size: null,
    status: "completed",
    source: dl.url(),
    destination,
    created_at: nowIso(),
  };
  svc.emit("download.completed", req.session_id, req.action_id, {
    download_id: record.download_id,
    filename: record.filename,
  }, "agent");
  return record;
};

const handleUpload: ActionHandler = async (svc, req) => {
  const page = pageOf(svc, req);
  const root = svc.config.upload_root;
  if (root === null) {
    throw new ApiError("UPLOAD_DENIED", "upload_root não configurado — upload negado (fail closed)");
  }
  const candidate = str(req.body, "path") ?? str(req.body, "file_ref");
  if (candidate === null) throw new ApiError("INVALID_REQUEST", "informe `path` ou `file_ref`");

  const decision = checkPath(candidate, "upload", { root, mustExist: true });
  if (!decision.allowed) {
    throw new ApiError(decision.code ?? "UPLOAD_DENIED", decision.reason, { root: decision.root });
  }
  const file = decision.resolved!;

  const resolved = await resolveOn(svc, page, readTarget(req.body.target), num(req.body, "timeout_ms"));
  const loc = resolved.handle as Locator | undefined;
  if (loc === undefined) throw new ApiError("TARGET_NOT_FOUND", "upload exige um <input type=file>; alvo por coordenada não serve");

  svc.emit("upload.started", req.session_id, req.action_id, { filename: path.basename(file) }, "agent");
  try {
    await loc.setInputFiles(file);
  } catch (e) {
    throw new ApiError("UPLOAD_DENIED", `setInputFiles falhou: ${(e as Error).message}`, { target: resolved.description });
  }

  const record: UploadRecord = {
    upload_id: newId("up"),
    session_id: req.session_id,
    filename: path.basename(file),
    destination_site: new URL(page.url()).host,
    task: svc.sessions.get(req.session_id).task,
    created_at: nowIso(),
  };
  svc.emit("upload.completed", req.session_id, req.action_id, {
    upload_id: record.upload_id,
    filename: record.filename,
    destination_site: record.destination_site,
  }, "agent");
  return record;
};

// ─────────────────────────────────────────────────────────────────────────────
// Task (FASE 33/34) — exige AgentProvider; sem ele, fail closed
// ─────────────────────────────────────────────────────────────────────────────

const handleTask: ActionHandler = async (svc, req) => {
  const goal = reqStr(req.body, "goal");
  const agent = svc.agent;
  const now = nowIso();
  const task: BrowserTask = {
    task_id: newId("tsk"),
    session_id: req.session_id,
    goal,
    state: "QUEUED",
    plan: null,
    actions: [],
    retries: 0,
    evidence: [],
    result: null,
    created_at: now,
    updated_at: now,
  };
  svc.registerTask(task);

  if (agent === null) {
    task.state = "FAILED";
    task.updated_at = nowIso();
    // Devolver um QUEUED que ninguém executará seria mentir por omissão.
    throw new ApiError(
      "INVALID_REQUEST",
      "browser.task exige um AgentProvider registrado no daemon; nenhum foi injetado",
      { task_id: task.task_id, goal },
    );
  }

  const page = pageOf(svc, req);
  svc.emit("task.started", req.session_id, req.action_id, { task_id: task.task_id, goal }, agent.name);
  try {
    task.state = "PLANNING";
    const raw = await svc.perception.observe(page, { limit: svc.config.observe_limit });
    const observation = await agent.observe({ session_id: req.session_id, observation: raw });
    const reasoning = await agent.reason({ goal, observation });
    const plan: Plan = await agent.plan({ goal, observation, reasoning });
    task.plan = plan;
    task.state = "RUNNING";

    for (const step of plan.steps) {
      const response = await agent.act({ session_id: req.session_id, step });
      task.actions.push(response.action_id);
      svc.emit("task.progress", req.session_id, response.action_id, {
        task_id: task.task_id,
        step: step.id,
        success: response.success,
      }, agent.name);
      if (!response.success) {
        task.state = "FAILED";
        task.result = response.error;
        task.updated_at = nowIso();
        svc.emit("task.failed", req.session_id, req.action_id, { task_id: task.task_id, step: step.id }, agent.name);
        return task;
      }
      const v = await agent.verify({ step, response });
      task.evidence.push(`${step.id}:${v.kind}:${v.verified ? "verified" : "unverified"}`);
    }
    task.state = "COMPLETED";
    task.updated_at = nowIso();
    svc.emit("task.completed", req.session_id, req.action_id, { task_id: task.task_id, steps: plan.steps.length }, agent.name);
    return task;
  } catch (e) {
    task.state = "FAILED";
    task.updated_at = nowIso();
    svc.emit("task.failed", req.session_id, req.action_id, { task_id: task.task_id, error: toActionError(e).code }, agent.name);
    throw e;
  }
};

// ─────────────────────────────────────────────────────────────────────────────

export const HANDLERS: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "browser.open": handleOpen,
  "browser.goto": handleGoto,
  "browser.back": historyHandler("back"),
  "browser.forward": historyHandler("forward"),
  "browser.reload": historyHandler("reload"),
  "browser.observe": handleObserve,
  "browser.find": handleFind,
  "browser.extract": handleExtract,
  "browser.screenshot": handleScreenshot,
  "browser.network": handleNetwork,
  "browser.tabs": handleTabs,
  "browser.new_tab": handleNewTab,
  "browser.switch_tab": handleSwitchTab,
  "browser.close_tab": handleCloseTab,
  "browser.click": handleClick,
  "browser.type": handleType,
  "browser.press": handlePress,
  "browser.scroll": handleScroll,
  "browser.drag": handleDrag,
  "browser.wait": handleWait,
  "browser.download": handleDownload,
  "browser.upload": handleUpload,
  "browser.task": handleTask,
});

export function handlerFor(tool: string): ActionHandler | null {
  return Object.hasOwn(HANDLERS, tool) ? HANDLERS[tool]! : null;
}

/** Trilha de auditoria de uma ação. Não recebe corpo — corpo pode carregar segredo. */
export function auditEntryFor(
  req: ActionRequest,
  result: "ok" | "error" | "denied",
  verified: boolean,
  detail?: Record<string, unknown>,
): AuditEntry {
  return {
    timestamp: nowIso(),
    session: req.session_id === "" ? null : req.session_id,
    actor: req.client ?? "unknown",
    action: req.tool,
    target: typeof req.body.target === "object" && req.body.target !== null ? JSON.stringify(req.body.target) : null,
    result,
    verified,
    action_id: req.action_id,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export { newActionId };
export type { PlanStep };
