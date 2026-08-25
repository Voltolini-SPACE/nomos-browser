/**
 * FASE 6 — E2E DE VISÃO REAL
 *
 * POR QUE ESTE ARQUIVO EXISTE, E NÃO UM PATCH NO E2E ANTIGO
 * ----------------------------------------------------------
 * `evidence/nomos-browser-final-validation/10-e2e/e2e-independente.ts` é
 * evidência de uma validação já feita: mexer nele reescreveria o passado. Ele
 * sobe o daemon SEM `vision_provider` e por isso o `E2E-10` falhava com
 * `{"strategy":"vision","outcome":"skipped"}` — e a falha estava CERTA: sem
 * provider, o degrau tem mesmo de ser pulado.
 *
 * Este script sobe o MESMO daemon com o provider LIGADO por configuração, e é
 * essa a diferença que ele mede.
 *
 * O QUE ELE PROVA — e por que cada peça é necessária
 * ---------------------------------------------------
 *  1. `strategy === "vision"`. Não basta "achou": achar por DOM numa página que
 *     tem DOM não prova nada sobre a visão. A fixture não tem UM elemento
 *     interativo — o alvo é pixel dentro de `<canvas>`.
 *  2. O clique cai DENTRO do alvo, e o erro é medido em px contra a VERDADE DA
 *     PÁGINA (`window.__alvoBox()`), não contra o que o runtime relatou.
 *     Comparar o relatório do runtime com ele mesmo não mede nada.
 *  3. `isTrusted === true`. Um evento sintético despachado por script passaria
 *     nos dois itens acima e não seria um clique de navegador.
 *
 * CUIDADO DE MÁQUINA
 * ------------------
 * M2 de 16 GB. `qwen2.5vl:3b` ocupa ~3,2 GB. O script descarrega TODOS os
 * modelos antes de começar e descarrega de novo no fim — dois modelos
 * residentes ao mesmo tempo já mataram os serviços NOMOS de produção por jetsam
 * nesta máquina (ver `scripts/lib-memoria.sh`).
 *
 * Rodar: node evidence/nomos-browser-final-loop/06-cascata/e2e-visao.ts
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../packages/api/src/daemon.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const FIXTURE = path.join(RAIZ, "tests", "fixtures", "cascata", "vision.html");
const OUT = path.join(AQUI, "out");
fs.mkdirSync(OUT, { recursive: true });

const OLLAMA = "http://127.0.0.1:11434";
const MODELO_VISAO = "qwen2.5vl:3b";
/** VERDADE da fixture. A página desenha exatamente isto. */
const ALVO = { x: 400, y: 120, w: 160, h: 100 };

