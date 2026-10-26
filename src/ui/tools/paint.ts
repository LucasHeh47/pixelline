// Painting tools: pencil (hard pixels), brush (soft, pressure), eraser and clone stamp.
// Left button paints with the primary colour, right button with the secondary one (like most pixel
// art editors). Shift+click draws a straight line from the last point; Alt picks a colour.
import * as L from 'lucide';
import { flatten } from '../../core/blend';
import { pack, type RGBA } from '../../core/color';
import type { Edit } from '../../core/document';
import { DITHER_PATTERNS, ditherOn, hueShift, paletteShade, type DitherPattern } from '../../core/ink';
import type { Raster } from '../../core/raster';
import { Stroke, type BrushSettings, type StrokeMode, type StrokeOptions } from '../../core/paint';
import type { App } from '../app';
import type { PointerInfo } from '../canvas/CanvasView';
import { dropdown, segmented, sep, slider, toggle } from '../controls';
import { currentPalette } from '../paletteStore';
import { toast } from '../widgets';
import type { BrushOutline, Tool } from './tool';

/**
 * How a painting tool puts colour down: normally, as shading (each pixel becomes a darker or
 * lighter shade of itself) or as a dither pattern.
 */
export type InkKind = 'normal' | 'shade' | 'dither';

export interface InkOptions {
  ink: InkKind;
  /** What the left button does when shading (the right button does the opposite). */
  shade: 'darker' | 'lighter';
  /** Shade by shifting the colour, or by stepping along the Swatches palette. */
  shadeWith: 'hue' | 'palette';
  pattern: DitherPattern;
  /** Dither with both colours (the other one fills the gaps). */
  both: boolean;
}

export const INK_DEFAULTS: InkOptions = { ink: 'normal', shade: 'darker', shadeWith: 'hue', pattern: 'checker', both: false };

/** Where the last stroke ended, per document (for Shift+click lines). */
const lastPoint = new WeakMap<object, { x: number; y: number }>();

export abstract class PaintTool implements Tool {
  abstract id: string;
  abstract name: string;
  abstract icon: L.IconNode;
  abstract hint: string;
  key?: string;
  protected edit: Edit | null = null;
  protected stroke: Stroke | null = null;
  /** Smoothed pointer position (for the brush's smoothing option). */
  private smooth: { x: number; y: number } | null = null;

  constructor(protected app: App) {}

  protected abstract brush(): BrushSettings;
  protected mode(): StrokeMode {
    return 'paint';
  }
  protected pixelPerfect(): boolean {
    return false;
  }
  /** 0–1: how much the brush lags behind the pointer to smooth out shaky lines. */
  protected smoothing(): number {
    return 0;
  }
  /** The tool's ink settings (pencil and brush have them). */
  protected inkOptions(): InkOptions | null {
    return null;
  }

  protected colorAt(p: PointerInfo): StrokeOptions['colorAt'] {
    const ink = this.inkOptions();
    if (!ink || ink.ink === 'normal') return undefined;
    const secondary = p.button === 2;
    if (ink.ink === 'shade') {
      const dir: 1 | -1 = (ink.shade === 'darker') !== secondary ? -1 : 1;
      const palette = ink.shadeWith === 'palette' ? currentPalette(this.app).colors : null;
      const cache = new Map<number, RGBA | null>();
      return (_x, _y, under) => {
        if (!under.a) return null;
        const key = pack(under);
        let out = cache.get(key);
        if (out === undefined) {
          out = palette ? paletteShade(under, dir, palette) : hueShift(under, dir);
          cache.set(key, out);
        }
        return out;
      };
    }
    const { fg, bg } = this.app.colors;
    const on = secondary ? bg : fg;
    const off = secondary ? fg : bg;
    return (x, y) => (ditherOn(ink.pattern, x, y) ? on : ink.both ? off : null);
  }

