#!/usr/bin/env node
/**
 * FASE 40 — O NÍVEL DE UMA TOOL TEM DE VALER PARA TUDO QUE ELA FAZ.
 *
 * O DEFEITO QUE ESTE GUARDA EXISTE PARA IMPEDIR (provado, não hipotético):
 * `browser_tabs` era declarada `A0` no manifesto e despachava QUATRO rotas —
 * `browser.tabs` (leitura), `browser.new_tab` (EGRESSO), `browser.switch_tab` e
 * `browser.close_tab` (mutação). Como o NOMOS classifica por FERRAMENTA e não
 * por argumento, a política do dono devolveu ALLOW para "ler arquivos locais" e
 * a chamada ABRIU uma aba na rede, headless, sem aprovação. Verbatim em
 * `evidence/nomos-browser-final-closeout/01-mcp/03-exploit-tabs.txt`.
 *
 * O guarda anterior (`mcp:manifesto-classifica-todas-as-tools`, em `ci.sh`)
 * conferia COBERTURA: toda tool tem um nível declarado. Passava verde com a
 * elevação de privilégio de pé, porque nunca olhou o que a tool FAZ. Este aqui
 * confere COERÊNCIA: o pior risco que a tool consegue despachar não pode ser
 * maior do que o nível declarado.
 *
 * COMO FUNCIONA (três passos, todos estáticos — sem Chromium, sem rede, sem NOMOS):
 *
 *   1. TABELA EXPLÍCITA `rota → classe de risco`, abaixo, cobrindo TODAS as
 *      rotas de `ACTION_CLASS` do contrato. Rota do contrato que ninguém
 *      classificar aqui REPROVA — é a mesma trava do `nivel_padrao: A5`, um
 *      nível acima.
 *   2. As rotas de cada tool são lidas de DUAS fontes independentes: o campo
 *      `routes` declarado em `TOOLS`, e as chamadas `call("<rota>", ...)` que
 *      aparecem no corpo daquela tool em `packages/mcp/src/tools.ts`. Divergiu,
 *      reprova. Sem isso o guarda checaria uma DECLARAÇÃO, e a declaração é
 *      exatamente o que envelhece quando alguém acrescenta um `if` no `build`.
 *   3. Nível declarado no manifesto ≥ nível mínimo exigido pela pior rota.
 *
 * Uso:  node scripts/verificar-risco-mcp.ts
 *       node scripts/verificar-risco-mcp.ts --tabela   # publica a tabela
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_CLASS } from "../packages/core/src/contract.ts";
import { TOOLS } from "../packages/mcp/src/tools.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_TS = path.join(RAIZ, "packages/mcp/src/tools.ts");
const MANIFESTO = path.join(RAIZ, "packaging/mcp/manifesto.json");

/**
 * Classe de risco de cada rota da API v1.
 *
 * NÃO é cópia de `ACTION_CLASS`. `ACTION_CLASS` responde "o runtime precisa de
 * fila/verificação para isto?" (OBSERVE/ACT/COMMIT); aqui a pergunta é outra:
 * "o dono precisa saber ANTES?". `browser.switch_tab` é ACT no contrato e
 * `mutacao` aqui — muda estado local e não sai para a rede. `browser.scroll`
 * também é ACT e é `egresso`, porque rolagem dispara lazy-loading.
 *
 *   leitura  — lê estado que já existe. Não muda um byte, não emite requisição.
 *   mutacao  — muda estado local do navegador. Nada sai para a rede por isso.
 *   egresso  — faz (ou pode fazer) byte sair desta máquina para a rede.
 */
export type ClasseRisco = "leitura" | "mutacao" | "egresso";

export const RISCO_DA_ROTA: Readonly<Record<string, ClasseRisco>> = Object.freeze({
  // ── leitura ────────────────────────────────────────────────────────────────
  "browser.observe": "leitura",
  "browser.find": "leitura",
  "browser.extract": "leitura",
  "browser.screenshot": "leitura",
  "browser.network": "leitura",
  "browser.tabs": "leitura",
  "browser.wait": "leitura",
  // ── mutação de estado local ────────────────────────────────────────────────
  "browser.switch_tab": "mutacao",
  "browser.close_tab": "mutacao",
  // ── egresso ────────────────────────────────────────────────────────────────
  "browser.open": "egresso",
  "browser.goto": "egresso",
  "browser.back": "egresso",
  "browser.forward": "egresso",
  "browser.reload": "egresso",
  "browser.new_tab": "egresso",
  // Clique/digitação/tecla/rolagem/arrasto NÃO são "interação local": qualquer
  // um deles dispara XHR, submit ou paginação infinita. Classificar pelo caso
  // benigno seria gate-shopping — a mesma escolha já registrada em
  // docs/NOMOS-INTEGRATION.md §2.
  "browser.click": "egresso",
  "browser.type": "egresso",
  "browser.press": "egresso",
  "browser.scroll": "egresso",
  "browser.drag": "egresso",
  "browser.download": "egresso",
  "browser.upload": "egresso",
  // Executor dirigido por modelo: o conjunto de rotas não é conhecido antes de
  // rodar, então vale o teto.
  "browser.task": "egresso",
});

/** Nível MÍNIMO do manifesto que cada classe de risco exige. */
export const NIVEL_MINIMO: Readonly<Record<ClasseRisco, number>> = Object.freeze({
  leitura: 0, // A0_READ_LOCAL
  mutacao: 1, // A1_WRITE_LOCAL
  egresso: 2, // A2_NET_EGRESS
});

const NIVEIS = ["A0", "A1", "A2", "A3", "A4", "A5", "A6"] as const;

