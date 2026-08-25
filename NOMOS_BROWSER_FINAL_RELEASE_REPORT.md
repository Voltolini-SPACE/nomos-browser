# NOMOS Browser — Relatório de release

```
PRODUCT_FINALIZED=YES
HUMAN_A1_GATE=PASS
LEGACY_TRUST_STATE=RESOLVED
FULL_REGRESSION=PASS
GA_VERSION=0.2.0
GA_TAG_REVALIDATED=YES
GA_PROMOTION_READY=YES
REMOTE_PUBLICATION=WAITING_FOR_OWNER
```

| | |
|---|---|
| Tag GA | `v0.2.0` → `e9a847cb65aecf8d0a636f6040c112ca9e287523` |
| Tag anterior | `v0.2.0-rc.1` → `95787cbf538eb82b6d30f20bda8f4e3feda12ba2` |
| Versão | `0.2.0` — coerente em **13 declarantes** |
| Remotos | nenhum, e nenhum foi criado |
| Manifesto MCP | impressão `317f15893e9ebd83afa17d11f66dd896c83342858ad723e0f4ed7afd32e27207` |
| Data | 2026-08-25 |

A versão anterior deste relatório está em
`evidence/nomos-browser-final-100/00-relatorio-anterior.md`. Registro que se
apaga não é registro.

---

## 1. O que separou o `rc.1` do GA

**Uma pessoa digitando `APROVO` num terminal.**

Todas as provas anteriores — e eram muitas — mediam o portão **fechando**:
negativas, `fail-closed`, elevação barrada, exploit recusado. A metade que
**autoriza** nunca tinha rodado. Enquanto ela não rodasse, dizer que o produto
estava pronto seria afirmar por inferência exatamente a coisa mais importante.

A ferramenta escolhida foi **`browser_tab_switch`** (`A1_WRITE_LOCAL`): troca o
foco entre duas abas em branco já abertas. Segura, reversível, sem rede, sem
exclusão, e observável — `browser_tabs` (A0) diz qual está ativa antes e depois.
`browser_tab_close` foi descartada justamente por apagar algo.

### O veredito não foi lido da tela

O script roda no terminal do dono e a saída dele fica lá. Ler o gate por ali me
obrigaria a pedir que alguém copiasse um texto — e **texto colado é depoimento,
não evidência**. Os sete gates foram computados das **duas trilhas duráveis**,
escritas por processos diferentes, que só fecham se contarem a mesma história:

```
~/.nomos/logs/audit.jsonl        quem AUTORIZOU  (e quem negou)
<sessoes>/<sid>/actions.jsonl    o que EXECUTOU
```

```
negativas de browser_tab_switch (A1) ....... 5
execucoes de browser_tab_switch (A1) ....... 2
negativas de nivel A2+ ..................... 3  (navigate, tab_open, task)
EXECUCOES de nivel A2+ ..................... 0
rota browser.switch_tab no runtime ......... 2
outras mutacoes de navegador ............... nenhuma
dono das trocas ............................ mcp:nomos-browser-mcp
```

| Prova | Gate | Resultado |
|---|---|---|
| 1 | `A1_WITHOUT_APPROVAL` | **DENIED** — sem TTY, e a aba não se moveu |
| 2 | `A1_INVALID_APPROVAL` | **DENIED — 3 de 3** |
| 3 | `A1_WITH_REAL_APROVO` | **PASS** |
| 4 | `APPROVAL_AUDITED` | **YES** — nas duas trilhas |
| 5 | `SCOPE_EXACT` | **EXATO** — só a rota aprovada mutou |
| 6 | `SILENT_ELEVATION` | **NO** |
| 7 | `PRIVILEGE_BYPASS` | **NO** |

**A quinta negativa de A1 é a que mais importa.** Quatro são as que eu já tinha
produzido sozinho. A quinta veio **depois** do `APROVO`: a mesma ferramenta,
tentada de novo sem terminal, foi negada. **A aprovação não grudou.** Esse é o
risco real de qualquer gate de aprovação — você autoriza uma coisa e a sessão
inteira sobe de nível — e ele está fechado por medida, não por promessa.

