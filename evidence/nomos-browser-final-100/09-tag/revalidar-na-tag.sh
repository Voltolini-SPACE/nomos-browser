#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FASE 11 — REVALIDAR A PARTIR DO CONTEÚDO DA TAG, NÃO DA ÁRVORE DE TRABALHO.
#
# A diferença não é formal. Rodar os testes no diretório de trabalho prova que a
# MÁQUINA passa; rodar num `git clone --branch v0.2.0-rc.1` prova que o que a
# TAG contém passa. Entre os dois cabe tudo o que existe na máquina e não está
# versionado: um arquivo não commitado, um `node_modules` com sobra, um
# `.runtime` do dono. Esta prova fecha essa fresta.
#
# Uso: bash evidence/nomos-browser-final-100/09-tag/revalidar-na-tag.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ORIG="/Users/AI/Projects/nomos-browser"
TAG="${TAG:-v0.2.0}"
SHA_TAG="$(git -C "$ORIG" rev-parse "${TAG}^{}")"
CR="/tmp/nomos-tag-${TAG}"
FALHAS=0

passo() {
  local nome="$1"; shift
  printf '\n══ %-46s ' "$nome"
  if "$@" > /tmp/tag-passo.log 2>&1; then
    printf 'OK\n'
  else
    printf 'FALHOU\n'; tail -14 /tmp/tag-passo.log | sed 's/^/    /'; FALHAS=$((FALHAS+1))
  fi
}

echo "TAG=$TAG"
echo "SHA_APONTADO=$SHA_TAG"
echo "CLONE=$CR"
rm -rf "$CR"

# ── 1. o clone tem de vir DA TAG, e o conteúdo tem de ser o dela ─────────────
passo "1. git clone --branch $TAG" bash -c \
  "git clone --branch '$TAG' --depth 1 'file://$ORIG' '$CR' >/dev/null 2>&1"
passo "2. o HEAD do clone é o commit da tag" bash -c \
  "test \"\$(git -C '$CR' rev-parse HEAD)\" = '$SHA_TAG'"
# Controle que separa "clonei a tag" de "clonei a árvore de trabalho": a árvore
# de trabalho poderia estar suja e o clone continuaria limpo. Se algum dia este
# passo falhar, é porque a tag não descreve o que se está testando.
passo "3. o clone não tem NADA fora do versionado" bash -c \
  "test -z \"\$(git -C '$CR' status --porcelain)\""

cd "$CR" || exit 1
VERSAO="$(node -p "require('./package.json').version")"
echo "VERSAO_NA_TAG=$VERSAO"

# ── 2. instalação reprodutível a partir do lock da tag ──────────────────────
passo "4. npm ci --include=dev" npm ci --include=dev
passo "5. playwright install chromium" npx playwright install chromium
passo "6. typecheck" npx tsc --noEmit -p tsconfig.json

# ── 3. os guardas de coerência, sobre o conteúdo da tag ─────────────────────
passo "7. versao coerente em todo o produto" node scripts/verificar-versao-coerente.ts
passo "8. guarda de versao nao e cego" node scripts/verificar-versao-coerente.ts --autoteste
passo "9. expansao de shell segura" node scripts/verificar-shell-expansao.ts
passo "10. guarda de shell nao e cego" node scripts/verificar-shell-expansao.ts --autoteste
passo "11. risco por tool coerente" node scripts/verificar-risco-mcp.ts
passo "12. cobertura da matriz de CI" bash scripts/ci-cobertura.sh

# ── 4. REGRESSION_ON_TAG ────────────────────────────────────────────────────
REGRESSAO=FAIL
if bash scripts/ci.sh all > /tmp/tag-ci.log 2>&1 && grep -q "CI_PASS=YES" /tmp/tag-ci.log; then
  REGRESSAO=PASS
else
  FALHAS=$((FALHAS+1)); echo; echo "── ci.sh all FALHOU ──"; tail -25 /tmp/tag-ci.log | sed 's/^/    /'
fi
echo; echo "══ 13. ci.sh all (regressao) → $REGRESSAO"

SUITE=FAIL
bash scripts/run-suite.sh > /tmp/tag-suite.log 2>&1
TS_PASS="$(grep -E '^TS_PASS=' /tmp/tag-suite.log | cut -d= -f2)"
TS_FAIL="$(grep -E '^TS_FAIL=' /tmp/tag-suite.log | cut -d= -f2)"
ARQ_OK="$(grep -E '^ARQUIVOS_OK=' /tmp/tag-suite.log | cut -d= -f2)"
if [ "${TS_FAIL:-1}" = "0" ] && [ "${TS_PASS:-0}" -ge 735 ]; then SUITE=PASS; else FALHAS=$((FALHAS+1)); fi
echo "══ 14. suite Node: TS_PASS=$TS_PASS TS_FAIL=$TS_FAIL ARQUIVOS_OK=$ARQ_OK → $SUITE"

