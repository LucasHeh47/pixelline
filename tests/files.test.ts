import { describe, expect, it } from 'vitest';
import { Layer } from '../src/core/layer';
import { addLayer, newDocument, upscaleImage } from '../src/core/ops';
import { Raster } from '../src/core/raster';
import { baseName, encodeImage, extOf, formatFromExt, lossNote, readImage } from '../src/ui/files';

const red = { r: 255, g: 0, b: 0, a: 255 };

describe('file helpers', () => {
  it('reads extensions and names', () => {
    expect(extOf('C:\\textures\\Grass.PNG')).toBe('png');
    expect(extOf('noext')).toBe('');
    expect(baseName('stone.ora')).toBe('stone');
    expect(formatFromExt('jpeg')).toBe('jpg');
    expect(formatFromExt('gif')).toBeNull();
  });

  it('notes when a save flattens layers', () => {
    const doc = newDocument(4, 4, 'transparent');
    expect(lossNote(doc, 'png')).toBeNull();
    doc.edit('add', (e) => addLayer(doc, e, new Layer('Top')));
    expect(lossNote(doc, 'png')).toMatch(/flattened/);
    expect(lossNote(doc, 'ora')).toBeNull();
  });

  it('round-trips PNG and ORA through save and open', async () => {
    const doc = newDocument(3, 2, 'transparent', 'tex');
    doc.layers[0].raster = Raster.filled(3, 2, red);
    const top = new Layer('Top', Raster.filled(1, 1, { r: 0, g: 0, b: 255, a: 255 }), 2, 1);
    doc.edit('add', (e) => addLayer(doc, e, top));

    const png = await readImage(await encodeImage(doc, { format: 'png' }), 'tex.png');
    expect(png.doc.fileType).toBe('png');
    expect(png.doc.layers).toHaveLength(1);
    expect(Array.from(png.doc.layers[0].raster.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(png.doc.layers[0].read({ x: 2, y: 1, w: 1, h: 1 }))).toEqual([0, 0, 255, 255]);

    const ora = await readImage(await encodeImage(doc, { format: 'ora' }), 'tex.ora');
    expect(ora.doc.fileType).toBe('ora');
    expect(ora.doc.layers.map((l) => l.name)).toEqual([doc.layers[0].name, 'Top']);
    expect(ora.doc.layers[1].x).toBe(2);
  });

  it('scales PNG exports with crisp pixels', async () => {
    const doc = newDocument(2, 1, 'transparent');
    doc.layers[0].raster = new Raster(2, 1, new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]));
    const out = await readImage(await encodeImage(doc, { format: 'png', scale: 3 }), 'x.png');
    expect(out.doc.width).toBe(6);
    expect(out.doc.height).toBe(3);
    const row = out.doc.layers[0].read({ x: 0, y: 1, w: 6, h: 1 });
    expect([row[0], row[8], row[12], row[20]]).toEqual([255, 255, 0, 0]);
  });
});

describe('upscaleImage', () => {
  it('scales every layer, its position and the tile grid, and undoes', () => {
    const doc = newDocument(4, 4, 'white');
    doc.meta.grid = { size: 2, show: true };
    doc.edit('add', (e) => addLayer(doc, e, new Layer('Dot', Raster.filled(1, 1, red), 1, 2)));
    doc.edit('Upscale', (e) => upscaleImage(doc, e, 'nearest', 2));
    expect([doc.width, doc.height]).toEqual([8, 8]);
    const dot = doc.layers[1];
    expect([dot.x, dot.y, dot.raster.width]).toEqual([2, 4, 2]);
    expect(doc.meta.grid?.size).toBe(4);
    doc.undo();
    expect([doc.width, doc.height, doc.layers[1].x, doc.meta.grid?.size]).toEqual([4, 4, 1, 2]);
  });
});
