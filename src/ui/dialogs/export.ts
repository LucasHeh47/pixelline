// Export as: a flattened copy as PNG, JPEG or WebP, optionally scaled (crisp whole-number scales for
// pixel art), with the file size shown before saving. The image itself isn't changed.
import { encodePng } from '../../core/io/png';
import { encodeImage, exportRaster, type SaveFormat } from '../files';
import type { App } from '../app';
import { slider } from '../controls';
import { debounce, h } from '../dom';
import { isDesktop, platform } from '../platform';
import { dialog, toast } from '../widgets';
import { checkbox, field, formatBytes, numInput, numValue, row, select } from './common';

const SCALES: [string, string][] = [
  ['1', '100% (actual size)'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
  ['8', '800%'],
  ['16', '1600%'],
  ['0.5', '50%'],
  ['0.25', '25%'],
  ['custom', 'Custom…'],
];

export async function openExport(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  app.commitTool();
  const o = app.prefs.exportOpts;
  const format = select<SaveFormat>(
    [
      ['png', 'PNG'],
      ['jpg', 'JPEG'],
      ['webp', 'WebP'],
    ],
    o.format === 'jpg' || o.format === 'webp' ? o.format : 'png',
  );
  const scaleSel = select(SCALES, SCALES.some(([v]) => Number(v) === o.scale) ? String(o.scale) : 'custom');
  const custom = numInput(Math.round(o.scale * 100), 1, 10000, 1, 80);
  const customWrap = h('span', { class: 'field-inline' }, custom, h('span', { class: 'hint' }, '%'));
  let quality = Math.round(o.quality * 100);
  const qualityEl = slider({ label: 'Quality', min: 10, max: 100, value: quality, unit: '%', width: 150, onInput: (v) => {
    quality = v;
    estimate();
  }, onChange: (v) => {
    quality = v;
    estimate();
  } });
  const small = checkbox('Smaller file for pixel art (paletted when 256 colours or fewer)', app.settings.bool('files.indexedPng'), () => estimate());
  const size = h('div', { class: 'export-size' });
  const scale = () => (scaleSel.value === 'custom' ? numValue(custom, 100) / 100 : Number(scaleSel.value));
  const opts = () => ({ format: format.value as SaveFormat, scale: scale(), quality: quality / 100, indexed: small.input.checked });
  let seq = 0;
  const estimate = debounce(async () => {
    const n = ++seq;
    const s = scale();
    const w = Math.max(1, Math.round(doc.width * s));
    const hh = Math.max(1, Math.round(doc.height * s));
    size.textContent = `${w} × ${hh} pixels · working out the file size…`;
    try {
      const bytes = w * hh > 40_000_000 ? null : await encodeImage(doc, opts());
      if (n !== seq) return;
      size.textContent = `${w} × ${hh} pixels${bytes ? ` · ${formatBytes(bytes.length)}` : ''}`;
    } catch {
      if (n === seq) size.textContent = `${w} × ${hh} pixels`;
    }
  }, 250);
  const sync = () => {
    customWrap.style.display = scaleSel.value === 'custom' ? '' : 'none';
    qualityEl.style.display = format.value === 'png' ? 'none' : '';
    small.el.style.display = format.value === 'png' ? '' : 'none';
    estimate();
  };
  format.addEventListener('change', sync);
  scaleSel.addEventListener('change', sync);
  custom.addEventListener('input', () => estimate());
  sync();
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, 'Saves a flattened copy. Your image and its layers stay as they are. Whole-number scales keep pixel art crisp.'),
    row(field('Format', format), field('Size', scaleSel), customWrap),
    qualityEl,
    small.el,
    size,
  );
  const choice = await dialog<'export' | 'copy' | 'cancel'>('Export as', body, [
    { label: 'Export…', value: 'export', primary: true },
    { label: 'Copy to clipboard', value: 'copy' },
    { label: 'Cancel', value: 'cancel' },
  ], { cancelValue: 'cancel' });
  seq++;
  if (choice === 'cancel') return;
  const chosen = opts();
  app.prefs.exportOpts = { format: chosen.format, scale: chosen.scale, quality: chosen.quality };
  app.savePrefs();
  if (choice === 'copy') {
    await platform.writeClipboardImage(encodePng(exportRaster(doc, chosen), { indexed: false, level: 1 }));
    toast('Copied the exported image.', { kind: 'success' });
    return;
  }
  const ext = chosen.format;
  const suffix = chosen.scale !== 1 ? `@${chosen.scale}x` : '';
  const path = await platform.saveFileDialog(`${doc.name}${suffix}.${ext}`, ext as 'png' | 'jpg' | 'webp');
  if (!path) return;
  const bytes = await encodeImage(doc, chosen);
  const r = await platform.saveFile(path, bytes);
  if (!r.ok) {
    toast(r.error ?? "Couldn't save the file.", { kind: 'error' });
    return;
  }
  const name = path.split(/[\\/]/).pop();
  toast(`Exported ${name} (${formatBytes(bytes.length)}).`, isDesktop ? { kind: 'success', action: { label: 'Show in folder', run: () => platform.showInFolder(path) } } : { kind: 'success' });
}
