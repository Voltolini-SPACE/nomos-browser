# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento pretendido: [SemVer](https://semver.org/lang/pt-BR/).

**Versão corrente: `0.3.0-rc.1`.** A primeira marcação foi `v0.2.0-rc.1`; antes dela
o repositório não tinha tag alguma e `package.json` declarava `0.1.0` desde o
início — e este arquivo dizia isso, porque anunciar uma versão que nunca foi
marcada seria o tipo de mentira que o resto desta documentação existe para
evitar. Cada tag foi revalidada a partir do CONTEÚDO DELA, nunca da árvore de
trabalho. O procedimento está em [docs/RELEASE.md](docs/RELEASE.md).

O que separou o `rc.1` do `0.2.0` foi **uma pessoa digitando `APROVO`**. Enquanto
nenhuma ferramenta acima de `A0` tinha sido executada pelo caminho canônico com
aprovação humana real, o produto não podia se dizer pronto: a metade do gate que
importa — a que autoriza — nunca tinha rodado. Rodou. Está em
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) o que continua valendo sobre
automação headless.

Desvio deliberado do formato: dentro de cada versão as mudanças estão
agrupadas **por commit**, e não só por categoria. As mensagens de commit deste
projeto descrevem defeito, causa raiz e correção; agrupar tudo por categoria
dissolveria essa cadeia. Cada bloco traz o sha, e dentro dele as categorias do
Keep a Changelog.

Legenda usada nos itens:
**⚠ INCOMPATÍVEL** = muda comportamento observável de quem já usa a API.

---

## [0.3.0-rc.1] — 2026-08-25

O que esta versão acrescenta é **o dono na sala**: um console onde ele vê o
agente trabalhar, e dois modos de autonomia que decidem quando o agente pergunta
e quando ele age sozinho.

A garantia que sustenta tudo é uma só, e ela é estrutural, não uma promessa:
**`AUTO` não é `BYPASS`**. `decidir()` não tem ramo algum que rebaixe uma ação
`SEMPRE_APROVAR` sob o modo automático, e o portão de autonomia roda **depois**
de capability e de controle humano — quando ele executa, tudo que a política do
dono nega já devolveu `403` e morreu.

Estado medido: 789 testes em 37 arquivos, 106 casos E2E em 9 baterias, sala
limpa 14/14 a partir de clone do HEAD, suíte da Gi com 148 passes.

### `56e655e` · `51b86c5` — Autonomia e centro de aprovação (2026-08-25)

#### Adicionado
- **Modos `ASK` e `AUTO` por sessão**, opt-in. Sessão sem modo declarado segue
  o comportamento anterior: a compatibilidade é estrutural, não um remendo, e é
  por isso que os 735 testes que já existiam continuaram verdes sem ajuste.
- **Classificação por FATOR antes do NÍVEL.** Efeito financeiro, envio externo e
  irreversibilidade alta tornam a ação `SEMPRE_APROVAR` independentemente do
  nível A0–A6. `browser.upload` pergunta em AUTO porque *envia dado seu para
  fora, e isso não se retira* — não porque é A2.
- **Aprovação `single-use, action-bound, session-bound, auditada, não-sticky`,
  com TTL** e teto de pendências por sessão.
- **Rota sem perfil de risco declarado cai em `SEMPRE_APROVAR`** (fail-closed).

#### Corrigido — segurança
- **A amarra de argumentos perdia chaves aninhadas.** `impressaoDeArgs` usava
  `JSON.stringify(args, Object.keys(args).sort())`, e o segundo argumento do
  `JSON.stringify` é um **replacer**, não uma lista de ordenação: ele descarta
  toda chave que não esteja na lista, em todos os níveis. Resultado medido:
  `{"target":{"selector":"#confirmar"}}` e `{"target":{"selector":"#comprar-agora"}}`
  serializavam ambos para `{"target":{}}` e produziam a MESMA impressão. Uma
  aprovação para clicar "Cancelar" teria autorizado "Confirmar compra".
  Substituído por serialização canônica recursiva.

### `a2d5ffe` · `004be52` — O gate entra no caminho crítico (2026-08-25)

#### Adicionado
- Portão de autonomia no ponto único de decisão do daemon, **depois** de
  capability e de controle humano. A ordem é a garantia.
