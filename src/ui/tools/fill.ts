// Paint bucket, gradient and shape tools.
import * as L from 'lucide';
import { flatten } from '../../core/blend';
import type { RGBA } from '../../core/color';
import type { Edit } from '../../core/document';
import { matchRegion, paintMask } from '../../core/fill';
import { union, type Point, type Rect } from '../../core/geom';
import { PENCIL, Stroke } from '../../core/paint';
import { Mask } from '../../core/selection';
import { drawGradient, ellipsePixels, rectPixels, type GradientKind } from '../../core/shapes';
import type { App } from '../app';
import type { PointerInfo } from '../canvas/CanvasView';
import { dropdown, segmented, sep, slider, toggle } from '../controls';
import { toast } from '../widgets';
import { pickColor } from './paint';
import type { Tool } from './tool';

function canPaint(app: App): boolean {
  const layer = app.doc?.active;
  if (!layer) return false;
  if (layer.locked) {
    toast(`"${layer.name}" is locked.`);
    return false;
  }
  if (!layer.visible) {
    toast(`"${layer.name}" is hidden. Show it to paint on it.`);
    return false;
  }
  return true;
}

export class BucketTool implements Tool {
  id = 'bucket';
  name = 'Paint bucket';
  icon = L.PaintBucket;
  key = 'G';
  hint = 'Fills an area of similar colour. Right-click fills with the secondary colour; Alt picks a colour.';

  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('bucket', { tolerance: 0, contiguous: true, merged: false, opacity: 100, diagonal: false });
  }

  cursor(): string {
    return 'crosshair';
  }

  down(p: PointerInfo): void {
    if (p.alt) {
      pickColor(this.app, p, p.button === 2);
      return;
    }
    if (!canPaint(this.app)) return;
    const doc = this.app.doc!;
    const o = this.o();
    const layer = doc.active;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const src = o.merged ? flatten(doc).data : layer.read(doc.bounds);
    let mask = matchRegion(src, doc.width, doc.height, x, y, { tolerance: o.tolerance, contiguous: o.contiguous, diagonal: o.diagonal });
    if (doc.selection) mask = mask.combine(doc.selection, 'intersect');
    if (mask.isEmpty()) return;
    const color = p.button === 2 ? this.app.colors.bg : this.app.colors.fg;
    doc.edit('Fill', (e) => {
      const area = mask.bounds;
      e.touch(layer, area);
      layer.ensure(area, doc.bounds);
      const data = layer.read(doc.bounds);
      paintMask(data, mask, color, o.opacity / 100, layer.alphaLocked);
      layer.write(doc.bounds, data);
      doc.emit({ type: 'pixels', layer, rect: area });
    });
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => this.app.tools.options.set('bucket', v);
    return [
      slider({ label: 'Tolerance', min: 0, max: 255, value: o.tolerance, width: 90, onChange: (v) => set({ tolerance: v }), title: '0 fills exactly one colour (pixel art); higher also fills similar colours' }),
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 80, onChange: (v) => set({ opacity: v }) }),
      sep(),
      toggle('Connected only', o.contiguous, (v) => set({ contiguous: v }), 'Only the area touching the pixel; off replaces that colour everywhere'),
      toggle('Diagonals', o.diagonal, (v) => set({ diagonal: v }), 'Fill leaks through pixels that touch at a corner'),
      toggle('All layers', o.merged, (v) => set({ merged: v }), 'Decide the area from the whole picture, fill on this layer'),
    ];
  }
}

