# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento pretendido: [SemVer](https://semver.org/lang/pt-BR/).

**Nada foi lançado ainda.** O repositório não tem nenhuma tag
(`git tag -l` devolve vazio) e `package.json` declara `0.1.0` desde o início.
Portanto tudo abaixo está em `[Não lançado]`. Anunciar uma versão que nunca foi
marcada seria o tipo de mentira que o resto desta documentação existe para
evitar. O procedimento para produzir a primeira versão real está em
[docs/RELEASE.md](docs/RELEASE.md).

Desvio deliberado do formato: dentro de `[Não lançado]` as mudanças estão
agrupadas **por commit**, e não só por categoria. As mensagens de commit deste
projeto descrevem defeito, causa raiz e correção; agrupar tudo por categoria
dissolveria essa cadeia. Cada bloco traz o sha, e dentro dele as categorias do
Keep a Changelog.

Legenda usada nos itens:
**⚠ INCOMPATÍVEL** = muda comportamento observável de quem já usa a API.

---

## [Não lançado]

### `78491cc` — Integração canônica com o NOMOS e binding da Gi (2026-08-25)

#### Adicionado
- `packaging/mcp/manifesto.json`: as 13 tools MCP classificadas por risco real —
  `A0_READ_LOCAL` (5), `A2_NET_EGRESS` (7), `A5_CODE_EXEC` (1), com
  `nivel_padrao: A5` para que tool futura não classificada nasça travada.
  Nada foi rebaixado para escapar do gate de aprovação: `browser_scroll` é A2
  porque dispara lazy-loading, `browser_press` é A2 porque Enter em formulário
  **é** o envio.
- `packaging/mcp/servidor.mjs`: lançador ao lado do manifesto. O `comando` do
  manifesto entra no hash de confiança, então um caminho com `../..` amarraria a
  confiança ao layout do repositório.
- `scripts/nomos-register.sh`: valida o manifesto, imprime o SHA-256 a registrar
  e mostra os comandos de consentimento. **Ele pede, nunca aprova.**
- `docs/NOMOS-INTEGRATION.md` e `docs/GI-INTEGRATION.md`.
- Guarda de CI que valida o manifesto (JSON válido, níveis em A0..A6, toda tool
  de `tools.ts` presente no mapa), verificada por controle: remover uma tool ou
  rebaixar o `nivel_padrao` faz o passo falhar.

#### Alterado
- O adaptador MCP passa a **resolver a sessão sozinho**: quem chama pelo NOMOS
  não precisa entender sessões, e o `session_id` volta no cabeçalho para quem
  quiser continuar.

#### Não fechado — depende do dono
- O **registro no catálogo de confiança do NOMOS** (`nomos mcp confiar`) é ato do
  dono. O pedido chegou a ser enfileirado (`nomos approvals list` mostrou
  `A5 alvo=mcp:confiar:nomos-browser`) e **expirou por TTL sem resposta**.
  Estado registrado: `BLOQUEADO_POR_APROVACAO`. O transporte está provado
  (`NOMOS_TRANSPORT_E2E=PASS`, 18/18 casos); o registro, não.

### `8cd9fff` — Ownership com lease obrigatório, T7 fechado, replay selado, watchdog e supervisor (2026-08-25)

#### ⚠ INCOMPATÍVEL
- **`allow_unleased` passou de `true` para `false` por padrão.** Uma sessão sem
  lease deixou de ficar aberta a qualquer chamador local. Cliente que não
  adquire, herda ou aguarda lease agora recebe `CONTROL_NOT_OWNED`. O modo
  antigo continua disponível via `NOMOS_BROWSER_ALLOW_UNLEASED=true`, e
  desligá-lo é uma escolha, não um default.
- **Handoff só move o lease com `to_holder`.** `to_owner` é rótulo livre;
  arrastar o lease para um rótulo trancaria a sessão para todo mundo.

#### Segurança
- **Sequestro de sessão corrigido:** a arbitragem de controle usava
  `x-nomos-client`, um header **auto-declarado** — qualquer processo local
  escrevia "sou o agente-A" e herdava o volante. O principal passa a ser o
  **sujeito do token**.
- **`session_allowlist` passou a valer nas rotas de ação.** O gate roda antes de
  ler o corpo e o `session_id` de uma ação vem **no corpo**: um token emitido
  para a sessão A operava a sessão B. Quem barrava, por acidente, era o lease —
  e defesa que só funciona com outra ligada não é defesa.
- **T7 fechado.** `/events` passa a exigir credencial **no handshake** e o
  servidor MCP exige `NOMOS_BROWSER_TOKEN`, propagando escopo. Bateria própria
  com 53 vetores (REST, WebSocket, MCP, SSRF, filesystem, capability, vazamento
  de segredo, corpo malformado, corpo gigante, escalada de capability, sequestro
  de sessão, replay de token, symlink): `OPEN_SECURITY_P1=0`.

