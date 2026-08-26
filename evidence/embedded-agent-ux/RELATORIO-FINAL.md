# MISSÃO NOMOS_BROWSER_EMBEDDED_AGENT_UX — relatório final

Data: 2026-08-26 · branch `feature/embedded-agent-ux` · base rebasada sobre o
main vigente do fechamento paralelo.

## O que existe agora

O NOMOS Browser ganhou a experiência de agente embutido: `node
packages/extension/launch.ts` sobe o daemon com o Chromium do runtime já
carregando a extensão NOMOS (MV3, side panel). No painel: chat com a Gi,
AGORA (estado + feed operacional), ASK/AUTO, aprovação amarrada à ação,
abas do agente, Audit/Replay somente leitura, Pausar/Assumir/Parar. Na página:
moldura no alvo + selo "● NOMOS controlando" desenhados pelo runtime
(spotlight), sem content script e sem permissão de host em site nenhum.

## Gates da condição final

| gate | estado | evidência |
|---|---|---|
| ARCHITECTURE_DECIDED | **YES** | `docs/adr/NOMOS_BROWSER_EMBEDDED_AGENT_UX.md` (A=31 · B=19 · C=18) |
| PARALLEL_WORK_PRESERVED | **YES** | `00-freeze-coexistencia.md`; worktree isolado; zero toque no main; rebase sobre o main deles |
| SIDE_PANEL · EMBEDDED_CHAT · LIVE_ACTIVITY | **PASS** | `tests/extension-e2e.test.ts` (tabela de gates impressa pelo teste) |
| ASK_MODE · AUTO_MODE · APPROVAL_UI | **PASS** | idem — inclusive o aviso "mesmo em AUTO, ainda pergunto: …" vindo do runtime |
| ACTION_HIGHLIGHT | **PASS** | `tests/spotlight.test.ts` + clique entregue/verificado com spotlight ligado no E2E |
| STOP · PAUSE · TAKEOVER · OWNERSHIP | **PASS** | E2E; STOP encontrou e fechou defeito real (abaixo) |
| AUDIT_UI · REPLAY_UI | **PASS** | E2E; replay sem alavanca (0 controles que agem, contado) |
| TAB_CONTROL | **PASS** | E2E; abas do agente com posse declarada |
| SECURE_BRIDGE · EXTENSION_AUTH | **PASS** | E2E: token real conecta, token forjado é recusado e dito |
| MCP_GOVERNED | **PASS** | inalterado e re-testado: suíte `mcp` 36/36; fonte do pacote `mcp` continua proibido de conter "playwright" |
| GI_INTEGRATION | **PASS com limite declarado** | chat → `browser.task` pelo control plane (E2E); sem `ai_provider` o painel repete a recusa com honestidade; a Gi por voz segue o caminho já validado de `docs/GI-INTEGRATION.md` |
| REAL_CHROME_E2E | **PASS** | dois Chromium reais por teste; runtime com a extensão embarcada provado por argv do processo |
| ADVERSARIAL_TESTS | **PASS** | `tests/extension-adversarial.test.ts` — 5/5 (reload, aprovação stale, duas sessões, sessão morta, runtime morto) |
| CLEAN_ROOM | **PASS** | clone limpo da branch → `npm ci` (0 vulnerabilidades) → build do cofre → 19/19 testes de extensão (E2E incluso). Pré-requisitos da máquina, declarados: cofre de marca e navegadores Playwright — o mesmo padrão dos clean-rooms existentes |
| SECURITY_REVIEW | **PASS** | `docs/security/browser-extension.md`; scan de segredos = 0 no main vigente; npm audit = 0; permissões fixadas por teste |
| DOCUMENTATION | **PASS** | `docs/extension.md`, `docs/embedded-agent.md`, `docs/security/browser-extension.md`, ADR |
| CHROME_WEB_STORE_READY | material pronto, **não publicado** | `packaging/webstore/listing.md` |
| USER_CAN_INTERRUPT_AGENT | **YES** | STOP/PAUSE/TAKEOVER acima |
| REPLAY_CAUSES_REAL_ACTION | **NO** (correto) | ausência de alavanca, contada por asserção |
| EMBEDDED_AGENT_UX_READY | **YES** | tudo acima |

## Regressão

`scripts/run-suite.sh`: **41 arquivos · 819 pass · 0 fail** — inclui os novos
(`spotlight`, `extension-build`, `extension-e2e`) e toda a suíte pré-existente
sobre as mudanças de core.

## Defeito real encontrado e corrigido (crédito do E2E do painel)

`release` deixava a sessão em `RECOVERING`, e a **parada de emergência
falhava** com `transição inválida RECOVERING → PAUSED`. Um freio que depende
do estado do agente não é um freio. Corrigido em `ALLOWED_TRANSITIONS`
(`core/session.ts`), com o E2E como regressão permanente (sequência
pause→resume→takeover→release→stop).

## Performance (medida, com o instrumento declarado)

- Clique aprovado pelo painel com spotlight ligado: ~300 ms ida-e-volta no E2E.
- Card de aprovação no painel: até ~800 ms (cadência do poll de `/live` do
  painel — mesmo compromisso declarado do console, que usa 700 ms).
- Eventos WS chegam em milissegundos; a parada de emergência respondeu em
  <30 ms no E2E.
- Spotlight: dwell configurável (default 220 ms quando ligado); **default
  geral desligado** para não alterar as latências públicas já medidas.

## Mudanças em arquivos compartilhados (mínimas, por desenho)

| arquivo | mudança |
|---|---|
| `core/session.ts` | opção `extension_dir` + flags de launch; `RECOVERING → PAUSED` permitido |
| `api/config.ts` | chaves `extension_dir`, `spotlight`, `spotlight_dwell_ms`, `spotlight_color` |
| `api/daemon.ts` | 1 linha: repassa `extension_dir` |
| `api/handlers.ts` | import + `destacarAlvo()` + 2 chamadas (click/type) |
| `package-lock.json` | workspace novo `@nomos/browser-extension` (lock-only) |

`docs/_gerado/CONFIGURATION.generated.md` NÃO foi regenerado aqui de
propósito — ele estava em alteração paralela; regenerar é um comando no merge.

## O que fica declarado como limite

- Chrome de marca: instalação manual/CWS (side-loading por flag foi removido
  pelo Google) — documentado na ADR e em `docs/extension.md`.
- Chat conversacional pleno exige `ai_provider`; sem ele, recusa honesta.
- Seleção de elemento pelo usuário e espelho no painel: v2, registrados em
  `docs/embedded-agent.md`.
