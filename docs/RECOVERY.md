# Recuperação — o que sobrevive ao quê

O ponto que define o produto é que **o estado da navegação pertence ao Runtime,
não ao modelo**. Este documento diz, caso a caso, até onde essa frase é
verdadeira — e onde ela para.

Fonte: `packages/core/src/recovery.ts`, `packages/observability/src/watchdog.ts`,
`tests/recovery-watchdog.test.ts` (24 pass), `tests/watchdog-wired.test.ts`
(8 pass), `tests/product02-gate.test.ts`, e as evidências citadas em cada linha.

---

## Resumo

| Evento | Sobrevive? | Como |
|---|---|---|
| Queda do **cliente** (agente sai, morre, é trocado) | **Sim** | `detach` não mata a sessão; `attach` retoma com abas, cookies e URL preservados. |
| Queda do **WebSocket** `/events` | **Sim** | O canal é observação, não controle. Reconectar (com credencial) retoma o feed. Eventos perdidos na janela **não** são reentregues. |
| **Takeover** humano | **Sim** | A sessão congela inteira; `release` devolve. |
| **Handoff** entre agentes | **Sim** | URL e estado da página preservados. Só move o lease com `to_holder`. |
| Queda do **processo do runtime** (`SIGKILL`) | **Sim, com decisão explícita** | Snapshot atômico em disco + varredura no arranque. |
| Morte do **navegador** | **Não** — a sessão não volta | Detectada pelo watchdog; lease e fila são liberados em vez de ficarem órfãos. |
| **Reboot da máquina** | **Não testado** | Só simulado com `launchctl kickstart -k`. |

---

## Queda do cliente

O caso do PRODUCT-01, e o mais fácil: o cliente é observador e comandante, nunca
dono do estado. `detach` não fecha nada. A sessão continua listada, e `attach`
devolve a mesma sessão com as mesmas abas.

Provado em `tests/e2e-gate.test.ts` (`RUNTIME_INDEPENDENCE_PASS=YES`): detach →
sessão viva e listada → attach → URL e conteúdo preservados.

## Queda do WebSocket

`/events` é um canal de **observação**. Derrubá-lo não afeta a sessão, não
cancela ação em voo e não solta lease.

Reconectar exige credencial **no handshake** (T7, fechado em `8cd9fff`): sem
credencial válida o upgrade é recusado (`401` sem credencial, `403` sem escopo) e
o socket é destruído. Nunca é aceito-e-mudo — um socket aberto que não entrega
evento é indistinguível, para o cliente, de um que foi negado.

**O que não sobrevive:** eventos emitidos enquanto você estava desconectado. O
buffer é limitado (`event_buffer`, 1000) e não é um log durável. Para reconstruir
o que aconteceu, a fonte é a **trilha de auditoria**, não o feed.

## Takeover

O humano assume; a sessão **congela inteira**, inclusive leitura.

Isso já foi "corrigido" para o lado errado uma vez: liberar `OBSERVE` durante o
controle humano, para a UI continuar espelhando. Errado — o humano assume o
volante justamente para digitar o que não quer delegar (senha, 2FA), e ler o DOM
nesse instante é o vazamento que o takeover existe para impedir. Revertido. A
correção certa foi a UI parar de pedir screenshot enquanto congelada.

Para uma task em execução, o passo devolve `CONTROL_HELD_BY_HUMAN` e a task vai
para `PAUSED` — não falha e não retenta.

## Handoff

`NOMOS → AGENTE-B → NOMOS` preservando URL e estado da página
(`HANDOFF_PASS=YES`, `tests/e2e-gate.test.ts`).

Desde `8cd9fff` o handoff **só move o lease com `to_holder`**. `to_owner` é
rótulo livre; arrastar o lease para um rótulo trancaria a sessão para todo mundo.
E o principal é o **sujeito do token**, nunca um header auto-declarado.

Handoff, takeover e release deixam **linha própria** na trilha — antes de
`bc7130f` as três operações passavam com `HTTP 200` e **zero** linhas.

## Queda do processo do runtime

O caso duro. Depois de um `SIGKILL` o que sobra é um diretório em disco e,
talvez, um Chromium vivo. O trabalho é decidir o que fazer com isso **sem
inventar estado**.

**Escrita atômica.** `SIGKILL` no meio de um `write()` deixa `state.json`
truncado, e um snapshot pela metade é pior que nenhum: ele *parece* estado
válido. Por isso tmp + fsync + rename. O tmp truncado que sobra é inerte —
`list()` só reconhece o nome exato `state.json`.

**Quatro decisões, nenhum default.** Toda sessão encontrada recebe uma decisão
explícita, com motivo registrado:

