# Segurança — extensão NOMOS (side panel)

Complementa o [`SECURITY.md`](../SECURITY.md) da raiz. Aqui só o que a extensão
acrescenta ou herda de forma diferente.

## Modelo de permissão (menor privilégio, com guarda executável)

| pedido | por quê | guarda |
|---|---|---|
| `sidePanel` | é o produto | `tests/extension-build.test.ts` fixa a lista exata |
| `storage` | URL/token em `chrome.storage.session` | idem |
| `host_permissions: 127.0.0.1 / localhost` | falar com o daemon local sem abrir CORS | idem; `<all_urls>` é proibido por asserção |
| content scripts | **não existem** | asserção `content_scripts === undefined` |
| `chrome.tabs`/`scripting`/`debugger`/`cookies` | **não usados** | asserção sobre o fonte do painel |

O highlight na página é do runtime (spotlight) — é isso que permite a linha
"content scripts: não existem". Quem um dia quiser content script vai ter que
editar o teste, e o teste é onde essa conversa deve acontecer.

## Autenticação painel ↔ runtime

- O painel só age com o token do daemon (Bearer em HTTP; `?token=` no WS, que
  é o único canal do handshake de WebSocket — exposição já declarada no
  SECURITY.md, loopback, token revogável).
- Token digitado pelo dono, nunca descoberto: amarra o painel ao runtime certo
  por ato explícito.
- `chrome.storage.session`: morre com o navegador, não vai para disco de
  perfil sincronizado, não é legível por páginas nem por outras extensões.
- Escopos valem no painel como em qualquer cliente: um token sem `ADMIN` não
  liga AUTO nem retoma de pausa — o painel mostra a recusa do runtime em vez
  de esconder o botão (a autoridade é do runtime, não da tela).

## Ameaças específicas e posição honesta

**T-ext1 — processo falso na porta do runtime.** Um processo local malicioso
escutando na porta receberia o token colado. Mitigação real: loopback + a
porta é do dono da máquina; quem roda processo malicioso local já venceu por
outros meios. O mesmo vale para o console e o CLI — a extensão não piora nem
resolve. Registrado como risco aceito de atacante local.

**T-ext2 — extensão clonada.** Uma extensão falsa pode imitar o painel e pedir
o token. Mitigações: instalação explícita (modo dev/CWS), nome/ícone do cofre,
e o token dá exatamente os escopos que o dono deu a ele — o raio de dano é o
raio do token. Nunca prometemos que UI é canal de identidade.

**T-ext3 — replay de token.** Tokens expiram e são revogáveis
(`packages/api/src/auth.ts`); o runtime guarda hash, não segredo.

**T-ext4 — página maliciosa dirigindo o runtime.** Sem CORS aberto, uma página
não fala com o daemon (T7 do SECURITY.md continua fechado). A extensão não
reabre isso: host_permission de extensão não vaza para páginas.

**T-ext5 — prompt injection visual.** Texto de página NUNCA é autoridade: o
que a página diz chega ao modelo como conteúdo selado
(`selarObservacao`/`selarTexto`, FASE de injection do runtime, com testes
`injection-wired` e `security-net-injection`). O painel não acrescenta canal
novo: ele nem lê a página — pede ao runtime. Tentativa relevante fica na
trilha; não há alerta por qualquer texto, de propósito.

**T-ext6 — aprovação por engano (clickjacking do painel).** O side panel é
chrome UI, fora do alcance de CSS/JS da página. O card de aprovação mostra
ação, alvo, nível, política e argumentos REDIGIDOS pelo runtime — decisão com
os olhos abertos, e single-use.

## O que a extensão NÃO faz, por contrato

- Não aprova nada sozinha, nem "lembra" aprovações.
- Não guarda segredo além do token de conexão (e nunca em `storage.local`).
- Não injeta script em página.
- Não abre porta, não escuta nada: só cliente.
