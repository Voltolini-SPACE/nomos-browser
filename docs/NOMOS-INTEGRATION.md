# NOMOS ↔ NOMOS Browser — integração por MCP

Como o NOMOS opera este navegador, quem decide o quê, e o que ainda depende do
dono. Tudo aqui é verificável: cada afirmação tem um comando ao lado.

---

## 1. O caminho

```
NOMOS (autoridade de ações)
  │  nomos mcp chamar <manifesto> <tool> --args '{...}'
  │      ├─ catálogo:  o manifesto está registrado? (SHA-256)   ← senão, recusa
  │      └─ gate:      nivel_da_tool(tool) → A0..A6 → policy.decide → gate()
  │                    A0 segue direto · A1+ exige aprovação humana
  ▼  (só se o gate passar)
subprocesso stdio, cwd = packaging/mcp/, comando do manifesto
  │  JSON-RPC 2.0, uma mensagem por linha, protocolVersion 2024-11-05
  ▼
packaging/mcp/servidor.mjs  →  packages/mcp/src/server.ts  ("nomos-browser-mcp")
  │  UMA chamada HTTP por tool, com Bearer NOMOS_BROWSER_TOKEN
  ▼
Browser Runtime — API v1 (http://127.0.0.1:7777)
  │  auth → escopo do token → lease da sessão → capability da sessão → ação
  ▼
Chromium
```

Três autoridades diferentes, e nenhuma delas é o adaptador:

| decide | quem | onde
|---|---|---
| se a tool pode rodar | **NOMOS** | `~/.nomos/policy.json` + gate interativo
| se este manifesto é confiável | **NOMOS** | `~/.nomos/mcp_catalogo.json` (SHA-256)
| se esta credencial pode esta rota | **Browser Runtime** | escopos do token, `packages/api/src/auth.ts`
| se esta sessão pode esta ação | **Browser Runtime** | capabilities + lease
| traduzir protocolo | `nomos-browser-mcp` | e **nada mais**

O adaptador não decide, não guarda token próprio, não abre navegador, não pede
capability. Ele traduz `tools/call` em um POST e devolve o envelope.

---

## 2. Classificação tool → categoria

O manifesto (`packaging/mcp/manifesto.json`) declara `nivel_padrao: "A5"` e o
mapa abaixo. **`nivel_padrao` é a trava para o desconhecido**: `nivel_da_tool` do
NOMOS devolve o piso para toda tool NÃO declarada, então uma tool nova que
ninguém classificar nasce como execução de código e exige o dono. Um piso mais
baixo faria o contrário — e é exatamente o erro que `scripts/ci.sh fast` passou a
impedir (`mcp:manifesto-classifica-todas-as-tools`).

| tool | categoria | por quê |
|---|---|---|
| `browser_observe` | **A0_READ_LOCAL** | lê a página **já carregada**: elementos, título, URL, árvore de acessibilidade. Não navega, não emite requisição nova, não muda um byte do DOM. Quem trouxe a página para lá foi um `browser_navigate` anterior — e aquele é A2. |
| `browser_find` | **A0_READ_LOCAL** | resolve um alvo **sem agir sobre ele**. É consulta ao DOM presente; devolve a estratégia que acertou. Nada é clicado. |
| `browser_extract` | **A0_READ_LOCAL** | lê texto/HTML do que está na tela. Sem requisição nova. O conteúdo ainda passa pela política `raw_web_content` do runtime antes de sair. |
| `browser_tabs` (`action=list`) | **A0_READ_LOCAL** | enumera abas abertas. |
| `browser_screenshot` | **A0_READ_LOCAL** | captura o que já está renderizado e devolve uma **referência**, não os bytes. É leitura de estado local. |
| `browser_navigate` | **A2_NET_EGRESS** | causa egresso: uma URL nova sai para a rede. |
| `browser_click` | **A2_NET_EGRESS** | um clique dispara navegação, XHR, submit. Não dá para saber antes — e classificar pelo caso benigno seria gate-shopping. |
| `browser_type` | **A2_NET_EGRESS** | digitar alimenta autocomplete, validação remota e formulário. Pode carregar `credential_ref`. |
| `browser_press` | **A2_NET_EGRESS** | `Enter` num formulário É o envio. |
| `browser_scroll` | **A2_NET_EGRESS** | rolagem dispara *lazy loading* e paginação infinita — egresso real, só que indireto. |
| `browser_download` | **A2_NET_EGRESS** | busca um arquivo na rede. (No runtime ainda exige a capability `download`, negada por padrão: **dois** gates, não um.) |
| `browser_upload` | **A2_NET_EGRESS** | manda um arquivo local **para fora**. É a direção mais cara do egresso. (Também exige capability `upload`.) |
| `browser_task` | **A5_CODE_EXEC** | entrega um objetivo em linguagem natural a um executor dirigido por modelo, que escolhe e encadeia os passos. O conjunto de ações não é conhecido antes de rodar. |

**Onde não classificamos para baixo.** `browser_scroll` e `browser_press`
parecem inofensivos e não são: rolagem carrega mais conteúdo da rede, e `Enter`
envia formulário. `browser_screenshot` poderia ter sido chamado de A4
(`DEVICE_SCREEN`, capturar tela) — não é: A4 é a **tela do dispositivo do dono**;
aqui é o viewport de um Chromium que o runtime controla, e o efeito é ler estado
que já existe. Continua A0 por ser leitura, não por ser conveniente.

