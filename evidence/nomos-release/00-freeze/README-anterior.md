# NOMOS Browser Runtime + NOMOS Web

Infraestrutura universal de navegação para agentes de IA. O navegador vira um
**recurso da plataforma**, não um brinquedo acoplado a um modelo específico.

```
NOMOS · Claude · Gemini · Qwen · Ollama · agente próprio
                     │
        MCP  ·  REST v1  ·  WebSocket  ·  SDK  ·  CLI
                     │
           NOMOS BROWSER RUNTIME
                     │
       Playwright · CDP · driver nativo
                     │
                  Chromium
```

O ponto que define o produto: **o estado da navegação pertence ao Runtime, não ao
modelo**. O agente desconecta, morre, ou é trocado por outro de outro fornecedor —
a sessão continua viva, com as mesmas abas, cookies e task.

## Estado atual — honesto

Medido em **2026-08-25**, HEAD `78491cc`.

```
run-suite.sh   TS_PASS=696  TS_FAIL=0  ARQUIVOS_OK=33  ARQUIVOS_RUINS=0
sdk-python     Ran 31 tests ... OK
```

Medido contra o HEAD **commitado**; trabalho não commitado de outra frente na
árvore no momento não entra na contagem.
Evidência da medição: `evidence/nomos-browser-final-loop/18-docs/resumo.tsv`
e `evidence/nomos-browser-final-loop/18-docs/sdk-python.out`. Números anteriores desta seção e do `EVIDENCIA.md`
("269 testes", "238 pass", "552") eram de execuções antigas e foram substituídos.

| Área | Situação | Evidência |
|---|---|---|
| Núcleo do navegador (Chromium/CDP, DOM, AX, mouse, teclado) | **PASS** | erro de coordenada **0,000 px**, `isTrusted=true`; `tests/pointer-keyboard.test.ts`, `tests/e2e-gate.test.ts` |
| Clique com **prova de entrega** | **PASS** | sem prova, devolve `TARGET_NOT_ACTIONABLE`/`CLICK_NOT_DELIVERED` — nunca sucesso otimista; `tests/click-entrega.test.ts` (21) |
| Procedência anti-injeção **no caminho de execução** | **PASS** | `observe`/`extract` devolvem `provenance`; 8/8 ataques classificados alta, 6/6 páginas legítimas com o cru preservado; `tests/injection-wired.test.ts` (16) |
| Auditoria forense (19 campos, negações, handoff, ator) | **PASS** | `AUDIT_COMPLETE=PASS` pelo script *intocado* da validação; `docs/AUDIT.md` |
| Segurança do control plane (REST, WebSocket, MCP) | **PASS** | 53/53 vetores, `OPEN_SECURITY_P1=0`; `evidence/nomos-browser-final-loop/11-security/out/bateria-completa.json` |
| Ownership com lease obrigatório | **PASS** | `allow_unleased` agora `false`; `tests/ownership.test.ts`, `tests/lease.test.ts` (37) |
| Task engine persistente (checkpoint, retry, resume, idempotência) | **PASS** | `SIGKILL` no meio de 12 passos: retoma em 6/12, termina 12/12, **zero** passos repetidos; `docs/TASK-ENGINE.md` |
| Providers de IA e visão **ligados ao runtime** | **PASS** | cascata chega ao degrau `vision`; erro medido **4,1 px** em alvo 160x100 |
| Replay com selo de integridade | **PASS, com resíduo** | detecta adulteração/reordenação/truncamento; **o selo é hash sem chave** |
| Watchdog e supervisão (launchd) | **PASS** | 11/11 passos contra o launchd real; **reboot real não testado** |
| Integração NOMOS — **transporte** | **PASS** | `NOMOS_TRANSPORT_E2E=PASS`, 18/18 casos contra daemon e Chromium reais |
| Integração NOMOS — **registro no catálogo** | **BLOQUEADO_POR_APROVACAO** | `nomos mcp confiar` é **ato do dono**; o pedido expirou por TTL sem resposta |
| NOMOS Web (UI, cursor, takeover) | **PASS parcial** | renderiza e espelha, servida pelo próprio daemon; marca sai `PROPOSTA` |
| Licença | **não escolhida** | `LICENSE` = todos os direitos reservados; escolher é ato do dono |

O que **não** está provado continua listado, com nome e motivo, em
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) e na seção "Ainda NÃO provado" de
[`docs/EVIDENCIA.md`](docs/EVIDENCIA.md). Nada aqui é declarado PASS sem
evidência executável.

**Uma capacidade que depende de assinatura do dono não é uma capacidade pronta.**
É o caso da integração NOMOS: o transporte está provado, o registro não é código
— é consentimento, e ele não veio.

## Requisitos

- Node ≥ 22.6 (usa TypeScript nativo — **não há passo de build**)
- Python ≥ 3.11 (apenas para o SDK Python)
- macOS ou Linux (a supervisão via `scripts/service.sh` é **launchd**, ou seja, só macOS)

