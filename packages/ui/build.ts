/**
 * Build da NOMOS Web (FASE 30/31/32).
 *
 * Por que existe um passo de build para uma página estática:
 *
 * O contrato de governança de marca proíbe copiar token para arquivo
 * intermediário — "tokens vivem no brandbook e são lidos de lá a cada uso"
 * (CONTRATO §6.3). Um `tokens.css` versionado neste repositório seria exatamente
 * esse arquivo intermediário: outras peças passariam a lê-lo em vez do cofre.
 *
 * Então: `src/app.html` não contém nenhuma cor. Este script lê o brandbook
 * vigente no cofre, confere a integridade contra SHA256SUMS, e injeta os tokens
 * ao gerar `dist/index.html` — que é artefato de build e não entra no git.
 *
 * Se a marca não resolver, o build FALHA. Não há fallback de cor.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER = path.join(process.env.HOME ?? "", ".brand-governance/bin/brand-resolve.sh");

export interface BrandResolution {
  marca: string;
  versao: string;
  fonte: string;
  oficial: boolean;
  /** rc do resolvedor. Consumidor testa rc != 0, nunca rc == 0. */
  rc: number;
}

export interface BrandTokens {
  cores: Record<string, string>;
  fontes: { mono: string; fallback: string[] };
  tagline: string;
  assinatura: string;
}

/**
 * Resolve a marca pelo resolvedor oficial. Nunca lê o registro por conta própria:
 * o resolvedor é a interface do consumidor e é ele que sabe quarentena, bloqueio
 * e ambiguidade.
 */
