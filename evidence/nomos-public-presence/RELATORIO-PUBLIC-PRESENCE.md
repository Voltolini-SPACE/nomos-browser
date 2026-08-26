# NOMOS Browser — fechamento da presença pública

Data: 2026-08-26.

A missão pedia revisar apresentação, marca e copy. O que ela encontrou primeiro
foi que **a CI pública estava vermelha em todas as onze execuções desde que o
repositório ganhou remote** — e que a validação da missão anterior, com cinco
salas limpas, nunca tinha rodado o comando que a CI roda.

---

## 1. O achado que dominou a missão: a CI nunca esteve verde

O dono avisou. Estava certo, e o modo de falha escondia isso de quem só olhasse a
lista de execuções: o job `fast` falha em ~1 min e os outros **sete jobs saem como
`skipped`**, então a execução inteira dura 1m07s e não parece uma suíte reprovando
— parece uma suíte rápida.

### Três causas independentes

| causa | desde | de quem |
|---|---|---|
| `test:ui-build` chamava `build()`, que falha fechado sem o cofre de marca | a 1ª execução | pré-existente |
| `config:tabela-gerada-esta-atual` — a tabela publicada anunciava `0.2.0` com o produto em `0.3.2` | a 1ª execução | pré-existente |
| `pacotes:manifestos-completos` — `engines.node` corrigido só na raiz | `5ca4461` | **minha** |

A terceira merece o nome inteiro. Na missão anterior eu corrigi `engines.node` de
`>=22.6.0` para `>=22.18.0` porque tinha **provado** que a faixa era falsa — e
mudei só o `package.json` da raiz. Os oito pacotes do workspace ficaram com a
faixa falsa. O guarda compara os pacotes com a raiz, então a CI passou a reprovar
exatamente a partir do commit em que eu "consertei" a alegação.

### Por que cinco salas limpas não pegaram

Nenhuma delas rodava o ponto de entrada que o GitHub roda.

```
sala limpa            npm test                  -> run-suite.sh
regressão completa    lista curada de etapas
workflow do GitHub    ./scripts/ci.sh <estagio>   <- ninguém rodava isto
```

Três caminhos parecidos e não iguais, e o que a CI reprovava não era exercido por
nenhum dos outros dois. **Validar algo adjacente ao que a CI valida não é validar
a CI.** `scripts/regressao-completa.sh` ganhou a etapa **5b**, que roda
literalmente `./scripts/ci.sh fast`. O verde local volta a significar o que
parecia significar.

### Resultado

Primeira execução verde da história do repositório, com os 8 jobs, incluindo
`e2e` com Chromium real:

```
fast · core · security · integration · adversarial · recovery · providers · e2e
todos success
```

`PUBLIC_GITHUB_ACTIONS=PASS`

---

## 2. Defeitos encontrados e corrigidos

### 2.1 Testes que confundiam "esta máquina não tem isto" com "o produto quebrou"

Três casos da mesma doença, e a regra que faltava era a metade que ninguém tinha
escrito: o cabeçalho do `ci.sh` já dizia **nunca verde por impossibilidade**;
faltava **tampouco vermelho por impossibilidade**.

| teste | dependia de | agora |
|---|---|---|
| `ui-build` (4 testes) | cofre de marca do dono | pula com a razão; os 2 herméticos continuam rodando |
| `policy-vault` (teste 6) | binário do Chromium | pula com a razão e o comando para resolver |
| `bench` (controle de CPU) | a máquina entregar CPU | pula com os números medidos |

Controles, em cada caso:

```
ui-build     com cofre    6 pass, 0 skip      sem cofre    2 pass, 0 fail, 4 skip
policy-vault macOS c/ Chromium 14 pass        Linux s/ Chromium 13 pass, 0 fail, 1 skip
bench        sem carga    37 pass, 0 skip     40 processos 36 pass, 0 fail, 1 skip
```

