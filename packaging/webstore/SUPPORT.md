# NOMOS Browser — suporte

- Site: https://voltolini.space/#browser
- Código e issues: https://github.com/Voltolini-SPACE/nomos-browser/issues
- Guia do usuário: `docs/USER_GUIDE.md` (no repositório e no artefato instalado)
- Diagnóstico rápido: `nomos-browser status` e `nomos-browser logs`

## Problemas comuns

| sintoma | causa real | o que fazer |
|---|---|---|
| Painel: "credencial expirada — reconecte" | o serviço reiniciou; o token rotaciona a cada boot | cole o token novo (Cmd+V — o serviço copia ao iniciar) |
| Painel: "runtime inalcançável" | o serviço não está rodando | `nomos-browser start`; depois `nomos-browser logs` |
| Gi: "sem provedor de IA configurado" | Ollama ausente/parado ou sem `ai_provider` na config | instale o Ollama, `ollama pull qwen2.5-coder:7b`, re-rode o install.sh (ou edite `~/.nomos-browser/app/nomos-browser.config.json`) |
| "já existe um nomos-browser vivo" | instância única por diretório de runtime | `nomos-browser stop` antes de subir outra |
| Aprovação sumiu antes de eu decidir | o prazo da ação (30 s) nega por padrão | a Gi propõe de novo; decida no card seguinte |
