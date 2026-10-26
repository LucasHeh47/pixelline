// Resizing, rotating and flipping pixels. Colours are mixed with premultiplied alpha, so resizing
// a sprite doesn't leave dark fringes around it.
import { Raster } from './raster';

/**
 * - nearest: keeps hard pixels (pixel art; scaling 16×16 up to 64×64 makes clean 4×4 blocks)
 * - bilinear / bicubic: smooth (photos)
 * - area: averages every source pixel that falls in a target pixel (best for shrinking photos)
 */
export type Resample = 'nearest' | 'bilinear' | 'bicubic' | 'area';

export const RESAMPLE_LABELS: Record<Resample, string> = {
  nearest: 'Nearest neighbour (hard edges, pixel art)',
  bilinear: 'Bilinear (smooth)',
  bicubic: 'Bicubic (smoother, sharper)',
  area: 'Area average (best for shrinking)',
};

function premultiplied(src: Raster): Float32Array {
  const d = src.data;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a;
    out[i + 1] = d[i + 1] * a;
    out[i + 2] = d[i + 2] * a;
    out[i + 3] = d[i + 3];
  }
  return out;
}

function unpremultiply(p: Float32Array, out: Uint8ClampedArray): void {
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0.5) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    out[i] = p[i] * k;
    out[i + 1] = p[i + 1] * k;
    out[i + 2] = p[i + 2] * k;
    out[i + 3] = a;
  }
}

/** Catmull-Rom weights (bicubic). */
function cubic(t: number): number {
  const a = -0.5;
  t = Math.abs(t);
  if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
  if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
  return 0;
}

/** A resized copy. */
export function resize(src: Raster, w: number, h: number, method: Resample): Raster {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const out = new Raster(w, h);
  if (!src.width || !src.height) return out;
  const sw = src.width;
  const sh = src.height;
  if (method === 'nearest') {
    const s = src.data;
    const d = out.data;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
        const i = (sy * sw + sx) * 4;
        const o = (y * w + x) * 4;
        d[o] = s[i];
        d[o + 1] = s[i + 1];
        d[o + 2] = s[i + 2];
        d[o + 3] = s[i + 3];
      }
    }
    return out;
  }
  const p = premultiplied(src);
  const res = new Float32Array(w * h * 4);
  const px = (x: number, y: number, c: number) => p[((Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))) * 4) + c];
  if (method === 'area' && (w < sw || h < sh)) {
    // Box filter over the exact source footprint of each target pixel
    const fx = sw / w;
    const fy = sh / h;
    for (let y = 0; y < h; y++) {
      const y0 = y * fy;
      const y1 = y0 + fy;
      for (let x = 0; x < w; x++) {
        const x0 = x * fx;
        const x1 = x0 + fx;
        const acc = [0, 0, 0, 0];
        let total = 0;
        for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
          for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
            const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
            const wgt = wx * wy;
            for (let c = 0; c < 4; c++) acc[c] += px(sx, sy, c) * wgt;
            total += wgt;
          }
        }
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) res[o + c] = acc[c] / total;
      }
    }
  } else if (method === 'bicubic') {
    for (let y = 0; y < h; y++) {
      const fy = ((y + 0.5) * sh) / h - 0.5;
      const iy = Math.floor(fy);
      for (let x = 0; x < w; x++) {
        const fx = ((x + 0.5) * sw) / w - 0.5;
        const ix = Math.floor(fx);
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          let v = 0;
          for (let m = -1; m <= 2; m++) {
            const wy = cubic(fy - (iy + m));
            for (let n = -1; n <= 2; n++) v += px(ix + n, iy + m, c) * cubic(fx - (ix + n)) * wy;
          }
          res[o + c] = v;
        }
        // Ringing can push colours past the alpha they're premultiplied with
        const a = Math.max(0, Math.min(255, res[o + 3]));
        res[o + 3] = a;
        for (let c = 0; c < 3; c++) res[o + c] = Math.max(0, Math.min(a, res[o + c]));
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const fy = ((y + 0.5) * sh) / h - 0.5;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      for (let x = 0; x < w; x++) {
        const fx = ((x + 0.5) * sw) / w - 0.5;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          const top = px(ix, iy, c) * (1 - tx) + px(ix + 1, iy, c) * tx;
          const bottom = px(ix, iy + 1, c) * (1 - tx) + px(ix + 1, iy + 1, c) * tx;
          res[o + c] = top * (1 - ty) + bottom * ty;
        }
      }
    }
  }
  unpremultiply(res, out.data);
  return out;
}

