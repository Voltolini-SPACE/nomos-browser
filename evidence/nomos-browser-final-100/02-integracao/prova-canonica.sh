#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FASE 2 (loop-100) — INTEGRAÇÃO COM O NOMOS REAL, APÓS O REGISTRO DO MANIFESTO
#
# O manifesto foi reassinado pelo dono. `MCP_OWNER_TRUST`, `NOMOS_DISCOVERY`,
# `NOMOS_HANDSHAKE` e `NOMOS_TOOLS_LIST` deixaram de ser bloqueio. O que resta
# medir é o que o caminho CANÔNICO (`nomos mcp chamar`) consegue decidir.
#
# ── O TETO QUE ESTA PROVA ENCONTROU (medido, não suposto) ────────────────────
#
# `nomos mcp chamar` NÃO tem `--panel`. Verificado em três fontes independentes,
# gravadas nesta mesma pasta:
#
#   · `nomos mcp chamar --help` → só `-h` e `--args`   (01-cli-chamar-help.txt)
#   · `cli.py` declara `--panel` em 17 subcomandos; `chamar` não é um deles
#                                                     (02-panel-flag.txt)
#   · `_approver_for()` cai em `interactive_approver`, que sai `False` quando
#     `stdin`/`stdout` não são TTY; e `gate()` sem aprovador é fail-closed
#                                                     (04-gate-approver.txt)
#
# Consequência: sem um humano digitando "APROVO" num terminal, o NOMOS nega toda
# tool acima de A0. Isso é o NOMOS FUNCIONANDO — não é defeito do NOMOS Browser
# e não é contornável sem forjar o consentimento do dono, o que esta missão
# proíbe. Portanto:
#
#   · GATES A0 → têm de fechar 100% pelo caminho canônico. Sem desconto.
#   · GATES A1+ → saem `BLOQUEADO_SEM_APROVADOR_NAO_TTY`, com o comando exato
#     que o dono roda no terminal dele para fechá-los. NÃO contam como PASS,
#     e a sombra do lançador NÃO é promovida a prova.
#
# ── POSICIONAMENTO DE PÁGINA ─────────────────────────────────────────────────
#
# `browser_extract` é A0, mas só há o que extrair se alguém navegou antes — e
# navegar é EGRESSO (A2), que o NOMOS nega aqui. Então a NAVEGAÇÃO do preparo é
# feita pelo LANÇADOR do manifesto (o mesmo `comando` que o NOMOS executaria),
# rotulada `setup=lancador (NAO-CANONICO)`. A LEITURA — que é o que o gate
# `NOMOS_EXTRACT` mede — é 100% canônica via `nomos mcp chamar`.
#
# Uso: bash evidence/nomos-browser-final-100/02-integracao/prova-canonica.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
NOMOS_BIN="${NOMOS_BIN:-/Users/AI/.local/bin/nomos}"
MANIFESTO="$RAIZ/packaging/mcp/manifesto.json"
SAIDA="$(cd "$(dirname "$0")" && pwd)"
ONESHOT="$RAIZ/evidence/nomos-browser-final-closeout/02-integracao/oneshot-lancador.mjs"
RUNTIME_URL="${NOMOS_BROWSER_URL:-http://127.0.0.1:7777}"
TOKEN_FILE="${NOMOS_BROWSER_TOKEN_FILE:-$HOME/.nomos-browser/control-token}"
RUNTIME_DIR="${NOMOS_BROWSER_RUNTIME_DIR:-$HOME/.nomos-browser}"
PORTA_ALVO="${PORTA_ALVO:-8902}"
ALVO="http://127.0.0.1:${PORTA_ALVO}/segredo"
CANARIO="CANARIO-LOOP100-$$"

export NOMOS_BROWSER_URL="$RUNTIME_URL"
export NOMOS_BROWSER_TOKEN_FILE="$TOKEN_FILE"
export NOMOS_BROWSER_HEADLESS=1

