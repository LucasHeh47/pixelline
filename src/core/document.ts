// An image document: its size, layers (bottom first), selection and undo history.
//
// Every change goes through an Edit. Before pixels change, the edit saves the 64×64 tiles they're
// in; when it's done it keeps only tiles that really changed. That keeps undo small: a brush stroke
// across a large photo stores the strip it painted, not the whole layer.
import { intersect, isEmpty, union, type Rect } from './geom';
import { Layer } from './layer';
import { allTransparent } from './raster';
import type { Mask } from './selection';

export type DocEvent =
  | { type: 'pixels'; layer: Layer; rect: Rect }
  /** Layers were added, removed, reordered or their settings changed. */
  | { type: 'layers' }
  | { type: 'selection' }
  /** The image size changed (resize, crop, canvas size). */
  | { type: 'size' }
  | { type: 'history' }
  /** The active layer changed. */
  | { type: 'active' };

/** One undoable step. */
export interface Change {
  label: string;
  /** Roughly how much memory the step keeps. */
  bytes: number;
  undo(): void;
  redo(): void;
}

export class History {
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  /** Changes on every step, undo and redo (to tell whether the file has unsaved changes). */
  version = 0;
  /** Oldest steps are forgotten past this many bytes or steps. */
  maxBytes = 1_500_000_000;
  maxSteps = 300;

  push(c: Change): void {
    this.undoStack.push(c);
    this.redoStack = [];
    this.version++;
    let total = this.undoStack.reduce((n, x) => n + x.bytes, 0);
    while (this.undoStack.length > 1 && (total > this.maxBytes || this.undoStack.length > this.maxSteps)) total -= this.undoStack.shift()!.bytes;
  }

  undo(): Change | undefined {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    this.version++;
    return c;
  }

