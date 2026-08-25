/**
 * REPLAY — FASE 25
 *
 * Reconstrução de sessão a partir do disco. Estrutura por sessão:
 *
 *   sessions/<id>/actions.jsonl     ← AuditEntry   (mesma trilha da FASE 24)
 *   sessions/<id>/events.jsonl      ← RuntimeEvent
 *   sessions/<id>/network.jsonl     ← NetworkRecord
 *   sessions/<id>/screenshots/      ← binários + index.jsonl
 *   sessions/<id>/result.json       ← desfecho da sessão
 *
 * O ponto da fase não é "gravar log": é conseguir responder *o que aconteceu, em
 * que ordem*. Por isso `replaySummary` funde as três fontes numa linha do tempo
 * única ordenada por timestamp — ação, evento e rede lado a lado, que é como o
 * fato realmente ocorreu.
 *
 * Honestidade sobre lacunas: nada é descartado em silêncio. Linha corrompida vai
 * para `errors`; screenshot no disco que não está no índice é devolvido marcado
 * `orphan`; `result.json` ilegível vira `result_error`, não `result: null` mudo.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AuditEntry, RuntimeEvent } from "../../core/src/contract.ts";
import { newId, nowIso } from "../../core/src/contract.ts";
import {
  ACTIONS_FILE,
  AuditLog,
  SESSIONS_ROOT,
  appendJsonl,
  assertSafeSessionId,
  flushJsonl,
  readJsonl,
  sessionDir,
  type JsonlLineError,
  type JsonlReadResult,
} from "./audit.ts";
import { pngDimensions } from "./png.ts";
import { redactObject } from "./redact.ts";
import type { EventBus, Subscription, SubscriptionFilter } from "./eventbus.ts";

export const EVENTS_FILE = "events.jsonl";
export const NETWORK_FILE = "network.jsonl";
export const RESULT_FILE = "result.json";
export const SCREENSHOTS_DIR = "screenshots";
export const SCREENSHOT_INDEX = "index.jsonl";
/** FASE 12 — selo de integridade do bundle. Ver `selarSessao`. */
export const SEAL_FILE = "seal.json";

/**
 * FASE 12 — SELO DE INTEGRIDADE DO BUNDLE DE REPLAY
 *
 * O PROBLEMA QUE O SELO RESOLVE E O QUE ELE NÃO RESOLVE
 * ----------------------------------------------------
 * `verifyReplay` já detectava muita coisa: JSONL corrompido, arquivo truncado,
 * screenshot com bytes divergentes do índice, timestamp fora de ordem, ação sem
 * desfecho. Nenhuma dessas checagens pega o ataque mais simples de todos —
 * ABRIR O JSONL E TROCAR UM VALOR. Se o JSON continua válido, o timestamp
 * continua no lugar e a contagem de linhas não muda, o bundle passa. Foi
 * medido: trocar a URL de uma linha de `actions.jsonl` era invisível.
 *
 * O selo fecha isso registrando, no fechamento da sessão, o sha256 e o tamanho
 * de cada arquivo do bundle. Verificar é recomputar e comparar. Linha alterada,
 * linhas reordenadas e arquivo truncado quebram o digest — os três casos que a
 * checagem estrutural deixava passar.
 *
 * RESÍDUO DECLARADO, PORQUE OMITI-LO SERIA PIOR QUE NÃO TER SELO
 * -------------------------------------------------------------
 * É hash SEM CHAVE. Quem tem permissão de escrita no diretório da sessão pode
 * adulterar o arquivo E reescrever o selo. Isto fecha corrupção acidental e
 * adulteração oportunista; NÃO fecha adversário com acesso de escrita. Para
 * isso seria preciso chave fora desta máquina — e prometer "à prova de
 * adulteração" com um hash local seria exatamente o tipo de afirmação que este
 * projeto não faz. Está escrito assim em `docs/SECURITY.md`.
 */
export interface SealedFile {
  /** Caminho RELATIVO ao diretório da sessão. */
  file: string;
  bytes: number;
  sha256: string;
}

export interface SessionSeal {
  session_id: string;
  sealed_at: string;
  algo: "sha256";
  /** Versão do formato do selo — para que um selo antigo seja reconhecido como antigo. */
  version: 1;
  files: SealedFile[];
  counts: { actions: number; events: number; network: number; screenshots: number };
}

