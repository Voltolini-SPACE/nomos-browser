/**
 * NOMOS Browser com agente embutido — o lançador do dono.
 *
 *   node packages/extension/launch.ts
 *
 * O que ele faz, na ordem:
 *
 *  1. Constrói a extensão do cofre vigente (`build.ts`) — a UI nasce com a
 *     marca do dia, nunca de um token copiado.
 *  2. Sobe o daemon como PROCESSO FILHO, pelo mesmo comando que o dono usaria
 *     (`node packages/api/src/daemon.ts`) — trava de instância única, prints e
 *     sinais do daemon continuam valendo. A primeira versão deste arquivo
 *     importava o daemon e confiava no efeito colateral; o daemon tem guarda de
 *     `import.meta.main` e NÃO subia. O teste de instalação real pegou.
 *  3. Espera o `/health` responder e CRIA A SESSÃO DO DONO (perfil "pessoal",
 *     headful): é ela que abre o Chromium com o painel embarcado. Sem sessão
 *     não há janela — e um lançador que termina sem janela não lançou nada.
 *  4. NÃO cola token. O daemon injeta um handshake de mesma origem
 *     (`local-runtime.json`) dentro da extensão que ele carregou, e o painel
 *     conecta sozinho ao abrir — clicar no ícone basta. O token fica só no
 *     arquivo 0600, como fallback do caminho avançado/remoto.
 *
 * O que ele NÃO faz: não liga `ai_provider` sozinho (runtime não fala com LLM
 * sem o dono pedir — exporte NOMOS_BROWSER_AI_PROVIDER=ollama:<modelo> antes),
 * e não desliga autenticação.
 *
 * Encerrar: Ctrl-C aqui derruba o daemon junto.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension } from "./build.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(HERE, "../api/src/daemon.ts");
const PORT = Number(process.env["NOMOS_BROWSER_PORT"] ?? "7777");
const BASE = `http://127.0.0.1:${PORT}`;

// 1. extensão do cofre
const ext = buildExtension();
console.error(`[nomos] extensão pronta em ${ext.dist} (${ext.selo})`);

// 2. daemon filho, com a experiência embutida ligada por ambiente
const env = {
  ...process.env,
  NOMOS_BROWSER_EXTENSION_DIR: ext.dist,
  NOMOS_BROWSER_SPOTLIGHT: process.env["NOMOS_BROWSER_SPOTLIGHT"] ?? "true",
  NOMOS_BROWSER_SPOTLIGHT_COLOR: process.env["NOMOS_BROWSER_SPOTLIGHT_COLOR"] ?? ext.corMarca,
};
const filho = spawn(process.execPath, [DAEMON], { env, stdio: ["ignore", "inherit", "inherit"] });
let encerrando = false;
filho.on("exit", (code) => {
  // Daemon caiu (ou já havia outro rodando — a trava de instância fala no log
  // acima). O lançador não tem por que sobreviver ao daemon.
  if (!encerrando) process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    encerrando = true;
    filho.kill(sig);
    process.exit(0);
  });
}

// 3. espera o /health — que exige credencial (o teste de instalação real pegou
//    o 401: a primeira versão sondava sem token e concluía, errado, que o
//    daemon não subiu). O token é gravado pelo próprio daemon no arranque, então
//    o laço relê o arquivo até ele existir. 30 s e erro claro, sem silêncio.
const tokenPath = path.join(os.homedir(), ".nomos-browser", "control-token");
const ate = Date.now() + 30_000;
let vivo = false;
let token: string | null = null;
while (Date.now() < ate) {
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch { /* daemon ainda não gravou */ }
  if (token !== null) {
    try {
      const r = await fetch(`${BASE}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) { vivo = true; break; }
    } catch { /* ainda subindo */ }
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (!vivo) {
  console.error(`[nomos] ERRO: o daemon não respondeu em ${BASE}/health em 30 s — veja as mensagens acima.`);
  filho.kill("SIGTERM");
  process.exit(1);
}

// sessão do dono — é ela que abre a janela do Chromium com o painel.
if (token !== null) {
  const r = await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ owner: "dono", profile: "pessoal" }),
  });
  const corpo = (await r.json().catch(() => null)) as { session_id?: string; error?: { message?: string } } | null;
  if (r.ok && corpo?.session_id !== undefined) {
    console.error(`[nomos] sessão do dono aberta: ${corpo.session_id} (perfil "pessoal")`);
  } else {
    console.error(`[nomos] ERRO ao abrir a sessão do dono: HTTP ${r.status} ${corpo?.error?.message ?? ""}`);
  }

  // 4. Nada de colar token. O daemon injeta um handshake de mesma origem
  //    (local-runtime.json) DENTRO da extensão que ele mesmo carregou, e o
  //    painel conecta sozinho ao abrir (ver daemon.ts / sidepanel.js). O token
  //    fica só no arquivo 0600, como fallback do caminho avançado/remoto.
  console.error(`[nomos] token de controle (fallback avançado) em: ${tokenPath}`);
}

console.error(
  "\n┌─ NOMOS Browser pronto ─────────────────────────────────\n" +
  "│ Na janela do Chromium que abriu, clique no ícone NOMOS\n" +
  "│ (quebra-cabeça → NOMOS; fixe na barra se quiser). O painel\n" +
  "│ abre ao lado JÁ conectado — é só conversar com a Gi.\n" +
  `│ (Avançado) runtime em ${BASE}. Ctrl-C aqui encerra tudo.\n` +
  "└────────────────────────────────────────────────────────",
);
