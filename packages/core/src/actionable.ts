/**
 * FASE 4 — ACIONABILIDADE E PROVA DE ENTREGA
 *
 * O DEFEITO QUE ESTE ARQUIVO EXISTE PARA MATAR
 * --------------------------------------------
 * `browser.click` com o alvo em y=900 num viewport de 800px devolvia HTTP 200,
 * `success:true`, sem erro — e o elemento não recebia clique nenhum. O runtime
 * pegava a caixa do alvo, mandava o par mousedown/mouseup naquela coordenada e
 * chamava aquilo de sucesso. Coordenada fora do viewport não acerta nada: o
 * Chromium simplesmente descarta o ponto, e o `success` era uma afirmação sobre
 * o DISPARO, não sobre a CHEGADA.
 *
 * `verified:false` não servia de pista porque é o mesmo valor devolvido quando
 * nenhuma verificação foi pedida — "não confirmei" e "não verifiquei" eram
 * indistinguíveis no envelope.
 *
 * A SEMÂNTICA, NESTA ORDEM
 * ------------------------
 *  1. resolver (cascata do target.ts, inalterada — não é assunto deste arquivo);
 *  2. rolar o alvo para dentro do viewport;
 *  3. esperar a caixa ASSENTAR (N amostras consecutivas iguais);
 *  4. remedir a caixa;
 *  5. verificar acionabilidade (viewport, área, visível, não coberto);
 *  6. clicar;
 *  7. provar que o evento chegou;
 *  8. só então `success:true`.
 *
 * POR QUE A ESTABILIZAÇÃO EXISTE
 * ------------------------------
 * O scroll do Chromium é ANIMADO. `Input.dispatchMouseEvent{mouseWheel}` volta
 * antes de a página parar de rolar, e a medição feita logo depois pega a caixa
 * no meio da animação. Foi exatamente assim que a validação da FASE 3 mediu 0px
 * de erro para alvos que o clique nunca acertou: o instrumento leu uma caixa
 * velha e o clique foi para uma coordenada que já não era do alvo.
 *
 * POR QUE CENTRALIZAR E NÃO ROLAR O MÍNIMO
 * ----------------------------------------
 * Rolar o mínimo necessário deixa o alvo colado na borda do viewport — que é
 * precisamente onde header grudado, barra de cookies e rodapé fixo vivem. O
 * "mínimo" produz um alvo tecnicamente dentro do viewport e praticamente
 * coberto. Centralizar custa alguns pixels de scroll a mais e evita a classe
 * inteira de falha.
 *
 * A PROVA DE ENTREGA E POR QUE ELA NÃO PODE SER FORJADA POR NÓS
 * -------------------------------------------------------------
 * Antes do clique instalamos, via CDP/`evaluate`, um listener de CAPTURA em
 * `document` (`{capture:true, once:true}`). Depois do clique lemos o que ele
 * gravou: qual elemento foi o `target` do evento e se ele é o alvo resolvido ou
 * descendente dele.
 *
 * Três propriedades fazem disso prova e não decoração:
 *
 *  - O REGISTRO É ESCRITO PELO DESPACHO DE EVENTO DO CHROMIUM, não por nós. O
 *    runtime não tem como marcá-lo como entregue sem que um evento de clique
 *    real tenha percorrido a árvore. Um `success:true` inventado exigiria que o
 *    próprio motor de eventos do navegador mentisse.
 *
 *  - A FASE DE CAPTURA EM `document` É A PRIMEIRA A RODAR depois de `window`.
 *    A página não consegue impedir o registro com `stopPropagation` num handler
 *    seu: quando o handler dela roda, o nosso já rodou. (Um `capture` em
 *    `window` chamando `stopPropagation` conseguiria — e quebraria todos os
 *    handlers da própria página junto, então é auto-derrotante.)
 *
 *  - NÃO EXIGE COOPERAÇÃO DA PÁGINA. Nenhum atributo, nenhum handler, nenhum
 *    log combinado com a fixture. Funciona em qualquer site.
 *
 * O que ela NÃO prova: que a página REAGIU ao clique. Isso é papel do
 * `verifier.ts` (URL_CHANGED, DOM_CHANGED…). São camadas distintas de propósito.
 */
import type { Frame, Locator, Page } from "playwright";
import type { BoundingBox } from "./contract.ts";
import { InputError, pause, type Point, type PointerEngine } from "./pointer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────────────────────

