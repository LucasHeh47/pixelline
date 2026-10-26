// Selection tools: rectangle/ellipse marquee, freehand and polygon lasso, magic wand.
// Modifiers at the start, like Photoshop: Shift adds, Alt subtracts, Shift+Alt intersects.
// Dragging inside the selection with the marquee moves its outline.
import * as L from 'lucide';
import { flatten } from '../../core/blend';
import { matchRegion } from '../../core/fill';
import type { Point } from '../../core/geom';
import { setSelection } from '../../core/ops';
import { Mask, type SelectMode } from '../../core/selection';
import type { App } from '../app';
import type { PointerInfo } from '../canvas/CanvasView';
import { dropdown, segmented, sep, slider, toggle } from '../controls';
import type { Tool } from './tool';

const MODES: { value: SelectMode; icon: L.IconNode; title: string }[] = [
  { value: 'replace', icon: L.SquareDashed, title: 'New selection' },
  { value: 'add', icon: L.SquarePlus, title: 'Add to the selection (hold Shift)' },
  { value: 'subtract', icon: L.SquareMinus, title: 'Subtract from the selection (hold Alt)' },
  { value: 'intersect', icon: L.SquareSquare, title: 'Keep where they overlap (hold Shift+Alt)' },
];

abstract class SelectTool implements Tool {
  abstract id: string;
  abstract name: string;
  abstract icon: L.IconNode;
  abstract hint: string;
  key?: string;

  constructor(protected app: App) {}

  protected base() {
    return this.app.tools.options.get('select', { mode: 'replace' as SelectMode, antialias: false, feather: 0 });
  }

  protected setBase(v: Record<string, unknown>): void {
    this.app.tools.options.set('select', v);
  }

  protected modeFor(p: PointerInfo): SelectMode {
    if (p.shift && p.alt) return 'intersect';
    if (p.shift) return 'add';
    if (p.alt) return 'subtract';
    return this.base().mode;
  }

  /** Combines a new shape with the selection, as one undo step. */
  protected apply(mask: Mask, mode: SelectMode, label: string): void {
    const doc = this.app.doc!;
    const f = this.base().feather;
    const shaped = f > 0 ? mask.feathered(f) : mask;
    const next = doc.selection && mode !== 'replace' ? doc.selection.combine(shaped, mode) : mode === 'subtract' || mode === 'intersect' ? null : shaped;
    doc.edit(label, (e) => setSelection(doc, e, next));
  }

  cursor(): string {
    return 'crosshair';
  }

  protected modeControls(extra: (HTMLElement | null)[] = []): HTMLElement[] {
    const b = this.base();
    return [
      segmented(MODES, b.mode, (v) => this.setBase({ mode: v })),
      sep(),
      slider({ label: 'Feather', min: 0, max: 100, value: b.feather, unit: 'px', width: 70, onChange: (v) => this.setBase({ feather: v }), title: 'Softens the edge of new selections' }),
      ...extra,
    ].filter((x): x is HTMLElement => !!x);
  }
}

export class MarqueeTool extends SelectTool {
  id = 'marquee';
  name = 'Rectangle select';
  icon = L.SquareDashed;
  key = 'M';
  hint = 'Drag to select a rectangle or ellipse. Shift adds, Alt subtracts; Shift while dragging makes a square or circle.';
  private start: Point | null = null;
  private end: Point | null = null;
  private mode: SelectMode = 'replace';
  private moving: { mask: Mask; from: Point } | null = null;

  private o() {
    return this.app.tools.options.get('marquee', { shape: 'rect' as 'rect' | 'ellipse', ratio: 'free' as 'free' | 'square' | 'fixed', fixedW: 16, fixedH: 16 });
  }

