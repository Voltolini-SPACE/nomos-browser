#!/usr/bin/env bash
# FASE 21 — CLEAN ROOM DEFINITIVO, a partir do HEAD candidato.
#
# Regra: `git clone` do HEAD. NENHUM arquivo copiado do checkout original.
# Se o produto depender de algo que só existe na árvore do dono, isto reprova —
# que é exatamente o ponto.
set -uo pipefail
RAIZ_ORIG="/Users/AI/Projects/nomos-browser"
HEAD_SHA="$(git -C "$RAIZ_ORIG" rev-parse HEAD)"
CURTO="$(git -C "$RAIZ_ORIG" rev-parse --short HEAD)"
CR="/tmp/nomos-cleanroom-final-$CURTO"
OUT="$RAIZ_ORIG/evidence/nomos-browser-final-loop/21-cleanroom"
mkdir -p "$OUT"
FALHAS=0
passo() {
  local nome="$1"; shift
  printf '\n══ %-44s ' "$nome"
  if "$@" > "/tmp/cr-passo.log" 2>&1; then
    printf 'OK\n'
  else
    printf 'FALHOU\n'
    tail -15 /tmp/cr-passo.log | sed 's/^/    /'
    FALHAS=$((FALHAS+1))
  fi
}

echo "HEAD_CANDIDATO=$HEAD_SHA"
echo "CLEAN_ROOM=$CR"
echo "ZERO_MANUAL_PATCHES=YES (nenhum arquivo copiado; só git clone)"
rm -rf "$CR"

passo "1. git clone do HEAD" bash -c "git clone --depth 1 file://$RAIZ_ORIG '$CR' && git -C '$CR' rev-parse HEAD | grep -q '$HEAD_SHA'"
cd "$CR" || exit 1
echo "  commit no clone: $(git rev-parse --short HEAD)"
echo "  arquivos versionados: $(git ls-files | wc -l | tr -d ' ')"

passo "2. npm ci --include=dev" npm ci --include=dev
passo "3. workspaces ligados" bash -c "ls node_modules/@nomos | wc -l | grep -qE '[1-9]'"
passo "4. playwright install chromium" npx playwright install chromium
passo "5. typecheck (não há build)" npx tsc --noEmit -p tsconfig.json
passo "6. cobertura da matriz de CI" bash scripts/ci-cobertura.sh
passo "7. smoke: spike de controle real" bash -c "node spike/fase1_spike.ts >/dev/null"
passo "8. ci.sh fast" bash scripts/ci.sh fast
passo "9. ci.sh core" bash scripts/ci.sh core
passo "10. ci.sh security" bash scripts/ci.sh security
passo "11. ci.sh integration" bash scripts/ci.sh integration
passo "12. ci.sh adversarial" bash scripts/ci.sh adversarial
passo "13. ci.sh recovery" bash scripts/ci.sh recovery
passo "14. ci.sh e2e" bash scripts/ci.sh e2e
passo "15. ci.sh providers" bash scripts/ci.sh providers

# ── supervisor a partir do clone ──
export NOMOS_BROWSER_HOME="$CR/.runtime"
passo "16. service.sh install" bash scripts/service.sh install
passo "17. service.sh start" bash scripts/service.sh start
sleep 4
passo "18. service.sh health" bash scripts/service.sh health
passo "19. instância única (2º start recusa)" bash -c "! bash scripts/service.sh start"
passo "20. service.sh status" bash scripts/service.sh status
passo "21. service.sh stop" bash scripts/service.sh stop
passo "22. service.sh uninstall" bash scripts/service.sh uninstall
passo "23. plist removido" bash -c "! test -f \"$HOME/Library/LaunchAgents/ai.nomos.browser.plist\""

echo
echo "── resultado do clean room ──"
echo "PASSOS_FALHOS=$FALHAS"
if [ "$FALHAS" -eq 0 ]; then
  echo "CLEAN_ROOM_FROM_RELEASE_HEAD=PASS"
  echo "INSTALLATION_REPRODUCIBLE=YES"
else
  echo "CLEAN_ROOM_FROM_RELEASE_HEAD=FAIL"
  echo "INSTALLATION_REPRODUCIBLE=NO"
fi
echo "ZERO_MANUAL_PATCHES=YES"
echo "DIR=$CR"
exit "$FALHAS"
