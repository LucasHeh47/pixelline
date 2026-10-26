// Electron main process: windows, native dialogs, file access and the clipboard.
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileKind } from '../src/shared/api';
import { setupUpdates } from './updater';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const SMOKE_SCREENSHOT = process.env.PIXELLINE_SCREENSHOT;
/** Files Pixelline opens (images, layered documents and palettes). */
const SUPPORTED = /\.(png|jpe?g|webp|gif|bmp|ico|ora|psd|gpl|pal|hex)$/i;

/** Paths the UI may read or write: chosen in a dialog, passed on the command line, dropped, or recent. */
const allowedPaths = new Set<string>();
/** Folders picked for exports: files may be written inside them. */
const allowedFolders = new Set<string>();
const dirty = new Map<number, boolean>();
const closing = new Set<number>();

function allow(p: string): string {
  const full = path.resolve(p);
  allowedPaths.add(full.toLowerCase());
  return full;
}

function isAllowed(p: string): boolean {
  return allowedPaths.has(path.resolve(p).toLowerCase());
}

// ---------- recent files ----------

const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
interface Recent {
  path: string;
  name: string;
  openedAt: number;
  pinned?: boolean;
}

async function readRecent(): Promise<Recent[]> {
  try {
    const list = JSON.parse(await fs.readFile(recentPath(), 'utf8')) as Recent[];
    return list.filter((r) => typeof r.path === 'string' && existsSync(r.path));
  } catch {
    return [];
  }
}

async function writeRecent(list: Recent[]): Promise<void> {
  // Keep every pinned file plus the 30 most recent others
  let unpinned = 0;
  const kept = list.filter((r) => r.pinned || unpinned++ < 30);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(recentPath(), JSON.stringify(kept, null, 2));
}

async function addRecent(p: string): Promise<void> {
  if (/\.(gpl|pal|hex)$/i.test(p)) return;
  const all = await readRecent();
  const prev = all.find((r) => r.path.toLowerCase() === p.toLowerCase());
  const list = all.filter((r) => r !== prev);
  list.unshift({ path: p, name: path.basename(p), openedAt: Date.now(), pinned: prev?.pinned || undefined });
  await writeRecent(list);
  app.addRecentDocument(p);
}

// ---------- windows ----------

function filesFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && SUPPORTED.test(a) && existsSync(a));
}

function createWindow(filePath?: string, launch = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#121417',
    title: 'Pixelline',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181d', symbolColor: '#c9ced8', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const id = win.webContents.id;
  if (filePath) allow(filePath);
  const query: Record<string, string> | undefined = filePath ? { file: path.resolve(filePath) } : launch ? { launch: '1' } : undefined;
  if (DEV_URL) win.loadURL(DEV_URL + (query ? `?${new URLSearchParams(query)}` : ''));
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_SCREENSHOT) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        await fs.writeFile(SMOKE_SCREENSHOT, img.toPNG());
        app.exit(0);
      }, Number(process.env.PIXELLINE_SCREENSHOT_DELAY ?? 2500));
    }
  });
  win.on('close', (e) => {
    if (dirty.get(id) && !closing.has(id)) {
      e.preventDefault();
      win.webContents.send('app:request-close');
    }
  });
  win.on('closed', () => {
    dirty.delete(id);
    closing.delete(id);
  });
  // Never navigate away from the app; open links in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && DEV_URL) win.webContents.toggleDevTools();
  });
  return win;
}

const senderWindow = (e: IpcMainInvokeEvent | Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);

// ---------- IPC ----------

async function readFileFor(p: string) {
  const full = allow(p);
  const data = await fs.readFile(full);
  await addRecent(full);
  return { path: full, name: path.basename(full), data: new Uint8Array(data) };
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'ora', 'psd'];

