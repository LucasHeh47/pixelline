// Every action in the app, with keyboard shortcuts. The menus, tool bar and command search all use these.
import * as L from 'lucide';
import type { IconNode } from 'lucide';
import { flatten } from '../core/blend';
import { FILTERS, type FilterDef } from '../core/filters';
import { readOra, writeOra } from '../core/io/ora';
import { isEmpty } from '../core/geom';
import { Layer } from '../core/layer';
import {
  addLayer,
  contentBounds,
  cropImage,
  eraseSelection,
  flattenImage,
  flipImage,
  layerFromSelection,
  mergeDown,
  moveLayer,
  nextLayerName,
  removeLayer,
  resizeCanvas,
  rotateImage,
  selectionFromAlpha,
  setLayerProps,
  setSelection,
  transformLayer,
} from '../core/ops';
import { Mask } from '../core/selection';
import type { App } from './app';
import { openCanvasSize, openImageSize, openTileGrid } from './dialogs/imageSize';
import { openExport } from './dialogs/export';
import { applyFilterNow, openFilter } from './dialogs/filterDialog';
import { openLayerProps } from './dialogs/layerProps';
import { openNewImage } from './dialogs/newImage';
import { numberDialog } from './dialogs/common';
import { openPixelArt, openReduceColors, openReplaceColor, openUpscale } from './dialogs/colorTools';
import { showAbout, showShortcuts } from './help';
import { openPalette } from './palette';
import { isDesktop, platform } from './platform';
import type { PaintTool } from './tools/paint';
import type { TransformTool } from './tools/move';
import { toast } from './widgets';

