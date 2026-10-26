// The Pixelline window: open images in tabs, the tool bar, options bar, canvas, panels and status
// bar. Owns the current colours, tool and preferences, and wires document changes to the views.
import { flatten } from '../core/blend';
import { parseHex, toHex, type RGBA } from '../core/color';
import type { DocEvent, ImageDoc } from '../core/document';
import { intersect, isEmpty, type Rect } from '../core/geom';
import { Layer } from '../core/layer';
import { addLayer, documentFromRaster, eraseSelection, fillSelection, nextLayerName } from '../core/ops';
import { decodePng, encodePng } from '../core/io/png';
import { Raster } from '../core/raster';
import type { Params } from '../core/filters';
import type { OpenedFile } from '../shared/api';
import { CanvasView, type ViewState } from './canvas/CanvasView';
import { Commands, eventKey } from './commands';
import { h } from './dom';
import { DocTabs } from './docTabs';
import { baseName, encodeImage, extOf, formatFromExt, lossNote, readImage, type SaveFormat } from './files';
import { HomeView, type HomeSection } from './home';
import { mcmetaText, parseMcmeta } from '../core/animation';
import { readOra, writeOra } from '../core/io/ora';
import { createImage } from './dialogs/newImage';
import { OptionsBar } from './optionsBar';
import { Panels } from './panels/panels';
import { isDesktop, platform } from './platform';
import { SettingsView } from './settings/SettingsView';
import { ACCENTS, SETTINGS } from './settings/schema';
import { Settings, type Refresh } from './settings/store';
import { StatusBar } from './statusBar';
import { TitleBar } from './titleBar';
import { Toolbar } from './toolbar';
import { BucketTool, GradientTool, ShapeTool } from './tools/fill';
import { CropTool, EyedropperTool, HandTool, TextTool, ZoomTool } from './tools/misc';
import { MoveTool, TransformTool } from './tools/move';
import { BrushTool, CloneTool, EraserTool, PencilTool } from './tools/paint';
import { LassoTool, MarqueeTool, WandTool } from './tools/select';
import { ToolManager } from './tools/tool';
import { Updates } from './updates';
import { closePopovers, dialog, setFocusFallback, toast } from './widgets';

/** One open image and what its tab remembers while another one is shown. */
export interface DocTab {
  id: number;
  doc: ImageDoc;
  view: ViewState;
  off: () => void;
  /** Already told that saving as PNG/JPEG flattens the layers. */
  flattenNoted?: boolean;
  /** Its copy in the recovery folder (kept while it has unsaved changes). */
  recoveryId: string;
  /** The history version last copied there. */
  recoveredVersion?: number;
}

export interface Prefs {
  tool: string;
  fg: string;
  bg: string;
  recentColors: string[];
  pixelGrid: boolean;
  tileMode: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  /** Palette shown in the Swatches panel. */
  palette: string;
  userPalettes: { name: string; colors: string[] }[];
  panelWidth: number;
  /** Panels folded closed. */
  collapsed: string[];
  hidePanels: boolean;
  /** Panels whose default (open or folded) has been applied; newer panels start at their default. */
  panelsKnown: string[];
  /** Animation: the previous frame shows faintly over each frame. */
  onionSkin: boolean;
  /** Selections and moves snap to the tile grid. */
  snapToGrid: boolean;
  /** What the Navigator shows. */
  navigatorMode?: 'fit' | 'actual' | 'tiled';
  lastNew: { width: number; height: number; background: string };
  recentCommands: string[];
  /** Last settings used in each filter's dialog. */
  filterParams: Record<string, Params>;
  /** Batch processing choices (dialogs/batch.ts). */
  batch?: object;
  /** Export dialog choices. */
  exportOpts: { format: SaveFormat; scale: number; quality: number };
}

const PREFS_KEY = 'pixelline.prefs';

const DEFAULT_PREFS: Prefs = {
  tool: 'pencil',
  fg: '#000000',
  bg: '#ffffff',
  recentColors: [],
  pixelGrid: true,
  tileMode: false,
  mirrorX: false,
  mirrorY: false,
  palette: 'Minecraft dyes',
  userPalettes: [],
  panelWidth: 288,
  collapsed: ['navigator', 'history'],
  hidePanels: false,
  panelsKnown: [],
  onionSkin: true,
  snapToGrid: false,
  lastNew: { width: 16, height: 16, background: 'transparent' },
  recentCommands: [],
  filterParams: {},
  exportOpts: { format: 'png', scale: 1, quality: 0.92 },
};

