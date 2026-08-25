# NOMOS Browser — Matriz de Verdade do Produto

**Toda copy pública deriva desta matriz.** Uma afirmação que não estiver aqui
como `PROVEN` não pode aparecer no README, no site, no GitHub ou em material de
lançamento.

A matriz existe porque a distância entre "o teste passou" e "o produto faz isso"
é onde nasce marketing falso. Cada linha aponta para um arquivo que qualquer
pessoa pode executar.

Legenda:

| status | significado |
|---|---|
| `PROVEN` | existe execução real, com controle negativo ou mutação que a derruba |
| `MEASURED` | número medido, com fronteira declarada; não é afirmação de garantia |
| `NOT PROVEN` | não há amostra ou execução que sustente — **não usar em copy** |
| `NOT IMPLEMENTED` | não existe no produto — **não usar em copy** |

Baseline: `HEAD=6964cf0` · suíte 789 testes / 37 arquivos · 106 casos E2E ·
sala limpa 14/14.

---

## Controle de navegador

| Claim | Status | Evidência |
|---|---|---|
| Controla Chromium real via Playwright + CDP | `PROVEN` | `tests/session.test.ts`, `tests/api.test.ts` — nada mockado; cookie lido do jar, JS avaliado na página |
| 23 verbos de navegação no contrato | `PROVEN` | `packages/core/src/contract.ts` (`ACTION_CLASS`), projetado no roteador sem segunda lista |
| Clique entregue de verdade, não só despachado | `PROVEN` | `tests/click-entrega.test.ts` — 21 casos |
| Percepção não encolhe a página | `PROVEN` | `tests/perception.test.ts` — `total_elements` conta todo o DOM, verificável de fora |
| Alvo resolvido por cascata (selector → texto → visão) | `PROVEN` | `tests/cascata-percepcao.test.ts` — 18 casos |
| Recuperação de sessão após queda do navegador | `PROVEN` | `tests/recovery-watchdog.test.ts` — 24 casos, com SIGKILL real |

## Modos de autonomia

| Claim | Status | Evidência |
|---|---|---|
| ASK: toda ação que muda a página pede aprovação | `PROVEN` | `08-modos/e2e-modos.txt` — 5/5 numa jornada de 8 passos |
| ASK: nenhuma leitura pede aprovação | `PROVEN` | idem, caso 3 — 3 leituras passam diretas |
| AUTO: nenhuma pergunta no que o dono já autorizou | `PROVEN` | idem, caso 5 — `AUTO_PROMPTS=0` |
| **AUTO não é bypass** | `PROVEN` | idem, caso 7 — `browser.upload` pergunta em AUTO. Mutação rebaixando `SEMPRE_APROVAR` derruba o caso |
| O resultado é idêntico nos dois modos | `PROVEN` | idem, caso 6 — AUTO faz menos perguntas, não menos trabalho |
| `UNEXPECTED_APPROVAL_PROMPTS=0` | `PROVEN` | idem — contador sobe para 3 e 5 sob mutação; não é cego |
| Aprovar uma task **não** é cheque em branco | `PROVEN` | `tests/task-engine.test.ts` — em ASK cada passo do plano reentra no portão |
| Passos de task reentram no gate | `PROVEN` | idem — mutação dando caminho privilegiado ao executor derruba o teste |

## Aprovação

| Claim | Status | Evidência |
|---|---|---|
| Aprovação é single-use | `PROVEN` | `tests/approvals.test.ts` — só a primeira decisão vale |
| Aprovação é action-bound | `PROVEN` | idem — impressão canônica recursiva dos argumentos |
| Aprovação é session-bound | `PROVEN` | idem — consumo confere as quatro amarras |
| Aprovação expira (TTL) e é auditada | `PROVEN` | idem + `APPROVAL_TIMEOUT` no contrato |
| Aprovação não é sticky | `PROVEN` | idem — pendências são negadas ao fechar a sessão |
| Quem age não pode autorizar | `PROVEN` | `tests/auth.test.ts` — perfil de agente não alcança `approvals.approve`, `autonomy.set`, `agent.resume`; três mutações derrubam |

