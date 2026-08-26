# PRODUCT MANIFEST — NOMOS Browser

Inventário canônico do que está sendo lançado. Toda capacidade aqui listada como
disponível tem linha correspondente em [`PRODUCT_TRUTH_MATRIX.md`](PRODUCT_TRUTH_MATRIX.md)
com status `PROVEN`.

Apurado em `HEAD=6964cf0`, versão de trabalho `0.2.0`.

---

## 1. Identificação

| campo | valor |
|---|---|
| Nome oficial | **NOMOS Browser** |
| Componente de operação | **Live Agent Console** (parte do produto, não produto separado) |
| Runtime | NOMOS Browser Runtime |
| Cliente de linha de comando | `nomos-web` |
| Repositório | `nomos-browser` |
| Versão em `package.json` | `0.2.0` |
| Licença | **MIT** · titular **Voltolini-SPACE** (ver §12) |
| Ecossistema | NOMOS (governança/autorização) · Gi (assistente de voz) · voltolini.space |

## 2. O que é

Infraestrutura de navegação para agentes de IA, **governada**. O navegador deixa
de ser um brinquedo acoplado a um modelo e vira um recurso da plataforma: um
runtime que qualquer agente — NOMOS, Claude, Gemini, Qwen, Ollama ou próprio —
opera pelos mesmos verbos, sob a mesma política e com a mesma trilha.

## 3. O problema que resolve

Dar a um agente o poder de usar um navegador é dar a ele o poder de comprar,
enviar, apagar e vazar em nome de alguém. Hoje isso costuma ser resolvido de dois
jeitos ruins:

- **confiança cega** — o agente age e o dono descobre depois;
- **paralisia** — o agente pergunta tudo, e o dono clica "sim" no automático até
  a aprovação virar reflexo.

O NOMOS Browser separa **o que o dono já autorizou** do **que precisa de
consentimento agora**, e torna a diferença visível, auditável e reversível.

## 4. Público

| público | uso |
|---|---|
| Operador/dono de agente | acompanha e controla a execução pelo Live Agent Console |
| Desenvolvedor de agente | integra por MCP, REST, WebSocket ou SDK |
| Auditor | lê replay e trilha de auditoria sem poder agir |
| Ecossistema NOMOS | usa o browser como capability governada pela política do dono |

## 5. Arquitetura

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

Ordem dos portões numa ação, e a ordem **é** a garantia:

```
CAPABILITY → CONTROLE HUMANO → PAUSA → REOBSERVAÇÃO → AUTONOMIA/APROVAÇÃO → AÇÃO
```

Quando o portão de autonomia executa, tudo que a política do dono nega já
devolveu `403` e morreu. Autonomia só escolhe entre *passar direto* e *parar para
perguntar* — nunca entre *permitido* e *proibido*.

Workspaces (`packages/*`): `api` (daemon, roteador, auth), `core` (contrato,
sessão, política, autonomia, aprovações, task engine, percepção, visão), `cli`,
`mcp`, `observability` (auditoria, replay, bench), `sdk`, `skills`, `ui`.

## 6. Superfícies

### CLI — `nomos-web` (8 comandos)

`health` · `open <url>` · `sessions` · `screenshot <id>` · `task --session <id> "<objetivo>"` ·
`events` · `replay <id>` · `close <id>`

`replay verify <id>` é uma **forma de invocação** de `replay`, não um nono
comando: a CLI não tem tabela de subcomandos, e o próprio código diz isso.
Contar a linha da ajuda em vez da entrada do registro era o que produzia "9".

Códigos de saída: `0` sucesso · `1` falha de negócio · `2` erro de uso ·
`3` runtime inalcançável.

A CLI **nunca concede capability sensível**: sessão criada por ela nasce com a
política padrão do runtime (download, upload, send, purchase, payment e delete
negados).

### MCP — 16 ferramentas

`browser_navigate` · `browser_observe` · `browser_find` · `browser_extract` ·
`browser_screenshot` · `browser_click` · `browser_type` · `browser_press` ·
`browser_scroll` · `browser_tabs` · `browser_tab_open` · `browser_tab_switch` ·
`browser_tab_close` · `browser_download` · `browser_upload` · `browser_task`

### API REST v1 + WebSocket

Sessões, tasks, lease, replay, configuração, autonomia, aprovações, estado vivo,
pausa/retomada, parada de emergência, takeover/release. Eventos por WebSocket em
`/events`. A UI é servida **na mesma origem** do runtime, com CSP
`connect-src 'self'` — não há CORS permissivo a explorar.

### Live Agent Console

Interface onde o dono vê o agente trabalhar: espelho da página, cursor do agente,
faixa de estado (agente, sessão, status, autonomia, dono, ação atual), feed de
atividade, centro de aprovação, histórico somente leitura, e os controles
Pausar / Cancelar / Assumir controle / Parar.

## 7. Contrato de ação

