# NOMOS Browser Runtime — Arquitetura

## A regra que define tudo

```
IA → NOMOS Browser API → NOMOS Browser Runtime → Browser Controller → Playwright/CDP → Chromium
```

E **nunca**:

```
IA → Playwright direto
```

A consequência prática dessa regra é a única que importa: **o estado da navegação
pertence ao Runtime, não ao modelo**. Um agente pode morrer, ser trocado por outro
de outro fornecedor, ou desconectar por uma hora — a sessão continua viva, com as
mesmas abas, os mesmos cookies e a mesma task. É isso que separa uma infraestrutura
de uma automação.

## Camadas

```
                 NOMOS · Claude · Gemini · Qwen · Ollama · agente próprio
                                      │
                       MCP  ·  REST v1  ·  WebSocket  ·  SDK TS/Py  ·  CLI
                                      │
   ┌──────────────────────────────────┴──────────────────────────────────┐
   │                        NOMOS BROWSER GATEWAY                        │
   │   SessionManager   ·   TaskEngine   ·   CapabilityEngine (policy)   │
   └──────────────────────────────────┬──────────────────────────────────┘
                                      │
   ┌──────────────────────────────────┴──────────────────────────────────┐
   │  PointerEngine · KeyboardEngine · PerceptionEngine · TargetResolver │
   │  ActionVerifier · Vault · DownloadMgr · UploadMgr · EventBus/Audit  │
   └──────────────────────────────────┬──────────────────────────────────┘
                                      │
                    Playwright  ·  CDP cru  ·  ComputerDriver nativo
                                      │
                                   Chromium
```

## Módulos e por que são separados

| Pacote | Responsabilidade | Não pode |
|---|---|---|
| `core` | Sessões, input, percepção, alvo, verificação, política, vault | Conhecer HTTP ou MCP |
| `observability` | EventBus, audit JSONL, redaction, replay, PNG | Conhecer Playwright |
| `api` | Daemon HTTP/WS, roteamento, backpressure | Conter lógica de navegador |
| `mcp` | Tradução MCP → HTTP | Importar Playwright (verificado em teste) |
| `sdk` / `sdk-python` | Cliente da API | Importar Playwright |
| `cli` | Cliente da API | Duplicar lógica do runtime |
| `ui` | NOMOS Web | Falar com Chromium direto |
| `skills` | Formato `.nomosskill` | Executar navegador |

A fronteira mais importante é `mcp`: a FASE 6 exige que ela seja uma casca fina.
O teste do módulo verifica literalmente que a string `playwright` não aparece no
código — não é uma promessa de arquitetura, é uma asserção executável.

## Decisões e seus motivos

**Node 26 executa TypeScript nativamente.** Sem passo de build, sem `dist/`, sem
divergência entre o que foi testado e o que roda. A FASE 55 (clean room) pede
`clone → install → start → test`; cada etapa a menos é uma classe de erro a menos.

**Sem framework HTTP.** `node:http` puro. As únicas dependências de runtime são
`playwright` e `ws`, ambas pinadas em versão exata. A missão proíbe `@latest`; a
superfície de supply chain é o outro motivo.

**Decodificador PNG próprio** (`observability/src/png.ts`). Existe para o runtime
poder *verificar* que um screenshot corresponde às coordenadas do DOM. Sem decodificar
o pixel não haveria evidência do mapeamento — haveria alegação. É o que sustenta a
camada de visão e o Pointer Engine operando por coordenada.

**Dois backends de input (CDP e Playwright).** O CDP cru é o caminho principal
porque entrega o evento no motor de input do Chromium — a página recebe
`isTrusted=true`, indistinguível de um humano. O backend Playwright é fallback.
Qual dos dois agiu vai no resultado da ação, sempre.

**`isTrusted` como discriminador.** O spike da FASE 1 provou que evento
sintetizado por JS chega `isTrusted=false` e evento via CDP chega `true`. Sem esse
controle negativo, "controlamos o navegador de verdade" seria uma frase, não um fato.

## Ciclo de uma ação

```
requisição
  → policy.check(tool, capabilities)        ← negado aqui não chega no navegador
  → fila da sessão (backpressure)
  → TargetResolver.resolve()                ← cascata; registra o que tentou
  → captura do snapshot "antes"
  → PointerEngine / KeyboardEngine
  → ActionVerifier.verify()                 ← confidence derivada de sinal observado
  → EventBus.emit() + AuditLog.append()     ← ambos já redigidos
  → ActionResponse
```

Falha em qualquer etapa vira `ActionResponse` com `error.code`. Não existe fallback
silencioso: uma ação que não pôde ser verificada volta `verified=false`, não
`success=true` otimista.

## Estado e recuperação

Sessão sobrevive a: cliente desconectar, WebSocket cair, agente trocar (`handoff`),
humano assumir (`takeover`). Ao devolver o controle, o runtime **reobserva** a
página — assumir que nada mudou durante o takeover seria a mesma classe de mentira
que a missão proíbe em toda parte.

O que a sessão **não** sobrevive nesta versão: queda do processo do runtime. O
audit log permite reconstruir o que aconteceu (`replay`), não ressuscitar o
`BrowserContext`.