  /** Snapped to whole pixels: the corner pixel under the pointer is included. */
  private rect(p0: Point, p1: Point, square: boolean, centre: boolean) {
    const o = this.o();
    let x0 = Math.floor(p0.x);
    let y0 = Math.floor(p0.y);
    let x1 = Math.floor(p1.x);
    let y1 = Math.floor(p1.y);
    let w = Math.abs(x1 - x0) + 1;
    let h = Math.abs(y1 - y0) + 1;
    if (o.ratio === 'fixed') {
      w = o.fixedW;
      h = o.fixedH;
      return { x: x1 - Math.floor(w / 2), y: y1 - Math.floor(h / 2), w, h };
    }
    if (square || o.ratio === 'square') w = h = Math.max(w, h);
    if (centre) {
      const rx = Math.abs(x1 - x0);
      const ry = Math.abs(y1 - y0);
      const r = square ? Math.max(rx, ry) : 0;
      return { x: x0 - (r || rx), y: y0 - (r || ry), w: (r || rx) * 2 + 1, h: (r || ry) * 2 + 1 };
    }
    if (x1 < x0) x1 = x0 - w + 1;
    else x1 = x0 + w - 1;
    if (y1 < y0) y1 = y0 - h + 1;
    else y1 = y0 + h - 1;
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w, h };
  }

  down(p: PointerInfo): void {
    const doc = this.app.doc!;
    this.mode = this.modeFor(p);
    // Dragging inside the selection (no modifier) moves its outline
    if (this.mode === 'replace' && doc.selection && doc.selection.get(Math.floor(p.x), Math.floor(p.y)) >= 128 && this.o().ratio !== 'fixed') {
      this.moving = { mask: doc.selection, from: { x: Math.floor(p.x), y: Math.floor(p.y) } };
      return;
    }
    this.start = { x: p.x, y: p.y };
    this.end = { x: p.x, y: p.y };
  }

  move(p: PointerInfo): void {
    const doc = this.app.doc!;
    if (this.moving) {
      const dx = Math.floor(p.x) - this.moving.from.x;
      const dy = Math.floor(p.y) - this.moving.from.y;
      doc.selection = shiftMask(this.moving.mask, dx, dy);
      this.app.view.selectionChanged();
      return;
    }
    if (this.start) this.end = { x: p.x, y: p.y };
    this.squareKey = p.shift;
    this.centreKey = p.alt && this.mode !== 'subtract';
  }

  private squareKey = false;
  private centreKey = false;

  up(p: PointerInfo): void {
    const doc = this.app.doc!;
    if (this.moving) {
      const moved = doc.selection;
      doc.selection = this.moving.mask;
      this.moving = null;
      if (moved && moved !== doc.selection) doc.edit('Move selection', (e) => setSelection(doc, e, moved));
      this.app.view.selectionChanged();
      return;
    }
    if (!this.start) return;
    const click = Math.abs(p.sx - this.app.view.toScreen(this.start.x, this.start.y).x) < 3 && Math.abs(p.sy - this.app.view.toScreen(this.start.x, this.start.y).y) < 3;
    const r = this.rect(this.start, { x: p.x, y: p.y }, p.shift && this.mode !== 'add', this.centreKey);
    this.start = this.end = null;
    if (click && this.o().ratio !== 'fixed') {
      // A click without dragging: deselect (like Photoshop)
      if (this.mode === 'replace' && doc.selection) doc.edit('Deselect', (e) => setSelection(doc, e, null));
      return;
    }
    const mask = this.o().shape === 'ellipse' ? Mask.ellipse(doc.width, doc.height, r, this.base().antialias) : Mask.rect(doc.width, doc.height, r);
    this.apply(mask, this.mode, this.o().shape === 'ellipse' ? 'Ellipse select' : 'Rectangle select');
  }

  cancel(): void {
    this.start = this.end = null;
    if (this.moving) {
      this.app.doc!.selection = this.moving.mask;
      this.moving = null;
      this.app.view.selectionChanged();
    }
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.start || !this.end) return;
    const view = this.app.view;
    const r = this.rect(this.start, this.end, this.squareKey && this.mode !== 'add', this.centreKey);
    const a = view.toScreen(r.x, r.y);
    const b = view.toScreen(r.x + r.w, r.y + r.h);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (this.o().shape === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    else ctx.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }

  status(): string {
    if (!this.start || !this.end) return '';
    const r = this.rect(this.start, this.end, this.squareKey, this.centreKey);
    return `${r.w} × ${r.h} at ${r.x}, ${r.y}`;
  }

  options(): HTMLElement[] {
    const o = this.o();
    return this.modeControls([
      sep(),
      segmented<'rect' | 'ellipse'>(
        [
          { value: 'rect', icon: L.Square, title: 'Rectangle' },
          { value: 'ellipse', icon: L.Circle, title: 'Ellipse' },
        ],
        o.shape,
        (v) => {
          this.app.tools.options.set('marquee', { shape: v });
          this.name = v === 'ellipse' ? 'Ellipse select' : 'Rectangle select';
        },
      ),
      dropdown<'free' | 'square' | 'fixed'>(
        'Size',
        [
          ['free', 'Any'],
          ['square', 'Square'],
          ['fixed', 'Fixed size'],
        ],
        o.ratio,
        (v) => {
          this.app.tools.options.set('marquee', { ratio: v });
          this.app.tools.changed();
        },
      ),
      o.ratio === 'fixed' ? slider({ label: 'W', min: 1, max: 4096, value: o.fixedW, width: 60, onChange: (v) => this.app.tools.options.set('marquee', { fixedW: v }) }) : null,
      o.ratio === 'fixed' ? slider({ label: 'H', min: 1, max: 4096, value: o.fixedH, width: 60, onChange: (v) => this.app.tools.options.set('marquee', { fixedH: v }) }) : null,
      o.shape === 'ellipse' ? toggle('Smooth edges', this.base().antialias, (v) => this.setBase({ antialias: v })) : null,
    ]);
  }
}

