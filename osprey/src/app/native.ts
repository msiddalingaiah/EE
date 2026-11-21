// The native app (Tauri, src-tauri/): file access through its own commands instead of the
// browser's. A folder is a plain path, chosen once and used from then on with no permission
// asked again on each start (the browser's File System Access asks after every reload). The
// handles here have the shape of the browser's (DirHandle, FileHandle), so the code using them
// doesn't change.

import type { FileHandle } from './files';
import { UserDir, type DirHandle, type Saved } from './userdir';

/** Running inside the native app. */
export const isNative = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** How the native commands are called: Tauri's invoke (or a stand-in, in tests). */
export type Invoke = (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<unknown>;

const tauriInvoke: Invoke = async (cmd, args, options) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args as never, options);
};

/** The last part of a path (a folder's or file's name). */
export const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}\\${name}`;

const notFound = (path: string) => new DOMException(`${path} not found`, 'NotFoundError');

/** A file on disk as a FileHandle: read whole, written whole (on close). */
export function nativeFile(path: string, invoke: Invoke = tauriInvoke): FileHandle & { path: string } {
  const name = baseName(path);
  return {
    name,
    path,
    async getFile() {
      const bytes = (await invoke('fs_read', { path })) as ArrayBuffer;
      return new File([bytes], name);
    },
    async createWritable() {
      const parts: Uint8Array[] = [];
      return {
        async write(data: string | Uint8Array) {
          parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        },
        async close() {
          const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
          let at = 0;
          for (const p of parts) {
            all.set(p, at);
            at += p.length;
          }
          await invoke('fs_write', all, { headers: { path: encodeURIComponent(path) } });
        },
      };
    },
  };
}

/** A folder on disk as a DirHandle. */
export function nativeDir(path: string, invoke: Invoke = tauriInvoke): DirHandle & { path: string } {
  return {
    name: baseName(path),
    path,
    async getDirectoryHandle(name, opts) {
      const sub = join(path, name);
      if (opts?.create) await invoke('fs_mkdir', { path: sub });
      return nativeDir(sub, invoke);
    },
    async getFileHandle(name, opts) {
      const file = join(path, name);
      if (!opts?.create && !(await invoke('fs_is_file', { path: file }))) throw notFound(file);
      return nativeFile(file, invoke);
    },
    async *values() {
      const entries = (await invoke('fs_list', { path })) as { name: string; dir: boolean }[];
      for (const e of entries) yield { kind: e.dir ? ('directory' as const) : ('file' as const), name: e.name };
    },
  };
}

/** Where the native app remembers its user directory's path (its own browser storage). */
const USERDIR_KEY = 'osprey.native.userdir';

/** The user directory in the native app: a folder chosen with the system's folder dialog. */
export function nativeUserDir(invoke: Invoke = tauriInvoke, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): UserDir {
  return new UserDir({
    async load(): Promise<Saved | undefined> {
      const path = storage.getItem(USERDIR_KEY);
      if (!path) return undefined;
      // (A folder deleted or moved since: not set up, rather than made again empty.)
      try {
        await invoke('fs_list', { path });
      } catch {
        return undefined;
      }
      return { where: 'folder', handle: nativeDir(path, invoke) };
    },
    async save(s) {
      if (s?.where === 'folder' && 'path' in s.handle) storage.setItem(USERDIR_KEY, (s.handle as { path: string }).path);
      else storage.removeItem(USERDIR_KEY);
    },
    async pickFolder() {
      const path = (await invoke('pick_folder', { title: 'Choose the user directory (libraries, rules, CAM jobs)' })) as string | null;
      if (!path) throw new DOMException('No folder chosen', 'AbortError');
      return nativeDir(path, invoke);
    },
  });
}
