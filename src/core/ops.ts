// Document operations: layers, image size, crop, rotation, selections and filters. Each takes the
// Edit it's part of, so callers decide what makes up one undo step.
import { blendInto, compositeLayer } from './blend';
import type { RGBA } from './color';
import { ImageDoc, type Edit } from './document';
import { paintMask, replaceColor } from './fill';
import type { FilterContext, FilterDef, Params } from './filters';
import { inflate, intersect, isEmpty, union, type Rect } from './geom';
import { Layer, type LayerProps } from './layer';
import { Raster } from './raster';
import { Mask } from './selection';
import { flipH, flipV, resize, rotate90, transformRaster, type Matrix, type Resample } from './transform';
import { upscale, type Upscaler } from './upscale';

// ---------- creating ----------

export type Background = 'white' | 'black' | 'transparent' | RGBA;

export function newDocument(width: number, height: number, background: Background = 'white', name = 'Untitled'): ImageDoc {
  const doc = new ImageDoc(width, height);
  doc.name = name;
  const fill: RGBA | null = background === 'white' ? { r: 255, g: 255, b: 255, a: 255 } : background === 'black' ? { r: 0, g: 0, b: 0, a: 255 } : background === 'transparent' ? null : background;
  const layer = fill ? new Layer('Background', Raster.filled(width, height, fill)) : new Layer('Layer 1');
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return doc;
}

/** A document made from one picture (an opened PNG or JPEG). */
export function documentFromRaster(raster: Raster, name: string): ImageDoc {
  const doc = new ImageDoc(raster.width, raster.height);
  doc.name = name;
  const layer = new Layer('Background', raster);
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return doc;
}