- Rotas: `autonomy.get/set`, `autonomy.default.get/set`, `approvals.list`,
  `approvals.approve/deny`, `live.state`, `agent.pause/resume`, `emergency.stop`.
- Códigos de erro `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`, `REOBSERVE_REQUIRED`,
  `AGENT_PAUSED`; rótulo de política `require_approval`; 12 eventos novos.

### `13bc871` · `0cf1509` · `51b107b` — Live Agent Console (2026-08-25)

#### Adicionado
- **Console visual**: espelho da página, cursor do agente, faixa de estado, feed
  de atividade, centro de aprovação e histórico.
- **Reobservação obrigatória**: devolver o volante não devolve o CONHECIMENTO. O
  agente que recupera o controle precisa reobservar antes de agir — a página
  pode ter mudado enquanto o humano digitava.

#### Corrigido
- **`Pausar` e `Parar` eram teatro.** `btPausar` só alternava um espelho local
  (`S.pausado`) enquanto o agente seguia agindo, e `btParar` enviava um
  `browser.task {goal:"", cancel:true}` sem significado. Agora falam com rotas
  reais, e a interrupção **termina no backend mesmo se a UI cair no meio**.
- **A UI não alcançava o runtime quando ele servia a página em outra porta.**
  `BASE` estava fixo em `7777` e a CSP `connect-src 'self'` bloqueava. O console
  ficava em "SEM SESSÃO" sem explicar por quê. Agora herda `location.origin`.

### `847b2a7` — Segredo na aprovação, replay somente leitura, escopos (2026-08-25)

#### Corrigido — segurança
- **O pedido de aprovação mostrava a senha em claro.** `redactObject` mascara
  por NOME de campo, e `text` não é nome de campo secreto. Medido com canário
  adversarial num `<input type="password">` real. Agora sai
  `[oculto: 24 caractere(s), C…Z]`: tamanho e pontas preservam o que permite
  DECIDIR sem expor. A trilha em disco já nascia limpa.
- **Escopos do Live Agent estavam certos por DESCUIDO.** As onze rotas caíam em
  `ADMIN` pelo *default* de `scopeForRoute`, não por declaração. Abrandar o
  default — uma linha, um dia, com boa intenção — moveria em silêncio o escopo de
  aprovar uma ação. Agora são declaradas, e um teste exige declaração explícita
  para toda rota.

#### Adicionado
- **Replay somente leitura** em três camadas: não existe verbo de escrita em
  `/replay` (405 + `Allow: GET`); ler o histórico não ressuscita a sessão; e
  `read_only` é **declarado** pelo runtime, não deduzido pela tela.
- Assimetria deliberada de escopo: `pause` e `emergency-stop` são `CONTROL`
  (parar nunca pode ser mais difícil que agir), `resume` é `ADMIN` (senão a pausa
  do operador duraria uma linha de laço do agente).

#### Corrigido
- **`GET /replay` devolvia `200` com replay vazio para sessão que nunca
  existiu** — forma idêntica à de uma sessão real que gravou pouco. A tela diria
  "essa sessão não fez nada" sobre algo que nunca houve. Agora é `404`, decidido
  pela existência do diretório e não pelo conteúdo, que é ambíguo.

### `7bd33ae` — ASK e AUTO numa jornada multipasso (2026-08-25)

#### Adicionado
- **Aprovar uma `browser.task` não é cheque em branco.** Em `ASK`, cada passo do
  plano reentra no portão. Isso vale porque o executor de passo fala com a
  própria API por loopback em vez de chamar `handlerFor()` direto — era
  comentário no código, agora é medida: dar ao executor um caminho privilegiado
  derruba o teste.

### `cba488f` — Modos de falha (2026-08-25)

#### Corrigido
- **Navegador morto era reportado como `TARGET_NOT_FOUND`.** Matando o Chromium,
  `browser.extract` **e** `browser.screenshot` voltavam "alvo não encontrado" — e
  um screenshot não tem alvo. O operador caçaria um seletor correto enquanto a
  verdade era que a página tinha morrido. `getPage()` cobria três situações com
  o mesmo código; agora sessão sem aba e aba que fechou são
  `BROWSER_UNAVAILABLE`, e só `page_id` que nunca foi da sessão continua
  `TARGET_NOT_FOUND`.
