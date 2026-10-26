import { describe, expect, it } from 'vitest';
import { deleteFrame, frameCount, insertFrame, mcmetaText, moveFrame, parseMcmeta, setAnimation } from '../src/core/animation';
import { applyBatchPlan, type BatchPlan } from '../src/core/batch';
import { luma, type RGBA } from '../src/core/color';
import { ditherOn, hueShift, makeRamp, paletteShade } from '../src/core/ink';
import { newDocument } from '../src/core/ops';
import { Stroke, PENCIL } from '../src/core/paint';
import { Raster } from '../src/core/raster';

const L = (c: RGBA) => luma(c.r, c.g, c.b);
const px = (r: Raster, x: number, y: number) => Array.from(r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe('inks', () => {
  it('shades darker toward blue and lighter toward yellow', () => {
    const green = { r: 80, g: 170, b: 60, a: 255 };
    const dark = hueShift(green, -1);
    const light = hueShift(green, 1);
    expect(L(dark)).toBeLessThan(L(green));
    expect(L(light)).toBeGreaterThan(L(green));
    // Darker drifts toward blue: more blue relative to red than the original
    expect(dark.b / Math.max(1, dark.r)).toBeGreaterThan(green.b / green.r);
    expect(dark.a).toBe(255);
  });

  it('steps along a palette ramp of the same hue', () => {
    const ramp = [
      { r: 30, g: 60, b: 20, a: 255 },
      { r: 60, g: 120, b: 40, a: 255 },
      { r: 110, g: 190, b: 80, a: 255 },
      { r: 200, g: 40, b: 40, a: 255 },
    ];
    expect(paletteShade(ramp[1], 1, ramp)).toMatchObject(ramp[2]);
    expect(paletteShade(ramp[1], -1, ramp)).toMatchObject(ramp[0]);
    expect(paletteShade(ramp[0], -1, ramp)).toBeNull();
  });

  it('makes a ramp from dark to light around a colour', () => {
    const c = { r: 120, g: 80, b: 200, a: 255 };
    const r = makeRamp(c, 7);
    expect(r).toHaveLength(7);
    expect(r[3]).toMatchObject({ r: 120, g: 80, b: 200 });
    for (let i = 1; i < r.length; i++) expect(L(r[i])).toBeGreaterThan(L(r[i - 1]));
  });

  it('dither patterns are fixed to the image', () => {
    expect([ditherOn('checker', 0, 0), ditherOn('checker', 1, 0), ditherOn('checker', 1, 1)]).toEqual([true, false, true]);
    expect([0, 1, 2, 3].filter((i) => ditherOn('light', i % 2, Math.floor(i / 2))).length).toBe(1);
    expect([0, 1, 2, 3].filter((i) => ditherOn('dark', i % 2, Math.floor(i / 2))).length).toBe(3);
  });

  it('a shading stroke changes each pixel once, from what was there, and skips transparent pixels', () => {
    const doc = newDocument(4, 1, 'transparent');
    const l = doc.layers[0];
    doc.edit('fill', (e) => {
      e.touch(l, doc.bounds);
      l.ensure(doc.bounds, doc.bounds);
      l.write({ x: 0, y: 0, w: 3, h: 1 }, new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255]));
    });
    const e = doc.begin('Shade');
    const s = new Stroke(doc, l, e, { mode: 'paint', color: { r: 0, g: 0, b: 0, a: 255 }, brush: PENCIL, colorAt: (_x, _y, under) => (under.a ? hueShift(under, -1) : null) });
    s.moveTo(0.5, 0.5);
    s.lineTo(3.5, 0.5);
    s.lineTo(0.5, 0.5);
    e.commit();
    const once = hueShift({ r: 100, g: 100, b: 100, a: 255 }, -1);
    expect(px(l.raster, 0, 0)).toEqual([once.r, once.g, once.b, 255]);
    expect(px(l.raster, 2, 0)).toEqual([once.r, once.g, once.b, 255]);
    expect(l.read({ x: 3, y: 0, w: 1, h: 1 })[3]).toBe(0);
  });
});

