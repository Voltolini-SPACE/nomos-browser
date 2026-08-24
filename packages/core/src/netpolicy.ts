/**
 * FASE 29/30 — POLÍTICA DE REDE DO NAVEGADOR
 *
 * `policy.ts` já tem um guarda de URL (`checkUrl`) que resolve o essencial:
 * allowlist de esquema, recusa de userinfo e reconhecimento numérico de faixas
 * internas. Este módulo NÃO o reescreve — importa e constrói por cima, para
 * entregar três coisas que `checkUrl` sozinho não dá:
 *
 *  1. MODOS NOMEADOS. `allow_internal` é um booleano: ou tudo interno passa, ou
 *     nada passa. Isso é grosseiro demais. Os próprios testes deste repositório
 *     navegam em `127.0.0.1:<porta efêmera>`; conceder `allow_internal` para
 *     isso abre junto `10/8`, `192.168/16` e a metadata da nuvem. O modo `lab`
 *     libera EXATAMENTE loopback numa porta listada, e nada mais.
 *
 *  2. MOTIVO LEGÍVEL E REGRA NOMEADA. Toda decisão devolve `{allowed, reason,
 *     rule}`. Um `false` sem regra é indefensável numa auditoria: não dá para
 *     saber se o bloqueio veio do esquema, do host, da porta ou do salto de
 *     redirect. `rule` é um enum fechado; `reason` é a frase para humano.
 *
 *  3. VERIFICAÇÃO POR SALTO DE REDIRECT. Checar só a URL pedida é insuficiente:
 *     `https://encurtador.exemplo/x` pode responder `302 Location:
 *     http://169.254.169.254/latest/meta-data/`. Medido neste repositório
 *     (probe da FASE 29): com `page.route()` do Playwright + `route.continue()`
 *     o handler é chamado UMA vez e o Chromium segue o redirect internamente —
 *     o destino escapa da checagem e a navegação para a metadata realmente
 *     acontece. Por isso o hook fala com o domínio `Fetch` do CDP direto, que
 *     pausa CADA salto (`interception-job-N.0`, `.1`, `.2`…). Custo: o módulo
 *     depende de Chromium. Benefício: nenhum salto passa sem decisão.
 *
 * FAIL CLOSED em toda dúvida: opção de configuração inválida lança em vez de
 * degradar; erro interno dentro do hook nega a requisição em vez de liberar;
 * host de metadata é negado em QUALQUER modo, inclusive `custom` — nenhuma
 * combinação de opções o libera.
 *
 * Tipos vêm de `contract.ts`; a base de URL vem de `policy.ts`. Nada é redefinido.
 */
import { PolicyError, checkUrl, isInternalHost } from "./policy.ts";
import type { ActionError, ActionErrorCode } from "./contract.ts";
import type { CDPSession, Page } from "playwright";

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulário da decisão
// ─────────────────────────────────────────────────────────────────────────────

export type NetworkMode = "strict" | "lab" | "custom";

/**
 * Regra que decidiu. Enum fechado de propósito: quem audita compara contra uma
 * lista finita, não contra prosa. Mudar esta lista é mudar o contrato do módulo.
 */
export type NetworkRule =
  | "URL_INVALIDA"
  | "ABOUT_BLANK"
  | "ESQUEMA_NEGADO"
  | "DATA_URI_GRANDE"
  | "USERINFO_NEGADO"
  | "METADATA_NEGADO"
  | "HOST_NEGADO_EXPLICITO"
  | "HOST_LIBERADO_EXPLICITO"
  | "INTERNO_NEGADO"
  | "INTERNO_LIBERADO"
  | "LOOPBACK_PORTA_NEGADA"
  | "LOOPBACK_PORTA_LIBERADA"
  | "EXTERNO_NEGADO"
  | "EXTERNO_LIBERADO"
  | "REDIRECT_LIMITE"
  | "ERRO_INTERNO";

