# Spec para o site — experiência de agente embutido (FASE 31)

ENTREGA PARA INCORPORAÇÃO POSTERIOR. A janela paralela é dona do site; este
arquivo existe para ela não ter que reconstituir a missão. Nada em `/browser/`
foi tocado por esta missão.

## O que anunciar (tudo abaixo é verdadeiro e testado — nada de futuro)

1. **Side panel dentro do Chromium.** Chat com a Gi ao lado da página; o agente
   navega e o dono vê. `node packages/extension/launch.ts` sobe tudo.
2. **ASK/AUTO no painel**, com o aviso "mesmo em AUTO, ainda pergunto: …" vindo
   do runtime (as rotas SEMPRE_APROVAR são citadas na tela).
3. **Aprovação ao lado da página** — ação, alvo, risco, política, argumentos
   redigidos; single-use, amarrada à ação.
4. **Highlight na própria página**: moldura no alvo + selo "● NOMOS
   controlando" antes de clique/digitação (spotlight do runtime, cor do cofre).
5. **Parar · Pausar · Assumir controle** no painel — parada de emergência
   inteira no backend; sobrevive à queda do painel. Funciona em QUALQUER estado
   da sessão (o E2E achou e fechou o buraco do RECOVERING).
6. **Audit e Replay somente leitura** no painel.
7. **Menor privilégio de verdade**: sem `<all_urls>`, sem content script, host
   permission só em loopback — fixado por teste que precisa ser editado para
   ampliar qualquer coisa.

## Números honestos (medidos no E2E, Chromium real, M2)

- 17 gates E2E = PASS (`tests/extension-e2e.test.ts` imprime a tabela).
- Clique aprovado pelo painel, com spotlight ligado, entregue e verificado em
  ~300 ms de ida-e-volta no teste.
- O card de aprovação aparece em até ~800 ms (cadência de leitura do `/live`
  pelo painel) — o mesmo compromisso declarado do console (700 ms lá).

## O que NÃO anunciar (limites declarados)

- Chrome de MARCA não aceita extensão por flag: lá é instalação manual
  (modo dev) ou CWS — e a CWS está preparada (`packaging/webstore/`), não
  publicada.
- Chat conversacional pleno exige `ai_provider` configurado; sem ele o painel
  recusa com honestidade.
- Sem Firefox/Safari nesta versão.

## Assets

- Screenshots reais: `evidence/embedded-agent-ux/screenshots/` (conexão, chat,
  aprovação, AUTO com aviso, histórico). Sem mock.
- Cores/fontes: cofre NOMOS, como todo o resto do produto.
