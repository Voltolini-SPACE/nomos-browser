/**
 * FASE 6 — prova do servidor MCP `nomos-browser-mcp`.
 *
 * Critério de honestidade: o teste NÃO usa o daemon real nem mock do cliente
 * HTTP. Sobe um servidor `node:http` que finge ser o Browser Runtime, devolve
 * envelopes `ActionResponse` válidos e REGISTRA cada requisição recebida. Assim
 * "fez um POST para a rota certa" é uma observação do lado do servidor, não uma
 * afirmação sobre o código do cliente.
 *
 * O framing stdio é provado com o processo de verdade (`node .../server.ts`),
 * porque testar só `handleMessage` deixaria o transporte sem cobertura — e o
 * transporte é exatamente onde um servidor MCP costuma morrer calado.
 *
 * Onde há risco de asserção vácua existe controle:
 *   - "erro do runtime vira isError" só vale se o MESMO caminho com success:true
 *     produzir isError ausente (senão isError poderia ser sempre true);
 *   - "não importa o motor de navegador" é verificado por leitura do fonte, e o
 *     controle é achar a mesma agulha num arquivo que sabidamente a contém.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  RuntimeClient,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpServer,
  type JsonRpcResponse,
  type McpToolResult,
} from "../packages/mcp/src/server.ts";
import { TOOLS, ToolInputError, buildRuntimeCall, listToolsPayload } from "../packages/mcp/src/tools.ts";
import { API_PREFIX, type ActionResponse } from "../packages/core/src/contract.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TS = path.join(RAIZ, "packages/mcp/src/server.ts");
const TOOLS_TS = path.join(RAIZ, "packages/mcp/src/tools.ts");
const PKG_JSON = path.join(RAIZ, "packages/mcp/package.json");

const ESPERADAS = [
  "browser_navigate",
  "browser_observe",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_extract",
  "browser_screenshot",
  "browser_tabs",
  "browser_download",
  "browser_upload",
  "browser_task",
];

// ─────────────────────────────────────────────────────────────────────────────
// Runtime de mentira — grava tudo que recebe
// ─────────────────────────────────────────────────────────────────────────────

interface Recebida {
  method: string;
  url: string;
  body: unknown;
  contentType: string | undefined;
  /** FASE 11 — sem gravar isto não há como PROVAR que a credencial viajou. */
  authorization: string | undefined;
}

interface Fake {
  url: string;
  recebidas: Recebida[];
  /** Próxima resposta para uma rota; consumida uma vez. */
  responder: (rota: string, r: { status?: number; payload: unknown }) => void;
  reset: () => void;
  close: () => Promise<void>;
}

function envelope<T>(result: T, overrides: Partial<ActionResponse<T>> = {}): ActionResponse<T> {
  return {
    success: true,
    action_id: "act_fake_1",
    state: "ACTIVE",
    result,
    error: null,
    timing: { started_at: "2026-08-24T00:00:00.000Z", ended_at: "2026-08-24T00:00:00.010Z", duration_ms: 10 },
    ...overrides,
  };
}

