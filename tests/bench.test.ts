/**
 * BENCH — FASE 32/33
 *
 * Aqui se testa o INSTRUMENTO, não o sistema medido. Nenhum LLM, nenhum
 * Chromium, nenhuma rede: só funções de latência conhecida, construída por
 * espera ocupada com relógio INDEPENDENTE do relógio da medição.
 *
 * Por que espera ocupada com `Date.now()` e medição com `performance.now()`:
 * se os dois fossem o mesmo relógio, a asserção "mediu ~20 ms" seria circular —
 * um instrumento que devolvesse sempre a mesma constante passaria. Com relógios
 * distintos, um `performance.now()` quebrado devolveria ~0 e o teste cai. Cada
 * afirmação de latência vem acompanhada do controle negativo correspondente
 * (uma função sem espera), sem o qual "mediu 20 ms" não distingue medida de
 * constante.
 *
 * Roda com: node --test tests/bench.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { REDACTED } from "../packages/observability/src/redact.ts";
import type { VerificationResult } from "../packages/core/src/contract.ts";
import {
  Benchmark,
  DEFAULT_MIN_SAMPLES,
  QualityBench,
  classifyCase,
  computeStats,
  minSamplesFor,
  percentile,
  resolveMinSamples,
} from "../packages/observability/src/bench.ts";

/** Espera ocupada por `ms` usando um relógio DIFERENTE do que o arnês cronometra. */
function spin(ms: number): void {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    /* ocupa a CPU de propósito: é latência real, não sono */
  }
}

/**
 * Sumidouro do trabalho de `burn`. Sem consumir o resultado, o otimizador pode
 * eliminar o laço inteiro e o teste passaria a medir nada.
 */
let sumidouro = 0;

/**
 * Trabalho de CPU de tamanho FIXO — custo estável sob qualquer carga da
 * máquina, ao contrário de `spin`, que fixa a parede e deixa a CPU variar.
 */
function burn(rondas: number): void {
  let x = 0;
  for (let i = 0; i < rondas; i += 1) x += Math.sqrt(i % 1000);
  sumidouro += x;
}

/**
 * Extrai as células de uma linha de tabela markdown, emulando o renderizador:
 * `\|` é literal e NÃO separa coluna. Um split ingênuo em `|` contaria uma
 * coluna a mais e acusaria a tabela de quebrada quando ela está correta.
 */
function cellsOf(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
}

