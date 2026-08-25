# Promoção a GA — estado

```
STATUS=BLOQUEIO_EXTERNO_REAL
BLOCKER=HUMAN_A1_GATE
```

O bloqueio é literalmente **um humano digitando uma palavra**. Não há truque que
o substitua, e procurar um seria trair o que este produto inteiro existe para
garantir. Tudo o mais está verde e medido.

```
HUMAN_A1_GATE=PENDENTE_DONO
LEGACY_TRUST_STATE=RESOLVED
FULL_REGRESSION=PASS
GA_PROMOTION_READY=NO   (por causa do gate, e só por isso)
```

Para desbloquear, no terminal do dono:

```sh
cd /Users/AI/Projects/nomos-browser
bash evidence/nomos-browser-ga/01-gate-humano/gate-humano-a1.sh
# duas perguntas; digite APROVO nas duas
```

---

## Onde cada fase parou

| Fase | Gate | Estado |
|---|---|---|
| 0 | `RC1_TAG_MATCH` / `WORKTREE_CLEAN` / `PRODUCTION_BASELINE_CAPTURED` | **YES / YES / YES** |
| 1 | `HUMAN_A1_GATE` | **PENDENTE_DONO** — 2 de 7 provas fechadas por mim |
| 2 | `BARGE_IN_PRODUCTION_PATH` | **PASS** |
| 3 | `LEGACY_TRUST_STATE` | **RESOLVED** |
| 4 | `FULL_REGRESSION` | **PASS** |
| 5–6 | `GA_VERSION` / `GA_TAG_REVALIDATED` | **não iniciadas** — dependem da FASE 1 |
| 7 | relatório | este arquivo + o relatório final, depois da promoção |
| 8 | `REMOTE_PUBLICATION` | **WAITING_FOR_OWNER** — não há remoto e não criei nenhum |

---

## FASE 0 — freeze

```
RC1_TAG_MATCH=YES              v0.2.0-rc.1 -> 95787cb
WORKTREE_CLEAN=YES             (arquivos rastreados: 0 linhas)
PRODUCTION_BASELINE_CAPTURED=YES
```

Dois achados, **nenhum causado por mim**:

**Cinco shells meus, de ontem, em laço infinito.** Eram
`until grep -qE "^TS_PASS=" /tmp/suite_*.txt; do sleep 20; done`; os arquivos
existiam mas tinham **zero** linhas `TS_PASS`. Girariam para sempre. Ownership
provado antes de encostar: `PPID=52056` (app do Claude Code), início Aug 24
12:14–13:17, comando citando `~/Projects/nomos-browser/.suite`.

O incômodo de verdade não é o desperdício: é que eles passavam despercebidos por
**todos** os meus contadores de `PROCESS_RESIDUAL`, que só olhavam `daemon.ts`,
Chromium e `servidor.mjs`. `PROCESS_RESIDUAL=0` era verdade sobre o **produto** e
falso sobre o **arnês**. Junto: 265 diretórios `nomos-sandbox-*`, 9 clean rooms e
956 MB em `/tmp`, tudo meu, tudo apagado. Não toquei em `/tmp/claude-504`,
`/tmp/nomos-panel-cdp` nem nos `venv_*` — não são meus.

**`br.com.se7enpay.nomos.servico` trocou de PID** (83005 → 69404) durante o
freeze. Não fui eu, e a prova é a monotonicidade dos PIDs: 69404 nasceu entre a
minha sondagem de baseline (69323) e a de ownership (69513); o meu `kill` só veio
em 69778. O serviço tem `KeepAlive`, e o log dele mostra um
`No space left on device` de **ontem** 09:10 (hoje há 88 Gi livres).
`nomos painel` (PID 69448) tem `PPID = zsh -l` — é o terminal do dono. Intocado.

---

## FASE 1 — gate humano A1 (2 de 7)

Ferramenta escolhida: **`browser_tab_switch`**, `A1_WRITE_LOCAL`. Troca o foco
entre duas abas em branco que já existem: segura, reversível, sem rede, sem
exclusão, e observável (`browser_tabs`, A0, diz qual está ativa).
`browser_tab_close` foi descartada justamente por apagar algo.

| # | Prova | Estado |
|---|---|---|
| 1 | sem aprovação (sem TTY) → negado | **DENIED** |
| 2 | aprovação incorreta (TTY, palavra errada) → negado | **DENIED — 3 de 3** |
| 3 | `APROVO` real → executado | **PENDENTE_DONO** |
| 4 | a aprovação aparece nas trilhas | pendente do 3 |
| 5 | escopo exato | pendente do 3 |
| 6 | sem elevação silenciosa para A2/A5 | pendente do 3 |
| 7 | sem bypass fora do NOMOS | pendente do 3 |

A prova 2 exigiu um pty: sem terminal, o caso "tem TTY mas a resposta é errada"
não é testável e viraria suposição. As três palavras foram `NAO`, `APROVADO` e
`aprovo` **minúsculo** — esta última prova que o NOMOS não afrouxa a comparação
exata (`resp.strip() != "APROVO"`).

O utilitário de pty **se recusa** a digitar `APROVO`; a checagem está no código
dele, não na minha boa vontade.

### O erro que me custou a primeira tentativa do dono

Ele rodou o gate, chegou no passo 3, e recebeu:

