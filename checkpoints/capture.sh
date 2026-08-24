#!/usr/bin/env bash
# Captura de estado mecânica — FASE 0 / NOMOS BROWSER PRODUCT-01
# Uso: checkpoints/capture.sh <nome-do-checkpoint>
set -uo pipefail
NAME="${1:?uso: capture.sh <nome>}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$OUT_DIR/$NAME.json"

j() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }

{
  printf '{\n'
  printf '  "checkpoint": %s,\n' "$(printf '%s' "$NAME" | j)"
  printf '  "captured_at_utc": %s,\n' "$(printf '%s' "$STAMP" | j)"
  printf '  "host": {\n'
  printf '    "os": %s,\n' "$(sw_vers 2>/dev/null | tr '\n' ' ' | j)"
  printf '    "arch": %s,\n' "$(uname -m | j)"
  printf '    "disk_avail": %s\n' "$(df -h / | tail -1 | awk '{print $4}' | j)"
  printf '  },\n'
  printf '  "runtimes": {\n'
  printf '    "node": %s,\n' "$(node -v 2>&1 | j)"
  printf '    "npm": %s,\n' "$(npm -v 2>&1 | j)"
  printf '    "python": %s,\n' "$(python3 -V 2>&1 | j)"
  printf '    "chrome": %s,\n' "$("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>&1 | j)"
  printf '    "playwright_browsers": %s\n' "$(ls -1 ~/Library/Caches/ms-playwright 2>/dev/null | tr '\n' ',' | j)"
  printf '  },\n'
  printf '  "repo": {\n'
  printf '    "path": %s,\n' "$(cd "$OUT_DIR/.." && pwd | j)"
  printf '    "branch": %s,\n' "$(git -C "$OUT_DIR/.." rev-parse --abbrev-ref HEAD 2>&1 | j)"
  printf '    "head": %s,\n' "$(git -C "$OUT_DIR/.." rev-parse HEAD 2>&1 | j)"
  printf '    "dirty_files": %s\n' "$(git -C "$OUT_DIR/.." status --porcelain 2>&1 | wc -l | tr -d ' ' | j)"
  printf '  },\n'
  printf '  "ports_listen": %s,\n' "$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ',' | j)"
  printf '  "port_7777_free": %s,\n' "$(lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1 && echo false || echo true)"
  printf '  "nomos_services": %s\n' "$(launchctl list 2>/dev/null | grep -iE 'nomos|omniroute' | awk '{print $3"("$1")"}' | tr '\n' ',' | j)"
  printf '}\n'
} > "$OUT"

python3 -c "import json,sys; json.load(open('$OUT')); print('CHECKPOINT_JSON_VALID=YES')" || { echo "CHECKPOINT_JSON_VALID=NO"; exit 1; }
shasum -a 256 "$OUT" | awk '{print "CHECKPOINT_SHA256="$1}'
echo "CHECKPOINT_FILE=$OUT"
