#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GATE HUMANO A1 — a única prova desta release que EU não consigo produzir.
#
# Tudo nesta bateria roda sozinho, menos uma coisa: alguém tem de digitar
# `APROVO` num terminal de verdade. Não há truque que substitua isso, e procurar
# um seria trair o que o produto inteiro existe para garantir.
#
# A AÇÃO ESCOLHIDA, e por quê: `browser_tab_switch` — nível `A1_WRITE_LOCAL`.
#   · segura ......... troca o foco entre duas abas que já existem
#   · reversível ..... a bateria troca de volta no fim e confere
#   · sem egresso .... as duas abas nascem em branco, nenhuma URL é visitada
#   · sem exclusão ... nada é apagado; `browser_tab_close` foi descartada por isso
#   · observável ..... `browser_tabs` (A0) mostra qual aba está ativa, antes e depois
#
# SETE PROVAS:
#   1. sem aprovação (sem TTY) ....................... NEGADO
#   2. aprovação incorreta (TTY, palavra errada) ..... NEGADO
#   3. `APROVO` real digitado pelo dono .............. EXECUTADO
#   4. a aprovação aparece na trilha ................. AUDITADO
#   5. o executado é exatamente o pedido ............. ESCOPO EXATO
#   6. nada de A2/A5 passou junto ou depois .......... SEM ELEVAÇÃO
#   7. o caminho foi o canônico, não um atalho ....... SEM BYPASS
#
# Uso — NO TERMINAL DO DONO (precisa de TTY):
#   bash evidence/nomos-browser-ga/01-gate-humano/gate-humano-a1.sh
#
# Só as partes 1 e 2 podem rodar sem TTY; nesse caso a bateria para e diz.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$RAIZ"
AQUI="$(cd "$(dirname "$0")" && pwd)"
NOMOS_BIN="${NOMOS_BIN:-/Users/AI/.local/bin/nomos}"
MANIFESTO="$RAIZ/packaging/mcp/manifesto.json"
LANCADOR="$RAIZ/evidence/nomos-browser-final-closeout/02-integracao/oneshot-lancador.mjs"
RESPONDER="$AQUI/responder-num-tty.py"
# Porta e diretório PRÓPRIOS: este gate não pode disputar o `daemon.lock` nem a
# porta 7777 com o resto da bateria de release. Ele sobe o que precisa e derruba
# no fim — a máquina volta como estava.
PORTA="${PORTA_GATE_A1:-7789}"
RUNTIME_URL="http://127.0.0.1:$PORTA"
RUNTIME_DIR="${NOMOS_BROWSER_RUNTIME_DIR:-/tmp/ga-gate-a1}"
TOKEN_FILE="$RUNTIME_DIR/control-token"
TRILHA_NOMOS="$HOME/.nomos/logs/audit.jsonl"

export NOMOS_BROWSER_URL="$RUNTIME_URL"
export NOMOS_BROWSER_TOKEN_FILE="$TOKEN_FILE"
export NOMOS_BROWSER_HEADLESS=1

# Tudo nasce FAIL.
G_SEM_APROVACAO=FAIL
G_APROVACAO_INVALIDA=FAIL
G_APROVO_REAL=FAIL
G_AUDITADO=FAIL
G_ESCOPO=FAIL
G_SEM_ELEVACAO=FAIL
G_SEM_BYPASS=FAIL

titulo() { printf '\n\033[1m══ %s ══════════════════════\033[0m\n' "$1"; }
nota()   { printf '  · %s\n' "$1"; }

chamar_nomos_sem_tty() {
  "$NOMOS_BIN" mcp chamar "$MANIFESTO" "$1" --args "$2" < /dev/null 2>&1
}
# A0: leitura, roda sem incomodar ninguém. É o nosso instrumento de medida.
abas_json() { "$NOMOS_BIN" mcp chamar "$MANIFESTO" browser_tabs --args '{}' < /dev/null 2>&1; }