---

## 3. O que roda headless e o que exige o dono

Medido com o binário real (`evidence/nomos-browser-final-loop/07-nomos/04-approvals-testar.txt`):

```
$ nomos approvals testar A0_READ_LOCAL "mcp:nomos-browser:browser_extract"
veredito: ALLOW — permitido pela política

$ nomos approvals testar A2_NET_EGRESS "mcp:nomos-browser:browser_navigate"
veredito: REQUIRE_APPROVAL — ação sensível: exige aprovação explícita
na prática: pediria a SUA aprovação; sem aprovador presente, o gate NEGA (fail-closed).
```

| roda sem o dono | exige o dono |
|---|---|
| `browser_observe`, `browser_find`, `browser_extract`, `browser_tabs`, `browser_screenshot` | `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_download`, `browser_upload`, `browser_task` |

Isto vem da política do dono (`~/.nomos/policy.json`: `A0_READ_LOCAL: ALLOW`,
o resto `REQUIRE_APPROVAL`, `A6: DENY`, `fail_closed: true`). Se ele mudar a
política, o comportamento muda no mesmo instante — nada aqui guarda cópia dela.

---

## 4. Registro (o que só o dono pode fazer)

O manifesto vive **fora** de `examples/mcp`, então `resolver_conector` do NOMOS
só o encontra por **caminho absoluto** — o campo `nome` não é aceito por
`confiar`/`chamar`.

```bash
# 0. conferir tudo e ver a impressão digital (não pede nada, não aprova nada)
bash scripts/nomos-register.sh

# 1. subir o runtime, se ainda não estiver de pé
node packages/api/src/daemon.ts          # ou: scripts/service.sh instalar

# 2. o conector herda o ambiente de quem roda o nomos
export NOMOS_BROWSER_URL=http://127.0.0.1:7777
export NOMOS_BROWSER_TOKEN_FILE=$HOME/.nomos-browser/control-token

# 3. inspecionar (num TERMINAL; pede "ACEITO O RISCO" enquanto experimental)
nomos mcp conectar /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json

# 4. registrar — escolha UMA porta
nomos mcp confiar /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json
nomos mcp confiar /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json --panel
```

Impressão digital atual (SHA-256 do manifesto canônico):

```
d267002feb6f9e4a8d24331fa75eb504629515469e9f07b2deb94edd803e0ffe
```

Só `nome`, `comando`, `nivel_padrao` e `tools` entram nesse hash. `descricao`,
`env` e `signature` ficam de fora — dá para corrigir a descrição depois sem
derrubar a confiança já registrada. Mudar **qualquer** um dos quatro derruba.

Por que `comando: ["node", "servidor.mjs"]` e não o caminho do `server.ts`: o
comando entra no hash, e um caminho com `../..` amarraria a confiança do dono ao
layout do repositório. `packaging/mcp/servidor.mjs` fica ao lado do manifesto
(que é o `cwd` do subprocesso) e resolve o servidor a partir do próprio caminho.

---

## 5. Sessão — o chamador não precisa saber que existe

Um `nomos mcp chamar` é **one-shot**: sobe o conector, executa, encerra. Então:

* a primeira tool sem `session_id` faz o adaptador criar UMA sessão pela rota
  normal (`POST /api/v1/sessions`) — **sem pedir capability**, o que faz o
  runtime aplicar o default restrito (download/upload/send/purchase/payment/
  delete negados);
* o runtime, no mesmo ato, concede o **lease exclusivo** ao principal do token.
  Sob `allow_unleased:false` (o default) isso não é luxo: sessão sem dono faria
  toda ação seguinte bater em `CONTROL_NOT_OWNED`;
* o `session_id` volta no **cabeçalho de toda resposta**
  (`route=… session_id=… http=… action_id=… state=…`). Quem quiser continuar
  repassa esse id na chamada seguinte; quem não quiser, ignora a linha.

Sem essa devolução, o bootstrap automático seria via de mão única: cada chamada
abriria uma aba em branco nova. Provado em `tests/mcp.test.ts` ("2e.") e no caso
`09b` do cliente fiel — o adaptador é morto com SIGKILL e a sessão **sobrevive**,
porque quem guarda estado é o runtime.

---

## 6. Como verificar

```bash
# transporte ponta a ponta contra daemon + Chromium reais (18 casos)
node evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts
#   → NOMOS_TRANSPORT_E2E=PASS

# unidade do adaptador (30 testes) e tipos
node --test tests/mcp.test.ts
npx tsc --noEmit -p tsconfig.json

# guardas de manifesto (dentro do estágio rápido)
bash scripts/ci.sh fast
#   mcp:manifesto-classifica-todas-as-tools   OK
#   mcp:lancador-do-manifesto-fala-mcp        OK

# estado do registro no NOMOS do dono
bash scripts/nomos-register.sh | tail -1
```

`evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts` é um cliente stdio
**reimplementado a partir do fonte do `ClienteMCP` do NOMOS** — mesmo handshake,
mesmo framing, mesmo `cwd`, mesma anotação de nível pelo manifesto. Ele existe
para que "o NOMOS consegue falar com isto" seja uma medição, e não uma suposição
apoiada num SDK que o NOMOS não usa.
