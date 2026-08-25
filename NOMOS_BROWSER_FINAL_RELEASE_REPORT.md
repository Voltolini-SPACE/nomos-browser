# NOMOS Browser — Relatório final de fechamento

```
PRODUCT_FINALIZED=YES
VERSAO=0.2.0-rc.1
TAG=v0.2.0-rc.1  ->  95787cbf538eb82b6d30f20bda8f4e3feda12ba2
REMOTES=[]        PUBLICATION_BLOCKED=NO_REMOTE  (não bloqueia; não criei remoto)
BASELINE_HEAD=6314050   ->   HEAD_FINAL=95787cb
```

Gerado em 2026-08-25. Substitui a versão anterior, que fechava com
`PRODUCT_FINALIZED=NO` e o bloqueio externo da reassinatura do manifesto.
A anterior está preservada em `evidence/nomos-browser-final-100/00-relatorio-anterior.md`.

---

## 1. O bloqueio externo caiu — e o que ele revelou

O dono registrou o manifesto MCP. A impressão `317f1589…` entrou no catálogo, e
com ela abriu-se um ramo de código que **nunca havia executado**: o do manifesto
confiável. Dois defeitos moravam ali.

Vale registrar o padrão, porque é o achado mais transferível desta missão:
**os dois defeitos estavam no caminho FELIZ**. Enquanto o manifesto esteve
experimental, tudo saía verde — porque o ramo do sucesso não rodava. Eles
apareceram na primeira hora do primeiro uso real.

### P2 · `scripts/nomos-register.sh` morria ao dizer "já registrado"

```
prova-nomos-real.sh: line 150: CURTA…: unbound variable
```

`$CURTA…` — o `…` (U+2026) é multibyte, o bash não encerra o nome da variável
ali, e sob `set -u` o script aborta. A mesma linha existia no produto
(`scripts/nomos-register.sh:109`) e no instrumento. Corrigidas as duas.

Guarda novo: `scripts/verificar-shell-expansao.ts`, estático, com autoteste
próprio (controle negativo injeta a linha ruim e exige `rc=1`; controle positivo
exige que `${VAR}…` **não** seja acusada). No `ci.sh`, estágio `security`.

### P1 · O barge-in da Gi sumia exatamente ao entrar em produção

`gi_nomos.browser.executar` tem duas portas. A do manifesto experimental honrava
`cancelar`. A do manifesto **registrado** usava `subprocess.run(...)`, que
bloqueia até o fim e ignora o evento. Quer dizer: a Gi continuaria navegando
depois de o dono mandar parar — e só em produção.

Corrigido com `Popen` + `start_new_session` + conferência a cada 0,2 s.
O `start_new_session` não é detalhe: `nomos mcp chamar` gera `node servidor.mjs`,
e matar só o pai deixaria o neto segurando a sessão do runtime.

**Teste de mutação executado**: com o `subprocess.run` de volta, 3 dos 4 casos
novos falham — e o que passa é exatamente o controle negativo (sem `cancelar`,
o comportamento não pode mudar). Com a correção, 4/4.

---

## 2. Os doze gates

| Gate | Veredito | Medida | Evidência |
|---|---|---|---|
| `MCP_OWNER_TRUST` | **PASS** | `317f1589…` recomputada pela biblioteca do próprio NOMOS | `01-mcp-trust/04-impressao.txt` |
| `NOMOS_DISCOVERY` | **PASS** | catálogo lista `✓ nomos-browser` | `01-mcp-trust/01-catalogo.txt` |
| `NOMOS_HANDSHAKE` | **PASS** | `conectado a 'nomos-browser' [✓ confiável]` | `01-mcp-trust/08-conectar.txt` |
| `TOOLS_LIST` | **PASS** | 16 tools; as quatro de aba separadas (A0/A2/A1/A1) | `01-mcp-trust/08-conectar.txt` |
| `NOMOS_BROWSER_INTEGRATION` | **PASS** | 11/11 gates pelo caminho canônico | `02-integracao/prova-canonica.txt` |
| `GI_BROWSER_INTEGRATION` | **PASS** | 18/18 casos, `registrado_no_nomos=True` | `03-gi/e2e-gi.txt` |
| `CONTROL_PLANE_INVARIANTS` | **PASS** | 6/6 invariantes | `04-antibypass/anti-bypass.txt` |
| `REGRESSAO_TOTAL` | **PASS** | ver §3 | `05-regressao/` |
| `PROCESS_RESIDUAL` | **0** | nove categorias, todas zeradas | `06-residuo/residuo-final.txt` |
| `CLEAN_ROOM_FINAL` | **PASS** | 18 passos, 0 falhas, `MCP_CLEAN_ROOM=PASS` | `07-cleanroom/clean-room.txt` |
| `VERSION_COHERENT` | **YES** | `0.2.0-rc.1` em 13 declarantes | `08-versao/01-guarda-versao.txt` |
| `TAG_REVALIDATED` | **YES** | tudo reexecutado do conteúdo da tag | `09-tag/revalidacao.txt` |

