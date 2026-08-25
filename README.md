<div align="center">

# NOMOS Browser

**O navegador do seu agente, com você na sala.**

Infraestrutura de navegação governada para agentes de IA. O navegador vira um
recurso da plataforma, não um brinquedo acoplado a um modelo — e o dono vê,
autoriza e interrompe o que o agente faz.

`0.3.0-rc.1` · Node ≥ 22.6 · Chromium via Playwright · sem passo de build

</div>

---

## O problema

Dar a um agente o poder de usar um navegador é dar a ele o poder de comprar,
enviar, apagar e vazar em nome de alguém. Isso costuma ser resolvido de dois
jeitos ruins:

- **confiança cega** — o agente age e o dono descobre depois;
- **paralisia** — o agente pergunta tudo, e o dono clica "sim" no automático até
  a aprovação virar reflexo.

O NOMOS Browser separa **o que o dono já autorizou** do **que precisa de
consentimento agora**, e torna a diferença visível, auditável e reversível.

## Como fica

```
NOMOS · Claude · Gemini · Qwen · Ollama · agente próprio
                        │
      MCP  ·  REST v1  ·  WebSocket  ·  SDK  ·  CLI  ·  Live Agent Console
                        │
              NOMOS BROWSER RUNTIME
        política → autonomia → aprovação → auditoria
                        │
                 Playwright · CDP
                        │
                     Chromium
```

O estado da navegação pertence ao **Runtime**, não ao modelo. O agente
desconecta, morre ou é trocado por outro de outro fornecedor: a sessão continua
viva, com as mesmas abas, cookies e task.

---

## Recursos

| | |
|---|---|
| **Live Agent Console** | Espelho da página, cursor do agente, faixa de estado, feed de atividade, centro de aprovação e histórico somente leitura |
| **Dois modos de autonomia** | `ASK` pergunta antes de cada ação que muda a página; `AUTO` executa sozinho o que você já autorizou |
| **`AUTO` não é bypass** | O modo automático nunca remove uma aprovação obrigatória. Isso é topologia do código, não promessa |
| **Aprovação com amarra** | Single-use, ligada à ação, à sessão e aos argumentos exatos. Aprovar "Cancelar" não autoriza "Confirmar compra" |
| **Segredo mascarado** | O texto a digitar aparece como `[oculto: 24 caractere(s), C…Z]`: o bastante para decidir, nunca o bastante para vazar |
| **Auditoria e replay** | Trilha encadeada por hash, selo ao encerrar a sessão, replay somente leitura em três camadas |
| **Controle humano** | Assumir o volante congela o agente; devolvê-lo obriga a reobservar antes de agir |
| **23 verbos, 16 ferramentas MCP** | Um contrato só, servido por MCP, REST, WebSocket, SDK e CLI |

## Demonstração

O Live Agent Console é servido pelo próprio runtime, na mesma origem, com CSP
`connect-src 'self'` — não há CORS permissivo a explorar.

```bash
node packages/api/src/daemon.ts
# abra a URL com o token que o daemon imprime
```

Roteiros reproduzíveis com resultado esperado estão em
[`docs/demos.md`](docs/demos.md).

---

## Instalação

```bash
npm ci --include=dev
npx playwright install chromium
```

`--include=dev` não é decoração: com `NODE_ENV=production` ou
`npm config omit=dev`, o `npm ci` pula as devDependencies e o typecheck falha
depois com *"This is not the tsc command you are looking for"*. Detalhes em
[`docs/INSTALLATION.md`](docs/INSTALLATION.md).

**Não há passo de build** para o runtime: o Node executa TypeScript nativamente.
A interface tem um passo próprio (`node packages/ui/build.ts`) porque lê os
tokens de marca do cofre a cada geração.

## Quick start

```bash
# 1. subir o runtime
node packages/api/src/daemon.ts &

# 2. estado
node packages/cli/src/main.ts health

# 3. abrir uma página (a sessão nasce com a política padrão)
node packages/cli/src/main.ts open https://example.com

# 4. ver o que ficou gravado
node packages/cli/src/main.ts sessions
node packages/cli/src/main.ts replay <SESSION_ID>
```

A CLI **nunca concede capability sensível**: sessão criada por ela nasce com
download, upload, send, purchase, payment e delete negados.

## Exemplos

```bash
# capturar a tela de uma sessão
node packages/cli/src/main.ts screenshot <SESSION_ID> --out /tmp/tela.png

# entregar um objetivo ao agente
node packages/cli/src/main.ts task --session <SESSION_ID> "encontre o preço do plano anual"

# acompanhar os eventos ao vivo
node packages/cli/src/main.ts events --session <SESSION_ID>

# verificar a integridade do replay gravado
node packages/cli/src/main.ts replay verify <SESSION_ID>
```

---

## ASK e AUTO

A hierarquia, e a ordem **é** a garantia:

```
POLÍTICA DO DONO → MODO DE AUTONOMIA → CAPABILITY DO NOMOS → GATES DE APROVAÇÃO → AÇÃO
```

