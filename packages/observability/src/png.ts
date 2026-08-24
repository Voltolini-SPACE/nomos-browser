/**
 * Decodificador PNG mínimo (8-bit, não-entrelaçado, RGB/RGBA/Gray/GrayAlpha).
 *
 * Existe para uma razão específica: permitir que o NOMOS Browser Runtime
 * VERIFIQUE mecanicamente que um screenshot corresponde às coordenadas do DOM,
 * em vez de apenas afirmar que "o screenshot funcionou". Sem decodificar o
 * pixel não há evidência — há alegação.
 *
 * Sem dependência externa: usa apenas node:zlib.
 */
import { inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  /** RGBA de 8 bits, sempre 4 canais, comprimento = width*height*4 */
  rgba: Uint8Array;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Lê apenas o IHDR. Barato — use quando só as dimensões importam. */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("png: assinatura inválida");
  }
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("png: IHDR ausente");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(buf: Buffer): DecodedPng {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("png: assinatura inválida");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // len + type(4) + data + crc(4)
  }

  if (bitDepth !== 8) throw new Error(`png: bitDepth ${bitDepth} não suportado (só 8)`);
  if (interlace !== 0) throw new Error("png: entrelaçado (Adam7) não suportado");
  if (idat.length === 0) throw new Error("png: sem IDAT");

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) throw new Error(`png: colorType ${colorType} não suportado`);
  if (colorType === 3 && palette === null) throw new Error("png: colorType 3 sem PLTE");

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels; // bitDepth 8 => 1 byte por canal
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]!;
    for (let i = 0; i < stride; i++) cur[i] = raw[rp + i]!;
    rp += stride;

    // Desfiltragem conforme RFC 2083 §6
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0; // esquerda
      const b = prev[i]!; // acima
      const c = i >= bpp ? prev[i - bpp]! : 0; // acima-esquerda
      let v = cur[i]!;
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default: throw new Error(`png: filtro ${filter} inválido na linha ${y}`);
      }
      cur[i] = v;
    }

    // Normaliza para RGBA
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      if (colorType === 6) {
        out[d] = cur[s]!; out[d + 1] = cur[s + 1]!; out[d + 2] = cur[s + 2]!; out[d + 3] = cur[s + 3]!;
      } else if (colorType === 2) {
        out[d] = cur[s]!; out[d + 1] = cur[s + 1]!; out[d + 2] = cur[s + 2]!; out[d + 3] = 255;
      } else if (colorType === 0) {
        const g = cur[s]!;
        out[d] = g; out[d + 1] = g; out[d + 2] = g; out[d + 3] = 255;
      } else if (colorType === 4) {
        const g = cur[s]!;
        out[d] = g; out[d + 1] = g; out[d + 2] = g; out[d + 3] = cur[s + 1]!;
      } else {
        const idx = cur[s]! * 3;
        out[d] = palette![idx]!; out[d + 1] = palette![idx + 1]!; out[d + 2] = palette![idx + 2]!; out[d + 3] = 255;
      }
    }
    prev.set(cur);
  }

  return { width, height, channels, rgba: out };
}

export function pixelAt(png: DecodedPng, x: number, y: number): Rgb {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= png.width || py >= png.height) {
    throw new Error(`png: pixel (${px},${py}) fora de ${png.width}x${png.height}`);
  }
  const d = (py * png.width + px) * 4;
  return { r: png.rgba[d]!, g: png.rgba[d + 1]!, b: png.rgba[d + 2]!, a: png.rgba[d + 3]! };
}

/** Distância euclidiana em RGB. Tolera antialiasing/compressão sem virar "qualquer cor passa". */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
