# NOMOS ↔ NOMOS Browser — integração por MCP

> **Caminhos nesta página.** `$REPO` é a raiz deste repositório e `$GI` a raiz do
> projeto da Gi. Eles aparecem como variáveis em vez de caminhos absolutos porque
> um caminho absoluto embutido diz o nome de usuário de quem escreveu e não
> funciona para mais ninguém:
>
> ```bash
> REPO="$(git rev-parse --show-toplevel)"
> GI="${GI:-$(dirname "$REPO")/pocket-assistant}"
> ```


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
| `browser_tabs` | **A0_READ_LOCAL** | enumera abas abertas. SÓ isso: não abre, não foca, não fecha. |
| `browser_tab_switch` | **A1_WRITE_LOCAL** | muda qual aba é a ativa. Nada sai para a rede, mas a partir dali toda leitura fala de outra página — é escrita de estado local, não leitura. |
| `browser_tab_close` | **A1_WRITE_LOCAL** | descarta uma aba e o que estava carregado nela. Mutação local, sem egresso. |
| `browser_screenshot` | **A0_READ_LOCAL** | captura o que já está renderizado e devolve uma **referência**, não os bytes. É leitura de estado local. |
| `browser_navigate` | **A2_NET_EGRESS** | causa egresso: uma URL nova sai para a rede. |
| `browser_tab_open` | **A2_NET_EGRESS** | abre aba nova; com `url`, ela sai para a rede antes de qualquer leitura. |
| `browser_click` | **A2_NET_EGRESS** | um clique dispara navegação, XHR, submit. Não dá para saber antes — e classificar pelo caso benigno seria gate-shopping. |
| `browser_type` | **A2_NET_EGRESS** | digitar alimenta autocomplete, validação remota e formulário. Pode carregar `credential_ref`. |
| `browser_press` | **A2_NET_EGRESS** | `Enter` num formulário É o envio. |
| `browser_scroll` | **A2_NET_EGRESS** | rolagem dispara *lazy loading* e paginação infinita — egresso real, só que indireto. |
| `browser_download` | **A2_NET_EGRESS** | busca um arquivo na rede. (No runtime ainda exige a capability `download`, negada por padrão: **dois** gates, não um.) |
| `browser_upload` | **A2_NET_EGRESS** | manda um arquivo local **para fora**. É a direção mais cara do egresso. (Também exige capability `upload`.) |
| `browser_task` | **A5_CODE_EXEC** | entrega um objetivo em linguagem natural a um executor dirigido por modelo, que escolhe e encadeia os passos. O conjunto de ações não é conhecido antes de rodar. |

**Uma ferramenta, uma classe de risco.** O NOMOS classifica por FERRAMENTA, não
por argumento — então o nível declarado vale para o **pior** que a ferramenta
sabe fazer. `browser_tabs` era A0 e despachava quatro rotas, entre elas
`browser.new_tab`: a política do dono devolveu `ALLOW` para "ler arquivos locais"
e a chamada **abriu uma aba na rede, headless, sem aprovação** (verbatim em
`evidence/nomos-browser-final-closeout/01-mcp/03-exploit-tabs.txt`). A correção
não foi validar melhor o `action`, foi partir a ferramenta em quatro, cada uma
com uma rota e um nível. O guarda que impede a volta é
`scripts/verificar-risco-mcp.ts` (passo `mcp:risco-por-tool-coerente` do estágio
`security`): ele mantém uma tabela explícita `rota → classe de risco`
(leitura/mutação/egresso) cobrindo as 23 rotas do contrato, lê as rotas de cada
ferramenta de **duas** fontes independentes — o campo `routes` e as chamadas
`call(...)` no corpo de `tools.ts` — e reprova quando o nível declarado é menor
que o exigido pela pior rota. Rota nova no contrato sem classe de risco também
reprova.

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
| `browser_observe`, `browser_find`, `browser_extract`, `browser_tabs`, `browser_screenshot` | `browser_navigate`, `browser_tab_open`, `browser_tab_switch`, `browser_tab_close`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_download`, `browser_upload`, `browser_task` |

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
nomos mcp conectar $REPO/packaging/mcp/manifesto.json

# 4. registrar — escolha UMA porta
nomos mcp confiar $REPO/packaging/mcp/manifesto.json
nomos mcp confiar $REPO/packaging/mcp/manifesto.json --panel
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

### 5.1 A sessão sobrevive entre chamadas one-shot (CLOSEOUT-2)

Devolver o `session_id` na resposta tornou a continuidade **possível**, mas só
para quem lesse a resposta e repassasse o id. O NOMOS não repassa: ele chama a
tool. Medido com o binário real e o manifesto registrado, duas chamadas seguidas
produziram **duas sessões** (`ses_ac4cc2dd…` e `ses_d77016fe…`, `SESSOES_VIVAS=2`
acumuladas) — e por isso `browser_extract` depois de abrir uma aba devolvia
`TARGET_NOT_FOUND`: a página estava na sessão anterior. Cada chamada também
vazava uma sessão que ninguém fechava.

O adaptador passou a **persistir** a sessão resolvida:

```
<runtime_dir>/mcp-session.json      # runtime_dir = NOMOS_BROWSER_RUNTIME_DIR ou ~/.nomos-browser
{ "session_id": "...", "runtime_url": "http://127.0.0.1:7777",
  "criada_em": "...", "owner": "mcp:nomos-browser-mcp" }
