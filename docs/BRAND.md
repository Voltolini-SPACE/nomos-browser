# Portão de marca — NOMOS Web (FASE 30/31/53)

Este documento é um **portão**, não uma fonte de marca. Ele não contém token algum,
por proibição explícita do contrato de governança (`~/.brand-governance/CONTRATO.md`,
seção 6, item 3: *"copiar token de marca para arquivo intermediário, contexto
compartilhado ou memória persistente"*).

## Estado apurado em 2026-08-24

```
~/.brand-governance/bin/brand-resolve.sh --require-official "NOMOS"   → rc=1  (fail-closed)
~/.brand-governance/bin/brand-resolve.sh "NOMOS"                       → rc=3
```

`rc=3` = marca **resolvida** (v1.0 vigente, integridade OK) porém **NÃO OFICIAL**:
a pasta vigente não tem documento de congelamento (LEI art. 6).

## Consequência operacional — vale para toda a NOMOS Web

1. **Toda peça de UI sai marcada `PROPOSTA`.** Não existe peça oficial NOMOS enquanto
   `--require-official` devolver `rc != 0`.
2. **Cada peça declara marca e versão** no próprio artefato (LEI art. 1.3).
3. **Tokens são lidos do cofre a cada build**, nunca commitados. O repositório não
   guarda cor, fonte nem grid da NOMOS. A UI é gerada por um passo que lê
   `03_OUTRAS_MARCAS/NOMOS/v1.0_VIGENTE` no momento da geração.
   Um `tokens.css` versionado neste repo seria exatamente o "arquivo intermediário"
   proibido — outras peças passariam a lê-lo *em vez de* ler o brandbook.
4. **Congelar a v1.0 é ato humano** (LEI art. 7.2). Nenhum agente promove `_VIGENTE`
   nem cria o documento de congelamento.

## Para o dono decidir

A NOMOS Web pode ser construída agora e entregue marcada `PROPOSTA`, ou o dono
congela a NOMOS v1.0 primeiro e a UI nasce oficial. As duas rotas são válidas;
a escolha é do dono, não do agente.

Enquanto não houver decisão, o build da UI **não** pode declarar nenhuma cor como
oficial (proibição 5 do contrato).
