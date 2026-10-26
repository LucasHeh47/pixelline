// Move tool (drag a layer, or the selected pixels) and Free transform (scale, rotate, flip).
import * as L from 'lucide';
import { eraseSelection, liftSelection, offsetLayer, pasteInto, replacePixels, setSelection } from '../../core/ops';
import { isEmpty, union, type Point, type Rect } from '../../core/geom';
import type { Layer } from '../../core/layer';
import { Raster } from '../../core/raster';
import { Mask } from '../../core/selection';
import { apply as applyM, multiply, transformRaster, type Matrix, type Resample } from '../../core/transform';
import type { App } from '../app';
import type { PointerInfo } from '../canvas/CanvasView';
import { maskCanvas, rasterCanvas } from '../canvas/util';
import { dropdown, sep, toggle } from '../controls';
import { h, icon } from '../dom';
import { toast, tooltip } from '../widgets';
import { shiftMask } from './select';
import type { Tool } from './tool';

export class MoveTool implements Tool {
  id = 'move';
  name = 'Move';
  icon = L.Move;
  key = 'V';
  hint = 'Drag to move the layer, or the selected pixels. Arrow keys nudge by a pixel (Shift: 10).';
  private drag: { from: Point; layer: Layer; start: Point; floating?: { raster: Raster; x: number; y: number; mask: Mask } } | null = null;
  private delta = { dx: 0, dy: 0 };

  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('move', { autoSelect: false, bounds: true });
  }

  cursor(): string {
    return 'move';
  }

  /** The topmost visible layer with a pixel at (x, y). */
  private layerAt(x: number, y: number): Layer | undefined {
    const doc = this.app.doc!;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible || l.locked) continue;
      const o = l.offset(Math.floor(x), Math.floor(y));
      if (o >= 0 && l.raster.data[o + 3] > 0) return l;
    }
    return undefined;
  }

  down(p: PointerInfo): void {
    const doc = this.app.doc!;
    let layer = doc.active;
    if (this.o().autoSelect && !doc.selection) {
      const hit = this.layerAt(p.x, p.y);
      if (hit) {
        doc.setActive(hit.id);
        layer = hit;
      }
    }
    if (layer.locked) {
      toast(`"${layer.name}" is locked.`);
      return;
    }
    this.delta = { dx: 0, dy: 0 };
    if (doc.selection) {
      const lifted = liftSelection(doc, layer);
      if (!lifted) return;
      const mask = doc.selection;
      this.drag = { from: { x: p.x, y: p.y }, layer, start: { x: layer.x, y: layer.y }, floating: { ...lifted, mask } };
      this.preview();
      return;
    }
    this.drag = { from: { x: p.x, y: p.y }, layer, start: { x: layer.x, y: layer.y } };
  }

  private preview(): void {
    const d = this.drag;
    if (!d?.floating) return;
    const f = d.floating;
    const area = { x: f.x, y: f.y, w: f.raster.width, h: f.raster.height };
    this.app.view.previews.set(d.layer, {
      canvas: rasterCanvas(f.raster),
      x: f.x + this.delta.dx,
      y: f.y + this.delta.dy,
      hole: { canvas: maskCanvas(f.mask, area), x: area.x, y: area.y },
    });
    this.app.view.antsShift = { ...this.delta };
    this.app.view.invalidate();
  }

  move(p: PointerInfo): void {
    const d = this.drag;
    if (!d) return;
    // Snapping moves in whole tiles
    const n = this.app.snapSize() ?? 1;
    let dx = Math.round((p.x - d.from.x) / n) * n;
    let dy = Math.round((p.y - d.from.y) / n) * n;
    // Shift keeps it straight
    if (p.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    this.delta = { dx, dy };
    if (d.floating) {
      const pv = this.app.view.previews.get(d.layer);
      if (pv) {
        pv.x = d.floating.x + dx;
        pv.y = d.floating.y + dy;
      }
      this.app.view.antsShift = { dx, dy };
      this.app.view.invalidate();
      return;
    }
    const old = d.layer.bounds;
    d.layer.x = d.start.x + dx;
    d.layer.y = d.start.y + dy;
    this.app.view.pixelsChanged(d.layer, union(old, d.layer.bounds));
  }

  up(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.finish(d.layer, d.start, this.delta, d.floating);
  }

  private finish(layer: Layer, start: Point, delta: { dx: number; dy: number }, floating?: { raster: Raster; x: number; y: number; mask: Mask }): void {
    const doc = this.app.doc!;
    const view = this.app.view;
    view.previews.delete(layer);
    view.antsShift = null;
    const { dx, dy } = delta;
    if (floating) {
      view.invalidate();
      if (!dx && !dy) return;
      doc.edit('Move pixels', (e) => {
        eraseSelection(doc, e, layer);
        pasteInto(doc, e, layer, floating.raster, floating.x + dx, floating.y + dy);
        setSelection(doc, e, shiftMask(floating.mask, dx, dy));
      });
      return;
    }
    // Put it back, then move it as an undoable step
    const old = layer.bounds;
    layer.x = start.x;
    layer.y = start.y;
    view.pixelsChanged(layer, union(old, layer.bounds));
    if (dx || dy) doc.edit('Move layer', (e) => offsetLayer(doc, e, layer, dx, dy));
  }

  cancel(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.finish(d.layer, d.start, { dx: 0, dy: 0 }, d.floating);
  }

  onKey(e: KeyboardEvent): boolean {
    const doc = this.app.doc;
    if (!doc || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || e.ctrlKey || e.altKey) return false;
    const n = this.app.snapSize() ?? (e.shiftKey ? 10 : 1);
    const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
    const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
    const layer = doc.active;
    if (layer.locked) return true;
    if (doc.selection) {
      const lifted = liftSelection(doc, layer);
      if (lifted) this.finish(layer, { x: layer.x, y: layer.y }, { dx, dy }, { ...lifted, mask: doc.selection });
    } else doc.edit('Nudge layer', (ed) => offsetLayer(doc, ed, layer, dx, dy));
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const doc = this.app.doc;
    if (!doc || !this.o().bounds) return;
    const l = doc.active;
    const c = l.raster.contentBounds();
    if (isEmpty(c)) return;
    const view = this.app.view;
    const a = view.toScreen(l.x + c.x, l.y + c.y);
    const b = view.toScreen(l.x + c.x + c.w, l.y + c.y + c.h);
    ctx.save();
    ctx.strokeStyle = 'rgba(169,139,255,0.9)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx.restore();
  }

  /** Lines a layer's pixels up with the image (or the selection). */
  align(how: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): void {
    const doc = this.app.doc!;
    const l = doc.active;
    const c = l.raster.contentBounds();
    if (isEmpty(c) || l.locked) return;
    const target: Rect = doc.selection?.bounds ?? doc.bounds;
    const x = l.x + c.x;
    const y = l.y + c.y;
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = target.x - x;
    if (how === 'right') dx = target.x + target.w - (x + c.w);
    if (how === 'hcenter') dx = Math.round(target.x + (target.w - c.w) / 2) - x;
    if (how === 'top') dy = target.y - y;
    if (how === 'bottom') dy = target.y + target.h - (y + c.h);
    if (how === 'vcenter') dy = Math.round(target.y + (target.h - c.h) / 2) - y;
    if (dx || dy) doc.edit('Align layer', (e) => offsetLayer(doc, e, l, dx, dy));
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => {
      this.app.tools.options.set('move', v);
      this.app.view.draw();
    };
    const alignBtn = (how: Parameters<MoveTool['align']>[0], ic: L.IconNode, title: string) => {
      const b = h('button', { class: 'btn icon-only', 'aria-label': title, onclick: () => this.align(how) }, icon(ic, 16));
      tooltip(b, title);
      return b;
    };
    return [
      toggle('Pick layer by clicking', o.autoSelect, (v) => set({ autoSelect: v }), 'Clicking picks the topmost layer with a pixel there'),
      toggle('Show bounds', o.bounds, (v) => set({ bounds: v })),
      sep(),
      h(
        'div',
        { class: 'ctl ctl-group' },
        alignBtn('left', L.AlignStartVertical, 'Align left edges'),
        alignBtn('hcenter', L.AlignCenterVertical, 'Centre horizontally'),
        alignBtn('right', L.AlignEndVertical, 'Align right edges'),
        alignBtn('top', L.AlignStartHorizontal, 'Align top edges'),
        alignBtn('vcenter', L.AlignCenterHorizontal, 'Centre vertically'),
        alignBtn('bottom', L.AlignEndHorizontal, 'Align bottom edges'),
      ),
    ];
  }
}

