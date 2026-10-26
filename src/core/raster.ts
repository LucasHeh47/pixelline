// A block of RGBA pixels (straight alpha, 4 bytes per pixel, rows top to bottom).
import type { RGBA } from './color';
import { intersect, isEmpty, type Rect } from './geom';

export class Raster {
  readonly data: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8ClampedArray,
  ) {
    if (width < 0 || height < 0 || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`Bad image size ${width}×${height}`);
    if (data && data.length !== width * height * 4) throw new Error(`Pixel data is ${data.length} bytes, expected ${width * height * 4}`);
    // 32-bit views (fast copies) need the pixels to start on a 4-byte boundary
    this.data = data ? (data.byteOffset % 4 ? new Uint8ClampedArray(data) : data) : new Uint8ClampedArray(width * height * 4);
  }

  static filled(width: number, height: number, c: RGBA): Raster {
    const r = new Raster(width, height);
    r.fill(c);
    return r;
  }

  get size(): Rect {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  /** Byte offset of a pixel, or -1 outside. */
  offset(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? (y * this.width + x) * 4 : -1;
  }

  get(x: number, y: number): RGBA {
    const i = this.offset(x, y);
    if (i < 0) return { r: 0, g: 0, b: 0, a: 0 };
    const d = this.data;
    return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
  }

  set(x: number, y: number, c: RGBA): void {
    const i = this.offset(x, y);
    if (i < 0) return;
    const d = this.data;
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
    d[i + 3] = c.a;
  }

  clone(): Raster {
    return new Raster(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  /** Copies a rectangle out (pixels outside the raster are transparent). */
  read(r: Rect): Uint8ClampedArray {
    const out = new Uint8ClampedArray(Math.max(0, r.w) * Math.max(0, r.h) * 4);
    const part = intersect(r, this.size);
    if (isEmpty(part)) return out;
    for (let y = part.y; y < part.y + part.h; y++) {
      const src = (y * this.width + part.x) * 4;
      const dst = ((y - r.y) * r.w + (part.x - r.x)) * 4;
      out.set(this.data.subarray(src, src + part.w * 4), dst);
    }
    return out;
  }

  /** Copies pixels in (the part of `r` outside the raster is skipped). */
  write(r: Rect, src: Uint8ClampedArray): void {
    const part = intersect(r, this.size);
    if (isEmpty(part)) return;
    for (let y = part.y; y < part.y + part.h; y++) {
      const from = ((y - r.y) * r.w + (part.x - r.x)) * 4;
      this.data.set(src.subarray(from, from + part.w * 4), (y * this.width + part.x) * 4);
    }
  }

  /** A new raster with the pixels of a rectangle (transparent outside). */
  crop(r: Rect): Raster {
    return new Raster(r.w, r.h, this.read(r));
  }

  fill(c: RGBA, r: Rect = this.size): void {
    const part = intersect(r, this.size);
    const d = this.data;
    for (let y = part.y; y < part.y + part.h; y++) {
      let i = (y * this.width + part.x) * 4;
      for (let x = 0; x < part.w; x++, i += 4) {
        d[i] = c.r;
        d[i + 1] = c.g;
        d[i + 2] = c.b;
        d[i + 3] = c.a;
      }
    }
  }

  clear(r: Rect = this.size): void {
    this.fill({ r: 0, g: 0, b: 0, a: 0 }, r);
  }

  /** The smallest rectangle holding every pixel that isn't fully transparent (empty when none). */
  contentBounds(): Rect {
    const { width: w, height: h, data: d } = this;
    let x1 = w;
    let y1 = h;
    let x2 = -1;
    let y2 = -1;
    for (let y = 0; y < h; y++) {
      let i = y * w * 4 + 3;
      for (let x = 0; x < w; x++, i += 4) {
        if (d[i] === 0) continue;
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        y2 = y;
      }
    }
    return x2 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
  }

  isTransparent(): boolean {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }
}

/** Whether a block of RGBA bytes is fully transparent. */
export function allTransparent(d: Uint8ClampedArray): boolean {
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}
