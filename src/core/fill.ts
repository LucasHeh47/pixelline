// Flood fill and the magic wand: finding the pixels that match a starting pixel.
import type { RGBA } from './color';
import { Mask } from './selection';

export interface MatchOptions {
  /** How different a pixel may be (0–255 in any channel, transparency included). */
  tolerance: number;
  /** Only pixels connected to the start (otherwise every matching pixel in the image). */
  contiguous: boolean;
  /** Diagonal neighbours count as connected. */
  diagonal?: boolean;
}

/**
 * The pixels of `src` (image-sized RGBA) that match the colour at (x, y), as a mask. Fully
 * transparent pixels all count as the same colour, whatever their RGB.
 */
export function matchRegion(src: Uint8ClampedArray, width: number, height: number, x: number, y: number, o: MatchOptions): Mask {
  const mask = new Mask(width, height);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const s = (y * width + x) * 4;
  const r0 = src[s];
  const g0 = src[s + 1];
  const b0 = src[s + 2];
  const a0 = src[s + 3];
  const tol = Math.max(0, Math.min(255, o.tolerance));
  const matches = (i: number) => {
    const a = src[i + 3];
    if (a0 === 0 && a === 0) return true;
    if (Math.abs(a - a0) > tol) return false;
    // Very transparent pixels: their colour hardly shows
    if (a0 === 0 || a === 0) return Math.abs(a - a0) <= tol;
    return Math.abs(src[i] - r0) <= tol && Math.abs(src[i + 1] - g0) <= tol && Math.abs(src[i + 2] - b0) <= tol;
  };
  const m = mask.data;
  if (!o.contiguous) {
    for (let p = 0, i = 0; p < m.length; p++, i += 4) if (matches(i)) m[p] = 255;
    mask.touched();
    return mask;
  }
  // Scanline fill: fills a run, then looks for runs above and below it
  const stack: number[] = [x, y];
  while (stack.length) {
    const sy = stack.pop()!;
    const sx = stack.pop()!;
    let lx = sx;
    const row = sy * width;
    if (m[row + lx] || !matches((row + lx) * 4)) continue;
    while (lx > 0 && !m[row + lx - 1] && matches((row + lx - 1) * 4)) lx--;
    let rx = sx;
    while (rx < width - 1 && !m[row + rx + 1] && matches((row + rx + 1) * 4)) rx++;
    m.fill(255, row + lx, row + rx + 1);
    const from = o.diagonal ? Math.max(0, lx - 1) : lx;
    const to = o.diagonal ? Math.min(width - 1, rx + 1) : rx;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let nx = from; nx <= to; nx++) {
        const ok = !m[nrow + nx] && matches((nrow + nx) * 4);
        if (ok && !inRun) stack.push(nx, ny);
        inRun = ok;
      }
    }
  }
  mask.touched();
  return mask;
}

/**
 * Paints a colour onto `dst` (image-sized RGBA) where `mask` is set, mixed by the mask and opacity.
 * With `keepAlpha`, only the colour of non-transparent pixels changes.
 */
export function paintMask(dst: Uint8ClampedArray, mask: Mask, color: RGBA, opacity = 1, keepAlpha = false): void {
  const m = mask.data;
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    if (!m[p]) continue;
    const as = (color.a / 255) * opacity * (m[p] / 255);
    if (keepAlpha) {
      if (!dst[i + 3]) continue;
      dst[i] += (color.r - dst[i]) * as;
      dst[i + 1] += (color.g - dst[i + 1]) * as;
      dst[i + 2] += (color.b - dst[i + 2]) * as;
      continue;
    }
    const ab = dst[i + 3] / 255;
    const ao = as + ab * (1 - as);
    const f = ao ? as / ao : 0;
    dst[i] += (color.r - dst[i]) * f;
    dst[i + 1] += (color.g - dst[i + 1]) * f;
    dst[i + 2] += (color.b - dst[i + 2]) * f;
    dst[i + 3] = ao * 255;
  }
}

/** Every pixel exactly this colour becomes another one (pixel-art palette swaps). */
export function replaceColor(dst: Uint8ClampedArray, from: RGBA, to: RGBA, tolerance = 0, mask?: Mask | null): number {
  let n = 0;
  for (let p = 0, i = 0; i < dst.length; p++, i += 4) {
    if (mask && !mask.data[p]) continue;
    if (dst[i + 3] === 0 && from.a === 0) continue;
    if (Math.abs(dst[i] - from.r) > tolerance || Math.abs(dst[i + 1] - from.g) > tolerance || Math.abs(dst[i + 2] - from.b) > tolerance || Math.abs(dst[i + 3] - from.a) > tolerance) continue;
    dst[i] = to.r;
    dst[i + 1] = to.g;
    dst[i + 2] = to.b;
    dst[i + 3] = to.a;
    n++;
  }
  return n;
}
