#!/usr/bin/env bash
# Sonda de memória e guarda de produção.
#
# Existe por uma causa medida, não por precaução genérica: nesta máquina (M2,
# 16 GB) rodar os testes de LLM junto com o resto produziu (a) gates falhando por
# timeout de carregamento — `qwen3.5:4b-q8_0` estourou 180 s onde isolado
# responde em 3,8 s — e (b) os serviços NOMOS de PRODUÇÃO sendo mortos com
# SIGKILL pelo jetsam do macOS e reiniciados pelo launchd.
#
# O sinal certo NÃO é o swap. Medido: descarregar um modelo de 5,13 GB moveu o
# disponível de 2,5 GB para 5,6 GB enquanto o swap usado saiu de 16769 MB para
# 16714 MB — praticamente parado. Swap no macOS não encolhe quando a pressão
# passa. O que prevê "o modelo vai carregar a tempo" é a memória DISPONÍVEL
# (free + inactive + purgeable).

# Memória disponível em GB: páginas livres + inativas + purgáveis.
mem_disponivel_gb() {
  /usr/bin/vm_stat | /usr/bin/awk '
    /Pages free|Pages inactive|Pages purgeable/ { gsub(/\./, "", $NF); s += $NF }
    END { printf "%.2f", s * 16384 / 1073741824 }'
}

# Percentual livre segundo o próprio macOS. Segunda opinião, fonte independente.
mem_livre_pct() {
  memory_pressure 2>/dev/null \
    | /usr/bin/grep -i "free percentage" \
    | /usr/bin/sed -E 's/.*: *([0-9]+)%.*/\1/' \
    | head -1
}

# Tamanho declarado de um modelo do Ollama, em GB. Vazio se desconhecido.
modelo_gb() {
  local modelo="$1"
  curl -s --max-time 8 http://127.0.0.1:11434/api/tags -o /tmp/nomos-tags.json 2>/dev/null || return 1
  python3 - "$modelo" <<'PY' 2>/dev/null
import json, sys
alvo = sys.argv[1]
try:
    d = json.load(open("/tmp/nomos-tags.json"))
except Exception:
    sys.exit(1)
for m in d.get("models", []):
    if m.get("name") == alvo:
        print(f"{m.get('size', 0) / 1e9:.2f}")
        sys.exit(0)
sys.exit(1)
PY
}

# Descarrega TODOS os modelos conhecidos e confirma que nenhum ficou residente.
# Um run interrompido deixa modelo na RAM — foi assim que encontrei 5,13 GB
# presos depois de matar a suíte.
descarregar_todos() {
  local modelos
  modelos=$(curl -s --max-time 8 http://127.0.0.1:11434/api/tags -o /tmp/nomos-tags.json 2>/dev/null \
    && python3 -c "
import json
try: print(' '.join(m['name'] for m in json.load(open('/tmp/nomos-tags.json')).get('models', [])))
except Exception: pass" 2>/dev/null)
  for m in $modelos; do
    curl -s --max-time 30 -X POST http://127.0.0.1:11434/api/generate \
      -d "{\"model\":\"$m\",\"keep_alive\":0}" -o /dev/null 2>/dev/null || true
  done
  sleep 3
  residentes
}

# Nomes dos modelos atualmente na memória, um por linha.
residentes() {
  curl -s --max-time 8 http://127.0.0.1:11434/api/ps -o /tmp/nomos-ps.json 2>/dev/null || return 0
  python3 -c "
import json
try:
    for m in json.load(open('/tmp/nomos-ps.json')).get('models', []): print(m['name'])
except Exception: pass" 2>/dev/null
}

# ── Guarda de produção ───────────────────────────────────────────────────────
#
# Assinatura dos serviços NOMOS. Se mudar entre antes e depois, algum deles
# morreu e voltou — foi exatamente o que aconteceu na missão anterior, e passou
# despercebido até eu comparar PIDs no fim.
producao_assinatura() {
  launchctl list 2>/dev/null \
    | /usr/bin/grep -iE "nomos|omniroute" \
    | /usr/bin/awk '{print $3"="$1}' \
    | sort
}

producao_viva() {
  [ -n "$(producao_assinatura)" ]
}
