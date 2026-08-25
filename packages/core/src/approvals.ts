/**
 * APPROVAL CENTER — o registro de aprovações humanas do runtime.
 *
 * ─── AS QUATRO PROPRIEDADES, E O QUE CADA UMA IMPEDE ────────────────────────
 *
 * `single-use`     uma aprovação vale UMA execução. Consumida, some.
 *                  Impede: aprovar um clique e o agente clicar dez vezes.
 *
 * `action-bound`   a aprovação nasce colada a um `action_id`, a uma rota e a
 *                  uma IMPRESSÃO DOS ARGUMENTOS.
 *                  Impede: aprovar `click` no botão "Cancelar" e o agente usar
 *                  a aprovação para clicar em "Confirmar compra". Sem o vínculo
 *                  com os argumentos, "aprovei um clique" seria um cheque em
 *                  branco para qualquer clique.
 *
 * `session-bound`  aprovação de uma sessão não serve em outra.
 *                  Impede: um agente aproveitar a aprovação dada a outro.
 *
 * `non-sticky`     nada fica "ligado" depois. A próxima ação equivalente pede
 *                  de novo.
 *                  Impede: o modo mais perigoso de falha de UX em produtos de
 *                  agente — a aprovação que vira permissão permanente sem
 *                  ninguém perceber.
 *
 * ─── E A QUINTA, QUE NÃO TEM NOME NA MISSÃO MAS É A MAIS IMPORTANTE ─────────
 *
 * `fail-closed`    prazo esgotado é NEGADO, nunca permitido. A ausência de
 *                  resposta não é consentimento — em lugar nenhum, e aqui
 *                  menos ainda, porque quem não respondeu pode simplesmente
 *                  não estar olhando a tela.
 */

import { createHash } from "node:crypto";

export type DecisaoHumana = "APROVADA" | "NEGADA" | "EXPIRADA";
export type EstadoAprovacao = "PENDENTE" | DecisaoHumana | "CONSUMIDA";

export interface PedidoDeAprovacao {
  approval_id: string;
  session_id: string;
  action_id: string;
  /** Rota do contrato, ex.: `browser.click`. */
  rota: string;
  /** Impressão dos argumentos. É o que torna a aprovação action-bound. */
  impressao_args: string;
  /** Argumentos já redigidos, para a tela. NUNCA os crus. */
  args_visiveis: Record<string, unknown>;
  nivel: string | null;
  motivo: string;
  consequencia: string;
  recurso: string;
  autonomy_mode: string | null;
  criado_em: string;
  expira_em: string;
  estado: EstadoAprovacao;
  decidido_por: string | null;
  decidido_em: string | null;
}

export interface PedidoNovo {
  session_id: string;
  action_id: string;
  rota: string;
  args: Record<string, unknown>;
  args_visiveis: Record<string, unknown>;
  nivel: string | null;
  motivo: string;
  consequencia: string;
  recurso: string;
  autonomy_mode: string | null;
}

/**
 * Serializa de forma DETERMINÍSTICA, ordenando as chaves em TODOS os níveis.
 *
 * A primeira versão disto usava `JSON.stringify(args, Object.keys(args).sort())`
 * — e era um buraco de segurança de verdade, pego pelo teste 4 na primeira
 * execução. O segundo argumento do `stringify` não é "a ordem das chaves": é um
 * REPLACER, uma lista de permissão aplicada em todos os níveis. Com
 * `["target"]`, a chave `selector` lá dentro simplesmente sumia:
 *
 *     {"target":{"selector":"#confirmar"}}      -> {"target":{}}
 *     {"target":{"selector":"#comprar-agora"}}  -> {"target":{}}
 *
 * As duas davam a MESMA impressão. Quer dizer: uma aprovação para clicar em
 * "Cancelar" liberava um clique em "Confirmar compra". O vínculo com os
 * argumentos — a propriedade `action-bound` inteira — não existia.
 */
