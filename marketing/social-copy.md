# Copy para redes

Curto, sem superlativo, e nada que a
[matriz de verdade](../PRODUCT_TRUTH_MATRIX.md) não sustente.

---

## Fio (thread) — 6 posts

**1/**
> Dar um navegador a um agente de IA é dar a ele o poder de comprar, enviar e
> apagar no seu nome.
>
> Passei semanas numa pergunta: como deixar o agente trabalhar sozinho sem
> entregar um cheque em branco?

**2/**
> As duas respostas comuns não servem.
>
> Confiança cega = você descobre depois.
> Perguntar tudo = você aprende a clicar "sim" sem ler.
>
> Uma aprovação que virou reflexo não protege ninguém.

**3/**
> A saída foi separar duas coisas: o que você JÁ autorizou, e o que precisa do
> seu consentimento AGORA.
>
> ASK: o agente lê à vontade, e para antes de cada ação que muda algo.
> AUTO: ele executa sozinho o que sua política já permite.

**4/**
> A parte que mais me custou provar: AUTO **não** é bypass.
>
> Ações que enviam dado para fora, mexem em dinheiro ou não têm volta continuam
> pedindo aprovação. Sempre.
>
> Não porque a doc promete. Porque o código não tem um caminho que faça o
> contrário.

**5/**
> Testei quebrando de propósito.
>
> Rebaixo a regra no código → o teste cai.
> Dou um atalho privilegiado ao executor de tarefas → o teste cai.
>
> Um teste que não sabe falhar não sabe nada.

**6/**
> Foi assim que achei o pior defeito.
>
> A amarra entre uma aprovação e seus argumentos usava
> `JSON.stringify(args, chaves.sort())`.
>
> O 2º parâmetro não ordena. Ele **filtra**, e descarta o que está aninhado.
>
> "Cancelar" e "Confirmar compra" produziam a mesma assinatura.

---

## Post único

> Construí um navegador para agentes de IA que não entrega cheque em branco.
>
> Dois modos: em ASK o agente pergunta antes de cada ação que muda algo; em AUTO
> ele age sozinho no que você já autorizou. E AUTO não é bypass: o que é
> irreversível continua pedindo aprovação, por construção do código.
>
> 792 testes, 106 casos com Chromium real, sala limpa a partir de clone novo.
>
> Nenhum p99 publicado. Trinta amostras não sustentam um.

## Bio curta

> NOMOS Browser: navegação governada para agentes de IA. Você vê, autoriza e
> interrompe.

## Uma frase para apresentação

> O navegador do seu agente, com você na sala.

---

## O que não postar

- Nenhum `p99`, nenhuma latência sem o `n` junto.
- "100% seguro", "infalível", "zero risco".
- Data de roadmap.
- Sugerir que a licença cobre a marca. MIT cobre o código; "NOMOS" é governada à parte.
- Screenshot que não seja do produto real.
