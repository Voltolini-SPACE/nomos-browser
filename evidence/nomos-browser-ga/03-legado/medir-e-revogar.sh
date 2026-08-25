#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FASE 3 — O MANIFESTO LEGADO d267002f…
#
# O catálogo confia POR IMPRESSÃO e `confiar` só ACRESCENTA. Depois da correção
# da elevação de privilégio, `nomos-browser` ficou listado duas vezes: a nova
# (317f1589…, 16 tools) e a antiga (d267002f…, 13 tools — a que declarava
# `browser_tabs` como A0 despachando quatro rotas, uma delas egresso).
#
# ORDEM DE TRABALHO, e ela importa: MEDIR primeiro, decidir depois. Revogar sem
# medir fecharia o caso sem nunca saber o tamanho dele — e o relatório diria
# "resolvido" sobre uma coisa que ninguém olhou.
#
#   PARTE 1  medir a superfície REAL com o legado ainda confiável
#   PARTE 2  revogar pelo caminho canônico (`nomos mcp revogar`)
#   PARTE 3  provar que o legado deixou de ser aceito
#   PARTE 4  provar que o manifesto ATUAL saiu ileso
#
# O manifesto antigo é EXTRAÍDO do histórico do git (`git show 78491cc:…`) —
# não é forjado, é o arquivo que realmente esteve lá. Ele é posto ao lado do
# `servidor.mjs` de propósito: esse é o cenário de ataque de verdade (alguém
# restaura o manifesto antigo onde o servidor mora), e não um caminho artificial.
# No fim, é removido, e a árvore volta limpa.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
NOMOS_BIN="${NOMOS_BIN:-/Users/AI/.local/bin/nomos}"
ATUAL="$RAIZ/packaging/mcp/manifesto.json"
LEGADO="$RAIZ/packaging/mcp/manifesto-antigo-78491cc.json"
COMMIT_LEGADO="78491cc"
TRILHA_NOMOS="$HOME/.nomos/logs/audit.jsonl"
RUNTIME_URL="${NOMOS_BROWSER_URL:-http://127.0.0.1:7777}"

export NOMOS_BROWSER_URL="$RUNTIME_URL"
export NOMOS_BROWSER_TOKEN_FILE="$HOME/.nomos-browser/control-token"
export NOMOS_BROWSER_HEADLESS=1

G_LEGADO_ACEITO_ANTES=DESCONHECIDO
G_LEGADO_EXPLORAVEL=DESCONHECIDO
G_REVOGADO=NO
G_LEGADO_RECUSADO_DEPOIS=NO
G_ATUAL_ILESO=NO

titulo() { printf '\n\033[1m══ %s ══════════════════════\033[0m\n' "$1"; }
nota()   { printf '  · %s\n' "$1"; }
limpar() { /bin/rm -f "$LEGADO"; }
trap limpar EXIT INT TERM

impressao_de() {
  "$(dirname "$(readlink -f "$NOMOS_BIN")")/python" - "$1" <<'PY'
import sys
from nomos.interface import mcp_catalogo as cat
from nomos.interface import mcp_client as mc
print(cat.impressao(mc.carregar_manifesto(sys.argv[1])))
PY
}
status_de() {
  "$(dirname "$(readlink -f "$NOMOS_BIN")")/python" - "$1" <<'PY'
import sys
from pathlib import Path
from nomos.interface import mcp_catalogo as cat
from nomos.interface import mcp_client as mc
print(cat.status(Path.home() / ".nomos", mc.carregar_manifesto(sys.argv[1])))
PY
}
n_abas() {
  "$NOMOS_BIN" mcp chamar "$ATUAL" browser_tabs --args '{}' < /dev/null 2>&1 \
    | grep -c '"page_id"'
}

# ─────────────────────────────────────────────────────────────────────────────
titulo "0. extrair o manifesto legado do histórico (não forjar)"
# ─────────────────────────────────────────────────────────────────────────────
git show "$COMMIT_LEGADO:packaging/mcp/manifesto.json" > "$LEGADO" 2>/dev/null || {
  echo "ABORTADO: não consegui extrair $COMMIT_LEGADO:packaging/mcp/manifesto.json"; exit 2; }
IMP_LEGADO="$(impressao_de "$LEGADO")"
IMP_ATUAL="$(impressao_de "$ATUAL")"
N_TOOLS_LEGADO="$(python3 -c "import json;print(len(json.load(open('$LEGADO'))['tools']))")"
nota "legado extraído de $COMMIT_LEGADO — $N_TOOLS_LEGADO tools"
nota "impressão do legado: $IMP_LEGADO"
nota "impressão do atual : $IMP_ATUAL"
[ "${IMP_LEGADO:0:8}" = "d267002f" ] || { echo "ABORTADO: o legado não é o d267002f… esperado"; exit 2; }