/** sha256 de um arquivo; `null` quando ele não existe. */
async function digestDe(alvo: string): Promise<{ bytes: number; sha256: string } | null> {
  try {
    const buf = await readFile(alvo);
    return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Arquivos que entram no selo, na ORDEM canônica (a ordem faz parte do selo). */
export async function arquivosDoBundle(dir: string): Promise<string[]> {
  const fixos = [ACTIONS_FILE, EVENTS_FILE, NETWORK_FILE, RESULT_FILE, `${SCREENSHOTS_DIR}/${SCREENSHOT_INDEX}`];
  const shots: string[] = [];
  try {
    for (const nome of (await readdir(path.join(dir, SCREENSHOTS_DIR))).sort()) {
      if (nome === SCREENSHOT_INDEX) continue;
      shots.push(`${SCREENSHOTS_DIR}/${nome}`);
    }
  } catch {
    // Sessão sem screenshot: lista vazia, não erro.
  }
  return [...fixos, ...shots];
}

/**
 * Calcula (sem gravar) o selo do que está no disco AGORA.
 * É a mesma função usada para selar e para verificar — duas implementações
 * divergiriam e o selo passaria a acusar diferença que não existe.
 */
export async function calcularSelo(session_id: string, options: ReplayOptions = {}): Promise<SessionSeal> {
  const root = options.root ?? SESSIONS_ROOT;
  const dir = sessionDir(session_id, root);
  const files: SealedFile[] = [];
  for (const rel of await arquivosDoBundle(dir)) {
    const d = await digestDe(path.join(dir, rel));
    // Arquivo ausente NÃO entra no selo. Selar a ausência transformaria
    // "a sessão não teve tráfego de rede" em divergência na primeira verificação.
    if (d !== null) files.push({ file: rel, bytes: d.bytes, sha256: d.sha256 });
  }
  const contar = async (rel: string): Promise<number> => {
    try {
      const t = await readFile(path.join(dir, rel), "utf8");
      return t.split("\n").filter((l) => l.trim() !== "").length;
    } catch {
      return 0;
    }
  };
  return {
    session_id,
    sealed_at: nowIso(),
    algo: "sha256",
    version: 1,
    files,
    counts: {
      actions: await contar(ACTIONS_FILE),
      events: await contar(EVENTS_FILE),
      network: await contar(NETWORK_FILE),
      screenshots: await contar(`${SCREENSHOTS_DIR}/${SCREENSHOT_INDEX}`),
    },
  };
}

/** Calcula e GRAVA o selo. Chamado no fechamento da sessão. */
export async function selarSessao(session_id: string, options: ReplayOptions = {}): Promise<SessionSeal> {
  const root = options.root ?? SESSIONS_ROOT;
  const dir = sessionDir(session_id, root);
  const selo = await calcularSelo(session_id, { root });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, SEAL_FILE), `${JSON.stringify(selo, null, 2)}\n`, "utf8");
  return selo;
}

/** Lê o selo gravado. `null` = sessão nunca selada (bundle legado ou aberto). */
export async function lerSelo(session_id: string, options: ReplayOptions = {}): Promise<SessionSeal | null> {
  const root = options.root ?? SESSIONS_ROOT;
  try {
    const cru = await readFile(path.join(sessionDir(session_id, root), SEAL_FILE), "utf8");
    return JSON.parse(cru) as SessionSeal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Selo ilegível é DIFERENTE de selo ausente: quem verifica precisa saber.
    throw error;
  }
}

/**
 * Registro de rede. O contrato v1 não define este tipo (a API v1 devolve
 * `{requests[]}` genérico em `browser.network`), então ele é declarado aqui de
 * forma aberta: campos conhecidos tipados, `[k: string]` para o resto, sem
 * obrigar quem captura a se encaixar num formato que o contrato não fixou.
 */
