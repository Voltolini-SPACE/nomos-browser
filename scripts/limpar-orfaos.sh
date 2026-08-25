#!/usr/bin/env bash
# Mata daemons órfãos DOS TESTES — por PROVA DE POSSE, nunca por porta.
#
# Por que isto existe: durante a validação do Live Agent, uma limpeza "por
# porta" matou o `claudio-input-engine` do dono, que por acaso ocupava uma porta
# que um instrumento meu havia usado minutos antes. O `ps` chegou a imprimir a
# linha de comando do processo ANTES do kill; a prova passou na frente e o
# comando seguiu assim mesmo.
#
# A lição não é "checar melhor a lista de portas". É que PORTA NÃO PROVA POSSE.
# Porta é endereço, e o sistema operacional reatribui endereço livre a quem
# pedir. Só a identidade do processo prova de quem ele é.
#
# Regra aqui: um processo só morre se passar nos DOIS testes —
#   1. a linha de comando é `packages/api/src/daemon.ts`;
#   2. o ambiente aponta para um runtime dir `/tmp/la-*` (criado pelos E2E).
# Qualquer outro é LISTADO e PRESERVADO, com o motivo dito em voz alta.
#
# Uso:  scripts/limpar-orfaos.sh [--dry-run]
set -uo pipefail

SECO=0
[ "${1:-}" = "--dry-run" ] && SECO=1

MORTOS=0
POUPADOS=0

echo "── candidatos: processos de daemon do runtime"
for pid in $(pgrep -f "packages/api/src/daemon.ts" 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -z "$cmd" ] && continue

  # A prova de posse: o runtime dir do processo. `ps -E` (macOS) mostra o
  # ambiente; sem ele, o processo é POUPADO — falta de prova nunca autoriza.
  amb="$(ps -E -o command= -p "$pid" 2>/dev/null || true)"
  if printf '%s' "$amb" | /usr/bin/grep -q "NOMOS_RUNTIME_DIR=/tmp/la-"; then
    if [ "$SECO" -eq 1 ]; then
      echo "  [mataria] pid=${pid} — runtime dir de teste (/tmp/la-*)"
    else
      kill -9 "$pid" 2>/dev/null && echo "  [morto]  pid=${pid} — runtime dir de teste (/tmp/la-*)"
    fi
    MORTOS=$((MORTOS + 1))
  else
    echo "  [POUPADO] pid=${pid} — nao prova ser de teste; nao se mata sem prova"
    POUPADOS=$((POUPADOS + 1))
  fi
done

# Controle negativo: mostra quem ocupa as portas dos testes SEM tocar em nada.
# Se aparecer um processo alheio aqui, ele continua vivo — e isso e o ponto.
echo "── portas de teste (apenas RELATADAS, jamais limpas por porta)"
for porta in 7793 7794 7795 7796 7797 7798 7799 8901 8910 8947 8952 8963 8971 8972 8981; do
  for pid in $(lsof -ti tcp:"${porta}" 2>/dev/null || true); do
    dono="$(ps -o command= -p "${pid}" 2>/dev/null | cut -c1-70)"
    echo "  porta ${porta}: pid=${pid} ${dono}"
  done
done

echo
echo "ORFAOS_MORTOS=${MORTOS}"
echo "PRESERVADOS_POR_FALTA_DE_PROVA=${POUPADOS}"
