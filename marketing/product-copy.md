# Copy canônica — NOMOS Browser

Fonte única para site, GitHub, apresentação e anúncio. Toda linha aqui deriva de
[`../PRODUCT_TRUTH_MATRIX.md`](../PRODUCT_TRUTH_MATRIX.md).

**Regra:** se a matriz diz `PROVEN`, a copy pode dizer *"faz"*. Se diz
`MEASURED`, a copy diz *"medimos"*, com o `n`. Se diz `NOT PROVEN` ou
`NOT IMPLEMENTED`, a copy **não fala do assunto** como benefício.

---

## One-liner

> O navegador do seu agente, com você na sala.

**Alternativa técnica:**

> Infraestrutura de navegação governada para agentes de IA.

## Elevator pitch

> Dar a um agente de IA um navegador é dar a ele o poder de comprar, enviar e
> apagar em seu nome. O NOMOS Browser separa o que você já autorizou do que
> precisa do seu consentimento agora.
>
> No modo automático, o agente executa sozinho aquilo que sua política já
> permite. Ações que enviam dados para fora, mexem em dinheiro ou não têm volta
> continuam pedindo aprovação, sempre. E você acompanha tudo numa tela onde pode
> pausar, assumir o controle ou parar.

## Descrição comercial

**O problema.** Um agente com navegador age no seu nome. As duas saídas comuns
são ruins: confiança cega, onde ele age e você descobre depois; ou paralisia,
onde ele pergunta tudo e você aprende a clicar "sim" sem ler.

**A solução.** O NOMOS Browser põe quatro portões entre o agente e a página:
política, autonomia, aprovação e trilha. A política do dono decide o que é
possível. O modo de autonomia decide o que passa direto. A aprovação cuida do
resto. A trilha registra tudo.

**O benefício.** O agente trabalha sozinho no que já é seguro, você é
interrompido só quando importa, e depois dá para provar o que aconteceu.

**A diferenciação.** Modo automático que não é bypass; aprovação de tarefa que
não vira cheque em branco; e um produto que se recusa a afirmar o que não mediu.

## Capacidades

Somente o que a matriz marca `PROVEN`:

- **Controle de Chromium real** por Playwright e CDP, com prova de entrega do
  clique — sem prova, o produto devolve erro em vez de sucesso otimista.
- **23 verbos** de navegação, servidos por MCP (16 ferramentas), REST v1,
  WebSocket, SDK e CLI.
- **Dois modos de autonomia**, `ASK` e `AUTO`, por sessão.
- **Aprovação amarrada** à ação, à sessão e aos argumentos exatos, de uso único,
  com prazo e auditada.
- **Segredos mascarados** na tela de aprovação, na trilha e no replay.
- **Live Agent Console**: espelho da página, cursor do agente, estado, feed,
  centro de aprovação e histórico.
- **Controle humano**: assumir o volante congela o agente; devolvê-lo obriga a
  reobservar antes de agir.
- **Trilha encadeada por hash**, selo ao encerrar e replay somente leitura.
- **Recuperação** de sessão após queda do navegador.
- **Task engine** persistente, com checkpoint e retomada idempotente.

## Modo ASK

> **Você acompanha, e decide o que importa.**
>
> O agente lê a página livremente. Antes de cada ação que muda alguma coisa, ele
> para e pergunta, dizendo o que vai fazer, onde, e qual a consequência.
>
> Ler nunca pergunta. Perguntar para ler é ruído, e ruído ensina você a aprovar
> sem prestar atenção.
>
> Se você entregar um objetivo inteiro ao agente, aprovar o objetivo **não**
> autoriza tudo o que ele decidir fazer: cada passo do plano volta a pedir
> permissão.

## Modo AUTO

> **Ele age sozinho no que você já autorizou.**
>
> "Agir sem perguntar" significa: execute tudo o que minha política já permite.
> Nunca significa: ignore as proteções.
>
> Continuam pedindo aprovação, mesmo em automático: ações que enviam dados para
> fora, que mexem em dinheiro, que não têm volta, e qualquer rota sem perfil de
> risco declarado.
>
> E se a conexão cair, a tela nunca volta dizendo "automático" sem poder provar:
> ela mostra estado desconhecido e trata como perguntar.

## Live Agent Console

> **Você vê o agente trabalhar.**
>
> A página espelhada, o cursor do agente com o que ele está fazendo, o estado da
> sessão, o histórico de cada ação com nível e duração.
>
> E quatro controles que funcionam de verdade, no servidor: pausar, cancelar a
> ação, assumir o controle e parar. Se a tela cair no meio de uma parada de
> emergência, o servidor termina a interrupção sozinho.
>
> Pausado, o agente não age — mas você continua vendo a página, porque é
> olhando que se decide se vale retomar.

## Segurança

> - **Escopos declarados** em toda rota. Quem age não pode autorizar: o perfil de
>   agente não alcança aprovar, delegar autonomia nem retomar depois de uma
>   pausa. Parar, sim: interromper nunca pode ser mais difícil do que agir.
> - **Política fail-closed** por capability, vinda do NOMOS.
> - **Segredos** não aparecem na tela de aprovação, na trilha nem no replay. O
>   texto digitado é mostrado como `[oculto: 24 caractere(s), C…Z]`: o bastante
>   para você reconhecer, nunca o bastante para vazar.
> - **Replay somente leitura**, garantido pela tabela de rotas e não por um botão
>   escondido.
> - **Conteúdo de página é dado, não instrução.** Uma página que manda o agente
>   ignorar suas ordens é conteúdo classificado, não uma ordem.
>
> O que o produto **não** afirma: não existe "100% seguro" aqui. O modelo de
> ameaça é publicado com os resíduos declarados, incluindo que o selo do replay é
> hash sem chave.

## Números que podem ser usados

| número | onde vale | ressalva obrigatória |
|---|---|---|
| 789 testes, 37 arquivos | qualquer lugar | é a suíte TypeScript |
| 106 casos E2E em 9 baterias | qualquer lugar | Chromium real |
| 148 testes verdes na integração com a Gi | ao falar de ecossistema | é a suíte da Gi |
| sala limpa 14/14 a partir de clone | ao falar de reprodutibilidade | — |
| p50 de 1 ms do evento até a tela | só com `n=62` junto | **e com a nota do polling de 700 ms da faixa** |

**Proibido:** citar qualquer `p99`. Não existe amostra que o sustente.

## Chamadas para ação

- **Primária:** `Ver a documentação`
- **Secundária:** `Ver no GitHub` *(quando houver repositório publicado)*
- **Terciária:** `Rodar as demos` → `node demos/rodar-demos.mjs`

## O que não prometer

- Datas de roadmap.
- Suporte a plataformas não medidas (só macOS/Apple Silicon foi validado).
- Que a licença cobre a **marca**. MIT cobre o código; "NOMOS" e "NOMOS
  Browser" são governados à parte.
- Qualquer coisa da seção "Não implementado" da matriz de verdade.
