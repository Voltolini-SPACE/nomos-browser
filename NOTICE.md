# Avisos

## Licença

O código deste repositório está sob a licença **MIT**, cujo texto integral está
em [`LICENSE`](LICENSE). Titular: **Voltolini-SPACE**.

O `LICENSE` contém **apenas** o texto canônico da MIT, sem nenhuma adição. Isso
é deliberado: qualquer nota extra dentro dele faz os detectores automáticos do
GitHub e das ferramentas de empacotamento classificarem o projeto como
*"Other"* em vez de *MIT*. Uma licença que as máquinas não conseguem ler falha
em metade do trabalho dela, e a metade que falha é justamente a que alcança
quem nunca vai abrir o arquivo.

Foi o que aconteceu na primeira publicação deste repositório, e este arquivo
existe por causa disso.

## Marca

A licença MIT cobre o **código**.

Ela **não** concede direito sobre:

- as marcas **NOMOS** e **NOMOS Browser**;
- os tokens de identidade visual (cores, tipografia, grid) do ecossistema.

Esses tokens são governados pelo contrato de marca do ecossistema e **não são
versionados neste repositório**: a interface os lê do cofre de marca a cada
build, e `tests/ui-build.test.ts` reprova se um valor literal aparecer no
código-fonte.

Você pode usar, modificar e redistribuir o software sob os termos da MIT. Para
usar o **nome** ou a **identidade visual** NOMOS num produto derivado, fale com
o titular.

## Histórico do estado legal

Até 2026-08-25 o `LICENSE` declarava *todos os direitos reservados* e trazia um
titular **placeholder**, derivado mecanicamente da identidade do autor do commit
HEAD. O histórico do repositório tem duas identidades de autoria, e nenhuma
delas prova titularidade legal por si só.

Titular e licença são decisões do dono. Ambas foram tomadas em 2026-08-25.

A cópia proprietária anterior está preservada em
[`evidence/nomos-release/00-freeze/LICENSE-anterior-proprietario.txt`](evidence/nomos-release/00-freeze/LICENSE-anterior-proprietario.txt),
porque o histórico do estado legal é parte da evidência do projeto.

## Dependências

O runtime depende de `playwright` (Apache-2.0) e `ws` (MIT). O Chromium é
baixado pelo Playwright e tem licença própria (BSD-3-Clause e outras, conforme
os componentes).
