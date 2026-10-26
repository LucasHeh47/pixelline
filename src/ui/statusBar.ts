// The bottom bar: zoom, image size, pointer position and colour, selection size, tool tips and messages.
import * as L from 'lucide';
import { toHex } from '../core/color';
import type { App } from './app';
import { h, icon } from './dom';
import { showMenu, tooltip } from './widgets';
import { ZOOMS } from './canvas/CanvasView';

export class StatusBar {
  readonly el: HTMLElement;
  private zoom: HTMLInputElement;
  private size: HTMLElement;
  private pos: HTMLElement;
  private color: HTMLElement;
  private sel: HTMLElement;
  private tool: HTMLElement;
  private msg: HTMLElement;
  private progress: HTMLElement;
  private mem: HTMLElement;
  private msgTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private app: App) {
    this.zoom = h('input', { class: 'sb-zoom', 'aria-label': 'Zoom', spellcheck: false }) as HTMLInputElement;
    this.zoom.addEventListener('change', () => {
      const v = parseFloat(this.zoom.value);
      if (Number.isFinite(v) && v > 0) app.view.setZoom(v / 100, undefined, true);
      this.update();
      app.view.el.focus();
    });
    this.zoom.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.update();
        app.view.el.focus();
      }
    });
    const zoomMenu = h('button', { class: 'btn sb-btn', 'aria-label': 'Zoom levels', onclick: (e: MouseEvent) => {
      showMenu(
        [
          { label: 'Fit on screen', hint: 'Ctrl+0', run: () => app.view.fit() },
          { separator: true },
          ...ZOOMS.filter((z) => z >= 0.25)
            .reverse()
            .map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(app.view.view.zoom - z) < 1e-6, run: () => app.view.setZoom(z, undefined, true) })),
        ],
        e.currentTarget as HTMLElement,
        'below',
      );
    } }, icon(L.ChevronUp, 12));
    this.size = h('span', { class: 'sb-item' });
    this.pos = h('span', { class: 'sb-item sb-pos' });
    this.color = h('span', { class: 'sb-item sb-color' });
    this.sel = h('span', { class: 'sb-item' });
    this.tool = h('span', { class: 'sb-tool' });
    this.msg = h('span', { class: 'sb-msg' });
    this.progress = h('span', { class: 'sb-progress', hidden: true });
    this.mem = h('span', { class: 'sb-item sb-mem' });
    tooltip(this.mem, 'Memory used by undo history for this image');
    this.el = h(
      'footer',
      { class: 'statusbar' },
      h('span', { class: 'sb-zoom-wrap' }, this.zoom, zoomMenu),
      this.size,
      this.pos,
      this.color,
      this.sel,
      this.tool,
      h('span', { class: 'spacer' }),
      this.msg,
      this.progress,
      this.mem,
    );
  }

  update(): void {
    const app = this.app;
    const doc = app.doc;
    if (document.activeElement !== this.zoom) this.zoom.value = doc ? `${+(app.view.view.zoom * 100).toFixed(app.view.view.zoom < 0.1 ? 1 : 0)}%` : '';
    this.zoom.disabled = !doc;
    this.size.textContent = doc ? `${doc.width} × ${doc.height}` : '';
    const hv = app.view.hover;
    if (doc && hv) {
      const x = Math.floor(hv.x);
      const y = Math.floor(hv.y);
      const inside = x >= 0 && y >= 0 && x < doc.width && y < doc.height;
      this.pos.textContent = `${x}, ${y}`;
      this.pos.classList.toggle('outside', !inside);
      const c = inside ? app.view.colorAt(x, y) : null;
      this.color.replaceChildren();
      if (c) this.color.append(h('span', { class: 'sb-swatch', style: { background: `rgba(${c.r},${c.g},${c.b},${c.a / 255})` } }), c.a ? `${toHex(c)}${c.a < 255 ? ` · ${Math.round((c.a / 255) * 100)}%` : ''}` : 'Transparent');
    } else {
      this.pos.textContent = '';
      this.color.replaceChildren();
    }
    const s = doc?.selection;
    this.sel.textContent = s ? `Selection ${s.bounds.w} × ${s.bounds.h}` : '';
    this.tool.textContent = doc ? (app.tools.current.status?.() ?? '') : '';
    const bytes = doc?.history.bytes ?? 0;
    this.mem.textContent = doc && bytes > 1024 * 1024 ? `Undo ${(bytes / 1024 / 1024).toFixed(0)} MB` : '';
  }

  /** A short message that goes away by itself. */
  flash(text: string, action?: { label: string; run: () => void }): void {
    clearTimeout(this.msgTimer);
    this.msg.replaceChildren(h('span', null, text));
    if (action) {
      this.msg.append(h('button', { class: 'btn text', onclick: () => {
        action.run();
        this.msg.replaceChildren();
      } }, action.label));
    }
    this.msgTimer = setTimeout(() => this.msg.replaceChildren(), action ? 9000 : 3500);
  }

  setProgress(label: string | null, percent: number): void {
    this.progress.hidden = label === null;
    if (label === null) return;
    this.progress.replaceChildren(h('span', { class: 'spinner' }), `${label} ${Math.round(percent)}%`);
  }
}
