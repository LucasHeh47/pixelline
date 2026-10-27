import { describe, expect, it } from 'vitest';
import { blendInto, flatten } from '../src/core/blend';
import { parseHex, toHex, type RGBA } from '../src/core/color';
import { ImageDoc } from '../src/core/document';
import { matchRegion } from '../src/core/fill';
import { Layer } from '../src/core/layer';
import { PENCIL, SOFT_BRUSH, Stroke, line } from '../src/core/paint';
import { Raster } from '../src/core/raster';
import { Mask } from '../src/core/selection';
import { ellipsePixels, rectPixels } from '../src/core/shapes';

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };

function doc(w = 16, h = 16): { doc: ImageDoc; layer: Layer } {
  const d = new ImageDoc(w, h);
  const layer = new Layer('Layer 1');
  d.layers.push(layer);
  d.activeId = layer.id;
  return { doc: d, layer };
}

const px = (l: Layer, x: number, y: number) => {
  const i = l.offset(x, y);
  return i < 0 ? [0, 0, 0, 0] : [...l.raster.data.slice(i, i + 4)];
};

describe('colours and pixels', () => {
  it('parses and formats hex', () => {
    expect(parseHex('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(parseHex('11223380')).toEqual({ r: 17, g: 34, b: 51, a: 128 });
    expect(parseHex('nope')).toBeNull();
    expect(toHex({ r: 1, g: 2, b: 3, a: 255 })).toBe('#010203');
    expect(toHex({ r: 1, g: 2, b: 3, a: 0 })).toBe('#01020300');
  });

  it('reads and writes rectangles, transparent outside', () => {
    const r = Raster.filled(4, 4, RED);
    const part = r.read({ x: -1, y: -1, w: 2, h: 2 });
    expect([...part.slice(12, 16)]).toEqual([255, 0, 0, 255]);
    expect([...part.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    r.clear({ x: 0, y: 0, w: 4, h: 1 });
    expect(r.contentBounds()).toEqual({ x: 0, y: 1, w: 4, h: 3 });
  });

  it('layers grow when painted outside their area, and keep pixels when moved', () => {
    const l = new Layer('x');
    l.ensure({ x: 10, y: 10, w: 2, h: 2 }, { x: 0, y: 0, w: 100, h: 100 });
    expect(l.bounds.w).toBeGreaterThan(2);
    l.write({ x: 10, y: 10, w: 1, h: 1 }, new Uint8ClampedArray([1, 2, 3, 255]));
    l.x += 500;
    l.x -= 500;
    expect(px(l, 10, 10)).toEqual([1, 2, 3, 255]);
    l.trim();
    expect(l.bounds).toEqual({ x: 10, y: 10, w: 1, h: 1 });
  });
});

describe('undo history', () => {
  it('keeps only changed tiles, undoes growth, and redoes', () => {
    const { doc: d, layer } = doc(300, 300);
    const e = d.begin('paint');
    const s = new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: PENCIL });
    s.moveTo(5, 5);
    s.lineTo(200, 5);
    e.commit();
    expect(px(layer, 100, 5)).toEqual([255, 0, 0, 255]);
    // A row of tiles, not the whole layer
    expect(d.history.bytes).toBeLessThan(64 * 64 * 4 * 2 * 5);
    d.undo();
    expect(px(layer, 100, 5)).toEqual([0, 0, 0, 0]);
    expect(layer.bounds.w).toBe(0);
    d.redo();
    expect(px(layer, 199, 5)).toEqual([255, 0, 0, 255]);
  });

  it('cancels an edit completely', () => {
    const { doc: d, layer } = doc();
    const e = d.begin('paint');
    new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: PENCIL }).moveTo(3, 3);
    e.cancel();
    expect(px(layer, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(d.history.canUndo).toBe(false);
  });
});

describe('blending', () => {
  it('mixes like the W3C formulas', () => {
    const dst = new Uint8ClampedArray([128, 128, 128, 255]);
    blendInto(dst, new Uint8ClampedArray([128, 255, 0, 255]), 'multiply', 1);
    expect([...dst]).toEqual([64, 128, 0, 255]);
    const d2 = new Uint8ClampedArray([0, 0, 255, 255]);
    blendInto(d2, new Uint8ClampedArray([255, 0, 0, 128]), 'normal', 1);
    expect([...d2]).toEqual([128, 0, 127, 255]);
    const d3 = new Uint8ClampedArray([200, 100, 50, 255]);
    blendInto(d3, new Uint8ClampedArray([200, 100, 50, 255]), 'difference', 1);
    expect([...d3]).toEqual([0, 0, 0, 255]);
  });

  it('flattens visible layers with opacity', () => {
    const d = new ImageDoc(2, 1);
    const a = new Layer('a', Raster.filled(2, 1, BLUE));
    const b = new Layer('b', Raster.filled(1, 1, RED), 1, 0);
    b.opacity = 0.5;
    const hidden = new Layer('c', Raster.filled(2, 1, { r: 0, g: 255, b: 0, a: 255 }));
    hidden.visible = false;
    d.layers.push(a, b, hidden);
    const out = flatten(d);
    expect([...out.data]).toEqual([0, 0, 255, 255, 128, 0, 128, 255]);
  });
});

describe('painting', () => {
  it('draws gap-free hard lines and pixel-perfect corners', () => {
    expect(line(0, 0, 3, 1)).toHaveLength(4);
    const { doc: d, layer } = doc();
    const e = d.begin('paint');
    const s = new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: PENCIL, pixelPerfect: true });
    // An L-shaped step: (2,2) → (3,2) → (3,3); pixel-perfect drops (3,2)
    s.moveTo(2.5, 2.5);
    s.lineTo(3.5, 2.5);
    s.lineTo(3.5, 3.5);
    e.commit();
    expect(px(layer, 2, 2)[3]).toBe(255);
    expect(px(layer, 3, 2)[3]).toBe(0);
    expect(px(layer, 3, 3)[3]).toBe(255);
  });

  it('never covers more than the stroke opacity, however often it overlaps', () => {
    const { doc: d, layer } = doc();
    const e = d.begin('paint');
    const s = new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: { ...PENCIL, size: 3, opacity: 0.5 } });
    s.moveTo(5.5, 5.5);
    for (let i = 0; i < 20; i++) s.lineTo(5.5 + (i % 2), 5.5);
    e.commit();
    expect(px(layer, 5, 5)[3]).toBe(128);
  });

  it('mirrors, wraps around edges, erases and keeps transparency locked', () => {
    const { doc: d, layer } = doc(16, 16);
    let e = d.begin('paint');
    new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: PENCIL, mirrorX: 8 }).moveTo(2.5, 4.5);
    e.commit();
    expect(px(layer, 2, 4)[3]).toBe(255);
    expect(px(layer, 13, 4)[3]).toBe(255);
    e = d.begin('wrap');
    new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: { ...PENCIL, size: 3 }, wrap: true }).moveTo(0.5, 10.5);
    e.commit();
    expect(px(layer, 15, 10)[3]).toBe(255);
    expect(px(layer, 1, 10)[3]).toBe(255);
    e = d.begin('erase');
    new Stroke(d, layer, e, { mode: 'erase', color: RED, brush: PENCIL }).moveTo(2.5, 4.5);
    e.commit();
    expect(px(layer, 2, 4)[3]).toBe(0);
    layer.alphaLocked = true;
    e = d.begin('recolor');
    const s = new Stroke(d, layer, e, { mode: 'paint', color: BLUE, brush: { ...PENCIL, size: 5 } });
    s.moveTo(13.5, 4.5);
    e.commit();
    expect(px(layer, 13, 4)).toEqual([0, 0, 255, 255]);
    expect(px(layer, 12, 4)[3]).toBe(0);
  });

  it('big hard brushes skip covered pixels without leaving holes', () => {
    // flow 0.999 works every pixel of every dab out in full; flow 1 only visits the new ones
    const paint = (flow: number, shape: 'round' | 'square') => {
      const { doc: d, layer } = doc(120, 90);
      const e = d.begin('paint');
      const s = new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: { ...PENCIL, size: 23, shape, flow }, wrap: true, mirrorX: 60 });
      [[5, 80], [40, 10], [41, 60], [118, 85], [70, 2]].forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
      e.commit();
      return layer.read(d.bounds);
    };
    for (const shape of ['round', 'square'] as const) expect(paint(1, shape)).toEqual(paint(0.999, shape));
  });

  it('soft brushes fade out and respect the selection', () => {
    const { doc: d, layer } = doc(40, 40);
    d.selection = Mask.rect(40, 40, { x: 0, y: 0, w: 20, h: 40 });
    const e = d.begin('paint');
    new Stroke(d, layer, e, { mode: 'paint', color: RED, brush: { ...SOFT_BRUSH, size: 20 }, selection: d.selection }).moveTo(20, 20);
    e.commit();
    const centre = px(layer, 19, 20)[3];
    const edge = px(layer, 12, 20)[3];
    expect(centre).toBe(255);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(px(layer, 21, 20)[3]).toBe(0);
  });
});

