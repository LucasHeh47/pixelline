// Colors: 8-bit RGBA with straight (not premultiplied) alpha, plus conversions to HSV/HSL and hex.

export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0–255 */
  a: number;
}

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return { r, g, b, a };
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Parses #rgb, #rgba, #rrggbb or #rrggbbaa (the # is optional). */
export function parseHex(s: string): RGBA | null {
  let h = s.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 255 };
}

/** #rrggbb, or #rrggbbaa when not opaque. */
export function toHex(c: RGBA, withAlpha = c.a < 255): string {
  const x = (v: number) => byte(v).toString(16).padStart(2, '0');
  return `#${x(c.r)}${x(c.g)}${x(c.b)}${withAlpha ? x(c.a) : ''}`;
}

export function cssColor(c: RGBA): string {
  return c.a >= 255 ? toHex(c, false) : `rgba(${c.r}, ${c.g}, ${c.b}, ${+(c.a / 255).toFixed(3)})`;
}

export function sameColor(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** One 32-bit number per color (for maps and fast comparisons). */
export function pack(c: RGBA): number {
  return ((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a) >>> 0;
}

export function unpack(n: number): RGBA {
  return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 };
}

/** Hue 0–360, saturation and value 0–1. */
export function rgbToHsv(c: RGBA): { h: number; s: number; v: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h: number, s: number, v: number, a = 255): RGBA {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a };
}

/** Hue 0–360, saturation and lightness 0–1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = (((h % 360) + 360) % 360) / 360;
  return [hue(p, q, hh + 1 / 3) * 255, hue(p, q, hh) * 255, hue(p, q, hh - 1 / 3) * 255];
}

/** Perceived brightness 0–255 (Rec. 601 weights, as Photoshop's grayscale uses). */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** A simple perceptual distance (weighted RGB, "redmean"), 0 for equal colors. */
export function colorDistance(a: RGBA, b: RGBA): number {
  const rm = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: byte(a.r + (b.r - a.r) * t), g: byte(a.g + (b.g - a.g) * t), b: byte(a.b + (b.b - a.b) * t), a: byte(a.a + (b.a - a.a) * t) };
}
