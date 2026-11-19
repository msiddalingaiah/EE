// The user directory: one place for the libraries, design rules and CAM jobs a user keeps,
//   libraries/  .ospreylib and .lbr files (Add part, update on open, Copy from…)
//   rules/      .dru files (Load design rules)
//   cam/        .cam jobs (File ▸ CAM)
// In Chromium it is a folder on disk, picked once (its handle kept in IndexedDB; after a reload
// the browser asks again, from a click, before it can be used). Elsewhere it lives in the
// browser's origin private file system, with export and import as a zip. Both are directory
// handles with the same API, so the rest of the code doesn't care which.

import { zip } from '../cam/zip';
import { unzip } from '../cam/unzip';
import { writeInFolder, type FileHandle } from './files';

export type Sub = 'libraries' | 'rules' | 'cam';
export const SUBS: Record<Sub, string[]> = {
  libraries: ['.ospreylib', '.lbr'],
  rules: ['.dru'],
  cam: ['.cam'],
};

/** A directory handle (FileSystemDirectoryHandle), as much of it as is used here. */
export interface DirHandle {
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string }>;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** What is remembered between visits: a folder's handle, or that the browser's storage is used. */
export type Saved = { where: 'folder'; handle: DirHandle } | { where: 'browser' };

export interface UserDirEnv {
  /** Where the choice is remembered (IndexedDB in the app). */
  load(): Promise<Saved | undefined>;
  save(s: Saved | undefined): Promise<void>;
  /** The browser's own storage (navigator.storage.getDirectory()), if there is one. */
  browserRoot?(): Promise<DirHandle>;
  /** Ask the user for a folder (showDirectoryPicker), if the browser can. */
  pickFolder?(): Promise<DirHandle>;
}

export type Status = 'none' | 'ready' | 'needs-permission';

