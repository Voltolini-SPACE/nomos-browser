# NOMOS Browser Runtime + NOMOS Web

Infraestrutura universal de navegação para agentes de IA. O navegador vira um
**recurso da plataforma**, não um brinquedo acoplado a um modelo específico.

```
NOMOS · Claude · Gemini · Qwen · Ollama · agente próprio
                     │
        MCP  ·  REST v1  ·  WebSocket  ·  SDK  ·  CLI
                     │
           NOMOS BROWSER RUNTIME
                     │
       Playwright · CDP · driver nativo
                     │
                  Chromium
```

O ponto que define o produto: **o estado da navegação pertence ao Runtime, não ao
modelo**. O agente desconecta, morre, ou é trocado por outro de outro fornecedor —
a sessão continua viva, com as mesmas abas, cookies e task.

## Estado atual — honesto

| Fase | O que é | Situação |
|---|---|---|
| 0 | Inventário e checkpoint | **PASS** — `checkpoints/pre-nomos-browser-product-01.json` |
| 1 | Spike de controle real | **PASS** — 25/25 (`spike/evidence/fase1_result.json`) |
| 16 | Formato `.nomosskill` | **PASS** — 10/10 |
| 30/31/32 | NOMOS Web (UI, cursor, takeover) | **PASS parcial** — renderiza; falta ligar ao daemon |
| — | Governança de marca | **PASS** — 6/6, com teste que barra token no fonte |

O restante das fases está em construção. Nada aqui é declarado PASS sem evidência
executável: veja `docs/EVIDENCIA.md`.

## Requisitos

- Node ≥ 22.6 (usa TypeScript nativo — **não há passo de build**)
- Python ≥ 3.11 (apenas para o SDK Python)
- macOS ou Linux

## Começar

```bash
npm install
npx playwright install chromium
```

Provar que o controle do navegador é real:

```bash
node spike/fase1_spike.ts
```

Rodar a suíte:

```bash
node --test tests/
```

Ver a NOMOS Web:

```bash
node packages/ui/serve.ts
```

## Provas, não alegações

O projeto se recusa a chamar de PASS o que não foi observado. Dois exemplos do
que isso significa na prática:

**O controle do navegador é real.** Um clique sintetizado por JavaScript chega à
página com `isTrusted=false`; um clique despachado por CDP chega com `true`. O
spike testa os dois — o segundo prova o controle, o primeiro prova que o teste
não é vácuo. Sem esse controle negativo, "controlamos o Chromium" seria uma
frase.

**O screenshot corresponde ao DOM.** O runtime traz um decodificador PNG próprio
para conferir que o pixel no centro do retângulo do elemento tem a cor daquele
elemento — mais um controle negativo provando que um pixel fora dele tem cor
diferente. Sem isso, a camada de visão operaria sobre um mapa não verificado.

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Camadas, módulos e o porquê de cada decisão |
| [API.md](docs/API.md) | Tabela de rotas normativa da API v1 |
| [SECURITY.md](docs/SECURITY.md) | Modelo de ameaça, com gaps declarados |
| [BRAND.md](docs/BRAND.md) | Portão de marca da NOMOS Web |

## Marca

A NOMOS Web sai marcada **PROPOSTA**: a marca NOMOS está vigente na v1.0 porém
sem documento de congelamento, então `brand-resolve --require-official` devolve
`rc=1` (fail-closed). Congelar é ato do dono, nunca do agente. Os tokens são
lidos do cofre a cada build e **não** são versionados neste repositório.

## Licença

Ainda não definida — decisão do dono.