export class GradientTool implements Tool {
  id = 'gradient';
  name = 'Gradient';
  icon = L.Blend;
  key = 'Shift+G';
  hint = 'Drag to draw a gradient from the primary to the secondary colour. Bands + dithering give pixel-art shading.';
  private from: Point | null = null;
  private to: Point | null = null;

  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('gradient', { kind: 'linear' as GradientKind, end: 'bg' as 'bg' | 'transparent', steps: 0, dither: false, opacity: 100, reverse: false });
  }

  cursor(): string {
    return 'crosshair';
  }

  down(p: PointerInfo): void {
    if (!canPaint(this.app)) return;
    this.from = { x: p.x, y: p.y };
    this.to = { x: p.x, y: p.y };
  }

  move(p: PointerInfo): void {
    if (!this.from) return;
    let to = { x: p.x, y: p.y };
    if (p.shift) {
      // Snap to 45° steps
      const dx = to.x - this.from.x;
      const dy = to.y - this.from.y;
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      to = { x: this.from.x + Math.cos(a) * len, y: this.from.y + Math.sin(a) * len };
    }
    this.to = to;
  }

  up(): void {
    const from = this.from;
    const to = this.to;
    this.from = this.to = null;
    if (!from || !to || Math.hypot(to.x - from.x, to.y - from.y) < 0.5) return;
    const doc = this.app.doc!;
    const layer = doc.active;
    const o = this.o();
    const fg = this.app.colors.fg;
    const end: RGBA = o.end === 'transparent' ? { ...fg, a: 0 } : this.app.colors.bg;
    const colors: [RGBA, RGBA] = o.reverse ? [end, fg] : [fg, end];
    doc.edit('Gradient', (e) => {
      const area = doc.selection?.bounds ?? doc.bounds;
      e.touch(layer, area);
      layer.ensure(area, doc.bounds);
      const data = layer.read(doc.bounds);
      drawGradient(data, doc.width, doc.height, { kind: o.kind, from, to, colors, steps: o.steps, dither: o.dither, opacity: o.opacity / 100 }, doc.selection);
      layer.write(doc.bounds, data);
      doc.emit({ type: 'pixels', layer, rect: area });
    });
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    if (!this.from || !this.to) return;
    const view = this.app.view;
    const a = view.toScreen(this.from.x, this.from.y);
    const b = view.toScreen(this.to.x, this.to.y);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    for (const [p, c] of [
      [a, this.app.colors.fg],
      [b, this.app.colors.bg],
    ] as const) {
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => this.app.tools.options.set('gradient', v);
    return [
      segmented<GradientKind>(
        [
          { value: 'linear', icon: L.MoveRight, title: 'Linear' },
          { value: 'radial', icon: L.CircleDot, title: 'Radial' },
          { value: 'angle', icon: L.RotateCw, title: 'Angle (around a point)' },
          { value: 'reflected', icon: L.MoveHorizontal, title: 'Reflected' },
          { value: 'diamond', icon: L.Diamond, title: 'Diamond' },
        ],
        o.kind,
        (v) => set({ kind: v }),
      ),
      dropdown<'bg' | 'transparent'>(
        'To',
        [
          ['bg', 'Secondary colour'],
          ['transparent', 'Transparent'],
        ],
        o.end,
        (v) => set({ end: v }),
      ),
      toggle('Reverse', o.reverse, (v) => set({ reverse: v })),
      sep(),
      slider({ label: 'Bands', min: 0, max: 32, value: o.steps, width: 70, onChange: (v) => set({ steps: v }), title: '0 = smooth; a number = that many flat colour bands (pixel-art shading)' }),
      toggle('Dither', o.dither, (v) => set({ dither: v }), 'Checkerboard-style dithering between bands (or to hide banding)'),
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 70, onChange: (v) => set({ opacity: v }) }),
    ];
  }
}

type ShapeKind = 'rect' | 'ellipse' | 'line';

export class ShapeTool implements Tool {
  id = 'shape';
  name = 'Shapes';
  icon = L.Shapes;
  key = 'U';
  hint = 'Drag to draw a rectangle, ellipse or line. Shift makes squares, circles and 45° lines; Alt draws from the centre.';
  private from: Point | null = null;
  private edit: Edit | null = null;
  /** Everything the shape covered during this drag (put back before each redraw). */
  private dirty: Rect | null = null;

  constructor(private app: App) {}

  private o() {
    return this.app.tools.options.get('shape', { kind: 'rect' as ShapeKind, fill: 'outline' as 'outline' | 'fill' | 'both', width: 1, smooth: false });
  }

  cursor(): string {
    return 'crosshair';
  }

  down(p: PointerInfo): void {
    if (!canPaint(this.app)) return;
    this.from = { x: p.x, y: p.y };
    this.edit = this.app.doc!.begin(this.o().kind === 'line' ? 'Line' : this.o().kind === 'ellipse' ? 'Ellipse' : 'Rectangle');
    this.draw(p);
  }

  move(p: PointerInfo): void {
    if (this.from) this.draw(p);
  }

  up(): void {
    this.edit?.commit();
    this.edit = null;
    this.from = null;
    this.dirty = null;
  }

  cancel(): void {
    this.edit?.cancel();
    this.edit = null;
    this.from = null;
    this.dirty = null;
  }

