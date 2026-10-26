// The Navigator panel: the whole image small, with a frame around the part on screen. Drag the frame
// to move around; the slider zooms.
import * as L from 'lucide';
import { ZOOMS } from '../canvas/CanvasView';
import type { App } from '../app';
import { h, icon } from '../dom';
import { tooltip } from '../widgets';

export class NavigatorPanel {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private zoom: HTMLInputElement;
  private label: HTMLElement;
  private queued = false;
  private mode: HTMLSelectElement;
  /** Where the image is drawn in the panel (CSS px) and at what scale. */
  private fit = { x: 0, y: 0, s: 1 };

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'nav-canvas' }) as HTMLCanvasElement;
    this.zoom = h('input', { type: 'range', class: 'ctl-range nav-zoom', min: 0, max: 1000, 'aria-label': 'Zoom' }) as HTMLInputElement;
    this.label = h('span', { class: 'nav-label' });
    const lo = Math.log(ZOOMS[0]);
    const hi = Math.log(ZOOMS[ZOOMS.length - 1]);
    this.zoom.addEventListener('input', () => {
      const z = Math.exp(lo + (Number(this.zoom.value) / 1000) * (hi - lo));
      // Snap near whole numbers so pixel art stays crisp
      const snapped = z > 1 && Math.abs(z - Math.round(z)) < 0.15 ? Math.round(z) : z;
      app.view.setZoom(snapped, { x: app.view.width / 2, y: app.view.height / 2 });
    });
    const out = h('button', { class: 'btn icon-only', 'aria-label': 'Zoom out', onclick: () => app.view.zoomStep(-1) }, icon(L.ZoomOut, 14));
    const inn = h('button', { class: 'btn icon-only', 'aria-label': 'Zoom in', onclick: () => app.view.zoomStep(1) }, icon(L.ZoomIn, 14));
    const fit = h('button', { class: 'btn icon-only', 'aria-label': 'Fit on screen', onclick: () => app.view.fit() }, icon(L.Maximize, 14));
    tooltip(fit, 'Fit on screen', 'Ctrl+0');
    // What the panel shows: the whole image, the image at its real size, or repeated 3×3
    this.mode = h('select', { class: 'input nav-mode', 'aria-label': 'Preview' }, h('option', { value: 'fit' }, 'Whole image'), h('option', { value: 'actual' }, 'Actual size'), h('option', { value: 'tiled' }, 'Tiled 3×3')) as HTMLSelectElement;
    this.mode.value = app.prefs.navigatorMode ?? 'fit';
    this.mode.addEventListener('change', () => {
      app.prefs.navigatorMode = this.mode.value as 'fit' | 'actual' | 'tiled';
      app.savePrefs();
      this.draw();
    });
    tooltip(this.mode, 'Actual size shows pixels as they’ll really look (a 16×16 texture is tiny); Tiled shows whether a texture repeats without seams');
    this.el = h('div', { class: 'navigator-panel' }, this.canvas, h('div', { class: 'nav-row' }, out, this.zoom, inn, this.label, fit), h('div', { class: 'nav-row' }, this.mode));
    let dragging = false;
    const moveTo = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.fit.x) / this.fit.s;
      const y = (e.clientY - r.top - this.fit.y) / this.fit.s;
      app.view.centreOn(x, y);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!app.doc) return;
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      moveTo(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (dragging) moveTo(e);
    });
    this.canvas.addEventListener('pointerup', () => (dragging = false));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** Redraws on the next frame (pixels or the view changed). */
  draw(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private render(): void {
    const app = this.app;
    const doc = app.doc;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const lo = Math.log(ZOOMS[0]);
    const hi = Math.log(ZOOMS[ZOOMS.length - 1]);
    this.zoom.disabled = !doc;
    if (!doc) {
      this.label.textContent = '';
      return;
    }
    const z = app.view.view.zoom;
    this.zoom.value = String(((Math.log(z) - lo) / (hi - lo)) * 1000);
    this.label.textContent = `${+(z * 100).toFixed(z < 0.1 ? 1 : 0)}%`;
    const mode = this.mode.value;
    if (mode !== 'fit') {
      // A preview, not a map: the image at its real size (or 2× when tiny), or tiled 3×3
      const tiles = mode === 'tiled' ? 3 : 1;
      let k = mode === 'actual' ? 1 : Math.min((cw - 8) / (doc.width * 3), (ch - 8) / (doc.height * 3));
      if (mode === 'actual' && doc.width * 4 <= cw && doc.height * 4 <= ch) k = 2;
      if (k >= 1) k = Math.floor(k);
      const tw = doc.width * k;
      const th = doc.height * k;
      const ox = Math.round((cw - tw * tiles) / 2);
      const oy = Math.round((ch - th * tiles) / 2);
      g.imageSmoothingEnabled = k < 1;
      const src = this.app.view.composited;
      for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) g.drawImage(src, ox + tx * tw, oy + ty * th, tw, th);
      this.fit = { x: ox + (tiles === 3 ? tw : 0), y: oy + (tiles === 3 ? th : 0), s: k };
      return;
    }
    const pad = 6;
    const s = Math.min((cw - pad * 2) / doc.width, (ch - pad * 2) / doc.height);
    const w = doc.width * s;
    const hh = doc.height * s;
    this.fit = { x: (cw - w) / 2, y: (ch - hh) / 2, s };
    const { x, y } = this.fit;
    // Checkerboard, then the image
    g.save();
    g.beginPath();
    g.rect(x, y, w, hh);
    g.clip();
    const sq = 5;
    for (let yy = Math.floor(y); yy < y + hh; yy += sq)
      for (let xx = Math.floor(x); xx < x + w; xx += sq) {
        g.fillStyle = ((xx - Math.floor(x) + yy - Math.floor(y)) / sq) % 2 ? '#d5d8de' : '#f5f6f8';
        g.fillRect(xx, yy, sq, sq);
      }
    g.imageSmoothingEnabled = s < 1;
    g.imageSmoothingQuality = 'high';
    g.drawImage(app.view.composited, x, y, w, hh);
    g.restore();
    // The part on screen
    const v = app.view.visibleRect();
    const rx = x + v.x * s;
    const ry = y + v.y * s;
    const rw = v.w * s;
    const rh = v.h * s;
    if (v.x > 0 || v.y > 0 || v.x + v.w < doc.width || v.y + v.h < doc.height) {
      g.lineWidth = 2;
      g.strokeStyle = getComputedStyle(this.el).getPropertyValue('--accent').trim() || '#a98bff';
      g.strokeRect(Math.round(rx) + 1, Math.round(ry) + 1, Math.max(4, Math.round(rw) - 2), Math.max(4, Math.round(rh) - 2));
    }
  }
}
