#!/usr/bin/env bash
# Executor da suíte, um arquivo por vez.
#
# Por que não `node --test "tests/*.test.ts"` direto: a suíte abre Chromium em
# vários arquivos e o runner do Node paraleliza por número de CPUs. Nesta máquina
# (M2 de 16 GB, swap perto do teto) isso derruba o processo no meio, e o sintoma
# é uma saída truncada SEM linha de sumário — que é exatamente o modo de falha
# perigoso: parece que passou porque não apareceu ✖.
#
# Aqui cada arquivo roda isolado, com timeout próprio, e o resultado de cada um
# é registrado. Um arquivo morto por falta de memória aparece como MORTO, nunca
# como silêncio.
#
# Uso:  scripts/run-suite.sh [--fast] [--out DIR]
#   --fast  pula os arquivos marcados como lentos (browser/E2E/bench)
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${RAIZ}/.suite"
FAST=0
TIMEOUT_S="${NOMOS_SUITE_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "uso: $0 [--fast] [--out DIR]" >&2; exit 2 ;;
  esac
done

# Arquivos que sobem Chromium ou rodam benchmark: caros, e os primeiros a morrer
# sob pressão de memória.
LENTOS="e2e-gate api session perception pointer-keyboard target-verifier vision bench recovery-watchdog security-net-injection security-files-secrets"

mkdir -p "$OUT"
rm -f "$OUT"/*.log "$OUT/resumo.tsv" 2>/dev/null || true

total_pass=0
total_fail=0
arquivos_ok=0
arquivos_ruins=0

printf 'arquivo\tstatus\tpass\tfail\tsegundos\n' > "$OUT/resumo.tsv"

for f in "$RAIZ"/tests/*.test.ts; do
  nome="$(basename "$f" .test.ts)"
  if [ "$FAST" -eq 1 ] && printf '%s' "$LENTOS" | /usr/bin/grep -qw "$nome"; then
    printf '%s\tPULADO\t0\t0\t0\n' "$nome" >> "$OUT/resumo.tsv"
    continue
  fi

  # Testes que carregam LLM competem por memória. Devolver o que ficou residente
  # antes de cada um evita que o vizinho anterior estoure o timeout deste — o
  # gate de visão falhava por 121s de carregamento, não por erro de código.
  case "$nome" in
    vision|aiprovider|product02-gate)
      for m in qwen3.5:4b-q8_0 qwen2.5-coder:7b qwen2.5vl:3b moondream:1.8b; do
        curl -s --max-time 20 -X POST http://127.0.0.1:11434/api/generate \
          -d "{\"model\":\"$m\",\"keep_alive\":0}" -o /dev/null 2>/dev/null || true
      done
      ;;
  esac

  log="$OUT/$nome.log"
  inicio=$(date +%s)
  # `timeout` do coreutils pode não existir no macOS; usa-se um watchdog simples.
  #
  # O teste roda em GRUPO DE PROCESSOS PRÓPRIO (`set -m` + subshell), e o vigia
  # mata o GRUPO (`kill -TERM -$pid`), não só o pai. A versão anterior matava
  # apenas o pai com `kill -9`: os filhos (`tests/fixtures/watchdog-child.ts`,
  # daemons, Chromium) eram reparentados para o init e sobreviviam. A validação
  # final encontrou 19 desses órfãos, o mais velho com 6 h de vida — todos
  # nascidos de arquivos classificados MORTO por timeout.
  #
  # TERM primeiro para dar chance de teardown; KILL depois, para quem ignorou.
  set -m
  ( cd "$RAIZ" && node --test "tests/$nome.test.ts" >"$log" 2>&1 ) &
  pid=$!
  set +m
  (
    sleep "$TIMEOUT_S"
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 3
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  ) &
  vigia=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$vigia" 2>/dev/null
  wait "$vigia" 2>/dev/null
  # Rede de segurança: sobrou algo do grupo depois do wait? Some com o grupo.
  kill -KILL -"$pid" 2>/dev/null || true
  fim=$(date +%s)
  seg=$((fim - inicio))

  p=$(/usr/bin/grep -E '^# pass |^ℹ pass ' "$log" | /usr/bin/awk '{print $NF}' | tail -1)
  fa=$(/usr/bin/grep -E '^# fail |^ℹ fail ' "$log" | /usr/bin/awk '{print $NF}' | tail -1)
  p="${p:-0}"; fa="${fa:-0}"

  if [ -z "$(/usr/bin/grep -E '^ℹ tests ' "$log")" ]; then
    # Sem linha de sumário = o processo morreu antes de terminar. Isso NÃO é
    # sucesso, por mais que nenhum ✖ tenha sido impresso.
    status="MORTO"
    arquivos_ruins=$((arquivos_ruins + 1))
  elif [ "$fa" != "0" ] || [ "$rc" -ne 0 ]; then
    status="FALHOU"
    arquivos_ruins=$((arquivos_ruins + 1))
  else
    status="OK"
    arquivos_ok=$((arquivos_ok + 1))
  fi

  total_pass=$((total_pass + p))
  total_fail=$((total_fail + fa))
  printf '%s\t%s\t%s\t%s\t%s\n' "$nome" "$status" "$p" "$fa" "$seg" >> "$OUT/resumo.tsv"
  printf '%-28s %-7s pass=%-4s fail=%-3s %ss\n' "$nome" "$status" "$p" "$fa" "$seg"
done

echo
echo "TS_PASS=$total_pass"
echo "TS_FAIL=$total_fail"
echo "ARQUIVOS_OK=$arquivos_ok"
echo "ARQUIVOS_RUINS=$arquivos_ruins"
echo "RESUMO=$OUT/resumo.tsv"
[ "$arquivos_ruins" -eq 0 ] && [ "$total_fail" -eq 0 ]
