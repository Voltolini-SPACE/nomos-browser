# Gi ↔ NOMOS Browser

> **Caminhos nesta página.** `$REPO` é a raiz deste repositório e `$GI` a raiz do
> projeto da Gi. Eles aparecem como variáveis em vez de caminhos absolutos porque
> um caminho absoluto embutido diz o nome de usuário de quem escreveu e não
> funciona para mais ninguém:
>
> ```bash
> REPO="$(git rev-parse --show-toplevel)"
> GI="${GI:-$(dirname "$REPO")/pocket-assistant}"
> ```


A Gi é o assistente de voz local (`$GI`, backend
FastAPI em `:8321`). Este documento descreve como ela ganha um navegador **sem
ganhar autoridade** — e qual é o passo, exato, que só o dono pode dar.

---

## 1. O caminho

```
voz → Realtime → tool_call
   → NomosDispatcher (gi_nomos/dispatcher.py)   ← a Gi já não executa nada direto
      → gi_nomos/browser.py
         ├─ 1. categoria = manifesto do NOMOS Browser (packaging/mcp/manifesto.json)
         ├─ 2. veredito  = nomos approvals testar <CATEGORIA> mcp:nomos-browser:<tool>
         │                 ↑ o MESMO caminho que gi_intents.action_gate já usa
         └─ 3. se e SÓ SE ALLOW:
               ├─ dono já registrou?  → nomos mcp chamar <manifesto> <tool>
               └─ ainda não?          → mesmo comando do manifesto, por stdio
                                        (mesmo cwd, mesma classificação, mesmo veredito)
                  → nomos-browser-mcp → API v1 → Chromium
   ← resultado estruturado + o veredito do NOMOS junto (auditoria bate dos dois lados)
```

`docs/GI_V3_ARCHITECTURE.md` **do repositório `pocket-assistant`** (não deste)
já declarava: *"NOMOS é a autoridade de ações"*.
Este módulo é essa frase escrita em código — a Gi **pergunta** antes de agir, e a
resposta do NOMOS é vinculante.

---

## 2. O que foi criado (e o que NÃO foi tocado)

**Criado:** `backend/gi_nomos/browser.py` — módulo novo, isolado.

**Não tocado:** `dispatcher.py`, `gi_intents.py`, `device_voice_gateway.py`,
`server.py` — nada que o serviço vivo (:8321, PID 29108) importa foi alterado, e
o serviço **não foi reiniciado**. Enquanto o dono não fizer o passo da §4, o
módulo existe e é testável, mas nenhuma tool de navegador chega ao modelo de voz.

Três invariantes que `browser.py` mantém:

1. **A categoria vem do manifesto.** O mapa tool→A0..A6 é lido de
   `packaging/mcp/manifesto.json` — o mesmo arquivo cujo SHA-256 o dono registra.
   Tool não declarada herda `nivel_padrao` (A5). Manifesto ausente ou torto ⇒
   **tudo** vira A5. Nunca A0.
2. **O veredito vem do NOMOS.** Não há cópia da política dentro da Gi. Mudou
   `~/.nomos/policy.json`, mudou o comportamento — sem redeploy.
3. **A Gi nunca aprova por ninguém.** Não existe caminho neste módulo que digite
   `CONFIO`, `ACEITO O RISCO` ou responda a fila do painel. Veredito diferente de
   `ALLOW` ⇒ `BLOQUEADO_POR_APROVACAO`, com o comando exato que falta ao dono.

---

## 3. As tools expostas à Gi

| capability da Gi | tool MCP | nível | roda hoje? |
|---|---|---|---|
| `navegador_ler` | `browser_extract` | A0 | **sim**, headless |
| `navegador_abas` | `browser_tabs` (só lista) | A0 | **sim**, headless |
| — | `browser_tab_open` | A2 | **não** — pede o dono |
| — | `browser_tab_switch` / `browser_tab_close` | A1 | **não** — pede o dono |
| `navegador_ver` (visão) | `browser_screenshot` | A0 | **sim**, headless |
| `navegador_abrir` | `browser_navigate` | A2 | **não** — pede o dono |