Todos em `evidence/nomos-browser-final-100/`.

---

## 3. Números, medidos a partir do conteúdo da tag

```
ci.sh all ................ CI_PASS=YES        (9 estágios)
suite Node ............... TS_PASS=735  TS_FAIL=0  ARQUIVOS_OK=35
SDK Python ............... 31/31
suite da Gi .............. 138/138
E2E ...................... 20/20 cenários · 213 checagens
adversarial .............. 53 vetores · OPEN_SECURITY_P1=0
plano de controle ........ 6/6
integração NOMOS ......... 11/11
integração Gi ............ 18/18
clean room ............... 18 passos · 0 falhas
resíduo de processo ...... 0
TRANSPORTE_REPETICOES .... 0  (com o daemon vivo — ver §6)
```

**Correção de um número do relatório anterior.** Ele dizia *223 checagens* no
E2E. Reabri o `e2e-final.json` **commitado em `1e6baf7`** e contei: eram **213**
já naquele run. Não houve regressão de cobertura — o número estava errado no
relatório. O certo é 213.

---

## 4. O teto que existe, medido e não contornado

```
EXECUCAO_CANONICA_A1_MAIS=BLOQUEADO_SEM_APROVADOR_NAO_TTY
```

Pelo caminho canônico `nomos mcp chamar`, **só ferramentas `A0` executam sem o
dono presente**. Não é suposição — vem de três fontes independentes, gravadas:

1. `nomos mcp chamar --help` → só `-h` e `--args`;
2. `cli.py` declara `--panel` em 17 subcomandos, e `chamar` não é um deles;
3. `_approver_for()` cai em `interactive_approver`, que devolve `False` sem TTY,
   e `gate()` sem aprovador é fail-closed.

As **onze** ferramentas `A1+` foram tentadas pelo caminho canônico e **todas**
foram negadas. Esse é o gate `NOMOS_FAIL_CLOSED_A1_MAIS`, e ele é **PASS**: o
teto é real e uniforme. O que falta não é o produto funcionar — é alguém
digitar `APROVO`. Não digitei, e não há como digitar sem forjar consentimento.

É por isso que a versão é `rc.1` e não `0.2.0`.

Para o dono fechar isso no terminal dele:

```sh
cd /Users/AI/Projects/nomos-browser
NOMOS_BROWSER_ALLOW_INTERNAL=true node packages/api/src/daemon.ts &
nomos mcp chamar packaging/mcp/manifesto.json browser_navigate \
  --args '{"url":"http://127.0.0.1:8902/segredo"}'
# o NOMOS pergunta; digite APROVO
```

---

## 5. Achados registrados que **não** corrigi, e por quê

### A impressão antiga continua confiável

O catálogo confia por impressão e `confiar` só **acrescenta**. Depois da
correção da elevação de privilégio, `nomos-browser` aparece **duas vezes**:

```
✓ nomos-browser  [317f15893e9ebd83…]   ← 16 tools, corrigido
✓ nomos-browser  [d267002feb6f9e4a…]   ← 13 tools, COM a elevação de privilégio
```

Que `d267002f…` é o manifesto vulnerável não é dedução: recomputei a impressão
de **cada versão do arquivo no histórico** — `78491cc` dá exatamente esse hash,
com 13 tools (`01-mcp-trust/05-origem-hash-antigo.txt`). Quem apresentar aquele
arquivo, que segue no histórico do git, obtém confiança para ele.

Não revoguei. `nomos mcp revogar` é bloqueio **duro** — o próprio NOMOS avisa
que não confia de novo "nem que reapareça idêntico", e desfazer exige editar a
lista de revogações à mão. É decisão do dono:

```sh
git show 78491cc:packaging/mcp/manifesto.json > /tmp/manifesto-antigo.json
nomos mcp revogar /tmp/manifesto-antigo.json
```

### Gateway de voz

```
VOICE_GATEWAY_NEW_TOOLS_PENDING_RESTART=OBSERVADO_REINICIO_NAO_MEU
VOICE_GATEWAY_SUPERVISION_REQUIRED=YES
```

`gi_nomos.device_voice_gateway` (PID 35643, `PPID=1`) foi observado **reiniciado
às 12:33:04**, dentro da janela desta missão. **Não fui eu** — a instrução era
explícita e a cumpri. O arquivo `device_voice_gateway.py` também foi modificado
às 12:26, e também não por mim (nesta sessão toquei apenas `gi_nomos/browser.py`
e acrescentei um arquivo de teste). Conferi, só lendo, que a integração do
navegador continua no lugar (`from .browser import TOOLS_REALTIME`, linhas
124–125 e 507) e que `test_gi_voice_tools.py` segue 37/37.

Se as ferramentas novas estão de fato vivas no caminho de voz, **não verifiquei**
— e não vou afirmar por inferência. Nenhum plist referencia esse processo: ele
continua sem supervisor, e um reinício continua sendo manual e sem rede.

---

## 6. Erros de instrumento desta missão

Ficam no registro. Nenhum foi apagado nem reescrito.

