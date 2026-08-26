# NOMOS Browser — fechamento do lançamento público

Data: 2026-08-26. Tudo abaixo foi medido a partir do **remoto publicado**, não da
árvore de trabalho de quem escreveu o código. Onde a medição não foi possível,
está dito que não foi.

---

## 1. HEADs finais

| repositório | ref | commit |
|---|---|---|
| `nomos-browser` | `main` | `d0a09ce` — um commit à frente da tag, só ferramenta (§9.9) |
| `nomos-browser` | tag `v0.3.2` | `6f5499a` — **artefato final** |
| `nomos-browser` | tag `v0.3.1` | `b19adef` |
| `nomos-browser` | tag `v0.3.0` | `9732fa4` |
| `voltolini-space-site` | `main` | `ea671c3` |
| `openkern` | `main` | `0de0410` — **não tocado nesta missão** |

Tags anteriores **não foram movidas nem reescritas**:

```
v0.3.0-rc.1  ->  2e0bab587b9411bac9d96e2e7096e5d0a447dbb9
v0.3.0-rc.2  ->  f716f5af5d4c76b5bebc9dfb1f484d9de0260647
```

Os dois valores são idênticos aos lidos no início da missão, antes de qualquer
alteração. Uma tag publicada não se move.

---

## 2. Release e tag final

- **Tag final:** `v0.3.2`
- **Releases no GitHub:** `v0.3.2` é *Latest*; `v0.3.0` e `v0.3.1` seguem
  publicadas; `v0.3.0-rc.2` segue como *Pre-release*. Nenhuma foi movida.
- **Versão coerente:** `VERSION_COHERENT=YES` (`0.3.2`) em **13 declarantes** (raiz + 8
  workspaces + `CLI_VERSION` + `SERVER_VERSION` + SDK Python + `pyproject.toml`).

Por que existem três versões no mesmo dia: cada sala limpa rodada a partir do
remoto publicado encontrou um vermelho que a validação na árvore de trabalho não
encontraria (§7.5 e §7.6). Nenhum deles foi corrigido movendo a tag onde
apareceu: uma tag publicada não se move, e mudar por baixo o que alguém já pode
ter baixado é pior do que ter três números.

| tag | o que a sala limpa dela achou |
|---|---|
| `v0.3.0` | teardown com `ENOTEMPTY` em 4 arquivos (§7.5) |
| `v0.3.1` | leitura de trilha sem espera em `watchdog-wired` (§7.6) |
| `v0.3.2` | nada — validação final |

---

## 3. URLs públicas

- **Repositório:** <https://github.com/Voltolini-SPACE/nomos-browser> — `PUBLIC`
- **Release:** <https://github.com/Voltolini-SPACE/nomos-browser/releases/tag/v0.3.0>
- **Página do produto:** <https://voltolini.space/browser/>
- **Licença detectada pelo GitHub:** `{"licenseInfo":{"key":"mit","name":"MIT License"}}`

---

## 4. Sala limpa (a partir do remoto publicado)

`scripts/clean-room-publico.sh` apaga o diretório, clona **anonimamente por
HTTPS**, neutraliza o ambiente da máquina e roda `npm test` — o comando que um
estranho digita, não a forma que eu sei que funciona.

| execução | ref | veredito |
|---|---|---|
| 1ª | `main` @ `d10df82` | **FALHOU** — `npm test` morreu em 1 s (§7.1) |
| 2ª | `main` @ `5ca4461` | `CLEAN_ROOM=PASS` · 797 passes · 0 falhas · 38/38 |
| 3ª | tag `v0.3.0` @ `9732fa4` | `CLEAN_ROOM=PASS` · 797 passes · 0 falhas · 38/38 |
| 4ª | tag `v0.3.1` @ `b19adef` | **FALHOU** — `watchdog-wired` 6/2 (§7.6) |
| 5ª | tag `v0.3.2` @ `6f5499a` | `CLEAN_ROOM=PASS` · 797 passes · 0 falhas · 38/38 |

Em todas: `HIGIENE=OK` (nenhum `node_modules`, `dist`, `.env` ou `.DS_Store`
versionado) e `TYPECHECK=OK`.

---

## 5. Suítes — resultado final

Medido no clone anônimo da tag **`v0.3.2`** (`6f5499a`):

