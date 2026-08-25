# MCP — 16 ferramentas

O NOMOS Browser expõe o navegador como servidor MCP, sem acoplamento a modelo.
Qualquer cliente MCP fala com ele pelos mesmos verbos, sob a mesma política e com
a mesma trilha.

## Ferramentas

| leitura | ação | comprometimento |
|---|---|---|
| `browser_observe` | `browser_navigate` | `browser_download` |
| `browser_find` | `browser_click` | `browser_upload` |
| `browser_extract` | `browser_type` | |
| `browser_screenshot` | `browser_press` | |
| `browser_tabs` | `browser_scroll` | |
| | `browser_tab_open` | |
| | `browser_tab_switch` | |
| | `browser_tab_close` | |
| | `browser_task` | |

A coluna importa: ela é a projeção de `ACTION_CLASS` do contrato
(`OBSERVE` / `ACT` / `COMMIT`), não uma segunda lista. Uma segunda lista
divergiria no dia em que o contrato ganhasse um verbo.

## Subir o servidor

```bash
node packages/mcp/src/server.ts
```

Transporte stdio JSON-RPC.

## No ecossistema NOMOS

O NOMOS trata o browser como **capability governada**. O registro tem três
propriedades que valem entender:

**A confiança é da IMPRESSÃO, não do nome.** O NOMOS calcula um SHA-256 do
manifesto **normalizado** — só quatro campos: `nome`, `comando`, `nivel_padrao`,
`tools`. Trocar qualquer um deles muda a impressão e invalida a confiança.

**Confiar só ACRESCENTA.** `nomos mcp confiar` nunca substitui uma entrada; o
catálogo é indexado por impressão. Revogar é bloqueio duro.

**Registrar é ato do dono.** Nenhum agente assina o manifesto em nome dele. O
catálogo vive em `~/.nomos/mcp_catalogo.json` com permissão `0600`.

```bash
nomos mcp listar
nomos mcp chamar <ferramenta> --args '{...}'
```

### O teto medido do caminho headless

`nomos mcp chamar` **não tem** `--panel`. Verificado de três maneiras: na saída
do `--help`, no argparse (que declara `--panel` em 17 subcomandos, mas não em
`chamar`), e no caminho de código que leva a `interactive_approver` — o qual
exige TTY e a palavra `APROVO` digitada.

Consequência: ações A1 ou acima **não** passam pelo caminho MCP canônico sem uma
pessoa num terminal. Isso não é bug; é a aprovação humana funcionando. Está
registrado como limite medido, não como falha.

## Integração com a Gi

A Gi (assistente de voz) aciona o browser pelo caminho MCP registrado, com
cancelamento por barge-in e distinção de cancelamento **tardio**: quando o
cancelamento chega depois de a ação já ter acontecido, a resposta admite
`cancelamento_tardio=True` em vez de dizer "cancelei" com a aba já trocada na
tela do dono.

Ver [`GI-INTEGRATION.md`](GI-INTEGRATION.md).

## Ver também

- [`NOMOS-INTEGRATION.md`](NOMOS-INTEGRATION.md) — manifesto, níveis, registro
- [`API.md`](API.md) — a mesma capacidade por REST
- [`security-overview.md`](security-overview.md) — escopos e política
