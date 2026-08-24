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

## FASE 67 — Primeiro gate executável

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
| `VISION_MOUSE_PASS` | **PARCIAL** | coordenada + mouse provados; **sem `VisionProvider` conectado** |
| `MULTI_AI_PASS` | **PARCIAL** | dois donos na mesma sessão pela API universal; **sem 2º provedor LLM real** |
| `RECOVERY_PASS` | **PARCIAL** | queda de **cliente** coberta; queda do **processo do runtime** não |

As três PARCIAIS não são arredondadas para YES. O gate da FASE 67 **não** está
inteiramente passado.

## Suíte completa

```
node --test "tests/*.test.ts"                → 238 pass, 0 fail  (13 arquivos)
cd sdk-python && python3 -m unittest ...     →  31 pass, 0 fail
```

Total: **269 testes**, todos executados contra Chromium real onde aplicável.

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

## Ainda NÃO provado

Declarado aqui para que a ausência não passe por sucesso:

- Sessão sobrevivendo à queda do processo do runtime (FASE 26 só cobre queda de cliente)
- Handoff entre duas IAs distintas de fornecedores diferentes (FASE 37)
- Visão como fallback real com `VisionProvider` conectado (FASE 49)
- Benchmark NOMOS WEB ARENA (FASE 38)
- Clean room em máquina limpa (FASE 55)
- Autenticação de WebSocket e autorização MCP (ver `SECURITY.md`, T7)

`NOMOS_BROWSER_PRODUCT_01` **não** está em PASS.
