// Fewer colours: palettes from images (median cut), mapping to a palette with or without
// dithering, and turning a photo or drawing into pixel art.
import { type RGBA } from './color';
import { Raster } from './raster';
import { resize } from './transform';

export type Dither = 'none' | 'floyd' | 'atkinson' | 'bayer2' | 'bayer4' | 'bayer8';

export const DITHER_LABELS: Record<Dither, string> = {
  none: 'None (flat colours)',
  floyd: 'Floyd–Steinberg (smooth)',
  atkinson: 'Atkinson (crisp, retro)',
  bayer2: 'Ordered 2×2 (checkerboard)',
  bayer4: 'Ordered 4×4',
  bayer8: 'Ordered 8×8',
};

function bayer(n: number): number[] {
  if (n === 1) return [0];
  const prev = bayer(n / 2);
  const half = n / 2;
  const out = new Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = prev[(y % half) * half + (x % half)] * 4;
      const q = (y < half ? 0 : 2) + (x < half ? 0 : 1);
      out[y * n + x] = v + [0, 2, 3, 1][q];
    }
  return out;
}

/** The distinct opaque colours of an image (stops counting after `max`). */
export function uniqueColors(src: Uint8ClampedArray, max = 4096): RGBA[] {
  const seen = new Set<number>();
  for (let i = 0; i < src.length && seen.size < max; i += 4) {
    if (src[i + 3] < 128) continue;
    seen.add((src[i] << 16) | (src[i + 1] << 8) | src[i + 2]);
  }
  return [...seen].map((v) => ({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 }));
}

/** A palette of up to `count` colours that represents the image well (median cut, then refined). */
export function makePalette(src: Uint8ClampedArray, count: number): RGBA[] {
  const pixels: number[][] = [];
  const step = Math.max(1, Math.floor(src.length / 4 / 200_000));
  for (let i = 0; i < src.length; i += 4 * step) if (src[i + 3] >= 128) pixels.push([src[i], src[i + 1], src[i + 2]]);
  if (!pixels.length) return [];
  const exact = uniqueColors(src, count + 1);
  if (exact.length <= count) return exact;
  let boxes = [pixels];
  while (boxes.length < count) {
    // Split the box with the widest colour range at its median
    let best = -1;
    let bestRange = -1;
    let bestCh = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const p of box) {
          if (p[c] < lo) lo = p[c];
          if (p[c] > hi) hi = p[c];
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          best = i;
          bestCh = c;
        }
      }
    });
    if (best < 0 || bestRange <= 0) break;
    const box = boxes[best].sort((p, q) => p[bestCh] - q[bestCh]);
    const mid = box.length >> 1;
    boxes = [...boxes.slice(0, best), box.slice(0, mid), box.slice(mid), ...boxes.slice(best + 1)];
  }
  let pal = boxes.map((box) => {
    const s = [0, 0, 0];
    for (const p of box) for (let c = 0; c < 3; c++) s[c] += p[c];
    return s.map((v) => v / box.length);
  });
  // A few k-means passes to fit the palette better
  for (let iter = 0; iter < 4; iter++) {
    const sums = pal.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      let bi = 0;
      let bd = Infinity;
      for (let k = 0; k < pal.length; k++) {
        const d = (p[0] - pal[k][0]) ** 2 * 0.3 + (p[1] - pal[k][1]) ** 2 * 0.59 + (p[2] - pal[k][2]) ** 2 * 0.11;
        if (d < bd) {
          bd = d;
          bi = k;
        }
      }
      const s = sums[bi];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    }
    pal = pal.map((c, k) => (sums[k][3] ? [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]] : c));
  }
  return pal.map(([r, g, b]) => ({ r: Math.round(r), g: Math.round(g), b: Math.round(b), a: 255 }));
}

/** The nearest palette colour (weighted RGB, close to how the eye sees differences). */
export function nearest(palette: RGBA[], r: number, g: number, b: number): number {
  let bi = 0;
  let bd = Infinity;
  for (let k = 0; k < palette.length; k++) {
    const c = palette[k];
    const rm = (r + c.r) / 2;
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bd) {
      bd = d;
      bi = k;
    }
  }
  return bi;
}

export interface RemapOptions {
  dither: Dither;
  /** 0–1: how strongly dithering spreads the error. */
  strength?: number;
  /** Pixels less opaque than this become transparent, the rest fully opaque (pixel art). Leave undefined to keep alpha. */
  alphaThreshold?: number;
}

