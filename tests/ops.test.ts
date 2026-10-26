import { describe, expect, it } from 'vitest';
import { flatten } from '../src/core/blend';
import type { RGBA } from '../src/core/color';
import { ImageDoc } from '../src/core/document';
import { FILTER_BY_ID } from '../src/core/filters';
import { decodePng, encodePng } from '../src/core/io/png';
import { readOra, writeOra } from '../src/core/io/ora';
import { readPsdFile, writePsdFile } from '../src/core/io/psd';
import { Layer } from '../src/core/layer';
import {
  addLayer,
  applyFilter,
  cropImage,
  eraseSelection,
  flattenImage,
  flipImage,
  layerFromSelection,
  mergeDown,
  newDocument,
  resizeCanvas,
  resizeImage,
  rotateImage,
  setSelection,
} from '../src/core/ops';
import { BUILTIN_PALETTES, parsePalette, serializePalette } from '../src/core/palettes';
import { makePalette, remap, toPixelArt, uniqueColors } from '../src/core/quantize';
import { Raster } from '../src/core/raster';
import { Mask } from '../src/core/selection';
import { flipH, resize, rotate90, transformRaster } from '../src/core/transform';
import { scale2x, upscale } from '../src/core/upscale';

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const ctx = { fg: { r: 0, g: 0, b: 0, a: 255 }, bg: { r: 255, g: 255, b: 255, a: 255 } };
const at = (r: Raster, x: number, y: number) => [...r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];

function checker(): Raster {
  const r = new Raster(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) r.set(x, y, (x + y) % 2 ? RED : BLUE);
  return r;
}

