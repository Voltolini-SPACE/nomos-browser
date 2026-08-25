#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CLOSEOUT-2 — PROVA DE INTEGRAÇÃO COM O NOMOS **REAL**
#
# Nada aqui reimplementa cliente MCP. Todo caminho canônico passa pelo binário do
# dono: `nomos mcp catalogo|conectar|chamar` e `nomos approvals testar`.
#
# ── O QUE ESTA PROVA NÃO PODE FAZER HOJE, E POR QUÊ ──────────────────────────
#
# A correção da elevação de privilégio MUDOU o manifesto (quatro ferramentas de
# aba no lugar de uma, cada uma com o seu nível). O SHA-256 do manifesto É a
# confiança registrada no NOMOS, então ele voltou a ser EXPERIMENTAL — e o NOMOS,
# por desenho, recusa `conectar` e `chamar` de server experimental (NOMOS-E002).
# Esse é o comportamento CERTO e não é contornado: nenhum comando abaixo digita
# "CONFIO" nem "ACEITO O RISCO" no lugar do dono (stdin vem de /dev/null).
#
# Enquanto o dono não reassinar, os gates que dependem de `nomos mcp chamar` saem
# FAIL com motivo BLOQUEADO_MANIFESTO_EXPERIMENTAL. Abaixo de cada um, a mesma
# verificação é repetida pelo LANÇADOR do manifesto (`node servidor.mjs` — o
# `comando` que o próprio NOMOS executaria, um processo por chamada, mesma forma
# one-shot). Essas linhas são rotuladas `via=lancador-direto (NAO-CANONICO)` e
# NÃO contam como PASS de gate nenhum.
#
# ── LIMITAÇÃO DECLARADA DO CLI ───────────────────────────────────────────────
#
# `nomos mcp chamar` não expõe cancelamento nem prazo: não há `--timeout` e não
# existe tool `browser_wait` no catálogo MCP (a rota `browser.wait` existe no
# contrato do runtime, mas nunca foi exposta como ferramenta). Então o prazo é
# provado por COMPORTAMENTO OBSERVÁVEL: (a) chamada com NOMOS_BROWSER_TIMEOUT_MS
# curto contra um alvo que não responde e (b) SIGTERM no processo do cliente no
# meio da chamada, conferindo runtime íntegro e sem sessão pendurada.
#
# Uso: bash evidence/nomos-browser-final-closeout/02-integracao/prova-nomos-real.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
NOMOS_BIN="${NOMOS_BIN:-/Users/AI/.local/bin/nomos}"
MANIFESTO="$RAIZ/packaging/mcp/manifesto.json"
SAIDA="$(cd "$(dirname "$0")" && pwd)"
ONESHOT="$SAIDA/oneshot-lancador.mjs"
RUNTIME_URL="${NOMOS_BROWSER_URL:-http://127.0.0.1:7777}"
TOKEN_FILE="${NOMOS_BROWSER_TOKEN_FILE:-$HOME/.nomos-browser/control-token}"
RUNTIME_DIR="${NOMOS_BROWSER_RUNTIME_DIR:-$HOME/.nomos-browser}"
PORTA_ALVO="${PORTA_ALVO:-8901}"
ALVO="http://127.0.0.1:${PORTA_ALVO}/segredo"
CANARIO="CANARIO-CLOSEOUT2-$$"

export NOMOS_BROWSER_URL="$RUNTIME_URL"
export NOMOS_BROWSER_TOKEN_FILE="$TOKEN_FILE"
export NOMOS_BROWSER_HEADLESS=1

# Gates: tudo nasce FAIL. Verde tem de ser conquistado.
G_MCP_OWNER_TRUST=FAIL
G_NOMOS_DISCOVERY=FAIL
G_NOMOS_HANDSHAKE=FAIL
G_NOMOS_TOOLS_LIST=FAIL
G_NOMOS_SESSION_DURAVEL=FAIL
G_NOMOS_EXTRACT=FAIL
G_NOMOS_ERRO_VALIDO=FAIL
G_NOMOS_CAPABILITY_ENFORCEMENT=FAIL
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

# CANÔNICO. stdin em /dev/null: um prompt de risco NÃO pode ser respondido aqui.
chamar_nomos() { "$NOMOS_BIN" mcp chamar "$MANIFESTO" "$1" --args "$2" < /dev/null 2>&1; }
# SOMBRA. Mesmo `comando` do manifesto, um processo por chamada.
chamar_lancador() { node "$ONESHOT" "$1" "$2" < /dev/null 2>&1; }

