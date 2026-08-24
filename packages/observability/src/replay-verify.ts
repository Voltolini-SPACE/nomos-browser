/**
 * REPLAY VERIFY — PRODUCT-02 / FASE 19
 *
 * `loadReplay` já é tolerante a corrupção: devolve o que conseguiu ler e anota o
 * resto. Tolerância, porém, não é diagnóstico — um bundle com metade dos frames
 * apagados carrega quatro listas plausíveis e `errors: []`. Quem só olha o bundle
 * conclui "está completo".
 *
 * Este módulo existe para o modo de falha inaceitável: **um replay que parece
 * completo e não é**. Ele lê por cima de `replay.ts` (não o altera) e responde
 * uma pergunta só: este bundle pode ser usado como prova do que aconteceu?
 *
 * Três regras de conduta:
 *
 *  1. NUNCA CONSERTA. Nenhum frame é fabricado, nenhuma linha é reescrita,
 *     nenhuma lacuna é interpolada. O verificador só descreve.
 *  2. NUNCA ARREDONDA. Ação iniciada sem desfecho registrado sai
 *     `UNKNOWN_OUTCOME` — nem "ok" nem "falhou". Inventar qualquer um dos dois
 *     seria pior que o silêncio.
 *  3. NUNCA VAZA. O relatório carrega arquivo, linha e tamanho — não o conteúdo
 *     da linha corrompida nem a mensagem do parser (que embute trecho do texto).
 *     Conteúdo cru só sob `incluir_bruto: true`, escolha explícita de quem chama.
 *
 * `integro` é falso quando existe ao menos um problema de severidade `erro`.
 * Avisos (empate de timestamp, lacuna, fonte ausente) são reportados sem derrubar
 * a integridade: um empate de milissegundo é normal, e chamar isso de corrupção
 * treinaria o leitor a ignorar o relatório.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EventName } from "../../core/src/contract.ts";
import { ACTIONS_FILE, sessionDir, SESSIONS_ROOT } from "./audit.ts";
import { decodePng, pngDimensions } from "./png.ts";
import {
  EVENTS_FILE,
  NETWORK_FILE,
  RESULT_FILE,
  SCREENSHOTS_DIR,
  SCREENSHOT_INDEX,
  loadReplay,
  timelineOf,
  type ReplayBundle,
  type ReplayOptions,
  type ReplaySource,
  type ScreenshotRecord,
  type TimelineItem,
} from "./replay.ts";

/** Marca de ação cujo desfecho o disco não sabe. Não é sucesso nem falha. */
export const UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME" as const;

/** Lacuna (ms) a partir da qual a pausa é reportada como suspeita de queda. */
export const LACUNA_PADRAO_MS = 30_000;

export type Severidade = "erro" | "aviso";

export type ReplayProblemCode =
  | "SESSAO_INEXISTENTE"
  | "FONTE_AUSENTE"
  | "JSONL_CORROMPIDO"
  | "ARQUIVO_TRUNCADO"
  | "SCREENSHOT_AUSENTE"
  | "SCREENSHOT_ORFAO"
  | "SCREENSHOT_BYTES_DIVERGENTE"
  | "PNG_ILEGIVEL"
  | "PNG_DIMENSAO_DIVERGENTE"
  | "REFERENCIA_SEM_SCREENSHOT"
  | "TIMESTAMP_INVALIDO"
  | "TIMESTAMP_FORA_DE_ORDEM"
  | "TIMESTAMP_EMPATADO"
  | "LACUNA_TEMPORAL"
  | "TROCA_DE_DONO_SEM_EVENTO"
  | "ACAO_SEM_DESFECHO"
  | "RESULT_AUSENTE"
  | "RESULT_ILEGIVEL"
  | "CONTAGEM_DIVERGENTE";

