# FASES 17 e 18 — segredo na superfície de aprovação, e histórico somente leitura

Registro do que foi medido, do que estava errado, e de como cada correção foi
provada. Nada aqui é conclusão por inferência: cada afirmação tem uma execução
que a sustenta e um controle que a derruba se ela deixar de ser verdade.

---

## FASE 17 — o segredo aparecia em claro na tela de aprovação

### O defeito

A tela de aprovação é a única superfície onde o texto a ser digitado aparece
**antes** de chegar à página. `redactObject` mascara por NOME de campo, e `text`
não é nome de campo secreto — então a senha saía inteira em `args_visiveis.text`.

Primeira medição (`06-segredos/01-antes.txt`), canário digitado num
`<input type="password">` real:

```
[VAZOU] 1. o pedido de aprovação não mostra o segredo em claro — args_visiveis.text = "CANARIO-SEGREDO-6I6Q5UXE"
[VAZOU] 2. a lista de aprovações também não — VAZOU
[PASS]  3. a trilha de auditoria em disco não guarda o segredo — nenhum arquivo
[PASS]  4. nem o diretório de runtime — nenhum arquivo
SECRET_LEAK_IN_UI=SIM   SECRET_LEAK_IN_AUDIT=0   VAZAMENTOS=2
```

O vazamento era só na superfície que **eu** criei nas fases anteriores. A trilha
em disco já nascia limpa.

### A correção

`paraExibicao()` em `packages/core/src/approvals.ts`, aplicada como segunda
camada sobre `redactObject`. Ela mascara o texto preservando o que permite
DECIDIR — tamanho e pontas — sem revelar o conteúdo:

```
text: "[oculto: 24 caractere(s), C…Z]"
text_oculto: true
```

Isso não é cosmético. Um pedido de aprovação que esconde o campo inteiro vira
"permitir? [sim/não]" sobre uma coisa que o dono não sabe o que é; um que mostra
tudo vaza. Tamanho e pontas é o ponto em que o dono reconhece o que digitou sem
que a tela o exponha.

### A prova

| medição | arquivo | resultado |
|---|---|---|
| depois da correção | `06-segredos/02-depois.txt` | `SECRET_LEAK_IN_UI=0  SECRET_LEAK_IN_AUDIT=0  VAZAMENTOS=0` |
| mutação (fix revertido) | `06-segredos/03-mutacao.txt` | casos 1 e 2 voltam a `[VAZOU]`, `VAZAMENTOS=2` |

Mais seis testes unitários (`tests/approvals.test.ts` 20–25). Sob mutação, três
deles caem — 20, 21 e 22, exatamente os que guardam o vazamento. Os outros três
continuam passando **de propósito**: eles afirmam passagem intacta e não-mutação
do argumento original, que a função identidade também satisfaz. Registrado aqui
para que ninguém leia "6 testes novos" como "6 testes sensíveis".

O produto continua digitando a senha de verdade: o mascaramento é só para
exibição, e o teste 25 prova que o argumento original não é tocado.

---

## FASE 18 — histórico somente leitura

### O que já existia (e não foi reimplementado)

`loadReplay`, `timelineOf`, `selarSessao`, `lerSelo`, `screenshotPath` e a rota
`/replay/verify` já existiam em `packages/observability/src/replay.ts`. A FASE 18
abriu uma **janela** para isso — não um segundo gravador.

### Como READ_ONLY foi construído

Em três camadas independentes, porque cada uma falha de um jeito diferente:

1. **Roteamento.** Não existe verbo de escrita em `/replay`. `POST`, `PUT`,
   `PATCH` e `DELETE` param no roteador com 405 e `Allow: GET`, sem chegar ao
   daemon. Uma tela pode esquecer de esconder um botão; uma rota que não existe
   não pode ser chamada.
2. **Não-ressurreição.** Ler o histórico inteiro de uma sessão encerrada não a
   traz de volta: a ação seguinte sobre ela é recusada, e ela não reaparece na
   listagem de sessões vivas.
3. **Declaração, não dedução.** `read_only: true` e `mode: "REPLAY"` viajam no
   corpo. A UI **lê** isso; o selo "SOMENTE LEITURA" acende pelo campo do
   runtime, nunca porque a tela achou que a sessão parecia encerrada.

O painel de histórico da UI não tem nenhum controle que aja — apenas
"Recarregar", que é uma leitura. Medido no DOM, não afirmado: o E2E conta
`button, input, select, textarea, a[href]` dentro de `#p-history` e exige que a
lista seja vazia fora do botão de recarga.

### Defeito de produto encontrado na FASE 18

`GET /replay` devolvia **200 com um replay vazio** para uma sessão que nunca
existiu. Um bundle de sessão inventada tem exatamente a mesma forma de uma
sessão real que gravou pouco: arrays vazios, contagens em zero, todas as fontes
em `missing`. A tela concluiria "essa sessão não fez nada" sobre algo que nunca
houve — uma mentira com cara de dado.

Corrigido: quando o diretório da sessão não existe, a rota devolve
`404 SESSION_NOT_FOUND`. A distinção não é inferida do conteúdo (que é ambíguo);
é a existência do diretório.

Mutação: removendo a checagem, o teste `"não existe" não vira "não fez nada"`
cai. Controle no mesmo teste: uma sessão que EXISTE e gravou pouco continua
sendo 200, com as fontes ausentes declaradas — sem ele, o 404 poderia estar
recusando todo replay.

