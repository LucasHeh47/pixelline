// Selections: an 8-bit mask the size of the image (0 = not selected, 255 = selected, values in
// between for soft edges). Tools and filters only change selected pixels.
import { intersect, isEmpty, type Point, type Rect } from './geom';

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

export class Mask {
  readonly data: Uint8Array;
  private cachedBounds: Rect | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(width * height);
  }

  static all(width: number, height: number): Mask {
    const m = new Mask(width, height);
    m.data.fill(255);
    return m;
  }

  static rect(width: number, height: number, r: Rect): Mask {
    const m = new Mask(width, height);
    const p = intersect(r, { x: 0, y: 0, w: width, h: height });
    for (let y = p.y; y < p.y + p.h; y++) m.data.fill(255, y * width + p.x, y * width + p.x + p.w);
    return m;
  }

  /** An ellipse filling `r`. With `antialias`, the edge pixels are partly selected. */
  static ellipse(width: number, height: number, r: Rect, antialias = false): Mask {
    const m = new Mask(width, height);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = r.w / 2;
    const ry = r.h / 2;
    if (rx <= 0 || ry <= 0) return m;
    const p = intersect(r, { x: 0, y: 0, w: width, h: height });
    const S = antialias ? 4 : 1;
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        let hits = 0;
        for (let sy = 0; sy < S; sy++)
          for (let sx = 0; sx < S; sx++) {
            const dx = (x + (sx + 0.5) / S - cx) / rx;
            const dy = (y + (sy + 0.5) / S - cy) / ry;
            if (dx * dx + dy * dy <= 1) hits++;
          }
        if (hits) m.data[y * width + x] = Math.round((hits * 255) / (S * S));
      }
    return m;
  }

  /** A polygon (lasso), filled with the even-odd rule; points are in image coordinates. */
  static polygon(width: number, height: number, pts: Point[], antialias = false): Mask {
    const m = new Mask(width, height);
    if (pts.length < 3) return m;
    const S = antialias ? 4 : 1;
    const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));
    const acc = new Uint16Array(width);
    for (let y = minY; y <= maxY; y++) {
      acc.fill(0);
      let any = false;
      for (let sy = 0; sy < S; sy++) {
        const yy = y + (sy + 0.5) / S;
        const xs: number[] = [];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[i];
          const b = pts[j];
          if (a.y <= yy !== b.y <= yy) xs.push(a.x + ((yy - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          // Sub-pixel columns whose centres fall inside the span
          const from = Math.max(0, Math.ceil(xs[k] * S - 0.5));
          const to = Math.min(width * S - 1, Math.floor(xs[k + 1] * S - 0.5));
          for (let sx = from; sx <= to; sx++) {
            acc[Math.floor(sx / S)]++;
            any = true;
          }
        }
      }
      if (!any) continue;
      for (let x = 0; x < width; x++) if (acc[x]) m.data[y * width + x] = Math.min(255, Math.round((acc[x] * 255) / (S * S)));
    }
    return m;
  }

  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.data[y * this.width + x] : 0;
  }

  clone(): Mask {
    return new Mask(this.width, this.height, new Uint8Array(this.data));
  }

  /** Call after changing `data` directly. */
  touched(): void {
    this.cachedBounds = null;
  }

  /** The smallest rectangle around the selected pixels (empty when nothing is selected). */
  get bounds(): Rect {
    if (this.cachedBounds) return this.cachedBounds;
    const { width: w, height: h, data: d } = this;
    let x1 = w;
    let y1 = h;
    let x2 = -1;
    let y2 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let first = -1;
      for (let x = 0; x < w; x++)
        if (d[row + x]) {
          first = x;
          break;
        }
      if (first < 0) continue;
      let last = first;
      for (let x = w - 1; x > first; x--)
        if (d[row + x]) {
          last = x;
          break;
        }
      if (first < x1) x1 = first;
      if (last > x2) x2 = last;
      if (y < y1) y1 = y;
      y2 = y;
    }
    this.cachedBounds = x2 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
    return this.cachedBounds;
  }

  isEmpty(): boolean {
    return isEmpty(this.bounds);
  }

  /** Combines with another selection of the same size. */
  combine(other: Mask, mode: SelectMode): Mask {
    if (mode === 'replace') return other.clone();
    const out = this.clone();
    const a = out.data;
    const b = other.data;
    for (let i = 0; i < a.length; i++) {
      if (mode === 'add') a[i] = Math.max(a[i], b[i]);
      else if (mode === 'subtract') a[i] = Math.max(0, a[i] - b[i]);
      else a[i] = Math.min(a[i], b[i]);
    }
    out.touched();
    return out;
  }

  inverted(): Mask {
    const out = this.clone();
    for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - out.data[i];
    out.touched();
    return out;
  }

  /** Grows (n > 0) or shrinks (n < 0) the selection by whole pixels. */
  grown(n: number): Mask {
    let cur = this.clone();
    const steps = Math.abs(Math.round(n));
    for (let s = 0; s < steps; s++) {
      const src = cur.data;
      const next = new Uint8Array(src.length);
      const { width: w, height: h } = this;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const nb = [src[i], x > 0 ? src[i - 1] : 0, x < w - 1 ? src[i + 1] : 0, y > 0 ? src[i - w] : 0, y < h - 1 ? src[i + w] : 0];
          next[i] = n > 0 ? Math.max(...nb) : Math.min(...nb);
        }
      cur = new Mask(w, h, next);
    }
    return cur;
  }

  /** Softens the edge by `radius` pixels (three box blurs, close to a Gaussian). */
  feathered(radius: number): Mask {
    const r = Math.max(0, Math.round(radius));
    if (!r) return this.clone();
    const { width: w, height: h } = this;
    const a = Float32Array.from(this.data);
    const b = new Float32Array(a.length);
    const box = Math.max(1, Math.round(r / 1.7));
    for (let pass = 0; pass < 3; pass++) {
      // Horizontal then vertical running sums
      for (let y = 0; y < h; y++) {
        let sum = 0;
        const row = y * w;
        for (let x = -box; x <= box; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          b[row + x] = sum / (box * 2 + 1);
          sum += a[row + Math.min(w - 1, x + box + 1)] - a[row + Math.max(0, x - box)];
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -box; y <= box; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / (box * 2 + 1);
          sum += b[Math.min(h - 1, y + box + 1) * w + x] - b[Math.max(0, y - box) * w + x];
        }
      }
    }
    return new Mask(w, h, Uint8Array.from(a, (v) => Math.round(v)));
  }

  /**
   * The selection's edge as line segments [x1, y1, x2, y2, …] between selected (≥ 128) and
   * unselected pixels, joined into runs (for drawing "marching ants").
   */
  outline(): Float32Array {
    const { width: w, height: h, data: d } = this;
    const b = this.bounds;
    const out: number[] = [];
    if (isEmpty(b)) return new Float32Array(0);
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[y * w + x] >= 128;
    // Horizontal edges at the top of each row y
    for (let y = b.y; y <= b.y + b.h; y++) {
      let start = -1;
      for (let x = b.x; x <= b.x + b.w; x++) {
        const edge = x < b.x + b.w && inside(x, y) !== inside(x, y - 1);
        if (edge && start < 0) start = x;
        else if (!edge && start >= 0) {
          out.push(start, y, x, y);
          start = -1;
        }
      }
    }
    // Vertical edges at the left of each column x
    for (let x = b.x; x <= b.x + b.w; x++) {
      let start = -1;
      for (let y = b.y; y <= b.y + b.h; y++) {
        const edge = y < b.y + b.h && inside(x, y) !== inside(x - 1, y);
        if (edge && start < 0) start = y;
        else if (!edge && start >= 0) {
          out.push(x, start, x, y);
          start = -1;
        }
      }
    }
    return Float32Array.from(out);
  }
}
