# FASES 0 e 3 — freeze do RC e o manifesto legado

docs(evidence): FASE 0 e FASE 3 — freeze do RC e o manifesto legado resolvido

FASE 0 — freeze
  RC1_TAG_MATCH=YES            v0.2.0-rc.1 -> 95787cb
  WORKTREE_CLEAN=YES           (rastreados: 0 linhas)
  PRODUCTION_BASELINE_CAPTURED=YES

Dois achados que o freeze pegou, nenhum causado por mim:

1. CINCO shells MEUS, de missoes de ONTEM, em laco infinito. Eram
   `until grep -qE "^TS_PASS=" /tmp/suite_*.txt; do sleep 20; done` — e os
   arquivos existiam mas tinham ZERO linhas TS_PASS. Girariam para sempre.
   Ownership provado antes de tocar: PPID=52056 (app do Claude Code), inicio
   Aug 24 12:14-13:17, comando citando ~/Projects/nomos-browser/.suite.
   Encerrados.

   O incomodo de verdade: eles passavam despercebidos por TODOS os meus
   contadores de PROCESS_RESIDUAL, que so' olhavam daemon.ts, Chromium e
   servidor.mjs. `PROCESS_RESIDUAL=0` era verdade sobre o PRODUTO e falso
   sobre o ARNES. Fica registrado.

   Junto: 265 diretorios /tmp/nomos-sandbox-*, 9 clean rooms e clones, 956 MB
   de residuo de arquivo das minhas missoes. Apagados. Nao toquei em
   /tmp/claude-504, /tmp/nomos-panel-cdp nem nos venv_* — nao sao meus.

2. br.com.se7enpay.nomos.servico trocou de PID (83005 -> 69404) durante o
   freeze. NAO fui eu, e a prova e' a monotonicidade dos PIDs: 69404 nasceu
   entre a minha sondagem de baseline (69323) e a de ownership (69513); o meu
   kill so' veio em 69778. O servico tem KeepAlive e o log dele mostra o
   motivo — um `No space left on device` de ONTEM 09:10 (hoje ha 88 Gi
   livres) e dezenas de aprovacoes pendentes no painel.

   `nomos painel` (PID 69448) tem PPID = `zsh -l`: e' o terminal do DONO.
   Intocado.

FASE 3 — manifesto legado d267002f
  Descoberta primeiro, sem alterar nada: o trust vive em
  ~/.nomos/mcp_catalogo.json (0600), `confiar` so' ACRESCENTA, e existe
  revogacao canonica — `cat.revogar()` na biblioteca, `nomos mcp revogar` no
  CLI, com linha `mcp.revogado` na trilha encadeada por hash. Editar o
  arquivo a mao seria MAIS FRACO (tirar de `confiaveis` so' devolve o server
  a EXPERIMENTAL, que ainda conecta com "ACEITO O RISCO" num TTY) e sem
  rastro. Nao editei.

  MEDIR ANTES DE DECIDIR. O manifesto antigo foi extraido do historico
  (`git show 78491cc:...`, nao forjado) e posto AO LADO do servidor.mjs — o
  cenario de ataque de verdade. Com ele ainda confiavel:

    status=confiavel · conecta · browser_tabs=A0 · veredito do NOMOS=ALLOW
    exploit historico (action=new + url): abas antes=2 depois=2
    QUEM BARROU: o SERVIDOR, por validacao de argumento do codigo ATUAL

  Esse detalhe e' o achado. A camada de MANIFESTO teria deixado passar; quem
  segurou foi a de codigo. Defesa de UMA camada so' — e um checkout do
  servidor.mjs daquele commit devolve a metade que falta.

  Classificacao A (revogacao canonica possivel), executada:
    LEGACY_TRUST_REVOKED=YES      catalogo: 3 confiaveis -> 2, 1 revogada
    LEGACY_REFUSED_AFTER=YES      conectar, chamar e o exploit: recusados
                                  ANTES de qualquer execucao
    CURRENT_MANIFEST_UNHARMED=YES atual segue confiavel, 16 tools, executa
    LEGACY_TRUST_STATE=RESOLVED
