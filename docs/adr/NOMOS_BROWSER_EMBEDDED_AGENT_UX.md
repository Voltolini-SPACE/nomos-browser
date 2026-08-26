# ADR — NOMOS Browser: agente embutido no navegador (Side Panel)

- Status: **ACEITA** (2026-08-26)
- Decisores: missão `NOMOS_BROWSER_EMBEDDED_AGENT_UX_AND_MCP_ARCHITECTURE`
- Contexto de código: commit `f801629`, branch `feature/embedded-agent-ux`

## Problema

O NOMOS Browser já governa a navegação (política → autonomia → aprovação →
auditoria), mas a experiência do dono vive numa página separada (NOMOS Web).
Queremos a experiência de "navegador com agente embutido": conversar com
Gi/NOMOS ao lado da página enquanto o agente navega — sem copiar Claude for
Chrome e sem entregar autoridade nova a nenhuma casca de UI.

## Alternativas

```
A = Extensão Chrome/Chromium (MV3 + chrome.sidePanel) + NOMOS runtime
B = MCP com navegador externo (Browser MCP / Playwright MCP como UX)
C = Navegador próprio (Electron/Chromium fork)
```

## Fatos verificados (não opinião)

1. `chrome.sidePanel` existe desde Chrome 114 (MV3), permissão `"sidePanel"`;
   `sidePanel.open()` desde o 116 exige gesto do usuário;
   `setPanelBehavior({openPanelOnActionClick:true})` abre pelo ícone.
   Fonte: developer.chrome.com/docs/extensions/reference/api/sidePanel.
2. Playwright carrega extensão descompactada em `launchPersistentContext` com
   `--disable-extensions-except` + `--load-extension` — **somente no canal
   `chromium`**; Chrome/Edge de marca removeram o side-loading por flag.
   Fonte: playwright.dev/docs/chrome-extensions.
3. O runtime NOMOS já usa `launchPersistentContext` headed por default
   (`core/session.ts:478`, `config.headless: false` — "takeover humano precisa
   de janela visível"). Ou seja: o Chromium que o runtime possui pode nascer
   com a extensão carregada, sem passo manual.
4. O daemon já expõe tudo que a UX precisa: REST v1, WS `/events`, aprovação,
   autonomia, takeover, replay — com token por escopo (`api/auth.ts`).
5. Uma página de extensão com `host_permissions` para `http://127.0.0.1:<porta>/*`
   faz fetch/WS ao daemon sem CORS permissivo — a ameaça T7 (CORS aberto)
   não precisa ser reaberta.

## Pontuação (0–5; pesos iguais; justificativa em uma linha)

| critério | A extensão | B MCP externo | C navegador próprio |
|---|---|---|---|
| Segurança | **4** — UI sem autoridade; token com escopo; sem CORS aberto | 2 — UX dependeria de bridge de terceiro fora da política | 3 — superfície própria enorme para manter |
| UX embutida | **5** — side panel nativo, overlay na página real | 1 — não há painel; UX fica no cliente MCP | 5 — controle total |
| Manutenção | **4** — MV3 estável; uma extensão | 3 — acoplamento a projeto externo | 1 — acompanhar Chromium/CVEs para sempre |
| Compatibilidade | **4** — Chromium do runtime já carrega por flag; Chrome real via unpacked/CWS | 3 | 2 — codecs, WebAuthn, sandbox, updates |
| Custo/velocidade | **5** — semanas; reusa API v1 inteira | 4 — pouco código, mas não entrega a UX pedida | 0 — meses antes do primeiro pixel |
| Integração NOMOS (ASK/AUTO, audit, replay) | **5** — lê o que o runtime fornece, como o console | 2 — governança contornável se o browser é de terceiro | 5 |
| Portabilidade | **4** — qualquer Chromium | 4 | 2 |
| **Total** | **31** | 19 | 18 |

## Decisão

**A — Extensão Chrome/Chromium + NOMOS runtime**, em duas superfícies do mesmo
artefato:

1. **Modo NOMOS Browser (principal):** o runtime lança seu Chromium com a
   extensão pré-carregada (canal `chromium`, flags do fato 2). O usuário abre o
   "NOMOS Browser" e o painel já está lá. O navegador continua sendo posse do
   runtime — nada muda na governança.
2. **Modo Chrome real (secundário):** a mesma extensão instalada unpacked (dev)
   ou futuramente via Chrome Web Store, conectando ao mesmo daemon local por
   token. Chrome de marca não aceita `--load-extension`, então este modo é
   sempre instalação explícita do dono — o que é coerente com a filosofia.

B fica como **protocolo**, não como UX: MCP continua sendo porta de entrada de
agentes (Claude, Codex, Cursor, Gi) para o MESMO runtime — fluxo obrigatório
`MCP CLIENT → NOMOS MCP → POLICY → NOMOS BROWSER → CHROME`, já garantido por
teste (o fonte do pacote `mcp` não pode conter a string `playwright`).

C fica **adiado por critério objetivo** (FASE 40): só se justifica se (a) a
extensão esbarrar em limite duro de API do Chrome que bloqueie UX essencial,
(b) precisarmos de política de rede/perfil abaixo do que CDP oferece, ou
(c) o produto exigir distribuição de binário próprio. Nenhum dos três é
verdadeiro hoje; um fork custa acompanhamento perpétuo de Chromium sem ganho
presente.

## Arquitetura consequente

```
NOMOS Browser Extension (MV3)
        │
        ├── Side Panel UI (chat Gi/NOMOS · AGORA · ASK/AUTO · aprovação ·
        │                  abas · Audit · Replay · Stop/Pause/Takeover)
        ├── Service Worker (conexão, reconexão, badge)
        └── Bridge Client ──► http/ws 127.0.0.1:<porta> + token com escopo
                                    │
                          NOMOS Browser Runtime (inalterado em autoridade)
                                    │        highlight na página é feito PELO
                                    │        runtime (spotlight), não pela extensão
                              NOMOS / Gi / MCP clients
```

Invariantes herdados, não renegociados:

- A extensão **não** recebe autoridade maior que o runtime; ela é um cliente da
  API v1 com token, como o console e o SDK.
- `AUTO != BYPASS_POLICY`; aprovação continua single-use e amarrada à ação.
- O LLM nunca fala com o Chrome direto; o painel envia intenção
  (`browser.task`/ações) ao control plane.
- Replay continua somente leitura (`REPLAY_CAUSES_REAL_ACTION=NO`).
- Highlight visual é responsabilidade do runtime (que já possui a página via
  Playwright), evitando content script com `<all_urls>` — menor privilégio
  por construção (FASE 18).

## Consequências negativas aceitas

- Duas superfícies de instalação (flag no Chromium do runtime; unpacked/CWS no
  Chrome real) — documentadas em `docs/extension.md`.
- MV3 service worker dorme (~30 s); o estado vivo mora no side panel enquanto
  aberto, e o runtime continua sendo a fonte de verdade (a UI "lê, não deduz").
- Chrome de marca sem CWS exige modo desenvolvedor — declarado com honestidade
  em vez de contornado.