export interface Command {
  id: string;
  title: string;
  category: string;
  keys?: string[];
  icon?: IconNode;
  keywords?: string;
  /** Runs even when focus is in a text field. */
  global?: boolean;
  /** Left out of menus and search (shortcut only). */
  hidden?: boolean;
  /** Needs an open image. */
  needsDoc?: boolean;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const CODE_KEYS: Record<string, string> = {
  Semicolon: ';',
  Equal: '=',
  Minus: '-',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Quote: "'",
  NumpadAdd: '+',
  NumpadSubtract: '-',
  Space: 'Space',
};

/** Turns a keyboard event into a string like "Ctrl+Shift+L". */
export function eventKey(e: KeyboardEvent): string {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export class Commands {
  private list: Command[] = [];
  private byId = new Map<string, Command>();
  private byKey = new Map<string, Command>();
  private listeners = new Set<() => void>();

  constructor(private app: App) {
    this.register();
  }

  all(): Command[] {
    return this.list.filter((c) => !c.hidden);
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  match(e: KeyboardEvent): Command | undefined {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined;
    return this.byKey.get(eventKey(e));
  }

  isEnabled(c: Command): boolean {
    if (c.needsDoc && !this.app.doc) return false;
    return !c.enabled || c.enabled();
  }

  run(id: string): void {
    const c = this.byId.get(id);
    if (!c || !this.isEnabled(c)) return;
    if (this.app.settings.bool('keyboard.remember') && !c.hidden) {
      const recent = this.app.prefs.recentCommands.filter((x) => x !== id);
      recent.unshift(id);
      this.app.prefs.recentCommands = recent.slice(0, 8);
      this.app.savePrefs();
    }
    try {
      const r = c.run();
      if (r instanceof Promise) r.catch((err: Error) => this.app.error(err));
    } catch (err) {
      this.app.error(err);
    }
  }

  /** Enabled states may have changed (selection, history). */
  refresh(): void {
    for (const l of this.listeners) l();
  }

  onRefresh(fn: () => void): void {
    this.listeners.add(fn);
  }

  private add(c: Command): void {
    this.list.push(c);
    this.byId.set(c.id, c);
    for (const k of c.keys ?? []) this.byKey.set(k, c);
  }

  private register(): void {
    const app = this.app;
    const a = (c: Command) => this.add(c);
    const doc = () => app.doc!;
    const layer = () => app.doc!.active;
    const hasSel = () => !!app.doc?.selection;
    /** Runs an edit on the active layer unless it's locked. */
    const onLayer = (label: string, fn: (e: import('../core/document').Edit, l: Layer) => void) => {
      const d = doc();
      const l = d.active;
      if (l.locked) {
        toast(`"${l.name}" is locked. Unlock it in the Layers panel first.`);
        return;
      }
      app.commitTool();
      d.edit(label, (e) => fn(e, l));
    };
    const whole = (label: string, fn: (e: import('../core/document').Edit) => void) => {
      app.commitTool();
      const d = doc();
      d.edit(label, fn);
    };

    // ---------- File ----------
    a({ id: 'file.new', title: 'New image…', category: 'File', icon: L.FilePlus, keys: ['Ctrl+N'], global: true, run: () => openNewImage(app) });
    a({ id: 'file.newFromClipboard', title: 'New image from clipboard', category: 'File', icon: L.ClipboardPaste, keys: ['Ctrl+Alt+V'], run: () => app.pasteAsNew() });
    a({ id: 'file.open', title: 'Open…', category: 'File', icon: L.FolderOpen, keys: ['Ctrl+O'], global: true, run: () => app.openFile() });
    a({
      id: 'file.place',
      title: 'Place image as layer…',
      category: 'File',
      icon: L.ImagePlus,
      needsDoc: true,
      keywords: 'import add insert embed',
      run: async () => {
        const files = await platform.openFileDialog('image', true);
        if (files?.length) await app.openFiles(files, true);
      },
    });
    a({ id: 'file.home', title: 'Start page', category: 'File', icon: L.House, run: () => app.openHome('home') });
    a({ id: 'file.save', title: 'Save', category: 'File', icon: L.Save, keys: ['Ctrl+S'], needsDoc: true, run: () => app.save() });
    a({ id: 'file.saveAs', title: 'Save as…', category: 'File', icon: L.SaveAll, keys: ['Ctrl+Shift+S'], needsDoc: true, run: () => app.save(app.tab, true) });
    a({ id: 'file.export', title: 'Export as…', category: 'File', icon: L.Download, keys: ['Ctrl+Alt+S', 'Ctrl+Alt+Shift+W'], needsDoc: true, keywords: 'png jpg webp scale upscale', run: () => openExport(app) });
    a({
      id: 'file.revert',
      title: 'Revert to saved',
      category: 'File',
      icon: L.History,
      keys: ['F12'],
      needsDoc: true,
      enabled: () => !!app.doc?.filePath && app.doc.dirty,
      run: async () => {
        const t = app.tab!;
        const path = t.doc.filePath!;
        t.doc.markSaved();
        await app.closeTab(t);
        await app.openPaths([path]);
      },
    });
    a({ id: 'file.close', title: 'Close image', category: 'File', icon: L.X, keys: ['Ctrl+W'], needsDoc: true, run: () => app.closeTab(app.tab!) });
    a({ id: 'file.closeAll', title: 'Close all images', category: 'File', keys: ['Ctrl+Alt+W'], needsDoc: true, run: () => app.closeTabs([...app.tabs]) });
    a({ id: 'file.newWindow', title: 'New window', category: 'File', icon: L.AppWindow, keys: ['Ctrl+Shift+Alt+N'], run: () => platform.newWindow() });
    a({ id: 'file.showInFolder', title: 'Show in folder', category: 'File', icon: L.FolderSearch, enabled: () => isDesktop && !!app.doc?.filePath, run: () => platform.showInFolder(app.doc!.filePath!) });
    a({ id: 'file.nextTab', title: 'Next image', category: 'File', keys: ['Ctrl+Tab'], hidden: true, run: () => cycleTab(app, 1) });
    a({ id: 'file.prevTab', title: 'Previous image', category: 'File', keys: ['Ctrl+Shift+Tab'], hidden: true, run: () => cycleTab(app, -1) });

    // ---------- Edit ----------
    a({
      id: 'edit.undo',
      title: 'Undo',
      category: 'Edit',
      icon: L.Undo2,
      keys: ['Ctrl+Z'],
      needsDoc: true,
      enabled: () => !!app.doc?.history.canUndo,
      run: () => {
        app.commitTool();
        const label = doc().undo();
        if (label) app.statusbar.flash(`Undid ${label}`);
      },
    });
    a({
      id: 'edit.redo',
      title: 'Redo',
      category: 'Edit',
      icon: L.Redo2,
      keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
      needsDoc: true,
      enabled: () => !!app.doc?.history.canRedo,
      run: () => {
        app.commitTool();
        const label = doc().redo();
        if (label) app.statusbar.flash(`Redid ${label}`);
      },
    });
    a({ id: 'edit.cut', title: 'Cut', category: 'Edit', icon: L.Scissors, keys: ['Ctrl+X'], needsDoc: true, run: () => app.cut() });
    a({ id: 'edit.copy', title: 'Copy', category: 'Edit', icon: L.Copy, keys: ['Ctrl+C'], needsDoc: true, run: () => app.copy(false) });
    a({ id: 'edit.copyMerged', title: 'Copy merged', category: 'Edit', icon: L.Layers2, keys: ['Ctrl+Shift+C'], needsDoc: true, keywords: 'all layers visible', run: () => app.copy(true) });
    a({ id: 'edit.paste', title: 'Paste', category: 'Edit', icon: L.ClipboardPaste, keys: ['Ctrl+V'], run: () => app.paste(false) });
    a({ id: 'edit.pasteInPlace', title: 'Paste in place', category: 'Edit', keys: ['Ctrl+Shift+V'], needsDoc: true, run: () => app.paste(true) });
    a({
      id: 'edit.clear',
      title: 'Delete selected pixels',
      category: 'Edit',
      icon: L.Eraser,
      keys: ['Delete', 'Backspace'],
      needsDoc: true,
      keywords: 'clear erase',
      run: () => {
        if (!hasSel()) {
          toast('Nothing is selected. Select an area first (to remove the whole layer, use Layer → Delete layer).');
          return;
        }
        onLayer('Delete pixels', (e, l) => eraseSelection(doc(), e, l));
      },
    });
    a({ id: 'edit.fillFg', title: 'Fill with primary colour', category: 'Edit', icon: L.PaintBucket, keys: ['Alt+Backspace', 'Alt+Delete'], needsDoc: true, run: () => app.fill('fg') });
    a({ id: 'edit.fillBg', title: 'Fill with secondary colour', category: 'Edit', keys: ['Ctrl+Backspace', 'Ctrl+Delete'], needsDoc: true, run: () => app.fill('bg') });
    a({
      id: 'edit.transform',
      title: 'Free transform',
      category: 'Edit',
      icon: L.Scaling,
      keys: ['Ctrl+T'],
      needsDoc: true,
      keywords: 'scale rotate resize',
      run: () => {
        const cur = app.tools.current.id;
        if (cur === 'transform') return;
        app.commitTool();
        const t = app.tools.get('transform') as TransformTool;
        if (t.begin(cur)) app.tools.select('transform');
      },
    });
    const layerTransform = (id: string, title: string, how: 'flipH' | 'flipV' | 'rot90' | 'rot180' | 'rot270', icon?: IconNode) =>
      a({ id, title, category: 'Edit', icon, needsDoc: true, run: () => onLayer(title, (e, l) => transformLayer(doc(), e, l, how)) });
    layerTransform('layer.flipH', 'Flip layer horizontally', 'flipH', L.FlipHorizontal2);
    layerTransform('layer.flipV', 'Flip layer vertically', 'flipV', L.FlipVertical2);
    layerTransform('layer.rot90', 'Rotate layer 90° clockwise', 'rot90', L.RotateCw);
    layerTransform('layer.rot270', 'Rotate layer 90° counter-clockwise', 'rot270', L.RotateCcw);
    layerTransform('layer.rot180', 'Rotate layer 180°', 'rot180');
    a({ id: 'edit.replaceColor', title: 'Replace colour…', category: 'Edit', icon: L.Replace, needsDoc: true, keywords: 'swap recolor recolour', run: () => openReplaceColor(app) });
    a({ id: 'color.swap', title: 'Swap primary and secondary colours', category: 'Edit', icon: L.ArrowLeftRight, keys: ['X'], run: () => app.swapColors() });
    a({ id: 'color.reset', title: 'Default colours (black and white)', category: 'Edit', keys: ['D'], run: () => app.resetColors() });
    a({ id: 'tool.smaller', title: 'Smaller brush', category: 'Edit', keys: ['['], hidden: true, run: () => (app.tools.current as Partial<PaintTool>).resize?.(-1) });
    a({ id: 'tool.bigger', title: 'Bigger brush', category: 'Edit', keys: [']'], hidden: true, run: () => (app.tools.current as Partial<PaintTool>).resize?.(1) });
    a({ id: 'app.settings', title: 'Settings', category: 'Edit', icon: L.Settings, keys: ['Ctrl+,'], global: true, keywords: 'preferences options', run: () => app.openSettings() });

    // ---------- Image ----------
    a({ id: 'image.size', title: 'Image size…', category: 'Image', icon: L.Scaling, keys: ['Ctrl+Alt+I'], needsDoc: true, keywords: 'resize scale resample', run: () => openImageSize(app) });
    a({ id: 'image.canvasSize', title: 'Canvas size…', category: 'Image', icon: L.Frame, keys: ['Ctrl+Alt+C'], needsDoc: true, keywords: 'expand border', run: () => openCanvasSize(app) });
    a({
      id: 'image.crop',
      title: 'Crop to selection',
      category: 'Image',
      icon: L.Crop,
      needsDoc: true,
      enabled: hasSel,
      run: () => {
        const r = doc().selection!.bounds;
        whole('Crop', (e) => cropImage(doc(), e, r, true));
        app.view.fit();
      },
    });
    a({
      id: 'image.trim',
      title: 'Trim transparent edges',
      category: 'Image',
      icon: L.Shrink,
      needsDoc: true,
      keywords: 'autocrop crop',
      run: () => {
        const r = contentBounds(doc());
        if (isEmpty(r)) return toast('The image is empty.');
        if (r.w === doc().width && r.h === doc().height) return toast('There are no transparent edges to trim.');
        whole('Trim', (e) => cropImage(doc(), e, r, true));
        app.view.fit();
      },
    });
    a({
      id: 'image.revealAll',
      title: 'Reveal all',
      category: 'Image',
      icon: L.Expand,
      needsDoc: true,
      keywords: 'grow canvas fit layers',
      run: () => {
        const d = doc();
        let x1 = 0;
        let y1 = 0;
        let x2 = d.width;
        let y2 = d.height;
        for (const l of d.layers) {
          const c = l.raster.contentBounds();
          if (isEmpty(c)) continue;
          x1 = Math.min(x1, l.x + c.x);
          y1 = Math.min(y1, l.y + c.y);
          x2 = Math.max(x2, l.x + c.x + c.w);
          y2 = Math.max(y2, l.y + c.y + c.h);
        }
        if (x1 === 0 && y1 === 0 && x2 === d.width && y2 === d.height) return toast('Everything is already inside the image.');
        whole('Reveal all', (e) => cropImage(d, e, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, false));
        app.view.fit();
      },
    });
    a({ id: 'image.rot90', title: 'Rotate image 90° clockwise', category: 'Image', icon: L.RotateCw, needsDoc: true, run: () => whole('Rotate image', (e) => rotateImage(doc(), e, 1)) });
    a({ id: 'image.rot270', title: 'Rotate image 90° counter-clockwise', category: 'Image', icon: L.RotateCcw, needsDoc: true, run: () => whole('Rotate image', (e) => rotateImage(doc(), e, 3)) });
    a({ id: 'image.rot180', title: 'Rotate image 180°', category: 'Image', needsDoc: true, run: () => whole('Rotate image', (e) => rotateImage(doc(), e, 2)) });
    a({ id: 'image.flipH', title: 'Flip image horizontally', category: 'Image', icon: L.FlipHorizontal2, needsDoc: true, keywords: 'mirror', run: () => whole('Flip image', (e) => flipImage(doc(), e, true)) });
    a({ id: 'image.flipV', title: 'Flip image vertically', category: 'Image', icon: L.FlipVertical2, needsDoc: true, run: () => whole('Flip image', (e) => flipImage(doc(), e, false)) });
    a({
      id: 'image.duplicate',
      title: 'Duplicate image',
      category: 'Image',
      icon: L.CopyPlus,
      needsDoc: true,
      run: async () => {
        app.commitTool();
        const copy = await readOra(await writeOra(doc()), `${doc().name} copy`);
        app.newImage(copy);
      },
    });
    a({ id: 'image.reduceColors', title: 'Reduce colours…', category: 'Image', icon: L.Palette, needsDoc: true, keywords: 'quantize indexed palette dither posterize', run: () => openReduceColors(app) });
    a({ id: 'image.pixelArt', title: 'Turn into pixel art…', category: 'Image', icon: L.Grid3x3, needsDoc: true, keywords: 'pixelate downscale photo convert sprite', run: () => openPixelArt(app) });
    a({ id: 'image.upscale', title: 'Upscale pixel art…', category: 'Image', icon: L.Maximize2, needsDoc: true, keywords: 'scale2x scale3x epx enlarge', run: () => openUpscale(app) });
    a({ id: 'image.tileGrid', title: 'Tile grid…', category: 'Image', icon: L.LayoutGrid, needsDoc: true, keywords: 'texture block 16', run: () => openTileGrid(app) });
    a({
      id: 'image.canvasMinecraft',
      title: 'Make square (pad to power of two)',
      category: 'Image',
      needsDoc: true,
      keywords: 'minecraft texture pow2 16 32 64',
      run: () => {
        const d = doc();
        let n = 1;
        while (n < Math.max(d.width, d.height)) n *= 2;
        if (n === d.width && n === d.height) return toast(`The image is already ${n} × ${n}.`);
        whole('Canvas size', (e) => resizeCanvas(d, e, n, n, 'c'));
        app.view.fit();
      },
    });

    // ---------- Layer ----------
    a({
      id: 'layer.new',
      title: 'New layer',
      category: 'Layer',
      icon: L.Plus,
      keys: ['Ctrl+Shift+N'],
      needsDoc: true,
      run: () => whole('New layer', (e) => addLayer(doc(), e, new Layer(nextLayerName(doc())))),
    });
    a({
      id: 'layer.duplicate',
      title: 'Duplicate layer',
      category: 'Layer',
      icon: L.Copy,
      keys: ['Ctrl+J'],
      needsDoc: true,
      keywords: 'copy selection to new layer',
      run: () => whole(hasSel() ? 'Layer via copy' : 'Duplicate layer', (e) => layerFromSelection(doc(), e, layer())),
    });
    a({
      id: 'layer.cut',
      title: 'Cut selection to new layer',
      category: 'Layer',
      icon: L.Scissors,
      keys: ['Ctrl+Shift+J'],
      needsDoc: true,
      enabled: hasSel,
      run: () => onLayer('Layer via cut', (e, l) => layerFromSelection(doc(), e, l, true)),
    });
    a({
      id: 'layer.delete',
      title: 'Delete layer',
      category: 'Layer',
      icon: L.Trash2,
      needsDoc: true,
      enabled: () => (app.doc?.layers.length ?? 0) > 1,
      run: () => whole('Delete layer', (e) => removeLayer(doc(), e, layer())),
    });
    a({ id: 'layer.props', title: 'Layer properties…', category: 'Layer', icon: L.SlidersHorizontal, needsDoc: true, keywords: 'rename opacity blend mode', run: () => openLayerProps(app, layer()) });
    a({
      id: 'layer.mergeDown',
      title: 'Merge down',
      category: 'Layer',
      icon: L.ArrowDownToLine,
      keys: ['Ctrl+E'],
      needsDoc: true,
      enabled: () => !!app.doc && app.doc.layers.indexOf(app.doc.active) > 0,
      run: () => whole('Merge down', (e) => mergeDown(doc(), e, layer())),
    });
    a({
      id: 'layer.mergeVisible',
      title: 'Merge visible',
      category: 'Layer',
      icon: L.Layers,
      keys: ['Ctrl+Shift+E'],
      needsDoc: true,
      run: () =>
        whole('Merge visible', (e) => {
          const d = doc();
          const vis = d.layers.filter((l) => l.visible);
          if (vis.length < 2) return;
          // Merge each visible layer down into the lowest visible one
          for (let i = vis.length - 1; i >= 1; i--) {
            const l = vis[i];
            const below = vis[i - 1];
            // Make it sit right above its target so merge down works on it
            moveLayer(d, e, l, d.layers.indexOf(below) + 1);
            mergeDown(d, e, l);
          }
        }),
    });
    a({ id: 'layer.flatten', title: 'Flatten image', category: 'Layer', icon: L.Square, needsDoc: true, run: () => whole('Flatten image', (e) => flattenImage(doc(), e)) });
    const move = (id: string, title: string, keys: string[], to: (i: number, n: number) => number, icon?: IconNode) =>
      a({
        id,
        title,
        category: 'Layer',
        keys,
        icon,
        needsDoc: true,
        run: () => {
          const d = doc();
          const i = d.layers.indexOf(d.active);
          const j = Math.max(0, Math.min(d.layers.length - 1, to(i, d.layers.length)));
          if (i !== j) whole('Move layer', (e) => moveLayer(d, e, d.active, j));
        },
      });
    move('layer.up', 'Move layer up', ['Ctrl+]'], (i) => i + 1, L.ArrowUp);
    move('layer.down', 'Move layer down', ['Ctrl+['], (i) => i - 1, L.ArrowDown);
    move('layer.top', 'Move layer to the top', ['Ctrl+Shift+]'], (_i, n) => n - 1, L.ArrowUpToLine);
    move('layer.bottom', 'Move layer to the bottom', ['Ctrl+Shift+['], () => 0, L.ArrowDownToLine);
    a({
      id: 'layer.selectAbove',
      title: 'Select the layer above',
      category: 'Layer',
      keys: ['Alt+]'],
      needsDoc: true,
      run: () => {
        const d = doc();
        const i = d.layers.indexOf(d.active);
        d.setActive(d.layers[Math.min(d.layers.length - 1, i + 1)].id);
      },
    });
    a({
      id: 'layer.selectBelow',
      title: 'Select the layer below',
      category: 'Layer',
      keys: ['Alt+['],
      needsDoc: true,
      run: () => {
        const d = doc();
        const i = d.layers.indexOf(d.active);
        d.setActive(d.layers[Math.max(0, i - 1)].id);
      },
    });
    a({
      id: 'layer.visible',
      title: 'Show / hide layer',
      category: 'Layer',
      icon: L.Eye,
      needsDoc: true,
      run: () => whole('Show / hide layer', (e) => setLayerProps(doc(), e, layer(), { visible: !layer().visible })),
    });
    a({ id: 'layer.lock', title: 'Lock layer', category: 'Layer', icon: L.Lock, needsDoc: true, checked: () => !!app.doc?.active.locked, run: () => whole('Lock layer', (e) => setLayerProps(doc(), e, layer(), { locked: !layer().locked })) });
    a({
      id: 'layer.alphaLock',
      title: 'Lock transparent pixels',
      category: 'Layer',
      icon: L.Grid2x2Check,
      keys: ['/'],
      needsDoc: true,
      keywords: 'alpha preserve transparency',
      checked: () => !!app.doc?.active.alphaLocked,
      run: () => whole('Lock transparent pixels', (e) => setLayerProps(doc(), e, layer(), { alphaLocked: !layer().alphaLocked })),
    });
    a({
      id: 'layer.trim',
      title: 'Trim layer to its pixels',
      category: 'Layer',
      needsDoc: true,
      keywords: 'shrink',
      run: () =>
        onLayer('Trim layer', (e, l) => {
          e.touch(l, l.bounds);
          l.trim();
          doc().emit({ type: 'pixels', layer: l, rect: doc().bounds });
        }),
    });
    a({
      id: 'layer.toImage',
      title: 'New layer from the whole image',
      category: 'Layer',
      keys: ['Ctrl+Alt+Shift+E'],
      needsDoc: true,
      keywords: 'stamp visible merged copy',
      run: () => {
        whole('Stamp visible', (e) => addLayer(doc(), e, new Layer('Merged', flatten(doc()), 0, 0), doc().layers.length));
      },
    });

    // ---------- Select ----------
    a({ id: 'select.all', title: 'Select all', category: 'Select', icon: L.SquareDashed, keys: ['Ctrl+A'], needsDoc: true, run: () => whole('Select all', (e) => setSelection(doc(), e, Mask.all(doc().width, doc().height))) });
    a({
      id: 'select.none',
      title: 'Deselect',
      category: 'Select',
      icon: L.SquareX,
      keys: ['Ctrl+D'],
      needsDoc: true,
      enabled: hasSel,
      run: () => {
        app.lastSelection.set(doc(), doc().selection!);
        whole('Deselect', (e) => setSelection(doc(), e, null));
      },
    });
    a({
      id: 'select.reselect',
      title: 'Reselect',
      category: 'Select',
      keys: ['Ctrl+Shift+D'],
      needsDoc: true,
      enabled: () => !!app.doc && app.lastSelection.has(app.doc),
      run: () => {
        const m = app.lastSelection.get(doc());
        if (m && m.width === doc().width && m.height === doc().height) whole('Reselect', (e) => setSelection(doc(), e, m));
      },
    });
    a({
      id: 'select.invert',
      title: 'Invert selection',
      category: 'Select',
      icon: L.FlipHorizontal,
      keys: ['Ctrl+Shift+I'],
      needsDoc: true,
      run: () => {
        const d = doc();
        const m = d.selection ? d.selection.inverted() : null;
        whole('Invert selection', (e) => setSelection(d, e, m && !m.isEmpty() ? m : null));
      },
    });
    a({
      id: 'select.layer',
      title: 'Select layer pixels',
      category: 'Select',
      icon: L.SquareMousePointer,
      needsDoc: true,
      keywords: 'alpha transparency load selection',
      run: () => {
        const m = selectionFromAlpha(doc(), layer());
        whole('Select layer pixels', (e) => setSelection(doc(), e, m.isEmpty() ? null : m));
      },
    });
    const modify = (id: string, title: string, label: string, max: number, fn: (m: Mask, n: number) => Mask, keys?: string[]) =>
      a({
        id,
        title,
        category: 'Select',
        keys,
        needsDoc: true,
        enabled: hasSel,
        run: async () => {
          const n = await numberDialog(title.replace('…', ''), label, 2, 1, max, 'px');
          if (n === null) return;
          const d = doc();
          const m = fn(d.selection!, n);
          whole(title.replace('…', ''), (e) => setSelection(d, e, m.isEmpty() ? null : m));
        },
      });
    modify('select.grow', 'Grow selection…', 'Grow by', 200, (m, n) => m.grown(n));
    modify('select.shrink', 'Shrink selection…', 'Shrink by', 200, (m, n) => m.grown(-n));
    modify('select.feather', 'Feather selection…', 'Soften the edge by', 200, (m, n) => m.feathered(n), ['Shift+F6']);

    // ---------- Filters and adjustments ----------
    const filterKeys: Record<string, string[]> = { hueSaturation: ['Ctrl+U'], levels: ['Ctrl+L'], invert: ['Ctrl+I'], grayscale: ['Ctrl+Shift+U'], brightnessContrast: ['Ctrl+Alt+B'] };
    for (const f of FILTERS) {
      a({
        id: `filter.${f.id}`,
        title: `${f.name}${f.params.length ? '…' : ''}`,
        category: f.group === 'Adjustments' ? 'Adjustments' : `Filter · ${f.group}`,
        keys: filterKeys[f.id],
        icon: filterIcon(f),
        keywords: f.description,
        needsDoc: true,
        run: () => (f.params.length ? openFilter(app, f.id) : applyFilterNow(app, f.id, {})),
      });
    }
    a({
      id: 'filter.repeat',
      title: 'Repeat last filter',
      category: 'Filter',
      icon: L.Repeat,
      keys: ['Ctrl+F'],
      needsDoc: true,
      enabled: () => !!app.lastFilter,
      run: () => applyFilterNow(app, app.lastFilter!.id, app.lastFilter!.params),
    });
    a({ id: 'filter.repeatOptions', title: 'Last filter with options…', category: 'Filter', keys: ['Ctrl+Alt+F'], needsDoc: true, enabled: () => !!app.lastFilter, run: () => openFilter(app, app.lastFilter!.id) });

    // ---------- View ----------
    a({ id: 'view.zoomIn', title: 'Zoom in', category: 'View', icon: L.ZoomIn, keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl++'], needsDoc: true, run: () => app.view.zoomStep(1) });
    a({ id: 'view.zoomOut', title: 'Zoom out', category: 'View', icon: L.ZoomOut, keys: ['Ctrl+-'], needsDoc: true, run: () => app.view.zoomStep(-1) });
    a({ id: 'view.fit', title: 'Fit on screen', category: 'View', icon: L.Maximize, keys: ['Ctrl+0'], needsDoc: true, run: () => app.view.fit() });
    a({ id: 'view.actual', title: 'Actual pixels (100%)', category: 'View', keys: ['Ctrl+1'], needsDoc: true, run: () => app.view.setZoom(1, undefined, true) });
    a({
      id: 'view.pixelGrid',
      title: 'Pixel grid',
      category: 'View',
      icon: L.Grid3x3,
      keys: ["Ctrl+'"],
      checked: () => app.prefs.pixelGrid,
      run: () => togglePref(app, 'pixelGrid', 'Pixel grid'),
    });
    a({
      id: 'view.tileGrid',
      title: 'Tile grid',
      category: 'View',
      icon: L.LayoutGrid,
      keys: ["Ctrl+Shift+'"],
      needsDoc: true,
      checked: () => !!app.doc?.meta.grid?.show,
      run: () => {
        const d = doc();
        const size = d.meta.grid?.size ?? 16;
        d.meta.grid = { size, show: !d.meta.grid?.show };
        app.view.draw();
        app.statusbar.flash(d.meta.grid.show ? `Tile grid on (every ${size} pixels)` : 'Tile grid off');
      },
    });
    a({
      id: 'view.tileMode',
      title: 'Seamless tile preview',
      category: 'View',
      icon: L.Grid2x2,
      keys: ['Shift+T'],
      keywords: 'tiling repeat texture wrap pattern',
      checked: () => app.prefs.tileMode,
      run: () => togglePref(app, 'tileMode', 'Seamless tile preview (painting wraps around the edges)'),
    });
    a({ id: 'view.mirrorX', title: 'Mirror painting left ↔ right', category: 'View', icon: L.FlipHorizontal2, keywords: 'symmetry', checked: () => app.prefs.mirrorX, run: () => togglePref(app, 'mirrorX', 'Left-right mirror painting') });
    a({ id: 'view.mirrorY', title: 'Mirror painting top ↕ bottom', category: 'View', icon: L.FlipVertical2, keywords: 'symmetry', checked: () => app.prefs.mirrorY, run: () => togglePref(app, 'mirrorY', 'Top-bottom mirror painting') });
    a({
      id: 'view.panels',
      title: 'Panels',
      category: 'View',
      icon: L.PanelRight,
      keys: ['Tab'],
      checked: () => !app.prefs.hidePanels,
      run: () => {
        app.prefs.hidePanels = !app.prefs.hidePanels;
        app.savePrefs();
        app.applyChrome();
      },
    });
    a({
      id: 'view.theme',
      title: 'Switch light / dark theme',
      category: 'View',
      icon: L.SunMoon,
      run: () => app.settings.set('appearance.theme', app.isDark ? 'light' : 'dark'),
    });
    a({
      id: 'view.fullscreen',
      title: 'Full screen',
      category: 'View',
      icon: L.Fullscreen,
      keys: ['F11'],
      run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()),
    });

    // ---------- Tools ----------
    for (const t of app.tools.list) {
      if (t.id === 'transform') continue;
      a({ id: `tool.${t.id}`, title: `${t.name} tool`, category: 'Tools', icon: t.icon, keys: t.key ? [t.key] : undefined, keywords: t.hint, run: () => app.selectTool(t.id) });
    }

    // ---------- Help ----------
    a({ id: 'help.palette', title: 'Search commands', category: 'Help', icon: L.Search, keys: ['Ctrl+K', 'Ctrl+Shift+P'], global: true, run: () => openPalette(app) });
    a({ id: 'help.shortcuts', title: 'Keyboard shortcuts', category: 'Help', icon: L.Keyboard, keys: ['Ctrl+/', 'F1'], run: () => showShortcuts(app) });
    a({ id: 'help.whatsNew', title: "What's new", category: 'Help', icon: L.Sparkles, run: () => app.updates.showWhatsNew() });
    a({ id: 'help.updates', title: 'Check for updates…', category: 'Help', icon: L.RefreshCw, run: () => app.updates.check(false) });
    a({ id: 'help.about', title: 'About Pixelline', category: 'Help', icon: L.Info, run: () => showAbout(app) });
    a({ id: 'help.devtools', title: 'Developer tools', category: 'Help', keys: ['Ctrl+Alt+Shift+I'], hidden: true, run: () => platform.toggleDevTools() });
  }
}

function togglePref(app: App, key: 'pixelGrid' | 'tileMode' | 'mirrorX' | 'mirrorY', label: string): void {
  app.prefs[key] = !app.prefs[key];
  app.savePrefs();
  app.view.draw();
  app.toolbar.refresh();
  app.statusbar.flash(`${label}: ${app.prefs[key] ? 'on' : 'off'}`);
  if (key === 'tileMode' && app.view.view.fitted) app.view.fit();
}

function cycleTab(app: App, dir: 1 | -1): void {
  if (app.tabs.length < 2 || !app.tab) return;
  const i = app.tabs.indexOf(app.tab);
  app.switchTab(app.tabs[(i + dir + app.tabs.length) % app.tabs.length]);
}

function filterIcon(f: FilterDef): IconNode | undefined {
  const icons: Record<string, IconNode> = {
    brightnessContrast: L.SunMedium,
    levels: L.ChartNoAxesColumn,
    hueSaturation: L.Droplet,
    colorBalance: L.Scale,
    exposure: L.Aperture,
    vibrance: L.Sparkle,
    invert: L.Contrast,
    grayscale: L.Eclipse,
    posterize: L.Layers2,
    threshold: L.SquareSplitHorizontal,
    gaussianBlur: L.Droplets,
    boxBlur: L.Droplets,
    motionBlur: L.Wind,
    unsharpMask: L.Focus,
    addNoise: L.Sparkles,
    median: L.Eraser,
    emboss: L.Mountain,
    edges: L.ScanLine,
    vignette: L.CircleDot,
    pixelate: L.Grid3x3,
    outline: L.SquareDashedBottom,
    colorToAlpha: L.Pipette,
    offset: L.Move,
    seamless: L.Repeat,
  };
  return icons[f.id];
}
