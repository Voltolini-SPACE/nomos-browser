# Registro de evidência

A missão (art. 61) proíbe aceitar como PASS: *"parece funcionar"*, *"funcionou uma
vez"*, *"o código está correto"*, *"o teste unitário passou"*. Cada afirmação aqui
carrega uma classificação:

| Classe | Significa |
|---|---|
| **OBSERVADO** | Aconteceu uma vez, com saída registrada |
| **MEDIDO** | Tem número: contagem, latência, tolerância |
| **REPRODUZIDO** | Reexecutado e deu o mesmo resultado |

Nada é promovido a REPRODUZIDO por parecer determinístico.

---

## FASE 0 — Inventário e checkpoint

`ENTRY_STATE_PASS`

| Item | Valor | Classe |
|---|---|---|
| Host | macOS 26.3.1, arm64 | OBSERVADO |
| Node | v26.0.0 — executa `.ts` nativamente | REPRODUZIDO |
| Python | 3.14.7 | OBSERVADO |
| Chrome do sistema | 151.0.7922.173 | OBSERVADO |
| Chromium do runtime | 151.0.7922.34 (playwright 1.62.1, build 1234) | OBSERVADO |
| Porta 7777 | livre | OBSERVADO |
| Serviços NOMOS vivos | `br.com.se7enpay.nomos.servico`, `com.nomos.panel`, `ai.sovereign.omniroute` | OBSERVADO |
| Checkpoint | `checkpoints/pre-nomos-browser-product-01.json`, sha256 `30ca75f8…64b65` | MEDIDO |

**Não tocado:** nenhum serviço NOMOS em produção foi alterado, parado ou
reconfigurado. O `nomos-panel` mantém seu Chrome CDP próprio em `:9337` com
`user-data-dir=/private/tmp/nomos-panel-cdp` — este projeto não encosta nele.

Reproduzir: `checkpoints/capture.sh <nome>`

---

## FASE 1 — Spike de controle real

`DOM_CONTROL_PASS=YES` · `CDP_MOUSE_PASS=YES` · `SCREENSHOT_PASS=YES`

```
node spike/fase1_spike.ts        → exit 0, 25/25 checks, 525 ms
```

Evidência: `spike/evidence/fase1_result.json` + `viewport.png`, `element.png`,
`fullpage.png`. Classe: **REPRODUZIDO** (executado 3×, mesmo resultado).

### O que torna esses números não-vazios

**O discriminador de realidade.** `CDP-04` afirma que os eventos entregues via
`Input.dispatchMouseEvent` chegam à página com `isTrusted=true`. Isso só
significaria algo se `isTrusted` pudesse valer `false` — por isso `CDP-10`
dispara um clique sintetizado por JavaScript e exige `isTrusted=false`. Sem esse
par, "controlamos o Chromium de verdade" seria indistinguível de teatro.

| Origem do clique | `isTrusted` | Check |
|---|---|---|
| `Input.dispatchMouseEvent` (CDP) | `true` | CDP-04 |
| `element.click()` (JS) | `false` | CDP-10 |

**O mapeamento coordenada↔pixel.** `SHOT-03` confere que o pixel no centro do
`getBoundingClientRect()` do elemento tem a cor daquele elemento — distância RGB
medida `0.00`, tolerância `12`. `SHOT-04` é o controle negativo: 20px à esquerda
do bloco a distância é `284.39`. Sem ele, um decodificador PNG quebrado que
devolvesse sempre a mesma cor passaria em SHOT-03.

**Precisão de coordenada.** `CDP-05` mede a diferença entre a coordenada enviada
ao CDP e a recebida pelo handler da página: `dx=0.00, dy=0.00` (tolerância 1px).

---

## FASE 16 — Formato `.nomosskill`

```
node --test tests/skills.test.ts → 10 pass, 0 fail, 152 ms
```

Classe: **REPRODUZIDO**. Cobre o exemplo literal da missão (forma curta) e a
forma completa, mais as recusas: segredo literal em vez de `credential_ref`,
`retry.max` fora de 0–10 (retry infinito é proibido), `fallback` inexistente,
nome de passo duplicado, tab na indentação.

Alvo só por `selector` ou só por `coordinates` gera **aviso**, não erro — é
frágil, não inválido.

