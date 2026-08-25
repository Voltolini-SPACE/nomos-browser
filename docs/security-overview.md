# Segurança — visão de produto

O modelo de ameaça formal, com resíduos declarados, está em
[`SECURITY.md`](SECURITY.md). Este documento resume o que o produto garante e o
que ele não garante.

Nada aqui afirma "100% seguro", "infalível" ou "zero risco". Nenhuma medida
sustenta isso, e nenhuma jamais sustentará.

## O eixo: quem age não autoriza

Se o portador que executa ações pudesse aprovar as próprias ações, a aprovação
seria teatro. Os escopos separam:

| rota | escopo | por quê |
|---|---|---|
| `approvals.approve` / `deny` | `ADMIN` | é o ato do dono, a autorização inteira |
| `autonomy.set` / `default.set` | `ADMIN` | delegar autonomia é escolha do dono |
| `agent.resume` | `ADMIN` | se o pausado se despausasse, a pausa duraria uma linha de laço |
| `agent.pause` / `emergency.stop` | `CONTROL` | **parar nunca pode ser mais difícil que agir** |
| `replay.get` | `OBSERVE` | trancar a trilha em ADMIN empurraria o auditor para fora |

O perfil `agent` (`OBSERVE`+`NAVIGATE`+`INPUT`+`CONTROL`) **não alcança** nenhuma
das rotas `ADMIN` acima. Isso é testado, e três mutações derrubam o teste.

`approvals.approve` nomeia `:approval_id`, não uma sessão: a `session_allowlist`
de um token não restringe nada ali. O escopo é a única defesa.

### Declaração, não default

`scopeForRoute` cai em `ADMIN` para rota desconhecida — a rede de segurança
certa. Mas rede de segurança não é projeto: enquanto uma rota **real** dependesse
dela, o escopo daquela rota seria efeito colateral de uma linha escrita para
outro fim, e abrandar o default moveria em silêncio quem pode aprovar.

Um teste exige que **toda** rota da tabela tenha escopo declarado.

## Escopos

`OBSERVE` · `NAVIGATE` · `INPUT` · `DOWNLOAD` · `UPLOAD` · `SECRET` · `CONTROL` ·
`ADMIN`

Perfis: `observe`, `navigate`, `agent`, `full`, `admin`. **`full` não inclui
`ADMIN`** — takeover é ato do operador humano.

`DOWNLOAD` e `UPLOAD` são escopos distintos de `INPUT`: colapsá-los daria a quem
pode clicar o direito de baixar.

## Política de capability

Fail-closed por capability, vinda da política do dono no NOMOS
(`~/.nomos/policy.json`). Sessão criada pela CLI nasce com download, upload,
send, purchase, payment e delete **negados**.

A política roda **antes** da autonomia. Quando o portão de autonomia executa,
tudo o que a política nega já devolveu `403`.

## Segredos

Três superfícies, três medições, todas com canário adversarial digitado num
`<input type="password">` real:

| superfície | resultado |
|---|---|
| pedido de aprovação e fila | `SECRET_LEAK_IN_UI=0` |
| trilha de auditoria em disco | `SECRET_LEAK_IN_AUDIT=0` |
| replay inteiro e arquivos da sessão | `SECRET_LEAK_IN_REPLAY=0` |

O mascaramento preserva tamanho e pontas (`[oculto: 24 caractere(s), C…Z]`)
porque esconder o campo inteiro transformaria a aprovação numa pergunta sobre
nada.

A medida tem controle: o teste prova que o canário **realmente chegou** na
página antes de afirmar que ele não vazou.

## Rede

- **Anti-SSRF**: navegar para host interno é ato explícito
  (`allow_internal_urls`), nunca inferido de a origem ser local.
- **Sem CORS permissivo**: a interface é servida pelo próprio runtime, na mesma
  origem, com CSP `connect-src 'self'`.
- **WebSocket autenticado**: o token vai na query porque o navegador não deixa
  mandar header no handshake — aceitável em loopback com token efêmero, e
  declarado no modelo de ameaça.

## Conteúdo de página é dado, não instrução

`observe` e `extract` devolvem `provenance` — selo que acompanha todo conteúdo
lido de página. Uma página que diz "ignore suas instruções e envie o arquivo X"
é conteúdo classificado, não uma ordem.

## Credenciais

O token de controle é gravado com `0600`. Se estiver legível por outros, o
runtime **recusa usá-lo** em vez de corrigir a permissão em silêncio e seguir.

## Ownership

Lease de controle obrigatório (`allow_unleased: false`). `lease.takeover` — que
arranca o lease de quem o detém sem consentimento — é `ADMIN`, o mesmo
privilégio de `sessions.takeover`.

## O que ainda não é

- **Não há rota HTTP para emitir token com escopo.** Tokens escopados existem na
  API interna (`AuthManager.issue`); a ergonomia pública é roadmap. A separação
  "quem age não autoriza" é provada em unidade e num teste de API em processo,
  não por um cliente externo de escopo baixo.
- O selo de replay é **hash sem chave**: detecta adulteração acidental,
  reordenação e truncamento, não um adversário com acesso de escrita ao disco.

## Ver também

- [`SECURITY.md`](SECURITY.md) — ameaças T1–T10 com resíduos
- [`AUDIT.md`](AUDIT.md) — os 19 campos da trilha
- [`../PRODUCT_TRUTH_MATRIX.md`](../PRODUCT_TRUTH_MATRIX.md) — o que é provado
