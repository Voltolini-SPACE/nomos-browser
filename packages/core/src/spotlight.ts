/**
 * Spotlight — FASE 10 da missão EMBEDDED_AGENT_UX.
 *
 * Antes de uma ação relevante (clique, digitação), o runtime destaca o elemento
 * NA PRÓPRIA página e acende um selo discreto "● NOMOS controlando".
 *
 * Por que isso mora no RUNTIME e não na extensão:
 *
 *  1. Menor privilégio (FASE 18). Um content script que desenha em qualquer
 *     página exigiria host permission ampla (`<all_urls>`). O runtime já possui
 *     a página via Playwright — desenhar por aqui não adiciona autoridade nova
 *     a ninguém.
 *  2. Toda superfície ganha o destaque de graça: painel, console, SDK, MCP.
 *
 * Invariantes:
 *  - `pointer-events: none` em tudo que é injetado. `elementFromPoint` ignora
 *    elemento com pointer-events:none, então a checagem de acionabilidade
 *    ("coberto no ponto") e a sonda de entrega NÃO são afetadas.
 *  - Best-effort DE VERDADE: falha aqui nunca derruba a ação. Uma página com
 *    javascript hostil, frame morto ou navegação no meio devolve `false` — e a
 *    ação segue seu caminho normal.
 *  - Nenhuma cor literal de marca no fonte (contrato de governança §6.3).
 *    Sem `spotlight_color` configurado, usa a cor de destaque do sistema
 *    (`Highlight`). O lançador com acesso ao cofre injeta a cor da marca por
 *    configuração.
 */
import type { Page } from "playwright";

export interface SpotlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpotlightOptions {
  /** Tempo que o destaque fica visível antes de sumir sozinho. */
  dwell_ms: number;
  /** Rótulo da ação, ex.: "clicar", "digitar". Vira texto do balão. */
  label: string;
  /** Cor CSS (vinda da configuração/cofre). null ⇒ `Highlight` do sistema. */
  color: string | null;
}

/**
 * Desenha o destaque e o selo. Resolve quando o desenho FOI FEITO (não espera
 * o dwell: quem espera é o chamador, se quiser que o humano veja antes do
 * gesto). Devolve false se a página não permitiu desenhar — nunca lança.
 */
export async function spotlight(page: Page, box: SpotlightBox, opts: SpotlightOptions): Promise<boolean> {
  const dwell = Math.max(0, Math.min(opts.dwell_ms, 5000));
  try {
    await page.evaluate(
      (arg: { b: SpotlightBox; rotulo: string; cor: string | null; ms: number }) => {
        const { b, rotulo, cor, ms } = arg;
        const ID = "__nomos_spotlight__";
        const SELO = "__nomos_selo__";
        const doc = document;
        const raiz = doc.documentElement;
        if (raiz === null) return;
        const corFinal = cor === null || cor === "" ? "Highlight" : cor;

        // moldura do alvo — recriada a cada chamada (a anterior é removida)
        doc.getElementById(ID)?.remove();
        const q = doc.createElement("div");
        q.id = ID;
        q.setAttribute("aria-hidden", "true");
        q.style.cssText =
          "position:fixed;pointer-events:none;z-index:2147483646;" +
          `left:${b.x - 3}px;top:${b.y - 3}px;width:${b.width + 6}px;height:${b.height + 6}px;` +
          `border:3px solid ${corFinal};border-radius:4px;` +
          "transition:opacity .25s ease-out;opacity:1;";
        const balao = doc.createElement("div");
        balao.style.cssText =
          "position:absolute;left:0;bottom:100%;margin-bottom:4px;" +
          `border:1px solid ${corFinal};color:${corFinal};` +
          "background:rgba(0,0,0,.82);padding:1px 7px;border-radius:3px;" +
          "font:11px/1.7 ui-monospace,monospace;white-space:nowrap;";
        balao.textContent = "NOMOS · " + rotulo;
        q.appendChild(balao);
        raiz.appendChild(q);
        setTimeout(() => {
          q.style.opacity = "0";
          setTimeout(() => q.remove(), 300);
        }, ms);

        // selo "● NOMOS controlando" — persistente, renovado a cada ação
        let selo = doc.getElementById(SELO);
        if (selo === null) {
          selo = doc.createElement("div");
          selo.id = SELO;
          selo.setAttribute("aria-hidden", "true");
          selo.style.cssText =
            "position:fixed;right:10px;bottom:10px;pointer-events:none;z-index:2147483647;" +
            `border:1px solid ${corFinal};color:${corFinal};` +
            "background:rgba(0,0,0,.82);padding:2px 9px;border-radius:10px;" +
            "font:11px/1.8 ui-monospace,monospace;transition:opacity .4s;";
          selo.textContent = "● NOMOS controlando";
          raiz.appendChild(selo);
        }
        selo.style.opacity = "1";
        const w = window as unknown as { __nomos_selo_t?: ReturnType<typeof setTimeout> };
        if (w.__nomos_selo_t !== undefined) clearTimeout(w.__nomos_selo_t);
        w.__nomos_selo_t = setTimeout(() => {
          const s = doc.getElementById(SELO);
          if (s !== null) {
            s.style.opacity = "0";
            setTimeout(() => s.remove(), 500);
          }
        }, ms + 1800);
      },
      {
        b: { x: box.x, y: box.y, width: box.width, height: box.height },
        rotulo: opts.label,
        cor: opts.color,
        ms: dwell,
      },
    );
    return true;
  } catch {
    // Página navegou, frame morreu, ou CSP hostil a evaluate: o destaque é
    // cortesia, não contrato. A ação nunca paga por ele.
    return false;
  }
}
