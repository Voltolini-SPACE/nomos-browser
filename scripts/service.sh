#!/usr/bin/env bash
# FASE 14 — SUPERVISÃO E ARRANQUE (macOS LaunchAgent)
#
# Este produto não tinha supervisor algum: o daemon subia à mão e morria com o
# terminal. Este script é o que falta entre "roda quando eu mando" e "está de pé
# porque a máquina está de pé".
#
# A REGRA QUE MANDA AQUI: NÃO ENCOSTE NO QUE NÃO É NOSSO.
# ------------------------------------------------------
# Esta máquina roda serviços NOMOS de produção — `br.com.se7enpay.nomos.servico`,
# `com.nomos.panel`, `ai.sovereign.omniroute`, `com.gijarvis.backend`. Um
# `launchctl bootout` no alvo errado derruba o negócio do dono. Por isso:
#
#   · label PRÓPRIA (`ai.nomos.browser`), que não colide com nenhuma delas;
#   · `install` RECUSA se a label já existir e o plist não for o nosso;
#   · `uninstall` só descarrega a NOSSA label, e só se o plist no NOSSO caminho
#     existir e declarar essa label;
#   · nenhum comando aqui itera sobre serviços de terceiros. Nunca.
#
# Uso: scripts/service.sh <install|uninstall|start|stop|restart|status|health|logs>
set -uo pipefail

LABEL="ai.nomos.browser"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$RAIZ/packaging/launchd/$LABEL.plist"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="${NOMOS_BROWSER_LOG_DIR:-$HOME/Library/Logs/nomos-browser}"
RUNTIME_DIR="${NOMOS_RUNTIME_DIR:-$HOME/.nomos-browser}"
SESSIONS_ROOT="${NOMOS_SESSIONS_ROOT:-$RAIZ/sessions}"
PORT="${NOMOS_BROWSER_PORT:-7777}"
HEADLESS="${NOMOS_BROWSER_HEADLESS:-true}"
LOCK="$RUNTIME_DIR/daemon.lock"
DOMINIO="gui/$(id -u)"
ALVO="$DOMINIO/$LABEL"

# Labels de PRODUÇÃO que este script jamais pode tocar. A lista existe para que a
# proibição seja verificável, não só prometida.
INTOCAVEIS="br.com.se7enpay.nomos.servico com.nomos.panel ai.sovereign.omniroute com.gijarvis.backend"

erro() { printf '%s\n' "erro: $*" >&2; }
info() { printf '%s\n' "$*"; }

# ─────────────────────────────────────────────────────────────────────────────

guarda_label() {
  # Recusa qualquer operação sobre uma label que não seja a nossa. É a rede
  # contra um erro de digitação virar incidente de produção.
  for proibida in $INTOCAVEIS; do
    if [ "$LABEL" = "$proibida" ]; then
      erro "LABEL=$LABEL é de um serviço de PRODUÇÃO. Abortado."
      exit 4
    fi
  done
}

label_carregada() {
  /bin/launchctl print "$ALVO" >/dev/null 2>&1
}

plist_e_nosso() {
  # "Nosso" = existe no NOSSO caminho e declara a NOSSA label. Um plist de
  # terceiro com a mesma label estaria em outro caminho e não passa aqui.
  [ -f "$PLIST" ] || return 1
  /usr/bin/plutil -extract Label raw "$PLIST" 2>/dev/null | /usr/bin/grep -qx "$LABEL"
}

pid_do_lock() {
  [ -f "$LOCK" ] || return 1
  /usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$LOCK" 2>/dev/null
}

