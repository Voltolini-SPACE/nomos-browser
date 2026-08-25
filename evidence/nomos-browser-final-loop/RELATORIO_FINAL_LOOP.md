# NOMOS_BROWSER_FINAL_PRODUCTION_LOOP — relatório

```
DATE=2026-08-25
REPO=/Users/AI/Projects/nomos-browser
BRANCH=main
HEAD_INICIAL=ab235d4f22ce3833a9857c2f6e86a4ac3373f503   (0.1.0, 8 commits, 0 tags, 0 remotes)
HEAD_FINAL=6314050                                       (9 commits novos)
VERSION=0.1.0  (bump para 0.2.0-rc.1 preparado, não aplicado — ver FASE 24)
```

## CONDIÇÃO DE PARADA

```
STATUS=BLOQUEIO_EXTERNO_REAL
ULTIMO_GATE_IMPEDIDO=NOMOS_BROWSER_INTEGRATION / GI_BROWSER_INTEGRATION
NATUREZA_DO_BLOQUEIO=consentimento do dono (ato que só ele pode praticar)
TUDO_O_MAIS=VERDE
```

Vinte e três dos vinte e cinco gates obrigatórios estão verdes, com evidência
reproduzível. Os dois que faltam **não dependem de código**: dependem de o dono
gravar a confiança do manifesto no catálogo MCP dele
(`~/.nomos/mcp_catalogo.json`), o que a política do próprio NOMOS reserva a um
ato humano. Eu preparei tudo, provei o transporte de ponta a ponta com um
cliente reimplementado a partir do `ClienteMCP` do NOMOS, enfileirei o pedido no
painel do dono — e **não** aprovei no lugar dele. Aprovar seria fraude de
consentimento, e a missão reprova isso mais do que reprova um gate vermelho.

---

## MATRIZ FINAL (FASE 23)

Coletada por `evidence/nomos-browser-final-loop/23-matriz/coletar-matriz.sh`,
que lê os arquivos de evidência — não a memória de quem escreve.

