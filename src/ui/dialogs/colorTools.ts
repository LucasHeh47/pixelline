// Colour tools for pixel art: reduce colours (to a palette, with dithering), turn a picture into
// pixel art, upscale pixel art with smooth edges, and replace one colour with another.
import { flatten } from '../../core/blend';
import { parseHex, toHex, type RGBA } from '../../core/color';
import { replaceColor } from '../../core/fill';
import type { FilterDef, Params } from '../../core/filters';
import { documentFromRaster, upscaleImage } from '../../core/ops';
import { DITHER_LABELS, makePalette, remap, toPixelArt, uniqueColors, type Dither } from '../../core/quantize';
import { resize } from '../../core/transform';
import type { Upscaler } from '../../core/upscale';
import { upscale } from '../../core/upscale';
import type { App } from '../app';
import { slider, toggle } from '../controls';
import { debounce, h } from '../dom';
import { allPalettes, currentPalette } from '../paletteStore';
import { dialog, toast } from '../widgets';
import { checkbox, field, nextFrame, numInput, numValue, rasterPreview, row, select } from './common';
import { applyOnce, canFilter, livePreview } from './filterDialog';

const ditherOptions = Object.entries(DITHER_LABELS) as [Dither, string][];

function paletteOptions(app: App, auto: string): [string, string][] {
  return [['auto', auto], ...allPalettes(app).map((p) => [p.name, `${p.name} (${p.colors.length})`] as [string, string])];
}

function paletteColors(app: App, name: string): RGBA[] | null {
  if (name === 'auto') return null;
  return allPalettes(app).find((p) => p.name === name)?.colors ?? null;
}

// ---------- reduce colours ----------

