// The tool bar on the left: tools grouped like an image editor's, the primary/secondary colours,
// and quick switches for pixel-art helpers (mirror painting, seamless tiling).
import * as L from 'lucide';
import { cssColor, toHex } from '../core/color';
import type { App } from './app';
import { openColorPicker } from './panels/color';
import { h, icon } from './dom';
import { tooltip } from './widgets';

/** Tools in the order shown, with separators between groups. */
const LAYOUT = ['move', 'marquee', 'lasso', 'wand', 'crop', '-', 'pencil', 'brush', 'eraser', 'clone', '-', 'bucket', 'gradient', 'shape', 'text', '-', 'eyedropper', 'hand', 'zoom'];

export class Toolbar {
  readonly el: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private fg: HTMLButtonElement;
  private bg: HTMLButtonElement;
  private toggles: { key: 'mirrorX' | 'mirrorY' | 'tileMode'; btn: HTMLButtonElement }[] = [];

  constructor(private app: App) {
    const tools = h('div', { class: 'tb-tools', role: 'toolbar', 'aria-label': 'Tools' });
    for (const id of LAYOUT) {
      if (id === '-') {
        tools.append(h('div', { class: 'tb-sep' }));
        continue;
      }
      const t = app.tools.get(id);
      if (!t) continue;
      const b = h('button', { class: 'tb-tool', 'aria-label': t.name, onclick: () => app.selectTool(id) }, icon(t.icon, 18)) as HTMLButtonElement;
      tooltip(b, `${t.name} — ${t.hint}`, t.key);
      this.buttons.set(id, b);
      tools.append(b);
    }
    this.fg = h('button', { class: 'tb-color fg', 'aria-label': 'Primary colour', onclick: () => openColorPicker(app, 'fg', this.fg) }) as HTMLButtonElement;
    this.bg = h('button', { class: 'tb-color bg', 'aria-label': 'Secondary colour', onclick: () => openColorPicker(app, 'bg', this.bg) }) as HTMLButtonElement;
    tooltip(this.fg, () => `Primary colour ${toHex(app.colors.fg)} — click to change. Left-click paints with it.`);
    tooltip(this.bg, () => `Secondary colour ${toHex(app.colors.bg)} — right-click paints with it.`);
    const swap = h('button', { class: 'tb-mini swap', 'aria-label': 'Swap colours', onclick: () => app.swapColors() }, icon(L.ArrowLeftRight, 11));
    tooltip(swap, 'Swap colours', 'X');
    const reset = h('button', { class: 'tb-mini reset', 'aria-label': 'Black and white', onclick: () => app.resetColors() }, h('span', { class: 'mini-bw' }));
    tooltip(reset, 'Default colours (black and white)', 'D');
    const colors = h('div', { class: 'tb-colors' }, this.bg, this.fg, swap, reset);

    const toggle = (key: 'mirrorX' | 'mirrorY' | 'tileMode', ic: L.IconNode, label: string, cmd: string) => {
      const b = h('button', { class: 'tb-tool small', 'aria-label': label, onclick: () => app.commands.run(cmd) }, icon(ic, 15)) as HTMLButtonElement;
      tooltip(b, label, app.commands.get(cmd)?.keys?.[0]);
      this.toggles.push({ key, btn: b });
      return b;
    };
    const helpers = h(
      'div',
      { class: 'tb-helpers' },
      toggle('mirrorX', L.FlipHorizontal2, 'Mirror painting left ↔ right', 'view.mirrorX'),
      toggle('mirrorY', L.FlipVertical2, 'Mirror painting top ↕ bottom', 'view.mirrorY'),
      toggle('tileMode', L.Grid2x2, 'Seamless tile preview (painting wraps around the edges)', 'view.tileMode'),
    );
    this.el = h('aside', { class: 'toolbar' }, tools, h('div', { class: 'spacer' }), helpers, colors);
    this.refresh();
  }

  refresh(): void {
    const cur = this.app.tools.current.id === 'transform' ? 'move' : this.app.tools.current.id;
    for (const [id, b] of this.buttons) b.classList.toggle('on', id === cur);
    for (const t of this.toggles) t.btn.classList.toggle('on', this.app.prefs[t.key]);
    this.refreshColors();
  }

  refreshColors(): void {
    this.fg.style.setProperty('--swatch', cssColor(this.app.colors.fg));
    this.bg.style.setProperty('--swatch', cssColor(this.app.colors.bg));
  }
}
