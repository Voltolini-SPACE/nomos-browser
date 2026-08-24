# VisionProvider — escolha do modelo e evidência

A FASE 5 do PRODUCT-02 é explícita: *"Não aceitar mock do provider como prova
final."* Então a primeira pergunta não foi como construir a camada de visão, e sim
**se existe nesta máquina um modelo capaz de localizar um elemento de UI com
precisão suficiente para clicar nele**. Construir a pilha antes de responder isso
seria construir sobre premissa não verificada.

## Método

Página de fixture conhecida, viewport `1280x800`, `deviceScaleFactor=1`. As
posições verdadeiras vêm do `getBoundingClientRect()` do DOM — o modelo nunca as
vê. Compara-se o centro da caixa devolvida pelo modelo com o centro real, e
pergunta-se a única coisa que importa na prática: **o clique cairia dentro do
alvo?**

Alvos:

| Alvo | Retângulo real |
|---|---|
| `#login-btn` (botão "Entrar") | `x=24, y=68, w=95.6, h=46` |
| `#target-block` (bloco sólido) | `x=400, y=120, w=160, h=100` |

## Resultado — `moondream:1.8b` (1,74 GB): **REFUTADO**

| Pedido | Resposta |
|---|---|
| "Describe what you see" | Alucinou: descreveu "documento com fundo vermelho", "Dios de contar" — nada disso existe na página |
| bounding box do botão | **string vazia** |
| `point:` no retângulo | **string vazia** |

Não produz coordenada. Não serve como VisionProvider. Escolhido inicialmente por
ser o menor modelo com fama de fazer *pointing*; a fama não sobreviveu ao teste.

## Resultado — `qwen2.5vl:3b` (3,2 GB): **VIÁVEL**

| Alvo | bbox do modelo | Centro modelo | Centro real | Erro | Clicaria no alvo |
|---|---|---|---|---|---|
| botão "Entrar" | `[26, 74, 119, 116]` | (72, 95) | (72, 91) | **4,1 px** | **sim** |
| bloco sólido | `[404, 124, 562, 224]` | (483, 174) | (480, 170) | **5,0 px** | **sim** |

Latência ~1 s com o modelo já residente (14,5 s na primeira chamada, que é o
carregamento). Para um alvo **inexistente** ("Comprar agora") devolveu
`{"bbox_2d": null}` — recusou inventar coordenada, que é o comportamento
necessário para a FASE 4.

## Um instrumento que mentiu no meio do caminho

A primeira medição acusou erro de **521 px** no bloco e concluiu que o modelo
errava feio. Era o meu parser: um `re.findall(r'-?\d+\.?\d*', resposta)` capturava
o `2` de `bbox_2d` como primeira coordenada, deslocando todas as outras.

O modelo estava certo o tempo inteiro. A lição fica no código: o parser de bbox lê
a **chave** do JSON, nunca números soltos do texto — e é por isso que
`packages/core/src/vision.ts` faz parsing defensivo em vez de regex sobre texto
livre.

## Decisão

`qwen2.5vl:3b` via Ollama é o provider real de referência. `moondream:1.8b`
permanece instalado apenas como contraexemplo documentado.

O `VisionProvider` é uma interface: o modelo é configurável e o Browser Core não
conhece nem o fornecedor nem o formato de saída dele. Trocar de modelo é
configuração, não refatoração.

## Restrição operacional desta máquina

M2 de 16 GB com swap perto do teto. Modelo de visão e modelo de texto **não** são
carregados ao mesmo tempo, e todo uso termina com `keep_alive: 0` para devolver a
memória. Benchmark de visão roda em série com o resto da suíte, nunca em paralelo.