export async function openReduceColors(app: App): Promise<void> {
  if (!canFilter(app)) return;
  app.commitTool();
  const doc = app.doc!;
  const area = doc.selection?.bounds ?? doc.active.bounds;
  const now = uniqueColors(doc.active.read(area), 100000).length;
  const params: Params = { colors: Math.min(16, Math.max(2, now)), palette: 'auto', dither: 'none', strength: 80, hard: true };
  const f: FilterDef = {
    id: 'reduceColors',
    name: 'Reduce colours',
    group: 'Other',
    description: '',
    params: [],
    run: (src, w, hh, p) => {
      const pal = paletteColors(app, String(p.palette)) ?? makePalette(src, Number(p.colors));
      return remap(src, w, hh, pal, { dither: p.dither as Dither, strength: Number(p.strength) / 100, alphaThreshold: p.hard ? 128 : undefined });
    },
  };
  const preview = livePreview(app, f, params);
  const count = slider({ label: 'Colours', min: 2, max: 256, value: Number(params.colors), log: true, width: 160, onInput: (v) => set('colors', v), onChange: (v) => set('colors', v) });
  const pal = select(paletteOptions(app, 'Best colours for this image'), 'auto');
  const set = (k: string, v: number | string | boolean) => {
    params[k] = v;
    count.style.display = params.palette === 'auto' ? '' : 'none';
    preview.update();
  };
  pal.addEventListener('change', () => set('palette', pal.value));
  const dither = select(ditherOptions, 'none');
  dither.addEventListener('change', () => set('dither', dither.value));
  const body = h(
    'div',
    { class: 'filter-dialog' },
    h('p', { class: 'hint' }, `This layer has ${now >= 100000 ? 'over 100,000' : now.toLocaleString()} colours${doc.selection ? ' in the selection' : ''}. Pick how many to keep, or a palette to match.`),
    field('Palette', pal),
    count,
    field('Dithering', dither, 'Mixes palette colours in patterns to suggest the ones that are missing.'),
    slider({ label: 'Dither strength', min: 0, max: 100, value: 80, unit: '%', width: 140, onInput: (v) => set('strength', v), onChange: (v) => set('strength', v) }),
    toggle('Hard edges (no half-transparent pixels)', true, (v) => set('hard', v)),
    h('div', { class: 'filter-foot' }, toggle('Preview', true, (v) => preview.setOn(v))),
  );
  preview.update(true);
  const ok = await dialog('Reduce colours', body, [
    { label: 'Apply', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { side: true, cls: 'filter-modal' });
  preview.stop();
  if (ok) await applyOnce(app, f, params);
}

// ---------- pixel art from a picture ----------

export async function openPixelArt(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  app.commitTool();
  const src = flatten(doc, doc.selection?.bounds ?? doc.bounds);
  const ratio = src.height / src.width;
  const startW = Math.min(src.width, 32);
  const wIn = numInput(startW, 1, 1024);
  const hIn = numInput(Math.max(1, Math.round(startW * ratio)), 1, 1024);
  const keep = checkbox('Keep proportions', true);
  const o = { colors: 16, palette: 'auto', dither: 'none' as Dither, punch: 25, alpha: 128, scaleBack: false };
  wIn.addEventListener('input', () => {
    if (keep.input.checked) hIn.value = String(Math.max(1, Math.round(numValue(wIn, startW) * ratio)));
    refresh();
  });
  hIn.addEventListener('input', () => {
    if (keep.input.checked) wIn.value = String(Math.max(1, Math.round(numValue(hIn, 16) / ratio)));
    refresh();
  });
  const sizes = h('div', { class: 'field-row' }, ...[16, 32, 64, 128].map((n) => h('button', { class: 'btn outline small', onclick: () => {
    wIn.value = String(n);
    hIn.value = String(keep.input.checked ? Math.max(1, Math.round(n * ratio)) : n);
    refresh();
  } }, `${n} px`)));
  const pal = select(paletteOptions(app, 'Best colours for this picture'), 'auto');
  const count = slider({ label: 'Colours', min: 2, max: 64, value: 16, width: 140, onChange: (v) => {
    o.colors = v;
    refresh();
  }, onInput: (v) => {
    o.colors = v;
    refresh();
  } });
  pal.addEventListener('change', () => {
    o.palette = pal.value;
    count.style.display = o.palette === 'auto' ? '' : 'none';
    refresh();
  });
  const dither = select(ditherOptions, 'none');
  dither.addEventListener('change', () => {
    o.dither = dither.value as Dither;
    refresh();
  });
  const box = h('div', { class: 'pa-preview' });
  const info = h('div', { class: 'hint' });
  let result = src;
  const render = () => {
    const w = numValue(wIn, startW);
    const hh = numValue(hIn, 16);
    result = toPixelArt(src, { width: w, height: hh, colors: o.colors, palette: paletteColors(app, o.palette) ?? undefined, dither: o.dither, punch: o.punch, alphaThreshold: o.alpha });
    box.replaceChildren(rasterPreview(result, 300, 260));
    info.textContent = `${w} × ${hh} pixels, ${uniqueColors(result.data).length} colours`;
  };
  const refresh = debounce(render, 60);
  const scaleBack = checkbox('Scale back up to the original size (blocky look)', false, (v) => (o.scaleBack = v));
  const body = h(
    'div',
    { class: 'pixel-art' },
    h(
      'div',
      { class: 'form' },
      h('p', { class: 'hint' }, `Shrinks ${doc.selection ? 'the selected area' : 'the picture'} to a few pixels and limits its colours: a quick start for textures and sprites. The result opens as a new image.`),
      row(field('Width', wIn), field('Height', hIn)),
      keep.el,
      sizes,
      field('Palette', pal),
      count,
      field('Dithering', dither),
      slider({ label: 'Punchier colours', min: 0, max: 100, value: 25, unit: '%', width: 140, onInput: (v) => {
        o.punch = v;
        refresh();
      }, onChange: (v) => {
        o.punch = v;
        refresh();
      } }),
      slider({ label: 'Transparency cut-off', min: 1, max: 255, value: 128, width: 140, title: 'Pixels less opaque than this become fully transparent', onInput: (v) => {
        o.alpha = v;
        refresh();
      }, onChange: (v) => {
        o.alpha = v;
        refresh();
      } }),
      scaleBack.el,
    ),
    h('div', { class: 'pa-side' }, box, info),
  );
  render();
  const ok = await dialog('Turn into pixel art', body, [
    { label: 'Create', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { wide: true });
  if (!ok) return;
  render();
  let out = result;
  if (o.scaleBack) {
    out = resize(result, src.width, src.height, 'nearest');
  }
  const nd = documentFromRaster(out, `${doc.name} pixel art`);
  nd.layers[0].name = 'Pixel art';
  if (!o.scaleBack && out.width <= 256) nd.meta.grid = { size: Math.min(16, out.width), show: false };
  app.newImage(nd);
}

// ---------- upscale ----------

const UPSCALERS: [string, string][] = [
  ['scale2x:2', 'Smooth edges 2× (Scale2x)'],
  ['scale3x:3', 'Smooth edges 3× (Scale3x)'],
  ['scale4x:4', 'Smooth edges 4× (Scale2x twice)'],
  ['nearest:2', 'Blocky 2× (nearest neighbour)'],
  ['nearest:3', 'Blocky 3×'],
  ['nearest:4', 'Blocky 4×'],
];

export async function openUpscale(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  app.commitTool();
  if (doc.width * doc.height > 1024 * 1024) {
    toast('Upscaling is meant for pixel art. For big images use Image → Image size.');
  }
  const how = select(UPSCALERS, 'scale2x:2');
  const src = flatten(doc);
  const before = h('div', { class: 'pa-preview' });
  const after = h('div', { class: 'pa-preview' });
  const crop = src.width > 64 || src.height > 64 ? src.crop({ x: Math.max(0, Math.floor(src.width / 2 - 32)), y: Math.max(0, Math.floor(src.height / 2 - 32)), w: Math.min(64, src.width), h: Math.min(64, src.height) }) : src;
  const render = () => {
    const [m, f] = how.value.split(':');
    const big = upscale(crop, m as Upscaler, Number(f) as 2 | 3 | 4);
    before.replaceChildren(rasterPreview(crop, 220, 220));
    after.replaceChildren(rasterPreview(big, 220, 220));
  };
  how.addEventListener('change', render);
  render();
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, 'Enlarges pixel art. Smooth edges rounds off jagged diagonals without blurring (great for turning 16× textures into 32×). Every layer is scaled.'),
    field('Method', how),
    h('div', { class: 'compare' }, h('div', null, h('div', { class: 'hint' }, 'Before'), before), h('div', null, h('div', { class: 'hint' }, 'After'), after)),
  );
  const ok = await dialog('Upscale pixel art', body, [
    { label: 'Upscale', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { wide: true });
  if (!ok) return;
  const [m, f] = how.value.split(':');
  await nextFrame();
  doc.edit('Upscale', (e) => upscaleImage(doc, e, m as Upscaler, Number(f) as 2 | 3 | 4));
  app.view.fit();
}

// ---------- replace colour ----------

export async function openReplaceColor(app: App): Promise<void> {
  if (!canFilter(app)) return;
  app.commitTool();
  const params: Params = { from: toHex(app.colors.fg, false), to: toHex(app.colors.bg, false), tolerance: 0, keepShade: false };
  const f: FilterDef = {
    id: 'replaceColor',
    name: 'Replace colour',
    group: 'Other',
    description: '',
    params: [],
    run: (src, _w, _h, p) => {
      const out = new Uint8ClampedArray(src);
      const from = parseHex(String(p.from))!;
      const to = parseHex(String(p.to))!;
      if (p.keepShade) {
        // Shift the hue/brightness of matching pixels instead of painting them flat
        const tol = Number(p.tolerance) * 4.42;
        for (let i = 0; i < out.length; i += 4) {
          if (!out[i + 3]) continue;
          const d = Math.hypot(out[i] - from.r, out[i + 1] - from.g, out[i + 2] - from.b);
          if (d > tol) continue;
          out[i] = Math.max(0, Math.min(255, out[i] + to.r - from.r));
          out[i + 1] = Math.max(0, Math.min(255, out[i + 1] + to.g - from.g));
          out[i + 2] = Math.max(0, Math.min(255, out[i + 2] + to.b - from.b));
        }
        return out;
      }
      replaceColor(out, from, to, Number(p.tolerance) * 2.55, null);
      return out;
    },
  };
  const preview = livePreview(app, f, params);
  const colorBox = (key: 'from' | 'to') => {
    const input = h('input', { type: 'color', class: 'color-input', value: String(params[key]) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      params[key] = input.value;
      preview.update();
    });
    const use = (which: 'fg' | 'bg', label: string) =>
      h('button', { class: 'btn outline small', onclick: () => {
        input.value = toHex(app.colors[which], false);
        params[key] = input.value;
        preview.update();
      } }, label);
    return h('span', { class: 'field-inline' }, input, use('fg', 'Primary'), use('bg', 'Secondary'));
  };
  const body = h(
    'div',
    { class: 'filter-dialog' },
    h('p', { class: 'hint' }, 'Swaps one colour for another on this layer — recolour a texture in one go. Set the colours to replace with the eyedropper (primary and secondary colours) before opening this.'),
    field('Replace', colorBox('from')),
    field('With', colorBox('to')),
    slider({ label: 'Similar colours too', min: 0, max: 100, value: 0, unit: '%', width: 150, onInput: (v) => {
      params.tolerance = v;
      preview.update();
    }, onChange: (v) => {
      params.tolerance = v;
      preview.update();
    } }),
    toggle('Keep shading (shift colours instead of flattening them)', false, (v) => {
      params.keepShade = v;
      preview.update();
    }),
    h('div', { class: 'filter-foot' }, toggle('Preview', true, (v) => preview.setOn(v))),
  );
  preview.update(true);
  const ok = await dialog('Replace colour', body, [
    { label: 'Replace', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { side: true, cls: 'filter-modal' });
  preview.stop();
  if (ok) await applyOnce(app, f, params);
}

/** The Swatches panel's palette, for menus elsewhere. */
export function swatchPalette(app: App): RGBA[] {
  return currentPalette(app).colors;
}
