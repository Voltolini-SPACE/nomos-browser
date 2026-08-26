# NOMOS Browser — Gi Side Panel Real Production Closeout

**Versão alvo:** 0.4.1 (correção de UX pública sobre a 0.4.0)
**Data:** 2026-08-26
**Skill:** implementation-loop-100 (spec → implementar → testar → validar → evidenciar)

## O problema que o dono viu

Ao clicar no ícone NOMOS, o dono **não encontrava o chat da Gi** — encontrava um
formulário técnico: **"CONECTAR AO RUNTIME"**, pedindo uma URL e um *"token
impresso pelo daemon"*. O `#chat` ficava `hidden` até alguém conectar à mão.
Como o token só ia para a área de transferência no arranque do serviço (e o
clipboard já havia sido sobrescrito havia mais de uma hora), **colar o token não
funcionava mais** — e o dono ficava sem caminho óbvio para falar com a Gi.

Isto violava o princípio central do produto: nada de terminal, nada de token,
nada de descobrir URL interna para conversar.

## Causa raiz (provada, não deduzida)

Arquitetura: extensão MV3 (cliente fino) + daemon Node (runtime) que sobe um
Chromium **real** via Playwright com a extensão embarcada (`--load-extension`).

- O painel abria no formulário porque **a auto-conexão nunca foi ligada**.
- `packages/api/src/auth.ts` já documentava a intenção que faltava:
  o `rootSecret` existe *"só para o daemon injetar na própria UI (mesma
  origem)"*. Essa injeção nunca havia sido implementada — **este é o furo**.
- `ai_provider` já estava configurado na instalação (`ollama:qwen2.5-coder:7b`);
  a "parede de IA" não era o bloqueio.

## A correção (alinhada ao design existente)

O daemon passa a **injetar a credencial na própria UI**, de mesma origem — que é
exatamente o que `auth.ts` prometia e o que `serveUi()` já faz para a NOMOS Web.

1. **`packages/api/src/daemon.ts`** — ao arrancar (porta ligada, **antes** de
   qualquer sessão/Chromium), se `extension_dir` está setado, grava
   `<extension_dir>/local-runtime.json` = `{base, token}` com modo **0600**;
   remove no encerramento. Não é `web_accessible_resource` — nenhuma página web
   o alcança; só a própria página do painel (mesma origem `chrome-extension://`).
2. **`packages/extension/src/sidepanel.js`** — no arranque, `fetch("local-runtime.json")`
   (recurso empacotado da própria origem, sem nenhuma `chrome.*` de página):
   se houver handshake, **conecta sozinho** e mostra o chat; senão cai no
   `storage.session`; senão mostra o formulário (uso avançado/remoto).
   Saudação de estado vazio + input focado + onboarding uma única vez. Cada
   mensagem anexa automaticamente a aba ativa (título+URL) pela rota do runtime,
   para *"que página é esta?"* simplesmente funcionar.
3. **`packages/extension/src/sidepanel.html`** — identidade **Gi** no cabeçalho,
   cartão de onboarding, placeholder amigável.
4. **`launch.ts` / `servico.ts`** — deixam de copiar o token para o clipboard;
   a mensagem final diz "clique no ícone — conecta sozinho".
5. **`packages/extension/build.ts`** — remove qualquer `local-runtime.json`
   residual, para todo build nascer pristino.

## Evidência (comando + retorno real)

### Prova LIVE em Chromium real (daemon + Ollama locais, custo 0)
```
HANDSHAKE_WRITTEN=PASS            HANDSHAKE_MATCHES_DAEMON=PASS
AUTOCONNECT_NO_TOKEN=PASS         TOKEN_FIELD_UNTOUCHED=PASS
GI_RESPONDED=PASS  (Gi: "Comecei. Acompanhe em AGORA.")
HANDSHAKE_REMOVED_ON_CLOSE=PASS
```
Captura: o painel abriu **já conectado**, sessão viva, pergunta do usuário e
resposta da Gi no mesmo painel, aba ativa no contexto — sem token, sem formulário.

### Testes da extensão (Chromium real, um arquivo isolado por vez)
```
extension-build         5/5    (contratos estáticos: sem hex, permissões mínimas,
                                nenhuma chrome.* de página no painel)
extension-autoconnect   3/3    POSITIVA (auto-conecta sem token) +
                                CONTRA-PROVA (token forjado NÃO conecta) +
                                SEGURANÇA (handshake 0600, não web_accessible)
extension-adversarial   5/5    (recarga, aprovação velha, 2ª sessão, sessão
                                morta, runtime morto)
extension-e2e          14/14   (caminho MANUAL/avançado continua de pé)
```

### Regressão completa (suíte por arquivo, isolada)
```
FULL_REGRESSION = 827 PASS / 0 FAIL   (43 arquivos OK, 0 mortos)
baseline 0.4.0 = 824 → +3 (os novos testes de auto-conexão)
```

### Anti-falso-positivo (FASE 17)
`extension-autoconnect` inclui uma prova NEGATIVA: com um `local-runtime.json`
de **token forjado** e `storage` vazio, o painel **NÃO** mostra o chat — volta ao
formulário. Se a auto-conexão apenas "mostrasse o chat" sem validar a credencial,
esse teste falharia.

## Segurança — o que NÃO mudou

- Permissões do manifesto continuam **exatamente** `["sidePanel","storage"]`.
- O painel continua sem falar com o Chromium (nenhuma `chrome.tabs/scripting/
  debugger/cookies/webNavigation`) — toda ação passa pelo runtime.
- O handshake vale só dentro do Chromium que o próprio daemon lançou (mesma
  origem), 0600, nunca `web_accessible`. O caminho manual (token explícito)
  segue existindo para runtime remoto.

## Status

`STATUS_FINAL=WARN_PARTIAL_DELIVERY_WITH_EXPLICIT_GAPS` — a correção está
implementada, testada e **provada em Chromium real**, sem regressão. Os gaps
restantes são atos que exigem autorização/execução do dono (abaixo).

### Provado nesta máquina
REAL_CHROME · ONE_CLICK_GI · GI_VISIBLE_NEXT_TO_PAGE · USER_CAN_TYPE ·
GI_CAN_RESPOND · PAGE_CONTEXT · ASK · AUTO · PAUSE · RESUME · STOP · TAKEOVER ·
AUDIT · full extension regression · anti-false-positive.

### Pendente de decisão/ato do dono
- **Atualizar a instalação viva** (`~/.nomos-browser/app`) com este código e
  reiniciar o serviço — reinicia a janela NOMOS atual do dono.
- **git commit/push, tag e GitHub Release** (0.4.1) — ato outward-facing.
- **Atualizar `voltolini.space/browser/`** com a mensagem correta.
- **Chrome Web Store** — ato exclusivo da conta do dono.
