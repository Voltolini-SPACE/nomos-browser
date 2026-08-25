# GitHub — descrição, topics e apresentação

Pronto para colar quando o repositório for publicado. **A publicação depende de
duas decisões do dono** (licença e titular de direitos autorais) — ver
[`../PRODUCT_MANIFEST.md`](../PRODUCT_MANIFEST.md) §12.

---

## Nome do repositório

`nomos-browser`

## Descrição (About) — 350 caracteres

> Infraestrutura de navegação governada para agentes de IA. Modo ASK e AUTO, com
> aprovação amarrada à ação, console ao vivo, trilha auditável e replay somente
> leitura. AUTO nunca remove uma aprovação obrigatória.

Versão curta, se o limite apertar:

> Navegação governada para agentes de IA. ASK/AUTO, aprovação amarrada, console
> ao vivo e replay auditável.

## Website

`https://voltolini.space/browser/`

## Topics

```
ai-agents  browser-automation  playwright  mcp  model-context-protocol
governance  human-in-the-loop  audit-trail  approval-workflow  chromium
typescript  nodejs  autonomy  security
```

`human-in-the-loop`, `governance` e `approval-workflow` são os que diferenciam:
`browser-automation` sozinho colocaria o produto na prateleira errada, ao lado de
scrapers.

## Seções do repositório

| item | estado |
|---|---|
| README | pronto — nível produto, 20 seções |
| LICENSE | **presente, proprietário**; titular é placeholder |
| CHANGELOG.md | pronto, formato Keep a Changelog |
| ROADMAP.md | pronto |
| SECURITY.md | `docs/SECURITY.md` — considerar cópia na raiz para o GitHub reconhecer |
| CONTRIBUTING.md | **não aplicável enquanto a licença for proprietária** |
| Issue templates | adiar até haver público |
| Social preview | gerar do cofre de marca no momento da publicação (ver abaixo) |

## Sobre CONTRIBUTING.md

Não faz sentido convidar contribuição para um repositório cuja licença não
concede permissão de uso, cópia ou modificação. Escrever um CONTRIBUTING agora
seria convidar alguém a enviar código que ele não teria direito de derivar.

Quando a licença for decidida, este é o gatilho para criar o arquivo.

## Social preview e ícones

O contrato de governança de marca proíbe copiar token de marca para arquivo
intermediário ou versionar cor no repositório. Então:

- os ativos visuais são **gerados a partir do cofre no momento da publicação**,
  como já acontece com a interface (`node packages/ui/build.ts`);
- nada de `logo.svg` com hexadecimal dentro entra no git;
- ver [`../docs/BRAND.md`](../docs/BRAND.md).

## Primeiro release

Título: `v0.3.0-rc.1 — Live Agent Console e modos de autonomia`

Corpo: as notas de release derivam do `CHANGELOG.md`, seção `[0.3.0-rc.1]`.
Marcar como **pre-release** — é um RC, e chamá-lo de estável antes da promoção
seria o tipo de coisa que este projeto passou a missão inteira evitando.

## Aviso para quem chegar pelo GitHub

Colocar em destaque, porque um visitante presume open source por padrão:

> Este software é **proprietário**. O `LICENSE` não concede nenhuma permissão a
> terceiros. O código está visível; o uso não está licenciado.
