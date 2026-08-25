/**
 * AUTONOMIA E APROVAÇÃO — quanto o agente pode fazer sozinho.
 *
 * ─── A FRASE QUE ESTE ARQUIVO INTEIRO EXISTE PARA GARANTIR ──────────────────
 *
 *     "Agir sem perguntar" significa: execute sozinho tudo o que eu JÁ
 *     autorizei pela minha política. Nunca: ignore as proteções.
 *
 * Isso não é um comentário motivacional. É uma propriedade estrutural, e ela
 * vem da ORDEM em que os portões rodam no `daemon.ts`:
 *
 *     USER POLICY      capabilities da sessão — nega em 403, e é final
 *           ↓
 *     AUTONOMY MODE    ASK/AUTO — só decide se PAUSA, nunca se PERMITE
 *           ↓
 *     NÍVEL + RISCO    A0..A5 e os fatores abaixo
 *           ↓
 *     APPROVAL GATE    WAITING_APPROVAL até um humano decidir
 *           ↓
 *     AÇÃO
 *
 * O gate de autonomia roda DEPOIS do de capability. Por construção ele só
 * consegue ACRESCENTAR fricção. Não existe caminho de código em que `AUTO`
 * transforme um `deny` em `allow` — porque quando ele roda, o `deny` já
 * devolveu 403 e a requisição morreu.
 *
 * ─── E A SEGUNDA GARANTIA, QUE É A QUE MAIS SE TENTA QUEBRAR ────────────────
 *
 * `AUTO` também não rebaixa `SEMPRE_APROVAR`. Quem classifica uma rota como
 * "aprovação humana obrigatória" é a MATRIZ, não o modo. O modo escolhe entre
 * `ASK` e `AUTO` para o que é rebaixável; o que não é, não é.
 *
 * ─── COMPATIBILIDADE, DECLARADA ────────────────────────────────────────────
 *
 * Autonomia é EXPLÍCITA por sessão. Uma sessão que nunca declarou modo tem
 * `null`, e para ela `decidir()` devolve `EXECUTAR` sem olhar mais nada — é
 * exatamente o comportamento que o runtime sempre teve. Isso não é preguiça:
 * é a diferença entre acrescentar uma camada e mudar o significado de todas as
 * sessões que já existem, inclusive as de teste. Quem governa uma sessão diz
 * isso na cara, ligando o modo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Estados que a interface pode receber. A UI NUNCA infere: se um estado existe,
// ele tem nome aqui, e é o runtime quem o diz.
// ─────────────────────────────────────────────────────────────────────────────

export const LIVE_AGENT_STATES = [
  "IDLE",
  "OBSERVING",
  "THINKING",
  "ACTING",
  "WAITING_APPROVAL",
  "PAUSED",
  "USER_CONTROL",
  "CANCELLING",
  "CANCELLED",
  "COMPLETED",
  "ERROR",
  "DISCONNECTED",
] as const;

export type LiveAgentState = (typeof LIVE_AGENT_STATES)[number];

/** Modo de autonomia. `null` = sessão não governada (comportamento legado). */
export type AutonomyMode = "ASK" | "AUTO";

/**
 * Alcance de uma escolha de autonomia.
 *
 * `SESSION` morre com a sessão — é o default, e é o default porque uma escolha
 * de autonomia feita no calor de uma tarefa não deve virar a regra permanente
 * de ninguém. `DEFAULT` é a preferência do usuário para sessões NOVAS, e mudar
 * o default é ato separado e explícito.
 */
export type AutonomyScope = "SESSION" | "DEFAULT";

