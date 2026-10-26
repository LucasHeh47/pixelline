// Photoshop documents (.psd), read and written with ag-psd. Layers keep their names, positions,
// opacity, blend modes, visibility and locks. Groups are flattened into their layers; layer masks
// are applied to the pixels; text and adjustment layers come in as their pixels.
import { initializeCanvas, readPsd, writePsd, type BlendMode as PsdBlend, type Layer as PsdLayer } from 'ag-psd';
import { flatten } from '../blend';
import { ImageDoc } from '../document';
import { Layer, type BlendMode } from '../layer';
import { Raster } from '../raster';

// ag-psd makes image buffers through a canvas; plain buffers work everywhere (tests, workers)
initializeCanvas(
  (w, h) => {
    if (typeof document === 'undefined') throw new Error('No canvas here');
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' }) as ImageData,
);

const FROM_PSD: Partial<Record<PsdBlend, BlendMode>> = {
  normal: 'normal',
  dissolve: 'normal',
  darken: 'darken',
  multiply: 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'multiply',
  'darker color': 'darken',
  lighten: 'lighten',
  screen: 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'screen',
  'lighter color': 'lighten',
  overlay: 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const TO_PSD: Record<BlendMode, PsdBlend> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color dodge',
  'color-burn': 'color burn',
  'hard-light': 'hard light',
  'soft-light': 'soft light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export interface PsdResult {
  doc: ImageDoc;
  /** Things that couldn't be kept exactly (shown to the user). */
  notes: string[];
}

export function readPsdFile(bytes: Uint8Array, name = 'Untitled'): PsdResult {
  const psd = readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const doc = new ImageDoc(psd.width, psd.height);
  doc.name = name;
  const notes = new Set<string>();
  const walk = (layers: PsdLayer[], hidden: boolean, opacity: number) => {
    for (const l of layers) {
      if (l.children) {
        // Groups: their visibility and opacity carry over to the layers inside
        if (l.blendMode && l.blendMode !== 'pass through' && l.blendMode !== 'normal') notes.add('Group blend modes were applied to each layer in the group.');
        walk(l.children, hidden || !!l.hidden, opacity * (l.opacity ?? 1));
        continue;
      }
      const img = l.imageData;
      const left = l.left ?? 0;
      const top = l.top ?? 0;
      const raster = img && img.width && img.height ? new Raster(img.width, img.height, new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4).slice()) : new Raster(0, 0);
      if (l.mask?.imageData && !l.mask.disabled) {
        applyMask(raster, left, top, l.mask.imageData, l.mask.left ?? 0, l.mask.top ?? 0, l.mask.defaultColor ?? 0);
        notes.add('Layer masks were applied to the layers’ pixels.');
      }
      if (l.text) notes.add('Text layers came in as pictures (the text can’t be edited).');
      if ((l as { effects?: unknown }).effects) notes.add('Layer effects (shadows, strokes…) aren’t supported and were left out.');
      const layer = new Layer(l.name || `Layer ${doc.layers.length + 1}`, raster, left, top);
      layer.visible = !(l.hidden || hidden);
      layer.opacity = Math.max(0, Math.min(1, (l.opacity ?? 1) * opacity));
      const blend = FROM_PSD[l.blendMode ?? 'normal'];
      if (!blend) notes.add(`The "${l.blendMode}" blend mode isn't supported; Normal was used.`);
      layer.blend = blend ?? 'normal';
      layer.alphaLocked = !!(l.transparencyProtected || l.protected?.transparency);
      layer.locked = !!(l.protected?.position && l.protected?.composite);
      doc.layers.push(layer);
    }
  };
  walk(psd.children ?? [], false, 1);
  if (!doc.layers.length) {
    // A flat file: just its composite image
    const img = psd.imageData;
    const raster = img ? new Raster(img.width, img.height, new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4).slice()) : new Raster(psd.width, psd.height);
    doc.layers.push(new Layer('Background', raster));
  }
  doc.activeId = doc.layers[doc.layers.length - 1].id;
  return { doc, notes: [...notes] };
}

function applyMask(r: Raster, left: number, top: number, mask: { width: number; height: number; data: ArrayLike<number> }, mLeft: number, mTop: number, outside: number): void {
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const mx = x + left - mLeft;
      const my = y + top - mTop;
      const m = mx >= 0 && my >= 0 && mx < mask.width && my < mask.height ? mask.data[(my * mask.width + mx) * 4] : outside;
      const i = (y * r.width + x) * 4 + 3;
      r.data[i] = (r.data[i] * m) / 255;
    }
}

export function writePsdFile(doc: ImageDoc): Uint8Array {
  const composite = flatten(doc);
  const children: PsdLayer[] = doc.layers.map((l) => ({
    name: l.name,
    left: l.x,
    top: l.y,
    right: l.x + l.raster.width,
    bottom: l.y + l.raster.height,
    opacity: l.opacity,
    hidden: !l.visible,
    blendMode: TO_PSD[l.blend] ?? 'normal',
    transparencyProtected: l.alphaLocked,
    protected: l.locked ? { position: true, composite: true } : undefined,
    imageData: l.raster.width && l.raster.height ? { width: l.raster.width, height: l.raster.height, data: new Uint8ClampedArray(l.raster.data) } : undefined,
  }));
  const out = writePsd(
    {
      width: doc.width,
      height: doc.height,
      children,
      imageData: { width: composite.width, height: composite.height, data: composite.data },
    },
    { generateThumbnail: false, noBackground: true },
  );
  return new Uint8Array(out);
}
