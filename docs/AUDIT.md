# Auditoria

A trilha é append-only em JSONL, uma linha por `AuditEntry`, em
`<sessions_root>/<session_id>/actions.jsonl`. Fatos sem sessão (`session: null`)
vão para o balde `_runtime`.

Por que ela foi reescrita: a trilha anterior **não reconstruía** decisão de
política, handoff nem ator. Medido na validação final: uma negação
`403 CAPABILITY_DENIED` deixava **zero** linhas; `handoff`/`takeover`/`release`
com `HTTP 200` deixavam **zero** linhas; `actor` era `"unknown"` em **100%** dos
registros, mesmo com `owner` definido. O gate antigo marcava `AUDIT_PASS=YES`
porque verificava só duas coisas — que havia ≥5 linhas e que não vazou
`set-cookie`/`authorization`. As duas continuavam verdadeiras.
(`evidence/nomos-browser-final-validation/06-audit/out/auditoria.json`,
`AUDIT_COMPLETE=FAIL`.)

Depois de `bc7130f`, o mesmo script da validação — **intocado** — devolve
`AUDIT_COMPLETE=PASS`. Suíte: `tests/audit-forense.test.ts` (12 pass) e
`tests/observability.test.ts` (22 pass), medidos 2026-08-25.

---

## O schema — 19 campos, todos obrigatórios

`null` é uma **resposta** ("não se aplica"). Chave **ausente** é uma pergunta sem
resposta — e foi exatamente o que impediu a trilha antiga de reconstruir quem
agiu, em que aba, sob que decisão. `makeAuditEntry` é a **única** fábrica: ela
preenche todo campo ausente e ignora `undefined` vindo do chamador, porque
`JSON.stringify` **apaga** `undefined` e produziria uma linha sem a chave.

| # | Campo | Tipo | O que responde |
|---|---|---|---|
| 1 | `timestamp` | string ISO | Quando. |
| 2 | `event` | `action`\|`policy`\|`control`\|`recovery`\|`task`\|`provider` | A classe do fato. Separa "o agente clicou" de "a política recusou" de "o humano tomou o volante" sem adivinhar pelo nome da ação. |
| 3 | `session` | string\|null | Qual sessão. `null` → balde `_runtime`. |
| 4 | `browser` | string\|null | O `BrowserContext`: estável na sessão, distinto entre sessões. |
| 5 | `page` | string\|null | **Em qual aba.** Com 2 abas abertas, sem isto era impossível saber qual recebeu a ação. |
| 6 | `task` | string\|null | A que task o fato pertence. |
| 7 | `owner` | string\|null | Dono corrente da sessão no instante do fato. |
| 8 | `actor` | string | **Quem pediu.** Nunca `"unknown"` quando a sessão tem dono. |
| 9 | `provider` | string\|null | `provider_id` do `AIProvider`/`VisionProvider` envolvido. |
| 10 | `action` | string | A ação ou o evento. |
| 11 | `capability` | string\|null | A capability exigida (de `REQUIRED_CAPABILITY`). |
| 12 | `policy_decision` | `allow`\|`deny`\|`not_applicable` | A decisão. |
| 13 | `policy_reason` | string\|null | Código + texto curto quando `deny`. |
| 14 | `target` | string\|null | O alvo. |
| 15 | `result` | `ok`\|`error`\|`denied` | O desfecho. |
| 16 | `verified` | bool\|null | Se a ação foi verificada. `null` = verificação não pedida. |
| 17 | `error` | `{code,message}`\|null | O erro, com o código do contrato. |
| 18 | `detail` | objeto | Contexto. **Nunca contém valor de segredo — apenas a referência usada.** |
| 19 | `action_id` | string\|null | Correlaciona com a resposta da API. |

`AUDIT_FIELDS` é a lista congelada contra a qual o gate confere **chave a
chave**. Produtor que esquece um campo não compila e não passa.

---

## Os eventos

**`action`** — os verbos do navegador: `browser.goto`, `browser.click`,
`browser.type`, `browser.find`, `browser.observe`, `browser.extract`,
`browser.screenshot`, `browser.download`, `browser.upload`, tabs, scroll, wait…

**`policy`** — decisão de política, incluindo **as negações**. Antes de `bc7130f`
uma negação era invisível: o evento mais relevante para segurança não deixava
rastro. Também aparece aqui `secret.used`, com a **referência** do segredo — nunca
o valor; é o que prova o uso.

**`control`** — `attach`, `detach`, `handoff`, `takeover`, `release`. As três
últimas deixavam zero linhas antes da correção.

**`recovery`** — decisões da varredura de arranque (`reattach`, `recover`,
`orphan`, `terminate`) e degradação do watchdog.

**`task`** — treze eventos: `task.created`, `task.started`, `task.progress`,
`task.checkpoint`, `task.retry`, `task.waiting`, `task.paused`, `task.resume`,
`task.cancelled`, `task.failed`, `task.recovering`, `task.completed`,
`task.cleanup`. Ver `docs/TASK-ENGINE.md`.