export class UserDir {
  status: Status = 'none';
  where: 'folder' | 'browser' | undefined;
  private root: DirHandle | undefined;
  private readonly names = new Map<Sub, string[]>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly env: UserDirEnv) {}

  /** Where it is, for people: the folder's name, or "this browser". */
  get label(): string {
    return this.where === 'browser' ? 'this browser' : this.root?.name ?? '';
  }

  get canPickFolder(): boolean {
    return !!this.env.pickFolder;
  }

  get canUseBrowser(): boolean {
    return !!this.env.browserRoot;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Pick up the directory chosen on an earlier visit. */
  async init(): Promise<void> {
    let saved: Saved | undefined;
    try {
      saved = await this.env.load();
    } catch {
      saved = undefined;
    }
    if (saved?.where === 'browser' && this.env.browserRoot) {
      await this.open(await this.browserDir(), 'browser');
    } else if (saved?.where === 'folder') {
      this.root = saved.handle;
      this.where = 'folder';
      const p = (await saved.handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (p === 'granted') await this.open(saved.handle, 'folder');
      else {
        this.status = 'needs-permission';
        this.changed();
      }
    }
  }

  /** Choose a folder on disk (from a click). Returns false if cancelled. */
  async choose(): Promise<boolean> {
    if (!this.env.pickFolder) return false;
    let dir: DirHandle;
    try {
      dir = await this.env.pickFolder();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      throw e;
    }
    await this.env.save({ where: 'folder', handle: dir });
    await this.open(dir, 'folder');
    return true;
  }

  /** Keep the user directory in the browser's own storage. */
  async useBrowser(): Promise<void> {
    if (!this.env.browserRoot) throw new Error("This browser can't keep files");
    await this.env.save({ where: 'browser' });
    await this.open(await this.browserDir(), 'browser');
  }

  /** Ask again for access to the folder chosen before (must run from a click). */
  async reconnect(): Promise<boolean> {
    if (!this.root || this.status !== 'needs-permission') return this.status === 'ready';
    const p = (await this.root.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (p !== 'granted') return false;
    await this.open(this.root, 'folder');
    return true;
  }

  /** The file names in a subdirectory, sorted (as of the last change; no waiting). */
  list(sub: Sub): string[] {
    return this.names.get(sub) ?? [];
  }

  has(sub: Sub, name: string): boolean {
    return this.list(sub).some((n) => n.toLowerCase() === name.toLowerCase());
  }

  async fileHandle(sub: Sub, name: string): Promise<FileHandle> {
    return (await this.dir(sub)).getFileHandle(name);
  }

  async read(sub: Sub, name: string): Promise<string> {
    return (await (await this.fileHandle(sub, name)).getFile()).text();
  }

  /** Write a file (replacing one of the same name); returns its handle. */
  async write(sub: Sub, name: string, text: string): Promise<FileHandle> {
    const dir = await this.dir(sub);
    await writeInFolder(dir, name, text);
    await this.refresh();
    return dir.getFileHandle(name);
  }

  /** Read the listings again (after something else may have changed the folder). */
  async refresh(): Promise<void> {
    if (this.status !== 'ready') return;
    for (const sub of Object.keys(SUBS) as Sub[]) {
      const out: string[] = [];
      for await (const e of (await this.dir(sub)).values()) {
        if (e.kind === 'file' && SUBS[sub].some((x) => e.name.toLowerCase().endsWith(x))) out.push(e.name);
      }
      this.names.set(sub, out.sort((a, b) => a.localeCompare(b)));
    }
    this.changed();
  }

  /** Every file, as one zip (libraries/…, rules/…, cam/…). */
  async exportZip(): Promise<Uint8Array> {
    const files = new Map<string, string>();
    for (const sub of Object.keys(SUBS) as Sub[]) {
      for (const name of this.list(sub)) files.set(`${sub}/${name}`, await this.read(sub, name));
    }
    return zip(files);
  }

  /** Add the files in a zip made by exportZip (or by hand, same layout); returns how many. */
  async importZip(bytes: Uint8Array): Promise<number> {
    const files = await unzip(bytes);
    const dec = new TextDecoder();
    let n = 0;
    for (const [path, data] of files) {
      const parts = path.split('/').filter(Boolean);
      const sub = parts.find((p): p is Sub => p in SUBS);
      const name = parts[parts.length - 1]!;
      if (!sub || !SUBS[sub].some((x) => name.toLowerCase().endsWith(x))) continue;
      await writeInFolder(await this.dir(sub), name, dec.decode(data));
      n++;
    }
    await this.refresh();
    return n;
  }

  private async open(dir: DirHandle, where: 'folder' | 'browser'): Promise<void> {
    this.root = dir;
    this.where = where;
    this.status = 'ready';
    await this.refresh();
  }

  private async browserDir(): Promise<DirHandle> {
    return (await this.env.browserRoot!()).getDirectoryHandle('osprey', { create: true });
  }

  private async dir(sub: Sub): Promise<DirHandle> {
    if (!this.root || this.status !== 'ready') throw new Error('No user directory (File ▸ Preferences sets one up)');
    return this.root.getDirectoryHandle(sub, { create: true });
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

// ---------------------------------------------------------------------------
// IndexedDB: a small key-value store for handles (the user directory, recent files).

const DB = 'osprey';
const STORE = 'handles';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    if (value === undefined) tx.objectStore(STORE).delete(key);
    else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The user directory as the app uses it: remembered in IndexedDB, the browser's own APIs. */
export function browserUserDir(): UserDir {
  const w = window as unknown as { showDirectoryPicker?(o: object): Promise<DirHandle> };
  const storage = navigator.storage as unknown as { getDirectory?(): Promise<DirHandle> } | undefined;
  return new UserDir({
    load: () => idbGet<Saved>('userdir'),
    save: (s) => idbSet('userdir', s),
    ...(typeof storage?.getDirectory === 'function' ? { browserRoot: () => storage.getDirectory!() } : {}),
    ...(typeof w.showDirectoryPicker === 'function'
      ? { pickFolder: () => w.showDirectoryPicker!({ id: 'osprey-userdir', mode: 'readwrite' }) }
      : {}),
  });
}