const linhas: string[] = [];
function diz(s: string): void {
  linhas.push(s);
  process.stdout.write(`${s}\n`);
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

/** `keep_alive: 0` em todo modelo conhecido. Espelha `descarregar_todos` do lib-memoria. */
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

// ── bateria ──────────────────────────────────────────────────────────────────

let codigoDeSaida = 1;
let daemon: any = null;
let srv: http.Server | null = null;

try {
  // 0. O backend existe e tem o modelo? Sem isso não há o que medir — e um
  //    script de evidência que "passa" sem backend é o pior resultado possível.
  let disponiveis: string[] = [];
  try {
    disponiveis = await modelos();
  } catch (e) {
    diz(`E2E_VISAO=SKIP  backend Ollama inalcançável em ${OLLAMA}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!disponiveis.includes(MODELO_VISAO)) {
    diz(`E2E_VISAO=SKIP  modelo ${MODELO_VISAO} ausente do backend (tem: ${disponiveis.join(", ")})`);
    process.exit(2);
  }

  await descarregarTodos();
  const antes = await residentes();
  diz(`preparo: modelos residentes antes = [${antes.join(", ")}]`);

  // 1. Servidor da fixture.
  const html = fs.readFileSync(FIXTURE);
  srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
  const a = srv.address() as { port: number };
  const FIX = `http://127.0.0.1:${a.port}/vision.html`;

  // 2. Daemon COM visão ligada POR CONFIGURAÇÃO. É o único delta em relação ao
  //    e2e da validação anterior.
  daemon = await startDaemon({
    port: 0,
    headless: true,
    allow_internal_urls: true,
    read_file: false,
    sessions_root: path.join(OUT, "sessions"),
    vision_provider: `ollama:${MODELO_VISAO}`,
    // Carga fria de 3,2 GB nesta máquina não cabe nos 20 s de default.
    vision_timeout_ms: 180_000,
    vision_min_confidence: 0.7,
    // O prazo da AÇÃO tem de comportar a inferência, senão o teto que dispara
    // primeiro é o da fila e o erro reportado seria o errado.
    action_timeout_ms: 300_000,
  } as never);

  const BASE = `http://127.0.0.1:${daemon.port}`;
  const TOKEN: string | null = daemon.token ?? null;
  const H = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(TOKEN !== null ? { authorization: `Bearer ${TOKEN}` } : {}),
    ...extra,
  });
  const acao = async (tool: string, corpo: Record<string, unknown>): Promise<any> => {
    const r = await fetch(`${BASE}/api/v1/${tool}`, {
      method: "POST",
      headers: H({ "content-type": "application/json" }),
      body: JSON.stringify(corpo),
    });
    return await r.json();
  };

  diz(`daemon=${BASE} fixture=${FIX}`);
  diz(`vision_provider=${daemon.config.vision_provider} min_conf=${daemon.config.vision_min_confidence}`);
  diz(`VisionProvider injetado=${daemon.vision === null ? "NENHUM" : daemon.vision.name}`);
  if (daemon.vision === null) throw new Error("config pediu visão e o daemon subiu sem VisionProvider");

  const s = await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ owner: "FASE6-VISAO", profile: "sandbox", headless: true }),
  });
  const sess = (await s.json()) as { session_id?: string };
  const SID = sess.session_id!;
  if (SID === undefined) throw new Error(`sessão não criada: ${JSON.stringify(sess)}`);
  diz(`sessao=${SID}`);

  const o = await acao("browser.open", { session_id: SID, url: FIX });
  if (o.success !== true) throw new Error(`open falhou: ${JSON.stringify(o.error)}`);

  // 3. A CASCATA. `semantic` é o campo pedido; a página não tem candidato
  //    interativo nenhum, então só o 5º degrau pode responder.
  const t0 = Date.now();
  const f = await acao("browser.find", {
    session_id: SID,
    target: { semantic: "o botao vermelho escrito COMPRAR" },
  });
  const msFind = Date.now() - t0;
  if (f.success !== true) {
    throw new Error(`find falhou (${msFind}ms): ${JSON.stringify(f.error?.detail?.trace ?? f.error)}`);
  }
  diz(`find: ${msFind}ms strategy=${f.result.strategy} attempted=[${(f.result.attempted ?? []).join(" -> ")}]`);
  diz(`find.box=${JSON.stringify(f.result.box)}`);
  if (f.result.strategy !== "vision") {
    throw new Error(`resolveu por "${f.result.strategy}", não por visão`);
  }

  // 4. O CLIQUE.
  const t1 = Date.now();
  const c = await acao("browser.click", {
    session_id: SID,
    target: { semantic: "o botao vermelho escrito COMPRAR" },
  });
  const msClick = Date.now() - t1;
  if (c.success !== true) throw new Error(`click falhou (${msClick}ms): ${JSON.stringify(c.error)}`);
  // A caixa do CLIQUE, ao lado da do FIND. `browser.click` refaz a cascata
  // inteira — inclusive a inferência —, então as duas podem discordar sobre
  // onde o alvo está. Imprimir as duas é o que torna essa discordância um dado
  // em vez de um mistério.
  diz(
    `click.box=${JSON.stringify(c.result?.target?.box)} ponto_do_clique=${JSON.stringify(c.result?.detail?.ponto_do_clique)}`,
  );

  const lido = await acao("browser.extract", { session_id: SID, target: { selector: "#clicado" } });
  const txt = String(lido.result?.content ?? "");
  const m = txt.match(/clique em (\d+),(\d+) isTrusted=(true|false)/);
  if (m === null) throw new Error(`o canvas não registrou clique nenhum: ${JSON.stringify(txt)}`);

  const cx = Number(m[1]);
  const cy = Number(m[2]);
  const confiavel = m[3] === "true";
  const centroX = ALVO.x + ALVO.w / 2;
  const centroY = ALVO.y + ALVO.h / 2;
  const erroX = Math.abs(cx - centroX);
  const erroY = Math.abs(cy - centroY);
  const erroPx = Math.sqrt(erroX * erroX + erroY * erroY);
  const dentro = cx >= ALVO.x && cx <= ALVO.x + ALVO.w && cy >= ALVO.y && cy <= ALVO.y + ALVO.h;

  diz(`click: ${msClick}ms`);
  diz(`alvo_verdade={x:${ALVO.x},y:${ALVO.y},w:${ALVO.w},h:${ALVO.h}} centro=(${centroX},${centroY})`);
  diz(`clique_observado=(${cx},${cy}) isTrusted=${confiavel}`);
  diz(`ERRO_PX=${erroPx.toFixed(1)} (dx=${erroX.toFixed(1)} dy=${erroY.toFixed(1)}) DENTRO_DO_ALVO=${dentro ? "SIM" : "NAO"}`);
  // A MARGEM é reportada junto com o veredito de propósito: "caiu dentro" com
  // 8 px de folga e "caiu dentro" com 60 px são resultados diferentes, e quem
  // ler esta evidência precisa saber qual dos dois aconteceu. O modelo tem viés
  // sistemático medido (~+30 px em y, largura superestimada) — ver
  // `out/diag-visao.json`.
  const margem = Math.min(cx - ALVO.x, ALVO.x + ALVO.w - cx, cy - ALVO.y, ALVO.y + ALVO.h - cy);
  diz(`MARGEM_ATE_A_BORDA=${margem}px (alvo ${ALVO.w}x${ALVO.h})`);

  // 5. A TRILHA. A cascata que chegou na visão tem de estar auditável.
  const arq = path.join(OUT, "sessions", SID, "actions.jsonl");
  const trilha = fs.existsSync(arq)
    ? fs
        .readFileSync(arq, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as any)
    : [];
  const cascata = trilha.find((l) => l.action === "target.cascade" && l.detail?.strategy === "vision");
  diz(`audit: ${trilha.length} linhas; target.cascade(vision)=${cascata === undefined ? "AUSENTE" : "presente"}`);
  if (cascata !== undefined) diz(`audit.trace=${JSON.stringify(cascata.detail.trace)}`);

  if (!dentro) throw new Error(`clique caiu FORA do alvo: (${cx},${cy}) erro ${erroPx.toFixed(1)}px`);
  if (!confiavel) throw new Error("evento sintético: isTrusted=false");
  if (cascata === undefined) throw new Error("a resolução por visão não deixou linha na trilha");

  fs.writeFileSync(
    path.join(OUT, "e2e-visao.json"),
    JSON.stringify(
      {
        quando: new Date().toISOString(),
        modelo: MODELO_VISAO,
        alvo_verdade: ALVO,
        strategy: f.result.strategy,
        attempted: f.result.attempted,
        box_da_visao: f.result.box,
        clique: { x: cx, y: cy, isTrusted: confiavel },
        erro_px: Number(erroPx.toFixed(2)),
        margem_ate_a_borda_px: margem,
        dentro_do_alvo: dentro,
        find_ms: msFind,
        click_ms: msClick,
        trace: cascata?.detail?.trace ?? null,
      },
      null,
      2,
    ),
  );

  diz(`E2E_VISAO=PASS  strategy=vision erro=${erroPx.toFixed(1)}px isTrusted=true`);
  codigoDeSaida = 0;
} catch (e) {
  diz(`E2E_VISAO=FAIL  ${(e as Error).message}`);
  codigoDeSaida = 1;
} finally {
  await daemon?.close().catch(() => undefined);
  await new Promise<void>((r) => (srv === null ? r() : srv.close(() => r())));
  // Descarrega SEMPRE — inclusive no caminho de falha, que é justamente quando
  // um modelo fica preso na RAM e mata o processo seguinte.
  await descarregarTodos();
  const depois = await residentes();
  diz(`limpeza: modelos residentes depois = [${depois.join(", ")}]`);
  fs.writeFileSync(path.join(OUT, "e2e-visao.log"), `${linhas.join("\n")}\n`);
}

process.exit(codigoDeSaida);