## Começar

```bash
npm ci --include=dev
npx playwright install chromium
```

`--include=dev` não é decoração: nesta máquina `NODE_ENV=production` e
`npm config omit=dev` fazem `npm ci` **pular as devDependencies**, e o typecheck
falha depois com "This is not the tsc command you are looking for". Detalhes em
[`docs/INSTALLATION.md`](docs/INSTALLATION.md).

Provar que o controle do navegador é real:

```bash
node spike/fase1_spike.ts        # 25/25
```

Rodar a suíte — use o executor, não `node --test tests/` direto:

```bash
bash scripts/run-suite.sh --out /tmp/suite
```

O runner do Node paraleliza por CPU; sob pressão de memória o processo morre no
meio e deixa saída truncada **sem linha de sumário**, que parece sucesso. O
`run-suite.sh` roda um arquivo por vez e um arquivo morto aparece como `MORTO`.

Subir o daemon (`127.0.0.1:7777`):

```bash
node packages/api/src/daemon.ts
```

Como serviço supervisionado (macOS):

```bash
bash scripts/service.sh install && bash scripts/service.sh start
bash scripts/service.sh health
```

Ver a NOMOS Web:

```bash
node packages/ui/serve.ts
```

## Provas, não alegações

O projeto se recusa a chamar de PASS o que não foi observado. Dois exemplos do
que isso significa na prática:

**O controle do navegador é real.** Um clique sintetizado por JavaScript chega à
página com `isTrusted=false`; um clique despachado por CDP chega com `true`. O
spike testa os dois — o segundo prova o controle, o primeiro prova que o teste
não é vácuo. Sem esse controle negativo, "controlamos o Chromium" seria uma
frase.

**O screenshot corresponde ao DOM.** O runtime traz um decodificador PNG próprio
para conferir que o pixel no centro do retângulo do elemento tem a cor daquele
elemento — mais um controle negativo provando que um pixel fora dele tem cor
diferente. Sem isso, a camada de visão operaria sobre um mapa não verificado.

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [INSTALLATION.md](docs/INSTALLATION.md) | Requisitos, instalação, serviço, verificação |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Grupos de configuração e as chaves sem as quais a funcionalidade não existe |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Sintoma → causa → verificação → correção |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Camadas, módulos e o porquê de cada decisão |
| [API.md](docs/API.md) | Tabela de rotas normativa da API v1 |
| [TASK-ENGINE.md](docs/TASK-ENGINE.md) | Estados, checkpoint, idempotência, retry, cancel, resume |
| [RECOVERY.md](docs/RECOVERY.md) | O que sobrevive ao quê — e o que não sobrevive |
| [AUDIT.md](docs/AUDIT.md) | Schema de 19 campos, redação, como ler e verificar |
| [SECURITY.md](docs/SECURITY.md) | Modelo de ameaça T1–T10, com resíduos declarados |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | Limites **medidos**, com números |
| [EVIDENCIA.md](docs/EVIDENCIA.md) | Registro de evidência (OBSERVADO / MEDIDO / REPRODUZIDO) |
| [RASTREABILIDADE.md](docs/RASTREABILIDADE.md) | Matriz requisito → artefato → teste → status |
| [NOMOS-INTEGRATION.md](docs/NOMOS-INTEGRATION.md) | Manifesto MCP, níveis de risco e o registro pendente |
| [GI-INTEGRATION.md](docs/GI-INTEGRATION.md) | Binding da Gi pelo caminho canônico do NOMOS |
| [VISION-PROVIDER.md](docs/VISION-PROVIDER.md) | Escolha e medição do provider de visão |
| [DECISAO-DRIVER-NATIVO.md](docs/DECISAO-DRIVER-NATIVO.md) | Por que não há driver nativo |
| [BRAND.md](docs/BRAND.md) | Portão de marca da NOMOS Web |
| [RELEASE.md](docs/RELEASE.md) | Como se faz uma versão |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog — nada lançado ainda |

## Marca

A NOMOS Web sai marcada **PROPOSTA**: a marca NOMOS está vigente na v1.0 porém
sem documento de congelamento, então `brand-resolve --require-official` devolve
`rc=1` (fail-closed). Congelar é ato do dono, nunca do agente. Os tokens são
lidos do cofre a cada build e **não** são versionados neste repositório.

## Licença

**Não escolhida.** [`LICENSE`](LICENSE) declara *todos os direitos reservados* —
que é o estado legal padrão de uma obra sem licença, não uma decisão nova.
Nenhuma permissão é concedida a terceiros.

Adotar uma licença aberta (MIT, Apache-2.0, AGPL-3.0…) é **ato do dono**: o
arquivo explica o efeito de cada opção e os passos exatos para trocar. O titular
declarado no `LICENSE` hoje é um **placeholder** derivado da identidade do commit
HEAD, e está marcado como tal.