- **`page_id` de aba morta soava como bug do cliente.** A sessão passou a
  lembrar quais abas foram suas (`closed_pages`, teto de 64) para responder "era
  sua e fechou" em vez de "não é sua".

### `7cc00d2` · `5473137` · `6964cf0` — Medição, regressão e sala limpa (2026-08-25)

#### Adicionado
- Medição de latência dos cinco caminhos do console, com fronteira declarada em
  cada um e **controle de instrumento**: 60 ms de atraso injetado movem só o
  caminho medido.
- `scripts/regressao-completa.sh` — 15 etapas, um veredito. Etapa que não pôde
  rodar sai `NAO_EXECUTADA` e **derruba** o gate: "não rodou" nunca pode se
  apresentar como "passou".
- `scripts/clean-room-live-agent.sh` — recusa rodar com árvore suja e constrói a
  UI a partir do `src` do clone.
- `scripts/limpar-orfaos.sh` — limpeza por **prova de posse**, nunca por porta.

#### Corrigido — instrumento
- **`run-suite.sh` só descarregava modelo ANTES dos três arquivos que carregam
  LLM.** Um arquivo morto por timeout não roda o `after()` dele e deixa o modelo
  residente com o `keep_alive` longo dos testes; o estrago é sempre para quem vem
  **depois**. Numa execução real isso deixou 5,02 GB presos e produziu seis
  arquivos vermelhos que estavam verdes minutos antes. Agora descarrega depois de
  cada arquivo, usando `lib-memoria.sh`, e registra memória disponível por
  arquivo para que starvation apareça como medida em vez de dedução.

### Licença

- **O projeto passou a ser MIT**, titular **Voltolini-SPACE**. Até 2026-08-25 o
  `LICENSE` declarava *todos os direitos reservados* com um titular
  **placeholder** derivado mecanicamente do autor do commit HEAD. As duas coisas
  eram decisão do dono, e nenhum agente tem autoridade sobre elas. Foram
  decididas nesta data. A cópia anterior está preservada em
  `evidence/nomos-release/00-freeze/LICENSE-anterior-proprietario.txt`.
- `license` e `author` passaram a ser **declarados** em `package.json` e em cada
  workspace. Antes não eram declarados em lugar nenhum, e quem instalasse não
  tinha como saber o que podia fazer com o código.
- A licença cobre o **código**. Ela não concede direito sobre as marcas "NOMOS"
  e "NOMOS Browser" nem sobre os tokens de identidade visual, que continuam
  governados pelo contrato de marca e fora do versionamento.
- `CONTRIBUTING.md` passou a existir, porque com MIT contribuir faz sentido.

### Limitações conhecidas nesta versão
- **`p99` não é reportado** em nenhum caminho de latência: 30 amostras exigem 100.
  Nenhum máximo observado é chamado de p99.
- **Não há rota HTTP para emitir token com escopo** — existe na API interna.
- **O ramo `pr.page.isClosed()` é inalcançável** em operação normal; é defesa de
  corrida, não cobertura.
- Validado em macOS/Apple Silicon. Outras plataformas não foram medidas.

---

## [0.2.0] — 2026-08-25

### `ae856aa` · `5384ae3` — O gate humano A1, e o cancelamento que mentia (2026-08-25)

#### Corrigido — integração com a Gi (auditabilidade)
- **Cancelamento que chegava tarde era reportado como `CANCELADO`.** O laço
  derrubava o processo sem perguntar se ele ainda estava vivo. Se o `nomos` já
  tinha terminado — e ele termina com o `node servidor.mjs` neto ainda segurando
  os pipes, que é exatamente quando `poll()` deixa de ser `None` — a Gi dizia
  "cancelei" com a aba já trocada na tela do dono. Agora existe
  `browser.cancel.too_late` e a resposta admite `cancelamento_tardio=True`.
- **`communicate()` sem prazo no caminho tardio** era um pendura: o neto segura
  os pipes e a espera não terminava. Prazo de 5 s, e se não fecharem, derruba o
  grupo e usa o que já veio.

