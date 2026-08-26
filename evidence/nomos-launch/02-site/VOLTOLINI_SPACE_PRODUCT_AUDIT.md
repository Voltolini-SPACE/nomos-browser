# Auditoria de produto — voltolini.space

Comparação entre o que o site **afirma** e o estado **real** dos produtos.

Apurado em 2026-08-25. Método: leitura de cada página do site e verificação
contra o repositório correspondente na máquina (`git`, testes, manifestos).

Classificação: `CORRECT` · `OUTDATED` · `MISSING` · `BROKEN` · `UNVERIFIED`

---

## Resumo

| # | achado | classe | corrigido |
|---|---|---|---|
| 1 | NOMOS Browser não tem página, e é citado como experimental | `MISSING` | sim |
| 2 | Contagem de testes do OpenKern se contradiz entre hub e produto | `BROKEN` | **sim** — resolvido por execução, ver §2 |
| 3 | `Se7enpay` viola a grafia da casa em `nomos/index.html` | `BROKEN` | sim |
| 4 | `/terminal/` é rota órfã, sem link de lugar nenhum | `BROKEN` | sim |
| 5 | `check.py` só valida o hub; quatro páginas não são checadas | `BROKEN` | parcial — ver §5 |
| 6 | Gi não tem página nem menção | `MISSING` | não — decisão do dono |
| 7 | Números do NOMOS e do EPISTEMOS | `CORRECT` (EPISTEMOS) · `OUTDATED` (NOMOS) | ver §7 |

---

## 1. NOMOS Browser — `MISSING` → corrigido

O produto não tinha página. A única menção estava em `nomos/index.html`, na
coluna **Experimental**:

> `Navegador via Playwright, opt-in, testes não assinados.`

Isso ficou desatualizado: o NOMOS Browser hoje é `0.3.0-rc.1`, com 792 testes,
106 casos ponta a ponta, Live Agent Console e dois modos de autonomia.

**Corrigido:** criada a página `/browser/`, e a linha em `nomos/index.html`
passou a apontar para ela mantendo o rótulo honesto — o produto é **release
candidate**, não estável, e continua em Experimental por isso.

## 2. OpenKern — contagem contraditória — `BROKEN` → **resolvido por execução**

Duas páginas citavam **o mesmo baseline congelado** com números diferentes:

| onde | afirmava |
|---|---|
| `index.html` (hub) | `95 testes no baseline congelado` |
| `openkern/index.html` | `69 testes no baseline G0 a G7` · terminal `69 passed` |

Ambas apontando para `openkern-bootstrap-01 (commit d06dddf)`.

**Resolvido rodando os testes naquele commit**, em clone temporário, sem tocar na
árvore de trabalho do dono (que está numa branch de fix, com trabalho não
commitado):

```
cargo test --workspace  @  d06dddf
  kern_types 12 · kern_fsm 5 · kern_policy 4 · kern_capability 22
  kern_repo 7 · kern_git 8 · kern_exec 11
  TOTAL_PASSED = 69   ·   0 failed
```

Bate exatamente com a decomposição do relatório congelado no próprio commit
(`TEST_COUNT = 69`), e com a mensagem do commit (*"G0..G7 PASS, 69 tests"*).

**A página do produto estava certa. O hub estava errado.**

### De onde veio o 95

O 95 não foi inventado. Ele é real **em outro commit**:

```
docs/BRAND_FREEZE_v1.0.md @ 2ff6631 (tag openkern-brand-v1.0)
  CARGO_TEST : RC=0 · 95 passed · 0 failed (workspace completo)
```

O commit `8f9f7ab` (*"site publication deltas"*) levou esse número para a copy do
hub. O defeito não foi um número inventado: foi um número **verdadeiro colado sob
o rótulo errado** — a contagem do *brand freeze* sob a etiqueta do *bootstrap
baseline*.

Três medições, três commits, todas verdadeiras:

| commit | rótulo | testes |
|---|---|---|
| `d06dddf` (`openkern-bootstrap-01`) | baseline congelado G0..G7 | **69** |
| `2ff6631` (`openkern-brand-v1.0`) | brand freeze v1.0 | **95** |
| `0de0410` (HEAD da branch de fix) | trabalho em curso | **128** |

