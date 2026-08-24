/**
 * FASE 6 — CATÁLOGO DE FERRAMENTAS MCP
 *
 * Este módulo é uma TRADUÇÃO, não uma implementação. Ele converte
 * `tools/call` do MCP em `{rota, corpo}` da API v1 do Browser Runtime — e nada
 * mais. Não há automação de navegador aqui, nem deve haver: o runtime é o único
 * dono do navegador. Se este pacote soubesse dirigir um, existiriam dois donos
 * do mesmo estado e a auditoria do runtime passaria a mentir por omissão.
 *
 * Toda rota emitida é conferida contra `ACTION_CLASS` / `REQUIRED_CAPABILITY`
 * do contrato no momento do import (ver AUTOCONFERÊNCIA no fim do arquivo).
 * Rota que o contrato não conhece derruba o processo no arranque, em vez de
 * virar 404 silencioso na primeira chamada do agente.
 */
import {
  ACTION_CLASS,
  API_PREFIX,
  REQUIRED_CAPABILITY,
  type ActionErrorCode,
  type TargetDescriptor,
  type VerificationKind,
  type VerificationSpec,
} from "../../core/src/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Erros de entrada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entrada inválida vinda do cliente MCP. Carrega um `ActionErrorCode` do
 * contrato para que a resposta ao agente use o mesmo vocabulário de erro da
 * API v1 — o agente não precisa aprender dois dicionários.
 */
export class ToolInputError extends Error {
  readonly code: ActionErrorCode = "INVALID_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos locais do protocolo MCP (não pertencem ao contrato do runtime)
// ─────────────────────────────────────────────────────────────────────────────

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Rotas da API v1 que esta ferramenta pode acionar. Usado na autoconferência. */
  routes: string[];
  /** Tradução pura args → corpo do POST. Lança `ToolInputError` se inválido. */
  build: (args: Record<string, unknown>, sessionId: string) => RuntimeCall;
}

export interface RuntimeCall {
  /** Nome da ferramenta no contrato, ex.: "browser.goto". */
  route: string;
  /** Caminho HTTP completo, ex.: "/api/v1/browser.goto". */
  path: string;
  body: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitores de argumento — fail closed
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknown(tool: string, args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new ToolInputError(`${tool}: argumento(s) desconhecido(s): ${extra.join(", ")}. Aceitos: ${allowed.join(", ")}`);
  }
}

function readString(tool: string, args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${tool}: "${key}" é obrigatório`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolInputError(`${tool}: "${key}" deve ser string, veio ${typeof v}`);
  if (required && v.length === 0) throw new ToolInputError(`${tool}: "${key}" não pode ser vazio`);
  return v;
}

function readBool(tool: string, args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolInputError(`${tool}: "${key}" deve ser boolean, veio ${typeof v}`);
  return v;
}

function readNumber(tool: string, args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolInputError(`${tool}: "${key}" deve ser número finito`);
  }
  return v;
}

function readInt(tool: string, args: Record<string, unknown>, key: string, min: number): number | undefined {
  const v = readNumber(tool, args, key);
  if (v === undefined) return undefined;
  if (!Number.isInteger(v)) throw new ToolInputError(`${tool}: "${key}" deve ser inteiro`);
  if (v < min) throw new ToolInputError(`${tool}: "${key}" deve ser >= ${min}`);
  return v;
}

function readEnum(tool: string, args: Record<string, unknown>, key: string, values: readonly string[]): string | undefined {
  const v = readString(tool, args, key, false);
  if (v === undefined) return undefined;
  if (!values.includes(v)) throw new ToolInputError(`${tool}: "${key}" deve ser um de [${values.join(", ")}], veio "${v}"`);
  return v;
}

const TARGET_KEYS = ["selector", "text", "role", "label", "placeholder", "semantic", "coordinates", "nth"] as const;

/**
 * Valida um `TargetDescriptor`. Alvo vazio é recusado aqui e não no runtime:
 * `{}` faria o resolvedor tentar a cascata inteira contra nada e devolver
 * TARGET_NOT_FOUND depois de gastar timeout — erro tardio e caro por um defeito
 * que é visível na entrada.
 */
function readTarget(tool: string, args: Record<string, unknown>, key: string, required: boolean): TargetDescriptor | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${tool}: "${key}" é obrigatório`);
    return undefined;
  }
  if (!isPlainObject(v)) throw new ToolInputError(`${tool}: "${key}" deve ser um objeto TargetDescriptor`);
  const extra = Object.keys(v).filter((k) => !TARGET_KEYS.includes(k as (typeof TARGET_KEYS)[number]));
  if (extra.length > 0) throw new ToolInputError(`${tool}: "${key}" tem campo(s) desconhecido(s): ${extra.join(", ")}`);
  if (Object.keys(v).length === 0) throw new ToolInputError(`${tool}: "${key}" não pode ser objeto vazio`);

  const coords = v.coordinates;
  if (coords !== undefined) {
    if (!isPlainObject(coords) || typeof coords.x !== "number" || typeof coords.y !== "number") {
      throw new ToolInputError(`${tool}: "${key}.coordinates" deve ser {x:number, y:number}`);
    }
  }
  if (v.nth !== undefined && (typeof v.nth !== "number" || !Number.isInteger(v.nth) || v.nth < 0)) {
    throw new ToolInputError(`${tool}: "${key}.nth" deve ser inteiro >= 0`);
  }
  for (const k of ["selector", "text", "role", "label", "placeholder", "semantic"]) {
    if (v[k] !== undefined && typeof v[k] !== "string") {
      throw new ToolInputError(`${tool}: "${key}.${k}" deve ser string`);
    }
  }
  return v as TargetDescriptor;
}

