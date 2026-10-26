// Pixel-art "inks": shading (lighter or darker, the way pixel artists shift hue as they shade),
// colour ramps, and dither patterns.
import { colorDistance, hslToRgb, luma, rgbToHsl, type RGBA } from './color';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Moves a hue toward a target hue by up to `amount` degrees (the short way round). */
function towardHue(h: number, target: number, amount: number): number {
  let d = target - h;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (h + Math.sign(d) * Math.min(Math.abs(d), amount) + 360) % 360;
}

/**
 * A lighter (dir 1) or darker (dir -1) shade of a colour. Like hand-picked pixel-art ramps,
 * lighter shades drift toward yellow and darker ones toward blue, and darker ones get a little
 * more saturated, so shading looks lively instead of grey.
 */
export function hueShift(c: RGBA, dir: 1 | -1, strength = 1): RGBA {
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  const step = 0.1 * strength;
  const grey = s < 0.06;
  const nh = grey ? h : towardHue(h, dir > 0 ? 55 : 235, 12 * strength);
  const ns = grey ? s : clamp01(dir > 0 ? s * (1 - 0.08 * strength) : s + (1 - s) * 0.12 * strength);
  const nl = clamp01(l + dir * step);
  const [r, g, b] = hslToRgb(nh, ns, nl);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: c.a };
}

/**
 * The next shade along the palette: colours of a similar hue, ordered from dark to light. Returns
 * null at the end of a ramp, or when nothing in the palette is close to the colour.
 */
export function paletteShade(c: RGBA, dir: 1 | -1, palette: RGBA[]): RGBA | null {
  if (palette.length < 2) return null;
  const [h, s] = rgbToHsl(c.r, c.g, c.b);
  const grey = s < 0.12;
  const sameFamily = (p: RGBA) => {
    const [ph, ps] = rgbToHsl(p.r, p.g, p.b);
    if (grey || ps < 0.12) return grey && ps < 0.12;
    const d = Math.abs(ph - h) % 360;
    return Math.min(d, 360 - d) <= 40;
  };
  const ramp = palette.filter(sameFamily).sort((a, b) => luma(a.r, a.g, a.b) - luma(b.r, b.g, b.b));
  if (!ramp.length) return null;
  // Where the colour sits on the ramp: an exact match, else the closest one
  let at = ramp.findIndex((p) => p.r === c.r && p.g === c.g && p.b === c.b);
  if (at < 0) {
    let best = Infinity;
    ramp.forEach((p, i) => {
      const d = colorDistance(p, c);
      if (d < best) {
        best = d;
        at = i;
      }
    });
    // Not on the ramp yet: the nearest ramp colour is the first step
    const near = ramp[at];
    const nl = luma(near.r, near.g, near.b);
    const cl = luma(c.r, c.g, c.b);
    if ((dir > 0 && nl > cl) || (dir < 0 && nl < cl)) return { ...near, a: c.a };
  }
  const next = ramp[at + dir];
  return next ? { ...next, a: c.a } : null;
}

/** A shading ramp around a colour: `count` colours from dark to light, with the colour in the middle. */
export function makeRamp(c: RGBA, count = 7): RGBA[] {
  const half = Math.floor(count / 2);
  const out: RGBA[] = [{ ...c, a: 255 }];
  let dark = out[0];
  let light = out[0];
  for (let i = 0; i < half; i++) {
    dark = hueShift(dark, -1);
    out.unshift(dark);
  }
  for (let i = 0; i < count - half - 1; i++) {
    light = hueShift(light, 1);
    out.push(light);
  }
  return out;
}

export type DitherPattern = 'checker' | 'light' | 'dark' | 'lines';

export const DITHER_PATTERNS: Record<DitherPattern, string> = {
  checker: 'Checkerboard (50%)',
  light: 'Light (25%)',
  dark: 'Dark (75%)',
  lines: 'Lines',
};

/** Whether a pixel is "on" in a dither pattern (patterns are fixed to the image, so strokes line up). */
export function ditherOn(pattern: DitherPattern, x: number, y: number): boolean {
  switch (pattern) {
    case 'checker':
      return ((x + y) & 1) === 0;
    case 'light':
      return (x & 1) === 0 && (y & 1) === 0;
    case 'dark':
      return !((x & 1) === 1 && (y & 1) === 1);
    case 'lines':
      return (y & 1) === 0;
  }
}
