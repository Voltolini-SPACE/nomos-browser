# Divergência do OpenKern: 95 vs 69 — resolvida por execução

O hub do voltolini.space afirmava `95 testes no baseline congelado`; a página
`/openkern/` afirmava `69 testes no baseline G0 a G7`. Ambas citavam o **mesmo**
baseline: `openkern-bootstrap-01 (commit d06dddf)`.

## Método

Clone do repositório em `/tmp`, `git checkout d06dddf`, `cargo test --workspace`.
A árvore de trabalho do dono **não foi tocada** (ela está numa branch de fix, com
trabalho não commitado).

## Resultado: o número canônico é 69

```
cargo test --workspace  @  d06dddf
  kern_types        12
  kern_fsm           5
  kern_policy        4
  kern_capability   22
  kern_repo          7
  kern_git           8
  kern_exec         11
  ────────────────────
  TOTAL_PASSED      69      0 failed
```

Bate exatamente com a decomposição do relatório congelado no próprio commit
(`docs/VALIDATION_REPORT.md`): **`TEST_COUNT = 69` (12 + 5 + 4 + 22 + 7 + 8 + 11)**
e `TEST rc=0 (69 passed)`.

A mensagem do próprio commit também diz: *"freeze: OPENKERN-BOOTSTRAP-01
validation report — G0..G7 PASS, 69 tests"*.

**A página `/openkern/` estava certa. O hub estava errado.**

## Por que o 95 existe

O 95 não foi inventado: ele é **real, em outro commit**.

```
docs/BRAND_FREEZE_v1.0.md  @  2ff6631  (tag openkern-brand-v1.0)
  CARGO_TEST : RC=0 · 95 passed · 0 failed (workspace completo)
```

O commit `8f9f7ab` — *"publish: OPENKERN-BRAND-03 documentary commit — MIT
license, public README, site publication deltas"* — levou esse número para a
copy do site.

O defeito, então, não é um número inventado: é um número **verdadeiro colado sob
o rótulo errado**. O hub anexou a contagem do *brand freeze* à etiqueta do
*bootstrap baseline*, enquanto a página do produto manteve a contagem certa para
aquela etiqueta.

## Três medições, três commits, todas verdadeiras

| commit | rótulo | testes |
|---|---|---|
| `d06dddf` (`openkern-bootstrap-01`) | baseline congelado G0..G7 | **69** |
| `2ff6631` (`openkern-brand-v1.0`) | brand freeze v1.0 | **95** |
| `0de0410` (HEAD de `fix/critical-remediation-kern-git`) | trabalho em curso | **128** |

O HEAD atual mede 128, o que mostra que nenhum dos dois números do site descreve
o estado presente do projeto. Isso é esperado num baseline **congelado**, e é
justamente por isso que o número precisa vir com o commit ao lado.

## Correção aplicada

O hub passou a citar **69**, com o commit nomeado, igual à página do produto.

Nenhum número foi escolhido por preferência: o que valia era o que o `cargo test`
devolvesse naquele commit, e ele devolveu 69.

## Verificação independente

```bash
git clone https://github.com/Voltolini-SPACE/openkern /tmp/ok && cd /tmp/ok
git checkout d06dddf && cargo test --workspace 2>&1 | grep "^test result:" \
  | awk '{s+=$4} END {print s}'
# 69
```
