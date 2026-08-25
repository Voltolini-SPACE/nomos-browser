/**
 * FASE 11 — BATERIA ADVERSARIAL COMPLETA CONTRA O DAEMON REAL
 *
 * POR QUE ESTE ARQUIVO EXISTE AO LADO DA BATERIA ANTERIOR
 * ------------------------------------------------------
 * `evidence/nomos-browser-final-validation/05-security/prova-guardas-vivos.ts`
 * cobre 16 vetores e continua valendo — ele NÃO é alterado por esta fase. O que
 * ele não cobria é o que o `docs/SECURITY.md` declarava, verbatim, como gap
 * aberto no T7: autenticação de WebSocket e autorização MCP. E não cobria mais
 * seis coisas que um atacante local tentaria antes de desistir: corpo
 * malformado, corpo gigante, escalada de capability, sequestro de sessão por
 * token de outra sessão, replay de credencial revogada/expirada, vazamento de
 * segredo em erro/evento/trilha, e fuga por symlink.
 *
 * REGRA DESTA BATERIA
 * -------------------
 * Todo vetor tem um CONTROLE POSITIVO em algum lugar da suíte. Uma bateria em
 * que tudo é bloqueado pode estar medindo um daemon quebrado: se nada funciona,
 * nada passa, e o placar fica verde por acidente. Por isso o grupo
 * `CONTROLES_POSITIVOS` — ele PRECISA passar, e o placar reprova se não passar.
 *
 * Nada aqui é simulado: daemon real, Chromium real, WebSocket real, servidor MCP
 * real. As recusas conferidas são as que saem pelo socket.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { createMcpServer } from "../../../packages/mcp/src/server.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-sec-"));
const RAIZ_SESSOES = path.join(TMP, "sessions");
const RAIZ_UPLOAD = path.join(TMP, "upload");
const RAIZ_DOWNLOAD = path.join(TMP, "download");
for (const dir of [RAIZ_SESSOES, RAIZ_UPLOAD, RAIZ_DOWNLOAD]) fs.mkdirSync(dir, { recursive: true });

// Arquivo legítimo dentro da raiz, e um SYMLINK que aponta para fora dela.
fs.writeFileSync(path.join(RAIZ_UPLOAD, "ok.txt"), "conteudo legitimo\n");
const ELO = path.join(RAIZ_UPLOAD, "fuga.txt");
try {
  fs.symlinkSync("/etc/passwd", ELO);
} catch {
  // Sistema sem permissão de symlink: o vetor sai como não-aplicável, jamais
  // como "passou".
}

// ─────────────────────────────────────────────────────────────────────────────
// Placar
// ─────────────────────────────────────────────────────────────────────────────

type Grupo =
  | "REST_AUTH"
  | "WEBSOCKET_AUTH"
  | "MCP_AUTHORIZATION"
  | "SSRF_PROTECTION"
  | "FILESYSTEM_PROTECTION"
  | "CAPABILITY_ENFORCEMENT"
  | "SECRET_LEAK_TEST"
  | "INPUT_HARDENING"
  | "SESSION_ISOLATION"
  | "CONTROLES_POSITIVOS";

interface Vetor {
  grupo: Grupo;
  nome: string;
  /** "bloqueio" = tem de ser recusado; "permitido" = controle positivo. */
  tipo: "bloqueio" | "permitido";
  observado: string;
  ok: boolean;
  na?: boolean;
}

const R: Vetor[] = [];
/** Todo corpo de resposta que passou por aqui — usado no teste de vazamento. */
const CORPOS: string[] = [];