/** Severidade padrão por código. Instâncias podem rebaixar (ver CONTAGEM_DIVERGENTE). */
export const SEVERIDADE_PADRAO: Readonly<Record<ReplayProblemCode, Severidade>> = Object.freeze({
  SESSAO_INEXISTENTE: "erro",
  // Sessão sem tráfego de rede legitimamente não tem network.jsonl.
  FONTE_AUSENTE: "aviso",
  JSONL_CORROMPIDO: "erro",
  ARQUIVO_TRUNCADO: "erro",
  SCREENSHOT_AUSENTE: "erro",
  SCREENSHOT_ORFAO: "erro",
  SCREENSHOT_BYTES_DIVERGENTE: "erro",
  PNG_ILEGIVEL: "erro",
  PNG_DIMENSAO_DIVERGENTE: "erro",
  REFERENCIA_SEM_SCREENSHOT: "erro",
  TIMESTAMP_INVALIDO: "erro",
  TIMESTAMP_FORA_DE_ORDEM: "erro",
  // Dois registros no mesmo milissegundo acontecem; o desempate é determinístico.
  TIMESTAMP_EMPATADO: "aviso",
  // Pausa longa SUGERE queda — não prova. Suspeita não é veredito.
  LACUNA_TEMPORAL: "aviso",
  TROCA_DE_DONO_SEM_EVENTO: "erro",
  ACAO_SEM_DESFECHO: "erro",
  RESULT_AUSENTE: "erro",
  RESULT_ILEGIVEL: "erro",
  CONTAGEM_DIVERGENTE: "erro",
});

export interface ReplayProblem {
  codigo: ReplayProblemCode;
  severidade: Severidade;
  mensagem: string;
  /** Caminho relativo ao diretório da sessão. Ausente quando não é sobre arquivo. */
  arquivo?: string;
  /** Linha FÍSICA 1-indexada. Só aparece quando é mesmo a linha física do arquivo. */
  linha?: number;
  detalhe?: Record<string, unknown>;
}

export interface ReplayCounts {
  actions: number;
  events: number;
  network: number;
  /** Entradas do índice de screenshots (órfãos não contam aqui). */
  screenshots: number;
  screenshots_orfaos: number;
  linha_do_tempo: number;
  linhas_corrompidas: number;
  problemas: number;
  erros: number;
  avisos: number;
  empates: number;
  lacunas: number;
}

export interface ReplayCoverage {
  /** Quais fontes existem no disco. Ausência é fato reportado, não zero silencioso. */
  fontes: {
    actions: boolean;
    events: boolean;
    network: boolean;
    screenshots: boolean;
    result: boolean;
  };
  /**
   * IDs de TODAS as checagens efetivamente executadas. Sem esta lista, a ausência
   * de um problema seria ambígua: "passou" e "nem rodou" pareceriam iguais.
   */
  checagens: string[];
  acoes_iniciadas: number;
  acoes_com_desfecho: number;
  acoes_sem_desfecho: number;
  screenshots_indexados: number;
  screenshots_presentes: number;
  screenshots_legiveis: number;
  intervalo: { inicio: string | null; fim: string | null; duracao_ms: number | null };
  /** Como o empate de timestamp foi desfeito, quando houve empate. */
  empate_desfeito_por: string;
}

export interface ReplayVerifyReport {
  session_id: string;
  dir: string;
  integro: boolean;
  problemas: ReplayProblem[];
  contagens: ReplayCounts;
  cobertura: ReplayCoverage;
}

export interface VerifyReplayOptions extends ReplayOptions {
  /** Lacuna temporal (ms) que dispara `LACUNA_TEMPORAL`. Default 30 000. */
  lacuna_ms?: number;
  /** Eventos que legitimam troca de dono. Default: handoff + takeover + release. */
  eventos_de_troca?: readonly EventName[];
  /**
   * Inclui conteúdo cru da linha corrompida e mensagem do parser no relatório.
   * Default `false`: o texto cru pode carregar segredo se o arquivo foi escrito
   * por alguém que não passou pelo `redactObject`.
   */
  incluir_bruto?: boolean;
  /**
   * Decodifica os PIXELS de cada screenshot, não só o cabeçalho.
   *
   * `pngDimensions` lê o IHDR e para — medido: um PNG cortado logo após o
   * cabeçalho devolve `1x1` sem erro. Para o caso normal isso basta, porque o
   * índice guarda o tamanho original e `SCREENSHOT_BYTES_DIVERGENTE` pega o
   * corte sem custo. Só um índice forjado *junto* com o binário escapa das duas
   * — e é para esse caso que este flag existe. Default `false`: inflar todo
   * screenshot de página inteira custa CPU que a verificação de rotina não
   * precisa pagar.
   */
  decodificar_pixels?: boolean;
}

