// Building blocks for dialogs: labelled fields, number boxes, choices, and a tiny image preview.
import type { Raster } from '../../core/raster';
import { h } from '../dom';
import { dialog } from '../widgets';

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function row(...children: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'field-row' }, ...children);
}

export function numInput(value: number, min: number, max: number, step = 1, width = 90): HTMLInputElement {
  const el = h('input', { class: 'input', type: 'number', min, max, step, value: String(value) }) as HTMLInputElement;
  el.style.width = `${width}px`;
  return el;
}

/** The number in a box, kept inside its limits. */
export function numValue(el: HTMLInputElement, fallback: number): number {
  const v = Number(el.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(Number(el.min), Math.min(Number(el.max), v));
}

export function select<T extends string>(options: [T, string][], value: T, width?: number): HTMLSelectElement {
  const el = h('select', { class: 'input' }, ...options.map(([v, label]) => h('option', { value: v }, label))) as HTMLSelectElement;
  el.value = value;
  if (width) el.style.width = `${width}px`;
  return el;
}

export function checkbox(label: string, value: boolean, onChange?: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return { el: h('label', { class: 'check' }, input, h('span', null, label)), input };
}

/** Asks for one number. */
export async function numberDialog(title: string, label: string, value: number, min: number, max: number, unit = ''): Promise<number | null> {
  const input = numInput(value, min, max);
  const body = h('div', null, field(label, h('span', { class: 'field-inline' }, input, unit ? h('span', { class: 'hint' }, unit) : null)));
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  const ok = await dialog(title, body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  return ok ? numValue(input, value) : null;
}

/** A canvas showing a raster, scaled to fit a box (crisp pixels when enlarged). */
export function rasterPreview(r: Raster, maxW: number, maxH: number): HTMLCanvasElement {
  const c = h('canvas', { class: 'raster-preview' }) as HTMLCanvasElement;
  c.width = r.width;
  c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  const s = Math.min(maxW / r.width, maxH / r.height);
  const scale = s >= 1 ? Math.max(1, Math.floor(s)) : s;
  c.style.width = `${Math.max(1, Math.round(r.width * scale))}px`;
  c.style.height = `${Math.max(1, Math.round(r.height * scale))}px`;
  return c;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Runs heavy work after the browser has painted (so "Working…" shows first). */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}
