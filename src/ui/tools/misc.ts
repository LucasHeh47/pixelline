// Eyedropper, hand, zoom, crop and text.
import * as L from 'lucide';
import { cssColor, toHex } from '../../core/color';
import { intersect, isEmpty, type Point, type Rect } from '../../core/geom';
import { Layer } from '../../core/layer';
import { addLayer, cropImage, nextLayerName } from '../../core/ops';
import { Raster } from '../../core/raster';
import type { App } from '../app';
import type { PointerInfo } from '../canvas/CanvasView';
import { dropdown, segmented, sep, slider, toggle } from '../controls';
import { h, icon } from '../dom';
import { pickColor } from './paint';
import type { Tool } from './tool';

export class EyedropperTool implements Tool {
  id = 'eyedropper';
  name = 'Eyedropper';
  icon = L.Pipette;
  key = 'I';
  hint = 'Click to pick a colour as the primary colour (right-click: secondary). Hold Alt with any paint tool to pick too.';
  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('eyedropper', { merged: true, back: false });
  }

  cursor(): string {
    return 'crosshair';
  }

  down(p: PointerInfo): void {
    pickColor(this.app, p, p.button === 2 || p.alt, this.o().merged);
  }

  move(p: PointerInfo): void {
    pickColor(this.app, p, p.button === 2 || p.alt, this.o().merged);
  }

  up(): void {
    // Go back to the previous tool after picking (handy for painting)
    if (this.o().back && this.app.prevTool) this.app.tools.select(this.app.prevTool);
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => this.app.tools.options.set('eyedropper', v);
    return [
      dropdown<'all' | 'layer'>(
        'Sample',
        [
          ['all', 'All layers'],
          ['layer', 'This layer'],
        ],
        o.merged ? 'all' : 'layer',
        (v) => set({ merged: v === 'all' }),
      ),
      toggle('Back to the previous tool after picking', o.back, (v) => set({ back: v })),
    ];
  }
}

export class HandTool implements Tool {
  id = 'hand';
  name = 'Hand';
  icon = L.Hand;
  key = 'H';
  hint = 'Drag to move around. Hold Space with any tool, or drag with the middle mouse button.';
  constructor(private app: App) {}
  cursor(): string {
    return 'grab';
  }
  options(): HTMLElement[] {
    const b = (label: string, run: () => void) => h('button', { class: 'btn outline', onclick: run }, label);
    return [b('Fit on screen', () => this.app.view.fit()), b('100%', () => this.app.view.setZoom(1, undefined, true))];
  }
}

export class ZoomTool implements Tool {
  id = 'zoom';
  name = 'Zoom';
  icon = L.ZoomIn;
  key = 'Z';
  hint = 'Click to zoom in, Alt+click (or right-click) to zoom out, drag around an area to zoom to it.';
  private from: { sx: number; sy: number } | null = null;
  private to: { sx: number; sy: number } | null = null;
  constructor(private app: App) {}
  cursor(): string {
    return 'zoom-in';
  }
  down(p: PointerInfo): void {
    this.from = { sx: p.sx, sy: p.sy };
    this.to = { ...this.from };
  }
  move(p: PointerInfo): void {
    if (this.from) this.to = { sx: p.sx, sy: p.sy };
  }
  up(p: PointerInfo): void {
    const view = this.app.view;
    const from = this.from;
    this.from = this.to = null;
    if (!from) return;
    const w = Math.abs(p.sx - from.sx);
    const hh = Math.abs(p.sy - from.sy);
    if (w > 8 && hh > 8) {
      const a = view.toImage(Math.min(p.sx, from.sx), Math.min(p.sy, from.sy));
      const b = view.toImage(Math.max(p.sx, from.sx), Math.max(p.sy, from.sy));
      const z = Math.min(view.width / (b.x - a.x), view.height / (b.y - a.y));
      view.setZoom(z, undefined);
      view.centreOn((a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    view.zoomStep(p.alt || p.button === 2 ? -1 : 1, { x: p.sx, y: p.sy });
  }
  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.from || !this.to) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(Math.min(this.from.sx, this.to.sx) + 0.5, Math.min(this.from.sy, this.to.sy) + 0.5, Math.abs(this.to.sx - this.from.sx), Math.abs(this.to.sy - this.from.sy));
    ctx.restore();
  }
  options(): HTMLElement[] {
    const b = (label: string, run: () => void) => h('button', { class: 'btn outline', onclick: run }, label);
    return [b('Zoom in', () => this.app.view.zoomStep(1)), b('Zoom out', () => this.app.view.zoomStep(-1)), b('Fit on screen', () => this.app.view.fit()), b('100%', () => this.app.view.setZoom(1, undefined, true))];
  }
}

type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'new';

export class CropTool implements Tool {
  id = 'crop';
  name = 'Crop';
  icon = L.Crop;
  key = 'C';
  hint = 'Drag to choose the part to keep, adjust the edges, then press Enter (or double-click). Esc cancels.';
  private rect: Rect | null = null;
  private drag: { handle: CropHandle; from: Point; rect: Rect } | null = null;
  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('crop', { ratio: 'free', deletePixels: true });
  }