/** "Layer 3": the next unused number. */
export function nextLayerName(doc: ImageDoc, base = 'Layer'): string {
  let n = doc.layers.length + 1;
  const used = new Set(doc.layers.map((l) => l.name));
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// ---------- layers ----------

export function addLayer(doc: ImageDoc, e: Edit, layer: Layer, index = doc.layers.indexOf(doc.active) + 1): Layer {
  const prevActive = doc.activeId;
  const at = Math.max(0, Math.min(doc.layers.length, index));
  const apply = () => {
    doc.layers.splice(at, 0, layer);
    doc.activeId = layer.id;
    doc.emit({ type: 'layers' });
  };
  apply();
  e.record(
    () => {
      doc.layers.splice(doc.layers.indexOf(layer), 1);
      doc.activeId = prevActive;
      doc.emit({ type: 'layers' });
    },
    apply,
    layer.raster.data.length,
  );
  return layer;
}

export function removeLayer(doc: ImageDoc, e: Edit, layer: Layer): void {
  const at = doc.layers.indexOf(layer);
  if (at < 0) return;
  const prevActive = doc.activeId;
  const apply = () => {
    doc.layers.splice(doc.layers.indexOf(layer), 1);
    if (doc.activeId === layer.id) doc.activeId = (doc.layers[at - 1] ?? doc.layers[at] ?? doc.layers[0])?.id ?? '';
    doc.emit({ type: 'layers' });
  };
  apply();
  e.record(
    () => {
      doc.layers.splice(at, 0, layer);
      doc.activeId = prevActive;
      doc.emit({ type: 'layers' });
    },
    apply,
    layer.raster.data.length,
  );
}

export function moveLayer(doc: ImageDoc, e: Edit, layer: Layer, to: number): void {
  const from = doc.layers.indexOf(layer);
  to = Math.max(0, Math.min(doc.layers.length - 1, to));
  if (from < 0 || from === to) return;
  const place = (a: number, b: number) => () => {
    doc.layers.splice(a, 1);
    doc.layers.splice(b, 0, layer);
    doc.emit({ type: 'layers' });
  };
  place(from, to)();
  e.record(place(to, from), place(from, to));
}

export function setLayerProps(doc: ImageDoc, e: Edit, layer: Layer, props: Partial<LayerProps>): void {
  const before: Partial<LayerProps> = {};
  for (const k of Object.keys(props) as (keyof LayerProps)[]) (before as Record<string, unknown>)[k] = layer[k];
  const set = (p: Partial<LayerProps>) => () => {
    layer.setProps(p);
    doc.emit({ type: 'layers' });
  };
  set(props)();
  e.record(set(before), set(props));
}

/** Moves a layer's pixels (changes where it sits; nothing is lost at the image edges). */
export function offsetLayer(doc: ImageDoc, e: Edit, layer: Layer, dx: number, dy: number): void {
  if (!dx && !dy) return;
  const move = (x: number, y: number) => () => {
    const old = layer.bounds;
    layer.x = x;
    layer.y = y;
    doc.emit({ type: 'pixels', layer, rect: union(old, layer.bounds) });
  };
  const from = { x: layer.x, y: layer.y };
  move(from.x + dx, from.y + dy)();
  e.record(move(from.x, from.y), move(from.x + dx, from.y + dy));
}

/** Gives a layer completely new pixels (after a transform), undoably. */
export function replacePixels(doc: ImageDoc, e: Edit, layer: Layer, raster: Raster, x: number, y: number): void {
  const before = { raster: layer.raster, x: layer.x, y: layer.y };
  const set = (r: Raster, nx: number, ny: number) => () => {
    const old = layer.bounds;
    layer.raster = r;
    layer.x = nx;
    layer.y = ny;
    doc.emit({ type: 'pixels', layer, rect: union(old, layer.bounds) });
  };
  set(raster, x, y)();
  e.record(set(before.raster, before.x, before.y), set(raster, x, y), raster.data.length + before.raster.data.length);
}

export function duplicateLayer(doc: ImageDoc, e: Edit, layer: Layer): Layer {
  const copy = layer.clone(`${layer.name} copy`);
  return addLayer(doc, e, copy, doc.layers.indexOf(layer) + 1);
}

/** Draws a layer onto the one below it and removes it. */
export function mergeDown(doc: ImageDoc, e: Edit, layer: Layer): void {
  const i = doc.layers.indexOf(layer);
  const below = doc.layers[i - 1];
  if (i <= 0 || !below) return;
  const area = union(below.bounds, layer.bounds);
  e.touch(below, area);
  below.setArea(area);
  compositeLayer(below.raster, below.bounds, layer);
  doc.emit({ type: 'pixels', layer: below, rect: area });
  removeLayer(doc, e, layer);
  doc.setActive(below.id);
}

/** All visible layers become one (hidden ones are dropped, like Photoshop's Flatten). */
export function flattenImage(doc: ImageDoc, e: Edit, background?: RGBA): void {
  const area = doc.bounds;
  const out = new Raster(area.w, area.h);
  if (background) out.fill(background);
  for (const l of doc.layers) compositeLayer(out, area, l);
  const flat = new Layer(doc.layers.length === 1 ? doc.layers[0].name : 'Background', out);
  for (const l of [...doc.layers]) removeLayer(doc, e, l);
  addLayer(doc, e, flat, 0);
}

/** A copy of the active layer's selected pixels as a new layer (Ctrl+J). */
export function layerFromSelection(doc: ImageDoc, e: Edit, layer: Layer, cut = false): Layer | null {
  const sel = doc.selection;
  if (!sel || sel.isEmpty()) return duplicateLayer(doc, e, layer);
  const area = intersect(sel.bounds, layer.bounds);
  if (isEmpty(area)) return null;
  const data = layer.read(area);
  applyMaskAlpha(data, sel, area);
  if (cut) eraseSelection(doc, e, layer);
  const copy = new Layer(`${layer.name} ${cut ? 'cut' : 'copy'}`, new Raster(area.w, area.h, data), area.x, area.y);
  return addLayer(doc, e, copy, doc.layers.indexOf(layer) + 1);
}

function applyMaskAlpha(data: Uint8ClampedArray, mask: Mask, area: Rect): void {
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      const m = mask.get(area.x + x, area.y + y);
      const i = (y * area.w + x) * 4 + 3;
      data[i] = (data[i] * m) / 255;
    }
}

/** Clears the selected pixels of a layer (the whole layer without a selection). */
export function eraseSelection(doc: ImageDoc, e: Edit, layer: Layer): void {
  const sel = doc.selection;
  const area = sel ? intersect(sel.bounds, layer.bounds) : layer.bounds;
  if (isEmpty(area)) return;
  e.touch(layer, area);
  const data = layer.read(area);
  if (!sel) data.fill(0);
  else
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++) {
        const m = sel.get(area.x + x, area.y + y);
        const i = (y * area.w + x) * 4 + 3;
        data[i] = (data[i] * (255 - m)) / 255;
      }
  layer.write(area, data);
  doc.emit({ type: 'pixels', layer, rect: area });
}

