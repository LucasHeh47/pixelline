// Exposes a minimal, typed API to the UI. The UI never gets direct Node or file-system access.
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import type { FileKind, OpenedFile, PixellineApi } from '../src/shared/api';

const api: PixellineApi = {
  platform: process.platform,
  isDesktop: true,
  openFileDialog: (kind?: FileKind, multiple?: boolean) => ipcRenderer.invoke('file:open-dialog', kind, multiple),
  openPath: (p: string) => ipcRenderer.invoke('file:open-path', p),
  async readDroppedFile(file: File): Promise<OpenedFile> {
    const p = webUtils.getPathForFile(file);
    const granted: string | null = p ? await ipcRenderer.invoke('file:grant', p) : null;
    const data = new Uint8Array(await file.arrayBuffer());
    return { path: granted, name: file.name, data };
  },
  saveFileDialog: (defaultName: string, kind: FileKind) => ipcRenderer.invoke('file:save-dialog', defaultName, kind),
  saveFile: (p: string, data: Uint8Array) => ipcRenderer.invoke('file:save', p, data),
  pickFolder: () => ipcRenderer.invoke('file:pick-folder'),
  saveInFolder: (folder, relative, data) => ipcRenderer.invoke('file:save-in-folder', folder, relative, data),
  recentFiles: () => ipcRenderer.invoke('file:recent'),
  clearRecentFiles: () => ipcRenderer.invoke('file:clear-recent'),
  removeRecentFile: (p) => ipcRenderer.invoke('file:remove-recent', p),
  pinRecentFile: (p, pinned) => ipcRenderer.invoke('file:pin-recent', p, pinned),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  writeClipboardImage: (png) => ipcRenderer.invoke('clipboard:write-image', png),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (t) => ipcRenderer.invoke('clipboard:write-text', t),
  setTitle: (t) => ipcRenderer.send('win:set-title', t),
  setDirty: (d) => ipcRenderer.send('win:set-dirty', d),
  setTheme: (t) => ipcRenderer.send('win:set-theme', t),
  newWindow: (p) => ipcRenderer.send('win:new', p),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  showInFolder: (p) => ipcRenderer.send('shell:show-in-folder', p),
  confirmClose: () => ipcRenderer.send('win:confirm-close'),
  onRequestClose: (cb) => {
    ipcRenderer.on('app:request-close', () => cb());
  },
  onOpenPaths: (cb) => {
    ipcRenderer.on('app:open-paths', (_e, paths: string[]) => cb(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []));
  },
  toggleDevTools: () => ipcRenderer.send('win:devtools'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  setZoomFactor: (f) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(f) || 1))),
  updates: {
    check: (opts) => ipcRenderer.invoke('updates:check', opts),
    state: () => ipcRenderer.invoke('updates:state'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    openPage: () => ipcRenderer.invoke('updates:open-page'),
    onState: (cb) => {
      ipcRenderer.on('updates:state', (_e, s) => cb(s));
    },
  },
};

contextBridge.exposeInMainWorld('pixelline', api);