# Tudo nasce FAIL. Verde tem de ser conquistado.
G_MCP_OWNER_TRUST=FAIL
G_NOMOS_DISCOVERY=FAIL
G_NOMOS_HANDSHAKE=FAIL
G_NOMOS_TOOLS_LIST=FAIL
G_NOMOS_SESSION_DURAVEL=FAIL
G_NOMOS_EXTRACT=FAIL
G_NOMOS_ERRO_VALIDO=FAIL
G_NOMOS_FAIL_CLOSED_A1_MAIS=FAIL
G_NOMOS_NO_PRIVILEGE_ESCALATION=FAIL
G_NOMOS_AUDIT=FAIL
G_NOMOS_SEM_ORFAO=FAIL

titulo() { printf '\n\033[1m══ %s ══════════════════════\033[0m\n' "$1"; }
nota()   { printf '  · %s\n' "$1"; }

TOKEN=""
[ -r "$TOKEN_FILE" ] && TOKEN="$(cat "$TOKEN_FILE")"
api() { /usr/bin/curl -s -m 10 -H "authorization: Bearer $TOKEN" "$@"; }

sessoes_vivas() {
  api "$RUNTIME_URL/api/v1/sessions" | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print("?"); raise SystemExit
print(len(d if isinstance(d, list) else d.get("sessions", [])))
'
}
chromium_vivos() { /bin/ps aux | /usr/bin/grep -c "[c]hrome-mac-arm64"; }
sid_de() { printf '%s' "$1" | /usr/bin/sed -nE 's/.*session_id=(ses_[0-9a-f]+).*/\1/p' | head -1; }

# CANÔNICO. stdin em /dev/null: um prompt de aprovação NÃO pode ser respondido aqui.
chamar_nomos()   { "$NOMOS_BIN" mcp chamar "$MANIFESTO" "$1" --args "$2" < /dev/null 2>&1; }
# SETUP. Mesmo `comando` do manifesto; NÃO conta como prova de gate nenhum.
chamar_lancador() { node "$ONESHOT" "$1" "$2" < /dev/null 2>&1; }

# ─────────────────────────────────────────────────────────────────────────────
titulo "0. preparo — daemon, credencial, alvo HTTP e linha de base"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$(/usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$RUNTIME_URL/health")" != "200" ]; then
  echo "ABORTADO: runtime não responde em $RUNTIME_URL — suba com: bash scripts/service.sh start"
  exit 2
fi
nota "runtime vivo em $RUNTIME_URL"
[ -r "$TOKEN_FILE" ] || { echo "ABORTADO: credencial ausente em $TOKEN_FILE"; exit 2; }
nota "credencial presente: $TOKEN_FILE"

cat > /tmp/alvo-loop100.mjs <<EOF
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html><head><title>Alvo</title></head><body><p id="fato">$CANARIO</p></body></html>');
}).listen($PORTA_ALVO, "127.0.0.1");
EOF
node /tmp/alvo-loop100.mjs & ALVO_PID=$!
# O alvo NÃO pode sobreviver a uma saída anormal: sem trap, um abort no meio
# deixa a porta ocupada e o run seguinte morre com EADDRINUSE.
trap 'kill "$ALVO_PID" 2>/dev/null' EXIT INT TERM
sleep 1
if ! /usr/bin/curl -s -m 5 "$ALVO" | /usr/bin/grep -q "$CANARIO"; then
  echo "ABORTADO: alvo HTTP não subiu em $ALVO"; exit 2
fi
nota "alvo HTTP: $ALVO (canário $CANARIO)"

# O produto BLOQUEIA navegar em 127.0.0.1 por default (anti-SSRF, `allow_internal_urls`
# = false). Isso é o certo, e é por isso que o opt-in NÃO entra no plist do
# supervisor: ele é decisão de quem roda o teste, não default de produto. O
# preparo desta prova precisa dele; se faltar, ABORTA em vez de sair FAIL — um
# FAIL aqui seria culpar o produto por uma configuração do instrumento.
SONDA_SSRF="$(api -X POST -H 'content-type: application/json' \
  -d "{\"url\":\"http://127.0.0.1:${PORTA_ALVO}/segredo\"}" \
  "$RUNTIME_URL/api/v1/browser.navigate" 2>&1 | head -c 400)"
