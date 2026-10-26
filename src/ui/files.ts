// Reading and writing image files. PNG goes through our own encoder (exact pixels, small paletted
// files for pixel art); JPEG, WebP, GIF and BMP are decoded by the browser; layered images are
// OpenRaster (.ora, Pixelline's own format) or Photoshop (.psd).
import { flatten } from '../core/blend';
import type { RGBA } from '../core/color';
import type { ImageDoc } from '../core/document';
import { readOra, writeOra } from '../core/io/ora';
import { decodePng, encodePng } from '../core/io/png';
import { readPsdFile, writePsdFile } from '../core/io/psd';
import { documentFromRaster } from '../core/ops';
import { Raster } from '../core/raster';
import { resize, type Resample } from '../core/transform';

export type SaveFormat = 'ora' | 'png' | 'jpg' | 'webp' | 'psd';

export const FORMAT_LABELS: Record<SaveFormat, string> = {
  ora: 'OpenRaster (.ora) — keeps layers',
  png: 'PNG — exact pixels, transparency',
  jpg: 'JPEG — photos, smallest files',
  webp: 'WebP — small, with transparency',
  psd: 'Photoshop (.psd) — keeps layers',
};

/** Formats that keep layers. */
export const LAYERED: SaveFormat[] = ['ora', 'psd'];

export function extOf(name: string): string {
  return (/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase();
}

export function baseName(name: string): string {
  return name.replace(/\.[^.\\/]+$/, '');
}

export function formatFromExt(ext: string): SaveFormat | null {
  if (ext === 'jpeg') return 'jpg';
  return (['ora', 'png', 'jpg', 'webp', 'psd'] as string[]).includes(ext) ? (ext as SaveFormat) : null;
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** Opens any supported image. `notes` lists anything that couldn't be kept (PSD effects…). */
export async function readImage(bytes: Uint8Array, name: string): Promise<{ doc: ImageDoc; notes: string[] }> {
  const title = baseName(name.split(/[\\/]/).pop() || name) || 'Untitled';
  let doc: ImageDoc;
  let notes: string[] = [];
  let type = extOf(name);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    doc = documentFromRaster(decodePng(bytes), title);
    type = 'png';
  } else if (startsWith(bytes, [0x38, 0x42, 0x50, 0x53])) {
    const r = readPsdFile(bytes, title);
    doc = r.doc;
    notes = r.notes;
    type = 'psd';
  } else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    doc = await readOra(bytes, title);
    type = 'ora';
  } else {
    doc = documentFromRaster(await decodeWithBrowser(bytes), title);
    if (type === 'jpeg') type = 'jpg';
  }
  doc.fileType = type;
  return { doc, notes };
}

/** Decodes JPEG, WebP, GIF (first frame), BMP and ICO. */
export async function decodeWithBrowser(bytes: Uint8Array): Promise<Raster> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error("This file isn't an image Pixelline can read, or it's damaged.");
  }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const img = g.getImageData(0, 0, c.width, c.height);
  return new Raster(c.width, c.height, new Uint8ClampedArray(img.data.buffer));
}

export interface ExportOptions {
  format: SaveFormat;
  /** Whole-number scales use nearest neighbour (crisp pixel art); others use `method`. */
  scale?: number;
  method?: Resample;
  /** JPEG/WebP quality, 0–1. */
  quality?: number;
  /** Paletted PNG when there are 256 colours or fewer. */
  indexed?: boolean;
  /** JPEG has no transparency: what shows through. */
  background?: RGBA;
}

/** The flattened image, scaled for export. */
export function exportRaster(doc: ImageDoc, o: Pick<ExportOptions, 'scale' | 'method'> = {}): Raster {
  let r = flatten(doc);
  const s = o.scale ?? 1;
  if (s !== 1) {
    const w = Math.max(1, Math.round(doc.width * s));
    const hgt = Math.max(1, Math.round(doc.height * s));
    const method: Resample = Number.isInteger(s) && s > 1 ? 'nearest' : (o.method ?? 'bicubic');
    r = resize(r, w, hgt, method);
  }
  return r;
}

export async function encodeImage(doc: ImageDoc, o: ExportOptions): Promise<Uint8Array> {
  switch (o.format) {
    case 'ora':
      return writeOra(doc);
    case 'psd':
      return writePsdFile(doc);
    case 'png':
      return encodePng(exportRaster(doc, o), { indexed: o.indexed !== false });
    default:
      return encodeWithBrowser(exportRaster(doc, o), o.format === 'jpg' ? 'image/jpeg' : 'image/webp', o.quality ?? 0.92, o.format === 'jpg' ? (o.background ?? { r: 255, g: 255, b: 255, a: 255 }) : undefined);
  }
}

export async function encodeWithBrowser(r: Raster, type: string, quality: number, background?: RGBA): Promise<Uint8Array> {
  const c = new OffscreenCanvas(r.width, r.height);
  const g = c.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(r.data), r.width, r.height);
  if (background) {
    // Draw over the background colour (putImageData would replace it)
    const tmp = new OffscreenCanvas(r.width, r.height);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.fillStyle = `rgb(${background.r},${background.g},${background.b})`;
    g.fillRect(0, 0, r.width, r.height);
    g.drawImage(tmp, 0, 0);
  } else g.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Whether saving in this format loses anything the document has. */
export function lossNote(doc: ImageDoc, format: SaveFormat): string | null {
  if (LAYERED.includes(format)) return null;
  const visible = doc.layers.filter((l) => l.visible);
  if (doc.layers.length > 1 || visible.length !== doc.layers.length) return `${format.toUpperCase()} files have one layer, so the saved file is the flattened image. Your layers stay while the image is open; save as .ora to keep them in the file.`;
  return null;
}
