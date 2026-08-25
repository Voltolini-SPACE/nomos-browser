# FASE 18 — medição que sustenta a documentação

Executado em `/Users/AI/Projects/nomos-browser`, HEAD `78491cc`, árvore limpa
(`git status --porcelain` só mostrava `?? evidence/`).

## Suíte TypeScript

```
início  2026-08-25 01:09:24 -03
fim     2026-08-25 01:12:05 -03   (161 s)
comando bash scripts/run-suite.sh --out /tmp/suite-doc

TS_PASS=696  TS_FAIL=0  ARQUIVOS_OK=33  ARQUIVOS_RUINS=0
```

Por arquivo: `resumo.tsv`. Saída completa: `run-suite.out`.

Zero arquivos `MORTO` — a medição não foi degradada por contenção de memória.
Memória livre reportada pelo macOS no início: 77 %.

## SDK Python

```
comando cd sdk-python && python3 -m unittest discover -s tests
Ran 31 tests in 0.642s ... OK
```

Saída: `sdk-python.out`.

## Total

**727 testes** (696 TypeScript + 31 Python), zero falhas.

## Série histórica, para que a comparação não se perca

| Quando | Total | Arquivos | Fonte |
|---|---|---|---|
| PRODUCT-01 | 269 (238 TS + 31 py) | 13 TS | `docs/EVIDENCIA.md` antes desta revisão |
| Validação final, 1ª passada | 487 TS | 22 OK + 2 MORTO | `evidence/nomos-browser-final-validation/02-core/suite-full/resumo.tsv` |
| Validação final, regressão | 552 TS | 24 | `evidence/nomos-browser-final-validation/16-regression/suite-final/resumo.tsv` |
| Loop de correção | 593 TS | 27 | `evidence/nomos-browser-final-loop/16-regressao/suite/resumo.tsv` |
| **Esta medição** | **696 TS** | **33** | `resumo.tsv` (neste diretório) |

Os 103 testes entre 593 e 696 são os arquivos que entraram com o task engine, os
providers no runtime, o ownership, o supervisor, o watchdog ligado e a cascata:
`task-engine` (19), `cascata-percepcao` (18), `providers-runtime` (14),
`ownership` (11), `supervisor` (10), `watchdog-wired` (8), mais o crescimento de
`replay-hardening` (34 → 44), `click-entrega` (13 → 21) e `mcp` (25 → 30).

## Nota sobre o escopo desta medição

Os números foram medidos contra o **HEAD commitado `78491cc`**. Durante a
execução havia trabalho não commitado de outra frente na árvore
(`packages/*/package.json`, `scripts/`, `tests/config-schema.test.ts`,
`.github/`, `docs/_gerado/`). Esse trabalho **não** entrou nesta contagem: os 33
arquivos medidos são os 33 que existiam em `tests/` no momento da execução, e
`tests/config-schema.test.ts` apareceu depois. Quando ele for commitado, a
contagem sobe e precisa ser remedida — o número desta página vale para o commit
que ele nomeia, não para sempre.