ativa_agora() {
  abas_json | python3 -c '
import sys, json, re
bruto = sys.stdin.read()
i = bruto.find("[")
try:
    abas = json.loads(bruto[i:])
    print(next((a["page_id"] for a in abas if a.get("active")), "?"))
except Exception:
    print("?")
'
}
ids_das_abas() {
  abas_json | python3 -c '
import sys, json
bruto = sys.stdin.read(); i = bruto.find("[")
try:
    print(" ".join(a["page_id"] for a in json.loads(bruto[i:])))
except Exception:
    print("")
'
}
linhas_trilha_runtime() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

# ─────────────────────────────────────────────────────────────────────────────
titulo "0. preparo — daemon, sessão MCP e DUAS abas em branco"
# ─────────────────────────────────────────────────────────────────────────────
DAEMON_PID=""
parar_daemon() { [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null; }
trap 'parar_daemon' EXIT INT TERM

saude() {
  /usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' \
    -H "authorization: Bearer $(cat "$TOKEN_FILE" 2>/dev/null)" "$RUNTIME_URL/health"
}
if [ "$(saude)" != "200" ]; then
  nota "subindo um daemon só para este gate em $RUNTIME_URL"
  mkdir -p "$RUNTIME_DIR" /tmp/ga-gate-a1-sessoes
  NOMOS_BROWSER_PORT="$PORTA" NOMOS_BROWSER_HEADLESS=true \
  NOMOS_RUNTIME_DIR="$RUNTIME_DIR" NOMOS_SESSIONS_ROOT="/tmp/ga-gate-a1-sessoes" \
    node packages/api/src/daemon.ts > /tmp/ga-gate-a1-daemon.log 2>&1 &
  DAEMON_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 1
    [ "$(saude)" = "200" ] && break
  done
fi
if [ "$(saude)" != "200" ]; then
  echo "ABORTADO: não consegui subir o runtime em $RUNTIME_URL"
  tail -8 /tmp/ga-gate-a1-daemon.log 2>/dev/null | sed 's/^/    /'
  exit 2
fi
nota "runtime vivo em $RUNTIME_URL"

# A segunda aba nasce EM BRANCO (sem `url`): nenhuma rede é tocada. Ainda assim
# `browser_tab_open` é A2 no manifesto, e o NOMOS a negaria aqui — por isso o
# preparo usa o LANÇADOR, rotulado, e NÃO conta como prova de gate nenhum.
IDS_ANTES="$(ids_das_abas)"
N_ANTES="$(printf '%s' "$IDS_ANTES" | wc -w | tr -d ' ')"
if [ "$N_ANTES" -lt 2 ]; then
  nota "setup=lancador (NAO-CANONICO): abrindo uma segunda aba em branco"
  node "$LANCADOR" browser_tab_open '{}' < /dev/null > /tmp/gate-a1-setup.log 2>&1
  sed 's/^/      /' /tmp/gate-a1-setup.log | head -3
fi

IDS="$(ids_das_abas)"
ABA_1="$(printf '%s' "$IDS" | cut -d' ' -f1)"
ABA_2="$(printf '%s' "$IDS" | cut -d' ' -f2)"
ATIVA_INICIAL="$(ativa_agora)"
nota "abas: $IDS"
nota "ativa no início: $ATIVA_INICIAL"

if [ -z "$ABA_2" ] || [ "$ABA_1" = "$ABA_2" ]; then
  echo "ABORTADO: preciso de DUAS abas distintas para que a troca seja observável."
  exit 2
fi

# O ALVO da troca é sempre a aba que NÃO está ativa. Assim "não aconteceu nada"
# e "aconteceu" são estados diferentes e visíveis, e não uma questão de fé.
if [ "$ATIVA_INICIAL" = "$ABA_1" ]; then ALVO="$ABA_2"; else ALVO="$ABA_1"; fi
nota "alvo da troca: $ALVO  (a aba que NÃO está ativa)"

SID="$(python3 -c '
import json, os, sys
p = os.path.expanduser("~/.nomos-browser/mcp-session.json")
try: print(json.load(open(p))["session_id"])
except Exception: print("")
')"
TRILHA="/tmp/ga-gate-a1-sessoes/$SID/actions.jsonl"
[ -f "$TRILHA" ] || TRILHA="$RAIZ/sessions/$SID/actions.jsonl"
nota "sessão MCP: $SID"
nota "trilha do runtime: $TRILHA"

ARGS="{\"page_id\":\"$ALVO\"}"

# ─────────────────────────────────────────────────────────────────────────────
titulo "1. SEM APROVAÇÃO — sem TTY, o gate tem de negar"
# ─────────────────────────────────────────────────────────────────────────────
R1="$(chamar_nomos_sem_tty browser_tab_switch "$ARGS")"
printf '%s\n' "$R1" | head -3 | sed 's/^/    /'
ATIVA_1="$(ativa_agora)"
echo "    ativa depois: $ATIVA_1  (tem de continuar $ATIVA_INICIAL)"
if printf '%s' "$R1" | grep -q "NOMOS-E002" && [ "$ATIVA_1" = "$ATIVA_INICIAL" ]; then
  G_SEM_APROVACAO=DENIED
  nota "negado E nada mudou — negativa sem efeito colateral"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "2. APROVAÇÃO INCORRETA — com TTY, palavra errada, o gate tem de negar"
# ─────────────────────────────────────────────────────────────────────────────
# Sem pty este caso não seria testável, e viraria suposição. O utilitário se
# recusa a digitar `APROVO` — a checagem está no código dele.
NEGOU_ERRADA=0
for PALAVRA in "NAO" "APROVADO" "aprovo"; do
  echo "--- resposta digitada: '$PALAVRA' ---"
  R2="$(python3 "$RESPONDER" "$PALAVRA" -- "$NOMOS_BIN" mcp chamar "$MANIFESTO" browser_tab_switch --args "$ARGS" 2>&1)"
  printf '%s\n' "$R2" | grep -E "APROVAÇÃO NECESSÁRIA|NOMOS-E002|\[TTY\]" | head -3 | sed 's/^/    /'
  A="$(ativa_agora)"
  if printf '%s' "$R2" | grep -q "NOMOS-E002" && [ "$A" = "$ATIVA_INICIAL" ]; then
    NEGOU_ERRADA=$((NEGOU_ERRADA+1))
    echo "    NEGADO, e a aba ativa continua $A"
  else
    echo "    ⚠ NÃO NEGOU (ou algo mudou): ativa=$A"
  fi
done
echo "    negadas: $NEGOU_ERRADA de 3"
[ "$NEGOU_ERRADA" = "3" ] && G_APROVACAO_INVALIDA=DENIED

# Nota: 'aprovo' minúsculo entra aqui de propósito. O NOMOS compara com
# `resp.strip() != "APROVO"`, então minúscula É resposta errada — e provar isso
# é provar que o gate não afrouxa o que ele mesmo escreveu.

# ─────────────────────────────────────────────────────────────────────────────
titulo "3. APROVO REAL — daqui em diante quem decide é você"
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo
  echo "  PARADO AQUI. Não há terminal interativo nesta execução, e o NOMOS"
  echo "  exige um. Isso não é falha: é o gate funcionando."
  echo
  echo "  Rode ESTE MESMO comando no seu Terminal para fechar o gate:"
  echo "      cd $RAIZ"
  echo "      bash evidence/nomos-browser-ga/01-gate-humano/gate-humano-a1.sh"
  echo
  echo "  Quando o NOMOS perguntar, digite:  APROVO"
  echo
  echo "SEM_APROVACAO=$G_SEM_APROVACAO"
  echo "APROVACAO_INVALIDA=$G_APROVACAO_INVALIDA"
  echo "APROVO_REAL=PENDENTE_DONO"
  echo "HUMAN_A1_GATE=PENDENTE_DONO"
  exit 3
fi

LINHAS_ANTES="$(linhas_trilha_runtime "$TRILHA")"
NOMOS_ANTES="$(linhas_trilha_runtime "$TRILHA_NOMOS")"

echo
echo "  ┌────────────────────────────────────────────────────────────────┐"
echo "  │  O NOMOS vai pedir sua aprovação para UMA ação:                 │"
echo "  │                                                                │"
echo "  │     trocar o foco para a aba $ALVO"
echo "  │     categoria A1_WRITE_LOCAL · sem rede · sem exclusão          │"
echo "  │                                                                │"
echo "  │  Digite exatamente:  APROVO                                    │"
echo "  │  Qualquer outra coisa nega — e isso já foi provado acima.       │"
echo "  └────────────────────────────────────────────────────────────────┘"
echo

"$NOMOS_BIN" mcp chamar "$MANIFESTO" browser_tab_switch --args "$ARGS" 2>&1 | tee /tmp/gate-a1-aprovo.log | sed 's/^/    /'
R3="$(cat /tmp/gate-a1-aprovo.log)"

ATIVA_3="$(ativa_agora)"
echo
echo "    ativa depois da aprovação: $ATIVA_3   (pedido: $ALVO)"
if printf '%s' "$R3" | grep -q "route=browser.switch_tab" && [ "$ATIVA_3" = "$ALVO" ]; then
  G_APROVO_REAL=PASS
  nota "EXECUTOU: a aba ativa é exatamente a que foi aprovada"
elif printf '%s' "$R3" | grep -q "NOMOS-E002"; then
  nota "NEGADO — se você digitou outra coisa, isso está certo. Rode de novo."
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "4. AUDITORIA — a aprovação e a ação deixaram rastro nas DUAS trilhas"
# ─────────────────────────────────────────────────────────────────────────────
# Duas trilhas independentes: a do NOMOS (quem autorizou) e a do runtime (o que
# foi feito). Uma só contando a história seria a palavra de um lado.
echo "--- trilha do NOMOS ($TRILHA_NOMOS) ---"
NOVAS_NOMOS="$(tail -n "+$((NOMOS_ANTES+1))" "$TRILHA_NOMOS" 2>/dev/null)"
printf '%s\n' "$NOVAS_NOMOS" | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l: continue
    try: d = json.loads(l)
    except Exception: continue
    ev = d.get("event", "")
    if "mcp" in ev or "aprov" in ev or "gate" in ev:
        print("    " + json.dumps({k: d.get(k) for k in ("event","server","tool","nivel","ts")}, ensure_ascii=False))
'
echo "--- trilha do runtime ($TRILHA) ---"
NOVAS_RT="$(tail -n "+$((LINHAS_ANTES+1))" "$TRILHA" 2>/dev/null)"
printf '%s\n' "$NOVAS_RT" | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l: continue
    try: d = json.loads(l)
    except Exception: continue
    print("    " + json.dumps({k: d.get(k) for k in ("action","actor","owner","capability","policy_decision","result")}, ensure_ascii=False))
'
OK_NOMOS=0; OK_RT=0
printf '%s' "$NOVAS_NOMOS" | grep -q '"event": *"mcp.client.tool"' && OK_NOMOS=1
printf '%s' "$NOVAS_NOMOS" | grep -q 'browser_tab_switch' && OK_NOMOS=$((OK_NOMOS+1))
printf '%s' "$NOVAS_RT" | grep -q '"action": *"browser.switch_tab"' && OK_RT=1
echo "    nomos_registrou_a_tool=$OK_NOMOS/2   runtime_registrou_a_acao=$OK_RT/1"
[ "$OK_NOMOS" = "2" ] && [ "$OK_RT" = "1" ] && G_AUDITADO=YES

# ─────────────────────────────────────────────────────────────────────────────
titulo "5. ESCOPO — foi feito EXATAMENTE o que foi pedido, e nada mais"
# ─────────────────────────────────────────────────────────────────────────────
ROTAS="$(printf '%s' "$NOVAS_RT" | python3 -c '
import sys, json
acoes = []
for l in sys.stdin:
    l = l.strip()
    if not l: continue
    try: d = json.loads(l)
    except Exception: continue
    a = d.get("action")
    if a: acoes.append(a)
print(",".join(sorted(set(acoes))))
')"
echo "    ações novas na trilha: [$ROTAS]"
# Só uma MUTAÇÃO pode ter acontecido. Leituras e linhas de política são o
# acompanhamento normal de qualquer chamada e não contam como escopo extra.
MUTACOES="$(printf '%s' "$ROTAS" | tr ',' '\n' | grep -vE '^(policy\.allow|policy\.deny|browser\.tabs|session\..*|lease\..*|task\..*)$' | tr '\n' ' ')"
echo "    mutações: [$MUTACOES]"
N_ABAS_DEPOIS="$(ids_das_abas | wc -w | tr -d ' ')"
echo "    nº de abas antes=$(printf '%s' "$IDS" | wc -w | tr -d ' ') depois=$N_ABAS_DEPOIS  (não pode ter nascido nem morrido aba)"
if [ "$(printf '%s' "$MUTACOES" | tr -d ' ')" = "browser.switch_tab" ] \
   && [ "$N_ABAS_DEPOIS" = "$(printf '%s' "$IDS" | wc -w | tr -d ' ')" ]; then
  G_ESCOPO=EXATO
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "6. SEM ELEVAÇÃO — aprovar UMA ação A1 não abre a porta para A2/A5"
# ─────────────────────────────────────────────────────────────────────────────
# O risco real de qualquer gate de aprovação é a aprovação "grudar": você
# autoriza uma coisa e a sessão inteira sobe de nível. Aqui, logo DEPOIS do
# APROVO, tentamos A2 e A5 sem TTY. Têm de continuar negadas.
ELEV=0
for PAR in "browser_navigate:{\"url\":\"http://127.0.0.1:9/nada\"}" \
           "browser_tab_open:{}" \
           "browser_task:{\"objetivo\":\"nada\"}"; do
  T="${PAR%%:*}"; A="${PAR#*:}"
  RR="$(chamar_nomos_sem_tty "$T" "$A")"
  if printf '%s' "$RR" | grep -q "NOMOS-E002"; then
    printf '    NEGADA  %-20s\n' "$T"
  else
    ELEV=$((ELEV+1)); printf '    PASSOU  %-20s  ← ELEVAÇÃO SILENCIOSA\n' "$T"
    printf '%s\n' "$RR" | head -2 | sed 's/^/        /'
  fi
done
# E a MESMA tool A1, de novo sem TTY: a aprovação anterior não pode valer duas vezes.
R6="$(chamar_nomos_sem_tty browser_tab_switch "{\"page_id\":\"$ATIVA_INICIAL\"}")"
if printf '%s' "$R6" | grep -q "NOMOS-E002"; then
  echo "    NEGADA  browser_tab_switch (2ª vez, sem TTY) — a aprovação NÃO grudou"
else
  ELEV=$((ELEV+1)); echo "    PASSOU  browser_tab_switch 2ª vez ← A APROVAÇÃO GRUDOU"
fi
echo "    elevações observadas: $ELEV (tem de ser 0)"
[ "$ELEV" = "0" ] && G_SEM_ELEVACAO=NO

# ─────────────────────────────────────────────────────────────────────────────
titulo "7. SEM BYPASS — o caminho foi o canônico, e as duas trilhas concordam"
# ─────────────────────────────────────────────────────────────────────────────
# "Sem bypass" aqui não é fé no código: é as DUAS trilhas contarem a mesma
# história. O NOMOS diz que autorizou a tool; o runtime diz que executou a rota,
# com o ator sendo o principal do MCP. Se alguém tivesse falado direto com o
# runtime, a trilha do NOMOS estaria vazia e a do runtime teria outro ator.
ATOR="$(printf '%s' "$NOVAS_RT" | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l: continue
    try: d = json.loads(l)
    except Exception: continue
    if d.get("action") == "browser.switch_tab":
        print(d.get("owner") or d.get("actor") or "?"); break
else:
    print("?")
')"
echo "    dono da sessão que executou: $ATOR"
echo "    NOMOS autorizou browser_tab_switch: $(printf '%s' "$NOVAS_NOMOS" | grep -c 'browser_tab_switch')"
CONCORDAM=0
printf '%s' "$ATOR" | grep -q "mcp:" && CONCORDAM=$((CONCORDAM+1))
[ "$(printf '%s' "$NOVAS_NOMOS" | grep -c 'browser_tab_switch')" -ge 1 ] && CONCORDAM=$((CONCORDAM+1))
echo "    trilhas concordantes: $CONCORDAM/2"
[ "$CONCORDAM" = "2" ] && G_SEM_BYPASS=NO

# ─────────────────────────────────────────────────────────────────────────────
titulo "8. REVERSÃO — devolver o foco à aba original (a ação era reversível)"
# ─────────────────────────────────────────────────────────────────────────────
# Reversível não é adjetivo de brochura: ou se demonstra, ou não vale. A volta
# precisa da sua aprovação também — o gate não faz exceção para desfazer.
if [ "$G_APROVO_REAL" = "PASS" ] && [ "$ATIVA_3" != "$ATIVA_INICIAL" ]; then
  echo "  Uma segunda aprovação, para devolver o foco a $ATIVA_INICIAL."
  echo "  Digite APROVO de novo (ou qualquer outra coisa para deixar como está)."
  echo
  "$NOMOS_BIN" mcp chamar "$MANIFESTO" browser_tab_switch \
    --args "{\"page_id\":\"$ATIVA_INICIAL\"}" 2>&1 | sed 's/^/    /'
  ATIVA_FIM="$(ativa_agora)"
  echo "    ativa no fim: $ATIVA_FIM  (início: $ATIVA_INICIAL)"
  [ "$ATIVA_FIM" = "$ATIVA_INICIAL" ] && nota "revertido" || nota "não revertido — a troca segue válida, só não voltou"
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "RODAPÉ"
# ─────────────────────────────────────────────────────────────────────────────
echo "TOOL=browser_tab_switch  NIVEL=A1_WRITE_LOCAL  ALVO=$ALVO"
echo "A1_WITHOUT_APPROVAL=$G_SEM_APROVACAO"
echo "A1_INVALID_APPROVAL=$G_APROVACAO_INVALIDA"
echo "A1_WITH_REAL_APROVO=$G_APROVO_REAL"
echo "APPROVAL_AUDITED=$G_AUDITADO"
echo "SCOPE_EXACT=$G_ESCOPO"
echo "PRIVILEGE_BYPASS=$G_SEM_BYPASS"
echo "SILENT_ELEVATION=$G_SEM_ELEVACAO"

if [ "$G_SEM_APROVACAO" = "DENIED" ] && [ "$G_APROVACAO_INVALIDA" = "DENIED" ] \
   && [ "$G_APROVO_REAL" = "PASS" ] && [ "$G_AUDITADO" = "YES" ] \
   && [ "$G_ESCOPO" = "EXATO" ] && [ "$G_SEM_ELEVACAO" = "NO" ] && [ "$G_SEM_BYPASS" = "NO" ]; then
  echo "HUMAN_A1_GATE=PASS"
  exit 0
fi
echo "HUMAN_A1_GATE=FAIL"
exit 1