export function resolveBrand(marca: string): BrandResolution {
  if (!existsSync(RESOLVER)) {
    throw new Error(`marca: governança inacessível em ${RESOLVER} — build abortado (fail closed)`);
  }

  let rcOficial = 0;
  try {
    execFileSync(RESOLVER, ["--require-official", marca], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    rcOficial = (e as { status?: number }).status ?? 1;
  }

  let saida = "";
  let rc = 0;
  try {
    saida = execFileSync(RESOLVER, [marca], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    rc = err.status ?? 1;
    saida = err.stdout ?? "";
  }

  // rc 2 (governança inacessível/ambígua), 4 (quarentena) e 5 (bloqueado) não
  // devolvem caminho de token. Não há peça possível — pare e peça decisão.
  if (rc === 2 || rc === 4 || rc === 5 || saida.trim() === "") {
    throw new Error(`marca: "${marca}" não resolveu (rc=${rc}) — pare e peça decisão do dono`);
  }

  const campo = (nome: string): string => {
    const m = saida.match(new RegExp(`^\\s*${nome}\\s*:\\s*(.+)$`, "m"));
    return m === null ? "" : m[1]!.trim();
  };

  const fonte = campo("fonte");
  if (fonte === "") throw new Error(`marca: "${marca}" resolveu sem caminho de fonte — build abortado`);

  return { marca: campo("marca") || marca, versao: campo("versao vigente"), fonte, oficial: rcOficial === 0, rc };
}

/** Confere o brandbook contra o SHA256SUMS do cofre. Ler token de arquivo adulterado é pior que não ler. */
function verificarIntegridade(dir: string, arquivo: string): { verificado: boolean; sha256: string } {
  const alvo = path.join(dir, arquivo);
  const sha256 = createHash("sha256").update(readFileSync(alvo)).digest("hex");
  const somas = path.join(dir, "SHA256SUMS");
  if (!existsSync(somas)) return { verificado: false, sha256 };
  for (const linha of readFileSync(somas, "utf8").split("\n")) {
    const m = linha.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m !== null && path.basename(m[2]!.trim()) === arquivo) {
      if (m[1] !== sha256) {
        throw new Error(`marca: integridade FALHOU para ${arquivo} — o cofre não bate com SHA256SUMS`);
      }
      return { verificado: true, sha256 };
    }
  }
  return { verificado: false, sha256 };
}

/** Extrai tokens do brandbook. Ausência é ausência: não inventa cor nem preenche lacuna. */
export function lerTokens(fonte: string): { tokens: BrandTokens; integridade: { verificado: boolean; sha256: string } } {
  const arquivo = "BRANDBOOK_NOMOS.md";
  const integridade = verificarIntegridade(fonte, arquivo);
  const md = readFileSync(path.join(fonte, arquivo), "utf8");

  const slug = (s: string): string =>
    s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Chave primária é o NOME da cor; o `uso` vira apelido semântico apenas quando
  // é único. "Rosa" e "Ciano" têm ambos uso "acento": chavear por uso faria a
  // segunda sobrescrever a primeira em silêncio — perda de token sem aviso.
  const cores: Record<string, string> = {};
  const porUso: Record<string, string[]> = {};
  for (const linha of md.split("\n")) {
    const m = linha.match(/^\|\s*([^|]+?)\s*\|\s*`?(#[0-9A-Fa-f]{6})`?\s*\|\s*([^|]*?)\s*\|/);
    if (m === null) continue;
    const nome = slug(m[1]!);
    const uso = slug(m[3]!);
    if (nome === "" || nome === "cor") continue;
    const hex = m[2]!.toUpperCase();
    if (cores[nome] !== undefined && cores[nome] !== hex) {
      throw new Error(`marca: cor "${nome}" definida duas vezes com valores diferentes — brandbook ambíguo`);
    }
    cores[nome] = hex;
    if (uso !== "") (porUso[uso] ??= []).push(nome);
  }
  for (const [uso, nomes] of Object.entries(porUso)) {
    if (nomes.length === 1 && cores[uso] === undefined) cores[uso] = cores[nomes[0]!]!;
  }
  if (Object.keys(cores).length === 0) {
    throw new Error("marca: nenhuma cor encontrada no brandbook — build abortado, não invento paleta");
  }

  const mono = md.match(/Recomendada:\s*\*\*([^*]+)\*\*/);
  const fb = md.match(/Fallback:\s*([^\n]+(?:\n[^\n#|]+)?)/);
  const tagline = md.match(/Tagline:\s*\*([^*]+)\*/);
  const assinatura = md.match(/Assinatura curta:\s*\*([^*]+)\*/);

  return {
    tokens: {
      cores,
      fontes: {
        mono: mono === null ? "" : mono[1]!.trim(),
        fallback: fb === null ? [] : fb[1]!.replace(/\s+/g, " ").split(",").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean),
      },
      tagline: tagline === null ? "" : tagline[1]!.trim(),
      assinatura: assinatura === null ? "" : assinatura[1]!.trim(),
    },
    integridade,
  };
}

export function build(): { saida: string; resolucao: BrandResolution; selo: string } {
  const resolucao = resolveBrand("NOMOS");
  const { tokens, integridade } = lerTokens(resolucao.fonte);

  const vars = Object.entries(tokens.cores).map(([k, v]) => `      --nomos-${k}: ${v};`).join("\n");
  const famMono = [tokens.fontes.mono, ...tokens.fontes.fallback, "monospace"]
    .filter(Boolean)
    .map((f) => (f.includes(" ") ? `"${f}"` : f))
    .join(", ");

  // LEI art. 1.3: a peça declara marca e versão. Não sendo oficial, sai PROPOSTA.
  const selo = resolucao.oficial
    ? `NOMOS ${resolucao.versao} · OFICIAL`
    : `NOMOS ${resolucao.versao} · PROPOSTA — sem congelamento (LEI art. 6)`;

  const template = readFileSync(path.join(HERE, "src", "app.html"), "utf8");
  const html = template
    .replaceAll("/*__NOMOS_CORES__*/", vars)
    .replaceAll("__NOMOS_FONT_MONO__", famMono)
    .replaceAll("__NOMOS_SELO__", selo)
    .replaceAll("__NOMOS_TAGLINE__", tokens.tagline)
    .replaceAll("__NOMOS_ASSINATURA__", tokens.assinatura)
    .replaceAll("__NOMOS_INTEGRIDADE__", integridade.verificado ? `sha256 verificado ${integridade.sha256.slice(0, 12)}` : "sha256 NÃO verificado");

  // Guarda específico, não genérico. O `__NOMOS_` cru também casava com
  // `window.__NOMOS_TOKEN`, que o daemon injeta em tempo de execução e é
  // legítimo — o guarda passou a acusar o próprio produto.
  const PLACEHOLDERS = [
    "/*__NOMOS_CORES__*/",
    "__NOMOS_FONT_MONO__",
    "__NOMOS_SELO__",
    "__NOMOS_TAGLINE__",
    "__NOMOS_ASSINATURA__",
    "__NOMOS_INTEGRIDADE__",
  ];
  const sobraram = PLACEHOLDERS.filter((ph) => html.includes(ph));
  if (sobraram.length > 0) {
    throw new Error(`build: placeholder não substituído: ${sobraram.join(", ")}`);
  }

  const dist = path.join(HERE, "dist");
  mkdirSync(dist, { recursive: true });
  const saida = path.join(dist, "index.html");
  writeFileSync(saida, html);
  return { saida, resolucao, selo };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = build();
  console.log(`NOMOS Web gerada: ${r.saida}`);
  console.log(`marca: ${r.resolucao.marca} ${r.resolucao.versao} | oficial=${r.resolucao.oficial} | rc=${r.resolucao.rc}`);
  console.log(`selo: ${r.selo}`);
}
