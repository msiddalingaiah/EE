// The menu bar (File, Edit, View, Tools, Help), drawn from the command list. Menus are rebuilt
// each time one opens, so labels, ticks and enabled states are always current. Mouse: click a
// title to open, hover to move between open menus and into submenus. Keys: Alt+letter opens a
// menu; arrows, Enter and Esc work inside.

import { MENUS, isEnabled, isVisible, labelOf, titleOf, type Command, type Commands, type MenuName } from './commands';

/** A menu item's element id: its own (domId) or one made from the command id. */
export const itemId = (c: Command): string => c.domId ?? `cmd-${c.id.replace(/[^\w-]/g, '-')}`;

/** What a menu holds: commands, submenus of commands, and separators between groups. */
type Entry = { command: Command } | { submenu: string; label: string; items: Command[]; title?: string };

function entries(commands: Command[], menu: MenuName): Entry[] {
  const out: Entry[] = [];
  const subs = new Map<string, Command[]>();
  for (const c of commands) {
    if (c.menu !== menu || !isVisible(c)) continue;
    if (c.children) {
      out.push({ submenu: `${menu}/${labelOf(c)}`, label: labelOf(c), items: c.children().filter(isVisible), ...(titleOf(c) ? { title: titleOf(c)! } : {}) });
    } else if (c.submenu) {
      const list = subs.get(c.submenu);
      if (list) list.push(c);
      else {
        const items = [c];
        subs.set(c.submenu, items);
        out.push({ submenu: `${menu}/${c.submenu}`, label: c.submenu, items });
      }
    } else out.push({ command: c });
  }
  return out;
}

const groupOf = (e: Entry) => ('command' in e ? e.command.group : e.items[0]?.group) ?? '';

export class MenuBar {
  private open: MenuName | undefined;