**Corrigido:** o hub passou a dizer 69 e a **nomear a tag**, para que o número
viaje com a sua procedência. É a lição que o resto desta auditoria repete: um
número sem commit ao lado envelhece sem avisar.

## 3. Grafia `SE7EN PAY` — `BROKEN` → corrigido

`nomos/index.html` linha 342 trazia:

> `MIT · mantido por Se7enpay · © 2026 NOMOS`

A grafia da casa é `SE7EN PAY`, e o `check.py` reprova `Se7enpay`, `Se7enPay` e
`SEVEN PAY`. Ele não pegou este caso porque **só inspeciona `index.html` e
`404.html`** (ver §5).

**Corrigido** para `SE7EN PAY`.

## 4. `/terminal/` órfão — `BROKEN` → corrigido

A rota foi publicada no commit mais recente (`db5346d`) e **nada no site aponta
para ela**. Só chega quem digita a URL.

**Corrigido:** entrada no card do CONFRAPAG no bloco de ecossistema, levando à
demonstração.

## 5. `check.py` só guarda o hub — `BROKEN`, corrigido parcialmente

A lista `PAGES` do verificador é `["index.html", "404.html"]`, e todas as
antirregressões leem `INDEX`. Consequência: `/nomos/`, `/epistemos/`,
`/openkern/`, `/terminal/` e a nova `/browser/` **não são verificadas** — nem
para link quebrado, nem para `alt` ausente, nem para proporção de imagem, nem
para a grafia da casa.

O achado §3 é a prova: um erro que o verificador conhece passou dois commits
porque estava no arquivo errado.

**Corrigido parcialmente:** as checagens que são seguras de generalizar (grafia
protegida, travessão em texto público, `alt` não vazio, link relativo existente)
passaram a rodar em **todas** as páginas. As antirregressões específicas do hub
continuam só nele, porque falam de elementos que só existem lá.

## 6. Gi — `MISSING`, não corrigido

O assistente de voz não aparece em lugar nenhum do site, embora seja parte do
ecossistema e tenha integração medida com o NOMOS Browser (148 testes verdes do
lado dele).

**Não corrigi:** decidir que um produto entra no site é decisão de posicionamento
do dono, não de quem audita. Registrado como lacuna.

## 7. Números do NOMOS e do EPISTEMOS — verificados

Não classifiquei mais como `UNVERIFIED`: eu os verifiquei.

### EPISTEMOS — `CORRECT`

O site afirma `996 tests green`. Rodado na tag que o site cita (`core v0.7`):

```
git checkout epistemos-v0.7.0 && pytest -q
  996 marcadores · 0 falhas · RC=0
```

O número está certo, na versão certa.

### NOMOS — `OUTDATED`, e para menos

O site afirma `1.900+ testes automatizados`. O repositório público coleta:

```
github.com/Voltolini-SPACE/NOMOS @ a8c362c
  pytest --collect-only -q  →  3796 tests collected
```

A afirmação é **verdadeira** (o `+` a torna um piso) porém defasada em mais da
metade. Isso não é falso claim; é um número que envelheceu sem avisar, que é
exatamente o padrão que esta auditoria encontrou três vezes.

A própria página do NOMOS traz a ressalva honesta de que os números *"refletem a
documentação pública do produto e podem evoluir a cada release"*.

---

## Observações de estrutura

**Não há componentes compartilhados.** Cada página duplica header, nav, footer e
CSS. Uma correção de rodapé precisa ser feita cinco vezes, e o achado §3 mostra o
custo disso: a grafia errada sobreviveu num arquivo enquanto o verificador
protegia outro.

Não é urgente e não foi mexido — introduzir templating num site que hoje é
"HTML puro, sem build" é uma decisão de arquitetura, não uma correção de
auditoria.

**Paletas por produto são deliberadas** (NOMOS verde terminal, EPISTEMOS
índigo/âmbar, OpenKern por estado). A página nova segue a paleta do NOMOS, por
ser produto da mesma família.
