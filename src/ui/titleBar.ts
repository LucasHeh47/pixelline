// The top bar: Pixelline logo, the menus (File, Edit, Image…), command search and theme button.
// Menus are built from commands each time they open, so checks and disabled items are current.
import * as L from 'lucide';
import { FILTERS } from '../core/filters';
import type { App } from './app';
import { h, icon, kbd } from './dom';
import { openPalette } from './palette';
import { suiteButton } from './suiteMenu';
import { isDesktop, platform } from './platform';
import { showMenu, tooltip, type MenuItem, type Popover } from './widgets';

type MenuSpec = (string | '-' | { label: string; icon?: L.IconNode; items: () => MenuSpec })[];

export class TitleBar {
  readonly el: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private menus: { label: string; spec: () => MenuSpec; btn?: HTMLButtonElement }[];
  private open: { index: number; pop: Popover } | null = null;

  constructor(private app: App) {
    this.el = h('header', { class: 'titlebar' });
    this.menus = [
      { label: 'File', spec: () => ['file.new', 'file.newFromClipboard', 'file.open', 'file.place', '-', 'file.save', 'file.saveAs', 'file.export', 'file.exportTiles', 'file.revert', '-', 'file.batch', '-', 'file.close', 'file.closeAll', '-', 'file.showInFolder', 'file.newWindow', 'file.home', '-', 'app.settings'] },
      {
        label: 'Edit',
        spec: () => [
          'edit.undo',
          'edit.redo',
          '-',
          'edit.cut',
          'edit.copy',
          'edit.copyMerged',
          'edit.paste',
          'edit.pasteInPlace',
          'edit.clear',
          '-',
          'edit.fillFg',
          'edit.fillBg',
          'edit.replaceColor',
          '-',
          'edit.transform',
          { label: 'Transform layer', icon: L.RotateCw, items: () => ['layer.flipH', 'layer.flipV', '-', 'layer.rot90', 'layer.rot270', 'layer.rot180'] },
          '-',
          'color.swap',
          'color.reset',
          '-',
          'app.settings',
        ],
      },
      {
        label: 'Image',
        spec: () => [
          { label: 'Adjustments', icon: L.SlidersHorizontal, items: () => FILTERS.filter((f) => f.group === 'Adjustments').map((f) => `filter.${f.id}`) },
          '-',
          'image.size',
          'image.canvasSize',
          'image.canvasMinecraft',
          '-',
          'image.crop',
          'image.trim',
          'image.revealAll',
          '-',
          { label: 'Rotate & flip', icon: L.RotateCw, items: () => ['image.rot90', 'image.rot270', 'image.rot180', '-', 'image.flipH', 'image.flipV'] },
          '-',
          'image.reduceColors',
          'image.pixelArt',
          'image.upscale',
          '-',
          'image.tileGrid',
          'image.duplicate',
        ],
      },
      {
        label: 'Layer',
        spec: () => [
          'layer.new',
          'layer.duplicate',
          'layer.cut',
          'layer.delete',
          '-',
          'layer.props',
          'layer.lock',
          'layer.alphaLock',
          '-',
          { label: 'Arrange', icon: L.Layers, items: () => ['layer.top', 'layer.up', 'layer.down', 'layer.bottom'] },
          '-',
          'layer.mergeDown',
          'layer.mergeVisible',
          'layer.toImage',
          'layer.flatten',
          '-',
          'layer.trim',
        ],
      },
      { label: 'Select', spec: () => ['select.all', 'select.none', 'select.reselect', 'select.invert', '-', 'select.layer', '-', 'select.grow', 'select.shrink', 'select.feather'] },
      {
        label: 'Filter',
        spec: () => {
          const groups = [...new Set(FILTERS.filter((f) => f.group !== 'Adjustments').map((f) => f.group))];
          return [
            'filter.repeat',
            'filter.repeatOptions',
            '-',
            ...groups.map((g) => ({ label: g, items: () => FILTERS.filter((f) => f.group === g).map((f) => `filter.${f.id}`) })),
          ];
        },
      },
      {
        label: 'View',
        spec: () => ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.pixelGrid', 'view.tileGrid', 'view.snap', 'view.tileMode', '-', 'view.mirrorX', 'view.mirrorY', '-', 'view.panels', 'view.theme', 'view.fullscreen'],
      },
      { label: 'Help', spec: () => ['help.palette', 'help.shortcuts', '-', 'help.whatsNew', 'help.updates', '-', 'help.about'] },
    ];
    this.rebuild();
    app.commands.onRefresh(() => this.refresh());
  }

