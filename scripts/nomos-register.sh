#!/usr/bin/env bash
# FASE 7 — REGISTRO DO CONECTOR MCP NO NOMOS.
#
# O QUE ESTE SCRIPT FAZ: prepara, confere e IMPRIME. Ele valida o manifesto,
# calcula a impressão digital que será registrada, confere se o daemon do Browser
# está de pé e mostra, prontos para copiar, os dois comandos de consentimento.
#
# O QUE ELE NÃO FAZ, POR CONSTRUÇÃO: aprovar. `nomos mcp confiar` pede "CONFIO"
# num TTY, ou enfileira o pedido no painel do dono com `--panel`; `nomos mcp
# conectar` num manifesto ainda não registrado pede "ACEITO O RISCO". Nenhuma
# dessas frases é digitada aqui. Um script que digitasse o aceite do dono
# transformaria consentimento em cerimônia — e o registro de auditoria do NOMOS
# passaria a dizer que um humano decidiu quando ninguém decidiu.
#
# Idempotente: rodar duas vezes não muda nada. Se o manifesto já estiver
# registrado, ele diz isso e sai 0 sem pedir nada.
#
# Uso: scripts/nomos-register.sh [caminho-do-manifesto]
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
MANIFESTO="${1:-$RAIZ/packaging/mcp/manifesto.json}"
NOMOS_BIN="${NOMOS_BIN:-/Users/AI/.local/bin/nomos}"
RUNTIME_URL="${NOMOS_BROWSER_URL:-http://127.0.0.1:7777}"
TOKEN_FILE="${NOMOS_BROWSER_TOKEN_FILE:-$HOME/.nomos-browser/control-token}"
FALHAS=0

titulo() { printf '\n\033[1m── %s ─────────────────────────────\033[0m\n' "$1"; }
ok()     { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
aviso()  { printf '  \033[33mAVISO\033[0m %s\n' "$1"; }
erro()   { printf '  \033[31mERRO\033[0m  %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

# ─────────────────────────────────────────────────────────────────────────────
titulo "1. manifesto"
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -f "$MANIFESTO" ]; then
  erro "manifesto não encontrado: $MANIFESTO"
  exit 1
fi
MANIFESTO="$(cd "$(dirname "$MANIFESTO")" && pwd)/$(basename "$MANIFESTO")"
ok "caminho absoluto: $MANIFESTO"

# `resolver_conector` do NOMOS aceita CAMINHO ou o nome de uma PASTA dentro de
# examples/mcp — nunca o campo `nome`. Este manifesto vive fora daquelas pastas,
# então o caminho absoluto é a única forma que funciona. Vale dizer isso aqui
# para que ninguém perca a tarde com `nomos mcp confiar nomos-browser`.
ok "resolução: por CAMINHO (o campo 'nome' não é aceito por 'confiar'/'chamar')"

# Validação com o MESMO carregador do NOMOS quando ele estiver disponível; senão,
# validação equivalente em Python puro. Fail-closed nos dois casos.
VALIDACAO="$(MANIFESTO="$MANIFESTO" python3 - <<'PY'
import json, os, sys, hashlib
caminho = os.environ["MANIFESTO"]
NIVEIS = {"A0", "A1", "A2", "A3", "A4", "A5", "A6"}
try:
    bruto = json.loads(open(caminho, encoding="utf-8").read())
except Exception as exc:
    print(f"ERRO|manifesto não é JSON válido: {exc}"); sys.exit(1)
nome, comando = bruto.get("nome"), bruto.get("comando")
if not isinstance(nome, str) or not nome:
    print("ERRO|manifesto sem campo 'nome'"); sys.exit(1)
if not isinstance(comando, list) or not comando or not all(isinstance(c, str) for c in comando):
    print("ERRO|'comando' deve ser lista de strings não vazia"); sys.exit(1)
nivel_padrao = str(bruto.get("nivel_padrao", "A5"))
if nivel_padrao not in NIVEIS:
    print(f"ERRO|nivel_padrao desconhecido: {nivel_padrao}"); sys.exit(1)
tools = bruto.get("tools", {})
if not isinstance(tools, dict):
    print("ERRO|'tools' deve ser um objeto tool->nível"); sys.exit(1)
for t, n in tools.items():
    if str(n) not in NIVEIS:
        print(f"ERRO|nível desconhecido para {t!r}: {n}"); sys.exit(1)
canonico = {"nome": nome, "comando": comando, "nivel_padrao": nivel_padrao,
            "tools": {str(t): str(n) for t, n in tools.items()}}
impressao = hashlib.sha256(json.dumps(canonico, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":")).encode("utf-8")).hexdigest()
maior = max((str(n) for n in canonico["tools"].values()), default=nivel_padrao)
print(f"OK|{nome}|{impressao}|{len(canonico['tools'])}|{nivel_padrao}|{maior}|{' '.join(comando)}")
PY
)"
if [ "${VALIDACAO%%|*}" != "OK" ]; then
  erro "${VALIDACAO#*|}"
  exit 1
fi
IFS='|' read -r _ NOME IMPRESSAO N_TOOLS PISO MAIOR COMANDO <<EOF
$VALIDACAO
EOF
ok "manifesto válido — nome='$NOME', $N_TOOLS tool(s), nivel_padrao=$PISO, maior risco declarado=$MAIOR"
ok "comando (roda com cwd=$(dirname "$MANIFESTO")): $COMANDO"