```
[NOMOS-E002] NEGADO (fail-closed): aprovação exige terminal interativo.
```

Não foi o NOMOS: fui eu. Eu canalizava a saída por `| tee` para gravar a
transcrição, e um pipe faz o stdout deixar de ser TTY. **O instrumento fechou a
porta na cara dele.** Trocado por `script -q`, que aloca um pty de verdade, e
validado com um TTY real respondendo errado de propósito.

---

## FASE 2 — barge-in no caminho privilegiado

```
REGISTERED_PATH_CANCEL=PASS
POST_CANCEL_ACTIONS=0
PROCESS_RESIDUAL=0
BARGE_IN_PRODUCTION_PATH=PASS
```

Ao desenhar a distinção pedida no audit, apareceu um caso que o código contava
**errado**: cancelamento que chega depois de a ação já ter executado devolvia
`CANCELADO`. O dono ouviria "cancelei" com a aba já trocada na tela. Agora há um
quarto evento — `too_late` — e a resposta admite `cancelamento_tardio=True`.

Quatro eventos, e não são sinônimos:

| evento | significa |
|---|---|
| `browser.cancel.requested` | alguém pediu para parar |
| `browser.cancel.accepted` | dá para parar, e vamos parar |
| `browser.cancel.terminated` | o que sobrou: `pid`, `gid`, `sinais`, `grupo_ainda_vivo` |
| `browser.cancel.too_late` | chegou tarde: a ação aconteceu e **não** foi desfeita |

`grupo_ainda_vivo` é medido com `killpg(gid, 0)` — que não envia sinal, só
pergunta. Sem esse campo, `terminated` seria otimismo com cara de auditoria.

Contra o NOMOS e o runtime **reais**, varrendo o atraso do cancelamento:

```
   0..360 ms   CANCELADO   ->  0 ações novas na trilha do runtime
 420..540 ms   EXECUTADO   ->  exatamente 1 ação na trilha
 INCOERENTES=0
```

O invariante medido não é "cancelou": é **a resposta dada ao dono bater com a
trilha do runtime**. Um `CANCELADO` com ação na trilha, ou um `EXECUTADO` sem
ela, seriam mentira — e é a mentira que o código ingênuo produzia.

Nota honesta: o ramo `too_late` **não** foi alcançado no E2E real (a transição
entre janela e execução é abrupta demais nesta máquina). Ele está coberto de
forma determinística no teste unitário, e isso está dito aqui em vez de ficar
escondido atrás do verde do E2E.

---

## FASE 3 — manifesto legado `d267002f…`

```
LEGACY_TRUSTED_BEFORE=SIM
LEGACY_TRUST_EXPLOITABLE=NAO
LEGACY_BLOCKED_BY_LAYER=SERVIDOR (validação de argumentos do código atual)
LEGACY_TRUST_REVOKED=YES
LEGACY_REFUSED_AFTER=YES
CURRENT_MANIFEST_UNHARMED=YES
LEGACY_TRUST_STATE=RESOLVED
```

Descoberta primeiro, sem alterar nada. O trust vive em
`~/.nomos/mcp_catalogo.json` (0600), `confiar` só **acrescenta**, e existe
revogação canônica: `cat.revogar()` na biblioteca, `nomos mcp revogar` no CLI,
com linha `mcp.revogado` numa trilha encadeada por hash. Editar o arquivo à mão
seria **mais fraco** — tirar de `confiaveis` só devolve o server a
`experimental`, que ainda conecta com "ACEITO O RISCO" num TTY — e sem rastro.
Não editei.

**Medir antes de decidir.** O manifesto antigo foi extraído do histórico
(`git show 78491cc:…`, não forjado) e posto **ao lado** do `servidor.mjs`, que é
o cenário de ataque de verdade. Com ele ainda confiável:

```
status=confiavel · conecta · browser_tabs=A0 · veredito do NOMOS=ALLOW
exploit histórico (action=new + url): abas antes=2, depois=2
QUEM BARROU: o SERVIDOR, por validação de argumento do código ATUAL
```

Esse detalhe é o achado. A camada de **manifesto** teria deixado passar; quem
segurou foi a de **código**. Defesa de uma camada só — e um `git checkout` do
`servidor.mjs` daquele commit devolve a metade que falta. Por isso revoguei,
mesmo com o exploit já barrado hoje. Catálogo: 3 confiáveis → 2, 1 revogada.

---

## FASE 4 — regressão integral

| Medida | Piso | Medido |
|---|---|---|
| Node | ≥ 735 | **735/735** em 35 arquivos |
| Python (SDK) | ≥ 31 | **31/31** |
| Gi | ≥ 138 | **145/145** (+7 do barge-in) |
| E2E | ≥ 20 | **20/20** |
| E2E checagens | ≥ 213 | **213** |
| adversarial | — | **53 vetores**, `OPEN_SECURITY_P1=0` |
| `ci.sh all` | — | **CI_PASS=YES** |
| repetições de transporte | 0 | **0** (11 classificadas como "daemon já derrubado") |
| resíduo de processo | 0 | **0** |

Nenhum contador foi reduzido para produzir verde. O da Gi **subiu**.

---

## FASE 8 — publicação

```
REMOTE_PUBLICATION=WAITING_FOR_OWNER
```

Não há remoto configurado e não criei nenhum. Isso não rebaixa o produto nem a
GA local.
