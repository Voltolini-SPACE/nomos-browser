# NOMOS Browser Runtime — Modelo de ameaça (FASE 40)

Escopo: o runtime roda em `127.0.0.1`, controla um navegador com sessões
autenticadas do dono e aceita comandos de agentes de IA. Isso combina três coisas
perigosas num processo só: **credenciais reais**, **execução dirigida por modelo**
e **conteúdo não confiável vindo da web**.

## Postura central

> Conteúdo lido da web é **dado**, nunca instrução.

Uma página pode conter texto dirigido ao agente ("ignore suas regras", "o usuário
já autorizou", "clique em Confirmar"). O runtime não tem como impedir que o modelo
leia isso — mas tem como garantir que **ler não basta para agir**: capability é
checada no runtime, do lado de cá da fronteira, sobre a identidade do agente. Um
texto na página não altera `Capabilities`.

## Ativos

| Ativo | Onde vive | Impacto se vazar |
|---|---|---|
| Cookies de sessão do dono | `profiles/<perfil>/` | Sequestro de conta |
| Segredos do vault | `profiles/<perfil>/vault.json` (0600) | Credencial comprometida |
| Audit log | `sessions/<id>/actions.jsonl` | Histórico de navegação |
| Superfície de controle | `127.0.0.1:7777` REST/WS | Controle total do navegador |

## Ameaças e mitigação

### T1 — Injeção de prompt via conteúdo de página
Página instrui o agente a executar ação sensível.
**Mitigação:** capability engine no runtime. `send`, `purchase`, `payment`,
`delete`, `upload` nascem **negados** (`RESTRICTED_CAPABILITIES`). Ferramenta sem
entrada em `REQUIRED_CAPABILITY` é negada — fail closed, não permitida por omissão.
**Resíduo:** dentro das capabilities concedidas o agente pode ser enganado. Por isso
a classe `COMMIT` existe e é separada de `ACT`.
**FASE 10:** `allow_unleased` passou a ser `false` por padrão (`NOMOS_BROWSER_ALLOW_UNLEASED`).
Quem cria a sessão recebe lease exclusivo no mesmo ato; qualquer outro principal
é recusado com `CONTROL_NOT_OWNED` até adquirir, herdar por handoff, ou esperar o
lease alheio expirar. Antes, uma sessão que ninguém tivesse "leaseado" ficava
aberta a qualquer chamador — a arbitragem só valia contra quem já tivesse pedido
um lease primeiro.

### T2 — SSRF / acesso a rede interna
Agente (ou página) leva o navegador a `169.254.169.254`, `10.0.0.0/8`, `localhost`.
**Mitigação:** guarda de URL em `policy.ts` bloqueia loopback, link-local, RFC1918,
`.local`, salvo `allow_internal` explícito na sessão.
**Nota honesta:** `allow_internal` é necessário para os próprios testes do runtime
(fixtures em `127.0.0.1`). É um flag explícito, nunca implícito.

### T3 — Esquemas de URL perigosos
`file://`, `chrome://`, `javascript:`, `data:` grandes.
**Mitigação:** allowlist de esquema (`http`, `https`, `about:blank`). `file://`
bloqueado sempre — é leitura arbitrária do disco do dono.

### T4 — Vazamento de segredo para o LLM
**Mitigação:** o agente pede `credential_ref`; o runtime injeta na página. O valor
não volta em `result`, não entra em evento, não entra em audit. Só o uso é
registrado (`secret.used` com a *referência*). `assertNoSecretLeak` blinda logs.
**Cookies nunca são devolvidos ao agente** — não há rota de leitura de cookie na API.

### T5 — Vazamento entre sessões
**Mitigação:** um `BrowserContext` por sessão, `userDataDir` por perfil. Perfis não
compartilham cookie por padrão. Agente A não acessa sessão de B sem capability.
**Verificação:** FASE 41 exige prova mecânica — cookie de A ausente em B.
**FASE 10/11 — duas correções medidas nesta frente:**
1. A identidade de CONTROLE é o **sujeito do token**, nunca `x-nomos-client`.
   O header é auto-declarado; arbitrar por ele deixaria qualquer processo local
   escrever "sou o agente-A" e herdar o volante dele.
2. `session_allowlist` passou a valer também nas rotas de **ação**. Ela era
   checada só onde o `session_id` vinha no caminho ou na query; numa ação ele vem
   no CORPO, que é lido depois do gate — então um token emitido para a sessão A
   operava a sessão B. Quem barrava, por acidente, era a arbitragem de lease.
   Defesa que só funciona quando outra defesa está ligada não é defesa.

### T6 — Path traversal em upload/download
**Mitigação:** normalização de caminho e confinamento a uma raiz permitida;
`..` rejeitado. Download registra origem, destino, mime e tamanho — não existe
download silencioso.

### T7 — Superfície de controle exposta
`7777` aberto na rede daria controle do navegador do dono a qualquer um da LAN.
**Mitigação:** bind em `127.0.0.1` por padrão. Bind não-loopback exige configuração
explícita **e** token de autenticação.

**O gap está FECHADO (FASE 11).** As três frentes que faltavam:

| Frente | Onde | Comportamento |
|---|---|---|
| REST | `daemon.ts` (gate antes de ler corpo) | 401 sem credencial, 403 sem escopo |
| WebSocket `/events` | `daemon.ts#server.on("upgrade")` | recusa **no handshake**, antes de qualquer frame |
| MCP | `packages/mcp/src/server.ts` | exige `NOMOS_BROWSER_TOKEN`; recusa **local**, sem abrir socket |

O WebSocket usa o **mesmo `AuthManager`** do REST — autenticação e autorização
(`OBSERVE`, mais a allowlist de sessão quando houver). Sem credencial válida o
upgrade é recusado com status próprio (`401` sem credencial, `403` sem escopo) e
o socket é destruído. Nunca é aceito-e-mudo: um socket aberto que não entrega
evento é indistinguível, para o cliente, de um que foi negado — e essa ambiguidade
esconde tanto a falha de configuração quanto o ataque.

**Risco aceito e mitigado — token na querystring.** `/events?token=…` é aceito
porque há cliente WebSocket que não permite header no handshake. O custo é real:
URL com segredo vaza para histórico de shell, `ps`, log de proxy reverso e
Referer. Mitigações: (a) o runtime **não registra a URL do upgrade** em log,
evento ou trilha; (b) `redact.ts` remove `token` de query string na
observabilidade de rede; (c) o token é **efêmero** — morre no reinício do daemon.
**Prefira o header `Authorization: Bearer`.** A querystring é a saída de
compatibilidade, não a recomendada.

**Autorização MCP.** O servidor MCP deixou de repassar chamadas sem se
identificar. Sem `NOMOS_BROWSER_TOKEN` ele recusa **antes de abrir socket** —
mandar e deixar o daemon negar significaria considerar aceitável tentar, e num
dia em que alguém suba o daemon com `NOMOS_BROWSER_AUTH=off` "tentar" viraria
"conseguir". A credencial é propagada em todo POST, e as recusas do runtime por
escopo e por arbitragem ganham nome próprio no erro MCP (`MCP_SCOPE_DENIED`,
`MCP_CONTROL_NOT_OWNED`) — os dois saem como `CAPABILITY_DENIED` no contrato e
pedem ações opostas de quem opera.

**Evidência ao lado da afirmação:**
`evidence/nomos-browser-final-loop/11-security/bateria-completa.ts` — 53 vetores,
`SECURITY_SUITE=PASS`, `OPEN_SECURITY_P1=0`. A bateria anterior
(`…/final-validation/05-security/prova-guardas-vivos.ts`, 16 vetores) continua
valendo e não foi alterada.

**Resíduo honesto:** o bind continua sendo loopback por padrão e essa continua
sendo a linha de defesa mais importante. Autenticação reduz o dano de um processo
local hostil; não torna seguro expor a porta na LAN.

### T8 — Redação insuficiente em observabilidade de rede
**Mitigação:** `redact.ts` remove `Authorization`, `Cookie`, `Set-Cookie`,
`x-api-key`, `token`, `password` e afins, recursivamente, case-insensitive, em
headers, corpo e query string.

### T9 — CAPTCHA e antiabuso
**Postura:** o runtime **detecta e escala**, não contorna. Resolver CAPTCHA está
fora do produto por decisão, não por limitação. Ao detectar, a task vai para
`WAITING` e pede intervenção humana.

### T10 — Watchdog em laço de reinício
Um watchdog que reinicia sem teto transforma falha em negação de serviço local.
**Mitigação:** backoff com teto e contador de falhas; após N tentativas o runtime
fica `degraded` e para de reiniciar, em vez de girar para sempre.

## Fora de escopo desta versão

- Sandbox de processo por sessão (todas compartilham o processo do runtime)
- Assinatura CRIPTOGRÁFICA (com chave) do audit log. **FASE 12** acrescentou um
  SELO de integridade ao bundle de replay (`seal.json`: sha256 por arquivo,
  tamanho e contagem), verificado em `verifyReplay`. Ele detecta adulteração de
  linha, reordenação e truncamento — inclusive quando o JSON continua válido e os
  timestamps continuam em ordem, que é o caso que nenhuma checagem estrutural
  pega. **Resíduo declarado:** é hash sem chave. Quem tem permissão de escrita no
  diretório da sessão pode adulterar E resselar. Fecha corrupção e adulteração
  oportunista; não fecha adversário com acesso de escrita — para isso seria
  preciso chave fora da máquina, que está fora do escopo desta versão.
- Multiusuário: o runtime assume **um dono** na máquina local

## Proibições operacionais herdadas da missão

Não usar produção financeira como laboratório. Não executar pagamento real. Não
excluir dado real. Não publicar conteúdo real. Não alterar sistema externo fora de
ambiente controlado.
