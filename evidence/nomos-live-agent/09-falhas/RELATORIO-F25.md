# FASE 25 — modos de falha

Um console que só é honesto quando tudo funciona não é honesto: é sortudo. O que
se mede aqui é o que a tela e o runtime dizem quando as coisas quebram. A regra é
sempre a mesma: **dizer o que não se sabe é obrigatório, inventar é proibido.**

Doze casos, todos PASS, com Chromium real e daemon real derrubado de verdade.

| # | falha injetada | o que se exigiu |
|---|---|---|
| 1 | alvo que não existe | falha COM código (`TARGET_NOT_FOUND`), não em silêncio |
| 1b | — | controle: a sessão sobrevive ao erro |
| 2 | servidor que aceita e nunca responde | `TIMEOUT` em 6 s, não travamento |
| 3 | `SIGKILL` no Chromium | ação seguinte falha sem inventar resultado |
| 3b | idem | o runtime não segue anunciando a sessão como antes |
| 3c | idem | o código diz `BROWSER_UNAVAILABLE`, não "alvo não encontrado" |
| 4 | — | controle: com runtime vivo, a tela mostra o AUTO real |
| 5 | daemon morto com a UI aberta | a tela DIZ que está desconectada |
| 6 | idem | **a tela NUNCA mostra AUTO** |
| 6b | idem | e explica o que fará enquanto não sabe |
| 7 | daemon de volta | a autonomia não volta a AUTO por memória da tela |
| 8 | sessão perdida | não é pintada como viva |
| 9 | toda a sequência | nenhum erro de JS |

```
FAILSAFE_AUTONOMIA=NUNCA_AUTO_SEM_PROVA
FAILURE_MODES_E2E=PASS
```

O caso 2 usa um servidor que **aceita a conexão e nunca escreve nada** — não um
servidor lento. Um prazo que só cobre "lento" não cobre "nunca".

---

## Defeito de produto encontrado: a página morta que se dizia alvo errado

Matando o Chromium, `browser.extract` **e** `browser.screenshot` voltavam
`TARGET_NOT_FOUND`. Um screenshot não tem alvo. O código estava errado, e o
erro custava caro: quem lesse a trilha iria caçar um seletor que estava correto,
enquanto a verdade era que a página tinha morrido.

`getPage()` cobria três situações com o mesmo código, e duas não eram erro de
alvo nenhum. A separação agora é:

| situação | código | por quê |
|---|---|---|
| sessão sem aba nenhuma | `BROWSER_UNAVAILABLE` | o navegador sumiu por baixo |
| aba que **era** desta sessão e fechou | `BROWSER_UNAVAILABLE` | idem |
| `page_id` que nunca foi desta sessão | `TARGET_NOT_FOUND` | erro de quem pediu |

`BROWSER_UNAVAILABLE` (503) já era o código dessa condição no mesmo arquivo,
duas funções abaixo ("contexto não está mais vivo").

O terceiro caso exigiu memória: a sessão passou a lembrar quais abas foram suas
(`closed_pages`, com teto de 64 — diagnóstico, não registro histórico). Sem ela,
um cliente que guardou um `page_id` e o usa depois da queda recebia "não
pertence à sessão", que soa como bug dele.

Três mutações, três quedas: sessão-sem-aba de volta a `TARGET_NOT_FOUND`; a
sessão esquecendo as abas mortas; e o renomeio geral que teria feito aba alheia
virar `BROWSER_UNAVAILABLE` — o controle que impede a correção de virar um
"troque tudo".

---

## Dois erros meus, e o segundo é o mais grave

### 1. A asserção que aceitava duas causas

O primeiro teste da página morta usava `/fechada|página aberta/`. O regex
aceitava os dois ramos do `getPage`, então não percebeu que o teste **nunca
tocava o ramo que eu achava estar cobrindo** — a mutação passou verde. Uma
asserção que aceita duas causas diferentes não distingue nenhuma delas. Agora a
mensagem é asserida exatamente.

Isso também revelou que o ramo `pr.page.isClosed()` é **inalcançável** em
operação normal: o listener de `close` tira a aba do mapa antes que alguém possa
observá-la fechada. Ele fica como defesa de corrida, e está dito aqui em vez de
ser contado como cobertura.

### 2. Eu estava medindo uma tela que não existia mais

O daemon serve `packages/ui/dist/index.html` — **artefato de build**, que não
entra no git. Editar `src/app.html` e rodar o E2E direto mede a versão anterior
da tela.

Foi assim que uma mutação deliberada na UI "passou" sem derrubar caso nenhum. Eu
quase registrei isso como "o caso 6 é cego". O cego era o instrumento: a tela
mutada nunca chegou ao navegador. Construindo antes de medir, a mesma mutação
derruba **três** casos:

```
[FALHA] 6.  a tela NUNCA mostra AUTO — modo=AUTO radios marcados=[AUTO] aviso="reconectando…"
[FALHA] 6b. e explica o que vai fazer enquanto não sabe
[FALHA] 7.  a autonomia NÃO volta a AUTO por memória da tela — texto="AGIR AUTOMATICAMENTE"
FAILSAFE_AUTONOMIA=FALHOU
```

E vale olhar para o que a mutação produzia: a tela dizendo **"AGIR
AUTOMATICAMENTE"**, com o rádio AUTO marcado, enquanto o runtime estava
`DISCONNECTED`. O dono leria que o agente está agindo sozinho num momento em que
ninguém consegue confirmar coisa alguma.

Os E2E de UI (`07-replay`, `09-falhas`) passaram a construir a interface antes de
medir. Os anteriores (`03-console`, `05-controles`) mediram uma `dist` que a
suíte havia construído — o resultado valia, mas por sorte de ordem de execução,
não por garantia. Isso está registrado como dívida, não como aprovação.