```
suíte TypeScript   797 passes · 0 falhas · 38/38 arquivos
E2E Live Agent     106 casos  · 9/9 baterias PASS
demos              24 passos OK em 6 demos, contra Chromium real
cobertura da CI    38/38 arquivos declarados
tipos              sem erro
regressão          16 etapas PASS · 0 falha · NOMOS_BROWSER_REGRESSION=PASS
alegações          UNPROVEN_PUBLIC_CLAIMS=0
```

Baterias E2E: `gate` 20 · `console` 18 · `takeover` 11 · `controles` 13 ·
`segredos` 4 · `replay` 13 · `modos` 8 · `falhas` 13 · `latência` 6.

**Uma etapa não executou e isso não virou verde:** `gi-pytest` sai como
`NAO_EXECUTADA` numa sala limpa, porque a Gi é outro produto em outro
repositório. Ela ficou **fora da conta** do veredito do NOMOS Browser e **dentro
do relatório**, com nome e com aviso no stderr.

---

## 6. Auditoria de segurança sobre exatamente o conteúdo público

```
PUBLIC_REPO_SECRET_LEAK=0          (ponta, no clone da tag)
CAMINHOS_PESSOAIS_EM_PRODUTO=0     (ponta, no clone da tag)
HISTORICO_PUBLICO_LIMPO=SIM        (todos os blobs de todos os 63 commits)
```

A varredura de histórico é nova, e existe por um motivo que virou prova. O
scanner que havia olhava `git ls-files` — o que está versionado **agora**. Mas um
repositório público entrega o **histórico**. Controle de mutação, num clone
descartável com um segredo plantado num commit e removido no commit seguinte:

| varredura | veredito | leitura |
|---|---|---|
| ponta (`verificar-segredos-publicos.sh`) | `PUBLIC_REPO_SECRET_LEAK=0` | diz que está limpo |
| histórico (`verificar-historico-publico.sh`) | `HISTORICO_PUBLICO_LIMPO=NAO` | acha o segredo |

O repositório entrega a credencial a qualquer um que clone, e o scanner antigo
o declarava limpo. As duas varreduras são complementares, e o lançamento
precisava das duas.

**O que elas não provam:** procuram *formatos* de credencial conhecidos. Um
segredo sem formato reconhecível — uma senha curta em texto — passa.

---

## 7. Defeitos reais encontrados e corrigidos nesta missão

### 7.1 `npm test` não rodava no Node 26, e o `engines` prometia faixa falsa

O achado que justificou a sala limpa existir. `npm test` declarava
`node --test --experimental-strip-types tests/`, passando um **diretório nu** ao
runner: funciona até o Node 22, quebra a partir do 23, quando o runner tenta
carregar o argumento como módulo e morre com `MODULE_NOT_FOUND` antes de rodar um
único teste. O `engines` dizia `>=22.6.0` — faixa que **inclui** o Node 26.

Quem clonasse o repositório público no Node 26 via a suíte inteira falhar sem
que existisse defeito nenhum.

Por baixo o piso também estava errado: o executor chama `node --test <arq>.ts`
sem `--experimental-strip-types`, então só roda de **22.18** em diante.
`>=22.6.0` era falso nas duas direções.

**Correção:** `test` delega ao executor (que é o que a própria documentação
manda usar, encerrando também a contradição entre script e docs) e
`engines.node` passa a `>=22.18.0`.

**Regressão + controle de mutação:** `tests/entrada-publica.test.ts`. O teste 4
reencena a forma antiga e **exige que ela falhe**; em Node < 23 declara SKIP
dizendo por quê, em vez de passar em silêncio onde o defeito não pode aparecer.
Revertendo `package.json` ao estado defeituoso, 3 dos 5 testes ficam vermelhos.

Medido nas duas pontas da faixa: `v22.23.1` e `v26.0.0`.

### 7.2 Números públicos que ninguém tinha medido

O mesmo fato com dois números: README dizia `789 passes / 37 arquivos`, a página
pública dizia `792 testes`. E a CLI era anunciada com `9 comandos`.

| alegação | declarado | medido |
|---|---|---|
| passes da suíte | 789 (README) / 792 (site) | **797** |
| arquivos de teste | 37 | **38** |
| comandos da CLI | 9 | **8** |

O "9º comando" era `replay verify`, que é uma **forma de invocação** de `replay`
— o próprio código da CLI diz que ela não tem tabela de subcomandos. Contaram a
linha da ajuda em vez da entrada do registro.