| Decisão | Quando |
|---|---|
| `reattach` | O browser está vivo, responde no CDP **e** é provadamente o mesmo browser que este runtime gravou. Reata via `connectOverCDP`. |
| `recover` | O browser está alcançável, mas a sessão não pode voltar a `ACTIVE` como se nada tivesse acontecido: havia ação em voo, ou a URL/as abas divergiram do snapshot. Vai para `RECOVERING` e reobserva. |
| `orphan` | Havia um processo e ele não está mais sob nosso controle: pid morto, pid vivo mas CDP mudo, ou identidade que não confere. **Nada é morto** — um pid gravado antes do crash pode ter sido reciclado pelo SO para um processo alheio. |
| `terminate` | O snapshot não descreve sessão alguma (corrompido, schema desconhecido, sessão já `CLOSED`). Retira-se o **snapshot**. `terminate` nunca mata processo. |

**Identidade, não "a porta respondeu".** Porta de CDP é reciclada. Se o Chromium
do snapshot morreu e outro qualquer subiu na mesma porta, "o CDP responde" faria
o runtime dirigir o navegador de outra pessoa. `browser_pid` morto ⇒ `orphan`,
nunca `reattach`.

**Medido:** `SIGKILL` real no processo do daemon, `RECOVERY_PASS=YES`, **3/3**
(`evidence/nomos-browser-final-validation/04-recovery/recovery-repeticao.log`).
Tasks: `SIGKILL` no meio de 12 passos, retoma em 6/12, termina 12/12 com **zero
passos repetidos**.

**Fragilidade documentada, não escondida:** uma execução independente do mesmo
gate, **sob contenção de memória**, falhou com `Error: kill ESRCH` — o daemon
filho morreu sozinho antes do `SIGKILL` do teste, depois de ~150 s de carga de
LLM. Sob condição limpa não reproduziu em 3 tentativas. Classificação honesta:
**PASS com fragilidade conhecida sob pressão de memória**, não PASS
incondicional.

## Morte do navegador

**A sessão não volta.** O que o produto garante aqui é outra coisa: que a morte
seja **detectada** e que os recursos sejam **liberados**.

A sonda antiga usava `context.pages()`, que devolve `[]` sobre contexto morto
**sem lançar** — ficava verde sobre navegador morto. Trocada por `cookies()`, que
vai até o alvo. O defeito que isso escondia era grave: com o navegador morto, o
**lease e a fila ficavam órfãos para sempre**, porque sem navegador nada mais
expira.

O watchdog roda três sondas (navegador morto, worker preso, task estagnada) com
backoff, teto e janela. Ao estourar `watchdog_max_restarts` o runtime entra em
**degradação terminal** com evento no audit, em vez de girar para sempre — T10
do modelo de ameaça: um watchdog sem teto transforma falha em negação de serviço
local.

## Reinício do serviço (launchd)

- Saída **limpa** não é ressuscitada (`KeepAlive.SuccessfulExit=false`).
- `SIGKILL` é seguido de reinício com **PID novo**.
- Crash-loop é freado pelo `ThrottleInterval` (medido: 4 tentativas em janela de
  32 s, teto 5).
- Segundo `start` é recusado (`rc=9`), mesmo PID — instância única por lockfile
  com PID **e** checagem de porta.

11/11 passos em
`evidence/nomos-browser-final-loop/14-supervisor/out/supervisor.json`.

---

## O que NÃO sobrevive

Declarado aqui para que a ausência não passe por sucesso.

1. **Reboot real da máquina.** Nunca executado — a máquina de prova é de
   produção. O que existe é `launchctl kickstart -k`, declarado como
   **simulação**. Ninguém pode afirmar hoje que o serviço volta depois de um
   boot frio.
2. **A página aberta quando o navegador morre.** Não há reabertura automática de
   abas a partir do snapshot: `recover` reobserva o que existe, não recria o que
   sumiu.
3. **Eventos do WebSocket perdidos na desconexão.** O feed não é durável. Use a
   trilha de auditoria.
4. **Estado de sessão entre máquinas.** O runtime assume **um dono, uma
   máquina**. Não há replicação nem migração de sessão.
5. **Isolamento de falha entre sessões.** Não há sandbox de processo por sessão:
   todas compartilham o processo do runtime. Foi exatamente isso que transformou
   o crash do download bloqueado (`ae4bff1`) em falha de **todas** as sessões
   simultaneamente. O defeito específico foi corrigido; a propriedade estrutural
   continua valendo.
6. **Integridade do replay contra adversário com escrita.** O selo é hash **sem
   chave**: quem tem permissão de escrita no diretório da sessão pode adulterar
   **e resselar**. Ver `docs/LIMITATIONS.md`.
