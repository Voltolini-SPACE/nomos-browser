# Agente embutido — a experiência

O que muda com a extensão: o dono deixa de operar o NOMOS por uma página
separada e passa a tê-lo **ao lado da página**, no side panel do Chromium.

```
┌───────────────────────────────┐
│ ● NOMOS        sessão a3f2    │
├───────────────────────────────┤
│ Gi                            │
│  O que deseja fazer?          │
│  > Abra o portal e procure... │
├───────────────────────────────┤
│ AGORA                         │
│  navegando                    │
│  Executando browser.click     │
├───────────────────────────────┤
│ ASK      AUTO                 │
├───────────────────────────────┤
│ Abas · Perguntar sobre página │
├───────────────────────────────┤
│ Audit  Replay  Pausar         │
│ Assumir controle  Parar       │
└───────────────────────────────┘
```

## O fluxo de uma conversa

```
VOCÊ (side panel) → NOMOS API v1 → política/autonomia → TaskEngine → Chromium
                                                ↘ aprovação quando preciso
```

Você: *"Gi, encontre as transações de ontem."*
Gi: *"Entendido — vou trabalhar nisso."* — e a partir daí o que aparece no chat
são os eventos **operacionais** da task (começou, passo, concluiu, falhou).
Raciocínio privado do modelo não aparece, por projeto: transparência é sobre o
que o agente FEZ, não voyeurismo sobre o que ele pensou.

## As garantias que o painel herda (e não pode afrouxar)

| garantia | onde vive |
|---|---|
| `AUTO != BYPASS` — o modo nunca rebaixa `SEMPRE_APROVAR` | `core/autonomy.ts` (topologia, com teste) |
| Aprovação single-use, amarrada à ação, sessão e argumentos | `core/approvals.ts` |
| Replay somente leitura — a alavanca não existe no painel | teste conta `button/input/select/textarea/a[href]` = 0 |
| Takeover congela o agente até para OBSERVAR | `CONTROL_HELD_BY_HUMAN` |
| Devolver o controle exige reobservação | `REOBSERVE_REQUIRED` |
| PARAR roda inteiro no backend | rota `emergency-stop`; sobrevive à queda do painel |
| Fail-safe de modo: sem estado comprovado, a tela mostra DESCONHECIDA e trata como PERGUNTAR | `sidepanel.js` |
| A parada funciona em QUALQUER estado — inclusive RECOVERING | `ALLOWED_TRANSITIONS` (buraco achado pelo E2E do painel e fechado) |

## Highlight na página (spotlight)

Antes de clique e digitação, o runtime desenha a moldura no alvo e o selo
"● NOMOS controlando" na própria página (`spotlight`, `spotlight_dwell_ms`,
`spotlight_color`). Por que no runtime e não na extensão:

- menor privilégio: zero permissão de host em site nenhum;
- toda superfície ganha o mesmo destaque (painel, console, SDK, MCP);
- `pointer-events:none` medido em teste: o overlay não intercepta o clique nem
  a prova de entrega.

Default **desligado** (`spotlight: false`) para não alterar as latências
públicas já medidas; o lançador da experiência embutida liga com a cor do cofre.

## Abas e posse

O painel lista as abas **do agente** (sessão do runtime), com a ativa marcada.
As abas do usuário não aparecem e não são tocadas — a confusão entre "minha
aba" e "aba possuída pelo agente" é exatamente o que o desenho evita.

## O que fica para a v2 (registrado, não prometido)

- Espelho da página dentro do painel (o console já tem; no modo embutido a
  página real está do lado — o espelho é redundante).
- Seleção de elemento pelo usuário ("usar elemento selecionado").
- Bootstrap de token sem colar (handshake de primeiro uso).
- Firefox/Safari.
