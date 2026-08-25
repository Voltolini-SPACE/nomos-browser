#!/usr/bin/env bash
# REGRESSÃO COMPLETA — FASE 29.
#
# Uma execução, um veredito, e nenhum degrau escondido. Cada etapa registra
# PASS/FALHA com o número que a sustenta; etapa que não pôde ser executada sai
# como NAO_EXECUTADA, jamais como PASS por omissão.
#
# A regra que dá sentido ao arquivo: um gate só fica verde se TUDO que ele
# cobre rodou. "Nenhum ✖ apareceu" não é o mesmo que "tudo passou" — foi essa
# confusão que a suíte de TS já aprendeu a recusar, e ela vale aqui também.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
SAIDA="${1:-${RAIZ}/evidence/nomos-live-agent/11-regressao}"
mkdir -p "$SAIDA"

# Caminho da Gi. Configuravel por ambiente: um caminho absoluto embutido diz o
# nome de usuario de quem escreveu e quebra para todo mundo mais. O default
# assume o layout de projetos irmaos, e a etapa sai NAO_EXECUTADA quando nao
# encontra — nunca PASS por omissao.
GI="${NOMOS_GI_ROOT:-$(cd "$RAIZ/.." 2>/dev/null && pwd)/pocket-assistant}"

etapas_ok=0
etapas_ruins=0
etapas_ausentes=0

registrar() { # nome status detalhe
  printf '%-34s %-14s %s\n' "$1" "$2" "$3"
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$SAIDA/etapas.tsv"
  case "$2" in
    PASS) etapas_ok=$((etapas_ok + 1)) ;;
    NAO_EXECUTADA) etapas_ausentes=$((etapas_ausentes + 1)) ;;
    *) etapas_ruins=$((etapas_ruins + 1)) ;;
  esac
}

rm -f "$SAIDA/etapas.tsv"
printf 'etapa\tstatus\tdetalhe\n' > "$SAIDA/etapas.tsv"

echo "════ higiene: órfãos dos MEUS testes (nunca por porta) ════"
"${RAIZ}/scripts/limpar-orfaos.sh" | tee "$SAIDA/00-limpeza.txt"
echo

echo "════ 1. suíte TypeScript do runtime ════"
if "${RAIZ}/scripts/run-suite.sh" > "$SAIDA/01-suite-ts.txt" 2>&1; then
  P="$(/usr/bin/grep -E '^TS_PASS=' "$SAIDA/01-suite-ts.txt" | tail -1 | cut -d= -f2)"
  registrar "suite-typescript" "PASS" "TS_PASS=${P:-?} TS_FAIL=0 em 37 arquivos"
else
  P="$(/usr/bin/grep -E '^TS_PASS=' "$SAIDA/01-suite-ts.txt" | tail -1 | cut -d= -f2)"
  F="$(/usr/bin/grep -E '^TS_FAIL=' "$SAIDA/01-suite-ts.txt" | tail -1 | cut -d= -f2)"
  R="$(/usr/bin/grep -E '^ARQUIVOS_RUINS=' "$SAIDA/01-suite-ts.txt" | tail -1 | cut -d= -f2)"
  registrar "suite-typescript" "FALHOU" "TS_PASS=${P:-?} TS_FAIL=${F:-?} arquivos_ruins=${R:-?}"
fi

echo
echo "════ 2. baterias E2E do Live Agent ════"
# Cada uma sobe daemon e Chromium REAIS. Rodam em série de propósito: em
# paralelo elas disputam memória, e a suíte já provou o que isso produz.
for e2e in \
  "02-gate/e2e-autonomia.mjs" \
  "03-console/e2e-console.mjs" \
  "04-takeover/e2e-takeover.mjs" \
  "05-controles/e2e-controles.mjs" \
  "06-segredos/medir-vazamento.mjs" \
  "07-replay/e2e-replay.mjs" \
  "08-modos/e2e-modos.mjs" \
  "09-falhas/e2e-falhas.mjs" \
  "10-latencia/medir-latencia.mjs"
do
  nome="$(basename "$(dirname "$e2e")")"
  alvo="${RAIZ}/evidence/nomos-live-agent/${e2e}"
  if [ ! -f "$alvo" ]; then
    registrar "e2e-${nome}" "NAO_EXECUTADA" "arquivo ausente: ${e2e}"
    continue
  fi
  log="$SAIDA/02-e2e-${nome}.txt"
  if (cd "$RAIZ" && node "$alvo") > "$log" 2>&1; then
    casos="$(/usr/bin/grep -c '^\[PASS\]' "$log" || true)"
    registrar "e2e-${nome}" "PASS" "${casos} casos PASS"
  else
    ruins="$(/usr/bin/grep -c '^\[FALHA\]' "$log" || true)"
    registrar "e2e-${nome}" "FALHOU" "${ruins} casos FALHA — ver $(basename "$log")"
  fi
  "${RAIZ}/scripts/limpar-orfaos.sh" > /dev/null 2>&1 || true
done

echo
echo "════ 3. Gi (assistente de voz) — suíte Python ════"
if [ -d "$GI/backend" ]; then
  if (cd "$GI/backend" && python3 -m pytest -q) > "$SAIDA/03-gi-pytest.txt" 2>&1; then
    LINHA="$(tail -3 "$SAIDA/03-gi-pytest.txt" | /usr/bin/grep -E 'passed|failed' | tail -1)"
    registrar "gi-pytest" "PASS" "${LINHA:-sem linha de sumário}"
  else
    LINHA="$(tail -5 "$SAIDA/03-gi-pytest.txt" | /usr/bin/grep -E 'passed|failed|error' | tail -1)"
    registrar "gi-pytest" "FALHOU" "${LINHA:-ver 03-gi-pytest.txt}"
  fi