describe('fill and selections', () => {
  it('finds connected or all matching pixels', () => {
    const r = Raster.filled(5, 5, RED);
    r.fill(BLUE, { x: 2, y: 0, w: 1, h: 5 });
    expect([...matchRegion(r.data, 5, 5, 0, 0, { tolerance: 0, contiguous: true }).data].filter(Boolean)).toHaveLength(10);
    expect([...matchRegion(r.data, 5, 5, 0, 0, { tolerance: 0, contiguous: false }).data].filter(Boolean)).toHaveLength(20);
    expect([...matchRegion(r.data, 5, 5, 0, 0, { tolerance: 255, contiguous: true }).data].filter(Boolean)).toHaveLength(25);
  });

  it('makes, combines and outlines selections', () => {
    const a = Mask.rect(10, 10, { x: 0, y: 0, w: 4, h: 4 });
    const b = Mask.rect(10, 10, { x: 2, y: 2, w: 4, h: 4 });
    expect(a.combine(b, 'add').bounds).toEqual({ x: 0, y: 0, w: 6, h: 6 });
    expect(a.combine(b, 'intersect').bounds).toEqual({ x: 2, y: 2, w: 2, h: 2 });
    expect([...a.combine(b, 'subtract').data].filter(Boolean)).toHaveLength(12);
    expect(a.inverted().bounds).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    // A square's outline is 4 segments
    expect(a.outline().length / 4).toBe(4);
    const e = Mask.ellipse(20, 20, { x: 0, y: 0, w: 20, h: 20 });
    const count = [...e.data].filter(Boolean).length;
    expect(Math.abs(count - Math.PI * 100)).toBeLessThan(20);
    const tri = Mask.polygon(10, 10, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(Math.abs([...tri.data].filter(Boolean).length - 50)).toBeLessThan(8);
    const f = Mask.rect(40, 40, { x: 5, y: 5, w: 30, h: 30 }).feathered(3);
    expect(f.get(20, 20)).toBe(255);
    expect(f.get(5, 20)).toBeGreaterThan(60);
    expect(f.get(5, 20)).toBeLessThan(200);
  });

  it('draws clean pixel ellipses and rectangles', () => {
    for (const [w, h] of [
      [5, 5],
      [8, 6],
      [16, 16],
      [3, 9],
    ]) {
      const pts = ellipsePixels({ x: 0, y: 0, w, h });
      const set = new Set(pts.map((p) => `${p.x},${p.y}`));
      // Symmetric left-right and top-bottom, inside the box
      for (const p of pts) {
        expect(set.has(`${w - 1 - p.x},${p.y}`)).toBe(true);
        expect(set.has(`${p.x},${h - 1 - p.y}`)).toBe(true);
        expect(p.x >= 0 && p.x < w && p.y >= 0 && p.y < h).toBe(true);
      }
      // Touches all four sides
      expect(pts.some((p) => p.x === 0) && pts.some((p) => p.y === 0) && pts.some((p) => p.x === w - 1) && pts.some((p) => p.y === h - 1)).toBe(true);
      // Connected (8-neighbours)
      const seen = new Set<string>([`${pts[0].x},${pts[0].y}`]);
      const queue = [pts[0]];
      while (queue.length) {
        const p = queue.pop()!;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const k = `${p.x + dx},${p.y + dy}`;
            if (set.has(k) && !seen.has(k)) {
              seen.add(k);
              queue.push({ x: p.x + dx, y: p.y + dy });
            }
          }
      }
      expect(seen.size).toBe(set.size);
    }
    expect(rectPixels({ x: 0, y: 0, w: 4, h: 3 })).toHaveLength(10);
  });
});