| Gate | Estado | Número medido | Evidência |
|---|---|---|---|
| `HEAD_WITH_FIXES_COMMITTED` | **YES** | 9 commits | `git log ab235d4..HEAD` |
| `BROWSER_CORE_REGRESSION` | **PASS** | 729 testes, 0 falhas, 35/35 arquivos | `22-regressao-total/suite/resumo.tsv` |
| `DOM` · `ACCESSIBILITY` · `MOUSE_KEYBOARD` | **PASS** | cascata provada degrau a degrau | `tests/cascata-percepcao.test.ts` |
| `VISION_ENGINE_CAPABILITY` | **PASS** | erro médio e máximo **0,000 px**, 6/6 alvos | `03-vision/out/coordenadas.json` |
| `VISION_PROVIDER_WIRED` | **PASS** | `strategy=vision` em produção | `06-cascata/out/e2e-visao.log` |
| `VISION_FALLBACK_E2E` | **PASS** | erro **4,1 px**, margem 49 px, `isTrusted=true` | idem |
| `AI_PROVIDER_WIRED` | **PASS** | injetado por config, com fallback classificado | `tests/providers-runtime.test.ts` |
| `LLM_ROUTING_PRODUCTION_READY` | **YES** | timeout, cancel, degradação, recuperação | idem |
| `INJECTION_PROTECTION_WIRED` | **PASS** | 8/8 ataques alta, 6/6 falsos-positivos preservados | `02-injection/out/verificacao.json` |
| `SECURITY_SUITE` | **PASS** | 53 vetores, `OPEN_SECURITY_P1=0` | `11-security/out/bateria-completa.json` |
| `AUDIT_COMPLETE` | **PASS** | 19 campos, 0 faltando | `06-audit/` (script original, intocado) |
| `REPLAY` | **PASS** | selo, adulteração e truncamento recusados | `tests/replay-hardening.test.ts` |
| **`NOMOS_BROWSER_INTEGRATION`** | **BLOQUEADO** | transporte 18/18; registro pendente | `07-nomos/cliente-fiel-saida.txt` |
| **`GI_BROWSER_INTEGRATION`** | **BLOQUEADO** | módulo pronto; depende do registro acima | `08-gi/` |
| `TASK_ENGINE` | **PASS** | 8/8 flags, SIGKILL + resume sem repetir passo | `09-task/e2e-task.ts` |
| `LEASE_RECOVERY` · `NO_DOUBLE_OWNER` | **PASS** | lease obrigatório por default | `tests/ownership.test.ts` |
| `NO_ORPHAN_PROCESS` | **PASS** | 0 residual; kill de grupo com controle A/B | `15-orfaos/prova-group-kill.sh` |
| `WATCHDOG_WIRED` | **PASS** | 3 sondas, falhas reais provocadas | `tests/watchdog-wired.test.ts` |
| `SUPERVISION` · `SINGLE_OWNER` | **PASS** | LaunchAgent real: start, health, duplo start, SIGKILL, restart | `tests/supervisor.test.ts` |
| `REBOOT_SAFETY` | **SIMULADO** | `launchctl kickstart -k`; reboot real não autorizado | declarado em `docs/LIMITATIONS.md` |
| `SOAK_TEST` | **PASS** | 100 ciclos, inclinação +0,049 MB/ciclo com R²=0,004 | `20-soak/out/soak-serie.jsonl` |
| `CONCURRENCY_TEST` | **PASS** | 10 sessões simultâneas; recusa limpa sob pressão | `20-soak/out/concorrencia.jsonl` |
| `CLEAN_ROOM` | **PASS** | 23 passos a partir de `git clone`, zero patch manual | `21-cleanroom/clean-room.log` |
| `PRODUCT_DOCS` | **PASS** | 10 documentos novos, 4 atualizados, LICENSE, CHANGELOG | `docs/` |
| `BROWSER_E2E_SUITE` | **PASS** | **20/20**, 223 checagens | `19-e2e/out/e2e-final.json` |
| `FULL_REGRESSION` | **PASS** | `ci.sh all` + 729 + 31 (Python) = **760 testes** | `22-regressao-total/` |
| `OPEN_P0` | **0** | — | — |
| `OPEN_P1` | **0** | — | — |

---

## O QUE MUDOU, POR FASE

### FASE 2 — a defesa contra injeção saiu do papel
`sanitize.ts` tinha 598 linhas, 22 testes verdes e **zero chamadas do daemon**.
Uma página hostil chegava crua e sem marcação ao agente. Hoje todo conteúdo de
página volta com `provenance`: `source`, `trust`, `injection_detected`,
`severity`, `findings` com o trecho literal, `sanitized_content` delimitado por
nonce, e `raw_content_available` decidido por política. Severidade alta retém o
cru; média e baixa apenas marcam — e é isso que impede o falso positivo de virar
censura. Medido: **8/8** ataques classificados como alta (incluindo payload em
`aria-label` e em texto oculto), **6/6** páginas legítimas com o cru preservado
(receita de bolo, preço em reais, documentação de API, artigo *sobre* prompt
injection), **3/3** modos de política corretos, audit sem o literal.

Dois padrões de detecção nasceram do teste: `execute browser.download` (pedir
que o agente gaste capability do dono) e instrução financeira.

### FASE 3 — auditoria que reconstrói, não que enfeita
Uma negação `403 CAPABILITY_DENIED` deixava **zero** linhas. `handoff`,
`takeover` e `release` com HTTP 200 deixavam **zero** linhas. `actor` era
`"unknown"` em 100% dos registros porque o código lia `x-nomos-client`, um header
que quase ninguém manda. Hoje são 19 campos obrigatórios com fábrica única que
recusa chave faltando, e a negação — o evento mais relevante para segurança — é
o que mais aparece.