function rowStartingWith(markdown: string, name: string): string[] {
  const line = markdown.split("\n").find((l) => l.startsWith(`| ${name} |`));
  assert.notEqual(line, undefined, `linha ausente no markdown: ${name}`);
  return cellsOf(line!);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("estatística — percentil que a amostra não sustenta", () => {
  it("1. N=10 ⇒ p99 é null e marcado insuficiente; N=100 ⇒ p99 é numérico", () => {
    const dez = computeStats(Array.from({ length: 10 }, (_v, i) => i + 1));
    assert.equal(dez.n, 10);
    assert.equal(dez.p99_ms, null, "p99 sobre 10 amostras não pode sair como número");
    const marca = dez.insufficient.find((i) => i.percentile === "p99");
    assert.notEqual(marca, undefined, "p99 tem de aparecer em insufficient");
    assert.deepEqual(marca, { percentile: "p99", n: 10, n_required: 100, reason: "insuficiente" });
    // p50 tem amostra de sobra e sai normalmente — a recusa é do percentil, não do relatório.
    assert.equal(dez.p50_ms, 5);

    const cem = computeStats(Array.from({ length: 100 }, (_v, i) => i + 1));
    assert.equal(cem.n, 100);
    assert.equal(typeof cem.p99_ms, "number");
    assert.equal(cem.p99_ms, 99);
    assert.deepEqual(cem.insufficient, [], "com N=100 nenhum percentil fica insuficiente");
  });

  it("a mesma regra vale para p95: N=19 recusa, N=20 reporta", () => {
    const dezenove = computeStats(Array.from({ length: 19 }, (_v, i) => i + 1));
    assert.equal(dezenove.p95_ms, null);
    assert.equal(dezenove.insufficient.some((i) => i.percentile === "p95"), true);
    assert.equal(dezenove.insufficient.some((i) => i.percentile === "p50"), false);

    const vinte = computeStats(Array.from({ length: 20 }, (_v, i) => i + 1));
    assert.equal(vinte.p95_ms, 19);
    assert.equal(vinte.insufficient.some((i) => i.percentile === "p95"), false);
  });

  it("mínimo é ceil(1/(1-q)) — 2 / 20 / 100", () => {
    assert.equal(minSamplesFor(0.5), 2);
    assert.equal(minSamplesFor(0.95), 20);
    assert.equal(minSamplesFor(0.99), 100);
    assert.equal(minSamplesFor(0.999), 1000);
    assert.deepEqual(DEFAULT_MIN_SAMPLES, { p50: 2, p95: 20, p99: 100 });
    assert.throws(() => minSamplesFor(1), /quantil inválido/);
    assert.throws(() => minSamplesFor(0), /quantil inválido/);
    assert.throws(() => minSamplesFor(Number.NaN), /quantil inválido/);
  });

  it("configuração pode LEVANTAR o piso, nunca baixá-lo", () => {
    // Tentativa de afrouxar: ignorada, o piso teórico prevalece.
    assert.deepEqual(resolveMinSamples({ p99: 5 }), { p50: 2, p95: 20, p99: 100 });
    assert.deepEqual(resolveMinSamples({ p50: 1, p95: 2, p99: 3 }), { p50: 2, p95: 20, p99: 100 });
    // Tentativa de apertar: aceita.
    assert.deepEqual(resolveMinSamples({ p99: 500 }), { p50: 2, p95: 20, p99: 500 });
    assert.throws(() => resolveMinSamples({ p99: 0 }), /min_samples\.p99 inválido/);
    assert.throws(() => resolveMinSamples({ p99: 1.5 }), /min_samples\.p99 inválido/);

    // E o efeito é observável: 100 amostras não bastam quando o piso é 500.
    const s = computeStats(Array.from({ length: 100 }, (_v, i) => i + 1), resolveMinSamples({ p99: 500 }));
    assert.equal(s.p99_ms, null);
    assert.equal(s.insufficient.find((i) => i.percentile === "p99")!.n_required, 500);
  });

  it("nearest-rank: devolve valor MEDIDO, não interpolação", () => {
    const s = computeStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    // Todos os percentis reportados pertencem à amostra.
    for (const v of [s.p50_ms, s.min_ms, s.max_ms]) {
      assert.equal([10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(v!), true, `valor inventado: ${v}`);
    }
    assert.equal(s.p50_ms, 50, "5ª posição de 10, não a média entre 50 e 60");
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4], 0.99), 4);
    assert.equal(percentile([], 0.5), null);
    assert.throws(() => percentile([1], 1.5), /quantil inválido/);
  });

  it("ordena antes de calcular: entrada fora de ordem dá o mesmo resultado", () => {
    const ordenada = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const bagunçada = computeStats([7, 1, 10, 3, 9, 2, 6, 5, 8, 4]);
    assert.equal(bagunçada.p50_ms, ordenada.p50_ms);
    assert.equal(bagunçada.min_ms, 1);
    assert.equal(bagunçada.max_ms, 10);
  });

  it("média e desvio amostral conferem com valor calculado à mão", () => {
    // [2,4,4,4,5,5,7,9]: média 5, soma dos quadrados dos desvios 32, n-1 = 7.
    const s = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(s.mean_ms, 5);
    assert.equal(Math.abs(s.stddev_ms! - Math.sqrt(32 / 7)) < 1e-12, true, `desvio ${s.stddev_ms}`);
    // Não é o desvio POPULACIONAL (2). Se fosse, a dispersão sairia subestimada.
    assert.notEqual(s.stddev_ms, 2);
  });

  it("N=1: min=max=média, desvio null, p50 null — uma medição não é distribuição", () => {
    const s = computeStats([42]);
    assert.equal(s.n, 1);
    assert.equal(s.min_ms, 42);
    assert.equal(s.max_ms, 42);
    assert.equal(s.mean_ms, 42);
    assert.equal(s.stddev_ms, null, "desvio amostral de 1 elemento é indefinido, não 0");
    assert.equal(s.p50_ms, null);
    assert.equal(s.insufficient.length, 3);
  });

  it("2. lista vazia não explode: devolve relatório vazio explícito, sem zeros falsos", () => {
    const s = computeStats([]);
    assert.equal(s.n, 0);
    for (const v of [s.min_ms, s.max_ms, s.mean_ms, s.stddev_ms, s.p50_ms, s.p95_ms, s.p99_ms]) {
      assert.equal(v, null, "campo vazio tem de ser null; 0 leria como 'mediu 0 ms'");
    }
    assert.deepEqual(
      s.insufficient.map((i) => i.percentile),
      ["p50", "p95", "p99"],
    );
  });

  it("amostra não finita é recusada em vez de virar NaN no relatório", () => {
    assert.throws(() => computeStats([1, Number.NaN, 3]), /amostra não finita/);
    assert.throws(() => computeStats([1, Number.POSITIVE_INFINITY]), /amostra não finita/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Benchmark.run — medição", () => {
  it("3. N=10 ⇒ p99 null/insuficiente; N=100 ⇒ p99 numérico, no run de verdade", async () => {
    const b = new Benchmark();
    const dez = await b.run("noop-10", () => 1 + 1, { iteracoes: 10 });
    assert.equal(dez.stats.n, 10);
    assert.equal(dez.samples_ms.length, 10);
    assert.equal(dez.stats.p99_ms, null);
    assert.equal(dez.stats.insufficient.some((i) => i.percentile === "p99"), true);

    const cem = await b.run("noop-100", () => 1 + 1, { iteracoes: 100 });
    assert.equal(cem.stats.n, 100);
    assert.equal(typeof cem.stats.p99_ms, "number");
    assert.deepEqual(cem.stats.insufficient, []);
    assert.equal(cem.stats.p99_ms! >= cem.stats.p50_ms!, true, "p99 >= p50 por construção");
    assert.equal(cem.stats.max_ms! >= cem.stats.p99_ms!, true);
  });

  it("4. latência sintética de 20 ms cai na faixa esperada — com controle negativo", async () => {
    const b = new Benchmark();
    const lento = await b.run("spin-20ms", () => spin(20), { iteracoes: 12, aquecimento: 2 });
    const rapido = await b.run("noop", () => undefined, { iteracoes: 12, aquecimento: 2 });

    // Piso: Date.now() tem resolução de 1 ms, então a espera real fica em [19,21).
    assert.equal(lento.stats.min_ms! >= 18.5, true, `min=${lento.stats.min_ms}`);
    assert.equal(lento.stats.p50_ms! >= 19, true, `p50=${lento.stats.p50_ms}`);
    // Teto generoso: uma pausa de GC pode alongar uma iteração sem que o
    // instrumento esteja errado. O que não pode é o valor central fugir.
    assert.equal(lento.stats.p50_ms! < 45, true, `p50=${lento.stats.p50_ms}`);

    // CONTROLE NEGATIVO: sem ele, um instrumento que devolvesse sempre ~20
    // passaria na asserção acima.
    assert.equal(rapido.stats.p50_ms! < 2, true, `noop p50=${rapido.stats.p50_ms}`);
    assert.equal(lento.stats.p50_ms! > rapido.stats.p50_ms! * 10, true, "o arnês distingue as duas latências");
  });

  it("5. aquecimento NÃO entra na estatística — com controle negativo sem aquecimento", async () => {
    const b = new Benchmark();

    // Função lenta apenas nas 5 primeiras chamadas: é exatamente o efeito que o
    // aquecimento existe para remover.
    let chamadas = 0;
    const fn = (): void => {
      chamadas += 1;
      if (chamadas <= 5) spin(25);
    };

    const comAquecimento = await b.run("com-aquecimento", fn, { iteracoes: 10, aquecimento: 5 });
    assert.equal(chamadas, 15, "aquecimento executa de verdade: 5 + 10 chamadas");
    assert.equal(comAquecimento.warmup_discarded, 5);
    assert.equal(comAquecimento.stats.n, 10, "só as 10 medidas entram em n");
    assert.equal(comAquecimento.samples_ms.length, 10);
    assert.equal(comAquecimento.stats.max_ms! < 10, true, `máximo=${comAquecimento.stats.max_ms} — o lento vazou`);

    // CONTROLE NEGATIVO: mesma função, sem aquecimento ⇒ o lento aparece.
    chamadas = 0;
    const semAquecimento = await b.run("sem-aquecimento", fn, { iteracoes: 10, aquecimento: 0 });
    assert.equal(semAquecimento.warmup_discarded, 0);
    assert.equal(semAquecimento.stats.n, 10);
    assert.equal(semAquecimento.stats.max_ms! >= 20, true, `máximo=${semAquecimento.stats.max_ms}`);
    assert.equal(
      semAquecimento.samples_ms.filter((s) => s >= 20).length,
      5,
      "exatamente as 5 primeiras iterações são lentas",
    );
    // A diferença entre os dois runs é o valor do aquecimento, medido.
    assert.equal(semAquecimento.stats.max_ms! > comAquecimento.stats.max_ms!, true);
  });

  it("função assíncrona é aguardada e medida", async () => {
    const b = new Benchmark();
    const r = await b.run("async-15ms", async () => new Promise((resolve) => setTimeout(resolve, 15)), {
      iteracoes: 6,
    });
    assert.equal(r.stats.n, 6);
    assert.equal(r.stats.min_ms! >= 12, true, `min=${r.stats.min_ms} — a promessa não foi aguardada`);
    assert.equal(r.stats.max_ms! < 200, true, `max=${r.stats.max_ms}`);
  });

  it("6. iteração que lança NÃO vira amostra; o erro é reportado, não engolido", async () => {
    const b = new Benchmark();
    let i = -1;
    const r = await b.run(
      "com-erro",
      () => {
        i += 1;
        // Falhar é barato: se o caminho de erro fosse cronometrado, a média
        // cairia e o benchmark ficaria "mais rápido" quanto mais quebrado.
        if (i === 2 || i === 5 || i === 7) throw new Error("falha sintética");
        spin(5);
      },
      { iteracoes: 10 },
    );

    assert.equal(r.iterations_requested, 10);
    assert.equal(r.stats.n, 7, "3 falhas ⇒ 7 amostras válidas");
    assert.equal(r.samples_ms.length, 7);
    assert.equal(r.errors.length, 3);
    assert.deepEqual(r.errors.map((e) => e.iteration), [2, 5, 7]);
    assert.deepEqual(r.errors.map((e) => e.phase), ["measure", "measure", "measure"]);
    assert.equal(r.errors[0]!.message.includes("falha sintética"), true);
    // Nenhuma amostra próxima de zero: nenhum erro entrou como medição.
    assert.equal(r.stats.min_ms! >= 4, true, `min=${r.stats.min_ms}`);
  });

  it("erro no aquecimento é marcado como warmup e não conta como iteração medida", async () => {
    const b = new Benchmark();
    let chamadas = 0;
    const r = await b.run(
      "erro-no-aquecimento",
      () => {
        chamadas += 1;
        if (chamadas <= 2) throw new Error("aquecimento ruim");
      },
      { iteracoes: 4, aquecimento: 3 },
    );
    assert.equal(r.warmup, 3);
    assert.equal(r.warmup_discarded, 1, "só 1 das 3 execuções de aquecimento concluiu");
    assert.equal(r.errors.filter((e) => e.phase === "warmup").length, 2);
    assert.equal(r.errors.filter((e) => e.phase === "measure").length, 0);
    assert.equal(r.stats.n, 4);
  });

  it("7. memória antes/depois e CPU são coletadas como delta real", async () => {
    const b = new Benchmark();
    // TRABALHO FIXO, não parede fixa. Esta escolha veio de uma medição, não de
    // estilo: a versão anterior deste teste usava `spin(30)`, passava sozinha e
    // caía na suíte completa. Espera ocupada mede PAREDE, e parede só vira CPU
    // quando o processo está escalonado — com a máquina livre 150 ms de parede
    // renderam 170 ms de CPU, com 24 processos concorrentes renderam 67 ms.
    // Trabalho fixo custa aproximadamente a mesma CPU sob qualquer carga
    // (medido: 46 ms ocioso, 58–67 ms sob carga — sobe, nunca desaba).
    const r = await b.run("burn-trabalho-fixo", () => burn(5_000_000), { iteracoes: 10, aquecimento: 2 });

    for (const campo of ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"] as const) {
      assert.equal(typeof r.memory.before[campo], "number");
      assert.equal(typeof r.memory.after[campo], "number");
      assert.equal(r.memory.delta[campo], r.memory.after[campo] - r.memory.before[campo], `delta de ${campo}`);
    }
    // A nota sobre contaminação por GC é obrigatória — sem ela um ΔRSS negativo
    // seria lido como "não alocou".
    assert.equal(r.memory.note.includes("negativo"), true);
    assert.equal(r.memory.gc_available, typeof (globalThis as { gc?: unknown }).gc === "function");
    assert.equal(r.memory.gc_forced, false, "sem force_gc não se força GC");

    assert.equal(r.cpu.total_us, r.cpu.user_us + r.cpu.system_us);
    assert.equal(r.cpu.user_us >= 0 && r.cpu.system_us >= 0, true);
    assert.equal(r.cpu.total_us > 20_000, true, `cpu total=${r.cpu.total_us} µs`);
    // A nota de atribuição é obrigatória: o número é do PROCESSO, não da função.
    assert.equal(r.cpu.note.includes("PROCESSO"), true);

    // Invariantes estruturais — verdadeiras sob qualquer carga, ao contrário de
    // qualquer limiar absoluto de tempo.
    const soma = r.samples_ms.reduce((acc, s) => acc + s, 0);
    assert.equal(r.wall_ms >= soma, true, `parede=${r.wall_ms} < soma das amostras=${soma}`);
    assert.equal(r.wall_ms >= r.stats.max_ms!, true);
    assert.equal(sumidouro > 0, true, "o trabalho não foi eliminado pelo otimizador");
  });

  it("CPU quase parada num run ocioso — controle negativo do contador de CPU", async () => {
    const b = new Benchmark();
    // Os dois runs no MESMO teste: a comparação é o que discrimina, e ela
    // sobrevive à carga da máquina porque ambos a sofrem igualmente.
    const queima = await b.run("queima", () => burn(5_000_000), { iteracoes: 10, aquecimento: 2 });
    const ocioso = await b.run("ocioso", async () => new Promise((resolve) => setTimeout(resolve, 20)), {
      iteracoes: 5,
    });

    // ~100 ms de parede, mas o processo dorme.
    //
    // O limiar de 5x foi calibrado NESTA maquina ("medido: ~1,0-1,7 ms de CPU,
    // com e sem 24 processos concorrentes") e reprovou no runner do GitHub, que
    // e outra maquina: menos nucleos, virtualizada, vizinhos barulhentos. Medido
    // aqui de novo, sob 12 processos disputando, a razao cai de ~40-100x para
    // 18,5x — degrada e nao chega perto de 5x. Ou seja: a disputa de CPU desta
    // maquina NAO reproduz a falha de la, e trocar 5 por outro numero sem ver os
    // valores do runner seria so mudar de aposta.
    //
    // Entao as medidas passam a ser IMPRESSAS sempre. A mensagem do assert nao
    // sobreviveu ao formato do TAP no log da CI — chegou como "false !== true",
    // sem numero nenhum, e foi por isso que a primeira investigacao ficou sem
    // dado. Uma linha de diagnostico no stdout sobrevive.
    const fracao = (r: { cpu: { total_us: number }; wall_ms: number }) =>
      r.wall_ms <= 0 ? 0 : r.cpu.total_us / (r.wall_ms * 1000);
    console.log(
      `[bench/cpu] queima cpu=${queima.cpu.total_us}us parede=${queima.wall_ms.toFixed(1)}ms fracao=${fracao(queima).toFixed(3)} | ` +
      `ocioso cpu=${ocioso.cpu.total_us}us parede=${ocioso.wall_ms.toFixed(1)}ms fracao=${fracao(ocioso).toFixed(3)} | ` +
      `razao=${ocioso.cpu.total_us === 0 ? "inf" : (queima.cpu.total_us / ocioso.cpu.total_us).toFixed(1)}x`,
    );

    assert.equal(ocioso.wall_ms >= 90, true, `parede=${ocioso.wall_ms}`);

    // A afirmacao que realmente importa nao e um multiplicador: e que o contador
    // mede CPU e nao relogio de parede. Dormir gasta pouca CPU POR UNIDADE DE
    // PAREDE; queimar gasta muita. Escrita como fracao, ela nao depende de quao
    // rapida e a maquina — so de a medicao significar o que diz. Um contador
    // quebrado que devolvesse a parede daria fracao ~1 nos dois e reprovaria
    // aqui; um que devolvesse zero reprovaria na linha de baixo.
    assert.equal(
      fracao(ocioso) < 0.5,
      true,
      `dormindo, a CPU deveria ser fracao pequena da parede: cpu=${ocioso.cpu.total_us}us parede=${ocioso.wall_ms}ms fracao=${fracao(ocioso).toFixed(3)}`,
    );
    assert.equal(
      fracao(queima) > 0.5,
      true,
      `queimando, a CPU deveria dominar a parede: cpu=${queima.cpu.total_us}us parede=${queima.wall_ms}ms fracao=${fracao(queima).toFixed(3)}`,
    );
    assert.equal(
      queima.cpu.total_us > ocioso.cpu.total_us * 5,
      true,
      `queima=${queima.cpu.total_us} µs vs ocioso=${ocioso.cpu.total_us} µs — o contador não distingue os dois`,
    );
    // E a parede NÃO distingue: os dois levam ~100 ms. É a CPU que separa.
    assert.equal(ocioso.wall_ms > 0 && queima.wall_ms > 0, true);
  });

  it("entrada inválida falha fechado em vez de virar default silencioso", async () => {
    const b = new Benchmark();
    await assert.rejects(() => b.run("x", () => 1, { iteracoes: -1 }), /iteracoes inválido/);
    await assert.rejects(() => b.run("x", () => 1, { iteracoes: 1.5 }), /iteracoes inválido/);
    await assert.rejects(() => b.run("x", () => 1, { iteracoes: Number.NaN }), /iteracoes inválido/);
    await assert.rejects(() => b.run("x", () => 1, { aquecimento: -3 }), /aquecimento inválido/);
    await assert.rejects(() => b.run("", () => 1), /nome do run é obrigatório/);
    await assert.rejects(() => b.run("x", undefined as unknown as () => void), /exige uma função/);
  });

  it("iteracoes:0 devolve resultado vazio explícito, sem explodir", async () => {
    const b = new Benchmark();
    const r = await b.run("zero", () => 1, { iteracoes: 0 });
    assert.equal(r.stats.n, 0);
    assert.deepEqual(r.samples_ms, []);
    assert.equal(r.stats.mean_ms, null);
    assert.equal(r.stats.p50_ms, null);
    assert.equal(r.stats.insufficient.length, 3);
  });

  it("rótulos do run são redigidos antes de entrar no resultado", async () => {
    const b = new Benchmark();
    const r = await b.run("com-rotulo", () => 1, {
      iteracoes: 2,
      labels: { host: "127.0.0.1", authorization: "Bearer SEGREDO_VIVO", modelo: "qwen3.5:4b-q8_0" },
    });
    assert.equal(r.labels.authorization, REDACTED);
    assert.equal(r.labels.host, "127.0.0.1");
    assert.equal(r.labels.modelo, "qwen3.5:4b-q8_0");
    assert.equal(JSON.stringify(r).includes("SEGREDO_VIVO"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Benchmark — relatórios", () => {
  it("8. markdown nunca imprime número para percentil que a amostra não sustenta", async () => {
    const b = new Benchmark();
    await b.run("curto", () => 1, { iteracoes: 10 });
    await b.run("longo", () => 1, { iteracoes: 100 });
    const md = b.toMarkdown();

    const curto = rowStartingWith(md, "curto");
    const longo = rowStartingWith(md, "longo");
    // Colunas: run | n | pedidas | erros | p50 | p95 | p99 | ...
    assert.equal(curto[1], "10");
    assert.equal(curto[5], "insuficiente", "p95 de 10 amostras");
    assert.equal(curto[6], "insuficiente", "p99 de 10 amostras");
    assert.equal(/\d/.test(curto[6]!), false, "a célula não pode conter dígito nenhum");
    assert.equal(curto[4] !== "insuficiente" && /^\d/.test(curto[4]!), true, "p50 sai como número");

    assert.equal(longo[1], "100");
    assert.equal(/^\d/.test(longo[6]!), true, "com N=100 o p99 sai como número");

    // O critério fica escrito no relatório, não só no código.
    assert.equal(md.includes("p99 n≥100"), true);
    assert.equal(md.includes("ceil(1/(1-q))"), true);
  });

  it("JSON do relatório é parseável, declara contrato e declara a omissão das amostras", async () => {
    const b = new Benchmark();
    await b.run("j", () => 1, { iteracoes: 12 });

    const semAmostras = JSON.parse(b.toJSON()) as {
      kind: string;
      contract: string;
      empty: boolean;
      samples_omitted: boolean;
      min_samples: Record<string, number>;
      results: { stats: { n: number; p99_ms: number | null }; samples_ms: number[] }[];
    };
    assert.equal(semAmostras.kind, "performance");
    assert.equal(semAmostras.contract, "1");
    assert.equal(semAmostras.empty, false);
    assert.equal(semAmostras.samples_omitted, true, "omissão declarada, nunca silenciosa");
    assert.deepEqual(semAmostras.results[0]!.samples_ms, []);
    assert.equal(semAmostras.results[0]!.stats.n, 12, "n continua verdadeiro mesmo sem as amostras");
    assert.equal(semAmostras.results[0]!.stats.p99_ms, null);
    assert.deepEqual(semAmostras.min_samples, { p50: 2, p95: 20, p99: 100 });

    const comAmostras = JSON.parse(b.toJSON({ samples: true })) as {
      samples_omitted: boolean;
      results: { samples_ms: number[] }[];
    };
    assert.equal(comAmostras.samples_omitted, false);
    assert.equal(comAmostras.results[0]!.samples_ms.length, 12);

    // O relatório em memória não foi mutado pela serialização.
    assert.equal(b.results[0]!.samples_ms.length, 12);
  });

  it("relatório sem nenhum run é vazio EXPLÍCITO, não uma tabela em branco", () => {
    const b = new Benchmark();
    const rep = b.report();
    assert.equal(rep.empty, true);
    assert.deepEqual(rep.results, []);

    const md = b.toMarkdown();
    assert.equal(md.includes("Nenhuma medição registrada"), true);
    assert.equal(md.includes("| run |"), false, "sem dados não se desenha cabeçalho de tabela");

    const json = JSON.parse(b.toJSON()) as { empty: boolean; results: unknown[] };
    assert.equal(json.empty, true);
    assert.deepEqual(json.results, []);
  });

  it("nome com pipe não quebra a tabela markdown", async () => {
    const b = new Benchmark();
    await b.run("a|b", () => 1, { iteracoes: 3 });
    const linha = b.toMarkdown().split("\n").find((l) => l.includes("a\\|b"))!;
    assert.notEqual(linha, undefined);
    assert.equal(cellsOf(linha).length, 11, "o pipe escapado não cria coluna extra");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("QualityBench — FASE 33", () => {
  const verificado: VerificationResult = {
    executed: true,
    verified: true,
    confidence: 1,
    kind: "URL_CHANGED",
    observed: "https://exemplo/ok",
    retries: 0,
  };
  const refutado: VerificationResult = {
    executed: true,
    verified: false,
    confidence: 0,
    kind: "ELEMENT_APPEARED",
    observed: null,
    retries: 2,
  };

  it("9. declarou sucesso e a verificação REFUTOU ⇒ false_success, e aparece no resumo", () => {
    const q = new QualityBench();
    q.record({ id: "t1", declared_success: true, verification: verificado });
    q.record({ id: "t2", declared_success: true, verification: refutado });
    q.record({ id: "t3", declared_success: true, verification: refutado });

    const s = q.summary();
    assert.equal(s.total, 3);
    assert.equal(s.declared_success, 3, "o agente disse que concluiu as 3");
    assert.equal(s.verified_success, 1, "só 1 foi comprovada por observação");
    assert.equal(s.false_success, 2, "2 declarações foram refutadas");
    assert.equal(s.verified_success_rate, 1 / 3);
    assert.equal(s.false_success_rate, 2 / 3);
    assert.equal(s.false_success_of_declared, 2 / 3);

    // O caso refutado é classificado como false_success, não como falha comum.
    assert.equal(q.cases[1]!.outcome, "false_success");
    assert.equal(q.cases[0]!.outcome, "verified_success");

    // ── o resumo TEM de mostrar isso ──
    const md = q.toMarkdown();
    assert.equal(md.includes("false_success"), true);
    assert.equal(rowStartingWith(md, "**false_success**")[1], "2");
    assert.equal(rowStartingWith(md, "**verified_success**")[1], "1");
    assert.equal(rowStartingWith(md, "declared_success")[1], "3");
    assert.equal(md.includes("métrica de honestidade"), true);
    assert.equal(md.includes("métrica principal"), true);

    const json = JSON.parse(q.toJSON()) as {
      primary_metric: string;
      honesty_metric: string;
      summary: { false_success: number; verified_success: number };
    };
    assert.equal(json.primary_metric, "verified_success");
    assert.equal(json.honesty_metric, "false_success");
    assert.equal(json.summary.false_success, 2);
    assert.equal(json.summary.verified_success, 1);
  });

  it("declarou e a verificação NÃO rodou ⇒ unverified_claim, jamais false_success", () => {
    const q = new QualityBench();
    q.record({ id: "sem-verificacao", declared_success: true });
    q.record({ id: "verificacao-nao-executou", declared_success: true, verification: { executed: false, verified: true } });

    const s = q.summary();
    assert.equal(s.declared_success, 2);
    assert.equal(s.unverified_claim, 2);
    assert.equal(s.false_success, 0, "verificação que não rodou não refuta nada");
    assert.equal(s.verified_success, 0, "e também não comprova nada");
    // `verified:true` sem `executed:true` é descartado — fail closed.
    assert.equal(q.cases[1]!.verified, false);
    assert.deepEqual(q.cases.map((c) => c.outcome), ["unverified_claim", "unverified_claim"]);
  });

  it("human_escalation é classe própria e não conta como sucesso do agente", () => {
    const q = new QualityBench();
    q.record({ id: "escalou", declared_success: true, verification: verificado, human_escalation: true });

    const s = q.summary();
    assert.equal(s.human_escalation, 1);
    assert.equal(q.cases[0]!.outcome, "human_escalation");
    // Contagens independentes continuam verdadeiras sobre os campos crus…
    assert.equal(s.declared_success, 1);
    assert.equal(s.verified_success, 1);
    // …mas o desfecho do caso não é sucesso autônomo.
    assert.notEqual(q.cases[0]!.outcome, "verified_success");
  });

  it("classifyCase cobre os seis desfechos, com escalação em primeiro lugar", () => {
    const exec = (verified: boolean) => ({ executed: true, verified });
    const naoExec = { executed: false, verified: false };
    assert.equal(classifyCase(true, exec(true), false), "verified_success");
    assert.equal(classifyCase(true, exec(false), false), "false_success");
    assert.equal(classifyCase(true, naoExec, false), "unverified_claim");
    assert.equal(classifyCase(false, exec(true), false), "undeclared_success");
    assert.equal(classifyCase(false, exec(false), false), "honest_failure");
    assert.equal(classifyCase(false, naoExec, false), "honest_failure");
    // Escalação vence qualquer combinação.
    assert.equal(classifyCase(true, exec(true), true), "human_escalation");
    assert.equal(classifyCase(false, naoExec, true), "human_escalation");
  });

  it("10. false_success NUNCA sai do resumo, nem quando vale zero", () => {
    const q = new QualityBench();
    q.record({ id: "ok1", declared_success: true, verification: verificado });
    q.record({ id: "ok2", declared_success: true, verification: verificado });

    const s = q.summary();
    assert.equal(s.false_success, 0);
    const md = q.toMarkdown();
    assert.equal(rowStartingWith(md, "**false_success**")[1], "0", "a linha existe mesmo zerada");
    assert.equal((JSON.parse(q.toJSON()) as { summary: Record<string, unknown> }).summary.false_success, 0);
  });

  it("11. bench vazio: divisão por zero vira null, relatório vazio explícito, sem exceção", () => {
    const q = new QualityBench();
    const s = q.summary();
    assert.equal(s.empty, true);
    assert.equal(s.total, 0);
    assert.equal(s.verified_success_rate, null);
    assert.equal(s.false_success_rate, null);
    assert.equal(s.false_success_of_declared, null);
    for (const v of [s.verified_success_rate, s.false_success_rate, s.false_success_of_declared]) {
      assert.equal(typeof v === "number" && Number.isNaN(v), false, "NaN vazaria como taxa");
    }

    const md = q.toMarkdown();
    assert.equal(md.includes("Nenhum caso registrado"), true);
    assert.equal(md.includes("`null` em taxa = denominador zero"), true);
    // Mesmo vazio, as métricas obrigatórias continuam listadas.
    assert.equal(rowStartingWith(md, "**false_success**")[1], "0");
    assert.equal(rowStartingWith(md, "**verified_success**")[1], "0");

    const json = JSON.parse(q.toJSON()) as { summary: { empty: boolean; verified_success_rate: number | null } };
    assert.equal(json.summary.empty, true);
    assert.equal(json.summary.verified_success_rate, null);
  });

  it("nenhuma declaração ⇒ false_success_of_declared é null, não 0 e não NaN", () => {
    const q = new QualityBench();
    q.record({ id: "falhou", declared_success: false, verification: refutado });
    const s = q.summary();
    assert.equal(s.declared_success, 0);
    assert.equal(s.false_success, 0);
    assert.equal(s.false_success_of_declared, null, "0/0 não é 0%");
    assert.equal(s.honest_failure, 1);
    assert.equal(s.verified_success_rate, 0, "0/1 é legitimamente 0");
    assert.equal(q.toMarkdown().includes("| false_success / declared_success | null |"), true);
  });

  it("subdeclaração: não declarou mas a verificação comprovou", () => {
    const q = new QualityBench();
    q.record({ id: "modesto", declared_success: false, verification: verificado });
    const s = q.summary();
    assert.equal(s.undeclared_success, 1);
    assert.equal(s.verified_success, 1, "verified_success mede observação, não declaração");
    assert.equal(s.declared_success, 0);
    assert.equal(s.false_success, 0);
  });

  it("segredo no detalhe do caso é redigido antes de entrar no relatório", () => {
    const q = new QualityBench({ labels: { cookie: "sid=VIVO", suite: "arena" } });
    const rec = q.record({
      id: "com-segredo",
      declared_success: true,
      verification: verificado,
      goal: "entrar no painel",
      detail: { credential_ref: "vault://se7en/pix", password: "NAO_PODE_VAZAR", campo: "#user" },
    });

    assert.equal(rec.detail!.password, REDACTED);
    assert.equal(rec.detail!.credential_ref, "vault://se7en/pix", "a referência é evidência e sobrevive");
    assert.equal(rec.detail!.campo, "#user");

    const json = q.toJSON();
    assert.equal(json.includes("NAO_PODE_VAZAR"), false);
    assert.equal(json.includes("sid=VIVO"), false);
    assert.equal(json.includes("vault://se7en/pix"), true);
    assert.equal(q.toMarkdown().includes("NAO_PODE_VAZAR"), false);
  });

  it("aceita VerificationResult do contrato sem adaptador e preserva confiança/observação", () => {
    const q = new QualityBench();
    const rec = q.record({ id: "contrato", declared_success: true, verification: verificado, duration_ms: 1234 });
    assert.equal(rec.confidence, 1);
    assert.equal(rec.observed, "https://exemplo/ok");
    assert.equal(rec.duration_ms, 1234);
    assert.equal(rec.outcome, "verified_success");
  });

  it("caso mal formado falha fechado", () => {
    const q = new QualityBench();
    assert.throws(() => q.record({ id: "", declared_success: true }), /exige id/);
    assert.throws(
      () => q.record({ id: "x", declared_success: undefined as unknown as boolean }),
      /declared_success deve ser booleano/,
    );
    assert.equal(q.cases.length, 0, "nada malformado entrou no relatório");
  });

  it("toJSON({cases:false}) omite os casos mas mantém o resumo íntegro", () => {
    const q = new QualityBench();
    q.record({ id: "a", declared_success: true, verification: refutado });
    const json = JSON.parse(q.toJSON({ cases: false })) as {
      cases: unknown[];
      summary: { total: number; false_success: number };
    };
    assert.deepEqual(json.cases, []);
    assert.equal(json.summary.total, 1);
    assert.equal(json.summary.false_success, 1);
  });
});
