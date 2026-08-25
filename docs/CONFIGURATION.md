# Configuração

A tabela completa, campo a campo, com tipo, default e variável de ambiente, é
**gerada a partir de `packages/api/src/config.ts`** e vive em:

> **[`docs/_gerado/CONFIGURATION.generated.md`](_gerado/CONFIGURATION.generated.md)**

Este documento é a **prosa**: o que cada grupo significa, o que acontece se você
não configurar nada, e quais chaves são a diferença entre uma funcionalidade
existir e não existir. Sempre que os dois divergirem, **o gerado vence** — ele é
lido do código, este aqui é escrito por gente.

Ele é produzido por `node scripts/config-schema.ts --markdown` e
`tests/config-schema.test.ts` impede que ele divirja do código. **Não edite o
arquivo gerado à mão** — a edição sobrevive até a próxima geração e a divergência
volta. Se algo estiver errado lá, o defeito está em `packages/api/src/config.ts`.

---

## Como a configuração é resolvida

Precedência, do mais fraco para o mais forte:

```
DEFAULTS  →  arquivo  →  variáveis de ambiente  →  override programático
```

O override programático vence por último porque quem embute o daemon num teste
precisa poder pedir `port: 0` sem que o ambiente do operador o contradiga.

Duas regras que valem para tudo abaixo:

1. **Não existe coerção silenciosa.** `NOMOS_BROWSER_PORT=abc` **não** vira
   `7777`: levanta `ConfigError`. Um daemon que "corrige" configuração errada
   esconde do dono o fato de que nunca leu o que foi pedido.
2. **A proveniência é registrada.** O campo `sources` diz, por chave, de onde
   veio o valor efetivo. Sem isso, "por que está headless?" só se responde por
   adivinhação.

**Arquivo:** `NOMOS_BROWSER_CONFIG=<caminho>`. O formato é JSON **ou** um
YAML-ish deliberadamente pobre (`chave: valor`, comentário com `#`, um nível de
aninhamento). Pobre de propósito: uma dependência de YAML para ler seis chaves
seria superfície de supply chain paga a troco de nada.

**Ambiente:** toda chave tem a forma `NOMOS_BROWSER_<CHAVE_EM_MAIÚSCULAS>`.

---

## As chaves sem as quais a funcionalidade NÃO EXISTE

Esta seção existe porque a ausência delas não produz erro de configuração — ela
produz **negação em tempo de execução**, e o operador que não leu isto conclui
que o produto está quebrado.

| Chave | Default | O que deixa de existir sem ela |
|---|---|---|
| `upload_root` | `null` | **Upload.** Toda tentativa é negada com `403 UPLOAD_DENIED`. |
| `download_root` | `null` | **Download.** Toda tentativa é negada (`download_root não configurado`). |
| `ai_provider` | `null` | **`browser.task`.** Sem `AIProvider` injetado, a rota devolve `INVALID_REQUEST`: não há motor de plano. |
| `vision_provider` | `null` | **O degrau `vision` da cascata.** O trace registra `vision: skipped, "nenhum VisionProvider injetado"` e a resolução de alvo para no DOM/AX. |

Os quatro defaults nulos são **decisão**, não esquecimento:

- `upload_root` / `download_root` nulos são **fail-closed**. O runtime dirige um
  navegador com as sessões autenticadas do dono; nascer com uma raiz de escrita
  implícita seria nascer com uma porta aberta no disco dele.
- `ai_provider` / `vision_provider` nulos garantem que **o runtime não nasce
  falando com um LLM sem o dono pedir**. Um default apontando para
  `127.0.0.1:11434` faria o produto enviar conteúdo de página a um modelo sem
  que ninguém tivesse autorizado.

Confirme o efeito antes de acusar defeito: `GET /health` e a trilha de auditoria
mostram a decisão de política (`policy_decision: "deny"`, `policy_reason`).

---

## Grupos

### Rede e bind

`host`, `port`, `max_body_bytes`, `event_buffer`.

Padrão: `127.0.0.1:7777`. **O bind loopback é a linha de defesa mais importante
do produto** (`docs/SECURITY.md`, T7). Expor a porta na LAN dá controle do
navegador do dono a quem estiver na rede. Autenticação existe e é obrigatória,
mas ela reduz o dano de um processo local hostil — não torna seguro publicar a
porta.

`max_body_bytes` (1 MiB) e `event_buffer` (1000) são anteparos de recurso, não
de segurança: corpo gigante e cliente lento não devem derrubar o processo.

### Política e capabilities

`default_policy`, `allow_internal_urls`, `allow_unleased`.

- `default_policy` escolhe entre as políticas nomeadas de `policy.ts`.
  Capabilities sensíveis (`send`, `purchase`, `payment`, `delete`, `upload`)
  nascem **negadas** (`RESTRICTED_CAPABILITIES`), e ferramenta sem entrada em
  `REQUIRED_CAPABILITY` é negada — fail-closed, nunca permitida por omissão.
- `allow_internal_urls` (default `false`) libera loopback, link-local, RFC1918 e
  `.local`. É necessário para os próprios testes do runtime (fixtures em
  `127.0.0.1`). É explícito por definição: um `allow_internal` implícito seria
  SSRF por conveniência.
- `allow_unleased` (default **`false`** desde `8cd9fff`) — ver "Ownership".

### Ownership e lease

`allow_unleased`.

Com o default atual, quem cria a sessão recebe lease exclusivo **no mesmo ato**.
Qualquer outro principal é recusado com `CONTROL_NOT_OWNED` até adquirir, herdar
por handoff, ou esperar o lease alheio expirar. O principal é o **sujeito do
token** — nunca um header auto-declarado.

