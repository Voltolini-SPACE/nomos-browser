/**
 * FASE 6b — O REFINO POR RECORTE MELHORA? MEDIDO, NÃO AFIRMADO.
 *
 * A PERGUNTA
 * ----------
 * A FASE 6 mediu que `qwen2.5vl:3b` sobre a tela inteira erra o centro de um
 * alvo de 160x100 por 96,4 px — 9 px FORA da borda. A hipótese do conserto é
 * que o erro ABSOLUTO do modelo escala com o tamanho da IMAGEM, não com o do
 * alvo; se for verdade, perguntar de novo sobre um RECORTE reduz o erro na
 * mesma proporção em que o recorte é menor que a tela.
 *
 * O DESENHO DA MEDIÇÃO
 * --------------------
 * 3 tamanhos de alvo × 3 configurações de refino × 3 execuções = 27 resoluções.
 *
 *   grande  320x200   médio  160x100 (o caso que falhava)   pequeno  80x50
 *   refine_passes = 0 (controle negativo) | 1 (default) | 2
 *
 * Os três alvos têm o MESMO CENTRO (480,170). Sem isso, "o pequeno errou mais"
 * poderia ser só "o pequeno está num lugar mais difícil da tela".
 *
 * Três execuções porque a 1ª inferência depois de carregar o modelo difere das
 * seguintes (medido na FASE 6: find#0 ≠ find#1 = find#2 sobre imagens
 * byte-idênticas). Com seed fixo, a variação entre as execuções 2 e 3 tem de
 * ser zero — e se não for, o número aparece aqui em vez de virar folclore.
 *
 * Tudo passa pelo daemon REAL, pela cascata REAL e pelo audit REAL: o número de
 * inferências sai do `trace` gravado, não de um contador do script.
 *
 * Rodar: node evidence/nomos-browser-final-loop/06-cascata/medir-refino.ts
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";
import { OllamaVisionProvider } from "../../../packages/core/src/vision.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });
const OLLAMA = "http://127.0.0.1:11434";
const MODELO = process.env.NOMOS_MEDIR_VL ?? "qwen2.5vl:3b";
const GOAL = "o botao vermelho escrito COMPRAR";

/**
 * Perilhas de EXPERIMENTO. Existem porque a 1a rodada REFUTOU a hipotese
 * inicial ("o erro escala com o tamanho da imagem"): recortar sem ampliar
 * deixou o alvo com os MESMOS pixels e o erro nao caiu. Poder variar DPR,
 * fator de recorte e tamanhos sem reescrever o script e o que separa medir de
 * chutar duas vezes.
 */
const EXECUCOES = Number(process.env.NOMOS_MEDIR_EXEC ?? "3");
const DPR = Number(process.env.NOMOS_MEDIR_DPR ?? "1");
const FATOR = process.env.NOMOS_MEDIR_FATOR === undefined ? undefined : Number(process.env.NOMOS_MEDIR_FATOR);
const PASSES_LISTA = (process.env.NOMOS_MEDIR_PASSES ?? "0,1,2").split(",").map((x) => Number(x.trim()));
/** FASE 6c — dimensão da MIRA. Um daemon por (passes × aim). */
const AIMS_LISTA = (process.env.NOMOS_MEDIR_AIM ?? "box_center").split(",").map((x) => x.trim());
const SO_TAMANHOS = process.env.NOMOS_MEDIR_TAMANHOS;
const ROTULO = process.env.NOMOS_MEDIR_ROTULO ?? `dpr${DPR}-f${FATOR ?? "def"}`;

/** Centro comum aos três tamanhos. */
const CX = 480;
const CY = 170;

interface Tamanho {
  nome: string;
  w: number;
  h: number;
}
const TODOS: Tamanho[] = [
  { nome: "grande", w: 320, h: 200 },
  { nome: "medio", w: 160, h: 100 },
  { nome: "pequeno", w: 80, h: 50 },
];
const TAMANHOS: Tamanho[] =
  SO_TAMANHOS === undefined ? TODOS : TODOS.filter((t) => SO_TAMANHOS.split(",").includes(t.nome));

