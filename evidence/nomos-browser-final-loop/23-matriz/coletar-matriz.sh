#!/usr/bin/env bash
# FASE 23 — coleta a matriz final a partir dos ARQUIVOS DE EVIDÊNCIA, não da memória.
# Cada linha aponta para o arquivo de onde o veredito foi lido.
set -uo pipefail
R="$(cd "$(dirname "$0")/../../.." && pwd)"
E="$R/evidence"
ler() { # ler <rotulo> <padrao> <arquivo...>
  local rotulo="$1"; local padrao="$2"; shift 2
  local achado=""
  for f in "$@"; do
    [ -f "$f" ] || continue
    achado="$(/usr/bin/grep -hoE "$padrao" "$f" 2>/dev/null | tail -1)"
    [ -n "$achado" ] && { printf '%-34s %-46s %s\n' "$rotulo" "$achado" "${f#$R/}"; return; }
  done
  printf '%-34s %-46s %s\n' "$rotulo" "NAO_ENCONTRADO" "(procurei em $#)"
}
L="$E/nomos-browser-final-loop"
V="$E/nomos-browser-final-validation"
echo "MATRIZ FINAL — coletada de arquivos de evidência em $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "HEAD=$(git -C "$R" rev-parse HEAD)"
echo
printf '%-34s %-46s %s\n' "ITEM" "VEREDITO" "EVIDENCIA"
printf '%-34s %-46s %s\n' "----" "--------" "---------"
ler "BROWSER_CORE_REGRESSION"  "TS_PASS=[0-9]+|TS_FAIL=[0-9]+"        "$L/22-regressao-total/regressao-total.log"
ler "VISION_ENGINE_CAPABILITY" "VISION_ENGINE_CAPABILITY=[A-Z]+"      "$L/22-regressao-total/regressao-total.log"
ler "VISION_FALLBACK_E2E"      "E2E_VISAO=[A-Z]+"                     "$L/22-regressao-total/regressao-total.log" "$L/06-cascata/out/e2e-visao.log"
ler "INJECTION_PROTECTION"     "INJECTION_PROTECTION_WIRED=[A-Z]+"    "$L/22-regressao-total/regressao-total.log" "$L/02-injection/out/verificacao.json"
ler "SECURITY_SUITE"           "SECURITY_SUITE=[A-Z]+"                "$L/22-regressao-total/regressao-total.log"
ler "OPEN_SECURITY_P1"         "OPEN_SECURITY_P1=[0-9]+"              "$L/22-regressao-total/regressao-total.log"
ler "SECURITY_LIVE_GUARDS"     "SECURITY_LIVE_GUARDS=[A-Z]+"          "$L/22-regressao-total/regressao-total.log"
ler "AUDIT_COMPLETE"           "AUDIT_COMPLETE=[A-Z]+"                "$L/22-regressao-total/regressao-total.log"
ler "TASK_ENGINE"              "TASK_ENGINE=[A-Z]+"                   "$L/22-regressao-total/regressao-total.log"
ler "NOMOS_TRANSPORT_E2E"      "NOMOS_TRANSPORT_E2E=[A-Z_]+"          "$L/22-regressao-total/regressao-total.log" "$L/07-nomos/cliente-fiel-saida.txt"
ler "BROWSER_E2E_SUITE"        "BROWSER_E2E_SUITE=[A-Z]+"             "$L/19-e2e/out/e2e-final.log"
ler "E2E_TOTAL"                "E2E_TOTAL=[0-9]+"                     "$L/19-e2e/out/e2e-final.log"
ler "E2E_FAIL"                 "E2E_FAIL=[0-9]+"                      "$L/19-e2e/out/e2e-final.log"
ler "SOAK_100_CYCLES"          "SOAK_100_CYCLES=[A-Z]+"               "$L/20-soak/out/soak-pesado.log"
ler "CONCURRENCY_10_SESSIONS"  "CONCURRENCY_10_SESSIONS=[A-Z]+"       "$L/20-soak/out/soak-pesado.log"
ler "MEMORY_STABLE"            "MEMORY_STABLE=[A-Z]+"                 "$L/20-soak/out/soak-pesado.log"
ler "PROCESS_RESIDUAL"         "PROCESS_RESIDUAL=[0-9]+"              "$L/20-soak/out/soak-pesado.log"
ler "CLEAN_ROOM"               "CLEAN_ROOM_FROM_RELEASE_HEAD=[A-Z]+"  "$L/21-cleanroom/clean-room.log"
ler "INSTALLATION_REPRODUCIBLE" "INSTALLATION_REPRODUCIBLE=[A-Z]+"    "$L/21-cleanroom/clean-room.log"
ler "TEST_TIMEOUT_GROUP_KILL"  "TEST_TIMEOUT_GROUP_KILL=[A-Z]+"       "$L/22-regressao-total/regressao-total.log" "$L/15-orfaos/prova.log"
ler "CI_LOCAL"                 "CI_PASS=[A-Z]+"                       "$L/22-regressao-total/regressao-total.log"
echo
echo "REGISTRO NO CATALOGO DO NOMOS (ato do dono):"
/Users/AI/.local/bin/nomos mcp catalogo 2>/dev/null | /usr/bin/grep -q "nomos-browser" \
  && echo "  NOMOS_BROWSER_REGISTRADO=SIM" \
  || echo "  NOMOS_BROWSER_REGISTRADO=NAO — pendente de 'nomos mcp confiar'"