  activate(): void {
    const doc = this.app.doc;
    this.rect = doc ? (doc.selection?.bounds ?? null) : null;
  }

  deactivate(): void {
    this.rect = null;
    this.drag = null;
  }

  cursor(): string {
    return 'crosshair';
  }

  private handleAt(p: PointerInfo): CropHandle {
    const r = this.rect;
    if (!r) return 'new';
    const view = this.app.view;
    const a = view.toScreen(r.x, r.y);
    const b = view.toScreen(r.x + r.w, r.y + r.h);
    const near = (v: number, t: number) => Math.abs(v - t) < 7;
    const inX = p.sx > a.x - 7 && p.sx < b.x + 7;
    const inY = p.sy > a.y - 7 && p.sy < b.y + 7;
    const n = near(p.sy, a.y) && inX;
    const s = near(p.sy, b.y) && inX;
    const w = near(p.sx, a.x) && inY;
    const e = near(p.sx, b.x) && inY;
    if (n && w) return 'nw';
    if (n && e) return 'ne';
    if (s && w) return 'sw';
    if (s && e) return 'se';
    if (n) return 'n';
    if (s) return 's';
    if (w) return 'w';
    if (e) return 'e';
    if (p.sx > a.x && p.sx < b.x && p.sy > a.y && p.sy < b.y) return 'move';
    return 'new';
  }

  hover(p: PointerInfo): void {
    const hd = this.handleAt(p);
    const cur: Record<CropHandle, string> = { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', new: 'crosshair' };
    this.app.view.el.style.cursor = cur[hd];
  }

  down(p: PointerInfo): void {
    const handle = this.handleAt(p);
    const from = { x: Math.round(p.x), y: Math.round(p.y) };
    this.drag = { handle, from, rect: this.rect ?? { x: from.x, y: from.y, w: 0, h: 0 } };
  }

  move(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const r0 = d.rect;
    let x1 = r0.x;
    let y1 = r0.y;
    let x2 = r0.x + r0.w;
    let y2 = r0.y + r0.h;
    if (d.handle === 'new') {
      x1 = d.from.x;
      y1 = d.from.y;
      x2 = x;
      y2 = y;
    } else if (d.handle === 'move') {
      const dx = x - d.from.x;
      const dy = y - d.from.y;
      x1 += dx;
      x2 += dx;
      y1 += dy;
      y2 += dy;
    } else {
      if (d.handle.includes('w')) x1 = x;
      if (d.handle.includes('e')) x2 = x;
      if (d.handle.includes('n')) y1 = y;
      if (d.handle.includes('s')) y2 = y;
    }
    let r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    const ratio = this.ratio();
    if (ratio && d.handle !== 'move') {
      // Keep the aspect ratio by fitting the height to the width
      const hh = Math.round(r.w / ratio);
      if (y2 < y1 || d.handle.includes('n')) r = { ...r, y: r.y + r.h - hh, h: hh };
      else r = { ...r, h: hh };
    }
    this.rect = r;
    this.app.tools.changed();
  }

  private ratio(): number | null {
    const o = this.o();
    const doc = this.app.doc!;
    if (o.ratio === '1:1') return 1;
    if (o.ratio === '16:9') return 16 / 9;
    if (o.ratio === '4:3') return 4 / 3;
    if (o.ratio === '3:2') return 3 / 2;
    if (o.ratio === 'image') return doc.width / doc.height;
    return null;
  }

  up(): void {
    this.drag = null;
    if (this.rect && (this.rect.w < 1 || this.rect.h < 1)) this.rect = null;
  }

  dblclick(): void {
    this.apply();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && this.rect) {
      this.apply();
      return true;
    }
    if (e.key === 'Escape' && this.rect) {
      this.rect = null;
      this.app.view.draw();
      return true;
    }
    return false;
  }