## Segredos

| Claim | Status | Evidência |
|---|---|---|
| Texto digitado não aparece em claro na aprovação | `PROVEN` | `06-segredos/02-depois.txt` — `SECRET_LEAK_IN_UI=0`; mutação em `03-mutacao.txt` reabre o vazamento |
| Segredo não entra na trilha de auditoria | `PROVEN` | idem — `SECRET_LEAK_IN_AUDIT=0` |
| Segredo não aparece no replay | `PROVEN` | `07-replay/e2e-replay.txt` — `SECRET_LEAK_IN_REPLAY=0`, com controle provando que o canário chegou à página |
| Mascaramento preserva o que permite decidir | `PROVEN` | `tests/approvals.test.ts` 20–25 — `[oculto: N caractere(s), X…Y]` |

## Replay e auditoria

| Claim | Status | Evidência |
|---|---|---|
| Replay é somente leitura | `PROVEN` | `tests/api.test.ts` — POST/PUT/PATCH/DELETE em `/replay` = 405 + `Allow: GET` |
| Ler o replay não ressuscita a sessão | `PROVEN` | idem — ação seguinte continua recusada |
| O modo read-only é declarado pelo runtime | `PROVEN` | idem — `read_only` no corpo; a UI lê, não deduz |
| "Não existe" ≠ "não fez nada" | `PROVEN` | idem — sessão inexistente é 404, não replay vazio de 200 |
| O replay relata o que não conseguiu ler | `PROVEN` | idem — corrompendo `actions.jsonl`, responde 200 e **reporta** |
| Trilha de auditoria encadeada por hash | `PROVEN` | `tests/audit-forense.test.ts`, `tests/replay-hardening.test.ts` (44 casos) |
| Sessão encerrada é selada | `PROVEN` | `07-replay/e2e-replay.txt` — `selado=true` |

## Live Agent Console

| Claim | Status | Evidência |
|---|---|---|
| A tela mostra estado canônico do runtime | `PROVEN` | `03-console/e2e-console.txt` — 18 casos |
| Pausar e parar são controles reais no backend | `PROVEN` | `05-controles/e2e-controles.txt` — 13 casos; o kill roda inteiro no backend mesmo se a UI cair |
| Tomada de controle humano congela o agente | `PROVEN` | `04-takeover/e2e-takeover.txt` — 11 casos |
| Devolver o volante exige reobservação | `PROVEN` | `REOBSERVE_REQUIRED` no contrato + `04-takeover` |
| Fail-safe: sem prova de estado, nunca AUTO | `PROVEN` | `09-falhas/e2e-falhas.txt` — casos 6, 6b, 7; mutação derruba os três |
| A tela diz quando não sabe | `PROVEN` | idem — "estado desconhecido — tratando como PERGUNTAR" |
| Nenhuma cor literal na UI (marca vem do cofre) | `PROVEN` | `tests/ui-build.test.ts` — falha se um hex aparecer no `src` |

## Modos de falha

| Claim | Status | Evidência |
|---|---|---|
| Erro de alvo falha com código, não em silêncio | `PROVEN` | `09-falhas/e2e-falhas.txt` caso 1 |
| Página que nunca responde vira `TIMEOUT` com prazo | `PROVEN` | idem caso 2 — servidor que aceita e nunca escreve |
| Navegador morto reporta `BROWSER_UNAVAILABLE` | `PROVEN` | idem casos 3/3c — inclusive em `browser.screenshot`, que não tem alvo |
| A sessão sobrevive a um erro de ação | `PROVEN` | idem caso 1b |

## Integração

