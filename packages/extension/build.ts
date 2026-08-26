/**
 * Build da extensão NOMOS (side panel).
 *
 * Mesma regra da NOMOS Web: `src/` não contém NENHUM token de marca. As cores
 * e fontes entram AQUI, lidas do cofre vigente via o resolvedor oficial
 * (reusa `packages/ui/build.ts` — uma só implementação de governança).
 * `dist/` é artefato de build e não entra no git.
 *
 * Os ícones também nascem aqui: PNG sólido na cor da marca, gerado por código
 * (zlib do Node) — nenhum binário versionado, nenhuma cor fora do cofre.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrand, lerTokens } from "../ui/build.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── PNG sólido ───────────────────────────────────────────────────────────────
function crc32(buf: Buffer): number {
  let c = ~0 >>> 0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo: string, dados: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([len, corpo, crc]);
}

/** Quadrado da cor da marca com borda escura — reconhecível em 16px. */
export function pngSolido(tamanho: number, hex: string): Buffer {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const borda = Math.max(1, Math.round(tamanho / 16));
  const linhas: Buffer[] = [];
  for (let y = 0; y < tamanho; y++) {
    const linha = Buffer.alloc(1 + tamanho * 4);
    for (let x = 0; x < tamanho; x++) {
      const naBorda = x < borda || y < borda || x >= tamanho - borda || y >= tamanho - borda;
      const o = 1 + x * 4;
      if (naBorda) {
        linha[o] = Math.round(r * 0.25);
        linha[o + 1] = Math.round(g * 0.25);
        linha[o + 2] = Math.round(b * 0.25);
      } else {
        linha[o] = r; linha[o + 1] = g; linha[o + 2] = b;
      }
      linha[o + 3] = 255;
    }
    linhas.push(linha);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamanho, 0);
  ihdr.writeUInt32BE(tamanho, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(linhas))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── build ────────────────────────────────────────────────────────────────────
export interface ExtensionBuild {
  dist: string;
  selo: string;
  corMarca: string;
}

export function buildExtension(): ExtensionBuild {
  const resolucao = resolveBrand("NOMOS");
  const { tokens, integridade } = lerTokens(resolucao.fonte);

  const corMarca = tokens.cores["marca"] ?? tokens.cores["verde-neon"];
  if (corMarca === undefined) {
    throw new Error("marca: brandbook sem cor primária ('marca') — build abortado");
  }

  const vars = Object.entries(tokens.cores).map(([k, v]) => `      --nomos-${k}: ${v};`).join("\n");
  const famMono = [tokens.fontes.mono, ...tokens.fontes.fallback, "monospace"]
    .filter(Boolean)
    .map((f) => (f.includes(" ") ? `"${f}"` : f))
    .join(", ");
  const selo = resolucao.oficial
    ? `NOMOS ${resolucao.versao} · OFICIAL`
    : `NOMOS ${resolucao.versao} · PROPOSTA — sem congelamento (LEI art. 6)`;

  const template = readFileSync(path.join(HERE, "src", "sidepanel.html"), "utf8");
  const html = template
    .replaceAll("/*__NOMOS_CORES__*/", vars)
    .replaceAll("__NOMOS_FONT_MONO__", famMono)
    .replaceAll("__NOMOS_SELO__", selo)
    .replaceAll("__NOMOS_TAGLINE__", tokens.tagline)
    .replaceAll("__NOMOS_ASSINATURA__", tokens.assinatura);

  const PLACEHOLDERS = [
    "/*__NOMOS_CORES__*/", "__NOMOS_FONT_MONO__", "__NOMOS_SELO__",
    "__NOMOS_TAGLINE__", "__NOMOS_ASSINATURA__",
  ];
  const sobraram = PLACEHOLDERS.filter((ph) => html.includes(ph));
  if (sobraram.length > 0) {
    throw new Error(`build: placeholder não substituído: ${sobraram.join(", ")}`);
  }

  const dist = path.join(HERE, "dist");
  mkdirSync(path.join(dist, "icons"), { recursive: true });
  // `local-runtime.json` é o handshake de auto-conexão que o DAEMON grava em
  // tempo de execução (ver daemon.ts) — nunca um artefato de build. Remove
  // qualquer resíduo de uma execução anterior para que todo build nasça
  // pristino: um handshake velho apontaria o painel para um runtime morto.
  rmSync(path.join(dist, "local-runtime.json"), { force: true });
  writeFileSync(path.join(dist, "sidepanel.html"), html);
  copyFileSync(path.join(HERE, "src", "sidepanel.js"), path.join(dist, "sidepanel.js"));
  copyFileSync(path.join(HERE, "src", "background.js"), path.join(dist, "background.js"));
  copyFileSync(path.join(HERE, "src", "manifest.json"), path.join(dist, "manifest.json"));
  for (const t of [16, 48, 128]) {
    writeFileSync(path.join(dist, "icons", `${t}.png`), pngSolido(t, corMarca));
  }
  if (integridade.verificado === false) {
    console.error("[extensao] aviso: brandbook sem SHA256SUMS conferido");
  }
  return { dist, selo, corMarca };
}

const executadoDireto = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  const r = buildExtension();
  console.log(`extensão construída em ${r.dist} (${r.selo})`);
}