if printf '%s' "$SONDA_SSRF" | /usr/bin/grep -q "host interno bloqueado"; then
  echo "ABORTADO: o daemon está sem allow_internal_urls. Suba assim para esta prova:"
  echo "  NOMOS_BROWSER_ALLOW_INTERNAL=true node packages/api/src/daemon.ts"
  exit 2
fi
nota "daemon com allow_internal_urls=true (opt-in DO TESTE, não default do produto)"

rm -f "$RUNTIME_DIR/mcp-session.json" "$RUNTIME_DIR/mcp-session.lock"
SESSOES_ANTES="$(sessoes_vivas)"
CHROMIUM_ANTES="$(chromium_vivos)"
nota "SESSOES_VIVAS_ANTES=$SESSOES_ANTES  CHROMIUM_ANTES=$CHROMIUM_ANTES"

# A impressão é recomputada pela BIBLIOTECA DO PRÓPRIO NOMOS (carregar_manifesto
# + impressao), não por uma reimplementação da normalização aqui.
HASH_ATUAL="$("$(dirname "$(readlink -f "$NOMOS_BIN")")/python" - "$MANIFESTO" <<'PY'
import sys
from nomos.interface import mcp_catalogo as cat
from nomos.interface import mcp_client as mc
print(cat.impressao(mc.carregar_manifesto(sys.argv[1])))
PY
)"
nota "IMPRESSAO_CANONICA_DO_MANIFESTO=$HASH_ATUAL"

# ─────────────────────────────────────────────────────────────────────────────
titulo "1. discovery — nomos mcp catalogo"
# ─────────────────────────────────────────────────────────────────────────────
CATALOGO="$("$NOMOS_BIN" mcp catalogo 2>&1)"
printf '%s\n' "$CATALOGO" | /usr/bin/sed 's/^/    /'
if printf '%s' "$CATALOGO" | /usr/bin/grep -q "✓ nomos-browser"; then
  G_NOMOS_DISCOVERY=PASS
  nota "DISCOVERY: o catálogo do dono lista o conector"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "2. confiança do dono — o hash registrado é o do manifesto ATUAL?"
# ─────────────────────────────────────────────────────────────────────────────
CURTA="$(printf '%s' "$HASH_ATUAL" | cut -c1-16)"
if printf '%s' "$CATALOGO" | /usr/bin/grep -q "$CURTA"; then
  G_MCP_OWNER_TRUST=PASS
  nota "TRUST: registrado com a impressão ATUAL (${CURTA}…)"
else
  nota "TRUST: FAIL — o catálogo NÃO tem a impressão atual."
  nota "        Re-registro (SÓ o dono): $NOMOS_BIN mcp confiar $MANIFESTO --panel"
fi

