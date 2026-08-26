# FASE 1 — Mapa do runtime existente

Fonte: leitura direta de `docs/ARCHITECTURE.md`, `docs/live-agent-console.md`,
`docs/API.md`, `docs/GI-INTEGRATION.md` e do código em `packages/*/src` no
commit `f801629`.

## EXISTING_BROWSER_CAPABILITIES

| capacidade | onde | estado |
|---|---|---|
| Browser control (Playwright + CDP cru, `isTrusted=true`) | `core/pointer.ts`, `core/keyboard.ts`, `core/session.ts` | ✅ produção |
| Sessões persistentes (`launchPersistentContext`, perfil, sobrevive a desconexão/handoff/takeover) | `core/session.ts` | ✅ |
| Tabs (list/open/switch/close, `PageInfo`) | API `browser.tabs` etc. | ✅ |
| Screenshots (viewport/full/element/region) + decoder PNG próprio | `browser.screenshot`, `observability/png.ts` | ✅ |
| Click/type/press/scroll/drag com prova de entrega e acionabilidade | `core/actionable.ts`, `core/verifier.ts` | ✅ |
| Navegação (`open/goto/back/forward/reload`, `wait` por condição) | API | ✅ |
| DOM/accessibility (`browser.observe`, `browser.find`, `browser.extract`) | `core/perception.ts`, `core/target.ts` | ✅ |
| Audit (JSONL encadeado por hash, selo, redaction) | `observability/audit.ts`, `redact.ts` | ✅ |
| Replay somente leitura (3 camadas, verificador) | `observability/replay.ts`, `replay-verify.ts` | ✅ |
| ASK / AUTO (`autonomy.ts`; AUTO ≠ bypass — topologia do código) | `core/autonomy.ts`, `core/policy.ts` | ✅ |
| Approval single-use amarrada a ação+sessão+args | `core/approvals.ts` | ✅ |
| Ownership / lease | `core/lease.ts` | ✅ |
| Recovery + watchdog | `core/recovery.ts`, `observability/watchdog.ts` | ✅ |
| Task engine (`browser.task {goal}`) com AI provider (Ollama/scripted) | `core/taskengine.ts`, `core/aiprovider.ts` | ✅ |
| Console atual (NOMOS Web): espelho, cursor, feed, aprovação, histórico, controles | `packages/ui` (servida pelo daemon, mesma origem, CSP `connect-src 'self'`) | ✅ |
| API: REST v1 + WebSocket `/events` (RuntimeEvent, filtro por sessão/evento) | `api/daemon.ts` | ✅ |
| Auth: token Bearer/`x-nomos-token`/`?token=`, escopos, hash-only em memória | `api/auth.ts` | ✅ |
| MCP governado (`mcp/server.ts` → HTTP; teste garante que "playwright" não aparece no fonte) | `packages/mcp` | ✅ |
| Gi integrada por manifesto + veredito NOMOS (nunca aprova por ninguém) | `docs/GI-INTEGRATION.md`, `pocket-assistant/gi_nomos` | ✅ |
| Governança de marca (tokens do cofre a cada build, zero hex no fonte) | `ui/build.ts`, `tests/ui-build.test.ts` | ✅ |

## MISSING_EMBEDDED_UX_CAPABILITIES

| lacuna | fase da missão |
|---|---|
| UI dentro do navegador (side panel) — hoje o console é uma página separada | 4–5 |
| Chat embutido com Gi/NOMOS no painel | 6, 22–23 |
| Streaming de atividade no painel (o console já tem; falta no painel) | 7 |
| Aprovação no painel lateral | 9 |
| Highlight do elemento NA PRÓPRIA página + selo "● NOMOS controlando" | 10 |
| Painel de abas com posse (aba do usuário vs aba do agente) | 14 |
| Bridge extensão→runtime autenticado | 16–17 |
| Modelo de permissão de extensão (menor privilégio) | 18 |
| "Perguntar sobre esta página" / elemento selecionado | 24 |
| Packaging da extensão + CWS-ready | 29–30 |

## Regra preservada

Nada acima será reconstruído. A extensão é **casca de UI** sobre a API v1
existente — mesma classe de consumidor que o console e o SDK, sem autoridade nova.
