// New image: size presets for game textures (Minecraft blocks, items, skins), sprites, icons and photos.
import * as L from 'lucide';
import { newDocument, type Background } from '../../core/ops';
import type { App } from '../app';
import { h, icon } from '../dom';
import { dialog } from '../widgets';
import { field, numInput, numValue, row, select } from './common';

export interface SizePreset {
  name: string;
  w: number;
  h: number;
  /** Background suggested for it. */
  bg?: string;
  hint?: string;
}

export const PRESET_GROUPS: { name: string; icon: L.IconNode; presets: SizePreset[] }[] = [
  {
    name: 'Minecraft',
    icon: L.Box,
    presets: [
      { name: 'Block or item', w: 16, h: 16, bg: 'transparent', hint: 'Vanilla texture size' },
      { name: 'Block or item (32×)', w: 32, h: 32, bg: 'transparent', hint: '2× resource packs' },
      { name: 'Block or item (64×)', w: 64, h: 64, bg: 'transparent', hint: '4× resource packs' },
      { name: 'Block or item (128×)', w: 128, h: 128, bg: 'transparent' },
      { name: 'Player skin', w: 64, h: 64, bg: 'transparent', hint: 'Classic and slim skins' },
      { name: 'Pack icon (pack.png)', w: 128, h: 128, bg: 'transparent' },
      { name: 'GUI / container', w: 256, h: 256, bg: 'transparent' },
      { name: 'Painting 2×2 blocks', w: 32, h: 32, bg: 'white' },
      { name: 'Painting 4×4 blocks', w: 64, h: 64, bg: 'white' },
      { name: 'Animated texture (4 frames)', w: 16, h: 64, bg: 'transparent', hint: 'Frames stacked top to bottom' },
    ],
  },
  {
    name: 'Pixel art',
    icon: L.Grid3x3,
    presets: [
      { name: 'Tiny sprite', w: 8, h: 8, bg: 'transparent' },
      { name: 'Sprite', w: 16, h: 16, bg: 'transparent' },
      { name: 'Character', w: 32, h: 32, bg: 'transparent' },
      { name: 'Large sprite', w: 64, h: 64, bg: 'transparent' },
      { name: 'Tileset 8×8 of 16 px', w: 128, h: 128, bg: 'transparent' },
      { name: 'Game Boy screen', w: 160, h: 144, bg: 'white' },
      { name: 'PICO-8 screen', w: 128, h: 128, bg: 'black' },
      { name: 'Retro screen', w: 320, h: 180, bg: 'black' },
    ],
  },
  {
    name: 'Icons',
    icon: L.AppWindow,
    presets: [
      { name: 'Icon 32', w: 32, h: 32, bg: 'transparent' },
      { name: 'Icon 64', w: 64, h: 64, bg: 'transparent' },
      { name: 'Icon 256', w: 256, h: 256, bg: 'transparent' },
      { name: 'App icon 512', w: 512, h: 512, bg: 'transparent' },
      { name: 'App icon 1024', w: 1024, h: 1024, bg: 'transparent' },
    ],
  },
  {
    name: 'Photo & screen',
    icon: L.Image,
    presets: [
      { name: 'HD 1280×720', w: 1280, h: 720, bg: 'white' },
      { name: 'Full HD 1920×1080', w: 1920, h: 1080, bg: 'white' },
      { name: '4K 3840×2160', w: 3840, h: 2160, bg: 'white' },
      { name: 'Square post 1080', w: 1080, h: 1080, bg: 'white' },
      { name: 'Story 1080×1920', w: 1080, h: 1920, bg: 'white' },
      { name: 'Thumbnail 1280×720', w: 1280, h: 720, bg: 'white' },
      { name: 'A4 at 300 dpi', w: 2480, h: 3508, bg: 'white' },
      { name: 'Letter at 300 dpi', w: 2550, h: 3300, bg: 'white' },
    ],
  },
];

const BACKGROUNDS: [string, string][] = [
  ['transparent', 'Transparent'],
  ['white', 'White'],
  ['black', 'Black'],
  ['bg', 'Secondary colour'],
  ['fg', 'Primary colour'],
];

/** Creates a document from a size and a background choice. */
export function createImage(app: App, w: number, hh: number, bg: string, name = 'Untitled'): void {
  const background: Background = bg === 'bg' ? app.colors.bg : bg === 'fg' ? app.colors.fg : (bg as Background);
  const doc = newDocument(w, hh, background, name);
  if (w <= 128 && hh <= 128) doc.meta.grid = { size: Math.min(16, w, hh), show: false };
  app.prefs.lastNew = { width: w, height: hh, background: bg };
  app.savePrefs();
  app.newImage(doc);
}

export async function openNewImage(app: App, preset?: SizePreset): Promise<void> {
  const last = app.prefs.lastNew;
  const name = h('input', { class: 'input', value: 'Untitled', spellcheck: false }) as HTMLInputElement;
  name.style.width = '100%';
  const wIn = numInput(preset?.w ?? last.width, 1, 16384);
  const hIn = numInput(preset?.h ?? last.height, 1, 16384);
  const bg = select(BACKGROUNDS as [string, string][], preset?.bg ?? last.background);
  const info = h('div', { class: 'hint' });
  const showInfo = () => {
    const w = numValue(wIn, 16);
    const hh = numValue(hIn, 16);
    const mb = (w * hh * 4) / 1024 / 1024;
    info.textContent = `${w} × ${hh} pixels${mb >= 1 ? ` · ${mb.toFixed(1)} MB per layer` : ''}`;
  };
  wIn.addEventListener('input', showInfo);
  hIn.addEventListener('input', showInfo);
  const list = h('div', { class: 'preset-list' });
  for (const g of PRESET_GROUPS) {
    list.append(h('div', { class: 'preset-group' }, icon(g.icon, 14), g.name));
    for (const p of g.presets) {
      const b = h(
        'button',
        { class: 'preset', onclick: () => {
          wIn.value = String(p.w);
          hIn.value = String(p.h);
          if (p.bg) bg.value = p.bg;
          if (name.value === 'Untitled' || list.dataset.auto === name.value) {
            name.value = p.name.replace(/ \(.*\)$/, '');
            list.dataset.auto = name.value;
          }
          list.querySelectorAll('.preset.on').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          showInfo();
        } },
        h('span', { class: 'preset-name' }, p.name),
        h('span', { class: 'preset-size' }, `${p.w}×${p.h}`),
      );
      list.append(b);
    }
  }
  const swap = h('button', { class: 'btn icon-only', 'aria-label': 'Swap width and height', title: 'Swap width and height', onclick: () => {
    const t = wIn.value;
    wIn.value = hIn.value;
    hIn.value = t;
    showInfo();
  } }, icon(L.ArrowLeftRight, 15));
  showInfo();
  const body = h(
    'div',
    { class: 'new-image' },
    list,
    h(
      'div',
      { class: 'form new-image-form' },
      field('Name', name),
      row(field('Width', h('span', { class: 'field-inline' }, wIn, h('span', { class: 'hint' }, 'px'))), swap, field('Height', h('span', { class: 'field-inline' }, hIn, h('span', { class: 'hint' }, 'px')))),
      field('Background', bg),
      info,
    ),
  );
  setTimeout(() => wIn.focus(), 0);
  const ok = await dialog('New image', body, [
    { label: 'Create', value: true, primary: true },
    { label: 'Cancel', value: false },
  ], { wide: true });
  if (!ok) return;
  createImage(app, numValue(wIn, 16), numValue(hIn, 16), bg.value, name.value.trim() || 'Untitled');
}