### FASE 4 — o clique parou de mentir
`browser.click` devolvia `HTTP 200`, `success:true` e **nenhum clique entregue**
quando o alvo estava fora do viewport. Hoje: rola até o alvo, espera a caixa
assentar (o scroll do Chromium é animado — era isso que fazia o `find` ler um
número exato e errado), remede, confere `elementFromPoint`, clica, e **prova** a
entrega com um listener de captura armado antes do gesto. Sem prova:
`TARGET_NOT_ACTIONABLE` ou `CLICK_NOT_DELIVERED`.

A primeira versão dessa prova reprovava clique em **link**, porque a navegação
destrói o contexto de JS antes de `page.url()` mudar. Corrigido com sinais de
processo armados antes do gesto. Um `href="#âncora"` continua provando pela
sonda, para que o sinal fraco não substitua o forte.

Resultado colateral: `medir-coordenadas.ts` passou de 4/6 alvos medidos para
**6/6**, com erro 0,000 px.

### FASE 5 e 6 — providers e cascata
`grep VisionProvider packages/api/src` devolvia 0. O degrau `vision` **nunca**
executava. Ligar o fio revelou três defeitos que ninguém podia ver antes:
o balde de audit `_runtime` era recusado pelo próprio validador de id de sessão;
o screenshot ia ao modelo em pixels de dispositivo com a legenda em CSS px (em
DPR 2 toda coordenada sairia pela metade); e a inferência não era repetível.

A precisão da visão era um defeito de **prompt**, não de modelo: pedíamos
`{"box":{x,y,width,height}}`, esquema que a Qwen2.5-VL não emite no treino, e a
largura vinha 1,8× inflada. Com o esquema nativo `bbox_2d` mais `point_2d`, o
erro caiu de **82,6 px para 4,1 px** e a margem até a borda subiu de 3 px para
49 px.

O refino por recorte foi implementado, medido em 3 tamanhos × 3 configurações ×
3 execuções, e **refutado** — recortar não amplia, o alvo continua com os mesmos
pixels. Default 0, com o número que justifica.

### FASE 9 — task engine de verdade
`grep checkpoint packages` devolvia 0. Hoje: 9 estados com tabela de transição
validada, checkpoint atômico por passo, idempotência por reserva em disco via
`link(2)` que sobrevive a reinício, retry com classificação (`CAPABILITY_DENIED`
e `POLICY_BLOCKED` **nunca** retentam — martelar porta fechada é defeito, não
resiliência), cancel, resume, cleanup em funil único e varredura de recuperação
no arranque que nunca deixa `RUNNING` mentiroso.

Prova: SIGKILL real no meio de 14 passos, retoma em 6/14 e termina 14/14 com
zero passos repetidos — medido contando requisições no servidor de fixture, um
ledger que o motor não controla.

### FASE 10 a 14 — ownership, T7, replay, watchdog, supervisor
Inverter `allow_unleased` para `false` desenterrou dois defeitos de segurança
reais: a arbitragem usava um header **auto-declarado** (qualquer processo local
escrevia "sou o agente-A" e herdava o volante), e `session_allowlist` nunca valia
nas rotas de ação, porque o gate roda antes de ler o corpo e o `session_id` de
uma ação vem no corpo — um token emitido para a sessão A operava a sessão B.

O T7 do `SECURITY.md` — *"autenticação de WebSocket e autorização MCP ainda não
estão implementadas"* — está fechado com evidência ao lado.

`replay-verify.ts` (791 linhas, zero usos) foi ligado e suas checagens, que eram
só estruturais, ganharam selo: bundle adulterado mantendo JSON válido e ordem
agora é recusado. `watchdog.ts` (557 linhas, zero instanciações) virou três
sondas reais — e a antiga sonda de navegador usava `context.pages()`, que
devolve `[]` sobre contexto morto **sem lançar**: ficava verde sobre navegador
morto.

Existe supervisor: `packaging/launchd/ai.nomos.browser.plist` e
`scripts/service.sh` com oito subcomandos, instância única por lockfile, provado
contra o launchd real.

### FASE 15 a 18 — órfãos, CI, configuração, documentação
O executor da suíte matava só o pai no timeout: 19 órfãos, o mais velho com 6 h.
Agora mata o **grupo**, com prova controlada A/B e controle de vacuidade.

