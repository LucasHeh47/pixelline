// The bridge between the Electron main process and the UI (exposed as window.pixelline).

export interface OpenedFile {
  path: string | null;
  name: string;
  data: Uint8Array;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  pinned?: boolean;
}

/** What a file dialog is for (decides its file types). */
/** 'save': the formats an image can be saved in, the default name's format first. */
export type FileKind = 'image' | 'save' | 'ora' | 'psd' | 'png' | 'jpg' | 'webp' | 'palette' | 'json' | 'folder';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface PixellineApi {
  platform: string;
  isDesktop: true;
  openFileDialog(kind?: FileKind, multiple?: boolean): Promise<OpenedFile[] | null>;
  openPath(path: string): Promise<OpenedFile | null>;
  readDroppedFile(file: File): Promise<OpenedFile>;
  saveFileDialog(defaultName: string, kind: FileKind): Promise<string | null>;
  saveFile(path: string, data: Uint8Array): Promise<SaveResult>;
  /** Picks a folder (for resource pack exports). Returns its path. */
  pickFolder(): Promise<string | null>;
  /** Writes a file inside a folder picked with pickFolder (subfolders are created). */
  saveInFolder(folder: string, relative: string, data: Uint8Array): Promise<SaveResult>;
  recentFiles(): Promise<RecentFile[]>;
  clearRecentFiles(): Promise<void>;
  removeRecentFile(path: string): Promise<void>;
  pinRecentFile(path: string, pinned: boolean): Promise<void>;
  /** A PNG of the image on the clipboard, if there is one. */
  readClipboardImage(): Promise<Uint8Array | null>;
  writeClipboardImage(png: Uint8Array): Promise<void>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  setTheme(theme: { dark: boolean; bar: string; symbol: string }): void;
  newWindow(path?: string): void;
  openExternal(url: string): void;
  showInFolder(path: string): void;
  confirmClose(): void;
  onRequestClose(cb: () => void): void;
  /** Files opened from outside (Explorer, a second launch) for this window to open in tabs. */
  onOpenPaths(cb: (paths: string[]) => void): void;
  toggleDevTools(): void;
  appVersion(): Promise<string>;
  /** Scales the whole window (1 = 100%). */
  setZoomFactor(factor: number): void;
  updates: UpdatesApi;
}

export interface UpdateCheckOptions {
  /** A background check at startup (no message when there's nothing new). */
  silent?: boolean;
  allowPrerelease?: boolean;
  autoDownload?: boolean;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  /** Version currently running. */
  current: string;
  /** Newest version found. */
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  /** Portable builds can't update themselves; `url` is the download page. */
  portable?: boolean;
  url?: string;
}

export interface UpdatesApi {
  check(opts: UpdateCheckOptions): Promise<UpdateState>;
  state(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<boolean>;
  openPage(): Promise<void>;
  onState(cb: (s: UpdateState) => void): void;
}