/** Draws pixels onto a layer at a position (normal blending), growing the layer to fit. */
export function pasteInto(doc: ImageDoc, e: Edit, layer: Layer, src: Raster, x: number, y: number, mask?: Mask | null): void {
  const area = { x, y, w: src.width, h: src.height };
  if (isEmpty(area)) return;
  e.touch(layer, area);
  layer.ensure(area, union(doc.bounds, union(layer.bounds, area)));
  const below = layer.read(area);
  let data = src.data;
  if (mask) {
    data = new Uint8ClampedArray(src.data);
    applyMaskAlpha(data, mask, area);
  }
  blendInto(below, data, 'normal', 1);
  layer.write(area, below);
  doc.emit({ type: 'pixels', layer, rect: area });
}

/** Lifts the selected pixels out of a layer: returns them (masked) and where they were. */
export function liftSelection(doc: ImageDoc, layer: Layer): { raster: Raster; x: number; y: number } | null {
  const sel = doc.selection;
  if (!sel) return null;
  const area = intersect(sel.bounds, layer.bounds);
  if (isEmpty(area)) return null;
  const data = layer.read(area);
  applyMaskAlpha(data, sel, area);
  return { raster: new Raster(area.w, area.h, data), x: area.x, y: area.y };
}

/** Fills the selection (or the whole image) on a layer with a colour. */
export function fillSelection(doc: ImageDoc, e: Edit, layer: Layer, color: RGBA, opacity = 1): void {
  const mask = doc.selection ?? Mask.all(doc.width, doc.height);
  const area = mask.bounds;
  if (isEmpty(area)) return;
  e.touch(layer, area);
  layer.ensure(area, doc.bounds);
  const data = layer.read(doc.bounds);
  paintMask(data, mask, color, opacity, layer.alphaLocked);
  layer.write(doc.bounds, data);
  doc.emit({ type: 'pixels', layer, rect: area });
}

/** Swaps one colour for another on a layer (exactly, or within a tolerance). */
export function swapColor(doc: ImageDoc, e: Edit, layer: Layer, from: RGBA, to: RGBA, tolerance = 0): number {
  const area = layer.bounds;
  if (isEmpty(area)) return 0;
  e.touch(layer, area);
  const data = layer.read(area);
  let mask: Mask | null = null;
  if (doc.selection) {
    // A mask in the layer's own coordinates
    mask = new Mask(area.w, area.h);
    for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) mask.data[y * area.w + x] = doc.selection.get(area.x + x, area.y + y);
  }
  const n = replaceColor(data, from, to, tolerance, mask);
  layer.write(area, data);
  doc.emit({ type: 'pixels', layer, rect: area });
  return n;
}

// ---------- the whole image ----------

/** Records the whole document's size and layers so a big change can be undone. */
function snapshot(doc: ImageDoc): () => void {
  const w = doc.width;
  const h = doc.height;
  const state = doc.layers.map((l) => ({ l, raster: l.raster, x: l.x, y: l.y }));
  const sel = doc.selection;
  return () => {
    doc.width = w;
    doc.height = h;
    for (const s of state) {
      s.l.raster = s.raster;
      s.l.x = s.x;
      s.l.y = s.y;
    }
    doc.selection = sel;
    doc.emit({ type: 'size' });
  };
}

/** Runs a change to the image size and layer pixels as one undoable step (keeps the whole state). */
export function bigChange(doc: ImageDoc, e: Edit, change: () => void): void {
  const before = snapshot(doc);
  change();
  const after = snapshot(doc);
  doc.emit({ type: 'size' });
  const bytes = doc.layers.reduce((n, l) => n + l.raster.data.length, 0) * 2;
  e.record(before, after, bytes);
}

/** Scales the image and every layer. */
export function resizeImage(doc: ImageDoc, e: Edit, width: number, height: number, method: Resample): void {
  bigChange(doc, e, () => {
    const sx = width / doc.width;
    const sy = height / doc.height;
    for (const l of doc.layers) {
      if (!l.raster.width || !l.raster.height) continue;
      const x = Math.round(l.x * sx);
      const y = Math.round(l.y * sy);
      const w = Math.max(1, Math.round((l.x + l.raster.width) * sx) - x);
      const h = Math.max(1, Math.round((l.y + l.raster.height) * sy) - y);
      l.raster = resize(l.raster, w, h, method);
      l.x = x;
      l.y = y;
    }
    doc.width = width;
    doc.height = height;
    doc.selection = null;
  });
}

