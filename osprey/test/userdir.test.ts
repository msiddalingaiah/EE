import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzip } from '../src/cam/unzip';
import { zip } from '../src/cam/zip';
import type { FileHandle } from '../src/app/files';
import { UserDir, type DirHandle, type Saved } from '../src/app/userdir';

/** A directory in memory, with the File System Access API's shape. */
class MemDir implements DirHandle {
  readonly dirs = new Map<string, MemDir>();
  readonly files = new Map<string, string>();
  permission: PermissionState = 'granted';
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMException(name, 'NotFoundError');
      this.dirs.set(name, (d = new MemDir(name)));
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle> {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException(name, 'NotFoundError');
      this.files.set(name, '');
    }
    return {
      name,
      getFile: async () => new File([this.files.get(name)!], name),
      createWritable: async () => {
        let text = '';
        return {
          write: async (d: string | Uint8Array) => { text += typeof d === 'string' ? d : new TextDecoder().decode(d); },
          close: async () => { this.files.set(name, text); },
        };
      },
    };
  }
  async *values() {
    for (const name of this.dirs.keys()) yield { kind: 'directory' as const, name };
    for (const name of this.files.keys()) yield { kind: 'file' as const, name };
  }
  async queryPermission(): Promise<PermissionState> { return this.permission; }
  async requestPermission(): Promise<PermissionState> { return (this.permission = 'granted'); }
}

function env(opts: { saved?: Saved; folder?: MemDir; browser?: MemDir } = {}) {
  const e = {
    saved: opts.saved,
    load: async () => e.saved,
    save: async (s: Saved | undefined) => { e.saved = s; },
    ...(opts.browser ? { browserRoot: async () => opts.browser! } : {}),
    ...(opts.folder ? { pickFolder: async () => opts.folder! } : {}),
  };
  return e;
}

describe('the user directory', () => {
  it('is not set up until a folder is chosen, then lists, reads and writes files by kind', async () => {
    const folder = new MemDir('hardware');
    const e = env({ folder });
    const u = new UserDir(e);
    await u.init();
    expect(u.status).toBe('none');
    expect(await u.choose()).toBe(true);
    expect(u.status).toBe('ready');
    expect(u.label).toBe('hardware');
    expect(e.saved).toEqual({ where: 'folder', handle: folder });

    await u.write('libraries', 'b.ospreylib', '{}');
    await u.write('libraries', 'a.lbr', '<eagle/>');
    await u.write('rules', 'fab.dru', 'x = 1');
    folder.dirs.get('libraries')!.files.set('notes.txt', 'not a library');
    await u.refresh();
    expect(u.list('libraries')).toEqual(['a.lbr', 'b.ospreylib']);
    expect(u.list('rules')).toEqual(['fab.dru']);
    expect(u.list('cam')).toEqual([]);
    expect(await u.read('rules', 'fab.dru')).toBe('x = 1');
    expect(u.has('libraries', 'B.OSPREYLIB')).toBe(true);
  });

  it('asks again for a folder remembered from an earlier visit, then opens it', async () => {
    const folder = new MemDir('hardware');
    folder.permission = 'prompt';
    const u = new UserDir(env({ saved: { where: 'folder', handle: folder } }));
    let changes = 0;
    u.onChange(() => changes++);
    await u.init();
    expect(u.status).toBe('needs-permission');
    expect(u.label).toBe('hardware');
    await expect(u.read('rules', 'x.dru')).rejects.toThrow(/No user directory/);
    expect(await u.reconnect()).toBe(true);
    expect(u.status).toBe('ready');
    expect(changes).toBeGreaterThan(1);
  });

  it("keeps files in the browser's storage, and moves them by zip", async () => {
    const browser = new MemDir('');
    const a = new UserDir(env({ browser }));
    await a.useBrowser();
    expect(a.label).toBe('this browser');
    await a.write('cam', 'jlc.cam', '{"x":1}');
    await a.write('libraries', 'mine.ospreylib', '{"osprey":1}');
    const z = await a.exportZip();

    const b = new UserDir(env({ folder: new MemDir('elsewhere') }));
    await b.choose();
    expect(await b.importZip(z)).toBe(2);
    expect(b.list('cam')).toEqual(['jlc.cam']);
    expect(await b.read('libraries', 'mine.ospreylib')).toBe('{"osprey":1}');
  });
});

describe('unzip', () => {
  it('reads what zip writes', async () => {
    const files = new Map([['a/b.txt', 'hello'], ['c.txt', 'ünïcode']]);
    const out = await unzip(zip(files));
    expect(new Map([...out].map(([k, v]) => [k, new TextDecoder().decode(v)]))).toEqual(files);
  });

  it('reads deflated entries (a zip made by another tool)', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'samples', 'eagle', 'TA7358A_2026-06-12.zip')));
    const out = await unzip(bytes);
    expect(out.size).toBeGreaterThan(3);
    const any = [...out.values()].find((v) => v.length > 100)!;
    expect(new TextDecoder().decode(any.subarray(0, 200))).toMatch(/\S/);
  });
});
