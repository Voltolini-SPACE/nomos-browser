# NOMOS Browser Runtime — API v1

Prefixo: `/api/v1`. Host padrão `127.0.0.1:7777`.
Todos os tipos vêm de `packages/core/src/contract.ts`. Esta é a tabela de rotas
normativa: SDKs, CLI e MCP codificam contra ela e **não** inventam rota.

## Regras invariantes

1. Toda rota de ação aceita `session_id` (no corpo ou em `?session_id=`).
2. Toda rota de ação responde `ActionResponse<T>` — `{success, action_id, state, result, error, timing}`.
   Erro HTTP mantém o envelope; o código de negócio vive em `error.code`.
3. Rotas de gestão (`/health`, `/sessions`, `/events`) respondem o objeto direto,
   não o envelope — não são ações sobre uma sessão.
4. Capability negada ⇒ HTTP 403 + `error.code = "CAPABILITY_DENIED"`. Fail closed:
   ferramenta sem entrada em `REQUIRED_CAPABILITY` é negada.
5. Controle humano ativo ⇒ HTTP 409 + `CONTROL_HELD_BY_HUMAN`.

## Gestão

| Método | Rota | Resposta |
|---|---|---|
| GET | `/health` | `HealthResponse` |
| GET | `/api/v1/sessions` | `SessionInfo[]` |
| POST | `/api/v1/sessions` | `SessionInfo` — corpo `{owner, profile?, capabilities?, headless?}` |
| GET | `/api/v1/sessions/:id` | `SessionInfo` |
| DELETE | `/api/v1/sessions/:id` | `{closed:true}` |
| POST | `/api/v1/sessions/:id/attach` | `SessionInfo` — corpo `{client}` |
| POST | `/api/v1/sessions/:id/detach` | `SessionInfo` — sessão **continua viva** |
| POST | `/api/v1/sessions/:id/handoff` | `SessionInfo` — corpo `{to_owner}` |
| POST | `/api/v1/sessions/:id/takeover` | `SessionInfo` — humano assume, agente congela |
| POST | `/api/v1/sessions/:id/release` | `SessionInfo` — devolve; runtime **reobserva** |

## Ações — `POST /api/v1/browser.<verbo>`

Corpo sempre inclui `session_id`.

| Ferramenta | Corpo adicional | `result` |
|---|---|---|
| `browser.open` | `{url}` | `PageInfo` |
| `browser.goto` | `{url, wait_until?}` | `PageInfo` |
| `browser.back` / `.forward` / `.reload` | — | `PageInfo` |
| `browser.observe` | `{accessibility?, screenshot?, limit?}` | `Observation` |
| `browser.find` | `{target: TargetDescriptor}` | `ResolvedTarget` |
| `browser.click` | `{target, verification?}` | `{target: ResolvedTarget, verification: VerificationResult}` |
| `browser.type` | `{target, text \| credential_ref, verification?}` | idem |
| `browser.press` | `{key \| keys[]}` | `{pressed}` |
| `browser.scroll` | `{dx?, dy?, target?}` | `{scrolled}` |
| `browser.drag` | `{from, to}` | `{dragged}` |
| `browser.extract` | `{target?, format?}` | `{content}` |
| `browser.screenshot` | `{scope?: viewport\|full\|element\|region, target?, region?}` | `{screenshot_ref, width, height}` |
| `browser.tabs` | — | `PageInfo[]` |
| `browser.new_tab` | `{url?}` | `PageInfo` |
| `browser.switch_tab` | `{page_id}` | `PageInfo` |
| `browser.close_tab` | `{page_id}` | `{closed}` |
| `browser.download` | `{target?, url?}` | `DownloadRecord` |
| `browser.upload` | `{target, path \| file_ref}` | `UploadRecord` |
| `browser.wait` | `{condition, timeout_ms?}` | `{waited_ms}` |
| `browser.network` | `{limit?}` | `{requests[]}` (com redaction) |
| `browser.task` | `{goal, profile?}` | `BrowserTask` |

`browser.wait` **não** aceita duração fixa como condição principal — `condition`
é `url_contains` / `element_visible` / `element_hidden` / `network_idle` / `text_present`.

## WebSocket

`ws://127.0.0.1:7777/events` — emite `RuntimeEvent` em JSON, um por frame.
Filtro opcional: `?session_id=...` e `?events=mouse.clicked,task.progress`.

## Códigos de erro

Enum fechado em `ActionErrorCode` (contract.ts). Não inventar código novo sem
subir a versão do contrato.
