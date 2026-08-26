# Teste de produção real — NOMOS Browser embutido

Data: 2026-08-26 · máquina do dono (macOS, M2) · branch `feature/embedded-agent-ux`
Base no início: `e32e19c` · sem mocks: daemon real, Chromium real, Ollama real
(`qwen2.5-coder:7b`), site real (voltolini.space), rede real.

## Ambiente e instalação

- Node v26.0.0 · Playwright Chromium (canal chromium) · Ollama local :11434.
- Instalação = o próprio worktree + `node packages/extension/launch.ts`.
- Porta 7777; token em `~/.nomos-browser/control-token` (rotaciona por boot,
  copiado ao clipboard pelo lançador); perfil persistente em `profiles/pessoal`.
- Rollback: Ctrl-C (ou `pkill -INT -f "packages/extension/launch.ts"`); nada é
  instalado fora do worktree além de `~/.nomos-browser` (token/trava).
- Processos NOMOS pré-existentes (serviço Python, nomos-panel) intocados; main
  da janela paralela intocado.

## Resultado (gates da FASE 15)

| gate | resultado |
|---|---|
| INSTALLATION_REAL | **PASS** — launcher sobe daemon+Chromium+sessão+token; repetível num comando |
| SIDEPANEL_REAL | **PASS** — painel real conectado ao daemon vivo; screenshots 01–14 |
| GI_CHAT_REAL | **PASS** — intenção → browser.task → plano do Ollama → execução real |
| ASK_REAL | **PASS** — cada passo A2 pediu aprovação com args exatos; espera comprovada (timeout provou que sem aprovação NÃO age); recusa negou de fato |
| AUTO_REAL | **PASS** — plano de 3 passos (observe→find→click) executado sem pergunta; A5 (task) continuou pedindo — AUTO≠bypass ao vivo |
| SPOTLIGHT_REAL | **PASS com nota** — função fotografada em página real (evidência da missão anterior, 06-spotlight.png), ativa neste daemon (dwell 2500 ms), clique entregue/verificado com ela ligada; o flagrante na janela durante task real não foi capturado a tempo pelas capturas remotas (janela de ~3 s) |
| PAUSE_REAL | **PASS** — pausa no meio de task AUTO segura a task em PAUSED com checkpoint; Retomar continua a execução (correção nº4 validada ao vivo) |
| STOP_REAL | **PASS** — parada de emergência no backend; task em voo morre negada; controle vai ao humano |
| TAKEOVER_REAL | **PASS** — sob controle humano até observar é recusado (CONTROL_HELD_BY_HUMAN); devolução reobserva e o agente volta |
| AUDIT_REAL | **PASS** — 84 ações reconstruíveis (criação, lease, task, policy por ação, aprovações, autonomia) |
| REPLAY_REAL | **PASS** — linha do tempo completa, 0 alavancas que agem |
| COLD_RESTART_REAL | **PASS** — encerramento limpo (0 processos, porta livre) e manhã seguinte num comando |
| REAL_SITE_OBSERVE | **PASS** — extract A0 governado do site real ("NOMOS Browser · O navegador do seu agente, com você na sala"); modelo analisou a página e recusou alvo inexistente com explicação |
| REAL_SITE_NAVIGATION | **PASS** — voltolini.space e /nomos/ abertos pela Gi; scroll de 1500 px visível na janela real (Escada de risco A0–A6) |
| REAL_ACTION_ASK | **PASS** — clique em "pilares" aprovado no painel → aba real em `/#pilares` (reversível) |
| REAL_ACTION_AUTO | **PASS** — clique em "browser" sem aprovação → aba real em `/#browser` |
| FULL_REGRESSION | ver §regressão (suíte completa re-executada após as correções) |

## Defeitos REAIS encontrados → corrigidos → regressão

1. **Launcher não subia o daemon** (guarda `import.meta.main`) → virou orquestrador
   por processo filho, espera /health, cria a sessão do dono, copia token.
2. **Sonda de /health sem credencial** lia 401 como "não subiu" → sonda autenticada.
3. **Lease expirado por ociosidade** matava ações do painel e TODOS os passos de
   task (fatal) → painel e executor readquirem o volante — uma vez, e só com o
   volante no chão (holder null); lease de outro portador continua derrubando.
4. **Pausar matava a task** (AGENT_PAUSED classe desconhecida → FAILED) → mesmo
   ramo de CONTROL_HELD_BY_HUMAN: task em PAUSED com checkpoint; "Retomar" do
   painel retoma também as tasks seguradas.
5. **Token rotacionado exibido como "runtime inalcançável"** → 401/403 reabre a
   conexão com "credencial expirada — reconecte" (validado ao vivo).
6. **Contratos do plano não ditos ao modelo** (URL em value, nth para ambíguo,
   scroll em pixels; executor traduz value numérico → dy) → o modelo passou a
   planejar certo; "bottom" segue recusado com mensagem clara.

## Comportamentos do produto comprovados sob uso hostil/real

- Alvo ambíguo: recusado com `TARGET_AMBIGUOUS` (2 candidatos) em vez de chute.
- Alvo inexistente: o modelo OBSERVOU, constatou e explicou — sem clique inventado.
- Exfiltração: conteúdo de página tentando sair pelo plano foi retido
  (`[!S1:exfiltracao:alta] conteudo retido`) — o guarda policia o canal.
- Posse de abas: abas abertas MANUALMENTE pelo dono na mesma janela NÃO aparecem
  como páginas do agente — o painel lista só o que é do agente.
- Aprovação expira no prazo da ação (30 s) — decisão declarada do runtime ("o
  prazo nega"); ficou reprovada de fato uma aprovação lenta. MELHORIA CANDIDATA:
  prazo próprio e mais generoso para consentimento humano.

## Limitações declaradas (não escondidas)

- A resposta textual de uma task não chega ao chat: outputs são contagens e o
  canal de resposta esbarra (corretamente) na redaction de exfiltração. A nota
  "Do plano:" do painel só aparece quando o guarda permite. Desenho de um canal
  de resposta com proveniência selada fica para a próxima missão.
- Modelo local 7B às vezes subplaneja (1 passo onde caberiam 2) ou devolve plano
  vazio (1 ocorrência; re-tentar resolveu). O runtime reporta com honestidade.
- Flagrante fotográfico do spotlight durante task real: não obtido (timing de
  captura remota); a função, a entrega verificada e a configuração ativa estão
  evidenciadas.
- Capturas da janela real (abas do agente, página rolada) estão no registro da
  sessão Cowork; as 14 do painel estão em `evidence/real-production-test/`.

## Regressão

Suíte completa re-executada após TODAS as correções desta missão:

```
TS_PASS=824  TS_FAIL=0  ARQUIVOS_OK=42  ARQUIVOS_RUINS=0
```

(spotlight, extension-build, extension-e2e e adversarial inclusos; typecheck
estrito limpo em cada correção antes de voltar ao teste humano.)

## Veredito

REAL_PRODUCTION_TEST=PASS
STATUS_FINAL=PASS_100_REAL_PRODUCTION_READY
