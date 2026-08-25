# Modo `ASK` — perguntar antes de agir

`ASK` é o modo em que o agente **para e pergunta** antes de cada ação que muda a
página. Leituras passam direto.

## Por que leituras não perguntam

Perguntar para ler é ruído, e ruído é perigoso: um dono que aprova quinze coisas
por minuto para de ler o que aprova. A aprovação vira reflexo, e o reflexo é
exatamente o que um pedido malicioso precisa para passar.

Medido numa jornada real de oito passos: **5 ações que mudam a página
perguntaram, 3 leituras passaram diretas**. O contador
`UNEXPECTED_APPROVAL_PROMPTS` conta pergunta fora do lugar nos dois sentidos, e
fica em `0`.

## O que aparece quando ele pergunta

O pedido de aprovação carrega o que permite **decidir**, não só o nome da rota:

| campo | exemplo |
|---|---|
| ação | `browser.click` |
| onde | `página atual` |
| nível | `A2` |
| consequência | *clica num elemento da página* |
| por que pergunto | *nível A2* ou o fator de risco, quando houver |
| parâmetros | argumentos redigidos, com segredo mascarado |

Sem consequência e recurso, a tela de aprovação vira "permitir? [sim/não]" sobre
uma coisa que o dono não sabe o que é.

## Segredos

O texto a ser digitado **nunca** aparece em claro. Ele sai assim:

```
text: "[oculto: 24 caractere(s), C…Z]"
text_oculto: true
```

Tamanho e pontas preservam o reconhecimento — o dono sabe que foi a senha dele
que o agente vai digitar — sem que a tela exponha o valor. Esconder o campo
inteiro seria pior: transformaria o pedido numa pergunta sobre nada.

Textos de um ou dois caracteres não ganham pontas, porque as pontas seriam o
texto inteiro.

## `browser.task` não é cheque em branco

Este é o ponto que faz o modo valer alguma coisa numa tarefa multipasso.

`browser.task` é `SEMPRE_APROVAR` (A5, irreversibilidade alta): o dono aprova
**uma vez**, "faça isso". Se essa aprovação valesse como autorização geral para
tudo o que o plano decidisse fazer, `ASK` estaria trancando a porta da frente com
a dos fundos aberta — e é por task que um agente trabalha.

Em `ASK`, **cada passo do plano reentra no portão**. Medido: aprovando uma task
de dois passos, a lista de perguntas é `["browser.task", "browser.goto",
"browser.goto"]`, não `["browser.task"]`.

Isso funciona porque o executor de passo fala com a própria API por loopback em
vez de chamar o handler direto. Dar a ele um caminho privilegiado derruba o teste
imediatamente.

## Aprovação: as cinco propriedades

| propriedade | o que significa |
|---|---|
| **single-use** | só a primeira decisão vale; a segunda é recusada |
| **action-bound** | ligada aos argumentos exatos, por impressão canônica recursiva |
| **session-bound** | não vale para outra sessão |
| **auditada** | proposta, decisão e consumo entram na trilha |
| **não-sticky** | fechar a sessão nega o que estiver pendente |

Há TTL (padrão 300 s) e teto de pendências por sessão: sem teto, um agente em
laço encheria a fila do dono.

### A amarra que quase não existiu

A primeira versão da impressão de argumentos usava:

```js
JSON.stringify(args, Object.keys(args).sort())
```

O segundo argumento do `JSON.stringify` é um **replacer**, não uma lista de
ordenação: ele descarta toda chave que não esteja na lista, em todos os níveis.

Resultado medido: `{"target":{"selector":"#confirmar"}}` e
`{"target":{"selector":"#comprar-agora"}}` serializavam ambos para
`{"target":{}}`. Uma aprovação para clicar "Cancelar" teria autorizado
"Confirmar compra".

Hoje a serialização é canônica e recursiva, e o teste que pegou isso continua na
suíte.

## Como ligar

```bash
curl -X POST localhost:7777/api/v1/sessions/<ID>/autonomy \
  -H 'content-type: application/json' \
  -d '{"mode":"ASK","by":"dono"}'
```

Ou pelo rádio de autonomia no rodapé do Live Agent Console.

Sessão sem modo declarado mantém o comportamento anterior ao recurso: a
compatibilidade é estrutural, e é por isso que os testes que já existiam
continuaram verdes sem ajuste.

## Ver também

- [`auto-mode.md`](auto-mode.md) — o outro modo, e o que **não** muda entre eles
- [`live-agent-console.md`](live-agent-console.md) — onde a aprovação aparece
- [`security-overview.md`](security-overview.md) — quem pode aprovar