const EVENTOS_DE_TROCA_PADRAO: readonly EventName[] = Object.freeze([
  "session.handoff",
  "control.taken",
  "control.returned",
]);

const ARQUIVO_POR_FONTE: Readonly<Record<ReplaySource | "screenshot", string>> = Object.freeze({
  action: ACTIONS_FILE,
  event: EVENTS_FILE,
  network: NETWORK_FILE,
  screenshot: `${SCREENSHOTS_DIR}/${SCREENSHOT_INDEX}`,
});

const ORDEM_FONTE: Readonly<Record<ReplaySource | "screenshot", number>> = Object.freeze({
  action: 0,
  event: 1,
  network: 2,
  screenshot: 3,
});

/** ms do timestamp, ou NaN quando ilegível. Não converte ilegível em 1970. */
function msDe(timestamp: unknown): number {
  if (typeof timestamp !== "string" || timestamp.length === 0) return Number.NaN;
  return Date.parse(timestamp);
}

async function lerBruto(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function existe(alvo: string): Promise<boolean> {
  try {
    await stat(alvo);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Verifica um bundle de replay contra corrupção.
 *
 * Lança apenas para `session_id` inválido (mesma regra do audit: nome que vira
 * caminho de arquivo é recusado, não sanitizado) e para I/O genuinamente
 * inesperado. Sessão inexistente não lança — vira `SESSAO_INEXISTENTE`.
 */
export async function verifyReplay(
  session_id: string,
  options: VerifyReplayOptions = {},
): Promise<ReplayVerifyReport> {
  const root = options.root ?? SESSIONS_ROOT;
  const lacunaMs = options.lacuna_ms ?? LACUNA_PADRAO_MS;
  const eventosDeTroca = new Set<string>(options.eventos_de_troca ?? EVENTOS_DE_TROCA_PADRAO);
  const incluirBruto = options.incluir_bruto === true;
  const decodificarPixels = options.decodificar_pixels === true;
  const dir = sessionDir(session_id, root); // valida o id; recusa `..`

  const problemas: ReplayProblem[] = [];
  const checagens: string[] = [];

  function anotar(
    codigo: ReplayProblemCode,
    mensagem: string,
    extra: { arquivo?: string; linha?: number; detalhe?: Record<string, unknown>; severidade?: Severidade } = {},
  ): void {
    const p: ReplayProblem = {
      codigo,
      severidade: extra.severidade ?? SEVERIDADE_PADRAO[codigo],
      mensagem,
    };
    if (extra.arquivo !== undefined) p.arquivo = extra.arquivo;
    if (extra.linha !== undefined) p.linha = extra.linha;
    if (extra.detalhe !== undefined) p.detalhe = extra.detalhe;
    problemas.push(p);
  }

  // ── C01 · a sessão existe no disco ────────────────────────────────────────
  checagens.push("C01_sessao_existe");
  if (!(await existe(dir))) {
    anotar("SESSAO_INEXISTENTE", `sessão ${session_id} não existe em ${root}`);
    return montarRelatorio(session_id, dir, problemas, checagens, null, [], {
      acoes_iniciadas: 0,
      acoes_com_desfecho: 0,
      acoes_sem_desfecho: 0,
      screenshots_presentes: 0,
      screenshots_legiveis: 0,
    });
  }

  const bundle = await loadReplay(session_id, { root });
  const linhaDoTempo = timelineOf(bundle);

  // ── C02 · quais fontes existem ────────────────────────────────────────────
  checagens.push("C02_fontes_presentes");
  for (const arquivo of bundle.missing) {
    // result.json ausente tem código próprio (C14): sessão que nunca fechou.
    if (arquivo === RESULT_FILE) continue;
    anotar("FONTE_AUSENTE", `fonte ${arquivo} não existe no disco`, { arquivo });
  }

  // ── C03 · linhas JSONL corrompidas ────────────────────────────────────────
  checagens.push("C03_linhas_jsonl");
  const erros = [...bundle.errors].sort((a, b) => {
    const of = ORDEM_FONTE[a.source] - ORDEM_FONTE[b.source];
    return of !== 0 ? of : a.error.line - b.error.line;
  });
  for (const { source, error } of erros) {
    const arquivo = ARQUIVO_POR_FONTE[source];
    anotar("JSONL_CORROMPIDO", `linha ${error.line} de ${arquivo} não é JSON válido`, {
      arquivo,
      linha: error.line,
      detalhe: {
        fonte: source,
        bytes: Buffer.byteLength(error.raw, "utf8"),
        ...(incluirBruto ? { bruto: error.raw, erro_parse: error.error } : {}),
      },
    });
  }

  // ── C04 · truncamento (última linha sem newline final) ────────────────────
  checagens.push("C04_newline_final");
  for (const arquivo of [ACTIONS_FILE, EVENTS_FILE, NETWORK_FILE, ARQUIVO_POR_FONTE.screenshot]) {
    const buf = await lerBruto(path.join(dir, arquivo));
    if (buf === null || buf.length === 0) continue;
    if (buf[buf.length - 1] === 0x0a) continue;
    const linhas = buf.toString("utf8").split("\n");
    const ultima = linhas[linhas.length - 1]!;
    let parseia = true;
    try {
      JSON.parse(ultima);
    } catch {
      parseia = false;
    }
    anotar(
      "ARQUIVO_TRUNCADO",
      `${arquivo} termina sem newline: a última linha foi escrita pela metade`,
      {
        arquivo,
        linha: linhas.length,
        detalhe: {
          bytes_ultima_linha: Buffer.byteLength(ultima, "utf8"),
          // false ⇒ o registro em si está cortado; true ⇒ só o \n se perdeu.
          ultima_linha_parseia: parseia,
          ...(incluirBruto ? { bruto: ultima } : {}),
        },
      },
    );
  }

  // ── C05/C06/C07 · screenshots: índice × disco × decodificação ─────────────
  checagens.push("C05_screenshots_indexados_no_disco");
  checagens.push("C06_screenshots_orfaos");
  checagens.push("C07_png_cabecalho");
  checagens.push("C16_bytes_do_screenshot");
  if (decodificarPixels) checagens.push("C17_pixels_do_screenshot");
  const shotsDir = path.join(dir, SCREENSHOTS_DIR);
  const indexados: ScreenshotRecord[] = bundle.screenshots
    .filter((s) => s.orphan !== true)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const orfaos: ScreenshotRecord[] = bundle.screenshots
    .filter((s) => s.orphan === true)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  let presentes = 0;
  let legiveis = 0;
  const refsIndexadas = new Set(indexados.map((s) => s.ref));

  for (const shot of indexados) {
    // Entrada que parseia como JSON mas não diz QUAL arquivo é: o frame não tem
    // como ser localizado. Vira problema — deixar `path.basename(undefined)`
    // estourar derrubaria o verificador justamente no bundle mais corrompido.
    if (typeof shot.file !== "string" || shot.file.length === 0) {
      anotar("SCREENSHOT_AUSENTE", `entrada do índice sem campo 'file' utilizável`, {
        arquivo: ARQUIVO_POR_FONTE.screenshot,
        detalhe: { ref: typeof shot.ref === "string" ? shot.ref : null, motivo: "campo 'file' ausente ou inválido" },
      });
      continue;
    }
    // basename: um índice forjado com `../` não pode fazer o verificador ler fora.
    const alvo = path.join(shotsDir, path.basename(shot.file));
    const bytes = await lerBruto(alvo);
    if (bytes === null) {
      anotar("SCREENSHOT_AUSENTE", `screenshot ${shot.ref} está no índice mas não no disco`, {
        arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
        detalhe: { ref: shot.ref, bytes_no_indice: shot.bytes },
      });
      continue;
    }
    presentes += 1;

    // C16 · o índice guarda o tamanho gravado; divergir significa que o binário
    // mudou DEPOIS de indexado — corte, sobrescrita ou troca de arquivo.
    if (typeof shot.bytes === "number" && shot.bytes !== bytes.length) {
      anotar(
        "SCREENSHOT_BYTES_DIVERGENTE",
        `screenshot ${shot.ref}: índice diz ${shot.bytes} bytes, o arquivo tem ${bytes.length}`,
        {
          arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
          detalhe: { ref: shot.ref, declarado: shot.bytes, observado: bytes.length },
        },
      );
    }

    try {
      const dims = pngDimensions(bytes);
      let decodifica = true;
      if (decodificarPixels) {
        try {
          decodePng(bytes);
        } catch (error) {
          decodifica = false;
          anotar("PNG_ILEGIVEL", `screenshot ${shot.ref} tem cabeçalho válido mas os pixels não decodificam`, {
            arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
            detalhe: {
              ref: shot.ref,
              bytes: bytes.length,
              // `cabecalho` passou e `pixels` não: o arquivo foi cortado depois do IHDR.
              camada: "pixels",
              motivo: error instanceof Error ? error.message : String(error),
              declarado_no_indice: typeof shot.decode_error === "string",
            },
          });
        }
      }
      if (decodifica) legiveis += 1;
      // `typeof === number`, não `!== null`: índice que simplesmente OMITE a
      // dimensão não declara nada, e acusar divergência ali seria acusação falsa.
      if (
        (typeof shot.width === "number" && shot.width !== dims.width) ||
        (typeof shot.height === "number" && shot.height !== dims.height)
      ) {
        anotar(
          "PNG_DIMENSAO_DIVERGENTE",
          `screenshot ${shot.ref}: índice diz ${shot.width}x${shot.height}, o arquivo diz ${dims.width}x${dims.height}`,
          {
            arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
            detalhe: {
              ref: shot.ref,
              indice: { width: shot.width, height: shot.height },
              arquivo: { width: dims.width, height: dims.height },
            },
          },
        );
      }
    } catch (error) {
      anotar("PNG_ILEGIVEL", `screenshot ${shot.ref} não decodifica como PNG`, {
        arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
        detalhe: {
          ref: shot.ref,
          bytes: bytes.length,
          camada: "cabecalho",
          motivo: error instanceof Error ? error.message : String(error),
          // O índice já declarava o defeito? Gravação honesta ≠ frame utilizável.
          declarado_no_indice: typeof shot.decode_error === "string",
        },
      });
    }
  }

  for (const shot of orfaos) {
    anotar("SCREENSHOT_ORFAO", `arquivo ${shot.file} está no disco mas não no índice`, {
      arquivo: `${SCREENSHOTS_DIR}/${path.basename(shot.file)}`,
      detalhe: { ref: shot.ref, bytes: shot.bytes },
    });
  }

  // ── C08 · referências a screenshot que o índice não conhece ───────────────
  checagens.push("C08_referencias_de_screenshot");
  const referencias: { ref: string; fonte: ReplaySource; registro: number }[] = [];
  bundle.events.forEach((e, i) => {
    const r = (e.payload as Record<string, unknown> | undefined)?.screenshot_ref;
    if (typeof r === "string" && r.length > 0) referencias.push({ ref: r, fonte: "event", registro: i });
  });
  bundle.actions.forEach((a, i) => {
    const r = a.detail?.screenshot_ref;
    if (typeof r === "string" && r.length > 0) referencias.push({ ref: r, fonte: "action", registro: i });
  });
  for (const { ref, fonte, registro } of referencias) {
    if (refsIndexadas.has(ref)) continue;
    anotar("REFERENCIA_SEM_SCREENSHOT", `registro cita screenshot_ref ${ref}, ausente do índice`, {
      arquivo: ARQUIVO_POR_FONTE[fonte],
      detalhe: { ref, fonte, registro },
    });
  }

  // ── C09 · ordem dos timestamps dentro de cada fonte ───────────────────────
  // A ordem do arquivo É a ordem de chegada. Timestamp que anda para trás
  // significa relógio alterado ou escrita fora de ordem — nos dois casos a
  // linha do tempo reconstruída deixa de refletir o que aconteceu.
  checagens.push("C09_timestamps_ordem");
  const fluxos: { fonte: ReplaySource; carimbos: unknown[] }[] = [
    { fonte: "action", carimbos: bundle.actions.map((a) => a.timestamp) },
    { fonte: "event", carimbos: bundle.events.map((e) => e.timestamp) },
    { fonte: "network", carimbos: bundle.network.map((n) => n.timestamp) },
  ];
  for (const { fonte, carimbos } of fluxos) {
    let anteriorMs = Number.NaN;
    let anteriorTs: unknown = null;
    for (let i = 0; i < carimbos.length; i += 1) {
      const ts = carimbos[i];
      const ms = msDe(ts);
      if (Number.isNaN(ms)) {
        anotar("TIMESTAMP_INVALIDO", `registro ${i} de ${ARQUIVO_POR_FONTE[fonte]} tem timestamp ilegível`, {
          arquivo: ARQUIVO_POR_FONTE[fonte],
          detalhe: { fonte, registro: i, timestamp: typeof ts === "string" ? ts : null },
        });
        continue;
      }
      if (!Number.isNaN(anteriorMs) && ms < anteriorMs) {
        anotar(
          "TIMESTAMP_FORA_DE_ORDEM",
          `registro ${i} de ${ARQUIVO_POR_FONTE[fonte]} retrocede no tempo`,
          {
            arquivo: ARQUIVO_POR_FONTE[fonte],
            detalhe: { fonte, registro: i, anterior: anteriorTs, atual: ts, delta_ms: ms - anteriorMs },
          },
        );
      }
      anteriorMs = ms;
      anteriorTs = ts;
    }
  }

  // ── C10 · empates de timestamp na linha do tempo fundida ──────────────────
  // Não é corrupção: é ambiguidade. O desempate de `timelineOf` é determinístico
  // (fonte, depois ordem de chegada dentro da fonte) — e precisa ser DITO, para
  // ninguém ler a ordem exibida como se fosse a ordem observada.
  checagens.push("C10_timestamps_empate");
  let empates = 0;
  for (let i = 0; i < linhaDoTempo.length; ) {
    const ms = msDe(linhaDoTempo[i]!.timestamp);
    if (Number.isNaN(ms)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < linhaDoTempo.length && msDe(linhaDoTempo[j]!.timestamp) === ms) j += 1;
    if (j - i > 1) {
      empates += 1;
      const grupo = linhaDoTempo.slice(i, j);
      anotar(
        "TIMESTAMP_EMPATADO",
        `${grupo.length} registros no mesmo instante ${linhaDoTempo[i]!.timestamp}: a ordem entre eles é convenção, não observação`,
        {
          detalhe: {
            timestamp: linhaDoTempo[i]!.timestamp,
            quantidade: grupo.length,
            ordem_aplicada: grupo.map((it) => ({
              fonte: it.source,
              registro: it.index,
              action_id: it.action_id,
            })),
          },
        },
      );
    }
    i = j;
  }

  // ── C11 · lacuna temporal ─────────────────────────────────────────────────
  checagens.push("C11_lacuna_temporal");
  let lacunas = 0;
  for (let i = 1; i < linhaDoTempo.length; i += 1) {
    const a = msDe(linhaDoTempo[i - 1]!.timestamp);
    const b = msDe(linhaDoTempo[i]!.timestamp);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const delta = b - a;
    if (delta <= lacunaMs) continue;
    lacunas += 1;
    anotar("LACUNA_TEMPORAL", `${delta} ms sem nenhum registro — sugere queda do processo`, {
      detalhe: {
        de: linhaDoTempo[i - 1]!.timestamp,
        ate: linhaDoTempo[i]!.timestamp,
        delta_ms: delta,
        limiar_ms: lacunaMs,
      },
    });
  }

  // ── C12 · troca de dono sem evento que a explique ─────────────────────────
  checagens.push("C12_troca_de_dono");
  const trocas = bundle.events
    .filter((e) => eventosDeTroca.has(e.event))
    .map((e) => ({ event: e.event, ms: msDe(e.timestamp), timestamp: e.timestamp }));
  let atorAnterior: string | null = null;
  let atorAnteriorMs = Number.NaN;
  let atorAnteriorTs: string | null = null;
  bundle.actions.forEach((entry, i) => {
    const ator = typeof entry.actor === "string" ? entry.actor : "";
    const ms = msDe(entry.timestamp);
    if (atorAnterior !== null && ator !== atorAnterior) {
      const janelaLegivel = !Number.isNaN(atorAnteriorMs) && !Number.isNaN(ms);
      const explicacao = janelaLegivel
        ? trocas.find((t) => !Number.isNaN(t.ms) && t.ms >= atorAnteriorMs && t.ms <= ms)
        : undefined;
      if (explicacao === undefined) {
        anotar(
          "TROCA_DE_DONO_SEM_EVENTO",
          `ator muda de ${atorAnterior} para ${ator} sem evento de troca no intervalo`,
          {
            arquivo: ACTIONS_FILE,
            detalhe: {
              registro: i,
              de: atorAnterior,
              para: ator,
              de_em: atorAnteriorTs,
              para_em: typeof entry.timestamp === "string" ? entry.timestamp : null,
              // Sem janela legível não dá para provar que houve evento: fail closed.
              janela_legivel: janelaLegivel,
              eventos_aceitos: [...eventosDeTroca],
            },
          },
        );
      }
    }
    atorAnterior = ator;
    atorAnteriorMs = ms;
    atorAnteriorTs = typeof entry.timestamp === "string" ? entry.timestamp : null;
  });

  // ── C13 · ação iniciada sem desfecho (in-flight na hora da queda) ─────────
  checagens.push("C13_acao_em_voo");
  const terminais = new Set<string>();
  for (const e of bundle.events) {
    if ((e.event === "action.completed" || e.event === "action.failed") && typeof e.action_id === "string") {
      terminais.add(e.action_id);
    }
  }
  // A trilha de auditoria só é escrita DEPOIS da ação: se há entrada, há desfecho.
  const auditadas = new Set<string>();
  for (const a of bundle.actions) {
    if (typeof a.action_id === "string" && a.action_id.length > 0) auditadas.add(a.action_id);
  }
  let iniciadas = 0;
  let comDesfecho = 0;
  bundle.events.forEach((e, i) => {
    if (e.event !== "action.started") return;
    iniciadas += 1;
    const id = typeof e.action_id === "string" && e.action_id.length > 0 ? e.action_id : null;
    if (id !== null && (terminais.has(id) || auditadas.has(id))) {
      comDesfecho += 1;
      return;
    }
    anotar(
      "ACAO_SEM_DESFECHO",
      `ação ${id ?? "(sem action_id)"} começou e o disco não registra fim: ${UNKNOWN_OUTCOME}`,
      {
        arquivo: EVENTS_FILE,
        detalhe: {
          registro: i,
          action_id: id,
          // Nem "ok" nem "falhou": o dado para decidir não existe.
          desfecho: UNKNOWN_OUTCOME,
          em: typeof e.timestamp === "string" ? e.timestamp : null,
          correlacionavel: id !== null,
        },
      },
    );
  });

  // ── C14 · result.json ─────────────────────────────────────────────────────
  checagens.push("C14_result_json");
  if (bundle.result_error !== null) {
    anotar("RESULT_ILEGIVEL", `${RESULT_FILE} existe mas não é legível`, {
      arquivo: RESULT_FILE,
      detalhe: incluirBruto ? { motivo: bundle.result_error } : {},
    });
  } else if (bundle.result === null) {
    anotar("RESULT_AUSENTE", `${RESULT_FILE} ausente: a sessão nunca fechou`, { arquivo: RESULT_FILE });
  }

  // ── C15 · contagens declaradas × contagens no disco ───────────────────────
  // Esta é a checagem que pega o bundle "bonito": remover uma linha inteira não
  // deixa erro de parse nem buraco de timestamp, só um número que não bate.
  checagens.push("C15_contagens");
  if (bundle.result !== null && bundle.result.recorded !== null && typeof bundle.result.recorded === "object") {
    const declarado = bundle.result.recorded;
    const observado: Record<string, number> = {
      actions: bundle.actions.length,
      events: bundle.events.length,
      network: bundle.network.length,
      screenshots: indexados.length,
    };
    for (const chave of ["actions", "events", "network", "screenshots"] as const) {
      const esperado = declarado[chave];
      if (typeof esperado !== "number") continue;
      const visto = observado[chave]!;
      if (visto === esperado) continue;
      const faltando = visto < esperado;
      anotar(
        "CONTAGEM_DIVERGENTE",
        `${RESULT_FILE} declara ${esperado} ${chave}, o disco entrega ${visto}`,
        {
          arquivo: RESULT_FILE,
          // Sobra pode ser outro escritor na mesma sessão; falta é perda de registro.
          severidade: faltando ? "erro" : "aviso",
          detalhe: { fonte: chave, declarado: esperado, observado: visto, faltando },
        },
      );
    }
  }

  return montarRelatorio(session_id, dir, problemas, checagens, bundle, linhaDoTempo, {
    acoes_iniciadas: iniciadas,
    acoes_com_desfecho: comDesfecho,
    acoes_sem_desfecho: iniciadas - comDesfecho,
    screenshots_presentes: presentes,
    screenshots_legiveis: legiveis,
    empates,
    lacunas,
    indexados: indexados.length,
    orfaos: orfaos.length,
  });
}

function montarRelatorio(
  session_id: string,
  dir: string,
  problemas: ReplayProblem[],
  checagens: string[],
  bundle: ReplayBundle | null,
  linhaDoTempo: TimelineItem[],
  extra: {
    acoes_iniciadas: number;
    acoes_com_desfecho: number;
    acoes_sem_desfecho: number;
    screenshots_presentes: number;
    screenshots_legiveis: number;
    empates?: number;
    lacunas?: number;
    indexados?: number;
    orfaos?: number;
  },
): ReplayVerifyReport {
  const erros = problemas.filter((p) => p.severidade === "erro").length;
  const avisos = problemas.length - erros;

  const finitos = linhaDoTempo
    .map((i) => i.timestamp)
    .filter((t) => !Number.isNaN(msDe(t)));
  const inicio = finitos.length > 0 ? finitos[0]! : null;
  const fim = finitos.length > 0 ? finitos[finitos.length - 1]! : null;

  const contagens: ReplayCounts = {
    actions: bundle?.actions.length ?? 0,
    events: bundle?.events.length ?? 0,
    network: bundle?.network.length ?? 0,
    screenshots: extra.indexados ?? 0,
    screenshots_orfaos: extra.orfaos ?? 0,
    linha_do_tempo: linhaDoTempo.length,
    linhas_corrompidas: bundle?.errors.length ?? 0,
    problemas: problemas.length,
    erros,
    avisos,
    empates: extra.empates ?? 0,
    lacunas: extra.lacunas ?? 0,
  };

  const ausentes = new Set(bundle?.missing ?? [ACTIONS_FILE, EVENTS_FILE, NETWORK_FILE, SCREENSHOTS_DIR, RESULT_FILE]);
  const cobertura: ReplayCoverage = {
    fontes: {
      actions: !ausentes.has(ACTIONS_FILE),
      events: !ausentes.has(EVENTS_FILE),
      network: !ausentes.has(NETWORK_FILE),
      screenshots: !ausentes.has(SCREENSHOTS_DIR),
      result: bundle?.result !== null && bundle !== null,
    },
    checagens,
    acoes_iniciadas: extra.acoes_iniciadas,
    acoes_com_desfecho: extra.acoes_com_desfecho,
    acoes_sem_desfecho: extra.acoes_sem_desfecho,
    screenshots_indexados: extra.indexados ?? 0,
    screenshots_presentes: extra.screenshots_presentes,
    screenshots_legiveis: extra.screenshots_legiveis,
    intervalo: {
      inicio,
      fim,
      duracao_ms: inicio === null || fim === null ? null : msDe(fim) - msDe(inicio),
    },
    empate_desfeito_por: "fonte, depois ordem de chegada dentro da fonte",
  };

  return {
    session_id,
    dir,
    integro: erros === 0,
    problemas,
    contagens,
    cobertura,
  };
}

/** Só os problemas que derrubam a integridade. Açúcar para quem só quer o veredito. */
export function errosDe(report: ReplayVerifyReport): ReplayProblem[] {
  return report.problemas.filter((p) => p.severidade === "erro");
}
