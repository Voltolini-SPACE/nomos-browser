# Live Agent Console

A tela onde o dono vê o agente trabalhar, autoriza o que precisa de
consentimento e interrompe o que não devia ter começado.

Servida pelo **próprio runtime**, na mesma origem, com CSP
`connect-src 'self'`. A alternativa seria liberar CORS para um servidor de UI
separado, e isso abriria a ameaça T7 do [`SECURITY.md`](SECURITY.md): com
`Access-Control-Allow-Origin` permissivo, qualquer página aberta no navegador do
dono passaria a conseguir dirigir o runtime.

```bash
node packages/api/src/daemon.ts
# abra a URL com o token que o daemon imprime
```

## O que a tela mostra

| região | conteúdo |
|---|---|
| **Faixa de estado** | agente, sessão, status, autonomia, dono, ação atual |
| **Palco** | espelho da página + cursor do agente com o rótulo do que ele está fazendo |
| **Feed** | atividade com `action_id`, capability, status, nível e duração |
| **Aprovação** | modal de tela cheia quando uma ação precisa de consentimento |
| **Histórico** | replay somente leitura da sessão selecionada |
| **Controles** | Pausar · Cancelar ação · Assumir controle · Parar |

## A regra que governa a tela

> **A interface nunca infere estado que o runtime fornece.**

`runtime_state`, `autonomy_mode`, `read_only`, `control` e a fila de aprovações
vêm no corpo da resposta de `/live`. A tela **lê**. Ela não deduz "parece
encerrada" nem "provavelmente ainda está em automático".

Isso tem consequências visíveis:

- o selo **SOMENTE LEITURA** do histórico acende pelo campo `read_only` do
  runtime, não porque a sessão parece velha;
- quando o runtime informa `too_late` num cancelamento, a tela diz *"A ação já
  havia sido concluída antes do cancelamento"* — nunca "Cancelado", que seria
  uma mentira confortável;
- quando o estado não pode ser lido, a tela **diz que não sabe**.

## Estados

`IDLE` · `OBSERVING` · `THINKING` · `ACTING` · `WAITING_APPROVAL` · `PAUSED` ·
`USER_CONTROL` · `CANCELLING` · `CANCELLED` · `COMPLETED` · `ERROR` ·
`DISCONNECTED`

A precedência quando mais de um se aplica:

```
USER_CONTROL > WAITING_APPROVAL > PAUSED > ACTING > IDLE > COMPLETED
```

O controle humano vem primeiro porque é o único estado em que o agente não pode
fazer nada — inclusive observar.

## Controles

### Pausar / Retomar

Bloqueia toda ação que não seja observação. **Observar continua permitido**: a
tela precisa seguir viva para o operador decidir se retoma.

Pausar é `CONTROL`; retomar é `ADMIN`. A assimetria é deliberada — ver
[`auto-mode.md`](auto-mode.md#quem-pode-ligar).

### Cancelar ação

Pede o cancelamento da ação em curso. Três desfechos possíveis, e a tela
distingue os três: aceito, tarde demais (`too_late`), ou não havia o que
cancelar.

### Assumir controle

Congela o agente e entrega o volante ao humano. Enquanto o humano tem o volante,
**toda** ação do agente é recusada com `CONTROL_HELD_BY_HUMAN` — inclusive
leitura, porque é nesse momento que o humano digita senha ou 2FA.

Ao devolver o volante, o agente é obrigado a **reobservar** antes de agir
(`REOBSERVE_REQUIRED`). Devolver o controle não devolve o **conhecimento**: a
página pode ter mudado enquanto o humano estava lá.

### Parar

Parada de emergência. Roda **inteira no backend** — provado abandonando a
conexão no meio e conferindo que a interrupção termina sozinha. Se a interface
cair durante o kill, o backend continua.

## Aprovação

Quando uma ação precisa de consentimento, o modal toma a tela e **intercepta os
cliques por baixo**, de propósito: não deve ser possível mexer no rádio de
autonomia enquanto se decide uma aprovação.

O modal mostra ação, onde, nível, consequência, motivo e parâmetros — com
segredo mascarado. Ver [`ask-mode.md`](ask-mode.md#o-que-aparece-quando-ele-pergunta).

## Histórico

Aba **History**: replay somente leitura da sessão selecionada, com contagens,
selo, e alerta quando a leitura foi incompleta.

O painel **não contém nenhum controle que aja** — só um botão "Recarregar", que
é leitura. Isso é medido contando `button, input, select, textarea, a[href]`
dentro do painel: a lista precisa ficar vazia fora do botão de recarga.

"Somente leitura" aqui não é um botão desabilitado que pode voltar a habilitar.
É a ausência da alavanca, sustentada por uma tabela de rotas onde não existe
verbo de escrita.

## Latência — o que a tela mostra e quando

| caminho | p50 medido | n |
|---|---|---|
| evento do runtime → tela (WebSocket) | 1,0 ms | 62 |
| quadro do navegador → tela (espelho) | ~18 ms | 30 |
| clique de aprovar → runtime | 1,0 ms | 30 |
| freio → runtime pausado | 3,0 ms | 30 |
| tomada de controle | 1,0 ms | 30 |

**A faixa de estado é a exceção, e ela precisa ser dita:** `/live` é lido por
**polling de 700 ms**. Uma mudança de estado aparece na faixa em até 700 ms *por
projeto*. Os eventos chegam em 1 ms; a faixa não.

`p99` não é reportado em nenhum caminho: 30 amostras exigem 100 para sustentar
um p99, e o instrumento devolve `null` em vez de chamar o máximo observado de
p99.

## Marca

A interface **não contém nenhuma cor literal**. Os tokens são lidos do cofre da
marca a cada build (`node packages/ui/build.ts`) e injetados no lugar de um
marcador. O teste `tests/ui-build.test.ts` falha se um hexadecimal aparecer no
fonte.

Isso é exigência do contrato de governança de marca, não estilo: um
`tokens.css` versionado seria um arquivo intermediário, e outras peças passariam
a lê-lo em vez de ler o brandbook.

## Ver também

- [`ask-mode.md`](ask-mode.md) · [`auto-mode.md`](auto-mode.md)
- [`audit-and-replay.md`](audit-and-replay.md)
- [`API.md`](API.md) — rotas `live.state`, `approvals.*`, `agent.*`
