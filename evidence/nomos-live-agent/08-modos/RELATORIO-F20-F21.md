# FASES 20 e 21 — ASK e AUTO numa jornada multipasso real

O que estas fases precisam responder não é "os dois modos funcionam". É a
diferença **exata** entre eles, medida numa jornada inteira em vez de numa ação
isolada.

Três afirmações, três medidas:

1. **O resultado final é idêntico nos dois modos.** AUTO não faz menos trabalho
   — faz menos perguntas. Se a página terminasse diferente, o modo teria mudado
   o produto, e não foi isso que se prometeu ao dono.
2. **Em ASK, toda ação que muda a página pergunta; nenhuma leitura pergunta.**
   Perguntar para ler é ruído, e ruído treina o dono a aprovar sem ler — que é
   como uma aprovação obrigatória vira um clique reflexo.
3. **Em AUTO, nenhuma dessas perguntas aparece, e a ação protegida continua
   perguntando.** É `AUTO != BYPASS` medido depois de oito passos sem
   interrupção, no momento em que a guarda seria mais fácil de baixar.

---

## A jornada

Duas páginas locais, oito ações reais em Chromium real:

```
browser.open    /            muda
browser.extract #etapa       lê      → INICIO
browser.type    #usuario     muda
browser.click   #entrar      muda    → etapa vira LOGADO
browser.extract #etapa       lê      → LOGADO
browser.goto    /painel      muda
browser.click   #exportar    muda    → etapa vira EXPORTADO
browser.extract #etapa       lê      → EXPORTADO
```

`muda` é a expectativa **declarada à mão** pelo teste a partir do contrato, não
lida de `PERFIL_DA_ROTA`. Ler a mesma tabela que o produto lê provaria apenas
que uma constante é igual a si mesma, e um erro na tabela passaria despercebido
dos dois lados.

## Resultado

```
PASSOS_DA_JORNADA=8 (mudam=5 leem=3)
ASK_PROMPTS=5
AUTO_PROMPTS=0
UNEXPECTED_APPROVAL_PROMPTS=0
RESULTADO_IDENTICO=SIM
AUTO_NAO_E_BYPASS=SIM
ASK_MODE_E2E=PASS
AUTO_MODE_E2E=PASS
```

`UNEXPECTED_APPROVAL_PROMPTS` conta pergunta fora do lugar nos **dois** sentidos:
pergunta em AUTO sobre rota que o dono já autorizou, ou pergunta em qualquer
modo sobre uma simples leitura.

O caso 7 é o que sustenta o resto: na mesma sessão em AUTO, logo depois dos oito
passos sem uma pergunta, `browser.upload` **perguntou** — com o motivo correto,
que é o fator de risco e não o nível:

> "a ação envia dado seu para fora, e isso não se retira"

Negada, devolveu `403 APPROVAL_DENIED`.

## Mutações — o contador não é cego

| mutação no produto | efeito medido |
|---|---|
| `SEMPRE_APROVAR` rebaixado sob AUTO (o bug do BYPASS) | caso 7 cai · `AUTO_NAO_E_BYPASS=NAO` |
| A0 vira `DEPENDE_DO_MODO` (ASK passa a perguntar para ler) | caso 3 cai · `UNEXPECTED=3` |
| AUTO se comporta como ASK | caso 5 cai · `AUTO_PROMPTS=5` · `UNEXPECTED=5` |

O contador sai de 0 para 3 e para 5 conforme o defeito. Ele mede.

---

## O cheque em branco que não existe

`browser.task` é `SEMPRE_APROVAR` (A5, irreversibilidade alta). O dono aprova
**uma vez**: "faça isso". A pergunta que decide se o modo de autonomia vale
alguma coisa numa tarefa multipasso é se essa aprovação vale como autorização
geral para tudo que o plano resolver fazer depois.

Se valesse, `AUTO != BYPASS` estaria trancando a porta da frente com a dos
fundos aberta — e o caminho dos fundos seria justamente o mais usado, porque é
por task que um agente trabalha.

Medido em `tests/task-engine.test.ts`, com plano determinístico e passos reais:

- **em AUTO**, a lista de perguntas é exatamente `["browser.task"]`. Controle no
  mesmo teste: os dois `browser.goto` aparecem na trilha forense — sem isso,
  "nenhuma pergunta" seria verdade trivial sobre um plano que não rodou.
- **em ASK**, depois de a task ser aprovada, **cada passo perguntou de novo**.
  Se os passos herdassem a aprovação da task, a lista teria um item só.

Isso funciona porque `executarPasso` fala com a própria API por loopback em vez
de chamar `handlerFor()` direto — o comentário no código dizia que a razão era
de segurança; agora existe medida.

**Mutação:** dando ao executor de passo o caminho privilegiado que o comentário
descreve (`client === "agente-fase9"` escapando do portão de autonomia), o teste
cai com a mensagem certa:

```
AssertionError: os passos do plano não reentraram no portão — perguntou: browser.task
```

---

## Erros meus, registrados

**1. O instrumento podia pendurar para sempre.** A mutação "A0 vira
DEPENDE_DO_MODO" travou a bateria: `lerEtapa()` chamava `browser.extract` cru e
esperava, e sob aquela mutação a leitura passou a exigir aprovação que ninguém
daria. Sob o produto correto o caminho nunca é usado — e é exatamente por isso
que precisava existir. `lerEtapa` passou pelo mesmo laço de aprovação da
jornada, e `executar()` ganhou teto duro de 20 s. Um instrumento que pendura é
pior do que um que falha: o operador não distingue "está pensando" de "morreu".

**2. Um daemon órfão fez a bateria inteira voltar 401.** Ao matar a execução
pendurada, o daemon da porta 7796 sobreviveu — `pkill -f "NOMOS_BROWSER_PORT=7796"`
não casa nada, porque variável de ambiente não aparece na linha de comando. A
execução seguinte falou com o daemon velho, cujo token não era o novo, e voltou
oito casos vermelhos que não diziam nada sobre o produto. O teste passou a
**recusar subir** com a porta ocupada, dizendo qual comando resolve, em vez de
descobrir depois.
