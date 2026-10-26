// Filter and adjustment dialogs: controls built from each filter's settings, with a live preview on
// the canvas. Applying is one undo step on the active layer (inside the selection, if any).
import { parseHex, toHex } from '../../core/color';
import { defaults, FILTER_BY_ID, type FilterDef, type Params } from '../../core/filters';
import { applyFilter, previewFilter } from '../../core/ops';
import type { App } from '../app';
import { slider, toggle } from '../controls';
import { h } from '../dom';
import { intersect, isEmpty } from '../../core/geom';
import { dialog, toast } from '../widgets';
import { curveEditor } from './curveEditor';
import { nextFrame, select } from './common';

/** Images this big preview only after the sliders stop moving. */
const SLOW = 1600 * 1600;

export function canFilter(app: App): boolean {
  const doc = app.doc;
  if (!doc) return false;
  const l = doc.active;
  if (l.locked) {
    toast(`"${l.name}" is locked. Unlock it in the Layers panel first.`);
    return false;
  }
  if (!l.visible) {
    toast(`"${l.name}" is hidden. Show it first.`);
    return false;
  }
  return true;
}

/** Applies a filter right away (filters without settings, and Repeat last filter). */
export async function applyFilterNow(app: App, id: string, params: Params): Promise<void> {
  const f = FILTER_BY_ID.get(id);
  if (!f || !canFilter(app)) return;
  app.commitTool();
  const doc = app.doc!;
  const p = { ...defaults(f), ...params };
  app.statusbar.flash(`${f.name}…`);
  await nextFrame();
  doc.edit(f.name, (e) => applyFilter(doc, e, doc.active, f, p, { fg: app.colors.fg, bg: app.colors.bg }));
  app.lastFilter = { id, params: p };
}

/** Shows a filter's result on the canvas while its dialog is open. */
export function livePreview(app: App, f: FilterDef, params: Params): { update(now?: boolean): void; setOn(on: boolean): void; stop(): void } {
  const doc = app.doc!;
  const layer = doc.active;
  const ctx = { fg: app.colors.fg, bg: app.colors.bg };
  const area = doc.selection?.bounds ?? layer.bounds;
  const slow = area.w * area.h > SLOW;
  let on = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    app.view.previews.delete(layer);
    app.view.invalidate();
  };
  const show = () => {
    if (!on) return clear();
    const r = previewFilter(doc, layer, f, params, ctx);
    if (!r) return clear();
    const canvas = new OffscreenCanvas(r.area.w, r.area.h);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.area.w, r.area.h), 0, 0);
    const hole = new OffscreenCanvas(r.area.w, r.area.h);
    const g = hole.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, r.area.w, r.area.h);
    app.view.previews.set(layer, { canvas, x: r.area.x, y: r.area.y, under: true, hole: { canvas: hole, x: r.area.x, y: r.area.y } });
    app.view.invalidate();
  };
  return {
    update(now = false) {
      clearTimeout(timer);
      timer = setTimeout(show, now ? 0 : slow ? 220 : 16);
    },
    setOn(v: boolean) {
      on = v;
      this.update(true);
    },
    stop() {
      clearTimeout(timer);
      clear();
    },
  };
}

/** Applies a filter-like change to the active layer as one undo step (not remembered as the last filter). */
export async function applyOnce(app: App, f: FilterDef, params: Params): Promise<void> {
  const doc = app.doc!;
  app.statusbar.flash(`${f.name}…`);
  await nextFrame();
  doc.edit(f.name, (e) => applyFilter(doc, e, doc.active, f, params, { fg: app.colors.fg, bg: app.colors.bg }));
}

export async function openFilter(app: App, id: string): Promise<void> {
  const f = FILTER_BY_ID.get(id);
  if (!f || !canFilter(app)) return;
  app.commitTool();
  const doc = app.doc!;
  const params: Params = { ...defaults(f), ...app.prefs.filterParams[id] };
  const preview = livePreview(app, f, params);
  const controls = h('div', { class: 'filter-controls' });
  const build = () => {
    const pixels = f.params.some((d) => d.type === 'curve') ? sample(app) : null;
    controls.replaceChildren(...f.params.map((d) => control(d, params, () => preview.update(), pixels)));
  };
  build();
  const reset = h('button', { class: 'btn text', onclick: () => {
    Object.assign(params, defaults(f));
    build();
    preview.update(true);
  } }, 'Reset');
  const body = h(
    'div',
    { class: 'filter-dialog' },
    h('p', { class: 'hint' }, f.description, doc.selection ? ' Only the selected area changes.' : ''),
    controls,
    h('div', { class: 'filter-foot' }, toggle('Preview', true, (v) => preview.setOn(v)), h('div', { class: 'spacer' }), reset),
  );
  preview.update(true);
  const ok = await dialog(f.name, body, [
    { label: 'Apply', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { side: true, cls: 'filter-modal' });
  preview.stop();
  if (!ok) return;
  app.prefs.filterParams[id] = { ...params };
  app.savePrefs();
  await applyFilterNow(app, id, params);
}

/** A control for one filter setting. */
function control(d: FilterDef['params'][number], params: Params, changed: () => void, pixels: Uint8ClampedArray | null = null): HTMLElement {
  switch (d.type) {
    case 'curve':
      return curveEditor(String(params[d.key]), pixels, (text) => {
        params[d.key] = text;
        changed();
      });
    case 'range':
      return slider({
        label: d.label,
        min: d.min ?? 0,
        max: d.max ?? 100,
        step: d.step ?? 1,
        value: Number(params[d.key]),
        unit: d.unit,
        width: 170,
        onInput: (v) => {
          params[d.key] = v;
          changed();
        },
        onChange: (v) => {
          params[d.key] = v;
          changed();
        },
      });
    case 'bool':
      return toggle(d.label, params[d.key] === true, (v) => {
        params[d.key] = v;
        changed();
      });
    case 'select': {
      const s = select((d.options ?? []) as [string, string][], String(params[d.key]));
      s.addEventListener('change', () => {
        params[d.key] = s.value;
        changed();
      });
      return h('label', { class: 'ctl ctl-dropdown' }, h('span', { class: 'ctl-label' }, d.label), s);
    }
    case 'color': {
      const c = parseHex(String(params[d.key])) ?? { r: 0, g: 0, b: 0, a: 255 };
      const input = h('input', { type: 'color', class: 'color-input', value: toHex(c, false) }) as HTMLInputElement;
      input.addEventListener('input', () => {
        params[d.key] = input.value;
        changed();
      });
      return h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, d.label), input);
    }
  }
}

/** The pixels a filter will change (for histograms), at most about a million. */
function sample(app: App): Uint8ClampedArray | null {
  const doc = app.doc;
  if (!doc) return null;
  const l = doc.active;
  const area = intersect(doc.selection?.bounds ?? l.bounds, doc.bounds);
  if (isEmpty(area)) return null;
  const step = Math.max(1, Math.ceil(Math.sqrt((area.w * area.h) / 1_000_000)));
  if (step === 1) return l.read(area);
  const out: number[] = [];
  for (let y = area.y; y < area.y + area.h; y += step) {
    const row = l.read({ x: area.x, y, w: area.w, h: 1 });
    for (let x = 0; x < area.w; x += step) out.push(row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]);
  }
  return new Uint8ClampedArray(out);
}