```

Regras, todas fail-safe (nenhuma delas derruba a chamada do agente):

| situação | o que acontece |
|---|---|
| arquivo existe, mesmo `runtime_url`, sessão viva | **reusa** — readquire o lease (reentrante) e chama `POST /sessions/:id/attach`, o que grava `session.attach` + `task.resume` + `lease.acquired` em `sessions/<id>/actions.jsonl` |
| sessão morta, fechada ou 404 | cria outra **em silêncio** e regrava o arquivo |
| `runtime_url` diferente | ignora o id: ele não significa nada em outro daemon |
| lease de **outro** principal (`CONTROL_NOT_OWNED`) | desiste do reuso e cria uma sessão nova — `allow_unleased` continua `false`, nada é roubado |
| arquivo corrompido/ilegível | trata como ausente |

**Corrida entre processos.** Dois `nomos mcp chamar` simultâneos não podem criar
duas sessões nem corromper o arquivo. A criação acontece sob uma trava
`link(2)`/EEXIST em `<runtime_dir>/mcp-session.lock` — a mesma primitiva da
idempotência do task engine (`packages/core/src/taskengine.ts`) — e a gravação é
`tmp` + `rename(2)`, atômica. Trava mais velha que 10 s é considerada abandonada
e quebrada, para que um cliente morto com SIGKILL não tranque o adaptador.

**Saída explícita do dono — e por que não é uma tool.**

```bash
node packaging/mcp/servidor.mjs --sessao            # qual é a sessão durável
node packaging/mcp/servidor.mjs --encerrar-sessao   # fecha no runtime e apaga o registro
NOMOS_BROWSER_MCP_SESSION=efemera nomos mcp chamar …  # UMA chamada sem persistência
```

Um `browser_session` com `action=close` (que seria A1) foi **recusado** por
quatro motivos: (1) quem precisa encerrar é o dono, e ferramenta é o que o
*agente* chama — dar o botão de desligar ao agente não dá nada ao dono; (2)
`action=…` é exatamente a forma que acabou de ser removida de `browser_tabs`, e
reintroduzi-la é como o defeito volta; (3) toda tool nova muda o SHA-256 do
manifesto e cobraria do dono uma **segunda** reassinatura por uma conveniência;
(4) o dono nunca precisou de tool para isso — `DELETE /api/v1/sessions/:id` já
existe, o que faltava era saber *qual* id, e é isso que o arquivo passou a dizer.
O daemon nunca é morto por esse caminho.

---

### 5.2 Quando o manifesto muda

O SHA-256 registrado cobre `nome`, `comando`, `nivel_padrao` e `tools` — e nada
mais (`descricao`, `env` e `signature` ficam de fora). **Acrescentar, remover ou
reclassificar uma tool muda o hash**, e o NOMOS volta a tratar o conector como
**experimental**: `nomos mcp conectar` e `nomos mcp chamar` recusam com
`[NOMOS-E002]`. Isso é fail-closed por desenho e **não deve ser contornado** —
uma correção de segurança que continuasse rodando sob a assinatura antiga
significaria que a assinatura não valia nada.

Foi o que aconteceu no CLOSEOUT-2: `browser_tabs` virou quatro ferramentas
(`browser_tabs` A0, `browser_tab_open` A2, `browser_tab_switch` A1,
`browser_tab_close` A1) para fechar a elevação de privilégio, e o hash mudou:

```
antes  d267002feb6f9e4a8d24331fa75eb504629515469e9f07b2deb94edd803e0ffe
depois 317f15893e9ebd83afa17d11f66dd896c83342858ad723e0f4ed7afd32e27207
```

O procedimento — **o passo 3 só o dono pode dar**:

```bash
# 1. conferir o que mudou e ver a nova impressão digital (não aprova nada)
bash scripts/nomos-register.sh
#    → NOMOS_MCP_REGISTRADO=NAO  impressao=317f1589…  (BLOQUEADO_POR_APROVACAO)

