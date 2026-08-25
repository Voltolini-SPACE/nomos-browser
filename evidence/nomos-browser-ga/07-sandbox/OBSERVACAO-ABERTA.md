# Observação aberta — diretórios `nomos-sandbox-*` em `/tmp`

**Status: não medido. Isto não é um achado; é uma pergunta em aberto.**

Ao fim da missão havia 39 diretórios `/private/tmp/nomos-sandbox-*`, criados
entre 13:23 e 13:42 — a janela das corridas de E2E e regressão desta sessão.
Foram removidos.

## O que sei

Vários cenários do E2E matam o daemon com **SIGKILL de propósito** (13 e 19 —
crash recovery; 20 — supervisor). Depois de um `SIGKILL` não há limpeza
possível, por definição: o processo não roda mais nada. Se os 39 vierem daí, não
há defeito nenhum — é o preço de testar crash de verdade.

## O que NÃO sei, e por que

Tentei medir se o encerramento **gracioso** também deixa resíduo. A sondagem
falhou em criar a sessão (o `POST /api/v1/sessions` não devolveu `session_id` no
formato que eu esperava), então nenhum sandbox foi criado e os três números
saíram `0`. Isso não prova que o produto limpa — prova que **o meu teste não
testou nada**.

Registrar `0 0 0` como se fosse resultado seria exatamente o tipo de verde vazio
que esta missão passou o tempo todo caçando. Fica como pergunta.

## Como fechar isto, quando alguém quiser

1. Subir um daemon com `NOMOS_RUNTIME_DIR` próprio.
2. Abrir uma sessão pelo caminho que de fato lança o Chromium (a CLI, o SDK, ou
   `browser.open`) — e confirmar que um `nomos-sandbox-*` NASCEU.
3. Fechar a sessão (`DELETE /api/v1/sessions/<id>`) e conferir se sumiu.
4. Repetir com `SIGTERM` no daemon, e depois com `SIGKILL`, separando os três
   casos. Só o terceiro tem desculpa.

Nada disso bloqueia a `v0.2.0`: são arquivos temporários em `/tmp`, sem segredo,
sem efeito sobre política, capability ou auditoria. É higiene, e higiene não
medida não vira afirmação.
