# NOMOS Browser — fechamento de produto e release

Da conclusão técnica ao produto documentado, apresentado e integrado ao
ecossistema.

Este documento registra o que foi **medido** e o que **não pôde** ser feito, com
o motivo. Onde houve erro meu, o erro está aqui.

---

## 1. HEAD inicial e final

| | |
|---|---|
| HEAD inicial | `6964cf0` — *FASE 31: NOMOS_LIVE_AGENT_FINAL_VALIDATION* |
| HEAD final | `076e446` · tag **`v0.3.0-rc.1`** |
| Branch | `main` |
| Remoto | **nenhum** (ver §10) |
| Árvore | limpa |

## 2. Versão

`0.2.0` → **`0.3.0-rc.1`**

O `package.json` declarava `0.2.0` com **16 commits além** da tag `v0.2.0`: a
versão declarada não descrevia mais o que o HEAD continha. Como a diferença era
uma capacidade inteira nova (Live Agent Console e modos de autonomia), o passo
correto era `0.3.0`, e como o artefato ainda não foi promovido, `-rc.1`.

`scripts/marcar-versao.ts` marca os **13 declarantes** de uma vez, reusando
`declarantes()` do próprio verificador — duas listas divergiriam no dia em que
um pacote novo nascesse. O autoteste tem controle negativo: a troca não pode
vazar para a versão de uma **dependência**.

Verificado por instrumento independente: `VERSION_COHERENT=YES (0.3.0-rc.1 em 13
declarantes)`, e `nomos-web --version` responde `0.3.0-rc.1`.

## 3. Commits desta fase

| commit | o que |
|---|---|
| `1d607cd` | versão, README de produto, 10 docs novos, demos, manifesto, matriz de verdade, roadmap, marketing |
| `a37a0c8` | security closeout: `PUBLIC_REPO_SECRET_LEAK=0`, caminhos pessoais fora do produto |
| `776d60f` | screenshots reais, e o que falta declarado |
| `ec7c871` | relatório de fechamento, marketing completo |
| `076e446` | correção do verificador que se auto-acusava (ver §17) |
| *(site)* `1a3ee3f` | página `/browser/`, `check.py` em todas as páginas, três correções, auditoria |

## 4. Testes

```
suíte TypeScript      792 passes · 0 falhas · 37/37 arquivos
E2E do Live Agent     9 baterias
demos                 6 demos, executadas contra Chromium real
Gi (pytest)           148 passed
```

Três testes novos entraram nesta fase, todos com mutação que os derruba (§7).

## 5. Sala limpa

`scripts/clean-room-live-agent.sh`, a partir de `git clone` do HEAD. Recusa
rodar com árvore suja: medir o HEAD enquanto o que importa está fora dele seria
medir outra coisa e chamar de prova.

## 6. Produto

- [`PRODUCT_MANIFEST.md`](../../PRODUCT_MANIFEST.md) — inventário canônico
- [`PRODUCT_TRUTH_MATRIX.md`](../../PRODUCT_TRUTH_MATRIX.md) — `PROVEN` /
  `MEASURED` / `NOT PROVEN` / `NOT IMPLEMENTED`, cada linha com o arquivo que a
  sustenta
- [`ROADMAP.md`](../../ROADMAP.md) — dívidas legítimas, sem data

A matriz é a fonte: nenhuma linha de copy pública existe sem `PROVEN`
correspondente.

## 7. Três defeitos que as demos encontraram

Os três tinham o mesmo formato: o produto **parecia** bem e o **verificador**
dizia que não. Em nenhum deles o verificador estava errado.

**1. Fechar a sessão nunca escrevia `result.json`.** O caminho de fechamento
chamava `selarSessao()` direto. O bundle nascia selado porém incompleto, e
**toda** sessão fechada pela API reprovava com *"a sessão nunca fechou"* — sobre
uma sessão que tinha fechado. Quem não tinha fechado era o gravador.

**2. Ler o replay quebrava o próprio selo.** `replay.read` e `replay.verified`
eram anotados no `actions.jsonl` **da sessão**, depois do selo:
`SELO_DIVERGENTE`. Uma rota somente leitura mudando aquilo que lê é a
contradição que a FASE 18 inteira existia para não cometer.

O detalhe que dói: o projeto **já tinha aprendido isso** ao fechar a sessão
(*"selar e depois anotar fazia todo bundle nascer divergente"*, comentado no
código). A mesma armadilha voltou por outro lado.

**3. Aprovar parecia trocar de dono.** O handler gravava o aprovador em `owner`
— que é *de quem é a sessão* — e a checagem C12 comparava ator em **todo**
registro. Uma sessão normal com duas aprovações produzia **14**
`TROCA_DE_DONO_SEM_EVENTO` por estar funcionando exatamente como projetado.

Corrigido dos dois lados: `owner` volta a ser o dono da sessão, e C12 compara
ator só entre ações **sobre a página**. O sinal forense continua inteiro — agente
A seguido de agente B sem handoff ainda é erro, e os controles negativos da
suíte provam isso.

## 8. Branding