async function startFake(): Promise<Fake> {
  const recebidas: Recebida[] = [];
  const respostas = new Map<string, { status?: number; payload: unknown }>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = { __unparseable: raw };
      }
      recebidas.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        body,
        contentType: req.headers["content-type"],
        authorization: req.headers["authorization"],
      });

      const rota = (req.url ?? "").replace(`${API_PREFIX}/`, "");
      const programada = respostas.get(rota);
      if (programada !== undefined) {
        respostas.delete(rota);
        res.writeHead(programada.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(programada.payload));
        return;
      }

      if (req.url === `${API_PREFIX}/sessions`) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            session_id: "sess_fake_001",
            owner: "mcp:nomos-browser-mcp",
            profile: "default",
            permissions: {},
            created_at: "2026-08-24T00:00:00.000Z",
            last_activity: "2026-08-24T00:00:00.000Z",
            context_id: "ctx_1",
            pages: [],
            task: null,
            status: "CREATED",
            control: "agent",
            attached_client: null,
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope({ echo: rota })));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("teste: endereço do fake inválido");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    recebidas,
    responder: (rota, r) => respostas.set(rota, r),
    reset: () => {
      recebidas.length = 0;
      respostas.clear();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let fake: Fake;

before(async () => {
  fake = await startFake();
});
after(async () => {
  await fake.close();
});

/**
 * FASE 11 — o servidor MCP passou a EXIGIR credencial do runtime. Isto não
 * afrouxa nada: acrescenta uma exigência que antes não existia. O caso que prova
 * a recusa sem credencial é o `1f`, mais abaixo.
 */
const TOKEN_DE_TESTE = "tok-de-teste-mcp";

function novoServidor() {
  return createMcpServer({ runtimeUrl: fake.url, owner: "teste", timeoutMs: 5_000, token: TOKEN_DE_TESTE });
}

function textoDe(r: McpToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. tools/list devolve as 13 ferramentas com inputSchema
// ─────────────────────────────────────────────────────────────────────────────

test("1a. tools/list devolve exatamente as 13 ferramentas do escopo", async () => {
  fake.reset();
  const srv = novoServidor();
  const res = (await srv.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as JsonRpcResponse;

  assert.equal(res.error, undefined, `tools/list falhou: ${JSON.stringify(res.error)}`);
  const tools = (res.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;

  assert.equal(tools.length, 13, `esperava 13 ferramentas, vieram ${tools.length}`);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...ESPERADAS].sort(),
    "conjunto de ferramentas diferente do exigido pela FASE 6",
  );
  // tools/list não pode fazer I/O: listar ferramenta não é agir sobre sessão.
  assert.equal(fake.recebidas.length, 0, "tools/list tocou o runtime — não deveria");
});

test("1b. toda ferramenta tem inputSchema JSON Schema utilizável", () => {
  for (const t of listToolsPayload()) {
    const s = t.inputSchema as Record<string, unknown>;
    assert.equal(s.type, "object", `${t.name}: inputSchema.type deve ser "object"`);
    assert.ok(typeof s.properties === "object" && s.properties !== null, `${t.name}: sem properties`);
    assert.equal(s.additionalProperties, false, `${t.name}: schema tem de ser fechado (fail closed)`);
    assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name}: descrição pobre demais`);

    const props = s.properties as Record<string, unknown>;
    assert.ok("session_id" in props, `${t.name}: precisa aceitar session_id`);

    // O schema tem de ser serializável — cliente MCP recebe isto por JSON.
    assert.doesNotThrow(() => JSON.stringify(t.inputSchema), `${t.name}: inputSchema não serializa`);

    // required, quando existe, só pode citar propriedade declarada.
    const required = (s.required ?? []) as string[];
    for (const r of required) assert.ok(r in props, `${t.name}: required cita "${r}" inexistente`);
  }
});

test("1c. campos obrigatórios estão declarados onde a API v1 exige", () => {
  const req = (nome: string) => ((TOOLS.find((t) => t.name === nome)!.inputSchema.required ?? []) as string[]);
  assert.deepEqual(req("browser_navigate"), ["url"]);
  assert.deepEqual(req("browser_find"), ["target"]);
  assert.deepEqual(req("browser_click"), ["target"]);
  assert.deepEqual(req("browser_type"), ["target"]);
  assert.deepEqual(req("browser_upload"), ["target"]);
  assert.deepEqual(req("browser_task"), ["goal"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. tools/call browser_navigate faz UM POST para a rota certa com o corpo certo
// ─────────────────────────────────────────────────────────────────────────────

test("2a. browser_navigate com session_id explícito faz UM POST em /api/v1/browser.goto", async () => {
  fake.reset();
  const srv = novoServidor();
  fake.responder("browser.goto", {
    payload: envelope({ page_id: "pg_1", url: "http://exemplo.local/x", title: "X", active: true, opened_at: "2026-08-24T00:00:00.000Z" }),
  });

  const res = (await srv.handleMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "browser_navigate",
      arguments: { url: "http://exemplo.local/x", wait_until: "domcontentloaded", session_id: "sess_pinada" },
    },
  })) as JsonRpcResponse;

  assert.equal(res.error, undefined, `chamada falhou: ${JSON.stringify(res.error)}`);
  assert.equal(res.id, 7, "id da resposta tem de casar com o da requisição");

  assert.equal(fake.recebidas.length, 1, `esperava 1 requisição HTTP, vieram ${fake.recebidas.length}: ${JSON.stringify(fake.recebidas.map((r) => r.url))}`);
  const [req] = fake.recebidas;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/browser.goto");
  assert.match(req.contentType ?? "", /application\/json/);
  assert.deepEqual(req.body, {
    session_id: "sess_pinada",
    url: "http://exemplo.local/x",
    wait_until: "domcontentloaded",
  });

  const out = res.result as McpToolResult;
  assert.notEqual(out.isError, true, "resposta de sucesso não pode vir marcada como erro");
  assert.match(textoDe(out), /route=browser\.goto/);
  assert.match(textoDe(out), /"page_id": "pg_1"/);
});

test("2b. sem session_id: cria UMA sessão, reutiliza nas chamadas seguintes", async () => {
  fake.reset();
  const srv = novoServidor();

  await srv.callTool("browser_navigate", { url: "http://exemplo.local/a" });
  await srv.callTool("browser_observe", { limit: 10 });

  const urls = fake.recebidas.map((r) => r.url);
  assert.deepEqual(urls, ["/api/v1/sessions", "/api/v1/browser.goto", "/api/v1/browser.observe"], `sequência inesperada: ${JSON.stringify(urls)}`);

  // A sessão criada tem de ser a usada — senão "reutilizar" seria só não criar.
  assert.equal((fake.recebidas[1].body as Record<string, unknown>).session_id, "sess_fake_001");
  assert.equal((fake.recebidas[2].body as Record<string, unknown>).session_id, "sess_fake_001");

  // Fail closed: criar sessão NÃO pode pedir capability. O default do runtime é restrito.
  assert.equal((fake.recebidas[0].body as Record<string, unknown>).capabilities, undefined, "servidor MCP tentou se autoconceder capabilities");
  assert.equal((fake.recebidas[0].body as Record<string, unknown>).owner, "teste");
});

test("2c. chamadas concorrentes sem session_id não criam duas sessões", async () => {
  fake.reset();
  const srv = novoServidor();
  await Promise.all([
    srv.callTool("browser_observe", {}),
    srv.callTool("browser_tabs", {}),
    srv.callTool("browser_extract", { format: "text" }),
  ]);
  const criacoes = fake.recebidas.filter((r) => r.url === "/api/v1/sessions");
  assert.equal(criacoes.length, 1, `criou ${criacoes.length} sessões em corrida — deveria criar 1`);
});

test("2e. FASE 7 — o session_id da sessão IMPLÍCITA volta no resultado", async () => {
  // Sem isto, o bootstrap automático de sessão é uma via de mão única: o chamador
  // NOMOS ganha "funciona sem saber de sessão" e perde "consigo continuar de
  // propósito". `nomos mcp chamar` é one-shot — um processo por chamada — então
  // sem o id na resposta a chamada seguinte SEMPRE abriria outra aba em branco.
  fake.reset();
  const srv = novoServidor();
  const out = await srv.callTool("browser_navigate", { url: "http://exemplo.local/a" });
  const t = textoDe(out);
  assert.match(t, /session_id=sess_fake_001/, `resultado não expôs o session_id: ${t.slice(0, 200)}`);

  // CONTROLE: com sessão FIXADA pelo cliente, o id devolvido é o do cliente —
  // senão "expõe a sessão" poderia ser um literal fixo no cabeçalho.
  fake.reset();
  const srv2 = novoServidor();
  const out2 = await srv2.callTool("browser_observe", { session_id: "sess_do_cliente" });
  assert.match(textoDe(out2), /session_id=sess_do_cliente/);
  assert.equal(
    fake.recebidas.filter((r) => r.url === "/api/v1/sessions").length,
    0,
    "com session_id explícito o adaptador não pode criar sessão nenhuma",
  );
});

test("2d. cada ferramenta cai na rota do contrato, com o corpo certo", async () => {
  const casos: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ["browser_navigate", { url: "http://a.local/p" }, "/api/v1/browser.goto", { session_id: "S", url: "http://a.local/p" }],
    ["browser_observe", { accessibility: true, limit: 5 }, "/api/v1/browser.observe", { session_id: "S", accessibility: true, limit: 5 }],
    ["browser_find", { target: { role: "button", text: "Entrar" } }, "/api/v1/browser.find", { session_id: "S", target: { role: "button", text: "Entrar" } }],
    ["browser_click", { target: { selector: "#b" }, verification: { kind: "URL_CHANGED", expect: "#logado" } }, "/api/v1/browser.click", { session_id: "S", target: { selector: "#b" }, verification: { kind: "URL_CHANGED", expect: "#logado" } }],
    ["browser_type", { target: { label: "Usuário" }, text: "nomos" }, "/api/v1/browser.type", { session_id: "S", target: { label: "Usuário" }, text: "nomos" }],
    ["browser_type", { target: { label: "Senha" }, credential_ref: "vault://x" }, "/api/v1/browser.type", { session_id: "S", target: { label: "Senha" }, credential_ref: "vault://x" }],
    ["browser_press", { key: "Enter" }, "/api/v1/browser.press", { session_id: "S", key: "Enter" }],
    ["browser_press", { keys: ["Control+A", "Backspace"] }, "/api/v1/browser.press", { session_id: "S", keys: ["Control+A", "Backspace"] }],
    ["browser_scroll", { dy: 400 }, "/api/v1/browser.scroll", { session_id: "S", dy: 400 }],
    ["browser_extract", { format: "markdown" }, "/api/v1/browser.extract", { session_id: "S", format: "markdown" }],
    ["browser_screenshot", { scope: "element", target: { selector: "#t" } }, "/api/v1/browser.screenshot", { session_id: "S", scope: "element", target: { selector: "#t" } }],
    ["browser_tabs", {}, "/api/v1/browser.tabs", { session_id: "S" }],
    ["browser_tabs", { action: "new", url: "http://a.local/" }, "/api/v1/browser.new_tab", { session_id: "S", url: "http://a.local/" }],
    ["browser_tabs", { action: "switch", page_id: "pg_2" }, "/api/v1/browser.switch_tab", { session_id: "S", page_id: "pg_2" }],
    ["browser_tabs", { action: "close", page_id: "pg_2" }, "/api/v1/browser.close_tab", { session_id: "S", page_id: "pg_2" }],
    ["browser_download", { url: "http://a.local/f.csv" }, "/api/v1/browser.download", { session_id: "S", url: "http://a.local/f.csv" }],
    ["browser_upload", { target: { selector: "input[type=file]" }, path: "/tmp/f.csv" }, "/api/v1/browser.upload", { session_id: "S", target: { selector: "input[type=file]" }, path: "/tmp/f.csv" }],
    ["browser_task", { goal: "extrair o TPV do dia" }, "/api/v1/browser.task", { session_id: "S", goal: "extrair o TPV do dia" }],
  ];

  const cobertas = new Set<string>();
  for (const [nome, args, urlEsperada, corpoEsperado] of casos) {
    fake.reset();
    const srv = novoServidor();
    await srv.callTool(nome, { ...args, session_id: "S" });
    assert.equal(fake.recebidas.length, 1, `${nome}: fez ${fake.recebidas.length} requisições`);
    assert.equal(fake.recebidas[0].url, urlEsperada, `${nome}: rota errada`);
    assert.deepEqual(fake.recebidas[0].body, corpoEsperado, `${nome}: corpo errado`);
    cobertas.add(nome);
  }
  // Controle: a tabela acima tem de cobrir as 13, senão o "cada ferramenta" mente.
  assert.deepEqual([...cobertas].sort(), [...ESPERADAS].sort(), "há ferramenta sem caso nesta tabela");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. success=false vira erro MCP visível
// ─────────────────────────────────────────────────────────────────────────────

test("3a. runtime com success=false vira isError preservando error.code", async () => {
  fake.reset();
  const srv = novoServidor();
  fake.responder("browser.download", {
    status: 403,
    payload: {
      success: false,
      action_id: "act_neg_9",
      state: "ACTIVE",
      result: null,
      error: { code: "CAPABILITY_DENIED", message: "download negado por política", detail: { required: "download" } },
      timing: { started_at: "2026-08-24T00:00:00.000Z", ended_at: "2026-08-24T00:00:00.002Z", duration_ms: 2 },
    },
  });

  const res = (await srv.handleMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "browser_download", arguments: { url: "http://a.local/f.csv", session_id: "S" } },
  })) as JsonRpcResponse;

  const out = res.result as McpToolResult;
  assert.equal(out.isError, true, "falha do runtime foi entregue como SUCESSO — regressão grave");
  const txt = textoDe(out);
  assert.match(txt, /CAPABILITY_DENIED/, "error.code do contrato não sobreviveu");
  assert.match(txt, /download negado por política/, "mensagem do runtime não sobreviveu");
  assert.match(txt, /act_neg_9/, "action_id perdido — sem ele a auditoria não fecha");
  assert.match(txt, /http=403/, "status HTTP perdido");
  assert.match(txt, /"required": "download"/, "detail estruturado perdido");
});

test("3b. CONTROLE: o mesmo caminho com success=true NÃO marca isError", async () => {
  // Sem este controle, "isError=true" em 3a poderia ser simplesmente constante.
  fake.reset();
  const srv = novoServidor();
  fake.responder("browser.download", {
    payload: envelope({ download_id: "dl_1", filename: "f.csv" }),
  });
  const out = await srv.callTool("browser_download", { url: "http://a.local/f.csv", session_id: "S" });
  assert.notEqual(out.isError, true, "sucesso do runtime foi marcado como erro");
  assert.match(textoDe(out), /"download_id": "dl_1"/);
});

test("3c. runtime inalcançável vira isError explícito, não sucesso vazio", async () => {
  // Porta fechada de propósito: falha de transporte tem de aparecer no resultado.
  const srv = createMcpServer({ runtimeUrl: "http://127.0.0.1:1", timeoutMs: 2_000, token: TOKEN_DE_TESTE });
  const out = await srv.callTool("browser_observe", { session_id: "S" });
  assert.equal(out.isError, true, "runtime morto produziu resultado de sucesso");
  assert.match(textoDe(out), /MCP_TRANSPORT_ERROR/);
  assert.match(textoDe(out), /127\.0\.0\.1:1/);
});

test("3d. resposta fora do envelope ActionResponse não é aceita como sucesso", async () => {
  fake.reset();
  const srv = novoServidor();
  fake.responder("browser.observe", { payload: { qualquer: "coisa" } });
  const out = await srv.callTool("browser_observe", { session_id: "S" });
  assert.equal(out.isError, true, "resposta fora do contrato passou como sucesso");
  assert.match(textoDe(out), /ActionResponse/);
});

test("3e. resposta não-JSON do runtime não vira sucesso", async () => {
  fake.reset();
  const srv = novoServidor();
  const server = http.createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>bad gateway</html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  try {
    const s2 = createMcpServer({ runtimeUrl: `http://127.0.0.1:${addr.port}`, timeoutMs: 5_000, token: TOKEN_DE_TESTE });
    const out = await s2.callTool("browser_observe", { session_id: "S" });
    assert.equal(out.isError, true);
    assert.match(textoDe(out), /não é JSON/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("3f. argumento inválido vira erro de PROTOCOLO e não toca o runtime", async () => {
  const casos: Array<[string, Record<string, unknown>, RegExp]> = [
    ["browser_navigate", { session_id: "S" }, /"url" é obrigatório/],
    ["browser_type", { target: { selector: "#a" }, session_id: "S" }, /exatamente um entre "text" e "credential_ref"/],
    ["browser_type", { target: { selector: "#a" }, text: "x", credential_ref: "v", session_id: "S" }, /exatamente um/],
    ["browser_press", { session_id: "S" }, /exatamente um entre "key" e "keys"/],
    ["browser_scroll", { session_id: "S" }, /ao menos um/],
    ["browser_screenshot", { scope: "element", session_id: "S" }, /exige "target"/],
    ["browser_screenshot", { scope: "region", session_id: "S" }, /exige "region"/],
    ["browser_tabs", { action: "switch", session_id: "S" }, /exige "page_id"/],
    ["browser_download", { session_id: "S" }, /informe "target" ou "url"/],
    ["browser_find", { target: {}, session_id: "S" }, /não pode ser objeto vazio/],
    ["browser_find", { target: { xpath: "//a" }, session_id: "S" }, /campo\(s\) desconhecido\(s\)/],
    ["browser_navigate", { url: "http://a/", turbo: true, session_id: "S" }, /argumento\(s\) desconhecido\(s\)/],
    ["browser_navigate", { url: "http://a/", wait_until: "quando_der", session_id: "S" }, /deve ser um de/],
    ["browser_click", { target: { selector: "#a" }, verification: { kind: "MAGIA" }, session_id: "S" }, /verification.kind/],
  ];

  for (const [nome, args, esperado] of casos) {
    fake.reset();
    const srv = novoServidor();
    const res = (await srv.handleMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: nome, arguments: args },
    })) as JsonRpcResponse;
    assert.equal(res.result, undefined, `${nome}: entrada inválida devolveu resultado`);
    assert.equal(res.error?.code, -32602, `${nome}: código JSON-RPC errado`);
    assert.match(res.error?.message ?? "", esperado, `${nome}: mensagem não explica a falha`);
    assert.equal(fake.recebidas.length, 0, `${nome}: entrada inválida chegou a bater no runtime`);
  }
});

test("3g. ferramenta desconhecida é erro de protocolo, não silêncio", async () => {
  fake.reset();
  const srv = novoServidor();
  const res = (await srv.handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "browser_hack", arguments: {} },
  })) as JsonRpcResponse;
  assert.equal(res.error?.code, -32602);
  assert.match(res.error?.message ?? "", /desconhecida/);
  assert.equal(fake.recebidas.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. o pacote MCP não contém lógica de navegador
// ─────────────────────────────────────────────────────────────────────────────

test("4a. o fonte do pacote MCP não menciona o motor de navegador", () => {
  // Agulha montada em pedaços para que ESTA linha não seja o que o teste acha
  // caso alguém amplie o grep para o próprio arquivo de teste no futuro.
  const agulha = ["play", "wright"].join("");
  const arquivos = [SERVER_TS, TOOLS_TS, PKG_JSON];

  for (const arq of arquivos) {
    const src = readFileSync(arq, "utf8").toLowerCase();
    assert.equal(src.includes(agulha), false, `${path.relative(RAIZ, arq)} menciona o motor de navegador — a FASE 6 proíbe`);
    assert.equal(src.includes("chromium"), false, `${path.relative(RAIZ, arq)} menciona chromium`);
    assert.equal(/\bcdpsession\b/.test(src), false, `${path.relative(RAIZ, arq)} menciona CDP`);
  }

  // CONTROLE DO INSTRUMENTO: a busca só significa alguma coisa se for capaz de
  // ACHAR. O spike da FASE 1 sabidamente importa o motor — se não achar lá, o
  // grep está quebrado e os PASS acima seriam decorativos.
  const spike = readFileSync(path.join(RAIZ, "spike/fase1_spike.ts"), "utf8").toLowerCase();
  assert.equal(spike.includes(agulha), true, "controle falhou: o grep não acha a agulha nem onde ela existe");
});

test("4b. o pacote MCP importa apenas o contrato e a stdlib do Node", () => {
  for (const arq of [SERVER_TS, TOOLS_TS]) {
    const src = readFileSync(arq, "utf8");
    const imports = [...src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, `${path.relative(RAIZ, arq)}: nenhum import encontrado (regex quebrada?)`);
    for (const spec of imports) {
      const ok = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
      assert.ok(ok, `${path.relative(RAIZ, arq)}: import externo proibido: ${spec}`);
      if (spec.startsWith("../")) {
        assert.match(spec, /core\/src\/contract\.ts$/, `${path.relative(RAIZ, arq)}: só o contrato pode ser importado de fora, veio ${spec}`);
      }
    }
  }
});

test("4c. package.json declara o binário e não tem dependências", () => {
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(pkg.name, "@nomos/browser-mcp");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["nomos-browser-mcp"], "./src/server.ts");
  assert.equal(pkg.dependencies, undefined, "pacote MCP não pode ter dependências");
  assert.equal(pkg.devDependencies, undefined, "pacote MCP não pode ter dependências");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. framing stdio no processo de verdade
// ─────────────────────────────────────────────────────────────────────────────

interface Sessao {
  enviar: (msg: unknown) => void;
  esperar: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>;
  stderr: () => string;
  encerrar: () => Promise<number | null>;
}

function subirProcesso(env: Record<string, string>): Sessao {
  const filho = spawn(process.execPath, [SERVER_TS], {
    cwd: RAIZ,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const recebidas = new Map<number, JsonRpcResponse>();
  const aguardando = new Map<number, (r: JsonRpcResponse) => void>();
  let buf = "";
  let err = "";

  filho.stdout.setEncoding("utf8");
  filho.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const linha = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (linha.trim() === "") continue;
      const msg = JSON.parse(linha) as JsonRpcResponse;
      const id = msg.id as number;
      recebidas.set(id, msg);
      aguardando.get(id)?.(msg);
      aguardando.delete(id);
    }
  });
  filho.stderr.setEncoding("utf8");
  filho.stderr.on("data", (c: string) => {
    err += c;
  });

  return {
    enviar: (msg) => filho.stdin.write(`${JSON.stringify(msg)}\n`),
    esperar: (id, timeoutMs = 10_000) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const pronta = recebidas.get(id);
        if (pronta !== undefined) return resolve(pronta);
        const t = setTimeout(() => reject(new Error(`timeout esperando resposta id=${id}; stderr=${err}`)), timeoutMs);
        aguardando.set(id, (r) => {
          clearTimeout(t);
          resolve(r);
        });
      }),
    stderr: () => err,
    encerrar: () =>
      new Promise<number | null>((resolve) => {
        filho.once("exit", (code) => resolve(code));
        filho.stdin.end();
      }),
  };
}

