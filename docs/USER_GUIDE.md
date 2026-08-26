# NOMOS Browser — guia do usuário

Para usar, você não precisa conhecer código. Precisa de um Mac (Apple Silicon
ou Intel) com Node.js ≥ 22.18 instalado — e, se quiser que a Gi planeje tarefas
sozinha, do [Ollama](https://ollama.com) com um modelo baixado.

## Instalar

1. Baixe o release em <https://github.com/Voltolini-SPACE/nomos-browser/releases>.
2. No Terminal (uma única vez):

```bash
tar -xzf nomos-browser-v*.tar.gz && cd nomos-browser-v*/
bash packaging/release/install.sh
```

Pronto: o NOMOS Browser abre sozinho e passa a iniciar no login.

## Abrir e conectar

- A janela do Chromium abre com a extensão NOMOS embarcada.
- Clique no ícone de quebra-cabeça → **NOMOS** (fixe se quiser).
- No painel: runtime `http://127.0.0.1:7777` e token — **Cmd+V** (o serviço
  copia o token para a área de transferência a cada início).
- Se aparecer "credencial expirada — reconecte": o serviço reiniciou e o token
  mudou; cole o novo (já está no clipboard).

## Conversar com a Gi

Escreva o que quer no campo do painel — ex.: *"Abra voltolini.space e clique em
browser"*. Criar uma tarefa SEMPRE pede sua aprovação (risco A5), em qualquer
modo: é você entregando um objetivo ao agente.

## ASK e AUTO

- **ASK**: a Gi pede permissão antes de cada ação que muda a página. O card
  mostra ação, alvo, risco, política e argumentos. Atenção: a aprovação expira
  com o prazo da ação (30 s) — se passar, a Gi tenta de novo e pergunta de novo.
- **AUTO**: executa sozinha o que é rebaixável. O aviso "mesmo em automático,
  ainda pergunto: …" lista o que SEMPRE exige você.

## Ver a Gi trabalhar

- **AGORA** mostra o estado (observando, navegando, aguardando aprovação…).
- Na página, o alvo ganha uma moldura e o selo **● NOMOS controlando**.
- **Abas** lista só as abas DO AGENTE. As suas não aparecem e não são tocadas.

## Pausar, parar, assumir

- **Pausar** congela o agente; a tarefa em curso fica guardada com checkpoint e
  **Retomar** continua de onde parou.
- **Parar** é freio de emergência: nega aprovações pendentes e congela tudo, no
  backend — funciona mesmo se o painel cair.
- **Assumir controle** entrega o navegador a você; o agente fica congelado até
  para observar (é a hora de digitar senha/2FA). Ao devolver, ele é obrigado a
  reobservar a página antes de agir.

## Auditoria e replay

**Audit** lista cada ação com decisão de política; **Replay** é a linha do tempo
completa, somente leitura — não existe botão que reexecute nada ali.

## Comandos do dia a dia

```bash
nomos-browser status    # está vivo?
nomos-browser start     # iniciar (ou recuperar)
nomos-browser stop      # parar tudo (daemon + navegador)
nomos-browser logs      # o que aconteceu
nomos-browser uninstall # remove o app; seus dados ficam (use --purge para tudo)
```

## Privacidade em uma linha

Tudo roda na sua máquina: runtime local, navegador local e, com Ollama, modelo
local — nada do que a Gi vê sai do seu computador. Detalhes:
[`packaging/webstore/PRIVACY.md`](../packaging/webstore/PRIVACY.md).

## Guia do desenvolvedor

Arquitetura, API, MCP e Developer Mode: [`README.md`](../README.md) e
[`docs/extension.md`](extension.md).
