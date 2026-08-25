#!/usr/bin/env bash
# FASE 38 + FASE 16 — CI anti-regressão. MATRIZ COMPLETA.
#
# O executável é ESTE script, não um YAML. Um workflow de CI que nunca rodou é
# uma promessa; um script que roda na máquina onde o produto vive é uma prova.
# `.github/workflows/ci.yml` apenas chama este arquivo, para que o que roda no
# runner seja idêntico ao que roda aqui.
#
# ── POR QUE A MATRIZ FOI REORGANIZADA (FASE 16) ──────────────────────────────
#
# A auditoria da validação anterior encontrou `tests/vision.test.ts` e
# `tests/aiprovider.test.ts` — 2.034 linhas — FORA de todo estágio: `ci.sh all`
# nunca os executava. A causa não foi descuido pontual, foi ESTRUTURAL: os
# estágios eram listas soltas e nada comparava a união dessas listas com
# `ls tests/*.test.ts`. Uma lista que ninguém confere é uma lista que envelhece.
#
# Duas mudanças fecham isso, e as duas são de INSTRUMENTO, não de teste:
#
#   1. A matriz virou declaração ÚNICA no topo deste arquivo (`E_<ESTAGIO>`), e
#      `scripts/ci.sh --listar-estagios` a publica em texto. Ninguém precisa
#      reler o corpo do script para saber o que roda onde.
#   2. `scripts/ci-cobertura.sh` lê essa publicação e FALHA se algum arquivo de
#      teste ficar fora de todo estágio (ou se um estágio citar arquivo que não
#      existe). É passo do estágio `fast`, então quebra barato.
#
# Um arquivo declarado e ausente agora é FALHA, não `skip` silencioso: o `[ -f ]
# && checar` antigo fazia um teste renomeado desaparecer da CI sem uma linha de
# aviso — mesmo defeito, outra porta.
#
# ── OS ESTÁGIOS E O QUE CADA UM CONTÉM ───────────────────────────────────────
#
#   fast        unidade pura, sem Chromium, sem rede, sem LLM.
#               Inclui os guardas estáticos (marca, deps pinadas, desacoplamento)
#               e o passo de cobertura da própria matriz.
#   core        DOM, input, percepção, alvo, sessão — Chromium real.
#   security    security-*, injection-wired, ownership, auth, policy-vault,
#               mais os guardas de default fechado (bind loopback, lease, auth,
#               watchdog, classificação do manifesto MCP, varredura de segredo).
#   providers   aiprovider, vision, providers-runtime, cascata-percepcao.
#               Estágio PRÓPRIO por causa da MEMÓRIA, não do tempo: é o único
#               passo que pode carregar modelo de vários GB, e nesta máquina
#               (M2, 16 GB) dois modelos residentes já mataram os serviços NOMOS
#               de produção por jetsam. Descarrega antes, entre e depois, e
#               confere a assinatura dos vizinhos — ver `scripts/lib-memoria.sh`.
#   integration api, mcp, sdk, cli, task-engine, click-entrega, audit-forense —
#               daemon e Chromium reais.
#   adversarial ataques e falhas provocadas, recovery e watchdog, mais as duas
#               baterias de vetores de segurança.
#   e2e         e2e-gate, product02-gate.
#   recovery    recovery-watchdog, supervisor.
#   cleanroom   subconjunto HERMÉTICO (sem Chromium, sem cofre de marca, sem
#               serviço de produção) — chamado só por `scripts/clean-room.sh`,
#               que clona o HEAD num diretório temporário e prova a instalação
#               do zero. Por isso NÃO entra em `all`.
#
# `all` roda tudo menos `cleanroom`.
#
# Uso: scripts/ci.sh [fast|core|security|providers|integration|adversarial|e2e|recovery|cleanroom|all]
#      scripts/ci.sh --listar-estagios   # matriz em texto, um "estagio<TAB>teste" por linha
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
ESTAGIO="${1:-all}"
FALHAS=0