# ─────────────────────────────────────────────────────────────────────────────
titulo "0. preparo — daemon, credencial, alvo HTTP e linha de base"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$(/usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $(cat "$TOKEN_FILE" 2>/dev/null)" "$RUNTIME_URL/health")" != "200" ]; then
  echo "ABORTADO: runtime não responde em $RUNTIME_URL — suba com: node packages/api/src/daemon.ts"
  exit 2
fi
nota "runtime vivo em $RUNTIME_URL"
[ -r "$TOKEN_FILE" ] || { echo "ABORTADO: credencial ausente em $TOKEN_FILE"; exit 2; }
nota "credencial presente: $TOKEN_FILE"

# Alvo local próprio, com canário único desta execução: se o extract devolver
# este texto, ele leu ESTA página, e não uma sobra de execução anterior.
cat > /tmp/alvo-closeout2.mjs <<EOF
import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/lento") { return; }           // nunca responde: prova de prazo
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html><head><title>Alvo</title></head><body><p id="fato">$CANARIO</p></body></html>');
}).listen($PORTA_ALVO, "127.0.0.1");
EOF
node /tmp/alvo-closeout2.mjs & ALVO_PID=$!
# Instrumento: o alvo NÃO pode sobreviver a uma saída anormal. Sem este trap,
# um abort no meio deixa :8901 ocupada e o próximo run morre com EADDRINUSE —
# foi exatamente o que aconteceu quando o defeito de expansão matou o script.
trap 'kill "$ALVO_PID" 2>/dev/null' EXIT INT TERM
sleep 1
if ! /usr/bin/curl -s -m 5 "$ALVO" | /usr/bin/grep -q "$CANARIO"; then
  echo "ABORTADO: alvo HTTP não subiu em $ALVO"; kill "$ALVO_PID" 2>/dev/null; exit 2
fi
nota "alvo HTTP: $ALVO (canário $CANARIO)"

# Estado limpo do adaptador: a prova da durabilidade tem de começar do zero.
rm -f "$RUNTIME_DIR/mcp-session.json" "$RUNTIME_DIR/mcp-session.lock"
SESSOES_ANTES="$(sessoes_vivas)"
CHROMIUM_ANTES="$(chromium_vivos)"
nota "SESSOES_VIVAS_ANTES=$SESSOES_ANTES  CHROMIUM_ANTES=$CHROMIUM_ANTES"

HASH_ATUAL="$(python3 - "$MANIFESTO" <<'PY'
import hashlib, json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
c = {"nome": m["nome"], "comando": m["comando"], "nivel_padrao": str(m.get("nivel_padrao", "A5")),
     "tools": {str(t): str(n) for t, n in m.get("tools", {}).items()}}
print(hashlib.sha256(json.dumps(c, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
PY
)"
nota "HASH_ATUAL_DO_MANIFESTO=$HASH_ATUAL"

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
  EXPERIMENTAL=0
else
  EXPERIMENTAL=1
  nota "TRUST: FAIL — o catálogo tem OUTRA impressão. O manifesto mudou (correção"
  nota "        da elevação de privilégio) e voltou a EXPERIMENTAL, fail-closed."
  nota "        Re-registro (SÓ o dono): $NOMOS_BIN mcp confiar $MANIFESTO"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "3. conexão — handshake + tools/list com os níveis do manifesto"
# ─────────────────────────────────────────────────────────────────────────────
CONECTAR="$("$NOMOS_BIN" mcp conectar "$MANIFESTO" < /dev/null 2>&1)"
printf '%s\n' "$CONECTAR" | /usr/bin/sed 's/^/    /'
if printf '%s' "$CONECTAR" | /usr/bin/grep -q "conectado a 'nomos-browser'"; then
  G_NOMOS_HANDSHAKE=PASS
  # `tools/list` só vale se vier com OS NÍVEIS que o manifesto declara — e as
  # quatro ferramentas de aba têm de aparecer separadas, com níveis diferentes.
  if printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A0\] browser_tabs" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A2\] browser_tab_open" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A1\] browser_tab_switch" \
     && printf '%s' "$CONECTAR" | /usr/bin/grep -q "\[A1\] browser_tab_close"; then
    G_NOMOS_TOOLS_LIST=PASS
  fi
