// Batch processing: the same changes to every image in a folder (and its subfolders), saved into
// another folder with the same layout. Made for resource packs: upscale every texture, recolour
// them to a palette, convert formats, or run a filter over all of them.
import * as L from 'lucide';
import { applyBatchPlan, type BatchPlan } from '../../core/batch';
import { FILTERS } from '../../core/filters';
import { DITHER_LABELS, type Dither } from '../../core/quantize';
import { RESAMPLE_LABELS, type Resample } from '../../core/transform';
import type { App } from '../app';
import { h, icon } from '../dom';
import { encodeImage, extOf, readImage, type SaveFormat } from '../files';
import { allPalettes } from '../paletteStore';
import { isDesktop, platform } from '../platform';
import { confirmDialog, dialog, toast } from '../widgets';
import { checkbox, field, numInput, numValue, row, select } from './common';

export async function openBatch(app: App): Promise<void> {
  if (!isDesktop) {
    toast('Batch processing works in the desktop app.');
    return;
  }
  const saved = app.prefs.batch as BatchPlan | undefined;
  const plan: BatchPlan = saved ?? {
    scale: { on: false, percent: 200, method: 'nearest' },
    upscale: { on: true, how: 'scale2x:2' },
    colors: { on: false, palette: 'auto', count: 16, dither: 'none' },
    filter: { on: false, id: 'outline' },
    trim: false,
    format: 'keep',
  };
  // Set from the folder button (an object, so TypeScript sees it change inside the callbacks)
  const picked: { source: string | null } = { source: null };
  let files: { path: string; size: number }[] = [];
  const recursive = checkbox('Include subfolders (a whole resource pack)', true, () => void list());
  const copyOthers = checkbox('Copy other files too (.mcmeta, .json…)', true);
  const srcLabel = h('div', { class: 'batch-src hint' }, 'No folder chosen yet.');
  const list = async () => {
    if (!picked.source) return;
    files = await platform.listFolder(picked.source, recursive.input.checked);
    srcLabel.textContent = `${picked.source} — ${files.length.toLocaleString()} image${files.length === 1 ? '' : 's'}`;
  };
  const pickSource = h('button', { class: 'btn outline', onclick: async () => {
    const f = await platform.pickFolder();
    if (!f) return;
    picked.source = f;
    await list();
  } }, icon(L.FolderOpen, 15), 'Choose folder…');

  // The steps, each with a switch
  const step = (label: string, on: boolean, onToggle: (v: boolean) => void, ...controls: HTMLElement[]) => {
    const c = checkbox(label, on, (v) => {
      onToggle(v);
      box.classList.toggle('off', !v);
    });
    const box = h('div', { class: `batch-step${on ? '' : ' off'}` }, c.el, h('div', { class: 'batch-controls' }, ...controls));
    return box;
  };
  const pct = numInput(plan.scale.percent, 1, 2000, 1, 80);
  pct.addEventListener('change', () => (plan.scale.percent = numValue(pct, 100)));
  const method = select(Object.entries(RESAMPLE_LABELS) as [Resample, string][], plan.scale.method);
  method.addEventListener('change', () => (plan.scale.method = method.value as Resample));
  const up = select(
    [
      ['scale2x:2', 'Smooth edges 2× (Scale2x)'],
      ['scale3x:3', 'Smooth edges 3×'],
      ['scale4x:4', 'Smooth edges 4×'],
      ['nearest:2', 'Blocky 2×'],
      ['nearest:4', 'Blocky 4×'],
    ],
    plan.upscale.how,
  );
  up.addEventListener('change', () => (plan.upscale.how = up.value));
  const pal = select([['auto', 'Best colours for each image'], ...allPalettes(app).map((p) => [p.name, p.name] as [string, string])], plan.colors.palette);
  pal.addEventListener('change', () => (plan.colors.palette = pal.value));
  const count = numInput(plan.colors.count, 2, 256, 1, 70);
  count.addEventListener('change', () => (plan.colors.count = numValue(count, 16)));
  const dither = select(Object.entries(DITHER_LABELS) as [Dither, string][], plan.colors.dither);
  dither.addEventListener('change', () => (plan.colors.dither = dither.value as Dither));
  const filter = select(
    FILTERS.filter((f) => f.group !== 'Textures').map((f) => [f.id, `${f.group}: ${f.name}`] as [string, string]),
    plan.filter.id,
  );
  filter.addEventListener('change', () => (plan.filter.id = filter.value));
  const format = select<'keep' | SaveFormat>(
    [
      ['keep', 'Same as the original'],
      ['png', 'PNG'],
      ['jpg', 'JPEG'],
      ['webp', 'WebP'],
    ],
    plan.format,
  );
  format.addEventListener('change', () => (plan.format = format.value as BatchPlan['format']));

  const body = h(
    'div',
    { class: 'batch' },
    h('p', { class: 'hint' }, 'Makes the same changes to every image in a folder and saves the results into another folder, keeping the subfolders. The originals aren’t changed.'),
    row(pickSource, srcLabel),
    recursive.el,
    h('div', { class: 'batch-steps' },
      step('Trim transparent edges', plan.trim, (v) => (plan.trim = v)),
      step('Resize', plan.scale.on, (v) => (plan.scale.on = v), h('span', { class: 'field-inline' }, pct, h('span', { class: 'hint' }, '%')), method),
      step('Upscale pixel art', plan.upscale.on, (v) => (plan.upscale.on = v), up),
      step('Apply a filter (with its last settings)', plan.filter.on, (v) => (plan.filter.on = v), filter),
      step('Reduce colours', plan.colors.on, (v) => (plan.colors.on = v), pal, h('span', { class: 'field-inline' }, count, h('span', { class: 'hint' }, 'colours')), dither),
    ),
    field('Save as', format),
    copyOthers.el,
  );
  const go = await dialog<'run' | 'cancel'>('Batch process a folder', body, [
    { label: 'Choose output folder and start…', value: 'run', primary: true },
    { label: 'Cancel', value: 'cancel' },
  ], { wide: true, beforeClose: (v) => {
    if (v === 'run' && (!picked.source || !files.length)) {
      toast(picked.source ? 'There are no images in that folder.' : 'Choose a folder first.');
      return false;
    }
    return true;
  } });
  app.prefs.batch = plan;
  app.savePrefs();
  const source = picked.source;
  if (go !== 'run' || !source) return;
  const out = await platform.pickFolder();
  if (!out) return;
  if (out.toLowerCase() === source.toLowerCase() && !(await confirmDialog('Replace the originals?', 'The output folder is the same as the source, so the images there will be overwritten.', 'Overwrite them', true))) return;
  await run(app, plan, source, out, files, recursive.input.checked && copyOthers.input.checked, copyOthers.input.checked);
}