export interface AcionabilidadeConfig {
  /** Rolar o alvo para dentro do viewport antes de agir. */
  scroll_into_view: boolean;
  /** Amostras CONSECUTIVAS iguais exigidas para declarar a caixa assentada. */
  stability_samples: number;
  /** Intervalo entre amostras. */
  stability_interval_ms: number;
}

/**
 * Teto de amostras = fator × amostras exigidas. Não é configuração própria de
 * propósito: o teto só existe para que um alvo que NUNCA para (carrossel, SPA
 * que reposiciona em loop) vire recusa em vez de espera infinita, e amarrá-lo
 * ao número de amostras mantém a relação "teto sempre folgado" sem uma quinta
 * chave para o operador errar.
 */
export const TETO_AMOSTRAS_FATOR = 12;
/** Tentativas de rolagem por roda antes de recorrer ao scrollIntoViewIfNeeded. */
export const MAX_TENTATIVAS_ROLAGEM = 3;
/** Espera máxima pela chegada do evento de clique depois do despacho. */
export const ESPERA_ENTREGA_MS = 600;
const PASSO_ENTREGA_MS = 40;
/**
 * Janela de RECONFERÊNCIA antes de concluir "não chegou" (FASE 4b).
 *
 * Uma navegação começa no instante do clique mas leva alguns milissegundos até
 * `page.url()` refletir o destino. A FASE 4 concluía "não chegou" nesse
 * intervalo e reprovava o gesto mais comum de um navegador: clicar num link.
 * Duas reconferências curtas custam ~300ms SÓ no caminho em que já não há prova
 * nenhuma — o caminho feliz não paga nada.
 */
export const RECONFERENCIAS_ENTREGA = 2;
export const RECONFERENCIA_MS = 150;
/**
 * Espera pela ABERTURA da aba quando o elemento clicado aponta para outro alvo
 * de navegação (`target="_blank"` e afins).
 *
 * Medido: o evento `page` do contexto chega ~290ms DEPOIS de o listener já ter
 * registrado o clique. Sem esta janela, `nova_aba` seria sempre `false` e o
 * runtime relataria "clique entregue" sem nunca mencionar a aba que ele abriu —
 * informação que o operador precisa ter. O custo é pago SÓ por clique que
 * declara abrir aba; clique comum não espera nada.
 */
export const ESPERA_NOVA_ABA_MS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos de saída
// ─────────────────────────────────────────────────────────────────────────────

export interface AreaVisivel {
  width: number;
  height: number;
}

export interface AcionabilidadeDetalhe {
  /** Caixa medida ANTES de qualquer rolagem. */
  box_antes: BoundingBox | null;
  /** Caixa medida DEPOIS de rolar e assentar — é dela que sai o ponto de clique. */
  box_depois: BoundingBox | null;
  /** Deslocamento de rolagem da JANELA. Rolagem de contêiner aninhado aparece
   *  como diferença entre `box_antes` e `box_depois`, não aqui. */
  scrolled: { dx: number; dy: number };
  amostras_ate_estabilizar: number;
  /** Mesmo número, com o nome que a linha de auditoria usa. */
  stabilized_after: number;
  dentro_do_viewport: boolean;
  /** `document.elementFromPoint` no ponto de clique. null quando não medível. */
  elemento_no_ponto: string | null;
  /** Quem rolou: "none" | "cdp:wheel" | "playwright:scrollIntoViewIfNeeded" | … */
  backend: string;
  actionable: boolean;
  /** Por que NÃO é acionável. null quando é. */
  motivo: string | null;
  viewport: AreaVisivel;
}

export interface Acionavel {
  /** Centro recalculado da caixa assentada. */
  ponto: Point;
  detalhe: AcionabilidadeDetalhe;
}

/** O alvo já resolvido, na forma mínima de que este módulo precisa. */
export interface AlvoAcionavel {
  /** Locator quando a estratégia produziu elemento; ausente em alvo por coordenada. */
  loc: Locator | undefined;
  /** Caixa da resolução. Para alvo por coordenada é {x,y,0,0} e nunca muda. */
  box: BoundingBox;
  descricao: string;
}