  redo(): Change | undefined {
    const c = this.redoStack.pop();
    if (!c) return;
    c.redo();
    this.undoStack.push(c);
    this.version++;
    return c;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Labels for the History panel: done steps (oldest first), then undone ones. */
  entries(): { done: string[]; undone: string[] } {
    return { done: this.undoStack.map((c) => c.label), undone: [...this.redoStack].reverse().map((c) => c.label) };
  }

  get bytes(): number {
    return this.undoStack.reduce((n, x) => n + x.bytes, 0) + this.redoStack.reduce((n, x) => n + x.bytes, 0);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export const TILE = 64;

const tileRect = (key: string): Rect => {
  const [tx, ty] = key.split(',').map(Number);
  return { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
};

function sameBytes(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Changes being made as one undoable step. */
export class Edit {
  private tiles = new Map<Layer, { area: Rect; before: Map<string, Uint8ClampedArray | null> }>();
  private ops: { undo(): void; redo(): void; bytes: number }[] = [];
  private done = false;

  constructor(
    readonly doc: ImageDoc,
    readonly label: string,
  ) {}

  /** Call before changing a layer's pixels inside `r` (image coordinates). */
  touch(layer: Layer, r: Rect): void {
    if (isEmpty(r)) return;
    let t = this.tiles.get(layer);
    if (!t) this.tiles.set(layer, (t = { area: layer.bounds, before: new Map() }));
    const tx1 = Math.floor(r.x / TILE);
    const ty1 = Math.floor(r.y / TILE);
    const tx2 = Math.floor((r.x + r.w - 1) / TILE);
    const ty2 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty1; ty <= ty2; ty++)
      for (let tx = tx1; tx <= tx2; tx++) {
        const key = `${tx},${ty}`;
        if (t.before.has(key)) continue;
        const data = layer.read({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
        t.before.set(key, allTransparent(data) ? null : data);
      }
  }

  /** The pixels a layer had in `r` when this edit first touched them (current pixels elsewhere). */
  original(layer: Layer, r: Rect): Uint8ClampedArray {
    const out = layer.read(r);
    const t = this.tiles.get(layer);
    if (!t) return out;
    const tx1 = Math.floor(r.x / TILE);
    const ty1 = Math.floor(r.y / TILE);
    const tx2 = Math.floor((r.x + r.w - 1) / TILE);
    const ty2 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty1; ty <= ty2; ty++)
      for (let tx = tx1; tx <= tx2; tx++) {
        const key = `${tx},${ty}`;
        if (!t.before.has(key)) continue;
        const src = t.before.get(key);
        const tr = { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
        const part = intersect(tr, r);
        for (let y = part.y; y < part.y + part.h; y++) {
          const dst = ((y - r.y) * r.w + (part.x - r.x)) * 4;
          if (!src) out.fill(0, dst, dst + part.w * 4);
          else {
            const from = ((y - tr.y) * TILE + (part.x - tr.x)) * 4;
            out.set(src.subarray(from, from + part.w * 4), dst);
          }
        }
      }
    return out;
  }

  /** Records a change that isn't pixels. Make the change first; pass how to undo and redo it. */
  record(undo: () => void, redo: () => void, bytes = 64): void {
    this.ops.push({ undo, redo, bytes });
  }

  get isEmpty(): boolean {
    return !this.ops.length && ![...this.tiles.values()].some((t) => t.before.size);
  }

  /** Finishes the edit and adds it to the undo history (if anything changed). */
  commit(): void {
    if (this.done) return;
    this.done = true;
    const ops = [...this.ops];
    for (const [layer, t] of this.tiles) {
      const areaAfter = layer.bounds;
      const before = new Map<string, Uint8ClampedArray | null>();
      const after = new Map<string, Uint8ClampedArray | null>();
      let dirty: Rect = { x: 0, y: 0, w: 0, h: 0 };
      for (const [key, b] of t.before) {
        const r = tileRect(key);
        const data = layer.read(r);
        const a = allTransparent(data) ? null : data;
        if (sameBytes(b, a)) continue;
        before.set(key, b);
        after.set(key, a);
        dirty = union(dirty, r);
      }
      const areaBefore = t.area;
      if (!before.size && areaBefore.x === areaAfter.x && areaBefore.y === areaAfter.y && areaBefore.w === areaAfter.w && areaBefore.h === areaAfter.h) continue;
      const apply = (area: Rect, tiles: Map<string, Uint8ClampedArray | null>) => {
        layer.setArea(area);
        const blank = new Uint8ClampedArray(TILE * TILE * 4);
        for (const [key, data] of tiles) layer.write(tileRect(key), data ?? blank);
        this.doc.emit({ type: 'pixels', layer, rect: union(dirty, union(area, areaBefore)) });
      };
      let bytes = 256;
      for (const v of before.values()) bytes += v?.length ?? 0;
      for (const v of after.values()) bytes += v?.length ?? 0;
      ops.push({ undo: () => apply(areaBefore, before), redo: () => apply(areaAfter, after), bytes });
    }
    if (!ops.length) return;
    const bytes = ops.reduce((n, o) => n + o.bytes, 0);
    this.doc.history.push({
      label: this.label,
      bytes,
      undo: () => {
        for (let i = ops.length - 1; i >= 0; i--) ops[i].undo();
      },
      redo: () => {
        for (const o of ops) o.redo();
      },
    });
    this.doc.emit({ type: 'history' });
  }

  /** Throws the edit away, putting everything back as it was. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    for (const [layer, t] of this.tiles) {
      layer.setArea(t.area);
      const blank = new Uint8ClampedArray(TILE * TILE * 4);
      let dirty: Rect = { x: 0, y: 0, w: 0, h: 0 };
      for (const [key, data] of t.before) {
        layer.write(tileRect(key), data ?? blank);
        dirty = union(dirty, tileRect(key));
      }
      this.doc.emit({ type: 'pixels', layer, rect: dirty });
    }
    for (let i = this.ops.length - 1; i >= 0; i--) this.ops[i].undo();
  }
}

export interface DocMeta {
  /** Colors saved with the image (pixel art palettes). */
  palette?: string[];
  /** A grid drawn over the image, e.g. 16 for a block texture's tiles. */
  grid?: { size: number; show: boolean };
  /** Dots per inch (for printing; doesn't change the pixels). */
  dpi?: number;
  /** An animated texture: frames stacked top to bottom (Minecraft's .png.mcmeta). */
  animation?: AnimationMeta;
}

export interface AnimationMeta {
  /** Height of one frame in pixels (Minecraft: the image width). */
  frameHeight: number;
  /** How long each frame shows, in game ticks (20 per second). */
  frametime: number;
  /** Blend smoothly between frames (Minecraft's "interpolate"). */
  interpolate: boolean;
  /** Settings from an .mcmeta file that Pixelline doesn't edit (frame order…), written back as they were. */
  extra?: Record<string, unknown>;
}

export class ImageDoc {
  width: number;
  height: number;
  /** Bottom layer first. */
  layers: Layer[] = [];
  activeId = '';
  /** null: nothing selected (tools work everywhere). */
  selection: Mask | null = null;
  history = new History();
  meta: DocMeta = {};
  name = 'Untitled';
  filePath: string | null = null;
  /** The format it was opened from or last saved as. */
  fileType: string | null = null;
  private savedVersion = 0;
  private listeners = new Set<(e: DocEvent) => void>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get bounds(): Rect {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  get active(): Layer {
    return this.layers.find((l) => l.id === this.activeId) ?? this.layers[this.layers.length - 1];
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  setActive(id: string): void {
    if (id === this.activeId || !this.layer(id)) return;
    this.activeId = id;
    this.emit({ type: 'active' });
  }

  on(fn: (e: DocEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: DocEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Starts an edit that's finished later (a brush stroke ends when the mouse is released). */
  begin(label: string): Edit {
    return new Edit(this, label);
  }

  /** Runs `fn` as one undoable step. If it throws, nothing changes. */
  edit<T>(label: string, fn: (e: Edit) => T): T {
    const e = new Edit(this, label);
    let out: T;
    try {
      out = fn(e);
    } catch (err) {
      e.cancel();
      throw err;
    }
    e.commit();
    return out;
  }

  undo(): string | undefined {
    const c = this.history.undo();
    if (c) this.emit({ type: 'history' });
    return c?.label;
  }

  redo(): string | undefined {
    const c = this.history.redo();
    if (c) this.emit({ type: 'history' });
    return c?.label;
  }

  get dirty(): boolean {
    return this.history.version !== this.savedVersion;
  }

  markSaved(): void {
    this.savedVersion = this.history.version;
    this.emit({ type: 'history' });
  }

  /** Every pixel event for the whole image (after big changes). */
  repaintAll(): void {
    for (const layer of this.layers) this.emit({ type: 'pixels', layer, rect: layer.bounds });
  }
}
