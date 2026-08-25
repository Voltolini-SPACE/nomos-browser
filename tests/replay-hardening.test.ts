/**
 * REPLAY HARDENING — PRODUCT-02 / FASE 19
 *
 * Cada defeito é montado em ISOLAMENTO num diretório temporário: um bundle, um
 * problema. Isolar importa porque um verificador que só sabe dizer "quebrado"
 * quando tudo está quebrado não distingue nada — e porque o teste precisa provar
 * *qual* defeito foi detectado, não que "algo" foi.
 *
 * Os dois primeiros testes são o controle negativo do conjunto:
 *   1. bundle escrito pelo `SessionRecorder` REAL sai `integro: true`
 *   2. bundle montado à mão pelo molde deste arquivo sai `integro: true`
 * Sem (1) o verificador poderia estar validando a minha ideia do formato em vez
 * do formato que a produção escreve. Sem (2) todo teste seguinte seria ambíguo:
 * o problema veio do defeito injetado ou do molde?
 *
 * Roda com: node --test tests/replay-hardening.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionRecorder, selarSessao, SEAL_FILE, calcularSelo } from "../packages/observability/src/replay.ts";
import {
  LACUNA_PADRAO_MS,
  UNKNOWN_OUTCOME,
  errosDe,
  verifyReplay,
  loadReplayVerificado,
  ReplayIntegrityError,
  type ReplayProblemCode,
  type ReplayVerifyReport,
} from "../packages/observability/src/replay-verify.ts";

/** PNG 1x1 válido — o mesmo usado na suíte de observabilidade. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const BASE = Date.parse("2026-08-24T10:00:00.000Z");
/** Timestamp ISO a `s` segundos da base. Aceita fração. */
const T = (s: number): string => new Date(BASE + s * 1000).toISOString();

let ROOT = "";

before(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "nomos-replay-hard-"));
});

after(async () => {
  if (ROOT !== "") await rm(ROOT, { recursive: true, force: true });
});

// ── molde de bundle ──────────────────────────────────────────────────────────

type Fonte = "actions" | "events" | "network" | "index";

/** Linha `string` = lixo cru injetado de propósito; objeto = registro legítimo. */
type Linha = unknown;

interface Molde {
  actions?: Linha[];
  events?: Linha[];
  network?: Linha[];
  index?: Linha[];
  arquivos?: { nome: string; bytes: Buffer }[];
  /** `null` não escreve result.json; string escreve conteúdo cru. */
  result?: unknown;
  recorded?: Record<string, number>;
  semNewline?: Fonte[];
  omitir?: (Fonte | "result")[];
  /** FASE 12 — não gravar `seal.json` (simula bundle legado, anterior ao selo). */
  naoSelar?: boolean;
}

const evtIniciada = (t: string, id: string) => ({
  timestamp: t,
  session_id: null,
  action_id: id,
  source: "runtime",
  event: "action.started",
  payload: {},
});
const evtConcluida = (t: string, id: string) => ({
  timestamp: t,
  session_id: null,
  action_id: id,
  source: "runtime",
  event: "action.completed",
  payload: {},
});
const evtQualquer = (t: string, nome: string, payload: Record<string, unknown> = {}) => ({
  timestamp: t,
  session_id: null,
  action_id: null,
  source: "runtime",
  event: nome,
  payload,
});
const auditoria = (t: string, id: string, actor = "agente-a") => ({
  timestamp: t,
  session: null,
  actor,
  action: "browser.click",
  target: "#entrar",
  result: "ok",
  verified: true,
  action_id: id,
});

const EVENTS_PADRAO = (): Linha[] => [
  evtIniciada(T(0), "act_1"),
  evtConcluida(T(1), "act_1"),
  evtQualquer(T(2), "page.loaded", { url: "https://exemplo.test/painel" }),
];
const ACTIONS_PADRAO = (): Linha[] => [auditoria(T(3), "act_1")];
const NETWORK_PADRAO = (): Linha[] => [
  { timestamp: T(4), url: "https://exemplo.test/api", method: "get", status: 200 },
];
const INDEX_PADRAO = (): Linha[] => [
  { ref: "shot_a", file: "shot_a.png", bytes: PNG_1X1.length, width: 1, height: 1, saved_at: T(5) },
];
const ARQUIVOS_PADRAO = () => [{ nome: "shot_a.png", bytes: PNG_1X1 }];

function contarObjetos(linhas: Linha[]): number {
  return linhas.filter((l) => typeof l !== "string").length;
}

async function escreverJsonl(file: string, linhas: Linha[], semNewline: boolean): Promise<void> {
  const corpo = linhas.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  await writeFile(file, corpo.length === 0 ? "" : semNewline ? corpo : `${corpo}\n`, "utf8");
}

/** Monta um bundle no disco. Sem molde, monta o bundle íntegro de referência. */
/**
 * FASE 12 — o molde SELA no fim, como a produção sela no fechamento da sessão.
 *
 * A ordem importa e não é detalhe: o selo é tirado DEPOIS de o molde escrever
 * tudo, inclusive os defeitos injetados. Isso mantém os casos anteriores
 * intactos (o selo confere com o que está no disco, defeituoso ou não, e nenhum
 * `SELO_DIVERGENTE` aparece onde não é o assunto) e deixa o selo medindo
 * exatamente o que ele existe para medir: adulteração APÓS o fechamento.
 * `naoSelar` existe para o caso do bundle legado, que nunca foi selado.
 */
