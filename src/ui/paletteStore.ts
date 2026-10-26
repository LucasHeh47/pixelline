// The palettes the app knows: built-in ones plus the user's own (saved in preferences).
import { flatten } from '../core/blend';
import { luma, parseHex, toHex, type RGBA } from '../core/color';
import type { ImageDoc } from '../core/document';
import { BUILTIN_PALETTES, type Palette } from '../core/palettes';
import { uniqueColors } from '../core/quantize';
import type { App } from './app';

/** The palette that lists the colours used in the open image (kept up to date). */
export const IMAGE_PALETTE = 'Colours in this image';

const imageColors = new WeakMap<ImageDoc, { version: number; colors: RGBA[] }>();

/** The distinct colours of an image, dark to light (at most 256; cached until the image changes). */
export function colorsInImage(doc: ImageDoc | null): RGBA[] {
  if (!doc) return [];
  const hit = imageColors.get(doc);
  if (hit && hit.version === doc.history.version) return hit.colors;
  // Big photos have thousands of colours; a palette of them isn't useful
  const colors = doc.width * doc.height > 2048 * 2048 ? [] : uniqueColors(flatten(doc).data, 257);
  const list = colors.length > 256 ? [] : colors.sort((a, b) => luma(a.r, a.g, a.b) - luma(b.r, b.g, b.b));
  imageColors.set(doc, { version: doc.history.version, colors: list });
  return list;
}

export function userPalettes(app: App): Palette[] {
  return app.prefs.userPalettes.map((p) => ({ name: p.name, colors: p.colors.map((c) => parseHex(c)).filter((c): c is RGBA => !!c) }));
}

export function allPalettes(app: App): Palette[] {
  return [...BUILTIN_PALETTES, ...userPalettes(app)];
}

export function isBuiltin(name: string): boolean {
  return name === IMAGE_PALETTE || BUILTIN_PALETTES.some((p) => p.name === name);
}

export function findPalette(app: App, name: string): Palette | undefined {
  return allPalettes(app).find((p) => p.name === name);
}

/** The palette shown in the Swatches panel. */
export function currentPalette(app: App): Palette {
  if (app.prefs.palette === IMAGE_PALETTE) return { name: IMAGE_PALETTE, colors: colorsInImage(app.doc) };
  return findPalette(app, app.prefs.palette) ?? BUILTIN_PALETTES[0];
}

/** Saves (or replaces) a user palette. Built-in names get a number added. */
export function saveUserPalette(app: App, p: Palette): string {
  let name = p.name.trim() || 'My palette';
  if (isBuiltin(name)) name = `${name} (mine)`;
  const list = app.prefs.userPalettes.filter((x) => x.name !== name);
  list.push({ name, colors: p.colors.map((c) => toHex(c)) });
  app.prefs.userPalettes = list;
  app.savePrefs();
  return name;
}

export function deleteUserPalette(app: App, name: string): void {
  app.prefs.userPalettes = app.prefs.userPalettes.filter((x) => x.name !== name);
  if (app.prefs.palette === name) app.prefs.palette = BUILTIN_PALETTES[0].name;
  app.savePrefs();
}