---

## Governança de marca — NOMOS Web

```
node --test tests/ui-build.test.ts → 6 pass, 0 fail
```

| Fato | Evidência | Classe |
|---|---|---|
| `brand-resolve --require-official NOMOS` → `rc=1` | fail-closed | OBSERVADO |
| `brand-resolve NOMOS` → `rc=3` (vigente, não oficial) | v1.0, integridade OK | OBSERVADO |
| Brandbook confere com `SHA256SUMS` | `78bf728b9a59…` | MEDIDO |
| Fonte da UI não contém nenhum hex de marca | teste falha se contiver | REPRODUZIDO |
| Peça gerada declara marca, versão e `PROPOSTA` | selo no rodapé | OBSERVADO |
| Marca inexistente aborta o build | não inventa paleta | REPRODUZIDO |

**Divergência aberta para o dono:** o corpo do `BRANDBOOK_NOMOS.md` afirma
"v1.0 (congelado)" e "v1.0 oficial" na seção 8, mas a governança reporta
`congelamento: NÃO INFORMADO` e `selo: SEM SELO`. Enquanto o resolvedor devolver
`rc != 0` com `--require-official`, toda peça sai `PROPOSTA`. Congelar é ato
humano (LEI art. 7.2) — nenhum agente resolve isso.

---

## GATE-E2E-01 — Primeiro gate executável

*Nome legado: `FASE 67`. A seção 67 da missão nunca foi uma fase; é o gate de
aceitação. Mapeamento preservado em `docs/RASTREABILIDADE.md` — o registro do
erro fica, ele não é apagado.*

```
node --test tests/e2e-gate.test.ts   → 12/12, contra daemon e Chromium REAIS
```

| Flag | Valor | Base |
|---|---|---|
| `RUNTIME_INDEPENDENCE_PASS` | **YES** | detach → sessão viva e listada → attach → URL e conteúdo preservados |
| `DOM_PASS` | **YES** | find/click/extract com `verified=true`, `confidence=1` |
| `ACCESSIBILITY_PASS` | **YES** | botão achado na árvore AX; `type` resolvido por role+label |
| `HANDOFF_PASS` | **YES** | NOMOS → AGENTE-B → NOMOS preservando URL e estado da página |
| `AUDIT_PASS` | **YES** | `actions.jsonl` ≥ 5 linhas, sem `set-cookie`/`authorization` |
| `REPLAY_PASS` | **YES** | bundle reconstruído, linha do tempo em ordem de timestamp |
| `VISION_MOUSE_PASS` | **YES** (era PARCIAL) | `VisionProvider` injetado pelo daemon desde `3f62706`; cascata chega ao degrau `vision` e o clique cai dentro do alvo — erro medido **4,1 px** em alvo 160x100 (`evidence/nomos-browser-final-loop/06-cascata/out/e2e-visao.json`) |
| `MULTI_AI_PASS` | **PARCIAL** (inalterado) | dois donos na mesma sessão pela API universal, provado. Dois provedores LLM **de fornecedores diferentes** em produção continuam não provados — o que existe é `ai_provider` + `ai_provider_fallback`, ambos medidos sobre Ollama local |
| `RECOVERY_PASS` | **YES** (era PARCIAL) | queda do **processo** coberta com `SIGKILL` real, 3/3 (`evidence/nomos-browser-final-validation/04-recovery/recovery-repeticao.log`); tasks retomam de checkpoint sem repetir efeito |

Duas das três PARCIAIS fecharam com medição. `MULTI_AI_PASS` **continua
PARCIAL** e não é arredondada para YES: o `GATE-E2E-01` ainda não está
inteiramente passado.

## Suíte completa

**Medido em 2026-08-25, 01:09–01:12 (UTC-3), HEAD `78491cc`**, nesta máquina,
com o executor do repositório (um arquivo por vez, timeout próprio):

```
bash scripts/run-suite.sh --out /tmp/suite-doc
   → TS_PASS=696  TS_FAIL=0  ARQUIVOS_OK=33  ARQUIVOS_RUINS=0   (161 s)

cd sdk-python && python3 -m unittest discover -s tests
   → Ran 31 tests in 0.642s ... OK
```