  /** Controls for the ink settings (shared by the pencil and the brush). */
  protected inkControls(): HTMLElement[] {
    const o = this.inkOptions();
    if (!o) return [];
    const set = (v: Partial<InkOptions>) => {
      this.setOpt(v);
      this.app.tools.changed();
    };
    const out: HTMLElement[] = [
      dropdown<InkKind>(
        'Ink',
        [
          ['normal', 'Normal'],
          ['shade', 'Shade'],
          ['dither', 'Dither'],
        ],
        o.ink,
        (v) => set({ ink: v }),
        'Normal paints the colour. Shade makes each pixel a darker or lighter shade of itself. Dither paints a pattern.',
      ),
    ];
    if (o.ink === 'shade') {
      out.push(
        segmented<'darker' | 'lighter'>(
          [
            { value: 'darker', label: 'Darker', title: 'Left button darkens, right button lightens' },
            { value: 'lighter', label: 'Lighter', title: 'Left button lightens, right button darkens' },
          ],
          o.shade,
          (v) => set({ shade: v }),
        ),
        dropdown<'hue' | 'palette'>(
          null,
          [
            ['hue', 'Shift the colour'],
            ['palette', 'Use the palette'],
          ],
          o.shadeWith,
          (v) => set({ shadeWith: v }),
          'Shift the colour: shades drift toward blue (darker) or yellow (lighter), like hand-made pixel-art ramps. Use the palette: step to the next colour of the same hue in the Swatches palette.',
        ),
      );
    } else if (o.ink === 'dither') {
      out.push(
        dropdown<DitherPattern>('Pattern', Object.entries(DITHER_PATTERNS) as [DitherPattern, string][], o.pattern, (v) => set({ pattern: v })),
        toggle('Both colours', o.both, (v) => set({ both: v }), 'Fill the gaps with the other colour'),
      );
    }
    return out;
  }

  cursor(): string {
    return 'none';
  }

  brushOutline(): BrushOutline | null {
    const b = this.brush();
    return { size: b.size, square: b.shape === 'square', hard: !b.antialias };
  }

  /** Starts a stroke. Returns false (and says why) when the layer can't be painted on. */
  protected begin(p: PointerInfo): boolean {
    const doc = this.app.doc;
    if (!doc) return false;
    const layer = doc.active;
    if (!layer) return false;
    if (layer.locked) {
      toast(`"${layer.name}" is locked. Unlock it in the Layers panel to paint on it.`);
      return false;
    }
    if (!layer.visible) {
      toast(`"${layer.name}" is hidden. Show it to paint on it.`);
      return false;
    }
    const prefs = this.app.prefs;
    this.edit = doc.begin(this.name);
    this.stroke = new Stroke(doc, layer, this.edit, {
      mode: this.mode(),
      color: p.button === 2 ? this.app.colors.bg : this.app.colors.fg,
      brush: this.brush(),
      selection: doc.selection,
      wrap: prefs.tileMode,
      mirrorX: prefs.mirrorX ? doc.width / 2 : undefined,
      mirrorY: prefs.mirrorY ? doc.height / 2 : undefined,
      pixelPerfect: this.pixelPerfect(),
      colorAt: this.colorAt(p),
    });
    return true;
  }

  down(p: PointerInfo): void {
    if (p.alt) {
      pickColor(this.app, p, p.button === 2);
      return;
    }
    if (!this.begin(p)) return;
    const doc = this.app.doc!;
    const last = lastPoint.get(doc);
    this.smooth = { x: p.x, y: p.y };
    if (p.shift && last) {
      this.stroke!.moveTo(last.x, last.y, p.pressure);
      this.stroke!.lineTo(p.x, p.y, p.pressure);
    } else this.stroke!.moveTo(p.x, p.y, p.pressure);
  }