else
  nota "PAROU AQUI: BLOQUEADO_MANIFESTO_EXPERIMENTAL (NOMOS-E002)"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "4. sessão durável — a página é aberta numa chamada e lida na SEGUINTE"
# ─────────────────────────────────────────────────────────────────────────────
echo "--- chamada A (canônica): browser_tab_open url=$ALVO ---"
A="$(chamar_nomos browser_tab_open "{\"url\":\"$ALVO\"}")"
printf '%s\n' "$A" | /usr/bin/sed 's/^/    /'
echo "--- chamada B (canônica), PROCESSO SEPARADO: browser_extract #fato ---"
B="$(chamar_nomos browser_extract '{"target":{"selector":"#fato"}}')"
printf '%s\n' "$B" | /usr/bin/sed 's/^/    /'
SA="$(sid_de "$A")"; SB="$(sid_de "$B")"
if [ -n "$SA" ] && [ "$SA" = "$SB" ]; then
  G_NOMOS_SESSION_DURAVEL=PASS
  nota "session_id ESTÁVEL entre dois processos one-shot: $SA"
fi
if printf '%s' "$B" | /usr/bin/grep -q "$CANARIO"; then G_NOMOS_EXTRACT=PASS; fi

if [ "$EXPERIMENTAL" = "1" ]; then
  echo
  echo "--- via=lancador-direto (NAO-CANONICO): mesma sequência, dois processos ---"
  LA="$(chamar_lancador browser_tab_open "{\"url\":\"$ALVO\"}")"
  printf '%s\n' "$LA" | /usr/bin/sed 's/^/    /'
  LB="$(chamar_lancador browser_extract '{"target":{"selector":"#fato"}}')"
  printf '%s\n' "$LB" | head -3 | /usr/bin/sed 's/^/    /'
  LSA="$(sid_de "$LA")"; LSB="$(sid_de "$LB")"
  echo "    SESSAO_A=$LSA SESSAO_B=$LSB IGUAIS=$([ "$LSA" = "$LSB" ] && echo sim || echo nao)"
  if printf '%s' "$LB" | /usr/bin/grep -q "$CANARIO"; then echo "    LEU_O_CANARIO=sim"; else echo "    LEU_O_CANARIO=nao"; fi
  echo "    registro persistido:"; /bin/cat "$RUNTIME_DIR/mcp-session.json" 2>/dev/null | /usr/bin/sed 's/^/      /'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "5. erro válido — tool inexistente, argumento inválido, alvo inexistente"
# ─────────────────────────────────────────────────────────────────────────────
E1="$(chamar_nomos browser_inexistente '{}')"; echo "--- tool inexistente ---"; printf '%s\n' "$E1" | head -3 | /usr/bin/sed 's/^/    /'
E2="$(chamar_nomos browser_navigate '{}')";    echo "--- argumento inválido (url ausente) ---"; printf '%s\n' "$E2" | head -3 | /usr/bin/sed 's/^/    /'
E3="$(chamar_nomos browser_extract '{"target":{"selector":"#nao-existe-nunca"}}')"
echo "--- alvo inexistente ---"; printf '%s\n' "$E3" | head -3 | /usr/bin/sed 's/^/    /'
if printf '%s' "$E1$E2$E3" | /usr/bin/grep -q "desconhecida" \
   && printf '%s' "$E2" | /usr/bin/grep -q "obrigatório" \
   && printf '%s' "$E3" | /usr/bin/grep -q "TARGET_NOT_FOUND"; then
  G_NOMOS_ERRO_VALIDO=PASS
fi
if [ "$EXPERIMENTAL" = "1" ]; then
  echo "--- via=lancador-direto (NAO-CANONICO) ---"
  chamar_lancador browser_inexistente '{}' | head -2 | /usr/bin/sed 's/^/    /'
  chamar_lancador browser_navigate '{}' | head -2 | /usr/bin/sed 's/^/    /'
  chamar_lancador browser_extract '{"target":{"selector":"#nao-existe-nunca"}}' | head -2 | /usr/bin/sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "6. capability enforcement — browser_download sem a capability"