Total: **727 testes** (696 TypeScript + 31 Python), zero falhas, zero arquivos
mortos por contenção. Classe: **MEDIDO**.

Escopo: medido contra o **HEAD commitado `78491cc`**. Trabalho não commitado de
outra frente que estava na árvore no momento (incluindo um `tests/config-schema.test.ts`
novo) **não** entra nesta contagem — quando entrar, o número tem de ser remedido.

Evidência bruta desta medição:
`evidence/nomos-browser-final-loop/18-docs/resumo.tsv`,
`evidence/nomos-browser-final-loop/18-docs/run-suite.out`, `evidence/nomos-browser-final-loop/18-docs/sdk-python.out`.

**Correção de documento:** esta seção afirmava *"238 pass"* e *"269 testes"* em
*"13 arquivos"*. Era verdade em PRODUCT-01 e deixou de ser. Medições intermediárias
registradas no caminho, para que a série não se perca: **487** (com 2 arquivos
`MORTO` por contenção de memória) e **552** em 24 arquivos, ambas em
`evidence/nomos-browser-final-validation/FINAL_REPORT.md`; **593** em 27 arquivos
em `evidence/nomos-browser-final-loop/16-regressao/suite/resumo.tsv`. O salto de
593 para 696 são os arquivos de teste que entraram com o task engine, os
providers, o ownership, o supervisor e o watchdog ligado — 27 arquivos passaram a
33.

## Defeitos encontrados na integração

Coisas que testes de módulo isolado não pegam, porque só existem na costura:

**1. Screenshots não chegavam ao disco.** `SessionRecorder` existia e o daemon
nunca o chamava. O `screenshot_ref` vivia só na memória do processo, então
`sessions/<id>/screenshots/` ficava vazio e o replay visual era impossível.
Ligado no handler; `persisted:false` é reportado quando a gravação falha, nunca
silenciado.

**2. `screenshot_ref` não era endereçável.** A NOMOS Web montava `src` a partir
do id opaco e exibia imagem quebrada. Criada a rota `GET /screenshots/:sid/:ref.png`
e o campo `screenshot_url`, que só aparece quando o arquivo existe de fato —
devolver link para arquivo ausente seria pior que não devolver.

**3. A UI não conseguia falar com o runtime.** Origens diferentes, sem CORS.
Resolvido servindo a UI **no próprio daemon** (mesma origem) em vez de liberar
`Access-Control-Allow-Origin` — o CORS permissivo abriria a ameaça T7 do
`SECURITY.md`, deixando qualquer página aberta no navegador do dono dirigir o
runtime. A rota de screenshot valida os segmentos por formato e reconfere a raiz
resolvida; `..` e `%2e%2e` devolvem 404 (verificado).

**4. Takeover — uma correção minha que estava errada.** Ao ver o feed inundado
de `CONTROL_HELD_BY_HUMAN`, liberei `OBSERVE` durante o controle humano para a
UI continuar espelhando. Errado: o humano assume o controle justamente para
digitar o que não quer delegar (senha, 2FA), e ler o DOM nesse instante é o
vazamento que o takeover existe para impedir. Revertido — congela tudo. O
sintoma era do cliente, e a correção certa foi a UI parar de pedir screenshot
enquanto congelada.

**5. `e2e-gate` passava sozinho e falhava na suíte.** `console.log` no `after()`
corrompia o canal serializado que o `node --test` usa entre processos
("Unable to deserialize cloned data"). Movido para stderr. Um teste que só passa
isolado é um teste que mente sobre o conjunto.

## FASE 30/31/32 — NOMOS Web

Renderizada e inspecionada em navegador real (`http://127.0.0.1:7788`).

| Item | Situação | Classe |
|---|---|---|
| Layout (barra, rail, palco, rodapé) | conforme o desenho da missão | OBSERVADO |
| Tokens do cofre aplicados | dark terminal, verde-neon | OBSERVADO |
| Selo PROPOSTA visível no rodapé | sim | OBSERVADO |
| Runtime ausente → degrada com aviso | "runtime inalcançável em `127.0.0.1:7777`" | OBSERVADO |
| Espelha a página real sob controle do runtime | sim, servida pelo daemon | OBSERVADO |
| Cursor ◉ NOMOS sobre o alvo, com rótulo da ação | "◉ NOMOS clicando" sobre o botão | OBSERVADO |
| Feed de eventos ao vivo | `mouse.moved`, `mouse.clicked`, `action.*` | OBSERVADO |
| Takeover congela e devolve | `control.taken` → overlay → `control.returned` | REPRODUZIDO |