export interface NetworkRecord {
  /** Ausente ⇒ preenchido com o instante da gravação. */
  timestamp?: string;
  url: string;
  method?: string;
  status?: number | null;
  resource_type?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  duration_ms?: number;
  failed?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ScreenshotRecord {
  ref: string;
  file: string;
  bytes: number;
  width: number | null;
  height: number | null;
  saved_at: string;
  /** Preenchido quando o buffer não é um PNG decodificável. */
  decode_error?: string;
  /** true quando o arquivo existe no disco mas não no índice. */
  orphan?: boolean;
}

export interface SessionResultFile {
  session_id: string;
  finished_at: string;
  /** Contagem do que ESTE recorder gravou — não do que está no disco. */
  recorded: { actions: number; events: number; network: number; screenshots: number };
  result: unknown;
}

export interface ReplayBundle {
  session_id: string;
  dir: string;
  actions: AuditEntry[];
  events: RuntimeEvent[];
  network: NetworkRecord[];
  screenshots: ScreenshotRecord[];
  result: SessionResultFile | null;
  /** Linhas corrompidas por fonte. Vazio = leitura íntegra. */
  errors: { source: ReplaySource | "screenshot"; error: JsonlLineError }[];
  /** Falha ao ler/parsear `result.json`, quando houve. */
  result_error: string | null;
  /** Fontes que sequer existem no disco. */
  missing: string[];
}

export type ReplaySource = "action" | "event" | "network";

export interface TimelineItem {
  timestamp: string;
  source: ReplaySource;
  /** Rótulo curto e legível: nome do evento, ação auditada ou `METHOD url`. */
  label: string;
  /** Posição dentro da própria fonte, antes da fusão. */
  index: number;
  session_id: string | null;
  action_id: string | null;
  data: AuditEntry | RuntimeEvent | NetworkRecord;
}

export interface ReplayOptions {
  root?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gravação
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionRecorderOptions extends ReplayOptions {
  /** fsync em todo append. Default false. */
  fsync?: boolean;
}

export class SessionRecorder {
  readonly session_id: string;
  readonly root: string;
  readonly dir: string;
  readonly fsync: boolean;

  #audit: AuditLog;
  #counts = { actions: 0, events: 0, network: 0, screenshots: 0 };
  #subscriptions: Subscription[] = [];

