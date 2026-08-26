/**
 * FASE 9 — MOTOR DE TASK PERSISTENTE
 *
 * O QUE ISTO CONSERTA (medido, não suposto)
 * -----------------------------------------
 * `handleTask` era um `for (const step of plan.steps)` linear. As consequências
 * não eram teóricas:
 *
 *   - `grep -rni checkpoint packages --include='*.ts'` devolvia ZERO. Uma task de
 *     doze passos que morria no décimo primeiro não deixava nada em disco: o
 *     único jeito de "retomar" era refazer os dez passos que JÁ tinham efeito no
 *     mundo (formulário reenviado, item recomprado, e-mail reenviado).
 *   - `BrowserTask.retries` era escrito `0` na criação e nunca incrementado. Um
 *     campo que só sabe dizer zero é pior que campo ausente: ele afirma que não
 *     houve retentativa, e essa afirmação nunca foi verificada.
 *   - `SIGKILL` no daemon deixava a task `RUNNING` na memória de um processo
 *     morto. Ao subir de novo, ninguém sabia que ela existiu. Nenhum estado
 *     mentiroso sobrevivia porque nenhum estado sobrevivia.
 *
 * AS QUATRO INVARIANTES QUE ESTE ARQUIVO EXISTE PARA SUSTENTAR
 * -----------------------------------------------------------
 *  1. ESTADO É DECLARADO, NÃO ADIVINHADO. Toda mudança passa por `#transitar`,
 *     que consulta `TASK_TRANSICOES`. Transição fora da tabela LEVANTA erro. A
 *     alternativa — atribuir `record.state = x` direto — é como o motor antigo
 *     conseguia ir de `RUNNING` para `FAILED` por três caminhos diferentes, dois
 *     deles sem escrever `last_error`.
 *
 *  2. O CHECKPOINT TEM DE BASTAR PARA NÃO REPETIR EFEITO. `checkpoint.step_index`
 *     é o índice do PRÓXIMO passo, gravado DEPOIS de o passo anterior ter sido
 *     confirmado. Retomar de um checkpoint nunca reexecuta um passo que já
 *     mudou o mundo. É por isso que ele é gravado passo a passo e não no fim:
 *     um checkpoint escrito no fim é um checkpoint que nunca existe quando
 *     importa.
 *
 *  3. RETRY É POLÍTICA, NÃO REFLEXO. Repetir uma ação NEGADA POR POLÍTICA é
 *     martelar a porta: não vai abrir, gera ruído na trilha e parece ataque para
 *     quem lê o log. `CAPABILITY_DENIED`, `POLICY_BLOCKED`, `UPLOAD_DENIED`,
 *     `INVALID_REQUEST` e `ABORTED` NUNCA são retentados. O default para código
 *     desconhecido é NÃO retentar (fail closed): "não sei se é transitório"
 *     nunca pode virar "então bate de novo".
 *
 *  4. ESTADO FINAL LIBERA RECURSO. Todo caminho de saída passa por `#encerrar`,
 *     que aborta o `AbortController`, tira a task do mapa de execução, escreve o
 *     registro final e emite `task.cleanup`. Sem funil único, cada `return`
 *     precisaria lembrar de limpar — e o `return` que esquece é o que vaza.
 *
 * DESACOPLAMENTO
 * --------------
 * Este arquivo é `core`: ele não conhece HTTP, não conhece `Page`, não conhece
 * `AgentProvider` e não escreve auditoria. Ele recebe um PLANEJADOR e um
 * EXECUTOR de passo por injeção, e emite fatos por callback. Quem liga isso ao
 * runtime é `packages/api/src/handlers.ts`. Um motor de task que soubesse falar
 * HTTP não poderia ser testado sem subir um servidor, e um motor que escrevesse
 * na trilha direto inverteria a camada (core → observability).
 */
// `node:crypto` explícito: o `crypto` GLOBAL do Node é a WebCrypto e não tem
// `createHash`. Importar o módulo dá as duas coisas de que este arquivo precisa
// (`randomUUID` e `createHash`) sem depender de qual delas o global expõe.
import crypto from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { newId, nowIso, type Plan, type PlanStep } from "./contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Estados e a TABELA de transições
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estados do motor. É um superconjunto de `TaskState` do contrato v1: `RETRYING`
 * e `RECOVERING` não existem lá porque o runtime antigo não tinha nem retentativa
 * nem recuperação. O tipo vive AQUI, e não em `contract.ts`, por uma razão de
 * concorrência de trabalho: mexer no contrato v1 obrigaria a subir a versão do
 * contrato e a tocar todos os consumidores. O que atravessa a fronteira HTTP
 * continua sendo JSON, e `state` continua sendo uma string.
 */
export type TaskEngineState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "RETRYING"
  | "PAUSED"
  | "CANCELLED"
  | "FAILED"
  | "COMPLETED"
  | "RECOVERING";

export const TASK_ESTADOS: readonly TaskEngineState[] = Object.freeze([
  "QUEUED", "RUNNING", "WAITING", "RETRYING", "PAUSED", "CANCELLED", "FAILED", "COMPLETED", "RECOVERING",
]);

/**
 * A tabela. Ler esta constante é ler a máquina de estados inteira — que é
 * exatamente o motivo de ela ser uma constante e não um emaranhado de `if`.
 *
 * Três decisões que merecem justificativa:
 *
 *   - `RUNNING → WAITING` e `WAITING → RUNNING` existem porque a ESPERA do
 *     backoff é um estado observável. Enquanto a task dorme 8 s entre tentativas
 *     ela não está rodando, e chamar isso de `RUNNING` mentiria para quem lê
 *     `GET /tasks`. `RETRYING` é a DECISÃO ("vou tentar de novo"); `WAITING` é a
 *     consequência ("estou no relógio"). Duas coisas, dois estados.
 *
 *   - `RUNNING → PAUSED` existe por causa do takeover humano (FASE 32). Quando o
 *     humano toma o volante, o passo devolve `CONTROL_HELD_BY_HUMAN`. Falhar a
 *     task ali seria punir o operador por operar; retentar seria martelar. Pausar
 *     e esperar `resume` é a única resposta honesta.
 *
 *   - Os três estados finais têm lista VAZIA. Não existe "reabrir" uma task
 *     COMPLETED: uma segunda execução é uma task nova, com `run_id` novo. É essa
 *     regra que faz a idempotência ter significado.
 */
export const TASK_TRANSICOES: Readonly<Record<TaskEngineState, readonly TaskEngineState[]>> = Object.freeze({
  QUEUED: Object.freeze<TaskEngineState[]>(["RUNNING", "PAUSED", "CANCELLED", "FAILED", "RECOVERING"]),
  RUNNING: Object.freeze<TaskEngineState[]>(["WAITING", "RETRYING", "PAUSED", "CANCELLED", "FAILED", "COMPLETED", "RECOVERING"]),
  WAITING: Object.freeze<TaskEngineState[]>(["RUNNING", "RETRYING", "PAUSED", "CANCELLED", "FAILED", "RECOVERING"]),
  RETRYING: Object.freeze<TaskEngineState[]>(["WAITING", "RUNNING", "PAUSED", "CANCELLED", "FAILED", "RECOVERING"]),
  PAUSED: Object.freeze<TaskEngineState[]>(["RUNNING", "CANCELLED", "FAILED", "RECOVERING"]),
  RECOVERING: Object.freeze<TaskEngineState[]>(["QUEUED", "RUNNING", "CANCELLED", "FAILED"]),
  COMPLETED: Object.freeze<TaskEngineState[]>([]),
  FAILED: Object.freeze<TaskEngineState[]>([]),
  CANCELLED: Object.freeze<TaskEngineState[]>([]),
});

export const TASK_ESTADOS_FINAIS: ReadonlySet<TaskEngineState> = new Set<TaskEngineState>([
  "COMPLETED", "FAILED", "CANCELLED",
]);

export function estadoFinal(s: TaskEngineState): boolean {
  return TASK_ESTADOS_FINAIS.has(s);
}