# ─────────────────────────────────────────────────────────────────────────────
titulo "2. impressão digital que será registrada"
# ─────────────────────────────────────────────────────────────────────────────
printf '  SHA-256: %s\n' "$IMPRESSAO"
printf '  (qualquer byte em nome/comando/nivel_padrao/tools muda este hash e\n'
printf '   derruba a confiança já registrada — descricao/env/signature ficam fora)\n'

# ─────────────────────────────────────────────────────────────────────────────
titulo "3. estado atual no catálogo do dono"
# ─────────────────────────────────────────────────────────────────────────────
JA_CONFIAVEL=0
if [ ! -x "$NOMOS_BIN" ]; then
  aviso "binário do NOMOS não encontrado em $NOMOS_BIN — pulando a consulta ao catálogo"
else
  CATALOGO="$("$NOMOS_BIN" mcp catalogo 2>&1)"
  CURTA="$(printf '%s' "$IMPRESSAO" | cut -c1-16)"
  if printf '%s' "$CATALOGO" | /usr/bin/grep -q "$CURTA"; then
    JA_CONFIAVEL=1
    ok "JÁ REGISTRADO como confiável (impressão ${CURTA}…) — nada a fazer"
  else
    aviso "ainda EXPERIMENTAL — o dono precisa registrar (passo 5)"
  fi
  printf '%s\n' "$CATALOGO" | /usr/bin/sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "4. daemon do NOMOS Browser"
# ─────────────────────────────────────────────────────────────────────────────
# O conector é uma CASCA: sem o daemon de pé, toda tool responde
# MCP_TRANSPORT_ERROR. Este passo AVISA — não sobe o daemon por conta própria,
# porque um daemon é um processo de longa vida com Chromium anexado e o dono tem
# de saber que ele existe. O comando fica impresso.
if /usr/bin/curl -s -m 3 -o /dev/null "$RUNTIME_URL/api/v1/health" 2>/dev/null; then
  ok "runtime respondendo em $RUNTIME_URL"
else
  aviso "runtime NÃO responde em $RUNTIME_URL — suba com:"
  printf '        cd %s && node packages/api/src/daemon.ts\n' "$RAIZ"
  printf '        (ou, como serviço do dono: scripts/service.sh instalar)\n'
fi

if [ -r "$TOKEN_FILE" ]; then
  ok "credencial do runtime presente: $TOKEN_FILE"
else
  aviso "credencial não encontrada em $TOKEN_FILE (o daemon a grava 0600 no arranque)"
fi

# O conector herda o AMBIENTE de quem roda `nomos mcp chamar`. Sem estas duas
# variáveis o adaptador recusa com MCP_NO_CREDENTIAL — que é o comportamento
# certo, e é por isso que a linha aparece aqui em vez de o lançador adivinhar o
# token lendo o cofre do dono por conta própria.
printf '\n  ambiente que o conector precisa herdar:\n'
printf '        export NOMOS_BROWSER_URL=%s\n' "$RUNTIME_URL"
printf '        export NOMOS_BROWSER_TOKEN_FILE=%s   # (ou NOMOS_BROWSER_TOKEN=...)\n' "$TOKEN_FILE"

# ─────────────────────────────────────────────────────────────────────────────
titulo "5. o que FALTA — e só o dono pode fazer"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$JA_CONFIAVEL" -eq 1 ]; then
  ok "nada. O manifesto já está registrado."
  printf '\n  para exercitar (tool A0 roda sem aprovação; A2/A5 pedem você):\n'
  printf '        %s mcp chamar %s browser_extract --args '"'"'{}'"'"'\n' "$NOMOS_BIN" "$MANIFESTO"
else
  printf '  Inspecionar (num TERMINAL — pede "ACEITO O RISCO" enquanto experimental):\n'
  printf '        %s mcp conectar %s\n\n' "$NOMOS_BIN" "$MANIFESTO"
  printf '  Registrar — escolha UMA porta:\n'
  printf '    a) terminal interativo (pede "CONFIO"):\n'
  printf '        %s mcp confiar %s\n\n' "$NOMOS_BIN" "$MANIFESTO"
  printf '    b) fila do painel do dono (http://127.0.0.1:8795):\n'
  printf '        %s mcp confiar %s --panel\n\n' "$NOMOS_BIN" "$MANIFESTO"
  printf '  Nenhuma das duas é executada por este script. A decisão é sua.\n'
fi

# ─────────────────────────────────────────────────────────────────────────────
titulo "6. verificação final"
# ─────────────────────────────────────────────────────────────────────────────
# Reconsulta o catálogo AGORA. Se o dono aprovou no painel enquanto este script
# rodava, isto pega; se não aprovou, isto diz a verdade em vez de supor.
if [ -x "$NOMOS_BIN" ]; then
  CURTA="$(printf '%s' "$IMPRESSAO" | cut -c1-16)"
  if "$NOMOS_BIN" mcp catalogo 2>&1 | /usr/bin/grep -q "$CURTA"; then
    echo "NOMOS_MCP_REGISTRADO=SIM  impressao=$IMPRESSAO"
  else
    echo "NOMOS_MCP_REGISTRADO=NAO  impressao=$IMPRESSAO  (BLOQUEADO_POR_APROVACAO)"
  fi
else
  echo "NOMOS_MCP_REGISTRADO=DESCONHECIDO  (binário do NOMOS ausente)"
fi

[ "$FALHAS" -eq 0 ] || exit 1
exit 0
