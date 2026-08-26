# COMO ABRIR O NOMOS BROWSER AMANHÃ

```bash
cd ~/Projects/nomos-browser-embedded-ux
NOMOS_BROWSER_AI_PROVIDER=ollama:qwen2.5-coder:7b node packages/extension/launch.ts
```

1. A janela do Chromium abre sozinha (sessão "pessoal", perfil persistente).
2. Clique no ícone de quebra-cabeça → **NOMOS** (fixe se quiser) — o painel abre ao lado.
3. Conecte: runtime `http://127.0.0.1:7777` + token **Cmd+V** (o lançador já copiou).
4. Converse com a Gi. ASK/AUTO no painel. **Ctrl-C no terminal encerra tudo.**

Sem `NOMOS_BROWSER_AI_PROVIDER`, tudo funciona menos o planejamento de tasks —
e a Gi diz isso com todas as letras em vez de fingir.

Se o painel disser "credencial expirada — reconecte": o runtime reiniciou e o
token rotacionou; o novo já está na área de transferência. Cole e siga.