# ─────────────────────────────────────────────────────────────────────────────
# MATRIZ — FONTE ÚNICA. Nomes sem `tests/` e sem `.test.ts`.
#
# Um mesmo arquivo pode aparecer em mais de um estágio de propósito: os testes
# de segurança são unidade E vetor de ataque, e um runner que só roda o job
# `adversarial` precisa deles ali. Duplicar execução custa tempo; não duplicar
# custa cobertura num job isolado — o segundo é mais caro.
# ─────────────────────────────────────────────────────────────────────────────
E_FAST="bench lease observability replay-hardening skills traceability ui-build config-schema"
E_CORE="session perception pointer-keyboard target-verifier"
E_SECURITY="auth policy-vault ownership injection-wired security-files-secrets security-net-injection"
E_PROVIDERS="aiprovider vision providers-runtime cascata-percepcao"
E_INTEGRATION="api mcp sdk-ts cli task-engine click-entrega audit-forense backpressure-audit"
E_ADVERSARIAL="security-net-injection security-files-secrets injection-wired watchdog-wired recovery-watchdog"
E_E2E="e2e-gate product02-gate"
# `supervisor` roda com HOME sandboxado: não sobe Chromium e não toca no launchd
# desta máquina. O ciclo completo contra o launchd real é `prova-supervisor.sh`,
# ato deliberado que NÃO entra em CI (esta máquina roda produção).
E_RECOVERY="recovery-watchdog supervisor"
E_CLEANROOM="config-schema lease skills traceability observability replay-hardening bench sdk-ts policy-vault"

ESTAGIOS="fast core security providers integration adversarial e2e recovery cleanroom"
ESTAGIOS_ALL="fast core security providers integration adversarial e2e recovery"

# Publicação da matriz. Tem de vir ANTES de qualquer trabalho: `ci-cobertura.sh`
# chama isto e não pode pagar um typecheck para descobrir a lista.
if [ "$ESTAGIO" = "--listar-estagios" ]; then
  for e in $ESTAGIOS; do
    nome_var="E_$(printf '%s' "$e" | tr '[:lower:]' '[:upper:]')"
    eval "lista=\${$nome_var}"
    for t in $lista; do printf '%s\t%s\n' "$e" "$t"; done
  done
  exit 0
fi

if [ "$ESTAGIO" != "all" ] && ! printf '%s\n' $ESTAGIOS | /usr/bin/grep -qx "$ESTAGIO"; then
  echo "estagio desconhecido: $ESTAGIO"
  echo "conhecidos: all $ESTAGIOS (e --listar-estagios)"
  exit 2
fi

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
# Passo que NÃO PODE rodar nesta máquina diz isso em voz alta, com a razão.
# Nunca vira OK: verde por impossibilidade é a mentira mais cara de uma CI.
pular() { printf '%-46sPULADO (%s)\n' "$1" "$2"; }

testes() { node --test "$@"; }

# Roda a lista de um estágio. Arquivo declarado e AUSENTE é falha — ver o
# cabeçalho: o `[ -f ] && checar` antigo apagava um teste renomeado em silêncio.
rodar_testes() {
  local t
  for t in $1; do
    if [ -f "tests/$t.test.ts" ]; then
      checar "test:$t" testes "tests/$t.test.ts"
    else
      printf '%-46sFALHOU (tests/%s.test.ts nao existe)\n' "test:$t" "$t"
      FALHAS=$((FALHAS + 1))
    fi
  done
}

# `all` = todos os estágios menos `cleanroom`.
roda() {
  [ "$ESTAGIO" = "$1" ] && return 0
  if [ "$ESTAGIO" = "all" ]; then
    printf '%s\n' $ESTAGIOS_ALL | /usr/bin/grep -qx "$1" && return 0
  fi
  return 1
}

# O cofre de marca é da MÁQUINA DO DONO, não do repositório. Num runner limpo
# ele não existe e `packages/ui/build.ts` falha fechado — comportamento correto
# do build, e informação inútil como falha de CI. Aqui a precondição é checada
# e o passo sai PULADO com a razão, em vez de derrubar o estágio.
COFRE_MARCA="${HOME:-}/.brand-governance/bin/brand-resolve.sh"