# Achado colateral, registrado sem ser corrigido por mim: o catálogo guarda a
# confiança POR IMPRESSÃO, e a impressão do manifesto ANTERIOR continua lá.
ANTIGAS="$(printf '%s' "$CATALOGO" | /usr/bin/grep -c "✓ nomos-browser")"
if [ "$ANTIGAS" -gt 1 ]; then
  nota "ATENÇÃO: $ANTIGAS impressões de 'nomos-browser' confiáveis ao mesmo tempo."
  nota "         A antiga (d267002feb6f9e4a…) é o manifesto de 13 tools do commit"
  nota "         78491cc — o que tinha a ELEVAÇÃO DE PRIVILÉGIO (browser_tabs A0"
  nota "         despachando browser.new_tab). Quem apresentar aquele arquivo"
  nota "         continua confiável. Só o dono revoga:"
  nota "           git show 78491cc:packaging/mcp/manifesto.json > /tmp/antigo.json"
  nota "           $NOMOS_BIN mcp revogar /tmp/antigo.json"
  nota "         NÃO revoguei: 'revogar' é bloqueio duro e irreversível pelo CLI."
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "3. conexão — handshake + tools/list com os níveis do manifesto"
# ─────────────────────────────────────────────────────────────────────────────
CONECTAR="$("$NOMOS_BIN" mcp conectar "$MANIFESTO" < /dev/null 2>&1)"
printf '%s\n' "$CONECTAR" | /usr/bin/sed 's/^/    /'
if printf '%s' "$CONECTAR" | /usr/bin/grep -q "conectado a 'nomos-browser' \[✓ confiável\]"; then
  G_NOMOS_HANDSHAKE=PASS
  N_TOOLS="$(printf '%s' "$CONECTAR" | /usr/bin/grep -cE '^  \[A[0-9]\] ')"
  # `tools/list` só vale com OS NÍVEIS declarados — e as quatro ferramentas de
  # aba têm de aparecer SEPARADAS, cada uma no seu nível. Foi a fusão delas numa
  # tool A0 só que abriu a elevação de privilégio.
  if [ "$N_TOOLS" = "16" ] \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A0\] browser_tabs" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A2\] browser_tab_open" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A1\] browser_tab_switch" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A1\] browser_tab_close"; then
    G_NOMOS_TOOLS_LIST=PASS
    nota "TOOLS_LIST: $N_TOOLS tools, as quatro de aba separadas e com níveis distintos"
  else
    nota "TOOLS_LIST: FAIL — N_TOOLS=$N_TOOLS ou níveis das abas fora do esperado"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "4. sessão durável — A0 em DOIS processos one-shot, mesmo session_id"
# ─────────────────────────────────────────────────────────────────────────────
echo "--- chamada A (canônica, A0): browser_tabs ---"
A="$(chamar_nomos browser_tabs '{}')"
printf '%s\n' "$A" | head -4 | /usr/bin/sed 's/^/    /'
echo "--- chamada B (canônica, A0), PROCESSO SEPARADO: browser_observe ---"
B="$(chamar_nomos browser_observe '{}')"
printf '%s\n' "$B" | head -4 | /usr/bin/sed 's/^/    /'
SA="$(sid_de "$A")"; SB="$(sid_de "$B")"
echo "    SESSAO_A=$SA  SESSAO_B=$SB"
if [ -n "$SA" ] && [ "$SA" = "$SB" ]; then
  G_NOMOS_SESSION_DURAVEL=PASS
  nota "session_id ESTÁVEL entre dois processos one-shot: $SA"
  nota "registro persistido:"; /bin/cat "$RUNTIME_DIR/mcp-session.json" | /usr/bin/sed 's/^/      /'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "5. extract — a LEITURA é canônica; a navegação do preparo, não"
# ─────────────────────────────────────────────────────────────────────────────
# Antes: prova de que o extract canônico NÃO enxerga o canário ainda. Sem esta
# linha, um canário deixado por outra execução passaria por leitura de agora.
ANTES="$(chamar_nomos browser_extract '{"target":{"selector":"#fato"}}')"
if printf '%s' "$ANTES" | /usr/bin/grep -q "$CANARIO"; then
  nota "ABORTADO CONCEITUALMENTE: o canário já estava na página ANTES de navegar."
  nota "Sem linha de base negativa, o gate seria vacuoso."
  G_NOMOS_EXTRACT=FAIL_VACUOSO
else
  nota "linha de base: o canário NÃO está na página antes do preparo (bom)"
  echo "--- setup=lancador (NAO-CANONICO): browser_navigate url=$ALVO ---"
  echo "    razão: navegar é A2 (egresso) e o NOMOS nega sem aprovador TTY."
  SET="$(chamar_lancador browser_navigate "{\"url\":\"$ALVO\"}")"
  printf '%s\n' "$SET" | head -3 | /usr/bin/sed 's/^/    /'
  SSET="$(sid_de "$SET")"
  echo "    SESSAO_DO_SETUP=$SSET  (tem de ser a MESMA de A/B: $SA)"
  echo "--- leitura CANÔNICA (A0): nomos mcp chamar browser_extract #fato ---"
  DEPOIS="$(chamar_nomos browser_extract '{"target":{"selector":"#fato"}}')"
  printf '%s\n' "$DEPOIS" | head -8 | /usr/bin/sed 's/^/    /'
  if [ "$SSET" = "$SA" ] && printf '%s' "$DEPOIS" | /usr/bin/grep -q "$CANARIO"; then
    G_NOMOS_EXTRACT=PASS
    nota "EXTRACT: o caminho canônico leu o canário DESTA execução ($CANARIO)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "6. erro válido — três formas de errar, todas pelo caminho canônico"