PY=FAIL
if ( cd sdk-python && python3 -m unittest discover -s tests ) > /tmp/tag-py.log 2>&1; then PY=PASS; else FALHAS=$((FALHAS+1)); fi
N_PY="$(grep -oE 'Ran [0-9]+ test' /tmp/tag-py.log | grep -oE '[0-9]+')"
echo "══ 15. SDK Python: $N_PY testes → $PY"

# ── 5. E2E_ON_TAG — a bateria de 20 cenarios, do conteudo da tag ────────────
E2E=FAIL
node evidence/nomos-browser-final-loop/19-e2e/e2e-final.ts > /tmp/tag-e2e.log 2>&1
E_TOT="$(grep -E '^E2E_TOTAL=' /tmp/tag-e2e.log | cut -d= -f2)"
E_PASS="$(grep -E '^E2E_PASS=' /tmp/tag-e2e.log | cut -d= -f2)"
E_FAIL="$(grep -E '^E2E_FAIL=' /tmp/tag-e2e.log | cut -d= -f2)"
# Repetições de transporte NÃO reprovam sozinhas, mas entram no rodapé como
# número: uma repetição silenciosa seria maquiagem. Zero é o esperado.
REPET="$(grep -E '^TRANSPORTE_REPETICOES=' /tmp/tag-e2e.log | cut -d= -f2)"
MORTO="$(grep -E '^TRANSPORTE_APOS_DAEMON_MORTO=' /tmp/tag-e2e.log | cut -d= -f2)"
grep -n "TRANSPORTE" /tmp/tag-e2e.log | sed 's/^/    /' || true
# Repetição com o daemon VIVO e' o unico numero que fala do produto. Zero e' o
# esperado; acima disso o E2E passa mas a tag NAO e' revalidada.
if [ "${REPET:-0}" != "0" ]; then FALHAS=$((FALHAS+1)); fi
CHECAGENS="$(python3 -c "
import json
try:
    d=json.load(open('evidence/nomos-browser-final-loop/19-e2e/out/e2e-final.json'))
    print(sum(len(c.get('checagens') or []) for c in d['cenarios']))
except Exception: print(0)
")"
if [ "${E_FAIL:-1}" = "0" ] && [ "${E_PASS:-0}" = "20" ]; then E2E=PASS; else FALHAS=$((FALHAS+1)); fi
echo "══ 16. E2E na tag: $E_PASS/$E_TOT cenarios, $CHECAGENS checagens → $E2E"
cp /tmp/tag-e2e.log "$ORIG/evidence/nomos-browser-final-100/09-tag/e2e-na-tag.txt" 2>/dev/null || true

# ── 6. o produto nao deixou residuo no host ─────────────────────────────────
sleep 2
RES_DAEMON="$(pgrep -fc 'packages/api/src/daemon.ts' 2>/dev/null || echo 0)"
RES_CHROME="$(/bin/ps aux | /usr/bin/grep -c '[c]hrome-mac-arm64')"
RES_MCP="$(pgrep -fc 'servidor.mjs' 2>/dev/null || echo 0)"
echo "══ 17. residuo: daemons=$RES_DAEMON chromium=$RES_CHROME servidor_mcp=$RES_MCP"
if [ "$RES_DAEMON" = "0" ] && [ "$RES_CHROME" = "0" ] && [ "$RES_MCP" = "0" ]; then :; else FALHAS=$((FALHAS+1)); fi

# ── 7. rodape ───────────────────────────────────────────────────────────────
echo
echo "══════════════════════ RODAPE ══════════════════════"
echo "TAG=$TAG"
echo "SHA=$SHA_TAG"
echo "VERSAO_NA_TAG=$VERSAO"
echo "PASSOS_FALHOS=$FALHAS"
echo "REGRESSION_ON_TAG=$REGRESSAO"
echo "SUITE_ON_TAG=$SUITE (TS_PASS=$TS_PASS)"
echo "PYTHON_ON_TAG=$PY ($N_PY)"
echo "E2E_ON_TAG=$E2E ($E_PASS/$E_TOT, $CHECAGENS checagens)"
echo "TRANSPORTE_REPETICOES_DAEMON_VIVO=${REPET:-?}   (0 exigido)"
echo "TRANSPORTE_APOS_DAEMON_MORTO=${MORTO:-?}   (ruido do proprio teste, nao reprova)"
if [ "$FALHAS" = "0" ]; then echo "TAG_REVALIDATED=YES"; else echo "TAG_REVALIDATED=NO"; fi
