#!/usr/bin/env bash
# FASE 30 — SALA LIMPA DO LIVE AGENT.
#
# A pergunta que uma sala limpa responde não é "o código funciona?" — a suíte já
# respondeu isso. É: **funciona a partir do que está versionado**, sem nada que
# só exista na minha árvore de trabalho.
#
# Três coisas que só aqui ficam provadas para o Live Agent:
#
#   1. os instrumentos de medida ESTÃO NO REPOSITÓRIO. Um E2E que só existe na
#      máquina de quem o escreveu não é evidência: é anedota. Aqui eles rodam do
#      clone, ou não rodam.
#   2. a UI é CONSTRUÍDA do `src` do clone. `dist/` é artefato e não entra no
#      git — foi exatamente por medir uma `dist` velha que uma mutação
#      deliberada "passou" durante a FASE 25. Da sala limpa não há dist velha
#      para mascarar nada.
#   3. nenhum estado do meu runtime (`~/.nomos-browser`, `/tmp/la-*`) participa:
#      o clone usa diretórios próprios.
#
# Uso:  scripts/clean-room-live-agent.sh
set -uo pipefail

ORIG="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ORIG" rev-parse HEAD)"
CURTO="$(git -C "$ORIG" rev-parse --short HEAD)"
CR="/tmp/nomos-cr-live-agent-${CURTO}"
FALHAS=0
PASSOS=0

passo() {
  local nome="$1"; shift
  PASSOS=$((PASSOS + 1))
  printf '\n══ %-52s ' "$nome"
  if "$@" > /tmp/cr-la.log 2>&1; then
    printf 'OK\n'
  else
    printf 'FALHOU\n'
    tail -15 /tmp/cr-la.log | sed 's/^/    /'
    FALHAS=$((FALHAS + 1))
  fi
}

echo "HEAD=${SHA}"
echo "SALA_LIMPA=${CR}"
echo "ZERO_PATCH_MANUAL=SIM (so git clone)"

# A árvore precisa estar limpa: uma sala limpa montada a partir de um HEAD que
# não contém o que estou medindo provaria o oposto do que se quer.
if [ -n "$(git -C "$ORIG" status --porcelain)" ]; then
  echo
  echo "RECUSADO: a arvore de trabalho tem mudanca nao commitada."
  echo "  Uma sala limpa clona o HEAD. Medir o HEAD enquanto o que importa esta"
  echo "  fora dele seria medir outra coisa e chamar de prova."
  git -C "$ORIG" status --short | sed 's/^/    /'
  exit 2
fi

rm -rf "$CR"
passo "1. git clone do HEAD" bash -c "git clone --depth 1 'file://${ORIG}' '${CR}' >/dev/null 2>&1 && [ \"\$(git -C '${CR}' rev-parse HEAD)\" = '${SHA}' ]"
cd "$CR" || exit 1

passo "2. npm ci --include=dev" npm ci --include=dev
passo "3. typecheck do clone" npx tsc --noEmit
passo "4. cobertura declarada da CI" bash scripts/ci-cobertura.sh
passo "5. guarda de expansao de shell" node scripts/verificar-shell-expansao.ts
passo "6. coerencia de versao" node scripts/verificar-versao-coerente.ts

# A UI é construída AQUI, do src do clone. Sem este passo, um E2E de tela mediria
# uma dist que não existe (ou pior: uma que existisse por acaso).
passo "7. build da UI a partir do src do clone" node packages/ui/build.ts
passo "8. a UI construida contem o painel de historico" \
  bash -c "grep -q 'hist-linha' packages/ui/dist/index.html"

# ── os instrumentos do Live Agent, rodando DO CLONE ──────────────────────────
export NOMOS_BROWSER_HOME="${CR}/.runtime"
for e2e in \
  "02-gate/e2e-autonomia.mjs" \
  "06-segredos/medir-vazamento.mjs" \
  "07-replay/e2e-replay.mjs" \
  "08-modos/e2e-modos.mjs" \
  "09-falhas/e2e-falhas.mjs"
do
  nome="$(basename "$(dirname "$e2e")")"
  if [ ! -f "evidence/nomos-live-agent/${e2e}" ]; then
    printf '\n══ %-52s %s\n' "9.${nome} E2E do clone" "AUSENTE NO REPOSITORIO"
    FALHAS=$((FALHAS + 1))
    PASSOS=$((PASSOS + 1))
    continue
  fi
  passo "9.${nome} E2E rodando do clone" node "evidence/nomos-live-agent/${e2e}"
  bash scripts/limpar-orfaos.sh > /dev/null 2>&1 || true
done

# ── o clone nao tocou no runtime do dono ─────────────────────────────────────
passo "10. o clone usa runtime proprio, nao o do dono" \
  bash -c "[ ! -d \"\$HOME/.nomos-browser/sessions/cr-live-agent\" ]"

echo
echo "════════════════════════════════════════════"
echo "PASSOS=${PASSOS}"
echo "FALHAS=${FALHAS}"
echo "LIVE_AGENT_CLEAN_ROOM=$([ "$FALHAS" -eq 0 ] && echo PASS || echo FALHA)"
echo "SALA_LIMPA=${CR}"
[ "$FALHAS" -eq 0 ]