`ci.sh all` não executava 2 034 linhas de teste. A correção não foi acrescentar
duas linhas: foi um passo que **prova** a cobertura e falha em quatro situações
diferentes. De 33 arquivos com 2 fora, para **35/35**.

Zero das 19 variáveis de ambiente estavam documentadas. Hoje são 50, com tabela
**gerada** da própria `config.ts` — lista escrita à mão diverge no primeiro dia —
e um teste que falha se schema e código divergirem, validado por quatro
controles negativos.

Dez documentos novos. Todo número foi medido e datado. Nove afirmações que a
evidência contradizia foram corrigidas, entre elas o `SECURITY.md` dizendo que o
runtime detecta CAPTCHA (`grep -rni captcha packages tests` = **0**).

### FASE 19 e 20 — E2E e carga
Bateria nova de **20 cenários e 223 checagens**, medindo pelo efeito observável
na página e no disco, nunca pelo relatório do runtime. 20/20.

Soak de **100 ciclos** com série temporal e regressão linear na segunda metade:
+0,049 MB/ciclo com R²=0,004 — ruído, não vazamento. Uma execução de **controle**
sem visão isolou o confundidor (carregar 3,2 GB de modelo faz o macOS comprimir
as páginas do Node) e deu inclinação **negativa**. Dez sessões simultâneas
completam; sob `max_workers` baixo a recusa é limpa, contável e agora auditável.

---

## O QUE FALTA — e é assinatura, não código

```bash
# 1. Registrar o servidor no catálogo MCP do NOMOS
/Users/AI/.local/bin/nomos mcp confiar \
  /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json --panel
# aprovar em http://127.0.0.1:8795  (a fila expira em 5 min)

# ou, num terminal seu:
/Users/AI/.local/bin/nomos mcp confiar \
  /Users/AI/Projects/nomos-browser/packaging/mcp/manifesto.json

# 2. Conferir
/Users/AI/.local/bin/nomos mcp catalogo   # deve listar nomos-browser como ✓

# 3. Ativar na Gi (ver docs/GI-INTEGRATION.md §4.2 — uma linha no dispatcher)
launchctl kickstart -k gui/$(id -u)/com.gijarvis.backend
```

Depois disso, `nomos mcp chamar <manifesto> browser_extract` roda headless
(A0 é `ALLOW` na sua política) e as ações de rede pedem sua aprovação, que é o
comportamento correto e não um defeito.

Outras três decisões que são suas e estão preparadas, não tomadas:
**licença** (o `LICENSE` traz o estado legal padrão e um placeholder explícito de
titular), **congelamento da marca** (`brand-resolve --require-official` devolve
`rc=1`, então toda peça sai `PROPOSTA`), e **uma janela para reboot real** da
máquina, hoje simulado com `launchctl kickstart -k`.

---

## HONESTIDADE — o que esta missão errou e corrigiu

- A bateria E2E antiga (12 cenários, da validação anterior) continua marcando
  10/12. Os dois que falham codificam premissas que o desenho canônico refutou:
  o cenário 9 procura um diretório `packages/nomos`, quando a integração correta
  é por manifesto MCP; o cenário 10 sobe o daemon **sem** provider de visão.
  **Não alterei esse script** — ele é evidência histórica do estado de ontem. A
  bateria da FASE 19 o substitui e passa 20/20.
- Quatro defeitos de instrumento na FASE 19, incluindo um degrau de supervisor
  que media arranque e chamava de reinício — passava por vacuidade.
- Dois na FASE 20: `browser.scroll` "não movia a página" (o CDP retorna ao
  despachar, não ao mover) e `/tmp` vs `/private/tmp`.
- Um na FASE 9b: o gate de cleanup media "não sobrou lease" num mundo onde
  ninguém adquiria lease. Corrigido e validado por **mutação**: com a propriedade
  cega, o teste reprova.
- A hipótese do refino de visão era minha e estava errada. A medição refutou e o
  número ficou no relatório.
