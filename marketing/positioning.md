# Posicionamento — NOMOS Browser

Decisões de nome, categoria e voz. Tudo aqui deriva de
[`../PRODUCT_TRUTH_MATRIX.md`](../PRODUCT_TRUTH_MATRIX.md): nenhuma afirmação
comercial pode existir sem linha `PROVEN` correspondente.

---

## Arquitetura de marca

| camada | nome | papel |
|---|---|---|
| Ecossistema | **NOMOS** | governança e autorização — a marca-mãe |
| Produto | **NOMOS Browser** | o navegador governado para agentes |
| Componente | **Live Agent Console** | a tela onde o dono acompanha e autoriza |
| Runtime | NOMOS Browser Runtime | o processo que executa |
| CLI | `nomos-web` | o cliente de linha de comando |

**O Live Agent Console não é produto separado.** Ele não roda sem o runtime, não
tem instalação própria, não tem preço próprio e não resolve problema próprio.
Tratá-lo como produto criaria uma segunda identidade para uma tela — e diluiria
o NOMOS Browser justamente no que ele tem de mais visível.

A marca-mãe é preservada: NOMOS Browser é *do* NOMOS, e a promessa do NOMOS
(*seu agente, sua máquina, suas regras*) é a mesma aqui, aplicada ao navegador.

> **Nota de nomenclatura pendente.** A CLI se chama `nomos-web` e o README
> anterior chamava a interface de "NOMOS Web". O nome de produto é **NOMOS
> Browser**; "NOMOS Web" sobrevive como nome do binário por compatibilidade.
> Unificar exigiria quebrar a CLI de quem já usa — é decisão de release maior,
> registrada no roadmap e não no material de lançamento.

## Categoria

**Infraestrutura de navegação governada para agentes de IA.**

Não é: framework de automação (Playwright/Puppeteer), extensão de navegador,
scraper, nem agente. É a **camada entre** um agente qualquer e um navegador real,
onde moram política, autonomia, aprovação e trilha.

## Público

| quem | por que se importa |
|---|---|
| **Dono/operador de agente** | quer que o agente trabalhe sozinho no que já autorizou, e pergunte no resto |
| **Desenvolvedor de agente** | quer navegador de verdade sem construir governança do zero |
| **Auditor / compliance** | quer saber o que foi feito, por quem, com qual autorização |
| **Ecossistema NOMOS** | o navegador como capability sob a política do dono |

Público principal: **dono/operador**. É dele a dor que o produto resolve, e é
dele a tela.

## Os três diferenciais

Escolhidos por serem os únicos que a concorrência não pode alegar sem construir:

1. **`AUTO` não é bypass.** O modo automático nunca remove uma aprovação
   obrigatória — e isso é topologia do código, não promessa de documentação.
2. **Aprovar um objetivo não é cheque em branco.** Em `ASK`, cada passo que o
   plano decidir executar reentra no portão.
3. **O produto se recusa a afirmar o que não mediu.** Nenhum `p99` é reportado
   porque 30 amostras não sustentam um. Isso é diferencial de categoria num
   mercado onde todo mundo publica número redondo.

## Voz

Herda o NOMOS: direta, técnica, sem superlativo. A regra da casa em
voltolini.space é **"prova, não promessa"** — e este produto foi construído sob
uma disciplina onde nada vira PASS sem controle negativo.

**Nunca dizer:** "100% seguro", "infalível", "zero risco", "à prova de falhas",
"p99 de X ms", "totalmente autônomo".

**Pode dizer:** o que a matriz de verdade marca `PROVEN`, com o mecanismo junto.
Quando a copy citar número, cita o `n` e o que ele mede.

**Tom:** o produto é sério porque o risco é sério. Um agente com navegador pode
comprar em nome de alguém. A copy não brinca com isso, e também não apela ao
medo — descreve o mecanismo e deixa o leitor concluir.

## Uma linha

> Infraestrutura de navegação governada para agentes de IA.

## Posicionamento em uma frase

> Para donos de agentes de IA que precisam de um navegador real sem entregar um
> cheque em branco, o NOMOS Browser é a camada de navegação governada que separa
> o que você já autorizou do que precisa do seu consentimento agora, e mostra a
> diferença numa tela onde você pode interromper a qualquer momento.

## Idioma

Português do Brasil como idioma oficial do produto e da documentação, alinhado ao
NOMOS e ao voltolini.space. Identificadores técnicos (rotas, códigos de erro,
nomes de ferramenta) permanecem em inglês por serem contrato.