  move(p: PointerInfo): void {
    if (!this.stroke) return;
    const k = this.smoothing();
    if (k > 0 && this.smooth) {
      this.smooth.x += (p.x - this.smooth.x) * (1 - k * 0.9);
      this.smooth.y += (p.y - this.smooth.y) * (1 - k * 0.9);
      this.stroke.lineTo(this.smooth.x, this.smooth.y, p.pressure);
    } else this.stroke.lineTo(p.x, p.y, p.pressure);
  }

  up(p: PointerInfo): void {
    if (!this.stroke || !this.edit) return;
    if (this.smoothing() > 0) this.stroke.lineTo(p.x, p.y, p.pressure);
    this.edit.commit();
    lastPoint.set(this.app.doc!, { x: p.x, y: p.y });
    this.stroke = null;
    this.edit = null;
  }

  cancel(): void {
    this.edit?.cancel();
    this.stroke = null;
    this.edit = null;
  }

  /** The tool's saved options (with defaults). */
  protected opts<T extends Record<string, unknown>>(defaults: T): T {
    return this.app.tools.options.get(this.id, defaults);
  }

  protected setOpt(values: Record<string, unknown>): void {
    this.app.tools.options.set(this.id, values);
    this.app.view.draw();
  }

  /** [ and ] change the size. */
  resize(dir: 1 | -1): void {
    const o = this.opts({ size: 1 } as Record<string, unknown>);
    const size = Number(o.size);
    const next = dir > 0 ? (size < 10 ? size + 1 : Math.round(size * 1.2)) : size <= 10 ? size - 1 : Math.round(size / 1.2);
    this.setOpt({ size: Math.max(1, Math.min(this.maxSize, next)) });
    this.app.tools.changed();
  }

  protected maxSize = 1000;
}

/** Picks the colour under the pointer into the primary (or secondary) colour. */
export function pickColor(app: App, p: { x: number; y: number }, secondary = false, merged = true): RGBA | null {
  const doc = app.doc;
  if (!doc) return null;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  const area = { x, y, w: 1, h: 1 };
  const d = merged ? flatten(doc, area).data : doc.active.read(area);
  const c = { r: d[0], g: d[1], b: d[2], a: d[3] };
  if (c.a === 0) return null;
  app.setColor(secondary ? 'bg' : 'fg', c);
  return c;
}

export class PencilTool extends PaintTool {
  id = 'pencil';
  name = 'Pencil';
  icon = L.Pencil;
  key = 'N';
  hint = 'Hard-edged pixels for pixel art. Right-click paints the secondary colour; Shift+click draws a line.';
  protected maxSize = 256;

  private o() {
    return this.opts({ size: 1, shape: 'square' as 'square' | 'round', pixelPerfect: true, opacity: 100, ...INK_DEFAULTS });
  }

  protected inkOptions(): InkOptions {
    return this.o();
  }

  protected brush(): BrushSettings {
    const o = this.o();
    return { size: o.size, hardness: 1, opacity: o.opacity / 100, flow: 1, spacing: 0.1, shape: o.shape, antialias: false };
  }

  protected pixelPerfect(): boolean {
    return this.o().pixelPerfect && this.o().size === 1;
  }

  options(): HTMLElement[] {
    const o = this.o();
    return [
      slider({ label: 'Size', min: 1, max: 256, value: o.size, unit: 'px', log: true, width: 110, onChange: (v) => this.setOpt({ size: v }) }),
      segmented<'square' | 'round'>(
        [
          { value: 'square', icon: L.Square, title: 'Square tip' },
          { value: 'round', icon: L.Circle, title: 'Round tip' },
        ],
        o.shape,
        (v) => this.setOpt({ shape: v }),
      ),
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 90, onChange: (v) => this.setOpt({ opacity: v }) }),
      sep(),
      toggle('Pixel perfect', o.pixelPerfect, (v) => this.setOpt({ pixelPerfect: v }), 'Removes the extra pixel in L-shaped corners of 1-pixel lines, for clean pixel-art curves'),
      sep(),
      ...this.inkControls(),
    ];
  }
}