describe('resizing and transforms', () => {
  it('keeps hard pixels with nearest neighbour', () => {
    const big = resize(checker(), 16, 16, 'nearest');
    expect(at(big, 0, 0)).toEqual(at(big, 3, 3));
    expect(at(big, 4, 0)).toEqual([255, 0, 0, 255]);
  });

  it('smooths without dark fringes around transparency', () => {
    const r = new Raster(2, 1);
    r.set(0, 0, { r: 255, g: 255, b: 255, a: 255 });
    const out = resize(r, 4, 1, 'bilinear');
    // The half-transparent pixel next to white stays white, not grey
    const edge = at(out, 2, 0);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[0]).toBe(255);
    for (const m of ['bicubic', 'area'] as const) expect(resize(checker(), 2, 2, m).width).toBe(2);
  });

  it('rotates, flips and transforms', () => {
    const r = new Raster(3, 2);
    r.set(0, 0, RED);
    expect(at(rotate90(r, 1), 1, 0)).toEqual([255, 0, 0, 255]);
    expect(rotate90(r, 1).width).toBe(2);
    expect(at(flipH(r), 2, 0)).toEqual([255, 0, 0, 255]);
    const t = transformRaster(r, { a: 2, b: 0, c: 0, d: 2, e: 10, f: 5 }, 'nearest');
    expect(t.x).toBe(10);
    expect(t.raster.width).toBe(6);
    expect(at(t.raster, 1, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe('filters', () => {
  it('runs adjustments and blurs', () => {
    const r = checker();
    const inv = FILTER_BY_ID.get('invert')!.run(r.data, 4, 4, {}, ctx);
    expect([...inv.slice(0, 4)]).toEqual([255, 255, 0, 255]);
    const blur = FILTER_BY_ID.get('gaussianBlur')!.run(r.data, 4, 4, { radius: 2, wrap: true }, ctx);
    // A wrapped blur of a checkerboard is an even purple
    expect(Math.abs(blur[0] - blur[2])).toBeLessThan(20);
    const post = FILTER_BY_ID.get('posterize')!.run(new Uint8ClampedArray([100, 200, 30, 255]), 1, 1, { levels: 2 }, ctx);
    expect([...post]).toEqual([0, 255, 0, 255]);
  });

  it('outlines sprites and wraps textures', () => {
    const s = new Raster(5, 5);
    s.set(2, 2, RED);
    const out = FILTER_BY_ID.get('outline')!.run(s.data, 5, 5, { thickness: 1, diagonal: false, inside: false }, ctx);
    const solid = [...Array(25).keys()].filter((p) => out[p * 4 + 3]);
    expect(solid).toHaveLength(5);
    const shifted = FILTER_BY_ID.get('offset')!.run(s.data, 5, 5, { half: true, dx: 0, dy: 0 }, ctx);
    expect(shifted[(4 * 5 + 4) * 4 + 3]).toBe(255);
    const bg = new Raster(2, 1, new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]));
    const cta = FILTER_BY_ID.get('colorToAlpha')!.run(bg.data, 2, 1, { threshold: 40 }, ctx);
    expect(cta[3]).toBe(0);
    expect(cta[7]).toBe(255);
  });

  it('only changes the selection, through a document', () => {
    const doc = newDocument(10, 10, 'white');
    doc.edit('sel', (e) => setSelection(doc, e, Mask.rect(10, 10, { x: 0, y: 0, w: 5, h: 10 })));
    doc.edit('invert', (e) => applyFilter(doc, e, doc.active, FILTER_BY_ID.get('invert')!, {}, ctx));
    const flat = flatten(doc);
    expect(at(flat, 2, 2)).toEqual([0, 0, 0, 255]);
    expect(at(flat, 7, 2)).toEqual([255, 255, 255, 255]);
    doc.undo();
    expect(at(flatten(doc), 2, 2)).toEqual([255, 255, 255, 255]);
  });
});

describe('pixel art', () => {
  it('makes palettes and maps to them, with dithering', () => {
    const r = resize(checker(), 32, 32, 'bilinear');
    const pal = makePalette(r.data, 3);
    expect(pal.length).toBeLessThanOrEqual(3);
    for (const d of ['none', 'floyd', 'atkinson', 'bayer4'] as const) {
      const out = remap(r.data, 32, 32, [RED, BLUE], { dither: d });
      expect(uniqueColors(out).length).toBeLessThanOrEqual(2);
    }
  });

  it('turns a picture into small pixel art', () => {
    const photo = resize(checker(), 128, 128, 'bicubic');
    const art = toPixelArt(photo, { width: 16, height: 16, colors: 4, dither: 'none' });
    expect(art.width).toBe(16);
    expect(uniqueColors(art.data).length).toBeLessThanOrEqual(4);
  });

  it('upscales with Scale2x, rounding diagonal edges', () => {
    const r = new Raster(2, 2);
    r.set(0, 0, RED);
    r.set(1, 1, RED);
    r.set(1, 0, BLUE);
    r.set(0, 1, BLUE);
    const out = scale2x(r);
    expect(out.width).toBe(4);
    expect(upscale(r, 'nearest', 3).width).toBe(6);
  });

  it('reads and writes palette files', () => {
    const p = BUILTIN_PALETTES[1];
    for (const f of ['gpl', 'pal', 'txt', 'hex'] as const) expect(parsePalette(serializePalette(p, f)).colors).toEqual(p.colors);
    expect(parsePalette(serializePalette(p, 'gpl')).name).toBe(p.name);
  });
});

describe('document operations', () => {
  it('resizes the image and the canvas', () => {
    const doc = newDocument(4, 4, 'white');
    doc.edit('resize', (e) => resizeImage(doc, e, 8, 8, 'nearest'));
    expect([doc.width, doc.active.raster.width]).toEqual([8, 8]);
    doc.edit('canvas', (e) => resizeCanvas(doc, e, 10, 12, 'c', { r: 0, g: 0, b: 0, a: 255 }));
    expect([doc.width, doc.height]).toEqual([10, 12]);
    expect(at(flatten(doc), 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(flatten(doc), 5, 5)).toEqual([255, 255, 255, 255]);
    doc.undo();
    doc.undo();
    expect([doc.width, doc.height]).toEqual([4, 4]);
  });

  it('crops, rotates and flips', () => {
    const doc = newDocument(6, 4, 'transparent');
    doc.active.ensure({ x: 0, y: 0, w: 6, h: 4 }, doc.bounds);
    doc.active.write({ x: 5, y: 0, w: 1, h: 1 }, new Uint8ClampedArray([255, 0, 0, 255]));
    doc.edit('rot', (e) => rotateImage(doc, e, 1));
    expect([doc.width, doc.height]).toEqual([4, 6]);
    expect(at(flatten(doc), 3, 5)).toEqual([255, 0, 0, 255]);
    doc.edit('flip', (e) => flipImage(doc, e, true));
    expect(at(flatten(doc), 0, 5)).toEqual([255, 0, 0, 255]);
    doc.edit('crop', (e) => cropImage(doc, e, { x: 0, y: 4, w: 2, h: 2 }));
    expect([doc.width, doc.height]).toEqual([2, 2]);
    expect(at(flatten(doc), 0, 1)).toEqual([255, 0, 0, 255]);
  });

  it('merges, flattens, copies and erases selections', () => {
    const doc = newDocument(4, 4, 'white');
    doc.edit('add', (e) => addLayer(doc, e, new Layer('Red', Raster.filled(2, 2, RED), 1, 1)));
    doc.edit('sel', (e) => setSelection(doc, e, Mask.rect(4, 4, { x: 1, y: 1, w: 1, h: 1 })));
    const copy = doc.edit('copy', (e) => layerFromSelection(doc, e, doc.active))!;
    expect(copy.bounds).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    doc.setActive(doc.layers[1].id);
    doc.edit('erase', (e) => eraseSelection(doc, e, doc.active));
    expect(doc.layers[1].read({ x: 1, y: 1, w: 1, h: 1 })[3]).toBe(0);
    doc.edit('merge', (e) => mergeDown(doc, e, doc.layers[2]));
    expect(doc.layers).toHaveLength(2);
    doc.edit('flatten', (e) => flattenImage(doc, e));
    expect(doc.layers).toHaveLength(1);
    expect(at(flatten(doc), 2, 2)).toEqual([255, 0, 0, 255]);
    expect(at(flatten(doc), 0, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('files', () => {
  it('round-trips PNG exactly, semi-transparent and paletted', () => {
    const r = new Raster(3, 2);
    r.set(0, 0, { r: 10, g: 20, b: 30, a: 77 });
    r.set(1, 0, RED);
    const back = decodePng(encodePng(r));
    expect([...back.data]).toEqual([...r.data]);
    const many = new Raster(32, 32);
    for (let i = 0; i < many.data.length; i++) many.data[i] = (i * 37) % 256;
    expect([...decodePng(encodePng(many)).data]).toEqual([...many.data]);
    const opaque = Raster.filled(8, 8, BLUE);
    expect([...decodePng(encodePng(opaque, { indexed: false })).data]).toEqual([...opaque.data]);
  });

  it('round-trips layered OpenRaster files', async () => {
    const doc = newDocument(8, 6, 'white');
    doc.edit('add', (e) => {
      const l = new Layer('Top', Raster.filled(2, 2, { r: 1, g: 2, b: 3, a: 128 }), 3, 2);
      l.blend = 'multiply';
      l.opacity = 0.5;
      l.alphaLocked = true;
      addLayer(doc, e, l);
      const h = new Layer('Hidden', Raster.filled(1, 1, RED), -2, -2);
      h.visible = false;
      addLayer(doc, e, h);
    });
    doc.meta = { palette: ['#ff0000'], grid: { size: 2, show: true } };
    const back = await readOra(await writeOra(doc), 'x');
    expect([back.width, back.height]).toEqual([8, 6]);
    expect(back.layers.map((l) => l.name)).toEqual(['Background', 'Top', 'Hidden']);
    const top = back.layers[1];
    expect([top.x, top.y, top.blend, top.opacity, top.alphaLocked]).toEqual([3, 2, 'multiply', 0.5, true]);
    expect([...top.raster.data.slice(0, 4)]).toEqual([1, 2, 3, 128]);
    expect([back.layers[2].visible, back.layers[2].x]).toEqual([false, -2]);
    expect(back.meta.grid).toEqual({ size: 2, show: true });
    expect(back.active.name).toBe('Hidden');
  });

  it('round-trips Photoshop files', () => {
    const doc = new ImageDoc(10, 8);
    const a = new Layer('Base', Raster.filled(10, 8, BLUE));
    const b = new Layer('Sprite', Raster.filled(3, 2, RED), 4, 5);
    b.blend = 'screen';
    b.opacity = 0.75;
    doc.layers.push(a, b);
    doc.activeId = b.id;
    const { doc: back, notes } = readPsdFile(writePsdFile(doc));
    expect(notes).toEqual([]);
    expect(back.layers.map((l) => [l.name, l.x, l.y, l.raster.width, l.blend])).toEqual([
      ['Base', 0, 0, 10, 'normal'],
      ['Sprite', 4, 5, 3, 'screen'],
    ]);
    expect(back.layers[1].opacity).toBeCloseTo(0.75, 2);
    expect([...back.layers[1].raster.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });
});
