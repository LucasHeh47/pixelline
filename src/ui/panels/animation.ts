// The Animation panel: for animated textures (frames stacked top to bottom, like Minecraft's). It
// plays the frames, adds, copies, moves and deletes them, sets the timing that goes in the
// .png.mcmeta saved next to the PNG, and turns on onion skin (the previous frame shown faintly).
import * as L from 'lucide';
import { DEFAULT_ANIMATION, deleteFrame, frameCount, frameRect, insertFrame, mcmetaText, moveFrame, setAnimation } from '../../core/animation';
import type { AnimationMeta, Edit } from '../../core/document';
import type { App } from '../app';
import { toggle } from '../controls';
import { h, icon } from '../dom';
import { platform } from '../platform';
import { toast, tooltip } from '../widgets';

export class AnimationPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private canvas: HTMLCanvasElement;
  private label: HTMLElement;
  private playBtn: HTMLButtonElement;
  /** The frame being shown and edited. */
  frame = 0;
  private playing = true;
  private started = 0;
  private raf = 0;
  visible = false;

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'anim-canvas' }) as HTMLCanvasElement;
    this.label = h('span', { class: 'anim-label' });
    this.playBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Play or pause', onclick: () => this.setPlaying(!this.playing) }) as HTMLButtonElement;
    this.body = h('div', { class: 'anim-body' });
    this.el = h('div', { class: 'animation-panel' }, this.body);
  }

  private meta(): AnimationMeta | undefined {
    return this.app.doc?.meta.animation;
  }

  private setMeta(m: Partial<AnimationMeta>, label = 'Animation settings'): void {
    const doc = this.app.doc;
    const cur = this.meta();
    if (!doc || !cur) return;
    doc.edit(label, (e) => setAnimation(doc, e, { ...cur, ...m }));
  }

  render(): void {
    const doc = this.app.doc;
    const meta = this.meta();
    this.stop();
    if (!doc) {
      this.body.replaceChildren(h('div', { class: 'hint' }, 'Open an image to animate it.'));
      return;
    }
    if (!meta) {
      const square = doc.height % doc.width === 0 && doc.height > doc.width;
      this.body.replaceChildren(
        h('p', { class: 'hint anim-intro' }, 'Animated textures keep their frames stacked top to bottom in one image, like Minecraft’s water or lava.', square ? ` This image fits ${doc.height / doc.width} frames.` : ''),
        h('button', { class: 'btn outline', onclick: () => this.enable() }, icon(L.Film, 15), 'Make this an animation'),
      );
      return;
    }
    const count = frameCount(doc);
    this.frame = Math.min(this.frame, count - 1);
    const num = (value: number, min: number, max: number, onChange: (v: number) => void, title: string) => {
      const input = h('input', { class: 'input anim-num', type: 'number', min, max, value: String(value), 'aria-label': title }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || min)));
        input.value = String(v);
        onChange(v);
      });
      tooltip(input, title);
      return input;
    };
    const btn = (ic: L.IconNode, title: string, run: () => void, disabled = false) => {
      const b = h('button', { class: 'btn icon-only', 'aria-label': title, onclick: run }, icon(ic, 15)) as HTMLButtonElement;
      b.disabled = disabled;
      tooltip(b, title);
      return b;
    };
    const seconds = (meta.frametime / 20).toFixed(2).replace(/0$/, '');
    this.body.replaceChildren(
      this.canvas,
      h(
        'div',
        { class: 'anim-row' },
        btn(L.SkipBack, 'Previous frame', () => this.goTo(this.frame - 1)),
        this.playBtn,
        btn(L.SkipForward, 'Next frame', () => this.goTo(this.frame + 1)),
        this.label,
      ),
      h(
        'div',
        { class: 'anim-row' },
        btn(L.Plus, 'Add an empty frame after this one', () => this.edit('Add frame', (e) => insertFrame(doc, e, this.frame, false), 1)),
        btn(L.CopyPlus, 'Duplicate this frame', () => this.edit('Duplicate frame', (e) => insertFrame(doc, e, this.frame, true), 1)),
        btn(L.ArrowUp, 'Move this frame earlier', () => this.edit('Move frame', (e) => moveFrame(doc, e, this.frame, this.frame - 1), -1), this.frame === 0),
        btn(L.ArrowDown, 'Move this frame later', () => this.edit('Move frame', (e) => moveFrame(doc, e, this.frame, this.frame + 1), 1), this.frame === count - 1),
        h('span', { class: 'spacer' }),
        btn(L.Trash2, 'Delete this frame', () => this.edit('Delete frame', (e) => deleteFrame(doc, e, this.frame), 0), count < 2),
      ),
      h(
        'label',
        { class: 'anim-field' },
        h('span', null, 'Frame time'),
        num(meta.frametime, 1, 200, (v) => this.setMeta({ frametime: v }, 'Frame time'), 'How long each frame shows, in game ticks (20 per second)'),
        h('span', { class: 'hint' }, `ticks · ${seconds} s`),
      ),
      h(
        'label',
        { class: 'anim-field' },
        h('span', null, 'Frame height'),
        num(meta.frameHeight, 1, doc.height, (v) => this.setMeta({ frameHeight: v }, 'Frame height'), 'Height of one frame in pixels (Minecraft: the same as the width)'),
        h('span', { class: 'hint' }, 'px'),
      ),
      toggle('Blend between frames', meta.interpolate, (v) => this.setMeta({ interpolate: v }), 'Minecraft’s "interpolate": frames fade into each other'),
      toggle('Onion skin', this.app.prefs.onionSkin, (v) => {
        this.app.prefs.onionSkin = v;
        this.app.savePrefs();
        this.app.view.draw();
      }, 'Shows the previous frame faintly over each frame, to line up movement'),
      h(
        'div',
        { class: 'anim-row' },
        h('button', { class: 'btn text small', onclick: () => {
          void platform.writeClipboardText(mcmetaText(meta, doc.width));
          toast('Copied the .mcmeta text.');
        } }, icon(L.Copy, 13), 'Copy .mcmeta'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn text small', onclick: () => doc.edit('Not animated', (e) => setAnimation(doc, e, null)) }, 'Not animated'),
      ),
      h('p', { class: 'hint anim-note' }, 'Saving as PNG also saves the .png.mcmeta next to it.'),
    );
    this.updateLabel();
    this.start();
  }

  private enable(): void {
    const doc = this.app.doc;
    if (!doc) return;
    const fh = doc.height > doc.width && doc.height % doc.width === 0 ? doc.width : doc.height;
    doc.edit('Make an animation', (e) => setAnimation(doc, e, { ...DEFAULT_ANIMATION, frameHeight: fh }));
    this.frame = 0;
    this.render();
  }

  /** A frame edit, then the frame to show next (relative to the current one). */
  private edit(label: string, fn: (e: Edit) => void, step: number): void {
    const doc = this.app.doc;
    if (!doc) return;
    this.app.commitTool();
    doc.edit(label, fn);
    this.goTo(this.frame + step);
  }

  /** A click on the canvas at image row y: that frame becomes the current one. */
  pointerAt(y: number): void {
    const doc = this.app.doc;
    if (!doc || !this.meta()) return;
    const count = frameCount(doc);
    const f = Math.max(0, Math.min(count - 1, Math.floor(y / this.meta()!.frameHeight)));
    if (this.playing) this.setPlaying(false);
    if (f !== this.frame) {
      this.frame = f;
      this.updateLabel();
      this.app.view.draw();
    }
  }

  /** Shows a frame (and scrolls the canvas to it). */
  goTo(i: number): void {
    const doc = this.app.doc;
    if (!doc || !this.meta()) return;
    const count = frameCount(doc);
    this.frame = (i + count) % count;
    this.setPlaying(false);
    const r = frameRect(doc, this.frame);
    const v = this.app.view.visibleRect();
    // Scroll to the frame if it's off screen (not before the canvas has a size)
    if (this.app.view.width > 100 && (r.y < v.y || r.y + r.h > v.y + v.h)) this.app.view.centreOn(r.x + r.w / 2, r.y + r.h / 2);
    this.app.view.draw();
    this.draw();
  }

  private setPlaying(on: boolean): void {
    this.playing = on;
    this.started = performance.now();
    this.playBtn.replaceChildren(icon(on ? L.Pause : L.Play, 15));
    tooltip(this.playBtn, on ? 'Pause' : 'Play');
    this.updateLabel();
  }

  private updateLabel(): void {
    const doc = this.app.doc;
    if (!doc) return;
    this.label.textContent = `Frame ${this.frame + 1} of ${frameCount(doc)}`;
  }

  private start(): void {
    this.setPlaying(this.playing);
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (!this.visible || !this.canvas.isConnected) return;
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** The image changed: the preview shows it on the next frame anyway; the frame count may have changed. */
  sizeChanged(): void {
    this.render();
  }

  private draw(): void {
    const doc = this.app.doc;
    const meta = this.meta();
    if (!doc || !meta) return;
    const count = frameCount(doc);
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    if (this.canvas.width !== Math.round(cw * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    // Which frame (and how far into it) at this moment
    let frame = this.frame;
    let t = 0;
    if (this.playing && count > 1) {
      const ms = meta.frametime * 50;
      const pos = (performance.now() - this.started) / ms;
      frame = Math.floor(pos) % count;
      t = pos - Math.floor(pos);
      if (frame !== this.frame) {
        this.frame = frame;
        this.updateLabel();
      }
    }
    const fh = meta.frameHeight;
    const s0 = Math.min((cw - 8) / doc.width, (ch - 8) / fh);
    const s = s0 >= 1 ? Math.floor(s0) : s0;
    const w = doc.width * s;
    const hh = fh * s;
    const x = (cw - w) / 2;
    const y = (ch - hh) / 2;
    const sq = 6;
    g.save();
    g.beginPath();
    g.rect(x, y, w, hh);
    g.clip();
    for (let yy = 0; yy < hh; yy += sq)
      for (let xx = 0; xx < w; xx += sq) {
        g.fillStyle = (Math.floor(xx / sq) + Math.floor(yy / sq)) % 2 ? '#d5d8de' : '#f5f6f8';
        g.fillRect(x + xx, y + yy, sq, sq);
      }
    g.imageSmoothingEnabled = false;
    const src = this.app.view.composited;
    g.drawImage(src, 0, frame * fh, doc.width, fh, x, y, w, hh);
    if (meta.interpolate && this.playing && count > 1) {
      g.globalAlpha = t;
      g.drawImage(src, 0, ((frame + 1) % count) * fh, doc.width, fh, x, y, w, hh);
      g.globalAlpha = 1;
    }
    g.restore();
  }
}