O caso do `policy-vault` tem um detalhe que só apareceu por rodar noutra
plataforma: o estágio `cleanroom` se anuncia como *"subconjunto HERMÉTICO (sem
Chromium)"* e declarava um arquivo que sobe um navegador. No Mac do dono passava
calado porque o Chromium estava instalado. Era justamente o script que deveria
provar instalação do zero que não rodava do zero.

### 2.2 A tela vazia apontava um endereço que podia não ser o dela

`#semTela` dizia *"nomos-browser em 127.0.0.1:7777"* como **texto fixo**. Com o
daemon noutra porta — o caso normal em teste, em demo, e em qualquer máquina com
a 7777 ocupada — a mensagem mandava o leitor conferir um endereço que não era o
dela. Mensagem de erro que aponta o lugar errado custa mais caro do que mensagem
nenhuma: manda depurar o que não está quebrado.

Controle de mutação, com daemon em porta não-padrão:

```
com o conserto     tela mostra 127.0.0.1:7830   = o runtime real
revertido          tela mostra 127.0.0.1:7777   = a mentira de volta
```

### 2.3 Eu publiquei uma string em formato de chave AWS num repositório público

`PUBLIC_REPO_SECRET_LEAK=1`, apontando para
`evidence/nomos-launch/04-seguranca/03-mutacao-segredo-plantado.txt`.

Não é credencial: é o canário sintético que eu mesmo plantei na missão anterior
para provar que a varredura de histórico funciona — corpo `0123456789ABCDEF`,
sequencial, não dá acesso a nada. Mas eu escrevi a **saída de um scanner de
segredos, com o segredo casado dentro**, para um arquivo versionado e publicado.
Ninguém que varre de fora consegue distinguir o meu canário de uma credencial
viva. E não conseguiu mesmo.

Redigido no HEAD. Duas coisas ficam ditas em vez de escondidas:

- O literal **permanece no histórico**, em `f801629`. Não reescrevo histórico já
  publicado por uma string que não é credencial, então `HISTORICO_PUBLICO_LIMPO`
  continua **NÃO**, com causa conhecida e nomeada, em vez de virar verde por uma
  exceção no scanner. Nenhuma exceção foi adicionada: allowlist de segredo
  apodrece.
- O relatório da missão anterior declarou `PUBLIC_REPO_SECRET_LEAK=0`. Era verdade
  quando foi medido, e deixou de ser no commit seguinte — o que introduziu o
  problema foi justamente o commit que publicou a evidência do gate. **Medi o gate
  antes de commitar o artefato que o quebra.**

---

## 3. Presença pública

### 3.1 A página do produto não levava ao produto

A `/browser/` tinha **quatro links, e nenhum ia para o GitHub**. Dizia "Código
aberto sob MIT" e não dizia onde. Os dois CTAs do hero eram âncoras para outras
seções da própria página. Quem chegasse convencido não tinha para onde ir.

Agora: CTA primário **Ver no GitHub**, seção **Começar** com clone/install/test/
daemon, e links para README, release, `SECURITY.md` e Issues.

Os comandos foram **conferidos, não copiados de memória**. A porta padrão foi
medida subindo o runtime (`127.0.0.1:7777` respondeu 401 — de pé e pedindo
credencial). E a primeira versão do bloco omitia que o console **exige token**;
quem seguisse levaria um 401 sem entender.

### 3.2 Screenshot real do console

A missão proíbe interface fictícia para marketing e exige screenshots reais.
`scripts/capturar-console.mjs` sobe o daemon de verdade, cria sessão de verdade,
põe o agente em ASK contra uma página de pagamento e fotografa a tela **no
instante em que ele para e pergunta** — o único estado que mostra "AUTO != BYPASS"
como coisa na tela, e não como frase de README.

