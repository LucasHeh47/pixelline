// Mixing layers. The formulas are the W3C "Compositing and Blending" ones, which browsers use for
// canvas blend modes, so what's exported matches what the screen shows (and Photoshop's modes).
import type { ImageDoc } from './document';
import { intersect, isEmpty, type Rect } from './geom';
import type { BlendMode, Layer } from './layer';
import { Raster } from './raster';

type Sep = (cb: number, cs: number) => number;

const hardLight: Sep = (cb, cs) => (cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1));

const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  overlay: (cb, cs) => hardLight(cs, cb),
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  'color-dodge': (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))),
  'color-burn': (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)),
  'hard-light': hardLight,
  'soft-light': (cb, cs) => {
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cb + (2 * cs - 1) * (d - cb);
  },
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
};

// ----- hue, saturation, color, luminosity -----

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: [number, number, number]): [number, number, number] {
  const l = lum(...c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  if (n < 0) c = c.map((v) => l + ((v - l) * l) / (l - n)) as [number, number, number];
  if (x > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as [number, number, number];
  return c;
}

function setLum(c: [number, number, number], l: number): [number, number, number] {
  const d = l - lum(...c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const sat = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);

function setSat(c: [number, number, number], s: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [mn, md, mx] = idx;
  if (c[mx] > c[mn]) {
    out[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    out[mx] = s;
  }
  out[mn] = 0;
  return out;
}

function nonSeparable(mode: BlendMode, b: [number, number, number], s: [number, number, number]): [number, number, number] {
  switch (mode) {
    case 'hue':
      return setLum(setSat(s, sat(b)), lum(...b));
    case 'saturation':
      return setLum(setSat(b, sat(s)), lum(...b));
    case 'color':
      return setLum(s, lum(...b));
    default:
      return setLum(b, lum(...s));
  }
}

/**
 * Draws `src` (straight-alpha RGBA, `rect` sized) onto `dst` (same size) with a blend mode and
 * opacity (0–1). `mask` (0–255 per pixel), when given, scales the source's alpha.
 */
export function blendInto(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode, opacity: number, mask?: Uint8Array | null): void {
  const sep = SEPARABLE[mode];
  const nonSep = mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity';
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    let as = (src[i + 3] / 255) * opacity;
    if (mask) as *= mask[p] / 255;
    if (as <= 0) continue;
    const ab = dst[i + 3] / 255;
    const ao = as + ab * (1 - as);
    if (mode === 'normal' || ab === 0) {
      // Plain "over": the common case, kept fast
      const k = as / ao;
      dst[i] = dst[i] + (src[i] - dst[i]) * k;
      dst[i + 1] = dst[i + 1] + (src[i + 1] - dst[i + 1]) * k;
      dst[i + 2] = dst[i + 2] + (src[i + 2] - dst[i + 2]) * k;
      dst[i + 3] = ao * 255;
      continue;
    }
    const cb: [number, number, number] = [dst[i] / 255, dst[i + 1] / 255, dst[i + 2] / 255];
    const cs: [number, number, number] = [src[i] / 255, src[i + 1] / 255, src[i + 2] / 255];
    const mixed = nonSep ? nonSeparable(mode, cb, cs) : sep ? [sep(cb[0], cs[0]), sep(cb[1], cs[1]), sep(cb[2], cs[2])] : cs;
    for (let c = 0; c < 3; c++) {
      const co = as * (1 - ab) * cs[c] + as * ab * mixed[c] + (1 - as) * ab * cb[c];
      dst[i + c] = (co / ao) * 255;
    }
    dst[i + 3] = ao * 255;
  }
}

/** Draws one layer onto `dst`, which holds the image area `area`. */
export function compositeLayer(dst: Raster, area: Rect, layer: Layer, opts: { ignoreHidden?: boolean } = {}): void {
  if (!layer.visible && !opts.ignoreHidden) return;
  if (layer.opacity <= 0) return;
  const part = intersect(area, layer.bounds);
  if (isEmpty(part)) return;
  const local = { x: part.x - area.x, y: part.y - area.y, w: part.w, h: part.h };
  const below = dst.read(local);
  blendInto(below, layer.read(part), layer.blend, layer.opacity);
  dst.write(local, below);
}

/** The visible image (all visible layers mixed), for an area of it (the whole image by default). */
export function flatten(doc: ImageDoc, area: Rect = doc.bounds, layers: Layer[] = doc.layers): Raster {
  const out = new Raster(area.w, area.h);
  for (const layer of layers) compositeLayer(out, area, layer);
  return out;
}
