// The Swatches panel: a palette's colours to paint with. Built-in pixel-art palettes, palettes of
// your own (made from an image, imported from .gpl/.pal/.hex files, or added to colour by colour).
import * as L from 'lucide';
import { flatten } from '../../core/blend';
import { toHex, type RGBA } from '../../core/color';
import { matchRegion } from '../../core/fill';
import { setSelection } from '../../core/ops';
import { parsePalette, serializePalette, type Palette, type PaletteFormat } from '../../core/palettes';
import { makePalette, uniqueColors } from '../../core/quantize';
import type { App } from '../app';
import { h, icon } from '../dom';
import { makeRamp } from '../../core/ink';
import { debounce } from '../dom';
import { allPalettes, currentPalette, deleteUserPalette, IMAGE_PALETTE, isBuiltin, saveUserPalette } from '../paletteStore';
import { platform } from '../platform';
import { promptDialog, showMenu, toast, tooltip } from '../widgets';
import { swatch } from './color';

export class SwatchesPanel {
  readonly el: HTMLElement;
  private select: HTMLSelectElement;
  private grid: HTMLElement;

  constructor(private app: App) {
    this.select = h('select', { class: 'input sw-select', 'aria-label': 'Palette' }) as HTMLSelectElement;
    this.select.addEventListener('change', () => {
      app.prefs.palette = this.select.value;
      app.savePrefs();
      this.render();
    });
    const add = h('button', { class: 'btn icon-only', 'aria-label': 'Add the primary colour', onclick: () => this.addColor(app.colors.fg) }, icon(L.Plus, 15));
    tooltip(add, 'Add the primary colour to this palette');
    const more = h('button', { class: 'btn icon-only', 'aria-label': 'Palette options', onclick: (e: MouseEvent) => this.menu(e.currentTarget as HTMLElement) }, icon(L.Ellipsis, 15));
    tooltip(more, 'New, import, export…');
    this.grid = h('div', { class: 'swatch-grid' });
    this.el = h('div', { class: 'swatches-panel' }, h('div', { class: 'sw-head' }, this.select, add, more), this.grid);
    this.render();
  }

