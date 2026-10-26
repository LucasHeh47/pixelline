// Adjustments and filters. Each one is described by its settings (so the app can build its
// dialog and live preview) and a function from pixels to pixels (RGBA, straight alpha).
import { hslToRgb, luma, rgbToHsl, type RGBA } from './color';

export type ParamType = 'range' | 'bool' | 'select' | 'color';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: [value: string, label: string][];
}

export type Params = Record<string, number | boolean | string>;

export interface FilterContext {
  /** The current colours (for filters that draw, like Outline). */
  fg: RGBA;
  bg: RGBA;
}

export interface FilterDef {
  id: string;
  name: string;
  group: 'Adjustments' | 'Blur' | 'Sharpen' | 'Noise' | 'Stylize' | 'Pixel art' | 'Textures' | 'Other';
  description: string;
  params: ParamDef[];
  /** How far (pixels) a result pixel looks at its neighbours. */
  reach?: (p: Params) => number;
  run(src: Uint8ClampedArray, w: number, h: number, p: Params, ctx: FilterContext): Uint8ClampedArray;
}

const n = (p: Params, k: string) => Number(p[k]);
const b = (p: Params, k: string) => p[k] === true || p[k] === 'true';

/** Applies a lookup table per colour channel (alpha unchanged). */
function lut(src: Uint8ClampedArray, r: Uint8ClampedArray, g = r, bl = r): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = r[src[i]];
    out[i + 1] = g[src[i + 1]];
    out[i + 2] = bl[src[i + 2]];
    out[i + 3] = src[i + 3];
  }
  return out;
}

function table(fn: (v: number) => number): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) t[v] = fn(v);
  return t;
}

function perPixel(src: Uint8ClampedArray, fn: (r: number, g: number, b: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, bl] = fn(src[i], src[i + 1], src[i + 2]);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = bl;
    out[i + 3] = src[i + 3];
  }
  return out;
}

// ---------- blur (on premultiplied colour, so edges of sprites don't darken) ----------

/** Separable blur with a 1D kernel. */
function convolve1d(src: Uint8ClampedArray, w: number, h: number, kernel: Float32Array, wrap = false): Uint8ClampedArray {
  const r = (kernel.length - 1) / 2;
  const pre = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    pre[i] = src[i] * a;
    pre[i + 1] = src[i + 1] * a;
    pre[i + 2] = src[i + 2] * a;
    pre[i + 3] = src[i + 3];
  }
  const tmp = new Float32Array(src.length);
  const idx = (v: number, size: number) => (wrap ? ((v % size) + size) % size : v < 0 ? 0 : v >= size ? size - 1 : v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = -r; k <= r; k++) {
        const i = (y * w + idx(x + k, w)) * 4;
        const wt = kernel[k + r];
        s0 += pre[i] * wt;
        s1 += pre[i + 1] * wt;
        s2 += pre[i + 2] * wt;
        s3 += pre[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = s0;
      tmp[o + 1] = s1;
      tmp[o + 2] = s2;
      tmp[o + 3] = s3;
    }
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = -r; k <= r; k++) {
        const i = (idx(y + k, h) * w + x) * 4;
        const wt = kernel[k + r];
        s0 += tmp[i] * wt;
        s1 += tmp[i + 1] * wt;
        s2 += tmp[i + 2] * wt;
        s3 += tmp[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      const a = s3 / 255;
      out[o] = a > 0 ? s0 / a : 0;
      out[o + 1] = a > 0 ? s1 / a : 0;
      out[o + 2] = a > 0 ? s2 / a : 0;
      out[o + 3] = s3;
    }
  return out;
}

export function gaussianKernel(radius: number): Float32Array {
  const sigma = Math.max(0.3, radius / 2);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

export function gaussianBlur(src: Uint8ClampedArray, w: number, h: number, radius: number, wrap = false): Uint8ClampedArray {
  if (radius <= 0) return new Uint8ClampedArray(src);
  return convolve1d(src, w, h, gaussianKernel(radius), wrap);
}

function boxBlur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  return convolve1d(src, w, h, new Float32Array(r * 2 + 1).fill(1 / (r * 2 + 1)));
}