# 2. inspecionar o conector antes de confiar (TERMINAL; pede "ACEITO O RISCO")
"$(command -v nomos)" mcp conectar $REPO/packaging/mcp/manifesto.json

# 3. RE-REGISTRAR — escolha UMA porta; as duas pedem o dono
"$(command -v nomos)" mcp confiar $REPO/packaging/mcp/manifesto.json
#    (terminal interativo; pede a palavra CONFIO)
"$(command -v nomos)" mcp confiar $REPO/packaging/mcp/manifesto.json --panel
#    (fila do painel do dono em http://127.0.0.1:8795, single-use, com TTL)

# 4. conferir que o catálogo passou a mostrar a impressão NOVA
"$(command -v nomos)" mcp catalogo
#    → ✓ nomos-browser  [317f15893e9ebd83…]

# 5. reexecutar a prova de integração ponta a ponta
bash evidence/nomos-browser-final-closeout/02-integracao/prova-nomos-real.sh
```

Enquanto o passo 3 não acontece, `prova-nomos-real.sh` roda até o fim e para em
`MOTIVO_DOS_FAIL=BLOQUEADO_MANIFESTO_EXPERIMENTAL`, registrando exatamente onde
parou. Não há atalho nem variável de ambiente que pule esse gate — nem deve
haver.

---

## 6. Como verificar

```bash
# transporte ponta a ponta contra daemon + Chromium reais (18 casos)
node evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts
#   → NOMOS_TRANSPORT_E2E=PASS

# unidade do adaptador (36 testes) e tipos
node --test tests/mcp.test.ts
npx tsc --noEmit -p tsconfig.json

# guardas de manifesto
bash scripts/ci.sh fast
#   mcp:manifesto-classifica-todas-as-tools   OK   (COBERTURA: toda tool tem nível)
#   mcp:lancador-do-manifesto-fala-mcp        OK
bash scripts/ci.sh security
#   mcp:risco-por-tool-coerente               OK   (COERÊNCIA: o nível vale para
#                                                   TUDO que a tool despacha)
node scripts/verificar-risco-mcp.ts --tabela   # a tabela rota → classe de risco

# integração canônica com o binário do dono (para em experimental se o manifesto
# mudou e ainda não foi reassinado — ver §5.2)
bash evidence/nomos-browser-final-closeout/02-integracao/prova-nomos-real.sh

# estado do registro no NOMOS do dono
bash scripts/nomos-register.sh | tail -1
```

`evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts` é um cliente stdio
**reimplementado a partir do fonte do `ClienteMCP` do NOMOS** — mesmo handshake,
mesmo framing, mesmo `cwd`, mesma anotação de nível pelo manifesto. Ele existe
para que "o NOMOS consegue falar com isto" seja uma medição, e não uma suposição
apoiada num SDK que o NOMOS não usa.
