// Layer properties: name, opacity, blend mode and locks, previewed live and applied as one undo step.
import { BLEND_MODES, type BlendMode, type Layer, type LayerProps } from '../../core/layer';
import { setLayerProps } from '../../core/ops';
import type { App } from '../app';
import { slider, toggle } from '../controls';
import { h } from '../dom';
import { dialog } from '../widgets';
import { field, select } from './common';

export async function openLayerProps(app: App, layer: Layer): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const before = layer.props();
  const next: LayerProps = { ...before };
  const preview = () => {
    layer.setProps(next);
    app.view.layersChanged();
  };
  const name = h('input', { class: 'input', value: before.name, spellcheck: false }) as HTMLInputElement;
  name.style.width = '100%';
  name.addEventListener('input', () => (next.name = name.value));
  const blend = select(BLEND_MODES.map((b) => [b.id, b.label] as [BlendMode, string]), before.blend);
  blend.addEventListener('change', () => {
    next.blend = blend.value as BlendMode;
    preview();
  });
  const body = h(
    'div',
    { class: 'form' },
    field('Name', name),
    slider({ label: 'Opacity', min: 0, max: 100, value: Math.round(before.opacity * 100), unit: '%', width: 170, onInput: (v) => {
      next.opacity = v / 100;
      preview();
    }, onChange: (v) => {
      next.opacity = v / 100;
      preview();
    } }),
    field('Blend mode', blend),
    toggle('Visible', before.visible, (v) => {
      next.visible = v;
      preview();
    }),
    toggle('Locked (no painting or moving)', before.locked, (v) => (next.locked = v)),
    toggle('Lock transparent pixels (paint only where there are pixels)', before.alphaLocked, (v) => (next.alphaLocked = v)),
  );
  setTimeout(() => {
    name.focus();
    name.select();
  }, 0);
  const ok = await dialog('Layer properties', body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  // Put it back, then apply (or not) as one undoable step
  layer.setProps(before);
  app.view.layersChanged();
  if (!ok) return;
  next.name = next.name.trim() || before.name;
  const changed = (Object.keys(next) as (keyof LayerProps)[]).filter((k) => next[k] !== before[k]);
  if (!changed.length) return;
  const props: Partial<LayerProps> = {};
  for (const k of changed) (props as Record<string, unknown>)[k] = next[k];
  doc.edit(changed.length === 1 && changed[0] === 'name' ? 'Rename layer' : 'Layer properties', (e) => setLayerProps(doc, e, layer, props));
}
