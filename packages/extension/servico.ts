/**
 * NOMOS Browser — entrypoint de PRODUÇÃO (instalação pública).
 *
 * Diferenças deliberadas para o `launch.ts` (Developer Mode):
 *  - NÃO constrói a extensão: usa a `dist/` pré-construída que veio no
 *    artefato do release. O cofre de marca é ferramenta de quem PUBLICA, não
 *    dependência de quem instala.
 *  - NÃO exige variável de ambiente: `nomos-browser.config.json` na raiz da
 *    instalação (escrito pelo install.sh) define extensão, spotlight e
 *    ai_provider. Ambiente continua vencendo se o dono exportar.
 *  - Vive sob o LaunchAgent: fica em primeiro plano segurando o daemon filho;
 *    SIGTERM do launchd encerra os dois.
 *
 * O que ele mantém idêntico: daemon como processo filho (trava de instância,
 * prints e sinais dele valem), /health autenticado antes de declarar vivo,
 * sessão do dono criada para abrir a janela, token no clipboard (macOS).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(HERE, "../..");
const DAEMON = path.join(RAIZ, "packages/api/src/daemon.ts");
const DIST = path.join(HERE, "dist");
const PORT = Number(process.env["NOMOS_BROWSER_PORT"] ?? "7777");
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(path.join(DIST, "manifest.json"))) {
  console.error(`[nomos] ERRO: extensão não encontrada em ${DIST}.`);
  console.error("[nomos] Este entrypoint é do ARTEFATO de release (dist pré-construída).");
  console.error("[nomos] No repositório de desenvolvimento use: node packages/extension/launch.ts");
  process.exit(1);
}

// A extensão embarcada entra por ambiente (vence o arquivo de config — é o
// mesmo precedence do daemon). spotlight/ai_provider vêm do
// nomos-browser.config.json da raiz da instalação, que o daemon lê sozinho.
const env = {
  ...process.env,
  NOMOS_BROWSER_EXTENSION_DIR: process.env["NOMOS_BROWSER_EXTENSION_DIR"] ?? DIST,
};

const filho = spawn(process.execPath, [DAEMON], { env, stdio: ["ignore", "inherit", "inherit"] });
let encerrando = false;
filho.on("exit", (code) => {
  if (!encerrando) process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    encerrando = true;
    filho.kill(sig);
    process.exit(0);
  });
}

// /health exige credencial; o daemon grava o token no arranque — relê até vir.
const tokenPath = path.join(os.homedir(), ".nomos-browser", "control-token");
const ate = Date.now() + 45_000;
let token: string | null = null;
let vivo = false;
while (Date.now() < ate) {
  try { token = readFileSync(tokenPath, "utf8").trim(); } catch { /* ainda não gravou */ }
  if (token !== null) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) { vivo = true; break; }
    } catch { /* subindo */ }
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (!vivo) {
  console.error(`[nomos] ERRO: o daemon não respondeu em ${BASE}/health em 45 s — veja o log acima.`);
  filho.kill("SIGTERM");
  process.exit(1);
}

// Sessão do dono = a janela com o painel. Se já existir sessão viva (restart do
// serviço com daemon segurado por trava), não duplica.
if (token !== null) {
  try {
    const lista = (await (await fetch(`${BASE}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()) as Array<{ status: string }>;
    const viva = Array.isArray(lista) && lista.some((s) => s.status !== "CLOSED" && s.status !== "FAILED");
    if (!viva) {
      const r = await fetch(`${BASE}/api/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ owner: "dono", profile: "pessoal" }),
      });
      const corpo = (await r.json().catch(() => null)) as { session_id?: string } | null;
      console.error(r.ok && corpo?.session_id !== undefined
        ? `[nomos] sessão do dono aberta: ${corpo.session_id}`
        : `[nomos] ERRO ao abrir a sessão do dono: HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`[nomos] aviso: não consegui garantir a sessão do dono: ${(e as Error).message}`);
  }

  // O painel conecta sozinho pelo handshake de mesma origem que o daemon injeta
  // na extensão (ver daemon.ts / sidepanel.js). O token não vai para a área de
  // transferência; fica só no arquivo 0600, como fallback do caminho avançado.
  console.error(`[nomos] token de controle (fallback avançado) em: ${tokenPath}`);
}

mkdirSync(path.join(os.homedir(), ".nomos-browser", "logs"), { recursive: true });
console.error(
  "\n┌─ NOMOS Browser em serviço ─────────────────────────────\n" +
  "│ Janela do Chromium aberta. Clique no ícone NOMOS: o painel\n" +
  "│ abre ao lado JÁ conectado — é só conversar com a Gi.\n" +
  `│ (Avançado) runtime em ${BASE}. Parar: nomos-browser stop\n` +
  "└────────────────────────────────────────────────────────",
);