`NOMOS_BROWSER_ALLOW_UNLEASED=true` restaura o comportamento antigo (sessão sem
lease aberta a qualquer chamador local). É modo permissivo declarado, para
compatibilidade; não use em máquina com sessões autenticadas reais.

### Raízes de arquivo

`profiles_root`, `sessions_root`, `tasks_root`, `upload_root`, `download_root`.

`profiles_root` guarda os `userDataDir` (cookies do dono). `sessions_root` guarda
a trilha de auditoria e o replay. `tasks_root` guarda checkpoints e as reservas
de idempotência. As três primeiras têm default derivado do runtime dir; as duas
últimas (`upload_root`, `download_root`) são nulas de propósito — ver acima.

Caminho fora da raiz é rejeitado com normalização (`..` e `%2e%2e` inclusive):
T6 do modelo de ameaça.

### Providers de IA e de visão

`ai_provider`, `ai_provider_fallback`, `ai_timeout_ms` (120 000), `ai_think`,
`vision_provider`, `vision_timeout_ms`, `vision_min_confidence` (0,7),
`vision_refine_passes` (**0**), `vision_refine_factor`, `vision_aim`,
`providers_base_url`, `providers_allow_remote` (`false`).

Formato da referência: `"<backend>:<modelo>"` (ex.: `ollama:qwen2.5vl:3b`).
Backend desconhecido é `ConfigError`, não fallback.

- **Fallback só em degradação classificada** — timeout, rede, `EMPTY_OUTPUT`,
  5xx. **Cancelamento nunca vira fallback:** cancelar é ordem, não falha.
- `providers_allow_remote=false` mantém os providers em `127.0.0.1`. Apontar o
  provider para fora da máquina significa enviar conteúdo de página do dono para
  um terceiro; exige o flag explícito.
- `vision_min_confidence = 0,7` é o guarda que barra caixa espúria. Ele foi o
  que refutou `moondream:1.8b`, que devolveu confiança 0,67 para um alvo
  inexistente.
- `vision_refine_passes = 0` **não é preguiça**: o refino por recorte foi
  implementado, medido e refutado em 9/9 células. Fica disponível para outro
  modelo. Ver `docs/LIMITATIONS.md`.
- `vision_aim` escolhe a mira (`point`, `box_center`, `point_then_box`). O
  default e o porquê estão em `docs/LIMITATIONS.md`, com os números.

### Task engine

`task_max_attempts` (3), `task_step_timeout_ms` (60 000),
`task_total_timeout_ms` (600 000), `task_retry_base_ms` (500),
`task_retry_max_ms` (30 000), `task_recover_grace_ms` (30 000), `tasks_root`.

`task_max_attempts` conta a **primeira** tentativa: `1` significa "sem
retentativa". O backoff é exponencial com teto e jitter *equal*.
`task_recover_grace_ms` é a janela que a varredura de arranque espera antes de
decidir sobre uma task que estava `RUNNING` quando o processo morreu.

Detalhes de estado, retry e o que **nunca** é retentado:
**[docs/TASK-ENGINE.md](TASK-ENGINE.md)**.

### Watchdog

`watchdog_enabled` (**`true`**), `watchdog_interval_ms` (5 000),
`watchdog_max_restarts` (3), `watchdog_task_stall_ms` (120 000),
`watchdog_worker_stall_ms` (60 000).

Três sondas: navegador morto, worker preso, task estagnada.
`watchdog_max_restarts` existe por causa de T10: um watchdog que reinicia sem
teto transforma falha em negação de serviço local. Ao estourar o teto o runtime
fica `degraded` e **para** de reiniciar, com evento próprio no audit.

### Procedência de conteúdo web

`raw_web_content`: `withhold_on_detection` (default) | `always` | `never`.

Desde `bc7130f`, `browser.observe` e `browser.extract` devolvem **`provenance`**
(`source`, `trust`, `injection_detected`, `severity`, `findings`,
`sanitized_content`, `nonce`, `raw_content_available`).

| Valor | Comportamento |
|---|---|
| `withhold_on_detection` | Severidade **alta** retém o texto cru; média/baixa **marcam** e entregam. É o controle de falso positivo: nem tudo que parece injeção justifica reter. |
| `always` | Entrega o cru sempre, ainda marcado. Para quem precisa do texto literal e assume o risco. |
| `never` | Nunca entrega o cru. |

`raw_content_available: false` **nunca** significa "o conteúdo sumiu": o texto
literal continua em `findings[].trecho` e dentro de `sanitized_content`.

### Comportamento de clique e estabilidade

`scroll_into_view` (`true`), `click_delivery_check` (`true`),
`stability_samples` (3), `stability_interval_ms` (50), `device_scale_factor` (1),
`action_timeout_ms` (30 000), `observe_limit` (200).

`click_delivery_check` é o que faz `browser.click` **provar** a entrega por
listener de captura armado antes do gesto. Desligá-lo devolve o comportamento
otimista antigo, em que alvo fora do viewport respondia `success:true` sem
clique nenhum. Não desligue.

`stability_samples`/`stability_interval_ms` existem porque o scroll do Chromium
é animado: medir a caixa antes de ela assentar produz um número exato e errado.

### Concorrência e recursos

`max_workers` (4), `max_concurrency` (4), `max_queue` (64),
`viewport` (1280x800), `headless` (`false`), `audit` (`true`).

`audit: false` desliga a trilha. Só faça isso em teste: sem trilha não há
reconstrução de decisão de política, e a única prova de que uma negação
aconteceu deixa de existir.