/** 3×3 convolution of the colour channels (alpha kept). */
function convolve3(src: Uint8ClampedArray, w: number, h: number, k: number[], bias = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const xx = Math.min(w - 1, Math.max(0, x + i));
            const yy = Math.min(h - 1, Math.max(0, y + j));
            s += src[(yy * w + xx) * 4 + c] * k[(j + 1) * 3 + (i + 1)];
          }
        out[o + c] = s + bias;
      }
      out[o + 3] = src[o + 3];
    }
  return out;
}

// ---------- pixel art helpers ----------

/** Adds a 1-pixel (or thicker) outline around everything that isn't transparent. */
function outline(src: Uint8ClampedArray, w: number, h: number, color: RGBA, thickness: number, diagonal: boolean, inside: boolean): Uint8ClampedArray {
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 0;
  const out = new Uint8ClampedArray(src);
  let ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ring[y * w + x] = solid(x, y) ? 1 : 0;
  for (let t = 0; t < thickness; t++) {
    const next = new Uint8Array(ring);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const near = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h && ring[yy * w + xx] === 1;
        const nb = near(x - 1, y) || near(x + 1, y) || near(x, y - 1) || near(x, y + 1) || (diagonal && (near(x - 1, y - 1) || near(x + 1, y - 1) || near(x - 1, y + 1) || near(x + 1, y + 1)));
        if (inside) {
          // The outermost ring of the shape itself
          const empty = (xx: number, yy: number) => !(xx >= 0 && yy >= 0 && xx < w && yy < h) || ring[yy * w + xx] === 0;
          const edge = empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1) || (diagonal && (empty(x - 1, y - 1) || empty(x + 1, y - 1) || empty(x - 1, y + 1) || empty(x + 1, y + 1)));
          if (ring[p] === 1 && edge) next[p] = 2;
        } else if (ring[p] === 0 && nb) next[p] = 2;
      }
    for (let p = 0; p < next.length; p++)
      if (next[p] === 2) {
        const i = p * 4;
        out[i] = color.r;
        out[i + 1] = color.g;
        out[i + 2] = color.b;
        out[i + 3] = color.a;
        next[p] = inside ? 0 : 1;
      }
    ring = next;
  }
  return out;
}

/** Shifts the image, wrapping around (Photoshop's Offset: shows the seams of a texture). */
export function offsetWrap(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const s = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const d = new Uint32Array(out.buffer);
  dx = ((Math.round(dx) % w) + w) % w;
  dy = ((Math.round(dy) % h) + h) % h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[((y + dy) % h) * w + ((x + dx) % w)] = s[y * w + x];
  return out;
}

/**
 * Makes a texture tile without visible seams: each edge band is cross-faded with the opposite
 * edge, so the right edge leads into the left one.
 */
function makeSeamless(src: Uint8ClampedArray, w: number, h: number, band: number): Uint8ClampedArray {
  const bw = Math.max(1, Math.min(Math.floor(w / 2), Math.round((w * band) / 100)));
  const bh = Math.max(1, Math.min(Math.floor(h / 2), Math.round((h * band) / 100)));
  // Blend with a half-shifted copy, weighted so the edges come from the shifted one
  const shifted = offsetWrap(src, w, h, Math.floor(w / 2), Math.floor(h / 2));
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ex = Math.min(x, w - 1 - x);
      const ey = Math.min(y, h - 1 - y);
      const tx = Math.min(1, ex / bw);
      const ty = Math.min(1, ey / bh);
      const keep = Math.min(tx, ty);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[i + c] = src[i + c] * keep + shifted[i + c] * (1 - keep);
    }
  return out;
}

