#!/usr/bin/env bash
# FASE 6 — CLEAN ROOM FINAL, a partir de `git clone` do HEAD candidato.
#
# Inclui o procedimento de integração MCP no roteiro — mas NÃO falsifica
# consentimento: os passos que exigem a assinatura do dono são IMPRIMIDOS e
# VERIFICADOS, nunca executados em nome dele. `stdin` vem de /dev/null em todo
# comando do NOMOS, para que nenhum prompt possa ser respondido por acidente.
set -uo pipefail
ORIG="/Users/AI/Projects/nomos-browser"
SHA="$(git -C "$ORIG" rev-parse HEAD)"; CURTO="$(git -C "$ORIG" rev-parse --short HEAD)"
CR="/tmp/nomos-cr-closeout-$CURTO"
NOMOS_BIN="/Users/AI/.local/bin/nomos"
FALHAS=0
passo() {
  local nome="$1"; shift
  printf '\n══ %-46s ' "$nome"
  if "$@" > /tmp/cr2.log 2>&1; then printf 'OK\n'; else printf 'FALHOU\n'; tail -12 /tmp/cr2.log | sed 's/^/    /'; FALHAS=$((FALHAS+1)); fi
}
echo "HEAD=$SHA"; echo "CLEAN_ROOM=$CR"; echo "ZERO_MANUAL_PATCHES=YES (só git clone)"
rm -rf "$CR"
passo "1. git clone do HEAD" bash -c "git clone --depth 1 file://$ORIG '$CR' >/dev/null 2>&1 && git -C '$CR' rev-parse HEAD | grep -q '$SHA'"
cd "$CR" || exit 1
passo "2. npm ci --include=dev" npm ci --include=dev
passo "3. playwright install chromium" npx playwright install chromium
passo "4. typecheck" npx tsc --noEmit -p tsconfig.json
passo "5. cobertura da matriz de CI" bash scripts/ci-cobertura.sh
passo "6. guarda de risco do MCP" node scripts/verificar-risco-mcp.ts
passo "7. spike de controle real" bash -c "node spike/fase1_spike.ts >/dev/null"
for est in fast core security integration adversarial recovery e2e providers; do
  passo "8.$est ci.sh $est" bash scripts/ci.sh "$est"
done
export NOMOS_BROWSER_HOME="$CR/.runtime"
passo "9. service.sh install" bash scripts/service.sh install
passo "10. service.sh start" bash scripts/service.sh start
sleep 4
passo "11. service.sh health" bash scripts/service.sh health
passo "12. instância única" bash -c "! bash scripts/service.sh start"

# ── integração MCP a partir do CLONE, sem falsificar consentimento ──
echo
echo "── integração MCP (o registro é ato do dono) ──"
MAN="$CR/packaging/mcp/manifesto.json"
IMPRESSAO="$(python3 - "$MAN" <<'PY'
import json,hashlib,sys
m=json.load(open(sys.argv[1]))
n={k:m[k] for k in ("nome","comando","nivel_padrao","tools") if k in m}
print(hashlib.sha256(json.dumps(n,sort_keys=True,ensure_ascii=False,separators=(",",":")).encode()).hexdigest())
PY
)"
echo "  impressão do manifesto DESTE clone: $IMPRESSAO"
passo "13. manifesto do clone é válido" bash -c "python3 -c \"import json;json.load(open('$MAN'))\""
passo "14. lançador do clone fala MCP" bash -c "printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cr\"}}}' | NOMOS_BROWSER_TOKEN=x node '$CR/packaging/mcp/servidor.mjs' 2>/dev/null | head -1 | grep -q '\"protocolVersion\"'"
REGISTRADO="$($NOMOS_BIN mcp catalogo < /dev/null 2>/dev/null | grep -c "$(echo "$IMPRESSAO" | cut -c1-16)")"
if [ "$REGISTRADO" -ge 1 ]; then
  echo "  ✓ este manifesto JÁ está registrado no catálogo do dono"
  passo "15. nomos mcp conectar (registrado)" bash -c "$NOMOS_BIN mcp conectar '$MAN' < /dev/null | grep -q 'confiável'"
  echo "  MCP_CLEAN_ROOM=PASS"
else
  echo "  ⚠ este manifesto NÃO está registrado (impressão diferente da do catálogo)."
  echo "    O NOMOS vai recusar conectar/chamar — fail-closed, comportamento correto."
  echo "    Comando do dono: $NOMOS_BIN mcp confiar $MAN"
  echo "  MCP_CLEAN_ROOM=BLOQUEADO_POR_APROVACAO"
fi

passo "16. service.sh stop" bash scripts/service.sh stop
passo "17. service.sh uninstall" bash scripts/service.sh uninstall
passo "18. plist removido" bash -c "! test -f \"$HOME/Library/LaunchAgents/ai.nomos.browser.plist\""

echo
echo "PASSOS_FALHOS=$FALHAS"
[ "$FALHAS" -eq 0 ] && echo "CLEAN_ROOM_FINAL=PASS" || echo "CLEAN_ROOM_FINAL=FAIL"
echo "INSTALLATION_REPRODUCIBLE=$([ "$FALHAS" -eq 0 ] && echo YES || echo NO)"
echo "MANIFESTO_IMPRESSAO=$IMPRESSAO"
exit "$FALHAS"