const WORKSPACE: Record<string, [string, string]> = {
  dark: ['#0d0f12', '#d9dce2'],
  mid: ['#2a2d33', '#a9aeb7'],
  light: ['#4a4e56', '#eef0f3'],
  black: ['#000000', '#000000'],
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex: string, amt: number): string {
  const to = amt < 0 ? 0 : 255;
  const a = Math.abs(amt);
  return '#' + hexToRgb(hex).map((c) => Math.round(c + (to - c) * a).toString(16).padStart(2, '0')).join('');
}

export function isTyping(t: EventTarget | null = document.activeElement): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t.isContentEditable) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type);
  return t instanceof HTMLSelectElement;
}

let tabSeq = 0;

export class App {
  readonly root: HTMLElement;
  readonly settings = new Settings(SETTINGS);
  prefs: Prefs;
  colors: { fg: RGBA; bg: RGBA };
  readonly tools: ToolManager;
  readonly view: CanvasView;
  readonly commands: Commands;
  readonly statusbar: StatusBar;
  readonly titlebar: TitleBar;
  readonly docTabs: DocTabs;
  readonly toolbar: Toolbar;
  readonly optionsbar: OptionsBar;
  readonly panels: Panels;
  readonly updates: Updates;
  tabs: DocTab[] = [];
  tab: DocTab | null = null;
  /** The tool before the current one (the eyedropper can go back to it). */
  prevTool: string | null = null;
  /** What was last copied here, so pasting can put it back where it came from. */
  clipboard: { raster: Raster; x: number; y: number } | null = null;
  lastFilter: { id: string; params: Params } | null = null;
  /** The selection before the last Deselect (Reselect brings it back). */
  lastSelection = new WeakMap<ImageDoc, import('../core/selection').Mask>();
  private home: HomeView | null = null;
  private settingsView: SettingsView | null = null;
  private systemDark = matchMedia('(prefers-color-scheme: dark)');
  private stage: HTMLElement;
  private empty: HTMLElement;
  private dropZone: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.prefs = this.loadPrefs();
    this.colors = { fg: parseHex(this.prefs.fg) ?? { r: 0, g: 0, b: 0, a: 255 }, bg: parseHex(this.prefs.bg) ?? { r: 255, g: 255, b: 255, a: 255 } };
    this.tools = new ToolManager(
      this,
      [
        new MoveTool(this),
        new MarqueeTool(this),
        new LassoTool(this),
        new WandTool(this),
        new CropTool(this),
        new EyedropperTool(this),
        new PencilTool(this),
        new BrushTool(this),
        new EraserTool(this),
        new CloneTool(this),
        new BucketTool(this),
        new GradientTool(this),
        new ShapeTool(this),
        new TextTool(this),
        new HandTool(this),
        new ZoomTool(this),
        new TransformTool(this),
      ],
      this.prefs.tool === 'transform' ? 'move' : this.prefs.tool,
    );
    this.view = new CanvasView(this);
    this.commands = new Commands(this);
    this.statusbar = new StatusBar(this);
    this.docTabs = new DocTabs(this);
    this.titlebar = new TitleBar(this);
    this.toolbar = new Toolbar(this);
    this.optionsbar = new OptionsBar(this);
    this.panels = new Panels(this);
    this.updates = new Updates(this);

    this.empty = h('div', { class: 'stage-empty' });
    this.stage = h('div', { class: 'stage' }, this.docTabs.el, h('div', { class: 'stage-canvas' }, this.view.el, this.empty));
    root.append(
      this.titlebar.el,
      this.optionsbar.el,
      h('div', { class: 'workarea' }, this.toolbar.el, this.stage, this.panels.el),
      this.statusbar.el,
    );

    for (const d of this.settings.defs) if (d.apply) d.apply(this.settings.get(d.id) as never, this);
    this.settings.onChange((id) => this.onSettingChanged(id));
    this.systemDark.addEventListener('change', () => {
      if (this.settings.str('appearance.theme') === 'system') this.applyTheme();
    });
    this.applyTheme();
    this.applyChrome();
    this.applyHistoryLimits();
    setFocusFallback(() => this.view.el.focus());

    this.tools.onChange(() => {
      this.optionsbar.render();
      this.toolbar.refresh();
      this.view.updateCursor();
      this.view.draw();
      this.statusbar.update();
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      // Alt alone would focus the window menu in some shells; nothing to do here
      if (e.key === 'Alt') e.preventDefault();
    });
    this.setupDrop();
    window.addEventListener('paste', (e) => {
      if (isTyping(e.target) || this.overlayOpen()) return;
      e.preventDefault();
      void this.paste();
    });
    platform.onRequestClose(() => {
      void this.saveBeforeQuit().then((ok) => {
        if (ok) platform.confirmClose();
      });
    });
    platform.onOpenPaths((paths) => void this.openPaths(paths));
    platform.onNewImage((o) => this.newFromOptions(o));
    window.addEventListener('beforeunload', (e) => {
      if (!isDesktop && this.tabs.some((t) => t.doc.dirty)) e.preventDefault();
    });

