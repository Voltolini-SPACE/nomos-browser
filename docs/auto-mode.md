# Modo `AUTO` — agir sem perguntar

`AUTO` significa: **execute sozinho tudo o que eu já autorizei pela minha
política.**

Nunca significa: *ignore as proteções do NOMOS*.

## A hierarquia

```
POLÍTICA DO DONO → MODO DE AUTONOMIA → CAPABILITY DO NOMOS → GATES DE APROVAÇÃO → AÇÃO
```

A autonomia é o **segundo** degrau, e ela só decide entre *passar direto* e
*parar para perguntar*. Ela nunca decide entre *permitido* e *proibido* — isso já
foi decidido acima dela.

## Por que `AUTO` não é bypass

Não é uma promessa de documentação. São duas propriedades do código.

**Primeira: a ordem dos portões.** No caminho de ação do daemon:

```
1. CAPABILITY  →  2. CONTROLE HUMANO  →  2a. PAUSA  →  2b. REOBSERVAÇÃO
                                                     →  3. AUTONOMIA/APROVAÇÃO  →  AÇÃO
```

Quando o portão de autonomia executa, tudo o que a política do dono nega já
devolveu `403` e morreu. O que sobra para a autonomia escolher é o conjunto de
ações que o dono **já** autorizou.

**Segunda: não existe o ramo.** Em `packages/core/src/autonomy.ts`, a função
`decidir()` não tem nenhum caminho que rebaixe uma ação `SEMPRE_APROVAR` sob
`AUTO`:

```ts
if (c.classe === "AUTOMATICO")      return { efeito: "EXECUTAR" };
if (c.classe === "SEMPRE_APROVAR")  return { efeito: "PEDIR_APROVACAO" };
return { efeito: modo === "AUTO" ? "EXECUTAR" : "PEDIR_APROVACAO" };
```

Só a terceira linha olha o modo. As duas primeiras não.

## O que continua perguntando em `AUTO`

A classificação olha **os fatores antes do nível**:

| fator | efeito | por quê |
|---|---|---|
| efeito financeiro | `SEMPRE_APROVAR` | dinheiro que sai não volta por retry |
| envio externo | `SEMPRE_APROVAR` | *a ação envia dado seu para fora, e isso não se retira* |
| irreversibilidade alta | `SEMPRE_APROVAR` | não há desfazer |
| nível `A4`–`A6` | `SEMPRE_APROVAR` | — |
| nível `A1`–`A3` | depende do modo | é aqui que `AUTO` age |
| nível `A0` | automático | leitura não muda nada |
| **rota sem perfil declarado** | `SEMPRE_APROVAR` | fail-closed |

`browser.upload` pergunta em `AUTO` porque **envia dado para fora**, não porque é
A2. `browser.task` pergunta porque entrega um objetivo a um executor que decidirá
as ações sozinho.

Medido numa jornada de oito passos em `AUTO`: **zero perguntas** nos passos
autorizados, e `browser.upload` na mesma sessão, logo em seguida, **perguntou**.

## O resultado é o mesmo nos dois modos

`AUTO` faz menos **perguntas**, não menos **trabalho**. Se a página terminasse
diferente, o modo teria mudado o produto, e não foi isso que se prometeu.

Medido: a mesma jornada em `ASK` e em `AUTO` termina no mesmo estado
(`EXPORTADO`), com 5 perguntas no primeiro e 0 no segundo.

## Fail-safe: sem prova, nunca `AUTO`

Quando o estado de autonomia **não pode ser comprovado** — runtime caído,
reconexão, sessão perdida — a interface nunca mostra `AUTO`. Ela:

- exibe autonomia `DESCONHECIDA`;
- desmarca os dois rádios;
- diz *"estado desconhecido — tratando como PERGUNTAR"*.

Isso não é conservadorismo decorativo. Uma tela que, ao reconectar, restaura
"agir sem perguntar" a partir da própria memória está concedendo autonomia que
ninguém concedeu naquele instante.

Sob mutação (a tela guardando o último modo visto), o console passava a exibir
**"AGIR AUTOMATICAMENTE"** com o rádio marcado enquanto o runtime estava
`DISCONNECTED`. Três casos de teste caem nessa mutação.

## Quem pode ligar

`autonomy.set` exige escopo **`ADMIN`**. Se um token de agente alcançasse essa
rota, o agente escolheria o próprio nível de licença, e `AUTO != BYPASS`
continuaria verdadeiro no papel e vazio na prática.

Pelo mesmo motivo, `approvals.approve` e `approvals.deny` são `ADMIN`: quem age
nunca pode ser quem autoriza.

`agent.resume` também é `ADMIN` — se o agente pausado pudesse se despausar, a
pausa do operador duraria até a próxima linha do laço dele.

Já **parar** é `CONTROL`: interromper trabalho em curso nunca pode ser mais
difícil do que iniciá-lo, senão o freio fica atrás de uma porta que o acelerador
não tem.

## Como ligar

```bash
curl -X POST localhost:7777/api/v1/sessions/<ID>/autonomy \
  -H 'content-type: application/json' \
  -d '{"mode":"AUTO","by":"dono"}'
```

O console mostra, ao lado do rádio, quais rotas continuam perguntando:

> *mesmo em automático, ainda pergunto: browser.task, browser.upload*

Prometer "não pergunto mais" e depois perguntar é pior do que perguntar sempre.

## Ver também

- [`ask-mode.md`](ask-mode.md) — o modo que pergunta
- [`security-overview.md`](security-overview.md) — escopos e separação de poderes
- [`live-agent-console.md`](live-agent-console.md) — onde o modo é escolhido