#### Adicionado — trilha do barge-in
- Quatro eventos que não são sinônimos: `requested` (pediram para parar),
  `accepted` (dá para parar), `terminated` (o que sobrou — com
  `grupo_ainda_vivo` medido por `killpg(gid, 0)`, que não envia sinal, só
  pergunta) e `too_late`. Sumidouro opcional: auditoria que derruba a ação que
  deveria registrar é pior que auditoria nenhuma.

#### Segurança — o manifesto legado saiu do chaveiro
- `d267002f…` (13 tools, com a elevação de privilégio) foi **revogado** pelo
  caminho canônico. A medição feita antes é o achado: com ele ainda confiável, o
  exploit histórico era barrado pelo **servidor**, por validação de argumento —
  **não** pela camada de manifesto, que teria deixado passar. A defesa era de uma
  camada só, e um `git checkout` do `servidor.mjs` daquele commit devolveria a
  outra metade.

#### Corrigido — instrumento
- O arranjo do gate canalizava a saída do `nomos` por `| tee`, e um pipe faz o
  stdout deixar de ser TTY: o dono chegou ao gate e **o instrumento** fechou a
  porta na cara dele. `script -q` no lugar.

---

## [0.2.0-rc.1] — 2026-08-25

### `6a32a4c` · `601a6db` · `60415e9` — Loop 100: o registro do manifesto acendeu dois defeitos de caminho feliz (2026-08-25)

Os dois defeitos abaixo dormiam num ramo que **só executa depois** que o dono
registra o manifesto no catálogo do NOMOS. Enquanto o manifesto esteve
experimental, tudo passava verde. Eles apareceram na primeira hora do primeiro
uso real — que é exatamente onde ninguém testa.

#### Corrigido — instalação
- **`scripts/nomos-register.sh` morria no ramo "já registrado".** `$CURTA…`: o
  `…` (U+2026) é multibyte e o bash não encerra o nome da variável ali; sob
  `set -u` o script aborta com `CURTA…: unbound variable`. Guarda novo e
  estático (`scripts/verificar-shell-expansao.ts`), com autoteste próprio,
  ligado no `ci.sh`.

#### Corrigido — integração com a Gi
- **O barge-in sumia ao entrar em produção.** `gi_nomos.browser.executar` tem
  duas portas: a do manifesto experimental honrava `cancelar`; a do manifesto
  REGISTRADO usava `subprocess.run(...)`, que bloqueia até o fim e ignora o
  evento. A Gi continuaria navegando depois de o dono mandar parar. Agora usa
  `Popen` com sessão nova e derruba a árvore (o `nomos` gera `node
  servidor.mjs`; matar só o pai deixaria o neto segurando a sessão).

#### Adicionado — guardas
- `versao:coerente-em-todo-o-produto` — a versão era escrita à mão em treze
  lugares e nada obrigava os treze a concordarem; pior, as asserções eram contra
  o literal `"0.1.0"`, então o teste que deveria pegar a deriva era justamente o
  que precisava ser editado a cada bump.
- `shell:expansao-nao-colada-em-nao-ascii` — a classe de defeito acima.

#### Corrigido — documentação
- O relatório anterior dizia **223 checagens** no E2E. Recontado a partir do
  `e2e-final.json` commitado em `1e6baf7`: eram **213** já naquele run. Não
  houve regressão de cobertura; o número estava errado no relatório.


### `0ebfe30` · `82c347c` · `aae1900` · `1e6baf7` — Closeout: elevação de privilégio pelo MCP, sessão durável, Gi ativada (2026-08-25)

O dono registrou o manifesto no catálogo do NOMOS. Foi o CLI **real** — e não o
cliente que havíamos reimplementado — que expôs os dois defeitos abaixo na
primeira hora de uso. A exigência de "não vale cliente reimplementado como prova
final" foi exatamente o que os encontrou.