function canonico(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  const o = v as Record<string, unknown>;
  const pares = Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`);
  return `{${pares.join(",")}}`;
}

/**
 * Impressão dos argumentos.
 *
 * Ordem de chaves não é semântica: sem normalizar, o mesmo pedido com as chaves
 * trocadas de lugar geraria outra impressão e o usuário veria uma aprovação
 * legítima falhar sem motivo visível. Truncada em 16 hex: o bastante para
 * distinguir dois pedidos, curta o bastante para caber num log e ser lida.
 */
export function impressaoDeArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonico(args)).digest("hex").slice(0, 16);
}

/**
 * Prepara argumentos para a TELA DE APROVAÇÃO.
 *
 * `redactObject` da observabilidade mascara por NOME DE CHAVE — `password`,
 * `token`, `authorization`, `api_key`. Isso cobre a trilha, e cobre bem. Mas
 * `browser.type` carrega o que vai ser digitado em `text`, e `text` não é nome
 * de segredo: um agente que digita uma senha num campo `<input type=password>`
 * passa o valor em claro por ali.
 *
 * Foi medido, não suposto — o canário apareceu inteiro em `args_visiveis.text`
 * (`evidence/nomos-live-agent/06-segredos/01-antes.txt`).
 *
 * A decisão, e o custo dela: `text` é SEMPRE mascarado aqui, mesmo quando não é
 * segredo. Perde-se poder ver "Ana Ribeiro" antes de aprovar. Ganha-se que a
 * tela mais compartilhada do produto — um console de agente é feito para ser
 * assistido, gravado, projetado numa reunião — nunca exiba uma senha porque
 * alguém não usou `credential_ref`. Entre errar para o lado de mostrar demais e
 * o de mostrar de menos numa superfície assim, o segundo é o único que não
 * produz um dano irreversível.
 *
 * O que sobra é suficiente para conferir: QUAL campo, QUANTOS caracteres, e as
 * pontas. "Digitar 24 caracteres começando em A e terminando em 9 no campo
 * #senha" é uma frase que dá para aprovar ou negar com consciência.
 */
export function paraExibicao(rota: string, args: Record<string, unknown>): Record<string, unknown> {
  if (rota !== "browser.type") return args;
  const fora: Record<string, unknown> = { ...args };
  const bruto = fora["text"];
  if (typeof bruto === "string" && bruto.length > 0) {
    const pontas = bruto.length <= 2 ? "" : `${bruto[0]}…${bruto[bruto.length - 1]}`;
    fora["text"] = `[oculto: ${bruto.length} caractere(s)${pontas === "" ? "" : `, ${pontas}`}]`;
    fora["text_oculto"] = true;
  }
  return fora;
}

export interface OpcoesRegistro {
  /** Prazo de uma pendência. Esgotado = NEGADA. */
  ttl_ms?: number;
  agora?: () => number;
  /** Teto de pendências simultâneas por sessão. Sem teto, um agente em laço
   *  enche a fila e a tela de aprovação vira inútil — que é uma forma de
   *  desligar o gate sem nunca o desligar. */
  max_pendentes_por_sessao?: number;
}

export class RegistroDeAprovacoes {
  private readonly pedidos = new Map<string, PedidoDeAprovacao>();
  private readonly esperando = new Map<string, ((p: PedidoDeAprovacao) => void)[]>();
  private readonly ttl: number;
  private readonly agora: () => number;
  private readonly maxPendentes: number;
  private seq = 0;

  constructor(opts: OpcoesRegistro = {}) {
    this.ttl = opts.ttl_ms ?? 300_000; // 5 min, como a fila do painel do NOMOS
    this.agora = opts.agora ?? (() => Date.now());
    this.maxPendentes = opts.max_pendentes_por_sessao ?? 32;
  }

  /** Cria uma pendência. Devolve o pedido, já em `PENDENTE`. */
  propor(p: PedidoNovo): PedidoDeAprovacao {
    this.expirarVencidas();
    const pendentes = this.pendentesDe(p.session_id).length;
    if (pendentes >= this.maxPendentes) {
      throw new Error(
        `fila de aprovações cheia para ${p.session_id} (${pendentes}); ` +
          "recuse ou aprove as pendentes antes de propor mais",
      );
    }
    this.seq += 1;
    const t = this.agora();
    const pedido: PedidoDeAprovacao = {
      approval_id: `apr_${t.toString(36)}_${this.seq.toString(36)}`,
      session_id: p.session_id,
      action_id: p.action_id,
      rota: p.rota,
      impressao_args: impressaoDeArgs(p.args),
      args_visiveis: p.args_visiveis,
      nivel: p.nivel,
      motivo: p.motivo,
      consequencia: p.consequencia,
      recurso: p.recurso,
      autonomy_mode: p.autonomy_mode,
      criado_em: new Date(t).toISOString(),
      expira_em: new Date(t + this.ttl).toISOString(),
      estado: "PENDENTE",
      decidido_por: null,
      decidido_em: null,
    };
    this.pedidos.set(pedido.approval_id, pedido);
    return { ...pedido };
  }

  /** Decisão humana. Só a PRIMEIRA vale — decidir duas vezes é erro. */
  decidir(approval_id: string, decisao: "APROVADA" | "NEGADA", por: string): PedidoDeAprovacao {
    this.expirarVencidas();
    const p = this.pedidos.get(approval_id);
    if (p === undefined) throw new Error(`aprovação desconhecida: ${approval_id}`);
    if (p.estado !== "PENDENTE") {
      throw new Error(`aprovação ${approval_id} já está ${p.estado}; não se decide duas vezes`);
    }
    p.estado = decisao;
    p.decidido_por = por;
    p.decidido_em = new Date(this.agora()).toISOString();
    this.acordar(approval_id);
    return { ...p };
  }

  /**
   * Consome uma aprovação para executar UMA ação.
   *
   * Confere as quatro amarras antes de liberar. Repare que ele exige a rota e a
   * impressão dos argumentos: quem chamar com outros argumentos não consegue
   * usar a aprovação, mesmo tendo o `approval_id` na mão.
   */
  consumir(
    approval_id: string,
    vinculo: { session_id: string; action_id: string; rota: string; args: Record<string, unknown> },
  ): { ok: true; pedido: PedidoDeAprovacao } | { ok: false; motivo: string } {
    this.expirarVencidas();
    const p = this.pedidos.get(approval_id);
    if (p === undefined) return { ok: false, motivo: "aprovação desconhecida" };
    if (p.estado === "CONSUMIDA") return { ok: false, motivo: "aprovação já foi usada (single-use)" };
    if (p.estado === "EXPIRADA") return { ok: false, motivo: "aprovação expirou sem resposta" };
    if (p.estado === "NEGADA") return { ok: false, motivo: "aprovação foi negada" };
    if (p.estado === "PENDENTE") return { ok: false, motivo: "aprovação ainda não foi decidida" };
    if (p.session_id !== vinculo.session_id) return { ok: false, motivo: "aprovação é de outra sessão" };
    if (p.action_id !== vinculo.action_id) return { ok: false, motivo: "aprovação é de outra ação" };
    if (p.rota !== vinculo.rota) return { ok: false, motivo: `aprovação é para ${p.rota}, não ${vinculo.rota}` };
    if (p.impressao_args !== impressaoDeArgs(vinculo.args)) {
      return { ok: false, motivo: "os argumentos mudaram depois da aprovação" };
    }
    p.estado = "CONSUMIDA";
    return { ok: true, pedido: { ...p } };
  }

  /**
   * Espera a decisão humana. Resolve quando o pedido sair de `PENDENTE` — por
   * decisão ou por prazo.
   *
   * O `unref()` no timer não é detalhe: sem ele, uma pendência aberta segura o
   * processo do daemon vivo por até 5 minutos depois de tudo o mais ter
   * terminado, e o `PROCESS_RESIDUAL=0` que custou tanto para conquistar
   * passaria a falhar de vez em quando, por um motivo que ninguém acharia.
   */
  aguardar(approval_id: string): Promise<PedidoDeAprovacao> {
    const p = this.pedidos.get(approval_id);
    if (p === undefined) return Promise.reject(new Error(`aprovação desconhecida: ${approval_id}`));
    if (p.estado !== "PENDENTE") return Promise.resolve({ ...p });

    return new Promise((resolve) => {
      const fila = this.esperando.get(approval_id) ?? [];
      fila.push(resolve);
      this.esperando.set(approval_id, fila);

      const restante = Math.max(0, Date.parse(p.expira_em) - this.agora());
      const timer = setTimeout(() => {
        this.expirarVencidas();
        this.acordar(approval_id);
      }, restante + 5);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  private acordar(approval_id: string): void {
    const fila = this.esperando.get(approval_id);
    if (fila === undefined) return;
    const p = this.pedidos.get(approval_id);
    if (p === undefined || p.estado === "PENDENTE") return;
    this.esperando.delete(approval_id);
    for (const r of fila) r({ ...p });
  }

  obter(approval_id: string): PedidoDeAprovacao | null {
    this.expirarVencidas();
    const p = this.pedidos.get(approval_id);
    return p === undefined ? null : { ...p };
  }

  pendentesDe(session_id: string): PedidoDeAprovacao[] {
    this.expirarVencidas();
    return [...this.pedidos.values()]
      .filter((p) => p.session_id === session_id && p.estado === "PENDENTE")
      .map((p) => ({ ...p }));
  }

  todasDe(session_id: string): PedidoDeAprovacao[] {
    this.expirarVencidas();
    return [...this.pedidos.values()].filter((p) => p.session_id === session_id).map((p) => ({ ...p }));
  }

  /**
   * Nega tudo que estiver pendente numa sessão. É o que o `PARAR TUDO` chama —
   * um kill switch que deixasse pendências vivas seria um kill switch que não
   * para nada, porque a primeira aprovação clicada depois soltaria a ação.
   */
  negarPendentes(session_id: string, por: string): PedidoDeAprovacao[] {
    return this.pendentesDe(session_id).map((p) => this.decidir(p.approval_id, "NEGADA", por));
  }

  private expirarVencidas(): void {
    const t = this.agora();
    for (const p of this.pedidos.values()) {
      if (p.estado !== "PENDENTE") continue;
      if (Date.parse(p.expira_em) <= t) {
        p.estado = "EXPIRADA";
        p.decidido_por = "runtime:prazo";
        p.decidido_em = new Date(t).toISOString();
        this.acordar(p.approval_id);
      }
    }
  }
}
