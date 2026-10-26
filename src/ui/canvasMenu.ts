// The canvas's right-click menu (for tools that don't paint with the right button): the things
// you'd do next with a selection or a layer, without hunting through the menus.
import * as L from 'lucide';
import type { App } from './app';
import { showMenu, type MenuItem } from './widgets';

export function openCanvasMenu(app: App, x: number, y: number): void {
  const doc = app.doc;
  if (!doc) return;
  const c = (id: string, label?: string): MenuItem => {
    const cmd = app.commands.get(id)!;
    return { label: label ?? cmd.title, icon: cmd.icon, hint: cmd.keys?.[0], checked: cmd.checked?.(), disabled: !app.commands.isEnabled(cmd), run: () => app.commands.run(id) };
  };
  const sel = !!doc.selection;
  const items: MenuItem[] = sel
    ? [
        c('edit.cut'),
        c('edit.copy'),
        c('edit.copyMerged'),
        c('edit.paste'),
        { separator: true },
        c('layer.duplicate', 'New layer from the selection'),
        c('layer.cut'),
        c('edit.transform', 'Transform the selection'),
        c('edit.fillFg'),
        c('edit.clear'),
        { separator: true },
        c('image.crop'),
        c('select.invert'),
        c('select.feather'),
        c('select.none'),
      ]
    : [
        c('edit.paste'),
        c('edit.copy', 'Copy the layer'),
        c('edit.copyMerged'),
        { separator: true },
        c('select.all'),
        c('select.layer'),
        c('select.reselect'),
        { separator: true },
        c('edit.transform'),
        { label: 'Transform layer', icon: L.RotateCw, submenu: () => [c('layer.flipH'), c('layer.flipV'), c('layer.rot90'), c('layer.rot270')] },
        { separator: true },
        c('layer.new'),
        c('layer.duplicate'),
        c('layer.props'),
      ];
  showMenu(items, { left: x, top: y, right: x, bottom: y });
}