| # | Erro | Como apareceu | Correção |
|---|---|---|---|
| 1 | `$CURTA…` no `prova-nomos-real.sh` | matou a prova no ramo que só ficou verde agora | `${CURTA}…` + guarda estático com autoteste |
| 2 | Sem `trap` no alvo HTTP da prova | a morte do item 1 deixou `:8901` presa; o run seguinte caiu com `EADDRINUSE` | `trap ... EXIT INT TERM` |
| 3 | `approvals testar A2` | categoria inexistente ⇒ `DENY` por engano meu, não do NOMOS | `A2_NET_EGRESS` |
| 4 | Padrão de erro estreito demais | o server dizia `"target.selector" deve ser string` e o grep não pegava | padrão ampliado |
| 5 | `len(tools) == 13` no `e2e-gi.py` | 13 era a contagem do manifesto **vulnerável** | 16, mais as asserções de `A1` |
| 6 | `TypeError: fetch failed` sem causa | reprovou a **primeira** tag e não deu para diagnosticar | causa + sonda de `/health` + repetição visível |
| 7 | Contador de repetições sem classe | saiu `TRANSPORTE_REPETICOES=11` num run verde | separado em "daemon vivo" (0 exigido) e "daemon já derrubado" (ruído do teste) |

Sobre o item 6, uma admissão que não dá para maquiar: **a causa daquela falha
continua desconhecida.** Levantei a hipótese do `keepAliveTimeout` (o daemon não
define nenhum; o default do Node é 5 s) e a **refutei** com sonda dirigida — 30
pares de requisições com pausas varridas em 3,9/4,0/4,1/4,9/5,0/5,1 s, nas duas
janelas suspeitas: **0 falhas** (`10-keepalive/`). Por isso **não** mexi no
daemon: mudar `keepAliveTimeout` sem prova seria a forma educada de esconder que
não sei a causa. O que fiz foi garantir que a próxima ocorrência seja
diagnosticável e impossível de confundir com ruído.

Sobre o item 7: a separação importa porque as onze repetições eram **todas**
contra daemons que a própria bateria havia derrubado (limpeza depois do SIGKILL
dos cenários 13 e 19, portas que o cenário 18 fecha de propósito) — nenhuma
dizia coisa alguma sobre o produto. Somadas num número só, diziam pior que nada:
escondiam o único número que importa. A revalidação da tag agora **exige**
`TRANSPORTE_REPETICOES=0`.

A tag foi cortada três vezes. `4f6a432` e `70fe2c6` foram **descartadas** — a
primeira reprovou na própria revalidação, a segunda saiu verde com onze
repetições que eu não estava disposto a chamar de ruído sem olhar. Uma tag que
não sobrevive à própria revalidação não descreve nada que se publique. Nenhuma
delas saiu desta máquina.

---

## 7. Guardas novos

| Guarda | O que impede | Autoteste |
|---|---|---|
| `shell:expansao-nao-colada-em-nao-ascii` | `$VAR…` matando script sob `set -u` | injeta a linha ruim e exige `rc=1`; e exige que a forma correta não seja acusada |
| `versao:coerente-em-todo-o-produto` | a versão em 13 lugares sem nada obrigá-los a concordar | deriva um declarante num clone temporário e exige `rc=1` |

Sobre o segundo: `tests/mcp.test.ts` assertava `pkg.version === "0.1.0"` — um
literal. Isso era armadilha, não guarda: o teste que deveria pegar a deriva era
justamente o que precisava ser editado a cada bump, e editar um teste para ele
voltar a passar é como o defeito entraria. Agora assevera **coerência**.

---

## 8. Máquina do dono

Serviços de produção com os **mesmos PIDs** do início ao fim:

```
br.com.se7enpay.nomos.servico = 83005
com.nomos.panel               = 83034
ai.sovereign.omniroute        = 12728
com.gijarvis.backend          = 51446
ai.sovereign.ollama           = 1003
```

`com.gi.nomos.gateway` (`gi-whatsapp-epistemos-01/gateway/gateway.py`) é serviço
legítimo do dono, com plist e `KeepAlive`, ativo desde antes desta sessão. O
launchd o reiniciou por conta própria (86909 → 78103); não o toquei. Não é
daemon estranho — e não é o gateway de **voz**, que é outro processo.

Consentimento nunca foi forjado: todo comando do NOMOS rodou com `stdin` em
`/dev/null`, e nenhum prompt de aprovação foi respondido no lugar do dono.

---

## 9. O que falta para `0.2.0` final

1. **O dono**: uma execução `A1+` pelo caminho canônico, com `APROVO` digitado
   no terminal dele. Comando na §4.
2. **O dono**: decidir sobre `d267002f…` (§5). Comando lá.
3. **O dono**: se quiser publicar, criar o remoto — `PUBLICATION_BLOCKED=NO_REMOTE`
   é escolha registrada, não impedimento. Não criei remoto por conta própria.
4. **Aberto**: a causa do item 6 da §6. O instrumento agora a captura se voltar.