/** A selection moved by whole pixels. */
export function shiftMask(m: Mask, dx: number, dy: number): Mask {
  const out = new Mask(m.width, m.height);
  for (let y = 0; y < m.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= m.height) continue;
    for (let x = 0; x < m.width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < m.width) out.data[y * m.width + x] = m.data[sy * m.width + sx];
    }
  }
  out.touched();
  return out;
}

export class LassoTool extends SelectTool {
  id = 'lasso';
  name = 'Lasso';
  icon = L.Lasso;
  key = 'L';
  hint = 'Freehand: drag around an area. Polygon: click corners, double-click (or click the start) to finish.';
  private pts: Point[] = [];
  private mode: SelectMode = 'replace';
  private dragging = false;
  private hoverPt: Point | null = null;

  private o() {
    return this.app.tools.options.get('lasso', { kind: 'free' as 'free' | 'polygon' });
  }

  down(p: PointerInfo): void {
    const poly = this.o().kind === 'polygon';
    if (poly && this.pts.length) {
      // Clicking near the first point closes the shape
      const first = this.app.view.toScreen(this.pts[0].x, this.pts[0].y);
      if (Math.hypot(first.x - p.sx, first.y - p.sy) < 8 && this.pts.length > 2) {
        this.finish();
        return;
      }
      this.pts.push({ x: p.x, y: p.y });
      return;
    }
    this.mode = this.modeFor(p);
    this.pts = [{ x: p.x, y: p.y }];
    this.dragging = !poly;
  }

  move(p: PointerInfo): void {
    if (this.dragging) this.pts.push({ x: p.x, y: p.y });
    this.hoverPt = { x: p.x, y: p.y };
  }

  hover(p: PointerInfo): void {
    this.hoverPt = { x: p.x, y: p.y };
  }

  up(): void {
    if (this.dragging) {
      this.dragging = false;
      this.finish();
    }
  }

