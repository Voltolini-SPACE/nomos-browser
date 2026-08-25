# FASE 26 — latência real

Cinco caminhos, medidos com relógio de verdade nas duas pontas reais. Nenhuma
amostra é sintética: cada uma é um evento que aconteceu num Chromium que existe,
com a tela aberta.

A estatística **não** foi reimplementada: usa `computeStats` do módulo de bench,
que já recusa imprimir um percentil que a amostra não sustenta.

## Resultado

| caminho | n | p50 | p95 | max |
|---|---|---|---|---|
| A. evento do runtime → UI (WebSocket) | 62 | 1,0 ms | 1,0 ms | 2,0 ms |
| B. quadro do navegador → UI (espelho) | 30 | 18–19 ms | 27 ms | 40 ms |
| C. clique de APROVAR → runtime | 30 | 1,0 ms | 1,0 ms | 1,0 ms |
| D. freio da tela → runtime PAUSADO | 30 | 3,0 ms | 4,0 ms | 4,0 ms |
| E. tomada de controle → volante no humano | 30 | 1,0 ms | 2,0 ms | 2,0 ms |

`p99` sai `—` em todos, com a razão impressa junto: *"precisa de 100, tem 30"*.
Com 30 amostras, um p99 seria o próprio máximo com nome de estatística. Escolher
um N que escondesse essa regra teria sido mais bonito e menos honesto.

## Onde cada número começa e termina

Latência sem fronteira declarada é propaganda: dá para fazer qualquer caminho
parecer rápido escolhendo onde começar a contar. Então:

- **A** — do `timestamp` que o runtime carimba no evento até o `onmessage` da
  página. Inclui serialização, socket e loop de eventos do navegador. Medido por
  uma sonda passiva **no mesmo socket que a UI usa**, ao lado do handler da
  aplicação, não no lugar dele.
- **B** — do pedido do quadro até o `onload` da imagem. São os **dois** passos
  que a UI de fato percorre: `browser.screenshot` devolve `screenshot_url`, e só
  então o PNG é buscado. Inclui captura no Chromium, gravação, transporte e
  decodificação.
- **C** — do `Date.now()` do clique **dentro da página** até o `decidido_em`
  carimbado pelo runtime.
- **D** — do clique até o runtime declarar `PAUSED` numa leitura seguinte.
  **Inclui a ida ao runtime para confirmar**, então é um teto, não o tempo
  interno do freio.
- **E** — do pedido de takeover até uma leitura confirmar `control=human`.
  Inclui as duas idas ao runtime.

## A fronteira que não é latência de transporte

A faixa de estado da UI lê `/live` por **polling de 700 ms**, não por evento.
Uma mudança de estado aparece na tela em até 700 ms **por projeto**, e nenhum
número acima descreve esse caminho.

Reportar a latência do WebSocket (1 ms) como se fosse a da faixa faria o console
parecer ~700× mais rápido do que ele mostra ao dono. Os eventos chegam em 1 ms;
a *faixa* pode levar até 700 ms. As duas coisas são verdade, e só juntas.

## Controle do instrumento

Números pequenos são fáceis de produzir por engano — basta medir nada. Com um
atraso **conhecido de 60 ms** injetado no runtime antes de carimbar
`decidido_em`:

| caminho | sem atraso | com 60 ms injetados |
|---|---|---|
| C. aprovação → runtime | 1,0 ms | **63,0 ms** |
| A. evento → UI | 1,0 ms | 1,0 ms |
| B. quadro → UI | 19,0 ms | 19,0 ms |
| E. posse | 1,0 ms | 1,0 ms |

O número sobe exatamente onde o atraso foi posto (1 + 60 + ~2 de ida e volta), e
os outros caminhos não se movem. O instrumento mede o caminho que diz medir, e
não contamina os vizinhos.

---

## Erros meus, registrados

**1. Zero amostras em C, e a causa era leitura de campo errado.** A rota
`approvals.list` devolve `{pendentes, todas}`. Depois de aprovada, a pendência
**sai** de `pendentes` — e eu procurava o registro decidido lá. Trinta iterações
produzindo zero amostras, com o instrumento reportando honestamente
`NAO_MEDIDO`, que foi a única coisa que funcionou como devia.

**2. "Não medido" que era premissa errada minha, não limitação do produto.** O
caso B saiu `NÃO MEDIDO` na primeira execução porque presumi que o espelho fosse
um `GET` de imagem. Não é: é ação + URL + imagem. Eu tinha escrito no próprio
comentário que dizer "não medido" é obrigatório — e estava certo em dizê-lo, mas
errado sobre a causa. Lendo `espelhar()` na UI, o caminho real apareceu e a
medida passou a existir.

**3. Um daemon órfão me deu 401 em toda a bateria — pela terceira vez.** Uma
sonda auxiliar ficou pendurada segurando a porta, e a execução seguinte falou
com o daemon velho, cujo token não era o novo. Os E2E já tinham ganhado guarda de
porta; a sonda descartável não. Vale como padrão: **todo instrumento que sobe um
daemon precisa recusar subir com a porta ocupada.**

**4. E a sonda pendurou porque eu esqueci a própria regra.** Ela chamava
`browser.open` com `await` numa sessão em modo ASK — e `browser.open` é A2, então
espera aprovação que ninguém ia dar. É exatamente o mesmo laço que eu já tinha
consertado no E2E dos modos, repetido num arquivo novo.
