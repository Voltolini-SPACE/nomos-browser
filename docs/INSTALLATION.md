# Instalação

Este documento cobre a instalação do **NOMOS Browser Runtime** a partir do
repositório. Não há pacote publicado em registro nenhum: `package.json` declara
`"private": true` e não existe tag no repositório. Instalar = clonar, instalar
dependências, baixar o Chromium do Playwright e (opcionalmente) instalar o
serviço supervisionado.

Estado verificado em `2026-08-25`, HEAD `78491cc`, em macOS 26.3.1 arm64.

---

## 1. Requisitos

| Item | Exigência | Por quê |
|---|---|---|
| Node | **≥ 22.18** (`package.json` → `engines`) | O produto executa `.ts` **nativamente**; não há passo de build. O executor chama `node --test <arquivo>.ts` sem `--experimental-strip-types`, então o piso é a versão em que o stripping já vem ligado: 22.18. Medido em `v22.23.1` e `v26.0.0`. |
| npm | ≥ 10 | `npm ci` com workspaces (`packages/*`). |
| Python | ≥ 3.11 | **Apenas** para o SDK Python (`sdk-python/`). O runtime não precisa. |
| Sistema | macOS ou Linux | O serviço supervisionado (`scripts/service.sh`) é **launchd**, ou seja, **só macOS**. Em Linux o runtime roda, a supervisão não. |
| Disco | ~500 MB | Chromium do Playwright em `~/Library/Caches/ms-playwright`. |
| Memória | 16 GB é o mínimo confortável **se** houver provider de IA local | Ver `docs/LIMITATIONS.md`: nesta máquina a suíte com LLM sob carga concorrente degrada de forma medida. |

Nada de Docker, Makefile ou `.service`: eles não existem neste repositório.

---

## 2. Dependências — e por que `--include=dev` importa

```bash
git clone <origem> nomos-browser
cd nomos-browser
npm ci --include=dev
npx playwright install chromium
```

### A armadilha do `--include=dev`

Nesta máquina o ambiente traz `NODE_ENV=production` **e** `npm config` com
`omit=dev`. Com qualquer um dos dois ativo, `npm ci` **pula as
devDependencies** — e a instalação parece bem-sucedida, porque o runtime em si
não depende delas. O sintoma aparece só depois, no typecheck:

```
$ npm run typecheck
This is not the tsc command you are looking for
```

Essa mensagem vem do binário `tsc` do **sistema** (o `tsc` do pacote antigo
`tsc` do Debian/Homebrew, não o do TypeScript), encontrado no `PATH` porque o
TypeScript do projeto não foi instalado. Não é defeito do produto e não é bug do
TypeScript: é o `npm ci` tendo feito exatamente o que foi configurado para fazer.

Verificar antes de acusar qualquer outra coisa:

```bash
node -p "process.env.NODE_ENV ?? '(não definido)'"
npm config get omit
ls node_modules/typescript/bin/tsc   # tem de existir
```

Com `npm ci --include=dev` o typecheck volta `rc=0`. Registrado em
`evidence/nomos-browser-final-validation/FINAL_REPORT.md`, FASE 13.

### `npm ci`, não `npm install`

`npm ci` é o que a CI roda nos cinco jobs e é o que o clean room exercita. Use o
mesmo comando, para que a diferença entre "funciona aqui" e "funciona na CI"
apareça agora e não no release. O lockfile foi corrigido em `ae4bff1` — antes
dele, `npm ci` falhava com `EUSAGE` em **qualquer** checkout limpo.

---

## 3. Primeira execução

### 3.1 Provar que o controle do navegador é real

```bash
node spike/fase1_spike.ts
```

Esperado: `exit 0`, **25/25 checks**. Ele inclui o controle negativo que dá
sentido ao resto: um clique via CDP chega à página com `isTrusted=true`, um
clique sintetizado em JavaScript chega com `false`. Se os dois derem o mesmo
valor, o instrumento está quebrado — não o produto.

### 3.2 Subir o daemon em primeiro plano

```bash
node packages/api/src/daemon.ts
```

Padrões: bind em `127.0.0.1:7777`, `headless: false`, política padrão,
**sem** provider de IA, **sem** provider de visão, **sem** `upload_root` nem
`download_root`. Ou seja: o runtime nasce mudo para LLMs e fail-closed para
arquivos. Isso é intencional — ver `docs/CONFIGURATION.md`.

### 3.3 Rodar a suíte

```bash
bash scripts/run-suite.sh --out /tmp/suite
```