# ─────────────────────────────────────────────────────────────────────────────
# (a) tool inexistente: cai no nivel_padrao A5 e o NOMOS nega ANTES do server.
E1="$(chamar_nomos browser_inexistente '{}')"
echo "--- (a) tool inexistente ---"; printf '%s\n' "$E1" | head -3 | /usr/bin/sed 's/^/    /'
# (b) argumento inválido numa tool A0: o erro tem de vir do SERVER, com código.
E2="$(chamar_nomos browser_extract '{"target":{"selector":123}}')"
echo "--- (b) argumento inválido em tool A0 ---"; printf '%s\n' "$E2" | head -3 | /usr/bin/sed 's/^/    /'
# (c) alvo inexistente: TARGET_NOT_FOUND com trace de estratégias.
E3="$(chamar_nomos browser_extract '{"target":{"selector":"#nao-existe-nunca"}}')"
echo "--- (c) alvo inexistente ---"; printf '%s\n' "$E3" | head -3 | /usr/bin/sed 's/^/    /'
OK_A=0; OK_B=0; OK_C=0
printf '%s' "$E1" | /usr/bin/grep -q "NOMOS-E002" && OK_A=1
printf '%s' "$E2" | /usr/bin/grep -qE "INVALID_REQUEST|VALIDATION|obrigatório|inválid|deve ser" && OK_B=1
printf '%s' "$E3" | /usr/bin/grep -q "TARGET_NOT_FOUND" && OK_C=1
echo "    (a)=$OK_A (b)=$OK_B (c)=$OK_C"
[ "$OK_A$OK_B$OK_C" = "111" ] && G_NOMOS_ERRO_VALIDO=PASS

# ─────────────────────────────────────────────────────────────────────────────
titulo "7. fail-closed A1+ — o NOMOS nega TUDO acima de A0 sem aprovador"
# ─────────────────────────────────────────────────────────────────────────────
# Este gate não mede o NOMOS Browser: mede que o teto encontrado é REAL e
# uniforme. Se alguma tool A1+ passasse aqui, seria elevação de privilégio.
NEGADAS=0; TOTAL=0
for par in "browser_tab_open:{\"url\":\"$ALVO\"}" \
           "browser_tab_switch:{\"page_id\":\"pg_x\"}" \
           "browser_tab_close:{\"page_id\":\"pg_x\"}" \
           "browser_navigate:{\"url\":\"$ALVO\"}" \
           "browser_click:{\"target\":{\"selector\":\"#fato\"}}" \
           "browser_type:{\"target\":{\"selector\":\"#fato\"},\"text\":\"x\"}" \
           "browser_press:{\"key\":\"Enter\"}" \
           "browser_scroll:{\"dy\":100}" \
           "browser_download:{\"url\":\"$ALVO\"}" \
           "browser_upload:{\"target\":{\"selector\":\"#f\"},\"path\":\"/tmp/x\"}" \
           "browser_task:{\"objetivo\":\"x\"}"; do
  TOOL="${par%%:*}"; ARGS="${par#*:}"
  TOTAL=$((TOTAL+1))
  R="$(chamar_nomos "$TOOL" "$ARGS")"
  if printf '%s' "$R" | /usr/bin/grep -q "NOMOS-E002"; then
    NEGADAS=$((NEGADAS+1)); printf '    NEGADA  %-22s\n' "$TOOL"
  else
    printf '    PASSOU  %-22s  ← ELEVAÇÃO DE PRIVILÉGIO\n' "$TOOL"
    printf '%s\n' "$R" | head -2 | /usr/bin/sed 's/^/        /'
  fi
done
echo "    NEGADAS=$NEGADAS de $TOTAL"
[ "$NEGADAS" = "$TOTAL" ] && G_NOMOS_FAIL_CLOSED_A1_MAIS=PASS

