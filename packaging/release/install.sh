#!/usr/bin/env bash
# Instalador do NOMOS Browser (macOS, Apple Silicon/Intel).
# Rode de dentro do release descompactado:  bash install.sh
# Idempotente: re-rodar atualiza a instalação. Não toca Ollama global,
# não mata processos alheios, não apaga dados de outros produtos.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
# install.sh vive em packaging/release/ dentro do artefato; a raiz é dois acima.
SRC="$(cd "$AQUI/../.." && pwd)"
APP="$HOME/.nomos-browser/app"
BIN="$HOME/.local/bin"
LABEL="space.voltolini.nomos-browser"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "── NOMOS Browser — instalação"

# 1. Node ≥ 22.18 (o runtime executa TypeScript nativamente; sem build).
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale Node ≥ 22.18 (https://nodejs.org ou brew install node) e rode de novo."
  exit 1
fi
NODEBIN="$(command -v node)"
NV="$(node -v | sed 's/^v//')"
MAJ="${NV%%.*}"; RESTO="${NV#*.}"; MIN="${RESTO%%.*}"
if [ "$MAJ" -lt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -lt 18 ]; }; then
  echo "ERRO: Node $NV é antigo demais. Este produto exige Node ≥ 22.18."
  exit 1
fi
echo "   node $NV ok ($NODEBIN)"

# 2. Copiar a aplicação.
mkdir -p "$APP" "$HOME/.nomos-browser/logs" "$BIN" "$HOME/Library/LaunchAgents"
rsync -a --delete "$SRC/" "$APP/"
echo "   aplicação em $APP"

# 3. Dependências de runtime (playwright, ws) + Chromium.
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
( cd "$APP" && npx playwright install chromium >/dev/null 2>&1 || npx playwright install chromium )
echo "   dependências e Chromium prontos"

# 4. Provider de IA: detectar Ollama local. Sem ele o produto funciona inteiro,
#    menos o planejamento de tasks — e a Gi diz isso na tela em vez de fingir.
MODELO=""
if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/tmp/nomos-ollama-tags.json 2>/dev/null; then
  MODELO="$(python3 - <<'PY' 2>/dev/null || true
import json
tags=json.load(open('/tmp/nomos-ollama-tags.json'))
nomes=[m['name'] for m in tags.get('models',[])]
pref=[n for n in nomes if 'qwen2.5-coder' in n] or [n for n in nomes if 'coder' in n] or nomes
print(pref[0] if pref else '')
PY
)"
fi
COR="$(python3 -c "import json;print(json.load(open('$APP/packaging-info.json'))['corMarca'])" 2>/dev/null || echo "")"
python3 - "$APP/nomos-browser.config.json" "$MODELO" "$COR" <<'PY'
import json,sys
alvo,modelo,cor=sys.argv[1],sys.argv[2],sys.argv[3]
cfg={"spotlight":True}
if cor: cfg["spotlight_color"]=cor
if modelo: cfg["ai_provider"]="ollama:"+modelo
json.dump(cfg,open(alvo,"w"),indent=2)
PY
if [ -n "$MODELO" ]; then
  echo "   Ollama detectado — Gi vai planejar com: $MODELO"
else
  echo "   Ollama NÃO detectado. A Gi conversa e controla, mas não planeja tasks sem um modelo."
  echo "   Para habilitar depois: instale https://ollama.com, baixe um modelo (ex.: ollama pull qwen2.5-coder:7b)"
  echo "   e acrescente \"ai_provider\": \"ollama:qwen2.5-coder:7b\" em $APP/nomos-browser.config.json"
fi

# 5. CLI e LaunchAgent (inicia no login; nomos-browser start/stop controla).
install -m 0755 "$APP/packaging/release/nomos-browser" "$BIN/nomos-browser"
sed -e "s|__NODE__|$NODEBIN|g" -e "s|__APP__|$APP|g" -e "s|__HOME__|$HOME|g" \
  "$APP/packaging/release/launchagent.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
echo "   CLI em $BIN/nomos-browser · LaunchAgent instalado (inicia no login)"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "   AVISO: $BIN não está no PATH — acrescente ao seu shell";; esac

# 6. Subir agora.
"$BIN/nomos-browser" start

echo "── Pronto. Na janela do Chromium: clique no ícone NOMOS — o painel abre ao lado JÁ conectado. É só conversar com a Gi."