if roda fast; then
  titulo "fast — unidade pura + guardas estáticos"
  rodar_testes "$E_FAST"

  # A matriz tem de cobrir TODO arquivo de teste. Barato e primeiro: descobrir
  # que um teste saiu da CI não deve custar dez minutos de Chromium.
  checar "ci:cobertura-da-matriz" bash "$RAIZ/scripts/ci-cobertura.sh"

  checar "python:sdk" bash -c "cd '$RAIZ/sdk-python' && python3 -m unittest discover -s tests"

  # Node v26 só faz type-stripping: sem este passo, nada aqui é verificado por um
  # typechecker. Foi assim que um `--token` silenciosamente ignorado sobreviveu a
  # 551 testes verdes.
  checar "typecheck" npx tsc --noEmit -p tsconfig.json

  if [ -x "$COFRE_MARCA" ]; then
    checar "build:ui" node packages/ui/build.ts
    # A marca é PROPOSTA até o dono congelar; o build tem de dizer isso.
    checar "marca:selo-declarado" bash -c \
      'node packages/ui/build.ts | /usr/bin/grep -qE "PROPOSTA|OFICIAL"'
  else
    pular "build:ui" "cofre de marca ausente: $COFRE_MARCA"
    pular "marca:selo-declarado" "cofre de marca ausente"
  fi

  # Nenhum hex de marca no fonte da UI (contrato de governança §6.3). Estático:
  # roda em qualquer máquina, com ou sem cofre.
  checar "marca:sem-hex-no-fonte" bash -c \
    '! /usr/bin/grep -qE "#[0-9A-Fa-f]{6}\b" packages/ui/src/app.html'

  # dist/ carrega tokens e não pode ser versionado.
  checar "marca:dist-nao-versionado" bash -c \
    '/usr/bin/grep -qE "^dist/$|^packages/ui/dist/$" .gitignore'

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

  # FASE 17 — todo pacote sob packages/ tem manifesto, e os manifestos são
  # coerentes com a raiz. Sem isto, um pacote novo entra no workspace sem nome,
  # sem licença e sem `exports`, e só se descobre no dia do empacotamento.
  checar "pacotes:manifestos-completos" node scripts/verificar-manifestos.ts

  # FASE 100 — a versao do produto era escrita a mao em TREZE lugares e nada
  # obrigava os treze a concordarem. Pior: as asserções eram contra o LITERAL
  # "0.1.0", entao o teste que deveria pegar a deriva era justamente o que
  # precisava ser editado a cada bump. Agora a raiz e a fonte e o resto bate.
  checar "versao:coerente-em-todo-o-produto" node scripts/verificar-versao-coerente.ts
  checar "versao:guarda-de-coerencia-nao-e-cego" node scripts/verificar-versao-coerente.ts --autoteste

  # FASE 17 — a tabela publicada tem de ser a tabela ATUAL. Um `.md` gerado que
  # ninguém regenera é a mesma lista escrita à mão que esta fase existe para
  # matar, só que com carimbo de "gerado".
  checar "config:tabela-gerada-esta-atual" bash -c '
    node scripts/config-schema.ts --markdown > /tmp/config-gerado.md || exit 1
    /usr/bin/diff -q /tmp/config-gerado.md docs/_gerado/CONFIGURATION.generated.md >/dev/null \
      || { echo "docs/_gerado/CONFIGURATION.generated.md desatualizado — rode: node scripts/config-schema.ts --markdown --escrever"; exit 1; }'

  # FASE 14 — a label do supervisor não pode colidir com produção.
  checar "supervisor:label-propria" bash -c '
    for L in br.com.se7enpay.nomos.servico com.nomos.panel ai.sovereign.omniroute com.gijarvis.backend; do
      if /usr/bin/grep -q "^LABEL=\"$L\"" scripts/service.sh; then echo "colide com $L"; exit 1; fi
    done
    /usr/bin/plutil -lint packaging/launchd/ai.nomos.browser.plist >/dev/null'

  # O lancador do manifesto tem de arrancar de verdade. `comando` quebrado so
  # apareceria no dia em que o dono rodasse `nomos mcp conectar`.
  checar "mcp:lancador-do-manifesto-fala-mcp" bash -c '
    cd packaging/mcp || exit 1
    resposta=$(printf "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"nomos-mcp-client\"}}}\n" | node servidor.mjs 2>/dev/null | head -1)
    printf "%s" "$resposta" | /usr/bin/grep -q "\"protocolVersion\":\"2024-11-05\"" || { echo "lancador nao respondeu o handshake do NOMOS: $resposta"; exit 1; }
    printf "%s" "$resposta" | /usr/bin/grep -q "nomos-browser-mcp" || { echo "serverInfo errado: $resposta"; exit 1; }'
