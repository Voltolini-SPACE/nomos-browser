/**
 * NOMOS Browser com agente embutido — lançador.
 *
 *   node packages/extension/launch.ts
 *
 * O que ele faz, na ordem, e por quê:
 *
 *  1. Constrói a extensão do cofre vigente (`build.ts`) — a UI nasce com a
 *     marca do dia, nunca de um token copiado.
 *  2. Exporta a configuração da experiência embutida por variável de ambiente:
 *     extensão carregada no Chromium do runtime, spotlight ligado, cor do
 *     destaque vinda do MESMO cofre. Não grava arquivo de config: quem quiser
 *     tornar isso permanente escreve `nomos-browser.config.json` por decisão.
 *  3. Entrega o processo ao daemon (`import` direto — mesmo processo, mesmo
 *     ciclo de vida, Ctrl-C funciona igual ao `npm run daemon`).
 *
 * O daemon imprime a URL do console e o caminho do token — o painel pede esse
 * token na primeira conexão. A extensão NÃO recebe o token automaticamente:
 * colar o token é o ato explícito que amarra o painel ao runtime certo.
 */
import { buildExtension } from "./build.ts";

const r = buildExtension();
console.error(`[embutido] extensão pronta em ${r.dist} (${r.selo})`);

process.env["NOMOS_BROWSER_EXTENSION_DIR"] = r.dist;
process.env["NOMOS_BROWSER_SPOTLIGHT"] = process.env["NOMOS_BROWSER_SPOTLIGHT"] ?? "true";
process.env["NOMOS_BROWSER_SPOTLIGHT_COLOR"] =
  process.env["NOMOS_BROWSER_SPOTLIGHT_COLOR"] ?? r.corMarca;

// O daemon lê o ambiente no arranque; daqui em diante o processo é dele.
await import("../api/src/daemon.ts");
