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

**Atualização 2026-08-25.** O título da seção correspondente em
`docs/EVIDENCIA.md` passou a ser `GATE-E2E-01`, com `FASE 67` registrado logo
abaixo como *nome legado*. O nome antigo continua no arquivo — a mudança foi de
qual nome vem primeiro, não de apagar o outro.

**`PRODUCT-01` e `PRODUCT-02` não são branding legado.** São os nomes das duas
missões, e continuam sendo os rótulos corretos para o trabalho de cada uma. As
fases da terceira rodada aparecem como `L-*` (FINAL_LOOP) para não colidir com a
numeração das duas primeiras.

---

## Mapa requisito → artefato → teste

Revisado em **2026-08-25**, HEAD `78491cc`, contra a suíte medida no mesmo dia
(`TS_PASS=696 TS_FAIL=0` em 33 arquivos —
`evidence/nomos-browser-final-loop/18-docs/resumo.tsv`).

`STATUS` usa a classificação da missão: **OBSERVADO** (aconteceu, com saída),
**MEDIDO** (tem número), **REPRODUZIDO** (reexecutado com mesmo resultado).
`—` significa não implementado.

**Nenhuma linha foi removida nesta revisão.** Linha que continua sem
implementação continua com `—`, e apagar uma delas para a tabela parecer melhor
seria o defeito que este arquivo existe para impedir.

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
| 20 | Driver nativo | `docs/DECISAO-DRIVER-NATIVO.md` | — | OBSERVADO |
| 21 | Download manager | `packages/core/src/filepolicy.ts`, `packages/api/src/handlers.ts` | `tests/security-files-secrets.test.ts` | REPRODUZIDO |
| 22 | Upload manager | `packages/core/src/filepolicy.ts` | `tests/security-files-secrets.test.ts` | REPRODUZIDO |
| 23 | Network observability | `packages/core/src/perception.ts`, `packages/observability/src/redact.ts` | `tests/perception.test.ts` | REPRODUZIDO |
| 24 | Audit log | `packages/observability/src/audit.ts`, `packages/core/src/contract.ts` | `tests/audit-forense.test.ts`, `tests/observability.test.ts` | REPRODUZIDO |
| 25 | Replay | `packages/observability/src/replay.ts` | `tests/observability.test.ts`, `tests/e2e-gate.test.ts` | REPRODUZIDO |
| 26 | Crash recovery | `packages/core/src/recovery.ts` | `tests/recovery-watchdog.test.ts`, `tests/product02-gate.test.ts` | REPRODUZIDO |
| 27 | Worker pool | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 28 | Multiagent handoff | `packages/core/src/session.ts`, `packages/core/src/lease.ts` | `tests/e2e-gate.test.ts`, `tests/ownership.test.ts` | REPRODUZIDO |
| 29 | Swarm | — | — | — |
| 30–32 | NOMOS Web, cursor, takeover | `packages/ui/` | `tests/ui-build.test.ts` + visual | OBSERVADO |
| 33–35 | Task engine | `packages/core/src/taskengine.ts` | `tests/task-engine.test.ts` | REPRODUZIDO |
| 36 | Integração NOMOS — transporte | `packaging/mcp/manifesto.json`, `packages/mcp/src/server.ts` | `tests/mcp.test.ts` | REPRODUZIDO |
| 36b | Integração NOMOS — registro no catálogo (ato do dono) | — | — | — |
| 37 | Handoff entre IAs de fornecedores diferentes | — | — | — |
| 38 | Benchmark NOMOS WEB ARENA | — | — | — |
| 39 | Bateria adversarial | `packages/core/src/policy.ts`, `packages/core/src/netpolicy.ts` | `tests/security-net-injection.test.ts` | REPRODUZIDO |
| 40 | Segurança / threat model | `docs/SECURITY.md`, `packages/core/src/policy.ts` | `tests/policy-vault.test.ts` | REPRODUZIDO |
| 41 | Isolamento entre sessões | `packages/core/src/session.ts` | `tests/session.test.ts` | REPRODUZIDO |
| 42 | Performance baseline | `packages/observability/src/bench.ts` | `tests/bench.test.ts` | MEDIDO |
| 43 | Backpressure | `packages/api/src/daemon.ts` | `tests/session.test.ts`, `tests/api.test.ts` | REPRODUZIDO |
| 44 | Watchdog | `packages/observability/src/watchdog.ts` | `tests/watchdog-wired.test.ts`, `tests/recovery-watchdog.test.ts` | REPRODUZIDO |
| 45 | Configuração | `packages/api/src/config.ts`, `docs/CONFIGURATION.md` | `tests/api.test.ts` | REPRODUZIDO |
| 46 | Versionamento | `packages/core/src/contract.ts` | `tests/api.test.ts` | REPRODUZIDO |
| 47 | Documentação | `docs/`, `README.md`, `CHANGELOG.md`, `LICENSE` | `tests/traceability.test.ts` | REPRODUZIDO |
| 48–52 | Demos E2E | `evidence/nomos-browser-final-validation/10-e2e/e2e-independente.ts` | 12 cenários reexecutados | OBSERVADO |
| 53 | NOMOS Web visual | `packages/ui/` | verificação visual | OBSERVADO |
| 54 | CI anti-regressão | `scripts/ci.sh` | 5 estágios reexecutados | OBSERVADO |
| 55 | Clean room | `evidence/nomos-browser-final-loop/01-cleanroom/cleanroom-do-head.log` | reexecutados a partir do HEAD | OBSERVADO |
| `GATE-E2E-01` | Primeiro gate executável | `tests/e2e-gate.test.ts` | 12 testes | REPRODUZIDO |

