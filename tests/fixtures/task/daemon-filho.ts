/**
 * FASE 9 — daemon como PROCESSO SEPARADO, com agente determinístico.
 *
 * Existe por um motivo que não tem atalho: para provar recuperação de crash é
 * preciso MATAR o runtime com `SIGKILL`, e não dá para SIGKILLar o processo que
 * está rodando o próprio teste. `tests/product02-gate.test.ts` já sobe
 * `packages/api/src/daemon.ts` assim; a diferença aqui é que aquele entrypoint
 * constrói o agente a partir da CONFIG (ou seja, exige um LLM), e o teste do
 * motor de task não pode depender de modelo. Este arquivo é o mesmo daemon, com
 * um `AgentProvider` scriptado injetado.
 *
 * Env que ele lê:
 *   NOMOS_TESTE_ROTEIRO   caminho do JSON com os passos do plano
 *   NOMOS_TESTE_MATAR_EM  (opcional) índice 1-based do passo em que o processo
 *                         se mata com SIGKILL — o crash acontece NO MEIO de uma
 *                         task de verdade, não entre duas execuções
 *   NOMOS_BROWSER_PORT / NOMOS_SESSIONS_ROOT / NOMOS_RUNTIME_DIR  como sempre
 */
import { readFileSync } from "node:fs";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { agenteScriptado, type RoteiroDeAgente } from "./agente-scriptado.ts";
import { readControlToken } from "../../../packages/api/src/auth.ts";

const caminho = process.env.NOMOS_TESTE_ROTEIRO;
if (caminho === undefined) throw new Error("NOMOS_TESTE_ROTEIRO é obrigatório");
/**
 * Relido a CADA planejamento, não uma vez no arranque.
 *
 * A prova E2E roda várias tasks contra o MESMO daemon filho (subir um Chromium
 * por task custaria minutos e memória que esta máquina não tem). Cada task tem
 * o seu plano, então o roteiro precisa poder mudar entre elas — e ler o arquivo
 * no `plan()` é o jeito mais simples de fazer isso sem inventar um canal de
 * controle novo.
 */
const lerRoteiro = (): RoteiroDeAgente => JSON.parse(readFileSync(caminho, "utf8")) as RoteiroDeAgente;
const matarEm = process.env.NOMOS_TESTE_MATAR_EM !== undefined ? Number(process.env.NOMOS_TESTE_MATAR_EM) : null;
const porta = Number(process.env.NOMOS_BROWSER_PORT ?? "0");

// O token do daemon só existe DEPOIS de `startDaemon`; o agente precisa dele
// para o loopback. A caixa mutável resolve a ordem sem duplicar o daemon.
const caixa: { token: string | null; base: string } = { token: null, base: `http://127.0.0.1:${porta}` };

const agente = agenteScriptado({
  name: "agente-scriptado-filho",
  base: () => caixa.base,
  token: () => caixa.token,
  roteiro: lerRoteiro,
  onBeforeStep: (_step, n) => {
    if (matarEm !== null && n === matarEm) {
      // SIGKILL em si mesmo: nada de `process.exit()`, que roda handlers de
      // saída e daria ao daemon a chance de encerrar limpo. Um crash limpo não
      // é crash — e a task tem de ficar `RUNNING` no disco, que é exatamente o
      // estado mentiroso que a recuperação existe para desfazer.
      process.kill(process.pid, "SIGKILL");
    }
  },
});

const handle = await startDaemon({
  agent: agente,
  vision: null,
  ai_provider: null,
  ai_provider_fallback: null,
  install_signal_handlers: true,
  // `runtime_dir` NÃO é lido do ambiente por `startDaemon`: quem o lê é quem
  // chama. Sem esta linha o token do daemon ia parar em `~/.nomos-browser` e o
  // teste (que aponta para um diretório temporário) não o acharia.
  ...(process.env.NOMOS_RUNTIME_DIR !== undefined ? { runtime_dir: process.env.NOMOS_RUNTIME_DIR } : {}),
});
caixa.base = handle.url;
caixa.token = handle.token ?? readControlToken(process.env.NOMOS_RUNTIME_DIR);
process.stderr.write(`[filho] daemon em ${handle.url}\n`);
