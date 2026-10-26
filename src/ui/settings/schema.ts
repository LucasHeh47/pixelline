// Every setting in Pixelline. Each one is wired to real behavior: `apply` runs when it changes
// (and at startup) and `refresh` lists the parts of the UI that redraw.
import * as L from 'lucide';
import type { App } from '../app';
import { platform } from '../platform';
import { uiOptions } from '../widgets';
import type { SectionDef, SettingDef, SettingOption } from './store';

export const SECTIONS: SectionDef[] = [
  { id: 'appearance', label: 'Appearance', icon: L.Palette, description: 'Theme, colors and what is shown on screen.' },
  { id: 'canvas', label: 'Canvas', icon: L.Frame, description: 'Transparency, grids, zooming and scrolling.' },
  { id: 'painting', label: 'Painting', icon: L.Brush, description: 'Brush cursors, colour picking and pen pressure.' },
  { id: 'files', label: 'Files & saving', icon: L.FileImage, description: 'Opening, saving and exporting images.' },
  { id: 'performance', label: 'Memory & undo', icon: L.Cpu, description: 'How much history is kept.' },
  { id: 'keyboard', label: 'Keyboard & search', icon: L.Keyboard, description: 'Command search and shortcuts.' },
  { id: 'updates', label: 'Updates', icon: L.RefreshCw, description: 'Version and automatic updates.' },
];

const opts = (...pairs: [string, string][]): SettingOption[] => pairs.map(([value, label]) => ({ value, label }));

export const ACCENTS: Record<string, [string, string]> = {
  violet: ['#a98bff', '#7c4dff'],
  blue: ['#4ea1ff', '#1a73e8'],
  teal: ['#22b8cf', '#0b7285'],
  green: ['#3fcf8e', '#188038'],
  pink: ['#f472b6', '#c2255c'],
  orange: ['#ff9f43', '#d9480f'],
  red: ['#ff6b6b', '#e03131'],
  gold: ['#ffd43b', '#b08800'],
};