As três palavras erradas da prova 2 foram `NAO`, `APROVADO` e `aprovo`
**minúsculo**. A última prova que o NOMOS não afrouxa a comparação exata
(`resp.strip() != "APROVO"`). Esse caso exigiu um pty: sem terminal, "tem TTY
mas a resposta é errada" não é testável e viraria suposição. O utilitário de pty
**se recusa** a digitar `APROVO` — a checagem está no código dele.

---

## 2. Erros meus, nesta missão

### O instrumento fechou a porta na cara do dono

Ele rodou o gate, chegou ao passo 3, e recebeu:

```
[NOMOS-E002] NEGADO (fail-closed): aprovação exige terminal interativo.
```

Não foi o NOMOS. Eu canalizava a saída do `nomos` por `| tee` para gravar a
transcrição, e **um pipe faz o stdout deixar de ser TTY**. O `interactive_approver`
recusa antes de perguntar. Trocado por `script -q`, que aloca um pty de verdade,
e validado com um TTY real respondendo errado de propósito antes de pedir a
segunda tentativa.

### `PROCESS_RESIDUAL=0` era verdade sobre o produto e falso sobre o arnês

O freeze encontrou **cinco shells meus, de ontem**, em laço infinito:
`until grep -qE "^TS_PASS=" /tmp/suite_*.txt; do sleep 20; done`, com os arquivos
existindo mas contendo **zero** linhas `TS_PASS`. Girariam para sempre. Ownership
provado antes de encostar: `PPID=52056` (app do Claude Code), início Aug 24
12:14–13:17, comando citando `~/Projects/nomos-browser/.suite`.

O incômodo não é o desperdício: é que **nenhum** dos meus contadores os enxergava
— eles só olhavam `daemon.ts`, Chromium e `servidor.mjs`. Junto vieram 265
diretórios `nomos-sandbox-*`, 9 clean rooms e 956 MB em `/tmp`. Tudo meu, tudo
removido. Não toquei em `/tmp/claude-504`, `/tmp/nomos-panel-cdp` nem nos
`venv_*` — não são meus.

### Um sétimo erro de instrumento, herdado

A tabela completa dos sete erros de instrumento da missão anterior continua em
`evidence/nomos-browser-final-100/00-relatorio-anterior.md`, §6. Nenhum foi
apagado.

---

## 3. Defeitos de produto corrigidos nesta versão

### O cancelamento que mentia

`gi_nomos.browser.executar` derrubava o processo sem perguntar se ele ainda
estava vivo. Se o `nomos` já tinha terminado — e ele termina com o
`node servidor.mjs` **neto** ainda segurando os pipes, que é exatamente quando
`poll()` deixa de ser `None` — a Gi devolvia `CANCELADO` para uma ação que
**aconteceu**. O dono ouviria "cancelei" com a aba já trocada na tela dele.

Agora há um quarto evento e a resposta admite `cancelamento_tardio=True`:

| evento | significa |
|---|---|
| `browser.cancel.requested` | alguém pediu para parar |
| `browser.cancel.accepted` | dá para parar, e vamos parar |
| `browser.cancel.terminated` | o que sobrou: `pid`, `gid`, `sinais`, `grupo_ainda_vivo` |
| `browser.cancel.too_late` | chegou tarde: a ação aconteceu e **não** foi desfeita |

`grupo_ainda_vivo` é medido com `killpg(gid, 0)` — que não envia sinal, só
pergunta. Sem esse campo, `terminated` seria otimismo com cara de auditoria.

No ramo tardio eu mesmo introduzi um `communicate()` **sem prazo** — um pendura,
já que o neto segura os pipes. Corrigido com prazo de 5 s e derrubada do grupo.

**Teste de mutação executado**: removido o ramo `too_late`, o teste reprova;
restaurado, 7/7. E o caso tardio deixou de ser uma corrida: o `nomos` falso
anuncia o próprio PID ao sair e o objeto `cancelar` só fica setado quando aquele
PID some de verdade (zumbi incluído). A primeira versão saía `skipped`, e um
teste que às vezes pula não prova nada.