fi

if roda core; then
  titulo "core — DOM, input, percepção, alvo, sessão (Chromium real)"
  rodar_testes "$E_CORE"
fi

if roda security; then
  titulo "security — testes de segurança + defaults fechados"
  rodar_testes "$E_SECURITY"

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

  # FASE 7 — O MANIFESTO MCP NÃO PODE DESCLASSIFICAR NADA POR OMISSÃO.
  #
  # `packaging/mcp/manifesto.json` é o que o dono registra no NOMOS; o SHA-256
  # dele vira a confiança. O risco real não é um manifesto inválido (o NOMOS
  # recusa isso sozinho, fail-closed) — é uma tool NOVA em `tools.ts` que ninguém
  # classificou: `nivel_da_tool` devolve o `nivel_padrao` para toda tool não
  # declarada, então a tool nasceria com o piso, e um piso baixo a faria rodar
  # SEM aprovação do dono. Este passo é unidade pura: lê os dois arquivos e
  # compara. Sem Chromium, sem rede, sem NOMOS instalado. Mora em `security`
  # porque o que ele guarda é AUTORIZAÇÃO, não estilo.
  checar "mcp:manifesto-classifica-todas-as-tools" node --input-type=module -e '
    const { readFileSync } = await import("node:fs");
    const { TOOL_NAMES } = await import("./packages/mcp/src/tools.ts");
    const NIVEIS = ["A0", "A1", "A2", "A3", "A4", "A5", "A6"];
    let m;
    try { m = JSON.parse(readFileSync("packaging/mcp/manifesto.json", "utf8")); }
    catch (e) { console.error(`manifesto nao e JSON valido: ${e.message}`); process.exit(1); }
    if (typeof m.nome !== "string" || m.nome === "") { console.error("manifesto sem nome"); process.exit(1); }
    if (!Array.isArray(m.comando) || m.comando.length === 0 || !m.comando.every((c) => typeof c === "string")) {
      console.error("comando deve ser lista de strings nao vazia"); process.exit(1);
    }
    // O piso vale para tool DESCONHECIDA (inclusive a que ainda nao existe).
    // A5 e a unica escolha honesta: capacidade nao classificada e tratada como
    // execucao de codigo, e o NOMOS exige o dono antes de rodar.
    if (m.nivel_padrao !== "A5") { console.error(`nivel_padrao deve ser A5 (fail-closed), veio ${m.nivel_padrao}`); process.exit(1); }
    const tools = m.tools ?? {};
    if (typeof tools !== "object" || tools === null || Array.isArray(tools)) { console.error("tools deve ser objeto"); process.exit(1); }
    for (const [t, n] of Object.entries(tools)) {
      if (!NIVEIS.includes(String(n))) { console.error(`nivel invalido para ${t}: ${n}`); process.exit(1); }
    }
    const faltando = TOOL_NAMES.filter((t) => !(t in tools));
    if (faltando.length > 0) { console.error(`tool sem classificacao no manifesto: ${faltando.join(", ")}`); process.exit(1); }
    const sobrando = Object.keys(tools).filter((t) => !TOOL_NAMES.includes(t));
    if (sobrando.length > 0) { console.error(`manifesto classifica tool inexistente: ${sobrando.join(", ")}`); process.exit(1); }
  '

  # FASE 40 — O NÍVEL DE UMA TOOL VALE PARA TUDO QUE ELA FAZ.
  #
  # O passo acima confere COBERTURA (toda tool tem nível). Ele passava verde com
  # uma elevação de privilégio de pé: `browser_tabs` era A0 e despachava
  # `browser.new_tab` — a política do dono devolvia ALLOW para "ler arquivos
  # locais" e a chamada ABRIA uma aba na rede, headless, sem aprovação (prova em
  # evidence/nomos-browser-final-closeout/01-mcp/03-exploit-tabs.txt).
  #
  # Este passo confere COERÊNCIA: para cada tool, a pior rota que ela consegue
  # despachar não pode exigir nível maior que o declarado. As rotas saem de DUAS
  # fontes (o campo `routes` e as chamadas `call(...)` no corpo), então acrescentar
  # um `if` novo no `build` sem reclassificar a tool reprova aqui.
  checar "mcp:risco-por-tool-coerente" node scripts/verificar-risco-mcp.ts

  # FASE 100 — `$VAR…` não é `${VAR}…`. O `…` é multibyte: o bash não encerra o
  # nome ali, tenta expandir `VAR\xe2\x80\xa6`, e sob `set -u` o script MORRE.
  # Isso derrubou `scripts/nomos-register.sh` no ramo "já registrado como
  # confiável" — o caminho FELIZ, que só passou a executar no dia em que o dono
  # registrou o manifesto. Guarda estático, com autoteste próprio.
  checar "shell:expansao-nao-colada-em-nao-ascii" node scripts/verificar-shell-expansao.ts
  checar "shell:guarda-de-expansao-nao-e-cego" node scripts/verificar-shell-expansao.ts --autoteste

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

  # FASE 10 — a sessão não pode voltar a nascer sem dono. `allow_unleased`
  # verdadeiro por default foi a ressalva registrada na FINAL_REPORT anterior;
  # este guarda existe para que ela não volte por descuido de configuração.
  checar "lease:fechado-por-default" node --input-type=module -e '
    const { loadConfig } = await import("./packages/api/src/config.ts");
    const c = loadConfig({ read_file: false, env: {} });
    if (c.allow_unleased !== false) { console.error("allow_unleased voltou a nascer true"); process.exit(1); }
    if (c.sources.allow_unleased !== "default") { console.error("proveniencia errada"); process.exit(1); }
    const p = loadConfig({ read_file: false, env: { NOMOS_BROWSER_ALLOW_UNLEASED: "true" } });
    if (p.allow_unleased !== true) { console.error("modo permissivo explicito deixou de funcionar"); process.exit(1); }
  '

  # FASE 13 — o vigia nasce ligado. Um supervisor que nasce desligado é um
  # supervisor que ninguém liga.
  checar "watchdog:ligado-por-default" node --input-type=module -e '
    const { loadConfig } = await import("./packages/api/src/config.ts");
    const c = loadConfig({ read_file: false, env: {} });
    if (c.watchdog_enabled !== true) { console.error("watchdog nasceu desligado"); process.exit(1); }
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

  # FASE 17 — os valores de configuração não podem vazar caminho do dono nem
  # credencial embutida em URL de backend. A rota existe; a redação é o contrato.
  checar "config:redacao-dos-sensiveis" node --input-type=module -e '
    const { loadConfig, redigirConfig, CONFIG_SCHEMA } = await import("./packages/api/src/config.ts");
    const c = loadConfig({ read_file: false, env: {}, sessions_root: "/Users/fulano/segredo" });
    const r = redigirConfig(c);
    if (String(r.sessions_root).includes("fulano")) { console.error("sessions_root vazou o caminho do dono"); process.exit(1); }
    for (const [k, e] of Object.entries(CONFIG_SCHEMA)) {
      if (!e.sensivel) continue;
      const v = r[k.split(".")[0]];
      if (v !== null && v !== undefined && typeof v === "string" && v !== "[REDIGIDO]") {
        console.error(`chave sensível ${k} saiu em claro: ${v}`); process.exit(1);
      }
    }
  '

  # FASE 11 — o SECURITY.md não pode voltar a declarar o T7 como gap aberto sem
  # que alguém tenha reaberto o buraco de propósito.
  checar "seguranca:t7-fechado" bash -c \
    '! /usr/bin/grep -q "Gap conhecido e aberto" docs/SECURITY.md'
