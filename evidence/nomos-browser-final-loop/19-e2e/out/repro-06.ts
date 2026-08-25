/**
 * REPRODUTOR MÍNIMO — cenários 6, 7, 8, 9, 10 e 17 (a CASCATA).
 *
 * SINTOMA: a partir do 5º cenário do bloco A, TODA criação de sessão voltou
 * `HTTP 429 BACKPRESSURE_REJECTED — worker pool cheio: 4/4`, e seis cenários
 * reprovaram em ~1 ms cada, sem chegar a medir coisa alguma.
 *
 * CAUSA RAIZ (do INSTRUMENTO): `max_workers` vale 4 por default, e o runtime
 * RECUSA em vez de enfileirar — que é o comportamento certo e declarado. A
 * bateria abria uma sessão por cenário e nunca fechava nenhuma. Quem abre, fecha.
 *
 * Este arquivo mostra o fato nu: N sessões cabem, a N+1 é recusada, e FECHAR uma
 * devolve a vaga. Nada aqui é defeito de produto — é a prova de que o instrumento
 * é que estava vazando recurso.
 *
 * CONSERTO APLICADO na bateria: `novaSessao` registra a sessão e o `finally` de
 * `cenario()` fecha todas — inclusive no caminho de falha.
 *
 * Uso: node evidence/nomos-browser-final-loop/19-e2e/out/repro-06.ts
 */
import { CAPS, daemonMinimo } from "./repro-comum.ts";

const TETO = 2; // pequeno de propósito: o defeito não depende do número
const d = await daemonMinimo({ NOMOS_BROWSER_MAX_WORKERS: String(TETO) });
let ok = false;
try {
  const criar = async (n: number): Promise<{ status: number; sid: string | null; code: string | null }> => {
    const r = await d.post<{ session_id?: string; error?: { code?: string } }>("/api/v1/sessions", {
      owner: `REPRO-06-${n}`,
      profile: "sandbox",
      headless: true,
      capabilities: CAPS,
    });
    return { status: r.status, sid: r.body.session_id ?? null, code: r.body.error?.code ?? null };
  };

  const vivas: string[] = [];
  for (let i = 1; i <= TETO; i += 1) {
    const c = await criar(i);
    console.log(`sessão ${i} (dentro do teto)   : http=${c.status} id=${c.sid ?? "-"} code=${c.code ?? "-"}`);
    if (c.sid !== null) vivas.push(c.sid);
  }

  const estourou = await criar(TETO + 1);
  console.log(`sessão ${TETO + 1} (além do teto)     : http=${estourou.status} code=${estourou.code}`);

  // Devolver a vaga: a recusa é de RECURSO, não de política.
  await fetch(`${d.url}/api/v1/sessions/${vivas[0]}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
    body: JSON.stringify({ reason: "repro" }),
  });
  const depoisDeFechar = await criar(TETO + 2);
  console.log(`sessão ${TETO + 2} após FECHAR uma    : http=${depoisDeFechar.status} id=${depoisDeFechar.sid ?? "-"} code=${depoisDeFechar.code ?? "-"}`);

  ok =
    vivas.length === TETO &&
    estourou.status === 429 &&
    estourou.code === "BACKPRESSURE_REJECTED" &&
    depoisDeFechar.sid !== null;
  console.log(`\nCONCLUSÃO: o pool recusa a N+1 e a vaga volta ao FECHAR = ${ok ? "CONFIRMADO" : "NÃO CONFIRMADO"}`);
  console.log(`REPRO_06=${ok ? "CONFIRMA_CAUSA_RAIZ" : "NAO_REPRODUZ"}`);
} finally {
  await d.fechar();
}
process.exit(ok ? 0 : 1);
