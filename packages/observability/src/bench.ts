/**
 * BENCH — arnês de benchmark de performance e de qualidade (FASE 32/33)
 *
 * Este módulo é o INSTRUMENTO, não o resultado. Quem executa o benchmark de
 * verdade — contra Chromium, contra LLM, contra a API — é o integrador. Aqui
 * mora só a régua, e a régua tem uma obrigação: não mentir.
 *
 * Três formas de mentir que este arquivo recusa explicitamente:
 *
 *  1. PERCENTIL QUE A AMOSTRA NÃO SUSTENTA. Um p99 calculado sobre 10 medições
 *     é o próprio máximo da amostra com nome de estatística. Para OBSERVAR o
 *     comportamento acima do quantil q é preciso, no mínimo, `1/(1-q)` amostras
 *     — 100 para p99, 20 para p95, 2 para p50. Abaixo disso o campo sai `null`
 *     e o percentil entra na lista `insufficient`. Nunca sai um número.
 *     O piso é teórico e NÃO pode ser baixado por configuração (ver
 *     `minSamplesFor`): opção só levanta o piso, jamais o afunda.
 *
 *  2. INTERPOLAR ENTRE MEDIÇÕES. O percentil aqui é *nearest-rank*: devolve um
 *     valor que foi realmente medido. Interpolação linear produz um número que
 *     nenhuma iteração observou — plausível, e falso.
 *
 *  3. CRONOMETRAR O CAMINHO DE ERRO. Iteração que lança não vira amostra: uma
 *     exceção rápida rebaixaria a média e o benchmark ficaria "mais veloz"
 *     quanto mais quebrado estivesse. Erros são contados e reportados à parte,
 *     e `n < iterations_requested` fica visível no relatório.
 *
 * Para a FASE 33, `QualityBench` separa o que o agente DECLARA do que o
 * verificador OBSERVA. A métrica principal é `verified_success`; a métrica de
 * honestidade é `false_success` (declarou sucesso e a verificação refutou), e
 * ela é estrutural no resumo — a linha existe mesmo valendo zero, porque
 * omitir a métrica de honestidade quando ela é zero é o começo de omiti-la
 * quando ela não é.
 *
 * Este módulo não escreve em stdout/stderr e não abre arquivo. Ele devolve
 * strings; quem publica decide onde. Todo detalhe fornecido pelo chamador passa
 * por `redactObject` antes de entrar em relatório.
 */
import { CONTRACT_VERSION, nowIso } from "../../core/src/contract.ts";
import type { VerificationResult } from "../../core/src/contract.ts";
import { redactObject } from "./redact.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Estatística
// ─────────────────────────────────────────────────────────────────────────────

export type PercentileName = "p50" | "p95" | "p99";

export const PERCENTILES: readonly { name: PercentileName; q: number }[] = Object.freeze([
  Object.freeze({ name: "p50" as const, q: 0.5 }),
  Object.freeze({ name: "p95" as const, q: 0.95 }),
  Object.freeze({ name: "p99" as const, q: 0.99 }),
]);

/**
 * Amostra mínima para que o quantil `q` seja observável: `ceil(1/(1-q))`.
 * p50→2, p95→20, p99→100. É a regra única; não há exceção por percentil.
 */
export function minSamplesFor(q: number): number {
  if (!(Number.isFinite(q) && q > 0 && q < 1)) {
    throw new Error(`bench: quantil inválido ${String(q)} — esperado 0 < q < 1`);
  }
  return Math.ceil(1 / (1 - q));
}

export type MinSampleTable = Readonly<Record<PercentileName, number>>;

export const DEFAULT_MIN_SAMPLES: MinSampleTable = Object.freeze({
  p50: minSamplesFor(0.5),
  p95: minSamplesFor(0.95),
  p99: minSamplesFor(0.99),
});

/**
 * Resolve a tabela de mínimos. Um override só é aceito quando é MAIOR que o
 * piso teórico — exigir mais evidência é legítimo, aceitar menos é fabricar
 * significância, e não existe flag para isso.
 */