Use **este** script, não `node --test tests/`. O runner do Node paraleliza por
número de CPUs, a suíte abre Chromium em vários arquivos, e sob pressão de
memória o processo morre no meio deixando saída truncada **sem linha de
sumário** — que parece sucesso. O `run-suite.sh` roda um arquivo por vez, com
timeout próprio, e um arquivo morto aparece como `MORTO`, nunca como silêncio.

Medido em `2026-08-25 01:09–01:12` (UTC-3), HEAD `78491cc`:
`TS_PASS=696  TS_FAIL=0  ARQUIVOS_OK=33  ARQUIVOS_RUINS=0`
(`evidence/nomos-browser-final-loop/18-docs/resumo.tsv`).

SDK Python, separado:

```bash
cd sdk-python && python3 -m unittest discover -s tests
```

Medido no mesmo dia: `Ran 31 tests … OK`
(`evidence/nomos-browser-final-loop/18-docs/sdk-python.out`).

---

## 4. Instalação como serviço (macOS / launchd)

```bash
bash scripts/service.sh install
bash scripts/service.sh start
bash scripts/service.sh status
```

O que `install` faz e o que ele recusa a fazer:

| Detalhe | Valor |
|---|---|
| Label | `ai.nomos.browser` |
| Plist instalado em | `~/Library/LaunchAgents/ai.nomos.browser.plist` |
| Modelo versionado | `packaging/launchd/ai.nomos.browser.plist` |
| Logs | `~/Library/Logs/nomos-browser` (ou `NOMOS_BROWSER_LOG_DIR`) |
| Lockfile de instância única | `<runtime_dir>/daemon.lock`, com o PID dentro |
| Porta | `NOMOS_BROWSER_PORT`, padrão `7777` |

- **`install` recusa** se a label já existir e **não** for nossa. Sequestrar a
  label de outro produto seria a forma mais rápida de derrubar um serviço do
  dono.
- **Instância única** por lockfile com PID **e** checagem de porta: dois daemons
  no mesmo `userDataDir` corrompem o perfil do dono. Um segundo `start` é
  recusado com `rc=9`, mantendo o PID original.
- **Saída limpa não é ressuscitada** (`KeepAlive.SuccessfulExit=false`); `SIGKILL`
  é (PID novo). Crash-loop é freado pelo `ThrottleInterval`.

Subcomandos: `install`, `uninstall`, `start`, `stop`, `restart`, `status`,
`health`, `logs`.

Provado contra o launchd real em
`evidence/nomos-browser-final-loop/14-supervisor/out/supervisor.json`
(**11/11 passos**, incluindo "serviços de produção intactos, mesmos PIDs").

**Limite honesto:** *reboot real não foi executado* — a máquina de prova é de
produção. O que foi feito é `launchctl kickstart -k`, declarado como **simulação**
de reboot. Ver `docs/LIMITATIONS.md`.

### Linux

Não há unit systemd versionada. Rode o daemon sob o supervisor da sua
preferência, garantindo por conta própria: instância única, restart com backoff
e `ExitTimeOut` suficiente para o runtime fechar os Chromium.

---

## 5. Verificação

```bash
curl -s http://127.0.0.1:7777/health
# ou
bash scripts/service.sh health
```

**`/health` responder `401` também é resposta válida e boa notícia:** significa
que o daemon está vivo e que a autenticação do control plane está ligada. Foi
exatamente assim que a correção do P1 de download foi confirmada
(`DELETE sessão → 200 · /health → 401 (daemon vivo)`). Um `curl` que não conecta
é o único resultado que significa "não subiu".

Ver `docs/TROUBLESHOOTING.md` para o que fazer em cada caso.

---

## 6. Integração com o NOMOS — instalada, **não** registrada

O manifesto MCP e o lançador existem e o transporte está provado ponta a ponta
(`NOMOS_TRANSPORT_E2E=PASS`, 18/18 casos,
`evidence/nomos-browser-final-loop/07-nomos/cliente-fiel-saida.txt`).

```bash
bash scripts/nomos-register.sh    # valida o manifesto e IMPRIME o que registrar
```

O script **pede, nunca aprova**. Gravar o hash no catálogo de confiança
(`nomos mcp confiar`) é **ato do dono**. Enquanto essa assinatura não acontecer,
o browser não está registrado no NOMOS e as tools A2/A5 aparecem como
`BLOQUEADO_POR_APROVACAO` — que é o comportamento correto, não uma falha.
Comandos exatos em `docs/NOMOS-INTEGRATION.md`.