### Barge-in medido contra o NOMOS e o runtime reais

O invariante medido não é "cancelou". É **a resposta dada ao dono bater com a
trilha do runtime**:

```
   0..360 ms   CANCELADO   ->  0 acoes novas na trilha
 420..540 ms   EXECUTADO   ->  exatamente 1 acao na trilha
 INCOERENTES=0        POST_CANCEL_ACTIONS=0        PROCESS_RESIDUAL=0
```

Um `CANCELADO` com ação na trilha, ou um `EXECUTADO` sem ela, seriam mentira — e
é a mentira que o código ingênuo produzia.

Nota honesta: o ramo `too_late` **não** foi alcançado no E2E real; a transição
entre janela e execução é abrupta demais nesta máquina. Ele está coberto de
forma determinística no teste unitário, e isso está dito aqui em vez de ficar
escondido atrás do verde do E2E.

---

## 4. O manifesto legado — e por que revoguei mesmo com o exploit já barrado

```
LEGACY_TRUSTED_BEFORE=SIM
LEGACY_TRUST_EXPLOITABLE=NAO
LEGACY_BLOCKED_BY_LAYER=SERVIDOR (validacao de argumentos do codigo atual)
LEGACY_TRUST_REVOKED=YES
LEGACY_REFUSED_AFTER=YES
CURRENT_MANIFEST_UNHARMED=YES
LEGACY_TRUST_STATE=RESOLVED
```

Descoberta primeiro, sem alterar nada: o trust vive em
`~/.nomos/mcp_catalogo.json` (0600), `confiar` só **acrescenta**, e existe
revogação canônica — `cat.revogar()` na biblioteca, `nomos mcp revogar` no CLI,
com linha `mcp.revogado` numa trilha encadeada por hash. Editar o arquivo à mão
seria **mais fraco** (tirar de `confiaveis` só devolve o server a
`experimental`, que ainda conecta com "ACEITO O RISCO" num TTY) e sem rastro.

**Medir antes de decidir.** O manifesto antigo foi extraído do histórico
(`git show 78491cc:…`, não forjado) e posto **ao lado do `servidor.mjs`** — o
cenário de ataque de verdade. Com ele ainda confiável:

```
status=confiavel · conecta · browser_tabs=A0 · veredito do NOMOS=ALLOW
exploit historico (action=new + url): abas antes=2, depois=2
QUEM BARROU: o SERVIDOR, por validacao de argumento do codigo ATUAL
```

Esse é o achado. A camada de **manifesto** deu `A0` e `ALLOW`; quem segurou foi a
de **código**. Defesa de uma camada só — e um `git checkout` do `servidor.mjs`
daquele commit devolveria a metade que falta. Por isso revoguei. Catálogo: 3
confiáveis → 2, com 1 revogada.

**A lição é do mecanismo, não deste caso:** confiança por registro nunca expira
sozinha. Toda correção que muda a classificação de uma ferramenta deixa a
impressão anterior válida até alguém revogá-la. Revogação é parte do
procedimento de correção, não faxina posterior.

---

## 5. Números, medidos a partir do conteúdo da tag `v0.2.0`

```
ci.sh all ................ CI_PASS=YES
suite Node ............... TS_PASS=735  TS_FAIL=0  ARQUIVOS_OK=35
SDK Python ............... 31/31
suite da Gi .............. 148/148
E2E ...................... 20/20 cenarios · 213 checagens
adversarial .............. 53 vetores · OPEN_SECURITY_P1=0
plano de controle ........ 6/6 invariantes
clean room ............... 18 passos · 0 falhas
residuo de processo ...... 0
TRANSPORTE_REPETICOES .... 0  (com o daemon vivo; 11 classificadas como
                               "daemon ja derrubado" — ruido do proprio teste)
```

Nenhum contador foi reduzido para produzir verde. O da Gi **subiu**: 138 → 145
(+7 do barge-in) → 148, porque o dono editou `test_gi_f1_realtime.py` às 13:29,
fora das minhas mudanças. O piso da missão era ≥ 138.

