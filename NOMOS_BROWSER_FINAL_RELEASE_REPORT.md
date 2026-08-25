# NOMOS_BROWSER_FINAL_RELEASE_REPORT

```
DATE=2026-08-25
REPO=/Users/AI/Projects/nomos-browser
BRANCH=main
HEAD_INICIAL=6314050   (baseline declarado pela missao de closeout)
HEAD_FINAL=40bfa5aa6c9238e7b66b30b768338653b29aaa8b
VERSAO=0.1.0           (bump para 0.2.0-rc.1 preparado, NAO aplicado)
TAG=nenhuma            (a FASE 10 proibe criar tag antes dos gates anteriores)
REMOTES=nenhum         -> PUBLICATION_BLOCKED=NO_REMOTE
```

## VEREDITO

```
PRODUCT_FINALIZED=NO
BLOCKER=o manifesto MCP precisa ser reassinado pelo dono. A correcao de uma
        ELEVACAO DE PRIVILEGIO (P0) mudou o SHA-256 do manifesto, que E a
        confianca registrada em ~/.nomos/mcp_catalogo.json. O NOMOS voltou a
        trata-lo como experimental -- fail-closed, comportamento correto -- e
        recusa `conectar` e `chamar` ate a reassinatura.
COMANDO_QUE_DESTRAVA=/Users/AI/.local/bin/nomos mcp confiar \
                     /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json
IMPRESSAO_A_REGISTRAR=317f15893e9ebd83afa17d11f66dd896c83342858ad723e0f4ed7afd32e27207
IMPRESSAO_NO_CATALOGO=d267002feb6f9e4a...  (a de antes da correcao)
```

Este `NO` nao e um produto quebrado. E o oposto: o registro que o dono fez
**funcionou**, e foi ele que expos, na primeira hora de uso real, um furo que
nenhum teste sintetico tinha pego. Corrigir o furo custou a assinatura. Manter a
assinatura teria custado a seguranca.

## O QUE O CLI REAL ENCONTROU

A missao exigiu: *"Nao vale cliente reimplementado como prova final."* Foi essa
exigencia que achou os dois defeitos.

### 1. Elevacao de privilegio pela fronteira MCP (P0) — CORRIGIDO

`browser_tabs` estava declarada `A0_READ_LOCAL` e despachava **quatro** rotas,
entre elas `browser.new_tab`, que aceita `url` e sai para a rede. O manifesto
classifica por **ferramenta**, nunca por argumento — o rotulo "ler arquivos
locais" valia para o pior que a ferramenta sabia fazer.

Executado contra o NOMOS real, headless, sem aprovacao
(`evidence/nomos-browser-final-closeout/01-mcp/03-exploit-tabs.txt`):

```
A0 · ler arquivos locais · alvo=mcp:nomos-browser:browser_tabs
veredito: ALLOW — permitido pela politica
route=browser.new_tab http=200
{ "page_id": "pg_55c911...", "url": "http://127.0.0.1:8899/segredo",
  "title": "Alvo /segredo", "active": true }
```

Correcao: **uma ferramenta, uma rota, uma classe de risco.**

| ferramenta | rota | nivel |
|---|---|---|
| `browser_tabs` | `browser.tabs` (so listar) | `A0_READ_LOCAL` |
| `browser_tab_open` | `browser.new_tab` | `A2_NET_EGRESS` |
| `browser_tab_switch` | `browser.switch_tab` | `A1_WRITE_LOCAL` |
| `browser_tab_close` | `browser.close_tab` | `A1_WRITE_LOCAL` |

O exploit morre no argumento:
`browser_tabs: argumento(s) desconhecido(s): action, url. Aceitos: session_id`

**Guarda contra reincidencia** — vale mais que a correcao:
`scripts/verificar-risco-mcp.ts` classifica as 23 rotas do runtime em leitura,
mutacao e egresso, extrai de `tools.ts` o que cada ferramenta alcanca, e reprova
o manifesto quando uma `A0` puder mutar ou sair para a rede. Roda na CI.
Controle negativo: rebaixar `browser_tab_open` para `A0` produz
`MCP_RISK_COHERENT=NO` com `rc=1`; restaurar devolve o hash byte a byte.

### 2. Sessao nao sobrevivia ao modelo one-shot (P1) — CORRIGIDO

