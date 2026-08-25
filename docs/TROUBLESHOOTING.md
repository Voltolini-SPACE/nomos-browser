# Troubleshooting

Formato de cada item: **sintoma → causa → verificação → correção**. Só entram
sintomas que já aconteceram e estão registrados em evidência ou em mensagem de
commit; nada aqui é hipótese.

Regra geral antes de qualquer diagnóstico: **leia o `detail` do erro.** O
contrato devolve código + mensagem + `detail`, e a maior parte dos itens abaixo
se resolve lendo o `detail` em vez de reexecutar o comando esperando outra
resposta.

---

## Instalação e build

### `npm ci` falha com `EUSAGE` / `Missing: @nomos/... from lock file`

**Sintoma**
```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json ... are in sync.
npm error Missing: @nomos/browser@0.1.0 from lock file
```

**Causa** — `package-lock.json` fora de sincronia com os workspaces. Foi um
defeito real: o lock tinha sido gerado antes de `packages/sdk`, `packages/cli` e
`packages/mcp` ganharem `package.json`. Corrigido em `ae4bff1`. Se reaparecer, é
porque alguém adicionou um workspace sem regenerar o lock.

**Verificação**
```bash
git log --oneline -1 -- package-lock.json
ls packages/*/package.json
```
Compare a lista com a chave `workspaces` do `package.json` raiz.

**Correção**
```bash
npm install --package-lock-only
npm ci --include=dev
```
Commite o lock junto com o `package.json` que o mudou. `npm ci` roda nos cinco
jobs da CI: lock quebrado = CI que nunca poderia passar.

### `typecheck` falha com "This is not the tsc command you are looking for"

**Sintoma** — `npm run typecheck` imprime exatamente essa frase.

**Causa** — as devDependencies não foram instaladas, o TypeScript do projeto não
existe em `node_modules`, e o `tsc` encontrado no `PATH` é o binário homônimo do
sistema. Nesta máquina isso é o **estado normal** de `npm ci` puro:
`NODE_ENV=production` e `npm config omit=dev` fazem o `npm ci` pular
devDependencies sem reclamar.

**Verificação**
```bash
node -p "process.env.NODE_ENV ?? '(não definido)'"
npm config get omit
ls node_modules/typescript/bin/tsc
```

**Correção**
```bash
npm ci --include=dev
npm run typecheck     # esperado: rc=0
```
Não é defeito do produto. Registrado em
`evidence/nomos-browser-final-validation/FINAL_REPORT.md`, FASE 13.

---

## Runtime — recusas

### `CAPABILITY_DENIED`

**Causa** — a ação exige uma capability que a sessão não tem, **ou** o
chamador não apresentou credencial válida. Capabilities sensíveis (`send`,
`purchase`, `payment`, `delete`, `upload`) nascem negadas, e ferramenta sem
entrada em `REQUIRED_CAPABILITY` é negada por omissão — fail-closed é o
comportamento correto, não um bug.

Atenção ao HTTP: **401** é credencial (ausente, inválida, revogada, expirada);
**403** é escopo (credencial boa, permissão insuficiente).

**Verificação** — a negação **deixa linha própria** na trilha desde `bc7130f`:
```bash
grep '"policy_decision":"deny"' <sessions_root>/<session_id>/actions.jsonl | tail -3
```
Leia `capability` e `policy_reason` na linha. Se `actor` estiver preenchido e
`policy_reason` disser qual capability faltou, o diagnóstico acabou.

**Correção** — conceda a capability na criação da sessão, ou emita credencial
com o escopo certo. **Não** insista: retentar ação negada é o padrão que o task
engine classifica como fatal exatamente porque três tentativas produzem três
`policy.deny` e nenhuma chance a mais de sucesso.

### `CONTROL_NOT_OWNED`

**Causa** — desde `8cd9fff`, `allow_unleased` é **`false` por padrão**. Uma
sessão sem lease deixou de ficar aberta a qualquer chamador local. Quem cria a
sessão recebe o lease no mesmo ato; outro principal é recusado até adquirir,
herdar por handoff, ou esperar o lease alheio expirar. **O principal é o sujeito
do token**, não o header `x-nomos-client` (que era auto-declarado e permitia
sequestro de sessão).

Este é o erro mais provável ao atualizar um cliente escrito antes dessa mudança.