### `ASK` — perguntar

Leituras passam direto. Toda ação que muda a página para e pergunta, com
consequência e recurso escritos em português, para que a decisão seja consciente
e não um clique reflexo.

Aprovar uma `browser.task` **não** é cheque em branco: cada passo que o plano
decidir executar reentra no portão.

### `AUTO` — agir sem perguntar

O agente executa sozinho tudo o que você já autorizou pela sua política. O que
**não** muda:

- ações com efeito financeiro, envio externo ou irreversibilidade alta continuam
  pedindo aprovação — `browser.upload` pergunta em `AUTO` porque *envia dado seu
  para fora, e isso não se retira*;
- rota sem perfil de risco declarado cai em "sempre aprovar" (fail-closed);
- se o estado de autonomia não puder ser comprovado (runtime caído, reconexão),
  a interface **nunca** mostra `AUTO`: cai para desconhecido e trata como `ASK`.

`AUTO != BYPASS` não é uma promessa de documentação. O portão de autonomia roda
**depois** de capability e de controle humano: quando ele executa, tudo que a
política nega já devolveu `403`. Não existe ramo no código que transforme um
`deny` em `allow`.

Mais em [`docs/ask-mode.md`](docs/ask-mode.md) e
[`docs/auto-mode.md`](docs/auto-mode.md).

## Segurança

- **Autenticação por token com escopos** (`OBSERVE`, `NAVIGATE`, `INPUT`,
  `DOWNLOAD`, `UPLOAD`, `SECRET`, `CONTROL`, `ADMIN`). Toda rota tem escopo
  **declarado**; nenhuma vive do default.
- **Quem age não autoriza.** O perfil de agente não alcança aprovar, delegar modo
  nem retomar. Parar, sim: `pause` e `emergency-stop` nunca podem ser mais
  difíceis do que agir.
- **Política fail-closed** por capability, com `A6_DESTRUCTIVE` negado.
- **Anti-SSRF**: navegar para host interno é ato explícito, nunca inferido.
- **Procedência anti-injeção** no caminho de execução: `observe` e `extract`
  devolvem `provenance`.
- **Lease de controle** obrigatório (`allow_unleased: false`).
- **Segredos** não aparecem na interface, na auditoria nem no replay.

O modelo de ameaça T1–T10, **com resíduos declarados**, está em
[`docs/SECURITY.md`](docs/SECURITY.md).

Nada aqui afirma "100% seguro". Nenhuma medida sustenta isso, e nenhuma jamais
sustentará.

## Auditoria e replay

Trilha de 19 campos por ação, encadeada por hash, com redação de segredo na
origem. Ao encerrar, a sessão é **selada**.

O replay é somente leitura em três camadas independentes: não existe verbo de
escrita na rota (405 + `Allow: GET`); ler o histórico não ressuscita a sessão; e
o modo é **declarado** pelo runtime, não deduzido pela tela.

Ele também é honesto sobre a própria leitura: relata linhas corrompidas e fontes
ausentes em vez de devolver uma linha do tempo mais curta que se apresenta como
completa. Sessão que nunca existiu é `404`, não um replay vazio de `200`.

Ver [`docs/audit-and-replay.md`](docs/audit-and-replay.md).

## MCP

16 ferramentas, sem acoplamento a modelo:

`browser_navigate` · `browser_observe` · `browser_find` · `browser_extract` ·
`browser_screenshot` · `browser_click` · `browser_type` · `browser_press` ·
`browser_scroll` · `browser_tabs` · `browser_tab_open` · `browser_tab_switch` ·
`browser_tab_close` · `browser_download` · `browser_upload` · `browser_task`

No ecossistema NOMOS, o browser é uma **capability governada** pela política do
dono, com catálogo assinado e confiança por impressão do manifesto normalizado.
Ver [`docs/mcp.md`](docs/mcp.md) e
[`docs/NOMOS-INTEGRATION.md`](docs/NOMOS-INTEGRATION.md).

## Configuração

51 chaves, consultáveis pelo próprio runtime:

```bash
curl -s localhost:7777/api/v1/config/schema   # a FORMA (pública)
curl -s localhost:7777/api/v1/config          # os VALORES efetivos (ADMIN)
```

A separação é deliberada: *"o que existe?"* pode ser respondida a qualquer
portador; *"o que está valendo aqui?"* não. Ver
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Troubleshooting

Sintoma → causa → verificação → correção em
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Desenvolvimento

```bash
npx tsc --noEmit                    # tipos
bash scripts/run-suite.sh           # suíte inteira, um arquivo por vez
bash scripts/run-suite.sh --fast    # pula browser/bench
bash scripts/regressao-completa.sh  # 15 etapas, um veredito
bash scripts/limpar-orfaos.sh       # higiene por prova de posse
```

Use o executor, não `node --test tests/` direto. O runner do Node paraleliza por
CPU; sob pressão de memória o processo morre no meio e deixa saída truncada
**sem linha de sumário**, que parece sucesso. O `run-suite.sh` roda um arquivo
por vez, e um arquivo morto aparece como `MORTO`.