const SAVE_FILTERS: Electron.FileFilter[] = [
  { name: 'PNG image', extensions: ['png'] },
  { name: 'Pixelline / OpenRaster image (keeps layers)', extensions: ['ora'] },
  { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP image', extensions: ['webp'] },
  { name: 'Photoshop document (keeps layers)', extensions: ['psd'] },
];

function filtersFor(kind: FileKind, defaultName = ''): Electron.FileFilter[] {
  switch (kind) {
    case 'save': {
      // Windows adds the first filter's extension, so the suggested format goes first
      const ext = (/\.([^.]+)$/.exec(defaultName)?.[1] ?? 'png').toLowerCase();
      const first = SAVE_FILTERS.find((f) => f.extensions.includes(ext));
      return first ? [first, ...SAVE_FILTERS.filter((f) => f !== first)] : SAVE_FILTERS;
    }
    case 'ora':
      return [{ name: 'Pixelline / OpenRaster image (layers)', extensions: ['ora'] }];
    case 'psd':
      return [{ name: 'Photoshop document', extensions: ['psd'] }];
    case 'png':
      return [{ name: 'PNG image', extensions: ['png'] }];
    case 'jpg':
      return [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }];
    case 'webp':
      return [{ name: 'WebP image', extensions: ['webp'] }];
    case 'palette':
      return [
        { name: 'Palettes', extensions: ['gpl', 'pal', 'hex', 'txt'] },
        { name: 'GIMP palette', extensions: ['gpl'] },
      ];
    case 'json':
      return [{ name: 'Pixelline settings', extensions: ['json'] }];
    default:
      return [
        { name: 'Images', extensions: IMAGE_EXT },
        { name: 'Layered (OpenRaster, Photoshop)', extensions: ['ora', 'psd'] },
        { name: 'Pictures (PNG, JPEG, WebP, GIF, BMP)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] },
      ];
  }
}

ipcMain.handle('file:open-dialog', async (e, kind: FileKind = 'image', multiple = false) => {
  const win = senderWindow(e);
  const res = await dialog.showOpenDialog(win!, {
    title: kind === 'palette' ? 'Open palette' : 'Open image',
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filtersFor(kind),
  });
  if (res.canceled || !res.filePaths.length) return null;
  return Promise.all(res.filePaths.map((p) => readFileFor(p)));
});

ipcMain.handle('file:open-path', async (_e, p: string) => {
  if (typeof p !== 'string') return null;
  const recent = await readRecent();
  if (!isAllowed(p) && !recent.some((r) => r.path.toLowerCase() === path.resolve(p).toLowerCase())) {
    throw new Error('That file can only be opened from the Open dialog.');
  }
  return readFileFor(p);
});

ipcMain.handle('file:grant', async (_e, p: string) => {
  if (typeof p === 'string' && p && SUPPORTED.test(p)) {
    const full = allow(p);
    await addRecent(full);
    return full;
  }
  return null;
});

ipcMain.handle('file:save-dialog', async (e, defaultName: string, kind: FileKind) => {
  const win = senderWindow(e);
  const res = await dialog.showSaveDialog(win!, { title: kind === 'json' ? 'Export settings' : kind === 'palette' ? 'Save palette' : 'Save as', defaultPath: defaultName, filters: filtersFor(kind, defaultName) });
  if (res.canceled || !res.filePath) return null;
  return allow(res.filePath);
});

async function writeAtomic(full: string, data: Uint8Array) {
  const tmp = `${full}.pixelline-${process.pid}.tmp`;
  try {
    // Write to a temporary file first so a crash can't leave a half-written image.
    await fs.writeFile(tmp, Buffer.from(data));
    await fs.rename(tmp, full);
    return { ok: true };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { ok: false, error: 'The file is locked — it may be open in another program. Close it there and try again, or use Save As.' };
    return { ok: false, error: (err as Error).message };
  }
}

ipcMain.handle('file:save', async (_e, p: string, data: Uint8Array) => {
  if (!isAllowed(p)) return { ok: false, error: "Pixelline isn't allowed to write to that location. Use Save As." };
  const full = path.resolve(p);
  const res = await writeAtomic(full, data);
  if (res.ok && SUPPORTED.test(full)) await addRecent(full);
  return res;
});

ipcMain.handle('file:pick-folder', async (e) => {
  const win = senderWindow(e);
  const res = await dialog.showOpenDialog(win!, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  const full = path.resolve(res.filePaths[0]);
  allowedFolders.add(full.toLowerCase());
  return full;
});

ipcMain.handle('file:save-in-folder', async (_e, folder: string, relative: string, data: Uint8Array) => {
  if (typeof folder !== 'string' || typeof relative !== 'string' || !allowedFolders.has(path.resolve(folder).toLowerCase())) return { ok: false, error: 'Choose the folder first.' };
  const full = path.resolve(folder, relative);
  // Stay inside the chosen folder
  if (!full.toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep)) return { ok: false, error: 'That path is outside the folder.' };
  await fs.mkdir(path.dirname(full), { recursive: true });
  return writeAtomic(full, data);
});

ipcMain.handle('file:recent', async () => {
  const list = await readRecent();
  for (const r of list) allow(r.path);
  return list;
});

ipcMain.handle('file:clear-recent', async () => {
  // Pinned files stay
  await writeRecent((await readRecent()).filter((r) => r.pinned)).catch(() => undefined);
  app.clearRecentDocuments();
});

ipcMain.handle('file:remove-recent', async (_e, p: string) => {
  if (typeof p !== 'string') return;
  await writeRecent((await readRecent()).filter((r) => r.path.toLowerCase() !== p.toLowerCase()));
});

ipcMain.handle('file:pin-recent', async (_e, p: string, pinned: boolean) => {
  if (typeof p !== 'string') return;
  const list = await readRecent();
  for (const r of list) if (r.path.toLowerCase() === p.toLowerCase()) r.pinned = pinned ? true : undefined;
  await writeRecent(list);
});

ipcMain.handle('clipboard:read-image', async () => {
  try {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue;
      const blob = (await item.getType('image/png')) as Blob;
      return new Uint8Array(await blob.arrayBuffer());
    }
  } catch {
    // nothing usable on the clipboard
  }
  return null;
});
ipcMain.handle('clipboard:write-image', async (_e, png: Uint8Array) => {
  if (!(png instanceof Uint8Array)) return;
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
});
ipcMain.handle('clipboard:read-text', () => clipboard.readText());
ipcMain.handle('clipboard:write-text', (_e, t: string) => clipboard.writeText(String(t ?? '')));

