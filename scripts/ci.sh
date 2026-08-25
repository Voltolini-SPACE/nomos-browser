#!/usr/bin/env bash
# FASE 38 — CI anti-regressão.
#
# O executável é ESTE script, não um YAML. Um workflow de CI que nunca rodou é
# uma promessa; um script que roda na máquina onde o produto vive é uma prova.
# `.github/workflows/ci.yml` apenas chama este arquivo, para que o que roda no
# runner seja idêntico ao que roda aqui.
#
# Estágios, do mais barato ao mais caro — a missão pede essa separação porque
# quebrar o rápido não deve custar dez minutos de Chromium para ser descoberto:
#
#   fast        unidade pura, sem Chromium, sem rede, sem LLM
#   integration daemon + Chromium real
#   e2e         gates ponta a ponta
#   adversarial segurança e ataques
#   guards      marca, segredos, desacoplamento
#   providers   FASE 5 — providers de modelo ligados ao runtime
#
# `providers` é estágio PRÓPRIO por causa da memória, não do tempo: é o único
# passo que pode carregar um modelo de vários GB, e nesta máquina (M2, 16 GB)
# dois modelos residentes ao mesmo tempo já mataram os serviços NOMOS de
# produção por jetsam. Isolado, ele descarrega antes e depois e confere a
# assinatura dos serviços vizinhos — ver `scripts/lib-memoria.sh`.
#
# Uso: scripts/ci.sh [fast|integration|e2e|adversarial|guards|providers|all]
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
ESTAGIO="${1:-all}"
FALHAS=0

titulo() { printf '\n\033[1m── %s ─────────────────────────────\033[0m\n' "$1"; }
checar() {
  local nome="$1"; shift
  printf '%-46s' "$nome"
  if "$@" >/tmp/ci-passo.log 2>&1; then
    printf 'OK\n'
  else
    printf 'FALHOU\n'
    /usr/bin/tail -12 /tmp/ci-passo.log | /usr/bin/sed 's/^/    /'
    FALHAS=$((FALHAS + 1))
  fi
}

testes() { node --test "$@"; }

RAPIDOS="auth lease skills traceability observability replay-hardening bench sdk-ts mcp cli policy-vault security-files-secrets security-net-injection ui-build"
# `cascata-percepcao` fica AQUI e não em `providers`: ele usa um VisionProvider
# espião determinístico e não carrega modelo nenhum. O que ele prova é o FIO —
# que a cascata chega ao 5º degrau em produção; quem prova o modelo é o estágio
# `providers` e o e2e de visão.
# `task-engine` (FASE 9) fica na INTEGRAÇÃO e não em `fast`: ele sobe daemon com
# Chromium real, derruba um `BrowserContext` por baixo de uma sessão e mata um
# processo filho com SIGKILL. Nenhuma dessas coisas cabe em "unidade pura" — e
# nenhuma delas carrega modelo, então também não pertence ao estágio `providers`.
INTEGRACAO="session perception pointer-keyboard target-verifier click-entrega cascata-percepcao api task-engine"
E2E="e2e-gate product02-gate"
ADVERSARIAIS="security-net-injection security-files-secrets recovery-watchdog injection-wired audit-forense"

