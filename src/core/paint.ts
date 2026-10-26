// Brush strokes. A stroke keeps its own coverage map (how much of the brush each pixel has had,
// 0–1). Every dab raises the coverage and the pixels are recalculated from how they were before
// the stroke, so overlapping dabs never get darker than the stroke's opacity (like Photoshop's
// opacity vs. flow), and pixel-perfect lines can take a pixel back out.
//
// The same stroke paints, erases or locks transparency, mirrors itself (symmetry) and wraps around
// the image edges (for seamless textures).
import type { RGBA } from './color';
import type { Edit, ImageDoc } from './document';
import { intersect, isEmpty, union, type Rect } from './geom';
import type { Layer } from './layer';
import type { Mask } from './selection';

export interface BrushSettings {
  /** Diameter in pixels. */
  size: number;
  /** 0 = soft edge, 1 = hard edge. */
  hardness: number;
  /** The most a stroke can cover (0–1). */
  opacity: number;
  /** How much each dab adds (0–1). */
  flow: number;
  /** Distance between dabs, as a fraction of the size. */
  spacing: number;
  shape: 'round' | 'square';
  /** Off for pixel art: pixels are either painted or not. */
  antialias: boolean;
  /** Pen pressure changes the size / the flow. */
  pressureSize?: boolean;
  pressureFlow?: boolean;
}

export const PENCIL: BrushSettings = { size: 1, hardness: 1, opacity: 1, flow: 1, spacing: 0.1, shape: 'square', antialias: false };
export const SOFT_BRUSH: BrushSettings = { size: 24, hardness: 0.6, opacity: 1, flow: 1, spacing: 0.15, shape: 'round', antialias: true, pressureSize: true };

export type StrokeMode = 'paint' | 'erase';

export interface StrokeOptions {
  mode: StrokeMode;
  color: RGBA;
  brush: BrushSettings;
  /** Only selected pixels change. */
  selection?: Mask | null;
  /** Painting near an edge continues on the opposite edge. */
  wrap?: boolean;
  /** Mirror lines (image coordinates, e.g. width / 2), or undefined for none. */
  mirrorX?: number;
  mirrorY?: number;
  /** For 1-pixel lines: removes the extra pixel in L-shaped corners. */
  pixelPerfect?: boolean;
  /** Paints each pixel with a colour from elsewhere instead of `color` (the clone stamp). */
  colorAt?: (x: number, y: number) => RGBA | null;
}

const T = 64;

export class Stroke {
  private coverage = new Map<number, Float32Array>();
  private last: { x: number; y: number; p: number } | null = null;
  /** Distance left over since the last dab. */
  private carry = 0;
  /** Pixels of a 1-pixel stroke (one trail per mirror image), for pixel-perfect corners. */
  private trails: { x: number; y: number }[][] = [];
  /** Area changed since the last call to takeDirty(). */
  private dirty: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(
    readonly doc: ImageDoc,
    readonly layer: Layer,
    readonly edit: Edit,
    readonly opts: StrokeOptions,
  ) {}

  private get onePixel(): boolean {
    const b = this.opts.brush;
    return !b.antialias && b.size <= 1.5;
  }

  /** Starts (or continues) the stroke at a point (image coordinates; pressure 0–1). */
  moveTo(x: number, y: number, pressure = 1): void {
    if (!this.last) {
      this.last = { x, y, p: pressure };
      this.dab(x, y, pressure);
      return;
    }
    this.lineTo(x, y, pressure);
  }