async function run(app: App, plan: BatchPlan, source: string, out: string, files: { path: string }[], copyNested: boolean, copyOthers: boolean): Promise<void> {
  let cancelled = false;
  const bar = h('div', { class: 'batch-bar' }, h('div', { class: 'batch-fill' }));
  const status = h('div', { class: 'hint batch-status' }, 'Starting…');
  const back = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: 'modal' }, h('h3', null, 'Processing images'), status, bar, h('div', { class: 'actions' }, h('button', { class: 'btn outline', onclick: () => (cancelled = true) }, 'Stop')));
  back.append(box);
  document.body.append(back);
  let done = 0;
  const failed: string[] = [];
  for (const f of files) {
    if (cancelled) break;
    status.textContent = `${done + 1} of ${files.length}: ${f.path}`;
    (bar.firstElementChild as HTMLElement).style.width = `${(done / files.length) * 100}%`;
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await platform.readInFolder(source, f.path);
      if (!bytes) throw new Error('unreadable');
      const { doc } = await readImage(bytes, f.path);
      applyBatchPlan(doc, plan, { palettes: allPalettes(app), filterParams: app.prefs.filterParams, fg: app.colors.fg, bg: app.colors.bg });
      const ext = extOf(f.path);
      const fmt: SaveFormat = plan.format === 'keep' ? (ext === 'jpg' || ext === 'jpeg' ? 'jpg' : ext === 'webp' ? 'webp' : 'png') : plan.format;
      const target = plan.format === 'keep' && ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? f.path : f.path.replace(/\.[^.\\/]+$/, `.${fmt}`);
      const data = await encodeImage(doc, { format: fmt, indexed: app.settings.bool('files.indexedPng'), quality: app.settings.num('files.jpegQuality') / 100 });
      const r = await platform.saveInFolder(out, target, data);
      if (!r.ok) throw new Error(r.error);
    } catch {
      failed.push(f.path);
    }
    done++;
  }
  // Other files (animation .mcmeta, models…) come along so a resource pack stays complete
  let copied = 0;
  if (!cancelled && copyOthers && out.toLowerCase() !== source.toLowerCase()) {
    const others = (await platform.listFolder(source, copyNested, true)).filter((o) => !/\.(png|jpe?g|webp|gif|bmp)$/i.test(o.path));
    for (const o of others) {
      if (cancelled) break;
      status.textContent = `Copying ${o.path}`;
      const bytes = await platform.readInFolder(source, o.path);
      if (bytes && (await platform.saveInFolder(out, o.path, bytes)).ok) copied++;
    }
  }
  back.remove();
  const msg = `${cancelled ? 'Stopped after' : 'Done:'} ${(done - failed.length).toLocaleString()} image${done - failed.length === 1 ? '' : 's'} saved${copied ? `, ${copied} other files copied` : ''}.${failed.length ? ` ${failed.length} couldn't be processed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}).` : ''}`;
  toast(msg, { kind: failed.length ? 'error' : 'success', ms: 12000, action: { label: 'Show folder', run: () => platform.showInFolder(out) } });
}
