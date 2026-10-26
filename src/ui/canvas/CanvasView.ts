// The canvas: shows a document zoomed and panned, and passes pointer input to the current tool.
//
// Each layer is kept as a GPU canvas, updated only where pixels change. They're composited into one
// image-sized canvas (only where something changed), so zooming and panning just redraws that one
// image. On top come the overlays: transparency checkerboard, pixel grid, tile grid, selection
// "marching ants" and what the current tool draws (brush outline, shape previews…).
import { flatten } from '../../core/blend';
import type { ImageDoc } from '../../core/document';
import { intersect, isEmpty, union, type Rect } from '../../core/geom';
import type { Layer } from '../../core/layer';
import type { App } from '../app';
import { openCanvasMenu } from '../canvasMenu';

export interface ViewState {
  zoom: number;
  /** Where the image's top-left corner is, in CSS pixels from the view's top-left. */
  panX: number;
  panY: number;
  /** Still at "fit to window" (refit when the window resizes). */
  fitted: boolean;
}

export interface PointerInfo {
  /** Image coordinates (fractional). */
  x: number;
  y: number;
  /** View coordinates (CSS pixels). */
  sx: number;
  sy: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
  e: PointerEvent;
}

/** Something drawn instead of a layer while a tool previews a change (moving pixels, filters…). */
export interface LayerPreview {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  x: number;
  y: number;
  /** Draw the layer's own pixels too, under the preview. */
  under?: boolean;
  /** Hide the layer's own pixels inside this area (where pixels were lifted out). */
  hole?: { canvas: HTMLCanvasElement | OffscreenCanvas; x: number; y: number };
}

interface LayerCanvas {
  canvas: OffscreenCanvas;
  x: number;
  y: number;
  w: number;
  h: number;
  dirty: Rect | null;
}

/** Tools whose right button opens the canvas menu (painting tools use it for the second colour). */
const MENU_TOOLS = new Set(['move', 'marquee', 'lasso', 'wand', 'crop', 'text', 'hand']);

export const ZOOMS = [0.01, 0.02, 0.03, 0.05, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128];