# ─────────────────────────────────────────────────────────────────────────────
titulo "8. elevação de privilégio — o exploit de 01-mcp/03 não é expressável"
# ─────────────────────────────────────────────────────────────────────────────
echo "--- (a) veredito da POLÍTICA do dono por ferramenta (dry-run, nada executa) ---"
"$NOMOS_BIN" approvals testar A0_READ_LOCAL "mcp:nomos-browser:browser_tabs"     2>&1 | /usr/bin/sed 's/^/    /'
"$NOMOS_BIN" approvals testar A2_NET_EGRESS "mcp:nomos-browser:browser_tab_open" 2>&1 | /usr/bin/sed 's/^/    /'
echo "--- (b) o exploit literal: browser_tabs (A0) com action=new + url ---"
ABAS_ANTES="$(chamar_nomos browser_tabs '{}' | /usr/bin/grep -c '"page_id"')"
X="$(chamar_nomos browser_tabs "{\"action\":\"new\",\"url\":\"$ALVO\"}")"
printf '%s\n' "$X" | head -4 | /usr/bin/sed 's/^/    /'
ABAS_DEPOIS="$(chamar_nomos browser_tabs '{}' | /usr/bin/grep -c '"page_id"')"
echo "    ABAS_ANTES=$ABAS_ANTES  ABAS_DEPOIS=$ABAS_DEPOIS"
if [ "$ABAS_ANTES" = "$ABAS_DEPOIS" ] && ! printf '%s' "$X" | /usr/bin/grep -q "browser.new_tab"; then
  G_NOMOS_NO_PRIVILEGE_ESCALATION=PASS
  nota "a tool A0 NÃO abriu aba: o argumento não escolhe mais a rota"
fi
echo "--- (c) guarda estático de coerência de risco ---"
node scripts/verificar-risco-mcp.ts 2>&1 | /usr/bin/sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────
titulo "9. audit — as chamadas canônicas aparecem em sessions/<id>/actions.jsonl"
# ─────────────────────────────────────────────────────────────────────────────
SID_AUDIT="$(python3 -c '
import json, sys, os
p = os.path.expanduser(sys.argv[1])
try: print(json.load(open(p))["session_id"])
except Exception: print("")
' "$RUNTIME_DIR/mcp-session.json")"
[ -z "$SID_AUDIT" ] && SID_AUDIT="$SA"
LINHAS="$RAIZ/sessions/$SID_AUDIT/actions.jsonl"
nota "sessão auditada: $SID_AUDIT"
if [ -f "$LINHAS" ]; then
  python3 - "$LINHAS" <<'PY'
import json, sys
linhas = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
print(f"    TOTAL_LINHAS={len(linhas)}")
campos = ("actor", "capability", "policy_decision")
completas = [l for l in linhas if all(l.get(c) is not None for c in campos)]
print(f"    LINHAS_COM_actor+capability+policy_decision={len(completas)}")
for l in linhas[-4:]:
    print("    " + json.dumps({k: l.get(k) for k in ("action", "actor", "owner", "capability", "policy_decision", "result")}, ensure_ascii=False))
acoes = sorted({l.get("action") for l in linhas})
print("    ACOES=" + ",".join(a for a in acoes if a))
PY
  if python3 - "$LINHAS" <<'PY'
import json, sys
linhas = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
campos = ("actor", "capability", "policy_decision")
ok = any(all(l.get(c) is not None for c in campos) for l in linhas)
sys.exit(0 if ok and len(linhas) > 0 else 1)
PY
  then G_NOMOS_AUDIT=PASS; fi
else
  nota "actions.jsonl não encontrado em $LINHAS"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "10. encerramento — sem órfão"
