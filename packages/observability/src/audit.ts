/**
 * AUDIT LOG — FASE 24
 *
 * Trilha append-only em JSONL, uma linha por `AuditEntry` do contrato, em
 * `sessions/<session_id>/actions.jsonl`.
 *
 * Três decisões que definem o valor da trilha:
 *
 *  1. LINHA RUIM NÃO DERRUBA O ARQUIVO. Um processo morto no meio de um write
 *     deixa uma linha truncada. Se a leitura estourasse ali, o crash apagaria a
 *     auditoria inteira — exatamente quando ela mais importa. A linha inválida
 *     é REPORTADA (número, conteúdo cru, erro) e as demais são devolvidas.
 *
 *  2. ESCRITA SERIALIZADA POR ARQUIVO. Duas ações concorrentes na mesma sessão
 *     não podem intercalar bytes e produzir uma linha híbrida. Cada caminho tem
 *     sua própria cadeia de promessas.
 *
 *  3. session_id É VALIDADO. Ele vem de fora e vira caminho de arquivo. `../`
 *     escreveria fora de `sessions/`. Aqui isso é erro, não sanitização
 *     silenciosa: fail closed.
 *
 * Tudo passa por `redactObject` antes de tocar o disco.
 */
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEntry } from "../../core/src/contract.ts";
import { redactObject } from "./redact.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Raiz das sessões: `<repo>/sessions`. Sobrescrevível por env para testes/daemon. */
export const SESSIONS_ROOT: string =
  process.env.NOMOS_SESSIONS_ROOT ?? path.resolve(HERE, "..", "..", "..", "sessions");

export const ACTIONS_FILE = "actions.jsonl";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Bucket para entradas sem sessão (`AuditEntry.session === null`). */
export const RUNTIME_BUCKET = "_runtime";

export interface JsonlLineError {
  /** 1-indexado, contando linhas físicas do arquivo. */
  line: number;
  raw: string;
  error: string;
}

export interface JsonlReadResult<T> {
  file: string;
  exists: boolean;
  entries: T[];
  errors: JsonlLineError[];
}

/**
 * Valida e devolve o session_id. Rejeita `..`, separador de caminho, vazio e
 * nome longo demais. Não corrige — recusa.
 */
export function assertSafeSessionId(session_id: string): string {
  // DEFEITO MEDIDO (FASE 5): `RUNTIME_BUCKET` é declarado NESTE arquivo e era
  // recusado por ESTA função — `SAFE_SESSION_ID` exige alfanumérico no primeiro
  // caractere e o balde começa com `_`. Consequência: toda entrada sem sessão
  // (`entry.session === null`) morria em `append()`, virava um
  // `[api] audit.append falhou` em stderr e SUMIA da trilha. A primeira produtora
  // real dessas linhas — `provider.degraded` do roteamento de providers — foi o
  // que revelou o buraco.
  //
  // A exceção é para a CONSTANTE, não para o padrão `_*`: um id de sessão
  // continua tendo de começar com alfanumérico, porque quem escolhe esse nome é
  // o cliente e o balde do runtime não pode ser sequestrado por ele.
  if (session_id === RUNTIME_BUCKET) return session_id;
  if (typeof session_id !== "string" || !SAFE_SESSION_ID.test(session_id)) {
    throw new Error(
      `audit: session_id inválido ${JSON.stringify(session_id)} — permitido [A-Za-z0-9._-], até 128 chars, sem separador de caminho`,
    );
  }
  if (session_id === "." || session_id === "..") {
    throw new Error("audit: session_id inválido — '.' e '..' não são sessões");
  }
  return session_id;
}

export function sessionDir(session_id: string, root: string = SESSIONS_ROOT): string {
  return path.join(root, assertSafeSessionId(session_id));
}

// ── Serialização de escrita por caminho ──────────────────────────────────────
const writeChains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  // `then(fn, fn)`: a próxima escrita roda mesmo que a anterior tenha falhado.
  const run = prev.then(fn, fn);
  writeChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface AppendOptions {
  /** fsync após o write. Custa I/O; garante durabilidade contra queda de energia. */
  fsync?: boolean;
}

/**
 * Anexa um objeto como uma linha JSON. Cria o diretório se preciso.
 * O valor JÁ deve vir redigido — quem chama daqui é responsável por isso.
 */
export async function appendJsonl(
  file: string,
  value: unknown,
  options: AppendOptions = {},
): Promise<void> {
  // `JSON.stringify` escapa \n e \r, então uma entrada nunca vira duas linhas.
  const line = `${JSON.stringify(value)}\n`;
  await serialize(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const fh = await open(file, "a");
    try {
      await fh.write(line);
      if (options.fsync === true) await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

/** Espera o término de todas as escritas pendentes de um arquivo. */
export async function flushJsonl(file: string): Promise<void> {
  const chain = writeChains.get(file);
  if (chain !== undefined) await chain;
}

/**
 * Lê um JSONL tolerando corrupção. Nunca lança por conteúdo — só por I/O
 * genuinamente inesperado (permissão, por exemplo). Arquivo ausente devolve
 * `exists:false` com listas vazias, o que é uma resposta, não um fallback.
 */
export async function readJsonl<T = unknown>(file: string): Promise<JsonlReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { file, exists: false, entries: [], errors: [] };
    }
    throw error;
  }

  const entries: T[] = [];
  const errors: JsonlLineError[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!;
    // Última linha vazia após o \n final não é registro.
    if (text.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(text) as T);
    } catch (error) {
      errors.push({
        line: i + 1,
        raw: text.length > 512 ? `${text.slice(0, 512)}…` : text,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { file, exists: true, entries, errors };
}

export interface AuditLogOptions {
  root?: string;
  /** Aplica fsync em todo append. Default false. */
  fsync?: boolean;
}

export class AuditLog {
  readonly root: string;
  readonly fsync: boolean;

  constructor(options: AuditLogOptions = {}) {
    this.root = options.root ?? SESSIONS_ROOT;
    this.fsync = options.fsync ?? false;
  }

  /** Caminho do arquivo de trilha da sessão. */
  file(session_id: string): string {
    return path.join(sessionDir(session_id, this.root), ACTIONS_FILE);
  }

  /**
   * Anexa uma entrada. A sessão sai de `entry.session`; entrada sem sessão vai
   * para o bucket `_runtime` em vez de sumir.
   * Devolve a entrada REDIGIDA — é literalmente o que foi para o disco.
   */
  async append(entry: AuditEntry, session_id?: string): Promise<AuditEntry> {
    const target = session_id ?? entry.session ?? RUNTIME_BUCKET;
    const safe = redactObject(entry);
    await appendJsonl(this.file(target), safe, { fsync: this.fsync });
    return safe;
  }

  /** Lê a trilha da sessão. `errors` lista as linhas corrompidas encontradas. */
  async read(session_id: string): Promise<JsonlReadResult<AuditEntry>> {
    return readJsonl<AuditEntry>(this.file(session_id));
  }

  /** Espera as escritas pendentes desta sessão irem ao disco. */
  async flush(session_id: string): Promise<void> {
    await flushJsonl(this.file(session_id));
  }

  /** true se já existe trilha para a sessão. */
  async exists(session_id: string): Promise<boolean> {
    try {
      await stat(this.file(session_id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

/** Trilha padrão do processo, apontando para `<repo>/sessions`. */
export const auditLog = new AuditLog();