Notas de honestidade sobre esta tabela:

- **Fase 20 (driver nativo)** não tem implementação e não vai ter: a decisão
  registrada é `NOT_REQUIRED_WITH_EVIDENCE`. O status `OBSERVADO` refere-se à
  **decisão documentada**, não a um driver que exista.
- **Fase 29 (swarm)** e **fase 37 (2ª IA de outro fornecedor)** continuam `—`.
  O que existe é handoff de **dono de sessão** e roteamento com fallback entre
  dois modelos do **mesmo** backend local.
- **Fase 36b** é `—` de propósito: o registro no catálogo do NOMOS é ato do dono
  (`nomos mcp confiar`), o pedido expirou por TTL, e não existe teste que possa
  provar um consentimento que não foi dado.
- **Fase 38** continua `—`: `bench.ts` está testado, e nenhum benchmark de arena
  foi executado. Ter o arnês não é ter o benchmark.
- **Fases 48–52 e 54–55** ficam em `OBSERVADO`, e não `REPRODUZIDO`, porque as
  execuções foram registradas mas não repetidas o suficiente para promoção.

### PRODUCT-02

Preenchido à medida que cada fase produz evidência. Fase sem teste correspondente
permanece `—`, nunca "implementado".

| Fase | Requisito | Artefato | Teste | Status |
|---|---|---|---|---|
| 0 | Revalidação do estado de entrada | `checkpoints/entry-product-02.json` | `tests/e2e-gate.test.ts` | REPRODUZIDO |
| 1 | Rastreabilidade | `docs/RASTREABILIDADE.md` | `tests/traceability.test.ts` | REPRODUZIDO |
| 2–5 | VisionProvider + cascata + provas negativas | `packages/core/src/vision.ts` | `tests/vision.test.ts`, `tests/product02-gate.test.ts` | REPRODUZIDO |
| 6–7 | AIProvider + dois providers locais reais | `packages/core/src/aiprovider.ts` | `tests/aiprovider.test.ts` | MEDIDO |
| 8–10 | Handoff, ownership e auditoria por agente | `packages/core/src/lease.ts` | `tests/lease.test.ts`, `tests/product02-gate.test.ts` | REPRODUZIDO |
| 11–14 | Crash do processo, snapshot e recovery | `packages/core/src/recovery.ts` | `tests/recovery-watchdog.test.ts`, `tests/product02-gate.test.ts` | REPRODUZIDO |
| 15–17 | Auth do control plane e autorização MCP | `packages/api/src/auth.ts` | `tests/auth.test.ts` | REPRODUZIDO |
| 19 | Endurecimento de replay | `packages/observability/src/replay-verify.ts` | `tests/replay-hardening.test.ts` | REPRODUZIDO |
| 20 | Watchdog | `packages/observability/src/watchdog.ts` | `tests/recovery-watchdog.test.ts` | REPRODUZIDO |
| 23 | Decisão sobre driver nativo | `docs/DECISAO-DRIVER-NATIVO.md` | — | OBSERVADO |
| 27–28 | Política de download e upload | `packages/core/src/filepolicy.ts` | `tests/security-files-secrets.test.ts` | REPRODUZIDO |
| 29 | Política de rede do navegador | `packages/core/src/netpolicy.ts` | `tests/security-net-injection.test.ts` | REPRODUZIDO |
| 30 | Injeção via página | `packages/core/src/sanitize.ts` | `tests/security-net-injection.test.ts` | REPRODUZIDO |
| 31 | Não-exfiltração de segredo | `packages/core/src/vault.ts` | `tests/security-files-secrets.test.ts` | REPRODUZIDO |
| 32–33 | Arnês de benchmark | `packages/observability/src/bench.ts` | `tests/bench.test.ts` | MEDIDO |
| 37 | Marca NOMOS | `docs/BRAND.md` | `tests/ui-build.test.ts` | REPRODUZIDO |
| 38 | CI anti-regressão | `scripts/ci.sh` | 5 estágios reexecutados | OBSERVADO |
| 41–42 | Vazamento e não-interferência | `checkpoints/capture.sh` | — | OBSERVADO |