export interface AutonomySetting {
  mode: AutonomyMode;
  scope: AutonomyScope;
  /** Quem escolheu. Vai para a trilha; sem isto a mudança é anônima. */
  by: string;
  at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Perfil de risco por rota
//
// O nível sozinho não decide. A missão é explícita nisso, e com razão: `A2` é
// "sai para a rede", e isso cabe tanto em `browser.goto` (reversível: volte)
// quanto em algo que envia dinheiro. O nível é o TETO; os fatores abaixo são o
// que distingue duas rotas do mesmo nível.
// ─────────────────────────────────────────────────────────────────────────────

/** Nível NOMOS declarado. `A6` nunca chega aqui: é `DENY` na política. */
export type Nivel = "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

export type Irreversibilidade = "nenhuma" | "baixa" | "alta";

export interface PerfilDeRisco {
  nivel: Nivel;
  /** Muda estado fora do runtime (a página, o disco, o outro lado). */
  efeito_colateral: boolean;
  /** Manda dado NOSSO para fora. Diferente de só visitar uma URL. */
  envio_externo: boolean;
  /** Move dinheiro. Nenhuma rota de navegador é hoje; a coluna existe porque
   *  o dia em que existir não pode depender de alguém lembrar de criá-la. */
  efeito_financeiro: boolean;
  irreversibilidade: Irreversibilidade;
  /** O que a ação toca, em uma palavra. Vai para a tela de aprovação. */
  recurso: string;
  /** Frase curta, em português, do que acontece se isto for adiante. É o texto
   *  que o usuário lê antes de decidir — e por isso vive aqui, junto do risco,
   *  e não numa tabela de tradução que envelhece sozinha. */
  consequencia: string;
}

/**
 * TODAS as rotas do contrato. Rota que não estiver aqui é tratada como
 * desconhecida e cai em `SEMPRE_APROVAR` — fail-closed, do mesmo jeito que o
 * `nivel_padrao: A5` do manifesto. Um guarda no CI confere a cobertura, porque
 * uma tabela que silenciosamente não cobre uma rota nova é pior que tabela
 * nenhuma: ela dá a sensação de estar protegendo.
 */
export const PERFIL_DA_ROTA: Readonly<Record<string, PerfilDeRisco>> = Object.freeze({
  // ── Leitura pura. Não muda nada, em lugar nenhum. ──────────────────────────
  "browser.observe": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "lê a página; nada muda" },
  "browser.find": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "localiza um alvo sem tocá-lo" },
  "browser.extract": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "extrai conteúdo; nada muda" },
  "browser.screenshot": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "captura a tela; nada muda" },
  "browser.tabs": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "abas", consequencia: "lista as abas; nada muda" },
  "browser.network": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "rede da página", consequencia: "lê o registro de rede; nada muda" },
  "browser.wait": { nivel: "A0", efeito_colateral: false, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "espera uma condição; nada muda" },

  // ── Mutação local de sessão. Não sai para a rede. ─────────────────────────
  "browser.switch_tab": { nivel: "A1", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "abas", consequencia: "muda a aba em foco; dá para voltar" },
  "browser.close_tab": { nivel: "A1", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "abas", consequencia: "fecha uma aba e descarta o que estava nela" },

  // ── Egresso e interação com a página. ────────────────────────────────────
  "browser.open": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "rede", consequencia: "abre uma URL" },
  "browser.goto": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "rede", consequencia: "navega para outra URL" },
  "browser.back": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "histórico", consequencia: "volta uma página" },
  "browser.forward": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "histórico", consequencia: "avança uma página" },
  "browser.reload": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "rede", consequencia: "recarrega a página" },
  "browser.new_tab": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "rede", consequencia: "abre uma aba nova" },
  "browser.scroll": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "nenhuma", recurso: "página atual", consequencia: "rola a página" },
  "browser.press": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "página atual", consequencia: "pressiona uma tecla na página" },
  "browser.drag": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "página atual", consequencia: "arrasta um elemento" },

  // ── Clique e digitação: mudam a página, e a página pode fazer qualquer
  //    coisa com isso. Irreversibilidade BAIXA e não "nenhuma" de propósito:
  //    um clique pode ser em "Enviar". ────────────────────────────────────────
  "browser.click": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "página atual", consequencia: "clica num elemento da página" },
  "browser.type": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "página atual", consequencia: "digita num campo da página" },

  // ── Saem do navegador. ───────────────────────────────────────────────────
  "browser.download": { nivel: "A2", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "baixa", recurso: "disco local", consequencia: "grava um arquivo no seu disco" },
  "browser.upload": { nivel: "A2", efeito_colateral: true, envio_externo: true, efeito_financeiro: false, irreversibilidade: "alta", recurso: "arquivo local → site", consequencia: "ENVIA um arquivo seu para o site; não dá para retirar" },

  // ── Executor de tarefas: um objetivo em linguagem natural vira N ações. ───
  "browser.task": { nivel: "A5", efeito_colateral: true, envio_externo: false, efeito_financeiro: false, irreversibilidade: "alta", recurso: "sessão inteira", consequencia: "entrega um objetivo ao executor, que decidirá as ações sozinho" },
});

// ─────────────────────────────────────────────────────────────────────────────
// A MATRIZ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O que a matriz decide para uma rota, ANTES de olhar o modo.
 *
 * `AUTOMATICO`      nunca pergunta (leitura pura)
 * `DEPENDE_DO_MODO` `AUTO` executa, `ASK` pergunta
 * `SEMPRE_APROVAR`  pergunta nos DOIS modos — é aqui que `AUTO != BYPASS` vive
 */
export type Classe = "AUTOMATICO" | "DEPENDE_DO_MODO" | "SEMPRE_APROVAR";

/** Motivo legível de uma classificação. Vai para a trilha e para a tela. */
export interface Classificacao {
  classe: Classe;
  motivo: string;
  fator: string | null;
}

/**
 * Classifica uma rota SEM olhar o modo de autonomia.
 *
 * Separar isto de `decidir()` não é organização: é o que torna possível provar
 * que o modo não influencia a classe. Um teste chama `classificar()` e confere
 * que a resposta é idêntica em `ASK` e em `AUTO` — porque a função nem recebe
 * o modo.
 */