if [ "$ESTAGIO" = "fast" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "fast — unidade pura"
  for t in $RAPIDOS; do
    [ -f "tests/$t.test.ts" ] && checar "test:$t" testes "tests/$t.test.ts"
  done
  checar "python:sdk" bash -c "cd '$RAIZ/sdk-python' && python3 -m unittest discover -s tests"

  # Node v26 só faz type-stripping: sem este passo, nada aqui é verificado por um
  # typechecker. Foi assim que um `--token` silenciosamente ignorado sobreviveu a
  # 551 testes verdes.
  checar "typecheck" npx tsc --noEmit -p tsconfig.json
fi

if [ "$ESTAGIO" = "guards" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "guards — marca, segredos, desacoplamento"

  checar "build:ui" node packages/ui/build.ts

  # Nenhum hex de marca no fonte da UI (contrato de governança §6.3).
  checar "marca:sem-hex-no-fonte" bash -c \
    '! /usr/bin/grep -qE "#[0-9A-Fa-f]{6}\b" packages/ui/src/app.html'

  # dist/ carrega tokens e não pode ser versionado.
  checar "marca:dist-nao-versionado" bash -c \
    '/usr/bin/grep -qE "^dist/$|^packages/ui/dist/$" .gitignore'

  # A marca é PROPOSTA até o dono congelar; o build tem de dizer isso.
  checar "marca:selo-declarado" bash -c \
    'node packages/ui/build.ts | /usr/bin/grep -qE "PROPOSTA|OFICIAL"'

  # Varredura de segredo no que É versionado. Arquivo ignorado não conta —
  # mas token real commitado, sim.
  checar "segredo:nada-no-versionado" bash -c '
    alvos=$(git ls-files -- "*.ts" "*.js" "*.py" "*.json" "*.md" "*.sh" "*.html" 2>/dev/null)
    [ -z "$alvos" ] && exit 0
    # Padrões de credencial real, não a PALAVRA "token".
    if printf "%s\n" $alvos | xargs /usr/bin/grep -lE "(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})" 2>/dev/null | /usr/bin/grep -q .; then
      echo "credencial encontrada em arquivo versionado"; exit 1
    fi
    exit 0'

  # Desacoplamento: as cascas de cliente não podem falar com o navegador.
  checar "desacoplamento:mcp-sem-playwright" bash -c \
    '! /usr/bin/grep -rlE "^\s*import .*\"playwright\"|require\(\"playwright\"\)" packages/mcp/src packages/sdk/src packages/cli/src 2>/dev/null | /usr/bin/grep -q .'

  # Nenhuma dependência flutuante: @latest, ^ e ~ são proibidos em produção.
  checar "deps:versoes-pinadas" bash -c '
    if /usr/bin/grep -hoE "\"(playwright|ws|typescript|@types/[a-z]+)\": \"[^\"]+\"" package.json packages/*/package.json 2>/dev/null \
       | /usr/bin/grep -qE ":\s*\"[\^~]|latest"; then
      echo "dependência não pinada"; exit 1
    fi
    exit 0'

  # O runtime não pode nascer aberto para a rede.
  #
  # Verificação de COMPORTAMENTO, não de texto: a primeira versão fazia grep por
  # `host: "127.0.0.1"` e acusava falso positivo, porque o default vem de uma
  # constante. Um guarda que quebra ao renomear uma constante não guarda nada.
  checar "rede:bind-loopback-por-default" node --input-type=module -e '
    const { loadConfig, DEFAULT_HOST } = await import("./packages/api/src/config.ts");
    const c = loadConfig({});
    const loopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";
    if (!loopback(c.host)) { console.error(`host default não é loopback: ${c.host}`); process.exit(1); }
    if (!loopback(DEFAULT_HOST)) { console.error(`DEFAULT_HOST não é loopback: ${DEFAULT_HOST}`); process.exit(1); }
    if (loadConfig({ host: "0.0.0.0" }).host !== "0.0.0.0") { console.error("bind explícito deveria ser possível"); process.exit(1); }
  '

  # Autenticação ligada por default. `auth_disabled` existe para migração e não
  # pode virar o caminho normal por descuido.
  checar "auth:ligada-por-default" node --input-type=module -e '
    const { AuthManager } = await import("./packages/api/src/auth.ts");
    const a = new AuthManager();
    if (a.disabled) { console.error("AuthManager nasceu desligado"); process.exit(1); }
    const r = a.authenticate(null);
    if (r.ok) { console.error("credencial ausente foi aceita"); process.exit(1); }
  '
fi

if [ "$ESTAGIO" = "integration" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "integration — daemon e Chromium reais"
  for t in $INTEGRACAO; do
    [ -f "tests/$t.test.ts" ] && checar "test:$t" testes "tests/$t.test.ts"
  done
fi

if [ "$ESTAGIO" = "adversarial" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "adversarial — segurança e falha"
  for t in $ADVERSARIAIS; do
    [ -f "tests/$t.test.ts" ] && checar "test:$t" testes "tests/$t.test.ts"
  done
fi

if [ "$ESTAGIO" = "e2e" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "e2e — gates ponta a ponta"
  for t in $E2E; do
    [ -f "tests/$t.test.ts" ] && checar "test:$t" testes "tests/$t.test.ts"
  done
fi

if [ "$ESTAGIO" = "providers" ] || [ "$ESTAGIO" = "all" ]; then
  titulo "providers — modelos ligados ao runtime (FASE 5)"
  # shellcheck source=lib-memoria.sh
  . "$RAIZ/scripts/lib-memoria.sh"

  PROD_ANTES="$(producao_assinatura)"
  # Um run interrompido deixa modelo residente. Começar limpo não é higiene
  # opcional: foi com 5,13 GB presos que o gate anterior estourou por timeout.
  descarregar_todos >/dev/null 2>&1 || true
  printf '%-46s%s\n' "memoria:disponivel-antes" "$(mem_disponivel_gb) GB (livre $(mem_livre_pct)%)"

  checar "test:providers-runtime" testes "tests/providers-runtime.test.ts"

  descarregar_todos >/dev/null 2>&1 || true
  RESIDENTES="$(residentes | tr '\n' ' ')"
  checar "memoria:nenhum-modelo-residente" bash -c "[ -z \"$RESIDENTES\" ]"
  printf '%-46s%s\n' "memoria:disponivel-depois" "$(mem_disponivel_gb) GB (livre $(mem_livre_pct)%)"

  # Guarda de produção: os serviços NOMOS têm de sair vivos e com os MESMOS
  # PIDs. Assinatura diferente = algum deles morreu e o launchd o reiniciou —
  # exatamente o que passou despercebido numa missão anterior.
  PROD_DEPOIS="$(producao_assinatura)"
  checar "producao:sobreviveu-intacta" bash -c "[ \"$PROD_ANTES\" = \"$PROD_DEPOIS\" ]"
fi

titulo "resultado"
if [ "$FALHAS" -eq 0 ]; then
  echo "CI_PASS=YES"
  exit 0
fi
echo "CI_PASS=NO  ($FALHAS passo(s) falharam)"
exit 1
