// The bar under the menus: the current tool's name and its options (size, opacity, mode…).
import type { App } from './app';
import { h, icon } from './dom';
import { tooltip } from './widgets';

export class OptionsBar {
  readonly el: HTMLElement;
  private toolName: HTMLElement;
  private body: HTMLElement;

  constructor(private app: App) {
    this.toolName = h('div', { class: 'ob-tool' });
    tooltip(this.toolName, () => app.tools.current.hint);
    this.body = h('div', { class: 'ob-body' });
    this.el = h('div', { class: 'optionsbar' }, this.toolName, this.body);
  }

  render(): void {
    const t = this.app.tools.current;
    // Keep keyboard focus if the user is typing in one of the boxes being replaced
    const focused = this.body.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute('aria-label') : null;
    this.toolName.replaceChildren(icon(t.icon, 16), h('span', null, t.name));
    const parts = (t.options?.() ?? []).filter((x): x is HTMLElement => !!x);
    this.body.replaceChildren(...parts);
    if (!parts.length) this.body.append(h('span', { class: 'ob-hint' }, t.hint));
    if (focused) (this.body.querySelector(`[aria-label="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }
}
