import { describe, expect, it, vi } from 'vitest';
import { Commands, shortcutOf } from '../src/app/commands';

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift,
});

describe('shortcutOf', () => {
  it('writes letters upper case, with modifiers in a fixed order', () => {
    expect(shortcutOf(key('r'))).toBe('R');
    expect(shortcutOf(key('R', { shift: true }))).toBe('Shift+R');
    expect(shortcutOf(key('s', { ctrl: true }))).toBe('Ctrl+S');
    expect(shortcutOf(key('S', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+S');
    expect(shortcutOf(key('z', { meta: true }))).toBe('Ctrl+Z'); // Cmd on a Mac
    expect(shortcutOf(key('f', { alt: true }))).toBe('Alt+F');
  });

  it('keeps Shift out of symbols it makes, and names keys', () => {
    expect(shortcutOf(key('?', { shift: true }))).toBe('?');
    expect(shortcutOf(key('Tab'))).toBe('Tab');
    expect(shortcutOf(key('Tab', { shift: true }))).toBe('Shift+Tab');
    expect(shortcutOf(key(' '))).toBe('Space');
    expect(shortcutOf(key('Del'))).toBe('Delete');
  });
});

describe('Commands', () => {
  it('matches a key to the enabled command that has it', () => {
    let board = false;
    const wire = vi.fn();
    const route = vi.fn();
    const cs = new Commands();
    cs.add(
      { id: 'wire', label: 'Wire', keys: ['W'], enabled: () => !board, run: wire },
      { id: 'route', label: 'Route', keys: ['W'], enabled: () => board, run: route },
    );
    expect(cs.match(key('w'))?.id).toBe('wire');
    board = true;
    expect(cs.match(key('w'))?.id).toBe('route');
    expect(cs.match(key('w', { shift: true }))).toBeUndefined();
  });

  it('leaves keys the browser handles alone', () => {
    const cs = new Commands();
    cs.add({ id: 'copy', label: 'Copy', keys: ['Ctrl+C'], nativeKeys: true, run: () => {} });
    expect(cs.match(key('c', { ctrl: true }))).toBeUndefined();
  });

  it('lists a second key, and refuses an id used twice', () => {
    const cs = new Commands();
    cs.add({ id: 'redo', label: 'Redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: () => {} });
    expect(cs.match(key('Z', { ctrl: true, shift: true }))?.id).toBe('redo');
    expect(() => cs.add({ id: 'redo', label: 'Again', run: () => {} })).toThrow(/twice/);
  });

  it('runs by id only when enabled', async () => {
    const run = vi.fn();
    let on = false;
    const cs = new Commands();
    cs.add({ id: 'x', label: 'X', enabled: () => on, run });
    expect(await cs.run('x')).toBe(false);
    on = true;
    expect(await cs.run('x')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await cs.run('nope')).toBe(false);
  });

  it('flattens submenus for the palette, with their menu path', () => {
    const cs = new Commands();
    cs.add(
      { id: 'file.save', menu: 'File', label: 'Save', run: () => {} },
      { id: 'file.cam', menu: 'File', label: 'CAM', children: () => [{ id: 'cam.default', label: 'Default', run: () => {} }] },
      { id: 'hidden', menu: 'File', label: 'Hidden', visible: () => false, run: () => {} },
    );
    expect(cs.flat().map(({ command, path }) => `${path}: ${command.id}`)).toEqual(['File: file.save', 'File › CAM: cam.default']);
  });
});