export function podeTransitar(de: TaskEngineState, para: TaskEngineState): boolean {
  const saidas = TASK_TRANSICOES[de];
  return saidas !== undefined && saidas.includes(para);
}

/**
 * Transição inválida é ERRO, não silêncio.
 *
 * O motor antigo não tinha como errar porque não tinha regra; assim que existe
 * regra, violá-la tem de doer. Se isto for lançado em produção, o defeito é do
 * chamador — e um `console.warn` esconderia justamente o bug que a tabela existe
 * para pegar.
 */
export class TaskStateError extends Error {
  readonly code = "INVALID_STATE_TRANSITION" as const;
  readonly de: TaskEngineState;
  readonly para: TaskEngineState;
  readonly task_id: string;
  constructor(task_id: string, de: TaskEngineState, para: TaskEngineState) {
    super(`task ${task_id}: transição inválida ${de} → ${para} (permitidas: ${TASK_TRANSICOES[de].join(", ") || "nenhuma, estado final"})`);
    this.name = "TaskStateError";
    this.task_id = task_id;
    this.de = de;
    this.para = para;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação de erro — o que pode ser retentado e o que NUNCA pode
// ─────────────────────────────────────────────────────────────────────────────

export type ClasseDeErro = "retentavel" | "fatal" | "desconhecido";

/**
 * NUNCA retentar. Cada entrada tem uma razão específica, não uma vibe:
 *
 *   CAPABILITY_DENIED / POLICY_BLOCKED / UPLOAD_DENIED / DOWNLOAD_DENIED
 *     A política não muda entre uma tentativa e a seguinte. Repetir é martelar a
 *     porta: três tentativas produzem três `policy.deny` na trilha e nenhuma
 *     chance a mais de sucesso. Pior: para quem audita, um agente que insiste em
 *     ação negada é indistinguível de um agente comprometido.
 *   INVALID_REQUEST
 *     O pedido está malformado. Ele estará igualmente malformado na 3ª vez.
 *   ABORTED / CANCELLED
 *     Alguém mandou parar. Retentar é desobedecer.
 *   CONTROL_HELD_BY_HUMAN
 *     Não é falha: é o humano operando. Vira PAUSED, não retry (ver a tabela).
 *   SESSION_NOT_FOUND
 *     A sessão não existe. Nenhuma quantidade de tentativas a faz existir.
 *   INVALID_STATE_TRANSITION
 *     Defeito interno do runtime. Retentar esconderia o bug.
 */
export const ERROS_FATAIS: ReadonlySet<string> = new Set([
  "CAPABILITY_DENIED",
  "POLICY_BLOCKED",
  "UPLOAD_DENIED",
  "DOWNLOAD_DENIED",
  "INVALID_REQUEST",
  "ABORTED",
  "CANCELLED",
  "CONTROL_HELD_BY_HUMAN",
  "SESSION_NOT_FOUND",
  "INVALID_STATE_TRANSITION",
]);

/**
 * PODE ser retentado — porque a causa é, por natureza, dependente do instante:
 *
 *   TIMEOUT / NETWORK / PROVIDER_DEGRADED   o relógio e a rede mudam.
 *   BROWSER_UNAVAILABLE / SESSION_NOT_ACTIVE  o navegador reinicia, a sessão volta.
 *   NAVIGATION_FAILED / BACKPRESSURE_REJECTED a página e a fila esvaziam.
 *   TARGET_NOT_FOUND / TARGET_NOT_ACTIONABLE / TARGET_AMBIGUOUS
 *     Este é o grupo que exige cuidado: o alvo pode ter mudado entre passos —
 *     spinner sumiu, modal abriu, lista reordenou. Retentar aqui é CORRETO
 *     porque o passo REEXECUTA A CASCATA DE RESOLUÇÃO inteira, do zero. O que
 *     seria errado é reusar a coordenada velha, e é justamente isso que o
 *     runtime não faz: cada tentativa parte do `TargetDescriptor`, não do
 *     `ResolvedTarget` da tentativa anterior.
 *   CLICK_NOT_DELIVERED
 *     O gesto saiu e nenhum evento chegou. Pode ter sido uma sobreposição
 *     transitória; a próxima tentativa reobserva e reconfere a acionabilidade.
 */
export const ERROS_RETENTAVEIS: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "NETWORK",
  "PROVIDER_DEGRADED",
  "BROWSER_UNAVAILABLE",
  "SESSION_NOT_ACTIVE",
  "NAVIGATION_FAILED",
  "BACKPRESSURE_REJECTED",
  "TARGET_NOT_FOUND",
  "TARGET_NOT_ACTIONABLE",
  "TARGET_AMBIGUOUS",
  "CLICK_NOT_DELIVERED",
]);

/**
 * Código desconhecido cai em `desconhecido`, e `desconhecido` NÃO é retentado.
 *
 * É a escolha fail closed. O contrário — "na dúvida, tenta de novo" — transforma
 * todo bug novo do runtime em três execuções do mesmo bug, e num efeito colateral
 * triplicado quando o passo já tinha mudado o mundo antes de estourar.
 */
export function classificarErro(code: string | null | undefined): ClasseDeErro {
  if (typeof code !== "string" || code === "") return "desconhecido";
  if (ERROS_FATAIS.has(code)) return "fatal";
  if (ERROS_RETENTAVEIS.has(code)) return "retentavel";
  return "desconhecido";
}

export function retentavel(code: string | null | undefined): boolean {
  return classificarErro(code) === "retentavel";
}

// ─────────────────────────────────────────────────────────────────────────────
// Política de retentativa
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Tentativas TOTAIS por passo, contando a primeira. 1 = sem retentativa. */
  max_attempts: number;
  base_ms: number;
  max_ms: number;
  /** Jitter desligado só em teste que mede o backoff exato. */
  jitter: boolean;
}

export const RETRY_PADRAO: RetryPolicy = Object.freeze({
  max_attempts: 3,
  base_ms: 500,
  max_ms: 30_000,
  jitter: true,
});

/**
 * Backoff exponencial com TETO e jitter "equal".
 *
 * Full jitter (`rnd() * teto`) pode devolver ~0 e derruba a própria razão de
 * existir do backoff — a tentativa 3 chegaria imediatamente após a 2. Equal
 * jitter garante metade do intervalo calculado como PISO e o intervalo cheio
 * como teto: dispersa sem anular. O teto existe porque 2^n sem limite chega a
 * horas de espera na 12ª tentativa, e uma task que espera horas em silêncio é
 * indistinguível de uma task travada.
 */
