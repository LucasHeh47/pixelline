// The start page: new images from size presets (Minecraft textures, sprites, icons, photos), recent
// files, and the file actions. Shown when Pixelline starts and from the logo.
import * as L from 'lucide';
import type { RecentFile, RecoveredImage } from '../shared/api';
import type { App } from './app';
import { createImage, openNewImage, PRESET_GROUPS, type SizePreset } from './dialogs/newImage';
import { h, icon } from './dom';
import { isDesktop, platform } from './platform';
import { showMenu, toast, tooltip } from './widgets';

export type HomeSection = 'home' | 'new' | 'open';

const FEATURED: [group: string, name: string][] = [
  ['Minecraft', 'Block or item'],
  ['Minecraft', 'Block or item (32×)'],
  ['Minecraft', 'Player skin'],
  ['Pixel art', 'Character'],
  ['Icons', 'Icon 256'],
  ['Photo & screen', 'Full HD 1920×1080'],
];

function relativeTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const mins = Math.round((now.getTime() - ms) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
  const days = (now.getTime() - ms) / 86400000;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function folderOf(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  if (parts.length <= 2) return parts.join('\\');
  return '…\\' + parts.slice(-2).join('\\');
}

/** Short tips on the start page (one set is shown each time). */
const TIPS: { icon: L.IconNode; title: string; text: string }[] = [
  { icon: L.Grid2x2, title: 'Seamless textures', text: 'Press Shift+T to see the image tiled around itself. Painting wraps around the edges, so block textures never show a seam.' },
  { icon: L.Blend, title: 'Shade in one stroke', text: 'Set the pencil’s Ink to Shade: each pixel you paint gets a darker shade of itself (right-click for lighter), hue-shifted like hand-made pixel art.' },
  { icon: L.Film, title: 'Animated textures', text: 'Open the Animation panel to play a strip of frames, use onion skin, and save the .png.mcmeta automatically with the PNG.' },
  { icon: L.FolderCog, title: 'A whole folder at once', text: 'File → Batch process resizes, upscales, recolours or converts every image in a folder, subfolders too (a whole resource pack).' },
  { icon: L.Search, title: 'Find any command', text: 'Press Ctrl+K and type what you want: "blur", "outline", "palette", "export"…' },
  { icon: L.Pipette, title: 'Colours from anywhere', text: 'The pipette in the Color panel picks a colour from anywhere on screen, even other apps.' },
];

function greeting(): string {
  const hr = new Date().getHours();
  return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

export class HomeView {
  readonly el: HTMLElement;
  private main: HTMLElement;
  private nav: HTMLElement;
  private section: HomeSection;
  private recent: RecentFile[] = [];
  private recovered: RecoveredImage[] = [];
  private filter = '';
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .popover')) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(
    private app: App,
    section: HomeSection,
    private onClosed: () => void,
  ) {
    this.section = section;
    this.nav = h('nav', { class: 'home-nav' });
    this.main = h('main', { class: 'home-main' });
    const close = h('button', { class: 'btn home-close', 'aria-label': 'Close the start page', onclick: () => this.close() }, icon(L.X, 18));
    tooltip(close, app.tabs.length ? 'Back to the image' : 'Close', 'Esc');
    this.el = h('div', { class: 'home-view', role: 'dialog', 'aria-label': 'Start page' }, h('aside', { class: 'home-rail' }, this.nav), h('div', { class: 'home-body' }, h('div', { class: 'home-top' }, h('div', { class: 'spacer' }), close), this.main));
    document.addEventListener('keydown', this.onKey, true);
    this.renderNav();
    this.render();
    void this.loadRecent();
  }

  close(): void {
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.onClosed();
  }

  show(section: HomeSection): void {
    this.section = section;
    this.renderNav();
    this.render();
    void this.loadRecent();
  }

  private async loadRecent(): Promise<void> {
    this.recent = await platform.recentFiles();
    this.recovered = await platform.recovery.list();
    this.render();
  }

  private renderNav(): void {
    const app = this.app;
    const brand = h('div', { class: 'home-brand' }, h('span', { class: 'brand-mark' }, icon(L.Shapes, 16)), 'Pixelline');
    const item = (id: HomeSection, label: string, ic: L.IconNode) => h('button', { class: `home-nav-item${this.section === id ? ' on' : ''}`, onclick: () => this.show(id) }, icon(ic, 18), label);
    const action = (label: string, ic: L.IconNode, run: () => unknown, disabled = false) => {
      const b = h('button', { class: 'home-nav-item', onclick: () => {
        this.close();
        void run();
      } }, icon(ic, 18), label) as HTMLButtonElement;
      b.disabled = disabled;
      return b;
    };
    const has = !!app.doc;
    this.nav.replaceChildren(
      ...[
        brand,
        item('home', 'Home', L.House),
        item('new', 'New', L.FilePlus),
        item('open', 'Open', L.FolderOpen),
        h('div', { class: 'home-nav-sep' }),
        action('Save', L.Save, () => app.commands.run('file.save'), !has),
        action('Save as', L.SaveAll, () => app.commands.run('file.saveAs'), !has),
        action('Export as', L.Download, () => app.commands.run('file.export'), !has),
        h('div', { class: 'spacer' }),
        action('Settings', L.Settings, () => app.openSettings()),
        action('About', L.Info, () => app.commands.run('help.about')),
      ],
    );
  }

  private render(): void {
    const scroll = this.main.scrollTop;
    this.main.replaceChildren();
    if (this.section === 'home') this.renderHome();
    else if (this.section === 'new') this.renderNew();
    else this.renderOpen();
    this.main.scrollTop = scroll;
  }

  private renderHome(): void {
    this.main.append(h('h1', { class: 'home-h1' }, greeting()));
    const strip = h('div', { class: 'size-strip' }, this.customCard());
    for (const [g, name] of FEATURED) {
      const p = PRESET_GROUPS.find((x) => x.name === g)?.presets.find((x) => x.name === name);
      if (p) strip.append(this.presetCard(p));
    }
    if (this.recovered.length) this.main.append(this.recoveryBlock());
    this.main.append(
      h('div', { class: 'home-row-head' }, h('h2', null, 'Start something new'), h('button', { class: 'btn text home-link', onclick: () => this.show('new') }, 'More sizes', icon(L.ArrowRight, 14))),
      strip,
      this.recentBlock(false),
      this.tipsBlock(),
    );
  }

  /** Images with unsaved changes from a session that ended unexpectedly. */
  private recoveryBlock(): HTMLElement {
    const list = h('div', { class: 'recover-list' });
    for (const r of this.recovered) {
      const when = relativeTime(r.savedAt);
      list.append(
        h(
          'div',
          { class: 'recover-row' },
          icon(L.LifeBuoy, 18),
          h('span', { class: 'name' }, r.name, h('span', { class: 'hint' }, ` · ${r.width} × ${r.height} · ${when}`)),
          h('button', { class: 'btn primary small', onclick: () => {
            this.close();
            void this.app.restoreRecovered(r.id, r.name, r.filePath);
          } }, 'Recover'),
          h('button', { class: 'btn outline small', onclick: async () => {
            await platform.recovery.remove(r.id);
            this.recovered = this.recovered.filter((x) => x !== r);
            this.render();
          } }, 'Discard'),
        ),
      );
    }
    return h('section', { class: 'home-recover' }, h('h2', null, 'Unsaved work from last time'), h('p', { class: 'hint' }, 'Pixelline closed before these were saved. Recover them to keep working, or discard them.'), list);
  }

  private tipsBlock(): HTMLElement {
    // Three tips, a different set each day
    const start = Math.floor(Date.now() / 86_400_000) % TIPS.length;
    const tips = [0, 1, 2].map((i) => TIPS[(start + i) % TIPS.length]);
    return h(
      'section',
      { class: 'home-tips' },
      h('h2', null, 'Tips'),
      h('div', { class: 'tips-grid' }, ...tips.map((t) => h('div', { class: 'tip-card' }, h('div', { class: 'tip-icon' }, icon(t.icon, 18)), h('div', null, h('div', { class: 'tip-title' }, t.title), h('div', { class: 'tip-text' }, t.text))))),
    );
  }

  private renderNew(): void {
    this.main.append(h('h1', { class: 'home-h1' }, 'New image'));
    const top = h('div', { class: 'size-strip' }, this.customCard());
    const clip = h('button', { class: 'size-card', onclick: () => {
      this.close();
      void this.app.pasteAsNew();
    } }, h('div', { class: 'size-thumb blank' }, icon(L.ClipboardPaste, 26)), h('div', { class: 'size-meta' }, h('div', { class: 'size-title' }, 'From clipboard'), h('div', { class: 'size-sub' }, 'A copied picture')));
    top.append(clip);
    this.main.append(top);
    for (const g of PRESET_GROUPS) {
      this.main.append(h('h2', { class: 'home-cat' }, icon(g.icon, 16), g.name));
      this.main.append(h('div', { class: 'size-grid' }, ...g.presets.map((p) => this.presetCard(p))));
    }
  }

  private renderOpen(): void {
    this.main.append(h('h1', { class: 'home-h1' }, 'Open'));
    const browse = h('button', { class: 'btn primary', onclick: () => {
      this.close();
      void this.app.openFile();
    } }, icon(L.FolderOpen, 16), 'Browse…');
    this.main.append(h('div', { class: 'home-open-actions' }, browse, h('span', { class: 'hint' }, 'PNG, JPEG, WebP, GIF, BMP, OpenRaster (.ora) and Photoshop (.psd). You can also drag files onto the window.')));
    this.main.append(this.recentBlock(true));
  }

  private customCard(): HTMLElement {
    const card = h('button', { class: 'size-card', onclick: () => {
      this.close();
      void openNewImage(this.app);
    } }, h('div', { class: 'size-thumb blank' }, icon(L.Plus, 28)), h('div', { class: 'size-meta' }, h('div', { class: 'size-title' }, 'Custom size…'), h('div', { class: 'size-sub' }, 'Any width and height')));
    tooltip(card, 'Choose a size', 'Ctrl+N');
    return card;
  }

  private presetCard(p: SizePreset): HTMLElement {
    // A proportional frame showing the shape of the image
    const max = 64;
    const s = Math.min(max / p.w, max / p.h);
    const frame = h('span', { class: `size-frame${p.bg === 'transparent' ? ' transparent' : ''}`, style: { width: `${Math.max(8, Math.round(p.w * s))}px`, height: `${Math.max(8, Math.round(p.h * s))}px` } });
    if (p.w <= 64 && p.h <= 64) frame.classList.add('pixel');
    const card = h('button', { class: 'size-card', onclick: () => {
      this.close();
      createImage(this.app, p.w, p.h, p.bg ?? 'white', p.name.replace(/ \(.*\)$/, ''));
    } }, h('div', { class: 'size-thumb' }, frame), h('div', { class: 'size-meta' }, h('div', { class: 'size-title' }, p.name), h('div', { class: 'size-sub' }, `${p.w} × ${p.h}${p.hint ? ` · ${p.hint}` : ''}`)));
    return card;
  }

  private recentBlock(full: boolean): HTMLElement {
    const wrap = h('section', { class: 'home-recent' });
    const search = h('input', { class: 'input home-search', type: 'search', placeholder: 'Search recent files', value: this.filter, 'aria-label': 'Search recent files' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.filter = search.value;
      const pos = search.selectionStart;
      this.render();
      const again = this.main.querySelector('.home-search') as HTMLInputElement | null;
      again?.focus();
      again?.setSelectionRange(pos, pos);
    });
    wrap.append(h('div', { class: 'home-row-head' }, h('h2', null, 'Recent'), h('div', { class: 'spacer' }), search));
    const q = this.filter.trim().toLowerCase();
    const pinned = this.recent.filter((r) => r.pinned);
    let list = [...pinned, ...this.recent.filter((r) => !r.pinned)];
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    if (!full && !q) list = list.slice(0, 12);
    if (!list.length) {
      const msg = q ? `No recent files match "${this.filter}".` : isDesktop ? 'Images you open or save will show up here.' : 'Recent files are listed in the desktop app.';
      wrap.append(h('div', { class: 'home-empty' }, icon(L.Clock, 26), h('p', null, msg)));
      return wrap;
    }
    const table = h('div', { class: 'recent-list', role: 'list' });
    table.append(h('div', { class: 'recent-row head' }, h('span'), h('span', null, 'Name'), h('span', null, 'Location'), h('span', null, 'Opened'), h('span')));
    for (const r of list) table.append(this.recentRow(r));
    wrap.append(table);
    return wrap;
  }

  private recentRow(r: RecentFile): HTMLElement {
    const ext = (/\.([^.]+)$/.exec(r.name)?.[1] ?? '').toLowerCase();
    const pin = h('button', { class: `btn icon-only${r.pinned ? ' on' : ''}`, 'aria-label': r.pinned ? 'Unpin' : 'Pin to the top', onclick: (e: MouseEvent) => {
      e.stopPropagation();
      void platform.pinRecentFile(r.path, !r.pinned).then(() => this.loadRecent());
    } }, icon(r.pinned ? L.PinOff : L.Pin, 15));
    tooltip(pin, r.pinned ? 'Unpin' : 'Pin to the top');
    const more = h('button', { class: 'btn icon-only', 'aria-label': 'More', onclick: (e: MouseEvent) => {
      e.stopPropagation();
      showMenu(
        [
          { label: 'Open', icon: L.FolderOpen, run: () => this.openRecent(r) },
          { label: 'Open in a new window', icon: L.AppWindow, run: () => platform.newWindow(r.path) },
          { label: 'Show in folder', icon: L.FolderSearch, run: () => platform.showInFolder(r.path) },
          { label: 'Copy path', icon: L.Copy, run: () => void platform.writeClipboardText(r.path).then(() => toast('Copied the file path.')) },
          { separator: true },
          { label: 'Remove from list', icon: L.X, run: () => void platform.removeRecentFile(r.path).then(() => this.loadRecent()) },
        ],
        e.currentTarget as HTMLElement,
      );
    } }, icon(L.Ellipsis, 15));
    const layered = ext === 'ora' || ext === 'psd';
    const row = h(
      'div',
      { class: 'recent-row', role: 'listitem', tabindex: '0', title: r.path },
      h('span', { class: `file-icon ${ext}` }, icon(layered ? L.Layers : L.FileImage, 18)),
      h('span', { class: 'name' }, r.name, r.pinned ? h('span', { class: 'pinned-mark', title: 'Pinned' }, icon(L.Pin, 12)) : null),
      h('span', { class: 'loc' }, folderOf(r.path)),
      h('span', { class: 'when' }, relativeTime(r.openedAt)),
      h('span', { class: 'acts' }, pin, more),
    );
    row.addEventListener('click', () => this.openRecent(r));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.openRecent(r);
    });
    return row;
  }

  private openRecent(r: RecentFile): void {
    this.close();
    void this.app.openRecent(r.path);
  }
}