async function montar(sid: string, m: Molde = {}): Promise<string> {
  const dir = path.join(ROOT, sid);
  await mkdir(path.join(dir, "screenshots"), { recursive: true });

  const sem = new Set(m.semNewline ?? []);
  const omitir = new Set(m.omitir ?? []);
  const actions = m.actions ?? ACTIONS_PADRAO();
  const events = m.events ?? EVENTS_PADRAO();
  const network = m.network ?? NETWORK_PADRAO();
  const index = m.index ?? INDEX_PADRAO();

  if (!omitir.has("actions")) {
    await escreverJsonl(path.join(dir, "actions.jsonl"), actions, sem.has("actions"));
  }
  if (!omitir.has("events")) {
    await escreverJsonl(path.join(dir, "events.jsonl"), events, sem.has("events"));
  }
  if (!omitir.has("network")) {
    await escreverJsonl(path.join(dir, "network.jsonl"), network, sem.has("network"));
  }
  if (!omitir.has("index")) {
    await escreverJsonl(path.join(dir, "screenshots", "index.jsonl"), index, sem.has("index"));
  }
  for (const f of m.arquivos ?? ARQUIVOS_PADRAO()) {
    await writeFile(path.join(dir, "screenshots", f.nome), f.bytes);
  }

  if (!omitir.has("result")) {
    const conteudo =
      m.result === undefined
        ? {
            session_id: sid,
            finished_at: T(6),
            recorded: m.recorded ?? {
              actions: contarObjetos(actions),
              events: contarObjetos(events),
              network: contarObjetos(network),
              screenshots: contarObjetos(index),
            },
            result: { ok: true },
          }
        : m.result;
    if (conteudo !== null) {
      await writeFile(
        path.join(dir, "result.json"),
        typeof conteudo === "string" ? conteudo : `${JSON.stringify(conteudo, null, 2)}\n`,
        "utf8",
      );
    }
  }
  if (m.naoSelar !== true) await selarSessao(sid, { root: ROOT });
  return dir;
}

const codigos = (r: ReplayVerifyReport): ReplayProblemCode[] => r.problemas.map((p) => p.codigo);
const porCodigo = (r: ReplayVerifyReport, c: ReplayProblemCode) =>
  r.problemas.filter((p) => p.codigo === c);

async function caminhar(dir: string, base = dir): Promise<string[]> {
  const saida: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const cheio = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...(await caminhar(cheio, base)));
    else saida.push(path.relative(base, cheio));
  }
  return saida.sort();
}