test("5a. processo real: initialize + tools/list + tools/call por stdio", async () => {
  fake.reset();
  const s = subirProcesso({ NOMOS_BROWSER_URL: fake.url, NOMOS_BROWSER_OWNER: "teste-stdio", NOMOS_BROWSER_TOKEN: TOKEN_DE_TESTE });
  try {
    s.enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const init = await s.esperar(1);
    assert.equal(init.error, undefined, `initialize falhou: ${JSON.stringify(init.error)} stderr=${s.stderr()}`);
    const ir = init.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } };
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(ir.protocolVersion), `protocolVersion não suportada: ${ir.protocolVersion}`);
    assert.equal(ir.serverInfo.name, "nomos-browser-mcp");
    assert.ok(ir.capabilities.tools !== undefined, "servidor não anuncia capability de tools");

    // Notificação NÃO pode gerar resposta. Se gerar, o id 3 seguinte casaria errado.
    s.enviar({ jsonrpc: "2.0", method: "notifications/initialized" });

    s.enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const lista = await s.esperar(2);
    assert.equal((lista.result as { tools: unknown[] }).tools.length, 13);

    s.enviar({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "http://exemplo.local/z" } },
    });
    const chamada = await s.esperar(3);
    assert.equal(chamada.error, undefined, `tools/call falhou: ${JSON.stringify(chamada.error)}`);
    assert.notEqual((chamada.result as McpToolResult).isError, true);

    const urls = fake.recebidas.map((r) => r.url);
    assert.deepEqual(urls, ["/api/v1/sessions", "/api/v1/browser.goto"], `sequência HTTP inesperada: ${JSON.stringify(urls)}`);
    assert.equal((fake.recebidas[0].body as Record<string, unknown>).owner, "teste-stdio");
  } finally {
    await s.encerrar();
  }
});

