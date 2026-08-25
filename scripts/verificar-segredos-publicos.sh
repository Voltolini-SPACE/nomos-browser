#!/usr/bin/env bash
# FASE 17 do release — o que vira PÚBLICO não pode carregar segredo.
#
# Varre apenas o que o GIT LEVA (`git ls-files`), que é o conjunto que importa:
# um segredo na árvore de trabalho mas fora do índice não é publicado, e um
# arquivo ignorado não vaza. Varrer o diretório inteiro produziria alarme sobre
# coisas que ninguém vai receber.
#
# Procura FORMATO de credencial, não a palavra "token": este produto fala de
# token o tempo todo, e um casador de palavra reprovaria a documentação inteira
# sem encontrar uma credencial sequer.
#
# Dois vereditos SEPARADOS, de propósito: um caminho pessoal não é uma
# credencial, e somar os dois faria o relatório dizer "vazou segredo" sobre um
# nome de pasta.
#
# Uso:  bash scripts/verificar-segredos-publicos.sh
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
ACHOU=0
echo "── 1. padroes de segredo em arquivos VERSIONADOS"
# Padroes de credencial real. Evita casar a PALAVRA 'token' (o produto fala dela
# o tempo todo) e procura FORMATOS: chaves longas, headers Bearer com valor, etc.
PADROES='(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})'
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.jpg|*.gif|*.pdf|*.woff2|*.ico) continue ;; esac
  if out=$(/usr/bin/grep -nEI "$PADROES" "$f" 2>/dev/null | head -3); then
    [ -n "$out" ] && { echo "  SUSPEITA em $f"; echo "$out" | sed 's/^/      /'; ACHOU=1; }
  fi
done < <(git ls-files)
[ "$ACHOU" -eq 0 ] && echo "  nenhum formato de credencial encontrado"

echo "── 2. token de controle do runtime nunca versionado"
if git ls-files | /usr/bin/grep -q "control-token"; then echo "  FALHA: control-token versionado"; ACHOU=1
else echo "  ok: control-token nao esta no git"; fi

echo "── 3. caminhos pessoais em arquivos de PRODUTO (nao evidencia)"
PESSOAL=$(git ls-files -- 'packages/*' 'scripts/*' 'docs/*' 'tests/*' 'demos/*' '*.md' \
  | /usr/bin/xargs /usr/bin/grep -lI "/Users/AI" 2>/dev/null | /usr/bin/grep -v "^evidence/" | head -10)
PESSOAIS=0
if [ -n "$PESSOAL" ]; then
  echo "  caminhos absolutos em:"; echo "$PESSOAL" | sed 's/^/      /'
  PESSOAIS=$(printf '%s\n' "$PESSOAL" | /usr/bin/wc -l | tr -d ' ')
else echo "  ok: nenhum /Users/AI em arquivo de produto"; fi

echo "── 4. dados de sessao/perfil de navegador versionados"
S=$(git ls-files | /usr/bin/grep -E "^(sessions|profiles|downloads)/" | head -5)
if [ -n "$S" ]; then echo "  FALHA:"; echo "$S" | sed 's/^/      /'; ACHOU=1; else echo "  ok"; fi

echo "── 5. o canario dos testes de segredo vazou para o git?"
C=$(git grep -lI "CANARIO-SEGREDO-\|CANARIO-REPLAY-" -- . 2>/dev/null | head -5)
if [ -n "$C" ]; then echo "  canarios (esperado em evidencia, nunca em produto):"; echo "$C" | sed 's/^/      /'; fi

echo
# Dois vereditos SEPARADOS. Um caminho pessoal nao e' uma credencial, e somar os
# dois faria o relatorio dizer "vazou segredo" sobre um nome de pasta.
echo "PUBLIC_REPO_SECRET_LEAK=$ACHOU"
echo "CAMINHOS_PESSOAIS_EM_PRODUTO=${PESSOAIS:-0}"

[ "$ACHOU" -eq 0 ]
