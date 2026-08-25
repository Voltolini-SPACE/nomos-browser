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
| GET | `/api/v1/queues` | profundidade da fila **por sessão** — `ADMIN` |

### Pressão: `/health` e `GET /api/v1/queues` (FASE 20b)

`HealthResponse.queues` publica o **agregado** das filas de sessão —
`{running, waiting, sessions_with_queue, max_concurrency, max_queue}`. Responde
"o runtime está sob pressão?" sem dizer **de quem** é a pressão.

`GET /api/v1/queues` publica o **detalhe por sessão** —
`{workers, sessions_pool, aggregate, sessions:[{session_id, running, waiting,
max_concurrency, max_queue, oldest_running_ms}]}`.

**Por que são duas rotas.** `/health` pede apenas `OBSERVE`, e `OBSERVE` é
concedido inclusive a token limitado a **uma** sessão — a rota não nomeia sessão,
então a `session_allowlist` não restringe nada ali. Publicar `session_id` +
profundidade no `/health` entregaria a atividade das sessões alheias a quem só
podia ver a própria: lido em laço, o número desenha o horário de trabalho de cada
agente. Por isso o detalhe por sessão exige `ADMIN`, no mesmo nível de
`config.get`.

`oldest_running_ms` viaja junto porque profundidade **sem idade** não distingue
"10 ações rápidas passando" de "1 ação presa há 4 minutos segurando as outras 9"
— os dois casos mostram o mesmo `running` e pedem correções opostas.

A fila **nasce na primeira ação** da sessão: sessão criada e ainda ociosa não
aparece em `sessions[]`, e isso é a verdade — ela não tem fila.

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

## Gestão de task (FASE 9)

Rotas de GESTÃO: respondem o objeto direto, **sem** o envelope `ActionResponse`
(o envelope é das AÇÕES). Autenticadas como as demais — `OBSERVE` para ler,
`CONTROL` para cancelar e retomar.

| Rota | Corpo / query | Resposta |
|---|---|---|
| `GET /api/v1/tasks` | `?session_id=&state=` | `{tasks[], total, filter}` |
| `GET /api/v1/tasks/:task_id` | `?session_id=` | `TaskRecord` (estado + checkpoint) |
| `POST /api/v1/tasks/:task_id/cancel` | `{reason?}` | `TaskRecord` em `CANCELLED` |
| `POST /api/v1/tasks/:task_id/resume` | `{session_id?}` | `TaskRecord` |

`browser.task` aceita `idempotency_key`. Duas chamadas com a mesma chave enquanto
a primeira está viva compartilham UMA execução; depois de `COMPLETED`, a segunda
devolve o resultado guardado sem reexecutar — inclusive entre reinícios do
processo, porque a reserva da chave é gravada em disco.

Estados: `QUEUED RUNNING WAITING RETRYING PAUSED CANCELLED FAILED COMPLETED
RECOVERING`. As transições válidas estão declaradas em `TASK_TRANSICOES`
(`packages/core/src/taskengine.ts`); transição fora da tabela é erro, não
silêncio. `resume` de uma task em estado final devolve o resultado guardado e
não reexecuta nada.

`resume` aceita `session_id` para religar a task a uma sessão NOVA — necessário
depois de um crash, quando a sessão original não pôde ser reconstituída. A troca
fica registrada na linha do tempo das duas sessões.

`browser.wait` **não** aceita duração fixa como condição principal — `condition`
é `url_contains` / `element_visible` / `element_hidden` / `network_idle` / `text_present`.

## WebSocket

`ws://127.0.0.1:7777/events` — emite `RuntimeEvent` em JSON, um por frame.
Filtro opcional: `?session_id=...` e `?events=mouse.clicked,task.progress`.

`session.rejected` (FASE 20b) é emitido quando `POST /api/v1/sessions` é recusado
por pool cheio. Antes dele o barramento só tinha `session.created`: quem observava
o runtime via o silêncio de uma sessão que nunca apareceu e não distinguia
"ninguém pediu" de "pedi e fui recusado".

## Códigos de erro

Enum fechado em `ActionErrorCode` (contract.ts). Não inventar código novo sem
subir a versão do contrato.