#### Adicionado
- **Selo de integridade do replay** (`seal.json`: sha256 por arquivo, tamanho e
  contagem), rota `GET /v1/sessions/:id/replay/verify` e comando
  `nomos-browser replay verify <SESSION_ID>`. Bundle adulterado, reordenado ou
  truncado é recusado — inclusive quando o JSON continua válido e os timestamps
  continuam em ordem, que é o caso que nenhuma checagem estrutural pega.
  **Resíduo declarado:** o selo é hash **sem chave** (ver `docs/SECURITY.md` e
  `docs/LIMITATIONS.md`).
- **Watchdog instanciado pelo daemon** com três sondas: navegador morto, worker
  preso e task estagnada. Backoff com teto, janela e degradação terminal com
  evento no audit.
- **Supervisão:** `packaging/launchd/ai.nomos.browser.plist` e `scripts/service.sh`
  (`install`, `uninstall`, `start`, `stop`, `restart`, `status`, `health`,
  `logs`), com instância única por lockfile com PID e checagem de porta — dois
  daemons no mesmo `userDataDir` corrompem o perfil do dono.

#### Corrigido
- A sonda de navegador morto usava `context.pages()`, que devolve `[]` sobre
  contexto morto **sem lançar**: ficava verde sobre navegador morto. Trocada por
  `cookies()`, que vai até o alvo. Com o navegador morto, o lease e a fila
  ficavam **órfãos para sempre** — sem navegador, nada mais expira.
- `tasks.resume` não registrava delegação: `taskHolders` só era populado na rota
  de **ação** `browser.task`, e resume é rota de **gestão**. Sob lease
  obrigatório, toda retomada de sessão de outro principal virava
  `CONTROL_NOT_OWNED`. A delegação passa a ser registrada na retomada e solta no
  `finally`.
- O gate de cleanup passava por vacuidade (média "não sobrou lease" num mundo sem
  leases); agora compara com linha de base independente, exige **identidade** do
  `lease_id`, e foi validado por mutação.

### `3f62706` — Providers no runtime, cascata até a visão e task engine persistente (2026-08-24)

#### Adicionado
- **Providers de IA e de visão no runtime.** `ai_provider`, `vision_provider`,
  timeouts, `think` e limiar entram na config; o daemon os constrói e injeta;
  `providers.ts` roteia com fallback. Fallback **só** em degradação classificada
  (timeout, rede, `EMPTY_OUTPUT`, 5xx); **cancelamento nunca vira fallback**,
  porque cancelar é ordem, não falha. Defaults nulos: o runtime não nasce falando
  com um LLM sem o dono pedir.
- **Task engine de produção** (`packages/core/src/taskengine.ts`): 9 estados com
  tabela de transição validada, checkpoint atômico por passo, idempotência por
  reserva em disco via `link(2)` que sobrevive a reinício, retry com backoff e
  classificação de erro, `cancel` com `AbortSignal`, `resume`, `cleanup` em funil
  único e varredura de recuperação no arranque. Quatro rotas de gestão
  (`GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/cancel`,
  `POST /v1/tasks/:id/resume`) e treze eventos de task no audit.
  Ver [docs/TASK-ENGINE.md](docs/TASK-ENGINE.md).
- **Cascata de percepção provada degrau a degrau**, com fixture por degrau
  (selector, accessibility, semantic, vision, nenhum) e espião que conta
  chamadas: a visão não é chamada quando o DOM resolve. O trace de cada
  tentativa entra no audit.

#### Corrigido
- O balde de audit `_runtime` era recusado pelo próprio `assertSafeSessionId`
  (a regex exige alfanumérico no primeiro caractere), então toda linha com
  `session: null` morria no append e virava stderr. Ninguém notara porque não
  havia produtor dessas linhas até `provider.degraded` existir.
- **DPR mentido para o modelo:** `page.screenshot()` devolve pixels de
  dispositivo e `viewportSize()` devolve CSS px. O runtime entregava a imagem 2x
  dizendo "1280x800". Em DPR 2 toda coordenada de visão sairia pela metade.
- **Inferência não repetível:** `temperature 0` não basta no Ollama — `find` e
  `click` discordavam sobre onde estava o mesmo alvo. Seed fixo alinhou os dois.
- **Precisão da visão era defeito de PROMPT, não de modelo.** O prompt pedia
  `{"box":{x,y,width,height}}`, esquema que a Qwen2.5-VL não emite no treino, e a
  largura vinha 1,8x inflada — num alvo de 160x100 o centro caía 9 px **fora**.
  Trocado para o esquema nativo `bbox_2d:[x1,y1,x2,y2]` mais `point_2d`:
  erro de **82,6 px para 4,1 px**, margem de 3 px para 49 px.