| Claim | Status | Evidência |
|---|---|---|
| 16 ferramentas MCP | `PROVEN` | `packages/mcp/src/tools.ts`; `tests/mcp.test.ts` — 36 casos |
| CLI `nomos-web` com 9 comandos | `PROVEN` | `tests/cli.test.ts` — 35 casos |
| SDK TypeScript | `PROVEN` | `tests/sdk-ts.test.ts` — 8 casos |
| API REST v1 + WebSocket de eventos | `PROVEN` | `tests/api.test.ts` — 42 casos |
| Integração com o Gi (assistente de voz) | `PROVEN` | suíte do Gi — 148 passed |
| Catálogo MCP do NOMOS com permissão 0600 | `PROVEN` | `11-regressao/etapas.tsv` |

## Segurança

| Claim | Status | Evidência |
|---|---|---|
| Autenticação por token com escopos | `PROVEN` | `tests/auth.test.ts` — 24 casos, com provas negativas |
| Toda rota tem escopo **declarado**, nenhuma vive do default | `PROVEN` | idem — mutação removendo uma declaração derruba |
| Política fail-closed por capability | `PROVEN` | `tests/policy-vault.test.ts`, `tests/e2e-gate.test.ts` |
| Anti-SSRF em URL interna | `PROVEN` | `tests/security-net-injection.test.ts` — 22 casos |
| Proteção de arquivos e segredos | `PROVEN` | `tests/security-files-secrets.test.ts` — 38 casos |
| Detecção de injeção via conteúdo de página | `PROVEN` | `tests/injection-wired.test.ts` — 16 casos |
| Lease de controle, fail-closed | `PROVEN` | `tests/lease.test.ts` — 37 casos |
| UI servida na mesma origem, com CSP | `PROVEN` | `packages/api/src/daemon.ts` — `connect-src 'self'`, sem CORS permissivo |

## Latência — números medidos, não garantias

| Claim | Status | Evidência |
|---|---|---|
| Evento do runtime → UI: p50 1,0 ms (n=62) | `MEASURED` | `10-latencia/medir-latencia.txt` |
| Quadro do navegador → UI: p50 ~18 ms (n=30) | `MEASURED` | idem |
| Clique de aprovar → runtime: p50 1,0 ms (n=30) | `MEASURED` | idem |
| Freio da tela → runtime pausado: p50 3,0 ms (n=30) | `MEASURED` | idem |
| Tomada de controle: p50 1,0 ms (n=30) | `MEASURED` | idem |
| A faixa de estado é polling de 700 ms | `MEASURED` | idem — os eventos chegam em 1 ms; a **faixa** pode levar 700 ms |
| **p99 de qualquer caminho** | `NOT PROVEN` | 30 amostras exigem 100 para p99. O instrumento devolve `null` e diz por quê. **Nenhum máximo observado pode ser chamado de p99.** |

## Não implementado

| Claim | Status | Nota |
|---|---|---|
| Rota HTTP para emitir token com escopo | `NOT IMPLEMENTED` | tokens escopados existem na API interna (`AuthManager.issue`); não há rota pública. Roadmap. |
| Cobertura funcional do ramo `pr.page.isClosed()` | `NOT PROVEN` | o listener de `close` tira a aba do mapa antes que alguém a observe fechada; é defesa de corrida. Roadmap. |
| Percentis estatisticamente robustos | `NOT PROVEN` | exige bateria longa dedicada. Roadmap. |

---

## Regras de derivação para a copy

1. Nada de `NOT PROVEN` ou `NOT IMPLEMENTED` vira benefício de marketing.
2. Números `MEASURED` sempre viajam com o `n` e com a fronteira do que medem.
3. Não usar "100% seguro", "infalível", "zero risco" — nenhuma linha aqui
   sustenta isso, e nenhuma linha jamais sustentará.
4. "AUTO não é bypass" pode ser dito sem ressalva: é `PROVEN`, com mutação.
5. Onde a matriz diz `MEASURED`, a copy diz "medimos"; onde diz `PROVEN`, a copy
   pode dizer "faz".
