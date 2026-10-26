// Rectangles and points in image coordinates (pixels; x to the right, y down).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function isEmpty(r: Rect): boolean {
  return r.w <= 0 || r.h <= 0;
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : { x, y, w: 0, h: 0 };
}

export function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return { ...b };
  if (isEmpty(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** The whole pixels a (possibly fractional) rectangle touches. */
export function pixelBounds(x1: number, y1: number, x2: number, y2: number): Rect {
  const x = Math.floor(Math.min(x1, x2));
  const y = Math.floor(Math.min(y1, y2));
  return { x, y, w: Math.ceil(Math.max(x1, x2)) - x, h: Math.ceil(Math.max(y1, y2)) - y };
}

/** A rectangle grown by `n` pixels on every side. */
export function inflate(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 };
}

/** A rectangle from two corners (either order), inclusive of both. */
export function fromCorners(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
