#!/usr/bin/env bash
# FASE 14 — PROVA DO SUPERVISOR CONTRA O launchd DE VERDADE
#
# `tests/supervisor.test.ts` cobre o que dá para provar sem tocar no launchd da
# máquina (template, política de recusa, trava de instância, SIGTERM). Este
# script faz o resto: o CICLO COMPLETO, com LaunchAgent instalado de fato.
#
# Ele é separado da suíte por uma razão de segurança operacional: esta máquina
# roda quatro serviços NOMOS de PRODUÇÃO sob launchd, e um teste que instala e
# desinstala agente a cada execução é um teste que, no dia em que falhar no
# meio, deixa estado carregado na máquina do dono.
#
# GUARDA DE PRODUÇÃO: a assinatura (label→pid) dos quatro serviços é tirada no
# começo e conferida no fim. Assinatura diferente = algum deles morreu, e o
# script REPROVA — mesmo que tudo o mais tenha passado.
#
# AO FINAL O SERVIÇO FICA DESINSTALADO. Ver a última linha do relatório.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
SERVICE="$RAIZ/scripts/service.sh"
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"
LABEL="ai.nomos.browser"
PORT="${NOMOS_BROWSER_PORT:-7788}"
RUNTIME_DIR="${NOMOS_RUNTIME_DIR:-$HOME/.nomos-browser}"
LOG_DIR="$HOME/Library/Logs/nomos-browser"
LOCK="$RUNTIME_DIR/daemon.lock"
export NOMOS_BROWSER_PORT="$PORT"

FALHAS=0
declare -a LINHAS
passo() {
  local nome="$1" esperado="$2" ok="$3" obs="$4"
  if [ "$ok" = "1" ]; then printf 'OK      %-46s %s\n' "$nome" "$obs"
  else printf 'FALHOU  %-46s %s\n' "$nome" "$obs"; FALHAS=$((FALHAS+1)); fi
  LINHAS+=("$(printf '{"passo":"%s","esperado":"%s","ok":%s,"observado":"%s"}' "$nome" "$esperado" "$([ "$ok" = 1 ] && echo true || echo false)" "$obs")")
}