#### Corrigido — ⚠ INCOMPATÍVEL · segurança (P0)
- **Elevação de privilégio pelo manifesto MCP.** `browser_tabs` estava declarada
  `A0_READ_LOCAL` e despachava quatro rotas, incluindo `browser.new_tab` (que
  aceita `url` e sai para a rede) e `browser.close_tab`. O manifesto classifica
  por **ferramenta**, nunca por argumento — então o rótulo "ler arquivos locais"
  valia para o pior que a ferramenta sabia fazer. Executado contra o NOMOS real,
  headless, sem aprovação nenhuma:

  ```
  A0 · ler arquivos locais · alvo=mcp:nomos-browser:browser_tabs
  veredito: ALLOW — permitido pela política
  route=browser.new_tab http=200
  { "url": "http://127.0.0.1:8899/segredo", "title": "Alvo /segredo" }
  ```

  Correção: uma ferramenta, uma rota, uma classe de risco.

  | ferramenta | rota | nível |
  |---|---|---|
  | `browser_tabs` | `browser.tabs` (só listar) | `A0_READ_LOCAL` |
  | `browser_tab_open` | `browser.new_tab` | `A2_NET_EGRESS` |
  | `browser_tab_switch` | `browser.switch_tab` | `A1_WRITE_LOCAL` |
  | `browser_tab_close` | `browser.close_tab` | `A1_WRITE_LOCAL` |

  **Quem chamava `browser_tabs` com `action`/`url` precisa migrar**: a ferramenta
  agora recusa esses argumentos.
  Evidência: `evidence/nomos-browser-final-closeout/01-mcp/03-exploit-tabs.txt`.

#### Corrigido — P1
- **A sessão não sobrevivia ao modelo one-shot do NOMOS.** `nomos mcp chamar`
  sobe o servidor, chama e encerra. Duas chamadas seguidas produziam duas sessões
  (`SESSOES_VIVAS=2` acumuladas) e `browser_extract` depois de abrir uma aba
  devolvia `TARGET_NOT_FOUND`, porque a sessão era outra, em `about:blank`. Pelo
  caminho canônico o produto era inutilizável para trabalho de mais de um passo,
  e vazava Chromium por chamada. Agora a sessão é persistida em
  `<runtime_dir>/mcp-session.json` com escrita atômica e trava contra corrida;
  processos one-shot distintos compartilham a mesma sessão.

#### Adicionado
- `scripts/verificar-risco-mcp.ts`: guarda que classifica as 23 rotas do runtime
  em leitura, mutação e egresso, extrai de `tools.ts` as rotas que cada
  ferramenta alcança, e **reprova o manifesto** se uma ferramenta `A0` puder
  mutar ou sair para a rede. Roda na CI. Validado por controle negativo:
  rebaixar `browser_tab_open` para `A0` produz `MCP_RISK_COHERENT=NO` com `rc=1`.
- Bateria de anti-bypass com seis invariantes do plano de controle, cada um com
  controle positivo **e** negativo:
  `evidence/nomos-browser-final-closeout/05-antibypass/`.

#### Mudado
- **Gi ativada.** `build_dispatcher()` do `pocket-assistant` registra as quatro
  capabilities `navegador_*`, com a categoria vinda **do manifesto**. O backend
  `com.gijarvis.backend` foi reiniciado. O E2E prova
  `Gi → NOMOS → MCP → API v1 → Chromium → resultado → Gi` para `A0`, e prova —
  conferindo no próprio navegador — que `A2` **não executa** sem o dono.

#### Nota operacional
- Mudar o manifesto muda o SHA-256, que **é** a confiança registrada. Depois
  desta correção o NOMOS voltou a tratá-lo como experimental (fail-closed,
  correto) e o dono precisa reassinar:
  `nomos mcp confiar packaging/mcp/manifesto.json`.
  Impressão nova: `317f15893e9ebd83afa17d11f66dd896c83342858ad723e0f4ed7afd32e27207`.
- O **gateway de voz** da Gi (processo `gi_nomos.device_voice_gateway`) roda
  órfão, fora do launchd, e nenhum plist o referencia. Ele **não** foi
  reiniciado: sem supervisor, reiniciá-lo é derrubar o assistente sem garantia de
  volta. É passo do dono.

#### Medido neste HEAD
`ci.sh all` → `CI_PASS=YES` · suíte Node **735/735** em 35 arquivos ·
SDK Python **31/31** · E2E **20/20** (223 checagens) · segurança **53 vetores**,
`OPEN_SECURITY_P1=0` · anti-bypass **6/6** · zero processo residual ·
produção com os mesmos PIDs.


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
