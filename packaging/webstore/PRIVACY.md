# NOMOS Browser — privacidade

Vale para a extensão e para o runtime local. Escrito para corresponder ao
comportamento REAL do código — não ao contrário.

## O que a Gi vê

Somente o que o runtime observa nas abas DO AGENTE (URL, título, DOM/árvore de
acessibilidade, screenshots), pelo caminho governado A0. As suas abas pessoais
na mesma janela não são listadas nem lidas.

## O que sai da sua máquina

- **Com Ollama (default detectado): nada.** Runtime, navegador, modelo e
  auditoria são locais. A extensão fala apenas com `127.0.0.1`.
- **Com provider de nuvem configurado POR VOCÊ** (`ai_provider` na config):
  o contexto de planejamento (objetivo + resumo da observação da página) vai ao
  provider escolhido. Nenhum provider vem configurado de fábrica.
- A extensão não tem analytics, não tem telemetria, não fala com servidor nosso.

## O que fica local, e onde

- Token de controle: `~/.nomos-browser/control-token` (rotaciona a cada boot);
  no painel, `chrome.storage.session` — morre quando o navegador fecha.
- Perfis do navegador do agente (cookies/sessões): `profiles/` da instalação.
- Auditoria/replay (JSONL, com REDACTION de segredos): `sessions/`.
- Logs do serviço: `~/.nomos-browser/logs/`.
- Screenshots capturados pelo runtime: locais, dentro da sessão.

## Retenção e remoção

Nada expira sozinho — auditoria existe para ser relida. Remoção é sua:
`nomos-browser uninstall --purge` apaga app E dados (token, perfis, config,
logs). Sem `--purge`, seus dados ficam.

## Proteções ativas com teste

Segredos nunca aparecem em claro na aprovação (`[oculto: N caracteres]`);
conteúdo de página tentando sair pelo plano do modelo é retido pelo guarda de
exfiltração; texto de página nunca vira instrução com autoridade
(anti-injection selado, com suíte própria).
