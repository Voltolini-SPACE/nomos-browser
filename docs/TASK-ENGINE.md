# Task engine

Motor de execução de planos multi-passo, em `packages/core/src/taskengine.ts`.
Substituiu, em `3f62706`, um `for` linear em `handlers.ts` que não tinha
persistência (`grep -rni checkpoint packages` devolvia **zero**), escrevia
`retries: 0` sem nunca incrementar, e em produção **sempre** devolvia
`INVALID_REQUEST` porque `main()` nunca injetava um agente.

Prova de ponta a ponta: `evidence/nomos-browser-final-loop/09-task/e2e-task.ts`
e o resumo em `evidence/nomos-browser-final-loop/16-regressao/verificacao-5-6-9.log`
(`TASK_ENGINE=PASS`, com `TASK_RESUME`, `TASK_IDEMPOTENCY`, `TASK_CANCEL`,
`TASK_CRASH_RECOVERY` e `TASK_CLEANUP` todos `PASS`).
Suíte: `tests/task-engine.test.ts` — **19 pass, 0 fail** (medido 2026-08-25).

---

## Pré-requisito

`browser.task` exige um `AIProvider` injetado no daemon. Sem `ai_provider`
configurado a rota devolve `INVALID_REQUEST` — não há motor de plano. Ver
`docs/CONFIGURATION.md`.

---

## Estados

Nove estados. É um **superconjunto** de `TaskState` do contrato v1: `RETRYING` e
`RECOVERING` não existem lá porque o runtime antigo não tinha nem retentativa
nem recuperação. O tipo vive no motor, e não em `contract.ts`, para não obrigar a
subir a versão do contrato e tocar todos os consumidores. O que atravessa a
fronteira HTTP continua sendo JSON, e `state` continua sendo uma string.

| Estado | Significa |
|---|---|
| `QUEUED` | Criada, ainda não começou. |
| `RUNNING` | Executando um passo. |
| `WAITING` | **No relógio** do backoff, ou aguardando condição externa. |
| `RETRYING` | A **decisão** de tentar de novo. |
| `PAUSED` | Parada esperando `resume` — tipicamente takeover humano. |
| `RECOVERING` | Encontrada em disco após queda do processo; sendo reavaliada. |
| `COMPLETED` | Final. |
| `FAILED` | Final. |
| `CANCELLED` | Final. |

`RETRYING` e `WAITING` são dois estados porque são duas coisas: `RETRYING` é
"vou tentar de novo", `WAITING` é "estou no relógio". Enquanto a task dorme 8 s
entre tentativas ela não está rodando, e chamar isso de `RUNNING` mentiria para
quem lê `GET /v1/tasks`.

## Tabela de transição

Transição fora da tabela **levanta** `TaskStateError` — não é logada e ignorada.
A tabela é uma constante congelada: ler `TASK_TRANSICOES` é ler a máquina de
estados inteira.

| De ↓ | Para |
|---|---|
| `QUEUED` | `RUNNING`, `PAUSED`, `CANCELLED`, `FAILED`, `RECOVERING` |
| `RUNNING` | `WAITING`, `RETRYING`, `PAUSED`, `CANCELLED`, `FAILED`, `COMPLETED`, `RECOVERING` |
| `WAITING` | `RUNNING`, `RETRYING`, `PAUSED`, `CANCELLED`, `FAILED`, `RECOVERING` |
| `RETRYING` | `WAITING`, `RUNNING`, `PAUSED`, `CANCELLED`, `FAILED`, `RECOVERING` |
| `PAUSED` | `RUNNING`, `CANCELLED`, `FAILED`, `RECOVERING` |
| `RECOVERING` | `QUEUED`, `RUNNING`, `CANCELLED`, `FAILED` |
| `COMPLETED` | *(vazio)* |
| `FAILED` | *(vazio)* |
| `CANCELLED` | *(vazio)* |

Duas decisões que merecem justificativa:

- **`RUNNING → PAUSED`** existe por causa do takeover humano. Quando o humano
  toma o volante, o passo devolve `CONTROL_HELD_BY_HUMAN`. Falhar a task ali
  seria punir o operador por operar; retentar seria martelar. Pausar e esperar
  `resume` é a única resposta honesta.
- **Os três estados finais têm lista vazia.** Não existe "reabrir" uma task
  `COMPLETED`: uma segunda execução é uma task nova, com `run_id` novo. É essa
  regra que faz a idempotência ter significado.

---

## Checkpoint

Atômico, por passo, gravado em `tasks_root`.

**O índice gravado é o do PRÓXIMO passo a executar**, não o do passo que acabou.
Retomar de um checkpoint nunca reexecuta um passo já confirmado. O checkpoint é
escrito **depois** do efeito e **antes** do passo seguinte: um checkpoint escrito
no fim é um checkpoint que nunca existe quando o processo morre no meio — que é
o único momento em que ele importa.

O **plano vive dentro do checkpoint**, porque retomar exige saber o que ainda
falta fazer, e o agente que gerou o plano pode não estar mais por perto.

A escrita é tmp + fsync + rename. `rename(2)` no mesmo filesystem é atômico: o
leitor vê o arquivo velho inteiro ou o novo inteiro, nunca metade. Um checkpoint
vazio seria **pior** que checkpoint nenhum — ele parece estado válido.

## Idempotência

`idempotency_key` opcional na criação. Chave já usada **devolve a task
existente**; não cria uma segunda.

A reserva é atômica **entre processos**, feita com `link(2)` num diretório
próprio (`_task_idempotency`, cujo nome começa com `_` justamente porque é
impossível para um `session_id`). `link(2)` falha com `EEXIST` quando o destino
existe, e falha **sem escrever** — não há janela entre "verifiquei" e "criei". A
reserva está em disco, portanto sobrevive a reinício do processo.