### Ciclo de fechamento (FINAL_LOOP) — os defeitos achados pela validação final

Cada linha nasceu de um defeito **medido** em
`evidence/nomos-browser-final-validation/FINAL_REPORT.md`, com reprodutor
executável antes da correção.

| Fase | Requisito | Artefato | Teste | Status |
|---|---|---|---|---|
| L-1 | Download bloqueado não pode derrubar o daemon | `packages/api/src/handlers.ts` | `evidence/nomos-browser-final-validation/05-security/repro-crash-download-bloqueado.ts` | REPRODUZIDO |
| L-2 | Lockfile em sincronia com os workspaces | `package-lock.json` | `evidence/nomos-browser-final-loop/01-cleanroom/cleanroom-do-head.log` | OBSERVADO |
| L-3 | Procedência anti-injeção no caminho de execução | `packages/core/src/sanitize.ts`, `packages/api/src/handlers.ts` | `tests/injection-wired.test.ts` | REPRODUZIDO |
| L-4 | Auditoria forense de 19 campos | `packages/core/src/contract.ts`, `packages/observability/src/audit.ts` | `tests/audit-forense.test.ts` | REPRODUZIDO |
| L-5 | Clique com prova de entrega | `packages/core/src/actionable.ts` | `tests/click-entrega.test.ts` | REPRODUZIDO |
| L-6 | Suíte sem processo órfão | `scripts/run-suite.sh` | `evidence/nomos-browser-final-loop/15-orfaos/prova-group-kill.sh` | REPRODUZIDO |
| L-7 | Providers injetados pelo daemon | `packages/api/src/providers.ts` | `tests/providers-runtime.test.ts` | REPRODUZIDO |
| L-8 | Cascata provada degrau a degrau | `packages/core/src/target.ts` | `tests/cascata-percepcao.test.ts` | REPRODUZIDO |
| L-9 | Task engine persistente | `packages/core/src/taskengine.ts`, `docs/TASK-ENGINE.md` | `tests/task-engine.test.ts` | REPRODUZIDO |
| L-10 | Ownership com lease obrigatório | `packages/core/src/session.ts`, `packages/api/src/auth.ts` | `tests/ownership.test.ts` | REPRODUZIDO |
| L-11 | Segurança completa — T7 fechado | `docs/SECURITY.md`, `packages/mcp/src/server.ts` | `evidence/nomos-browser-final-loop/11-security/bateria-completa.ts` | MEDIDO |
| L-12 | Replay selado | `packages/observability/src/replay.ts` | `tests/replay-hardening.test.ts` | REPRODUZIDO |
| L-13 | Watchdog instanciado pelo daemon | `packages/observability/src/watchdog.ts` | `tests/watchdog-wired.test.ts` | REPRODUZIDO |
| L-14 | Supervisão por launchd | `scripts/service.sh`, `packaging/launchd/ai.nomos.browser.plist` | `tests/supervisor.test.ts` | REPRODUZIDO |
| L-14b | Reboot real da máquina | — | — | — |
| L-15 | Adaptador MCP canônico do NOMOS | `packaging/mcp/servidor.mjs`, `scripts/nomos-register.sh` | `evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts` | MEDIDO |
| L-16 | Binding da Gi pelo caminho do NOMOS | `docs/GI-INTEGRATION.md` | `evidence/nomos-browser-final-loop/08-gi/e2e-gi.py` | MEDIDO |
| L-17 | Documentação de produto | `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `docs/LIMITATIONS.md`, `docs/RELEASE.md` | `tests/traceability.test.ts` | REPRODUZIDO |

`L-14b` fica em `—` e não pode ser fechada nesta máquina: ela é de produção, e
`launchctl kickstart -k` é **simulação de reboot**, declarada como tal.
