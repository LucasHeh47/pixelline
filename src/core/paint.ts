// Brush strokes. A stroke keeps its own coverage map (how much of the brush each pixel has had,
// 0–1). Every dab raises the coverage and the pixels are recalculated from how they were before
// the stroke, so overlapping dabs never get darker than the stroke's opacity (like Photoshop's
// opacity vs. flow), and pixel-perfect lines can take a pixel back out.
//
// The same stroke paints, erases or locks transparency, mirrors itself (symmetry) and wraps around
// the image edges (for seamless textures).
//
// Big brushes stay fast: dabs only change the coverage, and the pixels are worked out once per
// pointer move, just in the 64×64 blocks that changed. A hard tip is kept as one run of pixels per
// row, so each dab only visits the pixels the previous dab didn't already cover.
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
  /**
   * Paints each pixel with its own colour instead of `color`: from elsewhere (the clone stamp),
   * from a pattern (dithering) or from what's under it (shading). null leaves the pixel alone.
   */
  colorAt?: (x: number, y: number, under: RGBA) => RGBA | null;
}

const T = 64;

const blockKey = (x: number, y: number) => (Math.floor(y / T) + 32768) * 65536 + (Math.floor(x / T) + 32768);

/** A hard tip as one run of covered pixels per row, measured from the dab's top-left corner. */
interface Runs {
  from: Int32Array;
  to: Int32Array;
}

const runsCache = new Map<string, Runs>();

/** The runs of a hard (not antialiased) tip of a size, centred at a fraction of a pixel. */
function hardRuns(size: number, fx: number, fy: number, b: BrushSettings, w: number, h: number, ox: number, oy: number): Runs {
  const key = `${size}|${b.shape}|${fx}|${fy}|${w}|${h}`;
  let runs = runsCache.get(key);
  if (runs) return runs;
  const r = size / 2;
  runs = { from: new Int32Array(h), to: new Int32Array(h) };
  for (let j = 0; j < h; j++) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < w; i++) {
      if (tipValue(i + 0.5 - ox, j + 0.5 - oy, r, b) <= 0) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first >= 0) {
      runs.from[j] = first;
      runs.to[j] = last + 1;
    }
  }
  if (runsCache.size > 64) runsCache.clear();
  runsCache.set(key, runs);
  return runs;
}

