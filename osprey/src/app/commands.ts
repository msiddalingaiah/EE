// The command list: every command the menus, toolbar, shortcuts and command palette offer, by
// id, with its label, keys and state. The command line (README Next) will use the same ids.
// No DOM here beyond reading a KeyboardEvent's fields, so it can be tested on its own.

export type MenuName = 'File' | 'Edit' | 'View' | 'Tools' | 'Help';
export const MENUS: MenuName[] = ['File', 'Edit', 'View', 'Tools', 'Help'];

export interface Command {
  /** Stable id ("file.save"); the command line and tests use it. */
  id: string;
  /** Shown in menus and the palette; a function for labels that follow state ("Undo Rotate R1"). */
  label: string | (() => string);
  /** The menu it is in, and a submenu inside that ("CAM"); none = palette and keys only. */
  menu?: MenuName;
  submenu?: string;
  /** Items in a menu are grouped by this; a separator goes between groups. */
  group?: string;
  /** Keys that run it ("Ctrl+S", "Shift+B", "R", "Delete"); the first is shown. */
  keys?: string[];
  /** The keys are handled by the browser (Ctrl+C: the copy event); shown, not matched. */
  nativeKeys?: true;
  /** The element id of its menu item, where tests (and older links) know it by one. */
  domId?: string;
  /** Explanation shown as the menu item's tooltip. */
  title?: string | (() => string);
  /** Whether it can run now; disabled in menus and skipped by keys when false. */
  enabled?: () => boolean;
  /** Shown with a tick (a setting that is on). */
  checked?: () => boolean;
  /** Left out of menus and the palette when false (e.g. needs a browser feature). */
  visible?: () => boolean;
  /** A submenu whose items are computed when shown (CAM jobs, samples); `run` is unused. */
  children?: () => Command[];
  run?: () => void | Promise<void>;
}

export const labelOf = (c: Command): string => (typeof c.label === 'function' ? c.label() : c.label);
export const titleOf = (c: Command): string | undefined => (typeof c.title === 'function' ? c.title() : c.title);
export const isEnabled = (c: Command): boolean => c.enabled?.() ?? true;
export const isVisible = (c: Command): boolean => c.visible?.() ?? true;

/** The shortcut a key event stands for, written as in `Command.keys` ("Ctrl+Shift+S", "R", "Home"). */
export function shortcutOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  const named: Record<string, string> = { ' ': 'Space', Del: 'Delete', Esc: 'Escape' };
  let key = named[e.key] ?? e.key;
  if (key.length === 1) key = key.toUpperCase();
  const mods = [
    e.ctrlKey || e.metaKey ? 'Ctrl' : '',
    e.altKey ? 'Alt' : '',
    // Shift is part of the key for symbols ("?", "/"); for letters and named keys it is a modifier.
    e.shiftKey && (/^[A-Z0-9]$/.test(key) || key.length > 1) ? 'Shift' : '',
  ].filter(Boolean);
  return [...mods, key].join('+');
}

export class Commands {
  private readonly byId = new Map<string, Command>();

  add(...cs: Command[]): void {
    for (const c of cs) {
      if (this.byId.has(c.id)) throw new Error(`Command ${c.id} is defined twice`);
      this.byId.set(c.id, c);
    }
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  /** All commands, in the order added (menus keep that order). */
  list(): Command[] {
    return [...this.byId.values()];
  }

  /** The enabled command this key event runs, if any. */
  match(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): Command | undefined {
    const s = shortcutOf(e);
    const hits = this.list().filter((c) => !c.nativeKeys && c.run && c.keys?.includes(s) && isEnabled(c));
    if (hits.length > 1) console.warn(`${s} runs ${hits.map((c) => c.id).join(' and ')}; the first wins`);
    return hits[0];
  }

  /** Run a command by id when it is enabled; returns whether it ran. */
  async run(id: string): Promise<boolean> {
    const c = this.byId.get(id);
    if (!c?.run || !isEnabled(c)) return false;
    await c.run();
    return true;
  }

  /** Every runnable command, submenus' items included, with its menu path ("File › CAM"). */
  flat(): { command: Command; path: string }[] {
    const out: { command: Command; path: string }[] = [];
    for (const c of this.list()) {
      if (!isVisible(c)) continue;
      const path = [c.menu, c.submenu].filter(Boolean).join(' › ');
      if (c.children) {
        const inner = [path, labelOf(c)].filter(Boolean).join(' › ');
        for (const k of c.children()) if (k.run && isVisible(k)) out.push({ command: k, path: inner });
      } else if (c.run) out.push({ command: c, path });
    }
    return out;
  }
}
