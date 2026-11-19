// Opening and saving files. Uses the File System Access API where available (Chromium),
// so Save writes back to the file that was opened; elsewhere it falls back to download.

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
}

interface FsWindow {
  showOpenFilePicker?(opts: object): Promise<FileHandle[]>;
  showSaveFilePicker?(opts: object): Promise<FileHandle>;
}

/** What the open dialog offers: a project, a library, or Eagle files to import. */
export type OpenKind = 'project' | 'library' | 'eagle';
export const OPEN_EXTENSIONS: Record<OpenKind, string[]> = {
  project: ['.osprey'],
  library: ['.ospreylib'],
  eagle: ['.sch', '.brd', '.lbr'],
};
const PICKER_TYPES: Record<OpenKind, object[]> = {
  project: [{ description: 'Osprey project', accept: { 'application/octet-stream': OPEN_EXTENSIONS.project } }],
  library: [{ description: 'Osprey library', accept: { 'application/octet-stream': OPEN_EXTENSIONS.library } }],
  eagle: [{ description: 'Eagle schematic and board (select both), or library', accept: { 'application/octet-stream': OPEN_EXTENSIONS.eagle } }],
};
const SAVE_TYPES = {
  osprey: [{ description: 'Osprey project', accept: { 'application/json': ['.osprey'] } }],
  ospreylib: [{ description: 'Osprey library', accept: { 'application/json': ['.ospreylib'] } }],
  eagle: [{ description: 'Eagle file', accept: { 'application/xml': ['.sch', '.brd', '.lbr'] } }],
  zip: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
};
const MIME = { osprey: 'application/json', ospreylib: 'application/json', eagle: 'application/xml', zip: 'application/zip' };

export interface OpenedFile {
  name: string;
  text: string;
  handle?: FileHandle;
}

export type { FileHandle };

export function canPickFiles(): boolean {
  return typeof (window as FsWindow).showOpenFilePicker === 'function';
}

/**
 * Show the native open dialog (several files may be chosen, e.g. a .sch with its .brd).
 * Returns an empty list if the user cancels.
 */
export async function pickFiles(kind: OpenKind): Promise<OpenedFile[]> {
  const w = window as FsWindow;
  try {
    const handles = await w.showOpenFilePicker!({ id: `osprey-${kind}`, types: PICKER_TYPES[kind], multiple: kind === 'eagle' });
    return await Promise.all(
      handles.map(async (handle) => {
        const f = await handle.getFile();
        return { name: f.name, text: await f.text(), handle };
      }),
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return [];
    throw e;
  }
}

/**
 * Save text (or bytes). Writes to `handle` when there is one; otherwise asks for a location
 * (Chromium) or downloads the file. Returns the handle used, if any, or undefined if cancelled.
 */
export async function saveFile(
  text: string | Uint8Array, name: string, handle: FileHandle | undefined, kind: keyof typeof SAVE_TYPES = 'osprey',
): Promise<{ handle?: FileHandle; method: 'written' | 'downloaded' } | undefined> {
  const w = window as FsWindow;
  try {
    if (!handle && typeof w.showSaveFilePicker === 'function') {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: SAVE_TYPES[kind] });
    }
    if (handle) {
      const out = await handle.createWritable();
      await out.write(text);
      await out.close();
      return { handle, method: 'written' };
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
  const url = URL.createObjectURL(new Blob([text as BlobPart], { type: MIME[kind] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'downloaded' };
}

/** A file that couldn't be written into a folder: which, where, and the browser's reason. */
export class FolderWriteError extends Error {
  constructor(readonly file: string, readonly folder: string, readonly cause: unknown) {
    super(
      `Could not write ${file} in ${folder}: ${cause instanceof Error ? cause.message : String(cause)} ` +
      '(Is it open in another program, such as Excel, or is the folder syncing (OneDrive, Dropbox) or moved? Close it and try again; the next run asks for the folder again.)',
    );
  }
}

/**
 * Write one file into a folder. Chromium refuses ("InvalidStateError") when the file or folder
 * changed on disk behind its back (a sync client, another program); one retry with a fresh
 * handle gets past a passing change.
 */
async function writeInFolder(folder: FolderHandle, name: string, data: string | Uint8Array): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await out.write(data);
      await out.close();
      return;
    } catch (e) {
      const passing = e instanceof DOMException && (e.name === 'InvalidStateError' || e.name === 'NoModificationAllowedError');
      if (!passing || attempt >= 1) throw new FolderWriteError(name, folder.name, e);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** A folder chosen to save into (Chromium's File System Access). */
export interface FolderHandle {
  name: string;
  getFileHandle(name: string, opts: { create: boolean }): Promise<FileHandle>;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
}

const MIME_BY_EXT: Record<string, string> = { csv: 'text/csv', zip: 'application/zip' };

/**
 * Save several files into one folder: `folder` when given (and still writable), else a folder
 * the user picks (Chromium); elsewhere each file downloads. Returns the folder written to, if
 * any, and how; undefined if cancelled.
 */
export async function saveToFolder(
  files: Map<string, string | Uint8Array>, folder: FolderHandle | undefined,
): Promise<{ folder?: FolderHandle; method: 'written' | 'downloaded' } | undefined> {
  const w = window as FsWindow & { showDirectoryPicker?(opts: object): Promise<FolderHandle> };
  try {
    if (folder && folder.queryPermission && (await folder.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await folder.requestPermission?.({ mode: 'readwrite' })) !== 'granted') folder = undefined;
    }
    if (!folder && typeof w.showDirectoryPicker === 'function') {
      folder = await w.showDirectoryPicker({ id: 'osprey-output', mode: 'readwrite' });
    }
    if (folder) {
      for (const [name, data] of files) await writeInFolder(folder, name, data);
      return { folder, method: 'written' };
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
  for (const [name, data] of files) {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: MIME_BY_EXT[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { method: 'downloaded' };
}
