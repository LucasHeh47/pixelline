// A layer: pixels placed at an offset in the image, plus how it mixes with the layers below.
// Layers only store the area they use, and grow when painted outside it, so an empty layer costs
// nothing and moving one (changing its offset) never cuts anything off at the image edge.
import { intersect, isEmpty, union, type Rect } from './geom';
import { Raster } from './raster';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: { id: BlendMode; label: string; group: number }[] = [
  { id: 'normal', label: 'Normal', group: 0 },
  { id: 'darken', label: 'Darken', group: 1 },
  { id: 'multiply', label: 'Multiply', group: 1 },
  { id: 'color-burn', label: 'Color burn', group: 1 },
  { id: 'lighten', label: 'Lighten', group: 2 },
  { id: 'screen', label: 'Screen', group: 2 },
  { id: 'color-dodge', label: 'Color dodge', group: 2 },
  { id: 'overlay', label: 'Overlay', group: 3 },
  { id: 'soft-light', label: 'Soft light', group: 3 },
  { id: 'hard-light', label: 'Hard light', group: 3 },
  { id: 'difference', label: 'Difference', group: 4 },
  { id: 'exclusion', label: 'Exclusion', group: 4 },
  { id: 'hue', label: 'Hue', group: 5 },
  { id: 'saturation', label: 'Saturation', group: 5 },
  { id: 'color', label: 'Color', group: 5 },
  { id: 'luminosity', label: 'Luminosity', group: 5 },
];

let nextId = 1;
export const newLayerId = () => `L${Date.now().toString(36)}${(nextId++).toString(36)}`;

export class Layer {
  id: string;
  name: string;
  /** Where the raster's top-left pixel sits in the image. */
  x = 0;
  y = 0;
  raster: Raster;
  visible = true;
  /** 0–1 */
  opacity = 1;
  blend: BlendMode = 'normal';
  /** Can't be painted on or moved. */
  locked = false;
  /** Painting keeps the transparency as it is (only colors change). */
  alphaLocked = false;

  constructor(name: string, raster?: Raster, x = 0, y = 0, id?: string) {
    this.id = id ?? newLayerId();
    this.name = name;
    this.raster = raster ?? new Raster(0, 0);
    this.x = x;
    this.y = y;
  }

  /** The area the layer's pixels cover, in image coordinates. */
  get bounds(): Rect {
    return { x: this.x, y: this.y, w: this.raster.width, h: this.raster.height };
  }

  /** Copies a rectangle (image coordinates) out of the layer; outside it is transparent. */
  read(r: Rect): Uint8ClampedArray {
    return this.raster.read({ x: r.x - this.x, y: r.y - this.y, w: r.w, h: r.h });
  }

  /** Writes pixels (image coordinates); only the part inside the layer's area is kept. */
  write(r: Rect, data: Uint8ClampedArray): void {
    this.raster.write({ x: r.x - this.x, y: r.y - this.y, w: r.w, h: r.h }, data);
  }

  /** Byte offset of an image pixel in the raster, or -1. */
  offset(x: number, y: number): number {
    return this.raster.offset(x - this.x, y - this.y);
  }

  /** Moves and resizes the stored area, keeping the pixels where they are in the image. */
  setArea(area: Rect): void {
    if (area.x === this.x && area.y === this.y && area.w === this.raster.width && area.h === this.raster.height) return;
    const next = new Raster(Math.max(0, area.w), Math.max(0, area.h));
    const keep = intersect(area, this.bounds);
    if (!isEmpty(keep)) next.write({ x: keep.x - area.x, y: keep.y - area.y, w: keep.w, h: keep.h }, this.read(keep));
    this.raster = next;
    this.x = area.x;
    this.y = area.y;
  }

  /**
   * Makes the layer cover `r` (for painting there). It grows with some room to spare, so a brush
   * stroke doesn't reallocate on every dab, but never past `limit` (usually the image).
   */
  ensure(r: Rect, limit: Rect): void {
    const need = intersect(r, limit);
    if (isEmpty(need)) return;
    const cur = this.bounds;
    const hit = intersect(need, cur);
    if (!isEmpty(cur) && hit.w === need.w && hit.h === need.h) return;
    const margin = Math.max(64, Math.round(Math.max(limit.w, limit.h) / 8));
    const grown = { x: need.x - margin, y: need.y - margin, w: need.w + margin * 2, h: need.h + margin * 2 };
    this.setArea(union(cur, intersect(grown, limit)));
  }

  /** Shrinks the stored area to the pixels in use. */
  trim(): void {
    const c = this.raster.contentBounds();
    this.setArea(isEmpty(c) ? { x: 0, y: 0, w: 0, h: 0 } : { x: this.x + c.x, y: this.y + c.y, w: c.w, h: c.h });
  }

  /** A copy with its own pixels. */
  clone(name = this.name): Layer {
    const l = new Layer(name, this.raster.clone(), this.x, this.y);
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.blend = this.blend;
    l.alphaLocked = this.alphaLocked;
    return l;
  }

  /** The layer's settings (not its pixels), for undo. */
  props(): LayerProps {
    return { name: this.name, visible: this.visible, opacity: this.opacity, blend: this.blend, locked: this.locked, alphaLocked: this.alphaLocked };
  }

  setProps(p: Partial<LayerProps>): void {
    Object.assign(this, p);
  }
}

export interface LayerProps {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  alphaLocked: boolean;
}
