# Tasks — objetivos multipasso

`browser.task` entrega um **objetivo** ao executor, que decide os passos. É a
forma mais poderosa de usar o runtime, e por isso a mais governada.

O motor em detalhe — estados, checkpoint, idempotência, retry, cancel, resume —
está em [`TASK-ENGINE.md`](TASK-ENGINE.md).

```bash
node packages/cli/src/main.ts task --session <ID> "encontre o preço do plano anual"
```

## Por que `browser.task` é `SEMPRE_APROVAR`

Nível `A5`, irreversibilidade alta, e a consequência declarada é literalmente
*"entrega um objetivo ao executor, que decidirá as ações sozinho"*.

Um objetivo não é uma ação: é uma delegação. O dono não está autorizando um
clique, está autorizando um plano que ainda não existe.

Por isso ela pergunta nos **dois** modos, `ASK` e `AUTO`.

## Os passos reentram no portão

Este é o ponto que faz o modo de autonomia valer alguma coisa aqui.

Se aprovar a task valesse como autorização para tudo o que o plano resolvesse
fazer, `AUTO != BYPASS` estaria trancando a porta da frente com a dos fundos
aberta — e é por task que um agente trabalha.

Medido:

| modo | perguntas numa task de dois passos |
|---|---|
| `AUTO` | `["browser.task"]` — os passos correm sozinhos |
| `ASK` | `["browser.task", "browser.goto", "browser.goto"]` |

Em `AUTO` o teste tem controle: a trilha forense confirma que os dois
`browser.goto` **aconteceram**. Sem isso, "nenhuma pergunta" seria verdade
trivial sobre um plano que não rodou.

## Por que isso funciona

O executor de passo fala com a **própria API por loopback**, autenticado, em vez
de chamar `handlerFor()` direto. A razão é de segurança, não de estilo: o caminho
HTTP é onde moram a checagem de capability, o congelamento por controle humano, o
lease, a fila por sessão, a trilha de auditoria — e agora o portão de autonomia.

Um executor que chamasse o handler direto daria **ao modelo** um caminho
privilegiado que nenhum cliente humano tem, que é exatamente o privilégio que
este runtime existe para não conceder.

Isso deixou de ser um comentário no código e virou medida: dando ao executor de
passo um caminho privilegiado, o teste cai com a mensagem certa —
*"os passos do plano não reentraram no portão"*.

## Limites do próprio motor

- Um passo de plano **não pode abrir outra task**. Recursão sem fundo, e cada
  nível consumiria uma vaga da fila da mesma sessão.
- O passo age **como o dono da task**, não como o daemon: sob
  `allow_unleased: false`, um passo que se apresentasse como o daemon bateria em
  `CONTROL_NOT_OWNED`.
- Prazo próprio por passo e prazo total, separados do prazo do Playwright.

## Persistência

Task sobrevive a queda: checkpoint por passo, retomada idempotente. Medido com
`SIGKILL` no meio de 12 passos — retoma em 6/12, termina 12/12, **zero** passos
repetidos.

## Cancelamento

Três desfechos, e o produto distingue os três: aceito, **tarde demais**
(`too_late`), ou não havia o que cancelar.

Dizer "cancelei" para uma ação que já aconteceu é a mentira mais fácil de contar
num cancelamento, e a mais cara: o dono acha que nada mudou.

## Ver também

- [`TASK-ENGINE.md`](TASK-ENGINE.md) — o motor por dentro
- [`ask-mode.md`](ask-mode.md) · [`auto-mode.md`](auto-mode.md)
- [`RECOVERY.md`](RECOVERY.md)
