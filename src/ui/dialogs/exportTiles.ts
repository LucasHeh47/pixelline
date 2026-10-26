// Export tiles: cuts the image into tiles (the tile grid, or any size) and saves each as its own
// PNG in a folder. For texture atlases and sprite sheets; animation frames work the same way.
import { flatten } from '../../core/blend';
import { allTransparent } from '../../core/raster';
import { encodePng } from '../../core/io/png';
import { resize } from '../../core/transform';
import type { App } from '../app';
import { h } from '../dom';
import { isDesktop, platform } from '../platform';
import { dialog, toast } from '../widgets';
import { checkbox, field, numInput, numValue, row, select } from './common';

export async function openExportTiles(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  if (!isDesktop) {
    toast('Exporting tiles to a folder works in the desktop app.');
    return;
  }
  const g = doc.meta.grid?.size ?? (doc.meta.animation ? doc.width : 16);
  const tw = numInput(doc.meta.animation ? doc.width : g, 1, doc.width);
  const th = numInput(doc.meta.animation ? doc.meta.animation.frameHeight : g, 1, doc.height);
  const naming = select<'rowcol' | 'index'>(
    [
      ['rowcol', `${doc.name}_row_column.png (${doc.name}_0_1.png)`],
      ['index', `${doc.name}_number.png (${doc.name}_1.png)`],
    ],
    'rowcol',
  );
  const scale = select(
    [
      ['1', 'Actual size'],
      ['2', '200%'],
      ['4', '400%'],
      ['8', '800%'],
    ],
    '1',
  );
  const skip = checkbox('Leave out empty tiles', true);
  const info = h('div', { class: 'hint' });
  const update = () => {
    const cols = Math.floor(doc.width / numValue(tw, 16));
    const rows = Math.floor(doc.height / numValue(th, 16));
    info.textContent = `${cols} × ${rows} = ${cols * rows} tiles`;
  };
  tw.addEventListener('input', update);
  th.addEventListener('input', update);
  update();
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, 'Saves each tile of the image as its own PNG, in a folder you choose. Handy for splitting a texture atlas or a sprite sheet.'),
    row(field('Tile width', h('span', { class: 'field-inline' }, tw, h('span', { class: 'hint' }, 'px'))), field('Tile height', h('span', { class: 'field-inline' }, th, h('span', { class: 'hint' }, 'px')))),
    info,
    field('File names', naming),
    field('Size', scale),
    skip.el,
  );
  const ok = await dialog('Export tiles', body, [
    { label: 'Choose folder and export…', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const folder = await platform.pickFolder();
  if (!folder) return;
  const w = numValue(tw, 16);
  const hh = numValue(th, 16);
  const k = Number(scale.value);
  const flat = flatten(doc);
  let n = 0;
  let index = 0;
  for (let ty = 0; ty + hh <= doc.height; ty += hh)
    for (let tx = 0; tx + w <= doc.width; tx += w) {
      index++;
      let tile = flat.crop({ x: tx, y: ty, w, h: hh });
      if (skip.input.checked && allTransparent(tile.data)) continue;
      if (k > 1) tile = resize(tile, w * k, hh * k, 'nearest');
      const name = naming.value === 'index' ? `${doc.name}_${index}.png` : `${doc.name}_${ty / hh}_${tx / w}.png`;
      const r = await platform.saveInFolder(folder, name, encodePng(tile, { indexed: app.settings.bool('files.indexedPng') }));
      if (!r.ok) {
        toast(r.error ?? "Couldn't save the tiles.", { kind: 'error' });
        return;
      }
      n++;
    }
  toast(`Saved ${n} tile${n === 1 ? '' : 's'}.`, { kind: 'success', action: { label: 'Show folder', run: () => platform.showInFolder(folder) } });
}
