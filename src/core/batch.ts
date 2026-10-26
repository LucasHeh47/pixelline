// Batch processing: the same changes applied to many images (the dialog is in ui/dialogs/batch.ts).
import { flatten } from './blend';
import type { RGBA } from './color';
import type { ImageDoc } from './document';
import { defaults, FILTER_BY_ID, type Params } from './filters';
import { applyFilter, contentBounds, cropImage, resizeImage, upscaleImage } from './ops';
import type { Palette } from './palettes';
import { makePalette, remap, type Dither } from './quantize';
import type { Resample } from './transform';
import type { Upscaler } from './upscale';

/** 'keep' saves in the same format as the original. */
export type BatchFormat = 'keep' | 'png' | 'jpg' | 'webp' | 'ora' | 'psd';

export interface BatchPlan {
  scale: { on: boolean; percent: number; method: Resample };
  upscale: { on: boolean; how: string };
  colors: { on: boolean; palette: string; count: number; dither: Dither };
  filter: { on: boolean; id: string };
  trim: boolean;
  format: BatchFormat;
}

/** What a plan needs from the app: palettes by name, saved filter settings and the colours. */
export interface BatchContext {
  palettes: Palette[];
  filterParams: Record<string, Params>;
  fg: RGBA;
  bg: RGBA;
}

/** Applies a batch plan to one image (one undo step, though nobody undoes a batch). */
export function applyBatchPlan(doc: ImageDoc, plan: BatchPlan, ctx: BatchContext): void {
  doc.edit('Batch', (e) => {
    if (plan.trim) {
      const r = contentBounds(doc);
      if (r.w > 0 && r.h > 0 && (r.w !== doc.width || r.h !== doc.height)) cropImage(doc, e, r, true);
    }
    if (plan.scale.on && plan.scale.percent !== 100) {
      const w = Math.max(1, Math.round((doc.width * plan.scale.percent) / 100));
      const hh = Math.max(1, Math.round((doc.height * plan.scale.percent) / 100));
      resizeImage(doc, e, w, hh, plan.scale.method);
    }
    if (plan.upscale.on) {
      const [m, f] = plan.upscale.how.split(':');
      upscaleImage(doc, e, m as Upscaler, Number(f) as 2 | 3 | 4);
    }
    if (plan.filter.on) {
      const f = FILTER_BY_ID.get(plan.filter.id);
      if (f) for (const l of doc.layers) applyFilter(doc, e, l, f, { ...defaults(f), ...ctx.filterParams[f.id] }, { fg: ctx.fg, bg: ctx.bg });
    }
    if (plan.colors.on) {
      const pal = plan.colors.palette === 'auto' ? makePalette(flatten(doc).data, plan.colors.count) : (ctx.palettes.find((p) => p.name === plan.colors.palette)?.colors ?? []);
      for (const l of doc.layers) {
        const area = l.bounds;
        if (!area.w || !area.h || !pal.length) continue;
        e.touch(l, area);
        l.write(area, remap(l.read(area), area.w, area.h, pal, { dither: plan.colors.dither, strength: 0.8, alphaThreshold: 128 }));
      }
    }
  });
}