export interface NetworkDecision {
  allowed: boolean;
  /** Frase para humano. Nunca vazia, nem quando permitido. */
  reason: string;
  rule: NetworkRule;
  mode: NetworkMode;
  /** Código para o envelope `ActionResponse`; `null` quando permitido. */
  code: ActionErrorCode | null;
  /** URL normalizada. `null` quando nem parseou. */
  url: string | null;
  scheme: string | null;
  host: string | null;
  /** Porta efetiva (explícita ou default do esquema). `null` sem host. */
  port: number | null;
  internal: boolean;
  loopback: boolean;
  metadata: boolean;
  /** 0 = URL pedida; ≥1 = salto de redirect. */
  hop: number;
}

/** Converte decisão NEGADA no `ActionError` do contrato. Lança se foi permitida. */
export function networkActionError(d: NetworkDecision): ActionError {
  if (d.allowed) {
    throw new PolicyError("INTERNAL", "networkActionError chamado com decisão permitida");
  }
  return {
    code: d.code ?? "POLICY_BLOCKED",
    message: d.reason,
    detail: {
      rule: d.rule,
      mode: d.mode,
      url: d.url,
      scheme: d.scheme,
      host: d.host,
      port: d.port,
      internal: d.internal,
      loopback: d.loopback,
      metadata: d.metadata,
      hop: d.hop,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconhecimento de host
//
// `policy.ts` classifica "interno" (loopback + privado + link-local + .local),
// mas não expõe as primitivas de parsing nem distingue LOOPBACK de INTERNO — e
// essa distinção é o coração do modo `lab`. A missão proíbe editar `policy.ts`,
// então o parsing mínimo é reimplementado aqui. É duplicação consciente: o preço
// de não tocar num módulo que não é meu.
// ─────────────────────────────────────────────────────────────────────────────

function ipv4Octets(host: string): number[] | null {
  // A URL WHATWG já normalizou 2130706433, 0177.1 e 0x7f.1 para forma pontuada
  // (medido: os três viram "127.0.0.1"). Basta reconhecer a forma canônica.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return o.every((n) => n <= 255) ? o : null;
}

/** Expande `::` e devolve os 8 grupos de 16 bits, ou `null` se não for IPv6. */
function ipv6Groups(hostWithBrackets: string): number[] | null {
  if (!hostWithBrackets.startsWith("[") || !hostWithBrackets.endsWith("]")) return null;
  const raw = hostWithBrackets.slice(1, -1);
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** Últimos 32 bits de um IPv6 IPv4-mapped (`::ffff:a.b.c.d`), ou `null`. */
function mappedIpv4(g: number[]): number[] | null {
  if (!g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, ""); // ponto final é o MESMO host
}

/**
 * Loopback estrito: 127/8, `::1`, `::ffff:127.x.y.z`, `localhost`, `*.localhost`.
 *
 * `0.0.0.0` NÃO entra: é o endereço "não especificado", que muitas pilhas tratam
 * como loopback mas que não é loopback por definição. Deixá-lo de fora torna o
 * modo `lab` mais estreito, e estreitar é o lado seguro do erro.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "") return false;
  const v6 = ipv6Groups(host);
  if (v6 !== null) {
    if (v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1) return true;
    const m = mappedIpv4(v6);
    return m !== null && m[0] === 127;
  }
  const v4 = ipv4Octets(host);
  if (v4 !== null) return v4[0] === 127;
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Hosts de metadata de nuvem. Ler `169.254.169.254` de dentro de uma VM devolve
 * credencial de instância — é o alvo nº 1 de SSRF. Toda a faixa link-local
 * `169.254/16` conta (a metadata de tarefas do ECS vive em `169.254.170.2`).
 */
export const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200", // Alibaba Cloud
]);

export function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "") return false;
  if (METADATA_HOSTS.has(host)) return true;
  if (host === "internal" || host.endsWith(".internal")) return true;
  const v4 = ipv4Octets(host);
  if (v4 !== null && v4[0] === 169 && v4[1] === 254) return true;
  const v6 = ipv6Groups(host);
  if (v6 !== null) {
    if (v6[0] === 0xfd00 && v6[1] === 0xec2) return true; // fd00:ec2::254 (IMDSv6 da AWS)
    const m = mappedIpv4(v6);
    if (m !== null && m[0] === 169 && m[1] === 254) return true;
  }
  return false;
}