**`provider`** — `provider.degraded` e afins. Foi o primeiro produtor de linhas
com `session: null`, e por isso revelou que o balde `_runtime` era recusado pelo
próprio `assertSafeSessionId`: toda linha morria no append e virava stderr.
Corrigido em `3f62706`.

---

## O que é redigido, e por quê

`packages/observability/src/redact.ts`, aplicado recursivamente e
case-insensitive em headers, corpo e query string, sobre a forma **normalizada**
da chave — então `X-API-Key`, `x_api_key` e `xapikey` caem todos no mesmo balde.

**Campos:** `authorization`, `cookie`, `set-cookie`, `proxy-authorization`,
`x-api-key`, `api-key`, `token`, `access_token`, `refresh_token`, `password`,
`senha`, `secret`, `bearer`.

**Sufixos de alto sinal:** `*token`, `*secret`, `*password`, `*senha`, `*apikey`,
`*authorization`, `*cookie`, `*bearer`. Eles pegam `client_secret`,
`db_password`, `csrf_token`, `session_token` **sem** pegar `token_count`,
`tokenizer` ou `credential_ref`.

**`credential_ref` tem de sobreviver, e isso é deliberado.** O contrato audita a
**referência** do segredo — é ela que prova o uso. Redigir a referência junto com
o valor destruiria a única prova de que o segredo foi usado, sem proteger nada a
mais.

**Query string:** `token`, `access_token`, `refresh_token`, `id_token`, `key`,
`api_key`, `password`, `senha`, `secret`, `sig`, `signature`, `authorization`,
`bearer` (mais os sufixos). É por isso que `/events?token=…` — risco aceito e
declarado em `SECURITY.md` — não vaza pela observabilidade de rede: o runtime
**não registra a URL do upgrade** e o `redact.ts` limparia o parâmetro de todo
modo.

**Por quê, em uma frase:** o runtime dirige um navegador com as sessões
autenticadas do dono. Um log com `Cookie` é um sequestro de conta esperando um
leitor.

Marcadores: `[REDACTED]`, `[CIRCULAR]`, `[MAX_DEPTH]` (profundidade 16, para que
estrutura patológica não trave o bus).

**O que a trilha nunca contém:** valor de segredo, cookie, header de
autorização, e — no caso de injeção — o **trecho literal** do payload no corpo da
linha de ação.

---

## Como ler a trilha

```bash
S=<sessions_root>/<session_id>/actions.jsonl

# a linha do tempo, legível
python3 - "$S" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l)
    print(f"{e['timestamp']}  {e['event']:<9} {e['action']:<22} "
          f"actor={e['actor']:<12} page={e['page']} "
          f"{e['policy_decision']:<15} {e['result']}")
PY

# só as negações
grep '"policy_decision":"deny"' "$S"

# só a troca de controle
grep '"event":"control"' "$S"

# uma task inteira
grep '"task":"<task_id>"' "$S"

# degradação de provider (sessão null)
grep '"event":"provider"' <sessions_root>/_runtime/actions.jsonl
```

Três perguntas que a trilha agora responde e antes não respondia:

1. **Quem pediu?** `actor` — nunca `"unknown"` com sessão dona.
2. **Em qual aba?** `page`.
3. **Foi negado, e por quê?** `policy_decision` + `policy_reason` + `capability`.

---

## Como verificar um replay

O replay reconstrói a linha do tempo a partir de `actions.jsonl`, dos eventos e
dos screenshots gravados. Desde `8cd9fff` o bundle carrega um **selo**
(`seal.json`: sha256 por arquivo, tamanho e contagem).

```bash
# pela CLI
node packages/cli/src/main.ts replay <SESSION_ID>
node packages/cli/src/main.ts replay verify <SESSION_ID>
node packages/cli/src/main.ts replay verify --pixels --strict <SESSION_ID>

# pela API
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:7777/v1/sessions/<SESSION_ID>/replay/verify
```

`--pixels` decodifica os PNG; `--strict` faz aviso também reprovar.

**O que a verificação pega:** adulteração de uma linha, reordenação e
truncamento — **inclusive** quando o JSON continua válido e os timestamps
continuam em ordem, que é exatamente o caso que nenhuma checagem estrutural
pegava. Antes de `8cd9fff`, `replay-verify.ts` tinha 791 linhas e **zero usos**
fora do próprio teste: a integridade nunca era conferida em produção.

**O que ela NÃO pega, declarado:** o selo é **hash sem chave**. Quem tem
permissão de escrita no diretório da sessão pode adulterar **e resselar**. Fecha
corrupção e adulteração oportunista; não fecha adversário com acesso de escrita.
Para isso seria preciso chave fora da máquina — fora do escopo desta versão.
Ver `docs/SECURITY.md` e `docs/LIMITATIONS.md`.
