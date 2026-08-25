#!/usr/bin/env bash
# FASE 17 — INSTALAÇÃO DO ZERO (clean room).
#
# A pergunta que este script responde é uma só: "alguém que recebe este
# repositório e nunca rodou nada aqui consegue instalar e rodar?" Ela não se
# responde no diretório de trabalho — lá existem `node_modules` de meses atrás,
# caches, e arquivos que nunca entraram no git. Por isso: cópia limpa, em
# diretório temporário, `npm ci` do zero.
#
# O QUE É COPIADO, e por que não é `git clone`:
#
#   `git clone` levaria o HEAD, e o HEAD não contém a fase em curso (a missão
#   proíbe commitar). Provar a instalação do HEAD provaria o produto ANTERIOR —
#   exatamente o contrário do que se quer saber sobre manifestos novos.
#
#   Então a cópia é EXATAMENTE o que um commit levaria: `git ls-files`
#   (versionado) + `git ls-files --others --exclude-standard` (novo e não
#   ignorado). `node_modules`, `dist/` e o resto do lixo ficam de fora por serem
#   ignorados — que é a mesma regra que o git usaria.
#
# Uso: bash scripts/clean-room.sh [destino]
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

DESTINO="${1:-$(/usr/bin/mktemp -d /tmp/nomos-cleanroom.XXXXXX)}"
echo "== clean room em $DESTINO"
/bin/mkdir -p "$DESTINO"

# NUL em todo o caminho: nome de arquivo com espaço não pode quebrar a prova.
# `tar` e não `cpio`: o cpio do macOS é BSD e não conhece `-0`, então a lista
# separada por NUL chegava como UM nome gigante e a cópia saía vazia — falha
# silenciosa que o contador de arquivos abaixo pegou.
{ git ls-files -z; git ls-files -z --others --exclude-standard; } \
  | /usr/bin/tar -cf - --null -T - \
  | ( cd "$DESTINO" && /usr/bin/tar -xf - ) \
  || { echo "COPIA=FALHOU"; exit 1; }

ARQUIVOS=$(/usr/bin/find "$DESTINO" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')
echo "== arquivos copiados: $ARQUIVOS"
if [ -e "$DESTINO/node_modules" ]; then echo "CONTAMINACAO: node_modules veio junto"; exit 1; fi

cd "$DESTINO" || exit 1
echo
echo "== npm ci --include=dev"
if ! npm ci --include=dev 2>&1 | /usr/bin/tail -20; then
  echo "INSTALL_FROM_SCRATCH=FAIL (npm ci)"
  exit 1
fi

# Os workspaces têm de ter sido ligados. Um manifesto novo que o npm não
# reconhece não dá erro — ele simplesmente não vira symlink em node_modules, e
# o defeito só aparece no dia do empacotamento.
echo
echo "== workspaces ligados em node_modules/@nomos"
/bin/ls -1 node_modules/@nomos 2>/dev/null || { echo "INSTALL_FROM_SCRATCH=FAIL (nenhum workspace ligado)"; exit 1; }
LIGADOS=$(/bin/ls -1 node_modules/@nomos 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')
PACOTES=$(/bin/ls -1d packages/*/ | /usr/bin/wc -l | /usr/bin/tr -d ' ')
if [ "$LIGADOS" != "$PACOTES" ]; then
  echo "INSTALL_FROM_SCRATCH=FAIL ($LIGADOS de $PACOTES pacotes ligados)"
  exit 1
fi

echo
echo "== scripts/ci.sh cleanroom (hermético)"
bash scripts/ci.sh cleanroom
RC_CLEAN=$?

echo
echo "== scripts/ci.sh fast"
bash scripts/ci.sh fast
RC_FAST=$?

echo
if [ "$RC_CLEAN" -eq 0 ] && [ "$RC_FAST" -eq 0 ]; then
  echo "INSTALL_FROM_SCRATCH=PASS  (dir=$DESTINO arquivos=$ARQUIVOS workspaces=$LIGADOS)"
  exit 0
fi
echo "INSTALL_FROM_SCRATCH=FAIL  (cleanroom=$RC_CLEAN fast=$RC_FAST)"
exit 1
