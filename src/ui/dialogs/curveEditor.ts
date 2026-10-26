// The Curves editor: a graph of input → output brightness with the image's histogram behind it.
// Click to add a point, drag to move it, drag it off the graph (or double-click it) to remove it.
import { curvesFromText, curvesToText, curveTable, histogram, STRAIGHT, type Curves, type CurvePoints } from '../../core/filters';
import { segmented } from '../controls';
import { h } from '../dom';

type Channel = keyof Curves;

const COLORS: Record<Channel, string> = { rgb: '#d8dbe2', r: '#ff6b6b', g: '#3fcf8e', b: '#4ea1ff' };

export function curveEditor(value: string, pixels: Uint8ClampedArray | null, onChange: (text: string) => void): HTMLElement {
  const curves = curvesFromText(value);
  let channel: Channel = 'rgb';
  const SIZE = 256;
  const canvas = h('canvas', { class: 'curve-canvas', width: SIZE * 2, height: SIZE * 2 }) as HTMLCanvasElement;
  const hists: Partial<Record<Channel, Uint32Array>> = {};
  const hist = (ch: Channel) => (pixels ? (hists[ch] ??= histogram(pixels, ch)) : null);
  const readout = h('span', { class: 'hint curve-readout' }, 'Drag the line, or click it to add a point');

  const pts = () => curves[channel];
  const setPts = (p: CurvePoints) => {
    curves[channel] = p;
    onChange(curvesToText(curves));
    draw();
  };

  const draw = () => {
    const g = canvas.getContext('2d')!;
    const k = canvas.width / SIZE;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);
    g.fillStyle = getComputedStyle(canvas).getPropertyValue('--input-bg') || '#121417';
    g.fillRect(0, 0, SIZE, SIZE);
    // Histogram
    const hs = hist(channel);
    if (hs) {
      let max = 1;
      for (const v of hs) max = Math.max(max, v);
      g.fillStyle = channel === 'rgb' ? 'rgba(160,166,178,0.35)' : COLORS[channel] + '55';
      for (let x = 0; x < 256; x++) {
        const hh = Math.sqrt(hs[x] / max) * SIZE * 0.9;
        g.fillRect(x, SIZE - hh, 1, hh);
      }
    }
    // Grid and the straight line
    g.strokeStyle = 'rgba(127,127,127,0.25)';
    g.lineWidth = 0.5;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      g.moveTo((SIZE * i) / 4, 0);
      g.lineTo((SIZE * i) / 4, SIZE);
      g.moveTo(0, (SIZE * i) / 4);
      g.lineTo(SIZE, (SIZE * i) / 4);
    }
    g.moveTo(0, SIZE);
    g.lineTo(SIZE, 0);
    g.stroke();
    // The other channels' curves faintly, then this one
    for (const ch of ['r', 'g', 'b', 'rgb'] as Channel[]) {
      if (ch === channel || isStraight(curves[ch])) continue;
      plot(g, curveTable(curves[ch]), COLORS[ch], 0.35);
    }
    plot(g, curveTable(pts()), COLORS[channel], 1);
    for (const [x, y] of pts()) {
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#000000';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, 255 - y, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  };

  const toCurve = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 255, 255 - ((e.clientY - r.top) / r.height) * 255];
  };
  let drag: { index: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = toCurve(e);
    const list = [...pts()];
    let index = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 10);
    if (index < 0) {
      // A new point on the line where you clicked
      list.push([x, curveTable(list)[Math.round(Math.max(0, Math.min(255, x)))]]);
      list.sort((a, b) => a[0] - b[0]);
      index = list.findIndex(([px]) => px === x);
      setPts(list);
    }
    drag = { index };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = toCurve(e);
    if (!drag) {
      readout.textContent = x >= 0 && x <= 255 ? `In ${Math.round(x)} → out ${curveTable(pts())[Math.round(x)]}` : '';
      return;
    }
    const list = [...pts()];
    const i = drag.index;
    const outside = x < -20 || x > 275 || y < -20 || y > 275;
    // Dragging an inner point off the graph removes it
    if (outside && i > 0 && i < list.length - 1) {
      list.splice(i, 1);
      drag = null;
      setPts(list);
      return;
    }
    const lo = i > 0 ? list[i - 1][0] + 1 : 0;
    const hi = i < list.length - 1 ? list[i + 1][0] - 1 : 255;
    list[i] = [Math.max(lo, Math.min(hi, x)), Math.max(0, Math.min(255, y))];
    readout.textContent = `In ${Math.round(list[i][0])} → out ${Math.round(list[i][1])}`;
    setPts(list);
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = toCurve(e as unknown as PointerEvent);
    const list = [...pts()];
    const i = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 10);
    if (i > 0 && i < list.length - 1) {
      list.splice(i, 1);
      setPts(list);
    }
  });

  const channels = segmented<Channel>(
    [
      { value: 'rgb', label: 'RGB', title: 'All colours' },
      { value: 'r', label: 'R', title: 'Red only' },
      { value: 'g', label: 'G', title: 'Green only' },
      { value: 'b', label: 'B', title: 'Blue only' },
    ],
    channel,
    (v) => {
      channel = v;
      draw();
    },
  );
  const presets = h(
    'div',
    { class: 'curve-presets' },
    ...(
      [
        ['More contrast', [[0, 0], [64, 48], [192, 208], [255, 255]]],
        ['Less contrast', [[0, 20], [64, 72], [192, 184], [255, 235]]],
        ['Brighter', [[0, 0], [110, 150], [255, 255]]],
        ['Darker', [[0, 0], [140, 100], [255, 255]]],
        ['Straight', STRAIGHT],
      ] as [string, CurvePoints][]
    ).map(([label, p]) => h('button', { class: 'btn outline small', onclick: () => setPts(p.map((q) => [...q] as [number, number])) }, label)),
  );
  requestAnimationFrame(draw);
  return h('div', { class: 'curve-editor' }, h('div', { class: 'curve-head' }, channels, readout), canvas, presets);
}

function isStraight(p: CurvePoints): boolean {
  return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255;
}

function plot(g: CanvasRenderingContext2D, t: Uint8ClampedArray, color: string, alpha: number): void {
  g.save();
  g.globalAlpha = alpha;
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  for (let x = 0; x < 256; x++) {
    const y = 255 - t[x];
    if (x) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  g.restore();
}