// ---------- free transform ----------

interface TState {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  angle: number;
}

type Handle = { kind: 'scale'; hx: number; hy: number } | { kind: 'rotate' } | { kind: 'move' };

export class TransformTool implements Tool {
  id = 'transform';
  name = 'Free transform';
  icon = L.Scaling;
  hint = 'Drag the handles to scale (Shift keeps the shape, Alt scales from the middle), drag outside to rotate (Shift snaps to 15°), drag inside to move. Enter applies, Esc cancels.';
  private layer: Layer | null = null;
  private src: Raster | null = null;
  private srcCanvas: OffscreenCanvas | null = null;
  private origin = { x: 0, y: 0 };
  private floating: Mask | null = null;
  private st: TState = { cx: 0, cy: 0, sx: 1, sy: 1, angle: 0 };
  private drag: { handle: Handle; from: Point; st: TState } | null = null;
  private returnTo = 'move';

  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('transform', { method: 'nearest' as Resample });
  }

  /** Starts transforming the active layer, or the selected pixels. */
  begin(returnTo: string): boolean {
    const doc = this.app.doc;
    if (!doc) return false;
    const layer = doc.active;
    if (layer.locked) {
      toast(`"${layer.name}" is locked.`);
      return false;
    }
    this.returnTo = returnTo;
    if (doc.selection) {
      const lifted = liftSelection(doc, layer);
      if (!lifted) return false;
      this.src = lifted.raster;
      this.origin = { x: lifted.x, y: lifted.y };
      this.floating = doc.selection;
    } else {
      const c = layer.raster.contentBounds();
      if (isEmpty(c)) {
        toast('This layer is empty.');
        return false;
      }
      this.src = layer.raster.crop(c);
      this.origin = { x: layer.x + c.x, y: layer.y + c.y };
      this.floating = null;
    }
    this.layer = layer;
    this.srcCanvas = rasterCanvas(this.src);
    // Pixel art keeps hard pixels; anything with soft edges or many colours (brush strokes,
    // photos) is resampled smoothly, unless a quality was picked by hand
    if (!this.app.tools.options.get('transform', { chosen: false }).chosen) this.app.tools.options.set('transform', { method: looksLikePixelArt(this.src) ? 'nearest' : 'bilinear' });
    this.st = { cx: this.origin.x + this.src.width / 2, cy: this.origin.y + this.src.height / 2, sx: 1, sy: 1, angle: 0 };
    this.preview();
    return true;
  }

  private matrix(st = this.st): Matrix {
    const w = this.src!.width;
    const h2 = this.src!.height;
    const c = Math.cos(st.angle);
    const s = Math.sin(st.angle);
    const T1: Matrix = { a: 1, b: 0, c: 0, d: 1, e: -w / 2, f: -h2 / 2 };
    const S: Matrix = { a: st.sx, b: 0, c: 0, d: st.sy, e: 0, f: 0 };
    const R: Matrix = { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
    const T2: Matrix = { a: 1, b: 0, c: 0, d: 1, e: st.cx, f: st.cy };
    return multiply(T2, multiply(R, multiply(S, T1)));
  }

  private corners(): Point[] {
    const m = this.matrix();
    const w = this.src!.width;
    const hh = this.src!.height;
    return [applyM(m, 0, 0), applyM(m, w, 0), applyM(m, w, hh), applyM(m, 0, hh)];
  }

  private hole: OffscreenCanvas | null = null;

  /** Hides the whole layer content while it's transformed (its soft edges would show through otherwise). */
  private solidHole(): OffscreenCanvas {
    const src = this.src!;
    if (!this.hole || this.hole.width !== src.width || this.hole.height !== src.height) {
      this.hole = new OffscreenCanvas(src.width, src.height);
      const g = this.hole.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, src.width, src.height);
    }
    return this.hole;
  }

  private preview(): void {
    const layer = this.layer;
    const src = this.srcCanvas;
    if (!layer || !src || !this.src) return;
    const doc = this.app.doc!;
    const pts = this.corners();
    const minX = Math.floor(Math.min(...pts.map((p) => p.x)));
    const minY = Math.floor(Math.min(...pts.map((p) => p.y)));
    const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)));
    const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)));
    // Only the part inside the image is shown
    const x0 = Math.max(minX, -1);
    const y0 = Math.max(minY, -1);
    const w = Math.max(1, Math.min(maxX, doc.width + 1) - x0);
    const hh = Math.max(1, Math.min(maxY, doc.height + 1) - y0);
    const c = new OffscreenCanvas(w, hh);
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = this.o().method !== 'nearest';
    const m = this.matrix();
    g.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
    g.drawImage(src, 0, 0);
    const holeArea = this.floating ? { x: this.origin.x, y: this.origin.y, w: this.src.width, h: this.src.height } : null;
    this.app.view.previews.set(layer, {
      canvas: c,
      x: x0,
      y: y0,
      hole: holeArea ? { canvas: maskCanvas(this.floating!, holeArea), x: holeArea.x, y: holeArea.y } : { canvas: this.solidHole(), x: this.origin.x, y: this.origin.y },
    });
    this.app.view.invalidate();
  }

  private handleAt(p: PointerInfo): Handle {
    const view = this.app.view;
    const pts = this.corners().map((q) => view.toScreen(q.x, q.y));
    const local = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const mids = [0, 1, 2, 3].map((i) => ({ x: (pts[i].x + pts[(i + 1) % 4].x) / 2, y: (pts[i].y + pts[(i + 1) % 4].y) / 2 }));
    const midLocal = [
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ];
    for (let i = 0; i < 4; i++) if (Math.hypot(pts[i].x - p.sx, pts[i].y - p.sy) < 9) return { kind: 'scale', hx: local[i][0], hy: local[i][1] };
    for (let i = 0; i < 4; i++) if (Math.hypot(mids[i].x - p.sx, mids[i].y - p.sy) < 9) return { kind: 'scale', hx: midLocal[i][0], hy: midLocal[i][1] };
    // Inside the box: move; outside: rotate
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.sy !== b.y > p.sy && p.sx < ((b.x - a.x) * (p.sy - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? { kind: 'move' } : { kind: 'rotate' };
  }

  cursor(): string {
    return 'default';
  }

  hover(p: PointerInfo): void {
    if (!this.src) return;
    const hd = this.handleAt(p);
    this.app.view.el.style.cursor = hd.kind === 'move' ? 'move' : hd.kind === 'rotate' ? 'alias' : 'nwse-resize';
  }

  down(p: PointerInfo): void {
    if (!this.src) return;
    this.drag = { handle: this.handleAt(p), from: { x: p.x, y: p.y }, st: { ...this.st } };
  }

  move(p: PointerInfo): void {
    const d = this.drag;
    if (!d || !this.src) return;
    const st = { ...d.st };
    if (d.handle.kind === 'move') {
      st.cx += Math.round(p.x - d.from.x);
      st.cy += Math.round(p.y - d.from.y);
    } else if (d.handle.kind === 'rotate') {
      const a0 = Math.atan2(d.from.y - st.cy, d.from.x - st.cx);
      const a1 = Math.atan2(p.y - st.cy, p.x - st.cx);
      st.angle = d.st.angle + a1 - a0;
      if (p.shift) st.angle = Math.round(st.angle / (Math.PI / 12)) * (Math.PI / 12);
    } else {
      const w = this.src.width;
      const hh = this.src.height;
      const { hx, hy } = d.handle;
      const centre = p.alt;
      // The fixed point: the opposite handle (or the middle with Alt)
      const ax = centre ? 0.5 : 1 - hx;
      const ay = centre ? 0.5 : 1 - hy;
      const m0 = this.matrix(d.st);
      const anchor = applyM(m0, ax * w, ay * hh);
      const c = Math.cos(st.angle);
      const s = Math.sin(st.angle);
      // Pointer relative to the anchor, in the box's own (unrotated) directions
      const vx = p.x - anchor.x;
      const vy = p.y - anchor.y;
      const lx = vx * c + vy * s;
      const ly = -vx * s + vy * c;
      if (hx !== 0.5) st.sx = lx / ((hx - ax) * w);
      if (hy !== 0.5) st.sy = ly / ((hy - ay) * hh);
      if (p.shift && hx !== 0.5 && hy !== 0.5) {
        const k = Math.max(Math.abs(st.sx), Math.abs(st.sy));
        st.sx = Math.sign(st.sx || 1) * k;
        st.sy = Math.sign(st.sy || 1) * k;
      }
      // Pixel art: whole pixels
      if (this.o().method === 'nearest') {
        st.sx = Math.round(st.sx * w) / w || 1 / w;
        st.sy = Math.round(st.sy * hh) / hh || 1 / hh;
      }
      // Keep the anchor where it was
      const loc = { x: (0.5 - ax) * w * st.sx, y: (0.5 - ay) * hh * st.sy };
      st.cx = anchor.x + loc.x * c - loc.y * s;
      st.cy = anchor.y + loc.x * s + loc.y * c;
    }
    this.st = st;
    this.preview();
    this.app.tools.changed();
  }

  up(): void {
    this.drag = null;
  }

  flip(horizontal: boolean): void {
    if (horizontal) this.st.sx = -this.st.sx;
    else this.st.sy = -this.st.sy;
    this.preview();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key === 'Escape') {
      this.abort();
      return true;
    }
    return false;
  }

  /** Applies the transform as one undo step (then goes back to the previous tool). */
  commit(goBack = true): void {
    const doc = this.app.doc;
    const layer = this.layer;
    const src = this.src;
    if (!doc || !layer || !src) return;
    const m = this.matrix();
    const method = this.o().method;
    const out = transformRaster(src, m, method);
    const floating = this.floating;
    const origin = { ...this.origin };
    this.cleanup();
    doc.edit('Free transform', (e) => {
      if (!floating) {
        // The layer's content is all that changes, so the result replaces its pixels
        replacePixels(doc, e, layer, out.raster, out.x, out.y);
        return;
      }
      eraseSelection(doc, e, layer);
      pasteInto(doc, e, layer, out.raster, out.x, out.y);
      // The selection takes the new shape too
      const shape = new Raster(src.width, src.height);
      for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) shape.data[(y * src.width + x) * 4 + 3] = floating.get(origin.x + x, origin.y + y);
      const mt = transformRaster(shape, m, method === 'nearest' ? 'nearest' : 'bilinear');
      const sel = new Mask(doc.width, doc.height);
      for (let y = 0; y < mt.raster.height; y++)
        for (let x = 0; x < mt.raster.width; x++) {
          const X = x + mt.x;
          const Y = y + mt.y;
          if (X >= 0 && Y >= 0 && X < doc.width && Y < doc.height) sel.data[Y * doc.width + X] = mt.raster.data[(y * mt.raster.width + x) * 4 + 3];
        }
      sel.touched();
      setSelection(doc, e, sel);
    });
    if (goBack) this.app.tools.select(this.returnTo);
  }

  abort(): void {
    this.cleanup();
    this.app.tools.select(this.returnTo);
  }

  private cleanup(): void {
    if (this.layer) this.app.view.previews.delete(this.layer);
    this.app.view.invalidate();
    this.layer = null;
    this.src = null;
    this.srcCanvas = null;
    this.drag = null;
  }

  deactivate(): void {
    // Switching to another tool applies the transform
    if (this.layer) this.commit(false);
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.src) return;
    const view = this.app.view;
    const pts = this.corners().map((q) => view.toScreen(q.x, q.y));
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#a98bff';
    ctx.stroke();
    const dot = (p: Point) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#5b3fd6';
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      ctx.strokeRect(p.x - 4 + 0.5, p.y - 4 + 0.5, 7, 7);
    };
    for (let i = 0; i < 4; i++) {
      dot(pts[i]);
      dot({ x: (pts[i].x + pts[(i + 1) % 4].x) / 2, y: (pts[i].y + pts[(i + 1) % 4].y) / 2 });
    }
    ctx.restore();
  }

  status(): string {
    if (!this.src) return '';
    const w = Math.round(Math.abs(this.st.sx) * this.src.width);
    const hh = Math.round(Math.abs(this.st.sy) * this.src.height);
    return `${w} × ${hh} px · ${Math.round(Math.abs(this.st.sx) * 100)}% × ${Math.round(Math.abs(this.st.sy) * 100)}% · ${Math.round((this.st.angle * 180) / Math.PI)}°`;
  }

  options(): HTMLElement[] {
    const o = this.o();
    const btn = (label: string, ic: L.IconNode, run: () => void, cls = 'btn') => h('button', { class: cls, onclick: run }, icon(ic, 15), label);
    const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;
    return [
      h('span', { class: 'ctl-info' }, this.src ? `W ${pct(this.st.sx)} · H ${pct(this.st.sy)} · ${Math.round((this.st.angle * 180) / Math.PI)}°` : ''),
      dropdown<Resample>(
        'Quality',
        [
          ['nearest', 'Hard pixels'],
          ['bilinear', 'Smooth'],
          ['bicubic', 'Smoother'],
        ],
        o.method,
        (v) => {
          this.app.tools.options.set('transform', { method: v, chosen: true });
          this.preview();
        },
      ),
      sep(),
      btn('Flip ↔', L.FlipHorizontal2, () => this.flip(true)),
      btn('Flip ↕', L.FlipVertical2, () => this.flip(false)),
      sep(),
      btn('Apply', L.Check, () => this.commit(), 'btn primary'),
      btn('Cancel', L.X, () => this.abort(), 'btn outline'),
    ];
  }
}

/** Hard-edged with few colours: resampling should keep pixels crisp. */
function looksLikePixelArt(r: Raster): boolean {
  const d = r.data;
  const n = d.length / 4;
  const step = Math.max(1, Math.floor(n / 250_000));
  const colors = new Set<number>();
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    const a = d[i + 3];
    if (a && a < 255) return false;
    if (!a) continue;
    colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (colors.size > 256) return false;
  }
  return true;
}