  /** Redraws the shape from scratch for the current pointer position. */
  private draw(p: PointerInfo): void {
    const doc = this.app.doc!;
    const e = this.edit;
    const from = this.from;
    if (!e || !from) return;
    const o = this.o();
    const layer = doc.active;
    // Put back the previous frame of this drag (the edit stays open)
    if (this.dirty) restore(e, layer, this.dirty);
    const mark = (r: Rect) => (this.dirty = this.dirty ? union(this.dirty, r) : r);
    const fg = this.app.colors.fg;
    const bg = this.app.colors.bg;
    const prefs = this.app.prefs;
    const strokeOpts = (color: RGBA) => ({
      mode: 'paint' as const,
      color,
      brush: o.smooth ? { size: o.width, hardness: 0.95, opacity: 1, flow: 1, spacing: 0.1, shape: 'round' as const, antialias: true } : { ...PENCIL, size: o.width },
      selection: doc.selection,
      wrap: prefs.tileMode,
      mirrorX: prefs.mirrorX ? doc.width / 2 : undefined,
      mirrorY: prefs.mirrorY ? doc.height / 2 : undefined,
    });
    if (o.kind === 'line') {
      let to = { x: p.x, y: p.y };
      if (p.shift) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        to = { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
      }
      const s = new Stroke(doc, layer, e, strokeOpts(fg));
      s.moveTo(from.x, from.y);
      s.lineTo(to.x, to.y);
      mark(s.takeDirty());
      return;
    }
    const r = shapeRect(from, { x: p.x, y: p.y }, p.shift, p.alt);
    if (o.fill !== 'outline') {
      let mask = o.kind === 'ellipse' ? Mask.ellipse(doc.width, doc.height, r, o.smooth) : Mask.rect(doc.width, doc.height, r);
      if (doc.selection) mask = mask.combine(doc.selection, 'intersect');
      const area = mask.bounds;
      if (area.w && area.h) {
        e.touch(layer, area);
        layer.ensure(area, doc.bounds);
        const data = layer.read(doc.bounds);
        paintMask(data, mask, o.fill === 'both' ? bg : fg, 1, layer.alphaLocked);
        layer.write(doc.bounds, data);
        doc.emit({ type: 'pixels', layer, rect: area });
        mark(area);
      }
    }
    if (o.fill !== 'fill') {
      const s = new Stroke(doc, layer, e, strokeOpts(fg));
      if (o.kind === 'rect') {
        const pts = rectPixels(insetFor(r, o.width));
        for (const q of pts) s.dab(q.x + 0.5, q.y + 0.5);
      } else if (o.smooth) {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const rx = Math.max(0.5, r.w / 2 - o.width / 2);
        const ry = Math.max(0.5, r.h / 2 - o.width / 2);
        const n = Math.max(16, Math.ceil((rx + ry) * 2));
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = cx + Math.cos(a) * rx;
          const y = cy + Math.sin(a) * ry;
          if (i) s.lineTo(x, y);
          else s.moveTo(x, y);
        }
      } else {
        for (const q of ellipsePixels(insetFor(r, o.width))) s.dab(q.x + 0.5, q.y + 0.5);
      }
      mark(s.takeDirty());
    }
  }

  options(): HTMLElement[] {
    const o = this.o();
    const set = (v: Record<string, unknown>) => {
      this.app.tools.options.set('shape', v);
      this.app.tools.changed();
    };
    return [
      segmented<ShapeKind>(
        [
          { value: 'rect', icon: L.Square, title: 'Rectangle' },
          { value: 'ellipse', icon: L.Circle, title: 'Ellipse' },
          { value: 'line', icon: L.Slash, title: 'Line' },
        ],
        o.kind,
        (v) => set({ kind: v }),
      ),
      o.kind === 'line'
        ? null
        : dropdown<'outline' | 'fill' | 'both'>(
            null,
            [
              ['outline', 'Outline'],
              ['fill', 'Filled'],
              ['both', 'Outline + fill (secondary)'],
            ],
            o.fill,
            (v) => set({ fill: v }),
          ),
      slider({ label: 'Width', min: 1, max: 100, value: o.width, unit: 'px', width: 80, onChange: (v) => this.app.tools.options.set('shape', { width: v }) }),
      toggle('Smooth edges', o.smooth, (v) => set({ smooth: v }), 'Off: hard pixels (pixel art). On: anti-aliased edges (photos)'),
    ].filter((x): x is HTMLElement => !!x);
  }
}

/** The shape's box: Shift makes it square, Alt grows it from the starting point. */
function shapeRect(a: Point, b: Point, square: boolean, centre: boolean): Rect {
  const x0 = Math.floor(a.x);
  const y0 = Math.floor(a.y);
  let dx = Math.floor(b.x) - x0;
  let dy = Math.floor(b.y) - y0;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  if (centre) return { x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2 + 1, h: Math.abs(dy) * 2 + 1 };
  return { x: Math.min(x0, x0 + dx), y: Math.min(y0, y0 + dy), w: Math.abs(dx) + 1, h: Math.abs(dy) + 1 };
}

/** Thick outlines stay inside the box. */
function insetFor(r: Rect, width: number): Rect {
  const k = Math.floor((width - 1) / 2);
  return { x: r.x + k, y: r.y + k, w: Math.max(1, r.w - k * 2 - ((width - 1) % 2)), h: Math.max(1, r.h - k * 2 - ((width - 1) % 2)) };
}

/** Puts back the pixels an open edit changed in an area (the edit stays open). */
function restore(e: Edit, layer: import('../../core/layer').Layer, r: Rect): void {
  if (!r.w || !r.h) return;
  layer.write(r, e.original(layer, r));
  e.doc.emit({ type: 'pixels', layer, rect: r });
}
