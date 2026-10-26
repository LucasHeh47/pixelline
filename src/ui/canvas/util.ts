// Turning pixels into canvases (for previews drawn through the GPU).
import type { Raster } from '../../core/raster';
import type { Mask } from '../../core/selection';
import type { Rect } from '../../core/geom';

export function rasterCanvas(r: Raster): OffscreenCanvas {
  const c = new OffscreenCanvas(Math.max(1, r.width), Math.max(1, r.height));
  if (r.width && r.height) c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data) as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return c;
}

/** A canvas whose alpha is the selection over `area` (used to punch holes and mask previews). */
export function maskCanvas(m: Mask, area: Rect): OffscreenCanvas {
  const c = new OffscreenCanvas(Math.max(1, area.w), Math.max(1, area.h));
  const img = new ImageData(Math.max(1, area.w), Math.max(1, area.h));
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      const i = (y * area.w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = m.get(area.x + x, area.y + y);
    }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}
