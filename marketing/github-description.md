# GitHub — descrição, topics e apresentação

Licença **MIT** e titular **Voltolini-SPACE**, decididos pelo dono em
2026-08-25. Ver [`../PRODUCT_MANIFEST.md`](../PRODUCT_MANIFEST.md) §12.

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
| LICENSE | **MIT**, titular Voltolini-SPACE |
| CHANGELOG.md | pronto, formato Keep a Changelog |
| ROADMAP.md | pronto |
| SECURITY.md | `docs/SECURITY.md` — considerar cópia na raiz para o GitHub reconhecer |
| CONTRIBUTING.md | presente |
| Issue templates | adiar até haver público |
| Social preview | gerar do cofre de marca no momento da publicação (ver abaixo) |

## Sobre CONTRIBUTING.md

Com MIT, contribuir passa a fazer sentido, e o arquivo existe. Ele diz a coisa
que mais importa neste repositório: **um teste que não sabe falhar não entra**.

## Social preview e ícones

O contrato de governança de marca proíbe copiar token de marca para arquivo
intermediário ou versionar cor no repositório. Então:

- os ativos visuais são **gerados a partir do cofre no momento da publicação**,
  como já acontece com a interface (`node packages/ui/build.ts`);
- nada de `logo.svg` com hexadecimal dentro entra no git;
- ver [`../docs/BRAND.md`](../docs/BRAND.md).

## Primeiro release

Título: `v0.3.1 — Live Agent Console e modos de autonomia`

Corpo: as notas de release derivam do `CHANGELOG.md`, seção `[0.3.1]`.
Publicar como release normal, **não** pre-release. A promoção de `rc.2` a
estável foi paga com uma sala limpa a partir do remoto público, que reprovou o
`rc.2` e encontrou um defeito real na porta de entrada. As tags `v0.3.0-rc.1` e
`v0.3.0-rc.2` continuam onde estavam: uma tag publicada não se move.

## Aviso para quem chegar pelo GitHub

> **MIT**, e a licença cobre o **código**. As marcas "NOMOS" e "NOMOS Browser",
> e os tokens de identidade visual, são governados à parte e não são versionados
> aqui.
>
> `0.3.1` é **estável**, e estável não quer dizer completo. As limitações
> estão no README, não escondidas: nenhum p99 é reportado, não há rota HTTP para
> emitir token com escopo, e só macOS/Apple Silicon foi medido. Promover a
> versão não mediu nenhuma plataforma nova.
