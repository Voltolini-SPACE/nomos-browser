# Limitações medidas

Só entra aqui o que tem número medido ou ausência declarada. "Pode ser lento",
"talvez não funcione em X" não são limitações — são palpites, e palpite em
documento de produto é ruído.

Medições desta página: HEAD `78491cc`, máquina `PanheonAI.local` (M2, 16 GiB),
macOS 26.3.1 arm64, Node v26.0.0, Chromium 151 (playwright 1.62.1).

---

## 1. Localização visual — erro por tamanho de alvo

Bloco **VERBATIM** de
`evidence/nomos-browser-final-loop/06-cascata/out/medir-refino-aim.log`
(3 tamanhos de alvo × 3 modos de mira × 3 execuções, seed fixo, modelo
`qwen2.5vl:3b`, DPR 1, daemon real, cascata real, audit real):

```
RESUMO  (mediana das execuções; 'estável' = execuções 2 e 3 idênticas)
tamanho   aim             passes  erro_med  margem  dentro   inferencias  estavel
grande    box_center      0          4.2px    97px    3/3             1  sim
grande    point           0          4.5px    98px    3/3             1  sim
grande    point_then_box  0          4.5px    98px    3/3             1  sim
medio     box_center      0            5px    46px    3/3             1  sim
medio     point           0          4.1px    49px    3/3             1  sim
medio     point_then_box  0          4.1px    49px    3/3             1  sim
pequeno   box_center      0          5.4px    22px    3/3             1  sim
pequeno   point           0          2.8px    23px    3/3             1  sim
pequeno   point_then_box  0          2.8px    23px    3/3             1  sim
```

Onde `grande = 320x200`, `medio = 160x100`, `pequeno = 80x50`, os três com o
**mesmo centro (480,170)** — sem isso, "o pequeno errou mais" poderia ser só "o
pequeno está num lugar mais difícil da tela".

Lido em prosa, com a mira `point` (o default):

| Alvo | Erro mediano | Margem até a borda | Dentro do alvo |
|---|---|---|---|
| 320x200 | **4,5 px** | 98 px | 3/3 |
| 160x100 | **4,1 px** | 49 px | 3/3 |
| 80x50 | **2,8 px** | 23 px | 3/3 |

**Abaixo de 80 px de largura: NÃO MEDIDO.** Não há dado, portanto não há
afirmação. Quem depender de alvos menores tem de medir antes.

**O erro não escala com o tamanho do alvo** nesta faixa — o alvo pequeno errou
menos que o grande. É por isso que a hipótese do recorte foi refutada (item 2).

### Modelos

- **`moondream:1.8b` — REFUTADO**, por medição independente. Erra o alvo real e
  devolve caixa espúria com confiança **0,67** para um alvo **inexistente**.
  Abaixo do `vision_min_confidence = 0,7`, ou seja, o guarda de confiança do
  produto o barraria. O guarda existe, é correto e é necessário.
- **`qwen2.5vl:7b` — NÃO COUBE EM MEMÓRIA** nesta máquina. Não foi avaliado.
  Ausência de medição, não veredito sobre o modelo.
- **`qwen2.5vl:3b`** é o que está medido acima.

### O número não é transferível

A `docs/VISION-PROVIDER.md` mediu 4–5 px; a validação final, **com outra fixture
e outro enunciado**, mediu **41,7 px** para o mesmo modelo — ainda dentro do
alvo, mas uma ordem de grandeza maior. A conclusão prática se sustenta; **o
número não é transferível para qualquer página.**

E a precisão dependeu de **prompt**, não de modelo: o esquema
`{"box":{x,y,width,height}}` não é emitido pela Qwen2.5-VL no treino e a largura
vinha 1,8x inflada — num alvo de 160x100 o centro caía **9 px fora**. O esquema
nativo `bbox_2d`+`point_2d` levou o erro de **82,6 px para 4,1 px**.

---

## 2. Refino por recorte — medido e REFUTADO

`vision_refine_passes` tem default **`0`** por resultado experimental, não por
economia. O refino foi implementado, medido nos dois regimes de prompt e
**piorou ou empatou em 9/9 células**.

A razão é física, não de implementação: **recortar não amplia**. O alvo continua
com os mesmos pixels; perguntar de novo sobre um recorte não dá ao modelo
informação nova.

A opção continua no produto, desligada, disponível para outro modelo que se
comporte de outro jeito.
Evidência: `evidence/nomos-browser-final-loop/06-cascata/medir-refino.ts` e `evidence/nomos-browser-final-loop/06-cascata/out/medir-refino-aim.log`.

---

## 3. Coordenada e clique — o que é exato

| Medida | Valor | Fonte |
|---|---|---|
| Erro de coordenada CDP (enviada vs. recebida pela página) | **0,000 px** médio e máximo | `evidence/nomos-browser-final-validation/03-vision/out/coordenadas.json`; remedido em `bc7130f` com 6/6 alvos (antes 4/6) |
| Cliques dentro do alvo (alvos assentados) | 6/6 | `evidence/nomos-browser-final-validation/03-vision/medir-coordenadas.ts`, após a correção do clique (`bc7130f`) |
| `isTrusted=true` | 5/5 | FINAL_REPORT, FASE 3 (5 alvos independentes) |
| Screenshot × viewport × DPR | confere, decodificado pelo PNG decoder do próprio produto | FINAL_REPORT, FASE 3 |