const DEFAULT_PORT: Readonly<Record<string, number>> = Object.freeze({
  "http:": 80,
  "https:": 443,
});

function portOf(u: URL): number | null {
  if (u.port !== "") {
    const n = Number(u.port);
    return Number.isInteger(n) ? n : null;
  }
  return Object.hasOwn(DEFAULT_PORT, u.protocol) ? DEFAULT_PORT[u.protocol]! : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────────────────────

/** URI `data:` acima disto é payload, não ícone. Ambos são negados; a regra difere. */
export const DEFAULT_MAX_DATA_URI_BYTES = 2048;
export const DEFAULT_MAX_REDIRECTS = 10;

export interface NetworkPolicyOptions {
  mode: NetworkMode;
  /** Portas de loopback liberadas. Só faz sentido em `lab` e `custom`. */
  loopback_ports?: readonly number[];
  /** Hosts liberados por comparação LITERAL. Só em `custom`. Sem metacaractere. */
  allow_hosts?: readonly string[];
  /** Hosts negados por comparação literal. Vence qualquer liberação. */
  deny_hosts?: readonly string[];
  /** Libera a faixa interna inteira. Só em `custom`. Nunca libera metadata. */
  allow_internal?: boolean;
  /** `false` transforma `custom` em modo de rede fechada. Padrão `true`. */
  allow_external?: boolean;
  max_data_uri_bytes?: number;
  max_redirects?: number;
}

function assertPorts(ports: readonly number[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new PolicyError("INVALID_REQUEST", `porta inválida na política de rede: ${String(p)}`, { port: p });
    }
    out.add(p);
  }
  return out;
}