else
  registrar "gi-pytest" "NAO_EXECUTADA" "projeto Gi não encontrado em ${GI}"
fi

echo
echo "════ 4. confiança do MCP (catálogo do NOMOS) ════"
CAT="$HOME/.nomos/mcp_catalogo.json"
if [ -f "$CAT" ]; then
  PERM="$(/usr/bin/stat -f '%Lp' "$CAT" 2>/dev/null || echo '?')"
  RESUMO="$(/usr/bin/python3 - "$CAT" <<'PY' 2>/dev/null || echo "ilegivel"
import json,sys
d=json.load(open(sys.argv[1]))
print(f"confiaveis={len(d.get('confiaveis',{}))} revogadas={len(d.get('revogadas',[]))}")
PY
)"
  if [ "$PERM" = "600" ]; then
    registrar "mcp-catalogo" "PASS" "modo 0600 · ${RESUMO}"
  else
    registrar "mcp-catalogo" "FALHOU" "modo ${PERM} (esperado 600) · ${RESUMO}"
  fi
else
  registrar "mcp-catalogo" "NAO_EXECUTADA" "catálogo não existe em ${CAT}"
fi

echo
echo "════ 5. cobertura declarada da CI ════"
if (cd "$RAIZ" && bash scripts/ci-cobertura.sh) > "$SAIDA/05-cobertura.txt" 2>&1; then
  registrar "ci-cobertura" "PASS" "todo arquivo de teste está declarado na CI"
else
  registrar "ci-cobertura" "FALHOU" "ver 05-cobertura.txt"
fi

echo
echo "════ 6. guardas estáticas ════"
if (cd "$RAIZ" \
      && node scripts/verificar-shell-expansao.ts \
      && node scripts/verificar-versao-coerente.ts \
      && node scripts/marcar-versao.ts --autoteste \
      && node scripts/verificar-links-docs.ts --autoteste \
      && node scripts/verificar-links-docs.ts) \
     > "$SAIDA/06-guardas.txt" 2>&1; then
  registrar "guardas-estaticas" "PASS" "shell + versão + links de documentação"
else
  registrar "guardas-estaticas" "FALHOU" "ver 06-guardas.txt"
fi

echo
echo "════ 6b. segredos no que virará público ════"
if (cd "$RAIZ" && bash scripts/verificar-segredos-publicos.sh) > "$SAIDA/06b-segredos-publicos.txt" 2>&1; then
  registrar "segredos-publicos" "PASS" "PUBLIC_REPO_SECRET_LEAK=0"
else
  registrar "segredos-publicos" "FALHOU" "ver 06b-segredos-publicos.txt"
fi

echo
echo "════ 6c. demos reproduzíveis ════"
if (cd "$RAIZ" && node demos/rodar-demos.mjs) > "$SAIDA/06c-demos.txt" 2>&1; then
  registrar "demos" "PASS" "$(/usr/bin/grep -c '^  \[OK\]' "$SAIDA/06c-demos.txt" || true) passos OK em 6 demos"
else
  registrar "demos" "FALHOU" "ver 06c-demos.txt"
fi
"${RAIZ}/scripts/limpar-orfaos.sh" > /dev/null 2>&1 || true

echo
echo "════ 7. tipos ════"
if (cd "$RAIZ" && npx tsc --noEmit) > "$SAIDA/07-tsc.txt" 2>&1; then
  registrar "tsc-noEmit" "PASS" "sem erro de tipo"
else
  registrar "tsc-noEmit" "FALHOU" "ver 07-tsc.txt"
fi

echo
echo "════════════════════ VEREDITO ════════════════════"
# Um gate só fica verde se tudo que ele cobre EXECUTOU. Etapa ausente derruba,
# porque "não rodou" nunca pode se apresentar como "passou".
TS_OK=$(/usr/bin/grep -c '^suite-typescript	PASS' "$SAIDA/etapas.tsv" || true)
E2E_TOTAL=$(/usr/bin/grep -c '^e2e-' "$SAIDA/etapas.tsv" || true)
E2E_OK=$(/usr/bin/grep -c '^e2e-.*	PASS' "$SAIDA/etapas.tsv" || true)

echo "ETAPAS_PASS=${etapas_ok}"
echo "ETAPAS_FALHA=${etapas_ruins}"
echo "ETAPAS_NAO_EXECUTADAS=${etapas_ausentes}"
[ "$TS_OK" = "1" ] && echo "NOMOS_BROWSER_REGRESSION=PASS" || echo "NOMOS_BROWSER_REGRESSION=FALHA"
if [ "$E2E_TOTAL" -gt 0 ] && [ "$E2E_OK" = "$E2E_TOTAL" ]; then
  echo "LIVE_AGENT_REGRESSION=PASS (${E2E_OK}/${E2E_TOTAL} baterias)"
else
  echo "LIVE_AGENT_REGRESSION=FALHA (${E2E_OK}/${E2E_TOTAL} baterias)"
fi
echo "RELATORIO=${SAIDA}/etapas.tsv"

[ "$etapas_ruins" -eq 0 ] && [ "$etapas_ausentes" -eq 0 ]
