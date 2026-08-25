# Contribuir

Obrigado por olhar. Este documento é curto porque só existe uma regra que
realmente importa aqui, e ela vem primeiro.

## Um teste que não sabe falhar não entra

Todo teste novo precisa ser capaz de **reprovar**. Antes de abrir um PR, quebre
de propósito o código que o seu teste cobre e confirme que ele cai.

Se o teste continua verde com o defeito injetado, ele não está medindo nada, e
ele é pior do que nenhum teste: ele produz confiança sem base.

No corpo do PR, escreva a mutação que você fez e o que aconteceu. Por exemplo:

> Mutação: `if (perfil.envio_externo)` → `if (false)` em `classificar()`.
> Resultado: caso 7 do `e2e-modos` cai com `AUTO_NAO_E_BYPASS=NAO`.

Vários testes deste repositório existem só porque uma mutação revelou que a
versão anterior deles era cega. Um deles descobriu que uma aprovação para clicar
"Cancelar" autorizava "Confirmar compra".

## As outras regras

**Não declare PASS sem prova executável.** Se você não conseguiu medir, escreva
que não conseguiu, com o motivo. `NÃO MEDIDO` é uma resposta aceita aqui;
`provavelmente funciona` não é.

**Controle negativo onde houver risco de asserção vácua.** "O clique funciona"
só vale se existir também a prova de que um clique falso é rejeitado. "O segredo
não vazou" só vale se existir a prova de que o segredo realmente chegou lá.

**Nunca mate processo sem prova de posse.** Vale para scripts e para o seu
terminal. Porta não prova posse: o sistema operacional reatribui porta livre a
quem pedir. Use `scripts/limpar-orfaos.sh`.

**Não afirme número sem o `n`.** E não chame de `p99` o máximo de uma amostra
pequena. O módulo de bench recusa fazer isso; a documentação também deve.

## Antes de abrir o PR

```bash
npx tsc --noEmit
bash scripts/run-suite.sh              # ou --fast durante o desenvolvimento
bash scripts/regressao-completa.sh     # 17 etapas, um veredito
```

Use o executor, não `node --test tests/` direto: o runner do Node paraleliza por
CPU e, sob pressão de memória, morre no meio deixando saída truncada **sem linha
de sumário**, o que parece sucesso.

Se a suíte falhar de um jeito que não tem relação com a sua mudança, olhe a
coluna `mem_disp_gb` do `.suite/resumo.tsv` antes de investigar o código: um
modelo de LLM preso na memória por um teste morto já derrubou seis arquivos que
estavam verdes minutos antes.

## Estilo

- **Português** em comentário, documentação e mensagem de commit. Identificadores
  técnicos (rotas, códigos de erro, nomes de ferramenta) em inglês, porque são
  contrato.
- **Comentário explica POR QUE, não O QUE.** O código já diz o que faz. O que se
  perde é a razão: qual defeito isso evita, o que foi medido, o que se tentou
  antes e não funcionou.
- **Mensagem de commit descreve defeito, causa raiz e correção.** O `CHANGELOG`
  é agrupado por commit justamente porque essas mensagens carregam a cadeia.

## Segurança

Não abra issue pública com detalhe explorável. Ver [`SECURITY.md`](SECURITY.md).

## Marca

Os tokens de identidade visual **não** são versionados aqui: eles são lidos do
cofre de marca a cada build. Não adicione cor literal em
`packages/ui/src/app.html` — `tests/ui-build.test.ts` reprova, e a proibição vem
do contrato de governança de marca, não de preferência de estilo.

## Licença

Ao contribuir, você concorda que sua contribuição seja licenciada sob os termos
do [`LICENSE`](LICENSE) (MIT).
