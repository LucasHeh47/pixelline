// Colour picking: a saturation/brightness square, hue and opacity strips, hex and RGB boxes. Used by
// the Color panel and the pop-up picker on the tool bar's colour squares.
import * as L from 'lucide';
import { cssColor, hsvToRgb, parseHex, rgbToHsv, sameColor, toHex, type RGBA } from '../../core/color';
import { makeRamp } from '../../core/ink';
import type { App } from '../app';
import { h, icon } from '../dom';
import { Popover, tooltip } from '../widgets';

export class ColorPicker {
  readonly el: HTMLElement;
  private sv: HTMLCanvasElement;
  private hue: HTMLCanvasElement;
  private alpha: HTMLCanvasElement;
  private hex: HTMLInputElement;
  private rgb: HTMLInputElement[];
  private h = 0;
  private s = 0;
  private v = 0;
  private a = 255;
  /** Starts impossible so the first set() always fills the boxes. */
  private color: RGBA = { r: -1, g: -1, b: -1, a: -1 };

  constructor(private onChange: (c: RGBA, done: boolean) => void) {
    this.sv = h('canvas', { class: 'cp-sv' }) as HTMLCanvasElement;
    this.hue = h('canvas', { class: 'cp-strip' }) as HTMLCanvasElement;
    this.alpha = h('canvas', { class: 'cp-strip' }) as HTMLCanvasElement;
    this.hex = h('input', { class: 'input cp-hex', spellcheck: false, 'aria-label': 'Hex colour' }) as HTMLInputElement;
    this.hex.addEventListener('change', () => {
      const c = parseHex(this.hex.value);
      if (c) this.pick(c, true);
      else this.sync();
    });
    this.rgb = ['R', 'G', 'B', 'A'].map((label, i) => {
      const input = h('input', { class: 'input cp-num', type: 'number', min: 0, max: label === 'A' ? 100 : 255, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Math.max(0, Math.min(Number(input.max), Math.round(Number(input.value) || 0)));
        const c = { ...this.color };
        if (i === 0) c.r = v;
        else if (i === 1) c.g = v;
        else if (i === 2) c.b = v;
        else c.a = Math.round((v / 100) * 255);
        this.pick(c, true);
      });
      return input;
    });
    const nums = h('div', { class: 'cp-nums' }, this.hex, ...this.rgb.map((inp, i) => h('label', { class: 'cp-numwrap' }, h('span', null, ['R', 'G', 'B', 'A%'][i]), inp)));
    this.el = h('div', { class: 'color-picker' }, this.sv, this.hue, this.alpha, nums);
    this.drag(this.sv, (x, y, done) => {
      this.s = x;
      this.v = 1 - y;
      this.emit(done);
    });
    this.drag(this.hue, (x, _y, done) => {
      this.h = x * 360;
      this.emit(done);
    });
    this.drag(this.alpha, (x, _y, done) => {
      this.a = Math.round(x * 255);
      this.emit(done);
    });
    new ResizeObserver(() => this.draw()).observe(this.sv);
  }

  /** Shows a colour (keeps the hue when the colour is grey). */
  set(c: RGBA): void {
    if (sameColor(c, this.color)) return;
    this.color = { ...c };
    const hsv = rgbToHsv(c);
    if (hsv.s > 0 && hsv.v > 0) this.h = hsv.h;
    this.s = hsv.s;
    this.v = hsv.v;
    this.a = c.a;
    this.sync();
  }

  private pick(c: RGBA, done: boolean): void {
    this.set(c);
    this.onChange({ ...this.color }, done);
  }

  private emit(done: boolean): void {
    this.color = hsvToRgb(this.h, this.s, this.v, this.a);
    this.sync();
    this.onChange({ ...this.color }, done);
  }

  private sync(): void {
    if (document.activeElement !== this.hex) this.hex.value = toHex(this.color).slice(1);
    const vals = [this.color.r, this.color.g, this.color.b, Math.round((this.color.a / 255) * 100)];
    this.rgb.forEach((inp, i) => {
      if (document.activeElement !== inp) inp.value = String(vals[i]);
    });
    this.draw();
  }

