// The panel column on the right: Navigator, Color, Swatches, Layers and History. Each folds closed
// from its header; the column's width is dragged from its left edge.
import * as L from 'lucide';
import type { Layer } from '../../core/layer';
import type { App } from '../app';
import { h, icon } from '../dom';
import { AnimationPanel } from './animation';
import { ColorPanel } from './color';
import { HistoryPanel } from './history';
import { LayersPanel } from './layers';
import { NavigatorPanel } from './navigator';
import { SwatchesPanel } from './swatches';

export class Panels {
  readonly el: HTMLElement;
  readonly navigator: NavigatorPanel;
  readonly color: ColorPanel;
  readonly swatches: SwatchesPanel;
  readonly layers: LayersPanel;
  readonly history: HistoryPanel;
  readonly animation: AnimationPanel;
  private sections = new Map<string, HTMLElement>();

  constructor(private app: App) {
    this.navigator = new NavigatorPanel(app);
    this.color = new ColorPanel(app);
    this.swatches = new SwatchesPanel(app);
    this.layers = new LayersPanel(app);
    this.history = new HistoryPanel(app);
    this.animation = new AnimationPanel(app);
    // Panels added in an update start at their default: open or folded
    const DEFAULT_FOLDED = ['navigator', 'history', 'animation'];
    for (const id of ['navigator', 'color', 'swatches', 'layers', 'animation', 'history']) {
      if (app.prefs.panelsKnown.includes(id)) continue;
      app.prefs.panelsKnown.push(id);
      if (DEFAULT_FOLDED.includes(id) && !app.prefs.collapsed.includes(id)) app.prefs.collapsed.push(id);
    }
    app.savePrefs();
    const grip = h('div', { class: 'panels-grip', 'aria-hidden': 'true' });
    this.el = h(
      'aside',
      { class: 'panels' },
      grip,
      h(
        'div',
        { class: 'panels-scroll' },
        this.section('navigator', 'Navigator', L.Compass, this.navigator.el),
        this.section('color', 'Color', L.Palette, this.color.el),
        this.section('swatches', 'Swatches', L.SwatchBook, this.swatches.el),
        this.section('layers', 'Layers', L.Layers, this.layers.el, true),
        this.section('animation', 'Animation', L.Film, this.animation.el),
        this.section('history', 'History', L.History, this.history.el),
      ),
    );
    this.el.style.width = `${app.prefs.panelWidth}px`;
    grip.addEventListener('pointerdown', (e) => {
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.el.offsetWidth;
      const move = (ev: PointerEvent) => {
        const w = Math.max(220, Math.min(520, startW + (startX - ev.clientX)));
        this.el.style.width = `${w}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        app.prefs.panelWidth = this.el.offsetWidth;
        app.savePrefs();
        this.navigator.draw();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  private section(id: string, title: string, ic: L.IconNode, body: HTMLElement, grow = false): HTMLElement {
    const collapsed = this.app.prefs.collapsed.includes(id);
    const head = h('button', { class: 'panel-head', 'aria-expanded': collapsed ? 'false' : 'true' }, icon(L.ChevronDown, 14, 'caret'), icon(ic, 14), h('span', null, title));
    const sec = h('section', { class: `panel panel-${id}${collapsed ? ' collapsed' : ''}${grow ? ' grow' : ''}` }, head, h('div', { class: 'panel-body' }, body));
    head.addEventListener('click', () => {
      const now = !sec.classList.contains('collapsed');
      sec.classList.toggle('collapsed', now);
      head.setAttribute('aria-expanded', now ? 'false' : 'true');
      const set = new Set(this.app.prefs.collapsed);
      if (now) set.add(id);
      else set.delete(id);
      this.app.prefs.collapsed = [...set];
      this.app.savePrefs();
      this.animation.visible = this.open('animation');
      if (!now) this.refresh();
    });
    this.sections.set(id, sec);
    return sec;
  }

  private open(id: string): boolean {
    return !this.sections.get(id)?.classList.contains('collapsed') && !this.el.hidden;
  }

  refresh(): void {
    this.color.refresh();
    this.swatches.render();
    this.layers.render();
    this.history.render();
    this.navigator.draw();
    this.animation.visible = this.open('animation');
    this.animation.render();
  }

  /** The image size or animation settings changed. */
  sizeChanged(): void {
    this.animation.visible = this.open('animation');
    this.animation.render();
  }

  colorsChanged(): void {
    if (this.open('color')) this.color.refresh();
  }

  pixelsChanged(layer: Layer): void {
    this.layers.pixelsChanged(layer);
    if (this.open('navigator')) this.navigator.draw();
  }

  layersChanged(): void {
    this.layers.render();
    if (this.open('navigator')) this.navigator.draw();
  }

  viewChanged(): void {
    if (this.open('navigator')) this.navigator.draw();
  }

  historyChanged(): void {
    if (this.open('history')) this.history.render();
    if (this.open('swatches')) this.swatches.imageChanged();
  }
}