**Verificação**
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:7777/v1/sessions/<id> | python3 -m json.tool
```
Compare o `holder` do lease com o **sujeito do seu token** — não com o nome que
o seu cliente se dá.

**Correção**, em ordem de preferência:
1. Adquira o lease pela rota de controle antes de agir.
2. Peça `handoff` ao dono atual — e note que o handoff só move o lease com
   `to_holder`; `to_owner` é rótulo livre e não move nada.
3. Espere o lease expirar.
4. Só em ambiente sem sessões autenticadas reais:
   `NOMOS_BROWSER_ALLOW_UNLEASED=true`.

Caso especial já corrigido: `tasks.resume` de sessão de outro principal falhava
com `CONTROL_NOT_OWNED` porque a delegação só era registrada na rota de ação.
Corrigido em `8cd9fff`. Se você vir isso de novo, é regressão.

### `TARGET_NOT_ACTIONABLE` e `CLICK_NOT_DELIVERED`

Os dois nasceram em `bc7130f` e **são a correção**, não a regressão. Antes,
`browser.click` devolvia `HTTP 200` e `success:true` para alvo fora do viewport
sem entregar clique nenhum.

| Código | Significa |
|---|---|
| `TARGET_NOT_ACTIONABLE` | O runtime chegou ao alvo, mas ele **não pode receber o gesto**: `elementFromPoint` no centro devolveu outro elemento (overlay, modal, cookie banner), o alvo está coberto, tem tamanho zero, ou não assentou depois do scroll. O clique **não foi disparado**. |
| `CLICK_NOT_DELIVERED` | O gesto **foi disparado** e **nenhum evento chegou**. O listener de captura, armado antes do gesto, não registrou nada, e nenhum sinal de navegação apareceu. |

**Verificação — pelo `detail`.** O `detail` traz a caixa medida, o resultado do
`elementFromPoint`, o ponto clicado e os sinais de navegação observados. Leia
nesta ordem:

1. `detail` da caixa vs. viewport — o alvo estava mesmo na tela depois do scroll?
2. Quem `elementFromPoint` devolveu — se for outro elemento, você achou o
   overlay que está no caminho.
3. Para `CLICK_NOT_DELIVERED`, se houve `framenavigated`/`context.on("page")`.
   Um `<a href>` destrói o contexto de JS **antes** de `page.url()` mudar; é por
   isso que a prova usa sinais de processo e não só a sonda de DOM.
4. A trilha: `grep '"action":"browser.click"' actions.jsonl | tail -1`.

**Correção**
- Overlay/modal: feche-o primeiro; é um passo do plano, não um problema do
  clique.
- Alvo que ainda anima: o runtime já espera a caixa assentar
  (`stability_samples`/`stability_interval_ms`); aumente as amostras se a página
  animar por muito tempo.
- Ambos são **retentáveis** pelo task engine, porque a próxima tentativa
  reexecuta a cascata de resolução inteira — nunca reusa a coordenada velha.
- Não "resolva" desligando `click_delivery_check`. Isso não faz o clique chegar;
  faz o runtime voltar a mentir.

### `DOWNLOAD_DENIED: download_root não configurado`

**Sintoma**
```
DOWNLOAD_DENIED — download_root não configurado — download negado (fail closed)
```
O simétrico existe: `UPLOAD_DENIED — upload_root não configurado`.

**Causa** — `download_root` e `upload_root` têm default `null`. Sem raiz
declarada, **não há lugar legítimo** para escrever, e o runtime nega em vez de
escolher um por conta própria.

**Verificação**
```bash
node -p "process.env.NOMOS_BROWSER_DOWNLOAD_ROOT ?? '(não definido)'"
```
E confira `sources.download_root` na configuração efetiva: ele diz de onde o
valor veio.

**Correção**
```bash
export NOMOS_BROWSER_DOWNLOAD_ROOT=/caminho/dedicado/downloads
export NOMOS_BROWSER_UPLOAD_ROOT=/caminho/dedicado/uploads
```
Use diretório **dedicado**. Apontar para `$HOME` transforma a política de arquivo
em decoração. Caminho fora da raiz continua recusado, com `..` e `%2e%2e`
normalizados (T6).

---

## Providers

### Provider de LLM fora do ar / lento / mudo

**Sintomas possíveis** — `PROVIDER_DEGRADED`, `TIMEOUT`, `EMPTY_OUTPUT`, ou
`browser.task` devolvendo `INVALID_REQUEST`.

**Causas, em ordem de frequência**

1. **Nenhum provider configurado.** `ai_provider` e `vision_provider` têm default
   `null`. `browser.task` sem `AIProvider` devolve `INVALID_REQUEST`; a cascata
   sem `VisionProvider` registra `vision: skipped, "nenhum VisionProvider
   injetado"` no trace. Isso **não é falha do provider** — é ausência dele.
2. **Backend fora do ar.**
3. **`EMPTY_OUTPUT`:** o modelo gastou o orçamento de tokens no raciocínio
   interno e não emitiu resposta. A mensagem é explícita e acionável:
   *"use `think:false` ou aumente `max_tokens`"*. Medido com
   `qwen3.5:4b-q8_0`, que passa a responder com `think:false`.
4. **Contenção de memória:** o modelo não carrega a tempo e o timeout estoura.
   Medido: `qwen3.5:4b-q8_0` estourou 180 s sob carga onde isolado responde em
   3,8 s.

**Verificação**
```bash
curl -s --max-time 8 http://127.0.0.1:11434/api/tags | python3 -m json.tool | head
grep '"event":"provider"' <sessions_root>/_runtime/actions.jsonl | tail -5
```
As linhas `provider.degraded` ficam no balde `_runtime` (sessão `null`).