/** Digest de toda a árvore da sessão — prova que o verificador não escreveu nada. */
async function digestDir(dir: string): Promise<string> {
  const h = createHash("sha256");
  for (const rel of await caminhar(dir)) {
    h.update(rel);
    h.update(await readFile(path.join(dir, rel)));
  }
  return h.digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · controle negativo (bundle íntegro precisa passar)", () => {
  it("1. bundle escrito pelo SessionRecorder REAL sai integro:true, sem um problema sequer", async () => {
    const sid = "sess_intacto_recorder";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.init();
    await rec.recordEvent(evtIniciada(T(0), "act_1") as never);
    await rec.recordEvent(evtConcluida(T(1), "act_1") as never);
    await rec.recordAction(auditoria(T(2), "act_1") as never);
    await rec.recordNetwork({ timestamp: T(3), url: "https://exemplo.test/api", method: "get", status: 200 });
    await rec.saveScreenshot(PNG_1X1, "shot_real");
    await rec.finish({ ok: true });

    const r = await verifyReplay(sid, { root: ROOT });

    assert.deepEqual(r.problemas, [], "o escritor de produção não pode gerar problema");
    assert.equal(r.integro, true);
    assert.equal(r.contagens.erros, 0);
    assert.equal(r.contagens.avisos, 0);
    assert.deepEqual(r.cobertura.fontes, {
      actions: true,
      events: true,
      network: true,
      screenshots: true,
      result: true,
    });
    assert.equal(r.cobertura.acoes_iniciadas, 1);
    assert.equal(r.cobertura.acoes_com_desfecho, 1);
    assert.equal(r.cobertura.acoes_sem_desfecho, 0);
    assert.equal(r.cobertura.screenshots_indexados, 1);
    assert.equal(r.cobertura.screenshots_presentes, 1);
    assert.equal(r.cobertura.screenshots_legiveis, 1);
    assert.equal(r.cobertura.intervalo.inicio, T(0));
    assert.equal(r.cobertura.intervalo.fim, T(3));
    assert.equal(r.cobertura.intervalo.duracao_ms, 3000);
  });

  it("2. molde deste arquivo, sem defeito injetado, também sai integro:true", async () => {
    const sid = "sess_intacto_molde";
    await montar(sid);
    const r = await verifyReplay(sid, { root: ROOT });

    assert.deepEqual(r.problemas, []);
    assert.equal(r.integro, true);
    assert.deepEqual(r.contagens, {
      actions: 1,
      events: 3,
      network: 1,
      screenshots: 1,
      screenshots_orfaos: 0,
      linha_do_tempo: 5,
      linhas_corrompidas: 0,
      problemas: 0,
      erros: 0,
      avisos: 0,
      empates: 0,
      lacunas: 0,
    });
    // 17 checagens rodaram — a ausência de problema é resultado, não pulo.
    // Eram 16 até a FASE 12; `C18_selo_integridade` é a que passou a existir.
    assert.equal(r.cobertura.checagens.length, 17);
    assert.equal(r.cobertura.checagens[0], "C01_sessao_existe");
    assert.equal(r.cobertura.checagens.includes("C15_contagens"), true);
    assert.equal(r.cobertura.checagens.includes("C18_selo_integridade"), true);
    assert.equal(new Set(r.cobertura.checagens).size, 17, "sem checagem repetida");
    // A decodificação de pixels é opcional: se NÃO rodou, a lista não a menciona.
    assert.equal(r.cobertura.checagens.includes("C17_pixels_do_screenshot"), false);
    const fundo = await verifyReplay(sid, { root: ROOT, decodificar_pixels: true });
    assert.equal(fundo.cobertura.checagens.includes("C17_pixels_do_screenshot"), true);
    assert.equal(fundo.integro, true);
  });

  it("3. ação resolvida SÓ pela trilha de auditoria (sem evento de conclusão) não é in-flight", async () => {
    const sid = "sess_desfecho_por_auditoria";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_9")],
      actions: [auditoria(T(1), "act_9")],
    });
    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, true);
    assert.deepEqual(porCodigo(r, "ACAO_SEM_DESFECHO"), []);
    assert.equal(r.cobertura.acoes_com_desfecho, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · corrupção de arquivo", () => {
  it("4. linha JSONL corrompida é apontada por ARQUIVO e LINHA, sem perder as boas", async () => {
    const sid = "sess_linha_corrompida";
    await montar(sid, {
      events: [
        evtIniciada(T(0), "act_1"),
        "{lixo binário sem fechar",
        evtConcluida(T(1), "act_1"),
        evtQualquer(T(2), "page.loaded"),
      ],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "JSONL_CORROMPIDO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.arquivo, "events.jsonl");
    assert.equal(p[0]!.linha, 2);
    assert.equal(p[0]!.severidade, "erro");
    assert.equal(p[0]!.detalhe!.fonte, "event");
    assert.equal(r.contagens.linhas_corrompidas, 1);
    assert.equal(r.contagens.events, 3, "as três linhas boas continuam sendo lidas");
  });

  it("5. corrupção em actions.jsonl e network.jsonl é atribuída ao arquivo certo", async () => {
    const sid = "sess_corrompida_multi";
    await montar(sid, {
      actions: ["}{", auditoria(T(3), "act_1")],
      network: [{ timestamp: T(4), url: "https://exemplo.test/api" }, "nao json"],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    const p = porCodigo(r, "JSONL_CORROMPIDO");
    assert.equal(p.length, 2);
    assert.deepEqual(
      p.map((x) => [x.arquivo, x.linha]),
      [
        ["actions.jsonl", 1],
        ["network.jsonl", 2],
      ],
    );
    assert.equal(r.integro, false);
  });

  it("6. bundle truncado (última linha íntegra, mas sem newline final) é reportado", async () => {
    const sid = "sess_truncado_limpo";
    await montar(sid, { semNewline: ["events"] });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "ARQUIVO_TRUNCADO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.arquivo, "events.jsonl");
    assert.equal(p[0]!.linha, 3);
    assert.equal(p[0]!.detalhe!.ultima_linha_parseia, true, "só o \\n se perdeu");
    assert.deepEqual(porCodigo(r, "JSONL_CORROMPIDO"), [], "linha válida não vira erro de parse");
  });

  it("7. bundle truncado no meio do registro acumula TRUNCADO + CORROMPIDO", async () => {
    const sid = "sess_truncado_no_meio";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_1"), '{"timestamp":"2026-08-24T10:00:01.000Z","eve'],
      semNewline: ["events"],
      recorded: { actions: 1, events: 1, network: 1, screenshots: 1 },
    });
    const r = await verifyReplay(sid, { root: ROOT });

    const trunc = porCodigo(r, "ARQUIVO_TRUNCADO");
    assert.equal(trunc.length, 1);
    assert.equal(trunc[0]!.detalhe!.ultima_linha_parseia, false, "o registro em si está cortado");
    assert.equal(porCodigo(r, "JSONL_CORROMPIDO").length, 1);
    assert.equal(r.integro, false);
  });

  it("8. o relatório NÃO carrega o conteúdo da linha corrompida — só sob incluir_bruto", async () => {
    const sid = "sess_sem_vazamento";
    const SEGREDO = "HUNTER2_NAO_PODE_VAZAR";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_1"), `{"password":"${SEGREDO}"`, evtConcluida(T(1), "act_1")],
    });

    const fechado = await verifyReplay(sid, { root: ROOT });
    assert.equal(
      JSON.stringify(fechado).includes(SEGREDO),
      false,
      "conteúdo cru de linha corrompida não entra no relatório por padrão",
    );
    assert.equal(porCodigo(fechado, "JSONL_CORROMPIDO").length, 1);
    assert.equal(typeof porCodigo(fechado, "JSONL_CORROMPIDO")[0]!.detalhe!.bytes, "number");

    // O opt-in existe e funciona — não é código morto disfarçado de segurança.
    const aberto = await verifyReplay(sid, { root: ROOT, incluir_bruto: true });
    assert.equal(JSON.stringify(aberto).includes(SEGREDO), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · screenshots", () => {
  it("9. screenshot no índice e ausente do disco vira SCREENSHOT_AUSENTE", async () => {
    const sid = "sess_shot_ausente";
    await montar(sid, {
      index: [
        ...INDEX_PADRAO(),
        { ref: "shot_b", file: "shot_b.png", bytes: 91, width: 1, height: 1, saved_at: T(5) },
      ],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "SCREENSHOT_AUSENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.ref, "shot_b");
    assert.equal(r.cobertura.screenshots_indexados, 2);
    assert.equal(r.cobertura.screenshots_presentes, 1, "o frame ausente NÃO é fabricado");
    assert.equal(r.cobertura.screenshots_legiveis, 1);
  });

  it("10. arquivo no disco fora do índice vira SCREENSHOT_ORFAO", async () => {
    const sid = "sess_shot_orfao";
    await montar(sid, {
      arquivos: [...ARQUIVOS_PADRAO(), { nome: "shot_orfao.png", bytes: PNG_1X1 }],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "SCREENSHOT_ORFAO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.ref, "shot_orfao");
    assert.equal(r.contagens.screenshots_orfaos, 1);
    assert.equal(r.contagens.screenshots, 1, "órfão não infla a contagem do índice");
  });

  it("11. PNG ilegível é detectado pelo decodificador, não pela extensão", async () => {
    const sid = "sess_png_ilegivel";
    await montar(sid, {
      index: [{ ref: "shot_x", file: "shot_x.png", bytes: 11, width: 1, height: 1, saved_at: T(5) }],
      arquivos: [{ nome: "shot_x.png", bytes: Buffer.from("nao sou png") }],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "PNG_ILEGIVEL");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.ref, "shot_x");
    assert.equal(p[0]!.detalhe!.declarado_no_indice, false, "o índice mentia que era PNG bom");
    assert.equal(r.cobertura.screenshots_presentes, 1);
    assert.equal(r.cobertura.screenshots_legiveis, 0);
  });

  it("12. índice que declara dimensão diferente do arquivo é pego", async () => {
    const sid = "sess_png_dimensao";
    await montar(sid, {
      index: [
        { ref: "shot_a", file: "shot_a.png", bytes: PNG_1X1.length, width: 1280, height: 720, saved_at: T(5) },
      ],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "PNG_DIMENSAO_DIVERGENTE");
    assert.equal(p.length, 1);
    assert.deepEqual(p[0]!.detalhe!.indice, { width: 1280, height: 720 });
    assert.deepEqual(p[0]!.detalhe!.arquivo, { width: 1, height: 1 });
  });

  it("12b. PNG cortado logo após o cabeçalho: o índice o denuncia pelo TAMANHO", async () => {
    const sid = "sess_png_cortado";
    // MEDIDO: pngDimensions(PNG_1X1[0..33]) devolve {1,1} sem erro — o cabeçalho
    // sobrevive ao corte. Quem pega o corte é a contagem de bytes do índice.
    await montar(sid, { arquivos: [{ nome: "shot_a.png", bytes: PNG_1X1.subarray(0, 33) }] });

    const r = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(porCodigo(r, "PNG_ILEGIVEL"), [], "o cabeçalho sozinho passa — limite conhecido");
    const p = porCodigo(r, "SCREENSHOT_BYTES_DIVERGENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.declarado, PNG_1X1.length);
    assert.equal(p[0]!.detalhe!.observado, 33);
    assert.equal(r.integro, false);

    // Com decodificação de pixels, o mesmo arquivo cai também pela via do PNG.
    const fundo = await verifyReplay(sid, { root: ROOT, decodificar_pixels: true });
    const q = porCodigo(fundo, "PNG_ILEGIVEL");
    assert.equal(q.length, 1);
    assert.equal(q[0]!.detalhe!.camada, "pixels");
    assert.equal(fundo.cobertura.screenshots_legiveis, 0);
    assert.equal(fundo.integro, false);
  });

  it("12c. índice forjado de forma coerente só cai com decodificar_pixels", async () => {
    const sid = "sess_indice_forjado";
    const cortado = PNG_1X1.subarray(0, 33);
    // Tamanho e dimensão do índice batem com o binário: as checagens baratas
    // não têm por onde pegar. É exatamente o caso que o flag existe para cobrir.
    await montar(sid, {
      index: [{ ref: "shot_f", file: "shot_f.png", bytes: cortado.length, width: 1, height: 1, saved_at: T(5) }],
      arquivos: [{ nome: "shot_f.png", bytes: cortado }],
    });

    const raso = await verifyReplay(sid, { root: ROOT });
    assert.equal(raso.integro, true, "limite honesto: cabeçalho + tamanho coerentes passam");
    assert.equal(raso.cobertura.screenshots_legiveis, 1);

    const fundo = await verifyReplay(sid, { root: ROOT, decodificar_pixels: true });
    assert.equal(fundo.integro, false);
    assert.equal(porCodigo(fundo, "PNG_ILEGIVEL").length, 1);
    assert.equal(fundo.cobertura.screenshots_legiveis, 0);
  });

  it("12d. índice malformado vira problema, não derruba o verificador", async () => {
    const sid = "sess_indice_malformado";
    await montar(sid, {
      // Linhas que parseiam como JSON mas não descrevem um frame localizável.
      index: [{ ref: "shot_sem_arquivo", bytes: 10, saved_at: T(5) }, { file: "", ref: "vazio" }],
      arquivos: [],
      recorded: { actions: 1, events: 3, network: 1, screenshots: 2 },
    });

    const r = await verifyReplay(sid, { root: ROOT });
    const p = porCodigo(r, "SCREENSHOT_AUSENTE");
    assert.equal(p.length, 2, "as duas entradas inúteis são reportadas");
    assert.equal(p[0]!.detalhe!.motivo, "campo 'file' ausente ou inválido");
    assert.equal(r.integro, false);
  });

  it("12e. índice que OMITE a dimensão não é acusado de divergir", async () => {
    const sid = "sess_indice_sem_dimensao";
    await montar(sid, {
      index: [{ ref: "shot_a", file: "shot_a.png", bytes: PNG_1X1.length, saved_at: T(5) }],
    });
    const r = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(porCodigo(r, "PNG_DIMENSAO_DIVERGENTE"), [], "omitir ≠ declarar errado");
    assert.equal(r.integro, true);
  });

  it("13. registro que cita screenshot_ref desconhecido do índice é reportado", async () => {
    const sid = "sess_ref_pendurada";
    await montar(sid, {
      events: [
        evtIniciada(T(0), "act_1"),
        evtConcluida(T(1), "act_1"),
        evtQualquer(T(2), "page.loaded", { screenshot_ref: "shot_que_nunca_existiu" }),
      ],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "REFERENCIA_SEM_SCREENSHOT");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.ref, "shot_que_nunca_existiu");
    assert.equal(p[0]!.arquivo, "events.jsonl");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · tempo", () => {
  it("14. timestamp que retrocede dentro da fonte é TIMESTAMP_FORA_DE_ORDEM", async () => {
    const sid = "sess_fora_de_ordem";
    await montar(sid, {
      events: [evtIniciada(T(2), "act_1"), evtConcluida(T(0), "act_1"), evtQualquer(T(2.5), "page.loaded")],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "TIMESTAMP_FORA_DE_ORDEM");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.arquivo, "events.jsonl");
    assert.equal(p[0]!.detalhe!.registro, 1);
    assert.equal(p[0]!.detalhe!.delta_ms, -2000);
  });

  it("15. timestamp ilegível não vira 1970: sai TIMESTAMP_INVALIDO", async () => {
    const sid = "sess_timestamp_invalido";
    await montar(sid, {
      events: [
        evtIniciada(T(0), "act_1"),
        { ...(evtConcluida(T(1), "act_1") as Record<string, unknown>), timestamp: "ontem à tarde" },
        evtQualquer(T(2), "page.loaded"),
      ],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "TIMESTAMP_INVALIDO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.registro, 1);
    assert.equal(p[0]!.detalhe!.timestamp, "ontem à tarde");
    assert.deepEqual(porCodigo(r, "TIMESTAMP_FORA_DE_ORDEM"), [], "ilegível não é 'para trás'");
  });

  it("16. empate de timestamp é DITO, é aviso (não corrupção) e o desempate é estável", async () => {
    const sid = "sess_empate";
    await montar(sid, {
      events: [
        evtIniciada(T(0), "act_1"),
        evtConcluida(T(2), "act_1"),
        evtQualquer(T(2), "page.loaded"),
      ],
      actions: [auditoria(T(2), "act_1")],
      network: [{ timestamp: T(4), url: "https://exemplo.test/api", method: "get", status: 200 }],
    });

    const r = await verifyReplay(sid, { root: ROOT });
    const p = porCodigo(r, "TIMESTAMP_EMPATADO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.severidade, "aviso");
    assert.equal(r.integro, true, "empate de milissegundo não é corrupção");
    assert.equal(r.contagens.empates, 1);
    assert.equal(p[0]!.detalhe!.quantidade, 3);
    assert.equal(p[0]!.detalhe!.timestamp, T(2));
    // Dentro da mesma fonte, a ordem de CHEGADA (índice no arquivo) é preservada.
    assert.deepEqual(p[0]!.detalhe!.ordem_aplicada, [
      { fonte: "action", registro: 0, action_id: "act_1" },
      { fonte: "event", registro: 1, action_id: "act_1" },
      { fonte: "event", registro: 2, action_id: null },
    ]);
    assert.equal(r.cobertura.empate_desfeito_por.length > 0, true);

    // Estabilidade: reexecutar não pode reordenar o empate.
    const denovo = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(denovo, r);
  });

  it("17. lacuna temporal grande é aviso e o limiar é configurável", async () => {
    const sid = "sess_lacuna";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_1"), evtConcluida(T(1), "act_1"), evtQualquer(T(200), "page.loaded")],
      actions: [auditoria(T(201), "act_1")],
      network: [{ timestamp: T(202), url: "https://exemplo.test/api", method: "get", status: 200 }],
    });

    const padrao = await verifyReplay(sid, { root: ROOT });
    const p = porCodigo(padrao, "LACUNA_TEMPORAL");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.severidade, "aviso");
    assert.equal(p[0]!.detalhe!.delta_ms, 199_000);
    assert.equal(p[0]!.detalhe!.limiar_ms, LACUNA_PADRAO_MS);
    assert.equal(padrao.integro, true, "pausa longa SUGERE queda, não prova");
    assert.equal(padrao.contagens.lacunas, 1);

    const tolerante = await verifyReplay(sid, { root: ROOT, lacuna_ms: 300_000 });
    assert.deepEqual(porCodigo(tolerante, "LACUNA_TEMPORAL"), []);
    assert.equal(tolerante.contagens.lacunas, 0);

    const severo = await verifyReplay(sid, { root: ROOT, lacuna_ms: 500 });
    assert.equal(porCodigo(severo, "LACUNA_TEMPORAL").length, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · ownership e ações em voo", () => {
  it("18. troca de ator sem evento que a explique é reportada", async () => {
    const sid = "sess_troca_sem_evento";
    await montar(sid, {
      actions: [auditoria(T(3), "act_1", "agente-a"), auditoria(T(4), "act_2", "agente-b")],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "TROCA_DE_DONO_SEM_EVENTO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.de, "agente-a");
    assert.equal(p[0]!.detalhe!.para, "agente-b");
    assert.equal(p[0]!.detalhe!.de_em, T(3));
    assert.equal(p[0]!.detalhe!.para_em, T(4));
    assert.equal(p[0]!.arquivo, "actions.jsonl");
  });

  it("19. controle negativo: a MESMA troca com session.handoff no intervalo não acusa nada", async () => {
    const sid = "sess_troca_com_evento";
    await montar(sid, {
      events: [...EVENTS_PADRAO(), evtQualquer(T(3.5), "session.handoff", { to_owner: "agente-b" })],
      actions: [auditoria(T(3), "act_1", "agente-a"), auditoria(T(4), "act_2", "agente-b")],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.deepEqual(porCodigo(r, "TROCA_DE_DONO_SEM_EVENTO"), []);
    assert.equal(r.integro, true);
  });

  it("20. handoff FORA da janela não conta como explicação", async () => {
    const sid = "sess_troca_evento_fora";
    await montar(sid, {
      // Evento antes da primeira ação: não explica a troca que veio depois.
      events: [...EVENTS_PADRAO(), evtQualquer(T(2.5), "session.handoff", { to_owner: "agente-b" })],
      actions: [auditoria(T(3), "act_1", "agente-a"), auditoria(T(4), "act_2", "agente-b")],
    });
    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(porCodigo(r, "TROCA_DE_DONO_SEM_EVENTO").length, 1);
    assert.equal(r.integro, false);
  });

  it("21. ação iniciada sem fim sai UNKNOWN_OUTCOME — nunca 'ok', nunca 'falhou'", async () => {
    const sid = "sess_em_voo";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_1"), evtConcluida(T(1), "act_1"), evtIniciada(T(2), "act_2")],
      actions: [auditoria(T(3), "act_1")],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "ACAO_SEM_DESFECHO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.action_id, "act_2");
    assert.equal(p[0]!.detalhe!.desfecho, UNKNOWN_OUTCOME);
    assert.equal(p[0]!.detalhe!.correlacionavel, true);
    assert.equal(p[0]!.mensagem.includes(UNKNOWN_OUTCOME), true);
    assert.equal(r.cobertura.acoes_iniciadas, 2);
    assert.equal(r.cobertura.acoes_com_desfecho, 1);
    assert.equal(r.cobertura.acoes_sem_desfecho, 1);

    // O verificador não pode ter inventado desfecho em lugar nenhum do relatório.
    const texto = JSON.stringify(r);
    assert.equal(/"desfecho":"(ok|error|denied|falhou)"/.test(texto), false);
  });

  it("22. action.started sem action_id é in-flight não-correlacionável, não é sucesso", async () => {
    const sid = "sess_em_voo_sem_id";
    await montar(sid, {
      events: [{ ...(evtIniciada(T(0), "act_1") as Record<string, unknown>), action_id: null }],
      actions: [],
    });
    const r = await verifyReplay(sid, { root: ROOT });

    const p = porCodigo(r, "ACAO_SEM_DESFECHO");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.detalhe!.action_id, null);
    assert.equal(p[0]!.detalhe!.correlacionavel, false);
    assert.equal(p[0]!.detalhe!.desfecho, UNKNOWN_OUTCOME);
    assert.equal(r.integro, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · fechamento da sessão e contagens", () => {
  it("23. result.json ausente: a sessão nunca fechou", async () => {
    const sid = "sess_sem_result";
    await montar(sid, { omitir: ["result"] });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    const p = porCodigo(r, "RESULT_AUSENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.arquivo, "result.json");
    assert.equal(r.cobertura.fontes.result, false);
    assert.deepEqual(porCodigo(r, "FONTE_AUSENTE"), [], "result.json tem código próprio");
  });

  it("24. result.json ilegível não vira 'sem resultado' mudo", async () => {
    const sid = "sess_result_quebrado";
    await montar(sid, { result: '{ "session_id": "sess_result_quebrado", "recorded"' });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.integro, false);
    assert.equal(porCodigo(r, "RESULT_ILEGIVEL").length, 1);
    assert.deepEqual(porCodigo(r, "RESULT_AUSENTE"), []);
  });

  it("25. linha apagada depois do fato: o bundle parece íntegro e SÓ a contagem denuncia", async () => {
    const sid = "sess_linha_apagada";
    await montar(sid, {
      events: [evtIniciada(T(0), "act_1"), evtConcluida(T(1), "act_1")],
      // O gravador tinha escrito 3 eventos; alguém removeu um do arquivo.
      recorded: { actions: 1, events: 3, network: 1, screenshots: 1 },
    });
    const r = await verifyReplay(sid, { root: ROOT });

    assert.equal(r.contagens.linhas_corrompidas, 0, "nenhum erro de parse — o arquivo está 'limpo'");
    assert.deepEqual(porCodigo(r, "TIMESTAMP_FORA_DE_ORDEM"), []);
    const p = porCodigo(r, "CONTAGEM_DIVERGENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.severidade, "erro");
    assert.deepEqual(p[0]!.detalhe, { fonte: "events", declarado: 3, observado: 2, faltando: true });
    assert.equal(r.integro, false, "um replay que parece completo e não é PRECISA cair");
  });

  it("26. sobra de registro é aviso, não erro (outro escritor na mesma sessão)", async () => {
    const sid = "sess_sobra";
    await montar(sid, { recorded: { actions: 1, events: 2, network: 1, screenshots: 1 } });
    const r = await verifyReplay(sid, { root: ROOT });

    const p = porCodigo(r, "CONTAGEM_DIVERGENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.severidade, "aviso");
    assert.equal(p[0]!.detalhe!.faltando, false);
    assert.equal(r.integro, true);
  });

  it("27. fonte ausente é declarada como aviso, sem virar zero silencioso", async () => {
    const sid = "sess_sem_network";
    await montar(sid, { omitir: ["network"] });
    const r = await verifyReplay(sid, { root: ROOT });

    const p = porCodigo(r, "FONTE_AUSENTE");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.arquivo, "network.jsonl");
    assert.equal(r.cobertura.fontes.network, false);
    assert.equal(r.cobertura.fontes.events, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("replay-verify · conduta do verificador", () => {
  it("28. sessão inexistente é dita, não confundida com sessão vazia", async () => {
    const r = await verifyReplay("sess_que_nunca_houve", { root: ROOT });
    assert.equal(r.integro, false);
    assert.deepEqual(codigos(r), ["SESSAO_INEXISTENTE"]);
    assert.deepEqual(r.cobertura.checagens, ["C01_sessao_existe"], "não finge ter checado o resto");
    assert.equal(r.contagens.linha_do_tempo, 0);
    assert.deepEqual(r.cobertura.fontes, {
      actions: false,
      events: false,
      network: false,
      screenshots: false,
      result: false,
    });
  });

  it("29. session_id que vira caminho é recusado, não sanitizado", async () => {
    await assert.rejects(() => verifyReplay("../fora", { root: ROOT }), /session_id inválido/);
    await assert.rejects(() => verifyReplay("a/b", { root: ROOT }), /session_id inválido/);
  });

  it("30. bundle com vários defeitos: todos aparecem, nada é consertado e o relatório é estável", async () => {
    const sid = "sess_multi_defeito";
    const dir = await montar(sid, {
      events: [evtIniciada(T(2), "act_1"), "{corrompido", evtIniciada(T(0), "act_2")],
      actions: [auditoria(T(3), "act_1", "agente-a"), auditoria(T(4), "act_9", "agente-b")],
      index: [
        { ref: "shot_a", file: "shot_a.png", bytes: PNG_1X1.length, width: 1, height: 1, saved_at: T(5) },
        { ref: "shot_sumiu", file: "shot_sumiu.png", bytes: 10, width: 1, height: 1, saved_at: T(5) },
      ],
      arquivos: [...ARQUIVOS_PADRAO(), { nome: "shot_intruso.png", bytes: PNG_1X1 }],
      omitir: ["result"],
    });

    const antes = await digestDir(dir);
    const r = await verifyReplay(sid, { root: ROOT });
    const depois = await digestDir(dir);

    assert.equal(antes, depois, "o verificador NÃO escreve, NÃO conserta, NÃO fabrica frame");

    const vistos = new Set(codigos(r));
    for (const esperado of [
      "JSONL_CORROMPIDO",
      "SCREENSHOT_AUSENTE",
      "SCREENSHOT_ORFAO",
      "TIMESTAMP_FORA_DE_ORDEM",
      "TROCA_DE_DONO_SEM_EVENTO",
      "ACAO_SEM_DESFECHO",
      "RESULT_AUSENTE",
    ] as ReplayProblemCode[]) {
      assert.equal(vistos.has(esperado), true, `faltou detectar ${esperado}`);
    }
    assert.equal(r.integro, false);
    assert.equal(errosDe(r).length, r.contagens.erros);
    assert.equal(r.contagens.problemas, r.problemas.length);

    const denovo = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(denovo, r, "duas execuções sobre o mesmo disco dão o mesmo relatório");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FASE 12 — SELO DE INTEGRIDADE E RECUSA DE BUNDLE ADULTERADO
//
// O que estas checagens acrescentam às anteriores: as de cima são ESTRUTURAIS e
// pegam corrupção, truncamento, ordem e referência quebrada. Nenhuma delas pega
// a adulteração mais simples de todas — abrir o JSONL e trocar um valor,
// deixando o JSON válido, o timestamp no lugar e a contagem de linhas igual.
// Foi medido: era invisível. O selo pega, porque o digest do arquivo muda.
//
// Portões: REPLAY_RECORD, REPLAY_LOAD, REPLAY_VERIFY, REPLAY_TAMPER_DETECTION.
// ═════════════════════════════════════════════════════════════════════════════

const GATE_REPLAY: Record<string, string> = {
  REPLAY_RECORD: "FAIL",
  REPLAY_LOAD: "FAIL",
  REPLAY_VERIFY: "FAIL",
  REPLAY_TAMPER_DETECTION: "FAIL",
};

describe("FASE 12 · selo de integridade do replay", () => {
  it("F12-1. gravar → carregar → verificar: bundle real sai ÍNTEGRO e SELADO", async () => {
    const sid = "sess_f12_intacto";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.init();
    await rec.recordEvent(evtIniciada(T(0), "act_1") as never);
    await rec.recordEvent(evtConcluida(T(1), "act_1") as never);
    await rec.recordAction(auditoria(T(2), "act_1") as never);
    await rec.recordNetwork({ timestamp: T(3), url: "https://exemplo.test/a", method: "get", status: 200 });
    await rec.saveScreenshot(PNG_1X1, "shot_f12");
    await rec.finish({ ok: true });
    GATE_REPLAY.REPLAY_RECORD = "PASS";

    // O selo existe e cobre TODOS os arquivos do bundle — inclusive o binário
    // do screenshot, que é onde um índice forjado esconderia a troca.
    const selo = await calcularSelo(sid, { root: ROOT });
    const nomes = selo.files.map((f) => f.file).sort();
    assert.ok(nomes.includes("actions.jsonl"), `selo sem actions.jsonl: ${nomes.join(",")}`);
    assert.ok(nomes.includes("events.jsonl"));
    assert.ok(nomes.includes("network.jsonl"));
    assert.ok(nomes.includes("result.json"));
    assert.ok(nomes.includes("screenshots/index.jsonl"));
    assert.ok(nomes.some((n) => n.startsWith("screenshots/shot_f12")), "o binário do screenshot ficou fora do selo");
    for (const f of selo.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);

    // Carregar COM verificação devolve o bundle. É o caminho que a produção usa.
    const { bundle, report } = await loadReplayVerificado(sid, { root: ROOT });
    assert.equal(report.integro, true, JSON.stringify(report.problemas));
    assert.equal(bundle.actions.length, 1);
    assert.equal(bundle.events.length, 2);
    assert.equal(bundle.screenshots.length, 1);
    GATE_REPLAY.REPLAY_LOAD = "PASS";

    // Verificação sem NENHUM problema — nem aviso. Selo ausente seria aviso, e
    // é justamente o que não pode acontecer num bundle escrito pela produção.
    const r = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(r.problemas, [], "bundle selado pela produção gerou problema");
    assert.equal(r.cobertura.checagens.includes("C18_selo_integridade"), true);
    GATE_REPLAY.REPLAY_VERIFY = "PASS";
  });

  it("F12-2. ADULTERAR UMA LINHA (JSON válido, ordem intacta) é RECUSADO", async () => {
    const sid = "sess_f12_linha_trocada";
    await montar(sid);
    const antes = await verifyReplay(sid, { root: ROOT });
    assert.equal(antes.integro, true, "o bundle já nasceu reprovado — o caso não mediria nada");

    // A adulteração: trocar um valor DENTRO de uma linha legítima. O arquivo
    // continua sendo JSONL válido, o timestamp continua no lugar, a contagem de
    // linhas não muda. É o caso que toda checagem estrutural deixava passar.
    const alvo = path.join(ROOT, sid, "actions.jsonl");
    const original = await readFile(alvo, "utf8");
    const linhas = original.split("\n").filter((l) => l.trim() !== "");
    const primeira = JSON.parse(linhas[0]!) as Record<string, unknown>;
    primeira.actor = "ATOR-FORJADO";
    linhas[0] = JSON.stringify(primeira);
    await writeFile(alvo, `${linhas.join("\n")}\n`, "utf8");

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false, "linha adulterada passou pela verificação");
    const div = porCodigo(r, "SELO_DIVERGENTE");
    assert.equal(div.length, 1, `esperava um SELO_DIVERGENTE, veio ${codigos(r).join(",")}`);
    assert.equal(div[0]!.arquivo, "actions.jsonl");
    assert.match(div[0]!.mensagem, /ALTERADO/);

    // E o carregamento RECUSA — não devolve o bundle adulterado com um aviso.
    await assert.rejects(
      () => loadReplayVerificado(sid, { root: ROOT }),
      (e: unknown) => {
        assert.ok(e instanceof ReplayIntegrityError, `erro errado: ${String(e)}`);
        assert.equal(e.report.integro, false);
        assert.match(e.message, /SELO_DIVERGENTE/);
        return true;
      },
    );
  });

  it("F12-3. REORDENAR as linhas (mesmos bytes, outra ordem) é RECUSADO", async () => {
    const sid = "sess_f12_reordenado";
    // Duas ações com timestamps que, TROCADOS de lugar, ainda formam um arquivo
    // JSONL perfeitamente válido. A ordem é o fato adulterado.
    await montar(sid, {
      events: [evtIniciada(T(0), "act_a"), evtConcluida(T(1), "act_a"), evtIniciada(T(2), "act_b"), evtConcluida(T(3), "act_b")],
      actions: [auditoria(T(4), "act_a"), auditoria(T(5), "act_b")],
    });
    assert.equal((await verifyReplay(sid, { root: ROOT })).integro, true);

    const alvo = path.join(ROOT, sid, "actions.jsonl");
    const linhas = (await readFile(alvo, "utf8")).split("\n").filter((l) => l.trim() !== "");
    assert.equal(linhas.length, 2, "o caso precisa de duas linhas para poder trocá-las");
    await writeFile(alvo, `${[linhas[1], linhas[0]].join("\n")}\n`, "utf8");

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false, "reordenação passou pela verificação");
    const div = porCodigo(r, "SELO_DIVERGENTE");
    assert.equal(div.length, 1, `esperava SELO_DIVERGENTE, veio ${codigos(r).join(",")}`);
    // Reordenar preserva o TAMANHO do arquivo: é a assinatura da edição no
    // lugar, e o relatório diz isso em vez de chamar de truncamento.
    assert.equal((div[0]!.detalhe as Record<string, unknown>).mesmo_tamanho, true);
  });

  it("F12-4. TRUNCAR o arquivo é RECUSADO, e o relatório diz que foi truncamento", async () => {
    const sid = "sess_f12_truncado";
    await montar(sid);
    assert.equal((await verifyReplay(sid, { root: ROOT })).integro, true);

    const alvo = path.join(ROOT, sid, "events.jsonl");
    const conteudo = await readFile(alvo, "utf8");
    await writeFile(alvo, conteudo.slice(0, Math.floor(conteudo.length / 2)), "utf8");

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false);
    const div = porCodigo(r, "SELO_DIVERGENTE");
    assert.equal(div.length, 1, `esperava SELO_DIVERGENTE, veio ${codigos(r).join(",")}`);
    assert.match(div[0]!.mensagem, /TRUNCADO/);
    assert.equal((div[0]!.detalhe as Record<string, unknown>).mesmo_tamanho, false);
  });

  it("F12-5. APAGAR um arquivo do bundle é RECUSADO", async () => {
    const sid = "sess_f12_apagado";
    await montar(sid);
    await rm(path.join(ROOT, sid, "network.jsonl"));

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false, "apagar arquivo selado passou");
    const some = porCodigo(r, "SELO_ARQUIVO_AUSENTE");
    assert.equal(some.length, 1, `esperava SELO_ARQUIVO_AUSENTE, veio ${codigos(r).join(",")}`);
    assert.equal(some[0]!.arquivo, "network.jsonl");
  });

  it("F12-6. ACRESCENTAR arquivo depois do selo é RECUSADO", async () => {
    const sid = "sess_f12_extra";
    await montar(sid);
    await writeFile(path.join(ROOT, sid, "screenshots", "plantado.png"), PNG_1X1);

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false, "screenshot plantado depois do fechamento passou");
    assert.ok(codigos(r).includes("SELO_ARQUIVO_EXTRA"), codigos(r).join(","));
  });

  it("F12-7. ADULTERAR o BINÁRIO do screenshot é RECUSADO", async () => {
    const sid = "sess_f12_shot";
    const rec = new SessionRecorder(sid, { root: ROOT });
    await rec.init();
    await rec.recordEvent(evtIniciada(T(0), "act_s") as never);
    await rec.recordEvent(evtConcluida(T(1), "act_s") as never);
    await rec.recordAction(auditoria(T(2), "act_s") as never);
    const ref = await rec.saveScreenshot(PNG_1X1, "shot_trocado");
    await rec.finish({ ok: true });
    assert.equal((await verifyReplay(sid, { root: ROOT })).integro, true);

    // Troca o PNG por OUTRO PNG do mesmo tamanho: o índice continua batendo em
    // bytes, e sem selo isso passaria como imagem legítima.
    const arquivo = path.join(ROOT, sid, "screenshots", `${ref}.png`);
    const bytes = Buffer.from(await readFile(arquivo));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(arquivo, bytes);

    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, false, "screenshot trocado passou pela verificação");
    assert.ok(codigos(r).includes("SELO_DIVERGENTE"), codigos(r).join(","));
    GATE_REPLAY.REPLAY_TAMPER_DETECTION = "PASS";
  });

  it("F12-8. CONTROLE NEGATIVO: bundle íntegro atravessa tudo sem uma recusa", async () => {
    // Sem este caso, "recusa tudo" seria indistinguível de "detecta adulteração".
    const sid = "sess_f12_controle";
    await montar(sid);
    const r = await verifyReplay(sid, { root: ROOT });
    assert.deepEqual(r.problemas, [], `bundle intacto foi acusado: ${JSON.stringify(r.problemas)}`);
    assert.equal(r.integro, true);
    const { report } = await loadReplayVerificado(sid, { root: ROOT, permitir_avisos: false });
    assert.equal(report.integro, true);

    // O selo trava ADULTERAÇÃO, não a evolução legítima do bundle: uma escrita
    // seguida de RESSELO volta a aprovar. É o que torna o selo utilizável — um
    // mecanismo que congelasse o diretório para sempre seria abandonado no
    // primeiro reprocessamento legítimo.
    //
    // (Este é também o RESÍDUO declarado em docs/SECURITY.md: hash sem chave
    // detecta adulteração, mas quem tem escrita no diretório pode resselar. A
    // linha abaixo é a demonstração honesta disso, não um contorno.)
    const alvo12 = path.join(ROOT, sid, "actions.jsonl");
    const linhas12 = (await readFile(alvo12, "utf8")).split("\n").filter((l) => l.trim() !== "");
    const reg12 = JSON.parse(linhas12[0]!) as Record<string, unknown>;
    reg12.actor = "outro-ator";
    await writeFile(alvo12, `${[JSON.stringify(reg12), ...linhas12.slice(1)].join("\n")}\n`, "utf8");
    const depoisDaEscrita = await verifyReplay(sid, { root: ROOT });
    assert.equal(depoisDaEscrita.integro, false, "escrita sem resselo deveria reprovar");
    assert.deepEqual(codigos(depoisDaEscrita), ["SELO_DIVERGENTE"]);
    await selarSessao(sid, { root: ROOT });
    assert.equal((await verifyReplay(sid, { root: ROOT })).integro, true, "resselo nao reabilitou o bundle");
  });

  it("F12-9. bundle LEGADO (nunca selado) é AVISO, não erro", async () => {
    // Reprovar todo bundle anterior à FASE 12 transformaria o verificador em
    // ruído, e um verificador que reprova o normal ensina a ignorá-lo. Mas a
    // ausência do selo é DITA — não é silêncio.
    const sid = "sess_f12_legado";
    await montar(sid, { naoSelar: true });
    const r = await verifyReplay(sid, { root: ROOT });
    assert.equal(r.integro, true, "bundle legado foi reprovado");
    const av = porCodigo(r, "SELO_AUSENTE");
    assert.equal(av.length, 1, codigos(r).join(","));
    assert.equal(av[0]!.severidade, "aviso");
    assert.equal(await import("node:fs").then((fs) => fs.existsSync(path.join(ROOT, sid, SEAL_FILE))), false);

    // No modo ESTRITO (pipeline forense), o aviso também reprova.
    await assert.rejects(
      () => loadReplayVerificado(sid, { root: ROOT, permitir_avisos: false }),
      ReplayIntegrityError,
    );
  });

  it("F12-99. portões da FASE 12", () => {
    for (const [k, v] of Object.entries(GATE_REPLAY)) process.stderr.write(`${k}=${v}\n`);
    assert.deepEqual(Object.entries(GATE_REPLAY).filter(([, v]) => v !== "PASS"), []);
  });
});