  apply(): void {
    const doc = this.app.doc;
    const r = this.rect;
    if (!doc || !r || r.w < 1 || r.h < 1) return;
    this.rect = null;
    doc.edit('Crop', (e) => cropImage(doc, e, r, this.o().deletePixels));
    this.app.view.fit();
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const r = this.rect;
    if (!r) return;
    const view = this.app.view;
    const a = view.toScreen(r.x, r.y);
    const b = view.toScreen(r.x + r.w, r.y + r.h);
    ctx.save();
    // Darken what will be cut away
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    // Rule of thirds
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = a.x + ((b.x - a.x) * i) / 3;
      const y = a.y + ((b.y - a.y) * i) / 3;
      ctx.moveTo(x, a.y);
      ctx.lineTo(x, b.y);
      ctx.moveTo(a.x, y);
      ctx.lineTo(b.x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of [
      [a.x, a.y],
      [b.x, a.y],
      [a.x, b.y],
      [b.x, b.y],
      [(a.x + b.x) / 2, a.y],
      [(a.x + b.x) / 2, b.y],
      [a.x, (a.y + b.y) / 2],
      [b.x, (a.y + b.y) / 2],
    ])
      ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.restore();
  }

  status(): string {
    return this.rect ? `Crop to ${this.rect.w} × ${this.rect.h} — Enter to apply` : '';
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => this.app.tools.options.set('crop', v);
    return [
      dropdown(
        'Ratio',
        [
          ['free', 'Free'],
          ['1:1', 'Square (1:1)'],
          ['16:9', '16:9'],
          ['4:3', '4:3'],
          ['3:2', '3:2'],
          ['image', 'Like the image'],
        ],
        o.ratio,
        (v) => set({ ratio: v }),
      ),
      toggle('Delete cropped pixels', o.deletePixels, (v) => set({ deletePixels: v }), 'Off keeps them (outside the image) so you can move layers back later'),
      sep(),
      h('button', { class: 'btn primary', onclick: () => this.apply(), disabled: !this.rect }, icon(L.Check, 15), 'Crop'),
      h('button', { class: 'btn outline', onclick: () => {
        this.rect = null;
        this.app.tools.changed();
        this.app.view.draw();
      }, disabled: !this.rect }, 'Cancel'),
    ];
  }
}

const FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Consolas', 'Impact', 'Comic Sans MS', 'Lucida Console'];

