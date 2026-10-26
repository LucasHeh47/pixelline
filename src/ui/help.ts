// Keyboard shortcut reference and About dialog.
import type { App } from './app';
import { h, kbd } from './dom';
import { platform } from './platform';
import { dialog } from './widgets';

const MOUSE: [string, string][] = [
  ['Move around the image', 'Space+drag / middle-drag'],
  ['Zoom in and out', 'Mouse wheel'],
  ['Pick a colour with any paint tool', 'Alt+click'],
  ['Paint with the secondary colour', 'Right-click'],
  ['Draw a straight line', 'Shift+click'],
  ['Add to / subtract from a selection', 'Shift / Alt while selecting'],
  ['Nudge with the Move tool', 'Arrow keys (Shift: 10 px)'],
  ['Finish a transform, crop or lasso', 'Enter (Esc cancels)'],
];

export function showShortcuts(app: App): void {
  const table = h('div', { class: 'shortcut-table' });
  table.append(h('div', { class: 'cat' }, 'Mouse & canvas'));
  for (const [label, keys] of MOUSE) table.append(h('div', null, label), h('div', null, kbd(keys)));
  const byCat = new Map<string, { title: string; keys: string[] }[]>();
  for (const c of app.commands.all()) {
    if (!c.keys?.length) continue;
    const cat = c.category.startsWith('Filter') ? 'Filters' : c.category;
    const list = byCat.get(cat) ?? [];
    list.push({ title: c.title.replace(/…$/, ''), keys: c.keys });
    byCat.set(cat, list);
  }
  for (const [cat, list] of byCat) {
    table.append(h('div', { class: 'cat' }, cat));
    for (const c of list) table.append(h('div', null, c.title), h('div', null, ...c.keys.map((k) => kbd(k))));
  }
  const body = h('div', null, h('p', null, 'Every command is also searchable with Ctrl+K — no need to memorize these.'), table);
  void dialog('Keyboard shortcuts', body, [{ label: 'Close', value: true, primary: true }], { wide: true });
}

export async function showAbout(_app: App): Promise<void> {
  const version = await platform.appVersion();
  const body = h(
    'div',
    null,
    h('p', null, `Version ${version}${version.includes('-') ? ' (development build)' : ''}. An image editor for pixel art, game textures and photos.`),
    h('p', null, 'Layers with blend modes, selections, filters and adjustments, pixel-perfect drawing, seamless tile previews, palettes, colour reduction and pixel-art upscaling. Opens and saves PNG, JPEG, WebP, OpenRaster (.ora) and Photoshop (.psd) files.'),
    h('p', { class: 'hint' }, 'Part of the same family as Gridline.'),
  );
  await dialog('About Pixelline', body, [{ label: 'Close', value: true, primary: true }]);
}