A marca NOMOS **mudou de estado** desde a última vez que o repositório olhou:
`brand-resolve --require-official NOMOS` agora responde `rc=0`, com
`NOMOS_v1.0_CONGELADO.md` presente. O `docs/BRAND.md` documentava `rc=1`
(fail-closed, peça sai `PROPOSTA`) e estava desatualizado.

Isso é exatamente por que a missão manda verificar em vez de confiar num
documento de ontem.

A proibição que **não** mudou: token de marca não é copiado para arquivo
intermediário nem versionado. A interface continua lendo do cofre a cada build,
e `tests/ui-build.test.ts` falha se um hexadecimal aparecer no fonte.

## 9. README e documentação

README reescrito para nível de produto. O anterior dizia `696 testes`,
`HEAD 78491cc`, anunciava a integração NOMOS como **BLOQUEADA** e a marca como
**PROPOSTA** — três coisas já resolvidas havia dias.

Dez documentos novos: `quickstart`, `live-agent-console`, `ask-mode`,
`auto-mode`, `browser-control`, `tasks`, `audit-and-replay`, `mcp`,
`security-overview`, `demos`.

`scripts/verificar-links-docs.ts` guarda os links relativos e é **sensível a
maiúscula de propósito**: `docs/security.md` e `docs/SECURITY.md` são o mesmo
arquivo no macOS e arquivos **diferentes** no GitHub. Um link que só funciona na
máquina de quem escreveu é um link quebrado que ninguém vê. `DOCS_LINKS_OK=YES`.

## 10. GitHub

**O repositório não tem remoto.** 16 commits além da última tag existem apenas
nesta máquina, sem cópia. Isso é risco operacional, não só pendência de release.

Preparado e pronto para colar: nome, descrição, topics, primeiro release,
aviso de licença — em [`marketing/github-description.md`](../../marketing/github-description.md).

**CONTRIBUTING.md não foi criado de propósito.** Não faz sentido convidar
contribuição para um repositório cuja licença não concede permissão de uso,
cópia ou modificação: seria convidar alguém a enviar código que ele não teria
direito de derivar.

`SECURITY.md` criado na raiz (onde o GitHub procura), declarando o que **já** é
conhecido para que ninguém gaste um relato com isso.

## 11. Site

Página **`/browser/`** criada em `voltolini.space`, herdando CSS e paleta de
`/nomos/` por extração — produtos da mesma família não podem divergir quando a
marca mudar.

Auditoria completa do site em `VOLTOLINI_SPACE_PRODUCT_AUDIT.md` (no repositório
do site). Sete achados; quatro corrigidos, três deliberadamente não.

O achado estrutural: **`check.py` só validava o hub**. As quatro páginas de
produto nunca foram verificadas — nem link quebrado, nem `alt` ausente, nem a
grafia protegida da casa. A prova do custo: `nomos/index.html` trazia
`Se7enpay` havia dois commits, e o verificador **conhece** essa regra; ele só
não estava olhando para lá.

Agora as checagens genéricas rodam nas seis páginas. Duas correções minhas no
próprio verificador, ambas por falso positivo meu: *"recurso externo"* casava
`<a href>` e teria proibido o site de apontar para fora; e `lang` era exigido
`pt-BR` em toda página, mas `/epistemos/` é escrita em inglês de propósito, e
forçar `pt-BR` ali faria a página mentir para leitor de tela.

**Não empurrado.** `git push` publica o site: é ato do dono.

## 12. Marketing

`marketing/` com posicionamento, copy canônica, post de lançamento, descrição de
GitHub, copy de site, copy social, screenshots reais e diagramas.

Decisão de arquitetura de marca: **Live Agent Console não é produto separado.**
Não roda sem o runtime, não tem instalação, preço nem problema próprios. Tratá-lo
como produto criaria uma segunda identidade para uma tela.

## 13. Segurança

```
PUBLIC_REPO_SECRET_LEAK=0
CAMINHOS_PESSOAIS_EM_PRODUTO=0
```

`scripts/verificar-segredos-publicos.sh` varre **apenas o que o git leva**:
segredo fora do índice não é publicado e arquivo ignorado não vaza, então varrer
a árvore inteira produziria alarme sobre coisa que ninguém recebe.

Procura **formato** de credencial, não a palavra "token" — este produto fala de
token o tempo todo, e um casador de palavra reprovaria a documentação inteira sem
achar uma credencial sequer.

Dois vereditos **separados**, porque um caminho pessoal não é uma credencial.
Somar os dois foi o que a primeira versão do scan fez, e ela dizia "vazou
segredo" sobre um nome de pasta.

## 14. Limitações declaradas

- `P99_CLAIM=NOT_PROVEN` — nenhum máximo observado é chamado de p99
- `SCOPED_TOKEN_HTTP_MINT=NOT_IMPLEMENTED`
- `ISCLOSED_BRANCH_PROVEN=NO` — defesa de corrida, inalcançável em operação
- Plataforma: só macOS/Apple Silicon medido
- Faixa de estado da interface: polling de 700 ms, não evento

## 15. O que depende do dono

