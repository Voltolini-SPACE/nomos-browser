# ADR — Distribuição pública do NOMOS Browser

- Status: **ACEITA** (2026-08-26)
- Contexto: produto validado em produção real (`7455c9c`, 824/0); falta o
  caminho de instalação para quem não conhece o código.

## Alternativas

| | proposta | instalação | atualização | assinatura/notarização | complexidade |
|---|---|---|---|---|---|
| A | Extensão + daemon instalado separadamente (docs) | 2 passos manuais desconexos | manual dupla | n/a | baixa, UX ruim |
| B | Extensão + **serviço local instalado por script** (CLI + LaunchAgent) | 1 script, 1 comando | re-rodar install do release novo | não exigida (script + node do usuário) | **baixa, UX profissional** |
| C | App empacotado completo (Electron/fork) | 1 .dmg | pipeline próprio | OBRIGATÓRIA (custo Apple Developer + manutenção Chromium) | alta |
| D | Híbrido: B agora, C quando houver demanda paga | — | — | — | — |

## Decisão: **D com B como entrega desta missão**

O que fica de fora COM NOME: .dmg assinado/notarizado e binário Node embutido
exigem conta Apple Developer e pipeline de assinatura — custo que um produto
recém-público ainda não pagou. O requisito "Node ≥ 22.18 instalado" é declarado
com verificação e mensagem clara no instalador (mesma classe de exigência de
ferramentas como muitas CLIs profissionais). Windows: fora desta versão,
declarado.

## Forma do release

```
GitHub Release vX.Y.Z
├── nomos-browser-vX.Y.Z.tar.gz     produto executável (código + extensão dist
│                                    pré-construída do cofre + install.sh)
├── nomos-browser-extension-vX.Y.Z.zip   extensão para CWS / carga manual
└── SHA256SUMS.txt
```

`install.sh` (idempotente): verifica Node/versão → desempacota em
`~/.nomos-browser/app` → `npm ci --omit=dev` → `npx playwright install chromium`
→ detecta Ollama (`:11434`, primeiro modelo compatível) e grava
`nomos-browser.config.json` → instala CLI `nomos-browser` em `~/.local/bin` →
registra LaunchAgent `space.voltolini.nomos-browser` (RunAtLoad). Nunca toca
Ollama global, dados de outros produtos NOMOS, nem processos que não criou.

CLI: `nomos-browser install|start|stop|restart|status|logs|uninstall`.
`uninstall` remove app+LaunchAgent+CLI; PRESERVA `~/.nomos-browser`
(token/perfis/config) a menos que `--purge`.

Chrome real: zip da extensão (CWS quando o dono publicar; carga manual
documentada até lá). Painel/token/segurança: inalterados — o serviço é o MESMO
daemon governado, nada de autoridade nova.

## Native Messaging / pairing sem colar token

Avaliado e ADIADO com registro: exige host manifest por navegador e mais uma
superfície de auth; o fluxo atual (token no clipboard + colar = ato explícito)
foi validado no teste real e não enfraquece nada. Evolução natural: handshake
one-time no primeiro uso.
