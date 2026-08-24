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

### T6 — Path traversal em upload/download
**Mitigação:** normalização de caminho e confinamento a uma raiz permitida;
`..` rejeitado. Download registra origem, destino, mime e tamanho — não existe
download silencioso.

### T7 — Superfície de controle exposta
`7777` aberto na rede daria controle do navegador do dono a qualquer um da LAN.
**Mitigação:** bind em `127.0.0.1` por padrão. Bind não-loopback exige configuração
explícita **e** token de autenticação.
**Gap conhecido e aberto:** autenticação de WebSocket e autorização MCP ainda não
estão implementadas. Enquanto isso, qualquer processo local fala com o runtime.
Isso é aceitável só porque o bind é loopback — **não** exponha a porta.

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
- Assinatura/atestação do audit log (é append-only, não é à prova de adulteração)
- Multiusuário: o runtime assume **um dono** na máquina local

## Proibições operacionais herdadas da missão

Não usar produção financeira como laboratório. Não executar pagamento real. Não
excluir dado real. Não publicar conteúdo real. Não alterar sistema externo fora de
ambiente controlado.