/** Text: click to place a box, type, then click elsewhere or press Ctrl+Enter. The text becomes a new layer. */
export class TextTool implements Tool {
  id = 'text';
  name = 'Text';
  icon = L.Type;
  key = 'T';
  hint = 'Click where the text goes and type. Ctrl+Enter or clicking elsewhere finishes; Esc cancels. Turn off smoothing for crisp pixel text.';
  private box: HTMLTextAreaElement | null = null;
  private at: Point | null = null;
  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('text', { font: 'Segoe UI', size: 24, bold: false, italic: false, smooth: true, align: 'left' as CanvasTextAlign });
  }

  cursor(): string {
    return 'text';
  }

  down(p: PointerInfo): void {
    if (this.box) {
      this.commit();
      return;
    }
    const doc = this.app.doc!;
    if (p.x < 0 || p.y < 0 || p.x > doc.width || p.y > doc.height) return;
    this.at = { x: Math.round(p.x), y: Math.round(p.y) };
    this.open();
  }

  private font(): string {
    const o = this.o();
    return `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : ''}${o.size}px "${o.font}", sans-serif`;
  }

  private open(): void {
    const view = this.app.view;
    const at = this.at!;
    const s = view.toScreen(at.x, at.y);
    const o = this.o();
    const box = h('textarea', { class: 'text-tool-box', spellcheck: false, rows: 1 }) as HTMLTextAreaElement;
    box.style.left = `${s.x}px`;
    box.style.top = `${s.y}px`;
    box.style.font = this.font().replace(`${o.size}px`, `${o.size * view.view.zoom}px`);
    box.style.color = cssColor(this.app.colors.fg);
    box.style.textAlign = o.align;
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit();
      }
    });
    const grow = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight}px`;
      box.style.width = 'auto';
      box.style.width = `${Math.max(40, box.scrollWidth + 4)}px`;
    };
    box.addEventListener('input', grow);
    view.el.append(box);
    this.box = box;
    setTimeout(() => {
      box.focus();
      grow();
    }, 0);
  }

  private close(): void {
    this.box?.remove();
    this.box = null;
    this.app.view.el.focus();
  }

  /** Draws the text into a new layer. */
  commit(): void {
    const box = this.box;
    const at = this.at;
    const doc = this.app.doc;
    if (!box || !at || !doc) return this.close();
    const text = box.value.replace(/\s+$/, '');
    this.close();
    if (!text) return;
    const o = this.o();
    const lines = text.split('\n');
    const m = new OffscreenCanvas(1, 1).getContext('2d')!;
    m.font = this.font();
    const lineH = Math.round(o.size * 1.25);
    const width = Math.ceil(Math.max(...lines.map((l) => m.measureText(l).width))) + 4;
    const height = lineH * lines.length + Math.ceil(o.size * 0.3);
    const c = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const g = c.getContext('2d')!;
    g.font = this.font();
    g.textBaseline = 'top';
    g.textAlign = o.align;
    g.fillStyle = toHex(this.app.colors.fg, false);
    const x = o.align === 'center' ? width / 2 : o.align === 'right' ? width - 2 : 2;
    lines.forEach((l, i) => g.fillText(l, x, i * lineH + 1));
    const img = g.getImageData(0, 0, c.width, c.height);
    const data = new Uint8ClampedArray(img.data);
    const fg = this.app.colors.fg;
    // Canvas text is drawn with premultiplied edges: give every pixel the exact colour, keep its coverage
    for (let i = 0; i < data.length; i += 4) {
      let a = data[i + 3];
      if (!o.smooth) a = a >= 128 ? 255 : 0;
      data[i] = fg.r;
      data[i + 1] = fg.g;
      data[i + 2] = fg.b;
      data[i + 3] = (a * fg.a) / 255;
    }
    const raster = new Raster(c.width, c.height, data);
    const left = o.align === 'center' ? at.x - Math.round(width / 2) : o.align === 'right' ? at.x - width : at.x;
    const layer = new Layer(text.split('\n')[0].slice(0, 24) || nextLayerName(doc, 'Text'), raster, left, at.y);
    layer.trim();
    if (isEmpty(intersect(layer.bounds, doc.bounds))) return;
    doc.edit('Text', (e) => addLayer(doc, e, layer));
  }

  deactivate(): void {
    if (this.box) this.commit();
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => {
      this.app.tools.options.set('text', v);
      if (this.box) {
        const view = this.app.view;
        this.box.style.font = this.font().replace(`${this.o().size}px`, `${this.o().size * view.view.zoom}px`);
        this.box.style.textAlign = this.o().align;
      }
    };
    return [
      dropdown(
        null,
        FONTS.map((f) => [f, f] as [string, string]),
        FONTS.includes(o.font) ? o.font : FONTS[0],
        (v) => set({ font: v }),
        'Font',
      ),
      slider({ label: 'Size', min: 4, max: 400, value: o.size, unit: 'px', log: true, width: 90, onChange: (v) => set({ size: v }) }),
      toggle('Bold', o.bold, (v) => set({ bold: v })),
      toggle('Italic', o.italic, (v) => set({ italic: v })),
      segmented<CanvasTextAlign>(
        [
          { value: 'left', icon: L.AlignLeft, title: 'Left' },
          { value: 'center', icon: L.AlignCenter, title: 'Centre' },
          { value: 'right', icon: L.AlignRight, title: 'Right' },
        ],
        o.align,
        (v) => set({ align: v }),
      ),
      sep(),
      toggle('Smooth edges', o.smooth, (v) => set({ smooth: v }), 'Off gives crisp pixel text (best at small sizes)'),
    ];
  }
}
