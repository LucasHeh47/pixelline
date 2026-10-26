// The History panel: every step since the image was opened. Click one to go back (or forward) to it.
import * as L from 'lucide';
import type { App } from '../app';
import { h, icon, scrollToChild } from '../dom';

export class HistoryPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = h('div', { class: 'hist-list', role: 'listbox', 'aria-label': 'History' });
    this.el = h('div', { class: 'history-panel' }, this.list);
  }

  render(): void {
    const doc = this.app.doc;
    if (!doc) {
      this.list.replaceChildren(h('div', { class: 'hint ly-empty' }, 'Steps you take show up here.'));
      return;
    }
    const { done, undone } = doc.history.entries();
    const row = (label: string, i: number, state: 'done' | 'current' | 'undone', ic: L.IconNode) => {
      const el = h('div', { class: `hist-row ${state}`, role: 'option', 'aria-selected': state === 'current' ? 'true' : 'false' }, icon(ic, 14), h('span', null, label));
      el.addEventListener('click', () => this.goTo(i));
      return el;
    };
    const rows: HTMLElement[] = [row('Opened', 0, done.length ? 'done' : 'current', L.Image)];
    done.forEach((label, k) => rows.push(row(label, k + 1, k === done.length - 1 ? 'current' : 'done', L.CornerDownRight)));
    undone.forEach((label, k) => rows.push(row(label, done.length + k + 1, 'undone', L.CornerDownRight)));
    this.list.replaceChildren(...rows);
    // Scroll only the list (scrollIntoView would scroll the whole panel column too)
    scrollToChild(this.list, this.list.querySelector<HTMLElement>('.hist-row.current'));
  }

  /** Undoes or redoes until `steps` steps are done. */
  private goTo(steps: number): void {
    const doc = this.app.doc;
    if (!doc) return;
    this.app.commitTool();
    let done = doc.history.entries().done.length;
    while (done > steps && doc.history.canUndo) {
      doc.undo();
      done--;
    }
    while (done < steps && doc.history.canRedo) {
      doc.redo();
      done++;
    }
  }
}