### Honestidade da leitura

O replay relata o que não conseguiu ler em vez de encurtar a linha do tempo:
`leitura.linhas_corrompidas`, `leitura.fontes_ausentes`, `leitura.result_erro`.
Provado corrompendo uma linha real de `actions.jsonl` e exigindo que a rota
responda 200 **e** reporte a corrupção. Mutação: fixando `linhas_corrompidas: 0`,
o teste cai.

### Escopos: o que estava certo por descuido

As onze rotas do Live Agent Console já caíam em `ADMIN`, mas pelo **default** de
`scopeForRoute`, não por declaração. Enquanto fosse assim, abrandar o default —
uma linha, um dia, com boa intenção — moveria em silêncio o escopo de aprovar
uma ação. Agora estão declaradas, com o eixo escrito: **quem pode agir nunca é
quem autoriza.**

Uma assimetria deliberada: `agent.pause` e `emergency.stop` são `CONTROL`
(parar nunca pode ser mais difícil que agir), enquanto `agent.resume` é `ADMIN`
(se o agente pausado pudesse se despausar, a pausa duraria uma linha de laço).

Três mutações, três quedas:

| mutação | teste que cai |
|---|---|
| tirar uma declaração de escopo | `toda rota declarada tem escopo explícito` |
| `approvals.approve` → `CONTROL` | `o perfil de agente não alcança aprovação…` |
| `agent.resume` → `CONTROL` | `parar não é mais privilegiado do que agir` |

### E2E com navegador real

`07-replay/e2e-replay.mjs` — 13 casos, todos PASS, com Chromium real, página
real e digitação real. O caso 0 é o controle que impede o resto de ser vácuo:
prova que o canário **realmente chegou** na página antes de afirmar que ele não
vazou.

```
REPLAY_MODE=READ_ONLY
SECRET_LEAK_IN_REPLAY=0
FALHAS=0
```

---

## Erro meu, registrado

A primeira versão do caso 0 lia `#senha` com `attribute: "value"` e concluía que
o segredo não havia chegado. O valor digitado vive na **propriedade** do
elemento; o atributo `value` do HTML continua vazio. O produto estava certo, o
instrumento errado. A fixture passou a ecoar o valor num `<div id="eco">`, e a
confirmação passou a vir da própria página em vez do runtime.

Vale dizer o que isso significa: se o controle não estivesse lá, os casos 3, 4 e
9 teriam passado alegremente sobre uma página onde nada foi digitado.

---

## O instrumento que estragou uma bateria inteira

Uma execução da suíte veio com **seis arquivos vermelhos** que estavam verdes
minutos antes: `aiprovider` MORTO, `bench` FALHOU, `cascata-percepcao` FALHOU
(14 falhas), `cli` FALHOU, `product02-gate` MORTO, `recovery-watchdog` MORTO.
Registro preservado em `06-segredos/run-suite-CONTAMINADO.tsv`.

Nenhum era regressão.

**Causa, medida:** `aiprovider.test.ts` foi morto pelo vigia aos 304 s. O
`after()` dele não roda quando o processo é morto, então o modelo que ele havia
carregado ficou **residente** — `qwen2.5-coder:7b`, 5,02 GB, com `expires_at` em
**05/12/2318**. Cinco gigabytes presos assim não voltam sozinhos. Os arquivos
seguintes passaram a rodar numa máquina sem memória, e falharam do jeito que a
falta de memória faz falhar: asserção de latência estourando (`bench` esperava
`max < 200 ms` e mediu 347 ms para um `setTimeout(15)`), lease expirando antes
da ação (`cascata-percepcao`, com `current_holder: null` — ninguém tomou, ele
venceu), Chromium morrendo.

Esse é o modo de falha mais caro desta suíte porque ele **mente bem**: tudo tem
cara de regressão de produto.

Depois de descarregar o modelo, com **zero** linhas de produto alteradas:

| arquivo | contaminado | limpo |
|---|---|---|
| `aiprovider` | MORTO 304 s | OK 41 passes, 31 s |
| `bench` | FALHOU 1 | OK 37 passes, 1 s |
| `cascata-percepcao` | FALHOU 14 | OK 18 passes, 4 s |
| `cli` | FALHOU 294 s | OK 35 passes, 5 s |
| `product02-gate` | MORTO 301 s | OK 3 passes, 38 s |
| `recovery-watchdog` | MORTO 300 s | OK 24 passes, 8 s |

**Correção no `scripts/run-suite.sh`** — e não foi "aumentar o timeout":

- descarrega o que estiver residente **depois** de cada arquivo, não só antes
  dos três que carregam modelo. O estrago é sempre para quem vem DEPOIS, e a
  versão anterior só limpava ANTES;
- lê a lista do próprio `/api/ps` em vez de uma lista fixa de nomes, que
  silenciosamente não cobriria um modelo novo;
- registra `mem_livre_pct` e `llm_gb` por arquivo no `resumo.tsv`, para que
  starvation apareça como MEDIDA em vez de ser deduzida depois;
- quando um arquivo morre com memória apertada, o relatório diz na hora que
  MORTO sob starvation não é evidência de regressão.

Controle negativo do helper: com o Ollama inalcançável, `residente_gb` devolve
**vazio** (não um zero fingido), `descarregar_residentes` devolve rc=0 e não
derruba a suíte, e a coisa toda leva 0 s.