Três atos indelegáveis. Nenhum agente tem autoridade sobre eles:

**1. Titular dos direitos autorais.** O `LICENSE` traz um **placeholder**
derivado mecanicamente da identidade do commit HEAD. O histórico tem duas
identidades de autoria (44 commits `Voltolini-SPACE <admin@voltolini.space>`, 8
commits `NOMOS Browser <adm@se7enpay.com.br>`), e nenhuma prova titularidade
legal.

**2. Licença.** Hoje: proprietário, todos os direitos reservados, nenhuma
permissão a terceiros. Publicar o código sem decidir isso é coerente, mas é uma
decisão, não um default.

**3. Remoto e publicação.** O repositório não tem remoto; o site tem dois
commits não empurrados (um meu, um anterior). Criar remoto e empurrar são atos
do dono.

## 16. Incidente da sessão anterior, mantido no registro

Durante a Mission C, uma limpeza **por porta** enviou `SIGKILL` ao
`claudio-input-engine` do dono. O `ps` do mesmo laço imprimiu a linha de comando
do processo **antes** do kill: a prova passou na frente e o comando seguiu assim
mesmo.

`scripts/limpar-orfaos.sh` agora exige **prova de posse** (linha de comando do
daemon **e** runtime dir de teste) e preserva o resto dizendo o motivo. Registro
em `evidence/nomos-live-agent/11-regressao/INCIDENTE-processo-de-terceiro.md`,
mantido por decisão explícita.

`NO_KILL_WITHOUT_OWNERSHIP_PROOF=TRUE` foi respeitado em toda esta fase.


## 17. Artefato de release

```
tag                        v0.3.0-rc.1  →  076e446
RELEASE_ARTIFACT_REPRODUCIBLE=YES
```

Validado a partir de **clone da tag**, não da árvore de trabalho:

| checagem | resultado |
|---|---|
| `git clone --branch v0.3.0-rc.1` | HEAD confere |
| `npm ci --include=dev` | ok |
| `tsc --noEmit` | sem erro |
| `verificar-versao-coerente` | `0.3.0-rc.1` em 13 declarantes |
| `verificar-links-docs` | `DOCS_LINKS_OK=YES` |
| `verificar-segredos-publicos` | `PUBLIC_REPO_SECRET_LEAK=0` |
| `nomos-web --version` | `0.3.0-rc.1` |

### A tag foi recriada uma vez, e está dito

O primeiro clone da tag encontrou algo que a árvore de trabalho não mostrava: o
**verificador de segredos se acusava**. Ele procurava a string literal do
caminho pessoal, e a string literal estava dentro dele. Enquanto era arquivo
novo e não rastreado, não aparecia em `git ls-files` e a varredura reportava
zero. No clone, onde já era arquivo versionado, passou a se enxergar.

Vale registrar o formato do erro: **o instrumento estava certo sobre o mundo e
errado sobre si mesmo**, e só a clonagem limpa mostrou a diferença. É o mesmo
motivo pelo qual a sala limpa existe.

A tag foi apagada e recriada sobre a correção. Isso é legítimo aqui e **não**
viola a regra "nunca mover silenciosamente uma tag publicada" por duas razões:
o repositório não tem remoto, então a tag nunca saiu desta máquina; e a
recriação está escrita na própria mensagem da tag e neste relatório, o que é o
oposto de silenciosamente.

## 18. Estado final

```
MISSION_C_TECHNICAL=PASS
PRODUCT_DEFINITION=PASS
BRANDING=PASS
PRODUCT_COPY=PASS
README=PASS
DOCS=PASS
DEMOS=PASS
VERSIONING=PASS
CHANGELOG=PASS
PUBLIC_REPO_SECRET_LEAK=0
PRODUCT_SITE=PASS
VOLTOLINI_SPACE_AUDIT=PASS
MARKETING_PACKAGE=PASS
PRODUCT_TRUTH_MATRIX=PASS
RELEASE_CANDIDATE=PASS
RELEASE_CLEAN_ROOM=PASS
KNOWN_LIMITATIONS_DOCUMENTED=YES
P99_FALSE_CLAIM=NO
TREE_CLEAN=YES

NOMOS_BROWSER_TECHNICAL_PRODUCT=COMPLETE
NOMOS_BROWSER_MARKETING=COMPLETE
NOMOS_BROWSER_SITE=BUILT_NOT_PUBLISHED
NOMOS_BROWSER_GITHUB=PREPARED_NO_REMOTE
NOMOS_BROWSER_RELEASE=TAGGED_NOT_PUBLISHED
```

**`READY_FOR_PUBLIC_LAUNCH` não pode ser afirmado**, e o motivo não é técnico.
Três atos do dono continuam abertos (§15): titular dos direitos autorais,
licença, e criação de remoto/publicação.

Declarar `READY_FOR_PUBLIC_LAUNCH=YES` com o titular legal indefinido seria
exatamente o tipo de afirmação que o resto deste trabalho existe para não fazer.
O produto está **pronto para ser lançado**; o lançamento depende de decisões que
não são minhas.