/** Verdade do alvo, derivada do centro comum. */
function verdade(t: Tamanho): { x: number; y: number; w: number; h: number } {
  return { x: CX - t.w / 2, y: CY - t.h / 2, w: t.w, h: t.h };
}

/**
 * MESMO renderizador de `tests/fixtures/cascata/vision.html`: botão com rótulo
 * centralizado e dois irmãos que dão escala e obrigam a discriminar. Trocar o
 * desenho aqui mediria outra coisa que não o produto.
 */
function pagina(t: Tamanho): string {
  const v = verdade(t);
  return [
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>medir refino</title>',
    "<style>html,body{margin:0;padding:0;background:#fff}canvas{display:block}",
    "#clicado{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;color:#fff}</style>",
    '</head><body><canvas id="tela" width="1280" height="800"></canvas><div id="clicado">nada</div>',
    "<script>",
    `var ALVO = { x: ${v.x}, y: ${v.y}, w: ${v.w}, h: ${v.h} };`,
    "var c=document.getElementById('tela'),g=c.getContext('2d');",
    "g.fillStyle='#ffffff';g.fillRect(0,0,1280,800);",
    // MESMO renderizador da fixture: rotulo que ESCALA com o botao. Fixo em
    // 22px, o texto transbordava do alvo de 80x50 e o alvo deixava de parecer
    // um botao — o instrumento mediria o proprio desenho.
    "function botao(x,y,w,h,cor,rotulo){",
    " g.fillStyle=cor;g.fillRect(x,y,w,h);",
    " g.strokeStyle='rgba(0,0,0,0.25)';g.lineWidth=2;g.strokeRect(x+1,y+1,w-2,h-2);",
    " var px=Math.max(8,Math.min(22,Math.round(h*0.28)));",
    " for(;px>8;px-=1){g.font='bold '+px+'px system-ui, sans-serif';",
    "  if(g.measureText(rotulo).width<=w*0.8)break;}",
    " g.font='bold '+px+'px system-ui, sans-serif';",
    " if(g.measureText(rotulo).width>w*0.92)return;",
    " g.fillStyle='#ffffff';",
    " g.textAlign='center';g.textBaseline='middle';g.fillText(rotulo,x+w/2,y+h/2);}",
    "botao(ALVO.x,ALVO.y,ALVO.w,ALVO.h,'rgb(220,40,40)','COMPRAR');",
    "botao(120,400,150,60,'rgb(40,140,80)','VOLTAR');",
    "botao(880,600,150,60,'rgb(90,90,110)','AJUDA');",
    "c.addEventListener('click',function(e){document.getElementById('clicado').textContent=",
    " 'clique em '+Math.round(e.offsetX)+','+Math.round(e.offsetY)+' isTrusted='+e.isTrusted;});",
    "</script></body></html>",
  ].join("\n");
}

// ── higiene de memória ───────────────────────────────────────────────────────