## Retry

`max_attempts` conta a **primeira** tentativa: `1` = sem retentativa. Default 3.
Backoff exponencial com **teto** e jitter *equal*.

Jitter *full* (`rnd() * teto`) pode devolver ~0 e derruba a própria razão de
existir do backoff — a tentativa 3 chegaria imediatamente após a 2. Jitter
*equal* garante metade do intervalo como piso e o intervalo cheio como teto. O
teto existe porque `2^n` sem limite chega a horas de espera na 12ª tentativa, e
uma task que espera horas em silêncio é indistinguível de uma task travada.

### O que NUNCA é retentado

| Código | Por quê |
|---|---|
| `CAPABILITY_DENIED`, `POLICY_BLOCKED`, `UPLOAD_DENIED`, `DOWNLOAD_DENIED` | A política não muda entre uma tentativa e a seguinte. Três tentativas produzem três `policy.deny` na trilha e nenhuma chance a mais de sucesso. Pior: para quem audita, um agente que insiste em ação negada é indistinguível de um agente comprometido. |
| `INVALID_REQUEST` | O pedido estará igualmente malformado na 3ª vez. |
| `ABORTED`, `CANCELLED` | Alguém mandou parar. Retentar é desobedecer. |
| `CONTROL_HELD_BY_HUMAN` | Não é falha: é o humano operando. Vira `PAUSED`. |
| `SESSION_NOT_FOUND` | Nenhuma quantidade de tentativas faz a sessão existir. |
| `INVALID_STATE_TRANSITION` | Defeito interno do runtime. Retentar esconderia o bug. |

### O que PODE ser retentado

`TIMEOUT`, `NETWORK`, `PROVIDER_DEGRADED`, `BROWSER_UNAVAILABLE`,
`SESSION_NOT_ACTIVE`, `NAVIGATION_FAILED`, `BACKPRESSURE_REJECTED`,
`TARGET_NOT_FOUND`, `TARGET_NOT_ACTIONABLE`, `TARGET_AMBIGUOUS`,
`CLICK_NOT_DELIVERED`.

O grupo de alvo exige cuidado e é retentável por um motivo específico: o passo
**reexecuta a cascata de resolução inteira, do zero**. Cada tentativa parte do
`TargetDescriptor`, nunca do `ResolvedTarget` da tentativa anterior. Reusar a
coordenada velha é que seria errado — e é justamente o que o runtime não faz.

### Código desconhecido não é retentado

Fail-closed. O contrário — "na dúvida, tenta de novo" — transforma todo bug novo
do runtime em três execuções do mesmo bug, e num efeito colateral triplicado
quando o passo já tinha mudado o mundo antes de estourar.

---

## Cancel

`POST /v1/tasks/:task_id/cancel`. Propaga por `AbortSignal` até o passo em voo.

Cancelamento **nunca vira fallback de provider**: cancelar é ordem, não falha.
Se você cancelou e viu o fallback rodar, isso é bug.

## Resume

`POST /v1/tasks/:task_id/resume`. Retoma do checkpoint — do **próximo** passo,
nunca repetindo efeito.

`resume` é rota de **gestão**, não de ação. Isso já causou um defeito real: sob
lease obrigatório, `taskHolders` só era populado na rota de ação `browser.task`,
então toda retomada de sessão de outro principal virava `CONTROL_NOT_OWNED`.
Corrigido em `8cd9fff`: a delegação é registrada na retomada e **solta no
`finally`** — delegação pendurada seria um token de controle vivo depois que o
solicitante foi embora.

## Crash recovery

Varredura no arranque do daemon. Nenhuma task fica `RUNNING` mentirosa: uma task
encontrada em disco vai para `RECOVERING` e recebe uma decisão explícita antes
de voltar a `QUEUED`/`RUNNING` ou terminar em `FAILED`/`CANCELLED`.
`task_recover_grace_ms` (30 s) é a janela de espera antes de decidir.

**Prova, com `SIGKILL` real no meio de 12 passos:** retoma em 6/12 e termina
12/12 com **zero passos repetidos** — medido contando as requisições no servidor
de fixture, ou seja, num ledger que o motor **não controla**. É essa
independência que faz a prova valer.

## Cleanup

Funil único. Toda saída — sucesso, falha, cancelamento, recuperação — passa pelo
mesmo caminho de liberação. Foi o que permitiu tratar a delegação pendurada.

O gate de cleanup já passou **por vacuidade** (mediu "não sobrou lease" num mundo
sem leases). Hoje ele compara contra uma linha de base independente, exige
**identidade** do `lease_id`, e foi validado por **mutação**: com a propriedade
cega, o teste reprova.

---

## Rotas

| Método | Rota | Nome |
|---|---|---|
| POST | `/v1/…` (ação `browser.task`) | executa um objetivo |
| GET | `/v1/tasks` | `tasks.list` |
| GET | `/v1/tasks/:task_id` | `tasks.get` |
| POST | `/v1/tasks/:task_id/cancel` | `tasks.cancel` |
| POST | `/v1/tasks/:task_id/resume` | `tasks.resume` |

As quatro últimas são rotas de **gestão**. A tabela normativa completa está em
`docs/API.md`.

## Eventos no audit

Treze, todos com `event: "task"` e `task_id` preenchido:

`task.created`, `task.started`, `task.progress`, `task.checkpoint`,
`task.retry`, `task.waiting`, `task.paused`, `task.resume`, `task.cancelled`,
`task.failed`, `task.recovering`, `task.completed`, `task.cleanup`.

Como lê-los: `docs/AUDIT.md`.
