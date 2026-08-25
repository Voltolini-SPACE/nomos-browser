# NOMOS LIVE AGENT — VALIDAÇÃO FINAL

Console visual do agente + dois modos de autonomia, validados de ponta a ponta.

Este documento é o registro do que foi **medido**. Onde algo não pôde ser
medido, está dito que não pôde — e a razão. Onde houve erro meu, o erro está
aqui, não apagado.

---

## 1. A garantia central

```
USER POLICY → AUTONOMY MODE → NOMOS CAPABILITY POLICY → SECURITY / APPROVAL GATES → ACTION
```

**`AUTO != BYPASS`.** O modo automático nunca remove uma aprovação obrigatória
definida pela política de segurança. "Agir sem perguntar" significa *execute
sozinho tudo o que eu já autorizei pela minha política* — nunca *ignore as
proteções do NOMOS*.

Isso não é promessa: é **topologia**. Em `packages/core/src/autonomy.ts`,
`decidir()` não tem ramo algum que rebaixe `SEMPRE_APROVAR` sob AUTO, e o portão
de autonomia roda **depois** de capability e de controle humano — quando ele
executa, tudo que a política do dono nega já devolveu 403 e morreu.

Medido em quatro camadas independentes:

| camada | evidência |
|---|---|
| unidade | `tests/autonomy.test.ts` — 15 testes |
| ação isolada | `02-gate/e2e-autonomia.mjs` — caso 13 |
| jornada de 8 passos | `08-modos/e2e-modos.mjs` — caso 7 |
| passos de uma **task** | `tests/task-engine.test.ts` — sem cheque em branco |

E provado por mutação: rebaixando `SEMPRE_APROVAR` sob AUTO, o caso 7 cai com
`AUTO_NAO_E_BYPASS=NAO`.

---

## 2. Estado final

```
NOMOS_BROWSER_REGRESSION=PASS
LIVE_AGENT_REGRESSION=PASS
LIVE_AGENT_CLEAN_ROOM=PASS

ASK_MODE_E2E=PASS
AUTO_MODE_E2E=PASS
UNEXPECTED_APPROVAL_PROMPTS=0
RESULTADO_IDENTICO_ENTRE_MODOS=SIM
AUTO_NAO_E_BYPASS=SIM

REPLAY_MODE=READ_ONLY
SECRET_LEAK_IN_UI=0
SECRET_LEAK_IN_AUDIT=0
SECRET_LEAK_IN_REPLAY=0

FAILURE_MODES_E2E=PASS
FAILSAFE_AUTONOMIA=NUNCA_AUTO_SEM_PROVA
LATENCY_MEASURED=PASS

OPEN_SECURITY_P1=0
```

### Contadores

| medida | valor |
|---|---|
| suíte TypeScript | **789 passes, 0 falhas, 37/37 arquivos** |
| baterias E2E do Live Agent | **9 baterias, 106 casos PASS** |
| suíte do Gi (pytest) | **148 passed** |
| sala limpa (clone do HEAD) | **14 passos, 0 falhas** |
| etapas da regressão completa | **15 PASS, 0 falha, 0 não-executada** |

---

## 3. O que o console garante

**A UI nunca infere estado que o runtime fornece.** `runtime_state`,
`autonomy_mode`, `read_only` e `control` vêm do corpo da resposta. A tela lê.

**Fail-safe de autonomia.** Quando o estado não pode ser comprovado, a tela
**nunca** mostra AUTO: cai para `DESCONHECIDA`, desmarca os rádios e diz
*"estado desconhecido — tratando como PERGUNTAR"*. Medido derrubando o daemon com
a tela aberta e religando-o. Sob mutação (a tela guardando o último modo visto),
três casos caem — e o que a mutação produzia era a tela dizendo **"AGIR
AUTOMATICAMENTE"** com o rádio AUTO marcado enquanto o runtime estava
`DISCONNECTED`.

**Aprovação é `single-use, action-bound, session-bound, audited, non-sticky`.** A
amarra de argumentos usa serialização canônica recursiva — a primeira versão
usava `JSON.stringify(args, Object.keys(args).sort())`, cujo segundo argumento é
um *replacer*: `{"target":{"selector":"#confirmar"}}` e
`{"target":{"selector":"#comprar-agora"}}` serializavam ambos para
`{"target":{}}`. Uma aprovação para clicar "Cancelar" teria autorizado
"Confirmar compra".

**Segredo não aparece na tela de aprovação.** O texto a digitar sai como
`[oculto: 24 caractere(s), C…Z]` — tamanho e pontas preservam a capacidade de
DECIDIR sem revelar. Esconder o campo inteiro transformaria o pedido em
"permitir? [sim/não]" sobre algo que o dono não sabe o que é.

**Replay é somente leitura em três camadas:** não existe verbo de escrita em
`/replay` (405 + `Allow: GET`); ler o histórico não ressuscita a sessão; e o
modo é **declarado** pelo runtime, não deduzido pela tela. O painel de histórico
não contém nenhum controle que aja — medido contando `button, input, select,
textarea, a[href]` no DOM.

**Quem age nunca é quem autoriza.** As rotas de aprovação, delegação de modo e
retomada exigem ADMIN, agora por **declaração** e não pelo default de
`scopeForRoute`. Assimetria deliberada: `pause`/`emergency-stop` são CONTROL
(parar nunca pode ser mais difícil que agir), `resume` é ADMIN (senão a pausa do
operador duraria uma linha de laço do agente).

---

## 4. Latência (n=30 por caminho; n=62 no WebSocket)

