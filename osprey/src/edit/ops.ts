// Undoable primitive edits. Each one changes the typed model and the XML it was parsed
// from together, so saving writes exactly what the user sees.

import { domOf } from '../eagle/dom';

export interface Op {
  apply(): void;
  revert(): void;
}

type AttrPatch = Record<string, string | null>;

/**
 * Set model fields and the matching XML attributes (null removes an attribute).
 * Old values are captured when the op is created.
 */
export function setFields<T extends object>(obj: T, model: Partial<T>, attrs: AttrPatch): Op {
  const el = domOf(obj);
  const oldModel: Partial<T> = {};
  for (const k of Object.keys(model) as (keyof T)[]) oldModel[k] = obj[k];
  const oldAttrs: AttrPatch = {};
  for (const k of Object.keys(attrs)) oldAttrs[k] = el?.getAttribute(k) ?? null;

  const write = (m: Partial<T>, a: AttrPatch) => {
    Object.assign(obj, m);
    if (!el) return;
    for (const [k, v] of Object.entries(a)) {
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  };
  return { apply: () => write(model, attrs), revert: () => write(oldModel, oldAttrs) };
}

/**
 * Remove `item` from a model list and its element from the XML (with the line break
 * that follows it, so the file stays one element per line). Revert restores both in place.
 */
export function removeItem<T extends object>(list: T[], item: T): Op {
  const el = domOf(item);
  let index = -1;
  let parent: Node | null = null;
  let next: Node | null = null;
  let ws: Node | null = null;
  return {
    apply() {
      index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
      if (el?.parentNode) {
        parent = el.parentNode;
        const after = el.nextSibling;
        ws = after && after.nodeType === 3 && /^\s*$/.test(after.nodeValue ?? '') ? after : null;
        next = ws ? ws.nextSibling : after;
        parent.removeChild(el);
        if (ws) parent.removeChild(ws);
      }
    },
    revert() {
      if (index >= 0) list.splice(index, 0, item);
      if (el && parent) {
        parent.insertBefore(el, next);
        if (ws) parent.insertBefore(ws, next);
      }
    },
  };
}

/** Remove a keyed model entry (e.g. a schematic part) and its XML element; revert restores order. */
export function removeMapEntry<V extends object>(map: Map<string, V>, key: string): Op {
  const value = map.get(key);
  if (!value) return { apply() {}, revert() {} };
  const dom = removeItem([value], value);
  let entries: [string, V][] = [];
  return {
    apply() {
      entries = [...map.entries()];
      map.delete(key);
      dom.apply();
    },
    revert() {
      dom.revert();
      map.clear();
      for (const [k, v] of entries) map.set(k, v);
    },
  };
}

/** A group of ops applied as one undoable step. */
export class Transaction {
  private readonly ops: Op[] = [];

  /** The model objects the user acted on, so undo/redo can reselect them. */
  subjects: object[] = [];

  constructor(readonly label: string) {}

  get empty(): boolean {
    return this.ops.length === 0;
  }

  /** Apply an op now and record it. */
  run(op: Op): void {
    op.apply();
    this.ops.push(op);
  }

  revert(): void {
    for (let i = this.ops.length - 1; i >= 0; i--) this.ops[i]!.revert();
  }

  reapply(): void {
    for (const op of this.ops) op.apply();
  }
}

/** Undo/redo stacks plus a marker for the last saved state. */
export class History {
  private done: Transaction[] = [];
  private undone: Transaction[] = [];
  /** Number of transactions in `done` at the last save; -1 if that state is unreachable. */
  private savedAt = 0;

  push(tx: Transaction): void {
    if (tx.empty) return;
    if (this.savedAt > this.done.length) this.savedAt = -1;
    this.done.push(tx);
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.done[this.done.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.undone[this.undone.length - 1]?.label;
  }

  undo(): Transaction | undefined {
    const tx = this.done.pop();
    if (!tx) return undefined;
    tx.revert();
    this.undone.push(tx);
    return tx;
  }

  redo(): Transaction | undefined {
    const tx = this.undone.pop();
    if (!tx) return undefined;
    tx.reapply();
    this.done.push(tx);
    return tx;
  }

  markSaved(): void {
    this.savedAt = this.done.length;
  }

  get dirty(): boolean {
    return this.savedAt !== this.done.length;
  }
}
