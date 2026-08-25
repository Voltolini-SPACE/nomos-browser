/**
 * FASE 19 — daemon filho que emite DUAS CREDENCIAIS DISTINTAS.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * "Handoff entre dois donos com credenciais distintas" só é demonstrável com
 * DUAS IDENTIDADES de verdade. Identidade, neste runtime, é o SUJEITO DE UM
 * TOKEN — e não o header `x-nomos-client`, que é auto-declarado e não prova
 * nada. Não existe rota HTTP de emissão de token (e não deveria existir), então
 * quem emite é quem tem o `AuthManager` na mão: o processo do daemon.
 *
 * Este entrypoint é o `packages/api/src/daemon.ts` de sempre — mesma config,
 * mesmo `startDaemon` — com DUAS linhas a mais: emite `DONO-A` e `DONO-B` com
 * o preset `full` (que NÃO inclui ADMIN: tomar o volante à força continua sendo
 * ato do operador humano) e grava cada segredo em `runtime_dir` com modo 600.
 *
 * O daemon continua em PROCESSO SEPARADO do juiz — que é o ponto de tudo isto.
 */
import fs from "node:fs";
import path from "node:path";
import { startDaemon } from "../../../packages/api/src/daemon.ts";

const runtime_dir = process.env.NOMOS_RUNTIME_DIR;
if (runtime_dir === undefined) throw new Error("NOMOS_RUNTIME_DIR é obrigatório");

const handle = await startDaemon({
  install_signal_handlers: true,
  runtime_dir,
});

for (const sujeito of ["DONO-A", "DONO-B"]) {
  const emitido = handle.auth.issue({ subject: sujeito, preset: "full" });
  const alvo = path.join(runtime_dir, `token-${sujeito.toLowerCase()}`);
  fs.writeFileSync(alvo, emitido.secret, { encoding: "utf8", mode: 0o600 });
}

process.stderr.write(`nomos-browser em ${handle.url} — dois donos emitidos\n`);
