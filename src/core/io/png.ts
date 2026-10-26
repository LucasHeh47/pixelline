// PNG files, decoded and encoded exactly (no colour management or premultiplied rounding), so
// pixel art and semi-transparent pixels come back exactly as they were saved.
import { convertIndexedToRgb, decode, encode, hasPngSignature } from 'fast-png';
import { Raster } from '../raster';

export { hasPngSignature };

export function decodePng(bytes: Uint8Array): Raster {
  const png = decode(bytes);
  const { width: w, height: h } = png;
  const out = new Raster(w, h);
  const d = out.data;
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const ch = rgb.length / (w * h);
    for (let p = 0; p < w * h; p++) {
      d[p * 4] = rgb[p * ch];
      d[p * 4 + 1] = rgb[p * ch + 1];
      d[p * 4 + 2] = rgb[p * ch + 2];
      d[p * 4 + 3] = ch === 4 ? rgb[p * ch + 3] : 255;
    }
    return out;
  }
  const ch = png.channels;
  const src = png.data;
  const shift = png.depth === 16 ? 8 : 0;
  // Lower bit depths come out already unpacked to 0..(2^depth - 1)
  const scale = png.depth < 8 ? 255 / ((1 << png.depth) - 1) : 1;
  const v = (i: number) => (shift ? src[i] >> 8 : src[i] * scale);
  const key = png.transparency;
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    const o = p * 4;
    if (ch === 1 || ch === 2) {
      const g = v(i);
      d[o] = d[o + 1] = d[o + 2] = g;
      d[o + 3] = ch === 2 ? v(i + 1) : key && src[i] === key[0] ? 0 : 255;
    } else {
      d[o] = v(i);
      d[o + 1] = v(i + 1);
      d[o + 2] = v(i + 2);
      d[o + 3] = ch === 4 ? v(i + 3) : key && src[i] === key[0] && src[i + 1] === key[1] && src[i + 2] === key[2] ? 0 : 255;
    }
  }
  return out;
}

export interface PngOptions {
  /** Paletted PNG when the image has 256 colours or fewer (much smaller files for pixel art). */
  indexed?: boolean;
  /** 0–9; higher is smaller but slower. */
  level?: number;
}

export function encodePng(r: Raster, o: PngOptions = {}): Uint8Array {
  const zlib = { level: (o.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 };
  if (o.indexed !== false) {
    const indexed = toIndexed(r);
    if (indexed) return encode({ width: r.width, height: r.height, data: indexed.data, depth: 8, channels: 1, palette: indexed.palette }, { zlib });
  }
  // No transparency: a plain RGB file is a quarter smaller
  let opaque = true;
  for (let i = 3; i < r.data.length; i += 4)
    if (r.data[i] !== 255) {
      opaque = false;
      break;
    }
  if (opaque && r.width * r.height > 0) {
    const rgb = new Uint8Array(r.width * r.height * 3);
    for (let p = 0, i = 0; i < r.data.length; i += 4, p += 3) {
      rgb[p] = r.data[i];
      rgb[p + 1] = r.data[i + 1];
      rgb[p + 2] = r.data[i + 2];
    }
    return encode({ width: r.width, height: r.height, data: rgb, depth: 8, channels: 3 }, { zlib });
  }
  return encode({ width: r.width, height: r.height, data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length), depth: 8, channels: 4 }, { zlib });
}

/** A palette (up to 256 exact colours, transparency included) and indices, or null if there are more. */
function toIndexed(r: Raster): { data: Uint8Array; palette: number[][] } | null {
  const n = r.width * r.height;
  if (!n) return null;
  const px = new Uint32Array(r.data.buffer, r.data.byteOffset, n);
  const index = new Map<number, number>();
  const data = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    // Every fully transparent pixel is the same colour
    const v = r.data[p * 4 + 3] === 0 ? 0 : px[p];
    let k = index.get(v);
    if (k === undefined) {
      if (index.size >= 256) return null;
      k = index.size;
      index.set(v, k);
    }
    data[p] = k;
  }
  const bytes = new Uint8Array(4);
  const view = new Uint32Array(bytes.buffer);
  const colors = [...index.keys()].map((v) => {
    view[0] = v;
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  });
  // fast-png writes alpha (tRNS) only for colours that aren't opaque, in palette order, so those
  // must come first for the alpha values to line up with their colours
  const order = colors.map((_, i) => i).sort((a, b) => (colors[a][3] === 255 ? 1 : 0) - (colors[b][3] === 255 ? 1 : 0) || a - b);
  const translucent = colors.some((c) => c[3] !== 255);
  const palette = order.map((i) => (translucent ? colors[i] : colors[i].slice(0, 3)));
  const newIndex = new Uint8Array(colors.length);
  order.forEach((old, i) => (newIndex[old] = i));
  for (let p = 0; p < n; p++) data[p] = newIndex[data[p]];
  return { data, palette };
}
