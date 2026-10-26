// Pixel-art upscaling. Plain nearest-neighbour makes blocky copies; Scale2x/Scale3x (EPX) round
// off diagonal edges using only the image's own colours, so the result still looks hand-drawn.
import { Raster } from './raster';

const px32 = (r: Raster) => new Uint32Array(r.data.buffer, r.data.byteOffset, r.width * r.height);

/** Scale2x / AdvMAME2x. */
export function scale2x(src: Raster): Raster {
  const { width: w, height: h } = src;
  const out = new Raster(w * 2, h * 2);
  const s = px32(src);
  const d = px32(out);
  const at = (x: number, y: number) => s[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const W = w * 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      const a = at(x, y - 1);
      const b = at(x + 1, y);
      const c = at(x - 1, y);
      const dd = at(x, y + 1);
      let e0 = p;
      let e1 = p;
      let e2 = p;
      let e3 = p;
      if (c === a && c !== dd && a !== b) e0 = a;
      if (a === b && a !== c && b !== dd) e1 = b;
      if (dd === c && dd !== b && c !== a) e2 = c;
      if (b === dd && b !== a && dd !== c) e3 = dd;
      const o = y * 2 * W + x * 2;
      d[o] = e0;
      d[o + 1] = e1;
      d[o + W] = e2;
      d[o + W + 1] = e3;
    }
  return out;
}

/** Scale3x / AdvMAME3x. */
export function scale3x(src: Raster): Raster {
  const { width: w, height: h } = src;
  const out = new Raster(w * 3, h * 3);
  const s = px32(src);
  const d = px32(out);
  const at = (x: number, y: number) => s[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const W = w * 3;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const A = at(x - 1, y - 1);
      const B = at(x, y - 1);
      const C = at(x + 1, y - 1);
      const D = at(x - 1, y);
      const E = at(x, y);
      const F = at(x + 1, y);
      const G = at(x - 1, y + 1);
      const H = at(x, y + 1);
      const I = at(x + 1, y + 1);
      const e = [E, E, E, E, E, E, E, E, E];
      if (B !== H && D !== F) {
        e[0] = D === B ? D : E;
        e[1] = (D === B && E !== C) || (B === F && E !== A) ? B : E;
        e[2] = B === F ? F : E;
        e[3] = (D === B && E !== G) || (D === H && E !== A) ? D : E;
        e[5] = (B === F && E !== I) || (H === F && E !== C) ? F : E;
        e[6] = D === H ? D : E;
        e[7] = (D === H && E !== I) || (H === F && E !== G) ? H : E;
        e[8] = H === F ? F : E;
      }
      const o = y * 3 * W + x * 3;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) d[o + j * W + i] = e[j * 3 + i];
    }
  return out;
}

/** Each pixel becomes an n×n block. */
export function scaleNearest(src: Raster, n: number): Raster {
  const out = new Raster(src.width * n, src.height * n);
  const s = px32(src);
  const d = px32(out);
  const W = src.width * n;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < W; x++) d[y * W + x] = s[Math.floor(y / n) * src.width + Math.floor(x / n)];
  return out;
}

export type Upscaler = 'nearest' | 'scale2x' | 'scale3x' | 'scale4x';

/** Upscales by 2, 3 or 4 with the chosen method. */
export function upscale(src: Raster, method: Upscaler, factor: 2 | 3 | 4): Raster {
  if (method === 'nearest') return scaleNearest(src, factor);
  if (method === 'scale3x' || factor === 3) return scale3x(src);
  if (method === 'scale4x' || factor === 4) return scale2x(scale2x(src));
  return scale2x(src);
}
