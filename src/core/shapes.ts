// Shapes for the shape tools and gradients.
import type { RGBA } from './color';
import type { Point, Rect } from './geom';
import type { Mask } from './selection';

/** The outline pixels of an ellipse that fills `r` exactly (midpoint algorithm, pixel-art clean). */
export function ellipsePixels(r: Rect): Point[] {
  const out: Point[] = [];
  if (r.w <= 0 || r.h <= 0) return out;
  if (r.w <= 2 || r.h <= 2) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
    return out;
  }
  // Works on a doubled grid so even sizes are symmetric too
  const a = r.w - 1;
  const b = r.h - 1;
  const cx2 = r.x * 2 + a;
  const cy2 = r.y * 2 + b;
  const seen = new Set<number>();
  const plot = (dx2: number, dy2: number) => {
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const x = (cx2 + sx * dx2) / 2;
      const y = (cy2 + sy * dy2) / 2;
      const key = y * 100000 + x;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  };
  // Step along the larger axis, picking the nearest pixel on the other one (both octants)
  const rx = a / 2;
  const ry = b / 2;
  const evenX = a % 2;
  const evenY = b % 2;
  for (let dx2 = evenX; dx2 <= a; dx2 += 2) {
    const dx = dx2 / 2;
    const dy = ry * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2));
    const dy2 = Math.round(dy - evenY / 2) * 2 + evenY;
    plot(dx2, dy2);
  }
  for (let dy2 = evenY; dy2 <= b; dy2 += 2) {
    const dy = dy2 / 2;
    const dx = rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
    const dx2 = Math.round(dx - evenX / 2) * 2 + evenX;
    plot(dx2, dy2);
  }
  return out;
}

/** The outline pixels of a rectangle (1 pixel wide). */
export function rectPixels(r: Rect): Point[] {
  const out: Point[] = [];
  if (r.w <= 0 || r.h <= 0) return out;
  for (let x = r.x; x < r.x + r.w; x++) {
    out.push({ x, y: r.y });
    if (r.h > 1) out.push({ x, y: r.y + r.h - 1 });
  }
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    out.push({ x: r.x, y });
    if (r.w > 1) out.push({ x: r.x + r.w - 1, y });
  }
  return out;
}

export type GradientKind = 'linear' | 'radial' | 'angle' | 'diamond' | 'reflected';

/** 4×4 ordered (Bayer) dither thresholds, 0–1. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export interface GradientOptions {
  kind: GradientKind;
  from: Point;
  to: Point;
  colors: [RGBA, RGBA];
  /** 0 = smooth; n > 0 = n flat bands (pixel-art shading). */
  steps?: number;
  /** Ordered dithering between bands (with `steps`) or to hide banding. */
  dither?: boolean;
  opacity?: number;
}

/** Where a pixel falls along a gradient (0–1). */
function position(k: GradientKind, x: number, y: number, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy || 1;
  const px = x - from.x;
  const py = y - from.y;
  switch (k) {
    case 'radial':
      return Math.sqrt((px * px + py * py) / len2);
    case 'angle': {
      const a = Math.atan2(py, px) - Math.atan2(dy, dx);
      return ((a / (Math.PI * 2)) % 1 + 1) % 1;
    }
    case 'diamond': {
      const len = Math.sqrt(len2);
      const ux = dx / len;
      const uy = dy / len;
      return (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
    }
    case 'reflected':
      return Math.abs((px * dx + py * dy) / len2);
    default:
      return (px * dx + py * dy) / len2;
  }
}

/** Draws a gradient onto `dst` (an image-sized RGBA buffer), only where `mask` allows. */
export function drawGradient(dst: Uint8ClampedArray, width: number, height: number, o: GradientOptions, mask?: Mask | null): void {
  const [c0, c1] = o.colors;
  const opacity = o.opacity ?? 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const m = mask ? mask.data[p] / 255 : 1;
      if (m <= 0) continue;
      let t = Math.max(0, Math.min(1, position(o.kind, x + 0.5, y + 0.5, o.from, o.to)));
      if (o.steps && o.steps > 1) {
        const n = o.steps;
        const f = t * (n - 1);
        let band = Math.floor(f);
        if (o.dither && f - band > BAYER4[(y & 3) * 4 + (x & 3)]) band++;
        else if (!o.dither) band = Math.round(f);
        t = Math.min(n - 1, band) / (n - 1);
      } else if (o.dither) t = Math.max(0, Math.min(1, t + (BAYER4[(y & 3) * 4 + (x & 3)] - 0.5) / 255));
      const r = c0.r + (c1.r - c0.r) * t;
      const g = c0.g + (c1.g - c0.g) * t;
      const b = c0.b + (c1.b - c0.b) * t;
      const a = ((c0.a + (c1.a - c0.a) * t) / 255) * opacity * m;
      const i = p * 4;
      const ab = dst[i + 3] / 255;
      const ao = a + ab * (1 - a);
      const f = ao ? a / ao : 0;
      dst[i] += (r - dst[i]) * f;
      dst[i + 1] += (g - dst[i + 1]) * f;
      dst[i + 2] += (b - dst[i + 2]) * f;
      dst[i + 3] = ao * 255;
    }
}
