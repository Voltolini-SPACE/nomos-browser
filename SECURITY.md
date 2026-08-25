# Política de segurança

## Modelo de ameaça

O modelo completo, com **resíduos declarados**, está em
[`docs/SECURITY.md`](docs/SECURITY.md). A visão de produto está em
[`docs/security-overview.md`](docs/security-overview.md).

Este projeto não afirma "100% seguro", "infalível" ou "zero risco". Nenhuma
medida sustenta isso.

## O que já é conhecido e declarado

Estes pontos **não** precisam ser reportados: já estão documentados.

- O selo de replay é **hash sem chave**. Fecha corrupção, adulteração
  oportunista e truncamento; não fecha adversário com acesso de escrita ao
  diretório de sessões.
- **Não há rota HTTP para emitir token com escopo.** Tokens escopados existem na
  API interna.
- No handshake do WebSocket, o token viaja na **query string**, porque o
  navegador não permite header nesse ponto. Aceitável em loopback com token
  efêmero, e declarado no modelo de ameaça.
- O produto foi validado em **macOS/Apple Silicon**. Outras plataformas não foram
  medidas.

## Reportar uma vulnerabilidade

Este software é **proprietário e não publicado**: o [`LICENSE`](LICENSE) não
concede permissão de uso a terceiros. Não há, no momento, programa público de
divulgação.

Se você encontrou uma falha, escreva para o endereço do titular declarado no
`LICENSE`. Peço que não abra issue pública com detalhe explorável antes de haver
uma correção.

## O que ajuda num relato

- versão (`node packages/cli/src/main.ts --version`) e sistema;
- o que você esperava e o que aconteceu;
- passos para reproduzir, de preferência contra uma página local;
- se possível, o `action_id` da trilha de auditoria.

**Nunca inclua no relato:** token de controle, conteúdo de
`~/.nomos-browser/control-token`, cookies de sessão real ou dados de terceiros. O
produto mascara segredo nas próprias superfícies; um relato não deve desfazer
isso.
