# Post de lançamento

Três formatos. Todos derivam de
[`../PRODUCT_TRUTH_MATRIX.md`](../PRODUCT_TRUTH_MATRIX.md); nenhum número
aparece sem o que ele mede.

---

## LinkedIn — versão longa

> **Dar um navegador a um agente de IA é dar a ele o poder de comprar, enviar e
> apagar no seu nome.**
>
> Passei as últimas semanas construindo o NOMOS Browser em cima de uma pergunta
> incômoda: como deixar um agente trabalhar sozinho sem entregar um cheque em
> branco?
>
> As duas respostas comuns não servem. Confiança cega significa descobrir depois.
> Perguntar tudo significa treinar o dono a clicar "sim" sem ler, e uma aprovação
> que virou reflexo não protege ninguém.
>
> A saída foi separar duas coisas que costumam ser tratadas como uma só: **o que
> você já autorizou** e **o que precisa do seu consentimento agora**.
>
> São dois modos. Em ASK, o agente lê à vontade e para antes de cada ação que
> muda alguma coisa. Em AUTO, ele executa sozinho o que sua política já permite.
>
> E aqui está a parte que mais me custou provar: **AUTO não é bypass**. Ações que
> enviam dado para fora, mexem em dinheiro ou não têm volta continuam pedindo
> aprovação, sempre. Não porque a documentação promete — porque o código não tem
> um caminho que faça o contrário. O portão de autonomia roda depois do de
> política: quando ele executa, tudo que sua política nega já morreu com 403.
>
> Testei isso do jeito que dá para acreditar: quebrando de propósito. Rebaixando
> a regra no código, o teste cai. Dando ao executor de tarefas um atalho
> privilegiado, o teste cai. Um teste que não sabe falhar não sabe nada.
>
> Foi assim que encontrei o defeito que mais me assustou. A amarra que liga uma
> aprovação aos argumentos exatos usava `JSON.stringify(args, chaves.sort())`. O
> segundo parâmetro do `JSON.stringify` não ordena: ele **filtra**, e descarta
> tudo que está aninhado. Resultado: clicar em "Cancelar" e clicar em "Confirmar
> compra" produziam a mesma assinatura. Uma aprovação teria autorizado a outra.
>
> Estado atual: 789 testes, 106 casos ponta a ponta com Chromium de verdade, sala
> limpa reproduzida a partir de clone novo.
>
> E uma coisa que o produto **não** diz: nenhum p99. Trinta amostras não
> sustentam um p99, então o instrumento devolve nulo e explica por quê. Num
> mercado onde todo mundo publica número redondo, achei que valia mais publicar o
> que dá para provar.
>
> `voltolini.space/browser`

## LinkedIn — versão curta

> Construí um navegador para agentes de IA que não entrega cheque em branco.
>
> Dois modos: em ASK o agente pergunta antes de cada ação que muda algo; em AUTO
> ele age sozinho no que você já autorizou.
>
> A parte difícil foi provar que AUTO **não** é bypass. Ações irreversíveis
> continuam pedindo aprovação, e isso não é promessa de documentação: é a ordem
> dos portões no código. Rebaixando a regra de propósito, o teste cai.
>
> 789 testes, 106 casos com Chromium real, sala limpa a partir de clone novo. E
> nenhum p99 publicado, porque 30 amostras não sustentam um.
>
> `voltolini.space/browser`

## Anúncio interno

> **NOMOS Browser 0.3.0 — Live Agent Console e modos de autonomia**
>
> O que entra:
>
> - **Live Agent Console** — espelho da página, cursor do agente, estado, feed,
>   centro de aprovação e histórico somente leitura.
> - **ASK / AUTO por sessão**, opt-in. Sessão sem modo declarado mantém o
>   comportamento anterior.
> - **Aprovação** de uso único, amarrada à ação, à sessão e aos argumentos.
> - **Controles reais**: pausar, cancelar, assumir o volante, parar. A parada de
>   emergência termina no backend mesmo se a tela cair.
>
> Defeitos de produto corrigidos nesta versão (seis, todos com teste e mutação):
> senha em claro na tela de aprovação; amarra de argumentos que perdia chaves
> aninhadas; replay de sessão inexistente devolvendo 200 vazio; navegador morto
> reportado como erro de seletor; fechamento que nunca escrevia `result.json`;
> leitura de replay quebrando o próprio selo.
>
> Limitações declaradas: sem p99, sem rota HTTP para emitir token com escopo,
> validado só em macOS/Apple Silicon.
>
> **Bloqueado para publicação pública:** licença e titular de direitos autorais
> ainda não decididos, e o repositório não tem remoto.
>
> Rodar as demos: `node demos/rodar-demos.mjs`
