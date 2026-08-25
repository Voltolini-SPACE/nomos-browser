/**
 * REPRODUTOR MÍNIMO — cenário 5 (abas).
 *
 * SINTOMA: `browser.tabs` devolveu 3 abas onde a bateria exigia 2, e o cenário
 * reprovou.
 *
 * CAUSA RAIZ (do INSTRUMENTO, não do produto): a sessão nasce com uma aba, e
 * `browser.open` ABRE OUTRA — é o contrato (`docs/API.md`: `open` abre, `goto`
 * navega a corrente; `handlers.ts#handleOpen` chama `sessions.newPage`). A
 * bateria assumiu que `open` REUSARIA a aba em branco e cravou `n === 2`.
 *
 * Este arquivo mostra o fato nu, sem nenhuma expectativa embutida:
 *   abas ao criar a sessão  →  abas depois de UM browser.open
 *
 * CONSERTO APLICADO na bateria: medir por DELTA e IDENTIDADE (a listagem cresce
 * exatamente 1 no `new_tab`, encolhe exatamente 1 no `close_tab`, e a aba
 * fechada some por `page_id`), nunca por contagem absoluta.
 *
 * Uso: node evidence/nomos-browser-final-loop/19-e2e/out/repro-05.ts
 */
import { CAPS, daemonMinimo } from "./repro-comum.ts";

const d = await daemonMinimo();
let ok = false;
try {
  const s = await d.post<{ session_id: string }>("/api/v1/sessions", {
    owner: "REPRO-05",
    profile: "sandbox",
    headless: true,
    capabilities: CAPS,
  });
  const sid = s.body.session_id;

  const abas = async (): Promise<string[]> =>
    ((await d.post<{ result: { page_id: string }[] }>("/api/v1/browser.tabs", { session_id: sid })).body.result ?? []).map((a) => a.page_id);

  const antes = await abas();
  const aberta = await d.post<{ result: { page_id: string } }>("/api/v1/browser.open", {
    session_id: sid,
    url: "about:blank",
  });
  const depois = await abas();

  console.log(`abas ao criar a sessão      : ${antes.length}  ${JSON.stringify(antes)}`);
  console.log(`page_id devolvido pelo open : ${aberta.body.result?.page_id}`);
  console.log(`abas depois de UM open      : ${depois.length}  ${JSON.stringify(depois)}`);
  ok = depois.length === antes.length + 1 && !antes.includes(aberta.body.result!.page_id);
  console.log(`\nCONCLUSÃO: browser.open ABRE UMA ABA NOVA (não reusa a inicial) = ${ok ? "CONFIRMADO" : "NÃO CONFIRMADO"}`);
  console.log(`REPRO_05=${ok ? "CONFIRMA_CAUSA_RAIZ" : "NAO_REPRODUZ"}`);
} finally {
  await d.fechar();
}
process.exit(ok ? 0 : 1);