export const SETTINGS: SettingDef[] = [
  // ---------- Appearance ----------
  { id: 'appearance.theme', section: 'appearance', group: 'Theme', label: 'Theme', description: 'Dark keeps the focus on your image; "Match Windows" follows your system setting.', type: 'select', default: 'dark', options: opts(['dark', 'Dark'], ['light', 'Light'], ['system', 'Match Windows']), refresh: ['theme'], keywords: 'dark mode light mode' },
  { id: 'appearance.accent', section: 'appearance', group: 'Theme', label: 'Accent color', description: 'Used for buttons, the active tool and highlights.', type: 'select', default: 'violet', options: Object.keys(ACCENTS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })), refresh: ['theme'], keywords: 'color highlight' },
  { id: 'appearance.workspace', section: 'appearance', group: 'Theme', label: 'Background around the image', type: 'select', default: 'dark', options: opts(['dark', 'Dark grey'], ['mid', 'Middle grey'], ['light', 'Light grey'], ['black', 'Black']), refresh: ['theme', 'canvas'], keywords: 'workspace pasteboard' },
  { id: 'appearance.density', section: 'appearance', group: 'Layout', label: 'Density', description: 'Compact fits more on screen; comfortable has larger click targets.', type: 'select', default: 'comfortable', options: opts(['comfortable', 'Comfortable'], ['compact', 'Compact']), refresh: ['chrome'], keywords: 'spacing size' },
  { id: 'appearance.uiZoom', section: 'appearance', group: 'Layout', label: 'Interface size', description: 'Scales menus, panels and buttons (not your image).', type: 'number', default: 100, min: 80, max: 150, step: 10, unit: '%', desktopOnly: true, apply: (v: number) => platform.setZoomFactor(v / 100), keywords: 'zoom scale bigger smaller' },
  { id: 'appearance.reduceMotion', section: 'appearance', group: 'Layout', label: 'Reduce motion', description: 'Turns off animations, including the moving selection outline.', type: 'toggle', default: false, refresh: ['chrome', 'canvas'], keywords: 'animation accessibility marching ants' },
  { id: 'appearance.showStatusBar', section: 'appearance', group: 'Show on screen', label: 'Status bar', type: 'toggle', default: true, refresh: ['chrome'] },
  { id: 'appearance.showSearch', section: 'appearance', group: 'Show on screen', label: 'Search box in the title bar', description: 'Ctrl+K works either way.', type: 'toggle', default: true, refresh: ['titlebar'] },
  { id: 'appearance.titlePath', section: 'appearance', group: 'Show on screen', label: 'Show the file location in the window title', type: 'toggle', default: false, refresh: ['titlebar'], keywords: 'path folder' },
  { id: 'appearance.tooltips', section: 'appearance', group: 'Tooltips & messages', label: 'Tooltips', description: 'Short descriptions when you hover over a button.', type: 'toggle', default: true, apply: (v: boolean) => (uiOptions.tooltips = v) },
  { id: 'appearance.tooltipDelay', section: 'appearance', group: 'Tooltips & messages', label: 'Tooltip delay', type: 'number', default: 450, min: 0, max: 2000, step: 50, unit: 'ms', apply: (v: number) => (uiOptions.tooltipDelay = v) },
  { id: 'appearance.tooltipKeys', section: 'appearance', group: 'Tooltips & messages', label: 'Show keyboard shortcuts in tooltips', type: 'toggle', default: true, apply: (v: boolean) => (uiOptions.tooltipShortcuts = v) },
  { id: 'appearance.toastSeconds', section: 'appearance', group: 'Tooltips & messages', label: 'How long messages stay on screen', description: 'Error messages stay 3 seconds longer.', type: 'number', default: 4.5, min: 2, max: 20, step: 0.5, unit: 'seconds', apply: (v: number) => (uiOptions.toastMs = v * 1000), keywords: 'toast notification' },

  // ---------- Canvas ----------
  { id: 'canvas.checker', section: 'canvas', group: 'Transparency', label: 'Transparent areas', type: 'select', default: 'checker', options: opts(['checker', 'Checkerboard'], ['dark', 'Dark checkerboard'], ['light', 'Light checkerboard'], ['white', 'White'], ['black', 'Black']), refresh: ['canvas'], keywords: 'checkerboard alpha background' },
  { id: 'canvas.checkerSize', section: 'canvas', group: 'Transparency', label: 'Checkerboard square size', type: 'number', default: 8, min: 2, max: 32, step: 1, unit: 'px', refresh: ['canvas'] },
  { id: 'canvas.pixelGridZoom', section: 'canvas', group: 'Grids', label: 'Show the pixel grid from', description: 'The pixel grid (View → Pixel grid) appears once you zoom in this far.', type: 'number', default: 6, min: 2, max: 32, step: 1, unit: '× zoom', refresh: ['canvas'] },
  { id: 'canvas.gridColor', section: 'canvas', group: 'Grids', label: 'Tile grid colour', description: 'The grid every 16 pixels (or what you choose in View → Tile grid).', type: 'select', default: 'rgba(169,139,255,0.6)', options: opts(['rgba(169,139,255,0.6)', 'Violet'], ['rgba(78,161,255,0.6)', 'Blue'], ['rgba(255,80,80,0.6)', 'Red'], ['rgba(255,255,255,0.5)', 'White'], ['rgba(0,0,0,0.5)', 'Black']), refresh: ['canvas'] },
  { id: 'canvas.smoothZoomOut', section: 'canvas', group: 'Zoom', label: 'Smooth the image when zoomed out', description: 'Off shows exact pixels at every zoom (can look jagged on photos).', type: 'toggle', default: true, refresh: ['canvas'] },
  { id: 'canvas.wheel', section: 'canvas', group: 'Zoom', label: 'Mouse wheel', type: 'select', default: 'zoom', options: opts(['zoom', 'Zooms (Shift+wheel scrolls sideways)'], ['scroll', 'Scrolls (Ctrl+wheel zooms)']), keywords: 'scroll zoom mouse' },
  { id: 'canvas.fitPixelArt', section: 'canvas', group: 'Zoom', label: 'Open small images at a whole-number zoom', description: 'Keeps every pixel the same size (200%, 300%…) so pixel art looks sharp.', type: 'toggle', default: true },

  // ---------- Painting ----------
  { id: 'painting.cursor', section: 'painting', group: 'Cursor', label: 'Brush cursor', type: 'select', default: 'outline', options: opts(['outline', 'Brush outline'], ['cross', 'Crosshair']), refresh: ['canvas'] },
  { id: 'painting.pressure', section: 'painting', group: 'Pen tablets', label: 'Use pen pressure', description: 'Pressure changes the brush size (brush tool) when you use a pen.', type: 'toggle', default: true, keywords: 'tablet wacom stylus' },
  { id: 'painting.recentColors', section: 'painting', group: 'Colours', label: 'Recent colours to remember', type: 'number', default: 16, min: 0, max: 40, step: 1, refresh: ['panels'] },

  // ---------- Files ----------
  { id: 'files.indexedPng', section: 'files', group: 'Saving', label: 'Small PNG files for pixel art', description: 'Images with 256 colours or fewer are saved as paletted PNGs: the same pixels in a much smaller file.', type: 'toggle', default: true, keywords: 'indexed palette compression' },
  { id: 'files.jpegQuality', section: 'files', group: 'Saving', label: 'JPEG and WebP quality', type: 'number', default: 92, min: 10, max: 100, step: 1, unit: '%' },
  { id: 'files.warnFlatten', section: 'files', group: 'Saving', label: 'Mention when a save flattens layers', description: 'PNG, JPEG and WebP have one layer; .ora and .psd keep them.', type: 'toggle', default: true },
  { id: 'files.openAsLayers', section: 'files', group: 'Opening', label: 'When images are dropped on an open image', type: 'select', default: 'ask', options: opts(['ask', 'Ask (new image or new layer)'], ['open', 'Open them as new images'], ['layer', 'Add them as layers']), keywords: 'drag drop place' },
  { id: 'files.recoveryMinutes', section: 'files', group: 'Saving', label: 'Keep a safety copy of unsaved images', description: 'If Pixelline closes unexpectedly, the start page offers to bring your work back.', type: 'select', default: '2', options: opts(['0', 'Off'], ['1', 'Every minute'], ['2', 'Every 2 minutes'], ['5', 'Every 5 minutes'], ['10', 'Every 10 minutes']), desktopOnly: true, apply: (_v: string, app: App) => app.startRecovery?.(), keywords: 'autosave recover crash backup' },
  { id: 'files.restore', section: 'files', group: 'Opening', label: 'Show the start page when Pixelline opens', type: 'toggle', default: true, keywords: 'home welcome' },
  { id: 'files.clearRecent', section: 'files', group: 'Opening', label: 'Recent files list', type: 'action', desktopOnly: true, action: { label: 'Clear', run: () => platform.clearRecentFiles() } },

  // ---------- Memory ----------
  { id: 'history.steps', section: 'performance', group: 'Undo', label: 'Undo steps to keep', type: 'number', default: 300, min: 20, max: 2000, step: 10, refresh: ['history'] },
  { id: 'history.memory', section: 'performance', group: 'Undo', label: 'Memory for undo, per image', description: 'Older steps are forgotten once this is used. Undo only stores the parts of the image that changed.', type: 'number', default: 1500, min: 200, max: 8000, step: 100, unit: 'MB', refresh: ['history'], keywords: 'ram' },

  // ---------- Keyboard ----------
  { id: 'keyboard.remember', section: 'keyboard', group: 'Command search (Ctrl+K)', label: 'Remember the commands I use', type: 'toggle', default: true },
  { id: 'keyboard.clearRecent', section: 'keyboard', group: 'Command search (Ctrl+K)', label: 'Forget recently used commands', type: 'action', action: { label: 'Clear', run: (app) => {
    app.prefs.recentCommands = [];
    app.savePrefs();
  } } },
  { id: 'keyboard.list', section: 'keyboard', group: 'Shortcuts', label: 'All keyboard shortcuts', type: 'action', action: { label: 'Show', run: (app) => app.commands.run('help.shortcuts') } },

  // ---------- Updates ----------
  { id: 'updates.version', section: 'updates', group: 'Version', label: 'Installed version', type: 'info', info: async () => {
    const v = await platform.appVersion();
    return v.includes('-') ? `Pixelline ${v} (development build)` : `Pixelline ${v}`;
  } },
  { id: 'updates.check', section: 'updates', group: 'Version', label: 'Check for a newer version', type: 'action', desktopOnly: true, action: { label: 'Check now', run: (app) => app.updates.check(false) } },
  { id: 'updates.whatsNew', section: 'updates', group: 'Version', label: "What's new in this version", type: 'action', action: { label: 'Show', run: (app) => app.updates.showWhatsNew() } },
  { id: 'updates.onStartup', section: 'updates', group: 'Automatic updates', label: 'Check for updates when Pixelline starts', type: 'toggle', default: true, desktopOnly: true },
  { id: 'updates.autoDownload', section: 'updates', group: 'Automatic updates', label: 'Download updates in the background', description: "You're still asked before anything is installed.", type: 'toggle', default: false, desktopOnly: true },
  { id: 'updates.devBranch', section: 'updates', group: 'Automatic updates', label: 'Developer branch', description: 'Get development builds of Pixelline as soon as they are made. They have the newest features first, but may have bugs.', type: 'toggle', default: false, desktopOnly: true, keywords: 'beta preview development pre-release channel', apply: (v: boolean, app: App) => app.updates?.devBranchChanged(v) },
  { id: 'updates.showNotes', section: 'updates', group: 'Automatic updates', label: "Show what's new after updating", type: 'toggle', default: true },
];