  lineTo(x: number, y: number, pressure = 1): void {
    if (!this.last) return this.moveTo(x, y, pressure);
    const from = this.last;
    if (!this.opts.brush.antialias) {
      // Hard pixels: every pixel on the line, so it never has gaps
      const [x0, y0] = this.pixelCenter(from.x, from.y);
      const [x1, y1] = this.pixelCenter(x, y);
      const steps = line(Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1));
      for (let i = 1; i < steps.length; i++) {
        const t = i / (steps.length - 1);
        this.dab(steps[i].x + (x0 % 1), steps[i].y + (y0 % 1), from.p + (pressure - from.p) * t);
      }
      this.last = { x, y, p: pressure };
      return;
    }
    const dx = x - from.x;
    const dy = y - from.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(0.5, this.opts.brush.size * this.opts.brush.spacing);
    let d = step - this.carry;
    while (d <= dist) {
      const t = d / dist;
      this.dab(from.x + dx * t, from.y + dy * t, from.p + (pressure - from.p) * t);
      d += step;
    }
    this.carry = dist - (d - step);
    this.last = { x, y, p: pressure };
  }

  /** Where a hard brush of this size is centred for a pointer position (pixel centre or corner). */
  private pixelCenter(x: number, y: number): [number, number] {
    const size = Math.max(1, Math.round(this.opts.brush.size));
    if (size % 2) return [Math.floor(x) + 0.5, Math.floor(y) + 0.5];
    return [Math.round(x), Math.round(y)];
  }

  /** One dab of the brush, with its mirror images and wrapped copies. */
  dab(x: number, y: number, pressure = 1): void {
    const { mirrorX, mirrorY } = this.opts;
    const points: [number, number][] = [[x, y]];
    if (mirrorX !== undefined) points.push([2 * mirrorX - x, y]);
    if (mirrorY !== undefined) for (const [px, py] of [...points]) points.push([px, 2 * mirrorY - py]);
    points.forEach(([px, py], i) => this.stamp(px, py, pressure, i));
  }

  private stamp(x: number, y: number, pressure: number, copy = 0): void {
    const b = this.opts.brush;
    const size = Math.max(1, b.pressureSize ? b.size * Math.max(0.05, pressure) : b.size);
    const flow = Math.min(1, b.flow * (b.pressureFlow ? pressure : 1));
    if (!b.antialias) {
      [x, y] = this.pixelCenter(x, y);
      if (this.onePixel && this.opts.pixelPerfect) {
        const px = Math.floor(x);
        const py = Math.floor(y);
        const trail = (this.trails[copy] ??= []);
        const prev = trail[trail.length - 1];
        if (prev && prev.x === px && prev.y === py) return;
        trail.push({ x: px, y: py });
        this.fixCorner(trail);
      }
    }
    const r = size / 2;
    const bounds: Rect = { x: Math.floor(x - r - 1), y: Math.floor(y - r - 1), w: Math.ceil(size) + 3, h: Math.ceil(size) + 3 };
    const W = this.doc.width;
    const H = this.doc.height;
    const offsets: [number, number][] = [[0, 0]];
    if (this.opts.wrap) {
      for (const ox of [-W, 0, W])
        for (const oy of [-H, 0, H]) {
          if (!ox && !oy) continue;
          if (!isEmpty(intersect({ ...bounds, x: bounds.x + ox, y: bounds.y + oy }, this.doc.bounds))) offsets.push([ox, oy]);
        }
    }
    for (const [ox, oy] of offsets) {
      const area = intersect({ ...bounds, x: bounds.x + ox, y: bounds.y + oy }, this.doc.bounds);
      if (isEmpty(area)) continue;
      const cx = x + ox;
      const cy = y + oy;
      let changed = false;
      for (let py = area.y; py < area.y + area.h; py++)
        for (let px = area.x; px < area.x + area.w; px++) {
          const v = tipValue(px + 0.5 - cx, py + 0.5 - cy, r, b) * flow;
          if (v <= 0) continue;
          const m = this.cell(px, py, true)!;
          const i = (py & (T - 1)) * T + (px & (T - 1));
          const next = m[i] + (1 - m[i]) * v;
          if (next !== m[i]) {
            m[i] = next;
            changed = true;
          }
        }
      if (changed) this.render(area);
    }
  }

  /** Pixel-perfect: in an L-shaped corner (a, b, c), the middle pixel b is taken back out. */
  private fixCorner(t: { x: number; y: number }[]): void {
    if (t.length < 3) return;
    const a = t[t.length - 3];
    const b = t[t.length - 2];
    const c = t[t.length - 1];
    const near = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) === 1;
    if (near(a, b) && near(b, c) && Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1) {
      const m = this.cell(b.x, b.y, false);
      if (m) m[(b.y & (T - 1)) * T + (b.x & (T - 1))] = 0;
      t.splice(t.length - 2, 1);
      this.render({ x: b.x, y: b.y, w: 1, h: 1 });
    }
  }

  private cell(x: number, y: number, create: boolean): Float32Array | undefined {
    const key = (Math.floor(y / T) + 32768) * 65536 + (Math.floor(x / T) + 32768);
    let m = this.coverage.get(key);
    if (!m && create) this.coverage.set(key, (m = new Float32Array(T * T)));
    return m;
  }

  /** Recalculates pixels of `area` from the layer as it was before the stroke and the coverage. */
  private render(area: Rect): void {
    const { layer, edit, opts } = this;
    // Saved for undo before the layer grows, so undo can shrink it back
    edit.touch(layer, area);
    layer.ensure(area, this.doc.bounds);
    const orig = edit.original(layer, area);
    const out = new Uint8ClampedArray(orig);
    const sel = opts.selection;
    let { r: cr, g: cg, b: cb, a: ca } = opts.color;
    const colorAt = opts.colorAt;
    const erase = opts.mode === 'erase';
    const alphaLock = layer.alphaLocked && !erase;
    const opacity = opts.brush.opacity;
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++) {
        const px = area.x + x;
        const py = area.y + y;
        const m = this.cell(px, py, false);
        let k = m ? m[(py & (T - 1)) * T + (px & (T - 1))] * opacity : 0;
        if (sel) k *= sel.get(px, py) / 255;
        if (k <= 0) continue;
        const i = (y * area.w + x) * 4;
        if (erase) {
          out[i + 3] = orig[i + 3] * (1 - k);
          continue;
        }
        if (colorAt) {
          const c = colorAt(px, py);
          if (!c) continue;
          ({ r: cr, g: cg, b: cb, a: ca } = c);
        }
        const as = (ca / 255) * k;
        if (alphaLock) {
          // Recolor what's there, keeping its transparency
          if (!orig[i + 3]) continue;
          out[i] = orig[i] + (cr - orig[i]) * as;
          out[i + 1] = orig[i + 1] + (cg - orig[i + 1]) * as;
          out[i + 2] = orig[i + 2] + (cb - orig[i + 2]) * as;
          continue;
        }
        const ab = orig[i + 3] / 255;
        const ao = as + ab * (1 - as);
        const f = ao ? as / ao : 0;
        out[i] = orig[i] + (cr - orig[i]) * f;
        out[i + 1] = orig[i + 1] + (cg - orig[i + 1]) * f;
        out[i + 2] = orig[i + 2] + (cb - orig[i + 2]) * f;
        out[i + 3] = ao * 255;
      }
    layer.write(area, out);
    this.dirty = union(this.dirty, area);
    this.doc.emit({ type: 'pixels', layer, rect: area });
  }

  /** The area painted since the last call (for redrawing). */
  takeDirty(): Rect {
    const d = this.dirty;
    this.dirty = { x: 0, y: 0, w: 0, h: 0 };
    return d;
  }
}

/** How strongly a brush tip covers a pixel at offset (dx, dy) from its centre (0–1). */
export function tipValue(dx: number, dy: number, r: number, b: BrushSettings): number {
  if (b.shape === 'square') {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    if (!b.antialias) return d < r || (r <= 0.5 && d <= 0.5) ? 1 : 0;
    return Math.max(0, Math.min(1, r - d + 0.5));
  }
  const d = Math.hypot(dx, dy);
  if (!b.antialias) return d < r || (r <= 0.5 && d <= 0.5) ? 1 : 0;
  if (b.hardness >= 0.99) return Math.max(0, Math.min(1, r - d + 0.5));
  const inner = r * b.hardness;
  if (d <= inner) return 1;
  if (d >= r) return 0;
  const t = (d - inner) / (r - inner);
  return (1 - t * t) * (1 - t * t);
}

/** The pixels on a line between two pixels (Bresenham), both ends included. */
export function line(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}
