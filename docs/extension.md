# Extensão NOMOS (side panel)

A experiência de "navegador com agente embutido": um painel lateral dentro do
Chromium onde você conversa com a Gi/NOMOS, vê o agente trabalhar, alterna
ASK/AUTO, aprova o que exige consentimento, interrompe, assume o controle e
consulta auditoria e replay — enquanto a página está do lado.

A decisão de arquitetura (e as alternativas medidas) está em
[`adr/NOMOS_BROWSER_EMBEDDED_AGENT_UX.md`](adr/NOMOS_BROWSER_EMBEDDED_AGENT_UX.md).

## O que a extensão É — e o que ela nunca é

A extensão é uma **casca de UI**: cliente da API v1 com token, exatamente como
a NOMOS Web e o SDK. Ela não fala com o Chromium, não contém política, não
aprova nada sozinha e não ganha autoridade por morar dentro da janela.

```
Side Panel ──► http/ws 127.0.0.1:<porta> + token ──► NOMOS Browser Runtime
                                                    política → autonomia →
                                                    aprovação → auditoria
```

O destaque visual do alvo na página (moldura + "● NOMOS controlando") é feito
pelo **runtime** (`packages/core/src/spotlight.ts`), não por content script —
por isso a extensão não pede permissão de host em site nenhum.

## Instalar

### Modo 1 — NOMOS Browser (recomendado)

O runtime lança o próprio Chromium já com a extensão embarcada:

```bash
node packages/extension/launch.ts
```

Isso constrói a extensão do cofre de marca vigente, liga o spotlight com a cor
da marca e sobe o daemon. Toda sessão criada abre um Chromium com o painel
disponível (ícone NOMOS na barra → abre o side panel).

Equivalente por configuração, sem o lançador:

```bash
node packages/extension/build.ts
NOMOS_BROWSER_EXTENSION_DIR="$PWD/packages/extension/dist" \
NOMOS_BROWSER_SPOTLIGHT=true \
node packages/api/src/daemon.ts
```

### Modo 2 — no seu Chrome/Chromium

Chrome e Edge de marca **não aceitam** `--load-extension` por linha de comando
(removido pelo Google). O caminho é instalação explícita:

1. `node packages/extension/build.ts`
2. `chrome://extensions` → Modo do desenvolvedor → "Carregar sem compactação"
   → aponte para `packages/extension/dist`
3. Abra o painel pelo ícone NOMOS.

Publicação na Chrome Web Store: preparada em `packaging/webstore/`, **não
publicada** — publicar é ato do dono.

## Conectar

O painel pede a URL do runtime (default `http://127.0.0.1:7777`) e o token que
o daemon imprime no arranque (arquivo `control-token`). Colar o token é o ato
explícito que amarra o painel ao runtime certo — a extensão não o adivinha nem
o lê do disco. O token fica em `chrome.storage.session`: morre quando o
navegador fecha, e não é legível por páginas.

## Requisitos

- Chromium/Chrome 116+ (API `sidePanel` com `openPanelOnActionClick`).
- No modo 1, o Chromium do Playwright (canal `chromium`) — inclusive headless.

## O chat e a Gi

Cada mensagem vira `browser.task {goal}` no runtime — a intenção passa pelo
control plane, nunca por um atalho. Sem `ai_provider` configurado o painel diz
isso com todas as letras (o runtime recusa; a Gi não finge que trabalha). Com
`ai_provider` (ex.: `ollama:...`), a task roda e o progresso aparece como fala
da Gi e no feed AGORA.

"Perguntar sobre esta página" anexa o contexto da aba ativa DO AGENTE (título,
URL e um trecho extraído via `browser.extract`, caminho A0 governado) à próxima
mensagem. Seleção de elemento pelo usuário ficou fora desta versão: exigiria
content script/permissão de página, e o custo de privilégio não se paga ainda.

## Limites conhecidos (declarados, não escondidos)

- O painel mostra as abas DO AGENTE (as suas abas nunca aparecem nem são tocadas).
- `sidePanel.open()` programático exige gesto do usuário — o painel abre pelo
  ícone, não sozinho.
- O service worker MV3 dorme; o estado é sempre relido do runtime (a UI lê,
  não deduz). Fechar e reabrir o painel não perde nada: a sessão é do runtime.
- Firefox/Safari: fora do escopo desta versão (side panel é API Chromium).

## Testes

```bash
node --test tests/extension-build.test.ts   # marca + menor privilégio
node --test tests/spotlight.test.ts         # highlight não-interferente
node --test tests/extension-e2e.test.ts     # Chromium real, 17 gates
```
