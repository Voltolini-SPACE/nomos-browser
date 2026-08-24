# FASE 23 — Driver nativo: decisão com evidência

```
NATIVE_DRIVER_DECISION=NOT_REQUIRED_WITH_EVIDENCE
```

A missão é explícita: *"Antes de implementar, provar a necessidade. […] Não
adicionar complexidade apenas para marcar fase."* Então a pergunta não é "como
implementar um `ComputerDriver`", e sim **o que exatamente o CDP não alcança, e
isso importa para este produto?**

## O que foi testado

Sonda executada em Chromium 151 headless via Playwright/CDP
(`/tmp/nativeprobe.mjs`, saída abaixo). Cada linha é uma capacidade que, na
crença comum, exigiria automação de sistema operacional.

| Capacidade | Precisa de driver de SO? | Evidência |
|---|---|---|
| Seletor de arquivo nativo (upload) | **Não** | `filechooser` interceptado; arquivo anexado: `nomos-upload-probe.txt` |
| Escrita no clipboard | **Não** | `navigator.clipboard.writeText` → `"escreveu"` |
| Leitura do clipboard | **Não** | leu de volta `NOMOS-CLIP-CANARIO` |
| Diálogo `alert`/`confirm`/`prompt` | **Não** | evento `dialog` capturado: `alert:nativo?` |
| Foco de janela | **Não** (para o que importa) | `document.hasFocus() === true` mesmo headless |
| Mouse e teclado com `isTrusted` | **Não** | provado no spike da FASE 1 (`CDP-04`, `CDP-10`) |

Saída bruta:

```json
{
  "file_chooser": "nomos-upload-probe.txt",
  "clipboard_write": "escreveu",
  "clipboard_read": "NOMOS-CLIP-CANARIO",
  "dialog": "alert:nativo?",
  "chrome_ui_alcancavel": "NAO — CDP opera na página, não no chrome do navegador",
  "window_focus_headless": true
}
```

## O que o CDP realmente **não** alcança

Três superfícies, e nenhuma delas é requisito deste produto:

1. **A UI do próprio Chrome** — barra de endereço, menu, popups de extensão,
   preferências. O CDP opera sobre a página, não sobre o navegador. Mas o
   NOMOS Browser **é** quem controla o navegador: navegar é `browser.goto`, abrir
   aba é `browser.new_tab`. Automatizar a barra de endereço com o mouse seria
   simular por fora o que já existe por dentro, com mais fragilidade.

2. **Outras aplicações do sistema** — Finder, Terminal, apps nativos. Está
   explicitamente fora do escopo: o produto é uma infraestrutura *de navegação*,
   não um agente de desktop. Trazer isso para dentro ampliaria a superfície de
   ataque de um processo que já detém cookies e sessões autenticadas do dono.

3. **Diálogos modais do sistema operacional** — o seletor de arquivo do macOS
   quando não interceptado, permissões do SO. O caso que importa (upload) já é
   resolvido pelo `filechooser`, e resolver **melhor**: o runtime escolhe o
   arquivo por política, em vez de a página abrir um diálogo em que qualquer
   caminho local é alcançável. Ver `FASE 28` — a política de upload depende
   justamente de a página **não** ter essa escolha.

## Conclusão

Implementar `ComputerDriver` agora adicionaria: dependência de permissões de
acessibilidade do macOS, um caminho de input que **não** passa pelo policy engine
do runtime, e uma segunda forma de mover o mouse cuja auditoria seria distinta da
existente. Custo real, benefício não demonstrado.

A interface `ComputerDriver` **não** é implementada. Se um requisito futuro exigir
uma das três superfícies acima, esta decisão é revisitada com o caso concreto —
e a fronteira já está desenhada: `browser.mouse` e `computer.mouse` nunca se
misturam (regra herdada da FASE 20 do PRODUCT-01).

## Limite honesto desta decisão

A sonda rodou **headless**. O `filechooser` e os diálogos se comportam igual em
headful — é o mesmo caminho de CDP —, mas isso não foi medido aqui. Se algum dia
o produto depender de uma superfície headful específica, refazer a sonda antes de
reafirmar esta decisão.