## Testes

Medido em `HEAD 6964cf0`:

```
suíte TypeScript     789 passes · 0 falhas · 37/37 arquivos
E2E do Live Agent    106 casos  · 9 baterias
sala limpa           14/14 passos, a partir de clone do HEAD
regressão completa   15 etapas · 0 falha · 0 não-executada
```

O projeto se recusa a chamar de PASS o que não foi observado. Dois exemplos:

**O controle do navegador é real.** Um clique sintetizado por JavaScript chega à
página com `isTrusted=false`; um despachado por CDP chega com `true`. O spike
testa os dois — o segundo prova o controle, o primeiro prova que o teste não é
vácuo.

**O contador de aprovações não é cego.** Sob mutação do produto,
`UNEXPECTED_APPROVAL_PROMPTS` sai de `0` para `3` e para `5` conforme o defeito
injetado. Um contador que ficasse em zero sob mutação não estaria medindo nada.

## Limitações conhecidas

- **`p99` não é reportado** em nenhum caminho de latência: 30 amostras exigem 100
  para sustentar um p99. Nenhum máximo observado é chamado de p99.
- **Não há rota HTTP para emitir token com escopo** — existe na API interna.
- **O ramo `pr.page.isClosed()` é inalcançável** em operação normal; é defesa de
  corrida, não cobertura.
- **A faixa de estado da interface atualiza por polling de 700 ms.** Os eventos
  chegam em ~1 ms; a faixa, não.
- Validado em **macOS/Apple Silicon**. Outras plataformas não foram medidas.

A lista completa, com números, está em
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md), e o que é `PROVEN` contra o que é
`MEASURED` ou `NOT PROVEN` está em
[`PRODUCT_TRUTH_MATRIX.md`](PRODUCT_TRUTH_MATRIX.md).

## Roadmap

Em [`ROADMAP.md`](ROADMAP.md). O que está lá são dívidas legítimas, não
promessas de data.

---

## Documentação

**Comece por aqui**

| | |
|---|---|
| [quickstart.md](docs/quickstart.md) | Do zero ao primeiro browser task |
| [live-agent-console.md](docs/live-agent-console.md) | O console, seus estados e controles |
| [ask-mode.md](docs/ask-mode.md) · [auto-mode.md](docs/auto-mode.md) | Os dois modos, e o que não muda entre eles |
| [demos.md](docs/demos.md) | Roteiros reproduzíveis |

**Referência**

| | |
|---|---|
| [INSTALLATION.md](docs/INSTALLATION.md) · [CONFIGURATION.md](docs/CONFIGURATION.md) · [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Instalar, configurar, destravar |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [API.md](docs/API.md) | Camadas e rotas |
| [browser-control.md](docs/browser-control.md) · [tasks.md](docs/tasks.md) · [TASK-ENGINE.md](docs/TASK-ENGINE.md) | Verbos, alvos e o motor de task |
| [security-overview.md](docs/security-overview.md) · [SECURITY.md](docs/SECURITY.md) | Segurança do produto e modelo de ameaça |
| [audit-and-replay.md](docs/audit-and-replay.md) · [AUDIT.md](docs/AUDIT.md) | Trilha, selo e replay |
| [mcp.md](docs/mcp.md) · [NOMOS-INTEGRATION.md](docs/NOMOS-INTEGRATION.md) · [GI-INTEGRATION.md](docs/GI-INTEGRATION.md) | Integrações |
| [RECOVERY.md](docs/RECOVERY.md) · [VISION-PROVIDER.md](docs/VISION-PROVIDER.md) | O que sobrevive ao quê; visão |
| [LIMITATIONS.md](docs/LIMITATIONS.md) · [EVIDENCIA.md](docs/EVIDENCIA.md) · [RASTREABILIDADE.md](docs/RASTREABILIDADE.md) | Limites, evidência, rastreabilidade |
| [RELEASE.md](docs/RELEASE.md) · [CHANGELOG.md](CHANGELOG.md) | Como se faz uma versão; o que mudou |

## Marca

A marca NOMOS está **congelada na v1.0** e o resolvedor oficial responde `rc=0`.
Os tokens são lidos do cofre a cada build e **não** são versionados neste
repositório — copiar token de marca para arquivo intermediário é proibido pelo
contrato de governança. Ver [`docs/BRAND.md`](docs/BRAND.md).

## Licença

**Proprietária — todos os direitos reservados.** [`LICENSE`](LICENSE) não concede
nenhuma permissão a terceiros: é o estado legal padrão de uma obra sob direito
autoral, escrito explicitamente para que quem lê saiba.

O titular declarado no arquivo é um **placeholder** derivado da identidade do
commit HEAD, e está marcado como tal. Antes de qualquer distribuição, o dono
precisa decidir o titular legal e se o produto será source-available proprietário
ou licenciado. **Nenhum agente tem autoridade para escolher isso.**

<div align="center">

Parte do ecossistema **NOMOS** · [voltolini.space](https://voltolini.space)

</div>