async function vetor(
  grupo: Grupo,
  nome: string,
  tipo: "bloqueio" | "permitido",
  fn: () => Promise<{ ok: boolean; obs: string; na?: boolean }>,
): Promise<void> {
  let r: { ok: boolean; obs: string; na?: boolean };
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, obs: `lançou inesperadamente: ${(e as Error).message}` };
  }
  R.push({ grupo, nome, tipo, observado: r.obs, ok: r.ok, ...(r.na === true ? { na: true } : {}) });
  const marca = r.na === true ? "N/A      " : r.ok ? (tipo === "bloqueio" ? "BLOQUEOU " : "PERMITIU ") : "FALHOU!! ";
  console.log(`${marca} [${grupo}] ${nome.padEnd(52)} ${r.obs}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon sob ataque
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BODY = 4096;

const d = await startDaemon({
  host: "127.0.0.1",
  port: 0,
  headless: true,
  // POSTURA DE PRODUÇÃO: sem allow_internal.
  sessions_root: RAIZ_SESSOES,
  upload_root: RAIZ_UPLOAD,
  download_root: RAIZ_DOWNLOAD,
  // Teto pequeno de propósito: provar a defesa de corpo gigante não deve custar
  // um megabyte de tráfego por execução.
  max_body_bytes: MAX_BODY,
  vision: null,
  agent: null,
  ai_provider: null,
  vision_provider: null,
  read_file: false,
  env: {},
} as never);

const BASE = d.url;
const ROOT_TOKEN = d.token!;

// Credenciais com poderes DIFERENTES — é o que torna a escalada mensurável.
const T_OBSERVADOR = d.auth.issue({ subject: "observador", preset: "observe" }).secret;
const T_AGENTE = d.auth.issue({ subject: "agente", preset: "agent" }).secret;
const T_REVOGADO = d.auth.issue({ subject: "revogado", preset: "agent" });
const T_EXPIRADO = d.auth.issue({ subject: "expirado", preset: "agent", ttl_ms: 1 });
d.auth.revoke(T_REVOGADO.token_id);

interface Res {
  status: number;
  env: Record<string, unknown> & { success?: boolean; error?: { code?: string; detail?: Record<string, unknown> } };
  texto: string;
}

async function req(
  metodo: string,
  rota: string,
  corpo: unknown,
  token: string | null = ROOT_TOKEN,
  cru?: string,
): Promise<Res> {
  const r = await fetch(`${BASE}${rota}`, {
    method: metodo,
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(cru !== undefined ? { body: cru } : corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const texto = await r.text();
  CORPOS.push(texto);
  let env: Record<string, unknown> = {};
  try {
    env = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    env = { __nao_json: texto.slice(0, 200) };
  }
  return { status: r.status, env: env as Res["env"], texto };
}

const post = (rota: string, corpo: unknown, token: string | null = ROOT_TOKEN): Promise<Res> =>
  req("POST", rota, corpo, token);

/** Recusado = não veio `success:true` e o status não é 2xx. */
const recusado = (r: Res): boolean => r.env.success !== true && (r.status < 200 || r.status >= 300);

// Sessão-alvo: capabilities restritas de propósito (send/purchase/etc negados).
const CAPS_BASE = {
  navigate: true, read: true, click: true, type: true,
  download: true, upload: true, send: false, purchase: false, payment: false, delete: false,
};
const criada = await post("/api/v1/sessions", { owner: "ADVERSARIO", capabilities: CAPS_BASE, headless: true });
const SID = String(criada.env.session_id ?? "");
if (SID === "") {
  console.error("bateria: não consegui criar a sessão-alvo:", criada.texto.slice(0, 300));
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. AUTENTICAÇÃO REST
// ═════════════════════════════════════════════════════════════════════════════

await vetor("REST_AUTH", "sem credencial", "bloqueio", async () => {
  const r = await post("/api/v1/browser.tabs", { session_id: SID }, null);
  return { ok: r.status === 401, obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("REST_AUTH", "credencial inventada", "bloqueio", async () => {
  const r = await post("/api/v1/browser.tabs", { session_id: SID }, "nao-sou-um-token-de-verdade");
  return { ok: r.status === 401, obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)}` };
});

await vetor("REST_AUTH", "replay de credencial REVOGADA", "bloqueio", async () => {
  const r = await post("/api/v1/browser.tabs", { session_id: SID }, T_REVOGADO.secret);
  return {
    ok: r.status === 401 && r.env.error?.detail?.auth === "REVOKED_CREDENTIAL",
    obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)}`,
  };
});

await vetor("REST_AUTH", "replay de credencial EXPIRADA", "bloqueio", async () => {
  await new Promise((x) => setTimeout(x, 20));
  const r = await post("/api/v1/browser.tabs", { session_id: SID }, T_EXPIRADO.secret);
  return {
    ok: r.status === 401 && r.env.error?.detail?.auth === "EXPIRED_CREDENTIAL",
    obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)}`,
  };
});

await vetor("REST_AUTH", "UI (/) sem credencial", "bloqueio", async () => {
  const r = await fetch(`${BASE}/`);
  CORPOS.push(await r.text());
  return { ok: r.status === 401, obs: `status=${r.status}` };
});