| caminho | p50 | p95 |
|---|---|---|
| evento do runtime → UI (WebSocket) | 1,0 ms | 1,0 ms |
| quadro do navegador → UI (espelho) | 18 ms | 27 ms |
| clique de APROVAR → runtime | 1,0 ms | 1,0 ms |
| freio da tela → runtime PAUSADO | 3,0 ms | 4,0 ms |
| tomada de controle → volante no humano | 1,0 ms | 2,0 ms |

`p99` sai `—` em todos, com a razão impressa: *"precisa de 100, tem 30"*.

**A fronteira que não é transporte:** a faixa de estado lê `/live` por **polling
de 700 ms**. Os eventos chegam em 1 ms; a *faixa* pode levar até 700 ms.
Reportar o número do WebSocket como se fosse o da faixa faria o console parecer
~700× mais rápido do que ele mostra ao dono.

**Controle do instrumento:** com 60 ms de atraso conhecido injetado no runtime, o
caminho da aprovação sobe de 1,0 ms para **63,0 ms** e os outros **não se
movem**.

---

## 5. Defeitos de produto encontrados e corrigidos

| # | defeito | por que importava |
|---|---|---|
| 1 | segredo em claro na tela de aprovação | a única superfície onde o texto aparece antes de ir à página |
| 2 | amarra de argumentos perdia chaves aninhadas | aprovar "Cancelar" autorizaria "Confirmar compra" |
| 3 | `/replay` devolvia 200 vazio para sessão inexistente | "não existe" virava "não fez nada" — mentira com cara de dado |
| 4 | navegador morto reportado como `TARGET_NOT_FOUND` | o operador caçava um seletor correto; um *screenshot* não tem alvo |
| 5 | `page_id` de aba morta reportado como "não é sua" | soava como bug do cliente |
| 6 | escopos do Live Agent certos por **default**, não por declaração | abrandar o default moveria em silêncio quem pode aprovar |

---

## 6. Erros meus, registrados

A missão exige preservar evidência diagnóstica e não apagar erros de
instrumento. Estes são os desta fase.

**Uma bateria inteira contaminada por 5 GB presos.** `aiprovider` foi morto pelo
vigia aos 304 s; seu `after()` não rodou; o modelo ficou residente
(`qwen2.5-coder:7b`, 5,02 GB, `expires_at` em **2318**). Seis arquivos ficaram
vermelhos — `bench`, `cascata-percepcao`, `cli`, `product02-gate`,
`recovery-watchdog` — todos com cara de regressão de produto: latência
estourando, lease expirando, Chromium morrendo. Descarregado o modelo, os seis
voltaram ao verde **sem uma linha de produto mudar**.

**Eu estava medindo uma tela que não existia mais.** O daemon serve
`packages/ui/dist/index.html`, artefato de build fora do git. Uma mutação
deliberada na UI "passou" — e eu quase registrei o teste como cego. O cego era o
instrumento.

**Asserção que aceitava duas causas.** Um regex `/fechada|página aberta/` casava
os dois ramos do `getPage`, então não percebeu que o teste nunca tocava o ramo
que eu achava cobrir.

**Reimplementei o que já existia.** Reescrevi `descarregar`/`mem_livre` dentro do
`run-suite.sh` sem ver que `lib-memoria.sh` já os tinha — e a biblioteca ainda
documentava a **mesma** medição que refiz do zero. Corrigido: a suíte agora usa a
lib, e a métrica primária virou memória **disponível** em GB.

**Daemons órfãos deram 401 em baterias inteiras, três vezes.** Todo instrumento
que sobe daemon passou a recusar subir com a porta ocupada.

**E o pior deles: matei um serviço que não era meu.** Uma limpeza *por porta*
enviou SIGKILL ao `claudio-input-engine` do dono, que ocupava uma porta usada por
um instrumento meu minutos antes. O `ps` no mesmo laço **imprimiu a linha de
comando antes do kill** — a prova passou na frente e o comando seguiu assim
mesmo. O launchd registrou o `-9` e reiniciou o job; indisponibilidade da ordem
de segundos. **Porta não prova posse.** `scripts/limpar-orfaos.sh` agora mata só
quem passa em dois testes de identidade e **preserva** o resto, dizendo o motivo
em voz alta. Registro completo em
`evidence/nomos-live-agent/11-regressao/INCIDENTE-processo-de-terceiro.md`.

---

## 7. Limitações declaradas

Coisas que **não** estão provadas, ditas aqui em vez de omitidas:

- **`pr.page.isClosed()` é inalcançável** em operação normal: o listener de
  `close` tira a aba do mapa antes que alguém a observe fechada. Fica como defesa
  de corrida — dito, não contado como cobertura.
- **Não há rota HTTP para emitir token com escopo.** A separação "quem age não
  autoriza" é provada em unidade (`tests/auth.test.ts`, com mutação) e num teste
  de API em processo, não por um cliente externo de escopo baixo.
- **`p99` não é reportado em nenhum caminho de latência.** 30 amostras não o
  sustentam, e o número não é inventado.
- **`04-takeover` e `05-controles` não constroem a UI** — porque não abrem
  navegador. Os três que abrem (`03-console`, `07-replay`, `09-falhas`) constroem.

---

## 8. Reprodução

```bash
scripts/regressao-completa.sh        # 15 etapas, um veredito
scripts/clean-room-live-agent.sh     # do clone do HEAD, recusa árvore suja
scripts/limpar-orfaos.sh --dry-run   # higiene por posse, nunca por porta
```

Evidência bruta em `evidence/nomos-live-agent/`, uma pasta por fase, com o
relatório e a saída de cada instrumento.