### Defeitos encontrados e corrigidos na inspeção visual

1. `#tela { display:block }` vencia o atributo `hidden`, e a moldura quebrada da
   imagem aparecia sobre o aviso. Corrigido com `#tela[hidden]{display:none}`.
2. `BASE` usava `location.origin`: servida em `:7788`, a UI apontava para si
   mesma e reportava "runtime inalcançável" contra a própria porta. Agora só
   reusa a origem quando é o daemon (`:7777`) que serve a página.

Ambos foram achados por screenshot, não por leitura de código.

---

## O que foi fechado depois do PRODUCT-01 — medido

Cada linha aponta para um arquivo de evidência. Nada aqui vale por afirmação.

### Procedência anti-injeção ligada ao caminho de execução (`bc7130f`)

`INJECTION_PROTECTION_WIRED=PASS`. Antes: `sanitize.ts` tinha 22 testes verdes e
**o daemon nunca o chamava** — `observe` e `extract` devolviam o payload cru e
sem marcação (`evidence/nomos-browser-final-validation/05-security/out/prova-injecao.json`,
`INJECTION_PROTECTION_WIRED=NAO`).

| Fato | Valor | Classe |
|---|---|---|
| Ataques classificados severidade alta | **8/8** | MEDIDO |
| Páginas legítimas com o cru preservado | **6/6** | MEDIDO |
| Modos da política `raw_web_content` corretos | **3/3** | MEDIDO |
| Trecho literal do payload ausente do audit | sim | OBSERVADO |
| Suíte | `tests/injection-wired.test.ts` → 16 pass, 0 fail | REPRODUZIDO |

Verificação independente: `evidence/nomos-browser-final-loop/02-injection/verificacao-independente.ts`.

### Auditoria forense (`bc7130f`)

`AUDIT_COMPLETE=PASS`, pelo **mesmo script da validação, intocado**
(`evidence/nomos-browser-final-validation/06-audit/prova-auditoria.ts`). Antes:
negação `403` deixava zero linhas, handoff/takeover/release deixavam zero linhas,
`actor` era `"unknown"` em 100% dos registros. Agora `AuditEntry` tem **19 campos
obrigatórios** e uma única fábrica que recusa chave faltando. Ver `docs/AUDIT.md`.
Classe: **REPRODUZIDO** (`tests/audit-forense.test.ts` → 12 pass).

### Clique com prova de entrega (`bc7130f`)

Antes: `browser.click` devolvia `HTTP 200` e `success:true` para alvo fora do
viewport **sem entregar clique nenhum**.

| Fato | Valor | Classe |
|---|---|---|
| Alvos acertados por `evidence/nomos-browser-final-validation/03-vision/medir-coordenadas.ts` | **6/6** (antes 4/6) | MEDIDO |
| Erro médio e máximo de coordenada | **0,000 px** | MEDIDO |
| Sem prova de entrega, o retorno é | `TARGET_NOT_ACTIONABLE` ou `CLICK_NOT_DELIVERED` | OBSERVADO |
| Suíte | `tests/click-entrega.test.ts` → 21 pass | REPRODUZIDO |

Reprodutor do caso mais difícil (link que navega e destrói o contexto de JS antes
de `page.url()` mudar): `evidence/nomos-browser-final-loop/04-click/repro-link-navegante.ts`.

### Providers no runtime e cascata até a visão (`3f62706`)

`grep VisionProvider packages/api/src` devolvia **0**: o degrau `vision` nunca
executava em produção. Agora o daemon constrói e injeta os dois providers.

