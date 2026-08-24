/**
 * FILHO DE MENTIRA para os testes do Watchdog.
 *
 * NÃO é o daemon real: o teste do watchdog não pode depender de `packages/api`,
 * senão mediria a costura do daemon em vez do supervisor. Aqui só existe o que o
 * supervisor precisa observar — nascer, viver, morrer e obedecer (ou não) ao
 * SIGTERM.
 *
 * Cada arranque anexa uma linha ao arquivo em `NOMOS_FIXTURE_MARKER`. Essa é a
 * contagem INDEPENDENTE de reinícios: o contador interno do watchdog poderia
 * mentir, o disco não. Não imprime nada em stdout/stderr — supervisor silencioso
 * por padrão, e nada para vazar.
 *
 * Modos (`NOMOS_FIXTURE_MODE`):
 *   stay        vive até receber SIGTERM; sai com 0
 *   crash       sai imediatamente com NOMOS_FIXTURE_EXIT_CODE (default 7)
 *   crash_once  crasha só no PRIMEIRO arranque; do segundo em diante, vive
 *   ignore_term ignora SIGTERM (prova a escalada para SIGKILL no stop())
 *   listen      escuta em 127.0.0.1:NOMOS_FIXTURE_PORT e vive
 */
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";

const mode = process.env.NOMOS_FIXTURE_MODE ?? "stay";
const marker = process.env.NOMOS_FIXTURE_MARKER ?? "";
const exitCode = Number(process.env.NOMOS_FIXTURE_EXIT_CODE ?? "7");

/** Quantos arranques já houve ANTES deste, lidos do disco. */
function previousStarts(): number {
  if (marker === "") return 0;
  try {
    return readFileSync(marker, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

const before = previousStarts();
if (marker !== "") {
  appendFileSync(marker, `${JSON.stringify({ event: "start", pid: process.pid, mode, n: before + 1 })}\n`);
}

if (mode === "crash" || (mode === "crash_once" && before === 0)) {
  process.exit(Number.isInteger(exitCode) ? exitCode : 7);
}

function bye(signal: string): void {
  if (marker !== "") {
    appendFileSync(marker, `${JSON.stringify({ event: "signal", pid: process.pid, signal })}\n`);
  }
  process.exit(0);
}

if (mode !== "ignore_term") {
  process.on("SIGTERM", () => bye("SIGTERM"));
} else {
  // Handler vazio: recebe e NÃO sai — é o caso que obriga o SIGKILL.
  process.on("SIGTERM", () => {
    if (marker !== "") {
      appendFileSync(marker, `${JSON.stringify({ event: "ignored", pid: process.pid, signal: "SIGTERM" })}\n`);
    }
  });
}
process.on("SIGINT", () => bye("SIGINT"));

if (mode === "listen") {
  const port = Number(process.env.NOMOS_FIXTURE_PORT ?? "0");
  // Loopback sempre. Este fixture nunca aparece na rede.
  net.createServer().listen({ host: "127.0.0.1", port, exclusive: true });
}

// Timer REFERENCIADO: é o que mantém o processo vivo até um sinal chegar.
setInterval(() => undefined, 3_600_000);