**Correção:** `scripts/verificar-alegacoes-publicas.mjs` mede cada número e
compara com README, `PRODUCT_MANIFEST.md` e a página do site. A origem da
medição da suíte é obrigatória e explícita (`--resumo`), porque a medição que
vale é a da sala limpa.

### 7.3 Um relatório de evidência que se contradizia

`scripts/regressao-completa.sh` estampava `NOMOS_BROWSER_REGRESSION=PASS` três
linhas abaixo do seu próprio `ETAPAS_FALHA=1`, porque o veredito olhava só para a
suíte TypeScript. O comentário logo acima já dizia a regra certa ("etapa ausente
derruba"); o código não a implementava. E imprimia `em 37 arquivos` como
**literal** — número que envelheceu calado quando o 38º arquivo entrou.

**Correção:** cabeçalho e código de saída passam a dizer a mesma coisa, e o
número vem da medição.

### 7.4 Um arquivo de teste que nunca rodaria na CI

A própria `ci-cobertura` pegou: `tests/entrada-publica.test.ts` — criado na
correção 7.1 — entrou sem estar declarado em nenhum estágio de `ci.sh all`.
Declarado em `fast` e `cleanroom`. Matriz de volta a **38/38**.

### 7.5 Quatro arquivos de teste podiam ficar vermelhos sem nada ter falhado

Encontrado na regressão a partir do clone da tag `v0.3.0`.
`tests/ownership.test.ts` passou nos 11 testes e terminou **vermelho no
`after()`**: `ENOTEMPTY` num `rmSync(..., { recursive: true, force: true })`.
`force: true` engole `ENOENT`, não `ENOTEMPTY` — apareceu arquivo novo num
diretório que a caminhada já tinha esvaziado.

**Correção:** `tests/fixtures/limpeza.ts` insiste **contando as tentativas**. Pôr
`maxRetries` e seguir a vida apagaria a informação: se o runtime de fato continua
escrevendo depois de dizer que fechou, isso é defeito de produto, e a
retentativa silenciosa o esconderia. Quando é preciso insistir, sai aviso no
stderr dizendo o que aquilo significa.

**Controle de mutação** (em processo separado, obrigatoriamente — ver §9):

```
RMSYNC_CRU: ok=false erro=ENOTEMPTY
HELPER:     removido=true tentativas=8
CONTROLE=VALIDO (o cru quebra, o helper aguenta)
```

**O que isto não afirma:** não foi provado que `close()` retorna com escritas
pendentes. Foi provado que arquivos apareceram durante a remoção. O aviso existe
para que, se for esse o caso, a próxima ocorrência chegue com nome.

### 7.6 Um teste podia reprovar depois de o produto ter feito tudo certo

Visto na sala limpa da tag `v0.3.1`. O caso *"NAVEGADOR MORTO por baixo"* passou
em **todas** as asserções sobre comportamento — `detected.browser_dead` subiu,
`recovered.browser_dead` subiu, o lease foi solto — e reprovou três linhas
abaixo, em `o watchdog agiu sem deixar linha no audit`.

O watchdog tinha agido. A trilha é escrita de forma **assíncrona**; a leitura era
**síncrona e imediata**. E o mesmo arquivo, vinte linhas acima, já esperava desse
jeito pelo `status` da sessão: a espera existia para um efeito e faltava para o
outro.

**Correção:** `trilhaAte()` espera a linha aparecer, com prazo. Não enfraquece a
asserção — se a linha nunca aparecer, ela reprova ao fim do prazo com a mesma
mensagem.

**O que está provado:** a corrida existe no código, e a falha aconteceu numa
execução real. **O que não está:** que a correção elimina aquela ocorrência. A
falha **não foi reproduzida sob demanda** — 8 execuções isoladas e 6 sob carga de
CPU (`load average` 28,9) passaram todas. Carga sintética de CPU não recria a
disputa da suíte completa, que envolve vários Chromium e pressão de sistema de
arquivos. A correção se sustenta por **inspeção**, não por reprodução, e está
dito assim também no `CHANGELOG.md`.

---

## 8. Divergência do OpenKern — resolução documentada

Resolvida **por execução, não por preferência**.

| commit | contexto | `cargo test --workspace` |
|---|---|---|
| `d06dddf` | relatório congelado, `TEST_COUNT = 69` | **69 passed** |
| `2ff6631` | tag `openkern-brand-v1.0`, `docs/BRAND_FREEZE_v1.0.md` | **95 passed** |

Composição do 69 em `d06dddf`: `kern_types` 12 · `kern_fsm` 5 · `kern_policy` 4 ·
`kern_capability` 22 · `kern_repo` 7 · `kern_git` 8 · `kern_exec` 11.

Os dois números são **reais**; estavam colados no rótulo errado. O 95 é
verdadeiro em `2ff6631`, e o commit `8f9f7ab` o carregou para a cópia do hub, onde
passou a ser lido como se descrevesse `d06dddf`. Nenhum valor foi escolhido: cada
um foi reexecutado no commit a que pertence.

O repositório `openkern` **não foi tocado** — segue em `0de0410`, na branch de
correção do dono.

---

## 9. Erros meus, declarados

Nenhum destes é defeito do produto. Todos teriam virado conclusão errada se
tivessem passado sem verificação.

1. **Confundi a suíte de outro projeto com esta.** `/tmp/nomos-test.log` mostrava
   `3773 passed` em formato de dots do **pytest**. A suíte do NOMOS Browser é
   `node --test`, que emite TAP. Era o log de outro produto. Descartado como
   evidência antes de virar número público.

2. **A primeira sala limpa acusou `TYPECHECK=FAIL` com `tsc: command not found`.**
   Não era o produto: esta máquina exporta `NODE_ENV=production` e
   `npm config omit=dev`, e o `npm ci` pulou as devDependencies. A sala limpa
   passou a limpar também o **ambiente**, senão mede a minha máquina em vez do
   pacote publicado.

3. **Três sondas que produziram silêncio, lidas quase como "não reproduz".**
   `timeout` não existe nesta máquina; `timeout sh -c ...` falhava com
   *command not found* e o `grep` seguinte não achava nada. Saída vazia não é
   evidência de nada.

4. **Medi o runner de dentro do runner.** Os testes 3 e 4 de
   `entrada-publica.test.ts` inicialmente mediam a trava de recursão do
   `node:test` (`run() is being called recursively`), que **sai com 0 sem
   executar nada** — um sucesso falso. O ambiente do filho passou a nascer sem
   `NODE_TEST_CONTEXT`, e uma asserção agora reprova explicitamente se a marca
   voltar.

5. **Contei demos e arquivos com regex erradas**, e quase acusei o site de dizer
   "6 demos" sem base: o instrumento media 0. O cabeçalho do `resumo.tsv` também
   entrava como "1 arquivo ruim" inexistente — o instrumento acusando a si mesmo.

6. **Duas sondas de carga que não carregaram nada.** Ao tentar reproduzir §7.6,
   subi processos de carga com `&` dentro de uma cadeia de comandos: eles
   morreram junto com o subshell e a medição saiu `carga: 0 processos`. Um
   "passou sob carga" ali não teria significado nada. Refeito com `nohup` e com
   a carga contada antes de medir.

7. **Meu primeiro controle de mutação da limpeza deu falso negativo.** Eu escrevi
   um escritor concorrente com `setInterval` no mesmo processo, mas `rmSync` é
   **síncrono** e bloqueia o event loop de quem remove: o escritor nunca rodava
   durante a remoção. Só reproduziu com um processo separado.

8. **Li duas vezes um `.suite/resumo.tsv` que uma regressão em curso estava
   reescrevendo**, e o verificador acusou `medido=41` e depois `medido=0` contra
   `declarado=797`. Não era contradição de alegação: era eu medindo um arquivo do
   qual outro processo era dono. Na segunda vez o instrumento foi corrigido —
   resumo incompleto agora sai `NAO_MEDIDO` com o motivo, e conta em
   `ALEGACOES_NAO_VERIFICAVEIS`. Número parcial é pior do que número nenhum,
   porque tem cara de medição.

9. **`main` está um commit à frente de `v0.3.2`.** É esse conserto de
   instrumento. Não toca produto e não muda número publicado, então não gerou
   versão nova — mas está dito aqui para que ninguém compare os dois e ache que
   falta algo na tag.

E o incidente que continua registrado, de missões anteriores: matei o
`claudio-input-engine` do dono (PID 1055, porta 8931) com uma limpeza **por
porta**. O `launchd` o reiniciou e o serviço está saudável, mas a limpeza por
porta foi substituída por `scripts/limpar-orfaos.sh`, que só mata processos que
passam em **dois** testes de propriedade e apenas **relata** portas, jamais
limpando por elas. `NO_KILL_WITHOUT_OWNERSHIP_PROOF=TRUE`.

---

## 10. Alterações no site

- `792 testes / 37 arquivos` → **797 / 38**, medidos na sala limpa.
- `nomos-web com nove comandos` → **oito**.
- `0.3.0-rc.2` → **0.3.2**, no *kicker*, no rodapé e sem restar nenhuma menção a RC.
- Seção de estado: `Release candidate, e dito assim` → `Estável, e com os limites
  ditos assim mesmo`. **A lista de limites continua inteira**, e ganhou uma frase
  a mais: marcar uma versão como estável não mede nenhuma plataforma nova.
- Correção de layout publicada antes disto: o hub rolava 19 px no desktop e
  157 px no mobile (`overflow-x:clip` + `min-width:0`).

`LAYOUT_OK=YES (0 falha(s))` medido **contra o site no ar**, em 6 rotas × 2
larguras (1280 e 390), com Chromium real tentando rolar.

---

## 11. Alterações no GitHub e no material de marketing

- Release `v0.3.0` publicada como *Latest*, notas derivadas do `CHANGELOG.md`.
- `v0.3.0-rc.2` permanece *Pre-release*, intocada.
- Wiki desabilitada — estava habilitada e vazia num repositório público.
- Descrição, homepage (`voltolini.space/browser/`) e 13 tópicos: conferidos, sem
  alteração necessária.
- `marketing/github-description.md`: deixou de instruir "marcar como
  pre-release"; agora descreve a promoção e diz que as tags RC não se movem.
- `marketing/website-copy.md` e `marketing/launch-post.md`: versão atualizada e
  `release candidate` → `estável`, mantendo a lista de limitações.

---

## 12. Pendências explícitas

Nada disto está escondido no produto — tudo já aparece no README, na página
pública ou em `docs/LIMITATIONS.md`. Está repetido aqui para que a lista exista
num lugar só.

1. **Só macOS com Apple Silicon foi medido.** Linux e Windows não foram testados.
   Marcar `0.3.2` como estável não mediu nenhuma plataforma nova.
2. **Nenhum p99 é reportado, em nenhum caminho.** Trinta amostras não sustentam
   um p99; o instrumento devolve nulo e explica por quê.
3. **Não há rota HTTP para emitir token com escopo.** Existe só na API interna.
4. **O selo do replay é hash sem chave.** Detecta corrupção acidental, não um
   adversário com acesso de escrita ao bundle. Está declarado no modelo de ameaça.
5. **Flags E2E ainda PARCIAIS**, e ditas assim pelo próprio gate:
   `VISION_MOUSE_PASS=PARCIAL` (sem `VisionProvider`), `MULTI_AI_PASS=PARCIAL`
   (sem segundo provedor LLM real), `RECOVERY_PASS=PARCIAL` (queda do processo do
   runtime não coberta).
6. **A varredura de segredos procura formatos conhecidos.** Um segredo sem
   formato reconhecível passa.
7. **`gi-pytest` não roda em sala limpa** — a Gi vive em outro repositório. A
   etapa sai `NAO_EXECUTADA`, nunca `PASS`.
8. **Fora do escopo desta missão e ainda em aberto:** a investigação do
   *ConfraPix × TPV do Pix da Se7en* na Gi (`pocket-assistant`), relatada pelo
   dono e interrompida por uma troca de prioridade.

---

## 13. Portões

| portão | estado |
|---|---|
| `NOMOS_BROWSER_PUBLIC_REPO` | PASS |
| `MIT_LICENSE_DETECTED` | PASS |
| `PUBLIC_SITE_BROWSER_PAGE` | PASS |
| `SITE_PRODUCT_AUDIT` | PASS |
| `OPENKERN_CONTRADICTION_RESOLVED` | PASS |
| `PUBLIC_DEMOS` | PASS — 24 passos em 6 demos, do clone da tag |
| `SECURITY_SCAN` | PASS — ponta **e** histórico |
| `PUBLIC_CLEAN_ROOM` | PASS |
| `FINAL_RELEASE_TAG` | PASS — `v0.3.2` |
| `REMOTE_ARTIFACT_VALIDATION` | PASS |
| `UNPROVEN_PUBLIC_CLAIMS` | **0** |
| `KNOWN_PRODUCT_DEFECTS` | **0** |
| `PUBLIC_LAUNCH_COMPLETE` | **YES** |
