# Quick start — do zero ao primeiro browser task

Tempo: alguns minutos. Requisitos: Node ≥ 22.6, macOS ou Linux.

## 1. Instalar

```bash
git clone <repo> nomos-browser && cd nomos-browser
npm ci --include=dev
npx playwright install chromium
```

`--include=dev` importa: com `NODE_ENV=production` ou `npm config omit=dev` o
`npm ci` pula as devDependencies e o typecheck falha depois com *"This is not the
tsc command you are looking for"*.

Não existe passo de build para o runtime — o Node executa TypeScript nativamente.

## 2. Provar que o controle é real (opcional, 30 s)

```bash
node spike/fase1_spike.ts
```

Ele despacha um clique por CDP e confere `isTrusted=true` na página, **e**
despacha um por JavaScript conferindo `isTrusted=false`. O segundo é o controle
negativo: sem ele, "controlamos o Chromium" seria só uma frase.

## 3. Subir o runtime

```bash
node packages/api/src/daemon.ts
```

Ele imprime a porta (padrão `127.0.0.1:7777`) e o caminho do token de controle.
A interface fica na raiz, e exige o token:

```
http://127.0.0.1:7777/?token=<TOKEN>
```

O token vive em `~/.nomos-browser/control-token` com permissão `0600`. Se o
arquivo estiver legível por outros, o runtime **recusa usá-lo** — credencial
legível por terceiros é credencial comprometida.

## 4. Primeiro comando

```bash
node packages/cli/src/main.ts health
```

## 5. Primeiro browser task

```bash
# abre uma URL e cria a sessão
node packages/cli/src/main.ts open https://example.com

# guarde o SESSION_ID impresso
node packages/cli/src/main.ts sessions
```

A sessão nasce com a **política padrão**: download, upload, send, purchase,
payment e delete negados. A CLI nunca concede capability sensível.

Com o console aberto em paralelo, você vê a página espelhada e o cursor do
agente enquanto isso acontece.

## 6. Escolher o modo de autonomia

```bash
TOKEN=$(cat ~/.nomos-browser/control-token)
SID=<SESSION_ID>

curl -s -X POST localhost:7777/api/v1/sessions/$SID/autonomy \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"ASK","by":"dono"}'
```

Em `ASK`, a próxima ação que mudar a página vai parar e pedir aprovação — no
console, ou por `POST /api/v1/approvals/<id>/approve`.

## 7. Ver o que ficou gravado

```bash
node packages/cli/src/main.ts replay $SID
node packages/cli/src/main.ts replay verify $SID
```

## 8. Encerrar

```bash
node packages/cli/src/main.ts close $SID
```

Ao encerrar, a sessão é **selada**: o replay dela passa a ter selo de
integridade.

## Como serviço supervisionado (macOS)

```bash
bash scripts/service.sh install
bash scripts/service.sh start
bash scripts/service.sh health
```

## Próximos passos

- [`live-agent-console.md`](live-agent-console.md) — a tela e seus controles
- [`ask-mode.md`](ask-mode.md) · [`auto-mode.md`](auto-mode.md) — os dois modos
- [`demos.md`](demos.md) — roteiros com resultado esperado
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — quando algo não sobe
