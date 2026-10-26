// Access to the desktop shell. Falls back to browser APIs when run outside Electron (development only).
import type { FileKind, OpenedFile, PixellineApi, RecentFile, SaveResult } from '../shared/api';

declare global {
  interface Window {
    pixelline?: PixellineApi;
  }
}

const ACCEPT: Partial<Record<FileKind, string>> = {
  image: '.png,.jpg,.jpeg,.webp,.gif,.bmp,.ico,.ora,.psd',
  palette: '.gpl,.pal,.hex,.txt',
  json: '.json',
};

function pickFiles(kind: FileKind = 'image', multiple = false): Promise<OpenedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT[kind] ?? ACCEPT.image!;
    input.multiple = multiple;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return resolve(null);
      resolve(await Promise.all(files.map(async (f) => ({ path: null, name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.click();
  });
}

const webFallback: Omit<PixellineApi, 'isDesktop'> & { isDesktop: boolean } = {
  platform: 'web',
  isDesktop: false,
  openFileDialog: pickFiles,
  openPath: async () => null,
  readDroppedFile: async (file: File) => ({ path: null, name: file.name, data: new Uint8Array(await file.arrayBuffer()) }),
  saveFileDialog: async (name: string) => name,
  async saveFile(path: string, data: Uint8Array): Promise<SaveResult> {
    const blob = new Blob([data as BlobPart]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = path.split(/[\\/]/).pop() || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { ok: true };
  },
  pickFolder: async () => null,
  saveInFolder: async () => ({ ok: false, error: 'Folders can only be used in the desktop app.' }),
  listFolder: async () => [],
  readInFolder: async () => null,
  readSidecar: async () => null,
  saveSidecar: async () => ({ ok: false, error: 'Only in the desktop app.' }),
  recovery: {
    save: async () => undefined,
    list: async () => [],
    read: async () => null,
    remove: async () => undefined,
  },
  suite: {
    apps: async () => [],
    launch: async () => false,
  },
  recentFiles: async (): Promise<RecentFile[]> => [],
  clearRecentFiles: async () => undefined,
  removeRecentFile: async () => undefined,
  pinRecentFile: async () => undefined,
  async readClipboardImage() {
    try {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('image/png')) return new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
      }
    } catch {
      // no access
    }
    return null;
  },
  async writeClipboardImage(png) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]);
    } catch {
      // no access
    }
  },
  readClipboardText: async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  },
  writeClipboardText: async (t) => {
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      // ignore
    }
  },
  setTitle: (t) => {
    document.title = t;
  },
  setDirty: () => undefined,
  setTheme: () => undefined,
  setZoomFactor: () => undefined,
  updates: {
    check: async () => ({ status: 'unsupported', current: __APP_VERSION__, error: 'Updates are available in the desktop app.' }),
    state: async () => ({ status: 'unsupported', current: __APP_VERSION__ }),
    download: async () => ({ status: 'unsupported', current: __APP_VERSION__ }),
    install: async () => false,
    openPage: async () => undefined,
    onState: () => undefined,
  },
  newWindow: () => window.open(location.pathname, '_blank'),
  openExternal: (url) => {
    if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener');
  },
  showInFolder: () => undefined,
  confirmClose: () => undefined,
  onRequestClose: () => undefined,
  onOpenPaths: () => undefined,
  onNewImage: () => undefined,
  toggleDevTools: () => undefined,
  appVersion: async () => __APP_VERSION__,
};

export const platform: PixellineApi = (window.pixelline ?? webFallback) as PixellineApi;
export const isDesktop = !!window.pixelline;
