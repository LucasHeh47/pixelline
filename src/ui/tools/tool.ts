// What a tool is, and the manager that switches between them and remembers their options.
import type { IconNode } from 'lucide';
import type { App } from '../app';
import type { CanvasView, PointerInfo } from '../canvas/CanvasView';

export interface BrushOutline {
  size: number;
  square?: boolean;
  /** Snaps to whole pixels (pencil). */
  hard?: boolean;
}

export interface Tool {
  id: string;
  name: string;
  icon: IconNode;
  /** Single-key shortcut (B, E, V…). */
  key?: string;
  /** What the tool does, for tooltips. */
  hint: string;
  cursor?(): string;
  /** Controls for the options bar. */
  options?(): (HTMLElement | null)[];
  down?(p: PointerInfo): void;
  move?(p: PointerInfo): void;
  up?(p: PointerInfo): void;
  hover?(p: PointerInfo): void;
  dblclick?(p: PointerInfo): void;
  /** Pointer capture was lost: undo what's in progress. */
  cancel?(): void;
  /** Keys while the tool is active (Enter, Escape, arrows…). Returns true when handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Draws previews on top of the image (view coordinates). */
  overlay?(ctx: CanvasRenderingContext2D, view: CanvasView): void;
  brushOutline?(): BrushOutline | null;
  activate?(): void;
  /** Finishes anything pending (a transform, a crop, text) before another tool takes over. */
  deactivate?(): void;
  /** Text for the status bar while the tool is active. */
  status?(): string;
}

const KEY = 'pixelline.tools';

/** Tool options, saved between sessions. */
export class ToolOptions {
  private data: Record<string, Record<string, unknown>> = {};

  constructor() {
    try {
      this.data = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
    } catch {
      this.data = {};
    }
  }

  get<T extends Record<string, unknown>>(tool: string, defaults: T): T {
    return { ...defaults, ...(this.data[tool] as Partial<T>) };
  }

  set(tool: string, values: Record<string, unknown>): void {
    this.data[tool] = { ...this.data[tool], ...values };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage unavailable
    }
  }
}

export class ToolManager {
  readonly list: Tool[] = [];
  current: Tool;
  readonly options = new ToolOptions();
  private listeners = new Set<() => void>();

  constructor(
    private app: App,
    tools: Tool[],
    initial: string,
  ) {
    this.list = tools;
    this.current = tools.find((t) => t.id === initial) ?? tools[0];
  }

  get(id: string): Tool | undefined {
    return this.list.find((t) => t.id === id);
  }

  select(id: string): void {
    const next = this.get(id);
    if (!next || next === this.current) return;
    this.current.deactivate?.();
    this.current = next;
    next.activate?.();
    this.app.prefs.tool = id;
    this.app.savePrefs();
    for (const l of this.listeners) l();
  }

  /** Redraws the options bar (after options change from outside, like [ and ]). */
  changed(): void {
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
}