  private drag(el: HTMLCanvasElement, fn: (x: number, y: number, done: boolean) => void): void {
    const at = (e: PointerEvent, done: boolean) => {
      const r = el.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), done);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      at(e, false);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) at(e, false);
    });
    el.addEventListener('pointerup', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      at(e, true);
    });
  }

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const hh = Math.round(c.clientHeight * dpr);
    if (!w || !hh) return null;
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    return c.getContext('2d');
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    // Saturation (across) and brightness (down)
    const g = this.fit(this.sv);
    if (g) {
      const { width: w, height: hh } = this.sv;
      g.fillStyle = cssColor(hsvToRgb(this.h, 1, 1));
      g.fillRect(0, 0, w, hh);
      const white = g.createLinearGradient(0, 0, w, 0);
      white.addColorStop(0, '#fff');
      white.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = white;
      g.fillRect(0, 0, w, hh);
      const black = g.createLinearGradient(0, 0, 0, hh);
      black.addColorStop(0, 'rgba(0,0,0,0)');
      black.addColorStop(1, '#000');
      g.fillStyle = black;
      g.fillRect(0, 0, w, hh);
      ring(g, this.s * w, (1 - this.v) * hh, 6 * dpr, this.v > 0.55 && this.s < 0.5);
    }
    const hg = this.fit(this.hue);
    if (hg) {
      const { width: w, height: hh } = this.hue;
      const grad = hg.createLinearGradient(0, 0, w, 0);
      for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, cssColor(hsvToRgb(i * 60, 1, 1)));
      hg.fillStyle = grad;
      hg.fillRect(0, 0, w, hh);
      bar(hg, (this.h / 360) * w, hh, dpr);
    }
    const ag = this.fit(this.alpha);
    if (ag) {
      const { width: w, height: hh } = this.alpha;
      const sq = Math.round(5 * dpr);
      for (let y = 0; y < hh; y += sq) for (let x = 0; x < w; x += sq) {
        ag.fillStyle = ((x + y) / sq) % 2 ? '#c8ccd2' : '#f4f5f7';
        ag.fillRect(x, y, sq, sq);
      }
      const c = this.color;
      const grad = ag.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0)`);
      grad.addColorStop(1, `rgb(${c.r},${c.g},${c.b})`);
      ag.fillStyle = grad;
      ag.fillRect(0, 0, w, hh);
      bar(ag, (this.a / 255) * w, hh, dpr);
    }
  }
}

function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number, dark: boolean): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = dark ? '#000' : '#fff';
  g.stroke();
}

function bar(g: CanvasRenderingContext2D, x: number, hh: number, dpr: number): void {
  const w = 4 * dpr;
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = '#000';
  g.strokeRect(x - w / 2, 1, w, hh - 2);
  g.strokeStyle = '#fff';
  g.strokeRect(x - w / 2 + dpr, 1 + dpr, w - 2 * dpr, hh - 2 - 2 * dpr);
}

/** The Color panel: which colour is being edited, the picker and recent colours. */
export class ColorPanel {
  readonly el: HTMLElement;
  private picker: ColorPicker;
  private target: 'fg' | 'bg' = 'fg';
  private fgBtn: HTMLButtonElement;
  private bgBtn: HTMLButtonElement;
  private recent: HTMLElement;
  private ramp: HTMLElement;

  constructor(private app: App) {
    this.picker = new ColorPicker((c, done) => {
      app.colors[this.target] = c;
      if (done) app.setColor(this.target, c);
      else {
        app.toolbar.refreshColors();
        this.refreshTargets();
      }
    });
    const target = (which: 'fg' | 'bg', label: string) => {
      const b = h('button', { class: 'cp-target', 'aria-label': label, onclick: () => {
        this.target = which;
        this.refresh();
      } }, h('span', { class: 'cp-target-swatch' }), h('span', null, label)) as HTMLButtonElement;
      return b;
    };
    this.fgBtn = target('fg', 'Primary');
    this.bgBtn = target('bg', 'Secondary');
    const swap = h('button', { class: 'btn icon-only', 'aria-label': 'Swap colours', onclick: () => app.swapColors() }, icon(L.ArrowLeftRight, 14));
    tooltip(swap, 'Swap colours', 'X');
    this.recent = h('div', { class: 'swatch-row recent' });
    this.ramp = h('div', { class: 'swatch-row ramp' });
    const screen = h('button', { class: 'btn icon-only', 'aria-label': 'Pick a colour from the screen', onclick: () => void this.pickFromScreen() }, icon(L.Pipette, 14));
    tooltip(screen, 'Pick a colour from anywhere on the screen (another app, a reference picture…)');
    screen.hidden = !('EyeDropper' in window);
    const rampHead = h('div', { class: 'panel-sub with-action' }, h('span', null, 'Shades'), h('button', { class: 'btn text small', onclick: () => app.panels.swatches.addRamp(this.app.colors[this.target]) }, icon(L.Plus, 12), 'Add to palette'));
    tooltip(rampHead.lastElementChild as HTMLElement, 'Adds these shades to the Swatches palette');
    this.el = h(
      'div',
      { class: 'color-panel' },
      h('div', { class: 'cp-targets' }, this.fgBtn, swap, this.bgBtn, screen),
      this.picker.el,
      rampHead,
      this.ramp,
      h('div', { class: 'panel-sub' }, 'Recent'),
      this.recent,
    );
    this.refresh();
  }

  /** The system eyedropper: picks a colour anywhere on screen. */
  private async pickFromScreen(): Promise<void> {
    const Picker = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!Picker) return;
    try {
      const r = await new Picker().open();
      const c = parseHex(r.sRGBHex);
      if (c) this.app.setColor(this.target, c);
    } catch {
      // cancelled with Esc
    }
  }

  private refreshTargets(): void {
    const c = this.app.colors;
    this.fgBtn.classList.toggle('on', this.target === 'fg');
    this.bgBtn.classList.toggle('on', this.target === 'bg');
    (this.fgBtn.firstChild as HTMLElement).style.setProperty('--swatch', cssColor(c.fg));
    (this.bgBtn.firstChild as HTMLElement).style.setProperty('--swatch', cssColor(c.bg));
  }

  refresh(): void {
    this.picker.set(this.app.colors[this.target]);
    this.refreshTargets();
    // Darker and lighter shades of the colour, hue-shifted like pixel-art ramps
    const ramp = makeRamp(this.app.colors[this.target], 7);
    this.ramp.replaceChildren(...ramp.map((c, i) => {
      const el = swatch(this.app, toHex(c));
      if (i === 3) el.classList.add('current');
      return el;
    }));
    const list = this.app.prefs.recentColors;
    this.recent.replaceChildren(
      ...(list.length
        ? list.map((hex) => swatch(this.app, hex))
        : [h('span', { class: 'hint' }, 'Colours you paint with show up here.')]),
    );
  }
}

/** A clickable colour square: left-click sets the primary colour, right-click the secondary. */
export function swatch(app: App, hex: string, extra?: (e: MouseEvent) => void): HTMLElement {
  const c = parseHex(hex);
  const el = h('button', { class: 'swatch', 'aria-label': hex });
  el.style.setProperty('--swatch', c ? cssColor(c) : 'transparent');
  el.addEventListener('click', () => c && app.setColor('fg', c));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (extra) extra(e);
    else if (c) app.setColor('bg', c);
  });
  tooltip(el, `${hex} — click: primary colour, right-click: secondary`);
  return el;
}

let popover: Popover | null = null;

/** The pop-up picker for a tool bar colour square. */
export function openColorPicker(app: App, which: 'fg' | 'bg', anchor: HTMLElement): void {
  if (popover?.isOpen) {
    popover.close();
    return;
  }
  const picker = new ColorPicker((c, done) => {
    app.colors[which] = c;
    if (done) app.setColor(which, c);
    else app.toolbar.refreshColors();
  });
  const box = h('div', { class: 'cp-popover' }, h('div', { class: 'panel-sub' }, which === 'fg' ? 'Primary colour' : 'Secondary colour'), picker.el);
  popover = new Popover(box, anchor, 'cp-pop');
  popover.open(anchor, 'right');
  picker.set(app.colors[which]);
}
