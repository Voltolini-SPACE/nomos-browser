#!/usr/bin/env node
/**
 * FASE 7 — PROVA DO TRANSPORTE: CLIENTE FIEL AO DO NOMOS.
 *
 * Este arquivo NÃO usa o SDK de MCP, NÃO usa o `packages/mcp` como biblioteca e
 * NÃO fala HTTP com o runtime. Ele é uma reimplementação, em TypeScript, do
 * comportamento observável de `nomos/interface/mcp_client.py::ClienteMCP` — o
 * cliente que o NOMOS realmente usa — lido do wheel instalado em
 * `~/.local/share/nomos/venv/.../nomos/interface/mcp_client.py`.
 *
 * O que foi replicado, item a item, do fonte do NOMOS:
 *   • `PROTOCOLO = "2024-11-05"` e o handshake `initialize` com
 *     `{protocolVersion, capabilities:{}, clientInfo:{name:"nomos-mcp-client"}}`;
 *   • a notificação `notifications/initialized` logo após o handshake;
 *   • UMA mensagem JSON por linha, `\n` como framing, stdin/stdout do subprocesso;
 *   • subprocesso do `comando` do manifesto com `cwd` = diretório do manifesto
 *     (o `base=` do `ClienteMCP`), stderr descartado;
 *   • leitura em thread/fila com prazo — resposta fora de `id` é ignorada, EOF
 *     vira "server MCP encerrou sem responder (handshake?)", estouro de prazo
 *     vira "server MCP não respondeu em Ns";
 *   • `tools()` anotando cada tool com o nível A0–A6 vindo do MANIFESTO, e não
 *     do servidor — que é o ponto de governança inteiro: quem classifica risco
 *     é o manifesto que o dono registrou, nunca o server que quer ser chamado;
 *   • encerramento: fecha stdin, espera, e mata se não sair.
 *
 * O que ele prova, ponta a ponta, contra um daemon REAL com Chromium REAL:
 *   cliente → stdio → nomos-browser-mcp → HTTP API v1 → Chromium → resultado
 *   estruturado → stdio → cliente
 *
 * O que ele NÃO faz: aprovar coisa nenhuma no lugar do dono. Ele sobe o nosso
 * server como o NOMOS subiria; o gate de política do NOMOS (A0 direto, A1+ com
 * aprovação humana) é provado à parte, com o binário real, em `07-nomos/`.
 *
 * Uso:  node evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts
 * Saída: uma linha por caso + `NOMOS_TRANSPORT_E2E=PASS|FAIL`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const MANIFESTO = path.join(RAIZ, "packaging/mcp/manifesto.json");
const DAEMON_TS = path.join(RAIZ, "packages/api/src/daemon.ts");

// ─────────────────────────────────────────────────────────────────────────────
// RÉPLICA 1 — `carregar_manifesto` (mcp_client.py). Fail-closed idêntico.
// ─────────────────────────────────────────────────────────────────────────────

/** Espelha `NIVEIS` do NOMOS: A0..A6 → categoria de política. */
const NIVEIS: Readonly<Record<string, string>> = Object.freeze({
  A0: "READ_LOCAL",
  A1: "WRITE_LOCAL",
  A2: "NET_EGRESS",
  A3: "CONNECTOR_USE",
  A4: "DEVICE_SCREEN",
  A5: "CODE_EXEC",
  A6: "DESTRUCTIVE",
});
/** `NIVEL_FAIL_CLOSED` do NOMOS: tool desconhecida é tratada como execução de código. */
const NIVEL_FAIL_CLOSED = "A5";
const PROTOCOLO = "2024-11-05";

class ManifestoInvalido extends Error {}
class McpErro extends Error {}

export interface Manifesto {
  nome: string;
  comando: string[];
  nivel_padrao: string;
  tools: Record<string, string>;
}

/**
 * Mesma normalização de `carregar_manifesto`: devolve EXATAMENTE os 4 campos que
 * entram no SHA-256 de confiança. `descricao`, `env` e `signature` ficam fora —
 * é por isso que o dono pode corrigir a descrição depois sem derrubar o registro.
 */
