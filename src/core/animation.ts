// Animated textures: frames of equal height stacked top to bottom in one image, the way Minecraft
// resource packs store them (with a .png.mcmeta file next to the PNG for the timing).
import type { AnimationMeta, Edit, ImageDoc } from './document';
import type { Rect } from './geom';
import { bigChange } from './ops';
import { Raster } from './raster';

export const DEFAULT_ANIMATION: AnimationMeta = { frameHeight: 16, frametime: 2, interpolate: false };

/** How many whole frames the image holds. */
export function frameCount(doc: ImageDoc): number {
  const fh = doc.meta.animation?.frameHeight ?? 0;
  return fh > 0 ? Math.max(1, Math.floor(doc.height / fh)) : 1;
}

export function frameRect(doc: ImageDoc, i: number): Rect {
  const fh = doc.meta.animation?.frameHeight ?? doc.height;
  return { x: 0, y: i * fh, w: doc.width, h: fh };
}

/** The frame a point (image y) is in. */
export function frameAt(doc: ImageDoc, y: number): number {
  const fh = doc.meta.animation?.frameHeight ?? doc.height;
  return Math.max(0, Math.min(frameCount(doc) - 1, Math.floor(y / fh)));
}

/** Turns animation on (frames as tall as the image is wide) or changes its settings, undoably. */
export function setAnimation(doc: ImageDoc, e: Edit, meta: AnimationMeta | null): void {
  const before = doc.meta.animation;
  const apply = (m: AnimationMeta | undefined) => () => {
    if (m) doc.meta.animation = m;
    else delete doc.meta.animation;
    doc.emit({ type: 'size' });
  };
  apply(meta ?? undefined)();
  e.record(apply(before), apply(meta ?? undefined));
}

/**
 * Rebuilds every layer from a list of source frames: `order[i]` is the old frame that becomes
 * frame i (null for an empty frame). Inserting, duplicating, deleting and moving frames are all
 * this. Layers are cropped to the image while doing it.
 */
function rebuildFrames(doc: ImageDoc, e: Edit, order: (number | null)[]): void {
  const fh = doc.meta.animation?.frameHeight;
  if (!fh || !order.length) return;
  const w = doc.width;
  bigChange(doc, e, () => {
    for (const l of doc.layers) {
      const old = l.read({ x: 0, y: 0, w, h: doc.height });
      const out = new Uint8ClampedArray(w * fh * order.length * 4);
      order.forEach((src, i) => {
        if (src === null) return;
        const from = src * fh * w * 4;
        out.set(old.subarray(from, from + w * fh * 4), i * fh * w * 4);
      });
      l.raster = new Raster(w, fh * order.length, out);
      l.x = 0;
      l.y = 0;
      l.trim();
    }
    doc.height = fh * order.length;
    doc.selection = null;
  });
}

const frames = (doc: ImageDoc) => Array.from({ length: frameCount(doc) }, (_, i) => i as number | null);

/** Adds a frame after `after`: a copy of it, or empty. */
export function insertFrame(doc: ImageDoc, e: Edit, after: number, copy: boolean): void {
  const order = frames(doc);
  order.splice(after + 1, 0, copy ? after : null);
  rebuildFrames(doc, e, order);
}

export function deleteFrame(doc: ImageDoc, e: Edit, i: number): void {
  const order = frames(doc);
  if (order.length < 2) return;
  order.splice(i, 1);
  rebuildFrames(doc, e, order);
}

export function moveFrame(doc: ImageDoc, e: Edit, from: number, to: number): void {
  const order = frames(doc);
  if (to < 0 || to >= order.length || from === to) return;
  const [f] = order.splice(from, 1);
  order.splice(to, 0, f);
  rebuildFrames(doc, e, order);
}

/** The .png.mcmeta file for an animated texture. */
export function mcmetaText(meta: AnimationMeta, width: number): string {
  const anim: Record<string, unknown> = { ...(meta.extra ?? {}), frametime: meta.frametime };
  if (meta.interpolate) anim.interpolate = true;
  else delete anim.interpolate;
  // Frames taller or shorter than the width have to be spelled out
  if (meta.frameHeight !== width) {
    anim.width = width;
    anim.height = meta.frameHeight;
  } else {
    delete anim.width;
    delete anim.height;
  }
  return JSON.stringify({ animation: anim }, null, 2) + '\n';
}

/** Reads an .mcmeta file. Returns null when it has no animation. */
export function parseMcmeta(text: string, imageWidth: number): AnimationMeta | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const anim = (json as { animation?: Record<string, unknown> } | null)?.animation;
  if (!anim || typeof anim !== 'object') return null;
  const { frametime, interpolate, width, height, ...extra } = anim;
  const fw = typeof width === 'number' ? width : imageWidth;
  return {
    frameHeight: typeof height === 'number' && height > 0 ? height : fw,
    frametime: typeof frametime === 'number' && frametime > 0 ? frametime : 1,
    interpolate: interpolate === true,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}