`nomos mcp chamar` sobe o servidor, chama e encerra. Duas chamadas seguidas
produziam duas sessoes (`SESSOES_VIVAS=2`), e `browser_extract` depois de abrir
uma aba devolvia `TARGET_NOT_FOUND` — sessao nova, `about:blank`. Pelo caminho
canonico o produto era **inutilizavel para trabalho de mais de um passo**, e
vazava Chromium por chamada. O cliente reimplementado nao pegou isso porque
mantinha um processo vivo.

Agora a sessao vive em `<runtime_dir>/mcp-session.json`, com escrita atomica e
trava contra corrida. Provado: `session_id` identico na primeira e na ultima
chamada de processos diferentes (`ses_47884e156ee9486b`).

## MATRIZ DOS GATES

| Gate | Estado | Numero medido | Evidencia |
|---|---|---|---|
| `ENTRY_STATE_VALID` | **YES** | 10 commits da missao anterior conferidos | `00-baseline/baseline.txt` |
| `MCP_OWNER_TRUST` | **FAIL** | catalogo tem `d267002f…`, manifesto e `317f1589…` | `00-baseline/mcp-catalogo.txt` |
| `NOMOS_DISCOVERY` | **PASS** | `nomos mcp catalogo` lista o servidor | `02-integracao/prova.log` |
| `NOMOS_HANDSHAKE` · `TOOLS_LIST` | **FAIL** | recusa `NOMOS-E002` (experimental) | idem |
| `NOMOS_SESSION_DURAVEL` | **FAIL** | bloqueado pelo mesmo motivo | idem |
| `NOMOS_NO_PRIVILEGE_ESCALATION` | **PASS** | exploit recusado no argumento | idem |
| `NOMOS_AUDIT` · `NOMOS_SEM_ORFAO` | **PASS** | 0 sessao e 0 Chromium residual | idem |
| `NOMOS_BROWSER_INTEGRATION` | **FAIL** | motivo: `BLOQUEADO_MANIFESTO_EXPERIMENTAL` | idem |
| `GI_BROWSER_DISCOVERY` | **FAIL** | `registrado_no_nomos=False` | `08-gi/` |
| `GI_BROWSER_ACTION` | **BLOQUEADO_POR_APROVACAO** | A2 para no gate, e a aba nao se move | idem |
| `GI_BROWSER_RESULT` · `VISION` | **PASS** | extracao e captura reais pela Gi | idem |
| `GI_BROWSER_INTEGRATION` | **PASS (16/17)** | so a descoberta reprova | idem |
| `CONTROL_PLANE_INVARIANTS` | **PASS** | **6/6**, cada um com controle positivo e negativo | `05-antibypass/anti-bypass.json` |
| `REGRESSION` | **PASS** | `ci.sh all` = `CI_PASS=YES` | `07-regressao/regressao.log` |
| suite Node | **PASS** | **735/735** em 35 arquivos, 0 MORTO | `07-regressao/suite/resumo.tsv` |
| suite Python | **PASS** | **31/31** | `07-regressao/regressao.log` |
| `BROWSER_E2E_SUITE` | **PASS** | **20/20**, 223 checagens | `19-e2e/out/e2e-final.json` |
| `SECURITY_SUITE` | **PASS** | 53 vetores, `OPEN_SECURITY_P1=0` | `11-security/` |
| `TASK_ENGINE` | **PASS** | 8/8 flags | `09-task/e2e-task.ts` |
| `AUDIT_COMPLETE` | **PASS** | 0 campos faltando | `06-audit/` (script original) |
| `CLEAN_ROOM_FINAL` | **PASS** | 18 passos, `ZERO_MANUAL_PATCHES=YES` | `08-cleanroom/clean-room.log` |
| `INSTALLATION_REPRODUCIBLE` | **YES** | a partir de `git clone`, sem copiar arquivo | idem |
| `REBOOT_SAFETY` | **SIMULATED** | `launchctl kickstart -k`; reboot real nao autorizado | `docs/LIMITATIONS.md` |
| `LIMITATION_DOCUMENTED` | **YES** | — | idem |
| `PROCESS_RESIDUAL` | **0** | daemons, Chromium e orfaos zerados | `07-regressao/regressao.log` |
| `OPEN_P0` | **0** | o P0 do closeout foi corrigido neste HEAD | — |
| `OPEN_P1` | **0** | idem | — |
| `PUBLICATION_BLOCKED` | **NO_REMOTE** | `git remote -v` vazio; nao inventei repositorio | — |

