#!/usr/bin/env bash
# FASE 0 — congelamento de estado. Não altera nada; só observa e registra.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$RAIZ/evidence/nomos-browser-final-validation/00-baseline"
cd "$RAIZ"
exec > >(tee "$OUT/baseline.txt") 2>&1

echo "=== IDENTIDADE ==="
echo "DATE_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "DATE_LOCAL=$(date +%Y-%m-%dT%H:%M:%S%z)"
echo "HOST=$(hostname)"
echo "UNAME=$(uname -a)"
echo "MACOS=$(sw_vers -productVersion 2>/dev/null) build=$(sw_vers -buildVersion 2>/dev/null)"
echo "REPO=$RAIZ"

echo; echo "=== GIT ==="
echo "TOPLEVEL=$(git rev-parse --show-toplevel)"
echo "BRANCH=$(git branch --show-current)"
echo "HEAD=$(git rev-parse HEAD)"
echo "HEAD_SHORT=$(git rev-parse --short HEAD)"
echo "HEAD_DATE=$(git log -1 --format=%cI)"
echo "COMMITS=$(git rev-list --count HEAD)"
echo "TAGS=[$(git tag | tr '\n' ' ')]"
echo "REMOTES=[$(git remote -v | tr '\n' ';')]"
echo "--- git status --porcelain ---"
git status --porcelain=v1
echo "DIRTY_COUNT=$(git status --porcelain=v1 | wc -l | tr -d ' ')"
echo "--- stale locks ---"
ls -la .git/index.lock 2>/dev/null || echo "sem index.lock"

echo; echo "=== VERSOES ==="
echo "NODE=$(node -v)"
echo "NPM=$(npm -v)"
echo "PYTHON=$(python3 -V 2>&1)"
echo "GIT=$(git --version)"
echo "PRODUCT_VERSION=$(node -e 'console.log(require("./package.json").version)' 2>/dev/null)"
echo "PLAYWRIGHT_DEP=$(node -e 'console.log(require("./package.json").dependencies.playwright)' 2>/dev/null)"
echo "PLAYWRIGHT_INSTALLED=$(npx playwright --version 2>&1 | head -1)"
echo "TSC=$(npx tsc --version 2>&1 | head -1)"
echo "--- chromium do runtime ---"
ls -d ~/Library/Caches/ms-playwright/* 2>/dev/null
CHR="$(ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | head -1)"
echo "CHROMIUM_BIN=$CHR"
[ -n "$CHR" ] && echo "CHROMIUM_VERSION=$("$CHR" --version 2>&1)"
echo "SYSTEM_CHROME=$(/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version 2>/dev/null)"
echo "OLLAMA=$(command -v ollama || echo MISSING)"
[ -n "$(command -v ollama)" ] && ollama --version 2>&1 | head -1

echo; echo "=== RECURSOS ==="
echo "--- memoria ---"
vm_stat | head -12
echo "MEM_TOTAL_BYTES=$(sysctl -n hw.memsize)"
echo "--- swap ---"
sysctl vm.swapusage 2>/dev/null
echo "--- disco ---"
df -h / /System/Volumes/Data 2>/dev/null
echo "--- carga ---"
uptime

echo; echo "=== PROCESSOS NOMOS / BROWSER ==="
ps -Ao pid,ppid,%cpu,%mem,etime,command | grep -Ei 'nomos|chromium|chrome|playwright|ollama|daemon.ts' | grep -v grep | head -40
echo "PROC_COUNT=$(ps -Ao command | grep -Ei 'nomos|chromium|ollama' | grep -v grep | wc -l | tr -d ' ')"

echo; echo "=== PORTAS EM ESCUTA ==="
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -40

echo; echo "=== SERVICOS (launchd) ==="
launchctl list 2>/dev/null | grep -Ei 'nomos|omniroute|se7enpay|ollama' || echo "nenhum"

echo; echo "=== HASHES DE COMPONENTES CRITICOS ==="
git ls-files -- 'packages/**/*.ts' 'tests/*.ts' 'spike/*.ts' 'scripts/*.sh' 'docs/*.md' 'package.json' 'tsconfig*.json' 'README.md' \
  | sort | xargs shasum -a 256 > "$OUT/hashes-versionados.txt"
echo "ARQUIVOS_HASHEADOS=$(wc -l < "$OUT/hashes-versionados.txt" | tr -d ' ')"
echo "HASH_DO_CONJUNTO=$(shasum -a 256 "$OUT/hashes-versionados.txt" | awk '{print $1}')"
echo "GIT_TREE_HASH=$(git rev-parse HEAD^{tree})"

echo; echo "=== TAMANHO DO PRODUTO ==="
echo "LOC_TS_PACKAGES=$(git ls-files -- 'packages/**/*.ts' | xargs wc -l 2>/dev/null | tail -1)"
echo "LOC_TESTS=$(git ls-files -- 'tests/*.ts' | xargs wc -l 2>/dev/null | tail -1)"
echo "N_TEST_FILES=$(ls tests/*.test.ts | wc -l | tr -d ' ')"

echo; echo "BASELINE_CAPTURED=YES"
