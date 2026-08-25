# Controle do navegador

23 verbos, um contrato, servido por MCP, REST, WebSocket, SDK e CLI.

## As três classes

| classe | significa | verbos |
|---|---|---|
| `OBSERVE` | não muda nada | `observe` `find` `extract` `screenshot` `tabs` `network` `wait` |
| `ACT` | muda a página ou a navegação | `open` `goto` `back` `forward` `reload` `click` `type` `press` `scroll` `drag` `new_tab` `switch_tab` `close_tab` `task` |
| `COMMIT` | efeito que não se retira | `download` `upload` |

A classe governa escopo, autonomia e auditoria. Ela é declarada uma vez em
`ACTION_CLASS` e projetada em todo o resto — o roteador deriva a lista de
ferramentas dela, em vez de manter uma cópia.

## O clique é entregue, não despachado

Um clique sintetizado por JavaScript chega à página com `isTrusted=false`.
Um clique despachado por CDP chega com `true`. O runtime usa o segundo.

Mais: ele **exige prova de entrega**. Sem prova, devolve
`TARGET_NOT_ACTIONABLE` ou `CLICK_NOT_DELIVERED` — nunca um sucesso otimista.
Erro de coordenada medido: **0,000 px**.

## Resolução de alvo em cascata

```
seletor  →  texto/acessibilidade  →  visão
```

Cada degrau que a cascata desce entra na trilha. Um alvo resolvido por visão é
registrado como tal, com a confiança — porque "cliquei no botão Comprar" e
"cliquei no que um modelo achou ser o botão Comprar" não são a mesma afirmação.

Erro medido no degrau de visão: **4,1 px** num alvo de 160x100.

## Percepção não encolhe a página

`total_elements` conta **todos** os elementos do DOM, sem exceção — verificável
de fora. Uma percepção que devolvesse só os elementos "interessantes" e chamasse
isso de total esconderia do agente o que ele não viu.

## Screenshot corresponde ao DOM

O runtime traz um decodificador PNG próprio para conferir que o pixel no centro
do retângulo de um elemento tem a cor daquele elemento — com controle negativo
provando que um pixel fora dele tem cor diferente.

Sem isso, a camada de visão operaria sobre um mapa não verificado.

## Conteúdo de página é dado

`observe` e `extract` devolvem `provenance`. Texto vindo de uma página nunca é
tratado como instrução para o agente.

## Quando o navegador morre

A ação seguinte falha com `BROWSER_UNAVAILABLE`, não com "alvo não encontrado".

Isso foi um defeito corrigido: `getPage()` cobria três situações com o mesmo
código, e duas delas não eram erro de alvo nenhum. O sintoma era um
`browser.screenshot` — que não tem alvo — devolvendo `TARGET_NOT_FOUND`, e um
operador caçando um seletor que estava correto.

Hoje:

| situação | código |
|---|---|
| sessão sem aba nenhuma | `BROWSER_UNAVAILABLE` |
| aba que **era** desta sessão e fechou | `BROWSER_UNAVAILABLE` |
| `page_id` que nunca foi desta sessão | `TARGET_NOT_FOUND` |

## Recuperação

O runtime distingue `reattach`, `orphan` e `terminate`. Um `browser_pid` morto
vira `orphan`, nunca `reattach` — e nada é morto por conta própria, porque um pid
gravado antes de um crash pode ter sido reciclado pelo sistema para outro
processo.

Ver [`RECOVERY.md`](RECOVERY.md).

## Ver também

- [`API.md`](API.md) — rotas e envelopes
- [`tasks.md`](tasks.md) — objetivos multipasso
- [`VISION-PROVIDER.md`](VISION-PROVIDER.md) — escolha e medição do provider