/** Valores de `VerificationKind`. Tipado contra o contrato: se o enum mudar, isto quebra na compilação. */
const VERIFICATION_KINDS: readonly VerificationKind[] = [
  "URL_CHANGED",
  "ELEMENT_APPEARED",
  "ELEMENT_DISAPPEARED",
  "NETWORK_SUCCESS",
  "TEXT_CHANGED",
  "DOM_CHANGED",
  "NONE",
];

function readVerification(tool: string, args: Record<string, unknown>): VerificationSpec | undefined {
  const v = args.verification;
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) throw new ToolInputError(`${tool}: "verification" deve ser objeto`);
  const extra = Object.keys(v).filter((k) => !["kind", "expect", "timeout_ms"].includes(k));
  if (extra.length > 0) throw new ToolInputError(`${tool}: "verification" tem campo(s) desconhecido(s): ${extra.join(", ")}`);
  const kind = v.kind;
  if (typeof kind !== "string" || !VERIFICATION_KINDS.includes(kind as VerificationKind)) {
    throw new ToolInputError(`${tool}: "verification.kind" deve ser um de [${VERIFICATION_KINDS.join(", ")}]`);
  }
  if (v.expect !== undefined && typeof v.expect !== "string") {
    throw new ToolInputError(`${tool}: "verification.expect" deve ser string`);
  }
  if (v.timeout_ms !== undefined && (typeof v.timeout_ms !== "number" || !Number.isInteger(v.timeout_ms) || v.timeout_ms < 0)) {
    throw new ToolInputError(`${tool}: "verification.timeout_ms" deve ser inteiro >= 0`);
  }
  // Construção explícita a partir do que foi validado logo acima. Um `as` aqui
  // afirmaria um formato que o validador nunca conferiu campo a campo.
  const spec: VerificationSpec = { kind: v.kind as VerificationSpec["kind"] };
  if (typeof v.expect === "string") spec.expect = v.expect;
  if (typeof v.timeout_ms === "number") spec.timeout_ms = v.timeout_ms;
  return spec;
}

