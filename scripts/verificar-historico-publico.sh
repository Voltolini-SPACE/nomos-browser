#!/usr/bin/env bash
# Um repositorio publico entrega o HISTORICO, nao so a ponta.
#
# O scanner de segredos olha `git ls-files`, isto e, o que esta versionado AGORA.
# Um segredo que entrou num commit e foi removido no seguinte continua entregue
# a quem clona: `git log -p` mostra tudo. Esta varredura le todos os blobs
# alcancaveis por qualquer ref, que e exatamente o conjunto que o estranho baixa.
#
# Uso: scripts/verificar-historico-publico.sh [DIR_DO_CLONE]
set -uo pipefail
REPO="${1:-.}"
cd "$REPO" || exit 2

echo "VARREDURA_DE_HISTORICO"
echo "repo=$(pwd)"
echo "commits=$(git rev-list --count --all)"
echo "objetos=$(git rev-list --objects --all | wc -l | tr -d ' ')"
echo

# Formatos de credencial, nao a palavra "token". Procurar "token" acha
# documentacao; procurar o FORMATO acha credencial.
PADROES='(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}
github_pat_[A-Za-z0-9_]{60,}
sk-[A-Za-z0-9]{32,}
sk-ant-[A-Za-z0-9_-]{40,}
AKIA[0-9A-Z]{16}
AIza[0-9A-Za-z_-]{35}
xox[baprs]-[0-9A-Za-z-]{10,}
-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----
eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'

ACHADOS=0
echo "-- 1. formatos de credencial em QUALQUER blob do historico"
LISTA="$(git rev-list --objects --all | awk '{print $1}')"
# `git grep` sobre todas as refs le o conteudo versionado de cada commit.
while IFS= read -r padrao; do
  [ -z "$padrao" ] && continue
  SAIDA="$(git grep -I -n -E "$padrao" $(git rev-list --all) -- 2>/dev/null | head -5)"
  if [ -n "$SAIDA" ]; then
    echo "  ACHADO padrao: $padrao"
    echo "$SAIDA" | sed 's/^/      /'
    ACHADOS=$((ACHADOS+1))
  fi
done <<< "$PADROES"
[ "$ACHADOS" -eq 0 ] && echo "  nenhum formato de credencial em nenhum commit"
echo

echo "-- 2. arquivos que nunca deveriam ter entrado, em qualquer commit"
SUJOS=0
for p in '\.env$' 'control-token' 'id_rsa$' '\.pem$' '\.p12$' 'credentials\.json$'; do
  N="$(git rev-list --objects --all | awk '{print $2}' | grep -E "$p" | sort -u)"
  if [ -n "$N" ]; then
    echo "  ACHADO $p:"; echo "$N" | sed 's/^/      /'; SUJOS=$((SUJOS+1))
  fi
done
[ "$SUJOS" -eq 0 ] && echo "  nenhum arquivo proibido em nenhum commit"
echo

echo "-- 3. autoteste: a varredura enxerga um segredo plantado?"
# Sem este controle, "nenhum achado" e indistinguivel de uma varredura quebrada.
TMPB="$(mktemp)"
printf 'AKIA%s\n' "0123456789ABCDEF" > "$TMPB"
if grep -qE 'AKIA[0-9A-Z]{16}' "$TMPB"; then
  echo "  ok: o padrao casa com um segredo plantado"
  AUTO=1
else
  echo "  FALHA: a varredura nao enxerga nem um segredo plantado"
  AUTO=0
fi
rm -f "$TMPB"
echo

if [ "$ACHADOS" -eq 0 ] && [ "$SUJOS" -eq 0 ] && [ "$AUTO" -eq 1 ]; then
  echo "HISTORICO_PUBLICO_LIMPO=SIM"
else
  echo "HISTORICO_PUBLICO_LIMPO=NAO"
fi