export class CanvasView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** The composited image, one canvas pixel per image pixel. */
  private flat: OffscreenCanvas = new OffscreenCanvas(1, 1);
  private flatCtx = this.flat.getContext('2d')!;
  private flatDirty: Rect | null = null;
  private layers = new Map<Layer, LayerCanvas>();
  private pattern: CanvasPattern | null = null;
  private workspace = '';
  private patternKey = '';
  doc: ImageDoc | null = null;
  view: ViewState = { zoom: 1, panX: 0, panY: 0, fitted: true };
  width = 0;
  height = 0;
  private dpr = 1;
  private queued = false;
  previews = new Map<Layer, LayerPreview>();
  /** Selection outline in image coordinates, recomputed when the selection changes. */
  private ants: Float32Array | null = null;
  private antsOffset = 0;
  /** Draws the selection outline moved (while its pixels are dragged). */
  antsShift: { dx: number; dy: number } | null = null;
  private antsTimer: number | null = null;
  private pointerDown = false;
  private panDrag: { sx: number; sy: number; px: number; py: number } | null = null;
  private spaceHeld = false;
  /** Last pointer position over the canvas (for the status bar and brush outlines). */
  hover: { x: number; y: number; sx: number; sy: number } | null = null;

  constructor(private app: App) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.tabIndex = 0;
    this.el.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    this.el.addEventListener('pointerleave', () => {
      if (!this.pointerDown) {
        this.hover = null;
        this.app.statusbar.update();
        this.draw();
      }
    });
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('dblclick', (e) => this.app.tools.current.dblclick?.(this.info(e as PointerEvent)));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTyping()) {
        this.spaceHeld = true;
        this.updateCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
  }

  // ---------- document ----------

  setDoc(doc: ImageDoc | null, view?: ViewState): void {
    this.doc = doc;
    this.layers.clear();
    this.previews.clear();
    if (view) this.view = view;
    this.resetFlat();
    this.selectionChanged();
    if (doc && this.view.fitted) this.fit();
    this.draw();
  }

  /** After the image size changed (resize, crop…). */
  resetFlat(): void {
    const d = this.doc;
    this.layers.clear();
    if (!d) return;
    if (this.flat.width !== d.width || this.flat.height !== d.height) {
      this.flat = new OffscreenCanvas(Math.max(1, d.width), Math.max(1, d.height));
      this.flatCtx = this.flat.getContext('2d')!;
    }
    this.flatDirty = d.bounds;
  }

  /** Pixels of a layer changed in `rect` (image coordinates). */
  pixelsChanged(layer: Layer, rect: Rect): void {
    const lc = this.layers.get(layer);
    if (lc) lc.dirty = lc.dirty ? union(lc.dirty, rect) : rect;
    this.invalidate(rect);
  }

  /** Something over an area needs compositing again (no layer pixels changed). */
  invalidate(rect?: Rect): void {
    if (!this.doc) return;
    const r = rect ? intersect(rect, this.doc.bounds) : this.doc.bounds;
    if (!isEmpty(r)) this.flatDirty = this.flatDirty ? union(this.flatDirty, r) : r;
    this.draw();
  }

  /** Layers were added, removed, reordered or changed settings. */
  layersChanged(): void {
    if (!this.doc) return;
    for (const l of [...this.layers.keys()]) if (!this.doc.layers.includes(l)) this.layers.delete(l);
    this.invalidate();
  }

  selectionChanged(): void {
    const sel = this.doc?.selection;
    this.ants = sel ? sel.outline() : null;
    const still = this.app.settings.bool('appearance.reduceMotion');
    if (this.ants && still && this.antsTimer) {
      clearInterval(this.antsTimer);
      this.antsTimer = null;
    } else if (this.ants && !still && !this.antsTimer) {
      this.antsTimer = window.setInterval(() => {
        this.antsOffset = (this.antsOffset + 1) % 8;
        this.draw();
      }, 120);
    } else if (!this.ants && this.antsTimer) {
      clearInterval(this.antsTimer);
      this.antsTimer = null;
    }
    this.draw();
  }

  // ---------- view transform ----------

  toImage(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.view.panX) / this.view.zoom, y: (sy - this.view.panY) / this.view.zoom };
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.view.zoom + this.view.panX, y: y * this.view.zoom + this.view.panY };
  }

  /** Zooms so the whole image fits, centred. */
  fit(): void {
    const d = this.doc;
    // Hidden or not laid out yet: the size observer fits it once it has a size
    if (!d || this.width < 120 || this.height < 120) return;
    const pad = 40;
    // The seamless preview shows half a tile around the image
    const k = this.app.prefs.tileMode ? 2 : 1;
    const z = Math.min((this.width - pad * 2) / (d.width * k), (this.height - pad * 2) / (d.height * k));
    // Pixel art: whole-number zooms keep every pixel the same size
    const zoom = z >= 1 && this.app.settings.bool('canvas.fitPixelArt') ? Math.max(1, Math.floor(z)) : z;
    this.setZoom(zoom, undefined, true);
    this.view.fitted = true;
  }

  /** Zooms keeping a view point (CSS px) still; centred on the image without one. */
  setZoom(zoom: number, at?: { x: number; y: number }, centre = false): void {
    const d = this.doc;
    zoom = Math.max(0.01, Math.min(128, zoom));
    if (d && (centre || !at)) {
      this.view.zoom = zoom;
      this.view.panX = Math.round((this.width - d.width * zoom) / 2);
      this.view.panY = Math.round((this.height - d.height * zoom) / 2);
    } else if (at) {
      const p = this.toImage(at.x, at.y);
      this.view.zoom = zoom;
      this.view.panX = Math.round(at.x - p.x * zoom);
      this.view.panY = Math.round(at.y - p.y * zoom);
    }
    this.view.fitted = false;
    this.app.statusbar.update();
    this.app.onViewChanged();
    this.draw();
  }

  zoomStep(dir: 1 | -1, at?: { x: number; y: number }): void {
    const z = this.view.zoom;
    const next = dir > 0 ? (ZOOMS.find((v) => v > z * 1.001) ?? 128) : ([...ZOOMS].reverse().find((v) => v < z / 1.001) ?? 0.01);
    this.setZoom(next, at ?? { x: this.width / 2, y: this.height / 2 });
  }

  panBy(dx: number, dy: number): void {
    this.view.panX += dx;
    this.view.panY += dy;
    this.view.fitted = false;
    this.app.onViewChanged();
    this.draw();
  }

  /** Centres the view on an image point. */
  centreOn(x: number, y: number): void {
    this.view.panX = Math.round(this.width / 2 - x * this.view.zoom);
    this.view.panY = Math.round(this.height / 2 - y * this.view.zoom);
    this.view.fitted = false;
    this.app.onViewChanged();
    this.draw();
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const oldW = this.width;
    const oldH = this.height;
    this.width = Math.max(1, Math.floor(r.width));
    this.height = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.view.fitted) this.fit();
    else if (oldW) {
      // Keep the middle of the view where it was
      this.view.panX += Math.round((this.width - oldW) / 2);
      this.view.panY += Math.round((this.height - oldH) / 2);
    }
    this.render();
  }

  // ---------- drawing ----------

  draw(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  /** Copies changed layer pixels to their GPU canvases. */
  private syncLayer(layer: Layer): LayerCanvas | null {
    const b = layer.bounds;
    if (!b.w || !b.h) {
      this.layers.delete(layer);
      return null;
    }
    let lc = this.layers.get(layer);
    if (!lc || lc.w !== b.w || lc.h !== b.h) {
      lc = { canvas: new OffscreenCanvas(b.w, b.h), x: b.x, y: b.y, w: b.w, h: b.h, dirty: b };
      this.layers.set(layer, lc);
    }
    if (lc.x !== b.x || lc.y !== b.y) {
      lc.x = b.x;
      lc.y = b.y;
    }
    if (lc.dirty) {
      const r = intersect(lc.dirty, b);
      lc.dirty = null;
      if (!isEmpty(r)) {
        const data = layer.read(r);
        lc.canvas.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), r.x - b.x, r.y - b.y);
      }
    }
    return lc;
  }

  /** A layer's canvas, up to date (for thumbnails and exports through the GPU). */
  layerCanvas(layer: Layer): OffscreenCanvas | null {
    return this.syncLayer(layer)?.canvas ?? null;
  }

  private composite(): void {
    const d = this.doc;
    if (!d || !this.flatDirty) return;
    const r = intersect(this.flatDirty, d.bounds);
    this.flatDirty = null;
    if (isEmpty(r)) return;
    const c = this.flatCtx;
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.clearRect(r.x, r.y, r.w, r.h);
    for (const layer of d.layers) {
      if (!layer.visible) continue;
      const lc = this.syncLayer(layer);
      const pv = this.previews.get(layer);
      c.globalAlpha = layer.opacity;
      c.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
      if (pv && !pv.under && !pv.hole) {
        c.drawImage(pv.canvas, pv.x, pv.y);
        continue;
      }
      if (lc) {
        if (pv?.hole) {
          // The layer with an area cut out (pixels being moved), then what's being moved
          const tmp = new OffscreenCanvas(lc.w, lc.h);
          const t = tmp.getContext('2d')!;
          t.drawImage(lc.canvas, 0, 0);
          t.globalCompositeOperation = 'destination-out';
          t.drawImage(pv.hole.canvas, pv.hole.x - lc.x, pv.hole.y - lc.y);
          c.drawImage(tmp, lc.x, lc.y);
        } else c.drawImage(lc.canvas, lc.x, lc.y);
      }
      if (pv) c.drawImage(pv.canvas, pv.x, pv.y);
    }
    c.restore();
  }

  /** After the theme changed: colours are read again. */
  refreshTheme(): void {
    this.workspace = '';
    this.patternKey = '';
    this.draw();
  }

  private checker(): CanvasPattern | null {
    const s = this.app.settings;
    const size = Math.max(2, s.num('canvas.checkerSize'));
    const mode = s.str('canvas.checker');
    const solid: Record<string, string> = { white: '#ffffff', black: '#000000' };
    if (solid[mode]) return null;
    const [a, b] = mode === 'dark' || (mode === 'checker' && this.app.isDark) ? ['#2b2f37', '#3a3f49'] : ['#ffffff', '#e3e6eb'];
    const key = `${size}|${a}|${b}|${this.dpr}`;
    if (key !== this.patternKey) {
      const n = Math.round(size * this.dpr);
      const tile = new OffscreenCanvas(n * 2, n * 2);
      const t = tile.getContext('2d')!;
      t.fillStyle = a;
      t.fillRect(0, 0, n * 2, n * 2);
      t.fillStyle = b;
      t.fillRect(n, 0, n, n);
      t.fillRect(0, n, n, n);
      this.pattern = this.ctx.createPattern(tile, 'repeat');
      this.patternKey = key;
    }
    return this.pattern;
  }

  render(): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.workspace) this.workspace = getComputedStyle(this.el).getPropertyValue('--workspace').trim() || '#101215';
    ctx.fillStyle = this.workspace;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const d = this.doc;
    if (!d) return;
    this.composite();
    const { zoom, panX, panY } = this.view;
    const W = d.width * zoom;
    const H = d.height * zoom;
    const tiled = this.app.prefs.tileMode;
    const smooth = zoom < 1 && this.app.settings.bool('canvas.smoothZoomOut');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Tile preview: the image repeated around itself, dimmed, to check a seamless texture
    const spots: [number, number, boolean][] = [[0, 0, true]];
    if (tiled) for (let ty = -1; ty <= 1; ty++) for (let tx = -1; tx <= 1; tx++) if (tx || ty) spots.push([tx, ty, false]);
    for (const [tx, ty, main] of spots) {
      const x = panX + tx * W;
      const y = panY + ty * H;
      if (x > this.width || y > this.height || x + W < 0 || y + H < 0) continue;
      // Checkerboard behind transparency (in screen space so its squares stay the same size)
      const pat = this.checker();
      const mode = this.app.settings.str('canvas.checker');
      if (pat || mode === 'white' || mode === 'black') {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = pat ?? (mode === 'white' ? '#ffffff' : '#000000');
        ctx.fillRect(Math.round(x * dpr), Math.round(y * dpr), Math.round(W * dpr), Math.round(H * dpr));
        ctx.restore();
      }
      ctx.imageSmoothingEnabled = smooth;
      // High-quality shrinking is slow on big images: use it once the pointer is up
      ctx.imageSmoothingQuality = this.pointerDown ? 'low' : 'high';
      ctx.drawImage(this.flat, x, y, W, H);
      if (!main) {
        ctx.fillStyle = this.app.isDark ? 'rgba(10,12,15,0.32)' : 'rgba(255,255,255,0.32)';
        ctx.fillRect(x, y, W, H);
      }
    }
    // Image border
    ctx.strokeStyle = this.app.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(panX) - 0.5, Math.round(panY) - 0.5, Math.round(W) + 1, Math.round(H) + 1);
    this.drawFrames(d);
    this.drawGrids(d);
    this.drawSymmetry(d);
    this.drawAnts();
    this.app.tools.current.overlay?.(ctx, this);
    this.drawBrushOutline();
  }

  /** The visible part of the image, in whole image pixels. */
  visibleRect(): Rect {
    const a = this.toImage(0, 0);
    const b = this.toImage(this.width, this.height);
    const d = this.doc!;
    return intersect({ x: Math.floor(a.x), y: Math.floor(a.y), w: Math.ceil(b.x) - Math.floor(a.x), h: Math.ceil(b.y) - Math.floor(a.y) }, d.bounds);
  }

  /** Animated textures: lines between the frames, their numbers, and onion skin on the current frame. */
  private drawFrames(d: ImageDoc): void {
    const anim = d.meta.animation;
    if (!anim || anim.frameHeight <= 0) return;
    const ctx = this.ctx;
    const { zoom, panX, panY } = this.view;
    const fh = anim.frameHeight;
    const count = Math.max(1, Math.floor(d.height / fh));
    const W = d.width * zoom;
    const current = this.app.panels.animation.frame;
    // The frame before the current one, faintly on top of it, to line up movement
    if (this.app.prefs.onionSkin && count > 1) {
      const prev = (current - 1 + count) % count;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.imageSmoothingEnabled = zoom < 1;
      ctx.drawImage(this.flat, 0, prev * fh, d.width, fh, panX, panY + current * fh * zoom, W, fh * zoom);
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(169,139,255,0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 1; i < count; i++) {
      const y = Math.round(panY + i * fh * zoom) + 0.5;
      ctx.moveTo(panX, y);
      ctx.lineTo(panX + W, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Frame numbers beside the image; the current frame's is highlighted
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    for (let i = 0; i < count; i++) {
      const y = panY + i * fh * zoom + 3;
      if (y < -20 || y > this.height) continue;
      ctx.fillStyle = i === current ? '#a98bff' : this.app.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.fillText(String(i + 1), panX - 6, y);
    }
    ctx.restore();
  }

  private drawGrids(d: ImageDoc): void {
    const ctx = this.ctx;
    const z = this.view.zoom;
    const vis = this.visibleRect();
    if (isEmpty(vis)) return;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    };
    const s = this.app.settings;
    if (this.app.prefs.pixelGrid && z >= s.num('canvas.pixelGridZoom')) {
      ctx.beginPath();
      const p0 = this.toScreen(vis.x, vis.y);
      const p1 = this.toScreen(vis.x + vis.w, vis.y + vis.h);
      for (let x = vis.x; x <= vis.x + vis.w; x++) {
        const sx = Math.round(this.toScreen(x, 0).x) + 0.5;
        line(sx, p0.y, sx, p1.y);
      }
      for (let y = vis.y; y <= vis.y + vis.h; y++) {
        const sy = Math.round(this.toScreen(0, y).y) + 0.5;
        line(p0.x, sy, p1.x, sy);
      }
      ctx.strokeStyle = this.app.isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const grid = d.meta.grid;
    if (grid?.show && grid.size >= 1 && grid.size * z >= 4) {
      ctx.beginPath();
      const g = grid.size;
      const p0 = this.toScreen(vis.x, vis.y);
      const p1 = this.toScreen(vis.x + vis.w, vis.y + vis.h);
      for (let x = Math.ceil(vis.x / g) * g; x <= vis.x + vis.w; x += g) {
        const sx = Math.round(this.toScreen(x, 0).x) + 0.5;
        line(sx, p0.y, sx, p1.y);
      }
      for (let y = Math.ceil(vis.y / g) * g; y <= vis.y + vis.h; y += g) {
        const sy = Math.round(this.toScreen(0, y).y) + 0.5;
        line(p0.x, sy, p1.x, sy);
      }
      ctx.strokeStyle = s.str('canvas.gridColor') || 'rgba(78,161,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawSymmetry(d: ImageDoc): void {
    const p = this.app.prefs;
    if (!p.mirrorX && !p.mirrorY) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255, 120, 200, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (p.mirrorX) {
      const x = Math.round(this.toScreen(d.width / 2, 0).x) + 0.5;
      ctx.moveTo(x, this.view.panY);
      ctx.lineTo(x, this.view.panY + d.height * this.view.zoom);
    }
    if (p.mirrorY) {
      const y = Math.round(this.toScreen(0, d.height / 2).y) + 0.5;
      ctx.moveTo(this.view.panX, y);
      ctx.lineTo(this.view.panX + d.width * this.view.zoom, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawAnts(): void {
    const seg = this.ants;
    if (!seg || !seg.length) return;
    const ctx = this.ctx;
    const dx = this.antsShift?.dx ?? 0;
    const dy = this.antsShift?.dy ?? 0;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 4) {
      const a = this.toScreen(seg[i] + dx, seg[i + 1] + dy);
      const b = this.toScreen(seg[i + 2] + dx, seg[i + 3] + dy);
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
      ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.antsOffset;
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -this.antsOffset + 4;
    ctx.stroke();
    ctx.restore();
  }

  /** The size and shape of the brush under the pointer. */
  private drawBrushOutline(): void {
    const tool = this.app.tools.current;
    const shape = tool.brushOutline?.();
    if (!shape || !this.hover || this.spaceHeld) return;
    const ctx = this.ctx;
    const z = this.view.zoom;
    const size = Math.max(1, shape.size);
    let cx = this.hover.x;
    let cy = this.hover.y;
    if (shape.hard) {
      // Snap to pixels like the pencil does
      if (Math.round(size) % 2) {
        cx = Math.floor(cx) + 0.5;
        cy = Math.floor(cy) + 0.5;
      } else {
        cx = Math.round(cx);
        cy = Math.round(cy);
      }
    }
    const c = this.toScreen(cx, cy);
    const r = (size / 2) * z;
    ctx.save();
    ctx.lineWidth = 1;
    const path = () => {
      ctx.beginPath();
      if (shape.square) ctx.rect(Math.round(c.x - r) + 0.5, Math.round(c.y - r) + 0.5, Math.round(r * 2), Math.round(r * 2));
      else ctx.arc(c.x, c.y, Math.max(1, r), 0, Math.PI * 2);
    };
    const cross = this.app.settings.str('painting.cursor') === 'cross';
    if (r >= 3 && !cross) {
      path();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.stroke();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
    // A small crosshair for tiny brushes
    if (r < 6 || cross) {
      ctx.setLineDash([]);
      ctx.strokeStyle = this.app.isDark ? '#fff' : '#000';
      ctx.beginPath();
      ctx.moveTo(c.x - 6, c.y + 0.5);
      ctx.lineTo(c.x - 2, c.y + 0.5);
      ctx.moveTo(c.x + 2, c.y + 0.5);
      ctx.lineTo(c.x + 6, c.y + 0.5);
      ctx.moveTo(c.x + 0.5, c.y - 6);
      ctx.lineTo(c.x + 0.5, c.y - 2);
      ctx.moveTo(c.x + 0.5, c.y + 2);
      ctx.lineTo(c.x + 0.5, c.y + 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- input ----------

  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const p = this.toImage(sx, sy);
    const pe = e as PointerEvent;
    // Mice report 0.5 while pressed; only pens give real pressure
    const pressure = pe.pointerType === 'pen' && this.app.settings.bool('painting.pressure') ? Math.max(0.01, pe.pressure) : 1;
    return { x: p.x, y: p.y, sx, sy, pressure, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button, e: pe };
  }

  private onDown(e: PointerEvent): void {
    this.el.focus({ preventScroll: true });
    if (!this.doc) return;
    // Middle button or Space+drag pans; the Hand tool too
    if (e.button === 1 || (e.button === 0 && this.spaceHeld) || (e.button === 0 && this.app.tools.current.id === 'hand')) {
      e.preventDefault();
      this.panDrag = { sx: e.clientX, sy: e.clientY, px: this.view.panX, py: this.view.panY };
      this.el.setPointerCapture(e.pointerId);
      this.el.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    // Tools that don't use the right button get a menu there instead
    if (e.button === 2 && MENU_TOOLS.has(this.app.tools.current.id)) {
      openCanvasMenu(this.app, e.clientX, e.clientY);
      return;
    }
    const info = this.info(e);
    // In an animation, clicking a frame makes it the current one (for onion skin)
    if (this.doc.meta.animation) this.app.panels.animation.pointerAt(info.y);
    this.pointerDown = true;
    this.el.setPointerCapture(e.pointerId);
    try {
      this.app.tools.current.down?.(info);
    } catch (err) {
      this.app.error(err);
    }
    this.draw();
  }

  private onMove(e: PointerEvent): void {
    const info = this.info(e);
    this.hover = { x: info.x, y: info.y, sx: info.sx, sy: info.sy };
    if (this.panDrag) {
      this.view.panX = this.panDrag.px + (e.clientX - this.panDrag.sx);
      this.view.panY = this.panDrag.py + (e.clientY - this.panDrag.sy);
      this.view.fitted = false;
      this.app.onViewChanged();
      this.draw();
      return;
    }
    const tool = this.app.tools.current;
    try {
      if (this.pointerDown) {
        // Use every pointer sample (pens and fast mice send several per frame)
        const samples = e.getCoalescedEvents?.() ?? [];
        if (samples.length > 1) for (const s of samples) tool.move?.(this.info(s));
        else tool.move?.(info);
      } else tool.hover?.(info);
    } catch (err) {
      this.app.error(err);
    }
    this.statusQueued ||= requestAnimationFrame(() => {
      this.statusQueued = 0;
      this.app.statusbar.update();
    });
    this.draw();
  }

  private statusQueued = 0;

  private onUp(e: PointerEvent, cancelled = false): void {
    if (this.panDrag) {
      this.panDrag = null;
      this.updateCursor();
      return;
    }
    if (!this.pointerDown) return;
    this.pointerDown = false;
    try {
      if (cancelled) this.app.tools.current.cancel?.();
      else this.app.tools.current.up?.(this.info(e));
    } catch (err) {
      this.app.error(err);
    }
    this.draw();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.doc) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    const zoomWheel = this.app.settings.str('canvas.wheel') !== 'scroll';
    if (e.ctrlKey || (zoomWheel && !e.shiftKey)) {
      // Trackpad pinches arrive as small ctrl+wheel steps
      if (Math.abs(e.deltaY) < 20 && e.ctrlKey) this.setZoom(this.view.zoom * Math.exp(-e.deltaY * 0.01), at);
      else this.zoomStep(e.deltaY < 0 ? 1 : -1, at);
      return;
    }
    this.panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), e.shiftKey && !e.deltaX ? 0 : -e.deltaY);
  }

  updateCursor(): void {
    if (this.spaceHeld) {
      this.el.style.cursor = 'grab';
      return;
    }
    this.el.style.cursor = this.app.tools.current.cursor?.() ?? 'crosshair';
  }

  /** The colour drawn at an image pixel (all visible layers), or null outside. */
  colorAt(x: number, y: number): { r: number; g: number; b: number; a: number } | null {
    const d = this.doc;
    if (!d || x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    // Composited on the CPU: reading a pixel back from the GPU stalls drawing
    const p = flatten(d, { x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 }).data;
    return { r: p[0], g: p[1], b: p[2], a: p[3] };
  }

  /** A snapshot of the composited image (fast, through the GPU), e.g. for the navigator. */
  get composited(): OffscreenCanvas {
    this.composite();
    return this.flat;
  }

}

function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable);
}