/** Makes a colour transparent, softly (GIMP's "Color to alpha"): great for removing a background. */
function colorToAlpha(src: Uint8ClampedArray, color: RGBA, threshold: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const t = Math.max(1, threshold);
  for (let i = 0; i < src.length; i += 4) {
    const d = Math.max(Math.abs(src[i] - color.r), Math.abs(src[i + 1] - color.g), Math.abs(src[i + 2] - color.b));
    if (d >= t) continue;
    const a = d / t;
    // Remove the background colour's contribution from what's left
    for (let c = 0; c < 3; c++) {
      const bg = [color.r, color.g, color.b][c];
      out[i + c] = a > 0 ? (src[i + c] - bg * (1 - a)) / a : 0;
    }
    out[i + 3] = src[i + 3] * a;
  }
  return out;
}

function median(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  const out = new Uint8ClampedArray(src.length);
  const vals: number[][] = [[], [], [], []];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (const v of vals) v.length = 0;
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          const yy = Math.min(h - 1, Math.max(0, y + j));
          const k = (yy * w + xx) * 4;
          for (let c = 0; c < 4; c++) vals[c].push(src[k + c]);
        }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        vals[c].sort((p, q) => p - q);
        out[o + c] = vals[c][vals[c].length >> 1];
      }
    }
  return out;
}