**Correção**
- Configure `ai_provider` / `vision_provider` (`"<backend>:<modelo>"`).
- Para `EMPTY_OUTPUT`: `ai_think=false` ou mais `max_tokens`.
- Para carga: descarregue modelos residentes antes
  (`POST /api/generate` com `keep_alive:0`) — é o que `scripts/run-suite.sh` já
  faz antes de `vision`, `aiprovider` e `product02-gate`.
- Configure `ai_provider_fallback` — lembrando que o fallback só dispara em
  **degradação classificada** (timeout, rede, `EMPTY_OUTPUT`, 5xx).
  **Cancelamento nunca vira fallback.** Se você cancelou e viu o fallback rodar,
  isso é bug, não configuração.

---

## Suíte e processos

### Um arquivo da suíte volta `MORTO`

**Sintoma** — `resumo.tsv` traz `MORTO` na coluna de status, sem `pass`/`fail`.

**Causa** — o arquivo foi morto pelo vigia de timeout do executor. Na esmagadora
maioria dos casos observados **não é regressão de código: é contenção de
memória**. Medido: numa execução, `aiprovider` e `recovery-watchdog` morreram
juntos; reexecutados isolados voltaram `24/24` em 8 s e 41 testes em 103 s.

**Verificação**
```bash
awk -F'\t' '$2!="OK"' /tmp/suite/resumo.tsv
node --test tests/<arquivo>.test.ts        # isolado, sem carga concorrente
```
E olhe a memória **disponível** (`free + inactive + purgeable`), não o swap:
`scripts/lib-memoria.sh` existe exatamente por isso. Medido: descarregar um
modelo de 5,13 GB moveu o disponível de 2,5 GB para 5,6 GB enquanto o swap saiu
de 16 769 MB para 16 714 MB — praticamente parado. **Swap no macOS não encolhe
quando a pressão passa; ele não é o sinal.**

**Correção**
- `bash scripts/lib-memoria.sh` traz as funções de sonda e a descarga de modelos.
- Rode a suíte sem outra carga pesada dividindo os 16 GiB.
- `--fast` pula os arquivos que sobem Chromium/benchmark, quando você só quer o
  núcleo determinístico.
- **Nunca** interprete saída truncada sem linha de sumário como sucesso: é
  precisamente o modo de falha que o `run-suite.sh` existe para tornar visível.

### Processo órfão

**Sintoma** — processos `tests/fixtures/watchdog-child.ts` (ou Chromium) com
`PPID=1`, vivos por horas.

**Causa** — mecanismo isolado e corrigido em `bc7130f`: `run-suite.sh` matava só
o pai no timeout (`kill -9 $pid`) e os filhos eram reparentados para o init. A
validação encontrou **19 órfãos**, o mais velho com 6 h. Agora o arquivo roda em
**grupo de processos próprio** e o vigia mata o **grupo**, TERM antes de KILL.

**Verificação**
```bash
ps -eo pid,ppid,etime,command | awk '$2==1' | grep -E "watchdog-child|node --test|chromium"
```
Controle A/B, com controle de vácuo:
`evidence/nomos-browser-final-loop/15-orfaos/prova-group-kill.sh`
(estratégia antiga deixa 1 órfão, nova deixa 0).

**Correção** — **inventarie antes de matar.** Salve a lista com PID, idade e
linha de comando; só então termine. Órfão de execução terminada normalmente é
zero: se você encontrar órfãos com a versão atual, o inventário é a evidência de
que há regressão.

Nunca mate por nome sem conferir `PPID` e `etime`: esta máquina roda serviços de
produção.

---

## Serviço

### O serviço não sobe

Duas causas com sintomas parecidos e correções opostas.

**(a) Porta ocupada**
```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN
```
Se houver outro processo, não mate cegamente — pode ser um daemon do dono. Mude
`NOMOS_BROWSER_PORT` ou encerre o dono pelo `service.sh stop`.

**(b) Lockfile de instância única**

O `service.sh` mantém `<runtime_dir>/daemon.lock` com o PID dentro, **e** confere
a porta. Dois daemons no mesmo `userDataDir` corrompem o perfil do dono; por isso
um segundo `start` é recusado com `rc=9` mantendo o PID original — **isso é o
mecanismo funcionando**.

```bash
bash scripts/service.sh status
python3 -c 'import json;print(json.load(open("<runtime_dir>/daemon.lock"))["pid"])'
ps -p <pid>
```

- PID **vivo**: já existe uma instância. `stop` antes de `start`, ou use a que
  está rodando.
- PID **morto**: lock obsoleto. O `service.sh` já remove o lock quando o PID não
  está vivo; se persistir, remova o arquivo **depois** de confirmar que não há
  processo.

**(c) `install` recusa** — a label `ai.nomos.browser` já existe e **não é
nossa**. Correto: sequestrar a label de outro produto derrubaria um serviço do
dono. Investigue o plist existente antes de qualquer coisa.

**Logs**
```bash
bash scripts/service.sh logs
ls ~/Library/Logs/nomos-browser
```

### `/health` responde `401`

**Não é falha.** Significa daemon vivo com autenticação ligada. Foi assim que a
correção do P1 de download foi confirmada. O único resultado que significa "não
subiu" é a conexão recusada.