A tabela completa tool→categoria, com a justificativa de cada uma, está em
[`NOMOS-INTEGRATION.md`](./NOMOS-INTEGRATION.md#2-classificação-tool--categoria).
As três A0 leem uma página **já carregada**; abrir a página é A2 porque sai para
a rede. É por isso que, hoje, a Gi lê o navegador mas não o dirige.

---

## 4. O passo do dono — **não executado por nós**

### 4.1 Ambiente do serviço

O conector herda o ambiente do processo da Gi. Sem credencial o adaptador recusa
com `MCP_NO_CREDENTIAL` — o que é o comportamento certo. No arquivo de ambiente
do serviço (ou no `launchd` dele):

```bash
export NOMOS_BROWSER_URL=http://127.0.0.1:7777
export NOMOS_BROWSER_TOKEN_FILE=$HOME/.nomos-browser/control-token
```

### 4.2 A linha do dispatcher

Em `backend/gi_nomos/device_voice_gateway.py`, dentro de `build_dispatcher()`,
**depois** dos `d.register(...)` que já existem:

```python
def build_dispatcher(audit=None) -> NomosDispatcher:
    d = NomosDispatcher(audit=audit)
    ...                                    # as 8 capabilities atuais, intactas
    from .browser import registrar as registrar_navegador   # ← ACRESCENTAR
    registrar_navegador(d)                                  # ← ACRESCENTAR
    return d
```

E, para que o modelo de voz saiba que elas existem, na lista `TOOLS` do mesmo
arquivo:

```python
from .browser import TOOLS_REALTIME                          # ← ACRESCENTAR
TOOLS = [ ... ] + TOOLS_REALTIME                             # ← ACRESCENTAR
```

### 4.3 Reiniciar o serviço

```bash
# só o dono decide a hora: isto derruba a Gi por alguns segundos
launchctl kickstart -k gui/$(id -u)/com.gijarvis.backend
```

**Nada disso foi executado.** O serviço vivo continua exatamente como estava.

### 4.4 (Opcional) Registrar o conector no NOMOS

Enquanto o manifesto não estiver registrado, `browser.py` executa as tools A0
falando com o nosso server MCP por stdio — mesmo comando, mesmo `cwd`, mesma
classificação, mesmo veredito. Registrando, a execução passa a sair pelo
`nomos mcp chamar`, e a auditoria do NOMOS passa a ter a linha também:

```bash
nomos mcp confiar $REPO/packaging/mcp/manifesto.json --panel
```

`browser.py` detecta a mudança sozinho (`registrado()` consulta o catálogo a
cada chamada) — não há nada a reiniciar por causa disso.

---

## 5. Como verificar

```bash
python3 evidence/nomos-browser-final-loop/08-gi/e2e-gi.py
```

Sobe um daemon próprio com Chromium real e exercita o módulo REAL da Gi. Saída
atual (18 casos, 0 falhas):

```
GI_BROWSER_DISCOVERY=PASS
GI_BROWSER_ACTION=BLOQUEADO_POR_APROVACAO
GI_BROWSER_RESULT=PASS
GI_BROWSER_VISION=PASS
GI_BROWSER_INTEGRATION=PASS
```

`GI_BROWSER_ACTION=BLOQUEADO_POR_APROVACAO` **é o resultado certo**: navegação,
clique e formulário são A2, o NOMOS responde `REQUIRE_APPROVAL`, e a Gi não
executa. O caso `4b` fecha a porta do falso positivo — ele confere, pelo próprio
navegador, que a aba **não se moveu**: se a navegação tivesse escapado do gate, a
URL teria mudado.

Diagnóstico rápido, só-leitura:

```bash
cd $GI/backend && python3 -c \
  "from gi_nomos import browser as B; import json; print(json.dumps(B.diagnostico(), indent=2))"
```

Regressão da Gi (nada quebrou):

```bash
cd $GI/backend && \
  pytest -q test_gi_nomos.py test_gi_nomos_transport.py test_gi_audio_relay.py
#   42 passed
```