/** Enlarges the image and every layer with a pixel-art scaler (Scale2x/3x keep edges smooth, nearest keeps blocks). */
export function upscaleImage(doc: ImageDoc, e: Edit, method: Upscaler, factor: 2 | 3 | 4): void {
  bigChange(doc, e, () => {
    for (const l of doc.layers) {
      if (!l.raster.width || !l.raster.height) continue;
      l.raster = upscale(l.raster, method, factor);
      l.x *= factor;
      l.y *= factor;
    }
    doc.width *= factor;
    doc.height *= factor;
    doc.selection = null;
  });
  const grid = doc.meta.grid;
  if (grid) {
    doc.meta.grid = { ...grid, size: grid.size * factor };
    e.record(
      () => (doc.meta.grid = grid),
      () => (doc.meta.grid = { ...grid, size: grid.size * factor }),
    );
  }
}

export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

/** Changes the image size without scaling: layers keep their pixels, placed by `anchor`. */
export function resizeCanvas(doc: ImageDoc, e: Edit, width: number, height: number, anchor: Anchor, fill?: RGBA): void {
  bigChange(doc, e, () => {
    // Where the old image goes: left/centre/right, top/middle/bottom
    const col = anchor.endsWith('l') ? 0 : anchor.endsWith('r') ? 1 : 0.5;
    const row = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
    const dx = Math.round((width - doc.width) * col);
    const dy = Math.round((height - doc.height) * row);
    for (const l of doc.layers) {
      l.x += dx;
      l.y += dy;
    }
    const bg = doc.layers[0];
    if (fill && bg && bg.name === 'Background') {
      // The background layer grows with the canvas, filled with the colour
      const r = Raster.filled(width, height, fill);
      const part = intersect(bg.bounds, { x: 0, y: 0, w: width, h: height });
      if (!isEmpty(part)) r.write(part, bg.read(part));
      bg.raster = r;
      bg.x = 0;
      bg.y = 0;
    }
    doc.width = width;
    doc.height = height;
    doc.selection = null;
  });
}

/** Crops the image to a rectangle. With `deletePixels`, pixels outside are thrown away. */
export function cropImage(doc: ImageDoc, e: Edit, r: Rect, deletePixels = true): void {
  const area = intersect(r, inflate(doc.bounds, 1_000_000));
  if (isEmpty(area)) return;
  bigChange(doc, e, () => {
    for (const l of doc.layers) {
      if (deletePixels) {
        const keep = intersect(l.bounds, area);
        if (isEmpty(keep)) l.raster = new Raster(0, 0);
        else {
          l.raster = new Raster(keep.w, keep.h, l.read(keep));
          l.x = keep.x;
          l.y = keep.y;
        }
      }
      l.x -= area.x;
      l.y -= area.y;
    }
    doc.width = area.w;
    doc.height = area.h;
    doc.selection = null;
  });
}

/** The area with visible pixels in any layer (for "Trim"). */
export function contentBounds(doc: ImageDoc): Rect {
  let r: Rect = { x: 0, y: 0, w: 0, h: 0 };
  for (const l of doc.layers) {
    if (!l.visible) continue;
    const c = l.raster.contentBounds();
    if (!isEmpty(c)) r = union(r, { x: c.x + l.x, y: c.y + l.y, w: c.w, h: c.h });
  }
  return intersect(r, doc.bounds);
}

export function rotateImage(doc: ImageDoc, e: Edit, turns: 1 | 2 | 3): void {
  bigChange(doc, e, () => {
    const W = doc.width;
    const H = doc.height;
    for (const l of doc.layers) {
      const { x, y } = l;
      const w = l.raster.width;
      const h = l.raster.height;
      l.raster = rotate90(l.raster, turns);
      if (turns === 1) {
        l.x = H - (y + h);
        l.y = x;
      } else if (turns === 2) {
        l.x = W - (x + w);
        l.y = H - (y + h);
      } else {
        l.x = y;
        l.y = W - (x + w);
      }
    }
    if (turns !== 2) [doc.width, doc.height] = [H, W];
  });
}