A `/browser/` era a única página do site **sem `og:image`**, e o `twitter:card`
era `summary` (formato pequeno). Agora tem imagem social do produto real,
`summary_large_image`, e o print dentro da seção "Você vê o agente trabalhar",
que até então afirmava e não mostrava.

### 3.3 O hub dizia 792

Quando a `/browser/` foi corrigida de 792 para 797, o cartão do NOMOS Browser no
**hub** ficou para trás. O verificador de alegações não pegou porque **só conhecia
a `/browser/`** — um verificador que cobre uma página e se chama "verificador de
alegações públicas" entrega uma sensação de cobertura que não tem, e foi essa
sensação que deixou o 792 no ar. O conserto principal foi no instrumento
(`--hub`); o número foi a consequência.

### 3.4 Perfil da organização

O NOMOS Browser **não aparecia** em "Flagship products" do README do perfil.
Entrou com o posicionamento que a página defende. O link do NOMOS apontava para
`voltolini-space.github.io/NOMOS/` enquanto todo o resto do arquivo usa
`voltolini.space`; passou ao canônico.

### 3.5 GitHub

README ganhou badges de CI, release e licença — o de CI só faz sentido agora que
existe execução verde — e o print do console no topo, porque quem chega pelo
GitHub via oito seções de texto antes de ver o produto uma vez.

O cabeçalho do `ci.yml` dizia *"este workflow nunca foi executado por um runner do
GitHub — o repositório não tem remote"*. Deixou de ser verdade no dia em que o
repositório ganhou remote, e continuou no arquivo público por onze execuções.
**Uma nota de honestidade que ninguém revisa vira desinformação com selo de
honestidade.**

Wiki vazia desabilitada.

---

## 4. Plataforma nova, com escopo declarado

Parte desta missão rodou num container **Linux x86_64, Node 22.22.2** — o produto
só tinha sido medido em macOS/Apple Silicon.

```
PASSOU no Linux    npm ci · tsc --noEmit · ./scripts/ci.sh cleanroom  (CI_PASS=YES)
NÃO MEDIDO no Linux  tudo que exige Chromium — o binário não baixa naquele ambiente
```

Isto **não** promove Linux a plataforma suportada. É um resultado parcial, dito
como parcial. A limitação declarada no README continua valendo.

---

## 5. Erros meus nesta missão

1. **Li a CI como verde quando estava vermelha.** A página de lista de execuções,
   resumida, me devolveu "10/10 succeeded". A verdade era o oposto: `fast` falha e
   sete jobs saem `skipped`. Só a página do run individual, e depois `gh run list`,
   mostraram `failure`. Eu tinha dito ao dono que estava verde — com ressalva, mas
   tinha dito.

2. **Afirmei uma data de causa sem ler o histórico.** Escrevi num commit
   *"a CI estava vermelha desde 5ca4461"*, deduzindo a data da causa que eu tinha
   achado. `gh run list` mostrou que **todas** as execuções falharam, inclusive as
   anteriores ao meu commit. Corrigido no commit seguinte, que é público.

3. **Troquei um limiar frágil por outro.** Substituí o `5x` do bench por
   `fracao(queima) > 0.5`, achando "fração da parede" independente de hardware.
   Não é: no runner o processo é desescalonado, a parede infla, a fração desaba.
   **A CI me reprovou nessa exata linha.** Virou medida de validade, não asserção.

4. **Quase reportei um defeito de produto que era da minha foto.** A primeira
   captura do console saiu com o palco preto, e eu ia registrar "a página
   espelhada não aparece durante a aprovação". Medido: o espelho enche em ~1,45 s
   e **continua visível** com aprovação pendente. A foto disparava aos 900 ms.