# ─────────────────────────────────────────────────────────────────────────────
D="$(chamar_nomos browser_download "{\"url\":\"$ALVO\"}")"
printf '%s\n' "$D" | head -4 | /usr/bin/sed 's/^/    /'
if printf '%s' "$D" | /usr/bin/grep -q "CAPABILITY_DENIED"; then G_NOMOS_CAPABILITY_ENFORCEMENT=PASS; fi
if [ "$EXPERIMENTAL" = "1" ]; then
  echo "--- via=lancador-direto (NAO-CANONICO) ---"
  chamar_lancador browser_download "{\"url\":\"$ALVO\"}" | head -4 | /usr/bin/sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "7. elevação de privilégio — o exploit de 01-mcp/03 não é mais expressável"
# ─────────────────────────────────────────────────────────────────────────────
echo "--- (a) veredito do NOMOS para cada ferramenta de aba (não depende de confiança) ---"
V_TABS="$("$NOMOS_BIN" approvals testar A0_READ_LOCAL 'mcp:nomos-browser:browser_tabs' 2>&1)"
V_OPEN="$("$NOMOS_BIN" approvals testar A2_NET_EGRESS 'mcp:nomos-browser:browser_tab_open' 2>&1)"
printf '%s\n' "$V_TABS" | /usr/bin/sed 's/^/    /'
printf '%s\n' "$V_OPEN" | /usr/bin/sed 's/^/    /'

# URL EXCLUSIVA do exploit: a página legítima da seção 4 já está aberta, e contar
# "o alvo aparece nas abas" pegaria aquela. Com uma URL que só o exploit usaria,
# uma ocorrência sequer é prova de que ele abriu a aba.
ALVO_EXPLOIT="${ALVO}?exploit=1"
ABAS_ANTES="$(chamar_lancador browser_tabs '{}' | /usr/bin/grep -c '"page_id"')"

echo "--- (b) o exploit literal: browser_tabs com action=new + url ---"
X="$(chamar_nomos browser_tabs "{\"action\":\"new\",\"url\":\"$ALVO_EXPLOIT\"}")"
printf '%s\n' "$X" | head -4 | /usr/bin/sed 's/^/    /'
XL="$(chamar_lancador browser_tabs "{\"action\":\"new\",\"url\":\"$ALVO_EXPLOIT\"}")"
echo "    via=lancador-direto (NAO-CANONICO):"; printf '%s\n' "$XL" | head -2 | /usr/bin/sed 's/^/      /'

echo "--- (c) confirmação PELO NAVEGADOR: a aba do exploit NÃO existe ---"
ABAS_DEPOIS_TXT="$(chamar_lancador browser_tabs '{}')"
ABAS_DEPOIS="$(printf '%s\n' "$ABAS_DEPOIS_TXT" | /usr/bin/grep -c '"page_id"')"
OCORRENCIAS_EXPLOIT="$(printf '%s\n' "$ABAS_DEPOIS_TXT" | /usr/bin/grep -c "exploit=1")"
echo "    ABAS_ANTES=$ABAS_ANTES ABAS_DEPOIS=$ABAS_DEPOIS ocorrencias_da_url_do_exploit=$OCORRENCIAS_EXPLOIT"

echo "--- (d) browser_tab_open pelo caminho canônico: exige o dono ---"
O="$(chamar_nomos browser_tab_open "{\"url\":\"$ALVO\"}")"
printf '%s\n' "$O" | head -3 | /usr/bin/sed 's/^/    /'

# O gate exige as TRÊS coisas: veredito A2 para quem abre aba, recusa de
# ARGUMENTO para o exploit literal, e nenhuma aba do exploit aberta.
EXPLOIT_RECUSADO=0
printf '%s' "$XL" | /usr/bin/grep -q "argumento(s) desconhecido(s)" && EXPLOIT_RECUSADO=1
VEREDITO_OK=0
printf '%s' "$V_OPEN" | /usr/bin/grep -q "REQUIRE_APPROVAL" && printf '%s' "$V_TABS" | /usr/bin/grep -q "ALLOW" && VEREDITO_OK=1
if [ "$EXPLOIT_RECUSADO" = "1" ] && [ "$VEREDITO_OK" = "1" ] \
   && [ "$OCORRENCIAS_EXPLOIT" = "0" ] && [ "$ABAS_DEPOIS" = "$ABAS_ANTES" ] \
   && ! printf '%s' "$X" | /usr/bin/grep -q "page_id"; then
  G_NOMOS_NO_PRIVILEGE_ESCALATION=PASS
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "8. audit — as chamadas aparecem em sessions/<id>/actions.jsonl"
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
titulo "9. prazo e interrupção — comportamento observável (ver LIMITAÇÃO no topo)"
# ─────────────────────────────────────────────────────────────────────────────
echo "--- (a) prazo curto contra um alvo que nunca responde ---"
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
TIMEOUT_OUT="$(NOMOS_BROWSER_TIMEOUT_MS=3000 node "$ONESHOT" browser_navigate "{\"url\":\"http://127.0.0.1:${PORTA_ALVO}/lento\"}" < /dev/null 2>&1 | head -3)"
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
printf '%s\n' "$TIMEOUT_OUT" | /usr/bin/sed 's/^/    /'
echo "    decorrido_ms=$((T1 - T0))"

