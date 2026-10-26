// The palettes the app knows: built-in ones plus the user's own (saved in preferences).
import { parseHex, toHex, type RGBA } from '../core/color';
import { BUILTIN_PALETTES, type Palette } from '../core/palettes';
import type { App } from './app';

export function userPalettes(app: App): Palette[] {
  return app.prefs.userPalettes.map((p) => ({ name: p.name, colors: p.colors.map((c) => parseHex(c)).filter((c): c is RGBA => !!c) }));
}

export function allPalettes(app: App): Palette[] {
  return [...BUILTIN_PALETTES, ...userPalettes(app)];
}

export function isBuiltin(name: string): boolean {
  return BUILTIN_PALETTES.some((p) => p.name === name);
}

export function findPalette(app: App, name: string): Palette | undefined {
  return allPalettes(app).find((p) => p.name === name);
}

/** The palette shown in the Swatches panel. */
export function currentPalette(app: App): Palette {
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
