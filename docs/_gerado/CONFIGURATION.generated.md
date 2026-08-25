# Configuração do NOMOS Browser Runtime

<!-- ARQUIVO GERADO por `node scripts/config-schema.ts --markdown`. Não edite à mão. -->
<!-- A fonte é `packages/api/src/config.ts`; `tests/config-schema.test.ts` impede divergência. -->

Precedência: **defaults → arquivo → variáveis de ambiente → overrides do código**.
Nenhuma coerção silenciosa: valor fora da faixa lança `ConfigError` no arranque, com campo, origem e faixa na mensagem.

Coluna **sensível**: sai `[REDIGIDO]` em `GET /api/v1/config`. Ver `redigirConfig` para o critério.

| chave | tipo | default | faixa / valores | variável de ambiente | sensível | resumo |
| --- | --- | --- | --- | --- | --- | --- |
| `action_timeout_ms` | inteiro | `30000` | `1..3600000` | `NOMOS_BROWSER_ACTION_TIMEOUT_MS` | não | Prazo total por ação (fila + execução). Estourou ⇒ TIMEOUT. |
| `ai_provider` | provider-ref ou `null` | `null` | `ollama:<modelo>` | `NOMOS_BROWSER_AI_PROVIDER` | não | "<backend>:<modelo>". Default null: runtime não fala com LLM sem o dono pedir. |
| `ai_provider_fallback` | provider-ref ou `null` | `null` | `ollama:<modelo>` | `NOMOS_BROWSER_AI_PROVIDER_FALLBACK` | não | Secundário acionado só em DEGRADAÇÃO do principal. Nunca em cancelamento. |
| `ai_think` | boolean ou `null` | `null` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_AI_THINK` | não | `think` do backend. null = deixa o provider decidir. |
| `ai_timeout_ms` | inteiro | `120000` | `1..3600000` | `NOMOS_BROWSER_AI_TIMEOUT_MS` | não | Prazo de uma inferência de texto. |
| `allow_internal_urls` | boolean | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_ALLOW_INTERNAL` | não | Permitir navegar em 127.0.0.1/rede interna (anti-SSRF). Default false. |
| `allow_unleased` | boolean | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_ALLOW_UNLEASED` | não | Operar sessão sem lease. Default false: quem cria a sessão vira dono no mesmo ato. |
| `audit` | boolean | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_AUDIT` | não | Trilha de auditoria. Default true. |
| `click_delivery_check` | boolean | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_CLICK_DELIVERY_CHECK` | não | Exigir prova de que o evento de clique chegou ao alvo. Default true. |
| `default_policy` | enum | `restricted` | `restricted\|observe` | `NOMOS_BROWSER_POLICY` | não | Política de capacidades default. `full` não é dizível aqui de propósito. |
| `device_scale_factor` | inteiro | `1` | `1..8` | `NOMOS_BROWSER_DEVICE_SCALE_FACTOR` | não | DPR do contexto do Chromium. 1 = tela comum, 2 = retina. |
| `download_root` | caminho ou `null` | `null` | — | `NOMOS_BROWSER_DOWNLOAD_ROOT` | **sim** | Raiz permitida para download. Fora dela ⇒ DOWNLOAD_DENIED. |
| `event_buffer` | inteiro | `1000` | `0..1000000` | `NOMOS_BROWSER_EVENT_BUFFER` | não | Buffer circular do EventBus (reconexão de WebSocket). |
| `headless` | boolean | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_HEADLESS` | não | Chromium sem janela. Default false: takeover humano precisa de janela visível. |
| `host` | string | `127.0.0.1` | — | `NOMOS_BROWSER_HOST` | não | Endereço de bind do daemon. Loopback por default; sair dele é ato explícito. |
| `max_body_bytes` | inteiro | `1048576` | `1..268435456` | `NOMOS_BROWSER_MAX_BODY_BYTES` | não | Teto do corpo de requisição HTTP. |
| `max_concurrency` | inteiro | `4` | `1..1024` | `NOMOS_BROWSER_MAX_CONCURRENCY` | não | Ações simultâneas POR SESSÃO. |
| `max_queue` | inteiro | `64` | `0..100000` | `NOMOS_BROWSER_MAX_QUEUE` | não | Ações aguardando POR SESSÃO. Estourou ⇒ BACKPRESSURE_REJECTED. |
| `max_workers` | inteiro | `4` | `1..1024` | `NOMOS_BROWSER_MAX_WORKERS` | não | Teto de sessões vivas no pool. |
| `observe_limit` | inteiro | `200` | `1..100000` | `NOMOS_BROWSER_OBSERVE_LIMIT` | não | Teto de elementos devolvidos por browser.observe. |
| `port` | inteiro | `7777` | `0..65535` | `NOMOS_BROWSER_PORT` | não | Porta HTTP. 0 = efêmera escolhida pelo SO. |
| `profiles_root` | caminho ou `null` | `null` | — | `NOMOS_BROWSER_PROFILES_ROOT` | **sim** | Raiz dos perfis persistentes do Chromium (cookies e sessão do dono). |
| `providers_allow_remote` | boolean | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_PROVIDERS_ALLOW_REMOTE` | não | Consentimento explícito para mandar prompt e SCREENSHOT para fora desta máquina. |
| `providers_base_url` | url | `http://127.0.0.1:11434` | `http\|https, loopback salvo providers_allow_remote` | `NOMOS_BROWSER_PROVIDERS_BASE_URL` | **sim** | Backend dos providers. Loopback obrigatório salvo providers_allow_remote. |
| `raw_web_content` | enum | `withhold_on_detection` | `withhold_on_detection\|always\|never` | `NOMOS_BROWSER_RAW_WEB_CONTENT` | não | O que fazer com o texto CRU da web quando há injeção detectada. |
| `scroll_into_view` | boolean | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_SCROLL_INTO_VIEW` | não | Rolar o alvo para dentro do viewport antes do gesto. Default true. |
| `sessions_root` | caminho ou `null` | `null` | — | `NOMOS_SESSIONS_ROOT` | **sim** | Raiz do audit log JSONL e dos snapshots de sessão. |
| `stability_interval_ms` | inteiro | `50` | `0..10000` | `NOMOS_BROWSER_STABILITY_INTERVAL_MS` | não | Intervalo entre amostras de estabilização. |
| `stability_samples` | inteiro | `3` | `2..100` | `NOMOS_BROWSER_STABILITY_SAMPLES` | não | Amostras CONSECUTIVAS iguais da bounding box para declará-la assentada. Mínimo 2: com 1 não se compara nada. |
| `task_max_attempts` | inteiro | `3` | `1..100` | `NOMOS_BROWSER_TASK_MAX_ATTEMPTS` | não | Tentativas TOTAIS por passo, contando a primeira. 1 desliga a retentativa. |
| `task_recover_grace_ms` | inteiro | `30000` | `0..3600000` | `NOMOS_BROWSER_TASK_RECOVER_GRACE_MS` | não | Janela para retomar task RECOVERING após crash. Passada ⇒ FAILED com razão. |
| `task_retry_base_ms` | inteiro | `500` | `0..3600000` | `NOMOS_BROWSER_TASK_RETRY_BASE_MS` | não | Base do backoff exponencial. Não pode ser maior que task_retry_max_ms. |
| `task_retry_max_ms` | inteiro | `30000` | `0..3600000` | `NOMOS_BROWSER_TASK_RETRY_MAX_MS` | não | Teto do backoff exponencial. |
| `task_step_timeout_ms` | inteiro | `60000` | `1..3600000` | `NOMOS_BROWSER_TASK_STEP_TIMEOUT_MS` | não | Prazo de UM passo. Não pode ser maior que task_total_timeout_ms. |
| `task_total_timeout_ms` | inteiro | `600000` | `1..86400000` | `NOMOS_BROWSER_TASK_TOTAL_TIMEOUT_MS` | não | Prazo da task inteira. |
| `tasks_root` | caminho ou `null` | `null` | — | `NOMOS_BROWSER_TASKS_ROOT` | **sim** | Raiz dos arquivos de task. null ⇒ dentro de sessions_root. |
| `upload_root` | caminho ou `null` | `null` | — | `NOMOS_BROWSER_UPLOAD_ROOT` | **sim** | Raiz permitida para upload. Fora dela ⇒ UPLOAD_DENIED. |
| `version` | string | `0.1.0` | — | — | não | Versão anunciada em /health. Lida do package.json da raiz; sem variável de ambiente de propósito — versão não se configura, se publica. |
| `viewport.height` | inteiro | `800` | `1..20000` | `NOMOS_BROWSER_VIEWPORT_HEIGHT` | não | Altura CSS do viewport. |
| `viewport.width` | inteiro | `1280` | `1..20000` | `NOMOS_BROWSER_VIEWPORT_WIDTH` | não | Largura CSS do viewport. |
| `vision_aim` | enum | `point_then_box` | `box_center\|point\|point_then_box` | `NOMOS_BROWSER_VISION_AIM` | não | Onde mirar dentro do que a visão devolveu. |
| `vision_min_confidence` | fracao | `0.7` | `0..1` | `NOMOS_BROWSER_VISION_MIN_CONFIDENCE` | não | Abaixo disto a visão é descartada como palpite. |
| `vision_provider` | provider-ref ou `null` | `null` | `ollama:<modelo>` | `NOMOS_BROWSER_VISION_PROVIDER` | não | Ausente ⇒ degrau `vision` PULADO, com razão registrada. |
| `vision_refine_factor` | fracao | `2.5` | `1.2..6` | `NOMOS_BROWSER_VISION_REFINE_FACTOR` | não | Lado do recorte = maior lado da caixa grosseira × isto. |
| `vision_refine_passes` | inteiro | `0` | `0..2` | `NOMOS_BROWSER_VISION_REFINE_PASSES` | não | Passadas de refino por recorte. Default 0 POR MEDIÇÃO (ver target.ts). |
| `vision_timeout_ms` | inteiro | `20000` | `1..3600000` | `NOMOS_BROWSER_VISION_TIMEOUT_MS` | não | Prazo de uma inferência de visão. |
| `watchdog_enabled` | boolean | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `NOMOS_BROWSER_WATCHDOG_ENABLED` | não | Vigia interno. Default true — supervisor que nasce desligado é supervisor que ninguém liga. |
| `watchdog_interval_ms` | inteiro | `5000` | `50..3600000` | `NOMOS_BROWSER_WATCHDOG_INTERVAL_MS` | não | Período entre sondagens. Piso 50 ms: abaixo disso o vigia custa mais que o vigiado. |
| `watchdog_max_restarts` | inteiro | `3` | `0..1000` | `NOMOS_BROWSER_WATCHDOG_MAX_RESTARTS` | não | Recuperações da MESMA falha antes de DEGRADAR (T10). 0 = detecta e reporta, nunca recupera. |
| `watchdog_task_stall_ms` | inteiro | `120000` | `100..86400000` | `NOMOS_BROWSER_WATCHDOG_TASK_STALL_MS` | não | Task RUNNING sem avançar checkpoint por mais que isto é task estagnada. |
| `watchdog_worker_stall_ms` | inteiro | `60000` | `100..86400000` | `NOMOS_BROWSER_WATCHDOG_WORKER_STALL_MS` | não | Ação em execução há mais que isto é worker preso. |

## Variáveis de ambiente

Toda variável abaixo é suportada, tem default, tem validação e recusa valor inválido com mensagem nomeando campo, origem e faixa.

| variável | chave | default | faixa / valores | exemplo válido |
| --- | --- | --- | --- | --- |
| `NOMOS_BROWSER_ACTION_TIMEOUT_MS` | `action_timeout_ms` | `30000` | `1..3600000` | `30000` |
| `NOMOS_BROWSER_AI_PROVIDER` | `ai_provider` | `null` | `ollama:<modelo>` | `ollama:qwen2.5-coder:7b` |
| `NOMOS_BROWSER_AI_PROVIDER_FALLBACK` | `ai_provider_fallback` | `null` | `ollama:<modelo>` | `ollama:qwen2.5-coder:7b` |
| `NOMOS_BROWSER_AI_THINK` | `ai_think` | `null` | `true\|false\|1\|0\|yes\|no\|on\|off` | `false` |
| `NOMOS_BROWSER_AI_TIMEOUT_MS` | `ai_timeout_ms` | `120000` | `1..3600000` | `120000` |
| `NOMOS_BROWSER_ALLOW_INTERNAL` | `allow_internal_urls` | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `true` |
| `NOMOS_BROWSER_ALLOW_UNLEASED` | `allow_unleased` | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `true` |
| `NOMOS_BROWSER_AUDIT` | `audit` | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `false` |
| `NOMOS_BROWSER_CLICK_DELIVERY_CHECK` | `click_delivery_check` | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `false` |
| `NOMOS_BROWSER_POLICY` | `default_policy` | `restricted` | `restricted\|observe` | `observe` |
| `NOMOS_BROWSER_DEVICE_SCALE_FACTOR` | `device_scale_factor` | `1` | `1..8` | `2` |
| `NOMOS_BROWSER_DOWNLOAD_ROOT` | `download_root` | `null` | — | `/tmp/nomos-download` |
| `NOMOS_BROWSER_EVENT_BUFFER` | `event_buffer` | `1000` | `0..1000000` | `1000` |
| `NOMOS_BROWSER_HEADLESS` | `headless` | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `true` |
| `NOMOS_BROWSER_HOST` | `host` | `127.0.0.1` | — | `127.0.0.1` |
| `NOMOS_BROWSER_MAX_BODY_BYTES` | `max_body_bytes` | `1048576` | `1..268435456` | `1048576` |
| `NOMOS_BROWSER_MAX_CONCURRENCY` | `max_concurrency` | `4` | `1..1024` | `4` |
| `NOMOS_BROWSER_MAX_QUEUE` | `max_queue` | `64` | `0..100000` | `64` |
| `NOMOS_BROWSER_MAX_WORKERS` | `max_workers` | `4` | `1..1024` | `8` |
| `NOMOS_BROWSER_OBSERVE_LIMIT` | `observe_limit` | `200` | `1..100000` | `200` |
| `NOMOS_BROWSER_PORT` | `port` | `7777` | `0..65535` | `7777` |
| `NOMOS_BROWSER_PROFILES_ROOT` | `profiles_root` | `null` | — | `/tmp/nomos-perfis` |
| `NOMOS_BROWSER_PROVIDERS_ALLOW_REMOTE` | `providers_allow_remote` | `false` | `true\|false\|1\|0\|yes\|no\|on\|off` | `true` |
| `NOMOS_BROWSER_PROVIDERS_BASE_URL` | `providers_base_url` | `http://127.0.0.1:11434` | `http\|https, loopback salvo providers_allow_remote` | `http://127.0.0.1:11434` |
| `NOMOS_BROWSER_RAW_WEB_CONTENT` | `raw_web_content` | `withhold_on_detection` | `withhold_on_detection\|always\|never` | `always` |
| `NOMOS_BROWSER_SCROLL_INTO_VIEW` | `scroll_into_view` | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `false` |
| `NOMOS_SESSIONS_ROOT` | `sessions_root` | `null` | — | `/tmp/nomos-sessoes` |
| `NOMOS_BROWSER_STABILITY_INTERVAL_MS` | `stability_interval_ms` | `50` | `0..10000` | `50` |
| `NOMOS_BROWSER_STABILITY_SAMPLES` | `stability_samples` | `3` | `2..100` | `3` |
| `NOMOS_BROWSER_TASK_MAX_ATTEMPTS` | `task_max_attempts` | `3` | `1..100` | `3` |
| `NOMOS_BROWSER_TASK_RECOVER_GRACE_MS` | `task_recover_grace_ms` | `30000` | `0..3600000` | `30000` |
| `NOMOS_BROWSER_TASK_RETRY_BASE_MS` | `task_retry_base_ms` | `500` | `0..3600000` | `500` |
| `NOMOS_BROWSER_TASK_RETRY_MAX_MS` | `task_retry_max_ms` | `30000` | `0..3600000` | `30000` |
| `NOMOS_BROWSER_TASK_STEP_TIMEOUT_MS` | `task_step_timeout_ms` | `60000` | `1..3600000` | `45000` |
| `NOMOS_BROWSER_TASK_TOTAL_TIMEOUT_MS` | `task_total_timeout_ms` | `600000` | `1..86400000` | `600000` |
| `NOMOS_BROWSER_TASKS_ROOT` | `tasks_root` | `null` | — | `/tmp/nomos-tasks` |
| `NOMOS_BROWSER_UPLOAD_ROOT` | `upload_root` | `null` | — | `/tmp/nomos-upload` |
| `NOMOS_BROWSER_VIEWPORT_HEIGHT` | `viewport.height` | `800` | `1..20000` | `900` |
| `NOMOS_BROWSER_VIEWPORT_WIDTH` | `viewport.width` | `1280` | `1..20000` | `1440` |
| `NOMOS_BROWSER_VISION_AIM` | `vision_aim` | `point_then_box` | `box_center\|point\|point_then_box` | `box_center` |
| `NOMOS_BROWSER_VISION_MIN_CONFIDENCE` | `vision_min_confidence` | `0.7` | `0..1` | `0.7` |
| `NOMOS_BROWSER_VISION_PROVIDER` | `vision_provider` | `null` | `ollama:<modelo>` | `ollama:qwen2.5vl:3b` |
| `NOMOS_BROWSER_VISION_REFINE_FACTOR` | `vision_refine_factor` | `2.5` | `1.2..6` | `2.5` |
| `NOMOS_BROWSER_VISION_REFINE_PASSES` | `vision_refine_passes` | `0` | `0..2` | `2` |
| `NOMOS_BROWSER_VISION_TIMEOUT_MS` | `vision_timeout_ms` | `20000` | `1..3600000` | `20000` |
| `NOMOS_BROWSER_WATCHDOG_ENABLED` | `watchdog_enabled` | `true` | `true\|false\|1\|0\|yes\|no\|on\|off` | `false` |
| `NOMOS_BROWSER_WATCHDOG_INTERVAL_MS` | `watchdog_interval_ms` | `5000` | `50..3600000` | `5000` |
| `NOMOS_BROWSER_WATCHDOG_MAX_RESTARTS` | `watchdog_max_restarts` | `3` | `0..1000` | `3` |
| `NOMOS_BROWSER_WATCHDOG_TASK_STALL_MS` | `watchdog_task_stall_ms` | `120000` | `100..86400000` | `120000` |
| `NOMOS_BROWSER_WATCHDOG_WORKER_STALL_MS` | `watchdog_worker_stall_ms` | `60000` | `100..86400000` | `60000` |

Além destas, `NOMOS_BROWSER_CONFIG` aponta para o arquivo de configuração; declarada e ausente é **erro de arranque**, nunca fallback silencioso para os defaults.