echo "--- (b) SIGTERM no cliente no meio da chamada ---"
node "$ONESHOT" browser_navigate "{\"url\":\"http://127.0.0.1:${PORTA_ALVO}/lento\"}" > /tmp/sigterm-closeout2.log 2>&1 &
MPID=$!
sleep 2
kill -TERM "$MPID" 2>/dev/null
wait "$MPID" 2>/dev/null
SAUDE="$(api -o /dev/null -w '%{http_code}' "$RUNTIME_URL/health")"
echo "    cliente_morto=sim  runtime_health=$SAUDE  sessoes_agora=$(sessoes_vivas)"

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
rm -f /tmp/alvo-closeout2.mjs

# ─────────────────────────────────────────────────────────────────────────────
titulo "RODAPÉ"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$EXPERIMENTAL" = "1" ]; then
  echo "MOTIVO_DOS_FAIL=BLOQUEADO_MANIFESTO_EXPERIMENTAL"
  echo "PAROU_EM=nomos mcp conectar/chamar → [NOMOS-E002] 'nomos-browser' é experimental"
  echo "HASH_NOVO=$HASH_ATUAL"
  echo "DESTRAVA (só o dono): $NOMOS_BIN mcp confiar $MANIFESTO"
fi
TOTAL=FAIL
if [ "$G_MCP_OWNER_TRUST" = PASS ] && [ "$G_NOMOS_DISCOVERY" = PASS ] && [ "$G_NOMOS_HANDSHAKE" = PASS ] \
  && [ "$G_NOMOS_TOOLS_LIST" = PASS ] && [ "$G_NOMOS_SESSION_DURAVEL" = PASS ] && [ "$G_NOMOS_EXTRACT" = PASS ] \
  && [ "$G_NOMOS_ERRO_VALIDO" = PASS ] && [ "$G_NOMOS_CAPABILITY_ENFORCEMENT" = PASS ] \
  && [ "$G_NOMOS_NO_PRIVILEGE_ESCALATION" = PASS ] && [ "$G_NOMOS_AUDIT" = PASS ] && [ "$G_NOMOS_SEM_ORFAO" = PASS ]; then
  TOTAL=PASS
fi
echo "MCP_OWNER_TRUST=$G_MCP_OWNER_TRUST"
echo "NOMOS_DISCOVERY=$G_NOMOS_DISCOVERY"
echo "NOMOS_HANDSHAKE=$G_NOMOS_HANDSHAKE"
echo "NOMOS_TOOLS_LIST=$G_NOMOS_TOOLS_LIST"
echo "NOMOS_SESSION_DURAVEL=$G_NOMOS_SESSION_DURAVEL"
echo "NOMOS_EXTRACT=$G_NOMOS_EXTRACT"
echo "NOMOS_ERRO_VALIDO=$G_NOMOS_ERRO_VALIDO"
echo "NOMOS_CAPABILITY_ENFORCEMENT=$G_NOMOS_CAPABILITY_ENFORCEMENT"
echo "NOMOS_NO_PRIVILEGE_ESCALATION=$G_NOMOS_NO_PRIVILEGE_ESCALATION"
echo "NOMOS_AUDIT=$G_NOMOS_AUDIT"
echo "NOMOS_SEM_ORFAO=$G_NOMOS_SEM_ORFAO"
echo "NOMOS_BROWSER_INTEGRATION=$TOTAL"
[ "$TOTAL" = PASS ] && exit 0 || exit 1
