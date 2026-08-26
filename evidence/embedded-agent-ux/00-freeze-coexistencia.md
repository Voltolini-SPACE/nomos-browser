# FASE 0 — Freeze e coexistência com a janela paralela

Data: 2026-08-26 08:58 -03

## Estado observado (medido, não inferido)

| item | valor |
|---|---|
| repo canônico | `/Users/AI/Projects/nomos-browser` |
| remote | `https://github.com/Voltolini-SPACE/nomos-browser.git` |
| HEAD no momento do freeze | `f801629` — "evidencia: fechamento do lancamento publico" (2026-08-26 00:50 -03) |
| branch | `main` (única local) |
| worktrees pré-existentes | apenas o principal |
| tags | até `v0.3.2` |
| CI (últimos 5 runs em main) | **failure** — pertence ao fechamento da janela paralela; NÃO reaberto por esta missão |
| release pública | v0.3.x publicada, MIT, README de produto |

## Trabalho paralelo ativo (preservado)

Árvore do main SUJA com 11 arquivos modificados e não commitados:
`docs/_gerado/CONFIGURATION.generated.md`, `packages/{api,cli,core,mcp,observability,sdk,skills,ui}/package.json`,
`scripts/regressao-completa.sh`, `tests/policy-vault.test.ts`.

Múltiplos processos `claude` ativos na máquina + serviço da Gi
(`gi_nomos.device_voice_gateway` na :8765). Conclusão: fechamento paralelo em andamento, confirmado.

## Classificação de arquivos

| classe | arquivos |
|---|---|
| **proibidos temporariamente** (em alteração paralela) | os 11 acima + `README.md`, site `/browser/`, marketing, CI workflow |
| **compartilhados** (tocar só em branch, mudança mínima) | `packages/api/src/daemon.ts`, `packages/api/src/config.ts`, `packages/core/src/session.ts`, `packages/core/src/pointer.ts` |
| **seguros para esta missão** (novos) | `packages/extension/**`, `docs/adr/**`, `docs/extension.md`, `docs/embedded-agent.md`, `docs/security/browser-extension.md`, `evidence/embedded-agent-ux/**`, testes novos |

## Medida de isolamento

```
git worktree add -b feature/embedded-agent-ux \
  /Users/AI/Projects/nomos-browser-embedded-ux f801629
```

Toda a missão roda neste worktree. Nenhum comando desta missão tocou o worktree
principal, nenhum reset/revert/checkout foi executado no main, e os 11 arquivos
sujos permanecem exatamente como estavam.

```
PARALLEL_NOMOS_BROWSER_CLOSEOUT_ACTIVE=YES
DO_NOT_OVERWRITE_PARALLEL_WORK=YES
PARALLEL_WORK_PRESERVED=YES
```