test("5b. processo real: linha inválida vira -32700 e o servidor continua vivo", async () => {
  fake.reset();
  const s = subirProcesso({ NOMOS_BROWSER_URL: fake.url });
  try {
    s.enviar({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.deepEqual((await s.esperar(1)).result, {}, "ping não respondeu");

    s.enviar({ jsonrpc: "2.0", id: 2, method: "metodo/inexistente" });
    const naoExiste = await s.esperar(2);
    assert.equal(naoExiste.error?.code, -32601, "método inexistente devia dar -32601");

    s.enviar({ jsonrpc: "2.0", id: 3, method: "ping" });
    const vivo = await s.esperar(3);
    assert.deepEqual(vivo.result, {}, "servidor não sobreviveu ao método inexistente");
  } finally {
    const code = await s.encerrar();
    assert.equal(code, 0, "servidor não encerrou limpo ao fechar stdin");
  }
});

test("5c. processo real: JSON quebrado na linha devolve -32700", async () => {
  fake.reset();
  const filho = spawn(process.execPath, [SERVER_TS], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_URL: fake.url, NOMOS_BROWSER_TOKEN: TOKEN_DE_TESTE },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const primeira = new Promise<JsonRpcResponse>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("timeout esperando -32700")), 10_000);
      filho.stdout.setEncoding("utf8");
      filho.stdout.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(t);
          resolve(JSON.parse(buf.slice(0, nl)));
        }
      });
    });
    filho.stdin.write("{ isto não é json }\n");
    const res = await primeira;
    assert.equal(res.error?.code, -32700, `esperava parse error, veio ${JSON.stringify(res)}`);
    assert.equal(res.id, null);
  } finally {
    filho.stdin.end();
    await new Promise<void>((r) => filho.once("exit", () => r()));
  }
});