function carregarManifesto(caminho: string): Manifesto {
  let dados: Record<string, unknown>;
  try {
    dados = JSON.parse(readFileSync(caminho, "utf8")) as Record<string, unknown>;
  } catch {
    throw new ManifestoInvalido(`manifesto não é JSON válido: ${caminho}`);
  }
  const nome = dados.nome;
  const comando = dados.comando;
  if (typeof nome !== "string" || nome === "") throw new ManifestoInvalido("manifesto sem campo 'nome'");
  if (!Array.isArray(comando) || comando.length === 0 || !comando.every((c) => typeof c === "string")) {
    throw new ManifestoInvalido("'comando' deve ser lista de strings não vazia");
  }
  const nivel_padrao = String(dados.nivel_padrao ?? NIVEL_FAIL_CLOSED);
  if (!(nivel_padrao in NIVEIS)) throw new ManifestoInvalido(`nivel_padrao desconhecido: ${nivel_padrao}`);
  const brutas = dados.tools ?? {};
  if (typeof brutas !== "object" || brutas === null || Array.isArray(brutas)) {
    throw new ManifestoInvalido("'tools' deve ser um objeto tool->nível");
  }
  const tools: Record<string, string> = {};
  for (const [t, n] of Object.entries(brutas as Record<string, unknown>)) {
    if (!(String(n) in NIVEIS)) throw new ManifestoInvalido(`nível desconhecido para '${t}': ${String(n)}`);
    tools[String(t)] = String(n);
  }
  return { nome, comando: comando as string[], nivel_padrao, tools };
}

/** `nivel_da_tool`: tool não declarada HERDA o `nivel_padrao` (que aqui é A5). */
function nivelDaTool(m: Manifesto, tool: string): string {
  return m.tools[tool] ?? m.nivel_padrao;
}

// ─────────────────────────────────────────────────────────────────────────────
// RÉPLICA 2 — `ClienteMCP`. Sessão one-shot por stdio.
// ─────────────────────────────────────────────────────────────────────────────

interface RpcResposta {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface OpcoesCliente {
  /** `timeout` do ClienteMCP (segundos lá, ms aqui). Default do NOMOS: 30 s. */
  timeoutMs?: number;
  /** `base=` do ClienteMCP: o cwd do subprocesso = diretório do manifesto. */
  base?: string | null;
  env?: NodeJS.ProcessEnv;
}

class ClienteFiel {
  readonly manifesto: Manifesto;
  serverInfo: Record<string, unknown> = {};
  readonly #timeoutMs: number;
  readonly #base: string | null;
  readonly #env: NodeJS.ProcessEnv;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #mid = 0;
  /** A "fila" do leitor. `null` na fila = EOF, exatamente como o `_ler` do NOMOS. */
  #fila: (string | null)[] = [];
  #esperando: (() => void)[] = [];

  constructor(manifesto: Manifesto, opts: OpcoesCliente = {}) {
    this.manifesto = manifesto;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#base = opts.base ?? null;
    this.#env = opts.env ?? process.env;
  }

  get pid(): number | undefined {
    return this.#proc?.pid;
  }

  /** Equivale a `__enter__`: sobe o subprocesso, handshake, `initialized`. */
  async abrir(): Promise<this> {
    const [exe, ...argv] = this.manifesto.comando;
    this.#proc = spawn(exe!, argv, {
      cwd: this.#base ?? undefined,
      // stderr descartado: é o `stderr=subprocess.DEVNULL` do ClienteMCP. Se o
      // server escrever diagnóstico, ele NÃO pode contaminar o canal JSON-RPC.
      stdio: ["pipe", "pipe", "ignore"],
      env: this.#env,
    }) as ChildProcessWithoutNullStreams;

    // Leitor por LINHA. O NOMOS usa `for linha in proc.stdout` numa thread; aqui
    // o equivalente é acumular o buffer e cortar em `\n`. O que importa é a
    // propriedade: uma linha == uma mensagem, e nada bloqueia o prazo.
    let buffer = "";
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (pedaco: string) => {
      buffer += pedaco;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        this.#empilhar(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    const fim = (): void => {
      if (buffer.trim() !== "") this.#empilhar(buffer);
      buffer = "";
      this.#empilhar(null); // EOF/erro: sinaliza fim, como o `_fila.put(None)`
    };
    this.#proc.stdout.on("end", fim);
    this.#proc.on("close", fim);
    this.#proc.on("error", fim);