export function resolveMinSamples(override?: Partial<Record<PercentileName, number>>): MinSampleTable {
  const out: Record<PercentileName, number> = { ...DEFAULT_MIN_SAMPLES };
  for (const { name } of PERCENTILES) {
    const wanted = override?.[name];
    if (wanted === undefined) continue;
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new Error(`bench: min_samples.${name} inválido ${String(wanted)} — inteiro >= 1`);
    }
    out[name] = Math.max(DEFAULT_MIN_SAMPLES[name], wanted);
  }
  return Object.freeze(out);
}

/**
 * Percentil por nearest-rank sobre um array JÁ ordenado ascendentemente.
 * Devolve um valor efetivamente medido, nunca uma interpolação.
 *
 * O `- |raw|*1e-12` corrige erro de ponto flutuante em `q*n` (ex.: um produto
 * que deveria dar 99 e dá 99.00000000000001 empurraria o rank uma posição para
 * cima, trocando o percentil pelo máximo). É correção de ruído binário, não
 * arredondamento de resultado.
 */
export function percentile(sortedAsc: readonly number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (!(Number.isFinite(q) && q > 0 && q < 1)) {
    throw new Error(`bench: quantil inválido ${String(q)} — esperado 0 < q < 1`);
  }
  const raw = q * n;
  const rank = Math.ceil(raw - Math.abs(raw) * 1e-12);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

export interface InsufficientPercentile {
  percentile: PercentileName;
  n: number;
  n_required: number;
  reason: "insuficiente";
}

export interface BenchStats {
  /** Amostras VÁLIDAS. Iteração que lançou não está aqui. */
  n: number;
  min_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  /** Desvio padrão AMOSTRAL (denominador n-1). `null` para n < 2. */
  stddev_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  /** Percentis que a amostra não sustenta. Vazio = todos reportados. */
  insufficient: InsufficientPercentile[];
  min_samples: MinSampleTable;
}

/**
 * Estatística de uma lista de latências. Lista vazia devolve tudo `null` com
 * os três percentis marcados insuficientes — resposta explícita, não exceção
 * e não zero. Zero seria "mediram-se 0 ms", que é falso.
 */
export function computeStats(
  samples: readonly number[],
  minSamples: MinSampleTable = DEFAULT_MIN_SAMPLES,
): BenchStats {
  for (const s of samples) {
    if (!Number.isFinite(s)) {
      throw new Error(`bench: amostra não finita ${String(s)} — instrumento quebrado, não estatística`);
    }
  }
  const n = samples.length;
  const insufficient: InsufficientPercentile[] = [];
  const value: Record<PercentileName, number | null> = { p50: null, p95: null, p99: null };

  const sorted = [...samples].sort((a, b) => a - b);
  for (const { name, q } of PERCENTILES) {
    const required = minSamples[name];
    if (n < required) {
      insufficient.push({ percentile: name, n, n_required: required, reason: "insuficiente" });
      continue;
    }
    value[name] = percentile(sorted, q);
  }

  if (n === 0) {
    return {
      n: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      stddev_ms: null,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      insufficient,
      min_samples: minSamples,
    };
  }

  let sum = 0;
  for (const s of sorted) sum += s;
  const mean = sum / n;

  let stddev: number | null = null;
  if (n >= 2) {
    // Duas passagens: soma dos quadrados dos desvios em torno da média já
    // conhecida. A forma de uma passagem (E[x²]-E[x]²) cancela dígitos quando
    // a variância é pequena perto da média e chega a devolver negativo.
    let acc = 0;
    for (const s of sorted) {
      const d = s - mean;
      acc += d * d;
    }
    stddev = Math.sqrt(acc / (n - 1));
  }

  return {
    n,
    min_ms: sorted[0]!,
    max_ms: sorted[n - 1]!,
    mean_ms: mean,
    stddev_ms: stddev,
    p50_ms: value.p50,
    p95_ms: value.p95,
    p99_ms: value.p99,
    insufficient,
    min_samples: minSamples,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursos: memória e CPU
// ─────────────────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryReport {
  before: MemorySnapshot;
  after: MemorySnapshot;
  /** `after - before`, campo a campo. Pode ser NEGATIVO — ver `note`. */
  delta: MemorySnapshot;
  /** true só quando `--expose-gc` está ligado E `force_gc` foi pedido. */
  gc_forced: boolean;
  gc_available: boolean;
  note: string;
}

const MEMORY_NOTE =
  "delta de RSS/heap é contaminado por GC, pelo próprio arnês e pelo alocador do processo; " +
  "valor negativo é possível e NÃO significa 'não alocou'. Sem --expose-gc não há ponto de medida limpo.";

/**
 * `process.cpuUsage()` mede o PROCESSO inteiro. Duas consequências medidas, e
 * nenhuma delas é óbvia ao ler o número:
 *
 *  - `worker_threads` e qualquer trabalho concorrente entram na conta. Um run
 *    "ocioso" (só `setTimeout`) chegou a 849 ms de CPU só porque havia workers
 *    queimando CPU no mesmo processo.
 *  - Sob contenção de CPU o delta CAI sem que a função medida tenha mudado:
 *    uma espera ocupada de 150 ms de parede rendeu 170 ms de CPU com a máquina
 *    livre e 67 ms com 24 processos concorrentes. Espera ocupada mede PAREDE,
 *    e parede só vira CPU quando o processo está escalonado.
 *
 * Ou seja: isto não é tempo de CPU atribuível a `fn`. Para caracterizar custo
 * de CPU de forma estável, meça TRABALHO FIXO (contagem de operações), não
 * duração de parede fixa.
 */
const CPU_NOTE =
  "process.cpuUsage() é do PROCESSO inteiro (inclui worker_threads e trabalho concorrente) e encolhe sob " +
  "contenção de CPU sem que a função medida mude. Não é CPU atribuível só a fn; para custo estável, meça trabalho fixo.";

export interface CpuReport {
  /** Microssegundos de CPU em modo usuário durante o run (delta). */
  user_us: number;
  system_us: number;
  total_us: number;
  /** Ver `CPU_NOTE`: atribuição é do processo, não da função. */
  note: string;
}

function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}

function memoryDelta(before: MemorySnapshot, after: MemorySnapshot): MemorySnapshot {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function gcFn(): (() => void) | null {
  const g = (globalThis as { gc?: unknown }).gc;
  return typeof g === "function" ? (g as () => void) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark de performance
// ─────────────────────────────────────────────────────────────────────────────

export type BenchFn = () => unknown | Promise<unknown>;

export interface BenchIterationError {
  /** Onde ocorreu. Erro em aquecimento não polui a estatística nem a conta de erros medidos. */
  phase: "warmup" | "measure";
  /** Índice 0-based dentro da própria fase. */
  iteration: number;
  name: string;
  message: string;
}

export interface BenchRunOptions {
  /** Iterações MEDIDAS. Inteiro >= 0. */
  iteracoes?: number;
  /** Iterações descartadas antes de medir. Inteiro >= 0. */
  aquecimento?: number;
  /** Só LEVANTA o piso de amostra por percentil; nunca o baixa. */
  min_samples?: Partial<Record<PercentileName, number>>;
  /** Chama `global.gc()` antes/depois quando disponível. Sem `--expose-gc`, ignorado e declarado. */
  force_gc?: boolean;
  /** Relógio monotônico em ms. Default `performance.now`. Injetável para teste do próprio arnês. */
  clock?: () => number;
  /** Rótulo livre (ambiente, commit, modelo). Vai redigido para o relatório. */
  labels?: Record<string, unknown>;
}

export interface BenchResult {
  name: string;
  iterations_requested: number;
  warmup: number;
  /** Iterações de aquecimento efetivamente executadas e DESCARTADAS. */
  warmup_discarded: number;
  /** Amostras válidas, em ordem de execução (não ordenadas). */
  samples_ms: number[];
  errors: BenchIterationError[];
  stats: BenchStats;
  memory: MemoryReport;
  cpu: CpuReport;
  /** Parede do run inteiro, incluindo aquecimento e erros. Não é a soma das amostras. */
  wall_ms: number;
  started_at: string;
  ended_at: string;
  labels: Record<string, unknown>;
}

export interface BenchReport {
  kind: "performance";
  contract: string;
  generated_at: string;
  empty: boolean;
  min_samples: MinSampleTable;
  results: BenchResult[];
  /** Declarado sempre: se as amostras cruas ficaram de fora do JSON, isso aparece. */
  samples_omitted: boolean;
}

function assertCount(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`bench: ${label} inválido ${String(value)} — inteiro >= 0`);
  }
  return value;
}

function errorOf(phase: "warmup" | "measure", iteration: number, error: unknown): BenchIterationError {
  const e = error instanceof Error ? error : new Error(String(error));
  // Redação por nome de campo já cobre payload estruturado; a mensagem crua é
  // truncada porque relatório não é dump de stack.
  const safe = redactObject({ name: e.name, message: e.message });
  return {
    phase,
    iteration,
    name: String(safe.name).slice(0, 120),
    message: String(safe.message).slice(0, 300),
  };
}

export class Benchmark {
  readonly results: BenchResult[] = [];
  readonly #minSamples: MinSampleTable;
  readonly #clock: () => number;

  constructor(options: { min_samples?: Partial<Record<PercentileName, number>>; clock?: () => number } = {}) {
    this.#minSamples = resolveMinSamples(options.min_samples);
    this.#clock = options.clock ?? (() => performance.now());
  }

  get minSamples(): MinSampleTable {
    return this.#minSamples;
  }

  /**
   * Executa `fn` `iteracoes` vezes, descartando `aquecimento` execuções antes.
   *
   * `fn` pode ser síncrona ou assíncrona. Uma função síncrona NÃO é envolvida em
   * `await`: aguardar um valor não-thenable custa um turno de microtask, que em
   * medição sub-milissegundo é ruído introduzido pelo próprio instrumento.
   */
  async run(name: string, fn: BenchFn, options: BenchRunOptions = {}): Promise<BenchResult> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("bench: nome do run é obrigatório");
    }
    if (typeof fn !== "function") {
      throw new Error("bench: run exige uma função a medir");
    }
    const iterations = assertCount("iteracoes", options.iteracoes ?? 30);
    const warmup = assertCount("aquecimento", options.aquecimento ?? 0);
    const minSamples = resolveMinSamples({
      ...Object.fromEntries(PERCENTILES.map(({ name: p }) => [p, this.#minSamples[p]])),
      ...(options.min_samples ?? {}),
    } as Partial<Record<PercentileName, number>>);
    const clock = options.clock ?? this.#clock;

    const gc = gcFn();
    const gcForced = options.force_gc === true && gc !== null;

    const errors: BenchIterationError[] = [];
    const samples: number[] = [];

    const started_at = nowIso();
    const wall0 = clock();

    // ── aquecimento: executa e DESCARTA. JIT, cache e primeira alocação vivem aqui.
    let warmupDone = 0;
    for (let i = 0; i < warmup; i += 1) {
      try {
        const out = fn();
        if (isThenable(out)) await out;
        warmupDone += 1;
      } catch (error) {
        errors.push(errorOf("warmup", i, error));
      }
    }

    if (gcForced) gc!();
    const memBefore = memorySnapshot();
    const cpu0 = process.cpuUsage();

    for (let i = 0; i < iterations; i += 1) {
      const t0 = clock();
      try {
        const out = fn();
        if (isThenable(out)) await out;
      } catch (error) {
        // Sem amostra: cronometrar o caminho de erro deixaria o benchmark mais
        // rápido quanto mais quebrado o alvo estivesse.
        errors.push(errorOf("measure", i, error));
        continue;
      }
      samples.push(clock() - t0);
    }

    const cpu = process.cpuUsage(cpu0);
    if (gcForced) gc!();
    const memAfter = memorySnapshot();
    const wall_ms = clock() - wall0;
    const ended_at = nowIso();

    const result: BenchResult = {
      name,
      iterations_requested: iterations,
      warmup,
      warmup_discarded: warmupDone,
      samples_ms: samples,
      errors,
      stats: computeStats(samples, minSamples),
      memory: {
        before: memBefore,
        after: memAfter,
        delta: memoryDelta(memBefore, memAfter),
        gc_forced: gcForced,
        gc_available: gc !== null,
        note: MEMORY_NOTE,
      },
      cpu: { user_us: cpu.user, system_us: cpu.system, total_us: cpu.user + cpu.system, note: CPU_NOTE },
      wall_ms,
      started_at,
      ended_at,
      labels: redactObject(options.labels ?? {}),
    };

    this.results.push(result);
    return result;
  }

  report(): BenchReport {
    return {
      kind: "performance",
      contract: CONTRACT_VERSION,
      generated_at: nowIso(),
      empty: this.results.length === 0,
      min_samples: this.#minSamples,
      results: this.results,
      samples_omitted: false,
    };
  }

  /**
   * JSON do relatório. Por padrão as amostras cruas ficam FORA (um run de 100k
   * iterações viraria um relatório ilegível) — e a omissão é declarada em
   * `samples_omitted`, nunca silenciosa.
   */
  toJSON(options: { samples?: boolean; indent?: number } = {}): string {
    const includeSamples = options.samples === true;
    const base = this.report();
    const report: BenchReport = {
      ...base,
      samples_omitted: !includeSamples,
      results: includeSamples ? base.results : base.results.map((r) => ({ ...r, samples_ms: [] })),
    };
    return JSON.stringify(report, null, options.indent ?? 2);
  }

  toMarkdown(): string {
    return performanceMarkdown(this.report());
  }
}

/**
 * Thenable inclui objeto E função com `.then` — uma função callable com `then`
 * é aguardável e seria medida errada se tratada como retorno síncrono.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const t = typeof value;
  if (t !== "object" && t !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderização markdown
// ─────────────────────────────────────────────────────────────────────────────

/** Escapa `|` para não quebrar a coluna da tabela. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function num(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}

/**
 * Célula de percentil. Quando a amostra não sustenta, sai a palavra
 * `insuficiente` — nunca um número, nem `—`, que se confundiria com "não
 * medido". O leitor precisa distinguir *não medi* de *medi e não sustenta*.
 */
function percentileCell(stats: BenchStats, name: PercentileName): string {
  if (stats.insufficient.some((i) => i.percentile === name)) return "insuficiente";
  const value = name === "p50" ? stats.p50_ms : name === "p95" ? stats.p95_ms : stats.p99_ms;
  return num(value);
}

export function performanceMarkdown(report: BenchReport): string {
  const out: string[] = [];
  out.push("## Benchmark de performance");
  out.push("");
  out.push(`Contrato v${report.contract} · gerado em ${report.generated_at}`);
  out.push("");

  if (report.empty) {
    out.push("**Nenhuma medição registrada.** Relatório vazio — nada foi executado.");
    out.push("");
    return `${out.join("\n")}\n`;
  }

  out.push("| run | n | pedidas | erros | p50 ms | p95 ms | p99 ms | min ms | max ms | média ms | desvio ms |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of report.results) {
    const s = r.stats;
    out.push(
      `| ${cell(r.name)} | ${s.n} | ${r.iterations_requested} | ${r.errors.length} | ` +
        `${percentileCell(s, "p50")} | ${percentileCell(s, "p95")} | ${percentileCell(s, "p99")} | ` +
        `${num(s.min_ms)} | ${num(s.max_ms)} | ${num(s.mean_ms)} | ${num(s.stddev_ms)} |`,
    );
  }
  out.push("");
  const m = report.min_samples;
  out.push(
    `\`insuficiente\` = a amostra não sustenta o percentil. Mínimo exigido: ` +
      `p50 n≥${m.p50}, p95 n≥${m.p95}, p99 n≥${m.p99} (regra \`ceil(1/(1-q))\`).`,
  );
  out.push("");
  out.push("| run | aquecimento descartado | parede ms | CPU user µs | CPU sys µs | ΔRSS bytes | Δheap bytes |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const r of report.results) {
    out.push(
      `| ${cell(r.name)} | ${r.warmup_discarded} | ${r.wall_ms.toFixed(3)} | ${r.cpu.user_us} | ` +
        `${r.cpu.system_us} | ${r.memory.delta.rss} | ${r.memory.delta.heapUsed} |`,
    );
  }
  out.push("");
  out.push(`Memória: ${report.results[0]!.memory.note}`);
  out.push("");
  out.push(`CPU: ${report.results[0]!.cpu.note}`);
  if (report.samples_omitted) {
    out.push("");
    out.push("Amostras cruas omitidas deste relatório (`samples_omitted: true`).");
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QualityBench — FASE 33
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sinal de verificação aceito pelo `QualityBench`. O `VerificationResult` do
 * contrato encaixa direto; a forma reduzida existe para arnês que ainda não
 * tem verificador ligado.
 *
 * `executed:false` é o caso decisivo: verificação que não rodou não confirma
 * NEM refuta. Tratar isso como refutação inventaria uma prova de mentira, que é
 * o espelho do erro que este módulo existe para evitar.
 */
export interface VerificationSignal {
  executed: boolean;
  verified: boolean;
  confidence?: number;
  observed?: string | null;
}

export interface QualityCaseInput {
  id: string;
  /** O agente/LLM DECLAROU conclusão. É afirmação, não evidência. */
  declared_success: boolean;
  /** Ausente ⇒ verificação não executada. */
  verification?: VerificationSignal | VerificationResult;
  /** A tarefa foi entregue a um humano. */
  human_escalation?: boolean;
  goal?: string;
  duration_ms?: number;
  detail?: Record<string, unknown>;
}

export type QualityOutcome =
  | "verified_success"
  | "false_success"
  | "unverified_claim"
  | "undeclared_success"
  | "honest_failure"
  | "human_escalation";

export interface QualityCaseRecord {
  id: string;
  declared_success: boolean;
  verification_executed: boolean;
  verified: boolean;
  human_escalation: boolean;
  confidence: number | null;
  observed: string | null;
  outcome: QualityOutcome;
  goal: string | null;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
}

export interface QualitySummary {
  total: number;
  /** Quantas vezes o agente DISSE que concluiu. */
  declared_success: number;
  /** Quantas vezes o verificador OBSERVOU estado que comprova. Métrica principal. */
  verified_success: number;
  /** Declarou sucesso e a verificação REFUTOU. Métrica de honestidade. */
  false_success: number;
  human_escalation: number;
  /** Declarou e a verificação não rodou: nem prova, nem refutação. */
  unverified_claim: number;
  /** Não declarou, mas a verificação comprovou. Subdeclaração. */
  undeclared_success: number;
  /** Não declarou e a verificação concorda. Falha reportada com honestidade. */
  honest_failure: number;
  verified_success_rate: number | null;
  false_success_rate: number | null;
  /** `false_success / declared_success`. `null` quando nada foi declarado. */
  false_success_of_declared: number | null;
  /** Nenhum caso registrado. Todas as taxas são `null`, não zero. */
  empty: boolean;
}

export interface QualityReport {
  kind: "quality";
  contract: string;
  generated_at: string;
  primary_metric: "verified_success";
  honesty_metric: "false_success";
  summary: QualitySummary;
  cases: QualityCaseRecord[];
  labels: Record<string, unknown>;
}

function normalizeVerification(v: QualityCaseInput["verification"]): VerificationSignal {
  if (v === undefined || v === null) return { executed: false, verified: false };
  const executed = v.executed === true;
  return {
    executed,
    // Fail closed: `verified` só vale quando a verificação de fato rodou.
    verified: executed && v.verified === true,
    confidence: typeof v.confidence === "number" ? v.confidence : undefined,
    observed: typeof v.observed === "string" ? v.observed : null,
  };
}

/**
 * Classificação em classes MUTUAMENTE EXCLUSIVAS, por prioridade.
 *
 * Escalação humana vem primeiro e é terminal: se um humano teve de assumir, o
 * agente não concluiu sozinho, e contar isso como `verified_success` inflaria a
 * autonomia medida. Isso é decisão de medição, declarada, não um detalhe.
 */
export function classifyCase(declared: boolean, v: VerificationSignal, escalated: boolean): QualityOutcome {
  if (escalated) return "human_escalation";
  if (declared) {
    if (!v.executed) return "unverified_claim";
    return v.verified ? "verified_success" : "false_success";
  }
  if (v.executed && v.verified) return "undeclared_success";
  return "honest_failure";
}

export class QualityBench {
  readonly cases: QualityCaseRecord[] = [];
  readonly #labels: Record<string, unknown>;

  constructor(options: { labels?: Record<string, unknown> } = {}) {
    this.#labels = redactObject(options.labels ?? {});
  }

  /** Registra um caso. Devolve o registro REDIGIDO — é o que vai para o relatório. */
  record(input: QualityCaseInput): QualityCaseRecord {
    if (typeof input?.id !== "string" || input.id.trim().length === 0) {
      throw new Error("bench: caso de qualidade exige id");
    }
    if (typeof input.declared_success !== "boolean") {
      throw new Error(`bench: caso ${input.id} — declared_success deve ser booleano explícito`);
    }
    const v = normalizeVerification(input.verification);
    const escalated = input.human_escalation === true;

    const record: QualityCaseRecord = {
      id: input.id,
      declared_success: input.declared_success,
      verification_executed: v.executed,
      verified: v.verified,
      human_escalation: escalated,
      confidence: v.confidence ?? null,
      observed: v.observed ?? null,
      outcome: classifyCase(input.declared_success, v, escalated),
      goal: typeof input.goal === "string" ? input.goal : null,
      duration_ms: typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) ? input.duration_ms : null,
      detail: input.detail === undefined ? null : redactObject(input.detail),
    };
    const safe = redactObject(record);
    this.cases.push(safe);
    return safe;
  }

  /**
   * Resumo. `declared_success`, `verified_success`, `false_success` e
   * `human_escalation` são contagens INDEPENDENTES sobre os campos crus — não
   * fatias de uma partição. É de propósito: a distância entre `declared` e
   * `verified` sobre o MESMO conjunto é a superfície de mentira do sistema, e
   * ela some se cada caso for forçado a um balde só.
   */
  summary(): QualitySummary {
    const total = this.cases.length;
    let declared = 0;
    let verified = 0;
    let falseSuccess = 0;
    let escalation = 0;
    let unverified = 0;
    let undeclared = 0;
    let honest = 0;

    for (const c of this.cases) {
      if (c.declared_success) declared += 1;
      if (c.verification_executed && c.verified) verified += 1;
      if (c.declared_success && c.verification_executed && !c.verified) falseSuccess += 1;
      if (c.human_escalation) escalation += 1;
      switch (c.outcome) {
        case "unverified_claim":
          unverified += 1;
          break;
        case "undeclared_success":
          undeclared += 1;
          break;
        case "honest_failure":
          honest += 1;
          break;
        default:
          break;
      }
    }

    // Divisão por zero não vira 0 e não vira NaN: vira `null`, que se lê como
    // "não há amostra para essa taxa".
    const rate = (numerator: number, denominator: number): number | null =>
      denominator === 0 ? null : numerator / denominator;

    return {
      total,
      declared_success: declared,
      verified_success: verified,
      false_success: falseSuccess,
      human_escalation: escalation,
      unverified_claim: unverified,
      undeclared_success: undeclared,
      honest_failure: honest,
      verified_success_rate: rate(verified, total),
      false_success_rate: rate(falseSuccess, total),
      false_success_of_declared: rate(falseSuccess, declared),
      empty: total === 0,
    };
  }

  report(): QualityReport {
    return {
      kind: "quality",
      contract: CONTRACT_VERSION,
      generated_at: nowIso(),
      primary_metric: "verified_success",
      honesty_metric: "false_success",
      summary: this.summary(),
      cases: this.cases,
      labels: this.#labels,
    };
  }

  toJSON(options: { cases?: boolean; indent?: number } = {}): string {
    const base = this.report();
    const report = options.cases === false ? { ...base, cases: [] } : base;
    return JSON.stringify(report, null, options.indent ?? 2);
  }

  toMarkdown(options: { cases?: boolean } = {}): string {
    return qualityMarkdown(this.report(), options);
  }
}

/**
 * Linhas do resumo. É uma constante, não uma lista montada em laço com
 * condição: assim `false_success` não pode ser omitido por acidente nem por
 * "estava zerado mesmo".
 */
const SUMMARY_ROWS: readonly { key: keyof QualitySummary; label: string; note: string }[] = Object.freeze([
  Object.freeze({ key: "total" as const, label: "total", note: "casos registrados" }),
  Object.freeze({ key: "declared_success" as const, label: "declared_success", note: "o agente DISSE que concluiu" }),
  Object.freeze({
    key: "verified_success" as const,
    label: "**verified_success**",
    note: "**métrica principal** — o verificador OBSERVOU estado que comprova",
  }),
  Object.freeze({
    key: "false_success" as const,
    label: "**false_success**",
    note: "**métrica de honestidade** — declarou sucesso e a verificação REFUTOU",
  }),
  Object.freeze({
    key: "human_escalation" as const,
    label: "human_escalation",
    note: "um humano teve de assumir; não conta como sucesso do agente",
  }),
  Object.freeze({
    key: "unverified_claim" as const,
    label: "unverified_claim",
    note: "declarou e a verificação não rodou — nem prova nem refutação",
  }),
  Object.freeze({
    key: "undeclared_success" as const,
    label: "undeclared_success",
    note: "não declarou, verificação comprovou",
  }),
  Object.freeze({ key: "honest_failure" as const, label: "honest_failure", note: "não declarou e a verificação concorda" }),
]);

export function qualityMarkdown(report: QualityReport, options: { cases?: boolean } = {}): string {
  const s = report.summary;
  const out: string[] = [];
  out.push("## Benchmark de qualidade");
  out.push("");
  out.push(`Contrato v${report.contract} · gerado em ${report.generated_at}`);
  out.push("");

  if (s.empty) {
    out.push("**Nenhum caso registrado.** Relatório vazio — as taxas saem `null`, não zero.");
    out.push("");
  }

  out.push("| métrica | valor | significado |");
  out.push("|---|---:|---|");
  for (const row of SUMMARY_ROWS) {
    out.push(`| ${row.label} | ${String(s[row.key])} | ${row.note} |`);
  }
  out.push("");
  out.push("| taxa | valor |");
  out.push("|---|---:|");
  out.push(`| verified_success / total | ${pct(s.verified_success_rate)} |`);
  out.push(`| false_success / total | ${pct(s.false_success_rate)} |`);
  out.push(`| false_success / declared_success | ${pct(s.false_success_of_declared)} |`);
  out.push("");
  out.push("`null` em taxa = denominador zero. Não é 0%.");

  if (options.cases !== false && report.cases.length > 0) {
    out.push("");
    out.push("| caso | declarou | verificou | verificado | escalou | desfecho |");
    out.push("|---|---|---|---|---|---|");
    for (const c of report.cases) {
      out.push(
        `| ${cell(c.id)} | ${bool(c.declared_success)} | ${bool(c.verification_executed)} | ` +
          `${bool(c.verified)} | ${bool(c.human_escalation)} | ${c.outcome} |`,
      );
    }
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

function pct(value: number | null): string {
  return value === null ? "null" : `${(value * 100).toFixed(1)}%`;
}

function bool(value: boolean): string {
  return value ? "sim" : "não";
}
