# Auditoria e replay

Duas coisas diferentes que costumam ser confundidas:

- **auditoria** é a trilha do que foi decidido e executado, encadeada por hash;
- **replay** é a leitura dessa trilha depois, junto com eventos, rede e imagens.

O schema completo dos 19 campos está em [`AUDIT.md`](AUDIT.md).

## O que entra na trilha

Toda ação, **inclusive as negadas**. Uma trilha que só registra sucesso não
serve para auditoria: o que interessa a quem investiga costuma ser exatamente o
que não passou.

Entram também as decisões de política (`policy.allow` / `policy.deny`), a
proposta de aprovação (`action.proposed`, com `policy_decision: require_approval`),
a decisão do dono, o handoff de controle e o selo da sessão.

Segredos são redigidos **na origem**, antes de entrar na trilha.

## Selo

Ao encerrar, a sessão é selada: um `seal.json` com o digest de cada arquivo do
bundle. `nomos-web replay verify <ID>` confere.

O selo detecta adulteração, reordenação e truncamento. Ele é **hash sem chave** —
não protege contra um adversário com acesso de escrita ao disco, e isso está
declarado em vez de escondido.

## Replay é somente leitura

Três camadas independentes, porque cada uma falha de um jeito diferente:

**1. Roteamento.** Não existe verbo de escrita em `/replay`. `POST`, `PUT`,
`PATCH` e `DELETE` param no roteador com `405` e `Allow: GET`, sem chegar ao
daemon. Uma tela pode esquecer de esconder um botão; uma rota que não existe não
pode ser chamada.

**2. Não-ressurreição.** Ler o histórico inteiro de uma sessão encerrada não a
traz de volta: a ação seguinte sobre ela continua recusada, e ela não reaparece
na listagem de sessões vivas.

**3. Declaração.** `read_only: true` e `mode: "REPLAY"` viajam no corpo. A
interface **lê**; ela não deduz que está em replay porque "a sessão parece
encerrada".

## Honestidade da leitura

O replay relata o que não conseguiu ler, em vez de encurtar a linha do tempo:

```json
"leitura": {
  "linhas_corrompidas": 0,
  "fontes_ausentes": ["events.jsonl", "network.jsonl", "screenshots", "result.json"],
  "result_erro": null
}
```

O modo de falha perigoso seria engolir uma linha quebrada e devolver `200` com
uma linha do tempo silenciosamente incompleta — indistinguível de uma sessão que
fez menos. Corrompendo uma linha real de `actions.jsonl`, a rota responde `200`
**e reporta**.

## "Não existe" não é "não fez nada"

Uma sessão inventada e uma sessão real que gravou pouco têm exatamente a mesma
forma no bundle: arrays vazios, contagens em zero. Devolver `200` para as duas
faria a tela afirmar "essa sessão não fez nada" sobre algo que nunca houve — uma
mentira que parece um dado.

Sessão sem diretório é `404 SESSION_NOT_FOUND`. A distinção vem da existência do
diretório, não do conteúdo, que é ambíguo.

## Como usar

```bash
# linha do tempo
node packages/cli/src/main.ts replay <SESSION_ID>

# integridade
node packages/cli/src/main.ts replay verify <SESSION_ID>
node packages/cli/src/main.ts replay verify <SESSION_ID> --pixels --strict

# pela API
curl -s localhost:7777/api/v1/sessions/<ID>/replay        -H "authorization: Bearer $TOKEN"
curl -s localhost:7777/api/v1/sessions/<ID>/replay/verify -H "authorization: Bearer $TOKEN"
```

Na interface: aba **History**.

## Quem pode ler

`replay.get` e `replay.verify` são `OBSERVE`. A trilha é o que torna auditável o
que o agente fez; trancá-la em `ADMIN` empurraria o auditor para fora.

Quem pode **ler** o replay não pode aprovar, delegar modo nem retomar — isso é
testado com uma segunda identidade de escopo baixo.

## Ver também

- [`AUDIT.md`](AUDIT.md) — os 19 campos
- [`RECOVERY.md`](RECOVERY.md) — o que sobrevive ao quê
- [`live-agent-console.md`](live-agent-console.md#histórico) — o painel