## COMMITS DESTE CLOSEOUT

```
40bfa5a docs: T11, limites do registro e clean room final
1e6baf7 test(e2e): supervisor separa 'nosso servico ja de pe' de 'daemon estranho no lock'
aae1900 docs(evidence): FASE 3 (Gi ativada) e FASE 4 (anti-bypass)
82c347c test(anti-bypass): seis invariantes, cada um com controle positivo e negativo
0ebfe30 fix(mcp): elevacao de privilegio pelo manifesto e sessao one-shot
```

## FORA DO REPOSITORIO — o que toquei no `pocket-assistant`

A FASE 3 autorizou aplicar a configuracao ja preparada e reiniciar o backend.
`pocket-assistant` **nao e repositorio git**; os backups estao em
`evidence/nomos-browser-final-closeout/`.

- `backend/gi_nomos/device_voice_gateway.py` — duas linhas de ativacao em
  `build_dispatcher()` e o anexo de `TOOLS_REALTIME`. Quatro capabilities novas:
  `navegador_ler`, `navegador_ver`, `navegador_abas`, `navegador_abrir`.
- `backend/test_gi_voice_tools.py` — o guarda `test_dispatcher_tem_oito_tools`
  virou `test_dispatcher_tem_o_conjunto_exato_de_tools`, com as 12 atuais. Segue
  sendo **igualdade exata**: guarda contra crescimento acidental de capability.
- `com.gijarvis.backend` reiniciado (PID 29108 -> 51446), no ar.
- **NAO reiniciei o gateway de voz** (`gi_nomos.device_voice_gateway`, PID
  43891): ele roda **orfao**, `PPID=1`, fora do launchd, e nenhum plist o
  referencia. Sem supervisor, reinicia-lo e derrubar o assistente do dono sem
  garantia de volta. As tools novas so chegam a voz depois que ele o reiniciar.

## O QUE ESTA MISSAO ERROU NO PROPRIO INSTRUMENTO

Seis medicoes minhas estavam erradas. Em **todas**, o produto estava certo.

1. o guarda de risco escreve o veredito de falha em `stderr`; eu lia so `stdout`,
   e o controle negativo parecia mudo;
2. nao existe rota HTTP de emissao de token (por desenho); o token restrito nasce
   do `AuthManager`, e o segredo mora em `.secret`, nao `.token`;
3. `lease.transfer` exige `to`, nao `to_holder` — com o nome errado a rota
   devolvia 400 e eu media a **ausencia** da transferencia;
4. procurar a URL do runtime no fonte da Gi era falso positivo: o modulo LE
   `NOMOS_BROWSER_URL` para REPASSAR ao subprocesso do conector;
5. o token de teste precisava do escopo `NAVIGATE` e do lease da sessao A — sem
   isso o controle POSITIVO media falta de escopo, nao a allowlist;
6. o cenario 20 do E2E reprovou porque um daemon **meu**, iniciado a mao para o
   trabalho de MCP, segurava o lock. O `service.sh start` devolveu
   `rc=9 ... instancia unica` — o guarda funcionando. O instrumento e que
   confundia "nosso servico ja de pe" com "intruso no lock"; agora ele le o lock
   e diz o nome do dono dele.

## PROXIMA ACAO

1. **Dono:** `nomos mcp confiar packaging/mcp/manifesto.json`
   (impressao `317f1589…`).
2. **Eu:** reexecutar `02-integracao/prova-nomos-real.sh` e `08-gi/e2e-gi.py`.
   Com o registro, os oito gates de integracao fecham pelo caminho canonico.
3. **Eu:** `ci.sh all` + E2E 20 + clean room sobre o HEAD final.
4. **Eu:** bump `0.1.0 -> 0.2.0-rc.1`, commit de release, tag anotada
   `v0.2.0-rc.1`, CI sobre a tag e clean room a partir da tag.
5. **Dono, quando quiser:** reiniciar o gateway de voz; escolher licenca
   (o `LICENSE` esta no estado legal padrao, com titular em placeholder
   explicito); congelar a marca; autorizar uma janela de reboot real.