ipcMain.on('win:set-title', (e, title: string) => senderWindow(e)?.setTitle(String(title)));
ipcMain.on('win:set-dirty', (e, value: boolean) => {
  const win = senderWindow(e);
  dirty.set(e.sender.id, !!value);
  win?.setDocumentEdited?.(!!value);
});
ipcMain.on('win:set-theme', (e, t: { dark: boolean; bar: string; symbol: string }) => {
  const win = senderWindow(e);
  try {
    win?.setTitleBarOverlay?.({ color: t.bar, symbolColor: t.symbol, height: 40 });
    win?.setBackgroundColor(t.dark ? '#121417' : '#ffffff');
  } catch {
    // not supported on this platform
  }
});
ipcMain.on('win:new', (_e, p?: string) => {
  if (p && !isAllowed(p)) return;
  createWindow(p);
});
ipcMain.on('win:confirm-close', (e) => {
  closing.add(e.sender.id);
  senderWindow(e)?.close();
});
ipcMain.on('win:devtools', (e) => e.sender.toggleDevTools());
ipcMain.on('shell:open-external', (_e, url: string) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
});
ipcMain.on('shell:show-in-folder', (_e, p: string) => {
  if (typeof p === 'string' && (isAllowed(p) || [...allowedFolders].some((f) => path.resolve(p).toLowerCase().startsWith(f)))) shell.showItemInFolder(p);
});
ipcMain.handle('app:version', () => app.getVersion());

setupUpdates();

// ---------- lifecycle ----------

/** Lets a window open these files and asks it to (each becomes a tab). */
function sendPaths(win: BrowserWindow, files: string[]): void {
  const full = files.map((f) => allow(f));
  win.webContents.send('app:open-paths', full);
}

/** One window for several files: the first opens with it, the rest arrive as tabs. */
function openInNewWindow(files: string[]): void {
  const win = createWindow(files[0]);
  if (files.length > 1) win.webContents.once('did-finish-load', () => sendPaths(win, files.slice(1)));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    // Files opened while Pixelline runs become tabs in the window used last
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) {
      if (files.length) openInNewWindow(files);
      else createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    if (files.length) sendPaths(win, files);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.pixelline.app');
    const files = filesFromArgv(process.argv);
    if (process.env.PIXELLINE_OPEN && existsSync(process.env.PIXELLINE_OPEN)) files.push(process.env.PIXELLINE_OPEN);
    if (files.length) openInNewWindow(files);
    else createWindow(undefined, true);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