async function modelos(): Promise<string[]> {
  const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
  const d = (await r.json()) as { models?: { name?: string }[] };
  return (d.models ?? []).map((m) => m.name ?? "").filter((n) => n !== "");
}
async function residentes(): Promise<string[]> {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(8000) });
    const d = (await r.json()) as { models?: { name?: string }[] };
    return (d.models ?? []).map((m) => m.name ?? "").filter((n) => n !== "");
  } catch {
    return [];
  }
}
async function descarregarTodos(): Promise<void> {
  let lista: string[] = [];
  try {
    lista = await modelos();
  } catch {
    return;
  }
  for (const m of lista) {
    await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

// ── medição ──────────────────────────────────────────────────────────────────

interface Linha {
  tamanho: string;
  alvo: { x: number; y: number; w: number; h: number };
  refine_passes: number;
  aim_modo: string;
  aim: string | null;
  aim_point: { x: number; y: number } | null;
  margem_px: number | null;
  execucao: number;
  ok: boolean;
  strategy: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  centro: { x: number; y: number } | null;
  erro_px: number | null;
  dentro_do_alvo: boolean | null;
  ms: number;
  inferencias: number | null;
  refino: string | null;
  motivo: string | null;
  deslocamento_px: number | null;
  area_ratio_p1_p2: number | null;
  erro: string;
}

const linhas: Linha[] = [];
const saida: string[] = [];
function diz(s: string): void {
  saida.push(s);
  process.stdout.write(`${s}\n`);
}

let codigo = 1;
let srv: http.Server | null = null;

try {
  let disponiveis: string[] = [];
  try {
    disponiveis = await modelos();
  } catch (e) {
    diz(`MEDIR_REFINO=SKIP  backend Ollama inalcançável: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!disponiveis.includes(MODELO)) {
    diz(`MEDIR_REFINO=SKIP  modelo ${MODELO} ausente (tem: ${disponiveis.join(", ")})`);
    process.exit(2);
  }
  await descarregarTodos();
  diz(`modelo=${MODELO}  dpr=${DPR}  fator=${FATOR ?? "default"}  passes=[${PASSES_LISTA.join(",")}]  execucoes=${EXECUCOES}`);
  diz(`residentes_antes=[${(await residentes()).join(", ")}]`);

  const paginas: Record<string, string> = {};
  for (const t of TAMANHOS) paginas[`/${t.nome}`] = pagina(t);
  srv = http.createServer((req, res) => {
    const rota = (req.url ?? "/").split("?")[0]!;
    const html = paginas[rota];
    res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(html ?? "nao encontrado");
  });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
  const FIX = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  for (const aimModo of AIMS_LISTA) {
  for (const passes of PASSES_LISTA) {
    const raiz = path.join(OUT, `medir-${ROTULO}-${aimModo}-p${passes}`);
    fs.rmSync(raiz, { recursive: true, force: true });
    const d: any = await startDaemon({
      port: 0,
      headless: true,
      allow_internal_urls: true,
      read_file: false,
      sessions_root: raiz,
      vision_timeout_ms: 180_000,
      vision_min_confidence: 0.7,
      device_scale_factor: DPR,
      action_timeout_ms: 300_000,
      /**
       * O provider é INJETADO, não construído a partir de `vision_provider`.
       *
       * Não é atalho: `vision_aim` e `vision_refine_*` viajam NO PROVIDER
       * (`ComPoliticaDeRefino`/`ComPoliticaDeMira` em `target.ts`), e a linha
       * que copia a config para o provider mora em `packages/api/src/providers.ts`
       * — arquivo fora do confinamento desta rodada. Injetar aqui mede
       * exatamente o mesmo caminho de produção (mesma classe, mesma cascata,
       * mesmo daemon) sem depender dessa costura.
       *
       * A primeira execução desta medição NÃO fazia isso, e as três colunas de
       * `aim` saíram idênticas porque as três caíram no default. O sintoma
       * estava no próprio log: `aim=box_center ... mirou=point`.
       */
      vision: new OllamaVisionProvider({
        model: MODELO,
        timeout_ms: 180_000,
        aim: aimModo as never,
        refine_passes: passes,
        ...(FATOR !== undefined ? { refine_factor: FATOR } : {}),
      }),
    } as never);
    const BASE = `http://127.0.0.1:${d.port}`;
    const TOK: string | null = d.token ?? null;
    const p = async (rota: string, corpo: unknown): Promise<any> => {
      const x = await fetch(BASE + rota, {
        method: "POST",
        headers: { "content-type": "application/json", ...(TOK !== null ? { authorization: `Bearer ${TOK}` } : {}) },
        body: JSON.stringify(corpo),
      });
      return await x.json();
    };
    const s = await p("/api/v1/sessions", { owner: "MEDIR-REFINO", headless: true });
    const sid: string = s.session_id;

    for (const t of TAMANHOS) {
      const v = verdade(t);
      for (let exec = 1; exec <= EXECUCOES; exec += 1) {
        await p("/api/v1/browser.open", { session_id: sid, url: `${FIX}/${t.nome}` });
        const t0 = Date.now();
        const f = await p("/api/v1/browser.find", { session_id: sid, target: { semantic: GOAL } });
        const ms = Date.now() - t0;

        // O número de inferências sai do TRACE GRAVADO, não de um contador
        // deste script: é o produto que tem de saber quantas vezes perguntou.
        let refinoDet: any = null;
        try {
          const arq = path.join(raiz, sid, "actions.jsonl");
          const linhasAudit = fs
            .readFileSync(arq, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as any);
          const casc = [...linhasAudit].reverse().find((l) => l.action === "target.cascade");
          refinoDet = (casc?.detail?.trace ?? []).find((x: any) => x.strategy === "vision")?.detail ?? null;
        } catch {
          refinoDet = null;
        }

        const box = f?.result?.box ?? null;
        const cx = box === null ? null : box.x + box.width / 2;
        const cy = box === null ? null : box.y + box.height / 2;
        const erro = cx === null ? null : Math.hypot(cx - CX, cy! - CY);
        const dentro = cx === null ? null : cx >= v.x && cx <= v.x + v.w && cy! >= v.y && cy! <= v.y + v.h;

        linhas.push({
          tamanho: t.nome,
          alvo: v,
          refine_passes: passes,
          aim_modo: aimModo,
          aim: refinoDet?.aim ?? null,
          aim_point: refinoDet?.aim_point ?? null,
          // MARGEM até a borda mais próxima do alvo. "Caiu dentro" com 3px de
          // folga e com 60px são resultados diferentes, e o gate anterior
          // passou por 3px — o número tem de aparecer, não o veredito só.
          margem_px:
            cx === null ? null : Math.round(Math.min(cx - v.x, v.x + v.w - cx, cy! - v.y, v.y + v.h - cy!)),
          execucao: exec,
          ok: f?.success === true,
          strategy: f?.result?.strategy ?? null,
          box,
          centro: cx === null ? null : { x: Math.round(cx), y: Math.round(cy!) },
          erro_px: erro === null ? null : Number(erro.toFixed(1)),
          dentro_do_alvo: dentro,
          ms,
          inferencias: refinoDet?.inferencias ?? null,
          refino: refinoDet?.refino ?? null,
          motivo: refinoDet?.motivo ?? null,
          deslocamento_px: refinoDet?.deslocamento_px ?? null,
          area_ratio_p1_p2: refinoDet?.area_ratio_p1_p2 ?? null,
          erro: f?.success === true ? "" : JSON.stringify(f?.error?.code ?? f?.error ?? "?"),
        });

        diz(
          `${t.nome.padEnd(8)} ${t.w}x${t.h}`.padEnd(20) +
            ` aim=${aimModo.padEnd(14)} passes=${passes} exec=${exec}` +
            ` erro=${erro === null ? "  -  " : `${erro.toFixed(1)}px`.padStart(7)}` +
            ` DENTRO=${dentro === null ? "-" : dentro ? "SIM" : "NAO"}` +
            ` inf=${refinoDet?.inferencias ?? "-"}` +
            ` ${String(ms).padStart(6)}ms` +
            ` margem=${cx === null ? "  -" : String(Math.round(Math.min(cx - v.x, v.x + v.w - cx, cy! - v.y, v.y + v.h - cy!))).padStart(4)}px` +
            ` mirou=${refinoDet?.aim ?? "-"}` +
            (refinoDet?.motivo ? ` (${refinoDet.motivo})` : "") +
            (f?.success === true ? "" : ` ERRO=${f?.error?.code}`),
        );
      }
    }
    await d.close();
  }
  }

  // ── resumo ────────────────────────────────────────────────────────────────
  diz("");
  diz("RESUMO  (mediana das execuções; 'estável' = execuções 2 e 3 idênticas)");
  diz("tamanho   aim             passes  erro_med  margem  dentro   inferencias  estavel");
  for (const t of TAMANHOS) {
    for (const aimModo of AIMS_LISTA)
    for (const passes of PASSES_LISTA) {
      const g = linhas.filter((l) => l.tamanho === t.nome && l.refine_passes === passes && l.aim_modo === aimModo);
      const erros = g.map((l) => l.erro_px).filter((x): x is number => x !== null).sort((a, b) => a - b);
      const med = erros.length === 0 ? null : erros[Math.floor(erros.length / 2)]!;
      const dentroN = g.filter((l) => l.dentro_do_alvo === true).length;
      const infs = [...new Set(g.map((l) => l.inferencias))].join("/");
      // Estabilidade compara as execuções 2 e 3 (a 1ª é fria e difere). Com
      // menos de 3 execuções a pergunta não foi feita — e "NAO" seria mentira.
      const estavel = g.length >= 3 ? (g[1]!.erro_px === g[2]!.erro_px ? "sim" : "NAO") : "-";
      const margens = g.map((l) => l.margem_px).filter((x): x is number => x !== null).sort((a, b) => a - b);
      const margemMed = margens.length === 0 ? null : margens[Math.floor(margens.length / 2)]!;
      diz(
        `${t.nome.padEnd(9)} ${aimModo.padEnd(15)} ${String(passes).padEnd(7)} ${(med === null ? "-" : `${med}px`).padStart(8)}` +
          ` ${(margemMed === null ? "-" : `${margemMed}px`).padStart(7)}` +
          ` ${`${dentroN}/${g.length}`.padStart(6)}   ${infs.padStart(11)}  ${estavel}`,
      );
    }
  }

  const veredito = TAMANHOS.flatMap((t) =>
    AIMS_LISTA.map((aimModo) => {
    const com = linhas.filter((l) => l.tamanho === t.nome && l.refine_passes === 1 && l.aim_modo === aimModo);
    const sem = linhas.filter((l) => l.tamanho === t.nome && l.refine_passes === 0 && l.aim_modo === aimModo);
    const md = (xs: Linha[]): number | null => {
      const e = xs.map((l) => l.erro_px).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return e.length === 0 ? null : e[Math.floor(e.length / 2)]!;
    };
    return {
      tamanho: t.nome,
      aim: aimModo,
      erro_sem_refino: md(sem),
      erro_com_refino: md(com),
      dentro_sem: sem.filter((l) => l.dentro_do_alvo === true).length,
      dentro_com: com.filter((l) => l.dentro_do_alvo === true).length,
      total: com.length,
    };
  }),
  );
  // O veredito comparativo só faz sentido quando as DUAS configurações de
  // refino foram medidas nesta execução. Imprimi-lo com uma só produzia linhas
  // como "com_refino=nullpx (0/0 dentro)" — ruído que se lê como resultado.
  if (PASSES_LISTA.includes(0) && PASSES_LISTA.includes(1)) {
    diz("");
    for (const v of veredito) {
      diz(
        `VEREDITO ${v.tamanho.padEnd(8)} aim=${String(v.aim).padEnd(15)} sem_refino=${v.erro_sem_refino}px (${v.dentro_sem}/${v.total} dentro)` +
          `  com_refino=${v.erro_com_refino}px (${v.dentro_com}/${v.total} dentro)`,
      );
    }
  }

  fs.writeFileSync(
    path.join(OUT, `medir-refino-${ROTULO}.json`),
    JSON.stringify({ quando: new Date().toISOString(), modelo: MODELO, dpr: DPR, fator: FATOR ?? null, goal: GOAL, centro: { x: CX, y: CY }, linhas, veredito }, null, 2),
  );
  codigo = 0;
} catch (e) {
  diz(`MEDIR_REFINO=FALHOU  ${(e as Error).message}`);
  codigo = 1;
} finally {
  await new Promise<void>((r) => (srv === null ? r() : srv.close(() => r())));
  await descarregarTodos();
  diz(`residentes_depois=[${(await residentes()).join(", ")}]`);
  fs.writeFileSync(path.join(OUT, `medir-refino-${ROTULO}.log`), `${saida.join("\n")}\n`);
}
process.exit(codigo);
