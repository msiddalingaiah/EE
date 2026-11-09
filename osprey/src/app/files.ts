// Opening and saving files. Uses the File System Access API where available (Chromium),
// so Save writes back to the file that was opened; elsewhere it falls back to download.

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface FsWindow {
  showOpenFilePicker?(opts: object): Promise<FileHandle[]>;
  showSaveFilePicker?(opts: object): Promise<FileHandle>;
}

const PICKER_TYPES = [
  {
    description: 'Eagle files',
    accept: { 'application/xml': ['.sch', '.brd', '.lbr'] },
  },
];

export interface OpenedFile {
  name: string;
  text: string;
  handle?: FileHandle;
}

export type { FileHandle };

export function canPickFiles(): boolean {
  return typeof (window as FsWindow).showOpenFilePicker === 'function';
}

/** Show the native open dialog. Returns undefined if the user cancels. */
export async function pickFile(): Promise<OpenedFile | undefined> {
  const w = window as FsWindow;
  try {
    const [handle] = await w.showOpenFilePicker!({ types: PICKER_TYPES, multiple: false });
    if (!handle) return undefined;
    const f = await handle.getFile();
    return { name: f.name, text: await f.text(), handle };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
}

/**
 * Save text. Writes to `handle` when there is one; otherwise asks for a location
 * (Chromium) or downloads the file. Returns the handle used, if any, or undefined if cancelled.
 */
export async function saveFile(
  text: string, name: string, handle: FileHandle | undefined,
): Promise<{ handle?: FileHandle; method: 'written' | 'downloaded' } | undefined> {
  const w = window as FsWindow;
  try {
    if (!handle && typeof w.showSaveFilePicker === 'function') {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES });
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
  const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'downloaded' };
}