producao_assinatura() {
  local s=""
  # awk NÃO entende `\s` (isso é PCRE). A primeira versão usava `/^\s*pid = /`,
  # o padrão nunca casava, e a assinatura saía vazia para os quatro serviços —
  # "antes" e "depois" ficavam iguais por VACUIDADE. Uma guarda que não lê nada
  # aprova qualquer coisa, inclusive um serviço de produção derrubado.
  for L in br.com.se7enpay.nomos.servico com.nomos.panel ai.sovereign.omniroute com.gijarvis.backend; do
    s="$s$L=$(/bin/launchctl print "gui/$(id -u)/$L" 2>/dev/null | /usr/bin/awk '/pid = /{print $3; exit}');"
  done
  printf '%s' "$s"
}
pid_lock() { [ -f "$LOCK" ] && /usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$LOCK" 2>/dev/null; }
carregada() { /bin/launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }
esperar_saudavel() {
  local prazo=$((SECONDS + ${1:-60}))
  while [ "$SECONDS" -lt "$prazo" ]; do
    bash "$SERVICE" health >/dev/null 2>&1 && return 0
    /bin/sleep 1
  done
  return 1
}
esperar_pid_novo() {
  local antigo="$1" prazo=$((SECONDS + ${2:-90})) atual
  while [ "$SECONDS" -lt "$prazo" ]; do
    atual="$(pid_lock)"
    if [ -n "$atual" ] && [ "$atual" != "$antigo" ] && /bin/kill -0 "$atual" 2>/dev/null; then printf '%s' "$atual"; return 0; fi
    /bin/sleep 1
  done
  return 1
}

echo "── FASE 14 · prova do supervisor ────────────────────────────────"
PROD_ANTES="$(producao_assinatura)"
echo "producao antes: $PROD_ANTES"
ESTADO_ANTES_CARREGADA=$(carregada && echo SIM || echo NAO)
echo "label $LABEL carregada antes: $ESTADO_ANTES_CARREGADA"
if [ "$ESTADO_ANTES_CARREGADA" = "SIM" ]; then
  echo "ABORTADO: a label já está carregada antes de começarmos. Não mexo no que não instalei."
  exit 4
fi

# ── 1. install ───────────────────────────────────────────────────────────────
saida="$(bash "$SERVICE" install 2>&1)"; rc=$?
carregada && c=1 || c=0
passo "install carrega o LaunchAgent" "carregada" "$([ $rc -eq 0 ] && [ $c -eq 1 ] && echo 1 || echo 0)" "rc=$rc $(printf '%s' "$saida" | /usr/bin/tail -1)"

# ── 2. start + health ────────────────────────────────────────────────────────
bash "$SERVICE" start >/dev/null 2>&1
if esperar_saudavel 90; then h=1; else h=0; fi
PID1="$(pid_lock)"
passo "start sobe e GET /health responde ok" "HEALTH=OK" "$h" "pid=$PID1"

# ── 3. duplo start: UMA instância só ────────────────────────────────────────
saida="$(bash "$SERVICE" start 2>&1)"; rc=$?
PID_DEPOIS="$(pid_lock)"
mesmo=$([ "$PID1" = "$PID_DEPOIS" ] && echo 1 || echo 0)
passo "segundo start é RECUSADO (instância única)" "rc=9 e mesmo pid" \
  "$([ $rc -eq 9 ] && [ $mesmo -eq 1 ] && echo 1 || echo 0)" "rc=$rc pid_antes=$PID1 pid_depois=$PID_DEPOIS"

# ── 4. SIGTERM: encerramento gracioso, sem resíduo ──────────────────────────
# `kill -TERM` direto no pid, para exercitar o HANDLER do daemon (o `stop` usa
# bootout, que também manda SIGTERM — mas aqui queremos o handler isolado).
/bin/kill -TERM "$PID1" 2>/dev/null
i=0; while [ $i -lt 30 ] && /bin/kill -0 "$PID1" 2>/dev/null; do /bin/sleep 1; i=$((i+1)); done
morreu=$(/bin/kill -0 "$PID1" 2>/dev/null && echo 0 || echo 1)
passo "SIGTERM encerra sem processo residual" "pid morto" "$morreu" "esperou ${i}s"

# ── 5. o launchd RESSOBE (KeepAlive SuccessfulExit=false) ───────────────────
# SIGTERM sem handler seria saída != 0; com handler o daemon sai 0 e o launchd
# NÃO ressobe — é o comportamento pedido: saída limpa é o dono mandando parar.
# Para provar o reinício por CRASH, o próximo passo usa SIGKILL.
/bin/sleep 2
PID_APOS_TERM="$(pid_lock)"
passo "saída LIMPA não é ressuscitada pelo KeepAlive" "sem pid novo" \
  "$([ -z "$PID_APOS_TERM" ] || ! /bin/kill -0 "$PID_APOS_TERM" 2>/dev/null && echo 1 || echo 0)" "pid=${PID_APOS_TERM:-nenhum}"

# ── 6. SIGKILL: crash de verdade, launchd reinicia, PID NOVO ────────────────
bash "$SERVICE" start >/dev/null 2>&1
esperar_saudavel 90 || true
PID2="$(pid_lock)"
/bin/kill -9 "$PID2" 2>/dev/null
if PID3="$(esperar_pid_novo "$PID2" 120)"; then novo=1; else novo=0; PID3="nenhum"; fi
passo "SIGKILL: launchd reinicia com PID NOVO" "pid diferente" "$novo" "antes=$PID2 depois=$PID3"

# ── 7. kickstart -k: simulação de reboot (limitação declarada) ──────────────
# Reboot real não é executável aqui: esta máquina roda produção. `kickstart -k`
# mata e ressobe PELO launchd, que é o mesmo caminho do arranque no login.
if [ "$novo" = "1" ]; then
  /bin/launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  if PID4="$(esperar_pid_novo "$PID3" 120)"; then k=1; else k=0; PID4="nenhum"; fi
  esperar_saudavel 90 && hk=1 || hk=0
  passo "kickstart -k ressobe e volta saudável (proxy de reboot)" "pid novo + health ok" \
    "$([ $k -eq 1 ] && [ $hk -eq 1 ] && echo 1 || echo 0)" "antes=$PID3 depois=$PID4"
else
  passo "kickstart -k ressobe e volta saudável (proxy de reboot)" "pid novo + health ok" 0 "pulado: passo anterior falhou"
fi

# ── 8. stop ─────────────────────────────────────────────────────────────────
saida="$(bash "$SERVICE" stop 2>&1)"; rc=$?
PID_FIM="$(pid_lock)"
parado=$([ -z "$PID_FIM" ] || ! /bin/kill -0 "$PID_FIM" 2>/dev/null && echo 1 || echo 0)
passo "stop encerra o serviço" "STOP=OK" "$([ $rc -eq 0 ] && [ $parado -eq 1 ] && echo 1 || echo 0)" "rc=$rc $(printf '%s' "$saida" | /usr/bin/tail -1)"

# ── 9. CRASH-LOOP: binário que falha sempre, launchd freia ──────────────────
# Config inválida de propósito (`NOMOS_BROWSER_PORT=abc`): o daemon recusa
# arrancar e sai != 0. Com `KeepAlive SuccessfulExit=false`, o launchd ressobe —
# e o `ThrottleInterval` de 10 s é o que impede isso de virar laço quente.
: > "$LOG_DIR/stderr.log" 2>/dev/null || true
NOMOS_BROWSER_PORT=abc bash "$SERVICE" install >/dev/null 2>&1
INICIO=$SECONDS
/bin/sleep 32
# UMA linha por arranque falho. `grep -c NOMOS_BROWSER_PORT` contava 2 por
# tentativa (a linha do `throw` e a da mensagem) e inflava o número em 2x — foi
# assim que 4 tentativas legítimas viraram "8" e reprovaram o freio que estava
# funcionando. O marcador abaixo é o início da mensagem, que sai uma vez só.
TENTATIVAS=$(/usr/bin/grep -c '^ConfigError: port' "$LOG_DIR/stderr.log" 2>/dev/null || echo 0)
JANELA=$((SECONDS - INICIO))
# Teto teórico: janela/ThrottleInterval + 1. Sem freio seriam centenas.
TETO=$(( JANELA / 10 + 2 ))
passo "crash-loop freado pelo ThrottleInterval" "<= $TETO tentativas em ${JANELA}s" \
  "$([ "$TENTATIVAS" -le "$TETO" ] && [ "$TENTATIVAS" -ge 1 ] && echo 1 || echo 0)" "tentativas=$TENTATIVAS janela=${JANELA}s teto=$TETO"

# ── 10. uninstall: a máquina volta ao estado anterior ──────────────────────
export NOMOS_BROWSER_PORT="$PORT"
saida="$(bash "$SERVICE" uninstall 2>&1)"; rc=$?
carregada && ainda=1 || ainda=0
plist_existe=$([ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ] && echo 1 || echo 0)
passo "uninstall descarrega e remove o plist" "nada carregado, plist ausente" \
  "$([ $rc -eq 0 ] && [ $ainda -eq 0 ] && [ $plist_existe -eq 0 ] && echo 1 || echo 0)" \
  "rc=$rc carregada=$ainda plist=$plist_existe"

# ── 11. guarda de produção ─────────────────────────────────────────────────
PROD_DEPOIS="$(producao_assinatura)"
vazia=$(printf '%s' "$PROD_ANTES" | /usr/bin/grep -qE '=[0-9]+;' && echo 0 || echo 1)
if [ "$vazia" = "1" ]; then
  passo "guarda de produção leu os PIDs" "pids não vazios" 0 "assinatura vazia: a guarda não está medindo nada"
fi
passo "serviços de PRODUÇÃO intactos (mesmos PIDs)" "assinatura igual" \
  "$([ "$PROD_ANTES" = "$PROD_DEPOIS" ] && [ "$vazia" = "0" ] && echo 1 || echo 0)" "antes=$PROD_ANTES depois=$PROD_DEPOIS"

# ── relatório ──────────────────────────────────────────────────────────────
{ printf '{"gerado_em":"%s","passos":[' "$(date -u +%FT%TZ)"
  for i in "${!LINHAS[@]}"; do [ "$i" -gt 0 ] && printf ','; printf '%s' "${LINHAS[$i]}"; done
  printf ']}\n'; } > "$OUT/supervisor.json"

echo
echo "SUPERVISION=$([ $FALHAS -eq 0 ] && echo PASS || echo FAIL)"
echo "SINGLE_OWNER=$([ $FALHAS -eq 0 ] && echo PASS || echo FAIL)"
echo "RESTART_POLICY=$([ $FALHAS -eq 0 ] && echo PASS || echo FAIL)"
echo "GRACEFUL_SHUTDOWN=$([ $FALHAS -eq 0 ] && echo PASS || echo FAIL)"
echo "REBOOT_SAFETY=SIMULADO (launchctl kickstart -k; reboot real NAO executado — esta maquina roda producao)"
echo "PASSOS_FALHOS=$FALHAS"
echo "ESTADO_DO_SERVICO=DESINSTALADO"
exit $([ $FALHAS -eq 0 ] && echo 0 || echo 1)
