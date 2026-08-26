#!/usr/bin/env bash
# Empacota o release público do NOMOS Browser.
#   bash scripts/empacotar-release.sh
# Saída em dist-release/: tarball do produto (com a extensão JÁ construída do
# cofre), zip da extensão (CWS/carga manual) e SHA256SUMS.txt.
# Fonte do tarball é `git archive HEAD`: só o que está commitado viaja — o que
# o scan de segredos aprovou é exatamente o que é publicado. Evidence,
# marketing e checkpoints ficam de fora do artefato (são do repositório, não
# do produto instalável).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

# Árvore suja produziria um artefato que MENTE (fonte = HEAD, mas o dev está
# olhando para mudanças não commitadas). O primeiro empacotamento desta missão
# fez exatamente isso; a guarda existe para nunca mais.
if ! git diff-index --quiet HEAD --; then
  echo "ERRO: árvore com mudanças não commitadas — commit antes de empacotar." >&2
  git status --short | head -10 >&2
  exit 1
fi

VERSAO="$(node -p "require('./package.json').version")"
OUT="$RAIZ/dist-release"
STAGE="$OUT/stage/nomos-browser-v$VERSAO"
rm -rf "$OUT"; mkdir -p "$STAGE"

echo "── 1. extensão do cofre vigente"
COR="$(node -e "import('./packages/extension/build.ts').then(m=>{const r=m.buildExtension();console.log(r.corMarca);})")"
echo "   cor da marca: $COR"

echo "── 2. fonte = git archive HEAD (só o commitado)"
git archive HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/evidence" "$STAGE/marketing" "$STAGE/checkpoints" "$STAGE/.github" "$STAGE/spike"

echo "── 3. dist da extensão + packaging-info"
mkdir -p "$STAGE/packages/extension"
cp -R "$RAIZ/packages/extension/dist" "$STAGE/packages/extension/dist"
printf '{\n  "version": "%s",\n  "corMarca": "%s"\n}\n' "$VERSAO" "$COR" > "$STAGE/packaging-info.json"

echo "── 4. artefatos"
TAR="$OUT/nomos-browser-v$VERSAO.tar.gz"
ZIPX="$OUT/nomos-browser-extension-v$VERSAO.zip"
( cd "$OUT/stage" && tar -czf "$TAR" "nomos-browser-v$VERSAO" )
( cd "$RAIZ/packages/extension/dist" && zip -qr "$ZIPX" . )
( cd "$OUT" && shasum -a 256 "$(basename "$TAR")" "$(basename "$ZIPX")" > SHA256SUMS.txt )
rm -rf "$OUT/stage"

echo "── pronto"
cat "$OUT/SHA256SUMS.txt"
echo "instalação: descompactar o tarball e rodar  bash packaging/release/install.sh"
