# Release

Como se faz uma versão deste produto. **A primeira é `0.2.0-rc.1`**, marcada
pela tag anotada `v0.2.0-rc.1`; antes dela o repositório não tinha tag alguma e
`package.json` dizia `0.1.0` desde o começo. Este documento descreve o
procedimento — que foi o seguido para produzir essa versão.

O princípio é um só: **a versão que sai é a que a tag descreve, provada a partir
da tag** — não a partir da sua árvore de trabalho. Toda etapa abaixo existe para
fechar uma forma específica de mentir sobre isso.

---

## 0. Pré-requisitos que não são negociáveis

- Sem `P0`/`P1` aberto. Se houver, o release não acontece; o defeito acontece.
- `docs/EVIDENCIA.md`, `docs/RASTREABILIDADE.md` e `docs/LIMITATIONS.md`
  atualizados com números **desta** medição, com data.
- Nada descrito como pronto se depende de aprovação do dono que ainda não veio
  (hoje: o registro no catálogo do NOMOS — ver `docs/LIMITATIONS.md`, item 10).

## 1. Árvore limpa

```bash
git status --porcelain     # tem de sair VAZIO
git log --oneline -1
```

Qualquer arquivo não rastreado ou modificado é motivo para parar. Um release
feito com árvore suja é um release cujo conteúdo ninguém consegue reconstruir —
a tag apontaria para um commit que não é o que foi testado.

Exceção que **não** é exceção: se algo precisa existir e não está versionado,
versione. Se não precisa, remova. "Está aí mas não conta" não é um estado.

## 2. Versão

```bash
npm version <major|minor|patch> --no-git-tag-version
```

Regra de SemVer aplicada ao que este produto expõe:

- **MAJOR** — mudança incompatível na API v1, no contrato, ou em **default que
  muda comportamento observável**. Os dois exemplos que já ocorreram e que
  seriam major se houvesse versão publicada: `allow_unleased` invertendo para
  `false`, e `browser.observe`/`extract` passando a devolver `provenance`.
- **MINOR** — capacidade nova compatível.
- **PATCH** — correção sem mudança de contrato.

Alinhe a versão nos `package.json` dos pacotes publicáveis em `packages/*`.
Versão divergente entre pacotes do mesmo release é um bug de release, não um
detalhe.

## 3. Changelog

Mova o conteúdo de `[Não lançado]` para uma seção com a versão e a data:

```markdown
## [0.2.0] — 2026-08-25
```

Cada item tem de dizer se é **correção de defeito**, **capacidade nova** ou
**mudança de comportamento incompatível**. Item que não sabe dizer qual dos três
é ainda não está entendido o bastante para sair.

O changelog é escrito a partir das **mensagens de commit**, que neste projeto
descrevem defeito, causa raiz e correção. Não é escrito de memória.

## 4. Commit e tag

```bash
git add -A
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
```

Tag **anotada**, nunca leve: tag leve não guarda autor, data nem mensagem, e é o
tipo de economia que se paga em auditoria.

A tag vem **depois** do commit que fecha o changelog e a versão. Marcar antes
faz a tag apontar para um estado que não descreve a si mesmo.

## 5. CI sobre a tag

```bash
git checkout v0.2.0
bash scripts/ci.sh all           # esperado: CI_PASS=YES
bash scripts/run-suite.sh --out /tmp/suite-release
```

Registre `TS_PASS`, `TS_FAIL`, `ARQUIVOS_OK`, `ARQUIVOS_RUINS` e a **data/hora**
da execução. Arquivo `MORTO` **não** é aprovação: reexecute isolado, com a
máquina livre, e registre as duas execuções (ver `docs/TROUBLESHOOTING.md`).

Referência da última medição registrada: `2026-08-25 01:09–01:12` (UTC-3),
HEAD `78491cc` — `TS_PASS=696 TS_FAIL=0 ARQUIVOS_OK=33 ARQUIVOS_RUINS=0`
(`evidence/nomos-browser-final-loop/18-docs/resumo.tsv`).

## 6. Clean room a partir da tag

O passo que pega o que a máquina de desenvolvimento esconde. Clone **da tag**,
em diretório novo, sem reusar `node_modules`:

```bash
TAG=v0.2.0
DIR=$(mktemp -d /tmp/nomos-cleanroom-XXXXXX)
git clone --depth 1 --branch "$TAG" file://$PWD "$DIR"
cd "$DIR"
npm ci --include=dev            # --include=dev: ver docs/INSTALLATION.md
npx playwright install chromium
node spike/fase1_spike.ts       # esperado: 25/25
npm run typecheck               # esperado: rc=0
bash scripts/ci.sh all          # esperado: CI_PASS=YES
```

Foi exatamente este passo que pegou o `package-lock.json` fora de sincronia:
`npm ci` falhava com `EUSAGE` em **qualquer** checkout limpo, e a CI declarada,
que roda `npm ci` nos cinco jobs, nunca poderia ter passado. Sem clean room,
esse defeito viaja para dentro da versão.

## 7. E2E da tag

Contra daemon real e Chromium real, a partir do clean room:

```bash
node evidence/nomos-browser-final-validation/10-e2e/e2e-independente.ts
node evidence/nomos-browser-final-loop/07-nomos/cliente-fiel.ts
node evidence/nomos-browser-final-loop/11-security/bateria-completa.ts
bash evidence/nomos-browser-final-loop/14-supervisor/prova-supervisor.sh
```

Registre o resultado de cada um com o número, não com um adjetivo. Falha
esperada e **declarada** (por exemplo, um cenário que depende de aprovação
pendente do dono) continua sendo falha e entra no registro como tal.

## 8. Antes de anunciar

- [ ] `LICENSE` traz o titular **correto** — não o placeholder.
- [ ] `docs/LIMITATIONS.md` reflete os números desta medição.
- [ ] Nada é descrito como pronto se depende de assinatura do dono.
- [ ] `CHANGELOG.md` marca cada item como correção / capacidade / incompatível.
- [ ] Os artefatos de evidência desta release estão versionados, com caminho
      citável.

## 9. Se der errado depois da tag

Não reescreva a tag. Marque `v0.2.1` com a correção e registre no changelog o que
a `v0.2.0` tinha de errado. Uma tag mutável destrói a única propriedade que faz
uma tag valer alguma coisa: apontar sempre para o mesmo estado.