await vetor("REST_AUTH", "screenshots sem credencial", "bloqueio", async () => {
  const r = await fetch(`${BASE}/screenshots/${SID}/qualquer.png`);
  CORPOS.push(await r.text());
  return { ok: r.status === 401, obs: `status=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. AUTENTICAÇÃO DE WEBSOCKET  (o T7 declarado em SECURITY.md)
// ═════════════════════════════════════════════════════════════════════════════

interface Handshake {
  desfecho: "aberto" | "recusado" | "erro" | "mudo";
  status: number | null;
  detalhe: string;
}

/**
 * Um WebSocket ACEITO e MUDO é indistinguível de um negado — do ponto de vista
 * do cliente, os dois "não entregam evento". Por isso este apoio distingue os
 * quatro desfechos, e o teste exige `recusado` COM status, não apenas silêncio.
 */
function apertoDeMao(url: string, headers: Record<string, string> = {}): Promise<Handshake> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const prazo = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* já morto */
      }
      resolve({ desfecho: "mudo", status: null, detalhe: "handshake sem resposta em 5s" });
    }, 5_000);
    ws.on("open", () => {
      clearTimeout(prazo);
      ws.close();
      resolve({ desfecho: "aberto", status: 101, detalhe: "conexão estabelecida" });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(prazo);
      resolve({ desfecho: "recusado", status: res.statusCode ?? null, detalhe: `HTTP ${res.statusCode}` });
      res.destroy();
    });
    ws.on("error", (e: Error) => {
      clearTimeout(prazo);
      resolve({ desfecho: "erro", status: null, detalhe: e.message });
    });
  });
}

const WSBASE = `ws://127.0.0.1:${d.port}/events`;

await vetor("WEBSOCKET_AUTH", "upgrade sem credencial", "bloqueio", async () => {
  const h = await apertoDeMao(WSBASE);
  return {
    ok: h.desfecho === "recusado" && h.status === 401,
    obs: `desfecho=${h.desfecho} status=${h.status} (${h.detalhe})`,
  };
});

await vetor("WEBSOCKET_AUTH", "upgrade com credencial inválida", "bloqueio", async () => {
  const h = await apertoDeMao(WSBASE, { authorization: "Bearer token-que-nao-existe" });
  return { ok: h.desfecho === "recusado" && h.status === 401, obs: `desfecho=${h.desfecho} status=${h.status}` };
});

await vetor("WEBSOCKET_AUTH", "upgrade com credencial REVOGADA", "bloqueio", async () => {
  const h = await apertoDeMao(WSBASE, { authorization: `Bearer ${T_REVOGADO.secret}` });
  return { ok: h.desfecho === "recusado" && h.status === 401, obs: `desfecho=${h.desfecho} status=${h.status}` };
});

await vetor("WEBSOCKET_AUTH", "querystring ?token= inválido", "bloqueio", async () => {
  const h = await apertoDeMao(`${WSBASE}?token=invalido-de-proposito`);
  return { ok: h.desfecho === "recusado" && h.status === 401, obs: `desfecho=${h.desfecho} status=${h.status}` };
});

await vetor("WEBSOCKET_AUTH", "credencial válida por HEADER conecta", "permitido", async () => {
  const h = await apertoDeMao(WSBASE, { authorization: `Bearer ${ROOT_TOKEN}` });
  return { ok: h.desfecho === "aberto", obs: `desfecho=${h.desfecho} status=${h.status} (${h.detalhe})` };
});

await vetor("WEBSOCKET_AUTH", "credencial válida por ?token= conecta", "permitido", async () => {
  // Aceita porque há cliente WS que não manda header. O RISCO — token em URL,
  // que vai para histórico de shell e log de proxy — está documentado no T7 do
  // SECURITY.md e mitigado aqui: o runtime não registra a URL do upgrade.
  const h = await apertoDeMao(`${WSBASE}?token=${encodeURIComponent(ROOT_TOKEN)}`);
  return { ok: h.desfecho === "aberto", obs: `desfecho=${h.desfecho} status=${h.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. AUTORIZAÇÃO MCP
// ═════════════════════════════════════════════════════════════════════════════

await vetor("MCP_AUTHORIZATION", "servidor MCP sem NOMOS_BROWSER_TOKEN", "bloqueio", async () => {
  const antes = fs.readdirSync(RAIZ_SESSOES).length;
  const srv = createMcpServer({ runtimeUrl: BASE, timeoutMs: 5_000, token: null });
  const out = await srv.callTool("browser_observe", {});
  const texto = out.content.map((c) => c.text).join("\n");
  CORPOS.push(texto);
  const depois = fs.readdirSync(RAIZ_SESSOES).length;
  return {
    // Recusa LOCAL: além de `isError`, nenhuma sessão nova nasceu no runtime.
    ok: out.isError === true && /MCP_NO_CREDENTIAL/.test(texto) && depois === antes,
    obs: `isError=${out.isError} sessoes_antes=${antes} depois=${depois}`,
  };
});

await vetor("MCP_AUTHORIZATION", "MCP com credencial de ESCOPO INSUFICIENTE", "bloqueio", async () => {
  const srv = createMcpServer({ runtimeUrl: BASE, timeoutMs: 20_000, token: T_OBSERVADOR });
  const out = await srv.callTool("browser_click", { target: { selector: "#x" }, session_id: SID });
  const texto = out.content.map((c) => c.text).join("\n");
  CORPOS.push(texto);
  return { ok: out.isError === true, obs: `isError=${out.isError} ${texto.split("\n")[0]}` };
});

await vetor("MCP_AUTHORIZATION", "whoami revela poderes, nunca o segredo", "permitido", async () => {
  const srv = createMcpServer({ runtimeUrl: BASE, timeoutMs: 10_000, token: T_AGENTE });
  const eu = await srv.whoami();
  const texto = JSON.stringify(eu);
  CORPOS.push(texto);
  const scopes = (eu?.scopes ?? []) as string[];
  return {
    ok: eu !== null && eu.subject === "agente" && scopes.includes("CONTROL") && !texto.includes(T_AGENTE),
    obs: `subject=${String(eu?.subject)} scopes=${scopes.join("|")} segredo_no_corpo=${texto.includes(T_AGENTE)}`,
  };
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SSRF E ESQUEMAS DE URL
// ═════════════════════════════════════════════════════════════════════════════

const SSRF: [string, string][] = [
  ["metadata da nuvem 169.254.169.254", "http://169.254.169.254/latest/meta-data/"],
  ["RFC1918 10.0.0.1", "http://10.0.0.1/"],
  ["RFC1918 192.168.0.1", "http://192.168.0.1/admin"],
  ["loopback explícito", "http://127.0.0.1:7777/api/v1/sessions"],
  ["mDNS .local", "http://roteador.local/"],
  ["file:///etc/passwd", "file:///etc/passwd"],
  ["javascript: URL", "javascript:alert(1)"],
  ["data: URL", "data:text/html,<h1>x</h1>"],
  ["chrome://settings", "chrome://settings"],
  ["devtools://", "devtools://devtools/bundled/inspector.html"],
];
for (const [nome, url] of SSRF) {
  await vetor("SSRF_PROTECTION", nome, "bloqueio", async () => {
    const r = await post("/api/v1/browser.goto", { session_id: SID, url });
    return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. SISTEMA DE ARQUIVOS
// ═════════════════════════════════════════════════════════════════════════════

await vetor("FILESYSTEM_PROTECTION", "upload com traversal", "bloqueio", async () => {
  const r = await post("/api/v1/browser.upload", {
    session_id: SID, target: { selector: "#f" }, path: "../../../../etc/passwd",
  });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("FILESYSTEM_PROTECTION", "upload com caminho absoluto fora da raiz", "bloqueio", async () => {
  const r = await post("/api/v1/browser.upload", { session_id: SID, target: { selector: "#f" }, path: "/etc/hosts" });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("FILESYSTEM_PROTECTION", "upload por SYMLINK que aponta para fora da raiz", "bloqueio", async () => {
  if (!fs.existsSync(ELO)) return { ok: true, na: true, obs: "symlink não pôde ser criado neste sistema" };
  // O caminho PEDIDO está dentro da raiz; o REAL, não. É a fuga que validação
  // puramente lexical não pega.
  const r = await post("/api/v1/browser.upload", { session_id: SID, target: { selector: "#f" }, path: ELO });
  return { ok: r.env.success !== true, obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("FILESYSTEM_PROTECTION", "upload com BYTE NULO no caminho", "bloqueio", async () => {
  // Construído em código, nunca escrito literalmente: um byte nulo num arquivo
  // de fonte é convite a corrupção silenciosa de ferramenta.
  const caminho = `${RAIZ_UPLOAD}/ok.txt${String.fromCharCode(0)}.png`;
  const r = await post("/api/v1/browser.upload", { session_id: SID, target: { selector: "#f" }, path: caminho });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("FILESYSTEM_PROTECTION", "download de file://", "bloqueio", async () => {
  const r = await post("/api/v1/browser.download", { session_id: SID, url: "file:///etc/passwd" });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("FILESYSTEM_PROTECTION", "screenshot com traversal na rota", "bloqueio", async () => {
  const r = await fetch(`${BASE}/screenshots/${SID}/..%2F..%2F..%2Fetc%2Fpasswd`, {
    headers: { authorization: `Bearer ${ROOT_TOKEN}` },
  });
  CORPOS.push(await r.text());
  return { ok: r.status === 404, obs: `status=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. CAPABILITY: NEGADA E DEPOIS CONCEDIDA
// ═════════════════════════════════════════════════════════════════════════════

await vetor("CAPABILITY_ENFORCEMENT", "ação sem capability (send) é negada", "bloqueio", async () => {
  const r = await post("/api/v1/browser.send", { session_id: SID });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("CAPABILITY_ENFORCEMENT", "ferramenta fora do contrato é negada", "bloqueio", async () => {
  const r = await post("/api/v1/browser.rm_rf", { session_id: SID });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("CAPABILITY_ENFORCEMENT", "capability não se concede pelo CORPO do pedido", "bloqueio", async () => {
  const r = await post("/api/v1/browser.send", { session_id: SID, capabilities: { send: true } });
  return { ok: recusado(r), obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("CAPABILITY_ENFORCEMENT", "escopo insuficiente no token (observador clica)", "bloqueio", async () => {
  const r = await post("/api/v1/browser.click", { session_id: SID, target: { selector: "#x" } }, T_OBSERVADOR);
  return {
    ok: r.status === 403 && r.env.error?.detail?.auth === "SCOPE_DENIED",
    obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)} exigido=${String(r.env.error?.detail?.required_scope)}`,
  };
});

await vetor("CAPABILITY_ENFORCEMENT", "escalada: takeover exige ADMIN, agente não tem", "bloqueio", async () => {
  const r = await post(`/api/v1/sessions/${SID}/lease/takeover`, {}, T_AGENTE);
  return { ok: r.status === 403, obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)}` };
});

await vetor("CAPABILITY_ENFORCEMENT", "escalada: delegar identidade exige ADMIN", "bloqueio", async () => {
  const r = await fetch(`${BASE}/api/v1/browser.observe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${T_AGENTE}`,
      "x-nomos-on-behalf-of": "daemon-root",
    },
    body: JSON.stringify({ session_id: SID }),
  });
  CORPOS.push(await r.text());
  return { ok: r.status === 403, obs: `status=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. ISOLAMENTO / SEQUESTRO DE SESSÃO
// ═════════════════════════════════════════════════════════════════════════════

await vetor("SESSION_ISOLATION", "token amarrado a OUTRA sessão não toca esta", "bloqueio", async () => {
  // Credencial válida, escopo suficiente — e ainda assim recusada, porque a
  // sessão não é dela. É o sequestro de sessão com token legítimo de terceiro.
  const alheio = d.auth.issue({ subject: "dono-de-outra", preset: "agent", session_allowlist: ["ses_outra"] }).secret;
  const r = await post("/api/v1/browser.observe", { session_id: SID }, alheio);
  return {
    ok: r.status === 403 && r.env.error?.detail?.auth === "SESSION_NOT_OWNED",
    obs: `status=${r.status} failure=${String(r.env.error?.detail?.auth)}`,
  };
});

await vetor("SESSION_ISOLATION", "arbitragem barra segunda identidade na sessão", "bloqueio", async () => {
  const r = await post("/api/v1/browser.observe", { session_id: SID }, T_AGENTE);
  return {
    ok: r.status === 409 && r.env.error?.detail?.lease === "CONTROL_NOT_OWNED",
    obs: `status=${r.status} lease=${String(r.env.error?.detail?.lease)} dono=${String(r.env.error?.detail?.current_holder)}`,
  };
});

await vetor("SESSION_ISOLATION", "sessão inexistente responde 404, não 409", "bloqueio", async () => {
  const r = await post("/api/v1/browser.observe", { session_id: "ses_naoexiste" });
  return { ok: r.status === 404, obs: `status=${r.status} code=${r.env.error?.code}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. ENTRADA MALFORMADA E CORPO GIGANTE
// ═════════════════════════════════════════════════════════════════════════════

await vetor("INPUT_HARDENING", "corpo que não é JSON", "bloqueio", async () => {
  const r = await req("POST", "/api/v1/browser.observe", undefined, ROOT_TOKEN, "{ isto nao e json }");
  return {
    ok: r.status === 400 && r.env.error?.code === "INVALID_REQUEST",
    obs: `status=${r.status} code=${r.env.error?.code}`,
  };
});

await vetor("INPUT_HARDENING", "corpo JSON que não é objeto", "bloqueio", async () => {
  const r = await req("POST", "/api/v1/browser.observe", undefined, ROOT_TOKEN, "[1,2,3]");
  return { ok: r.status === 400, obs: `status=${r.status} code=${r.env.error?.code}` };
});

await vetor("INPUT_HARDENING", `corpo maior que max_body_bytes (${MAX_BODY})`, "bloqueio", async () => {
  const gigante = JSON.stringify({ session_id: SID, lixo: "A".repeat(MAX_BODY * 3) });
  const r = await req("POST", "/api/v1/browser.observe", undefined, ROOT_TOKEN, gigante);
  return {
    ok: recusado(r) && /bytes/.test(JSON.stringify(r.env)),
    obs: `status=${r.status} code=${r.env.error?.code} enviados=${gigante.length}`,
  };
});

await vetor("INPUT_HARDENING", "URL absurdamente longa", "bloqueio", async () => {
  const r = await fetch(`${BASE}/api/v1/browser.observe?x=${"a".repeat(9000)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ROOT_TOKEN}` },
    body: JSON.stringify({ session_id: SID }),
  });
  CORPOS.push(await r.text());
  return { ok: r.status >= 400, obs: `status=${r.status}` };
});

await vetor("INPUT_HARDENING", "rota inexistente sai no ENVELOPE, não em HTML de stack", "bloqueio", async () => {
  const r = await req("GET", "/api/v1/nao-existe-isso", undefined);
  const temEnvelope = typeof r.env.success === "boolean" && "action_id" in r.env;
  return { ok: r.status === 404 && temEnvelope, obs: `status=${r.status} envelope=${temEnvelope}` };
});

await vetor("INPUT_HARDENING", "método errado devolve 405 com allow", "bloqueio", async () => {
  const r = await req("DELETE", "/health", undefined);
  return { ok: r.status === 405, obs: `status=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. VAZAMENTO DE SEGREDO
// ═════════════════════════════════════════════════════════════════════════════

function varrer(dir: string, achados: string[], agulhas: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      varrer(p, achados, agulhas);
      continue;
    }
    let conteudo = "";
    try {
      conteudo = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const a of agulhas) if (a.length > 8 && conteudo.includes(a)) achados.push(`${p} contem ${a.slice(0, 6)}...`);
  }
}

const AGULHAS = [ROOT_TOKEN, T_OBSERVADOR, T_AGENTE, T_REVOGADO.secret, T_EXPIRADO.secret];

await vetor("SECRET_LEAK_TEST", "nenhum token na trilha de auditoria em disco", "bloqueio", async () => {
  const achados: string[] = [];
  varrer(RAIZ_SESSOES, achados, AGULHAS);
  return { ok: achados.length === 0, obs: achados.length === 0 ? "trilha limpa" : achados.join(" | ") };
});

await vetor("SECRET_LEAK_TEST", "nenhum token em corpo de resposta ou de erro", "bloqueio", async () => {
  const sujos = CORPOS.filter((c) => AGULHAS.some((a) => c.includes(a)));
  return {
    ok: sujos.length === 0,
    obs: sujos.length === 0 ? `${CORPOS.length} corpos limpos` : `${sujos.length} corpos com token`,
  };
});

await vetor("SECRET_LEAK_TEST", "nenhum token no fluxo de eventos do WebSocket", "bloqueio", async () => {
  const recebidos: string[] = [];
  const ws = new WebSocket(`${WSBASE}?token=${encodeURIComponent(ROOT_TOKEN)}`);
  await new Promise<void>((r) => {
    ws.on("open", () => r());
    ws.on("error", () => r());
  });
  ws.on("message", (m) => recebidos.push(String(m)));
  // Provoca tráfego: a rajada gera evento de ação E de negação.
  await post("/api/v1/browser.tabs", { session_id: SID });
  await post("/api/v1/browser.observe", { session_id: SID }, T_AGENTE);
  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  const sujos = recebidos.filter((c) => AGULHAS.some((a) => c.includes(a)));
  return { ok: sujos.length === 0, obs: `${recebidos.length} eventos, ${sujos.length} com segredo` };
});

await vetor("SECRET_LEAK_TEST", "arquivo de token do daemon é 0600", "bloqueio", async () => {
  const p = d.tokenPath;
  if (p === null || !fs.existsSync(p)) return { ok: false, obs: "token do daemon não foi gravado" };
  const modo = fs.statSync(p).mode & 0o777;
  return { ok: (modo & 0o077) === 0, obs: `modo=${modo.toString(8)}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. CONTROLES POSITIVOS — sem eles o placar verde não significa nada
// ═════════════════════════════════════════════════════════════════════════════

await vetor("CONTROLES_POSITIVOS", "credencial válida + dono do lease AGE", "permitido", async () => {
  const r = await post("/api/v1/browser.tabs", { session_id: SID });
  return { ok: r.env.success === true, obs: `status=${r.status} success=${r.env.success}` };
});

await vetor("CONTROLES_POSITIVOS", "capability CONCEDIDA passa (o verbo antes negado)", "permitido", async () => {
  // Mesma ação, sessão com a capability ligada: prova que a negação anterior foi
  // POLÍTICA, e não uma rota quebrada que nega tudo.
  const s2 = await post("/api/v1/sessions", {
    owner: "COM-PERMISSAO", capabilities: { ...CAPS_BASE, send: true }, headless: true,
  });
  const sid2 = String(s2.env.session_id ?? "");
  const r = await post("/api/v1/browser.send", { session_id: sid2 });
  const negadaPorCapability = r.env.error?.code === "CAPABILITY_DENIED";
  await req("DELETE", `/api/v1/sessions/${sid2}`, {});
  return { ok: !negadaPorCapability, obs: `status=${r.status} code=${r.env.error?.code ?? "(sem erro)"}` };
});

await vetor("CONTROLES_POSITIVOS", "observador LÊ o que lhe cabe", "permitido", async () => {
  const r = await req("GET", "/health", undefined, T_OBSERVADOR);
  return { ok: r.status === 200, obs: `status=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// PLACAR
// ═════════════════════════════════════════════════════════════════════════════

const GRUPOS: Grupo[] = [
  "REST_AUTH", "WEBSOCKET_AUTH", "MCP_AUTHORIZATION", "SSRF_PROTECTION",
  "FILESYSTEM_PROTECTION", "CAPABILITY_ENFORCEMENT", "SECRET_LEAK_TEST",
  "INPUT_HARDENING", "SESSION_ISOLATION", "CONTROLES_POSITIVOS",
];

const falhos = R.filter((v) => !v.ok);
console.log("\n--- placar -----------------------------------------------");
for (const g of GRUPOS) {
  const meus = R.filter((v) => v.grupo === g);
  const ruins = meus.filter((v) => !v.ok);
  console.log(`${g}=${ruins.length === 0 ? "PASS" : "FAIL"}  (${meus.length - ruins.length}/${meus.length})`);
}
console.log(`ADVERSARIAL_TOTAL=${R.length}`);
console.log(`ADVERSARIAL_OK=${R.length - falhos.length}`);
console.log(`OPEN_SECURITY_P1=${falhos.length}`);
console.log(`SECURITY_SUITE=${falhos.length === 0 ? "PASS" : "FAIL"}`);
if (falhos.length > 0) {
  console.log("\nVETORES QUE NAO SE COMPORTARAM COMO O PRODUTO PROMETE:");
  for (const f of falhos) console.log(`  [${f.grupo}] ${f.nome} -> ${f.observado}`);
}
console.log("\nBLOQUEADOS:");
for (const v of R.filter((x) => x.ok && x.tipo === "bloqueio")) console.log(`  BLOQUEADO ${v.nome}`);
console.log("PERMITIDOS (controles positivos):");
for (const v of R.filter((x) => x.ok && x.tipo === "permitido")) console.log(`  PERMITIDO ${v.nome}`);

fs.writeFileSync(
  path.join(OUT, "bateria-completa.json"),
  JSON.stringify({ gerado_em: new Date().toISOString(), vetores: R }, null, 2),
);

await d.close("fim da bateria");
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(falhos.length === 0 ? 0 : 1);