export function classificar(perfil: PerfilDeRisco | undefined): Classificacao {
  // Rota que ninguém classificou. Fail-closed, igual ao `nivel_padrao: A5`.
  if (perfil === undefined) {
    return {
      classe: "SEMPRE_APROVAR",
      motivo: "rota sem perfil de risco declarado — fail-closed",
      fator: "desconhecida",
    };
  }

  // ── Os fatores vêm ANTES do nível, e essa ordem é o ponto ────────────────
  // Um `A2` que envia arquivo para fora é mais perigoso que um `A2` que rola a
  // página, e nenhuma leitura de nível captura isso. Se o nível viesse antes, a
  // única forma de proteger o upload seria promovê-lo a `A5` no manifesto — o
  // que mudaria a impressão, quebraria a confiança registrada e exigiria uma
  // reassinatura do dono para uma coisa que não é sobre nível.
  if (perfil.efeito_financeiro) {
    return { classe: "SEMPRE_APROVAR", motivo: "a ação move dinheiro", fator: "efeito_financeiro" };
  }
  if (perfil.envio_externo) {
    return {
      classe: "SEMPRE_APROVAR",
      motivo: "a ação envia dado seu para fora, e isso não se retira",
      fator: "envio_externo",
    };
  }
  if (perfil.irreversibilidade === "alta") {
    return { classe: "SEMPRE_APROVAR", motivo: "a ação não tem volta", fator: "irreversibilidade" };
  }

  // ── Só então o nível ─────────────────────────────────────────────────────
  switch (perfil.nivel) {
    case "A0":
      return { classe: "AUTOMATICO", motivo: "leitura local; não muda nada", fator: null };
    case "A1":
    case "A2":
      return { classe: "DEPENDE_DO_MODO", motivo: `nível ${perfil.nivel}`, fator: null };
    case "A3":
      // A3 é uso de credencial/conector: quem manda é a política da capability,
      // que já rodou antes. Aqui vira pergunta, nunca liberação.
      return { classe: "DEPENDE_DO_MODO", motivo: "A3 — decidido pela política da capability", fator: null };
    case "A4":
      return { classe: "SEMPRE_APROVAR", motivo: "A4 — dispositivo sensível (mic/câmera/tela)", fator: "nivel" };
    case "A5":
      return { classe: "SEMPRE_APROVAR", motivo: "A5 — execução de código/objetivo aberto", fator: "nivel" };
    case "A6":
      // Não deveria chegar: `A6` é `DENY` na política e morre antes. Se chegar,
      // é bug de ordem de portões — e o fail-closed cobre o bug.
      return { classe: "SEMPRE_APROVAR", motivo: "A6 — destrutivo; não deveria ter chegado até aqui", fator: "nivel" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A DECISÃO
// ─────────────────────────────────────────────────────────────────────────────

export type Efeito = "EXECUTAR" | "PEDIR_APROVACAO";

export interface Decisao {
  efeito: Efeito;
  classe: Classe;
  motivo: string;
  fator: string | null;
  nivel: Nivel | null;
  perfil: PerfilDeRisco | null;
  /** Verdadeiro quando a sessão não é governada por autonomia (modo `null`). */
  nao_governada: boolean;
}

/**
 * Junta modo e classe. É a única função que enxerga o modo — e repare no que
 * ela NÃO consegue fazer: não existe ramo em que `AUTO` devolva `EXECUTAR`
 * para `SEMPRE_APROVAR`. A ausência desse ramo é o gate de segurança.
 */
export function decidir(rota: string, modo: AutonomyMode | null): Decisao {
  const perfil = PERFIL_DA_ROTA[rota];

  // Sessão não governada: o runtime se comporta como sempre se comportou. A
  // política de capabilities já rodou e já pode ter negado; aqui não se
  // acrescenta nada.
  if (modo === null) {
    return {
      efeito: "EXECUTAR",
      classe: "AUTOMATICO",
      motivo: "sessão sem modo de autonomia declarado",
      fator: null,
      nivel: perfil?.nivel ?? null,
      perfil: perfil ?? null,
      nao_governada: true,
    };
  }

  const c = classificar(perfil);
  const base = {
    classe: c.classe,
    motivo: c.motivo,
    fator: c.fator,
    nivel: perfil?.nivel ?? null,
    perfil: perfil ?? null,
    nao_governada: false,
  };

  if (c.classe === "AUTOMATICO") return { ...base, efeito: "EXECUTAR" };
  if (c.classe === "SEMPRE_APROVAR") return { ...base, efeito: "PEDIR_APROVACAO" };
  return { ...base, efeito: modo === "AUTO" ? "EXECUTAR" : "PEDIR_APROVACAO" };
}

/**
 * Rotas que `AUTO` NÃO consegue liberar. Existe para o CI conferir a lista, e
 * para a UI conseguir avisar o usuário do que continuará perguntando mesmo no
 * modo automático — prometer "não pergunto mais" e perguntar é pior que
 * perguntar sempre.
 */
export function rotasQueSempreAprovam(): string[] {
  return Object.keys(PERFIL_DA_ROTA)
    .filter((r) => classificar(PERFIL_DA_ROTA[r]).classe === "SEMPRE_APROVAR")
    .sort();
}