# ─────────────────────────────────────────────────────────────────────────────
titulo "1. MEDIR — o que o legado consegue HOJE, ainda confiável"
# ─────────────────────────────────────────────────────────────────────────────
ST="$(status_de "$LEGADO")"
echo "    status do legado no catálogo: $ST"
[ "$ST" = "confiavel" ] && G_LEGADO_ACEITO_ANTES=SIM

echo "--- (a) o NOMOS conecta usando o manifesto legado? ---"
"$NOMOS_BIN" mcp conectar "$LEGADO" < /dev/null 2>&1 | head -6 | sed 's/^/    /'

echo "--- (b) que nível o legado dá a browser_tabs? ---"
NIVEL_TABS="$(python3 -c "import json;print(json.load(open('$LEGADO'))['tools'].get('browser_tabs','(ausente)'))")"
echo "    legado: browser_tabs = $NIVEL_TABS"
echo "    atual : browser_tabs = $(python3 -c "import json;print(json.load(open('$ATUAL'))['tools'].get('browser_tabs'))")"
"$NOMOS_BIN" approvals testar A0_READ_LOCAL "mcp:nomos-browser:browser_tabs" 2>&1 | head -2 | sed 's/^/    /'

echo "--- (c) O EXPLOIT HISTÓRICO, tentado de verdade pelo caminho canônico ---"
echo "    browser_tabs (A0 no legado) com action=new + url — era assim que a aba abria"
ABAS_ANTES="$(n_abas)"
EXPLOIT="$("$NOMOS_BIN" mcp chamar "$LEGADO" browser_tabs \
  --args '{"action":"new","url":"http://127.0.0.1:8999/exfil"}' < /dev/null 2>&1)"
printf '%s\n' "$EXPLOIT" | head -4 | sed 's/^/    /'
ABAS_DEPOIS="$(n_abas)"
echo "    abas antes=$ABAS_ANTES depois=$ABAS_DEPOIS"

# QUAL CAMADA barrou? A distinção é o achado desta fase.
if printf '%s' "$EXPLOIT" | grep -q "NOMOS-E002"; then
  CAMADA="NOMOS (política)"
elif printf '%s' "$EXPLOIT" | grep -qi "desconhecid"; then
  CAMADA="SERVIDOR (validação de argumentos do código atual)"
else
  CAMADA="NENHUMA"
fi
echo "    quem barrou: $CAMADA"
if [ "$ABAS_ANTES" = "$ABAS_DEPOIS" ] && [ "$CAMADA" != "NENHUMA" ]; then
  G_LEGADO_EXPLORAVEL=NAO
  nota "o exploit NÃO abriu aba. Mas veja a camada: se foi o SERVIDOR, então a"
  nota "camada de manifesto teria deixado passar, e a defesa é de UMA só."
else
  G_LEGADO_EXPLORAVEL=SIM
  nota "⚠ o exploit FUNCIONOU — isto é caminho privilegiado utilizável"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "2. REVOGAR — pelo caminho canônico, com rastro"
# ─────────────────────────────────────────────────────────────────────────────
# Por que revogar mesmo se o servidor atual barra o exploit: a defesa hoje é de
# UMA camada só (a validação de argumentos do código de agora). Um checkout do
# `servidor.mjs` daquele commit devolve a outra metade, e aí o manifesto
# confiável é a chave que faltava. Revogar tira a chave do chaveiro.
NOMOS_ANTES="$(wc -l < "$TRILHA_NOMOS" 2>/dev/null | tr -d ' ')"
echo "--- catálogo ANTES ---"
"$NOMOS_BIN" mcp catalogo 2>&1 | sed 's/^/    /'

echo "--- nomos mcp revogar <legado> ---"
"$NOMOS_BIN" mcp revogar "$LEGADO" < /dev/null 2>&1 | sed 's/^/    /'
RC_REV=$?
echo "    rc=$RC_REV"

echo "--- catálogo DEPOIS ---"
CAT_DEPOIS="$("$NOMOS_BIN" mcp catalogo 2>&1)"
printf '%s\n' "$CAT_DEPOIS" | sed 's/^/    /'

echo "--- a revogação deixou rastro na trilha do NOMOS? ---"
tail -n "+$((NOMOS_ANTES+1))" "$TRILHA_NOMOS" 2>/dev/null | grep -i "revog" | head -3 | sed 's/^/    /'
RASTRO="$(tail -n "+$((NOMOS_ANTES+1))" "$TRILHA_NOMOS" 2>/dev/null | grep -ci "mcp.revogado")"
echo "    linhas mcp.revogado: $RASTRO"