  constructor(session_id: string, options: SessionRecorderOptions = {}) {
    this.session_id = assertSafeSessionId(session_id);
    this.root = options.root ?? SESSIONS_ROOT;
    this.dir = sessionDir(this.session_id, this.root);
    this.fsync = options.fsync ?? false;
    this.#audit = new AuditLog({ root: this.root, fsync: this.fsync });
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  /** Garante a árvore da sessão. Idempotente. */
  async init(): Promise<string> {
    await mkdir(this.path(SCREENSHOTS_DIR), { recursive: true });
    return this.dir;
  }

  /**
   * FASE 12 — sela o bundle. Idempotente: reselar recalcula sobre o disco atual.
   * Chamado no fechamento da sessão; o `verifyReplay` é quem confere depois.
   */
  async seal(): Promise<SessionSeal> {
    return selarSessao(this.session_id, { root: this.root });
  }

  /** Grava em `actions.jsonl` (mesma trilha do AuditLog). Devolve o redigido. */
  async recordAction(entry: AuditEntry): Promise<AuditEntry> {
    const safe = await this.#audit.append(entry, this.session_id);
    this.#counts.actions += 1;
    return safe;
  }

  /** Grava em `events.jsonl`. Devolve o redigido. */
  async recordEvent(event: RuntimeEvent): Promise<RuntimeEvent> {
    const safe = redactObject(event);
    await appendJsonl(this.path(EVENTS_FILE), safe, { fsync: this.fsync });
    this.#counts.events += 1;
    return safe;
  }

  /** Grava em `network.jsonl`. Cabeçalhos e URL saem redigidos. */
  async recordNetwork(record: NetworkRecord): Promise<NetworkRecord> {
    const stamped: NetworkRecord = { ...record, timestamp: record.timestamp ?? nowIso() };
    const safe = redactObject(stamped);
    await appendJsonl(this.path(NETWORK_FILE), safe, { fsync: this.fsync });
    this.#counts.network += 1;
    return safe;
  }

  /**
   * Persiste um screenshot e devolve a REFERÊNCIA — é ela que atravessa a API
   * (`Observation.screenshot_ref`), nunca o binário nem o caminho absoluto.
   * As dimensões saem do decodificador PNG do próprio pacote; se o buffer não
   * for PNG, o byte é salvo assim mesmo e o erro fica registrado no índice.
   */
  async saveScreenshot(buffer: Buffer | Uint8Array, ref?: string): Promise<string> {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (bytes.length === 0) {
      throw new Error("replay: saveScreenshot recebeu buffer vazio");
    }
    const id = ref ?? newId("shot");
    assertSafeSessionId(id); // mesma regra de nome: vira caminho de arquivo

    let width: number | null = null;
    let height: number | null = null;
    let decode_error: string | undefined;
    try {
      const dims = pngDimensions(bytes);
      width = dims.width;
      height = dims.height;
    } catch (error) {
      decode_error = error instanceof Error ? error.message : String(error);
    }

    const filename = `${id}.${decode_error === undefined ? "png" : "bin"}`;
    await mkdir(this.path(SCREENSHOTS_DIR), { recursive: true });
    await writeFile(this.path(SCREENSHOTS_DIR, filename), bytes);

    const record: ScreenshotRecord = {
      ref: id,
      file: filename,
      bytes: bytes.length,
      width,
      height,
      saved_at: nowIso(),
      ...(decode_error === undefined ? {} : { decode_error }),
    };
    await appendJsonl(this.path(SCREENSHOTS_DIR, SCREENSHOT_INDEX), record, { fsync: this.fsync });
    this.#counts.screenshots += 1;
    return id;
  }

  /**
   * Liga o recorder a um EventBus: todo evento que casar com o filtro vira
   * linha em `events.jsonl`. Devolve a assinatura para desligar.
   */
  recordFrom(bus: EventBus, filter?: SubscriptionFilter): Subscription {
    const sub = bus.subscribe(filter ?? { session_id: this.session_id }, async (event) => {
      await this.recordEvent(event as RuntimeEvent);
    });
    this.#subscriptions.push(sub);
    return sub;
  }

  /** Espera todas as escritas pendentes desta sessão chegarem ao disco. */
  async flush(): Promise<void> {
    await Promise.all([
      flushJsonl(this.path(ACTIONS_FILE)),
      flushJsonl(this.path(EVENTS_FILE)),
      flushJsonl(this.path(NETWORK_FILE)),
      flushJsonl(this.path(SCREENSHOTS_DIR, SCREENSHOT_INDEX)),
    ]);
  }

  counts(): Readonly<{ actions: number; events: number; network: number; screenshots: number }> {
    return { ...this.#counts };
  }

  /** Fecha a sessão: cancela assinaturas, drena escritas e grava `result.json`. */
  async finish(result: unknown): Promise<SessionResultFile> {
    for (const sub of this.#subscriptions) sub.unsubscribe();
    this.#subscriptions = [];
    await this.flush();

    const payload: SessionResultFile = {
      session_id: this.session_id,
      finished_at: nowIso(),
      recorded: this.counts(),
      result: redactObject(result),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(RESULT_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    // FASE 12 — SELA DEPOIS DE ESCREVER O ÚLTIMO ARQUIVO, e não antes.
    //
    // `finish()` é o ponto em que a sessão para de escrever; um selo tirado um
    // instante antes já nasceria obsoleto por causa do próprio `result.json`.
    // Selar aqui torna a integridade uma propriedade do bundle FECHADO, que é a
    // única sobre a qual dá para afirmar alguma coisa.
    await selarSessao(this.session_id, { root: this.root });
    return payload;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

async function readScreenshots(dir: string): Promise<{ shots: ScreenshotRecord[]; errors: JsonlLineError[]; exists: boolean }> {
  const indexFile = path.join(dir, SCREENSHOT_INDEX);
  const index = await readJsonl<ScreenshotRecord>(indexFile);

  let files: string[] = [];
  let exists = index.exists;
  try {
    files = await readdir(dir);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const known = new Set(index.entries.map((s) => s.file));
  const shots = [...index.entries];
  for (const f of files) {
    if (f === SCREENSHOT_INDEX || known.has(f)) continue;
    // Arquivo sem entrada no índice: aparece marcado, em vez de ser omitido.
    const st = await stat(path.join(dir, f)).catch(() => null);
    shots.push({
      ref: path.parse(f).name,
      file: f,
      bytes: st?.size ?? 0,
      width: null,
      height: null,
      saved_at: st === null ? nowIso() : new Date(st.mtimeMs).toISOString(),
      orphan: true,
    });
  }
  return { shots, errors: index.errors, exists };
}

/** Reconstrói tudo que existe no disco para a sessão. */
export async function loadReplay(session_id: string, options: ReplayOptions = {}): Promise<ReplayBundle> {
  const root = options.root ?? SESSIONS_ROOT;
  const dir = sessionDir(session_id, root);

  const [actions, events, network, shots] = await Promise.all([
    readJsonl<AuditEntry>(path.join(dir, ACTIONS_FILE)),
    readJsonl<RuntimeEvent>(path.join(dir, EVENTS_FILE)),
    readJsonl<NetworkRecord>(path.join(dir, NETWORK_FILE)),
    readScreenshots(path.join(dir, SCREENSHOTS_DIR)),
  ]);

  let result: SessionResultFile | null = null;
  let result_error: string | null = null;
  try {
    result = JSON.parse(await readFile(path.join(dir, RESULT_FILE), "utf8")) as SessionResultFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      result_error = error instanceof Error ? error.message : String(error);
    }
  }

  const errors: ReplayBundle["errors"] = [
    ...actions.errors.map((e) => ({ source: "action" as const, error: e })),
    ...events.errors.map((e) => ({ source: "event" as const, error: e })),
    ...network.errors.map((e) => ({ source: "network" as const, error: e })),
    ...shots.errors.map((e) => ({ source: "screenshot" as const, error: e })),
  ];

  const missing: string[] = [];
  if (!actions.exists) missing.push(ACTIONS_FILE);
  if (!events.exists) missing.push(EVENTS_FILE);
  if (!network.exists) missing.push(NETWORK_FILE);
  if (!shots.exists) missing.push(SCREENSHOTS_DIR);
  if (result === null && result_error === null) missing.push(RESULT_FILE);

  return {
    session_id,
    dir,
    actions: actions.entries,
    events: events.entries,
    network: network.entries,
    screenshots: shots.shots,
    result,
    errors,
    result_error,
    missing,
  };
}

/** Ordem de desempate quando dois registros têm o mesmo instante. */
const SOURCE_RANK: Readonly<Record<ReplaySource, number>> = Object.freeze({
  action: 0,
  event: 1,
  network: 2,
});

function toMillis(timestamp: string | undefined): number {
  if (typeof timestamp !== "string") return Number.POSITIVE_INFINITY;
  const ms = Date.parse(timestamp);
  // Timestamp ilegível vai para o fim em vez de virar 1970 e bagunçar a ordem.
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function networkLabel(record: NetworkRecord): string {
  const method = typeof record.method === "string" ? record.method.toUpperCase() : "REQ";
  const status = record.status === null || record.status === undefined ? "" : ` ${record.status}`;
  return `${method}${status} ${record.url}`;
}

/** Funde as três fontes de um bundle já carregado numa linha do tempo. */
export function timelineOf(bundle: ReplayBundle): TimelineItem[] {
  const items: TimelineItem[] = [];

  bundle.actions.forEach((entry, index) => {
    items.push({
      timestamp: entry.timestamp,
      source: "action",
      label: `${entry.action} → ${entry.result}`,
      index,
      session_id: entry.session ?? null,
      action_id: entry.action_id ?? null,
      data: entry,
    });
  });

  bundle.events.forEach((event, index) => {
    items.push({
      timestamp: event.timestamp,
      source: "event",
      label: event.event,
      index,
      session_id: event.session_id,
      action_id: event.action_id,
      data: event,
    });
  });

  bundle.network.forEach((record, index) => {
    items.push({
      timestamp: record.timestamp ?? "",
      source: "network",
      label: networkLabel(record),
      index,
      session_id: typeof record.session_id === "string" ? record.session_id : null,
      action_id: typeof record.action_id === "string" ? record.action_id : null,
      data: record,
    });
  });

  items.sort((a, b) => {
    const am = toMillis(a.timestamp);
    const bm = toMillis(b.timestamp);
    // Comparação por igualdade, não por subtração: Infinity - Infinity é NaN e
    // um comparador que devolve NaN produz ordem indefinida.
    if (am !== bm) return am < bm ? -1 : 1;
    const r = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    return r !== 0 ? r : a.index - b.index;
  });

  return items;
}

/** Linha do tempo da sessão, ordenada por timestamp, fundindo as três fontes. */
export async function replaySummary(
  session_id: string,
  options: ReplayOptions = {},
): Promise<TimelineItem[]> {
  return timelineOf(await loadReplay(session_id, options));
}

/**
 * Caminho absoluto do binário de um screenshot.
 *
 * Aceita o `ScreenshotRecord` do bundle — que carrega o nome de arquivo REAL —
 * ou uma referência crua. Com a referência crua assume a convenção `.png`, que
 * é o caso normal; um buffer não-PNG é gravado como `.bin` e só o record sabe
 * disso. Por isso, quando houver bundle em mãos, passe o record.
 */
export function screenshotPath(
  session_id: string,
  ref: string | ScreenshotRecord,
  options: ReplayOptions = {},
): string {
  const root = options.root ?? SESSIONS_ROOT;
  const filename =
    typeof ref === "string" ? `${assertSafeSessionId(ref)}.png` : path.basename(ref.file);
  return path.join(sessionDir(session_id, root), SCREENSHOTS_DIR, filename);
}

export type { JsonlLineError, JsonlReadResult };
