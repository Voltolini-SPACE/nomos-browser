# Gap analysis — o que separa o produto validado de um release público

Base: teste de produção real PASS @ `7455c9c` (824/0). Pergunta: uma pessoa que
não conhece o código consegue instalar e usar?

## Dependências de hoje, classificadas

| dependência hoje | classe | destino no release |
|---|---|---|
| Terminal para lançar (`node packages/extension/launch.ts`) | CAN_AUTOMATE | CLI `nomos-browser` + LaunchAgent (start no login); terminal só no Developer Mode |
| Node.js ≥ 22.18 | USER_REQUIRED | requisito declarado no instalador (verificado com erro claro). Empacotar Node (Electron/pkg) fica adiado por custo — ver ADR |
| npm ci no repo | CAN_AUTOMATE | `install.sh` do release faz sozinho no diretório da instalação |
| Chromium do Playwright | CAN_AUTOMATE | `install.sh` roda `npx playwright install chromium` |
| Path do repo do desenvolvedor | DEV_ONLY | instalação vive em `~/.nomos-browser/app`; nenhum path do dev na doc pública |
| `NOMOS_BROWSER_AI_PROVIDER=` digitado por execução | CAN_AUTOMATE | config persistente `nomos-browser.config.json` gravada pelo instalador; Ollama detectado automaticamente (porta 11434 + lista de modelos) |
| Ollama instalado com um modelo | OPTIONAL_ADVANCED | sem ele TUDO funciona menos o planejamento de tasks — e a Gi diz isso; onboarding explica como instalar |
| Daemon iniciado manualmente a cada uso | CAN_AUTOMATE | LaunchAgent (`RunAtLoad`) + `nomos-browser start/stop/status` |
| Token colado no painel | USER_REQUIRED (1º uso) | mantido por decisão de segurança (ato explícito); lançador copia para o clipboard; pairing automático fica registrado como evolução (FASE 9) |
| Extensão carregada por flag no Chromium do runtime | CAN_EMBED | já embutida pelo daemon (`extension_dir`); para Chrome de marca: zip da CWS (pacote pronto) |
| Cofre de marca (`~/.brand-governance`) p/ build da extensão | DEV_ONLY | o RELEASE distribui a extensão JÁ construída (dist no zip/tarball); o build do cofre é passo de quem publica, não de quem instala |
| Conhecimento de worktree/branch | DEV_ONLY | irrelevante para o usuário do artefato |

## O que já está pronto e não muda

Runtime governado, painel, ASK/AUTO, aprovação, spotlight, audit, replay,
takeover — validados em produção real. Esta missão é DISTRIBUIÇÃO, não produto.

## Experiência-alvo (FASE 2)

```
curl -fsSL <release>/install.sh | bash   (ou baixar e rodar)
        ↓ instala app + Chromium + LaunchAgent + config (Ollama detectado)
nomos-browser start        (ou login seguinte: inicia sozinho)
        ↓ janela do NOMOS Browser abre com o painel embarcado
ícone NOMOS → colar token (já no clipboard) → conversar com a Gi
```

Developer Mode continua: `node packages/extension/launch.ts` no repo.
