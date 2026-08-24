# Rastreabilidade — requisito → artefato → teste

## A inconsistência "55 fases" vs "FASE 67"

**Origem: erro meu, no relatório final do PRODUCT-01.**

O documento da missão PRODUCT-01 tem **seções numeradas de 0 a 67**. Dessas, as
que carregam o rótulo `FASE N` vão de `FASE 0` a `FASE 55` (seções 4 a 59). As
seções 60–67 são de outra natureza — critérios de aceite, definição de robustez,
regras, proibições, rollback, resultado esperado, visão de produto, e a última:

> **67. PRIMEIRO GATE EXECUTÁVEL**

Eu chamei a seção 67 de "FASE 67". Ela nunca foi uma fase; é o gate de aceitação.
E ao mesmo tempo escrevi "a missão tem 55 fases", que está certo. As duas frases
juntas produziram a contradição.

**Correção adotada:** o gate passa a se chamar `GATE-E2E-01`. As evidências
antigas **não** foram renumeradas — a tabela abaixo mapeia o nome legado para o
atual, para que nenhum registro anterior fique órfão.

| Nome legado | Nome atual | Onde aparece |
|---|---|---|
| `FASE 67` | `GATE-E2E-01` | `tests/e2e-gate.test.ts`, `docs/EVIDENCIA.md` |
| "55 fases" | 56 fases (`FASE 0`–`FASE 55`) | relatório PRODUCT-01 |

O arquivo `tests/e2e-gate.test.ts` mantém o cabeçalho histórico com nota de
equivalência. Reescrever o passado para parecer coerente seria pior que a
inconsistência.

---

## Mapa requisito → artefato → teste

`STATUS` usa a classificação da missão: **OBSERVADO** (aconteceu, com saída),
**MEDIDO** (tem número), **REPRODUZIDO** (reexecutado com mesmo resultado).
`—` significa não implementado.

### PRODUCT-01

| Fase | Requisito | Artefato | Teste | Status |
|---|---|---|---|---|
| 0 | Inventário e checkpoint | `checkpoints/capture.sh` | `checkpoints/*.json` | REPRODUZIDO |
| 1 | Spike de controle real | `spike/fase1_spike.ts` | `spike/fase1_spike.ts` | REPRODUZIDO |
| 2 | Daemon | `packages/api/src/daemon.ts` | `tests/api.test.ts` | REPRODUZIDO |
| 3 | Session manager | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 4 | API REST v1 | `packages/api/src/router.ts`, `packages/api/src/handlers.ts` | `tests/api.test.ts` | REPRODUZIDO |
| 5 | WebSocket / event bus | `packages/observability/src/eventbus.ts` | `tests/observability.test.ts` | REPRODUZIDO |
| 6 | MCP server | `packages/mcp/src/server.ts` | `tests/mcp.test.ts` | REPRODUZIDO |
| 7 | SDK TypeScript | `packages/sdk/src/index.ts` | `tests/sdk-ts.test.ts` | REPRODUZIDO |
| 8 | SDK Python | `sdk-python/nomos_browser/` | `sdk-python/tests/` | REPRODUZIDO |
| 9 | CLI | `packages/cli/src/main.ts` | `tests/cli.test.ts` | REPRODUZIDO |
| 10 | Pointer engine | `packages/core/src/pointer.ts` | `tests/pointer-keyboard.test.ts` | REPRODUZIDO |
| 11 | Keyboard engine | `packages/core/src/keyboard.ts` | `tests/pointer-keyboard.test.ts` | REPRODUZIDO |
| 12 | Perception engine | `packages/core/src/perception.ts` | `tests/perception.test.ts` | REPRODUZIDO |
| 13 | Target resolution | `packages/core/src/target.ts` | `tests/target-verifier.test.ts` | REPRODUZIDO |
| 14 | Action verifier | `packages/core/src/verifier.ts` | `tests/target-verifier.test.ts` | REPRODUZIDO |
| 15 | Self-healing | `packages/core/src/target.ts` | `tests/target-verifier.test.ts` | REPRODUZIDO |
| 16 | Web skills `.nomosskill` | `packages/skills/src/schema.ts` | `tests/skills.test.ts` | REPRODUZIDO |
| 17 | Profile manager | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 18 | Vault | `packages/core/src/vault.ts` | `tests/policy-vault.test.ts` | REPRODUZIDO |
| 19 | Capability / policy | `packages/core/src/policy.ts` | `tests/policy-vault.test.ts` | REPRODUZIDO |
| 20 | Driver nativo | — | — | — |
| 21 | Download manager | `packages/api/src/handlers.ts`, `packages/core/src/policy.ts` | `tests/policy-vault.test.ts` | OBSERVADO |
| 22 | Upload manager | `packages/core/src/policy.ts` | `tests/policy-vault.test.ts` | OBSERVADO |
| 23 | Network observability | `packages/core/src/perception.ts`, `packages/observability/src/redact.ts` | `tests/perception.test.ts` | REPRODUZIDO |
| 24 | Audit log | `packages/observability/src/audit.ts` | `tests/observability.test.ts` | REPRODUZIDO |
| 25 | Replay | `packages/observability/src/replay.ts` | `tests/observability.test.ts`, `tests/e2e-gate.test.ts` | REPRODUZIDO |
| 26 | Crash recovery | — | — | — |
| 27 | Worker pool | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 28 | Multiagent handoff | `packages/core/src/session.ts` | `tests/e2e-gate.test.ts` | REPRODUZIDO |
| 29 | Swarm | — | — | — |
| 30–32 | NOMOS Web, cursor, takeover | `packages/ui/` | `tests/ui-build.test.ts` + visual | OBSERVADO |
| 33–35 | Task engine | `packages/api/src/handlers.ts` | `tests/api.test.ts` | OBSERVADO |
| 36–37 | Integração NOMOS / 2ª IA | — | — | — |
| 38–39 | Benchmark / adversariais | — | — | — |
| 40 | Segurança / threat model | `docs/SECURITY.md`, `packages/core/src/policy.ts` | `tests/policy-vault.test.ts` | REPRODUZIDO |
| 41 | Isolamento entre sessões | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 42 | Performance baseline | — | — | — |
| 43 | Backpressure | `packages/api/src/daemon.ts` | `tests/session.test.ts`, `tests/api.test.ts` | REPRODUZIDO |
| 44 | Watchdog | — | — | — |
| 45 | Configuração | `packages/api/src/config.ts` | `tests/api.test.ts` | REPRODUZIDO |
| 46 | Versionamento | `packages/core/src/contract.ts` | `tests/api.test.ts` | REPRODUZIDO |
| 47 | Documentação | `docs/` | `tests/ui-build.test.ts` (marca) | OBSERVADO |
| 48–52 | Demos E2E | — | — | — |
| 53 | NOMOS Web visual | `packages/ui/` | verificação visual | OBSERVADO |
| 54 | CI anti-regressão | — | — | — |
| 55 | Clean room | — | — | — |
| `GATE-E2E-01` | Primeiro gate executável | `tests/e2e-gate.test.ts` | 12 testes | REPRODUZIDO |

### PRODUCT-02

Preenchido à medida que cada fase produz evidência. Fase sem teste correspondente
permanece `—`, nunca "implementado".

| Fase | Requisito | Artefato | Teste | Status |
|---|---|---|---|---|
| 0 | Revalidação do estado de entrada | `checkpoints/entry-product-02.json` | `tests/e2e-gate.test.ts` | REPRODUZIDO |
| 1 | Rastreabilidade | `docs/RASTREABILIDADE.md` | `tests/traceability.test.ts` | REPRODUZIDO |