    this.renderEmpty();
    this.refreshAll();
    // A file opened from Explorer (or a new window for one) arrives as ?file=
    const params = new URLSearchParams(location.search);
    const file = params.get('file');
    if (file) void this.openPaths([file]);
    else if (params.get('new')) this.newFromOptions(Object.fromEntries(params));
    else if (this.settings.bool('files.restore')) this.openHome('home');
    void this.updates.startup();
    this.startRecovery();
  }

  /** The tile size selections and moves snap to, or null when snapping is off. */
  snapSize(): number | null {
    if (!this.prefs.snapToGrid || !this.doc) return null;
    return Math.max(1, this.doc.meta.grid?.size ?? 16);
  }

  /** A new image asked for from outside (Baseline): { new: '16x16', bg, name }. */
  newFromOptions(o: Record<string, string>): void {
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(o.new ?? '');
    if (!m) return;
    const w = Math.max(1, Math.min(16384, +m[1]));
    const hh = Math.max(1, Math.min(16384, +m[2]));
    createImage(this, w, hh, ['transparent', 'white', 'black'].includes(o.bg) ? o.bg : 'transparent', o.name?.trim() || 'Untitled');
  }

  // ---------- recovery ----------

  private recoveryTimer: number | undefined;

  /** Every few minutes, images with unsaved changes are copied somewhere safe. */
  startRecovery(): void {
    clearInterval(this.recoveryTimer);
    const minutes = this.settings.num('files.recoveryMinutes');
    if (!isDesktop || !minutes) return;
    this.recoveryTimer = window.setInterval(() => void this.saveRecovery(), minutes * 60_000);
  }

  private async saveRecovery(): Promise<void> {
    for (const t of this.tabs) {
      const d = t.doc;
      if (!d.dirty || t.recoveredVersion === d.history.version) continue;
      try {
        const bytes = await writeOra(d);
        await platform.recovery.save(t.recoveryId, bytes, { name: d.name, width: d.width, height: d.height, filePath: d.filePath });
        t.recoveredVersion = d.history.version;
      } catch {
        // a failed copy is tried again next time
      }
    }
  }

  /** The image was saved, closed or thrown away: its recovery copy goes. */
  private dropRecovery(t: DocTab): void {
    if (t.recoveredVersion === undefined) return;
    t.recoveredVersion = undefined;
    void platform.recovery.remove(t.recoveryId);
  }

  /** Opens a recovered image (from a session that ended unexpectedly) in a new tab. */
  async restoreRecovered(id: string, name: string, filePath: string | null): Promise<void> {
    const bytes = await platform.recovery.read(id);
    if (!bytes?.length) {
      toast("That copy couldn't be read.", { kind: 'error' });
      return;
    }
    const doc = await readOra(bytes, name);
    doc.filePath = filePath;
    doc.fileType = filePath ? extOf(filePath) : 'ora';
    this.closeHome();
    this.addDoc(doc);
    // Recovered work counts as unsaved until it's saved again
    doc.edit('Recovered', (e) => e.record(() => undefined, () => undefined));
    await platform.recovery.remove(id);
    toast(`Recovered "${name}". Save it to keep it.`, { kind: 'success' });
  }

  // ---------- state ----------

  get doc(): ImageDoc | null {
    return this.tab?.doc ?? null;
  }

  private loadPrefs(): Prefs {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
      const p = { ...DEFAULT_PREFS, ...raw, lastNew: { ...DEFAULT_PREFS.lastNew, ...raw.lastNew }, exportOpts: { ...DEFAULT_PREFS.exportOpts, ...raw.exportOpts } };
      // Lists are copied so changing them never changes the defaults
      return { ...p, collapsed: [...p.collapsed], panelsKnown: [...p.panelsKnown], recentColors: [...p.recentColors], userPalettes: [...p.userPalettes], recentCommands: [...p.recentCommands] };
    } catch {
      return { ...DEFAULT_PREFS, collapsed: [...DEFAULT_PREFS.collapsed], panelsKnown: [] };
    }
  }

  savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // storage unavailable
    }
  }

  /** Sets the primary or secondary colour. */
  setColor(which: 'fg' | 'bg', c: RGBA): void {
    this.colors[which] = { ...c };
    this.prefs[which] = toHex(c);
    this.rememberColor();
    this.toolbar.refreshColors();
    this.panels.colorsChanged();
    this.view.draw();
  }

  swapColors(): void {
    const { fg, bg } = this.colors;
    this.colors = { fg: bg, bg: fg };
    this.prefs.fg = toHex(this.colors.fg);
    this.prefs.bg = toHex(this.colors.bg);
    this.savePrefs();
    this.toolbar.refreshColors();
    this.panels.colorsChanged();
  }

  resetColors(): void {
    this.colors = { fg: { r: 0, g: 0, b: 0, a: 255 }, bg: { r: 255, g: 255, b: 255, a: 255 } };
    this.prefs.fg = '#000000';
    this.prefs.bg = '#ffffff';
    this.savePrefs();
    this.toolbar.refreshColors();
    this.panels.colorsChanged();
  }

  private colorTimer: ReturnType<typeof setTimeout> | undefined;

  /** Adds the primary colour to the recent colours once it stops changing. */
  private rememberColor(): void {
    clearTimeout(this.colorTimer);
    this.colorTimer = setTimeout(() => {
      const hex = toHex(this.colors.fg);
      const max = this.settings.num('painting.recentColors');
      this.prefs.recentColors = [hex, ...this.prefs.recentColors.filter((c) => c !== hex)].slice(0, max);
      this.savePrefs();
      this.panels.colorsChanged();
    }, 700);
  }

  selectTool(id: string): void {
    const cur = this.tools.current.id;
    if (cur === id) return;
    if (cur !== 'transform') this.prevTool = cur;
    this.tools.select(id);
  }

  /** Finishes a transform or text box in progress (before undo, saving, switching images…). */
  commitTool(): void {
    const t = this.tools.current;
    if (t instanceof TransformTool) t.commit();
    else if (t instanceof TextTool) t.commit();
  }

  get isDark(): boolean {
    const t = this.settings.str('appearance.theme');
    return t === 'system' ? this.systemDark.matches : t === 'dark';
  }

  error(err: unknown): void {
    console.error(err);
    toast(String((err as Error)?.message ?? err), { kind: 'error' });
  }

  /** Zoom or scroll changed. */
  onViewChanged(): void {
    if (this.tab) this.tab.view = { ...this.view.view };
    this.statusbar.update();
    this.panels.viewChanged();
  }

  private overlayOpen(): boolean {
    return !!document.querySelector('.modal-backdrop') || !!this.home || !!this.settingsView;
  }

  // ---------- theme and settings ----------

  applyTheme(): void {
    const root = document.documentElement;
    const dark = this.isDark;
    root.dataset.theme = dark ? 'dark' : 'light';
    const pair = ACCENTS[this.settings.str('appearance.accent')] ?? ACCENTS.violet;
    const a = dark ? pair[0] : pair[1];
    const [r, g, b] = hexToRgb(a);
    const ws = WORKSPACE[this.settings.str('appearance.workspace')] ?? WORKSPACE.dark;
    const vars: Record<string, string> = {
      '--accent': a,
      '--accent-strong': shade(a, dark ? -0.15 : -0.2),
      '--accent-soft': `rgba(${r}, ${g}, ${b}, ${dark ? 0.16 : 0.12})`,
      '--accent-text': dark ? '#0b1220' : '#ffffff',
      '--workspace': dark ? ws[0] : ws[1],
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    platform.setTheme({ dark, bar: dark ? '#16181d' : '#f6f7f9', symbol: dark ? '#c9ced8' : '#3c4350' });
    this.view.refreshTheme();
    this.titlebar.refresh();
  }

  applyChrome(): void {
    const s = this.settings;
    const root = document.documentElement;
    root.classList.toggle('is-desktop', isDesktop);
    root.classList.toggle('density-compact', s.str('appearance.density') === 'compact');
    root.classList.toggle('reduce-motion', s.bool('appearance.reduceMotion'));
    this.statusbar.el.hidden = !s.bool('appearance.showStatusBar');
    this.panels.el.hidden = this.prefs.hidePanels;
  }

  private applyHistoryLimits(): void {
    for (const t of this.tabs) {
      t.doc.history.maxSteps = this.settings.num('history.steps');
      t.doc.history.maxBytes = this.settings.num('history.memory') * 1024 * 1024;
    }
  }

  private onSettingChanged(id: string): void {
    const d = this.settings.byId.get(id);
    if (!d) return;
    d.apply?.(this.settings.get(id) as never, this);
    const r = new Set<Refresh>(d.refresh ?? []);
    if (r.has('theme')) this.applyTheme();
    if (r.has('chrome')) this.applyChrome();
    if (r.has('titlebar')) this.titlebar.rebuild();
    if (r.has('history')) this.applyHistoryLimits();
    if (r.has('canvas')) {
      this.view.refreshTheme();
      this.view.selectionChanged();
    }
    if (r.has('panels')) this.panels.colorsChanged();
    this.refreshAll();
  }

  /** Brings every part of the window up to date. */
  refreshAll(): void {
    this.titlebar.refresh();
    this.docTabs.render();
    this.toolbar.refresh();
    this.optionsbar.render();
    this.statusbar.update();
    this.panels.refresh();
    this.renderEmpty();
  }

  // ---------- tabs ----------

  /** Shows a document in a new tab. */
  addDoc(doc: ImageDoc): DocTab {
    doc.history.maxSteps = this.settings.num('history.steps');
    doc.history.maxBytes = this.settings.num('history.memory') * 1024 * 1024;
    const tab: DocTab = { id: ++tabSeq, doc, view: { zoom: 1, panX: 0, panY: 0, fitted: true }, off: () => undefined, recoveryId: `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
    tab.off = doc.on((e) => this.onDocEvent(tab, e));
    const i = this.tab ? this.tabs.indexOf(this.tab) + 1 : this.tabs.length;
    this.tabs.splice(i, 0, tab);
    this.switchTab(tab);
    return tab;
  }

  switchTab(tab: DocTab | null): void {
    if (tab === this.tab && tab) return;
    this.commitTool();
    if (this.tab) this.tab.view = { ...this.view.view };
    this.tab = tab;
    this.view.setDoc(tab?.doc ?? null, tab ? { ...tab.view } : undefined);
    this.tools.current.activate?.();
    this.refreshAll();
    this.view.el.focus();
  }

  async closeTab(tab: DocTab): Promise<boolean> {
    if (tab.doc.dirty) {
      if (tab !== this.tab) this.switchTab(tab);
      const choice = await dialog<'save' | 'discard' | 'cancel'>(
        'Save changes?',
        `Do you want to save the changes to "${tab.doc.name}"?`,
        [
          { label: 'Save', value: 'save', primary: true },
          { label: "Don't save", value: 'discard' },
          { label: 'Cancel', value: 'cancel' },
        ],
        { cancelValue: 'cancel' },
      );
      if (choice === 'cancel') return false;
      if (choice === 'save' && !(await this.save(tab))) return false;
    }
    if (tab === this.tab) this.commitTool();
    const i = this.tabs.indexOf(tab);
    tab.off();
    this.dropRecovery(tab);
    this.tabs.splice(i, 1);
    if (tab === this.tab) {
      this.tab = null;
      this.switchTab(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    } else this.refreshAll();
    platform.setDirty(this.tabs.some((t) => t.doc.dirty));
    return true;
  }

  async closeTabs(list: DocTab[]): Promise<void> {
    for (const t of list) if (!(await this.closeTab(t))) return;
  }

  moveTab(from: number, to: number): void {
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, t);
    this.docTabs.render();
  }

  private onDocEvent(tab: DocTab, e: DocEvent): void {
    if (e.type === 'history') {
      this.docTabs.render();
      platform.setDirty(this.tabs.some((t) => t.doc.dirty));
      if (!tab.doc.dirty) this.dropRecovery(tab);
    }
    if (tab !== this.tab) return;
    switch (e.type) {
      case 'pixels':
        this.view.pixelsChanged(e.layer, e.rect);
        this.panels.pixelsChanged(e.layer);
        break;
      case 'layers':
        this.view.layersChanged();
        this.panels.layersChanged();
        break;
      case 'active':
        this.panels.layersChanged();
        this.optionsbar.render();
        break;
      case 'selection':
        this.view.selectionChanged();
        this.statusbar.update();
        this.commands.refresh();
        break;
      case 'size':
        this.view.resetFlat();
        this.view.selectionChanged();
        if (this.view.view.fitted) this.view.fit();
        else this.view.invalidate();
        this.panels.layersChanged();
        this.panels.viewChanged();
        this.panels.sizeChanged();
        this.statusbar.update();
        break;
      case 'history':
        this.titlebar.refresh();
        this.panels.historyChanged();
        this.commands.refresh();
        break;
    }
  }

  // ---------- start page, settings ----------

  openHome(section: HomeSection = 'home'): void {
    closePopovers();
    if (this.home) {
      this.home.show(section);
      return;
    }
    this.home = new HomeView(this, section, () => {
      this.home = null;
      this.view.el.focus();
    });
    document.body.append(this.home.el);
  }

  closeHome(): void {
    this.home?.close();
  }

  openSettings(section?: string): void {
    closePopovers();
    if (this.settingsView) {
      this.settingsView.show(section);
      return;
    }
    this.settingsView = new SettingsView(this, section, () => {
      this.settingsView = null;
      this.view.el.focus();
    });
    document.body.append(this.settingsView.el);
  }

  private renderEmpty(): void {
    this.empty.hidden = !!this.tab;
    this.view.el.hidden = !this.tab;
    if (this.tab) return;
    this.empty.replaceChildren(
      h(
        'div',
        { class: 'stage-empty-card' },
        h('div', { class: 'stage-empty-title' }, 'No image open'),
        h('div', { class: 'stage-empty-sub' }, 'Create a new image, open one, or drop image files here.'),
        h(
          'div',
          { class: 'stage-empty-actions' },
          h('button', { class: 'btn primary', onclick: () => this.commands.run('file.new') }, 'New image…'),
          h('button', { class: 'btn outline', onclick: () => this.commands.run('file.open') }, 'Open…'),
          h('button', { class: 'btn outline', onclick: () => this.openHome('home') }, 'Start page'),
        ),
      ),
    );
  }

  // ---------- keyboard ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (this.settingsView) return;
    if (isTyping(e.target)) {
      const c = this.commands.match(e);
      if (c?.global) {
        e.preventDefault();
        this.commands.run(c.id);
      }
      return;
    }
    if (this.home) {
      // The start page takes file commands only
      const c = this.commands.match(e);
      if (c && (c.category === 'File' || c.global)) {
        e.preventDefault();
        this.commands.run(c.id);
      }
      return;
    }
    if (document.querySelector('.popover')) return;
    if (this.tab && this.tools.current.onKey?.(e)) {
      e.preventDefault();
      return;
    }
    const c = this.commands.match(e);
    if (c) {
      e.preventDefault();
      this.commands.run(c.id);
      return;
    }
    const k = eventKey(e);
    const tool = this.tools.list.find((t) => t.key === k);
    if (tool) {
      e.preventDefault();
      this.selectTool(tool.id);
    }
  }

  // ---------- files ----------

  /** New image from size and background. */
  newImage(doc: ImageDoc): void {
    this.closeHome();
    this.addDoc(doc);
  }

  async openFile(): Promise<void> {
    const files = await platform.openFileDialog('image', true);
    if (files?.length) await this.openFiles(files);
  }

  async openPaths(paths: string[]): Promise<void> {
    const files: OpenedFile[] = [];
    for (const p of paths) {
      try {
        const f = await platform.openPath(p);
        if (f) files.push(f);
      } catch (err) {
        this.error(err);
      }
    }
    if (files.length) await this.openFiles(files);
  }

  async openRecent(path: string): Promise<void> {
    await this.openPaths([path]);
  }

  /** Opens images in tabs (or as layers of the current image). Palettes go to the Swatches panel. */
  async openFiles(files: OpenedFile[], asLayers = false): Promise<void> {
    for (const f of files) {
      const ext = extOf(f.name);
      if (['gpl', 'pal', 'hex', 'txt'].includes(ext)) {
        this.panels.swatches.importPalette(new TextDecoder().decode(f.data), baseName(f.name));
        continue;
      }
      const open = f.path ? this.tabs.find((t) => t.doc.filePath?.toLowerCase() === f.path!.toLowerCase()) : undefined;
      if (open && !asLayers) {
        this.switchTab(open);
        continue;
      }
      try {
        this.statusbar.flash(`Opening ${f.name}…`);
        const { doc, notes } = await readImage(f.data, f.name);
        if (asLayers && this.doc) {
          this.addAsLayers(doc);
          continue;
        }
        doc.filePath = f.path;
        // An animated texture's timing is in the .png.mcmeta next to it
        if (f.path && doc.fileType === 'png') {
          const meta = await platform.readSidecar(f.path, '.mcmeta');
          const anim = meta ? parseMcmeta(new TextDecoder().decode(meta), doc.width) : null;
          if (anim) doc.meta.animation = anim;
        }
        this.closeHome();
        this.addDoc(doc);
        if (notes.length) toast(`Opened with changes: ${notes.join(' ')}`, { ms: 9000 });
      } catch (err) {
        toast(`Couldn't open ${f.name}: ${(err as Error).message ?? err}`, { kind: 'error' });
      }
    }
  }

  /** Adds another image's layers to the current image, centred. */
  private addAsLayers(src: ImageDoc): void {
    const doc = this.doc!;
    const dx = Math.round((doc.width - src.width) / 2);
    const dy = Math.round((doc.height - src.height) / 2);
    doc.edit('Place image', (e) => {
      for (const l of src.layers) {
        const copy = new Layer(src.layers.length === 1 ? src.name : `${src.name} — ${l.name}`, l.raster, l.x + dx, l.y + dy);
        copy.setProps({ ...l.props(), name: copy.name });
        addLayer(doc, e, copy);
      }
    });
    this.selectTool('move');
  }

  /** Saves the image; asks where (and in which format) when it has no file yet. */
  async save(tab = this.tab, saveAs = false): Promise<boolean> {
    if (!tab) return false;
    if (tab === this.tab) this.commitTool();
    const doc = tab.doc;
    let path = doc.filePath;
    let format = path ? formatFromExt(extOf(path)) : null;
    if (!path || saveAs || !format) {
      const suggested = format ?? (doc.layers.length > 1 ? 'ora' : 'png');
      path = await platform.saveFileDialog(`${doc.name}.${suggested}`, 'save');
      if (!path) return false;
      format = formatFromExt(extOf(path));
      if (!format) {
        path += `.${suggested}`;
        format = suggested;
      }
    }
    try {
      const bytes = await encodeImage(doc, { format, indexed: this.settings.bool('files.indexedPng'), quality: this.settings.num('files.jpegQuality') / 100 });
      const r = await platform.saveFile(path, bytes);
      if (!r.ok) {
        toast(r.error ?? "Couldn't save the file.", { kind: 'error' });
        return false;
      }
    } catch (err) {
      this.error(err);
      return false;
    }
    doc.filePath = isDesktop ? path : null;
    doc.name = baseName(path.split(/[\\/]/).pop() || doc.name);
    doc.fileType = format;
    // Animated textures need their .png.mcmeta next to the PNG
    if (format === 'png' && doc.meta.animation && isDesktop) {
      const r = await platform.saveSidecar(path, '.mcmeta', new TextEncoder().encode(mcmetaText(doc.meta.animation, doc.width)));
      if (!r.ok) toast(`The image was saved, but its .mcmeta wasn't: ${r.error ?? 'unknown error'}`, { kind: 'error' });
    }
    doc.markSaved();
    const note = lossNote(doc, format);
    if (note && this.settings.bool('files.warnFlatten') && !tab.flattenNoted) {
      tab.flattenNoted = true;
      toast(note, { ms: 9000 });
    } else this.statusbar.flash(`Saved ${path.split(/[\\/]/).pop()}`);
    this.refreshAll();
    return true;
  }

  /** Before the window closes: offers to save each image with changes. */
  async saveBeforeQuit(): Promise<boolean> {
    this.commitTool();
    for (const t of this.tabs.filter((x) => x.doc.dirty)) {
      this.switchTab(t);
      const choice = await dialog<'save' | 'discard' | 'cancel'>(
        'Save changes?',
        `Do you want to save the changes to "${t.doc.name}" before closing?`,
        [
          { label: 'Save', value: 'save', primary: true },
          { label: "Don't save", value: 'discard' },
          { label: 'Cancel', value: 'cancel' },
        ],
        { cancelValue: 'cancel' },
      );
      if (choice === 'cancel') return false;
      if (choice === 'save' && !(await this.save(t))) return false;
      if (choice === 'discard') this.dropRecovery(t);
    }
    return true;
  }

  // ---------- clipboard ----------

  /** The pixels a copy takes: the selection (soft edges kept) or the whole layer. */
  private copyPixels(merged: boolean): { raster: Raster; x: number; y: number } | null {
    const doc = this.doc;
    if (!doc) return null;
    const sel = doc.selection;
    const layer = doc.active;
    let area: Rect = sel ? sel.bounds : merged ? doc.bounds : intersect(layer.bounds, doc.bounds);
    if (!merged && !sel) {
      const c = layer.raster.contentBounds();
      area = intersect({ x: layer.x + c.x, y: layer.y + c.y, w: c.w, h: c.h }, doc.bounds);
    }
    if (isEmpty(area)) return null;
    const data = merged ? flatten(doc, area).data : layer.read(area);
    if (sel)
      for (let y = 0; y < area.h; y++)
        for (let x = 0; x < area.w; x++) {
          const i = (y * area.w + x) * 4 + 3;
          data[i] = (data[i] * sel.get(area.x + x, area.y + y)) / 255;
        }
    return { raster: new Raster(area.w, area.h, data), x: area.x, y: area.y };
  }

  async copy(merged = false): Promise<boolean> {
    this.commitTool();
    const c = this.copyPixels(merged);
    if (!c) {
      toast(merged ? 'Nothing to copy.' : 'This layer is empty here — nothing to copy.');
      return false;
    }
    this.clipboard = c;
    await platform.writeClipboardImage(encodePng(c.raster, { indexed: false, level: 1 }));
    this.statusbar.flash(`Copied ${c.raster.width} × ${c.raster.height} pixels`);
    return true;
  }

  async cut(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    if (doc.active.locked) {
      toast(`"${doc.active.name}" is locked.`);
      return;
    }
    if (!(await this.copy(false))) return;
    doc.edit('Cut', (e) => eraseSelection(doc, e, doc.active));
  }

  /** Pastes as a new layer: where it was copied from when it fits, otherwise in the middle of the view. */
  async paste(inPlace = false): Promise<void> {
    const png = await platform.readClipboardImage();
    let raster: Raster | null = null;
    let at: { x: number; y: number } | null = null;
    if (png) {
      try {
        raster = decodePng(png);
      } catch {
        raster = null;
      }
      // Our own copy: keep where it came from
      const own = this.clipboard;
      if (raster && own && own.raster.width === raster.width && own.raster.height === raster.height && sameish(own.raster.data, raster.data)) {
        raster = own.raster;
        at = { x: own.x, y: own.y };
      }
    } else if (this.clipboard) {
      raster = this.clipboard.raster;
      at = { x: this.clipboard.x, y: this.clipboard.y };
    }
    if (!raster) {
      toast('There is no picture on the clipboard. Copy an image or part of one first.');
      return;
    }
    const doc = this.doc;
    if (!doc) {
      this.pasteAsNew(raster);
      return;
    }
    this.commitTool();
    let x: number;
    let y: number;
    const fits = at && at.x >= 0 && at.y >= 0 && at.x + raster.width <= doc.width && at.y + raster.height <= doc.height;
    if (at && (inPlace || fits)) {
      x = at.x;
      y = at.y;
    } else {
      const v = this.view.visibleRect();
      const c = intersect(v, doc.bounds);
      const mid = isEmpty(c) ? { x: doc.width / 2, y: doc.height / 2 } : { x: c.x + c.w / 2, y: c.y + c.h / 2 };
      x = Math.round(mid.x - raster.width / 2);
      y = Math.round(mid.y - raster.height / 2);
    }
    const layer = new Layer(nextLayerName(doc, 'Pasted'), raster, x, y);
    doc.edit('Paste', (e) => {
      addLayer(doc, e, layer);
      if (doc.selection) {
        const prev = doc.selection;
        doc.selection = null;
        doc.emit({ type: 'selection' });
        e.record(
          () => {
            doc.selection = prev;
            doc.emit({ type: 'selection' });
          },
          () => {
            doc.selection = null;
            doc.emit({ type: 'selection' });
          },
        );
      }
    });
    this.selectTool('move');
    if (raster.width > doc.width || raster.height > doc.height) toast('The pasted picture is bigger than the image. Use Image → Reveal all, or move it into place.');
  }

  async pasteAsNew(raster?: Raster): Promise<void> {
    if (!raster) {
      const png = await platform.readClipboardImage();
      if (!png) {
        toast('There is no picture on the clipboard.');
        return;
      }
      raster = decodePng(png);
    }
    const doc = documentFromRaster(raster, 'Pasted image');
    doc.layers[0].name = 'Layer 1';
    this.newImage(doc);
  }

  /** Fills the selection (or the layer) with the primary or secondary colour. */
  fill(which: 'fg' | 'bg'): void {
    const doc = this.doc;
    if (!doc) return;
    if (doc.active.locked) {
      toast(`"${doc.active.name}" is locked.`);
      return;
    }
    doc.edit(which === 'fg' ? 'Fill with primary colour' : 'Fill with secondary colour', (e) => fillSelection(doc, e, doc.active, this.colors[which]));
  }

  // ---------- drag and drop ----------

  private setupDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (depth === 1) this.showDropZone();
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.hideDropZone();
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.dropZone?.querySelectorAll('.drop-half').forEach((el) => {
        const r = el.getBoundingClientRect();
        el.classList.toggle('on', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
      });
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const target = this.dropZone?.querySelector('.drop-half.on') as HTMLElement | null;
      const asLayers = target?.dataset.mode === 'layer' || (!this.dropZone?.querySelector('.drop-half') && this.settings.str('files.openAsLayers') === 'layer' && !!this.doc);
      this.hideDropZone();
      const files = [...(e.dataTransfer?.files ?? [])];
      void Promise.all(files.map((f) => platform.readDroppedFile(f))).then((opened) => this.openFiles(opened, asLayers));
    });
  }

  private showDropZone(): void {
    this.hideDropZone();
    const mode = this.settings.str('files.openAsLayers');
    const both = !!this.doc && mode === 'ask' && !this.home;
    const half = (m: string, title: string, sub: string) => h('div', { class: 'drop-half', dataset: { mode: m } }, h('div', { class: 'drop-title' }, title), h('div', { class: 'drop-sub' }, sub));
    this.dropZone = h(
      'div',
      { class: `drop-zone${both ? ' two' : ''}` },
      both ? half('open', 'Open as new images', 'Each file in its own tab') : null,
      both ? half('layer', `Add to "${this.doc!.name}"`, 'Each file becomes a layer') : h('div', { class: 'drop-single' }, h('div', { class: 'drop-title' }, 'Drop images to open them')),
    );
    document.body.append(this.dropZone);
  }

  private hideDropZone(): void {
    this.dropZone?.remove();
    this.dropZone = null;
  }
}

/** Equal pixels, allowing for the rounding a clipboard round trip can add. */
function sameish(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i + 3] - b[i + 3]) > 2) return false;
    if (a[i + 3] && (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2)) return false;
  }
  return true;
}
