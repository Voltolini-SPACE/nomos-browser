# Diagramas

Fonte dos diagramas usados em site, README e apresentação. Texto, não imagem, de
propósito: um diagrama em ASCII não desalinha em tema escuro, não precisa de
`alt` inventado, não tem proporção para errar, e continua legível quando alguém
copia para um terminal.

---

## 1. Camadas

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

## 2. A ordem dos portões

O diagrama mais importante do produto. A **ordem** é a garantia:

```
  ação pedida
      │
      ▼
┌─────────────┐  nega → 403        a política do dono decide o que é POSSÍVEL
│ CAPABILITY  │─────────►
└─────┬───────┘
      ▼
┌─────────────┐  humano com o volante → 409
│  CONTROLE   │─────────►
└─────┬───────┘
      ▼
┌─────────────┐  pausado → 409 (mas OBSERVAR continua passando)
│    PAUSA    │─────────►
└─────┬───────┘
      ▼
┌─────────────┐  volante devolvido → precisa reobservar antes de agir
│ REOBSERVAÇÃO│─────────►
└─────┬───────┘
      ▼
┌─────────────┐  AUTOMÁTICO ──────────────────────┐
│  AUTONOMIA  │  DEPENDE DO MODO → ASK: pergunta  │
└─────┬───────┘  SEMPRE APROVAR  → pergunta       │
      │                                            │
      ▼                                            ▼
  aprovação do dono ────────────────────────►   AÇÃO
```

Quando o portão de autonomia executa, tudo que a política nega **já morreu**.
Por isso `AUTO` só pode escolher entre *passar direto* e *parar para perguntar*,
nunca entre *permitido* e *proibido*.

## 3. Classificação: fatores antes do nível

```
                    ┌── efeito financeiro ──┐
  ação  ──────────► ├── envio externo ──────┤──► SEMPRE APROVAR
                    └── irreversível alta ──┘
                              │ nenhum
                              ▼
                       nível A4 a A6  ──────────► SEMPRE APROVAR
                       nível A1 a A3  ──────────► DEPENDE DO MODO
                       nível A0       ──────────► AUTOMÁTICO
                       sem perfil     ──────────► SEMPRE APROVAR (fail closed)
```

`browser.upload` pergunta em `AUTO` porque **envia dado para fora**, não porque
é A2.

## 4. Task: o objetivo aprovado uma vez, os passos aprovados sempre

```
  dono aprova ──► browser.task ──► executor planeja
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                     passo 1         passo 2         passo 3
                        │               │               │
                        └──── cada um volta ao PORTÃO ──┘
                                        │
                          ASK: pergunta de novo, a cada passo
                          AUTO: passa, se o dono já autorizou aquela rota
```

O executor de passo fala com a **própria API por loopback**, e é isso que
mantém os passos dentro do portão. Um executor que chamasse o handler direto
daria ao modelo um caminho privilegiado que nenhum cliente humano tem.