export class BrushTool extends PaintTool {
  id = 'brush';
  name = 'Brush';
  icon = L.Brush;
  key = 'B';
  hint = 'Soft painting with pen pressure. Right-click paints the secondary colour; Shift+click draws a line.';

  private o() {
    return this.opts({ size: 24, hardness: 60, opacity: 100, flow: 100, smoothing: 20, pressureSize: true, pressureFlow: false, ...INK_DEFAULTS });
  }

  protected inkOptions(): InkOptions {
    return this.o();
  }

  protected brush(): BrushSettings {
    const o = this.o();
    return { size: o.size, hardness: o.hardness / 100, opacity: o.opacity / 100, flow: o.flow / 100, spacing: 0.12, shape: 'round', antialias: true, pressureSize: o.pressureSize, pressureFlow: o.pressureFlow };
  }

  protected smoothing(): number {
    return this.o().smoothing / 100;
  }

  options(): HTMLElement[] {
    const o = this.o();
    return [
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', log: true, width: 110, onChange: (v) => this.setOpt({ size: v }) }),
      slider({ label: 'Hardness', min: 0, max: 100, value: o.hardness, unit: '%', width: 80, onChange: (v) => this.setOpt({ hardness: v }) }),
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 80, onChange: (v) => this.setOpt({ opacity: v }), title: 'The most a stroke covers, however often you go over a spot' }),
      slider({ label: 'Flow', min: 1, max: 100, value: o.flow, unit: '%', width: 80, onChange: (v) => this.setOpt({ flow: v }), title: 'How much each touch adds: low flow builds up gently' }),
      slider({ label: 'Smoothing', min: 0, max: 95, value: o.smoothing, unit: '%', width: 70, onChange: (v) => this.setOpt({ smoothing: v }), title: 'Steadies shaky lines (the brush trails the pointer a little)' }),
      sep(),
      toggle('Pressure: size', o.pressureSize, (v) => this.setOpt({ pressureSize: v }), 'With a pen, pressing harder paints bigger'),
      toggle('flow', o.pressureFlow, (v) => this.setOpt({ pressureFlow: v }), 'With a pen, pressing harder paints stronger'),
      sep(),
      ...this.inkControls(),
    ];
  }
}

export class EraserTool extends PaintTool {
  id = 'eraser';
  name = 'Eraser';
  icon = L.Eraser;
  key = 'E';
  hint = 'Erases to transparency. Hard pixels for pixel art, or soft edges.';

  private o() {
    return this.opts({ size: 8, kind: 'pixel' as 'pixel' | 'soft', hardness: 50, opacity: 100 });
  }

  protected mode(): StrokeMode {
    return 'erase';
  }

  protected brush(): BrushSettings {
    const o = this.o();
    if (o.kind === 'pixel') return { size: o.size, hardness: 1, opacity: o.opacity / 100, flow: 1, spacing: 0.1, shape: 'square', antialias: false };
    return { size: o.size, hardness: o.hardness / 100, opacity: o.opacity / 100, flow: 1, spacing: 0.12, shape: 'round', antialias: true, pressureSize: true };
  }

  options(): HTMLElement[] {
    const o = this.o();
    return [
      segmented<'pixel' | 'soft'>(
        [
          { value: 'pixel', icon: L.Grid3x3, label: 'Pixel', title: 'Hard square pixels (pixel art)' },
          { value: 'soft', icon: L.CircleDot, label: 'Soft', title: 'A soft round eraser' },
        ],
        o.kind,
        (v) => {
          this.setOpt({ kind: v });
          this.app.tools.changed();
        },
      ),
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', log: true, width: 110, onChange: (v) => this.setOpt({ size: v }) }),
      o.kind === 'soft' ? slider({ label: 'Hardness', min: 0, max: 100, value: o.hardness, unit: '%', width: 80, onChange: (v) => this.setOpt({ hardness: v }) }) : null,
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 80, onChange: (v) => this.setOpt({ opacity: v }) }),
    ].filter((x): x is HTMLElement => !!x);
  }
}

