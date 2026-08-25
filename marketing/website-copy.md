# Copy do site — `voltolini.space/browser/`

Texto pronto para a página. **Atenção às regras do `check.py` do site:**

- **nenhum travessão (`—`) em texto público** — o build reprova;
- toda `<img>` precisa de `alt` não vazio e de `width`/`height` batendo com o
  arquivo real dentro de 1% de proporção;
- nada carregado de fora (sem CDN, sem fonte externa).

O `check.py` hoje só inspeciona `index.html` e `404.html`. Isso não é licença
para escrever pior nas outras páginas; é motivo para revisar à mão.

---

## Hero

**Eyebrow:** `NOMOS · Browser`

**H1:**
> O navegador do seu agente, com você na sala.

**Lead:**
> Dar um navegador a um agente de IA é dar a ele o poder de comprar, enviar e
> apagar no seu nome. O NOMOS Browser separa o que você já autorizou do que
> precisa do seu consentimento agora.

**CTAs:** `Documentação` (primário) · `GitHub` (secundário, só quando existir)

## Proposta de valor

> Confiança cega significa descobrir depois. Perguntar tudo significa aprender a
> clicar "sim" sem ler. O NOMOS Browser faz a separação que resolve os dois: o
> agente age sozinho no que já é seguro, e para quando importa.

## Bullets de evidência

- `✓` Modo automático que **não** é bypass. Ações irreversíveis continuam pedindo
  aprovação, por construção do código e não por promessa.
- `✓` Aprovar um objetivo não é cheque em branco: cada passo do plano volta a
  pedir permissão.
- `✓` Aprovação de uso único, amarrada à ação, à sessão e aos argumentos exatos.
- `✓` Segredos não aparecem na tela, na trilha nem no replay.
- `✓` 789 testes automatizados e 106 casos ponta a ponta com Chromium real.
- `✓` Sala limpa reproduzida a partir de clone novo do repositório.

## Live Agent Console

> **Você vê o agente trabalhar.**
>
> A página espelhada, o cursor do agente com o que ele está fazendo agora, o
> estado da sessão e o histórico de cada ação.
>
> Quatro controles que funcionam no servidor, não na tela: pausar, cancelar a
> ação, assumir o controle, parar. Se a tela cair no meio de uma parada de
> emergência, o servidor termina a interrupção sozinho.
>
> Pausado, o agente não age. Mas você continua vendo a página, porque é olhando
> que se decide se vale retomar.

## ASK e AUTO

**ASK**
> O agente lê à vontade. Antes de cada ação que muda alguma coisa, ele para e
> pergunta, dizendo o que vai fazer e qual a consequência. Ler nunca pergunta.

**AUTO**
> O agente executa sozinho o que sua política já permite. Continuam pedindo
> aprovação: o que envia dado para fora, o que mexe em dinheiro, o que não tem
> volta.
>
> E se a conexão cair, a tela nunca volta dizendo "automático" sem poder provar.
> Ela mostra estado desconhecido e trata como perguntar.

## Arquitetura

```
seu agente  ·  MCP · REST · WebSocket · SDK · CLI
                        │
              NOMOS BROWSER RUNTIME
      política · autonomia · aprovação · auditoria
                        │
                 Playwright · CDP
                        │
                     Chromium
```

> A ordem é a garantia. Quando o portão de autonomia executa, tudo que sua
> política nega já foi recusado.

## Segurança

> Escopos declarados em toda rota. Quem age não pode autorizar: o perfil de
> agente não alcança aprovar nem delegar autonomia. Parar, sim: interromper nunca
> pode ser mais difícil do que agir.
>
> O modelo de ameaça é publicado com os resíduos declarados. O produto não diz
> "100% seguro", porque nenhuma medida sustenta isso.

## Integrações

> Parte do ecossistema NOMOS: o navegador entra como capacidade governada pela
> política do dono. 16 ferramentas MCP, sem acoplamento a modelo. Integrado
> também à Gi, o assistente de voz, com cancelamento por interrupção de fala.

## Demos

> Seis roteiros reproduzíveis, do controle básico ao replay auditado, executados
> contra um Chromium real a cada validação.
>
> `node demos/rodar-demos.mjs`

## Status

> **0.3.0-rc.1 · release candidate.** Software proprietário; o código não está
> licenciado para uso de terceiros.
>
> Validado em macOS com Apple Silicon. Outras plataformas ainda não foram
> medidas, e por isso não são anunciadas.

## Rodapé

> Parte do ecossistema NOMOS · voltolini.space

---

## Verificação de coerência com o site atual

A página `/nomos/` lista hoje, na coluna **Experimental**:

> `Navegador via Playwright, opt-in, testes não assinados.`

Publicar `/browser/` sem tocar nessa linha deixaria o site se contradizendo. Duas
saídas honestas:

1. atualizar a linha para apontar ao produto, mantendo o rótulo experimental
   (o browser é RC, não estável);
2. ou mover o item de Experimental para uma linha de integração que aponte para
   `/browser/`.

Recomendada: **(1)**, com texto
`Navegador governado: NOMOS Browser 0.3.0-rc.1, com console e modos de autonomia`
e link. Mantém o rótulo honesto e resolve a contradição.
