// The command palette (Ctrl+Shift+P): every enabled command, found by typing part of its name
// or menu; and the Help dialogs (shortcuts, about) drawn from the same command list.

import { isEnabled, labelOf, type Command, type Commands } from './commands';

/** Open the palette; runs the chosen command, then calls `after`. */
export function openPalette(commands: Commands, after: () => void): void {
  const all = commands.flat().filter(({ command }) => isEnabled(command));
  const dlg = document.createElement('dialog');
  dlg.className = 'palette';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Type a command…';
  input.setAttribute('aria-label', 'Command');
  const list = document.createElement('div');
  list.className = 'palette-list';
  list.setAttribute('role', 'listbox');
  dlg.append(input, list);

  let shown: { command: Command; path: string }[] = [];
  let at = 0;
  const choose = (c: Command) => {
    dlg.close();
    void Promise.resolve(c.run?.()).finally(after);
  };
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = all.filter(({ command, path }) => {
      const text = `${path} ${labelOf(command)}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.slice(0, 50).map(({ command, path }, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `palette-item${i === at ? ' active' : ''}`;
      b.setAttribute('role', 'option');
      b.dataset.command = command.id;
      const label = document.createElement('span');
      label.textContent = labelOf(command);
      const where = document.createElement('span');
      where.className = 'palette-path';
      where.textContent = path;
      const keys = document.createElement('kbd');
      keys.textContent = command.keys?.[0] ?? '';
      b.append(label, where, keys);
      b.addEventListener('click', () => choose(command));
      return b;
    }));
    if (!shown.length) list.append(Object.assign(document.createElement('div'), { className: 'palette-none', textContent: 'No matching command' }));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    at = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = shown[at]?.command;
      if (c) choose(c);
    }
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    after();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close(); // a click on the backdrop
  });
  document.body.append(dlg);
  dlg.showModal();
  render();
  input.focus();
}

/** Keys that belong to a tool while it runs, not to a command (listed under Shortcuts). */
const MODAL_KEYS: [string, string][] = [
  ['Esc', 'Stop the tool, cancel a move, or clear the selection'],
  ['Enter', 'Close a pour or finish a drawn shape'],
  ['/', 'Wire, route or pour: change how corners bend'],
  ['L / Shift+L', 'Routing: change layer with a via (Shift: even where it breaks clearance)'],
  ['Space + drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Shift + click', 'Add to the selection'],
  ['Ctrl + click', 'Toggle in the selection'],
];

/** A simple modal with a title and content; closes on Esc, a click outside or Close. */
export function showDialog(title: string, body: Node[], after: () => void): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'info-dialog';
  const h = document.createElement('h2');
  h.textContent = title;
  const content = document.createElement('div');
  content.className = 'info-body';
  content.append(...body);
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dlg.close());
  const row = document.createElement('div');
  row.className = 'info-buttons';
  row.append(close);
  dlg.append(h, content, row);
  dlg.addEventListener('close', () => {
    dlg.remove();
    after();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  close.focus();
}

/** Help ▸ Shortcuts: every command with keys, by menu, then the keys tools use. */
export function showShortcuts(commands: Commands, after: () => void): void {
  const table = document.createElement('table');
  table.className = 'shortcuts';
  const row = (keys: string, what: string, head = false) => {
    const tr = document.createElement('tr');
    if (head) {
      const th = document.createElement('th');
      th.colSpan = 2;
      th.textContent = what;
      tr.append(th);
    } else {
      const k = document.createElement('td');
      k.append(Object.assign(document.createElement('kbd'), { textContent: keys }));
      const w = document.createElement('td');
      w.textContent = what;
      tr.append(k, w);
    }
    table.append(tr);
  };
  let menu: string | undefined;
  for (const c of commands.list().filter((x) => x.keys?.length)) {
    const m = c.menu ?? 'Other';
    if (m !== menu) row('', (menu = m), true);
    row(c.keys!.join(' or '), labelOf(c));
  }
  row('', 'While a tool runs', true);
  for (const [k, w] of MODAL_KEYS) row(k, w);
  showDialog('Shortcuts', [table], after);
}