export function flipH(src: Raster): Raster {
  const out = new Raster(src.width, src.height);
  const w = src.width;
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, w * src.height);
  const d = new Uint32Array(out.data.buffer);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < w; x++) d[y * w + x] = s[y * w + (w - 1 - x)];
  return out;
}

export function flipV(src: Raster): Raster {
  const out = new Raster(src.width, src.height);
  const row = src.width * 4;
  for (let y = 0; y < src.height; y++) out.data.set(src.data.subarray(y * row, y * row + row), (src.height - 1 - y) * row);
  return out;
}

/** Rotated a quarter turn clockwise (1), half (2) or counter-clockwise (3). */
export function rotate90(src: Raster, turns: 1 | 2 | 3): Raster {
  const { width: w, height: h } = src;
  const out = turns === 2 ? new Raster(w, h) : new Raster(h, w);
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, w * h);
  const d = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = s[y * w + x];
      if (turns === 1) d[x * h + (h - 1 - y)] = v;
      else if (turns === 2) d[(h - 1 - y) * w + (w - 1 - x)] = v;
      else d[(w - 1 - x) * h + y] = v;
    }
  return out;
}

/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m: Matrix, n: Matrix): Matrix {
  return { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f };
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c || 1e-12;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * Draws `src` through a transform (source pixel space → image space). Returns the new pixels and
 * where their top-left goes.
 */
export function transformRaster(src: Raster, m: Matrix, method: Resample): { raster: Raster; x: number; y: number } {
  const corners = [apply(m, 0, 0), apply(m, src.width, 0), apply(m, 0, src.height), apply(m, src.width, src.height)];
  const x0 = Math.floor(Math.min(...corners.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...corners.map((p) => p.y)));
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x)));
  const y1 = Math.ceil(Math.max(...corners.map((p) => p.y)));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Raster(w, h);
  if (!w || !h || !src.width || !src.height) return { raster: out, x: x0, y: y0 };
  const inv = invert(m);
  const sw = src.width;
  const sh = src.height;
  if (method === 'nearest') {
    const s = new Uint32Array(src.data.buffer, src.data.byteOffset, sw * sh);
    const d = new Uint32Array(out.data.buffer);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = apply(inv, x0 + x + 0.5, y0 + y + 0.5);
        const sx = Math.floor(p.x);
        const sy = Math.floor(p.y);
        if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) d[y * w + x] = s[sy * sw + sx];
      }
    return { raster: out, x: x0, y: y0 };
  }
  const p = premultiplied(src);
  const res = new Float32Array(w * h * 4);
  const at = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : p[(y * sw + x) * 4 + c]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = apply(inv, x0 + x + 0.5, y0 + y + 0.5);
      const fx = q.x - 0.5;
      const fy = q.y - 0.5;
      if (fx < -1 || fy < -1 || fx > sw || fy > sh) continue;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = at(ix, iy, c) * (1 - tx) + at(ix + 1, iy, c) * tx;
        const bottom = at(ix, iy + 1, c) * (1 - tx) + at(ix + 1, iy + 1, c) * tx;
        res[o + c] = top * (1 - ty) + bottom * ty;
      }
    }
  unpremultiply(res, out.data);
  return { raster: out, x: x0, y: y0 };
}