/** Deterministic noise so previews and results match. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

// ---------- the list ----------

export const FILTERS: FilterDef[] = [
  // Adjustments
  {
    id: 'brightnessContrast',
    name: 'Brightness / Contrast',
    group: 'Adjustments',
    description: 'Lightens or darkens, and spreads colours apart or together.',
    params: [
      { key: 'brightness', label: 'Brightness', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'range', min: -100, max: 100, default: 0 },
    ],
    run: (src, _w, _h, p) => {
      const br = n(p, 'brightness') * 1.5;
      const ct = n(p, 'contrast');
      const f = ct >= 0 ? 1 + ct / 50 : 1 + ct / 100;
      return lut(src, table((v) => (v + br - 127.5) * f + 127.5));
    },
  },
  {
    id: 'levels',
    name: 'Levels',
    group: 'Adjustments',
    description: 'Sets the black point, white point and midtones.',
    params: [
      { key: 'inBlack', label: 'Input black', type: 'range', min: 0, max: 253, default: 0 },
      { key: 'gamma', label: 'Midtones', type: 'range', min: 0.1, max: 9.99, step: 0.01, default: 1 },
      { key: 'inWhite', label: 'Input white', type: 'range', min: 2, max: 255, default: 255 },
      { key: 'outBlack', label: 'Output black', type: 'range', min: 0, max: 255, default: 0 },
      { key: 'outWhite', label: 'Output white', type: 'range', min: 0, max: 255, default: 255 },
    ],
    run: (src, _w, _h, p) => {
      const ib = n(p, 'inBlack');
      const iw = Math.max(ib + 1, n(p, 'inWhite'));
      const g = Math.max(0.01, n(p, 'gamma'));
      const ob = n(p, 'outBlack');
      const ow = n(p, 'outWhite');
      return lut(src, table((v) => ob + Math.pow(Math.min(1, Math.max(0, (v - ib) / (iw - ib))), 1 / g) * (ow - ob)));
    },
  },
  {
    id: 'hueSaturation',
    name: 'Hue / Saturation',
    group: 'Adjustments',
    description: 'Shifts colours around the colour wheel, and makes them more or less vivid.',
    params: [
      { key: 'hue', label: 'Hue', type: 'range', min: -180, max: 180, default: 0, unit: '°' },
      { key: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'lightness', label: 'Lightness', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'colorize', label: 'Colorize (one hue)', type: 'bool', default: false },
    ],
    run: (src, _w, _h, p) => {
      const dh = n(p, 'hue');
      const ds = n(p, 'saturation') / 100;
      const dl = n(p, 'lightness') / 100;
      const colorize = b(p, 'colorize');
      return perPixel(src, (r, g, bl) => {
        let [hh, s, l] = rgbToHsl(r, g, bl);
        if (colorize) {
          hh = (dh + 360) % 360;
          s = Math.max(0, Math.min(1, 0.25 + ds * 0.75));
        } else {
          hh += dh;
          s = ds >= 0 ? s + (1 - s) * ds * s : s * (1 + ds);
        }
        l = dl >= 0 ? l + (1 - l) * dl : l * (1 + dl);
        return hslToRgb(hh, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
      });
    },
  },
  {
    id: 'colorBalance',
    name: 'Color balance',
    group: 'Adjustments',
    description: 'Warms up or cools down the colours.',
    params: [
      { key: 'cr', label: 'Cyan ↔ Red', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'mg', label: 'Magenta ↔ Green', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'yb', label: 'Yellow ↔ Blue', type: 'range', min: -100, max: 100, default: 0 },
      { key: 'luminosity', label: 'Keep brightness', type: 'bool', default: true },
    ],
    run: (src, _w, _h, p) => {
      const d = [n(p, 'cr'), n(p, 'mg'), n(p, 'yb')].map((v) => v * 0.6);
      const keep = b(p, 'luminosity');
      return perPixel(src, (r, g, bl) => {
        // Strongest in the midtones
        const l = luma(r, g, bl) / 255;
        const wgt = 1 - Math.abs(l - 0.5) * 1.2;
        let nr = r + d[0] * wgt;
        let ng = g + d[1] * wgt;
        let nb = bl + d[2] * wgt;
        if (keep) {
          const diff = luma(r, g, bl) - luma(nr, ng, nb);
          nr += diff;
          ng += diff;
          nb += diff;
        }
        return [nr, ng, nb];
      });
    },
  },
  {
    id: 'exposure',
    name: 'Exposure',
    group: 'Adjustments',
    description: 'Brightens or darkens like changing a camera’s exposure (in stops).',
    params: [
      { key: 'stops', label: 'Exposure', type: 'range', min: -4, max: 4, step: 0.05, default: 0, unit: ' stops' },
      { key: 'gamma', label: 'Gamma', type: 'range', min: 0.2, max: 3, step: 0.01, default: 1 },
    ],
    run: (src, _w, _h, p) => {
      const k = Math.pow(2, n(p, 'stops'));
      const g = n(p, 'gamma');
      return lut(
        src,
        table((v) => {
          // In linear light, like a real exposure change
          const lin = Math.pow(v / 255, 2.2) * k;
          return Math.pow(Math.min(1, lin), 1 / 2.2 / g) * 255;
        }),
      );
    },
  },
  {
    id: 'vibrance',
    name: 'Vibrance',
    group: 'Adjustments',
    description: 'Boosts dull colours more than ones that are already vivid (keeps skin natural).',
    params: [{ key: 'amount', label: 'Vibrance', type: 'range', min: -100, max: 100, default: 30 }],
    run: (src, _w, _h, p) => {
      const amt = n(p, 'amount') / 100;
      return perPixel(src, (r, g, bl) => {
        // Dull colours (low saturation) get most of the boost
        const sat = (Math.max(r, g, bl) - Math.min(r, g, bl)) / 255;
        const k = 1 + amt * (1 - sat) * 1.5;
        const y = luma(r, g, bl);
        return [y + (r - y) * k, y + (g - y) * k, y + (bl - y) * k];
      });
    },
  },
  {
    id: 'invert',
    name: 'Invert',
    group: 'Adjustments',
    description: 'Turns every colour into its opposite.',
    params: [],
    run: (src) => lut(src, table((v) => 255 - v)),
  },
  {
    id: 'grayscale',
    name: 'Black & white',
    group: 'Adjustments',
    description: 'Removes colour, keeping how bright things look.',
    params: [{ key: 'tint', label: 'Sepia tint', type: 'range', min: 0, max: 100, default: 0 }],
    run: (src, _w, _h, p) => {
      const t = n(p, 'tint') / 100;
      return perPixel(src, (r, g, bl) => {
        const y = luma(r, g, bl);
        return [y + 40 * t, y + 15 * t, y - 25 * t];
      });
    },
  },
  {
    id: 'posterize',
    name: 'Posterize',
    group: 'Adjustments',
    description: 'Reduces each colour channel to a few levels.',
    params: [{ key: 'levels', label: 'Levels', type: 'range', min: 2, max: 64, default: 6 }],
    run: (src, _w, _h, p) => {
      const lv = Math.max(2, Math.round(n(p, 'levels')));
      return lut(src, table((v) => (Math.round((v / 255) * (lv - 1)) / (lv - 1)) * 255));
    },
  },
  {
    id: 'threshold',
    name: 'Threshold',
    group: 'Adjustments',
    description: 'Every pixel becomes black or white.',
    params: [{ key: 'level', label: 'Level', type: 'range', min: 1, max: 255, default: 128 }],
    run: (src, _w, _h, p) => {
      const t = n(p, 'level');
      return perPixel(src, (r, g, bl) => (luma(r, g, bl) >= t ? [255, 255, 255] : [0, 0, 0]));
    },
  },
  // Blur
  {
    id: 'gaussianBlur',
    name: 'Gaussian blur',
    group: 'Blur',
    description: 'A smooth, even blur.',
    params: [
      { key: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 100, step: 0.5, default: 4, unit: ' px' },
      { key: 'wrap', label: 'Wrap around edges (textures)', type: 'bool', default: false },
    ],
    reach: (p) => Math.ceil(n(p, 'radius') * 1.5) + 1,
    run: (src, w, h, p) => gaussianBlur(src, w, h, n(p, 'radius'), b(p, 'wrap')),
  },
  {
    id: 'boxBlur',
    name: 'Box blur',
    group: 'Blur',
    description: 'A quick blur that averages squares of pixels.',
    params: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 50, default: 3, unit: ' px' }],
    reach: (p) => Math.ceil(n(p, 'radius')) + 1,
    run: (src, w, h, p) => boxBlur(src, w, h, n(p, 'radius')),
  },
  {
    id: 'motionBlur',
    name: 'Motion blur',
    group: 'Blur',
    description: 'Blurs in one direction, like something moving fast.',
    params: [
      { key: 'distance', label: 'Distance', type: 'range', min: 1, max: 100, default: 12, unit: ' px' },
      { key: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, default: 0, unit: '°' },
    ],
    reach: (p) => Math.ceil(n(p, 'distance')) + 1,
    run: (src, w, h, p) => {
      const dist = Math.max(1, Math.round(n(p, 'distance')));
      const a = (n(p, 'angle') * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      const out = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const acc = [0, 0, 0, 0];
          for (let k = -dist; k <= dist; k++) {
            const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx * k)));
            const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy * k)));
            const i = (yy * w + xx) * 4;
            const al = src[i + 3] / 255;
            acc[0] += src[i] * al;
            acc[1] += src[i + 1] * al;
            acc[2] += src[i + 2] * al;
            acc[3] += src[i + 3];
          }
          const cnt = dist * 2 + 1;
          const o = (y * w + x) * 4;
          const al = acc[3] / cnt / 255;
          out[o] = al ? acc[0] / cnt / al : 0;
          out[o + 1] = al ? acc[1] / cnt / al : 0;
          out[o + 2] = al ? acc[2] / cnt / al : 0;
          out[o + 3] = acc[3] / cnt;
        }
      return out;
    },
  },
  // Sharpen
  {
    id: 'unsharpMask',
    name: 'Sharpen (unsharp mask)',
    group: 'Sharpen',
    description: 'Makes edges crisper.',
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 500, default: 80, unit: '%' },
      { key: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 20, step: 0.1, default: 1.5, unit: ' px' },
      { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, default: 2 },
    ],
    reach: (p) => Math.ceil(n(p, 'radius') * 1.5) + 1,
    run: (src, w, h, p) => {
      const blurred = gaussianBlur(src, w, h, n(p, 'radius'));
      const amt = n(p, 'amount') / 100;
      const th = n(p, 'threshold');
      const out = new Uint8ClampedArray(src);
      for (let i = 0; i < src.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const d = src[i + c] - blurred[i + c];
          if (Math.abs(d) >= th) out[i + c] = src[i + c] + d * amt;
        }
      return out;
    },
  },
  // Noise
  {
    id: 'addNoise',
    name: 'Add noise',
    group: 'Noise',
    description: 'Adds grain (also nice for natural-looking textures).',
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 100, default: 12 },
      { key: 'mono', label: 'Monochrome', type: 'bool', default: true },
      { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, default: 7 },
    ],
    run: (src, _w, _h, p) => {
      const amt = n(p, 'amount') * 2.55;
      const mono = b(p, 'mono');
      const rnd = rng(n(p, 'seed') * 9973);
      const out = new Uint8ClampedArray(src);
      for (let i = 0; i < src.length; i += 4) {
        if (!src[i + 3]) continue;
        const base = (rnd() - 0.5) * 2 * amt;
        for (let c = 0; c < 3; c++) out[i + c] = src[i + c] + (mono ? base : (rnd() - 0.5) * 2 * amt);
      }
      return out;
    },
  },
  {
    id: 'median',
    name: 'Despeckle (median)',
    group: 'Noise',
    description: 'Removes specks and grain while keeping edges.',
    params: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 6, default: 1, unit: ' px' }],
    reach: (p) => Math.ceil(n(p, 'radius')) + 1,
    run: (src, w, h, p) => median(src, w, h, n(p, 'radius')),
  },
  // Stylize
  {
    id: 'emboss',
    name: 'Emboss',
    group: 'Stylize',
    description: 'Makes the image look raised, like stamped metal.',
    params: [],
    reach: () => 2,
    run: (src, w, h) => convolve3(src, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2]),
  },
  {
    id: 'edges',
    name: 'Find edges',
    group: 'Stylize',
    description: 'Shows only the outlines in the picture.',
    params: [],
    reach: () => 2,
    run: (src, w, h) => {
      const gx = convolve3(src, w, h, [-1, 0, 1, -2, 0, 2, -1, 0, 1], 128);
      const gy = convolve3(src, w, h, [-1, -2, -1, 0, 0, 0, 1, 2, 1], 128);
      const out = new Uint8ClampedArray(src.length);
      for (let i = 0; i < src.length; i += 4) {
        for (let c = 0; c < 3; c++) out[i + c] = 255 - Math.hypot(gx[i + c] - 128, gy[i + c] - 128);
        out[i + 3] = src[i + 3];
      }
      return out;
    },
  },
  {
    id: 'vignette',
    name: 'Vignette',
    group: 'Stylize',
    description: 'Darkens the corners to draw the eye to the middle.',
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, default: 45 },
      { key: 'size', label: 'Size', type: 'range', min: 10, max: 100, default: 60 },
    ],
    run: (src, w, h, p) => {
      const amt = n(p, 'amount') / 100;
      const size = n(p, 'size') / 100;
      const out = new Uint8ClampedArray(src);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5) / w - 0.5;
          const dy = (y + 0.5) / h - 0.5;
          const d = Math.sqrt(dx * dx + dy * dy) / 0.7071;
          const t = Math.max(0, (d - size * 0.7) / (1 - size * 0.7));
          const f = 1 - amt * t * t;
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) out[i + c] = src[i + c] * f;
        }
      return out;
    },
  },
  {
    id: 'pixelate',
    name: 'Pixelate',
    group: 'Stylize',
    description: 'Turns the picture into big square blocks.',
    params: [{ key: 'size', label: 'Block size', type: 'range', min: 2, max: 128, default: 8, unit: ' px' }],
    run: (src, w, h, p) => {
      const s = Math.max(1, Math.round(n(p, 'size')));
      const out = new Uint8ClampedArray(src.length);
      for (let by = 0; by < h; by += s)
        for (let bx = 0; bx < w; bx += s) {
          const acc = [0, 0, 0, 0];
          let cnt = 0;
          for (let y = by; y < Math.min(h, by + s); y++)
            for (let x = bx; x < Math.min(w, bx + s); x++) {
              const i = (y * w + x) * 4;
              const al = src[i + 3] / 255;
              acc[0] += src[i] * al;
              acc[1] += src[i + 1] * al;
              acc[2] += src[i + 2] * al;
              acc[3] += src[i + 3];
              cnt++;
            }
          const al = acc[3] / cnt / 255;
          for (let y = by; y < Math.min(h, by + s); y++)
            for (let x = bx; x < Math.min(w, bx + s); x++) {
              const o = (y * w + x) * 4;
              out[o] = al ? acc[0] / cnt / al : 0;
              out[o + 1] = al ? acc[1] / cnt / al : 0;
              out[o + 2] = al ? acc[2] / cnt / al : 0;
              out[o + 3] = acc[3] / cnt;
            }
        }
      return out;
    },
  },
  // Pixel art
  {
    id: 'outline',
    name: 'Outline',
    group: 'Pixel art',
    description: 'Draws an outline in the foreground colour around everything that isn’t transparent (sprites, items).',
    params: [
      { key: 'thickness', label: 'Thickness', type: 'range', min: 1, max: 8, default: 1, unit: ' px' },
      { key: 'diagonal', label: 'Include corners', type: 'bool', default: false },
      { key: 'inside', label: 'Inside the shape', type: 'bool', default: false },
    ],
    reach: (p) => Math.ceil(n(p, 'thickness')) + 1,
    run: (src, w, h, p, ctx) => outline(src, w, h, ctx.fg, Math.max(1, Math.round(n(p, 'thickness'))), b(p, 'diagonal'), b(p, 'inside')),
  },
  {
    id: 'colorToAlpha',
    name: 'Color to transparency',
    group: 'Pixel art',
    description: 'Makes the background colour (the secondary colour) transparent, keeping soft edges clean.',
    params: [{ key: 'threshold', label: 'Softness', type: 'range', min: 1, max: 255, default: 40 }],
    run: (src, _w, _h, p, ctx) => colorToAlpha(src, ctx.bg, n(p, 'threshold')),
  },
  // Textures
  {
    id: 'offset',
    name: 'Offset (wrap around)',
    group: 'Textures',
    description: 'Shifts the image with wrap-around, so the seams of a tiling texture come to the middle where you can fix them.',
    params: [
      { key: 'dx', label: 'Right', type: 'range', min: -2048, max: 2048, default: 0, unit: ' px' },
      { key: 'dy', label: 'Down', type: 'range', min: -2048, max: 2048, default: 0, unit: ' px' },
      { key: 'half', label: 'Half the size', type: 'bool', default: true },
    ],
    run: (src, w, h, p) => (b(p, 'half') ? offsetWrap(src, w, h, Math.floor(w / 2), Math.floor(h / 2)) : offsetWrap(src, w, h, n(p, 'dx'), n(p, 'dy'))),
  },
  {
    id: 'seamless',
    name: 'Make seamless',
    group: 'Textures',
    description: 'Blends each edge into the opposite one so the texture tiles without visible seams.',
    params: [{ key: 'band', label: 'Blend width', type: 'range', min: 5, max: 50, default: 25, unit: '%' }],
    run: (src, w, h, p) => makeSeamless(src, w, h, n(p, 'band')),
  },
];

export const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

export function defaults(f: FilterDef): Params {
  const p: Params = {};
  for (const d of f.params) p[d.key] = d.default;
  return p;
}