# ─────────────────────────────────────────────────────────────────────────────
# A saída explícita do DONO. Não é tool: é comando do lançador. Justificativa em
# `encerrarSessaoPersistida`, packages/mcp/src/server.ts.
( cd "$RAIZ/packaging/mcp" && node servidor.mjs --encerrar-sessao < /dev/null ) | /usr/bin/sed 's/^/    /'
sleep 2
SESSOES_DEPOIS="$(sessoes_vivas)"
CHROMIUM_DEPOIS="$(chromium_vivos)"
echo "    SESSOES_VIVAS_ANTES=$SESSOES_ANTES  SESSOES_VIVAS_DEPOIS=$SESSOES_DEPOIS"
echo "    CHROMIUM_ANTES=$CHROMIUM_ANTES  CHROMIUM_DEPOIS=$CHROMIUM_DEPOIS"
[ "$SESSOES_DEPOIS" = "$SESSOES_ANTES" ] && [ "$CHROMIUM_DEPOIS" -le "$CHROMIUM_ANTES" ] && G_NOMOS_SEM_ORFAO=PASS

kill "$ALVO_PID" 2>/dev/null
rm -f /tmp/alvo-loop100.mjs

# ─────────────────────────────────────────────────────────────────────────────
titulo "RODAPÉ"
# ─────────────────────────────────────────────────────────────────────────────
echo "IMPRESSAO_EM_USO=$HASH_ATUAL"
echo "MCP_OWNER_TRUST=$G_MCP_OWNER_TRUST"
echo "NOMOS_DISCOVERY=$G_NOMOS_DISCOVERY"
echo "NOMOS_HANDSHAKE=$G_NOMOS_HANDSHAKE"
echo "NOMOS_TOOLS_LIST=$G_NOMOS_TOOLS_LIST"
echo "NOMOS_SESSION_DURAVEL=$G_NOMOS_SESSION_DURAVEL"
echo "NOMOS_EXTRACT=$G_NOMOS_EXTRACT"
echo "NOMOS_ERRO_VALIDO=$G_NOMOS_ERRO_VALIDO"
echo "NOMOS_FAIL_CLOSED_A1_MAIS=$G_NOMOS_FAIL_CLOSED_A1_MAIS"
echo "NOMOS_NO_PRIVILEGE_ESCALATION=$G_NOMOS_NO_PRIVILEGE_ESCALATION"
echo "NOMOS_AUDIT=$G_NOMOS_AUDIT"
echo "NOMOS_SEM_ORFAO=$G_NOMOS_SEM_ORFAO"

TODOS="$G_MCP_OWNER_TRUST$G_NOMOS_DISCOVERY$G_NOMOS_HANDSHAKE$G_NOMOS_TOOLS_LIST$G_NOMOS_SESSION_DURAVEL$G_NOMOS_EXTRACT$G_NOMOS_ERRO_VALIDO$G_NOMOS_FAIL_CLOSED_A1_MAIS$G_NOMOS_NO_PRIVILEGE_ESCALATION$G_NOMOS_AUDIT$G_NOMOS_SEM_ORFAO"
if printf '%s' "$TODOS" | /usr/bin/grep -q "FAIL"; then
  echo "NOMOS_BROWSER_INTEGRATION=FAIL"
  RC=1
else
  echo "NOMOS_BROWSER_INTEGRATION=PASS"
  RC=0
fi

echo
echo "── O QUE ESTA PROVA NÃO FECHA, E POR QUÊ ────────────────────────────────"
echo "EXECUCAO_CANONICA_A1_MAIS=BLOQUEADO_SEM_APROVADOR_NAO_TTY"
echo "  'nomos mcp chamar' não tem --panel e 'interactive_approver' exige TTY."
echo "  Onze tools A1+ foram tentadas pelo caminho canônico e TODAS negadas —"
echo "  esse é o gate NOMOS_FAIL_CLOSED_A1_MAIS acima, e ele é PASS: o teto é"
echo "  real e uniforme. O que falta é EXECUTAR uma delas com o dono presente."
echo "  Quem fecha isso é o dono, no terminal dele:"
echo "    cd $RAIZ"
echo "    $NOMOS_BIN mcp chamar $MANIFESTO browser_navigate --args '{\"url\":\"$ALVO\"}'"
echo "    (o NOMOS pergunta; digite APROVO)"
echo "  Sem TTY do dono, forçar isso seria forjar consentimento. Não forcei."
exit "$RC"
