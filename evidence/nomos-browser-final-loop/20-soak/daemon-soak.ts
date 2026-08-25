/**
 * FASE 20 — ENTRADA DE PROCESSO DO DAEMON SOB SOAK.
 *
 * POR QUE EXISTE (e por que não é `packages/api/src/daemon.ts` puro)
 * -----------------------------------------------------------------
 * O soak precisa, no MESMO processo de longa duração, de três coisas que os
 * dois entrypoints existentes nunca juntam:
 *
 *   1. motor de task exercitado sem depender de um LLM de texto — senão o que
 *      a série de RSS mediria seria a memória do modelo, não a do runtime;
 *   2. VISÃO viva, construída a partir da config, para a resolução por visão
 *      de 25 em 25 ciclos (`tests/fixtures/task/daemon-filho.ts` passa
 *      `vision: null` e portanto não serve);
 *   3. um processo separado de quem julga — não há como medir o RSS do daemon
 *      honestamente de dentro do próprio daemon.
 *
 * O agente é o mesmo `agente-scriptado` das fixtures: o PLANO é scriptado, a
 * EXECUÇÃO passa pela API real por loopback, com capability, lease, fila e
 * auditoria de verdade. Nada aqui fabrica sucesso.
 *
 * Env lida:
 *   NOMOS_TESTE_ROTEIRO   caminho do JSON com os passos (relido a cada plano)
 *   NOMOS_RUNTIME_DIR / NOMOS_BROWSER_* como no daemon de produção
 */
import { readFileSync } from "node:fs";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { agenteScriptado, type RoteiroDeAgente } from "../../../tests/fixtures/task/agente-scriptado.ts";
import { readControlToken } from "../../../packages/api/src/auth.ts";

const caminho = process.env.NOMOS_TESTE_ROTEIRO;
if (caminho === undefined) throw new Error("NOMOS_TESTE_ROTEIRO é obrigatório");
const lerRoteiro = (): RoteiroDeAgente => JSON.parse(readFileSync(caminho, "utf8")) as RoteiroDeAgente;

const porta = Number(process.env.NOMOS_BROWSER_PORT ?? "0");
const caixa: { token: string | null; base: string } = { token: null, base: `http://127.0.0.1:${porta}` };

const agente = agenteScriptado({
  name: "agente-scriptado-soak",
  base: () => caixa.base,
  token: () => caixa.token,
  roteiro: lerRoteiro,
});

// `vision` OMITIDO de propósito: ausente ⇒ `startDaemon` constrói a partir de
// `NOMOS_BROWSER_VISION_PROVIDER`. `null` desligaria a visão e o ciclo de visão
// mediria a ausência dela.
const handle = await startDaemon({
  agent: agente,
  ai_provider: null,
  ai_provider_fallback: null,
  install_signal_handlers: true,
  ...(process.env.NOMOS_RUNTIME_DIR !== undefined ? { runtime_dir: process.env.NOMOS_RUNTIME_DIR } : {}),
});
caixa.base = handle.url;
caixa.token = handle.token ?? readControlToken(process.env.NOMOS_RUNTIME_DIR);
process.stderr.write(`[soak] daemon em ${handle.url}\n`);
