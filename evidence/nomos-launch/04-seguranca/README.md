# Auditoria de segurança sobre exatamente o conteúdo público

Os quatro arquivos aqui provam duas coisas separadas, e a segunda só existe
porque a primeira não bastava.

## O que foi varrido

`01-historico-tag.txt` e `02-ponta-tag.txt` foram gerados **dentro do clone
anônimo da tag `v0.3.0`**, não na árvore de trabalho. O conjunto varrido é
exatamente o que um estranho baixa.

| verdito | arquivo | o que cobre |
|---|---|---|
| `PUBLIC_REPO_SECRET_LEAK=0` | `02-ponta-tag.txt` | o que está versionado **agora** |
| `CAMINHOS_PESSOAIS_EM_PRODUTO=0` | `02-ponta-tag.txt` | `/Users/...` em arquivo de produto |
| `HISTORICO_PUBLICO_LIMPO=SIM` | `01-historico-tag.txt` | **todos os blobs de todos os commits** |

## Por que a varredura de histórico teve que existir

O scanner que já existia olha `git ls-files`, isto é, o que está versionado na
ponta. Mas um repositório público entrega o **histórico**: um segredo que entrou
num commit e saiu no seguinte continua sendo baixado por quem clona, e `git log -p`
o mostra inteiro.

`03-` e `04-` são o **controle de mutação** dessa afirmação. Num clone descartável
foi plantado um segredo em formato real (`AKIA` + 16), commitado, e depois
removido da ponta por um segundo commit:

```
03-mutacao-segredo-plantado.txt        HISTORICO_PUBLICO_LIMPO=NAO   <- pega
04-mutacao-scanner-de-ponta-nao-ve.txt PUBLIC_REPO_SECRET_LEAK=0     <- não pega
```

O scanner antigo declara o repositório limpo. O mesmo repositório entrega a
credencial a qualquer pessoa que clone. Sem esse controle, o `=0` do scanner de
ponta teria sido lido como "não há segredo no que publicamos", que é uma
afirmação mais forte do que ele sabe fazer.

## O que estas varreduras NÃO provam

Elas procuram **formatos de credencial** conhecidos e caminhos pessoais. Um
segredo que não se pareça com nenhum formato conhecido — uma senha curta em
texto, uma URL interna sem padrão — passa. O autoteste da seção 3 só prova que a
varredura não está cega, não que a lista de padrões é completa.