export interface RegistroDeEntrega {
  /** true quando o `target` do evento era o alvo resolvido ou descendente dele. */
  alvo_esperado: boolean;
  elemento: string | null;
  isTrusted: boolean;
  x: number;
  y: number;
  tipo: string;
  /** O elemento clicado aponta para outro alvo de navegação (`target=_blank`). */
  abre_nova_aba: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Medição
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Área REALMENTE clicável. `innerWidth/innerHeight` incluem a barra de rolagem,
 * e um ponto sobre a barra não acerta elemento nenhum: `elementFromPoint` ali
 * devolve null. `clientWidth/clientHeight` do documentElement é a região de
 * hit-test de verdade — usar a outra faria a checagem aprovar pontos mortos.
 */
export async function areaVisivel(page: Page): Promise<AreaVisivel> {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
}

async function rolagemDaJanela(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }));
}

export function centroDe(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function pontoDentro(p: Point, vp: AreaVisivel): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < vp.width && p.y < vp.height;
}

function mesmaCaixa(a: BoundingBox, b: BoundingBox): boolean {
  // Igualdade EXATA. Tolerância aqui seria a porta de volta do defeito: uma
  // animação lenta de 0,4px por amostra passaria por "estável".
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

async function medir(alvo: AlvoAcionavel): Promise<BoundingBox | null> {
  if (alvo.loc === undefined) return { ...alvo.box };
  try {
    return await alvo.loc.boundingBox({ timeout: 1000 });
  } catch {
    // Elemento destacado do DOM: `boundingBox` estoura em vez de devolver null.
    return null;
  }
}

export interface Estabilizacao {
  /** Última caixa NÃO nula observada. null se nunca houve caixa. */
  box: BoundingBox | null;
  amostras: number;
  estabilizou: boolean;
  /** true quando a caixa virou null no meio — elemento saiu do DOM. */
  removido: boolean;
}

/**
 * Amostra a caixa até `stability_samples` leituras consecutivas idênticas.
 * Alvo por coordenada assenta na primeira amostra (a caixa é constante) e não
 * paga nenhum intervalo — não faria sentido esperar por algo que não se move.
 */
export async function estabilizarCaixa(
  alvo: AlvoAcionavel,
  cfg: AcionabilidadeConfig,
): Promise<Estabilizacao> {
  const exigidas = Math.max(1, Math.floor(cfg.stability_samples));
  const intervalo = Math.max(0, Math.floor(cfg.stability_interval_ms));
  const teto = Math.max(exigidas * TETO_AMOSTRAS_FATOR, exigidas + 1);

  if (alvo.loc === undefined) {
    return { box: { ...alvo.box }, amostras: 1, estabilizou: true, removido: false };
  }

  let anterior: BoundingBox | null = null;
  let iguais = 0;
  let amostras = 0;
  let ultima: BoundingBox | null = null;

  while (amostras < teto) {
    const atual = await medir(alvo);
    amostras += 1;
    if (atual === null) {
      // Sumiu. Não continua amostrando: o alvo deixou de existir e insistir só
      // trocaria uma recusa honesta por um timeout.
      return { box: ultima, amostras, estabilizou: false, removido: true };
    }
    ultima = atual;
    if (anterior !== null && mesmaCaixa(anterior, atual)) {
      iguais += 1;
      if (iguais >= exigidas - 1) return { box: atual, amostras, estabilizou: true, removido: false };
    } else {
      iguais = 0;
    }
    anterior = atual;
    if (intervalo > 0) await pause(intervalo);
  }
  return { box: ultima, amostras, estabilizou: false, removido: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rolagem
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Traz o alvo para dentro do viewport.
 *
 * ORDEM DOS BACKENDS, E POR QUÊ:
 *
 *  1. `pointer.scroll` (CDP `Input.dispatchMouseEvent{mouseWheel}`) PRIMEIRO.
 *     É o mesmo caminho de input confiável que o clique usa: dispara `wheel` e
 *     `scroll` de verdade, com `isTrusted=true`, e por isso aciona lazy-load,
 *     scroll infinito e listeners de rolagem — coisas de que uma rolagem
 *     programática não dá notícia. É a rolagem que um humano produziria.
 *
 *  2. `Locator.scrollIntoViewIfNeeded()` como SEGUNDA tentativa. A roda age na
 *     posição do cursor: se o alvo estiver num contêiner aninhado que o ponto
 *     projetado não alcança, ela não chega lá. O `scrollIntoViewIfNeeded` é o
 *     "traga isto à vista" nativo do Chromium e resolve contêiner aninhado e
 *     rolagem horizontal. Ele NÃO é síntese de input, então não afeta o
 *     `isTrusted` do clique que vem depois — quem despacha o clique continua
 *     sendo o `Input` domain, e os testes provam `isTrusted===true` em todos os
 *     cliques entregues.
 *
 * Qual dos dois agiu vai em `backend`. Rolagem que não aparece no resultado
 * seria o mesmo fallback silencioso que a arquitetura proíbe.
 */
async function rolarParaDentro(
  page: Page,
  alvo: AlvoAcionavel,
  pointer: PointerEngine,
  cfg: AcionabilidadeConfig,
  vp: AreaVisivel,
  boxInicial: BoundingBox,
): Promise<{ backend: string; box: BoundingBox | null; amostras: number; removido: boolean; estabilizou: boolean }> {
  const backends: string[] = [];
  let box: BoundingBox | null = boxInicial;
  let amostras = 0;
  let removido = false;
  let estabilizou = true;

  const dentro = (b: BoundingBox | null): boolean => b !== null && pontoDentro(centroDe(b), vp);

  // Alvo por coordenada: a coordenada JÁ é do viewport. "Rolar até ela" não faz
  // sentido — rolar mudaria o que está sob o ponto, não traria o ponto para
  // dentro. Fora do viewport, resta recusar.
  if (alvo.loc === undefined) return { backend: "none", box, amostras: 0, removido: false, estabilizou: true };

  for (let t = 0; t < MAX_TENTATIVAS_ROLAGEM && !dentro(box); t += 1) {
    const c = centroDe(box!);
    // Ponto do cursor: a projeção do alvo dentro do viewport na primeira
    // tentativa (cai sobre o contêiner que precisa rolar) e o centro da tela na
    // segunda (quando a primeira não produziu progresso).
    const at =
      t === 0
        ? { x: clamp(c.x, 1, vp.width - 2), y: clamp(c.y, 1, vp.height - 2) }
        : { x: Math.floor(vp.width / 2), y: Math.floor(vp.height / 2) };
    const dx = Math.round(c.x - vp.width / 2);
    const dy = Math.round(c.y - vp.height / 2);
    if (dx === 0 && dy === 0) break;
    try {
      await pointer.scroll({ dx, dy }, { at });
      backends.push("cdp:wheel");
    } catch {
      break;
    }
    const est = await estabilizarCaixa(alvo, cfg);
    amostras += est.amostras;
    estabilizou = est.estabilizou;
    if (est.removido) return { backend: backends.join("+"), box: est.box, amostras, removido: true, estabilizou };
    if (est.box !== null && box !== null && mesmaCaixa(est.box, box)) {
      box = est.box;
      break; // Sem progresso: insistir com a roda só gastaria tempo.
    }
    box = est.box;
  }

  if (!dentro(box)) {
    try {
      await alvo.loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      backends.push("playwright:scrollIntoViewIfNeeded");
      const est = await estabilizarCaixa(alvo, cfg);
      amostras += est.amostras;
      estabilizou = est.estabilizou;
      removido = est.removido;
      box = est.box;
    } catch {
      // Falhou (elemento sumiu, sem caixa, timeout): a checagem de
      // acionabilidade logo abaixo é quem transforma isso em recusa tipada.
      backends.push("playwright:scrollIntoViewIfNeeded#falhou");
      box = await medir(alvo);
      removido = box === null;
    }
  }

  return { backend: backends.length === 0 ? "none" : backends.join("+"), box, amostras, removido, estabilizou };
}

// ─────────────────────────────────────────────────────────────────────────────
// Checagem no ponto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tag#id.classe` — identidade legível de quem está no ponto.
 *
 * O corpo é REPETIDO dentro de cada `evaluate` de propósito. A alternativa
 * óbvia — serializar a função e reconstruí-la com `eval` no lado da página —
 * quebraria em qualquer site com CSP sem `unsafe-eval`, ou seja, exatamente nos
 * sites que mais importam. Duplicar oito linhas é mais barato que uma defesa
 * que só funciona em página permissiva.
 */
interface NoPonto {
  descricao: string | null;
  acerto: boolean;
  visivel: boolean;
}

async function verNoPonto(page: Page, alvo: AlvoAcionavel, p: Point): Promise<NoPonto> {
  const arg = { x: p.x, y: p.y };
  if (alvo.loc === undefined) {
    // Alvo por coordenada não tem elemento esperado: o que estiver no ponto É o
    // alvo, por definição do descritor. Registramos quem é; não julgamos.
    return page.evaluate((a: { x: number; y: number }) => {
      const nomear = (el: Element | null): string | null => {
        if (el === null) return null;
        const t = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "?";
        const id = typeof el.id === "string" && el.id !== "" ? `#${el.id}` : "";
        let cls = "";
        const cn = el.getAttribute("class");
        if (cn !== null && cn.trim() !== "") cls = `.${cn.trim().split(/\s+/).slice(0, 3).join(".")}`;
        return `${t}${id}${cls}`;
      };
      const el = document.elementFromPoint(a.x, a.y);
      return { descricao: nomear(el), acerto: el !== null, visivel: true };
    }, arg);
  }
  return alvo.loc.evaluate((el: Element, a: { x: number; y: number }) => {
    const nomear = (x: Element | null): string | null => {
      if (x === null) return null;
      const t = typeof x.tagName === "string" ? x.tagName.toLowerCase() : "?";
      const id = typeof x.id === "string" && x.id !== "" ? `#${x.id}` : "";
      let cls = "";
      const cn = x.getAttribute("class");
      if (cn !== null && cn.trim() !== "") cls = `.${cn.trim().split(/\s+/).slice(0, 3).join(".")}`;
      return `${t}${id}${cls}`;
    };
    const no = document.elementFromPoint(a.x, a.y);
    const est = window.getComputedStyle(el);
    const visivel =
      est.visibility !== "hidden" && est.display !== "none" && Number(est.opacity) > 0 && el.isConnected;
    return {
      descricao: nomear(no),
      // Descendente conta (um <span> dentro do <button> entrega o clique ao
      // <button>). ANCESTRAL não conta: se o ponto cai no pai, o `target` do
      // evento é o pai e o alvo nem entra no caminho de propagação.
      acerto: no !== null && (no === el || el.contains(no)),
      visivel,
    };
  }, arg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fachada: garantir acionabilidade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executa as etapas 2 a 5. Devolve o ponto de clique recalculado e o detalhe
 * completo. LANÇA `TARGET_NOT_ACTIONABLE` quando o alvo não pode receber o
 * gesto — que é a diferença entre este runtime e o anterior: antes, esta função
 * não existia e o gesto ia para a coordenada de qualquer jeito.
 */
export async function garantirAcionavel(
  page: Page,
  alvo: AlvoAcionavel,
  pointer: PointerEngine,
  cfg: AcionabilidadeConfig,
): Promise<Acionavel> {
  const vp = await areaVisivel(page);
  const rolagemAntes = await rolagemDaJanela(page);

  const inicial = await estabilizarCaixa(alvo, cfg);
  const boxAntes = inicial.box;
  let amostras = inicial.amostras;
  let estabilizou = inicial.estabilizou;
  let removido = inicial.removido;
  let box = inicial.box;
  let backend = "none";

  if (cfg.scroll_into_view && !removido && box !== null && !pontoDentro(centroDe(box), vp)) {
    const r = await rolarParaDentro(page, alvo, pointer, cfg, vp, box);
    backend = r.backend;
    box = r.box;
    amostras += r.amostras;
    removido = r.removido;
    estabilizou = r.estabilizou && !r.removido;
  } else if (!cfg.scroll_into_view) {
    backend = "desligado";
  }

  const rolagemDepois = await rolagemDaJanela(page);
  const scrolled = { dx: rolagemDepois.x - rolagemAntes.x, dy: rolagemDepois.y - rolagemAntes.y };
  const ponto = box === null ? { x: 0, y: 0 } : centroDe(box);
  const dentro = box !== null && pontoDentro(ponto, vp);

  let noPonto: NoPonto = { descricao: null, acerto: false, visivel: false };
  if (box !== null && dentro && !removido) {
    try {
      noPonto = await verNoPonto(page, alvo, ponto);
    } catch {
      noPonto = { descricao: null, acerto: false, visivel: false };
    }
  }

  const detalhe: AcionabilidadeDetalhe = {
    box_antes: boxAntes,
    box_depois: box,
    scrolled,
    amostras_ate_estabilizar: amostras,
    stabilized_after: amostras,
    dentro_do_viewport: dentro,
    elemento_no_ponto: noPonto.descricao,
    backend,
    actionable: false,
    motivo: null,
    viewport: vp,
  };

  const recusa = (motivo: string): never => {
    detalhe.motivo = motivo;
    throw new InputError("TARGET_NOT_ACTIONABLE", `alvo não acionável: ${motivo} (${alvo.descricao})`, {
      ...detalhe,
    });
  };

  if (removido || box === null) recusa("alvo saiu do DOM antes do gesto");
  if (!estabilizou) recusa("caixa do alvo não assentou dentro do teto de amostras — alvo em movimento");
  // Área zero só condena ELEMENTO. Alvo por coordenada tem caixa {x,y,0,0} por
  // construção — reprovar por isso transformaria todo clique por coordenada em
  // recusa, que é inventar fracasso.
  if (alvo.loc !== undefined && (box!.width <= 0 || box!.height <= 0)) {
    recusa(`área zero (${box!.width}x${box!.height})`);
  }
  if (!dentro) {
    recusa(
      `centro (${ponto.x}, ${ponto.y}) fora do viewport ${vp.width}x${vp.height} mesmo após rolar (backend=${backend})`,
    );
  }
  if (alvo.loc !== undefined && !noPonto.visivel) recusa("elemento invisível (display/visibility/opacity)");
  if (alvo.loc !== undefined && !noPonto.acerto) {
    recusa(`coberto no ponto de clique por ${noPonto.descricao ?? "nada (ponto morto)"}`);
  }
  if (alvo.loc === undefined && noPonto.descricao === null) recusa("nenhum elemento sob a coordenada");

  detalhe.actionable = true;
  return { ponto, detalhe };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prova de entrega
// ─────────────────────────────────────────────────────────────────────────────

const CHAVE_ENTREGA = "__nomos_entrega__";

/**
 * Instala o listener de captura. Três nomes de evento porque o botão direito
 * não produz `click` no Chromium (produz `contextmenu`) e o do meio produz
 * `auxclick` — escutar só `click` reprovaria cliques que foram entregues.
 */
async function instalarListener(page: Page, alvo: AlvoAcionavel): Promise<void> {
  const chave = CHAVE_ENTREGA;
  if (alvo.loc === undefined) {
    await page.evaluate((k: string) => {
      const w = window as unknown as Record<string, unknown>;
      w[k] = null;
      const nomear = (x: Element | null): string | null => {
        if (x === null) return null;
        const t = typeof x.tagName === "string" ? x.tagName.toLowerCase() : "?";
        const id = typeof x.id === "string" && x.id !== "" ? `#${x.id}` : "";
        let cls = "";
        const cn = x.getAttribute("class");
        if (cn !== null && cn.trim() !== "") cls = `.${cn.trim().split(/\s+/).slice(0, 3).join(".")}`;
        return `${t}${id}${cls}`;
      };
      // `_self`/`_top`/`_parent` reaproveitam janela existente; qualquer outro
      // nome cria (ou troca para) outra aba. É isto que autoriza a espera pelo
      // evento `page` do contexto — e só isto.
      const abre = (t: Element | null): boolean => {
        if (t === null || typeof t.closest !== "function") return false;
        const a = t.closest("a[target], area[target], form[target]");
        if (a === null) return false;
        const alvo = (a.getAttribute("target") ?? "").trim().toLowerCase();
        return alvo !== "" && alvo !== "_self" && alvo !== "_top" && alvo !== "_parent";
      };
      const h = (ev: Event): void => {
        if (w[k] !== null) return;
        const me = ev as MouseEvent;
        const t = ev.target as Element | null;
        w[k] = {
          alvo_esperado: t !== null,
          elemento: nomear(t),
          isTrusted: ev.isTrusted,
          x: me.clientX,
          y: me.clientY,
          tipo: ev.type,
          abre_nova_aba: abre(t),
        };
      };
      for (const nome of ["click", "auxclick", "contextmenu"]) {
        document.addEventListener(nome, h, { capture: true, once: true });
      }
    }, chave);
    return;
  }
  await alvo.loc.evaluate((el: Element, k: string) => {
    const w = window as unknown as Record<string, unknown>;
    w[k] = null;
    const nomear = (x: Element | null): string | null => {
      if (x === null) return null;
      const t = typeof x.tagName === "string" ? x.tagName.toLowerCase() : "?";
      const id = typeof x.id === "string" && x.id !== "" ? `#${x.id}` : "";
      let cls = "";
      const cn = x.getAttribute("class");
      if (cn !== null && cn.trim() !== "") cls = `.${cn.trim().split(/\s+/).slice(0, 3).join(".")}`;
      return `${t}${id}${cls}`;
    };
    const abre = (t: Element | null): boolean => {
      if (t === null || typeof t.closest !== "function") return false;
      const a = t.closest("a[target], area[target], form[target]");
      if (a === null) return false;
      const destino = (a.getAttribute("target") ?? "").trim().toLowerCase();
      return destino !== "" && destino !== "_self" && destino !== "_top" && destino !== "_parent";
    };
    const h = (ev: Event): void => {
      if (w[k] !== null) return;
      const me = ev as MouseEvent;
      const t = ev.target as Element | null;
      w[k] = {
        // O alvo resolvido, ou descendente dele: um <span> dentro do <button>
        // entrega o clique ao <button>, e recusar isso reprovaria clique bom.
        alvo_esperado: t !== null && (t === el || el.contains(t)),
        elemento: nomear(t),
        isTrusted: ev.isTrusted,
        x: me.clientX,
        y: me.clientY,
        tipo: ev.type,
        abre_nova_aba: abre(t),
      };
    };
    for (const nome of ["click", "auxclick", "contextmenu"]) {
      document.addEventListener(nome, h, { capture: true, once: true });
    }
  }, chave);
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 4b — NAVEGAÇÃO É EVIDÊNCIA DE PRIMEIRA CLASSE
//
// O DEFEITO: clicar num `<a href>` que navega devolvia CLICK_NOT_DELIVERED. A
// navegação DESTRÓI o contexto de execução do frame principal e leva o registro
// da sonda junto; a leitura perdia a corrida. A FASE 4 já tinha uma nota sobre
// isso, e ela não pegava o caso por dois motivos:
//
//   1. o único sinal consultado era `page.url()`, que ainda aponta para a URL
//      ANTIGA durante os primeiros milissegundos da navegação;
//   2. o erro de "contexto destruído" era tratado como derrota IMEDIATA, sem
//      nenhuma janela de reconferência.
//
// A CORREÇÃO: além da sonda, a ação arma SINAIS antes do clique —
// `framenavigated` no frame principal e `page` no contexto (aba nova) — e a
// leitura ganha uma janela curta de reconferência. Sinal armado ANTES do clique
// só pode disparar por algo que aconteceu DEPOIS dele, e é por isso que ele é
// prova e não palpite.
//
// O QUE NÃO FOI AFROUXADO: um registro de sonda que aponta OUTRO elemento
// continua reprovando o clique mesmo que a página navegue ("entrega_errada").
// Prova positiva de entrega no lugar errado vence qualquer evidência indireta —
// senão bastaria um clique acidental que navega para tudo virar sucesso.
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenciaDeEntrega =
  | "listener"
  | "navegacao"
  | "nova_aba"
  | "entrega_errada"
  | "sem_prova"
  | "desligado";

export interface LeituraDeEntrega {
  registro: RegistroDeEntrega | null;
  evidencia: EvidenciaDeEntrega;
  url_antes: string;
  url_depois: string;
  navegou: boolean;
  nova_aba: boolean;
  /** A leitura da sonda estourou por destruição do contexto de execução. */
  contexto_destruido: boolean;
}

export interface SondaArmada {
  url_antes: string;
  ler: () => Promise<LeituraDeEntrega>;
  /** Solta os listeners de processo. Chamar SEMPRE (finally). */
  desarmar: () => void;
}

/** Erros que o Chromium/Playwright emitem quando a navegação matou o contexto. */
const CONTEXTO_DESTRUIDO =
  /Execution context was destroyed|Cannot find context|Target closed|Target crashed|frame was detached|Navigation to|page has been closed/i;

export function ehContextoDestruido(e: unknown): boolean {
  return CONTEXTO_DESTRUIDO.test(e instanceof Error ? e.message : String(e));
}

/**
 * Arma a prova de entrega: listener de captura NA PÁGINA + sinais de navegação
 * e de aba nova NO PROCESSO. Os dois últimos sobrevivem à destruição do contexto
 * de JS, que é exatamente onde o listener sozinho falhava.
 */
export async function armarSondaDeEntrega(page: Page, alvo: AlvoAcionavel): Promise<SondaArmada> {
  const url_antes = page.url();
  let navegou = false;
  let nova_aba = false;

  // `framenavigated` do frame PRINCIPAL. Subframe não conta: um iframe de
  // anúncio navegando sozinho não é prova de que o nosso clique chegou.
  const aoNavegar = (frame: Frame): void => {
    if (frame === page.mainFrame()) navegou = true;
  };
  const aoAbrirAba = (): void => {
    nova_aba = true;
  };
  const contexto = page.context();
  page.on("framenavigated", aoNavegar);
  contexto.on("page", aoAbrirAba);
  const desarmar = (): void => {
    page.off("framenavigated", aoNavegar);
    contexto.off("page", aoAbrirAba);
  };

  try {
    await instalarListener(page, alvo);
  } catch (e) {
    desarmar();
    throw e;
  }

  const ler = async (): Promise<LeituraDeEntrega> => {
    let registro: RegistroDeEntrega | null = null;
    let contexto_destruido = false;
    const limite = Date.now() + ESPERA_ENTREGA_MS;

    // A SONDA É CONSULTADA PRIMEIRO, SEMPRE.
    //
    // É o que mantém o caso da âncora (`href="#fim"`) provado pelo listener: uma
    // navegação de mesmo documento também dispara `framenavigated`, e se o sinal
    // tivesse precedência a âncora passaria a ser "provada" por navegação —
    // trocando uma prova forte por uma fraca sem necessidade.
    for (;;) {
      try {
        const r = await page.evaluate((chave: string) => {
          const w = window as unknown as Record<string, unknown>;
          return (w[chave] ?? null) as RegistroDeEntrega | null;
        }, CHAVE_ENTREGA);
        if (r !== null) {
          registro = r;
          break;
        }
      } catch (e) {
        if (!ehContextoDestruido(e)) throw e;
        contexto_destruido = true;
        break;
      }
      // Sem registro E já houve navegação de documento ou aba nova: o contexto
      // que guardava o registro morreu. Insistir só gastaria tempo.
      if (navegou || nova_aba || page.url() !== url_antes) break;
      if (Date.now() >= limite) break;
      await pause(PASSO_ENTREGA_MS);
    }

    // O clique declarou abrir aba: espera o evento `page` do contexto para poder
    // NOMEAR isso. A entrega já está provada pelo listener aqui — o que está em
    // jogo é a qualidade do relato, não o veredito.
    if (registro !== null && registro.abre_nova_aba && !nova_aba) {
      const limiteAba = Date.now() + ESPERA_NOVA_ABA_MS;
      while (!nova_aba && Date.now() < limiteAba) await pause(PASSO_ENTREGA_MS);
    }

    // JANELA DE RECONFERÊNCIA — só quando não há prova alguma ainda. A navegação
    // começa no clique mas leva alguns ms para aparecer em `page.url()`.
    if (registro === null && !navegou && !nova_aba && page.url() === url_antes) {
      for (let i = 0; i < RECONFERENCIAS_ENTREGA; i += 1) {
        await pause(RECONFERENCIA_MS);
        if (navegou || nova_aba || page.url() !== url_antes) break;
      }
    }

    const url_depois = page.url();
    const houveNavegacao = navegou || url_depois !== url_antes || contexto_destruido;

    let evidencia: EvidenciaDeEntrega;
    if (registro !== null && !registro.alvo_esperado) {
      // Prova POSITIVA de que o evento foi para outro elemento. Vence tudo.
      evidencia = "entrega_errada";
    } else if (nova_aba) {
      evidencia = "nova_aba";
    } else if (registro !== null) {
      evidencia = "listener";
    } else if (houveNavegacao) {
      evidencia = "navegacao";
    } else {
      evidencia = "sem_prova";
    }

    return { registro, evidencia, url_antes, url_depois, navegou, nova_aba, contexto_destruido };
  };

  return { url_antes, ler, desarmar };
}

/** Entrega comprovada? Uma única regra, para os dois chamadores não divergirem. */
export function entregaComprovada(leitura: LeituraDeEntrega): boolean {
  return leitura.evidencia === "listener" || leitura.evidencia === "navegacao" || leitura.evidencia === "nova_aba";
}
