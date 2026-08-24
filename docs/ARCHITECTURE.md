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
  → Acionabilidade.rolar → assentar → remedir → conferir ponto   (FASE 4)
  → captura do snapshot "antes"
  → sonda de entrega armada (listener de captura em `document`)  (FASE 4)
  → PointerEngine / KeyboardEngine
  → prova de entrega lida                   ← o evento chegou ao alvo?
  → ActionVerifier.verify()                 ← confidence derivada de sinal observado
  → EventBus.emit() + AuditLog.append()     ← ambos já redigidos
  → ActionResponse
```

Falha em qualquer etapa vira `ActionResponse` com `error.code`. Não existe fallback
silencioso: uma ação que não pôde ser verificada volta `verified=false`, não
`success=true` otimista.

### Acionabilidade e entrega (FASE 4)

`verified=false` sozinho nunca foi pista suficiente, porque é também o valor
devolvido quando NENHUMA verificação foi pedida. Um clique despachado para uma
coordenada fora do viewport voltava `success:true, verified:false` — indistinguível
de "cliquei e ninguém me pediu prova". Dois códigos novos separam as duas coisas:

| código | quando | HTTP |
| --- | --- | --- |
| `TARGET_NOT_ACTIONABLE` | alvo existe mas não pode receber o gesto: fora do viewport mesmo após rolar, área zero, invisível, coberto no ponto, removido do DOM, ou em movimento que não assenta | 409 |
| `CLICK_NOT_DELIVERED` | o gesto foi despachado e nenhum evento chegou ao alvo | 500 |

A prova de entrega tem três formas, todas armadas ANTES do gesto (sinal armado
antes só pode disparar por algo que veio depois, e é isso que o torna prova):

| `delivery_evidence` | o que provou |
| --- | --- |
| `listener` | o evento chegou ao alvo — listener de CAPTURA em `document` |
| `navegacao` | a navegação destruiu o contexto de JS e levou o registro junto; `framenavigated` no frame principal, mudança de `page.url()` ou erro de contexto destruído provam que o clique agiu |
| `nova_aba` | o clique abriu uma aba (`target="_blank"`); evento `page` do contexto |
| `entrega_errada` | o evento chegou a OUTRO elemento — reprova mesmo que a página navegue |
| `sem_prova` | nada chegou e nada navegou ⇒ `CLICK_NOT_DELIVERED` |

A sonda é consultada PRIMEIRO, sempre: uma âncora (`href="#fim"`) também dispara
`framenavigated`, e dar precedência ao sinal trocaria prova forte por fraca. Quem
escreve o registro é o despacho de eventos do Chromium, não o runtime. O runtime não tem como marcar "entregue" sem que um evento real
tenha percorrido a árvore, e a fase de captura em `document` roda antes de
qualquer handler da página — logo a página não consegue suprimi-la.

Configuração: `scroll_into_view`, `stability_samples`, `stability_interval_ms`,
`click_delivery_check` (ver `packages/api/src/config.ts`).

## Estado e recuperação

Sessão sobrevive a: cliente desconectar, WebSocket cair, agente trocar (`handoff`),
humano assumir (`takeover`). Ao devolver o controle, o runtime **reobserva** a
página — assumir que nada mudou durante o takeover seria a mesma classe de mentira
que a missão proíbe em toda parte.

O que a sessão **não** sobrevive nesta versão: queda do processo do runtime. O
audit log permite reconstruir o que aconteceu (`replay`), não ressuscitar o
`BrowserContext`.