function ordemDoNivel(n: unknown): number {
  const i = NIVEIS.indexOf(String(n) as (typeof NIVEIS)[number]);
  return i;
}

/**
 * Rotas que o CORPO de cada tool realmente despacha, lidas do fonte.
 *
 * Segunda fonte, independente do campo `routes`. O recorte é por
 * `name: "<tool>"` até o `name:` seguinte — o mesmo objeto literal —, e dentro
 * dele toda ocorrência de `call("<rota>"`.
 */
export function rotasNoFonte(fonte: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const nomes = [...fonte.matchAll(/^\s*name: "([a-z_]+)",$/gm)];
  for (let i = 0; i < nomes.length; i++) {
    const nome = nomes[i]![1]!;
    const ini = nomes[i]!.index!;
    const fim = i + 1 < nomes.length ? nomes[i + 1]!.index! : fonte.length;
    const corpo = fonte.slice(ini, fim);
    const rotas = [...corpo.matchAll(/\bcall\("([a-z_.]+)"/g)].map((m) => m[1]!);
    out.set(nome, [...new Set(rotas)].sort());
  }
  return out;
}

export interface Problema {
  tool: string;
  motivo: string;
}

export function verificar(manifesto: Record<string, unknown>, fonte: string): Problema[] {
  const problemas: Problema[] = [];

  // ── 1. a tabela cobre o contrato inteiro ──────────────────────────────────
  for (const rota of Object.keys(ACTION_CLASS)) {
    if (!(rota in RISCO_DA_ROTA)) {
      problemas.push({
        tool: "(tabela)",
        motivo: `rota "${rota}" existe em ACTION_CLASS e NÃO tem classe de risco em RISCO_DA_ROTA — classifique antes de expor`,
      });
    }
  }
  for (const rota of Object.keys(RISCO_DA_ROTA)) {
    if (!(rota in ACTION_CLASS)) {
      problemas.push({ tool: "(tabela)", motivo: `RISCO_DA_ROTA classifica "${rota}", que não existe no contrato` });
    }
  }

  const doFonte = rotasNoFonte(fonte);
  const tools = (manifesto.tools ?? {}) as Record<string, unknown>;

  for (const tool of TOOLS) {
    const declaradas = [...tool.routes].sort();

    // ── 2. declaração × fonte ───────────────────────────────────────────────
    const reais = doFonte.get(tool.name);
    if (reais === undefined || reais.length === 0) {
      problemas.push({ tool: tool.name, motivo: "nenhuma chamada call(...) encontrada no fonte — recorte do guarda quebrou" });
    } else if (reais.join(",") !== declaradas.join(",")) {
      problemas.push({
        tool: tool.name,
        motivo: `routes declarada [${declaradas.join(", ")}] diverge do que o corpo despacha [${reais.join(", ")}]`,
      });
    }

    // ── 3. nível declarado ≥ pior risco ─────────────────────────────────────
    const nivel = tools[tool.name];
    if (nivel === undefined) {
      problemas.push({ tool: tool.name, motivo: "sem nível no manifesto (cairia em nivel_padrao)" });
      continue;
    }
    const ordem = ordemDoNivel(nivel);
    if (ordem < 0) {
      problemas.push({ tool: tool.name, motivo: `nível inválido no manifesto: ${JSON.stringify(nivel)}` });
      continue;
    }
    const universo = [...new Set([...declaradas, ...(reais ?? [])])];
    for (const rota of universo) {
      const classe = RISCO_DA_ROTA[rota];
      if (classe === undefined) {
        problemas.push({ tool: tool.name, motivo: `despacha "${rota}", sem classe de risco` });
        continue;
      }
      const minimo = NIVEL_MINIMO[classe];
      if (ordem < minimo) {
        problemas.push({
          tool: tool.name,
          motivo:
            `declarada ${String(nivel)} no manifesto, mas despacha "${rota}" (${classe}), ` +
            `que exige ao menos ${NIVEIS[minimo]}. ELEVAÇÃO DE PRIVILÉGIO PELO MCP.`,
        });
      }
    }
  }

  // Tool no manifesto que não existe mais no catálogo: o guarda de cobertura em
  // ci.sh já pega, mas repetir aqui é barato e mantém este script autossuficiente.
  const nomes = new Set(TOOLS.map((t) => t.name));
  for (const t of Object.keys(tools)) {
    if (!nomes.has(t)) problemas.push({ tool: t, motivo: "classificada no manifesto e inexistente em TOOLS" });
  }
  return problemas;
}

function tabela(): string {
  const linhas: string[] = ["rota\tclasse\tnivel_minimo"];
  for (const rota of Object.keys(RISCO_DA_ROTA).sort()) {
    const c = RISCO_DA_ROTA[rota]!;
    linhas.push(`${rota}\t${c}\t${NIVEIS[NIVEL_MINIMO[c]]}`);
  }
  return linhas.join("\n");
}

function main(): void {
  if (process.argv.includes("--tabela")) {
    console.log(tabela());
    return;
  }
  const manifesto = JSON.parse(fs.readFileSync(MANIFESTO, "utf8")) as Record<string, unknown>;
  const fonte = fs.readFileSync(TOOLS_TS, "utf8");
  const problemas = verificar(manifesto, fonte);
  if (problemas.length > 0) {
    console.error("MCP_RISK_COHERENT=NO");
    for (const p of problemas) console.error(`  - ${p.tool}: ${p.motivo}`);
    process.exit(1);
  }
  const rotas = Object.keys(RISCO_DA_ROTA).length;
  console.log(`MCP_RISK_COHERENT=YES (${TOOLS.length} tools, ${rotas} rotas classificadas)`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