export function backoffMs(attempt: number, p: RetryPolicy, rnd: () => number = Math.random): number {
  const n = Math.max(1, Math.trunc(attempt));
  const cru = Math.min(p.max_ms, p.base_ms * 2 ** (n - 1));
  if (!p.jitter) return cru;
  const metade = cru / 2;
  return Math.round(metade + rnd() * metade);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registro persistido
// ─────────────────────────────────────────────────────────────────────────────

export interface PassoConcluido {
  index: number;
  step_id: string;
  action: string;
  /** `action_id` da ação REAL executada — o elo com a linha da trilha. */
  action_id: string | null;
  success: boolean;
  verified: boolean;
  /** Em que tentativa este passo finalmente passou. 1 = de primeira. */
  attempt: number;
  at: string;
}

/**
 * O checkpoint. `step_index` é o índice do PRÓXIMO passo a executar — não do
 * último executado. A diferença é a que decide se um resume repete efeito: com
 * "último executado" seria preciso lembrar de somar 1 em todo ponto de leitura,
 * e o ponto que esquecesse reexecutaria uma compra.
 */
export interface TaskCheckpoint {
  step_index: number;
  total_steps: number | null;
  completed: PassoConcluido[];
  /**
   * O plano vive DENTRO do checkpoint porque retomar exige saber o que ainda
   * falta. Replanejar no resume daria um plano diferente para os passos
   * restantes — e os índices já efetivados apontariam para outros passos.
   */
  plan: Plan | null;
  updated_at: string;
}

export interface TaskErrorRef {
  code: string;
  message: string;
  /** Classe apurada no momento da falha; explica por que houve (ou não) retry. */
  classe: ClasseDeErro;
  step_index: number | null;
  attempt: number;
  at: string;
}

export interface TaskRecord {
  task_id: string;
  /** Muda a CADA execução (create, resume, recover). O task_id não muda nunca. */
  run_id: string;
  session_id: string;
  state: TaskEngineState;
  step_index: number;
  attempt: number;
  checkpoint: TaskCheckpoint;
  created_at: string;
  updated_at: string;
  owner: string | null;
  provider: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  last_error: TaskErrorRef | null;
  idempotency_key: string;

  // ── Compatibilidade com `BrowserTask` (contrato v1) ───────────────────────
  // `browser.task` continua devolvendo um objeto que responde às mesmas
  // perguntas de antes. Quebrar essa forma quebraria SDK, CLI, MCP e três
  // testes que já existem — e a FASE 9 é sobre o que faltava, não sobre
  // renomear o que funcionava.
  goal: string;
  plan: Plan | null;
  actions: string[];
  /** Agora conta de verdade. Antes era escrito `0` e nunca incrementado. */
  retries: number;
  evidence: string[];
  result: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistência
// ─────────────────────────────────────────────────────────────────────────────

const ID_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Duplicado de propósito em relação a `observability/audit.ts`.
 *
 * `core` não pode importar `observability` — a dependência é de baixo para cima,
 * e inverter isso faria o motor de task arrastar o log de auditoria para dentro
 * de qualquer teste unitário. A regra é a MESMA (alfanumérico primeiro, sem
 * separador de caminho, até 128 chars) e a razão é a mesma: um `session_id` com
 * `..` escreveria fora da raiz.
 */
export function idSeguro(id: string, campo: string): string {
  if (typeof id !== "string" || !ID_SEGURO.test(id) || id === "." || id === "..") {
    throw new Error(`taskengine: ${campo} inválido ${JSON.stringify(id)} — permitido [A-Za-z0-9._-], até 128 chars, sem separador de caminho`);
  }
  return id;
}

export const TASKS_DIR = "tasks";
export const TASKS_INDEX = "index.jsonl";
/** Onde as reservas de `idempotency_key` moram. `_` no início é impossível para session_id. */
export const IDEMPOTENCIA_DIR = "_task_idempotency";

export interface ReservaIdempotencia {
  key_hash: string;
  task_id: string;
  session_id: string;
  created_at: string;
}

/**
 * Store em arquivo. Duas estruturas, dois propósitos:
 *
 *   `<root>/<session_id>/tasks/<task_id>.json`  ESTADO ATUAL, sobrescrito.
 *   `<root>/<session_id>/tasks/index.jsonl`     LINHA DO TEMPO, append-only.
 *
 * O JSON sozinho responde "como está a task?"; ele não responde "o que
 * aconteceu com ela?", porque cada gravação apaga a anterior. O JSONL sozinho
 * responde a segunda pergunta mas exige reproduzir o histórico inteiro para
 * responder a primeira. As duas juntas custam uma gravação a mais e respondem
 * as duas — e é a linha do tempo que mostra, depois de um crash, que a task
 * chegou ao passo 7 antes de morrer.
 */
export class TaskStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(session_id: string): string {
    return path.join(this.root, idSeguro(session_id, "session_id"), TASKS_DIR);
  }

  file(session_id: string, task_id: string): string {
    return path.join(this.dir(session_id), `${idSeguro(task_id, "task_id")}.json`);
  }

  /** tmp + fsync + rename — o mesmo padrão de `recovery.ts`, pela mesma razão. */
  async save(rec: TaskRecord): Promise<void> {
    const alvo = this.file(rec.session_id, rec.task_id);
    await mkdir(path.dirname(alvo), { recursive: true });
    const tmp = `${alvo}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const corpo = `${JSON.stringify(rec, null, 2)}\n`;
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(corpo, "utf8");
        // fsync ANTES do rename: sem isto o rename pode ganhar a corrida contra
        // os bytes e publicar um arquivo VAZIO. Num motor cujo propósito é
        // sobreviver a SIGKILL, um checkpoint vazio é pior que nenhum — ele
        // afirma "passo 0" para uma task que já estava no passo 7.
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, alvo);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async load(session_id: string, task_id: string): Promise<TaskRecord | null> {
    try {
      const cru = await readFile(this.file(session_id, task_id), "utf8");
      const v: unknown = JSON.parse(cru);
      return validarRegistro(v);
    } catch {
      // Arquivo ausente, JSON truncado por queda no meio da escrita (impossível
      // com rename, mas não custa) ou forma inválida: tratado como "não existe".
      return null;
    }
  }

  /** Append-only. Falha aqui NÃO derruba a task — perde-se linha do tempo, não estado. */
  async appendIndex(session_id: string, linha: Record<string, unknown>): Promise<void> {
    const alvo = path.join(this.dir(session_id), TASKS_INDEX);
    await mkdir(path.dirname(alvo), { recursive: true });
    const fh = await open(alvo, "a");
    try {
      await fh.writeFile(`${JSON.stringify(linha)}\n`, "utf8");
    } finally {
      await fh.close();
    }
  }

  async readIndex(session_id: string): Promise<Record<string, unknown>[]> {
    try {
      const cru = await readFile(path.join(this.dir(session_id), TASKS_INDEX), "utf8");
      const saida: Record<string, unknown>[] = [];
      for (const l of cru.split("\n")) {
        if (l.trim() === "") continue;
        try {
          saida.push(JSON.parse(l) as Record<string, unknown>);
        } catch {
          // Linha corrompida não invalida as demais: JSONL é resiliente por
          // desenho e engolir o arquivo inteiro por causa de uma linha seria
          // perder o histórico bom junto com o ruim.
        }
      }
      return saida;
    } catch {
      return [];
    }
  }

  /** Varre `<root>/*` procurando `tasks/*.json`. É a base do crash recovery. */
  async scan(): Promise<TaskRecord[]> {
    const achados: TaskRecord[] = [];
    let sessoes: string[];
    try {
      sessoes = await readdir(this.root);
    } catch {
      return achados;
    }
    for (const s of sessoes) {
      if (s.startsWith("_") || s.startsWith(".")) continue;
      let arquivos: string[];
      try {
        arquivos = await readdir(path.join(this.root, s, TASKS_DIR));
      } catch {
        continue; // sessão sem tasks
      }
      for (const f of arquivos) {
        // Sobras `*.json.tmp-*` de um rename interrompido não são estado.
        if (!f.endsWith(".json")) continue;
        try {
          const cru = await readFile(path.join(this.root, s, TASKS_DIR, f), "utf8");
          const rec = validarRegistro(JSON.parse(cru));
          if (rec !== null) achados.push(rec);
        } catch {
          // Arquivo ilegível é ignorado, não inventado.
        }
      }
    }
    return achados;
  }

  /**
   * Reserva ATÔMICA da chave de idempotência, entre processos.
   *
   * `link(2)` falha com EEXIST quando o destino existe, e falha sem escrever —
   * é a primitiva certa. `open(..., "wx")` também recusa, mas deixaria uma
   * janela entre criar o arquivo e escrever o conteúdo: um segundo processo que
   * lesse nessa janela veria um arquivo VAZIO e concluiria "não há dono". Com
   * link, o arquivo aparece já completo, porque foi escrito no tmp antes.
   *
   * Devolve o dono corrente: `owner:true` quando a reserva é NOSSA.
   */
  async reservar(key: string, task_id: string, session_id: string): Promise<{ owner: boolean; reserva: ReservaIdempotencia }> {
    const key_hash = hashChave(key);
    const dir = path.join(this.root, IDEMPOTENCIA_DIR);
    await mkdir(dir, { recursive: true });
    const alvo = path.join(dir, `${key_hash}.json`);
    const reserva: ReservaIdempotencia = { key_hash, task_id, session_id, created_at: nowIso() };
    const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(`${JSON.stringify(reserva)}\n`, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await link(tmp, alvo);
        return { owner: true, reserva };
      } catch {
        // Já reservada — por outra chamada nossa ou por outro processo.
        const cru = await readFile(alvo, "utf8");
        return { owner: false, reserva: JSON.parse(cru) as ReservaIdempotencia };
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async reservaDe(key: string): Promise<ReservaIdempotencia | null> {
    try {
      const cru = await readFile(path.join(this.root, IDEMPOTENCIA_DIR, `${hashChave(key)}.json`), "utf8");
      return JSON.parse(cru) as ReservaIdempotencia;
    } catch {
      return null;
    }
  }

  async existe(): Promise<boolean> {
    try {
      await stat(this.root);
      return true;
    } catch {
      return false;
    }
  }
}

/** SHA-256 hex. A chave crua pode conter `/`, espaço e acento; o hash, não. */
export function hashChave(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Chave derivada quando o chamador não fornece uma.
 *
 * Deriva de `session_id` + `goal` e NÃO do relógio: uma chave que incluísse o
 * timestamp seria única a cada chamada e a idempotência derivada nunca casaria —
 * ou seja, existiria no código e não no comportamento.
 */
export function chaveDerivada(session_id: string, goal: string): string {
  return `auto:${session_id}:${hashChave(goal)}`;
}

/** Validação estrutural. Campo faltando é registro inválido, não default calado. */
export function validarRegistro(v: unknown): TaskRecord | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const strings = ["task_id", "run_id", "session_id", "state", "created_at", "updated_at", "idempotency_key", "goal"];
  for (const k of strings) if (typeof r[k] !== "string" || r[k] === "") return null;
  if (!(TASK_ESTADOS as readonly string[]).includes(r.state as string)) return null;
  if (typeof r.step_index !== "number" || typeof r.attempt !== "number") return null;
  const cp = r.checkpoint;
  if (cp === null || typeof cp !== "object") return null;
  const c = cp as Record<string, unknown>;
  if (typeof c.step_index !== "number" || !Array.isArray(c.completed)) return null;
  return v as TaskRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fronteiras injetadas: planejador, executor, auditoria, limpeza
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resultado de UM passo, na forma que o motor entende.
 *
 * Deliberadamente NÃO é `ActionResponse`: o motor não deve saber o que é um
 * envelope HTTP. `code` é uma string livre porque ele classifica códigos que
 * vêm de três origens diferentes (contrato, provider, próprio motor).
 */
export interface StepOutcome {
  ok: boolean;
  action_id: string | null;
  code: string | null;
  message: string | null;
  verified: boolean;
  result?: unknown;
}

export interface StepContext {
  task: Readonly<TaskRecord>;
  step: PlanStep;
  index: number;
  attempt: number;
  /** Abortado por cancel, por prazo do passo ou por prazo total da task. */
  signal: AbortSignal;
}

export type StepExecutor = (ctx: StepContext) => Promise<StepOutcome>;
export type TaskPlanner = (ctx: { task: Readonly<TaskRecord>; signal: AbortSignal }) => Promise<Plan>;

export const TASK_AUDIT_ACTIONS = [
  "task.created", "task.started", "task.progress", "task.checkpoint", "task.retry",
  "task.waiting", "task.paused", "task.resume", "task.cancelled", "task.failed",
  "task.completed", "task.recovering", "task.cleanup",
] as const;
export type TaskAuditAction = (typeof TASK_AUDIT_ACTIONS)[number];

export interface TaskAuditEvent {
  action: TaskAuditAction;
  task: Readonly<TaskRecord>;
  step_index: number | null;
  attempt: number;
  result: "ok" | "error" | "denied";
  detail: Record<string, unknown>;
  error: { code: string; message: string } | null;
}

export interface TaskEngineOptions {
  /** Raiz das sessões. Os arquivos caem em `<root>/<session_id>/tasks/`. */
  root: string;
  policy?: Partial<RetryPolicy>;
  step_timeout_ms?: number;
  total_timeout_ms?: number;
  /**
   * Quanto tempo uma task RECOVERING pode esperar por um `resume` antes de ser
   * declarada FAILED. Ver `recuperar()` para a justificativa.
   */
  recover_grace_ms?: number;
  onAudit?: (ev: TaskAuditEvent) => void | Promise<void>;
  /**
   * Liberação de recurso do lado do runtime.
   *
   * Pode devolver um objeto: ele entra no `detail` de `task.cleanup`. Isso é o
   * que transforma a linha de limpeza de DECORAÇÃO em EVIDÊNCIA — "liberado:
   * true" sem números é uma afirmação que ninguém pode conferir; "abas abertas:
   * 2, lease: null, fila: 0/0" é verificável contra o estado real da sessão.
   */
  onCleanup?: (rec: Readonly<TaskRecord>) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
  /** A sessão desta task ainda pode ser reconstituída? Usado no crash recovery. */
  canResume?: (session_id: string) => boolean | Promise<boolean>;
  rnd?: () => number;
}

interface EmVoo {
  controller: AbortController;
  /** Motivo do abort, para distinguir cancelamento de prazo estourado. */
  motivo: "cancel" | "step_timeout" | "task_timeout" | null;
  promessa: Promise<TaskRecord> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// O motor
// ─────────────────────────────────────────────────────────────────────────────

export class TaskEngine {
  readonly store: TaskStore;
  readonly policy: RetryPolicy;
  readonly step_timeout_ms: number;
  readonly total_timeout_ms: number;
  readonly recover_grace_ms: number;

  readonly #registros = new Map<string, TaskRecord>();
  readonly #emVoo = new Map<string, EmVoo>();
  /** Dedup de `create` concorrente DENTRO deste processo (o disco cobre entre processos). */
  readonly #criando = new Map<string, Promise<{ record: TaskRecord; reused: boolean }>>();
  readonly #graca = new Map<string, NodeJS.Timeout>();
  readonly #onAudit: (ev: TaskAuditEvent) => void | Promise<void>;
  readonly #onCleanup: (rec: Readonly<TaskRecord>) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
  readonly #canResume: (session_id: string) => boolean | Promise<boolean>;
  readonly #rnd: () => number;

  constructor(opts: TaskEngineOptions) {
    this.store = new TaskStore(opts.root);
    this.policy = { ...RETRY_PADRAO, ...(opts.policy ?? {}) };
    this.step_timeout_ms = opts.step_timeout_ms ?? 60_000;
    this.total_timeout_ms = opts.total_timeout_ms ?? 600_000;
    this.recover_grace_ms = opts.recover_grace_ms ?? 30_000;
    this.#onAudit = opts.onAudit ?? (() => undefined);
    this.#onCleanup = opts.onCleanup ?? (() => undefined);
    this.#canResume = opts.canResume ?? (() => false);
    this.#rnd = opts.rnd ?? Math.random;
  }

  get(task_id: string): TaskRecord | null {
    return this.#registros.get(task_id) ?? null;
  }

  list(filtro: { session_id?: string | null; state?: string | null } = {}): TaskRecord[] {
    const saida: TaskRecord[] = [];
    for (const r of this.#registros.values()) {
      if (filtro.session_id != null && filtro.session_id !== "" && r.session_id !== filtro.session_id) continue;
      if (filtro.state != null && filtro.state !== "" && r.state !== filtro.state) continue;
      saida.push(r);
    }
    // Mais recente primeiro: é a ordem em que um operador olha uma lista de tasks.
    return saida.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  /**
   * Traz para a memória tudo o que existe em disco.
   *
   * `GET /tasks` sem isto listaria apenas as tasks criadas DESDE o último
   * arranque — e uma listagem que esconde a task que o operador está procurando
   * é pior que nenhuma listagem, porque parece completa.
   */
  async hidratar(): Promise<void> {
    for (const rec of await this.store.scan()) {
      // O que está em memória GANHA do disco: pode estar mais novo que o
      // arquivo (uma gravação em curso), nunca mais velho.
      if (!this.#registros.has(rec.task_id)) this.#registros.set(rec.task_id, rec);
    }
  }

  /** Carrega do disco quando não está em memória (processo reiniciado). */
  async fetch(task_id: string, session_id?: string | null): Promise<TaskRecord | null> {
    const memoria = this.#registros.get(task_id);
    if (memoria !== undefined) return memoria;
    if (session_id != null && session_id !== "") {
      const disco = await this.store.load(session_id, task_id);
      if (disco !== null) {
        this.#registros.set(disco.task_id, disco);
        return disco;
      }
      return null;
    }
    for (const rec of await this.store.scan()) {
      if (!this.#registros.has(rec.task_id)) this.#registros.set(rec.task_id, rec);
    }
    return this.#registros.get(task_id) ?? null;
  }

  // ── criação e idempotência ─────────────────────────────────────────────────

  /**
   * Cria — ou DEVOLVE a existente quando a chave de idempotência já foi usada.
   *
   * Ordem que importa: a RESERVA vem antes de qualquer gravação de registro. O
   * caminho inverso (gravar e depois reservar) produziria um arquivo de task
   * órfão toda vez que a reserva perdesse a corrida, e o `scan()` do crash
   * recovery encontraria tasks que nunca deveriam ter existido.
   */
  async create(args: {
    session_id: string;
    goal: string;
    owner?: string | null;
    provider?: string | null;
    idempotency_key?: string | null;
    inputs?: Record<string, unknown>;
  }): Promise<{ record: TaskRecord; reused: boolean }> {
    const session_id = idSeguro(args.session_id, "session_id");
    const key =
      typeof args.idempotency_key === "string" && args.idempotency_key.trim() !== ""
        ? args.idempotency_key.trim()
        : chaveDerivada(session_id, args.goal);

    // Duas chamadas SIMULTÂNEAS no mesmo processo nem chegam ao disco juntas: a
    // segunda espera a promessa da primeira. Sem isto, as duas criariam registro
    // e uma delas seria descartada — correto no fim, mas com um arquivo escrito
    // e removido no meio, e uma linha `task.created` a mais na trilha.
    const emCurso = this.#criando.get(key);
    if (emCurso !== undefined) {
      const r = await emCurso;
      return { record: r.record, reused: true };
    }
    const promessa = this.#criarDeFato(session_id, key, args);
    this.#criando.set(key, promessa);
    try {
      return await promessa;
    } finally {
      this.#criando.delete(key);
    }
  }

  async #criarDeFato(
    session_id: string,
    key: string,
    args: { goal: string; owner?: string | null; provider?: string | null; inputs?: Record<string, unknown> },
  ): Promise<{ record: TaskRecord; reused: boolean }> {
    const task_id = newId("tsk");
    const { owner, reserva } = await this.store.reservar(key, task_id, session_id);
    if (!owner) {
      // Chave já usada. A task existente é a resposta — inclusive quando ela já
      // terminou: é assim que "mesma chave depois de COMPLETED devolve o
      // resultado guardado" vale ENTRE REINÍCIOS, porque a reserva está no disco.
      const existente = await this.fetch(reserva.task_id, reserva.session_id);
      if (existente !== null) return { record: existente, reused: true };
      // Reserva sem registro = criação interrompida entre o link e o save.
      // Seguir usando o task_id reservado mantém a chave honrada.
    }
    const agora = nowIso();
    const rec: TaskRecord = {
      task_id: owner ? task_id : reserva.task_id,
      run_id: newId("run"),
      session_id,
      state: "QUEUED",
      step_index: 0,
      attempt: 0,
      checkpoint: { step_index: 0, total_steps: null, completed: [], plan: null, updated_at: agora },
      created_at: agora,
      updated_at: agora,
      owner: args.owner ?? null,
      provider: args.provider ?? null,
      inputs: { goal: args.goal, session_id, ...(args.inputs ?? {}) },
      outputs: null,
      last_error: null,
      idempotency_key: key,
      goal: args.goal,
      plan: null,
      actions: [],
      retries: 0,
      evidence: [],
      result: null,
    };
    this.#registros.set(rec.task_id, rec);
    await this.store.save(rec);
    await this.#anotar("task.created", rec, { idempotency_key: key, goal: args.goal, state: rec.state }, "ok", null, null);
    return { record: rec, reused: false };
  }

  // ── execução ───────────────────────────────────────────────────────────────

  /**
   * Executa (ou retoma) a task até um estado FINAL.
   *
   * Idempotente por desenho: chamar `run` numa task já em estado final devolve o
   * registro guardado SEM reexecutar nada. É esse ramo que atende "resume de
   * task que já completou devolve o resultado guardado".
   */
  async run(task_id: string, io: { plan: TaskPlanner; execute: StepExecutor }): Promise<TaskRecord> {
    const rec = await this.fetch(task_id);
    if (rec === null) throw new Error(`taskengine: task desconhecida ${task_id}`);
    if (estadoFinal(rec.state)) return rec;

    const jaRodando = this.#emVoo.get(task_id);
    if (jaRodando?.promessa != null) return jaRodando.promessa;

    const controller = new AbortController();
    const voo: EmVoo = { controller, motivo: null, promessa: null };
    this.#emVoo.set(task_id, voo);
    const p = this.#laco(rec, io, voo).finally(() => {
      if (this.#emVoo.get(task_id) === voo) this.#emVoo.delete(task_id);
    });
    voo.promessa = p;
    return p;
  }

  async #laco(rec: TaskRecord, io: { plan: TaskPlanner; execute: StepExecutor }, voo: EmVoo): Promise<TaskRecord> {
    const fimDaTask = Date.now() + this.total_timeout_ms;
    // `run_id` novo a cada execução: um resume é uma EXECUÇÃO nova da mesma
    // task. Sem isso, duas passagens pelo motor seriam indistinguíveis na trilha.
    rec.run_id = newId("run");
    await this.#transitar(rec, "RUNNING");
    await this.#anotar("task.started", rec, { state: rec.state, resumed: rec.checkpoint.completed.length > 0, run_id: rec.run_id }, "ok", null, null);

    try {
      // ── planejamento ────────────────────────────────────────────────────────
      //
      // Planejar NÃO entra na política de retentativa, e isso é deliberado. Um
      // provider degradado no planejamento já emite `provider.degraded` na
      // trilha; retentar produziria N linhas de degradação para a mesma falha e
      // gastaria N inferências de um modelo que acabou de dizer que está fora.
      // Falha de planejamento é falha da task.
      if (rec.checkpoint.plan === null) {
        const plano = await io.plan({ task: rec, signal: voo.controller.signal });
        rec.checkpoint.plan = plano;
        rec.plan = plano;
        rec.checkpoint.total_steps = plano.steps.length;
        await this.#checkpoint(rec, { fase: "plan", steps: plano.steps.length });
      }
      const plano = rec.checkpoint.plan;
      const passos = plano.steps;

      // ── passos ──────────────────────────────────────────────────────────────
      for (let i = rec.checkpoint.step_index; i < passos.length; i += 1) {
        const passo = passos[i]!;
        rec.step_index = i;

        for (let tentativa = 1; ; tentativa += 1) {
          rec.attempt = tentativa;
          if (voo.controller.signal.aborted) {
            return await this.#finalizarAbortado(rec, voo);
          }
          const restante = fimDaTask - Date.now();
          if (restante <= 0) {
            return await this.#finalizar(rec, "FAILED", {
              code: "TIMEOUT",
              message: `prazo total da task (${this.total_timeout_ms} ms) estourou antes do passo ${i}`,
              classe: "retentavel",
              step_index: i,
              attempt: tentativa,
              at: nowIso(),
            }, voo);
          }

          const saida = await this.#executarPasso(io.execute, rec, passo, i, tentativa, voo, Math.min(this.step_timeout_ms, restante));

          if (saida.ok) {
            const concluido: PassoConcluido = {
              index: i,
              step_id: passo.id,
              action: passo.action,
              action_id: saida.action_id,
              success: true,
              verified: saida.verified,
              attempt: tentativa,
              at: nowIso(),
            };
            rec.checkpoint.completed.push(concluido);
            // O checkpoint aponta para o PRÓXIMO. Gravado AQUI, logo depois de o
            // efeito ter acontecido — é este `+1` que impede o resume de clicar
            // duas vezes no mesmo botão.
            rec.checkpoint.step_index = i + 1;
            rec.attempt = 0;
            if (saida.action_id !== null) rec.actions.push(saida.action_id);
            rec.evidence.push(`${passo.id}:${passo.action}:${saida.verified ? "verified" : "unverified"}`);
            await this.#anotar("task.progress", rec, {
              step: passo.id, action: passo.action, attempt: tentativa,
              verified: saida.verified, state: rec.state, action_id: saida.action_id,
            }, "ok", null, i);
            await this.#checkpoint(rec, { fase: "step", step: passo.id, next_step_index: rec.checkpoint.step_index });
            break;
          }

          // ── o passo falhou ──────────────────────────────────────────────────
          const code = saida.code ?? "INTERNAL";
          const message = saida.message ?? "passo falhou sem mensagem";
          const classe = classificarErro(code);
          const erro: TaskErrorRef = { code, message, classe, step_index: i, attempt: tentativa, at: nowIso() };

          if (voo.controller.signal.aborted && voo.motivo === "cancel") {
            return await this.#finalizarAbortado(rec, voo);
          }
          // Controle humano não é falha: é o dono operando. Pausar preserva o
          // checkpoint e devolve a decisão a quem tem o volante.
          // AGENT_PAUSED entrou aqui pelo teste de produção real: o botão
          // Pausar do painel derrubava a task em FAILED ("classe desconhecido")
          // — um freio que destrói o trabalho que devia só segurar. Pausa do
          // operador e volante humano são o MESMO fenômeno para a task: ela
          // espera em PAUSED, com checkpoint, até o dono retomar.
          if (code === "CONTROL_HELD_BY_HUMAN" || code === "AGENT_PAUSED") {
            rec.last_error = erro;
            await this.#transitar(rec, "PAUSED");
            await this.#anotar("task.paused", rec, { code, step: passo.id, state: rec.state }, "denied", { code, message }, i);
            await this.#persistir(rec);
            return rec;
          }
          if (classe !== "retentavel") {
            // Fatal ou desconhecido: ZERO retentativas. `attempt` fica no valor
            // real da tentativa que falhou — 1 quando não houve nenhuma repetição.
            return await this.#finalizar(rec, "FAILED", erro, voo);
          }
          if (tentativa >= this.policy.max_attempts) {
            return await this.#finalizar(rec, "FAILED", { ...erro, message: `${message} (esgotadas ${tentativa} de ${this.policy.max_attempts} tentativas)` }, voo);
          }

          rec.last_error = erro;
          rec.retries += 1;
          await this.#transitar(rec, "RETRYING");
          await this.#anotar("task.retry", rec, {
            code, classe, step: passo.id, attempt: tentativa,
            next_attempt: tentativa + 1, max_attempts: this.policy.max_attempts, state: rec.state,
          }, "error", { code, message }, i);

          const espera = backoffMs(tentativa, this.policy, this.#rnd);
          await this.#transitar(rec, "WAITING");
          await this.#anotar("task.waiting", rec, { wait_ms: espera, attempt: tentativa, step: passo.id, state: rec.state }, "ok", null, i);
          await this.#persistir(rec);
          const dormiu = await this.#dormir(espera, voo.controller.signal);
          if (!dormiu) return await this.#finalizarAbortado(rec, voo);
          await this.#transitar(rec, "RUNNING");
        }
      }

      rec.outputs = {
        steps: passos.length,
        completed: rec.checkpoint.completed.length,
        evidence: [...rec.evidence],
        actions: [...rec.actions],
        retries: rec.retries,
      };
      rec.result = rec.outputs;
      return await this.#finalizar(rec, "COMPLETED", null, voo);
    } catch (e) {
      // Qualquer exceção não prevista (planejador que estourou, executor que
      // lançou) termina a task explicitamente. Deixá-la RUNNING é exatamente a
      // mentira que esta fase existe para eliminar.
      if (voo.controller.signal.aborted && voo.motivo === "cancel") {
        return await this.#finalizarAbortado(rec, voo);
      }
      const code = codigoDe(e);
      return await this.#finalizar(rec, "FAILED", {
        code,
        message: (e as Error)?.message ?? String(e),
        classe: classificarErro(code),
        step_index: rec.step_index,
        attempt: rec.attempt,
        at: nowIso(),
      }, voo);
    }
  }

  /**
   * Roda UM passo com prazo e cancelamento.
   *
   * O `Promise.race` é honesto sobre o seu limite: o executor recebe o
   * `AbortSignal` e deve encerrar, mas se ele ignorar o sinal a chamada continua
   * viva em segundo plano. O motor não pode matar uma promessa alheia — a mesma
   * limitação que `SessionQueue` já declara em `detail.still_running`. O que o
   * motor garante é que a TASK não fica presa, e que o estado registrado
   * corresponde ao que ele sabe.
   */
  async #executarPasso(
    execute: StepExecutor,
    rec: TaskRecord,
    step: PlanStep,
    index: number,
    attempt: number,
    voo: EmVoo,
    prazo: number,
  ): Promise<StepOutcome> {
    const passoCtl = new AbortController();
    const cancelar = (): void => passoCtl.abort(voo.controller.signal.reason);
    if (voo.controller.signal.aborted) cancelar();
    else voo.controller.signal.addEventListener("abort", cancelar, { once: true });
    const relogio = setTimeout(() => {
      if (voo.motivo === null) voo.motivo = "step_timeout";
      passoCtl.abort(new Error(`prazo do passo (${prazo} ms) estourou`));
    }, prazo);
    // `unref` para que um passo pendurado não segure o processo aberto.
    if (typeof relogio.unref === "function") relogio.unref();

    try {
      const corrida = new Promise<StepOutcome>((_resolve, reject) => {
        passoCtl.signal.addEventListener("abort", () => {
          const porCancelamento = voo.motivo === "cancel";
          reject(new PassoAbortado(porCancelamento ? "ABORTED" : "TIMEOUT", porCancelamento
            ? "passo abortado por cancelamento da task"
            : `passo ${step.id} não terminou em ${prazo} ms`));
        }, { once: true });
      });
      return await Promise.race([
        execute({ task: rec, step, index, attempt, signal: passoCtl.signal }),
        corrida,
      ]);
    } catch (e) {
      // Exceção do executor vira `StepOutcome` falho: o laço tem UM caminho de
      // decisão, e não dois (um para retorno, outro para throw).
      return { ok: false, action_id: null, code: codigoDe(e), message: (e as Error)?.message ?? String(e), verified: false };
    } finally {
      clearTimeout(relogio);
      voo.controller.signal.removeEventListener("abort", cancelar);
    }
  }

  /** Espera cancelável. Devolve false quando foi interrompida. */
  #dormir(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!signal.aborted);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        signal.removeEventListener("abort", parar);
        resolve(true);
      }, ms);
      const parar = (): void => {
        clearTimeout(t);
        resolve(false);
      };
      if (signal.aborted) {
        clearTimeout(t);
        resolve(false);
        return;
      }
      signal.addEventListener("abort", parar, { once: true });
    });
  }

  // ── cancelamento, pausa, retomada ──────────────────────────────────────────

  /**
   * Cancela. O passo EM VOO é abortado (`AbortSignal`), nada depois dele roda e
   * a limpeza acontece.
   *
   * Cancelar uma task já finalizada não é erro: é no-op idempotente. Um cliente
   * que cancela por prudência, depois de a task ter completado sozinha, não
   * merece um 500.
   */
  async cancel(task_id: string, reason = "requested"): Promise<TaskRecord> {
    const rec = await this.fetch(task_id);
    if (rec === null) throw new Error(`taskengine: task desconhecida ${task_id}`);
    if (estadoFinal(rec.state)) return rec;

    const voo = this.#emVoo.get(task_id);
    if (voo !== undefined) {
      voo.motivo = "cancel";
      voo.controller.abort(new Error(`task cancelada: ${reason}`));
      // Esperar o laço terminar é o que torna o cancelamento OBSERVÁVEL: quem
      // chamou `cancel` recebe o registro já em CANCELLED, e não um "pedi para
      // parar, veja depois se parou".
      if (voo.promessa !== null) {
        try {
          return await voo.promessa;
        } catch {
          /* o laço já registrou o estado final; o erro não acrescenta nada */
        }
      }
    }
    const atual = this.#registros.get(task_id) ?? rec;
    if (estadoFinal(atual.state)) return atual;
    atual.last_error = { code: "CANCELLED", message: `task cancelada: ${reason}`, classe: "fatal", step_index: atual.step_index, attempt: atual.attempt, at: nowIso() };
    return this.#finalizar(atual, "CANCELLED", atual.last_error, null, { reason });
  }

  /**
   * Falha uma task que nunca chegou a rodar — pré-condição ausente (sem
   * AgentProvider, sem sessão), não erro de passo.
   *
   * Existe para que esse caminho passe pelo MESMO funil de `#finalizar`: estado
   * gravado, `last_error` preenchido, `task.failed` e `task.cleanup` emitidos.
   * Um `throw` direto no handler deixaria a task QUEUED em disco para sempre —
   * e o crash recovery a encontraria como trabalho pendente que ninguém pediu.
   */
  async falhar(task_id: string, code: string, message: string): Promise<TaskRecord> {
    const rec = await this.fetch(task_id);
    if (rec === null) throw new Error(`taskengine: task desconhecida ${task_id}`);
    if (estadoFinal(rec.state)) return rec;
    return this.#finalizar(rec, "FAILED", {
      code, message, classe: classificarErro(code), step_index: rec.step_index, attempt: rec.attempt, at: nowIso(),
    }, this.#emVoo.get(task_id) ?? null);
  }

  /** Pausa explícita. Preserva o checkpoint; só `resume` volta a rodar. */
  async pause(task_id: string, reason = "requested"): Promise<TaskRecord> {
    const rec = await this.fetch(task_id);
    if (rec === null) throw new Error(`taskengine: task desconhecida ${task_id}`);
    if (estadoFinal(rec.state) || rec.state === "PAUSED") return rec;
    await this.#transitar(rec, "PAUSED");
    await this.#anotar("task.paused", rec, { reason, state: rec.state }, "ok", null, rec.step_index);
    await this.#persistir(rec);
    return rec;
  }

  /**
   * Retoma do checkpoint.
   *
   * Três casos, três respostas diferentes — e nenhuma delas reexecuta trabalho:
   *   final      devolve o resultado guardado, sem tocar no navegador;
   *   RECOVERING cancela a janela de graça e recomeça do `checkpoint.step_index`;
   *   PAUSED     idem.
   */
  async resume(
    task_id: string,
    io: { plan: TaskPlanner; execute: StepExecutor },
    opts: { session_id?: string | null } = {},
  ): Promise<TaskRecord> {
    const rec = await this.fetch(task_id, opts.session_id ?? null);
    if (rec === null) throw new Error(`taskengine: task desconhecida ${task_id}`);

    if (estadoFinal(rec.state)) {
      // NÃO reexecuta. Esta é a garantia inteira do item "resume de task que já
      // completou": o resultado vem do registro, não de uma segunda passagem.
      await this.#anotar("task.resume", rec, { state: rec.state, replayed: false, reason: "estado final: resultado guardado devolvido" }, "ok", null, rec.step_index);
      return rec;
    }
    const g = this.#graca.get(task_id);
    if (g !== undefined) {
      clearTimeout(g);
      this.#graca.delete(task_id);
    }
    // Rebind de sessão: depois de um crash a sessão antiga pode não existir mais.
    // Retomar numa sessão nova é honesto — o checkpoint diz o que já foi feito,
    // e mentir sobre em que sessão a task continua seria pior que registrar a troca.
    const novaSessao = opts.session_id ?? null;
    if (novaSessao !== null && novaSessao !== "" && novaSessao !== rec.session_id) {
      const antiga = rec.session_id;
      rec.session_id = idSeguro(novaSessao, "session_id");
      rec.inputs = { ...rec.inputs, session_id: rec.session_id, rebound_from: antiga };
      /**
       * A sessão ANTIGA também precisa saber. A partir daqui todas as linhas
       * desta task vão para a linha do tempo da sessão NOVA — e sem esta marca a
       * task simplesmente sumiria do histórico da antiga, parada em RECOVERING
       * para sempre, como se ninguém a tivesse retomado. Quem investigar o
       * crash começa pela sessão que caiu; é ali que o ponteiro tem de estar.
       */
      await this.store.appendIndex(antiga, {
        at: nowIso(),
        action: "task.resume",
        task_id: rec.task_id,
        run_id: rec.run_id,
        session_id: antiga,
        state: rec.state,
        step_index: rec.checkpoint.step_index,
        attempt: rec.attempt,
        result: "ok",
        error: null,
        detail: { rebound_to: rec.session_id, reason: "sessão original não pôde ser reconstituída após o crash" },
      }).catch(() => undefined);
    }
    await this.#anotar("task.resume", rec, {
      state: rec.state,
      from_step_index: rec.checkpoint.step_index,
      completed: rec.checkpoint.completed.length,
      replayed: false,
    }, "ok", null, rec.checkpoint.step_index);
    if (rec.state === "RECOVERING") await this.#transitar(rec, "QUEUED");
    rec.step_index = rec.checkpoint.step_index;
    await this.#persistir(rec);
    return this.run(task_id, io);
  }

  // ── crash recovery ─────────────────────────────────────────────────────────

  /**
   * Varre o disco no arranque e reconcilia.
   *
   * TODA task em `RUNNING`/`RETRYING`/`WAITING` num arquivo é, por definição,
   * mentira: o processo que a rodava morreu. Ela vira `RECOVERING` no disco
   * ANTES de qualquer tentativa de reconstituição — se o novo processo também
   * morrer, o próximo arranque encontra `RECOVERING` e não `RUNNING`.
   *
   * A janela de graça existe por uma tensão real: "se a sessão puder ser
   * reconstituída, retoma; senão, FAILED". Só que "poder ser reconstituída" nem
   * sempre se sabe no milissegundo do arranque — o Chromium ainda está subindo,
   * o cliente ainda vai reatar. Marcar FAILED na hora mataria tasks recuperáveis;
   * deixar RECOVERING para sempre recriaria o estado mentiroso com outro nome. A
   * graça resolve as duas: há um prazo, ele é finito, e quem não for retomado
   * dentro dele termina FAILED com `last_error` dizendo exatamente isso.
   */
  async recuperar(): Promise<TaskRecord[]> {
    const emDisco = await this.store.scan();
    const recuperadas: TaskRecord[] = [];
    for (const rec of emDisco) {
      if (!this.#registros.has(rec.task_id)) this.#registros.set(rec.task_id, rec);
      const vivo = this.#registros.get(rec.task_id)!;
      if (vivo.state !== "RUNNING" && vivo.state !== "RETRYING" && vivo.state !== "WAITING") continue;

      const anterior = vivo.state;
      await this.#transitar(vivo, "RECOVERING");
      vivo.last_error = {
        code: "RUNTIME_CRASH",
        message: `o runtime caiu com a task em ${anterior}; retomável a partir do passo ${vivo.checkpoint.step_index}`,
        classe: "retentavel",
        step_index: vivo.checkpoint.step_index,
        attempt: vivo.attempt,
        at: nowIso(),
      };
      await this.#persistir(vivo);
      await this.#anotar("task.recovering", vivo, {
        previous_state: anterior,
        from_step_index: vivo.checkpoint.step_index,
        completed: vivo.checkpoint.completed.length,
        state: vivo.state,
      }, "error", { code: "RUNTIME_CRASH", message: vivo.last_error.message }, vivo.checkpoint.step_index);
      recuperadas.push(vivo);

      const reconstituivel = await this.#canResume(vivo.session_id);
      if (!reconstituivel) this.#armarGraca(vivo);
    }
    return recuperadas;
  }

  #armarGraca(rec: TaskRecord): void {
    const t = setTimeout(() => {
      this.#graca.delete(rec.task_id);
      const atual = this.#registros.get(rec.task_id);
      if (atual === undefined || atual.state !== "RECOVERING") return;
      void this.#finalizar(atual, "FAILED", {
        code: "SESSION_NOT_RECONSTITUTED",
        message: `sessão ${atual.session_id} não pôde ser reconstituída e ninguém retomou a task em ${this.recover_grace_ms} ms`,
        classe: "fatal",
        step_index: atual.checkpoint.step_index,
        attempt: atual.attempt,
        at: nowIso(),
      }, null);
    }, this.recover_grace_ms);
    if (typeof t.unref === "function") t.unref();
    this.#graca.set(rec.task_id, t);
  }

  /** Solta timers e controladores. Chamado no `close()` do daemon. */
  async encerrarTudo(): Promise<void> {
    for (const t of this.#graca.values()) clearTimeout(t);
    this.#graca.clear();
    for (const voo of this.#emVoo.values()) {
      voo.motivo = "cancel";
      voo.controller.abort(new Error("daemon encerrando"));
    }
    this.#emVoo.clear();
  }

  // ── internos ───────────────────────────────────────────────────────────────

  /** ÚNICO ponto onde `state` muda. Fora da tabela, levanta. */
  async #transitar(rec: TaskRecord, para: TaskEngineState): Promise<void> {
    if (rec.state === para) return;
    if (!podeTransitar(rec.state, para)) throw new TaskStateError(rec.task_id, rec.state, para);
    rec.state = para;
    rec.updated_at = nowIso();
  }

  async #persistir(rec: TaskRecord): Promise<void> {
    rec.updated_at = nowIso();
    await this.store.save(rec);
  }

  async #checkpoint(rec: TaskRecord, detalhe: Record<string, unknown>): Promise<void> {
    rec.checkpoint.updated_at = nowIso();
    await this.#persistir(rec);
    await this.#anotar("task.checkpoint", rec, {
      ...detalhe,
      step_index: rec.checkpoint.step_index,
      total_steps: rec.checkpoint.total_steps,
      completed: rec.checkpoint.completed.length,
      state: rec.state,
    }, "ok", null, rec.checkpoint.step_index);
  }

  async #finalizarAbortado(rec: TaskRecord, voo: EmVoo): Promise<TaskRecord> {
    const porCancelamento = voo.motivo === "cancel";
    const erro: TaskErrorRef = porCancelamento
      ? { code: "CANCELLED", message: "task cancelada; o passo em voo foi abortado", classe: "fatal", step_index: rec.step_index, attempt: rec.attempt, at: nowIso() }
      : { code: "TIMEOUT", message: `prazo estourado (${voo.motivo ?? "desconhecido"})`, classe: "retentavel", step_index: rec.step_index, attempt: rec.attempt, at: nowIso() };
    return this.#finalizar(rec, porCancelamento ? "CANCELLED" : "FAILED", erro, voo);
  }

  /**
   * O funil único de saída. Todo caminho que termina uma task passa por aqui —
   * é o que garante que `task.cleanup` não dependa de alguém lembrar de chamá-lo.
   */
  async #finalizar(
    rec: TaskRecord,
    estado: "COMPLETED" | "FAILED" | "CANCELLED",
    erro: TaskErrorRef | null,
    voo: EmVoo | null,
    extra: Record<string, unknown> = {},
  ): Promise<TaskRecord> {
    if (estadoFinal(rec.state)) return rec;
    if (erro !== null) {
      rec.last_error = erro;
      rec.result = { code: erro.code, message: erro.message };
    }
    await this.#transitar(rec, estado);
    await this.#persistir(rec);

    const acao: TaskAuditAction = estado === "COMPLETED" ? "task.completed" : estado === "CANCELLED" ? "task.cancelled" : "task.failed";
    await this.#anotar(acao, rec, {
      ...extra,
      state: rec.state,
      steps: rec.checkpoint.total_steps,
      completed: rec.checkpoint.completed.length,
      retries: rec.retries,
      ...(erro !== null ? { code: erro.code, classe: erro.classe } : {}),
    }, estado === "COMPLETED" ? "ok" : estado === "CANCELLED" ? "denied" : "error",
      erro !== null ? { code: erro.code, message: erro.message } : null,
      rec.step_index);

    await this.#limpar(rec, voo);
    return rec;
  }

  /**
   * Liberação de recurso. Aborta o controlador (nenhum passo pendurado segue
   * achando que a task vive), tira a task do mapa de execução e avisa o runtime
   * para soltar o que for dele — página, lease, engines.
   *
   * `onCleanup` que falha NÃO reverte o estado final: a task terminou de fato, e
   * um erro de limpeza é um fato à parte, registrado como tal.
   */
  async #limpar(rec: TaskRecord, voo: EmVoo | null): Promise<void> {
    const g = this.#graca.get(rec.task_id);
    if (g !== undefined) {
      clearTimeout(g);
      this.#graca.delete(rec.task_id);
    }
    if (voo !== null && !voo.controller.signal.aborted) {
      voo.controller.abort(new Error("task finalizada"));
    }
    this.#emVoo.delete(rec.task_id);
    let falha: string | null = null;
    let evidencia: Record<string, unknown> = {};
    try {
      const r = await this.#onCleanup(rec);
      if (r !== null && r !== undefined && typeof r === "object") evidencia = r;
    } catch (e) {
      falha = (e as Error)?.message ?? String(e);
    }
    await this.#anotar("task.cleanup", rec, {
      ...evidencia,
      state: rec.state,
      released: falha === null,
      aborted: true,
      ...(falha !== null ? { cleanup_error: falha } : {}),
    }, falha === null ? "ok" : "error", falha === null ? null : { code: "CLEANUP_FAILED", message: falha }, rec.step_index);
  }

  /**
   * Emite o fato: uma linha no JSONL da sessão E o callback de auditoria.
   *
   * As duas coisas, não uma: o JSONL é a linha do tempo do MOTOR (sobrevive sem
   * o daemon, é lido pelo crash recovery e pela prova E2E); o callback é o que
   * leva o fato para a trilha forense da FASE 3, com `owner`, `provider`,
   * `browser` e `page` preenchidos por quem tem esse contexto. Nenhuma das duas
   * substitui a outra.
   *
   * Falha aqui nunca derruba a task: perder observabilidade é ruim, perder o
   * trabalho por causa dela seria pior.
   */
  async #anotar(
    action: TaskAuditAction,
    rec: TaskRecord,
    detail: Record<string, unknown>,
    result: "ok" | "error" | "denied",
    error: { code: string; message: string } | null,
    step_index: number | null,
  ): Promise<void> {
    const ev: TaskAuditEvent = { action, task: rec, step_index, attempt: rec.attempt, result, detail, error };
    try {
      await this.store.appendIndex(rec.session_id, {
        at: nowIso(),
        action,
        task_id: rec.task_id,
        run_id: rec.run_id,
        session_id: rec.session_id,
        state: rec.state,
        step_index,
        attempt: rec.attempt,
        result,
        error,
        detail,
      });
    } catch (e) {
      console.error("[taskengine] index.jsonl falhou:", (e as Error)?.message ?? String(e));
    }
    try {
      await this.#onAudit(ev);
    } catch (e) {
      console.error("[taskengine] onAudit falhou:", (e as Error)?.message ?? String(e));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Erro interno do motor para abort de passo. Carrega o código já classificado. */
export class PassoAbortado extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PassoAbortado";
    this.code = code;
  }
}

/**
 * Extrai um código classificável de qualquer coisa lançada.
 *
 * `AbortError` do próprio Node vira `ABORTED` (fatal, nunca retentado) e
 * `TimeoutError` vira `TIMEOUT` (retentável) — sem esta tradução os dois cairiam
 * em `desconhecido` e um cancelamento explícito seria tratado como falha opaca.
 */
export function codigoDe(e: unknown): string {
  if (e === null || e === undefined) return "INTERNAL";
  const o = e as { code?: unknown; name?: unknown };
  if (typeof o.code === "string" && o.code !== "") return o.code;
  if (o.name === "AbortError") return "ABORTED";
  if (o.name === "TimeoutError") return "TIMEOUT";
  return "INTERNAL";
}