| Fato | Valor | Classe |
|---|---|---|
| Erro de localização visual, alvo 160x100, mira `point` | **4,1 px** (era 82,6 px com o prompt antigo) | MEDIDO |
| Margem até a borda do alvo | 49 px | MEDIDO |
| Estabilidade com seed fixo (execuções 2 e 3 idênticas) | 9/9 células | REPRODUZIDO |
| Refino por recorte | **REFUTADO** — piora ou empata em 9/9 | MEDIDO |
| `moondream:1.8b` | **REFUTADO** — confiança 0,67 em alvo inexistente, abaixo do limiar 0,7 | MEDIDO |
| `qwen2.5vl:7b` | **não coube em memória** — não avaliado | — |
| Suíte | `tests/providers-runtime.test.ts` (14), `tests/cascata-percepcao.test.ts` (18), `tests/vision.test.ts` (50) | REPRODUZIDO |

Evidência: `evidence/nomos-browser-final-loop/06-cascata/out/e2e-visao.json`,
`evidence/nomos-browser-final-loop/06-cascata/out/medir-refino-aim.log`, `evidence/nomos-browser-final-loop/06-cascata/out/medir-refino-canonico.json`. Números por tamanho de alvo
em `docs/LIMITATIONS.md`.

### Task engine persistente (`3f62706`)

`TASK_ENGINE=PASS` (`evidence/nomos-browser-final-loop/16-regressao/verificacao-5-6-9.log`),
com `TASK_RESUME`, `TASK_IDEMPOTENCY`, `TASK_CANCEL`, `TASK_CRASH_RECOVERY` e
`TASK_CLEANUP` todos `PASS`.

A prova decisiva: `SIGKILL` real no meio de 12 passos → retoma em **6/12** e
termina **12/12 com zero passos repetidos**, medido contando requisições no
servidor de fixture — um ledger que o motor **não controla**. Classe: **MEDIDO**.
Suíte: `tests/task-engine.test.ts` → 19 pass. Ver `docs/TASK-ENGINE.md`.

### Ownership com lease obrigatório e T7 fechado (`8cd9fff`)

| Fato | Valor | Classe |
|---|---|---|
| Bateria de segurança | **53/53 vetores**, `OPEN_SECURITY_P1=0` | MEDIDO |
| `allow_unleased` | passou de `true` para **`false`** por padrão | OBSERVADO |
| Sequestro de sessão por header auto-declarado | corrigido — o principal é o **sujeito do token** | OBSERVADO |
| `session_allowlist` nas rotas de ação | corrigido — valia só onde o id vinha no caminho/query | OBSERVADO |
| Suíte | `tests/ownership.test.ts` (11), `tests/lease.test.ts` (37), `tests/auth.test.ts` (21), `tests/mcp.test.ts` (30) | REPRODUZIDO |

Evidência: `evidence/nomos-browser-final-loop/11-security/out/bateria-completa.json`.
Grupos cobertos: REST_AUTH (6), WEBSOCKET_AUTH (6), MCP_AUTHORIZATION (3),
SSRF_PROTECTION (10), FILESYSTEM_PROTECTION (6), CAPABILITY_ENFORCEMENT (6),
INPUT_HARDENING (6), SECRET_LEAK_TEST (4), SESSION_ISOLATION (3) e
**CONTROLES_POSITIVOS (3)** — sem os controles positivos, uma bateria que barra
tudo (inclusive o legítimo) passaria por segurança perfeita.

### Replay selado (`8cd9fff`)

Selo sha256 do bundle, rota `GET /v1/sessions/:id/replay/verify` e comando de
CLI. Bundle adulterado, reordenado ou truncado é recusado — inclusive com JSON
válido e timestamps em ordem. Antes, `replay-verify.ts` tinha 791 linhas e
**zero usos** fora do próprio teste. Suíte: `tests/replay-hardening.test.ts` → 44
pass. **Resíduo declarado:** hash **sem chave** (ver `docs/LIMITATIONS.md`).

### Watchdog e supervisão (`8cd9fff`)

`evidence/nomos-browser-final-loop/14-supervisor/out/supervisor.json` — **11/11
passos** contra o launchd real: instalação, `/health` ok, segundo `start`
recusado (`rc=9`, mesmo PID), `SIGTERM` sem resíduo, saída limpa não
ressuscitada, `SIGKILL` com PID novo, `kickstart -k` saudável, `stop` sem
resíduo, crash-loop freado (4 tentativas, janela 32 s, teto 5), `uninstall`
limpo, e **serviços de produção intactos com os mesmos PIDs**.