describe('animated textures', () => {
  function strip(): ReturnType<typeof newDocument> {
    // Three 2×2 frames with red, green and blue pixels
    const doc = newDocument(2, 6, 'transparent');
    const l = doc.layers[0];
    const data = new Uint8ClampedArray(2 * 6 * 4);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 2; x++) data.set([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][Math.floor(y / 2)], (y * 2 + x) * 4);
    doc.edit('fill', (e) => {
      e.touch(l, doc.bounds);
      l.ensure(doc.bounds, doc.bounds);
      l.write(doc.bounds, data);
    });
    doc.edit('anim', (e) => setAnimation(doc, e, { frameHeight: 2, frametime: 3, interpolate: false }));
    return doc;
  }
  const colorOf = (doc: ReturnType<typeof newDocument>, frame: number) => Array.from(doc.layers[0].read({ x: 0, y: frame * 2, w: 1, h: 1 }));

  it('adds, copies, moves and deletes frames, undoably', () => {
    const doc = strip();
    expect(frameCount(doc)).toBe(3);
    doc.edit('dup', (e) => insertFrame(doc, e, 0, true));
    expect(doc.height).toBe(8);
    expect([colorOf(doc, 0), colorOf(doc, 1), colorOf(doc, 2)]).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255]]);
    doc.edit('move', (e) => moveFrame(doc, e, 3, 0));
    expect(colorOf(doc, 0)).toEqual([0, 0, 255, 255]);
    doc.edit('del', (e) => deleteFrame(doc, e, 0));
    expect(frameCount(doc)).toBe(3);
    doc.edit('add', (e) => insertFrame(doc, e, 2, false));
    expect(colorOf(doc, 3)).toEqual([0, 0, 0, 0]);
    doc.undo();
    doc.undo();
    doc.undo();
    doc.undo();
    expect(doc.height).toBe(6);
    expect([colorOf(doc, 0), colorOf(doc, 2)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
  });

  it('writes and reads Minecraft .mcmeta files, keeping settings it does not edit', () => {
    const text = mcmetaText({ frameHeight: 16, frametime: 4, interpolate: true, extra: { frames: [0, 1, 0, 2] } }, 16);
    expect(JSON.parse(text)).toEqual({ animation: { frames: [0, 1, 0, 2], frametime: 4, interpolate: true } });
    expect(parseMcmeta(text, 16)).toEqual({ frameHeight: 16, frametime: 4, interpolate: true, extra: { frames: [0, 1, 0, 2] } });
    // Non-square frames are spelled out
    expect(JSON.parse(mcmetaText({ frameHeight: 8, frametime: 1, interpolate: false }, 16))).toEqual({ animation: { frametime: 1, width: 16, height: 8 } });
    expect(parseMcmeta('{"animation":{}}', 32)).toMatchObject({ frameHeight: 32, frametime: 1 });
    expect(parseMcmeta('{"texture":{"blur":true}}', 16)).toBeNull();
    expect(parseMcmeta('not json', 16)).toBeNull();
  });
});

describe('batch processing', () => {
  const plan = (p: Partial<BatchPlan>): BatchPlan => ({
    scale: { on: false, percent: 100, method: 'nearest' },
    upscale: { on: false, how: 'nearest:2' },
    colors: { on: false, palette: 'auto', count: 16, dither: 'none' },
    filter: { on: false, id: 'invert' },
    trim: false,
    format: 'keep',
    ...p,
  });
  const ctx = { palettes: [{ name: 'BW', colors: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }] }], filterParams: {}, fg: { r: 0, g: 0, b: 0, a: 255 }, bg: { r: 255, g: 255, b: 255, a: 255 } };

  it('trims, upscales, filters and recolours in that order', () => {
    const doc = newDocument(4, 4, 'transparent');
    const l = doc.layers[0];
    doc.edit('dot', (e) => {
      const r = { x: 1, y: 1, w: 2, h: 1 };
      e.touch(l, r);
      l.ensure(r, doc.bounds);
      l.write(r, new Uint8ClampedArray([200, 30, 30, 255, 40, 40, 40, 255]));
    });
    applyBatchPlan(doc, plan({ trim: true, upscale: { on: true, how: 'nearest:2' }, filter: { on: true, id: 'invert' }, colors: { on: true, palette: 'BW', count: 2, dither: 'none' } }), ctx);
    expect([doc.width, doc.height]).toEqual([4, 2]);
    const out = doc.layers[0].read(doc.bounds);
    // Inverted red (55,225,225) is light: white; inverted dark grey is light too
    expect(Array.from(out.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(out.slice(8, 12))).toEqual([255, 255, 255, 255]);
  });

  it('resizes by a percentage', () => {
    const doc = newDocument(10, 6, 'white');
    applyBatchPlan(doc, plan({ scale: { on: true, percent: 50, method: 'bilinear' } }), ctx);
    expect([doc.width, doc.height]).toEqual([5, 3]);
  });
});