  constructor(
    private readonly bar: HTMLElement,
    private readonly commands: Commands,
    /** Called after a menu command runs (e.g. to give the canvas focus back). */
    private readonly after: () => void,
  ) {
    bar.setAttribute('role', 'menubar');
    this.build();
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !bar.contains(e.target as Node)) this.close();
    });
    window.addEventListener('keydown', (e) => this.onKey(e), { capture: true });
    window.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return !!this.open;
  }

  /** Draw the bar again (its items' ids stay the same). */
  build(): void {
    const all = this.commands.list();
    this.bar.replaceChildren(...MENUS.map((m) => {
      const wrap = el('div', 'menu');
      wrap.dataset.menuName = m;
      const title = el('button', 'menu-title', m);
      title.type = 'button';
      title.dataset.menuTitle = m;
      title.setAttribute('aria-haspopup', 'menu');
      title.setAttribute('aria-expanded', String(this.open === m));
      title.addEventListener('click', () => (this.open === m ? this.close() : this.show(m)));
      title.addEventListener('pointerenter', () => {
        if (this.open && this.open !== m) this.show(m);
      });
      const pop = this.pop(entries(all, m), m);
      pop.hidden = this.open !== m;
      wrap.append(title, pop);
      return wrap;
    }));
  }

  show(m: MenuName, focusFirst = false): void {
    this.open = m;
    this.build();
    this.bar.classList.add('open');
    if (focusFirst) this.items(this.popOf(m))[0]?.focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = undefined;
    this.bar.classList.remove('open');
    for (const p of this.bar.querySelectorAll<HTMLElement>('.menu-pop')) p.hidden = true;
    for (const t of this.bar.querySelectorAll('.menu-title')) t.setAttribute('aria-expanded', 'false');
  }

  /** Open the menu and submenus leading to an item, e.g. "File/CAM" (for tests and the palette). */
  reveal(path: string): void {
    const [top, ...subs] = path.split('/');
    this.show(top as MenuName);
    let at = top!;
    for (const s of subs) {
      at = `${at}/${s}`;
      const trigger = this.bar.querySelector<HTMLElement>(`[data-submenu="${CSS.escape(at)}"]`);
      if (trigger) this.openSub(trigger);
    }
  }

  private pop(list: Entry[], path: string): HTMLElement {
    const pop = el('div', 'menu-pop');
    pop.setAttribute('role', 'menu');
    let group: string | undefined;
    for (const e of list) {
      const g = groupOf(e);
      if (group !== undefined && g !== group) {
        const sep = el('div', 'menu-sep');
        sep.setAttribute('role', 'separator');
        pop.append(sep);
      }
      group = g;
      if ('command' in e) pop.append(this.item(e.command, path));
      else {
        const wrap = el('div', 'menu-subwrap');
        const trigger = el('button', 'menu-item has-sub');
        trigger.type = 'button';
        trigger.setAttribute('role', 'menuitem');
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.dataset.submenu = e.submenu;
        trigger.dataset.menu = path;
        if (e.title) trigger.title = e.title;
        trigger.append(el('span', 'menu-check'), el('span', 'menu-label', e.label), el('span', 'menu-arrow', '▸'));
        const sub = this.pop(e.items.map((command) => ({ command })), e.submenu);
        sub.classList.add('sub');
        sub.hidden = true;
        trigger.disabled = !e.items.some(isEnabled);
        trigger.addEventListener('click', () => this.openSub(trigger));
        trigger.addEventListener('pointerenter', () => this.openSub(trigger));
        wrap.append(trigger, sub);
        pop.append(wrap);
      }
    }
    return pop;
  }

  private item(c: Command, path: string): HTMLButtonElement {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.id = itemId(c);
    b.dataset.command = c.id;
    b.dataset.menu = path;
    const checked = c.checked?.();
    b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
    b.disabled = !isEnabled(c);
    const title = titleOf(c);
    if (title) b.title = title;
    b.append(el('span', 'menu-check', checked ? '✓' : ''), el('span', 'menu-label', labelOf(c)), el('kbd', 'menu-keys', c.keys?.[0] ?? ''));
    b.addEventListener('pointerenter', () => this.closeSubsIn(b.parentElement!));
    b.addEventListener('click', () => {
      if (b.disabled || !c.run) return;
      this.close();
      void Promise.resolve(c.run()).finally(this.after);
    });
    return b;
  }

  private openSub(trigger: HTMLElement): void {
    const sub = trigger.nextElementSibling as HTMLElement | null;
    if (!sub || (trigger as HTMLButtonElement).disabled) return;
    this.closeSubsIn(trigger.closest('.menu-pop')!);
    sub.hidden = false;
  }

  private closeSubsIn(pop: Element): void {
    for (const s of pop.querySelectorAll<HTMLElement>(':scope > .menu-subwrap > .menu-pop')) s.hidden = true;
  }

  private popOf(m: MenuName): HTMLElement {
    return this.bar.querySelector<HTMLElement>(`[data-menu-name="${m}"] > .menu-pop`)!;
  }

  /** The enabled items directly in a menu (not in its submenus). */
  private items(pop: HTMLElement): HTMLButtonElement[] {
    return [...pop.querySelectorAll<HTMLButtonElement>(':scope > .menu-item, :scope > .menu-subwrap > .menu-item')].filter((b) => !b.disabled);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) {
      // Alt+letter opens a menu (Alt+F: File).
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const m = MENUS.find((x) => x[0]!.toLowerCase() === e.key.toLowerCase());
        if (m) {
          e.preventDefault();
          e.stopPropagation();
          this.show(m, true);
        }
      }
      return;
    }
    // While a menu is open it has the keys; the editor's shortcuts wait.
    const focused = document.activeElement instanceof HTMLButtonElement && this.bar.contains(document.activeElement) ? document.activeElement : undefined;
    const pop = (focused?.closest('.menu-pop') as HTMLElement | null) ?? this.popOf(this.open);
    const list = this.items(pop);
    const i = focused ? list.indexOf(focused) : -1;
    const step = (d: number) => list[(i + d + list.length) % list.length]?.focus();
    const sideways = (d: number) => {
      const m = MENUS[(MENUS.indexOf(this.open!) + d + MENUS.length) % MENUS.length]!;
      this.show(m, true);
    };
    switch (e.key) {
      case 'Escape':
        if (pop.classList.contains('sub')) {
          pop.hidden = true;
          (pop.previousElementSibling as HTMLElement).focus();
        } else this.close();
        break;
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(i < 0 ? 0 : -1); break;
      case 'ArrowRight':
        if (focused?.dataset.submenu) {
          this.openSub(focused);
          this.items(focused.nextElementSibling as HTMLElement)[0]?.focus();
        } else sideways(1);
        break;
      case 'ArrowLeft':
        if (pop.classList.contains('sub')) {
          pop.hidden = true;
          (pop.previousElementSibling as HTMLElement).focus();
        } else sideways(-1);
        break;
      case 'Enter':
      case ' ':
        focused?.click();
        break;
      case 'Tab':
        this.close();
        return;
      default:
        // Ctrl shortcuts close the menu and go ahead; other keys are swallowed.
        if (e.ctrlKey || e.metaKey) {
          this.close();
          return;
        }
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}
