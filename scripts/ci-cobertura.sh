#!/usr/bin/env bash
# FASE 16 — COBERTURA DA MATRIZ DE CI.
#
# O defeito que este script existe para impedir já aconteceu: `tests/vision.test.ts`
# e `tests/aiprovider.test.ts` (2.034 linhas) não estavam em NENHUM estágio, e
# `ci.sh all` passava verde sem jamais executá-los. Ninguém mentiu — a matriz era
# uma lista escrita à mão e nada a comparava com o diretório de testes.
#
# A comparação é entre dois FATOS, nenhum dos dois redigitado aqui:
#
#   A. `ls tests/*.test.ts`                  — o que existe no disco.
#   B. `scripts/ci.sh --listar-estagios`     — o que a matriz declara.
#
# Falha em três casos, e os três são defeitos diferentes:
#
#   1. arquivo de teste FORA de todo estágio      → teste que nunca roda
#   2. estágio cita arquivo que NÃO EXISTE        → matriz apontando para o vazio
#   3. `all` não cobre um estágio (menos cleanroom) → estágio órfão
#
# Saída em chave=valor no fim, para os gates da missão.
#
# Uso: bash scripts/ci-cobertura.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

MATRIZ="$(bash scripts/ci.sh --listar-estagios)" || { echo "ci.sh --listar-estagios falhou"; exit 2; }
if [ -z "$MATRIZ" ]; then echo "matriz vazia — ci.sh nao publicou estagio nenhum"; exit 2; fi

# B: nomes declarados, sem repetição.
DECLARADOS="$(printf '%s\n' "$MATRIZ" | /usr/bin/awk -F'\t' '{print $2}' | /usr/bin/sort -u)"
# A: nomes no disco.
NO_DISCO="$(/bin/ls tests/*.test.ts 2>/dev/null | /usr/bin/sed 's|^tests/||; s|\.test\.ts$||' | /usr/bin/sort -u)"

if [ -z "$NO_DISCO" ]; then echo "nenhum tests/*.test.ts encontrado — instrumento no lugar errado?"; exit 2; fi

FORA="$(/usr/bin/comm -23 <(printf '%s\n' "$NO_DISCO") <(printf '%s\n' "$DECLARADOS"))"
FANTASMA="$(/usr/bin/comm -13 <(printf '%s\n' "$NO_DISCO") <(printf '%s\n' "$DECLARADOS"))"

TOTAL=$(printf '%s\n' "$NO_DISCO" | /usr/bin/grep -c .)
FALHAS=0

echo "── cobertura da matriz de CI ─────────────────────────────"
printf '%s\n' "$MATRIZ" | /usr/bin/awk -F'\t' '{c[$1]++} END {for (e in c) printf "  %-14s %2d arquivo(s)\n", e, c[e]}' | /usr/bin/sort
echo "  arquivos em tests/: $TOTAL   declarados na matriz: $(printf '%s\n' "$DECLARADOS" | /usr/bin/grep -c .)"

if printf '%s\n' "$FORA" | /usr/bin/grep -q .; then
  echo
  echo "FALHA 1 — arquivo de teste FORA de todo estagio (nunca roda em ci.sh all):"
  printf '%s\n' "$FORA" | /usr/bin/sed 's|^|    tests/|; s|$|.test.ts|'
  FALHAS=$((FALHAS + 1))
fi

if printf '%s\n' "$FANTASMA" | /usr/bin/grep -q .; then
  echo
  echo "FALHA 2 — estagio cita arquivo que NAO EXISTE:"
  printf '%s\n' "$FANTASMA" | /usr/bin/sed 's|^|    tests/|; s|$|.test.ts|'
  FALHAS=$((FALHAS + 1))
fi

# 3. Todo estágio publicado (menos `cleanroom`) tem de ser alcançado por `all`.
#    Um estágio que existe e ninguém chama é cobertura no papel.
ESTAGIOS_PUB="$(printf '%s\n' "$MATRIZ" | /usr/bin/awk -F'\t' '{print $1}' | /usr/bin/sort -u | /usr/bin/grep -v '^cleanroom$')"
ALL_DECL="$(/usr/bin/grep -E '^ESTAGIOS_ALL=' scripts/ci.sh | /usr/bin/sed 's/^ESTAGIOS_ALL="//; s/"$//' | tr ' ' '\n' | /usr/bin/sort -u)"
ORFAOS="$(/usr/bin/comm -23 <(printf '%s\n' "$ESTAGIOS_PUB") <(printf '%s\n' "$ALL_DECL"))"
if printf '%s\n' "$ORFAOS" | /usr/bin/grep -q .; then
  echo
  echo "FALHA 3 — estagio publicado que 'all' nao roda:"
  printf '%s\n' "$ORFAOS" | /usr/bin/sed 's|^|    |'
  FALHAS=$((FALHAS + 1))
fi

# 4. O workflow tem de ESPELHAR a matriz. Um estágio que existe em `ci.sh` e
#    não tem job no YAML é cobertura que só vale na máquina do dono.
WF=".github/workflows/ci.yml"
if [ -f "$WF" ]; then
  SEM_JOB=""
  for e in $ALL_DECL; do
    /usr/bin/grep -qE "^\s+- run: \./scripts/ci\.sh $e\s*$" "$WF" || SEM_JOB="$SEM_JOB $e"
  done
  if [ -n "$SEM_JOB" ]; then
    echo
    echo "FALHA 4 — estagio sem job em $WF:$SEM_JOB"
    FALHAS=$((FALHAS + 1))
  fi
else
  echo "AVISO: $WF nao existe — espelhamento do workflow nao verificado"
fi

# Gates nomeados na missão. Verificados por PERTENCIMENTO à matriz, não por grep
# de texto: um `grep vision scripts/ci.sh` casaria com um comentário.
em_matriz() { printf '%s\n' "$DECLARADOS" | /usr/bin/grep -qx "$1"; }
echo
em_matriz vision      && echo "VISION_IN_CI=YES"      || { echo "VISION_IN_CI=NO";      FALHAS=$((FALHAS + 1)); }
em_matriz aiprovider  && echo "AIPROVIDER_IN_CI=YES"  || { echo "AIPROVIDER_IN_CI=NO";  FALHAS=$((FALHAS + 1)); }
if [ "$FALHAS" -eq 0 ]; then
  echo "ALL_TEST_FILES_IN_CI=YES"
  echo "CI_COBERTURA=PASS"
  exit 0
fi
echo "ALL_TEST_FILES_IN_CI=NO"
echo "CI_COBERTURA=FAIL ($FALHAS problema(s))"
exit 1
