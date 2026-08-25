# Roadmap

O que está aqui são **dívidas legítimas**, não promessas de data. Nada nesta
lista bloqueia o release: cada item está declarado em
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) e em
[`PRODUCT_TRUTH_MATRIX.md`](PRODUCT_TRUTH_MATRIX.md) com o status real.

A regra que separa roadmap de blocker: um blocker é algo que faz o produto
**mentir** sobre si mesmo. Um item de roadmap é algo que o produto ainda não faz
e **diz que não faz**.

---

## 1. Rota HTTP para emitir token com escopo

`SCOPED_TOKEN_HTTP_MINT=NOT_IMPLEMENTED`

Tokens com escopo existem e funcionam (`AuthManager.issue`), mas só pela API
interna. Não há rota pública para um operador emitir um token `observe` para um
auditor, ou um token `agent` para um cliente.

**Consequência hoje:** a separação "quem age não autoriza" é provada em unidade
(`tests/auth.test.ts`, com três mutações) e num teste de API em processo, **não**
por um cliente externo de escopo baixo batendo na rede.

**O que fazer:** `POST /api/v1/tokens` (ADMIN), com `preset`, `ttl_ms`,
`session_allowlist` e `subject`; `DELETE /api/v1/tokens/:id` para revogar;
listagem sem jamais devolver o segredo. Emitir token é ato de delegação — a rota
precisa ser `ADMIN` e auditada como tal.

## 2. O ramo `pr.page.isClosed()`

`ISCLOSED_BRANCH_PROVEN=NO`

O ramo existe em `getPage()` e está correto, mas é **inalcançável em operação
normal**: o listener de `close` tira a aba do mapa antes que alguém possa
observá-la fechada. É defesa de corrida.

**O que fazer:** ou construir um caminho real que o execute (uma corrida entre a
consulta ao mapa e o fechamento da aba), ou concluir que ele é genuinamente
inalcançável e removê-lo — deixando o comportamento a cargo dos dois ramos que
de fato disparam. As duas saídas são honestas; manter cobertura declarada sobre
código que ninguém executa não é.

## 3. Percentis estatisticamente sustentados

`P99_CLAIM=NOT_PROVEN`

Nenhum caminho de latência reporta `p99`: 30 amostras exigem 100, e o instrumento
devolve `null` em vez de chamar o máximo observado de p99.

**O que fazer:** uma bateria longa dedicada (≥ 100 amostras por caminho), rodada
numa máquina em repouso, com a memória disponível registrada por amostra. Sem o
repouso o número mede a máquina, não o produto — esta sessão mediu exatamente
isso quando 5 GB presos por um teste morto derrubaram seis arquivos que estavam
verdes.

Até lá, **nenhum máximo observado pode ser chamado de p99** em nenhuma superfície
pública.

## 4. Observabilidade

- A faixa de estado do console lê `/live` por **polling de 700 ms**. Os eventos
  já chegam por WebSocket em ~1 ms; migrar a faixa para evento eliminaria a
  diferença de duas ordens de grandeza entre o que o feed mostra e o que a faixa
  mostra.
- O selo de replay é **hash sem chave**: fecha corrupção e adulteração
  oportunista, não um adversário com acesso de escrita ao diretório. Assinatura
  com chave é o próximo degrau, e muda a afirmação de "íntegro" para "íntegro e
  autêntico".

## 5. Plataformas

Validado em **macOS/Apple Silicon**. Linux é plausível (nada no runtime depende
de macOS), mas *plausível* não é *medido* — e a supervisão via
`scripts/service.sh` é launchd, portanto só macOS.

**O que fazer:** rodar a suíte inteira em Linux e publicar o número, ou declarar
a plataforma como não suportada. Hoje o README diz que não foi medida, que é a
única coisa verdadeira a dizer.

## 6. Integrações

- **Gi** — integrada e medida (148 testes verdes do lado da Gi), com
  cancelamento por barge-in e distinção de cancelamento tardio.
- **Outros clientes MCP** — o servidor é agnóstico por construção, mas só a
  integração com o NOMOS e com a Gi foi exercitada de ponta a ponta.

## 7. Distribuição

Não é dívida técnica, é decisão do dono, e está registrada aqui para não se
perder:

- o `LICENSE` declara software **proprietário e não publicado**;
- o titular de direitos autorais no arquivo é um **placeholder** derivado da
  identidade do commit HEAD;
- o repositório **não tem remoto** — 16 commits além da última tag existem só
  nesta máquina.

Nenhum agente tem autoridade para escolher titular, licença ou destino de
publicação. Ver [`PRODUCT_MANIFEST.md`](PRODUCT_MANIFEST.md) §12.
