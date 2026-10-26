// Image size (resample everything), canvas size (add or cut space around the image) and the tile grid.
import * as L from 'lucide';
import { resizeCanvas, resizeImage, type Anchor } from '../../core/ops';
import { RESAMPLE_LABELS, type Resample } from '../../core/transform';
import type { App } from '../app';
import { h, icon } from '../dom';
import { dialog } from '../widgets';
import { checkbox, field, nextFrame, numInput, numValue, row, select } from './common';

const MAX = 16384;

export async function openImageSize(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  app.commitTool();
  const w0 = doc.width;
  const h0 = doc.height;
  const wIn = numInput(w0, 1, MAX);
  const hIn = numInput(h0, 1, MAX);
  const pct = numInput(100, 1, 10000, 1, 80);
  const link = checkbox('Keep proportions', true);
  // Pixel art: nearest neighbour keeps hard edges; photos look better smooth
  const method = select(Object.entries(RESAMPLE_LABELS) as [Resample, string][], w0 * h0 <= 256 * 256 ? 'nearest' : 'bicubic');
  const info = h('div', { class: 'hint size-info' });
  const showInfo = () => {
    const w = numValue(wIn, w0);
    const hh = numValue(hIn, h0);
    const mb = (w * hh * 4 * doc.layers.length) / 1024 / 1024;
    info.textContent = `${w0} × ${h0} → ${w} × ${hh} pixels${mb > 200 ? ` · about ${mb.toFixed(0)} MB of layers` : ''}`;
  };
  const fromW = () => {
    if (link.input.checked) hIn.value = String(Math.max(1, Math.round((numValue(wIn, w0) * h0) / w0)));
    pct.value = String(Math.round((numValue(wIn, w0) / w0) * 100));
    showInfo();
  };
  const fromH = () => {
    if (link.input.checked) wIn.value = String(Math.max(1, Math.round((numValue(hIn, h0) * w0) / h0)));
    pct.value = String(Math.round((numValue(hIn, h0) / h0) * 100));
    showInfo();
  };
  const fromPct = () => {
    const p = numValue(pct, 100) / 100;
    wIn.value = String(Math.max(1, Math.round(w0 * p)));
    hIn.value = String(Math.max(1, Math.round(h0 * p)));
    showInfo();
  };
  wIn.addEventListener('input', fromW);
  hIn.addEventListener('input', fromH);
  pct.addEventListener('input', fromPct);
  const quick = (label: string, p: number) =>
    h('button', { class: 'btn outline small', onclick: () => {
      pct.value = String(p * 100);
      fromPct();
    } }, label);
  showInfo();
  const body = h(
    'div',
    { class: 'form' },
    row(field('Width', h('span', { class: 'field-inline' }, wIn, h('span', { class: 'hint' }, 'px'))), field('Height', h('span', { class: 'field-inline' }, hIn, h('span', { class: 'hint' }, 'px'))), field('Scale', h('span', { class: 'field-inline' }, pct, h('span', { class: 'hint' }, '%')))),
    h('div', { class: 'field-row' }, link.el, h('div', { class: 'spacer' }), quick('½×', 0.5), quick('2×', 2), quick('4×', 4), quick('8×', 8)),
    field('Resampling', method, 'Nearest neighbour keeps pixel art crisp. Bicubic and Averaging are best for photos.'),
    info,
  );
  const ok = await dialog('Image size', body, [
    { label: 'Resize', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const w = numValue(wIn, w0);
  const hh = numValue(hIn, h0);
  if (w === w0 && hh === h0) return;
  app.statusbar.flash('Resizing…');
  await nextFrame();
  doc.edit('Image size', (e) => resizeImage(doc, e, w, hh, method.value as Resample));
  app.view.fit();
}

const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export async function openCanvasSize(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  app.commitTool();
  const w0 = doc.width;
  const h0 = doc.height;
  const wIn = numInput(w0, 1, MAX);
  const hIn = numInput(h0, 1, MAX);
  const rel = checkbox('Relative (add to the current size)', false, (on) => {
    wIn.min = on ? String(1 - w0) : '1';
    hIn.min = on ? String(1 - h0) : '1';
    wIn.value = String(on ? numValue(wIn, w0) - w0 : numValue(wIn, 0) + w0);
    hIn.value = String(on ? numValue(hIn, h0) - h0 : numValue(hIn, 0) + h0);
  });
  let anchor: Anchor = 'c';
  const grid = h('div', { class: 'anchor-grid' });
  const arrows: Record<Anchor, L.IconNode> = { tl: L.ArrowUpLeft, t: L.ArrowUp, tr: L.ArrowUpRight, l: L.ArrowLeft, c: L.Dot, r: L.ArrowRight, bl: L.ArrowDownLeft, b: L.ArrowDown, br: L.ArrowDownRight };
  const drawGrid = () =>
    grid.replaceChildren(
      ...ANCHORS.map((a) =>
        h('button', { class: `anchor${a === anchor ? ' on' : ''}`, 'aria-label': a, onclick: () => {
          anchor = a;
          drawGrid();
        } }, a === anchor ? icon(L.Square, 12) : icon(arrows[a], 12)),
      ),
    );
  drawGrid();
  const fill = select(
    [
      ['transparent', 'Transparent'],
      ['bg', 'Secondary colour'],
      ['fg', 'Primary colour'],
    ],
    'transparent',
  );
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, `Now ${w0} × ${h0}. Adds empty space around the image, or cuts it away. Pixels aren't stretched.`),
    row(field('Width', h('span', { class: 'field-inline' }, wIn, h('span', { class: 'hint' }, 'px'))), field('Height', h('span', { class: 'field-inline' }, hIn, h('span', { class: 'hint' }, 'px')))),
    rel.el,
    row(field('Anchor', grid, 'Where the current image stays'), field('New space on the bottom layer', fill)),
  );
  const ok = await dialog('Canvas size', body, [
    { label: 'Apply', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const w = rel.input.checked ? w0 + numValue(wIn, 0) : numValue(wIn, w0);
  const hh = rel.input.checked ? h0 + numValue(hIn, 0) : numValue(hIn, h0);
  if (w < 1 || hh < 1 || (w === w0 && hh === h0)) return;
  const color = fill.value === 'transparent' ? undefined : app.colors[fill.value as 'fg' | 'bg'];
  doc.edit('Canvas size', (e) => resizeCanvas(doc, e, w, hh, anchor, color));
  app.view.fit();
}

export async function openTileGrid(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const g = doc.meta.grid ?? { size: 16, show: true };
  const size = numInput(g.size, 2, 4096);
  const show = checkbox('Show the tile grid', true);
  const presets = h(
    'div',
    { class: 'field-row' },
    ...[8, 16, 32, 64, 128].map((n) => h('button', { class: 'btn outline small', onclick: () => (size.value = String(n)) }, String(n))),
  );
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, 'Lines every few pixels: handy for texture atlases, sprite sheets and animation frames. Saved with .ora files.'),
    field('Tile size', h('span', { class: 'field-inline' }, size, h('span', { class: 'hint' }, 'px'))),
    presets,
    show.el,
  );
  const ok = await dialog('Tile grid', body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  doc.meta.grid = { size: numValue(size, 16), show: show.input.checked };
  app.view.draw();
}