export function flipImage(doc: ImageDoc, e: Edit, horizontal: boolean): void {
  bigChange(doc, e, () => {
    for (const l of doc.layers) {
      if (horizontal) {
        l.raster = flipH(l.raster);
        l.x = doc.width - (l.x + l.raster.width);
      } else {
        l.raster = flipV(l.raster);
        l.y = doc.height - (l.y + l.raster.height);
      }
    }
  });
}

/** Flips or rotates one layer in place (around its own centre). */
export function transformLayer(doc: ImageDoc, e: Edit, layer: Layer, how: 'flipH' | 'flipV' | 'rot90' | 'rot180' | 'rot270'): void {
  const b = layer.bounds;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r = how === 'flipH' ? flipH(layer.raster) : how === 'flipV' ? flipV(layer.raster) : rotate90(layer.raster, how === 'rot90' ? 1 : how === 'rot180' ? 2 : 3);
  replacePixels(doc, e, layer, r, Math.round(cx - r.width / 2), Math.round(cy - r.height / 2));
}

/** Free transform: draws a layer through a matrix (layer pixel space → image space). */
export function applyMatrix(doc: ImageDoc, e: Edit, layer: Layer, m: Matrix, method: Resample): void {
  const out = transformRaster(layer.raster, m, method);
  replacePixels(doc, e, layer, out.raster, out.x, out.y);
}

// ---------- selection ----------

export function setSelection(doc: ImageDoc, e: Edit, mask: Mask | null): void {
  const before = doc.selection;
  const next = mask && !mask.isEmpty() ? mask : null;
  const set = (m: Mask | null) => () => {
    doc.selection = m;
    doc.emit({ type: 'selection' });
  };
  set(next)();
  e.record(set(before), set(next), (next?.data.length ?? 0) + (before?.data.length ?? 0));
}

/** Selects the non-transparent pixels of a layer (Ctrl+click on its thumbnail). */
export function selectionFromAlpha(doc: ImageDoc, layer: Layer): Mask {
  const m = new Mask(doc.width, doc.height);
  const area = intersect(layer.bounds, doc.bounds);
  const data = layer.read(area);
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) m.data[(area.y + y) * doc.width + area.x + x] = data[(y * area.w + x) * 4 + 3];
  m.touched();
  return m;
}

// ---------- filters ----------

/** Runs a filter on a layer, inside the selection (with soft edges blended). */
export function applyFilter(doc: ImageDoc, e: Edit, layer: Layer, f: FilterDef, params: Params, ctx: FilterContext): void {
  const result = previewFilter(doc, layer, f, params, ctx);
  if (!result) return;
  e.touch(layer, result.area);
  layer.ensure(result.area, union(doc.bounds, layer.bounds));
  layer.write(result.area, result.data);
  doc.emit({ type: 'pixels', layer, rect: result.area });
}

/** A filter's result for a layer without changing it (for live previews). */
export function previewFilter(doc: ImageDoc, layer: Layer, f: FilterDef, params: Params, ctx: FilterContext): { area: Rect; data: Uint8ClampedArray } | null {
  const sel = doc.selection;
  const reach = f.reach?.(params) ?? 0;
  // Without a selection: the layer's pixels, plus room to spread (blurs, outlines) inside the
  // image. Texture filters (offset, seamless) work on the whole image, since they wrap around it.
  const target = sel ? sel.bounds : f.group === 'Textures' ? doc.bounds : union(intersect(inflate(layer.bounds, reach), doc.bounds), layer.bounds);
  if (isEmpty(target)) return null;
  const ctxArea = sel ? intersect(inflate(target, reach), doc.bounds) : target;
  const src = layer.read(ctxArea);
  const out = f.run(src, ctxArea.w, ctxArea.h, params, ctx);
  if (sel) {
    // Keep the original outside the selection, mix at soft edges
    for (let y = 0; y < ctxArea.h; y++)
      for (let x = 0; x < ctxArea.w; x++) {
        const m = sel.get(ctxArea.x + x, ctxArea.y + y) / 255;
        if (m >= 1) continue;
        const i = (y * ctxArea.w + x) * 4;
        for (let c = 0; c < 4; c++) out[i + c] = src[i + c] + (out[i + c] - src[i + c]) * m;
      }
  }
  return { area: ctxArea, data: out };
}