23 verbos, classificados em `OBSERVE` (não muda nada), `ACT` (muda a página) e
`COMMIT` (efeito que não se retira). Cada verbo declara nível de risco (A0–A6),
capability exigida, reversibilidade, e se envia dado para fora.

A classificação de autonomia olha **os fatores antes do nível**: efeito
financeiro, envio externo e irreversibilidade alta tornam a ação
`SEMPRE_APROVAR`, independentemente do nível.

## 8. Modos de autonomia

### ASK — *modo perguntar*

O agente executa leituras livremente e para para perguntar antes de cada ação que
muda a página. Aprovar uma `browser.task` **não** autoriza os passos que o plano
decidir executar: cada passo reentra no portão.

### AUTO — *agir sem perguntar*

O agente executa sozinho tudo o que o dono já autorizou pela política. Ações
marcadas `SEMPRE_APROVAR` **continuam perguntando** — `browser.upload` e
`browser.task` são exemplos medidos. `AUTO` não remove nenhuma aprovação
obrigatória.

Fail-safe: quando o estado de autonomia não pode ser comprovado (runtime caído,
reconexão), a interface **nunca** mostra AUTO. Cai para desconhecido e trata como
PERGUNTAR.

## 9. Aprovação

Single-use · action-bound · session-bound · auditada · não-sticky, com TTL.

A amarra de argumentos usa serialização canônica recursiva: aprovar um clique em
"Cancelar" não pode autorizar um clique em "Confirmar compra".

O texto a ser digitado aparece mascarado — `[oculto: 24 caractere(s), C…Z]` —
preservando o que permite decidir sem expor o segredo.

## 10. Auditoria e replay

Trilha encadeada por hash, selo de sessão ao encerrar, e replay **somente
leitura** em três camadas: não existe verbo de escrita na rota; ler o histórico
não ressuscita a sessão; o modo é declarado pelo runtime, não deduzido pela tela.

O replay é honesto sobre a própria leitura: relata linhas corrompidas e fontes
ausentes em vez de devolver uma linha do tempo mais curta que se apresenta como
completa. Sessão que nunca existiu é `404`, não um replay vazio de `200`.

## 11. Requisitos e instalação

| requisito | valor |
|---|---|
| Node.js | ≥ 22.18.0 (medido em 22.23.1 e 26.0.0) |
| Dependências de runtime | `playwright`, `ws` |
| Navegador | Chromium (via `npx playwright install chromium`) |
| Sistema | validado em macOS (Apple Silicon) |
| Build | **não há passo de build** para o runtime — TypeScript nativo do Node |
| Build da UI | `node packages/ui/build.ts` (lê a marca do cofre a cada build) |

## 12. Estado legal

| | |
|---|---|
| Licença | **MIT** |
| Titular | **Voltolini-SPACE** |
| Decidido em | 2026-08-25, pelo dono |

Até essa data o `LICENSE` declarava *todos os direitos reservados* e trazia um
titular **placeholder**, derivado mecanicamente do autor do commit HEAD. O
histórico tem duas identidades de autoria (44 commits `Voltolini-SPACE`, 8
commits `NOMOS Browser <adm@se7enpay.com.br>`), e nenhuma delas prova
titularidade legal por si só. Nenhum agente tem autoridade para escolher isso; o
dono escolheu.

A escolha alinha o NOMOS Browser ao resto do ecossistema: NOMOS e OpenKern
também são MIT.

**A licença cobre o código.** Ela não concede direito sobre as marcas "NOMOS" e
"NOMOS Browser" nem sobre os tokens de identidade visual, que são governados
pelo contrato de marca e não são versionados neste repositório.

A cópia proprietária anterior está preservada em
`evidence/nomos-release/00-freeze/LICENSE-anterior-proprietario.txt`.

## 13. Limitações conhecidas

Declaradas por inteiro em [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) e resumidas:

- **p99 não é reportado** em nenhum caminho de latência: 30 amostras não o
  sustentam, e o instrumento devolve `null` em vez de chamar o máximo observado
  de p99.
- **Não há rota HTTP para emitir token com escopo.** Tokens escopados existem na
  API interna; a ergonomia pública é roadmap.
- **O ramo `pr.page.isClosed()` é inalcançável** em operação normal — defesa de
  corrida, não cobertura.
- Validado em macOS/Apple Silicon; outras plataformas não foram medidas.
- A faixa de estado da UI atualiza por polling de 700 ms (os eventos chegam em
  ~1 ms; a faixa não).

## 14. Integrações

- **NOMOS** — o browser é uma capability governada pela política do dono
  (`~/.nomos/policy.json`), com catálogo MCP assinado e confiança por impressão
  do manifesto normalizado.
- **Gi** — assistente de voz que aciona o browser pelo caminho MCP registrado,
  com cancelamento por barge-in e distinção de cancelamento tardio (`too_late`).
- **Qualquer cliente MCP** — 16 ferramentas, sem acoplamento a modelo.