if printf '%s' "$CAT_DEPOIS" | grep -q "d267002feb6f9e4a"; then
  nota "⚠ o legado AINDA aparece como confiável"
else
  [ "$RASTRO" -ge 1 ] && G_REVOGADO=YES && nota "revogado e auditado"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "3. PROVAR — o legado deixou de ser aceito"
# ─────────────────────────────────────────────────────────────────────────────
ST2="$(status_de "$LEGADO")"
echo "    status do legado agora: $ST2   (tem de ser 'revogado')"

echo "--- (a) conectar com o legado ---"
C2="$("$NOMOS_BIN" mcp conectar "$LEGADO" < /dev/null 2>&1)"
printf '%s\n' "$C2" | head -3 | sed 's/^/    /'

echo "--- (b) chamar uma tool A0 pelo legado (antes isto funcionava) ---"
T2="$("$NOMOS_BIN" mcp chamar "$LEGADO" browser_tabs --args '{}' < /dev/null 2>&1)"
printf '%s\n' "$T2" | head -3 | sed 's/^/    /'

echo "--- (c) o exploit histórico, de novo ---"
ABAS_A="$(n_abas)"
E2="$("$NOMOS_BIN" mcp chamar "$LEGADO" browser_tabs \
  --args '{"action":"new","url":"http://127.0.0.1:8999/exfil"}' < /dev/null 2>&1)"
printf '%s\n' "$E2" | head -2 | sed 's/^/    /'
ABAS_B="$(n_abas)"
echo "    abas antes=$ABAS_A depois=$ABAS_B"

if [ "$ST2" = "revogado" ] \
   && printf '%s' "$C2" | grep -qi "revogado" \
   && printf '%s' "$T2" | grep -qi "revogado" \
   && [ "$ABAS_A" = "$ABAS_B" ]; then
  G_LEGADO_RECUSADO_DEPOIS=YES
  nota "o legado é recusado ANTES de qualquer execução, nas três portas"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "4. CONTROLE — o manifesto ATUAL saiu ileso"
# ─────────────────────────────────────────────────────────────────────────────
# Sem este controle, "revoguei" e "quebrei tudo" seriam indistinguíveis.
ST_AT="$(status_de "$ATUAL")"
echo "    status do atual: $ST_AT"
C_AT="$("$NOMOS_BIN" mcp conectar "$ATUAL" < /dev/null 2>&1)"
printf '%s\n' "$C_AT" | head -2 | sed 's/^/    /'
N_TOOLS="$(printf '%s' "$C_AT" | grep -cE '^  \[A[0-9]\] ')"
T_AT="$("$NOMOS_BIN" mcp chamar "$ATUAL" browser_tabs --args '{}' < /dev/null 2>&1)"
printf '%s\n' "$T_AT" | head -2 | sed 's/^/    /'
echo "    tools listadas pelo atual: $N_TOOLS"
if [ "$ST_AT" = "confiavel" ] && [ "$N_TOOLS" = "16" ] \
   && printf '%s' "$T_AT" | grep -q "route=browser.tabs"; then
  G_ATUAL_ILESO=YES
  nota "atual continua confiável, com 16 tools, e executa"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "RODAPÉ"
# ─────────────────────────────────────────────────────────────────────────────
echo "LEGACY_MANIFEST_SHA=$IMP_LEGADO"
echo "LEGACY_MANIFEST_COMMIT=$COMMIT_LEGADO ($N_TOOLS_LEGADO tools)"
echo "LEGACY_TRUSTED_BEFORE=$G_LEGADO_ACEITO_ANTES"
echo "LEGACY_TRUST_EXPLOITABLE=$G_LEGADO_EXPLORAVEL"
echo "LEGACY_BLOCKED_BY_LAYER=$CAMADA"
echo "LEGACY_TRUST_REVOKED=$G_REVOGADO"
echo "LEGACY_REFUSED_AFTER=$G_LEGADO_RECUSADO_DEPOIS"
echo "CURRENT_MANIFEST_UNHARMED=$G_ATUAL_ILESO"
if [ "$G_REVOGADO" = "YES" ] && [ "$G_LEGADO_RECUSADO_DEPOIS" = "YES" ] && [ "$G_ATUAL_ILESO" = "YES" ]; then
  echo "LEGACY_TRUST_STATE=RESOLVED"
  RC=0
else
  echo "LEGACY_TRUST_STATE=NOT_RESOLVED"
  RC=1
fi
limpar
echo "arquivo temporário do legado removido: $([ -f "$LEGADO" ] && echo AINDA_EXISTE || echo OK)"
exit "$RC"