#### Medido e refutado
- O **refino por recorte** foi implementado, medido e **refutado** nos dois
  regimes de prompt (piora ou empata em 9/9 células). Fica com default `0`,
  disponível para outro modelo. Recortar não amplia — o alvo continua com os
  mesmos pixels.

### `bc7130f` — Procedência anti-injeção, auditoria forense, clique com prova de entrega (2026-08-24)

#### ⚠ INCOMPATÍVEL
- **`browser.observe` e `browser.extract` passam a devolver `provenance`.**
  `sanitize.ts` existia, tinha 22 testes verdes e o daemon nunca o chamava: os
  dois verbos devolviam o payload cru e sem marcação. Agora todo conteúdo de
  página volta com `source`, `trust`, `injection_detected`, `severity`,
  `findings`, `sanitized_content`, `nonce` e `raw_content_available`. A política
  `raw_web_content` (`withhold_on_detection` | `always` | `never`) decide o cru:
  severidade alta retém, média/baixa só marca — e esse é o controle de falso
  positivo. Quem consumia o texto cru sem olhar `provenance` continua recebendo
  conteúdo, mas pode recebê-lo retido em página hostil.
- **`browser.click` deixou de devolver sucesso otimista.** Antes: HTTP 200 e
  `success:true` para alvo fora do viewport, **sem entregar clique nenhum**.
  Agora rola até o alvo, espera a caixa assentar, remede, confere
  `elementFromPoint`, clica e **prova a entrega** por listener de captura armado
  antes do gesto. Sem prova: `TARGET_NOT_ACTIONABLE` ou `CLICK_NOT_DELIVERED`.
  Cliente que tratava `success:true` como verdade agora vê erros que antes eram
  silenciosos — o erro é a correção, não uma regressão.

#### Adicionado
- **Auditoria forense:** `AuditEntry` passa a ter **19 campos obrigatórios**
  (`event`, `browser`, `page`, `task`, `owner`, `actor`, `provider`,
  `capability`, `policy_decision`, `policy_reason`, `error`…) e uma única fábrica
  que recusa chave faltando. Negações, controle humano, attach/detach, recovery,
  task e `provider.degraded` passam a deixar linha própria.
  Ver [docs/AUDIT.md](docs/AUDIT.md).
- Dois padrões novos de detecção de injeção, achados pelos próprios casos de
  teste: **invocação de ferramenta** (`execute browser.download`) e **instrução
  financeira**. A árvore de acessibilidade entrou na inspeção.
- Navegação virou prova de primeira classe no clique: um `<a href>` destrói o
  contexto de JS antes de `page.url()` mudar, e a primeira versão **reprovava o
  clique de link** — o defeito mais comum possível num navegador. Corrigido com
  sinais de processo (`framenavigated` no frame principal, `context.on("page")`)
  armados antes do clique. `href="#ancora"` continua provando pela sonda.

#### Corrigido
- `run-suite.sh` matava só o pai no timeout (`kill -9 $pid`) e os filhos eram
  reparentados para o init — a validação encontrou **19 órfãos**, o mais velho
  com 6 h. Agora o arquivo roda em grupo de processos próprio e o vigia mata o
  **grupo**, TERM antes de KILL.

### `ae4bff1` — Download bloqueado derrubava o daemon; lockfile fora de sincronia (2026-08-24)

#### Corrigido
- **P1 de disponibilidade:** `handleDownload` criava `page.waitForEvent("download")`
  **antes** do `urlGuard`. Quando o guarda recusava a URL — comportamento correto
  de segurança — ninguém mais esperava por esse waiter; ao fechar a página ele
  rejeitava sem handler e o `unhandledRejection` derrubava o **processo** do
  daemon, levando junto todas as outras sessões. Qualquer cliente com capability
  `download` derrubava o runtime com duas chamadas.
- **`package-lock.json` fora de sincronia com os workspaces** (gerado antes de
  `packages/{sdk,cli,mcp}` ganharem `package.json`). `npm ci` — o comando que
  `.github/workflows/ci.yml` roda nos cinco jobs — falhava com `EUSAGE` em
  qualquer checkout limpo, ou seja, o workflow declarado nunca poderia ter
  passado.

---

## Antes de `ae4bff1`

O histórico anterior (`ab235d4` e antecessores) não está detalhado aqui: este
arquivo nasceu na fase de documentação de produto, e reconstruir changelog de
commits antigos a partir de memória seria inventar. As mensagens de commit
originais continuam sendo a fonte (`git log --format=%B`), e o estado auditado
daquele ponto está em
`evidence/nomos-browser-final-validation/FINAL_REPORT.md` (HEAD `ab235d4`).