fi

if roda providers; then
  titulo "providers — modelos ligados ao runtime (FASE 5) + contratos de provider"
  # shellcheck source=lib-memoria.sh
  . "$RAIZ/scripts/lib-memoria.sh"

  PROD_ANTES="$(producao_assinatura)"
  # Um run interrompido deixa modelo residente. Começar limpo não é higiene
  # opcional: foi com 5,13 GB presos que o gate anterior estourou por timeout.
  descarregar_todos >/dev/null 2>&1 || true
  printf '%-46s%s\n' "memoria:disponivel-antes" "$(mem_disponivel_gb) GB (livre $(mem_livre_pct)%)"

  # Descarga ENTRE arquivos, não só nas pontas: `aiprovider` e `vision` carregam
  # modelos DIFERENTES, e é a soma dos dois residentes que mata os vizinhos.
  for t in $E_PROVIDERS; do
    if [ -f "tests/$t.test.ts" ]; then
      checar "test:$t" testes "tests/$t.test.ts"
      descarregar_todos >/dev/null 2>&1 || true
      printf '%-46s%s\n' "  memoria:apos-$t" "$(mem_disponivel_gb) GB"
    else
      printf '%-46sFALHOU (tests/%s.test.ts nao existe)\n' "test:$t" "$t"
      FALHAS=$((FALHAS + 1))
    fi
  done

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