A geometria é exata. **A imprecisão do item 1 é do modelo de visão, não do
runtime.** Separar as duas coisas mudou o veredito da validação — não é
formalidade.

---

## 4. Selo de replay é hash SEM CHAVE

Pega adulteração de linha, reordenação e truncamento, inclusive com JSON válido
e timestamps em ordem. **Não pega** adversário com permissão de escrita no
diretório da sessão: ele pode adulterar **e resselar**. Fechar isso exigiria
chave fora da máquina — fora do escopo desta versão. Declarado também em
`docs/SECURITY.md`.

## 5. Sem sandbox de processo por sessão

Todas as sessões compartilham o processo do runtime. Foi isso que transformou o
crash do download bloqueado (`ae4bff1`) em falha de **todas** as sessões
simultaneamente: um `unhandledRejection` derrubava o processo inteiro. O defeito
específico foi corrigido; **a propriedade estrutural continua valendo** — um
defeito equivalente teria o mesmo alcance.

## 6. Um dono por máquina

O runtime assume **um dono**, local. Não há multiusuário, não há replicação e não
há migração de sessão entre máquinas. O bind é `127.0.0.1` por padrão, e essa
continua sendo a linha de defesa mais importante: autenticação reduz o dano de um
processo local hostil, não torna seguro expor a porta na LAN.

## 7. Reboot real NÃO testado

A supervisão foi provada contra o launchd real em 11/11 passos — instalação,
instância única, `SIGTERM` sem resíduo, `SIGKILL` com reinício e PID novo,
crash-loop freado. Mas **reboot real nunca foi executado**: a máquina de prova é
de produção. O que existe é `launchctl kickstart -k`, **declarado como
simulação**. Ninguém pode afirmar hoje que o serviço volta depois de um boot
frio.

## 8. Fragilidade sob contenção de memória

Não é limitação do produto em uso normal, mas é real e medida no laboratório:

- A suíte, com outra carga pesada dividindo os 16 GiB, produz arquivos `MORTO`
  (mortos pelo vigia de timeout). Já aconteceu com `aiprovider` e
  `recovery-watchdog`; isolados, voltaram verdes.
- `qwen3.5:4b-q8_0` estourou **180 s** de carregamento sob carga, onde isolado
  responde em **3,8 s**.
- O gate de crash recovery falhou uma vez com `kill ESRCH` sob pressão — o daemon
  filho morreu sozinho antes do `SIGKILL` do teste. Sob condição limpa não
  reproduziu em 3 tentativas.

O sinal certo **não é o swap**: descarregar um modelo de 5,13 GB moveu a memória
disponível de 2,5 GB para 5,6 GB enquanto o swap saiu de 16 769 MB para
16 714 MB — praticamente parado. Swap no macOS não encolhe quando a pressão
passa. Use `scripts/lib-memoria.sh` (memória **disponível** = free + inactive +
purgeable).

---

## 9. Capacidades que simplesmente não existem

`grep` confirma zero ocorrências no produto:

- **clipboard** — não existe.
- **`localStorage` / `sessionStorage`** — não existe API.
- **cookies** — há isolamento por perfil, mas **não** há rota de leitura ou
  escrita de cookie. Isso é deliberado (T4): cookies nunca são devolvidos ao
  agente.
- **janelas** (múltiplas janelas do navegador) — só abas.
- **swarm / multiagente** — só handoff de dono de sessão.
- **CAPTCHA** — o runtime **detecta e escala**, não contorna. Está fora do
  produto por decisão, não por limitação técnica.

## 10. Integração NOMOS: transporte provado, registro PENDENTE

O transporte foi provado ponta a ponta (`NOMOS_TRANSPORT_E2E=PASS`, 18/18 casos
contra daemon e Chromium reais) e a Gi despacha pelo caminho canônico.

**O que falta não é código: é assinatura.** `nomos mcp confiar` grava o hash do
manifesto no catálogo do dono e é **ato dele**. O pedido chegou a ser enfileirado
no painel (`A5 alvo=mcp:confiar:nomos-browser`) e **expirou por TTL sem
resposta**. Estado: `BLOQUEADO_POR_APROVACAO`.

Enquanto isso não acontecer, o browser **não está registrado no NOMOS**, e tools
A2/A5 chamadas pela Gi param no gate com `BLOQUEADO_POR_APROVACAO` — que é o
comportamento correto, porque o NOMOS é a autoridade. Não descreva essa
integração como "pronta".

## 11. Marca em estado PROPOSTA

`brand-resolve --require-official NOMOS` devolve `rc=1` (fail-closed): a marca
está vigente na v1.0 **sem documento de congelamento**. Toda peça da NOMOS Web
sai marcada `PROPOSTA`. Congelar é ato humano — nenhum agente resolve isso.

Divergência aberta e não reconciliada: o corpo do `BRANDBOOK_NOMOS.md` afirma
"v1.0 (congelado)" e "v1.0 oficial" na seção 8, mas a governança reporta
`congelamento: NÃO INFORMADO` e `selo: SEM SELO`.

## 12. Sem licença aberta e sem versão publicada

`LICENSE` declara "todos os direitos reservados" — que é o estado legal padrão na
ausência de escolha, não uma decisão nova. Escolher MIT/Apache-2.0/AGPL é ato do
dono. Não há nenhuma tag no repositório e `package.json` é `"private": true`:
**nada foi lançado**. Ver `LICENSE`, `CHANGELOG.md` e `docs/RELEASE.md`.
