# FASE 0 — o que já existe, e onde a camada nova encaixa

```
GA_BASELINE_INTACT=YES        HEAD=b7d84a9 · v0.2.0 -> e9a847c · árvore limpa
CURRENT_RUNTIME_MAPPED=YES
UI_INTEGRATION_POINTS_MAPPED=YES
```

A regra desta fase é "não reimplementar o que já existe", e ela muda bastante o
tamanho da missão: **boa parte das FASES 6, 7, 10, 11, 12 e 15 já tem base
construída.** O que é genuinamente novo é a camada de **autonomia e aprovação** —
e é ela que não existe em lugar nenhum hoje.

---

## 1. Runtime — o que já está pronto

| Necessidade da missão | Já existe? | Onde |
|---|---|---|
| sessão (criar, listar, ler, fechar) | **sim** | `POST/GET/DELETE /api/v1/sessions[/:id]` |
| attach / detach | **sim** | `sessions.attach` · `sessions.detach` |
| ownership (handoff) | **sim** | `sessions.handoff` |
| **assumir controle** | **sim** | `sessions.takeover` |
| **devolver controle** | **sim** | `sessions.release` |
| lease (get/acquire/release/renew/transfer/takeover) | **sim** | `/sessions/:id/lease*` |
| tabs | **sim** | `browser.tabs` · `new_tab` · `switch_tab` · `close_tab` |
| ações | **sim** | `POST /api/v1/browser.<verbo>` |
| screenshot / frame | **sim** | `browser.screenshot` → `screenshot_url` |
| **cancelamento** | **sim** | `tasks.cancel` + barge-in validado na v0.2.0 |
| auditoria | **sim** | `sessions/<id>/actions.jsonl`, 19 campos |
| replay | **parcial** | `replay.verify` existe; falta a leitura para revisão |
| eventos ao vivo | **sim** | `GET /events` (WebSocket) |
| whoami / config / queues | **sim** | `/whoami` · `/config` · `/queues` |
| **aprovação humana** | **NÃO** | — |
| **modo de autonomia (ASK/AUTO)** | **NÃO** | — |

## 2. UI — o que já está pronto

`packages/ui/src/app.html`, 453 linhas, servido por `serve.ts`, com tokens de
marca injetados por `build.ts`.

Já tem:

- **tela ao vivo** (`#tela`) — espelhada por `browser.screenshot{scope:viewport}`
  a cada 1200 ms, usando `screenshot_url` (bytes reais, não o ref opaco);
- **cursor do agente** (`#cursor`, `#cursorAcao`);
- **faixa de controle humano** (`#humano`) — "Ações do agente congeladas";
- botões **Pausar**, **Assumir controle**, **Parar**;
- **WebSocket** para `/events`, com token na query (o navegador não deixa mandar
  header no handshake);
- listagem de sessões, feed, e painéis de tasks/agents/skills/downloads/history.

Não tem: modo de autonomia, centro de aprovação, os indicadores obrigatórios da
FASE 19, e os campos por item exigidos na FASE 8.

## 3. Eventos — o que falta nomear

`EventName` (`packages/core/src/contract.ts:389`) tem 38 nomes. Já cobrem:
`task.paused`, `control.taken`, `control.returned`, `session.closed`,
`action.started/completed/failed`.

**Faltam** os da FASE 28: `autonomy.changed`, `action.proposed`,
`action.approved`, `action.denied`, `cancel.requested`, `cancel.accepted`,
`cancel.too_late`, `owner.changed`, `agent.resumed`, `emergency_stop`.

## 4. Onde a camada nova encaixa — e por que exatamente ali

O runtime tem **um único ponto** por onde toda ação passa antes de tocar o
Chromium: `packages/api/src/daemon.ts:~1625`.

```ts
const capability = capabilityFor(tool);

// 1. CAPABILITY — antes de qualquer contato com o navegador.
const decision = services.policy.check(tool, info.permissions, info.owner);
if (!decision.allowed) { /* 403 CAPABILITY_DENIED, auditado */ }

// ← 2. AQUI entra o gate de AUTONOMIA/APROVAÇÃO

// 3. execução
```

A ordem não é arbitrária, e ela é a própria hierarquia que a missão exige:

```
USER POLICY            capabilities da sessão — nega em 403, e isso é final
      ↓
AUTONOMY MODE          ASK/AUTO — só decide se PAUSA, nunca se PERMITE
      ↓
NOMOS CAPABILITY       nível A0..A5 do manifesto + fatores de risco
      ↓
APPROVAL GATE          WAITING_APPROVAL até um humano decidir
      ↓
ACTION
```

O ponto que essa ordem protege: **o modo de autonomia só pode adicionar fricção,
nunca remover.** Ele roda DEPOIS do gate de capability, então uma ação que a
política do dono nega continua negada em `AUTO`. E uma ação classificada como
"aprovação obrigatória" continua parando em `WAITING_APPROVAL` em `AUTO` —
porque quem decide isso é a matriz de nível, não o modo.

`AUTO` significa *"execute sozinho tudo o que eu já autorizei"*. Nunca
*"ignore as proteções"*.

## 5. O que a UI não pode fazer

O contrato da FASE 1 existe por um motivo: hoje a UI **infere** estado. Ela
descobre "controle humano" por um flag local e desenha a faixa. Se o runtime e a
tela discordarem, quem está errado é a tela — e o usuário não tem como saber.

A partir daqui: todo estado vem do runtime, nomeado, e a UI só desenha.
