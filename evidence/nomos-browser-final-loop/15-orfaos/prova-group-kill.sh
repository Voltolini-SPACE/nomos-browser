#!/usr/bin/env bash
# FASE 15 — prova controlada: matar o PAI deixa órfão; matar o GRUPO não deixa.
# Roda o MESMO teste travado nas duas estratégias e conta os filhos sobreviventes.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
MARCA="NOMOS-PGTEST-CANARIO-$$"
cd "$RAIZ"
cat > "tests/zz-pgtest.test.ts" <<EOF
import { test } from "node:test";
import { spawn } from "node:child_process";
test("gera filho e trava (fixture de prova do FASE 15)", async () => {
  spawn(process.execPath, ["-e", "process.title='$MARCA'; setInterval(()=>{}, 1e9)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600000));
});
EOF
conta() { pgrep -f "$MARCA" 2>/dev/null | grep -c . || true; }
limpa() { pgrep -f "$MARCA" 2>/dev/null | xargs -r kill -9 2>/dev/null || true; }

rodar() {
  local estrategia="$1"
  limpa; sleep 1
  set -m
  ( cd "$RAIZ" && node --test tests/zz-pgtest.test.ts >/tmp/pg-$estrategia.log 2>&1 ) &
  local pid=$!
  set +m
  sleep 6
  local vivos_durante; vivos_durante=$(conta)
  if [ "$estrategia" = "so-o-pai" ]; then
    kill -9 "$pid" 2>/dev/null
  else
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 2
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null
  sleep 2
  local vivos_depois; vivos_depois=$(conta)
  printf '%-14s filho_vivo_durante=%s  orfaos_depois=%s\n' "$estrategia" "$vivos_durante" "$vivos_depois"
  echo "$vivos_durante:$vivos_depois"
  limpa
}

echo "== controle: comportamento ANTIGO (kill -9 só no pai) =="
ANTIGO=$(rodar "so-o-pai" | tail -1)
echo "== corrigido: kill no GRUPO de processos =="
NOVO=$(rodar "o-grupo" | tail -1)
rm -f "tests/zz-pgtest.test.ts"
limpa

a_dur=${ANTIGO%%:*}; a_orf=${ANTIGO##*:}
n_dur=${NOVO%%:*};   n_orf=${NOVO##*:}
echo
echo "ANTIGO: filho vivo durante=$a_dur, órfãos após kill=$a_orf"
echo "NOVO:   filho vivo durante=$n_dur, órfãos após kill=$n_orf"
# O teste só vale se o filho REALMENTE existiu nos dois casos (controle de vácuo).
if [ "$a_dur" -lt 1 ] || [ "$n_dur" -lt 1 ]; then
  echo "TESTE_VACUO=SIM — o filho nunca subiu; a prova não vale"
  echo "TEST_TIMEOUT_GROUP_KILL=INCONCLUSIVO"; exit 2
fi
echo "TESTE_VACUO=NAO (filho subiu nos dois casos)"
if [ "$a_orf" -ge 1 ] && [ "$n_orf" -eq 0 ]; then
  echo "TEST_TIMEOUT_GROUP_KILL=PASS"; exit 0
fi
echo "TEST_TIMEOUT_GROUP_KILL=FAIL"; exit 1