/** Clone stamp: Alt+click sets where to copy from, then painting copies from there. */
export class CloneTool extends PaintTool {
  id = 'clone';
  name = 'Clone stamp';
  icon = L.Stamp;
  key = 'S';
  hint = 'Alt+click where to copy from, then paint to copy those pixels (great for removing blemishes or repeating texture details).';
  private source: { x: number; y: number } | null = null;
  private offset: { x: number; y: number } | null = null;
  private snapshot: Raster | null = null;

  private o() {
    return this.opts({ size: 30, hardness: 50, opacity: 100, aligned: true, sample: 'all' as 'all' | 'layer', pixel: false });
  }

  protected brush(): BrushSettings {
    const o = this.o();
    if (o.pixel) return { size: o.size, hardness: 1, opacity: o.opacity / 100, flow: 1, spacing: 0.1, shape: 'square', antialias: false };
    return { size: o.size, hardness: o.hardness / 100, opacity: o.opacity / 100, flow: 1, spacing: 0.1, shape: 'round', antialias: true, pressureSize: true };
  }

  protected colorAt(): StrokeOptions['colorAt'] {
    const snap = this.snapshot;
    const off = this.offset;
    if (!snap || !off) return undefined;
    return (x, y) => {
      const sx = x + off.x;
      const sy = y + off.y;
      const c = snap.get(Math.floor(sx), Math.floor(sy));
      return c.a ? c : null;
    };
  }

  down(p: PointerInfo): void {
    const doc = this.app.doc;
    if (!doc) return;
    if (p.alt) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      toast('Clone source set. Now paint where you want the copy.');
      return;
    }
    if (!this.source) {
      toast('Alt+click first, to choose where to copy from.');
      return;
    }
    if (!this.offset || !this.o().aligned) this.offset = { x: Math.round(this.source.x - p.x), y: Math.round(this.source.y - p.y) };
    // Copy from how the image looks now, so the stroke doesn't copy itself
    this.snapshot = this.o().sample === 'all' ? flatten(doc) : doc.active.raster.crop({ x: -doc.active.x, y: -doc.active.y, w: doc.width, h: doc.height });
    super.down({ ...p, alt: false });
  }

  up(p: PointerInfo): void {
    super.up(p);
    this.snapshot = null;
  }

  overlay(ctx: CanvasRenderingContext2D): void {
    const view = this.app.view;
    const at = this.offset && view.hover ? { x: view.hover.x + this.offset.x, y: view.hover.y + this.offset.y } : this.source;
    if (!at) return;
    const s = view.toScreen(at.x, at.y);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(s.x - 8, s.y);
    ctx.lineTo(s.x + 8, s.y);
    ctx.moveTo(s.x, s.y - 8);
    ctx.lineTo(s.x, s.y + 8);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.restore();
  }

  options(): HTMLElement[] {
    const o = this.o();
    return [
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', log: true, width: 110, onChange: (v) => this.setOpt({ size: v }) }),
      o.pixel ? null : slider({ label: 'Hardness', min: 0, max: 100, value: o.hardness, unit: '%', width: 80, onChange: (v) => this.setOpt({ hardness: v }) }),
      slider({ label: 'Opacity', min: 1, max: 100, value: o.opacity, unit: '%', width: 80, onChange: (v) => this.setOpt({ opacity: v }) }),
      sep(),
      dropdown<'all' | 'layer'>(
        'Copy from',
        [
          ['all', 'All layers'],
          ['layer', 'This layer'],
        ],
        o.sample,
        (v) => this.setOpt({ sample: v }),
      ),
      toggle('Aligned', o.aligned, (v) => this.setOpt({ aligned: v }), 'Keeps the same distance to the source between strokes'),
      toggle('Hard pixels', o.pixel, (v) => {
        this.setOpt({ pixel: v });
        this.app.tools.changed();
      }),
    ].filter((x): x is HTMLElement => !!x);
  }
}