  dblclick(): void {
    if (this.o().kind === 'polygon' && this.pts.length > 2) this.finish();
  }

  onKey(e: KeyboardEvent): boolean {
    if (!this.pts.length) return false;
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    if (e.key === 'Escape') {
      this.pts = [];
      this.app.view.draw();
      return true;
    }
    if (e.key === 'Backspace') {
      this.pts.pop();
      this.app.view.draw();
      return true;
    }
    return false;
  }

  private finish(): void {
    const doc = this.app.doc!;
    const pts = this.pts;
    this.pts = [];
    if (pts.length < 3) {
      if (this.mode === 'replace' && doc.selection) doc.edit('Deselect', (e) => setSelection(doc, e, null));
      return;
    }
    this.apply(Mask.polygon(doc.width, doc.height, pts, this.base().antialias), this.mode, 'Lasso select');
    this.app.view.draw();
  }

  cancel(): void {
    this.pts = [];
    this.dragging = false;
  }

  deactivate(): void {
    this.pts = [];
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.pts.length) return;
    const view = this.app.view;
    ctx.save();
    ctx.beginPath();
    this.pts.forEach((pt, i) => {
      const s = view.toScreen(pt.x, pt.y);
      if (i) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
    });
    if (this.o().kind === 'polygon' && this.hoverPt) {
      const s = view.toScreen(this.hoverPt.x, this.hoverPt.y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (this.o().kind === 'polygon') {
      const f = view.toScreen(this.pts[0].x, this.pts[0].y);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.fillRect(f.x - 3, f.y - 3, 6, 6);
    }
    ctx.restore();
  }

  options(): HTMLElement[] {
    const o = this.o();
    return this.modeControls([
      sep(),
      segmented<'free' | 'polygon'>(
        [
          { value: 'free', icon: L.Lasso, label: 'Freehand', title: 'Drag around the area' },
          { value: 'polygon', icon: L.Pentagon, label: 'Polygon', title: 'Click each corner; double-click to finish' },
        ],
        o.kind,
        (v) => {
          this.app.tools.options.set('lasso', { kind: v });
          this.pts = [];
        },
      ),
      toggle('Smooth edges', this.base().antialias, (v) => this.setBase({ antialias: v })),
    ]);
  }
}

export class WandTool extends SelectTool {
  id = 'wand';
  name = 'Magic wand';
  icon = L.WandSparkles;
  key = 'W';
  hint = 'Click a colour to select the area of similar colour. Shift adds, Alt subtracts.';

  private o() {
    return this.app.tools.options.get('wand', { tolerance: 0, contiguous: true, merged: false, diagonal: false });
  }

  down(p: PointerInfo): void {
    const doc = this.app.doc!;
    const o = this.o();
    const src = o.merged ? flatten(doc).data : doc.active.read(doc.bounds);
    const mask = matchRegion(src, doc.width, doc.height, Math.floor(p.x), Math.floor(p.y), { tolerance: o.tolerance, contiguous: o.contiguous, diagonal: o.diagonal });
    if (mask.isEmpty()) return;
    this.apply(mask, this.modeFor(p), 'Magic wand');
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => this.app.tools.options.set('wand', v);
    return this.modeControls([
      sep(),
      slider({ label: 'Tolerance', min: 0, max: 255, value: o.tolerance, width: 90, onChange: (v) => set({ tolerance: v }), title: '0 selects exactly this colour (pixel art); higher includes similar colours (photos)' }),
      toggle('Connected only', o.contiguous, (v) => set({ contiguous: v }), 'Only the area touching the pixel you click; off selects that colour everywhere'),
      toggle('Diagonals', o.diagonal, (v) => set({ diagonal: v }), 'Pixels that touch only at a corner count as connected'),
      toggle('All layers', o.merged, (v) => set({ merged: v }), 'Look at the whole picture instead of just this layer'),
    ]);
  }
}
