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

# ── residência de LLM e memória livre ───────────────────────────────────────
#
# Um arquivo MORTO por timeout não roda o `after()` dele. Quando esse arquivo
# carregou um modelo local, o modelo fica RESIDENTE — e o Ollama grava o
# `keep_alive` pedido, que nos testes é longo: um `expires_at` no ano 2318 foi
# encontrado numa execução real. Cinco gigabytes presos assim não voltam
# sozinhos, e o vizinho seguinte falha por falta de memória, não por defeito.
#
# Essa é a falha de instrumento mais cara desta suíte porque ela MENTE bem: o
# sintoma é asserção de latência estourando, lease expirando e Chromium morrendo
# — tudo com cara de regressão de produto. Numa execução real ela produziu seis
# arquivos vermelhos que estavam verdes minutos antes e voltaram a ficar verdes
# depois, sem que uma linha de produto mudasse.
#
# Duas correções, e nenhuma delas é "aumentar o timeout":
#   · descarrega o que estiver residente DEPOIS de cada arquivo, não só antes
#     dos três que carregam modelo (o estrago é para quem vem DEPOIS);
#   · lê a lista do próprio `/api/ps` em vez de uma lista fixa de nomes, que
#     silenciosamente não cobre um modelo novo.
descarregar_residentes() {
  local ps_json
  ps_json="$(curl -s --max-time 8 http://127.0.0.1:11434/api/ps 2>/dev/null)" || return 0
  [ -z "$ps_json" ] && return 0
  printf '%s' "$ps_json" \
    | /usr/bin/python3 -c 'import sys,json;d=json.load(sys.stdin);print("\n".join(m["name"] for m in d.get("models",[])))' 2>/dev/null \
    | while IFS= read -r m; do
        [ -z "$m" ] && continue
        curl -s --max-time 20 -X POST http://127.0.0.1:11434/api/generate \
          -d "{\"model\":\"${m}\",\"keep_alive\":0}" -o /dev/null 2>/dev/null || true
      done
  return 0
}

# Percentual de memória livre do sistema. Vazio quando indisponível — nunca
# inventa um número, porque este valor entra no relatório como MEDIDA.
mem_livre() {
  memory_pressure 2>/dev/null \
    | /usr/bin/awk -F': *' '/free percentage/{gsub(/%/,"",$2); print $2; exit}'
}

# Gigabytes de modelo presos agora. Mesma regra: vazio quando não deu para ler.
residente_gb() {
  curl -s --max-time 8 http://127.0.0.1:11434/api/ps 2>/dev/null \
    | /usr/bin/python3 -c 'import sys,json;d=json.load(sys.stdin);print(round(sum(m["size"] for m in d.get("models",[]))/1e9,2))' 2>/dev/null
}

mkdir -p "$OUT"
rm -f "$OUT"/*.log "$OUT/resumo.tsv" 2>/dev/null || true

total_pass=0
total_fail=0
arquivos_ok=0
arquivos_ruins=0

printf 'arquivo\tstatus\tpass\tfail\tsegundos\tmem_livre_pct\tllm_gb\n' > "$OUT/resumo.tsv"

for f in "$RAIZ"/tests/*.test.ts; do
  nome="$(basename "$f" .test.ts)"
  if [ "$FAST" -eq 1 ] && printf '%s' "$LENTOS" | /usr/bin/grep -qw "$nome"; then
    printf '%s\tPULADO\t0\t0\t0\n' "$nome" >> "$OUT/resumo.tsv"
    continue
  fi

  # Testes que carregam LLM competem por memória. Devolver o que ficou residente
  # antes de cada um evita que o vizinho anterior estoure o timeout deste — o
  # gate de visão falhava por 121s de carregamento, não por erro de código.
  descarregar_residentes
  mem_ini="$(mem_livre)"
  gb_ini="$(residente_gb)"

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
  # DEPOIS: é aqui que mora a correção. Um arquivo morto no meio deixa o modelo
  # preso, e quem paga é o próximo — não ele.
  descarregar_residentes

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
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$nome" "$status" "$p" "$fa" "$seg" "${mem_ini:-?}" "${gb_ini:-?}" >> "$OUT/resumo.tsv"
  printf '%-28s %-7s pass=%-4s fail=%-3s %ss  mem=%s%% llm=%sGB\n' \
    "$nome" "$status" "$p" "$fa" "$seg" "${mem_ini:-?}" "${gb_ini:-?}"
  # MORTO com memória apertada quase nunca é defeito de produto. Dizer isso na
  # hora evita que o leitor do relatório abra uma caça a um bug que não existe.
  if [ "$status" = "MORTO" ] && [ -n "${mem_ini:-}" ] && [ "${mem_ini%%.*}" -lt 35 ] 2>/dev/null; then
    printf '    ^ atencao: memoria livre em %s%% e %sGB de LLM residente ao iniciar este arquivo.\n' \
      "$mem_ini" "${gb_ini:-?}"
    printf '      MORTO sob starvation NAO e evidencia de regressao. Reexecute o arquivo isolado.\n'
  fi
done

echo
echo "TS_PASS=$total_pass"
echo "TS_FAIL=$total_fail"
echo "ARQUIVOS_OK=$arquivos_ok"
echo "ARQUIVOS_RUINS=$arquivos_ruins"
echo "RESUMO=$OUT/resumo.tsv"
[ "$arquivos_ruins" -eq 0 ] && [ "$total_fail" -eq 0 ]
