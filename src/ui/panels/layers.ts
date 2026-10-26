// The Layers panel: thumbnails, show/hide, locks, opacity and blend mode, drag to reorder.
// Top layer first, like every image editor. Double-click a name to rename it.
import * as L from 'lucide';
import { BLEND_MODES, type BlendMode, type Layer } from '../../core/layer';
import { moveLayer, selectionFromAlpha, setLayerProps, setSelection } from '../../core/ops';
import type { App } from '../app';
import { slider } from '../controls';
import { h, icon } from '../dom';
import { openLayerProps } from '../dialogs/layerProps';
import { showMenu, tooltip, type MenuItem } from '../widgets';

const THUMB = 34;

export class LayersPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private blend: HTMLSelectElement;
  private opacity: HTMLElement & { setValue?: (v: number) => void };
  private thumbs = new Map<Layer, HTMLCanvasElement>();
  private dirtyThumbs = new Set<Layer>();
  private thumbTimer: ReturnType<typeof setTimeout> | undefined;
  private dragLayer: Layer | null = null;
  private lockBtn: HTMLButtonElement;
  private alphaBtn: HTMLButtonElement;

  constructor(private app: App) {
    this.blend = h('select', { class: 'input ly-blend', 'aria-label': 'Blend mode' }) as HTMLSelectElement;
    let group = 0;
    for (const b of BLEND_MODES) {
      if (b.group !== group) {
        this.blend.append(h('option', { disabled: true }, '──────'));
        group = b.group;
      }
      this.blend.append(h('option', { value: b.id }, b.label));
    }
    this.blend.addEventListener('change', () => this.setProp({ blend: this.blend.value as BlendMode }, 'Blend mode'));
    tooltip(this.blend, 'How the layer mixes with the layers below');
    let opacityEdit: { layer: Layer; from: number } | null = null;
    this.opacity = slider({
      label: 'Opacity',
      min: 0,
      max: 100,
      value: 100,
      unit: '%',
      width: 80,
      onInput: (v) => {
        // Live while dragging, one undo step at the end
        const l = app.doc?.active;
        if (!l) return;
        opacityEdit ??= { layer: l, from: l.opacity };
        l.opacity = v / 100;
        app.view.layersChanged();
      },
      onChange: (v) => {
        const doc = app.doc;
        if (!doc) return;
        const l = opacityEdit?.layer ?? doc.active;
        if (opacityEdit) l.opacity = opacityEdit.from;
        opacityEdit = null;
        if (Math.round(l.opacity * 100) !== v) doc.edit('Layer opacity', (e) => setLayerProps(doc, e, l, { opacity: v / 100 }));
        else app.view.layersChanged();
      },
    });
    this.lockBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Lock layer', onclick: () => this.setProp({ locked: !app.doc!.active.locked }, 'Lock layer') }, icon(L.Lock, 14)) as HTMLButtonElement;
    tooltip(this.lockBtn, 'Lock the layer (no painting or moving)');
    this.alphaBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Lock transparent pixels', onclick: () => this.setProp({ alphaLocked: !app.doc!.active.alphaLocked }, 'Lock transparent pixels') }, icon(L.Grid2x2Check, 14)) as HTMLButtonElement;
    tooltip(this.alphaBtn, 'Lock transparent pixels: paint only where the layer already has pixels', '/');
    this.list = h('div', { class: 'ly-list', role: 'listbox', 'aria-label': 'Layers' });
    this.list.addEventListener('dragover', (e) => {
      if (this.dragLayer) e.preventDefault();
    });
    const btn = (ic: L.IconNode, label: string, cmd: string) => {
      const b = h('button', { class: 'btn icon-only', 'aria-label': label, onclick: () => app.commands.run(cmd) }, icon(ic, 15));
      tooltip(b, label, app.commands.get(cmd)?.keys?.[0]);
      return b;
    };
    const foot = h(
      'div',
      { class: 'ly-foot' },
      btn(L.Plus, 'New layer', 'layer.new'),
      btn(L.Copy, 'Duplicate layer', 'layer.duplicate'),
      btn(L.ArrowDownToLine, 'Merge down', 'layer.mergeDown'),
      btn(L.SlidersHorizontal, 'Layer properties', 'layer.props'),
      h('div', { class: 'spacer' }),
      btn(L.Trash2, 'Delete layer', 'layer.delete'),
    );
    this.el = h('div', { class: 'layers-panel' }, h('div', { class: 'ly-head' }, this.blend, this.opacity, this.lockBtn, this.alphaBtn), this.list, foot);
  }

  private setProp(props: Parameters<typeof setLayerProps>[3], label: string): void {
    const doc = this.app.doc;
    if (!doc) return;
    doc.edit(label, (e) => setLayerProps(doc, e, doc.active, props));
  }

  render(): void {
    const doc = this.app.doc;
    this.el.classList.toggle('disabled', !doc);
    this.thumbs.clear();
    if (!doc) {
      this.list.replaceChildren(h('div', { class: 'hint ly-empty' }, 'Open or create an image to see its layers.'));
      return;
    }
    const active = doc.active;
    this.blend.value = active.blend;
    this.opacity.setValue?.(Math.round(active.opacity * 100));
    this.lockBtn.classList.toggle('on', active.locked);
    this.alphaBtn.classList.toggle('on', active.alphaLocked);
    this.list.replaceChildren(...[...doc.layers].reverse().map((l) => this.row(l, l === active)));
    for (const l of doc.layers) this.drawThumb(l);
  }

  private row(l: Layer, on: boolean): HTMLElement {
    const app = this.app;
    const doc = app.doc!;
    const eye = h('button', { class: `ly-eye${l.visible ? '' : ' off'}`, 'aria-label': l.visible ? 'Hide layer' : 'Show layer', onclick: (e: MouseEvent) => {
      e.stopPropagation();
      if (e.altKey) {
        // Alt+click: show only this layer (again to show them all)
        const others = doc.layers.filter((x) => x !== l);
        const solo = others.some((x) => x.visible);
        doc.edit(solo ? 'Show only this layer' : 'Show all layers', (ed) => {
          for (const x of others) setLayerProps(doc, ed, x, { visible: !solo });
          if (!l.visible) setLayerProps(doc, ed, l, { visible: true });
        });
      } else doc.edit(l.visible ? 'Hide layer' : 'Show layer', (ed) => setLayerProps(doc, ed, l, { visible: !l.visible }));
    } }, icon(l.visible ? L.Eye : L.EyeOff, 15));
    tooltip(eye, 'Show / hide (Alt+click: show only this layer)');
    const thumb = h('canvas', { class: 'ly-thumb', width: THUMB, height: THUMB }) as HTMLCanvasElement;
    this.thumbs.set(l, thumb);
    thumb.addEventListener('click', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Ctrl+click the thumbnail: select the layer's pixels
      e.stopPropagation();
      const m = selectionFromAlpha(doc, l);
      doc.edit('Select layer pixels', (ed) => setSelection(doc, ed, m.isEmpty() ? null : m));
    });
    const name = h('span', { class: 'ly-name' }, l.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.rename(l, name);
    });
    const badges = h(
      'span',
      { class: 'ly-badges' },
      l.blend !== 'normal' ? h('span', { class: 'ly-badge' }, BLEND_MODES.find((b) => b.id === l.blend)?.label ?? '') : null,
      l.opacity < 1 ? h('span', { class: 'ly-badge' }, `${Math.round(l.opacity * 100)}%`) : null,
      l.alphaLocked ? icon(L.Grid2x2Check, 13) : null,
      l.locked ? icon(L.Lock, 13) : null,
    );
    const row = h('div', { class: `ly-row${on ? ' on' : ''}${l.visible ? '' : ' hidden-layer'}`, role: 'option', 'aria-selected': on ? 'true' : 'false', draggable: 'true' }, eye, thumb, name, badges);
    row.addEventListener('click', () => doc.setActive(l.id));
    row.addEventListener('dblclick', (e) => {
      if (e.target === row || e.target === thumb) void openLayerProps(app, l);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      doc.setActive(l.id);
      this.menu({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
    });
    row.addEventListener('dragstart', (e) => {
      this.dragLayer = l;
      e.dataTransfer?.setData('text/x-pixelline-layer', l.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragLayer = null;
      row.classList.remove('dragging');
      this.list.querySelectorAll('.drop-above, .drop-below').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragLayer || this.dragLayer === l) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', (e) => {
      const moving = this.dragLayer;
      if (!moving) return;
      e.preventDefault();
      e.stopPropagation();
      const r = row.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      // The list is top-first; layers are bottom-first
      const from = doc.layers.indexOf(moving);
      let to = doc.layers.indexOf(l) + (above ? 1 : 0);
      if (from < to) to--;
      if (from !== to) doc.edit('Move layer', (ed) => moveLayer(doc, ed, moving, to));
    });
    return row;
  }

  private rename(l: Layer, el: HTMLElement): void {
    const doc = this.app.doc!;
    const input = h('input', { class: 'input ly-rename', value: l.name, spellcheck: false }) as HTMLInputElement;
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== l.name) doc.edit('Rename layer', (e) => setLayerProps(doc, e, l, { name: v }));
      else this.render();
      this.app.view.el.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private menu(at: { left: number; top: number; right: number; bottom: number }): void {
    const app = this.app;
    const c = (id: string, label?: string): MenuItem => {
      const cmd = app.commands.get(id)!;
      return { label: label ?? cmd.title, icon: cmd.icon, hint: cmd.keys?.[0], checked: cmd.checked?.(), disabled: !app.commands.isEnabled(cmd), run: () => app.commands.run(id) };
    };
    showMenu(
      [
        c('layer.props'),
        { separator: true },
        c('layer.new'),
        c('layer.duplicate'),
        c('layer.delete'),
        { separator: true },
        c('layer.mergeDown'),
        c('layer.mergeVisible'),
        c('layer.flatten'),
        { separator: true },
        c('select.layer'),
        c('layer.trim'),
        { separator: true },
        c('layer.lock'),
        c('layer.alphaLock'),
        { separator: true },
        c('layer.flipH'),
        c('layer.flipV'),
        c('layer.rot90'),
      ],
      at,
    );
  }

  /** A layer's pixels changed: its thumbnail is redrawn shortly. */
  pixelsChanged(l: Layer): void {
    this.dirtyThumbs.add(l);
    if (this.thumbTimer) return;
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = undefined;
      for (const x of this.dirtyThumbs) this.drawThumb(x);
      this.dirtyThumbs.clear();
    }, 120);
  }

  private drawThumb(l: Layer): void {
    const c = this.thumbs.get(l);
    const doc = this.app.doc;
    if (!c || !doc) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(THUMB * dpr);
    if (c.width !== size) {
      c.width = size;
      c.height = size;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, size, size);
    const s = Math.min(size / doc.width, size / doc.height);
    const w = doc.width * s;
    const hh = doc.height * s;
    const ox = (size - w) / 2;
    const oy = (size - hh) / 2;
    // Checkerboard behind the image area
    const sq = Math.max(2, Math.round(4 * dpr));
    g.save();
    g.beginPath();
    g.rect(ox, oy, w, hh);
    g.clip();
    for (let y = 0; y < size; y += sq) for (let x = 0; x < size; x += sq) {
      g.fillStyle = ((x + y) / sq) % 2 ? '#d5d8de' : '#f5f6f8';
      g.fillRect(x, y, sq, sq);
    }
    const lc = this.app.view.layerCanvas(l);
    if (lc) {
      g.imageSmoothingEnabled = s < 1;
      g.drawImage(lc, ox + l.x * s, oy + l.y * s, l.raster.width * s, l.raster.height * s);
    }
    g.restore();
  }
}