    const init = await this._rpc("initialize", {
      protocolVersion: PROTOCOLO,
      capabilities: {},
      clientInfo: { name: "nomos-mcp-client" },
    });
    this.serverInfo = (init.serverInfo ?? {}) as Record<string, unknown>;
    this._notificar("notifications/initialized");
    return this;
  }

  #empilhar(v: string | null): void {
    this.#fila.push(v);
    const w = this.#esperando.shift();
    if (w !== undefined) w();
  }

  /** Espera uma linha até `prazo` (epoch ms). `undefined` = estourou o prazo. */
  async #proximaLinha(prazo: number): Promise<string | null | undefined> {
    for (;;) {
      if (this.#fila.length > 0) return this.#fila.shift();
      const restante = prazo - Date.now();
      if (restante <= 0) return undefined;
      const chegou = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          this.#esperando = this.#esperando.filter((f) => f !== acordar);
          resolve(false);
        }, restante);
        const acordar = (): void => {
          clearTimeout(t);
          resolve(true);
        };
        this.#esperando.push(acordar);
      });
      if (!chegou && this.#fila.length === 0) return undefined;
    }
  }

  _enviar(payload: Record<string, unknown>): void {
    if (this.#proc === null) throw new McpErro("cliente não está aberto");
    this.#proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _notificar(metodo: string): void {
    // Notificação = mensagem SEM `id`. O NOMOS manda exatamente isto.
    this._enviar({ jsonrpc: "2.0", method: metodo });
  }

  /** Notificação com params — usada para provar que o server tolera cancelamento. */
  _notificarCom(metodo: string, params: Record<string, unknown>): void {
    this._enviar({ jsonrpc: "2.0", method: metodo, params });
  }

  async _rpc(metodo: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    this.#mid += 1;
    const meu = this.#mid;
    this._enviar({ jsonrpc: "2.0", id: meu, method: metodo, ...(params !== undefined ? { params } : {}) });
    const limite = timeoutMs ?? this.#timeoutMs;
    const prazo = Date.now() + limite;
    for (;;) {
      const linha = await this.#proximaLinha(prazo);
      if (linha === undefined) {
        throw new McpErro(
          `server MCP não respondeu em ${(limite / 1000).toFixed(0)}s (o comando do manifesto fala MCP?)`,
        );
      }
      if (linha === null) throw new McpErro("server MCP encerrou sem responder (handshake?)");
      if (linha.trim() === "") continue;
      let msg: RpcResposta;
      try {
        msg = JSON.parse(linha) as RpcResposta;
      } catch {
        throw new McpErro("server MCP respondeu algo que não é JSON");
      }
      // Resposta de outro `id` (ou notificação/log do server): não é a minha.
      if (typeof msg !== "object" || msg === null || msg.id !== meu) continue;
      if (msg.error !== undefined) throw new McpErro(String(msg.error.message ?? "erro do server"));
      return msg.result ?? {};
    }
  }

  /** `tools/list` ANOTADA com o nível do manifesto — igual ao `tools()` do NOMOS. */
  async tools(): Promise<Array<Record<string, unknown> & { nivel: string }>> {
    const r = await this._rpc("tools/list");
    const lista = (r.tools ?? []) as Array<Record<string, unknown>>;
    return lista.map((t) => ({ ...t, nivel: nivelDaTool(this.manifesto, String(t.name ?? "")) }));
  }

  async chamar(tool: string, argumentos: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this._rpc("tools/call", { name: tool, arguments: argumentos }, timeoutMs);
  }

  /** Equivale a `__exit__`: fecha stdin, espera até 5 s, mata se não sair. */
  async fechar(): Promise<void> {
    const p = this.#proc;
    if (p === null) return;
    this.#proc = null;
    try {
      p.stdin.end();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          p.kill("SIGKILL");
          resolve();
        }, 5_000);
        p.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      p.kill("SIGKILL");
    }
  }

  /** Morte abrupta do server — usada nos casos de cancelamento e reconnect. */
  matar(): void {
    this.#proc?.kill("SIGKILL");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Placar
// ─────────────────────────────────────────────────────────────────────────────

let falhas = 0;
const linhas: string[] = [];

function caso(nome: string, ok: boolean, detalhe: string): void {
  if (!ok) falhas += 1;
  const linha = `[${ok ? "PASS" : "FALHA"}] ${nome} — ${detalhe}`;
  linhas.push(linha);
  console.log(linha);
}

function texto(r: Record<string, unknown>): string {
  const c = (r.content ?? []) as Array<{ type?: string; text?: string }>;
  return c.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
}
function ehErro(r: Record<string, unknown>): boolean {
  return r.isError === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: uma página real, servida por loopback. Nada de file:// — o caminho
// que se quer provar inclui a rede do Chromium.
// ─────────────────────────────────────────────────────────────────────────────

const MARCA = "NOMOS-TRANSPORTE-E2E-MARCADOR";
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture do transporte</title></head>
<body>
<h1 id="titulo">${MARCA}</h1>
<p id="estado">inicial</p>
<button id="botao" onclick="document.getElementById('estado').textContent='clicado'">Confirmar</button>
<input id="campo" placeholder="Digite aqui">
</body></html>`;

async function subirFixture(): Promise<{ url: string; fechar: () => Promise<void> }> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGINA);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    fechar: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon REAL. Processo próprio, porta própria, runtime_dir próprio — nada
// encosta no daemon do dono nem nos serviços de produção da máquina.
// ─────────────────────────────────────────────────────────────────────────────

interface Daemon {
  url: string;
  token: string;
  fechar: () => Promise<void>;
}

async function subirDaemon(runtimeDir: string, perfis: string, sessoes: string): Promise<Daemon> {
  const envDaemon: NodeJS.ProcessEnv = {
    ...process.env,
    NOMOS_RUNTIME_DIR: runtimeDir,
    NOMOS_BROWSER_PORT: "0",
    NOMOS_BROWSER_HOST: "127.0.0.1",
    NOMOS_BROWSER_HEADLESS: "true",
    // A fixture é loopback: sem isto a netpolicy recusa a navegação, e o que
    // se mediria seria a política, não o transporte.
    NOMOS_BROWSER_ALLOW_INTERNAL: "true",
    NOMOS_BROWSER_PROFILES_ROOT: perfis,
    NOMOS_SESSIONS_ROOT: sessoes,
  };
  // `NOMOS_BROWSER_CONFIG` aponta para um arquivo EXPLÍCITO e ausente derruba o
  // arranque de propósito (config.ts). Apagar a variável é diferente de mandá-la
  // vazia: aqui se quer o default do produto, não um caminho inexistente.
  delete envDaemon.NOMOS_BROWSER_CONFIG;
  const proc = spawn(process.execPath, [DAEMON_TS], {
    cwd: RAIZ,
    stdio: ["ignore", "ignore", "pipe"],
    env: envDaemon,
  });

  let url: string | null = null;
  let stderr = "";
  const pronto = new Promise<void>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`daemon não subiu em 90s. stderr:\n${stderr.slice(-1500)}`)), 90_000);
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => {
      stderr += d;
      const m = /nomos-browser em (http:\/\/\S+)/.exec(stderr);
      if (m !== null && url === null) {
        url = m[1]!;
        clearTimeout(limite);
        resolve();
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(limite);
      if (url === null) reject(new Error(`daemon saiu com código ${String(code)}. stderr:\n${stderr.slice(-1500)}`));
    });
  });
  await pronto;

  const token = readFileSync(path.join(runtimeDir, "control-token"), "utf8").trim();
  if (token === "") throw new Error("daemon não gravou credencial");

  return {
    url: url!,
    token,
    fechar: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          r();
        }, 15_000);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A prova
// ─────────────────────────────────────────────────────────────────────────────

/** Extrai `session_id=<id>` do cabeçalho que o adaptador devolve (FASE 7.2). */
function sessaoDo(t: string): string | null {
  const m = /session_id=(\S+)/.exec(t);
  return m === null ? null : m[1]!;
}

async function main(): Promise<void> {
  const manifesto = carregarManifesto(MANIFESTO);
  const BASE = path.dirname(MANIFESTO);

  caso(
    "00 manifesto canônico carrega com a MESMA validação do NOMOS",
    manifesto.nome === "nomos-browser" &&
      Object.keys(manifesto.tools).length === 16 &&
      manifesto.nivel_padrao === "A5",
    `nome=${manifesto.nome} tools=${Object.keys(manifesto.tools).length} nivel_padrao=${manifesto.nivel_padrao}`,
  );

  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-fiel-rt-"));
  const perfis = mkdtempSync(path.join(os.tmpdir(), "nomos-fiel-perfis-"));
  const sessoes = mkdtempSync(path.join(os.tmpdir(), "nomos-fiel-sess-"));
  const fixture = await subirFixture();
  // Segundo servidor: aceita a conexão e NUNCA responde. É o alvo do caso de
  // cancelamento — uma chamada que fica pendurada de verdade.
  const pendurado = http.createServer(() => {
    /* nunca responde: a requisição fica aberta */
  });
  await new Promise<void>((r) => pendurado.listen(0, "127.0.0.1", r));
  const urlPendurada = `http://127.0.0.1:${(pendurado.address() as { port: number }).port}/`;

  let daemon: Daemon | null = null;
  try {
    daemon = await subirDaemon(runtimeDir, perfis, sessoes);
    console.log(`# daemon real em ${daemon.url} (runtime_dir=${runtimeDir})`);

    const ambiente = (comToken: boolean): NodeJS.ProcessEnv => {
      const e: NodeJS.ProcessEnv = { ...process.env, NOMOS_BROWSER_URL: daemon!.url };
      if (comToken) e.NOMOS_BROWSER_TOKEN = daemon!.token;
      else delete e.NOMOS_BROWSER_TOKEN;
      delete e.NOMOS_BROWSER_TOKEN_FILE;
      return e;
    };

    // ── 01 DISCOVERABILITY ────────────────────────────────────────────────
    const c1 = await new ClienteFiel(manifesto, { base: BASE, env: ambiente(true) }).abrir();
    const tools = await c1.tools();
    const nomes = tools.map((t) => String(t.name)).sort();
    const declaradas = Object.keys(manifesto.tools).sort();
    const todasComSchema = tools.every((t) => {
      const s = t.inputSchema as { type?: string } | undefined;
      return s !== undefined && s.type === "object" && typeof t.description === "string" && t.description !== "";
    });
    const niveisBatem = tools.every((t) => t.nivel === manifesto.tools[String(t.name)]);
    caso(
      "01 discoverability — tools/list devolve as 13 com schema e nível do manifesto",
      tools.length === 16 && JSON.stringify(nomes) === JSON.stringify(declaradas) && todasComSchema && niveisBatem,
      `server=${String(c1.serverInfo.name)} tools=${tools.length} schema_ok=${todasComSchema} niveis_do_manifesto_ok=${niveisBatem}`,
    );
    caso(
      "01b nenhuma tool do server escapa da classificação do manifesto",
      tools.every((t) => t.nivel !== undefined && t.nivel in NIVEIS),
      `A0=${tools.filter((t) => t.nivel === "A0").length} A2=${tools.filter((t) => t.nivel === "A2").length} A5=${tools.filter((t) => t.nivel === "A5").length}`,
    );

    // ── 02 AUTENTICAÇÃO — sem credencial, recusa CLARA e sem socket ────────
    const cSem = await new ClienteFiel(manifesto, { base: BASE, env: ambiente(false) }).abrir();
    const rSem = await cSem.chamar("browser_observe", {});
    const txtSem = texto(rSem);
    caso(
      "02 autenticação — sem NOMOS_BROWSER_TOKEN o adaptador recusa com erro próprio",
      ehErro(rSem) && txtSem.includes("MCP_NO_CREDENTIAL") && txtSem.includes("NOMOS_BROWSER_TOKEN"),
      `isError=${String(rSem.isError)} código=${/code=(\S+)/.exec(txtSem)?.[1] ?? "?"}`,
    );
    await cSem.fechar();

    // ── 03 SESSÃO + AÇÃO + RETORNO ESTRUTURADO ────────────────────────────
    const rNav = await c1.chamar("browser_navigate", { url: fixture.url, wait_until: "load" }, 90_000);
    const txtNav = texto(rNav);
    const sid = sessaoDo(txtNav);
    caso(
      "03 sessão — o adaptador criou a sessão sozinho e devolveu o session_id",
      !ehErro(rNav) && sid !== null && sid !== "",
      `isError=${String(rNav.isError === true)} session_id=${sid ?? "(ausente)"}`,
    );
    caso(
      "03b ação — navegação real chegou ao Chromium e voltou estruturada",
      !ehErro(rNav) && txtNav.includes("state=") && txtNav.includes(new URL(fixture.url).host),
      (txtNav.split("\n")[0] ?? "").slice(0, 120),
    );

    const rObs = await c1.chamar("browser_observe", { limit: 5 }, 60_000);
    caso(
      "03c sessão reutilizada no MESMO processo sem o cliente pedir",
      !ehErro(rObs) && sessaoDo(texto(rObs)) === sid,
      `session_id da 2ª chamada=${sessaoDo(texto(rObs)) ?? "?"}`,
    );

    const rExt = await c1.chamar("browser_extract", { format: "text" }, 60_000);
    const txtExt = texto(rExt);
    caso(
      "04 retorno estruturado — browser_extract traz o conteúdo REAL da página",
      !ehErro(rExt) && txtExt.includes(MARCA) && txtExt.includes('"scope"'),
      `marcador=${txtExt.includes(MARCA)} envelope_json=${txtExt.includes('"provenance"')}`,
    );

    // ── 05 AÇÃO COM EFEITO — clique muda o DOM, e a extração PROVA ────────
    const rClick = await c1.chamar(
      "browser_click",
      { target: { selector: "#botao" }, verification: { kind: "TEXT_CHANGED", timeout_ms: 5000 } },
      60_000,
    );
    const rDepois = await c1.chamar("browser_extract", { target: { selector: "#estado" }, format: "text" }, 60_000);
    caso(
      "05 ação com efeito — clique real mudou o DOM e a extração seguinte vê a mudança",
      !ehErro(rClick) && !ehErro(rDepois) && texto(rDepois).includes("clicado"),
      `click_isError=${String(rClick.isError === true)} estado_depois=${texto(rDepois).includes("clicado") ? "clicado" : "inalterado"}`,
    );

    // ── 06 ERRO — protocolo e execução saem por portas DIFERENTES ─────────
    let erroTool = "";
    try {
      await c1.chamar("browser_teleportar", {});
    } catch (e) {
      erroTool = e instanceof McpErro ? e.message : `TIPO INESPERADO: ${String(e)}`;
    }
    caso(
      "06 erro — tool inexistente vira erro JSON-RPC, não resultado vazio",
      erroTool.includes("desconhecida"),
      `McpErro: ${erroTool.slice(0, 90)}`,
    );

    let erroArgs = "";
    try {
      await c1.chamar("browser_navigate", { urlz: "http://exemplo" });
    } catch (e) {
      erroArgs = e instanceof McpErro ? e.message : `TIPO INESPERADO: ${String(e)}`;
    }
    caso(
      "06b erro — argumento inválido vira erro JSON-RPC com a razão exata",
      erroArgs.includes("desconhecido") || erroArgs.includes("obrigatório"),
      `McpErro: ${erroArgs.slice(0, 90)}`,
    );

    const rAlvo = await c1.chamar("browser_click", { target: { selector: "#nao-existe-nesta-pagina" } }, 60_000);
    const txtAlvo = texto(rAlvo);
    caso(
      "06c erro — falha de EXECUÇÃO volta como isError com o código do contrato",
      ehErro(rAlvo) && txtAlvo.includes("NOMOS_BROWSER_ERROR") && /code=[A-Z_]+/.test(txtAlvo),
      `código=${/code=(\S+)/.exec(txtAlvo)?.[1] ?? "?"}`,
    );
    caso(
      "06d controle — o MESMO caminho com sucesso NÃO marca isError",
      !ehErro(rExt) && ehErro(rAlvo),
      `extract.isError=${String(rExt.isError === true)} click_alvo_ruim.isError=${String(rAlvo.isError === true)}`,
    );

    // ── 07 CANCELAMENTO ───────────────────────────────────────────────────
    //
    // O `ClienteMCP` do NOMOS é one-shot e NUNCA envia `notifications/cancelled`:
    // cancelar, no modelo dele, é abandonar a chamada e derrubar o subprocesso
    // (`__exit__`). Então são duas propriedades, e as duas são medidas:
    //   (a) uma notificação de cancelamento não pode QUEBRAR o fluxo — notificação
    //       não recebe resposta e o stream tem de seguir vivo;
    //   (b) o abandono real tem de virar erro no cliente, e não silêncio eterno.
    c1._notificarCom("notifications/cancelled", { requestId: 999, reason: "prova de cancelamento" });
    let vivoDepois = false;
    try {
      const rPing = await c1._rpc("ping", undefined, 10_000);
      vivoDepois = typeof rPing === "object";
    } catch {
      vivoDepois = false;
    }
    caso(
      "07 cancelamento — notificação de cancelamento não recebe resposta e não derruba o stream",
      vivoDepois,
      `ping após notifications/cancelled respondeu=${vivoDepois}`,
    );

    const cCancel = await new ClienteFiel(manifesto, { base: BASE, env: ambiente(true) }).abrir();
    // Navegação para um servidor que aceita e nunca responde: a chamada FICA
    // pendurada de verdade — não é um sleep fingindo ser I/O.
    const pendente = cCancel.chamar("browser_navigate", { url: urlPendurada }, 60_000);
    await new Promise((r) => setTimeout(r, 2_500));
    cCancel.matar();
    let fimCancel = "";
    try {
      await pendente;
      fimCancel = "(a chamada abandonada RETORNOU — isto seria um vazamento)";
    } catch (e) {
      fimCancel = e instanceof McpErro ? e.message : `TIPO INESPERADO: ${String(e)}`;
    }
    caso(
      "07b cancelamento — chamada abandonada morre com o subprocesso e vira erro, não silêncio",
      fimCancel.includes("encerrou sem responder"),
      `McpErro: ${fimCancel.slice(0, 90)}`,
    );
    await cCancel.fechar();

    // ── 08 TIMEOUT ────────────────────────────────────────────────────────
    //
    // Medido do jeito que dói de verdade no NOMOS: um `comando` que SOBE mas não
    // fala MCP. É o caso em que `readline` bloquearia para sempre — a razão de o
    // `ClienteMCP` ter leitor em thread e prazo.
    const mudo: Manifesto = {
      nome: "servidor-mudo",
      comando: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      nivel_padrao: "A5",
      tools: {},
    };
    let erroTimeout = "";
    const t0 = Date.now();
    const cMudo = new ClienteFiel(mudo, { base: BASE, timeoutMs: 1_500, env: ambiente(true) });
    try {
      await cMudo.abrir();
      erroTimeout = "(o handshake com um server MUDO retornou — isto seria falso positivo)";
    } catch (e) {
      erroTimeout = e instanceof McpErro ? e.message : `TIPO INESPERADO: ${String(e)}`;
    }
    const gasto = Date.now() - t0;
    await cMudo.fechar();
    caso(
      "08 timeout — server que não fala MCP estoura o prazo em vez de pendurar o cliente",
      erroTimeout.includes("não respondeu em") && gasto < 10_000,
      `McpErro: ${erroTimeout.slice(0, 70)} (${gasto} ms)`,
    );

    // ── 09 RECONNECT ──────────────────────────────────────────────────────
    //
    // Matar o adaptador não pode custar a sessão: quem guarda estado é o RUNTIME.
    // Este caso mata o server no SIGKILL, sobe outro processo do zero e continua
    // NA MESMA SESSÃO pelo `session_id` — que é exatamente como `nomos mcp chamar`
    // opera (um processo novo por chamada).
    c1.matar();
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await new ClienteFiel(manifesto, { base: BASE, env: ambiente(true) }).abrir();
    const tools2 = await c2.tools();
    caso(
      "09 reconnect — subprocesso morto, novo processo faz handshake e lista as 13 de novo",
      tools2.length === 16 && String(c2.serverInfo.name) === "nomos-browser-mcp",
      `server=${String(c2.serverInfo.name)} tools=${tools2.length} pid_novo=${String(c2.pid)}`,
    );
    const rRetomada = await c2.chamar("browser_extract", { session_id: sid ?? "", format: "text" }, 60_000);
    const txtRetomada = texto(rRetomada);
    caso(
      "09b reconnect — a SESSÃO sobreviveu ao adaptador: o processo novo retoma pelo session_id",
      !ehErro(rRetomada) && sessaoDo(txtRetomada) === sid && txtRetomada.includes(MARCA),
      `session_id retomado=${sessaoDo(txtRetomada) ?? "?"} conteúdo_ainda_visível=${txtRetomada.includes(MARCA)}`,
    );
    await c2.fechar();
  } catch (err) {
    caso("XX execução da bateria", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    await daemon?.fechar();
    await fixture.fechar();
    await new Promise<void>((r) => pendurado.close(() => r()));
    pendurado.closeAllConnections?.();
    for (const d of [runtimeDir, perfis, sessoes]) rmSync(d, { recursive: true, force: true });
  }

  console.log("");
  console.log(`casos=${linhas.length} falhas=${falhas}`);
  console.log(`NOMOS_TRANSPORT_E2E=${falhas === 0 ? "PASS" : "FAIL"}`);
  process.exit(falhas === 0 ? 0 : 1);
}

await main();
