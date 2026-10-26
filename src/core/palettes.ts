// Palettes: built-in sets popular for pixel art, and the common palette file formats
// (GIMP .gpl, JASC/Paint Shop Pro .pal, Paint.NET .txt, plain .hex).
import { parseHex, toHex, type RGBA } from './color';

export interface Palette {
  name: string;
  colors: RGBA[];
}

const P = (name: string, hex: string): Palette => ({ name, colors: hex.trim().split(/\s+/).map((h) => parseHex(h)!) });

export const BUILTIN_PALETTES: Palette[] = [
  P('Minecraft dyes', 'f9fffe 9d9d97 474f52 1d1d21 835432 b02e26 f9801d fed83d 80c71f 5e7c16 169c9c 3ab3da 3c44aa 8932b8 c74ebd f38baa'),
  P('PICO-8', '000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa'),
  P('DawnBringer 16', '140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161 597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6'),
  P('Sweetie 16', '1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57'),
  P('Endesga 32', 'be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569'),
  P('Game Boy', '0f380f 306230 8bac0f 9bbc0f'),
  P('Grayscale', '000000 242424 494949 6d6d6d 929292 b6b6b6 dbdbdb ffffff'),
  P('Basic', '000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 808080 800000 008000 000080 808000 800080 008080 c0c0c0'),
];

export type PaletteFormat = 'gpl' | 'pal' | 'txt' | 'hex';

/** Reads any of the supported palette formats (detected from the text). */
export function parsePalette(text: string, fallbackName = 'Palette'): Palette {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const colors: RGBA[] = [];
  let name = fallbackName;
  if (/^GIMP Palette/i.test(lines[0] ?? '')) {
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const nm = /^Name:\s*(.*)$/i.exec(t);
      if (nm) {
        name = nm[1].trim() || name;
        continue;
      }
      if (/^Columns:/i.test(t)) continue;
      const m = /^(\d+)\s+(\d+)\s+(\d+)/.exec(t);
      if (m) colors.push({ r: +m[1], g: +m[2], b: +m[3], a: 255 });
    }
    return { name, colors };
  }
  if (/^JASC-PAL/i.test(lines[0] ?? '')) {
    for (const line of lines.slice(3)) {
      const m = /^(\d+)\s+(\d+)\s+(\d+)/.exec(line.trim());
      if (m) colors.push({ r: +m[1], g: +m[2], b: +m[3], a: 255 });
    }
    return { name, colors };
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith(';') || t.startsWith('//')) continue;
    // Paint.NET writes AARRGGBB
    if (/^[0-9a-f]{8}$/i.test(t)) {
      const c = parseHex(t.slice(2) + t.slice(0, 2));
      if (c) colors.push(c);
      continue;
    }
    for (const tok of t.split(/[\s,;]+/)) {
      const c = parseHex(tok);
      if (c) colors.push(c);
    }
  }
  return { name, colors };
}

export function serializePalette(p: Palette, format: PaletteFormat): string {
  switch (format) {
    case 'gpl':
      return ['GIMP Palette', `Name: ${p.name}`, 'Columns: 8', '#', ...p.colors.map((c) => `${String(c.r).padStart(3)} ${String(c.g).padStart(3)} ${String(c.b).padStart(3)}\t${toHex(c, false)}`)].join('\n') + '\n';
    case 'pal':
      return ['JASC-PAL', '0100', String(p.colors.length), ...p.colors.map((c) => `${c.r} ${c.g} ${c.b}`)].join('\r\n') + '\r\n';
    case 'txt':
      return [`; ${p.name}`, ...p.colors.map((c) => (c.a.toString(16).padStart(2, '0') + toHex(c, false).slice(1)).toUpperCase())].join('\r\n') + '\r\n';
    default:
      return p.colors.map((c) => toHex(c, false).slice(1)).join('\n') + '\n';
  }
}
