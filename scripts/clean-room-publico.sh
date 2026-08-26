#!/usr/bin/env bash
# Clean room PUBLICO: valida o produto exatamente como um usuario externo o recebe.
# Nao usa a working tree local. Clona o remoto publico por HTTPS anonimo.
set -uo pipefail

RAIZ="${RAIZ:-/tmp/nomos-clean-room}"
REMOTO="https://github.com/Voltolini-SPACE/nomos-browser.git"
REF="${1:-main}"
SAIDA="$RAIZ/relatorio.txt"

rm -rf "$RAIZ"
mkdir -p "$RAIZ"
exec > >(tee "$SAIDA") 2>&1

echo "CLEAN_ROOM_PUBLICO"
echo "remoto=$REMOTO"
echo "ref=$REF"
echo "data=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "node=$(node --version)"
echo "npm=$(npm --version)"
echo

# --- 1. clone anonimo, sem credenciais, sem reaproveitar nada local -----------
echo "== 1. CLONE =="
env -u GIT_DIR -u GIT_WORK_TREE \
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  git clone --depth 1 --branch "$REF" "$REMOTO" "$RAIZ/repo" || { echo "CLONE=FAIL"; echo "CLEAN_ROOM=FAIL"; exit 1; }
cd "$RAIZ/repo" || exit 1
HEAD_CLONE="$(git rev-parse HEAD)"
echo "CLONE=OK head=$HEAD_CLONE"
echo "arquivos_versionados=$(git ls-files | wc -l | tr -d ' ')"
echo

# --- 2. o que o usuario externo recebe ----------------------------------------
echo "== 2. CONTEUDO RECEBIDO =="
for f in README.md LICENSE NOTICE.md CHANGELOG.md CONTRIBUTING.md SECURITY.md PRODUCT_MANIFEST.md PRODUCT_TRUTH_MATRIX.md ROADMAP.md package.json; do
  if [ -f "$f" ]; then echo "  presente: $f ($(wc -c <"$f" | tr -d ' ') b)"; else echo "  AUSENTE: $f"; fi
done
echo "VERSAO_PACKAGE_JSON=$(node -p "require('./package.json').version")"
echo "LICENSE_PACKAGE_JSON=$(node -p "require('./package.json').license")"
echo

# --- 3. artefatos de build nao podem estar no pacote publico ------------------
echo "== 3. HIGIENE DO PACOTE =="
SUJEIRA=0
for padrao in "node_modules" "packages/ui/dist" ".env" ".DS_Store"; do
  N="$(git ls-files | grep -c "^$padrao" || true)"
  echo "  $padrao: $N arquivo(s) versionado(s)"
  [ "$N" -gt 0 ] && SUJEIRA=$((SUJEIRA+1))
done
echo "HIGIENE=$([ "$SUJEIRA" -eq 0 ] && echo OK || echo FAIL)"
echo

# --- 4. instalar como um usuario externo --------------------------------------
echo "== 4. NPM CI =="
# O shell desta maquina exporta NODE_ENV=production e npm config omit=dev. Com
# isso o `npm ci` pula as devDependencies e o typecheck falha com "tsc: command
# not found" — que NAO e defeito do produto, e sim do instrumento. Um usuario
# externo tipico nao tem essas variaveis. A sala limpa precisa ser limpa tambem
# no ambiente, senao mede a minha maquina em vez do pacote publicado.
echo "  ambiente herdado: NODE_ENV=${NODE_ENV:-unset} omit=$(npm config get omit 2>/dev/null)"
if env -u NODE_ENV npm ci --include=dev --no-audit --no-fund; then echo "NPM_CI=OK"; else echo "NPM_CI=FAIL"; echo "CLEAN_ROOM=FAIL"; exit 1; fi
echo "  tsc local: $([ -x node_modules/.bin/tsc ] && echo presente || echo AUSENTE)"
echo

# --- 5. typecheck --------------------------------------------------------------
echo "== 5. TYPECHECK =="
if env -u NODE_ENV PATH="$PWD/node_modules/.bin:$PATH" npm run typecheck --silent; then echo "TYPECHECK=OK"; else echo "TYPECHECK=FAIL"; fi
echo

# --- 6. suite completa ---------------------------------------------------------
echo "== 6. SUITE =="
T0=$(date +%s)
# Roda exatamente o que um estranho digita: `npm test`, como declarado no
# package.json publicado. Nao a forma que eu sei que funciona.
env -u NODE_ENV npm test --silent > "$RAIZ/suite.log" 2>&1
RC_SUITE=$?
T1=$(date +%s)
echo "SUITE_RC=$RC_SUITE  duracao=$((T1-T0))s"
grep -E "^(TS_PASS|TS_FAIL|ARQUIVOS_OK|ARQUIVOS_RUINS)=" "$RAIZ/suite.log" | sed "s/^/  /"
echo

# --- veredito ------------------------------------------------------------------
echo "== VEREDITO =="
if [ "$RC_SUITE" -eq 0 ] && [ "$SUJEIRA" -eq 0 ]; then
  echo "CLEAN_ROOM=PASS"
else
  echo "CLEAN_ROOM=FAIL"
fi
echo "head=$HEAD_CLONE"