function assertHosts(hosts: readonly string[], field: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const h of hosts) {
    if (typeof h !== "string" || h.trim() === "") {
      throw new PolicyError("INVALID_REQUEST", `host inválido em ${field}`, { host: h });
    }
    // Metacaractere não resolve: `*.exemplo.com` seria aceito como host literal e
    // nunca casaria, virando uma liberação que o operador ACHA que existe.
    if (/[*?]/.test(h)) {
      throw new PolicyError("INVALID_REQUEST", `${field} aceita host literal, não padrão: ${h}`, { host: h });
    }
    out.add(normalizeHost(h));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// NetworkPolicy
// ─────────────────────────────────────────────────────────────────────────────

export class NetworkPolicy {
  readonly mode: NetworkMode;
  readonly loopbackPorts: ReadonlySet<number>;
  readonly allowHosts: ReadonlySet<string>;
  readonly denyHosts: ReadonlySet<string>;
  readonly allowInternal: boolean;
  readonly allowExternal: boolean;
  readonly maxDataUriBytes: number;
  readonly maxRedirects: number;

  constructor(opts: NetworkPolicyOptions) {
    const mode = opts?.mode;
    if (mode !== "strict" && mode !== "lab" && mode !== "custom") {
      throw new PolicyError("INVALID_REQUEST", `modo de rede desconhecido: ${String(mode)}`, {
        mode,
        known: ["strict", "lab", "custom"],
      });
    }
    this.mode = mode;

    const ports = opts.loopback_ports ?? [];
    if (mode === "strict" && ports.length > 0) {
      // Aceitar e ignorar seria pior: o operador acharia que liberou a porta.
      throw new PolicyError("INVALID_REQUEST", "modo strict não admite loopback_ports; use lab ou custom");
    }
    this.loopbackPorts = assertPorts(ports);

    const allow = opts.allow_hosts ?? [];
    if (mode !== "custom" && allow.length > 0) {
      throw new PolicyError("INVALID_REQUEST", `allow_hosts só existe no modo custom (modo atual: ${mode})`);
    }
    this.allowHosts = assertHosts(allow, "allow_hosts");
    this.denyHosts = assertHosts(opts.deny_hosts ?? [], "deny_hosts");

    if (opts.allow_internal === true && mode !== "custom") {
      throw new PolicyError("INVALID_REQUEST", `allow_internal só existe no modo custom (modo atual: ${mode})`);
    }
    this.allowInternal = opts.allow_internal === true;

    if (opts.allow_external === false && mode !== "custom") {
      throw new PolicyError("INVALID_REQUEST", `allow_external só é configurável no modo custom (modo atual: ${mode})`);
    }
    this.allowExternal = opts.allow_external !== false;

    const maxData = opts.max_data_uri_bytes ?? DEFAULT_MAX_DATA_URI_BYTES;
    if (!Number.isInteger(maxData) || maxData < 0) {
      throw new PolicyError("INVALID_REQUEST", `max_data_uri_bytes inválido: ${String(maxData)}`);
    }
    this.maxDataUriBytes = maxData;

    const maxRed = opts.max_redirects ?? DEFAULT_MAX_REDIRECTS;
    if (!Number.isInteger(maxRed) || maxRed < 0) {
      throw new PolicyError("INVALID_REQUEST", `max_redirects inválido: ${String(maxRed)}`);
    }
    this.maxRedirects = maxRed;
  }

  /** Nada interno. É o default de produção. */
  static strict(opts: Omit<NetworkPolicyOptions, "mode"> = {}): NetworkPolicy {
    return new NetworkPolicy({ ...opts, mode: "strict" });
  }

  /**
   * Loopback numa porta explicitamente listada — e SÓ isso. É assim que os
   * testes deste repositório navegam nas próprias fixtures sem abrir a faixa
   * privada nem a metadata.
   */
  static lab(loopback_ports: readonly number[], opts: Omit<NetworkPolicyOptions, "mode" | "loopback_ports"> = {}): NetworkPolicy {
    return new NetworkPolicy({ ...opts, mode: "lab", loopback_ports });
  }

  static custom(opts: Omit<NetworkPolicyOptions, "mode">): NetworkPolicy {
    return new NetworkPolicy({ ...opts, mode: "custom" });
  }

  /** Retrato da configuração — vai para audit sem precisar reler o código. */
  describe(): Record<string, unknown> {
    return {
      mode: this.mode,
      loopback_ports: [...this.loopbackPorts].sort((a, b) => a - b),
      allow_hosts: [...this.allowHosts].sort(),
      deny_hosts: [...this.denyHosts].sort(),
      allow_internal: this.allowInternal,
      allow_external: this.allowExternal,
      max_data_uri_bytes: this.maxDataUriBytes,
      max_redirects: this.maxRedirects,
    };
  }

  #deny(
    rule: NetworkRule,
    reason: string,
    partial: Partial<NetworkDecision> = {},
    code: ActionErrorCode = "POLICY_BLOCKED",
  ): NetworkDecision {
    return {
      allowed: false,
      reason,
      rule,
      mode: this.mode,
      code,
      url: null,
      scheme: null,
      host: null,
      port: null,
      internal: false,
      loopback: false,
      metadata: false,
      hop: 0,
      ...partial,
    };
  }

  /**
   * Decide sobre uma URL. `hop` é informativo para a URL pedida (0) e decisivo
   * para saltos de redirect (≥1), onde o teto de `max_redirects` vale.
   */
  check(raw: unknown, opts: { hop?: number } = {}): NetworkDecision {
    const hop = Number.isInteger(opts.hop) ? (opts.hop as number) : 0;

    if (hop > this.maxRedirects) {
      return this.#deny(
        "REDIRECT_LIMITE",
        `cadeia de redirect excedeu ${this.maxRedirects} saltos; navegação abortada`,
        { hop, url: typeof raw === "string" ? raw : null },
      );
    }

    if (typeof raw !== "string" || raw.trim() === "") {
      return this.#deny("URL_INVALIDA", "url ausente ou não é string", { hop }, "INVALID_REQUEST");
    }
    const text = raw.trim();

    // `data:` é decidido ANTES de checkUrl para que o tamanho apareça na regra.
    // Ambos os ramos negam — a distinção existe para o auditor saber se veio um
    // ícone de 40 bytes ou um documento inteiro embutido na URL.
    if (/^data:/i.test(text)) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > this.maxDataUriBytes) {
        return this.#deny(
          "DATA_URI_GRANDE",
          `data: com ${bytes} bytes excede o teto de ${this.maxDataUriBytes}; payload embutido é negado`,
          { hop, scheme: "data:", url: `data:…[${bytes} bytes]` },
        );
      }
      return this.#deny("ESQUEMA_NEGADO", `esquema bloqueado: data: (${bytes} bytes)`, {
        hop,
        scheme: "data:",
        url: `data:…[${bytes} bytes]`,
      });
    }

    // Base emprestada de policy.ts: allowlist de esquema, recusa de userinfo,
    // normalização. `allow_internal: true` aqui NÃO libera nada — apenas evita
    // que checkUrl decida sobre "interno" antes de o modo ser aplicado.
    const base = checkUrl(text, { allow_internal: true });
    if (!base.allowed) {
      if (base.code === "INVALID_REQUEST") {
        return this.#deny("URL_INVALIDA", base.reason, { hop, scheme: base.scheme, host: base.host }, "INVALID_REQUEST");
      }
      const rule: NetworkRule = /userinfo/i.test(base.reason) ? "USERINFO_NEGADO" : "ESQUEMA_NEGADO";
      return this.#deny(rule, base.reason, { hop, scheme: base.scheme, host: base.host, url: base.url });
    }

    if (base.scheme === "about:") {
      return {
        allowed: true,
        reason: "about:blank permitido (página vazia, sem rede)",
        rule: "ABOUT_BLANK",
        mode: this.mode,
        code: null,
        url: "about:blank",
        scheme: "about:",
        host: null,
        port: null,
        internal: false,
        loopback: false,
        metadata: false,
        hop,
      };
    }

    // A partir daqui a URL é http(s) e parseia — reparsear é seguro.
    const u = new URL(base.url!);
    const host = normalizeHost(u.hostname);
    const port = portOf(u);
    const metadata = isMetadataHost(host);
    const loopback = isLoopbackHost(host);
    const internal = isInternalHost(host);

    const ctx: Partial<NetworkDecision> = {
      hop,
      url: base.url,
      scheme: base.scheme,
      host,
      port,
      internal,
      loopback,
      metadata,
    };
    const onde = hop === 0 ? "destino" : `salto de redirect #${hop}`;

    // 1. Metadata é negada em QUALQUER modo. Nenhuma combinação de allow_hosts,
    //    allow_internal ou loopback_ports a libera — por isso vem antes de tudo.
    if (metadata) {
      return this.#deny(
        "METADATA_NEGADO",
        `${onde} é endpoint de metadata de nuvem (${host}) — negado em todos os modos`,
        ctx,
      );
    }

    // 2. Denylist explícita vence qualquer liberação.
    if (this.denyHosts.has(host)) {
      return this.#deny("HOST_NEGADO_EXPLICITO", `${onde} está em deny_hosts: ${host}`, ctx);
    }

    const permitir = (rule: NetworkRule, reason: string): NetworkDecision => ({
      allowed: true,
      reason,
      rule,
      mode: this.mode,
      code: null,
      url: base.url,
      scheme: base.scheme,
      host,
      port,
      internal,
      loopback,
      metadata,
      hop,
    });

    // 3. Allowlist literal (só custom).
    if (this.mode === "custom" && this.allowHosts.has(host)) {
      return permitir("HOST_LIBERADO_EXPLICITO", `${onde} está em allow_hosts: ${host}`);
    }

    // 4. Loopback numa porta listada (lab e custom).
    if (loopback && this.mode !== "strict") {
      if (port !== null && this.loopbackPorts.has(port)) {
        return permitir(
          "LOOPBACK_PORTA_LIBERADA",
          `${onde} é loopback ${host}:${port}, porta listada no modo ${this.mode}`,
        );
      }
      return this.#deny(
        "LOOPBACK_PORTA_NEGADA",
        `${onde} é loopback ${host}:${port ?? "?"}, porta NÃO listada (liberadas: ${
          [...this.loopbackPorts].sort((a, b) => a - b).join(",") || "nenhuma"
        })`,
        ctx,
      );
    }

    // 5. Faixa interna.
    if (internal) {
      if (this.mode === "custom" && this.allowInternal) {
        return permitir("INTERNO_LIBERADO", `${onde} é interno (${host}) e allow_internal está ligado`);
      }
      return this.#deny(
        "INTERNO_NEGADO",
        `${onde} é host interno (${host}) e o modo ${this.mode} não o admite`,
        ctx,
      );
    }

    // 6. Externo.
    if (!this.allowExternal) {
      return this.#deny("EXTERNO_NEGADO", `${onde} é externo (${host}) e allow_external está desligado`, ctx);
    }
    return permitir("EXTERNO_LIBERADO", `${onde} é destino externo permitido (${host})`);
  }

  /**
   * Decisão sobre um salto de redirect. `from` entra só no motivo — quem decide
   * é o DESTINO. Uma URL pública que responde `302` para a metadata é barrada
   * aqui, não na origem.
   */
  checkRedirect(from: string, to: unknown, hop: number): NetworkDecision {
    const d = this.check(to, { hop });
    const alvo = d.url ?? (typeof to === "string" ? to : String(to));
    return {
      ...d,
      reason: d.allowed
        ? `${d.reason} (redirect de ${from})`
        : `${d.reason} — redirect de ${from} para ${alvo} bloqueado no DESTINO`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook de verificação por navegação
// ─────────────────────────────────────────────────────────────────────────────

export interface NavigationContext {
  request_id: string;
  /** Chave da cadeia de redirect: todos os saltos de uma navegação a compartilham. */
  chain: string;
  resource_type: string;
  method: string;
}

export interface GuardedNavigation {
  decision: NetworkDecision;
  context: NavigationContext;
  at: string;
}

export interface NavigationGuardOptions {
  /** Chamado a cada decisão, permitida ou não — plugue o eventbus/audit aqui. */
  onDecision?: (d: NetworkDecision, ctx: NavigationContext) => void;
  /** Teto do buffer de decisões guardadas. Corte é contabilizado, não silencioso. */
  log_limit?: number;
}

export interface NavigationGuard {
  readonly attached: boolean;
  /** Decisões observadas, da mais antiga para a mais nova. */
  decisions(): GuardedNavigation[];
  blocked(): GuardedNavigation[];
  /** Quantas decisões o buffer circular descartou. */
  dropped(): number;
  detach(): Promise<void>;
}

const DEFAULT_LOG_LIMIT = 500;
const CHAIN_TABLE_LIMIT = 4096;

/**
 * Chave da cadeia de redirect a partir do `requestId` do CDP.
 *
 * Medido: o Chromium emite `interception-job-7.0`, `interception-job-7.1`, … —
 * o sufixo numérico é o índice do salto. Só o PREFIXO é usado como chave; a
 * contagem de saltos é feita por este módulo, para não depender do formato do
 * sufixo. Id sem sufixo numérico vira a própria chave (degrada para 1 salto).
 */
export function chainKeyOf(requestId: string): string {
  const m = /^(.*)\.\d+$/.exec(requestId);
  return m === null ? requestId : m[1]!;
}

/**
 * Instala a verificação por navegação numa `Page` do Chromium.
 *
 * Intercepta TODAS as requisições, não só o documento: `<img src=
 * "http://169.254.169.254/latest/meta-data/">` é SSRF igual, e sai da mesma
 * página. `resource_type` fica na decisão para quem quiser filtrar depois.
 *
 * Limites conhecidos (declarados, não escondidos):
 *  - Exige CDP: só Chromium.
 *  - `data:`, `blob:` e `about:` não geram requisição de rede e portanto NÃO
 *    passam por aqui. Quem os barra é `NetworkPolicy.check()` na camada de
 *    `browser.goto` / `browser.open`.
 *  - Rebind de DNS (`nome-publico` que resolve para 127.0.0.1) não é detectável
 *    lexicalmente; este hook decide sobre o NOME, não sobre o IP resolvido.
 */
export async function guardPage(
  page: Page,
  policy: NetworkPolicy,
  opts: NavigationGuardOptions = {},
): Promise<NavigationGuard> {
  const limit = opts.log_limit ?? DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new PolicyError("INVALID_REQUEST", `log_limit inválido: ${String(opts.log_limit)}`);
  }

  const ctxOwner = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<CDPSession> };
  if (typeof ctxOwner.newCDPSession !== "function") {
    throw new PolicyError(
      "BROWSER_UNAVAILABLE",
      "guarda de navegação exige CDP (Chromium); este navegador não expõe newCDPSession",
    );
  }

  let cdp: CDPSession;
  try {
    cdp = await ctxOwner.newCDPSession(page);
  } catch (err) {
    throw new PolicyError("BROWSER_UNAVAILABLE", `sessão CDP indisponível: ${err instanceof Error ? err.message : String(err)}`);
  }

  const log: GuardedNavigation[] = [];
  let dropped = 0;
  const hops = new Map<string, number>();
  let attached = true;

  const record = (decision: NetworkDecision, context: NavigationContext): void => {
    log.push({ decision, context, at: new Date().toISOString() });
    while (log.length > limit) {
      log.shift();
      dropped += 1;
    }
    if (opts.onDecision !== undefined) {
      try {
        opts.onDecision(decision, context);
      } catch {
        // Observador quebrado não derruba a guarda. A decisão já foi tomada.
      }
    }
  };

  const onPaused = (ev: unknown): void => {
    const e = ev as {
      requestId: string;
      request: { url: string; method?: string };
      resourceType?: string;
    };
    const requestId = e?.requestId;
    if (typeof requestId !== "string") return;

    const finish = (allowed: boolean): void => {
      const p = allowed
        ? cdp.send("Fetch.continueRequest", { requestId })
        : cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      // A promessa rejeita quando a página já morreu; isso não é falha da guarda.
      void p.catch(() => {});
    };

    let context: NavigationContext = {
      request_id: requestId,
      chain: chainKeyOf(requestId),
      resource_type: typeof e.resourceType === "string" ? e.resourceType : "Other",
      method: typeof e.request?.method === "string" ? e.request.method : "GET",
    };

    try {
      const url = e.request?.url;
      const chain = context.chain;
      const hop = hops.get(chain) ?? 0;
      hops.set(chain, hop + 1);
      if (hops.size > CHAIN_TABLE_LIMIT) {
        // Poda determinística: a tabela é auxiliar, não é evidência.
        const oldest = hops.keys().next();
        if (oldest.done !== true) hops.delete(oldest.value);
      }

      const decision = policy.check(url, { hop });
      record(decision, context);
      finish(decision.allowed);
    } catch (err) {
      // Fail closed: erro interno na guarda NEGA. Liberar "porque deu erro" é
      // exatamente o buraco que este módulo existe para não ter.
      const decision: NetworkDecision = {
        allowed: false,
        reason: `erro interno na guarda de navegação: ${err instanceof Error ? err.message : String(err)}`,
        rule: "ERRO_INTERNO",
        mode: policy.mode,
        code: "INTERNAL",
        url: typeof e.request?.url === "string" ? e.request.url : null,
        scheme: null,
        host: null,
        port: null,
        internal: false,
        loopback: false,
        metadata: false,
        hop: 0,
      };
      record(decision, context);
      finish(false);
    }
  };

  cdp.on("Fetch.requestPaused", onPaused);
  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  } catch (err) {
    cdp.off("Fetch.requestPaused", onPaused);
    throw new PolicyError("BROWSER_UNAVAILABLE", `Fetch.enable falhou: ${err instanceof Error ? err.message : String(err)}`);
  }

  const detach = async (): Promise<void> => {
    if (!attached) return;
    attached = false;
    cdp.off("Fetch.requestPaused", onPaused);
    try {
      await cdp.send("Fetch.disable");
    } catch {
      // Página/sessão já encerrada: desanexar de algo morto não é erro.
    }
    try {
      await cdp.detach();
    } catch {
      /* idem */
    }
  };

  page.once("close", () => {
    void detach();
  });

  return {
    get attached() {
      return attached;
    },
    decisions: () => log.map((g) => ({ ...g, decision: { ...g.decision }, context: { ...g.context } })),
    blocked: () =>
      log.filter((g) => !g.decision.allowed).map((g) => ({ ...g, decision: { ...g.decision }, context: { ...g.context } })),
    dropped: () => dropped,
    detach,
  };
}
