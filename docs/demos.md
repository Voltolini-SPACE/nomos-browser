# Demos reproduzíveis

Seis roteiros, do controle básico ao replay. Cada um pode ser seguido à mão pela
CLI ou pela API — e todos são **executados** por
[`demos/rodar-demos.mjs`](../demos/rodar-demos.mjs) contra um runtime e um
Chromium reais.

```bash
node demos/rodar-demos.mjs
```

Um roteiro de demo sem execução é uma promessa. Com execução, é uma prova que
caduca: no dia em que o produto mudar, esta bateria falha.

Última execução: **6 demos, 0 falhas** (`DEMOS_REPRODUZIVEIS=PASS`).

**Requisitos comuns:** Node ≥ 22.6, `npx playwright install chromium`, portas
`7801` e `8991` livres. A bateria sobe o próprio runtime e a própria página de
teste; não depende de rede externa.

---

## Demo A — controle de navegador básico

**Objetivo:** provar que há um Chromium real do outro lado.

```bash
node packages/api/src/daemon.ts &
node packages/cli/src/main.ts health
node packages/cli/src/main.ts open http://127.0.0.1:8991/
```

**Esperado:** `/health` com `runtime=ok`; sessão criada; título da página lido do
navegador; e um alvo inexistente falhando **com código**
(`TARGET_NOT_FOUND`), nunca em silêncio.

---

## Demo B — modo ASK

**Objetivo:** ver a diferença entre ler e agir.

```bash
curl -X POST localhost:7777/api/v1/sessions/$SID/autonomy \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"ASK","by":"dono"}'
```

**Esperado:**

- `browser.extract` passa direto — **leitura não pergunta**;
- `browser.click` para e pede aprovação, com nível `A2` e a consequência
  *"clica num elemento da página"*;
- aprovada, a ação acontece e o efeito aparece na página.

---

## Demo C — modo AUTO

**Objetivo:** provar que `AUTO` não é bypass.

**Esperado:**

- `browser.goto` passa direto, sem perguntar;
- `browser.upload` **ainda pergunta**, com o motivo *"a ação envia dado seu para
  fora, e isso não se retira"*;
- negada, é recusada com `APPROVAL_DENIED`.

> **Nota da primeira execução.** A sessão da demo nascia sem capability de
> upload, e o upload era negado com `CAPABILITY_DENIED` antes de chegar a pedir
> aprovação. O roteiro estava errado, o produto não: o portão de **capability**
> roda antes do de **autonomia**. A demo passou a conceder a capability
> justamente para que quem recuse seja o portão que ela quer mostrar.

---

## Demo D — task multipasso

**Objetivo:** mostrar que aprovar um objetivo não é cheque em branco.

```bash
node packages/cli/src/main.ts task --session $SID "conferir o saldo exibido"
```

**Esperado:** `browser.task` pede aprovação **mesmo em `AUTO`** — nível `A5`,
consequência *"entrega um objetivo ao executor, que decidirá as ações sozinho"*.

Em `ASK`, cada **passo** do plano reentra no portão. Isso é medido em
`tests/task-engine.test.ts`, com mutação: dar ao executor de passo um caminho
privilegiado derruba o teste.

---

## Demo E — Live Agent Console

**Objetivo:** ver que o estado da tela vem do runtime.

**Esperado:**

- `/live` devolve `runtime_state`, `autonomy_mode` e `control` canônicos;
- declara quais rotas continuam perguntando em `AUTO`
  (`browser.task, browser.upload`);
- **pausar** muda `runtime_state` para `PAUSED` no backend;
- pausado, a ação é recusada com `AGENT_PAUSED`;
- **mas observar continua permitido** — a tela precisa seguir viva para o
  operador decidir se retoma.

---

## Demo F — auditoria e replay

**Objetivo:** mostrar que o histórico é somente leitura e íntegro.

```bash
node packages/cli/src/main.ts close $SID
node packages/cli/src/main.ts replay $SID
node packages/cli/src/main.ts replay verify $SID
```

**Esperado:**

- o replay traz as ações gravadas, com `selado=true`;
- o runtime **declara** `read_only: true` e `mode: "REPLAY"`;
- `POST`, `PUT`, `PATCH` e `DELETE` em `/replay` respondem `405`;
- sessão inexistente é `404`, não um replay vazio de `200`;
- `verify` responde `integro=true`, com `0` erros.

> **Três defeitos que esta demo encontrou.** A primeira execução reprovou aqui,
> e o verificador estava certo nas três vezes:
>
> 1. fechar a sessão pela API **nunca escrevia `result.json`** — todo bundle
>    reprovava com *"a sessão nunca fechou"*, sobre uma sessão que fechou;
> 2. **ler** o replay anotava `replay.read` no `actions.jsonl` da sessão, depois
>    do selo — uma rota somente leitura quebrando o que ela lê;
> 3. o registro de aprovação gravava o aprovador no campo `owner`, e a checagem
>    de troca de ator comparava **todos** os registros: uma sessão normal com
>    duas aprovações produzia 14 `TROCA_DE_DONO_SEM_EVENTO` por estar
>    funcionando como projetado.
>
> Os três estão corrigidos, cada um com teste e mutação que o derruba.

---

## Ver também

- [`quickstart.md`](quickstart.md) — os mesmos passos, comentados
- [`ask-mode.md`](ask-mode.md) · [`auto-mode.md`](auto-mode.md)
- [`audit-and-replay.md`](audit-and-replay.md)