/** Maps every pixel to a palette colour. */
export function remap(src: Uint8ClampedArray, w: number, h: number, palette: RGBA[], o: RemapOptions): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  if (!palette.length) return out;
  const strength = o.strength ?? 1;
  const cache = new Map<number, number>();
  const pick = (r: number, g: number, b: number) => {
    const key = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
    let k = cache.get(key);
    if (k === undefined) {
      k = nearest(palette, r, g, b);
      if (cache.size < 1 << 18) cache.set(key, k);
    }
    return k;
  };
  const alpha = (a: number) => (o.alphaThreshold === undefined ? a : a >= o.alphaThreshold ? 255 : 0);
  if (o.dither === 'floyd' || o.dither === 'atkinson') {
    const err = new Float32Array(w * h * 3);
    const spread: [number, number, number][] =
      o.dither === 'floyd'
        ? [
            [1, 0, 7 / 16],
            [-1, 1, 3 / 16],
            [0, 1, 5 / 16],
            [1, 1, 1 / 16],
          ]
        : [
            [1, 0, 1 / 8],
            [2, 0, 1 / 8],
            [-1, 1, 1 / 8],
            [0, 1, 1 / 8],
            [1, 1, 1 / 8],
            [0, 2, 1 / 8],
          ];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const i = p * 4;
        const a = alpha(src[i + 3]);
        out[i + 3] = a;
        if (!a) continue;
        const r = Math.max(0, Math.min(255, src[i] + err[p * 3]));
        const g = Math.max(0, Math.min(255, src[i + 1] + err[p * 3 + 1]));
        const b = Math.max(0, Math.min(255, src[i + 2] + err[p * 3 + 2]));
        const c = palette[pick(r, g, b)];
        out[i] = c.r;
        out[i + 1] = c.g;
        out[i + 2] = c.b;
        const e = [(r - c.r) * strength, (g - c.g) * strength, (b - c.b) * strength];
        for (const [dx, dy, wgt] of spread) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) continue;
          const q = (yy * w + xx) * 3;
          err[q] += e[0] * wgt;
          err[q + 1] += e[1] * wgt;
          err[q + 2] += e[2] * wgt;
        }
      }
    return out;
  }
  const size = o.dither === 'bayer2' ? 2 : o.dither === 'bayer4' ? 4 : o.dither === 'bayer8' ? 8 : 0;
  const matrix = size ? bayer(size).map((v) => (v + 0.5) / (size * size) - 0.5) : null;
  // How far apart the palette's colours are decides how much ordered dithering moves a pixel
  const spreadAmt = matrix ? (255 / Math.max(2, Math.cbrt(palette.length))) * strength : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = alpha(src[i + 3]);
      out[i + 3] = a;
      if (!a) continue;
      const t = matrix ? matrix[(y % size) * size + (x % size)] * spreadAmt : 0;
      const c = palette[pick(Math.max(0, Math.min(255, src[i] + t)), Math.max(0, Math.min(255, src[i + 1] + t)), Math.max(0, Math.min(255, src[i + 2] + t)))];
      out[i] = c.r;
      out[i + 1] = c.g;
      out[i + 2] = c.b;
    }
  return out;
}

export interface PixelArtOptions {
  width: number;
  height: number;
  /** Colours to use; when empty, a palette of `colors` colours is made from the picture. */
  palette?: RGBA[];
  colors: number;
  dither: Dither;
  /** Boosts contrast and saturation first: small pixel art reads better with punchy colours. */
  punch?: number;
  /** Pixels less opaque than this become transparent. */
  alphaThreshold?: number;
}

/**
 * Turns a picture into pixel art: shrinks it (averaging), optionally makes colours punchier, then
 * maps it to a small palette. Great for making block textures out of photos.
 */
export function toPixelArt(src: Raster, o: PixelArtOptions): Raster {
  const small = resize(src, o.width, o.height, 'area');
  const d = small.data;
  const punch = (o.punch ?? 0) / 100;
  if (punch) {
    for (let i = 0; i < d.length; i += 4) {
      const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
      for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] - avg) * (1 + punch * 0.8) + avg + (d[i + c] - 128) * punch * 0.3;
    }
  }
  const palette = o.palette?.length ? o.palette : makePalette(d, Math.max(2, o.colors));
  const out = remap(d, small.width, small.height, palette, { dither: o.dither, strength: 0.85, alphaThreshold: o.alphaThreshold ?? 128 });
  return new Raster(small.width, small.height, out);
}