test("5d. stdin fechado logo após o pedido não trunca a resposta", async () => {
  // Regressão contra encerramento à força: se o processo saísse sem drenar,
  // a resposta ficaria no buffer do pipe e o cliente veria silêncio.
  fake.reset();
  const filho = spawn(process.execPath, [SERVER_TS], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_URL: fake.url, NOMOS_BROWSER_TOKEN: TOKEN_DE_TESTE },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  filho.stdout.setEncoding("utf8");
  filho.stdout.on("data", (c: string) => {
    out += c;
  });

  filho.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { goal: "provar drenagem" } } })}\n`,
  );
  filho.stdin.end(); // fecha imediatamente, sem esperar a resposta

  const code = await new Promise<number | null>((r) => filho.once("exit", (c) => r(c)));
  assert.equal(code, 0, "servidor não encerrou limpo");
  const linhas = out.trim().split("\n").filter((l) => l !== "");
  assert.equal(linhas.length, 1, `esperava 1 resposta drenada, veio: ${JSON.stringify(out)}`);
  const res = JSON.parse(linhas[0]) as JsonRpcResponse;
  assert.equal(res.id, 1);
  assert.notEqual((res.result as McpToolResult).isError, true);
  assert.deepEqual(fake.recebidas.map((r) => r.url), ["/api/v1/sessions", "/api/v1/browser.task"]);
});

test("5e. URL de runtime inválida derruba o arranque em vez de cair no default", async () => {
  const filho = spawn(process.execPath, [SERVER_TS], {
    cwd: RAIZ,
    env: { ...process.env, NOMOS_BROWSER_URL: "isto-nao-e-url" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  filho.stderr.setEncoding("utf8");
  filho.stderr.on("data", (c: string) => {
    err += c;
  });
  const code = await new Promise<number | null>((r) => filho.once("exit", (c) => r(c)));
  assert.equal(code, 2, `esperava exit 2, veio ${code}; stderr=${err}`);
  assert.match(err, /NOMOS_BROWSER_URL inválida/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. detalhes de tradução que não dependem de I/O
// ─────────────────────────────────────────────────────────────────────────────

test("6a. buildRuntimeCall é pura e monta o caminho com o prefixo do contrato", () => {
  const c = buildRuntimeCall("browser_click", { target: { text: "OK" } }, "S1");
  assert.equal(c.route, "browser.click");
  assert.equal(c.path, `${API_PREFIX}/browser.click`);
  assert.deepEqual(c.body, { session_id: "S1", target: { text: "OK" } });
  // Campo opcional ausente não pode virar chave undefined no corpo.
  assert.equal("verification" in c.body, false, "corpo carrega chave fantasma");
});

test("6b. ToolInputError carrega um ActionErrorCode do contrato", () => {
  let capturado: unknown;
  try {
    buildRuntimeCall("browser_navigate", {}, "S");
    assert.fail("buildRuntimeCall aceitou entrada sem url");
  } catch (err) {
    capturado = err;
  }
  assert.ok(capturado instanceof ToolInputError, `esperava ToolInputError, veio ${String(capturado)}`);
  assert.equal((capturado as ToolInputError).code, "INVALID_REQUEST");
});

test("6c. RuntimeClient recusa esquema não-HTTP", () => {
  assert.throws(() => new RuntimeClient({ runtimeUrl: "file:///etc/passwd" }), /deve ser http/);
  assert.equal(new RuntimeClient({ runtimeUrl: "http://127.0.0.1:7777/" }).baseUrl, "http://127.0.0.1:7777");
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 11 — AUTORIZAÇÃO MCP
//
// O `docs/SECURITY.md` declarava, verbatim, que "autorização MCP ainda não está
// implementada" e que, enquanto isso, "qualquer processo local fala com o
// runtime". Estes três casos são o que fecha essa frase.
// ─────────────────────────────────────────────────────────────────────────────

test("6a. sem credencial o servidor MCP recusa ANTES de abrir socket", async () => {
  fake.reset();
  // `token: null` é explícito: nem o ambiente do operador vale aqui.
  const srv = createMcpServer({ runtimeUrl: fake.url, owner: "teste", timeoutMs: 5_000, token: null });
  const out = await srv.callTool("browser_observe", { session_id: "S" });
  assert.equal(out.isError, true, "chamada sem credencial não foi recusada");
  assert.match(textoDe(out), /MCP_NO_CREDENTIAL/);
  assert.match(textoDe(out), /NOMOS_BROWSER_TOKEN/);
  // A recusa é LOCAL: nada chegou ao runtime. Mandar e deixar o daemon negar
  // significaria que o servidor MCP acha aceitável tentar — e num dia em que
  // alguém suba o daemon com NOMOS_BROWSER_AUTH=off, "tentar" vira "conseguir".
  assert.deepEqual(fake.recebidas, [], `abriu socket sem credencial: ${JSON.stringify(fake.recebidas)}`);
});

test("6b. a credencial é PROPAGADA em toda chamada ao runtime", async () => {
  fake.reset();
  const srv = novoServidor();
  await srv.callTool("browser_observe", { session_id: "S" });
  assert.ok(fake.recebidas.length > 0, "nenhuma chamada chegou ao runtime");
  for (const r of fake.recebidas) {
    assert.equal(r.authorization, `Bearer ${TOKEN_DE_TESTE}`, `chamada a ${r.url} saiu sem credencial`);
  }
});

test("6c. recusa por ESCOPO do runtime vira erro MCP com nome próprio", async () => {
  fake.reset();
  const srv = novoServidor();
  // O runtime recusa por escopo — é a resposta REAL de `auth.authorize`.
  fake.responder("browser.click", {
    status: 403,
    payload: envelope(null, {
      success: false,
      error: {
        code: "CAPABILITY_DENIED",
        message: "escopo INPUT não concedido a observador",
        detail: { auth: "SCOPE_DENIED", required_scope: "INPUT", subject: "observador" },
      },
    }),
  });
  const out = await srv.callTool("browser_click", { target: { selector: "#b" }, session_id: "S" });
  assert.equal(out.isError, true);
  // Nome próprio: "seu token não tem INPUT" e "outra IA está com o volante"
  // saem ambos como CAPABILITY_DENIED no contrato e pedem ações opostas.
  assert.match(textoDe(out), /MCP_SCOPE_DENIED/);
  assert.match(textoDe(out), /required_scope=INPUT/);
  // O código do contrato não é perdido no caminho.
  assert.match(textoDe(out), /contract_code=CAPABILITY_DENIED/);
});

test("6d. recusa por ARBITRAGEM de lease também tem nome próprio", async () => {
  fake.reset();
  const srv = novoServidor();
  fake.responder("browser.click", {
    status: 409,
    payload: envelope(null, {
      success: false,
      error: {
        code: "CAPABILITY_DENIED",
        message: "IA-B não detém o lease da sessão",
        detail: { lease: "CONTROL_NOT_OWNED", current_holder: "IA-A" },
      },
    }),
  });
  const out = await srv.callTool("browser_click", { target: { selector: "#b" }, session_id: "S" });
  assert.equal(out.isError, true);
  assert.match(textoDe(out), /MCP_CONTROL_NOT_OWNED/);
  assert.match(textoDe(out), /IA-A/);
});