`TAG_REVALIDATED=YES` na primeira tentativa, a partir de
`git clone --branch v0.2.0` — não da árvore de trabalho. O passo 3 do
revalidador confere que o clone não tem **nada** fora do versionado; se um dia
falhar, é porque a tag não descreve o que se está testando.

---

## 6. O limite que continua valendo

```
EXECUCAO_HEADLESS_A1_MAIS=IMPOSSIVEL_POR_DESENHO
```

`nomos mcp chamar` não tem `--panel`, e `interactive_approver` exige TTY. Uma
automação **headless** só executa ferramentas `A0`. Isso deixou de ser um
bloqueio para a release — esta versão provou que o caminho com o dono presente
funciona, é auditado e não é contornável — mas continua sendo um fato de
desenho: quem precisar de automação que navegue sozinha tem de saber disso, ou o
dono muda a política dele. `docs/LIMITATIONS.md`.

---

## 7. Máquina do dono

Serviços de produção ao fim da missão:

```
ai.sovereign.ollama          = 1003
ai.sovereign.omniroute       = 12728
com.nomos.panel              = 83034
com.gijarvis.backend         = 51446
com.gi.nomos.gateway         = 78103
br.com.se7enpay.nomos.servico = 69404   (era 83005)
```

O último trocou de PID **durante o freeze, e não fui eu**. A prova é a
monotonicidade dos PIDs: 69404 nasceu entre a minha sondagem de baseline (69323)
e a de ownership (69513); o meu `kill` só veio em 69778. O serviço tem
`KeepAlive`, e o log dele mostra um `No space left on device` de **ontem** 09:10
(hoje há 88 Gi livres). `nomos painel` (PID 69448) tem `PPID = zsh -l` — é o
terminal do dono, intocado.

`gi_nomos.device_voice_gateway` continua **sem supervisor** (`PPID=1`, nenhum
plist o referencia). Foi observado reiniciando às 12:33:04, também não por mim.
Se as ferramentas `navegador_*` estão vivas no caminho de voz, **não verifiquei**
— e não vou afirmar por inferência.

Consentimento nunca foi forjado: todo comando do NOMOS rodou com `stdin` em
`/dev/null`, exceto o único momento em que o dono digitou `APROVO` no terminal
dele.

---

## 8. Reprodução

```sh
cd /Users/AI/Projects/nomos-browser

# o gate humano (precisa de TTY e de uma pessoa)
bash evidence/nomos-browser-ga/01-gate-humano/gate-humano-a1.sh
# e o veredito, computado das trilhas:
python3 evidence/nomos-browser-ga/01-gate-humano/verificar-gate-a1.py <session_id>

# barge-in contra NOMOS e runtime reais
python3 evidence/nomos-browser-ga/02-bargein/bargein-real.py

# manifesto legado: medir e revogar
bash evidence/nomos-browser-ga/03-legado/medir-e-revogar.sh

# regressao integral
bash scripts/ci.sh all && bash scripts/run-suite.sh
( cd sdk-python && python3 -m unittest discover -s tests )
( cd /Users/AI/Projects/pocket-assistant/backend && python3 -m pytest -q )
node evidence/nomos-browser-final-loop/11-security/bateria-completa.ts
node evidence/nomos-browser-final-loop/19-e2e/e2e-final.ts

# revalidacao a partir do CONTEUDO da tag
TAG=v0.2.0 bash evidence/nomos-browser-final-100/09-tag/revalidar-na-tag.sh
```

---

## 9. Publicação

```
REMOTE_PUBLICATION=WAITING_FOR_OWNER
```

Não há remoto configurado e **não criei nenhum**. Isso não rebaixa a GA local: a
tag existe, foi revalidada a partir do próprio conteúdo, e o produto está
fechado. Quando houver um remoto autorizado, a checagem antes de publicar
(nome, visibilidade, branch default, ausência de segredos, `.gitignore`,
histórico, tags, README, LICENSE, SECURITY, instalação) está descrita em
`docs/RELEASE.md`.