/** Remove chaves `undefined` — o corpo do POST não deve carregar campo fantasma. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v;
  return out;
}

function call(route: string, body: Record<string, unknown>): RuntimeCall {
  return { route, path: `${API_PREFIX}/${route}`, body: compact(body) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragmentos de JSON Schema reaproveitados
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID_PROP = {
  type: "string",
  description: "Sessão do runtime. Se omitido, o servidor MCP cria uma e reutiliza no processo.",
} as const;

const TARGET_SCHEMA = {
  type: "object",
  description:
    "Descritor de alvo. Combine campos: o runtime tenta a cascata seletor → role/text → acessibilidade → semântico → visão → coordenada e informa qual funcionou. Alvo só com 'selector' é frágil por construção.",
  properties: {
    selector: { type: "string", description: "Seletor CSS." },
    text: { type: "string", description: "Texto visível do elemento." },
    role: { type: "string", description: "Role ARIA, ex.: button, link, textbox." },
    label: { type: "string", description: "Rótulo acessível." },
    placeholder: { type: "string", description: "Placeholder do campo." },
    semantic: { type: "string", description: "Descrição em linguagem natural do alvo." },
    coordinates: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
    nth: { type: "integer", minimum: 0, description: "Índice quando o alvo é legitimamente múltiplo." },
  },
  additionalProperties: false,
  minProperties: 1,
} as const;

const VERIFICATION_SCHEMA = {
  type: "object",
  description: "Como provar que a ação surtiu efeito. Sem isto o runtime devolve confiança baixa.",
  properties: {
    kind: { type: "string", enum: [...VERIFICATION_KINDS] },
    expect: { type: "string", description: "Valor esperado conforme o kind." },
    timeout_ms: { type: "integer", minimum: 0 },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

function schema(props: Record<string, unknown>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties: { ...props, session_id: SESSION_ID_PROP },
    required,
    additionalProperties: false,
  };
}

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const;
const SCREENSHOT_SCOPES = ["viewport", "full", "element", "region"] as const;
const TAB_ACTIONS = ["list", "new", "switch", "close"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// As 13 ferramentas
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "browser_navigate",
    description:
      "Navega a sessão para uma URL e devolve a página resultante (PageInfo). Mapeia para POST /api/v1/browser.goto.",
    routes: ["browser.goto"],
    inputSchema: schema(
      {
        url: { type: "string", description: "URL absoluta de destino." },
        wait_until: { type: "string", enum: [...WAIT_UNTIL], description: "Condição de carga antes de retornar." },
      },
      ["url"],
    ),
    build: (args, sessionId) => {
      rejectUnknown("browser_navigate", args, ["url", "wait_until", "session_id"]);
      return call("browser.goto", {
        session_id: sessionId,
        url: readString("browser_navigate", args, "url", true),
        wait_until: readEnum("browser_navigate", args, "wait_until", WAIT_UNTIL),
      });
    },
  },
  {
    name: "browser_observe",
    description:
      "Observa a página atual: elementos, título, URL e (opcional) árvore de acessibilidade e screenshot. Devolve Observation, que informa total_elements e truncated — leia esses campos antes de concluir que a página é pequena.",
    routes: ["browser.observe"],
    inputSchema: schema({
      accessibility: { type: "boolean", description: "Incluir a árvore de acessibilidade serializada." },
      screenshot: { type: "boolean", description: "Capturar screenshot e devolver a referência." },
      limit: { type: "integer", minimum: 1, description: "Máximo de elementos retornados." },
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_observe", args, ["accessibility", "screenshot", "limit", "session_id"]);
      return call("browser.observe", {
        session_id: sessionId,
        accessibility: readBool("browser_observe", args, "accessibility"),
        screenshot: readBool("browser_observe", args, "screenshot"),
        limit: readInt("browser_observe", args, "limit", 1),
      });
    },
  },
  {
    name: "browser_find",
    description:
      "Resolve um alvo sem agir sobre ele. Devolve ResolvedTarget com a estratégia que acertou, as tentadas e se houve self-healing.",
    routes: ["browser.find"],
    inputSchema: schema({ target: TARGET_SCHEMA }, ["target"]),
    build: (args, sessionId) => {
      rejectUnknown("browser_find", args, ["target", "session_id"]);
      return call("browser.find", {
        session_id: sessionId,
        target: readTarget("browser_find", args, "target", true),
      });
    },
  },
  {
    name: "browser_click",
    description: "Clica no alvo resolvido e verifica o efeito. Devolve o alvo resolvido e o resultado da verificação.",
    routes: ["browser.click"],
    inputSchema: schema({ target: TARGET_SCHEMA, verification: VERIFICATION_SCHEMA }, ["target"]),
    build: (args, sessionId) => {
      rejectUnknown("browser_click", args, ["target", "verification", "session_id"]);
      return call("browser.click", {
        session_id: sessionId,
        target: readTarget("browser_click", args, "target", true),
        verification: readVerification("browser_click", args),
      });
    },
  },
  {
    name: "browser_type",
    description:
      "Digita em um campo. Use 'text' para valor comum ou 'credential_ref' para segredo — com credential_ref o valor é injetado pelo runtime e NUNCA transita por aqui nem aparece em log. Exatamente um dos dois.",
    routes: ["browser.type"],
    inputSchema: {
      type: "object",
      properties: {
        target: TARGET_SCHEMA,
        text: { type: "string", description: "Texto literal a digitar." },
        credential_ref: {
          type: "string",
          description: "Referência de segredo no vault do runtime. O valor não volta na resposta.",
        },
        verification: VERIFICATION_SCHEMA,
        session_id: SESSION_ID_PROP,
      },
      required: ["target"],
      additionalProperties: false,
      oneOf: [{ required: ["text"] }, { required: ["credential_ref"] }],
    },
    build: (args, sessionId) => {
      rejectUnknown("browser_type", args, ["target", "text", "credential_ref", "verification", "session_id"]);
      const text = readString("browser_type", args, "text", false);
      const credential_ref = readString("browser_type", args, "credential_ref", false);
      // Fail closed: os dois juntos é ambíguo (qual vence?) e nenhum é ação vazia.
      if ((text === undefined) === (credential_ref === undefined)) {
        throw new ToolInputError('browser_type: forneça exatamente um entre "text" e "credential_ref"');
      }
      return call("browser.type", {
        session_id: sessionId,
        target: readTarget("browser_type", args, "target", true),
        text,
        credential_ref,
        verification: readVerification("browser_type", args),
      });
    },
  },
  {
    name: "browser_press",
    description: "Pressiona uma tecla ('key') ou uma sequência ('keys'), ex.: Enter, Tab, Control+A.",
    routes: ["browser.press"],
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Tecla única, ex.: Enter." },
        keys: { type: "array", items: { type: "string" }, minItems: 1, description: "Sequência de teclas." },
        session_id: SESSION_ID_PROP,
      },
      additionalProperties: false,
      oneOf: [{ required: ["key"] }, { required: ["keys"] }],
    },
    build: (args, sessionId) => {
      rejectUnknown("browser_press", args, ["key", "keys", "session_id"]);
      const key = readString("browser_press", args, "key", false);
      let keys: string[] | undefined;
      if (args.keys !== undefined && args.keys !== null) {
        if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.some((k) => typeof k !== "string")) {
          throw new ToolInputError('browser_press: "keys" deve ser array não vazio de string');
        }
        keys = args.keys as string[];
      }
      if ((key === undefined) === (keys === undefined)) {
        throw new ToolInputError('browser_press: forneça exatamente um entre "key" e "keys"');
      }
      return call("browser.press", { session_id: sessionId, key, keys });
    },
  },
  {
    name: "browser_scroll",
    description: "Rola a página ou um contêiner. Informe dx/dy em pixels e/ou um target para rolar até o elemento.",
    routes: ["browser.scroll"],
    inputSchema: schema({
      dx: { type: "number", description: "Deslocamento horizontal em pixels." },
      dy: { type: "number", description: "Deslocamento vertical em pixels." },
      target: TARGET_SCHEMA,
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_scroll", args, ["dx", "dy", "target", "session_id"]);
      const dx = readNumber("browser_scroll", args, "dx");
      const dy = readNumber("browser_scroll", args, "dy");
      const target = readTarget("browser_scroll", args, "target", false);
      if (dx === undefined && dy === undefined && target === undefined) {
        throw new ToolInputError('browser_scroll: informe ao menos um entre "dx", "dy" e "target"');
      }
      return call("browser.scroll", { session_id: sessionId, dx, dy, target });
    },
  },
  {
    name: "browser_extract",
    description: "Extrai conteúdo da página inteira ou de um alvo. 'format' é repassado ao runtime (ex.: text, html, markdown).",
    routes: ["browser.extract"],
    inputSchema: schema({
      target: TARGET_SCHEMA,
      format: { type: "string", description: "Formato de saída pedido ao runtime, ex.: text, html, markdown." },
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_extract", args, ["target", "format", "session_id"]);
      return call("browser.extract", {
        session_id: sessionId,
        target: readTarget("browser_extract", args, "target", false),
        format: readString("browser_extract", args, "format", false),
      });
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Captura screenshot. scope=viewport|full|element|region. Devolve a referência da imagem (screenshot_ref), não os bytes.",
    routes: ["browser.screenshot"],
    inputSchema: schema({
      scope: { type: "string", enum: [...SCREENSHOT_SCOPES], description: "Escopo da captura. Default do runtime: viewport." },
      target: TARGET_SCHEMA,
      region: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
      },
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_screenshot", args, ["scope", "target", "region", "session_id"]);
      const scope = readEnum("browser_screenshot", args, "scope", SCREENSHOT_SCOPES);
      const target = readTarget("browser_screenshot", args, "target", false);
      let region: Record<string, number> | undefined;
      if (args.region !== undefined && args.region !== null) {
        const r = args.region;
        if (!isPlainObject(r) || ["x", "y", "width", "height"].some((k) => typeof r[k] !== "number")) {
          throw new ToolInputError('browser_screenshot: "region" deve ser {x,y,width,height} numéricos');
        }
        region = r as Record<string, number>;
      }
      // Escopo sem o dado que ele exige produziria captura do lugar errado — o
      // pior tipo de falha aqui, porque a imagem "funciona" e mente.
      if (scope === "element" && target === undefined) {
        throw new ToolInputError('browser_screenshot: scope="element" exige "target"');
      }
      if (scope === "region" && region === undefined) {
        throw new ToolInputError('browser_screenshot: scope="region" exige "region"');
      }
      return call("browser.screenshot", { session_id: sessionId, scope, target, region });
    },
  },
  {
    name: "browser_tabs",
    description:
      "Gerencia abas. action=list (default) lista PageInfo[]; new abre aba (url opcional); switch foca page_id; close fecha page_id.",
    routes: ["browser.tabs", "browser.new_tab", "browser.switch_tab", "browser.close_tab"],
    inputSchema: schema({
      action: { type: "string", enum: [...TAB_ACTIONS], description: "Operação sobre abas. Default: list." },
      url: { type: "string", description: "URL inicial quando action=new." },
      page_id: { type: "string", description: "Aba alvo quando action=switch ou close." },
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_tabs", args, ["action", "url", "page_id", "session_id"]);
      const action = readEnum("browser_tabs", args, "action", TAB_ACTIONS) ?? "list";
      const url = readString("browser_tabs", args, "url", false);
      const page_id = readString("browser_tabs", args, "page_id", false);
      if ((action === "switch" || action === "close") && page_id === undefined) {
        throw new ToolInputError(`browser_tabs: action="${action}" exige "page_id"`);
      }
      if (action === "list") return call("browser.tabs", { session_id: sessionId });
      if (action === "new") return call("browser.new_tab", { session_id: sessionId, url });
      if (action === "switch") return call("browser.switch_tab", { session_id: sessionId, page_id });
      return call("browser.close_tab", { session_id: sessionId, page_id });
    },
  },
  {
    name: "browser_download",
    description:
      "Baixa um arquivo a partir de um alvo clicável ou de uma URL direta. Ação COMMIT: exige a capability 'download', negada por padrão — sem concessão explícita do dono o runtime responde CAPABILITY_DENIED.",
    routes: ["browser.download"],
    inputSchema: schema({
      target: TARGET_SCHEMA,
      url: { type: "string", description: "URL direta do arquivo." },
    }),
    build: (args, sessionId) => {
      rejectUnknown("browser_download", args, ["target", "url", "session_id"]);
      const target = readTarget("browser_download", args, "target", false);
      const url = readString("browser_download", args, "url", false);
      if (target === undefined && url === undefined) {
        throw new ToolInputError('browser_download: informe "target" ou "url"');
      }
      return call("browser.download", { session_id: sessionId, target, url });
    },
  },
  {
    name: "browser_upload",
    description:
      "Envia um arquivo para um campo de upload. Ação COMMIT: exige a capability 'upload', negada por padrão — sem concessão explícita do dono o runtime responde CAPABILITY_DENIED.",
    routes: ["browser.upload"],
    inputSchema: {
      type: "object",
      properties: {
        target: TARGET_SCHEMA,
        path: { type: "string", description: "Caminho do arquivo local (validado pelo runtime)." },
        file_ref: { type: "string", description: "Referência de arquivo já registrada no runtime." },
        session_id: SESSION_ID_PROP,
      },
      required: ["target"],
      additionalProperties: false,
      oneOf: [{ required: ["path"] }, { required: ["file_ref"] }],
    },
    build: (args, sessionId) => {
      rejectUnknown("browser_upload", args, ["target", "path", "file_ref", "session_id"]);
      const p = readString("browser_upload", args, "path", false);
      const file_ref = readString("browser_upload", args, "file_ref", false);
      if ((p === undefined) === (file_ref === undefined)) {
        throw new ToolInputError('browser_upload: forneça exatamente um entre "path" e "file_ref"');
      }
      return call("browser.upload", {
        session_id: sessionId,
        target: readTarget("browser_upload", args, "target", true),
        path: p,
        file_ref,
      });
    },
  },
  {
    name: "browser_task",
    description:
      "Entrega um objetivo em linguagem natural ao executor de tarefas do runtime e devolve BrowserTask (task_id, state, plan, evidence). O planejamento é do runtime; este servidor não decide passos.",
    routes: ["browser.task"],
    inputSchema: schema(
      {
        goal: { type: "string", description: "Objetivo a atingir." },
        profile: { type: "string", description: "Perfil de navegador a usar." },
      },
      ["goal"],
    ),
    build: (args, sessionId) => {
      rejectUnknown("browser_task", args, ["goal", "profile", "session_id"]);
      return call("browser.task", {
        session_id: sessionId,
        goal: readString("browser_task", args, "goal", true),
        profile: readString("browser_task", args, "profile", false),
      });
    },
  },
]);

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOLS.map((t) => t.name));

export function toolByName(name: string): McpToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Forma exposta em `tools/list` — sem `routes`/`build`, que são internos. */
export function listToolsPayload(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * Traduz uma chamada MCP em um POST da API v1. Pura: não faz I/O, não decide
 * sessão. Quem resolve a sessão é o servidor.
 */
export function buildRuntimeCall(name: string, args: Record<string, unknown>, sessionId: string): RuntimeCall {
  const tool = toolByName(name);
  if (tool === undefined) throw new ToolInputError(`ferramenta desconhecida: ${name}`);
  if (!isPlainObject(args)) throw new ToolInputError(`${name}: "arguments" deve ser objeto`);
  return tool.build(args, sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOCONFERÊNCIA — roda no import, derruba o processo no arranque
// ─────────────────────────────────────────────────────────────────────────────

for (const tool of TOOLS) {
  if (tool.routes.length === 0) throw new Error(`mcp/tools: ${tool.name} não declara rota`);
  for (const route of tool.routes) {
    if (!(route in ACTION_CLASS)) {
      throw new Error(`mcp/tools: ${tool.name} aponta para "${route}", que não existe em ACTION_CLASS do contrato`);
    }
    if (!(route in REQUIRED_CAPABILITY)) {
      throw new Error(`mcp/tools: "${route}" não tem capability exigida no contrato — fail closed, rota recusada`);
    }
  }
}
