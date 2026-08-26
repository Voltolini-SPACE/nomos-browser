# NOMOS_BROWSER_PUBLIC_RELEASE — relatório final

Data: 2026-08-26 · missão `NOMOS_BROWSER_PUBLIC_RELEASE_1.0`

```text
REPO=github.com/Voltolini-SPACE/nomos-browser
BRANCH=main
HEAD=28bf1cb  (release tag em 91140e3; depois: matriz de CI, doc gerada, skips com motivo no runner limpo — CI da main VERDE em todos os estágios)
VERSION=0.4.0  (não 1.0: agente embutido + distribuição são minor — maturidade real, não nome de missão)
TAG=v0.4.0

FULL_REGRESSION=PASS            (824 testes · 42 arquivos · 0 falhas, no HEAD rebaseado)
CLEAN_ROOM=PASS                 (estado de usuário zerado; instalação só pela doc)
PUBLIC_ARTIFACT_INSTALL=PASS    (tarball → install.sh → serviço vivo; Ollama detectado sozinho)
COLD_START=PASS*                (stop → 0 processos → start pela CLI; *reboot físico não executado — máquina em uso; LaunchAgent RunAtLoad instalado e bootstrap verificado)
GI_CHAT=PASS                    (intenção → browser.task → plano do Ollama → execução real)
ASK=PASS                        (aprovação por passo com args exatos; clique em "pilares" → /#pilares)
AUTO=PASS                       (plano multi-etapas sem pergunta; A5 continuou perguntando — AUTO≠bypass)
SPOTLIGHT=PASS                  (função em página real + entrega verificada com ela ligada; flagrante fotográfico em task real segue não capturado — timing de captura remota, declarado)
PAUSE_RESUME=PASS               (task PAUSED com checkpoint; Retomar continua e conclui)
STOP=PASS                       (emergência no backend; task em voo morre negada)
TAKEOVER=PASS                   (CONTROL_HELD_BY_HUMAN até para observar; devolução reobserva)
AUDIT=PASS / REPLAY=PASS        (119 e 40 ações reconstruíveis nos dois E2E; replay sem alavanca)
SECURITY=PASS                   (suíte security/injection/exfiltração verde; guarda de exfiltração visto retendo conteúdo em uso real; secret scan = 0; npm audit = 0; permissões da extensão fixadas por teste)
PUBLIC_SOURCE_E2E=PASS          (uninstall --purge → download do RELEASE com SHA-256 conferido → install → Gi executa goto+scroll em AUTO → takeover → audit)

GITHUB=PASS                     (main 91140e3→f4934c1; tag v0.4.0; release com tarball, zip da extensão e SHA256SUMS)
WEBSITE=PASS                    (voltolini.space/browser/ atualizado: 0.4.0, painel da Gi, instalação de usuário, 824/42; publicado APÓS o release existir)
STORE_PACKAGE=READY             (zip + STORE_LISTING + PRIVACY + PERMISSIONS_JUSTIFICATION + SUPPORT em packaging/webstore/)
CHROME_WEB_STORE=WAITING_OWNER_PUBLISH_ACTION

PRODUCT_ENGINEERING_COMPLETE=YES
PUBLIC_RELEASE_COMPLETE=YES     (exceto o único ato exclusivo do dono acima)

STATUS_FINAL=PASS_100_PUBLIC_RELEASE_READY
```

## Auditoria de cada PASS (FASE 36 — reprodução)

| gate | comando de reprodução | controle negativo |
|---|---|---|
| Regressão | `npm test` (resumo em /tmp/nomos-reg-final na máquina do dono) | mutation controls já versionados na suíte (scan de segredos autoacusável, replay-verify, ui-build) |
| Artefato | `curl -L .../v0.4.0/nomos-browser-v0.4.0.tar.gz` + `shasum -c` | hash publicado; tarball vem de `git archive` com guarda de árvore suja (o 1º empacotamento sujo FALHOU e foi por isso que a guarda existe) |
| Instalação | `bash packaging/release/install.sh` | Node antigo/ausente → erro claro; Ollama ausente → aviso honesto, produto segue |
| E2E público | painel do artefato instalado dirigido como humano (registro nesta sessão + screenshots 15–16 em evidence/real-production-test/) | token forjado recusado; CONTROL_HELD_BY_HUMAN durante takeover |
| CI | `bash scripts/ci.sh fast` | a própria CI reprovou o push (matriz sem os 4 testes novos) e a correção só entrou depois de verde local |

## Defeitos achados POR ESTA missão (loop fechado)

1. Empacotador aceitava árvore suja → artefato mentiroso; agora recusa.
2. Matriz de CI sem os 4 testes novos → guarda `ci:cobertura-da-matriz` pegou no push; corrigido nos estágios certos.
3. `CONFIGURATION.generated.md` defasada (4 chaves novas) → regenerada.

## O único ato do dono

```text
WHAT_IS_BLOCKED=Chrome Web Store (publicação da extensão)
WHY_ONLY_OWNER_CAN_DO_IT=conta de desenvolvedor CWS (taxa única US$5) e consentimento de publicação são pessoais
EVERYTHING_ALREADY_COMPLETED=zip (no release), listing, privacidade, justificativa de permissões, suporte, screenshots reais
EXACT_OWNER_ACTION=chrome.google.com/webstore/devconsole → novo item → subir nomos-browser-extension-v0.4.0.zip → colar os textos de packaging/webstore/ → enviar para revisão
WHAT_TO_RUN_AFTER=nada no código; quando aprovada, trocar em docs a instrução de carga manual pela URL da loja
```

## Como qualquer pessoa usa hoje

github.com/Voltolini-SPACE/nomos-browser/releases → baixar → `bash
packaging/release/install.sh` → janela abre → ícone NOMOS → Cmd+V → conversar
com a Gi. Sem launch.ts, sem node na mão, sem variável, sem path de dev.