vivo() {
  local pid; pid="$(pid_do_lock)" || return 1
  [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null
}

porta_ocupada() {
  /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

token() {
  [ -f "$RUNTIME_DIR/control-token" ] && /bin/cat "$RUNTIME_DIR/control-token"
}

# ─────────────────────────────────────────────────────────────────────────────

cmd_install() {
  guarda_label
  [ -f "$PLIST_TEMPLATE" ] || { erro "template ausente: $PLIST_TEMPLATE"; exit 2; }

  # ── a recusa que protege o vizinho ──────────────────────────────────────
  if label_carregada && ! plist_e_nosso; then
    erro "a label $LABEL já está carregada e o plist em $PLIST não é nosso."
    erro "recuso instalar por cima: isso derrubaria um serviço que não instalei."
    exit 4
  fi
  if [ -f "$PLIST" ] && ! plist_e_nosso; then
    erro "$PLIST existe e declara outra label. Recuso sobrescrever."
    exit 4
  fi

  local node_bin; node_bin="$(command -v node)"
  [ -n "$node_bin" ] || { erro "node não encontrado no PATH"; exit 2; }

  /bin/mkdir -p "$AGENTS_DIR" "$LOG_DIR" "$RUNTIME_DIR" "$SESSIONS_ROOT"
  /bin/chmod 700 "$RUNTIME_DIR"

  /usr/bin/sed \
    -e "s#@LABEL@#$LABEL#g" \
    -e "s#@NODE@#$node_bin#g" \
    -e "s#@DAEMON@#$RAIZ/packages/api/src/daemon.ts#g" \
    -e "s#@REPO@#$RAIZ#g" \
    -e "s#@RUNTIME_DIR@#$RUNTIME_DIR#g" \
    -e "s#@SESSIONS_ROOT@#$SESSIONS_ROOT#g" \
    -e "s#@LOG_DIR@#$LOG_DIR#g" \
    -e "s#@PORT@#$PORT#g" \
    -e "s#@HEADLESS@#$HEADLESS#g" \
    -e "s#@PATH@#$PATH#g" \
    -e "s#@HOME@#$HOME#g" \
    "$PLIST_TEMPLATE" > "$PLIST.tmp" || { erro "falha ao renderizar o template"; exit 1; }

  # Plist malformado carregado é serviço que "some" sem dizer por quê.
  if ! /usr/bin/plutil -lint "$PLIST.tmp" >/dev/null 2>&1; then
    erro "plist renderizado é inválido — não instalo:"; /usr/bin/plutil -lint "$PLIST.tmp" >&2
    /bin/rm -f "$PLIST.tmp"; exit 1
  fi
  /bin/mv "$PLIST.tmp" "$PLIST"

  # Se já estava carregado (nosso), descarrega antes para pegar o plist novo.
  if label_carregada; then /bin/launchctl bootout "$ALVO" >/dev/null 2>&1; fi
  if ! /bin/launchctl bootstrap "$DOMINIO" "$PLIST" 2>/tmp/nomos-bootstrap.err; then
    erro "launchctl bootstrap falhou: $(/bin/cat /tmp/nomos-bootstrap.err)"
    exit 1
  fi
  info "INSTALL=OK label=$LABEL plist=$PLIST log=$LOG_DIR"
}

cmd_uninstall() {
  guarda_label
  if label_carregada; then
    if ! plist_e_nosso; then
      erro "a label $LABEL está carregada mas o plist não é nosso — recuso descarregar."
      exit 4
    fi
    /bin/launchctl bootout "$ALVO" >/dev/null 2>&1
  fi
  [ -f "$PLIST" ] && plist_e_nosso && /bin/rm -f "$PLIST"
  # A trava é do processo, não da instalação: se sobrou, é lixo de um daemon
  # morto. O daemon vivo já a removeu no encerramento.
  vivo || /bin/rm -f "$LOCK"
  info "UNINSTALL=OK label=$LABEL plist_removido=$([ -f "$PLIST" ] && echo NAO || echo SIM)"
}

cmd_start() {
  guarda_label
  # ── INSTÂNCIA ÚNICA, conferida ANTES de mandar o launchd subir ───────────
  # Duas perguntas, porque cada uma sozinha mente: a trava com PID vivo prova
  # que há um daemon nosso; a porta ocupada prova que ALGO está na 7777 — pode
  # ser outro programa qualquer, e o operador precisa saber qual dos dois é.
  if vivo; then
    erro "já há um nomos-browser vivo (pid $(pid_do_lock)) — instância única."
    info "START=RECUSADO motivo=ja_rodando"
    exit 9
  fi
  if porta_ocupada; then
    erro "a porta $PORT já está ocupada por outro processo (o lock não é nosso)."
    info "START=RECUSADO motivo=porta_ocupada"
    exit 9
  fi
  if ! label_carregada; then erro "serviço não instalado — rode: $0 install"; exit 2; fi
  /bin/launchctl kickstart "$ALVO" >/dev/null 2>&1
  info "START=OK label=$LABEL"
}

cmd_stop() {
  guarda_label
  if ! label_carregada; then info "STOP=NADA_A_PARAR"; return 0; fi
  plist_e_nosso || { erro "label carregada não é nossa — recuso parar."; exit 4; }
  # SIGTERM: o daemon tem handler que fecha sessões e navegadores. `bootout`
  # manda SIGTERM e espera até `ExitTimeOut`. Matar com SIGKILL aqui deixaria
  # Chromium órfão — o defeito que o encerramento gracioso existe para não ter.
  /bin/launchctl bootout "$ALVO" >/dev/null 2>&1
  local i=0
  while [ "$i" -lt 30 ]; do
    vivo || break
    /bin/sleep 1; i=$((i + 1))
  done
  if vivo; then
    erro "o daemon não encerrou em 30 s (pid $(pid_do_lock))"
    info "STOP=TIMEOUT"
    exit 1
  fi
  info "STOP=OK residual=nenhum"
}

cmd_restart() {
  cmd_stop || true
  # Recarrega para o caso de o plist ter mudado.
  if plist_e_nosso; then /bin/launchctl bootstrap "$DOMINIO" "$PLIST" >/dev/null 2>&1; fi
  cmd_start
}

cmd_status() {
  local carregada="NAO" nosso="NAO" pid="-" porta="livre" estado="parado"
  label_carregada && carregada="SIM"
  plist_e_nosso && nosso="SIM"
  vivo && { pid="$(pid_do_lock)"; estado="rodando"; }
  porta_ocupada && porta="ocupada"
  printf 'LABEL=%s\nCARREGADA=%s\nPLIST_NOSSO=%s\nESTADO=%s\nPID=%s\nPORTA_%s=%s\nPLIST=%s\nLOGS=%s\n' \
    "$LABEL" "$carregada" "$nosso" "$estado" "$pid" "$PORT" "$porta" "$PLIST" "$LOG_DIR"
  [ "$estado" = "rodando" ]
}

cmd_health() {
  local tok; tok="$(token)"
  local url="http://127.0.0.1:$PORT/health"
  local corpo
  corpo="$(/usr/bin/curl -fsS --max-time 5 ${tok:+-H "authorization: Bearer $tok"} "$url" 2>/dev/null)"
  if [ -z "$corpo" ]; then
    info "HEALTH=FAIL url=$url motivo=sem_resposta"
    return 1
  fi
  printf '%s\n' "$corpo"
  # `runtime: ok` é o que o supervisor precisa; qualquer outra coisa é problema.
  if printf '%s' "$corpo" | /usr/bin/grep -q '"runtime":"ok"'; then
    info "HEALTH=OK"
    return 0
  fi
  info "HEALTH=DEGRADADO"
  return 1
}

cmd_logs() {
  local n="${2:-40}"
  for f in "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"; do
    printf '\n── %s ──\n' "$f"
    [ -f "$f" ] && /usr/bin/tail -n "$n" "$f" || printf '(sem arquivo)\n'
  done
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  health)    cmd_health ;;
  logs)      cmd_logs "$@" ;;
  *)
    printf 'uso: %s <install|uninstall|start|stop|restart|status|health|logs>\n' "$0" >&2
    exit 2
    ;;
esac
