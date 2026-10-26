// Image tabs above the canvas: several images open in one window. Click to switch, middle-click or ×
// to close, drag to reorder, right-click for more. Each tab shows a small thumbnail.
import * as L from 'lucide';
import type { App, DocTab } from './app';
import { h, icon, scrollToChild } from './dom';
import { isDesktop, platform } from './platform';
import { showMenu, toast, tooltip, type MenuItem } from './widgets';

export class DocTabs {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private dragId: number | null = null;

  constructor(private app: App) {
    this.list = h('div', { class: 'doc-tabs-list', role: 'tablist', 'aria-label': 'Open images' });
    const add = h('button', { class: 'btn doc-tab-new', 'aria-label': 'New image', onclick: () => app.commands.run('file.new') }, icon(L.Plus, 15));
    tooltip(add, 'New image', 'Ctrl+N');
    this.el = h('div', { class: 'doc-tabs' }, this.list, add);
    this.list.addEventListener(
      'wheel',
      (e) => {
        if (this.list.scrollWidth <= this.list.clientWidth) return;
        e.preventDefault();
        this.list.scrollLeft += e.deltaY || e.deltaX;
      },
      { passive: false },
    );
    this.list.addEventListener('dblclick', (e) => {
      if (e.target === this.list) app.commands.run('file.new');
    });
  }

  render(): void {
    const app = this.app;
    this.el.hidden = !app.tabs.length;
    this.list.replaceChildren(
      ...app.tabs.map((t) => {
        const d = t.doc;
        const on = t === app.tab;
        const close = h('button', { class: 'doc-tab-close', 'aria-label': `Close ${d.name}`, tabindex: '-1', onclick: (e: Event) => {
          e.stopPropagation();
          void app.closeTab(t);
        } }, icon(L.X, 13));
        const el = h(
          'div',
          {
            class: `doc-tab${on ? ' on' : ''}${d.dirty ? ' dirty' : ''}`,
            role: 'tab',
            'aria-selected': on ? 'true' : 'false',
            draggable: 'true',
            title: `${d.filePath ?? d.name} — ${d.width} × ${d.height}${d.dirty ? ' — unsaved changes' : ''}`,
          },
          h('span', { class: 'doc-tab-name' }, d.name),
          h('span', { class: 'doc-tab-size' }, `${d.width}×${d.height}`),
          h('span', { class: 'doc-tab-dot', 'aria-hidden': 'true' }),
          close,
        );
        el.addEventListener('mousedown', (e) => {
          if (e.button === 1) e.preventDefault();
        });
        el.addEventListener('click', () => app.switchTab(t));
        el.addEventListener('auxclick', (e) => {
          if (e.button === 1) void app.closeTab(t);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.menu(t, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
        });
        el.addEventListener('dragstart', (e) => {
          this.dragId = t.id;
          e.dataTransfer?.setData('text/x-pixelline-tab', String(t.id));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
          this.dragId = null;
          this.list.querySelectorAll('.drop-left, .drop-right').forEach((x) => x.classList.remove('drop-left', 'drop-right'));
        });
        el.addEventListener('dragover', (e) => {
          if (this.dragId === null || this.dragId === t.id) return;
          e.preventDefault();
          const r = el.getBoundingClientRect();
          const left = e.clientX < r.left + r.width / 2;
          el.classList.toggle('drop-left', left);
          el.classList.toggle('drop-right', !left);
        });
        el.addEventListener('dragleave', () => el.classList.remove('drop-left', 'drop-right'));
        el.addEventListener('drop', (e) => {
          if (this.dragId === null) return;
          e.preventDefault();
          e.stopPropagation();
          const from = app.tabs.findIndex((b) => b.id === this.dragId);
          const r = el.getBoundingClientRect();
          let to = app.tabs.indexOf(t) + (e.clientX < r.left + r.width / 2 ? 0 : 1);
          if (from < to) to--;
          app.moveTab(from, to);
        });
        return el;
      }),
    );
    scrollToChild(this.list, this.list.querySelector<HTMLElement>('.doc-tab.on'), true);
  }

  private menu(t: DocTab, at: { left: number; top: number; right: number; bottom: number }): void {
    const app = this.app;
    const i = app.tabs.indexOf(t);
    const path = t.doc.filePath;
    const items: MenuItem[] = [
      { label: 'New image…', icon: L.Plus, hint: 'Ctrl+N', run: () => app.commands.run('file.new') },
      { separator: true },
      { label: 'Close', icon: L.X, hint: 'Ctrl+W', run: () => void app.closeTab(t) },
      { label: 'Close other images', disabled: app.tabs.length < 2, run: () => void app.closeTabs(app.tabs.filter((b) => b !== t)) },
      { label: 'Close images to the right', disabled: i === app.tabs.length - 1, run: () => void app.closeTabs(app.tabs.slice(i + 1)) },
    ];
    if (path && isDesktop) {
      items.push(
        { separator: true },
        { label: 'Show in folder', icon: L.FolderOpen, run: () => platform.showInFolder(path) },
        {
          label: 'Copy file path',
          icon: L.Copy,
          run: () => {
            void platform.writeClipboardText(path);
            toast('File path copied.');
          },
        },
      );
    }
    showMenu(items, at);
  }
}
