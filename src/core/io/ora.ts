// OpenRaster (.ora): Pixelline's own file format. It's an open standard (a zip of PNG layers plus
// stack.xml) that Krita, GIMP and MyPaint open too. Pixelline-only settings go in pixelline.json
// inside the same zip, which other programs ignore.
import JSZip from 'jszip';
import { flatten } from '../blend';
import { ImageDoc, type DocMeta } from '../document';
import { Layer, type BlendMode } from '../layer';
import { Raster } from '../raster';
import { resize } from '../transform';
import { decodePng, encodePng } from './png';

const TO_ORA: Record<BlendMode, string> = {
  normal: 'svg:src-over',
  multiply: 'svg:multiply',
  screen: 'svg:screen',
  overlay: 'svg:overlay',
  darken: 'svg:darken',
  lighten: 'svg:lighten',
  'color-dodge': 'svg:color-dodge',
  'color-burn': 'svg:color-burn',
  'hard-light': 'svg:hard-light',
  'soft-light': 'svg:soft-light',
  difference: 'svg:difference',
  exclusion: 'svg:exclusion',
  hue: 'svg:hue',
  saturation: 'svg:saturation',
  color: 'svg:color',
  luminosity: 'svg:luminosity',
};
const FROM_ORA = new Map(Object.entries(TO_ORA).map(([k, v]) => [v, k as BlendMode]));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

interface Extra {
  version: 1;
  active?: number;
  meta?: DocMeta;
  layers?: { alphaLocked?: boolean; locked?: boolean }[];
}

export async function writeOra(doc: ImageDoc): Promise<Uint8Array> {
  const zip = new JSZip();
  // The mimetype must be the first file, uncompressed
  zip.file('mimetype', 'image/openraster', { compression: 'STORE' });
  const top = [...doc.layers].reverse();
  const lines = top.map((l, i) => {
    const attrs = [
      `name="${esc(l.name)}"`,
      `src="data/layer${i}.png"`,
      `x="${l.x}"`,
      `y="${l.y}"`,
      `opacity="${+l.opacity.toFixed(4)}"`,
      `visibility="${l.visible ? 'visible' : 'hidden'}"`,
      `composite-op="${TO_ORA[l.blend] ?? 'svg:src-over'}"`,
    ];
    if (l.locked) attrs.push('edit-locked="true"');
    if (l.alphaLocked) attrs.push('alpha-preserve="true"');
    if (l.id === doc.activeId) attrs.push('selected="true"');
    return `    <layer ${attrs.join(' ')}/>`;
  });
  zip.file('stack.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${doc.width}" h="${doc.height}" xres="${doc.meta.dpi ?? 72}" yres="${doc.meta.dpi ?? 72}">\n  <stack>\n${lines.join('\n')}\n  </stack>\n</image>\n`);
  top.forEach((l, i) => zip.file(`data/layer${i}.png`, encodePng(l.raster.width && l.raster.height ? l.raster : new Raster(1, 1))));
  const merged = flatten(doc);
  zip.file('mergedimage.png', encodePng(merged));
  const scale = Math.min(1, 256 / Math.max(doc.width, doc.height));
  zip.file('Thumbnails/thumbnail.png', encodePng(scale < 1 ? resize(merged, Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)), doc.width <= 256 ? 'nearest' : 'area') : merged));
  const extra: Extra = { version: 1, active: doc.layers.indexOf(doc.active), meta: doc.meta, layers: doc.layers.map((l) => ({ alphaLocked: l.alphaLocked || undefined, locked: l.locked || undefined })) };
  zip.file('pixelline.json', JSON.stringify(extra, null, 1));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unesc(m[2]);
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) out[m[1]] ??= unesc(m[2]);
  return out;
}

export async function readOra(bytes: Uint8Array, name = 'Untitled'): Promise<ImageDoc> {
  const zip = await JSZip.loadAsync(bytes);
  const stack = await zip.file('stack.xml')?.async('string');
  if (!stack) throw new Error("This isn't an OpenRaster file (it has no stack.xml).");
  const image = attrs(/<image\b([^>]*)>/.exec(stack)?.[1] ?? '');
  const doc = new ImageDoc(Math.max(1, parseInt(image.w, 10) || 1), Math.max(1, parseInt(image.h, 10) || 1));
  doc.name = name;
  // Layers are listed top first; stacks (groups) are flattened, keeping their offsets and visibility
  const found: { a: Record<string, string>; ox: number; oy: number; hidden: boolean }[] = [];
  const offsets: { x: number; y: number; hidden: boolean }[] = [{ x: 0, y: 0, hidden: false }];
  for (const m of stack.matchAll(/<(\/?)(stack|layer)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, body, selfClose] = m;
    const cur = offsets[offsets.length - 1];
    if (tag === 'stack') {
      if (close) offsets.pop();
      else {
        const a = attrs(body);
        const nested = { x: cur.x + (parseInt(a.x, 10) || 0), y: cur.y + (parseInt(a.y, 10) || 0), hidden: cur.hidden || a.visibility === 'hidden' };
        if (!selfClose) offsets.push(offsets.length === 1 && !a.x && !a.y ? cur : nested);
      }
      continue;
    }
    if (close) continue;
    found.push({ a: attrs(body), ox: cur.x, oy: cur.y, hidden: cur.hidden });
  }
  for (const f of found.reverse()) {
    const file = f.a.src ? zip.file(f.a.src) : null;
    if (!file) continue;
    const raster = decodePng(await file.async('uint8array'));
    const layer = new Layer(f.a.name || `Layer ${doc.layers.length + 1}`, raster, (parseInt(f.a.x, 10) || 0) + f.ox, (parseInt(f.a.y, 10) || 0) + f.oy);
    const opacity = parseFloat(f.a.opacity);
    layer.opacity = isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity));
    layer.visible = f.a.visibility !== 'hidden' && !f.hidden;
    layer.blend = FROM_ORA.get(f.a['composite-op'] ?? '') ?? 'normal';
    layer.locked = f.a['edit-locked'] === 'true';
    layer.alphaLocked = f.a['alpha-preserve'] === 'true';
    doc.layers.push(layer);
    if (f.a.selected === 'true') doc.activeId = layer.id;
  }
  if (!doc.layers.length) doc.layers.push(new Layer('Layer 1'));
  try {
    const extra = JSON.parse((await zip.file('pixelline.json')?.async('string')) ?? 'null') as Extra | null;
    if (extra?.meta) doc.meta = extra.meta;
    extra?.layers?.forEach((x, i) => {
      const l = doc.layers[i];
      if (!l) return;
      if (x.alphaLocked) l.alphaLocked = true;
      if (x.locked) l.locked = true;
    });
    if (!doc.activeId && extra?.active !== undefined && doc.layers[extra.active]) doc.activeId = doc.layers[extra.active].id;
  } catch {
    // other programs' files don't have it
  }
  const dpi = parseFloat(image.xres);
  if (dpi && dpi !== 72) doc.meta.dpi = dpi;
  if (!doc.activeId) doc.activeId = doc.layers[doc.layers.length - 1].id;
  return doc;
}