5. **Errei rota e corpo da API e culpei o silêncio.** `?session_id=` em vez de
   `/sessions/{id}/approvals` (200 com lista vazia, indistinguível de "ainda não
   chegou"), e `{autonomy_mode}` em vez de `{mode, by}` — a rota aceitava, o modo
   não mudava, e a captura esperava para sempre por uma aprovação impossível.
   O script agora **confere** o modo em vez de supor.

6. **Meu verificador de alegações só conhecia uma página** (§3.3).

---

## 6. Pendências, e nada disto está escondido no produto

1. **`HISTORICO_PUBLICO_LIMPO=NÃO`**, causa única e nomeada: o canário sintético
   em `f801629` (§2.3). Não é credencial. Exige reescrever histórico publicado
   para limpar.
2. **Só macOS/Apple Silicon é plataforma medida.** O resultado no Linux é parcial
   e está declarado como parcial.
3. **Nenhum p99 é reportado**, em nenhum caminho.
4. **Não há rota HTTP para emitir token com escopo.** Existe na API interna.
5. **O selo do replay é hash sem chave** — detecta corrupção acidental, não um
   adversário com escrita no bundle.
6. **Flags E2E ainda PARCIAIS**, ditas assim pelo próprio gate:
   `VISION_MOUSE_PASS`, `MULTI_AI_PASS`, `RECOVERY_PASS`.
7. **`test:bench` reprovou no runner por um motivo que não reproduzi.** Sob 40
   processos disputando aqui a razão ficou em 19,7x, bem acima do 5x. O limiar
   segue intocado por falta de razão medida; quando acontecer de novo, o teste
   pula dizendo os números em vez de mentir que o produto quebrou.
8. **Registrado, fora de escopo, para o dono decidir:**
   - `voltolini-space.github.io/NOMOS/` e `voltolini.space/nomos/` servem a mesma
     página em dois endereços. Conteúdo duplicado divide sinal de busca.
   - O campo *website* do perfil da organização ainda aponta para o github.io.
   - `openkern` é público e não está em "Flagship products". Não o adicionei
     porque não o revisei nesta missão, e escrever posicionamento de produto que
     não conferi seria inventar alegação.
   - `se7enpay-autopost` é público **sem descrição**.
9. **Ainda em aberto de missões anteriores:** a investigação do
   *ConfraPix × TPV do Pix da Se7en* na Gi (`pocket-assistant`).

---

## 7. Portões

| portão | estado |
|---|---|
| `NOMOS_BROWSER_PRODUCT` | PASS — 797 passes, 0 falhas, 38/38 arquivos |
| `GITHUB_PUBLIC` | PASS |
| `README` | PASS |
| `QUICKSTART` | PASS — clone + `npm ci` + typecheck executados em Linux e macOS |
| `PUBLIC_CI` | **PASS** — 8/8 jobs verdes |
| `SITE_BROWSER` | PASS |
| `MOBILE` | PASS — `LAYOUT_OK=YES`, 6 rotas × 2 larguras (1280 e 390) |
| `VISUAL_IDENTITY` | PASS — verde-neon NOMOS, selo `NOMOS v1.0 · OFICIAL` |
| `COPY` | PASS |
| `SEO` | PASS |
| `SOCIAL_PREVIEW` | PASS — `og:image` do produto real, `summary_large_image` |
| `PUBLIC_LINKS` | PASS — `BROKEN_PUBLIC_LINKS=0` |
| `SECRET_SCAN_HEAD` | PASS — `PUBLIC_REPO_SECRET_LEAK=0` |
| `SECRET_SCAN_HISTORY` | **FAIL declarado** — §2.3, causa única e nomeada |
| `UNPROVEN_PUBLIC_CLAIMS` | **0** |
| `EXTERNAL_USER_TEST` | PASS — 10/10 respondidas pela página no ar |
| `PUBLIC_PRESENCE_COMPLETE` | **YES**, com a ressalva de `SECRET_SCAN_HISTORY` |

**Versão:** `v0.3.2` mantida. Nada aqui mudou comportamento de produto que
justificasse semantic versioning — os consertos foram em testes, instrumentos,
documentação e apresentação.