  render(): void {
    const app = this.app;
    const pals = allPalettes(app);
    const cur = currentPalette(app);
    const image = cur.name === IMAGE_PALETTE;
    this.select.replaceChildren(
      h('option', { value: IMAGE_PALETTE }, image ? `${IMAGE_PALETTE} (${cur.colors.length})` : IMAGE_PALETTE),
      h('option', { disabled: true }, '──────────'),
      ...pals.map((p) => h('option', { value: p.name }, `${p.name} (${p.colors.length})`)),
    );
    this.select.value = cur.name;
    this.grid.replaceChildren(
      ...cur.colors.map((c, i) => swatch(app, toHex(c), (e) => this.swatchMenu(c, i, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY }))),
    );
    if (!cur.colors.length)
      this.grid.append(
        h(
          'span',
          { class: 'hint' },
          image ? (app.doc ? 'This image has more than 256 colours (a photo?), so they aren’t listed.' : 'Open an image to see its colours.') : 'Empty palette. Press + to add the primary colour.',
        ),
      );
  }

  /** The image changed: "Colours in this image" catches up (a moment later, not on every stroke). */
  imageChanged = debounce(() => {
    if (this.app.prefs.palette === IMAGE_PALETTE) this.render();
  }, 400);

  /** Adds a shading ramp of a colour (dark to light) to the palette. */
  addRamp(c: RGBA): void {
    const p = this.editable();
    const have = new Set(p.colors.map((x) => toHex(x)));
    const ramp = makeRamp(c, 7).filter((x) => !have.has(toHex(x)));
    if (!ramp.length) {
      toast('Those shades are already in the palette.');
      return;
    }
    saveUserPalette(this.app, { name: p.name, colors: [...p.colors, ...ramp] });
    this.render();
    toast(`Added ${ramp.length} shades to "${p.name}".`);
  }

  /** Makes the current palette editable: a built-in one is copied to your palettes first. */
  private editable(): Palette {
    const cur = currentPalette(this.app);
    if (!isBuiltin(cur.name)) return cur;
    const name = saveUserPalette(this.app, { name: cur.name, colors: [...cur.colors] });
    this.app.prefs.palette = name;
    this.app.savePrefs();
    toast(`Built-in palettes don't change, so this is now "${name}", your own copy.`);
    return currentPalette(this.app);
  }

  private addColor(c: RGBA): void {
    const p = this.editable();
    const hex = toHex(c);
    if (p.colors.some((x) => toHex(x) === hex)) {
      toast(`${hex} is already in the palette.`);
      return;
    }
    saveUserPalette(this.app, { name: p.name, colors: [...p.colors, c] });
    this.render();
  }

  private swatchMenu(c: RGBA, index: number, at: { left: number; top: number; right: number; bottom: number }): void {
    const app = this.app;
    const doc = app.doc;
    showMenu(
      [
        { label: 'Use as primary colour', swatch: toHex(c), run: () => app.setColor('fg', c) },
        { label: 'Use as secondary colour', run: () => app.setColor('bg', c) },
        { separator: true },
        {
          label: 'Select this colour on the layer',
          icon: L.Pipette,
          disabled: !doc,
          run: () => {
            const d = app.doc!;
            const data = d.active.read(d.bounds);
            // Any pixel of the colour, wherever it is: start from a pixel that has it
            let start = -1;
            for (let i = 0; i < data.length; i += 4)
              if (data[i] === c.r && data[i + 1] === c.g && data[i + 2] === c.b && data[i + 3] > 0) {
                start = i / 4;
                break;
              }
            if (start < 0) return toast(`${toHex(c)} isn't on this layer.`);
            const m = matchRegion(data, d.width, d.height, start % d.width, Math.floor(start / d.width), { tolerance: 0, contiguous: false, diagonal: false });
            d.edit('Select colour', (e) => setSelection(d, e, m));
          },
        },
        { separator: true },
        {
          label: 'Remove from palette',
          icon: L.Trash2,
          run: () => {
            const p = this.editable();
            saveUserPalette(app, { name: p.name, colors: p.colors.filter((_, i) => i !== index) });
            this.render();
          },
        },
      ],
      at,
    );
  }

  private menu(anchor: HTMLElement): void {
    const app = this.app;
    const cur = currentPalette(app);
    const user = !isBuiltin(cur.name);
    showMenu(
      [
        {
          label: 'New palette from the image',
          icon: L.ImageDown,
          disabled: !app.doc,
          run: () => void this.fromImage(),
        },
        { label: 'New empty palette', icon: L.Plus, run: () => void this.newEmpty() },
        { label: 'Add shades of the primary colour', icon: L.Blend, run: () => this.addRamp(app.colors.fg) },
        { separator: true },
        { label: 'Import palette…', icon: L.Upload, hint: '.gpl .pal .hex', run: () => void this.importFile() },
        {
          label: 'Export palette',
          icon: L.Download,
          submenu: () =>
            (
              [
                ['gpl', 'GIMP / Aseprite (.gpl)'],
                ['pal', 'JASC / Paint Shop Pro (.pal)'],
                ['hex', 'Lospec hex (.hex)'],
                ['txt', 'Paint.NET (.txt)'],
              ] as [PaletteFormat, string][]
            ).map(([f, label]) => ({ label, run: () => void this.exportFile(f) })),
        },
        { separator: true },
        { label: 'Rename palette…', disabled: !user, run: () => void this.rename() },
        {
          label: 'Delete palette',
          icon: L.Trash2,
          danger: true,
          disabled: !user,
          run: () => {
            deleteUserPalette(app, cur.name);
            this.render();
          },
        },
      ],
      anchor,
    );
  }

  private async fromImage(): Promise<void> {
    const doc = this.app.doc!;
    const data = flatten(doc).data;
    const unique = uniqueColors(data, 257);
    const colors = unique.length <= 256 ? unique : makePalette(data, 32);
    const name = await promptDialog('New palette', unique.length <= 256 ? `The image has ${unique.length} colours. Palette name:` : 'The image has many colours; the palette gets the 32 that represent it best. Palette name:', `${doc.name} colours`);
    if (!name) return;
    // Darkest first reads best
    colors.sort((a, b) => a.r * 0.3 + a.g * 0.59 + a.b * 0.11 - (b.r * 0.3 + b.g * 0.59 + b.b * 0.11));
    this.app.prefs.palette = saveUserPalette(this.app, { name, colors });
    this.app.savePrefs();
    this.render();
  }

  private async newEmpty(): Promise<void> {
    const name = await promptDialog('New palette', 'Palette name:', 'My palette');
    if (!name) return;
    this.app.prefs.palette = saveUserPalette(this.app, { name, colors: [] });
    this.app.savePrefs();
    this.render();
  }

  private async rename(): Promise<void> {
    const cur = currentPalette(this.app);
    const name = await promptDialog('Rename palette', 'New name:', cur.name, (v) => (!v.trim() ? 'Type a name.' : allPalettes(this.app).some((p) => p.name === v.trim() && p.name !== cur.name) ? 'There is already a palette with that name.' : null));
    if (!name || name === cur.name) return;
    deleteUserPalette(this.app, cur.name);
    this.app.prefs.palette = saveUserPalette(this.app, { name, colors: cur.colors });
    this.app.savePrefs();
    this.render();
  }

  private async importFile(): Promise<void> {
    const files = await platform.openFileDialog('palette', true);
    for (const f of files ?? []) this.importPalette(new TextDecoder().decode(f.data), f.name.replace(/\.[^.]+$/, ''));
  }

  /** Adds a palette from file text and shows it. */
  importPalette(text: string, name: string): void {
    try {
      const p = parsePalette(text, name);
      if (!p.colors.length) throw new Error('No colours found in the file.');
      this.app.prefs.palette = saveUserPalette(this.app, p);
      this.app.savePrefs();
      this.render();
      toast(`Added the palette "${this.app.prefs.palette}" (${p.colors.length} colours).`, { kind: 'success' });
    } catch (err) {
      toast(`Couldn't read the palette: ${(err as Error).message}`, { kind: 'error' });
    }
  }

  private async exportFile(format: PaletteFormat): Promise<void> {
    const p = currentPalette(this.app);
    const path = await platform.saveFileDialog(`${p.name}.${format}`, 'palette');
    if (!path) return;
    const r = await platform.saveFile(path, new TextEncoder().encode(serializePalette(p, format)));
    if (r.ok) toast(`Saved ${path.split(/[\\/]/).pop()}.`, { kind: 'success' });
    else toast(r.error ?? "Couldn't save the palette.", { kind: 'error' });
  }
}
