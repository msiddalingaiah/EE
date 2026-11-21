// The native app's file access (src/app/native.ts), on an in-memory stand-in for its commands.

import { describe, expect, it } from 'vitest';
import { nativeUserDir, type Invoke } from '../src/app/native';

/** The native commands over a map of path → bytes (folders: path → undefined). */
function fakeFs(picked: string | null = 'C:\\Users\\me\\Osprey') {
  const files = new Map<string, Uint8Array | undefined>();
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '');
  const invoke: Invoke = async (cmd, args, options) => {
    const a = args as { path?: string };
    switch (cmd) {
      case 'pick_folder':
        if (picked) files.set(norm(picked), undefined);
        return picked;
      case 'fs_mkdir': {
        const parts = norm(a.path!).split('\\');
        for (let i = 1; i <= parts.length; i++) {
          const p = parts.slice(0, i).join('\\');
          if (!files.has(p)) files.set(p, undefined);
        }
        return null;
      }
      case 'fs_list': {
        const dir = norm(a.path!);
        if (!files.has(dir) || files.get(dir)) throw new Error(`${dir}: not found`);
        return [...files].filter(([p]) => p.startsWith(`${dir}\\`) && !p.slice(dir.length + 1).includes('\\'))
          .map(([p, v]) => ({ name: p.slice(dir.length + 1), dir: v === undefined }));
      }
      case 'fs_is_file':
        return !!files.get(norm(a.path!));
      case 'fs_read': {
        const f = files.get(norm(a.path!));
        if (!f) throw new Error('not found');
        return f.slice().buffer;
      }
      case 'fs_write':
        files.set(norm(decodeURIComponent(options!.headers.path!)), args as Uint8Array);
        return null;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return { files, invoke };
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('native user directory', () => {
  it('uses a chosen folder, and finds it ready again after a restart with nothing to reconnect', async () => {
    const fs = fakeFs();
    const storage = memStorage();
    const ud = nativeUserDir(fs.invoke, storage);
    await ud.init();
    expect(ud.status).toBe('none');
    expect(ud.canPickFolder).toBe(true);
    expect(ud.canUseBrowser).toBe(false);
    expect(await ud.choose()).toBe(true);
    expect(ud.status).toBe('ready');
    expect(ud.label).toBe('Osprey');

    await ud.write('libraries', 'mine.ospreylib', '{"osprey":1}');
    await ud.write('rules', 'jlc.dru', 'x');
    expect(fs.files.has('C:\\Users\\me\\Osprey\\libraries\\mine.ospreylib')).toBe(true);
    expect(ud.list('libraries')).toEqual(['mine.ospreylib']);
    expect(await ud.read('libraries', 'mine.ospreylib')).toBe('{"osprey":1}');

    // The next start: the same folder, ready at once.
    const again = nativeUserDir(fs.invoke, storage);
    await again.init();
    expect(again.status).toBe('ready');
    expect(again.list('libraries')).toEqual(['mine.ospreylib']);
    expect(again.list('rules')).toEqual(['jlc.dru']);
  });

  it('keeps names with spaces and accents, and reports a missing file', async () => {
    const fs = fakeFs('D:\\Dossiers été\\Osprey dir');
    const ud = nativeUserDir(fs.invoke, memStorage());
    await ud.choose();
    await ud.write('cam', 'two layer é.cam', 'job');
    expect(ud.list('cam')).toEqual(['two layer é.cam']);
    await expect(ud.read('cam', 'nope.cam')).rejects.toThrow(/not found/);
  });

  it('treats a cancelled dialog as no choice, and a folder deleted since as not set up', async () => {
    const cancelled = nativeUserDir(fakeFs(null).invoke, memStorage());
    expect(await cancelled.choose()).toBe(false);
    expect(cancelled.status).toBe('none');

    const fs = fakeFs();
    const storage = memStorage();
    await nativeUserDir(fs.invoke, storage).choose();
    for (const k of [...fs.files.keys()]) if (k.startsWith('C:\\Users\\me\\Osprey')) fs.files.delete(k);
    const after = nativeUserDir(fs.invoke, storage);
    await after.init();
    expect(after.status).toBe('none');
    expect(fs.files.has('C:\\Users\\me\\Osprey')).toBe(false);
  });
});