export class Stroke {
  private coverage = new Map<number, Float32Array>();
  /** Blocks whose coverage changed since the pixels were last worked out, with the changed part. */
  private pending = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  /** Where each mirror image's last hard dab went (its pixels are fully covered already). */
  private lastRuns: ({ runs: Runs; x: number; y: number } | undefined)[] = [];
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
      this.flush();
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
      this.flush();
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
    this.flush();
  }

  /** Where a hard brush of this size is centred for a pointer position (pixel centre or corner). */
  private pixelCenter(x: number, y: number): [number, number] {
    const size = Math.max(1, Math.round(this.opts.brush.size));
    if (size % 2) return [Math.floor(x) + 0.5, Math.floor(y) + 0.5];
    return [Math.round(x), Math.round(y)];
  }

  /** One dab of the brush, with its mirror images and wrapped copies (pixels change on takeDirty()). */
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
    // A full-strength hard tip covers whole pixels, so only the ones the last dab missed can change
    const runs = !b.antialias && flow >= 1 && !this.onePixel ? hardRuns(size, x - Math.floor(x), y - Math.floor(y), b, bounds.w, bounds.h, x - bounds.x, y - bounds.y) : null;
    const prev = this.lastRuns[copy];
    const after = runs && prev?.runs === runs ? prev : null;
    for (const [ox, oy] of offsets) {
      const area = intersect({ ...bounds, x: bounds.x + ox, y: bounds.y + oy }, this.doc.bounds);
      if (isEmpty(area)) continue;
      if (runs) this.stampRuns(runs, bounds.x + ox, bounds.y + oy, after && { runs, x: after.x + ox, y: after.y + oy }, area);
      else this.stampTip(x + ox, y + oy, r, flow, area);
    }
    this.lastRuns[copy] = runs ? { runs, x: bounds.x, y: bounds.y } : undefined;
  }

  /** A hard dab at full strength: its rows of pixels, less those the previous dab covered. */
  private stampRuns(runs: Runs, bx: number, by: number, prev: { runs: Runs; x: number; y: number } | null, area: Rect): void {
    const h = runs.from.length;
    for (let j = 0; j < h; j++) {
      const y = by + j;
      if (y < area.y || y >= area.y + area.h || runs.from[j] >= runs.to[j]) continue;
      const s = Math.max(area.x, bx + runs.from[j]);
      const e = Math.min(area.x + area.w, bx + runs.to[j]);
      if (s >= e) continue;
      const jp = prev ? y - prev.y : -1;
      if (prev && jp >= 0 && jp < h && prev.runs.from[jp] < prev.runs.to[jp]) {
        const ps = prev.x + prev.runs.from[jp];
        const pe = prev.x + prev.runs.to[jp];
        if (ps < e && pe > s) {
          if (s < ps) this.cover(y, s, ps);
          if (pe < e) this.cover(y, pe, e);
          continue;
        }
      }
      this.cover(y, s, e);
    }
  }

  /** Fully covers pixels x0 ≤ x < x1 of a row. */
  private cover(y: number, x0: number, x1: number): void {
    const row = (y & (T - 1)) * T;
    for (let x = x0; x < x1; ) {
      const end = Math.min(x1, (Math.floor(x / T) + 1) * T);
      const m = this.cell(x, y, true)!;
      let a = -1;
      let z = -1;
      for (let px = x; px < end; px++) {
        const i = row + (px & (T - 1));
        if (m[i] === 1) continue;
        m[i] = 1;
        if (a < 0) a = px;
        z = px;
      }
      if (a >= 0) this.mark(a, z, y);
      x = end;
    }
  }

  /** Any other dab: the tip's strength at every pixel it reaches. */
  private stampTip(cx: number, cy: number, r: number, flow: number, area: Rect): void {
    const b = this.opts.brush;
    // No tip reaches farther than this from its centre
    const reach = r + 1;
    for (let py = area.y; py < area.y + area.h; py++) {
      const dy = py + 0.5 - cy;
      let x0 = area.x;
      let x1 = area.x + area.w;
      if (b.shape === 'round') {
        const q = reach * reach - dy * dy;
        if (q <= 0) continue;
        const half = Math.sqrt(q);
        x0 = Math.max(x0, Math.floor(cx - half - 0.5));
        x1 = Math.min(x1, Math.ceil(cx + half + 0.5));
      }
      const row = (py & (T - 1)) * T;
      for (let x = x0; x < x1; ) {
        const end = Math.min(x1, (Math.floor(x / T) + 1) * T);
        let m = this.cell(x, py, false);
        let a = -1;
        let z = -1;
        for (let px = x; px < end; px++) {
          const v = tipValue(px + 0.5 - cx, dy, r, b) * flow;
          if (v <= 0) continue;
          m ??= this.cell(px, py, true)!;
          const i = row + (px & (T - 1));
          const next = m[i] + (1 - m[i]) * v;
          if (next === m[i]) continue;
          m[i] = next;
          if (a < 0) a = px;
          z = px;
        }
        if (a >= 0) this.mark(a, z, py);
        x = end;
      }
    }
  }

  /** Notes that coverage changed in pixels x0…x1 of a row (all in one block). */
  private mark(x0: number, x1: number, y: number): void {
    const key = blockKey(x0, y);
    const d = this.pending.get(key);
    if (!d) {
      this.pending.set(key, { x0, y0: y, x1, y1: y });
      return;
    }
    if (x0 < d.x0) d.x0 = x0;
    if (x1 > d.x1) d.x1 = x1;
    if (y < d.y0) d.y0 = y;
    if (y > d.y1) d.y1 = y;
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
      this.mark(b.x, b.x, b.y);
    }
  }

  private cell(x: number, y: number, create: boolean): Float32Array | undefined {
    const key = blockKey(x, y);
    let m = this.coverage.get(key);
    if (!m && create) this.coverage.set(key, (m = new Float32Array(T * T)));
    return m;
  }

  /** Works out the pixels whose coverage changed, from the layer as it was before the stroke. */
  private flush(): void {
    if (!this.pending.size) return;
    const rects: Rect[] = [];
    let all: Rect = { x: 0, y: 0, w: 0, h: 0 };
    for (const d of this.pending.values()) {
      const r = { x: d.x0, y: d.y0, w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 };
      rects.push(r);
      all = union(all, r);
    }
    this.pending.clear();
    const { layer, edit } = this;
    // Saved for undo before the layer grows, so undo can shrink it back
    for (const r of rects) edit.touch(layer, r);
    layer.ensure(all, this.doc.bounds);
    for (const r of rects) this.render(r);
    this.dirty = union(this.dirty, all);
    this.doc.emit({ type: 'pixels', layer, rect: all });
  }

  /** Recalculates the pixels of `area` (inside one block) from the original pixels and the coverage. */
  private render(area: Rect): void {
    const { layer, edit, opts } = this;
    const m = this.cell(area.x, area.y, false);
    if (!m) return;
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
        let k = m[(py & (T - 1)) * T + (px & (T - 1))] * opacity;
        if (sel) k *= sel.get(px, py) / 255;
        if (k <= 0) continue;
        const i = (y * area.w + x) * 4;
        if (erase) {
          out[i + 3] = orig[i + 3] * (1 - k);
          continue;
        }
        if (colorAt) {
          const c = colorAt(px, py, { r: orig[i], g: orig[i + 1], b: orig[i + 2], a: orig[i + 3] });
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
  }

  /** The area painted since the last call (for redrawing). */
  takeDirty(): Rect {
    this.flush();
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
  const d = Math.sqrt(dx * dx + dy * dy);
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