**Limite declarado: reboot real NÃO executado** — a máquina é de produção; o
`kickstart -k` é declarado como **simulação**. Classe: **OBSERVADO**, não
REPRODUZIDO para reboot.

Suíte: `tests/supervisor.test.ts` (10), `tests/watchdog-wired.test.ts` (8).

### Integração NOMOS e Gi (`78491cc`)

`NOMOS_TRANSPORT_E2E=PASS` — **18 casos, 0 falhas**, com um cliente stdio
reimplementado a partir do `ClienteMCP` do NOMOS (mesmo handshake, mesmo
protocolo, subprocesso com cwd do manifesto), contra daemon e Chromium **reais**:
descoberta com as 13 tools e seus níveis, recusa por falta de credencial, sessão
criada pelo adaptador, clique que muda o DOM, extração que vê a mudança, erro de
execução com o código do contrato, cancelamento, timeout e reconnect com a sessão
sobrevivendo ao adaptador.
Evidência: `evidence/nomos-browser-final-loop/07-nomos/cliente-fiel-saida.txt`.

Gi: `GI_BROWSER_INTEGRATION=PASS`, 0 casos com falha
(`evidence/nomos-browser-final-loop/08-gi/e2e-gi-saida.txt`). Com categoria A2 a
Gi **não move a aba** — conferido pelo próprio navegador, não pelo relatório.

**E o que NÃO está fechado:** `GI_BROWSER_ACTION=BLOQUEADO_POR_APROVACAO`. O
registro do manifesto no catálogo de confiança (`nomos mcp confiar`) é **ato do
dono**; o pedido foi enfileirado (`A5 alvo=mcp:confiar:nomos-browser`) e
**expirou por TTL sem resposta**. O transporte está provado; o registro, não.
Descrever essa integração como "pronta" seria falso.

---

## Ainda NÃO provado

Declarado aqui para que a ausência não passe por sucesso. Revisado em
**2026-08-25** contra o estado de HEAD `78491cc` — itens que fecharam saíram
desta lista **e aparecem acima com a medição que os fechou**.

**Bloqueado por ato do dono (não é trabalho de engenharia):**

- **Registro do browser no catálogo MCP do NOMOS.** `nomos mcp confiar` grava o
  hash do manifesto e é ato do dono. Estado: `BLOQUEADO_POR_APROVACAO`, pedido
  expirado por TTL. Comandos exatos em `docs/NOMOS-INTEGRATION.md`.
- **Congelamento da marca NOMOS.** Enquanto `brand-resolve --require-official`
  devolver `rc != 0`, toda peça sai `PROPOSTA`.
- **Escolha de licença.** `LICENSE` está em "todos os direitos reservados", com
  titular em placeholder explícito.

**Não medido / não executado:**

- **Reboot real da máquina.** Só simulado com `launchctl kickstart -k`.
- **Handoff entre duas IAs de fornecedores diferentes em produção.** O que está
  provado é dois **donos** na mesma sessão pela API universal, e roteamento com
  fallback entre dois modelos **do mesmo backend local**.
- **Benchmark NOMOS WEB ARENA.** `bench.ts` tem 37 testes verdes e nenhum
  benchmark de arena foi executado.
- **Swarm / multiagente.** Não existe; só handoff de dono de sessão.
- **Localização visual em alvos abaixo de 80 px de largura.** Sem dado.
- **`qwen2.5vl:7b`.** Não coube em memória nesta máquina; não avaliado.
- **Clean room a partir de uma tag.** Clean room foi provado a partir do HEAD;
  não há tag no repositório para reproduzir a partir dela (`docs/RELEASE.md`).

**Resíduos estruturais declarados** (não são "a fazer" — são propriedades desta
versão, listadas em `docs/LIMITATIONS.md`):

- Selo de replay é hash **sem chave**.
- **Sem sandbox de processo por sessão.**
- **Um dono por máquina**; sem multiusuário.
- Sem clipboard, sem `localStorage`/`sessionStorage`, sem API de cookie.

---

`NOMOS_BROWSER_PRODUCT_01` e `PRODUCT-02`: o núcleo está medido e verde, e as
lacunas remanescentes estão nominalmente listadas acima. **Nenhum selo de
"produto finalizado" é emitido aqui** — isso depende de atos do dono que não
aconteceram.