if roda integration; then
  titulo "integration — daemon e Chromium reais"
  rodar_testes "$E_INTEGRATION"
fi

if roda adversarial; then
  titulo "adversarial — ataques, falhas provocadas, recovery e watchdog"
  rodar_testes "$E_ADVERSARIAL"

  # FASE 11 — a bateria COMPLETA (53 vetores) roda como passo próprio, e não
  # como `node --test`: ela é um programa que imprime placar por grupo e sai
  # !=0 quando um vetor não se comporta como o produto promete. A bateria
  # anterior (16 vetores, `final-validation/05-security`) continua valendo e
  # roda ao lado — nenhuma das duas substitui a outra.
  checar "seguranca:bateria-completa" node evidence/nomos-browser-final-loop/11-security/bateria-completa.ts
  checar "seguranca:guardas-vivos" node evidence/nomos-browser-final-validation/05-security/prova-guardas-vivos.ts
fi

if roda e2e; then
  titulo "e2e — gates ponta a ponta"
  rodar_testes "$E_E2E"
fi

if roda recovery; then
  titulo "recovery — vigia e supervisor"
  rodar_testes "$E_RECOVERY"
fi

# `cleanroom` NUNCA entra em `all`: ele existe para rodar num CLONE do HEAD, em
# diretório temporário, sem cofre de marca, sem Chromium instalado e sem tocar
# nos serviços de produção. Rodá-lo aqui junto do resto não provaria nada que os
# outros estágios já não provem — a prova é o AMBIENTE, não a lista.
if [ "$ESTAGIO" = "cleanroom" ]; then
  titulo "cleanroom — instalação do zero (chamado por scripts/clean-room.sh)"
  rodar_testes "$E_CLEANROOM"
  checar "typecheck" npx tsc --noEmit -p tsconfig.json
  checar "ci:cobertura-da-matriz" bash "$RAIZ/scripts/ci-cobertura.sh"
  checar "pacotes:manifestos-completos" node scripts/verificar-manifestos.ts
  # O schema de configuração tem de ser GERÁVEL num clone limpo: se ele
  # dependesse de estado da máquina do dono, a tabela publicada seria dele, não
  # do produto.
  checar "config:schema-gerado" bash -c 'node scripts/config-schema.ts --markdown | /usr/bin/grep -q "NOMOS_BROWSER_PORT"'
fi

titulo "resultado"
if [ "$FALHAS" -eq 0 ]; then
  echo "CI_PASS=YES"
  exit 0
fi
echo "CI_PASS=NO  ($FALHAS passo(s) falharam)"
exit 1
