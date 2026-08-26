# Chrome Web Store — material preparado (NÃO publicado)

Publicar é ato do dono. Este diretório deixa tudo pronto:
`CHROME_WEB_STORE_READY` = material completo, publicação pendente por decisão.

## Nome

NOMOS Browser

## Resumo curto (132 chars máx.)

Painel do NOMOS: converse com a Gi, veja o agente navegar, aprove o que exige
consentimento, interrompa e audite.

## Descrição

O NOMOS Browser é infraestrutura de navegação governada para agentes de IA: o
agente navega, o dono vê, autoriza e interrompe. Esta extensão coloca essa
experiência ao lado da página, no side panel do Chrome:

- converse com a Gi/NOMOS e acompanhe o agente trabalhando em tempo real;
- ASK/AUTO: escolha entre aprovar cada ação ou deixar executar o que você já
  autorizou — o modo automático nunca remove uma aprovação obrigatória;
- aprovação amarrada à ação exata (single-use, com nível de risco e política);
- pare, pause ou assuma o controle a qualquer momento;
- auditoria e replay somente leitura da sessão.

Requer o NOMOS Browser Runtime rodando na sua máquina (grátis, MIT):
https://github.com/Voltolini-SPACE/nomos-browser

## Justificativa de permissões (formulário da CWS)

| permissão | justificativa |
|---|---|
| `sidePanel` | A extensão É um painel lateral. |
| `storage` | Guardar URL e token do runtime local pela duração da sessão do navegador (`storage.session`). |
| `http://127.0.0.1/*`, `http://localhost/*` | Falar com o runtime NOMOS que roda na máquina do usuário. A extensão não acessa nenhum site: não há content scripts nem permissões de host além do loopback. |

## Divulgação de privacidade (formulário da CWS)

- A extensão não coleta, não transmite e não vende dados de usuário.
- Todo tráfego é local (127.0.0.1) entre o painel e o runtime do próprio usuário.
- Nenhum dado sai da máquina; não há analytics, não há servidores nossos.
- O token de acesso ao runtime fica em `chrome.storage.session` e morre quando
  o navegador fecha.

## Ícones

Gerados no build a partir do cofre de marca (`packages/extension/build.ts`):
16/48/128 px. Para a CWS falta o de 440×280 (promo pequeno) — gerar com o
mesmo `pngSolido` no dia da publicação.

## Screenshots

Reais, capturados do painel funcionando: `evidence/embedded-agent-ux/screenshots/`.
A CWS pede 1280×800 ou 640×400 — recortar dos reais, nunca montar mock.

## Pendências para o dia da publicação (checklist do dono)

1. Conta de desenvolvedor CWS (taxa única de US$ 5).
2. Zip de `packages/extension/dist` (buildado do cofre no dia).
3. Promo 440×280.
4. Decidir visibilidade (unlisted primeiro é o caminho prudente).