  rebuild(): void {
    const app = this.app;
    const s = app.settings;
    const brand = h('button', { class: 'brand', 'aria-label': 'Pixelline start page', onclick: () => app.openHome('home') }, h('span', { class: 'brand-mark' }, icon(L.Shapes, 14)), 'Pixelline');
    tooltip(brand, 'Start page: new, open and recent images');
    const bar = h('nav', { class: 'menubar', role: 'menubar' });
    this.menus.forEach((m, i) => {
      const b = h('button', { class: 'menubar-item', role: 'menuitem', 'aria-haspopup': 'menu', onclick: () => this.openMenu(i) }, m.label) as HTMLButtonElement;
      // Moving across the bar with a menu open switches menus, like a desktop app
      b.addEventListener('mouseenter', () => {
        if (this.open && this.open.index !== i && this.open.pop.isOpen) this.openMenu(i);
      });
      m.btn = b;
      bar.append(b);
    });
    this.undoBtn = h('button', { class: 'btn', 'aria-label': 'Undo', onclick: () => app.commands.run('edit.undo') }, icon(L.Undo2, 16)) as HTMLButtonElement;
    tooltip(this.undoBtn, 'Undo', 'Ctrl+Z');
    this.redoBtn = h('button', { class: 'btn', 'aria-label': 'Redo', onclick: () => app.commands.run('edit.redo') }, icon(L.Redo2, 16)) as HTMLButtonElement;
    tooltip(this.redoBtn, 'Redo', 'Ctrl+Y');
    const search = s.bool('appearance.showSearch')
      ? h('div', { class: 'cmd-search', role: 'button', tabindex: '0', onclick: () => openPalette(app) }, icon(L.Search, 14), h('span', { class: 'label' }, 'Search commands, tools, filters…'), kbd('Ctrl+K'))
      : null;
    this.themeBtn = h('button', { class: 'btn', 'aria-label': 'Switch light / dark theme', onclick: () => app.commands.run('view.theme') }) as HTMLButtonElement;
    tooltip(this.themeBtn, 'Switch light / dark theme');
    const settings = h('button', { class: 'btn', 'aria-label': 'Settings', onclick: () => app.openSettings() }, icon(L.Settings, 16));
    tooltip(settings, 'Settings', 'Ctrl+,');
    this.el.replaceChildren(
      ...[
        suiteButton(),
        brand,
        bar,
        h('div', { class: 'quick-access' }, this.undoBtn, this.redoBtn),
        h('div', { class: 'spacer' }),
        search ?? h('div', { class: 'spacer' }),
        h('div', { class: 'spacer' }),
        settings,
        this.themeBtn,
        isDesktop && platform.platform !== 'darwin' ? h('div', { class: 'controls-gap' }) : null,
      ].filter((x): x is HTMLElement => !!x),
    );
    this.refresh();
  }

  refresh(): void {
    const app = this.app;
    if (!this.themeBtn) return;
    this.themeBtn.replaceChildren(icon(app.isDark ? L.Sun : L.Moon, 16));
    const d = app.doc;
    this.undoBtn.disabled = !d?.history.canUndo;
    this.redoBtn.disabled = !d?.history.canRedo;
    const where = d ? (app.settings.bool('appearance.titlePath') && d.filePath ? d.filePath : d.name) : '';
    platform.setTitle(d ? `${where}${d.dirty ? ' •' : ''} — Pixelline` : 'Pixelline');
  }

  private openMenu(i: number): void {
    const m = this.menus[i];
    if (!m.btn) return;
    this.open?.pop.close();
    this.menus.forEach((x) => x.btn?.classList.toggle('on', x === m));
    const pop = showMenu(this.items(m.spec()), m.btn, 'below');
    pop.onClose = ((prev) => () => {
      prev?.();
      m.btn?.classList.remove('on');
      if (this.open?.pop === pop) this.open = null;
    })(pop.onClose);
    this.open = { index: i, pop };
    // Left/right arrows move between menus
    pop.el.addEventListener('keydown', (e) => {
      // The menu itself handles arrows that open or close a submenu
      if (e.defaultPrevented || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      e.preventDefault();
      this.openMenu((i + (e.key === 'ArrowRight' ? 1 : -1) + this.menus.length) % this.menus.length);
      this.open?.pop.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });
  }

  private items(spec: MenuSpec): MenuItem[] {
    const app = this.app;
    const out: MenuItem[] = [];
    for (const s of spec) {
      if (s === '-') {
        if (out.length && !('separator' in out[out.length - 1])) out.push({ separator: true });
        continue;
      }
      if (typeof s === 'object') {
        out.push({ label: s.label, icon: s.icon, submenu: () => this.items(s.items()) });
        continue;
      }
      const c = app.commands.get(s);
      if (!c) continue;
      out.push({ label: c.title, icon: c.checked ? undefined : c.icon, checked: c.checked?.(), hint: c.keys?.[0], disabled: !app.commands.isEnabled(c), run: () => app.commands.run(c.id) });
    }
    if (out.length && 'separator' in out[out.length - 1]) out.pop();
    return out;
  }
}
