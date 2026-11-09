// Undoable primitive edits. Each one changes the typed model and the XML it was parsed
// from together, so saving writes exactly what the user sees.

import { domOf, link } from '../eagle/dom';

export interface Op {
  apply(): void;
  revert(): void;
}

type AttrPatch = Record<string, string | null>;

/**
 * Set model fields and the matching XML attributes (null removes an attribute).
 * New attributes are placed where Eagle's DTD puts them; revert restores the element's
 * attributes exactly, order included, so undo gives back the original bytes.
 */
export function setFields<T extends object>(obj: T, model: Partial<T>, attrs: AttrPatch): Op {
  const el = domOf(obj);
  const oldModel: Partial<T> = {};
  for (const k of Object.keys(model) as (keyof T)[]) oldModel[k] = obj[k];
  const before = el ? el.getAttributeNames().map((n): [string, string] => [n, el.getAttribute(n)!]) : [];

  return {
    apply() {
      Object.assign(obj, model);
      if (!el) return;
      let added = false;
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null) el.removeAttribute(k);
        else {
          if (!el.hasAttribute(k)) added = true;
          el.setAttribute(k, v);
        }
      }
      if (added) orderAttributes(el);
    },
    revert() {
      Object.assign(obj, oldModel);
      if (!el) return;
      for (const n of el.getAttributeNames()) el.removeAttribute(n);
      for (const [n, v] of before) el.setAttribute(n, v);
    },
  };
}

/** Put an element's attributes in Eagle's DTD order (unknown ones keep their order, last). */
function orderAttributes(el: Element): void {
  const order = ATTRIBUTE_ORDER[el.tagName];
  if (!order) return;
  const attrs = el.getAttributeNames().map((n): [string, string] => [n, el.getAttribute(n)!]);
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i < 0 ? order.length : i;
  };
  const sorted = attrs.map((a, i) => ({ a, i })).sort((p, q) => rank(p.a[0]) - rank(q.a[0]) || p.i - q.i);
  for (const [n] of attrs) el.removeAttribute(n);
  for (const { a: [n, v] } of sorted) el.setAttribute(n, v);
}

/** Attribute order of the elements Osprey edits, from eagle.dtd. */
const ATTRIBUTE_ORDER: Record<string, string[]> = {
  element: ['name', 'library', 'library_urn', 'package', 'package3d_urn', 'override_package3d_urn',
    'override_package_urn', 'override_locally_modified', 'value', 'x', 'y', 'locked', 'populate', 'smashed', 'rot'],
  instance: ['part', 'gate', 'x', 'y', 'smashed', 'rot'],
  part: ['name', 'library', 'library_urn', 'deviceset', 'device', 'package3d_urn', 'override_package3d_urn',
    'override_package_urn', 'override_locally_modified', 'technology', 'value'],
  attribute: ['name', 'value', 'x', 'y', 'size', 'layer', 'font', 'ratio', 'rot', 'display', 'constant', 'align'],
  text: ['x', 'y', 'size', 'layer', 'font', 'ratio', 'rot', 'align', 'distance'],
  label: ['x', 'y', 'size', 'layer', 'font', 'ratio', 'rot', 'xref', 'align', 'grouprefs'],
  wire: ['x1', 'y1', 'x2', 'y2', 'width', 'layer', 'extent', 'style', 'curve', 'cap', 'grouprefs'],
  rectangle: ['x1', 'y1', 'x2', 'y2', 'layer', 'rot', 'grouprefs'],
  vertex: ['x', 'y', 'curve'],
};

const isBlank = (n: Node | null): boolean => !!n && n.nodeType === 3 && /^\s*$/.test(n.nodeValue ?? '');

/**
 * Remove `item` from a model list and its element from the XML (with the line break
 * that follows it, so the file stays one element per line). An element left with no
 * children collapses back to `<x/>`, as Eagle writes it. Revert restores everything in place.
 */
export function removeItem<T extends object>(list: T[], item: T): Op {
  const el = domOf(item);
  let index = -1;
  let parent: Node | null = null;
  let next: Node | null = null;
  let ws: Node | null = null;
  let leftovers: Node[] = [];
  return {
    apply() {
      index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
      if (el?.parentNode) {
        parent = el.parentNode;
        const after = el.nextSibling;
        ws = isBlank(after) ? after : null;
        next = ws ? ws.nextSibling : after;
        parent.removeChild(el);
        if (ws) parent.removeChild(ws);
        const rest = [...parent.childNodes];
        leftovers = rest.length && rest.every(isBlank) ? rest : [];
        for (const n of leftovers) parent.removeChild(n);
      }
    },
    revert() {
      if (index >= 0) list.splice(index, 0, item);
      if (el && parent) {
        for (const n of leftovers) parent.appendChild(n);
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

/** Rename a key of an ordered map (e.g. a schematic part), keeping its position. */
export function renameMapKey<V>(map: Map<string, V>, oldKey: string, newKey: string): Op {
  const swap = (from: string, to: string) => {
    const entries = [...map.entries()].map(([k, v]): [string, V] => [k === from ? to : k, v]);
    map.clear();
    for (const [k, v] of entries) map.set(k, v);
  };
  return { apply: () => swap(oldKey, newKey), revert: () => swap(newKey, oldKey) };
}

/**
 * Add a new model object to `list` and a matching XML element as the last child of
 * `parent`, formatted one element per line as Eagle writes it. The element is created
 * once, so redo re-inserts the very same node.
 */
export function insertChild<T extends object>(
  list: T[], item: T, parent: Element, tag: string, attrs: Record<string, string>,
): Op {
  const doc = parent.ownerDocument;
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  orderAttributes(el);
  link(item, el);
  const added: Node[] = [];
  return {
    apply() {
      list.push(item);
      added.length = 0;
      const last = parent.lastChild;
      if (!last) {
        // <x/> becomes <x>\n<child/>\n</x>
        const open = doc.createTextNode('\n');
        const close = doc.createTextNode('\n');
        parent.append(open, el, close);
        added.push(open, el, close);
      } else if (isBlank(last)) {
        // <x>\n<prev/>\n</x>: the new child goes on its own line before </x>
        const nl = doc.createTextNode('\n');
        parent.insertBefore(nl, last);
        parent.insertBefore(el, last);
        added.push(nl, el);
      } else {
        parent.append(el);
        added.push(el);
      }
    },
    revert() {
      const i = list.lastIndexOf(item);
      if (i >= 0) list.splice(i, 1);
      for (const n of added) n.parentNode?.removeChild(n);
    },
  };
}

/** A group of ops applied as one undoable step. */
export class Transaction {
  private readonly ops: Op[] = [];

  /** The model objects the user acted on, so undo/redo can reselect them. */
  subjects: object[] = [];

  /** The documents this step changes (for per-file "unsaved" tracking). Empty = unknown/all. */
  readonly files = new Set<object>();

  constructor(readonly label: string) {}

  get empty(): boolean {
    return this.ops.length === 0;
  }

  /** Number of ops so far (to tell whether a step of a command changed anything). */
  get size(): number {
    return this.ops.length;
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

const ANY = {};

/**
 * Undo/redo stacks plus save points. Save points can be tracked per document (e.g. a
 * schematic and its board), so each file knows whether it has unsaved changes.
 */
export class History {
  private done: Transaction[] = [];
  private undone: Transaction[] = [];
  /** For each document: the `done` stack as it was when that document was last saved. */
  private saved = new Map<object, Transaction[]>();

  push(tx: Transaction): void {
    if (tx.empty) return;
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

  /** Record that `doc` (or, without one, everything) was saved in the current state. */
  markSaved(doc: object = ANY): void {
    this.saved.set(doc, [...this.done]);
  }

  /**
   * Does `doc` (or anything, without one) differ from its last save? Compares the current
   * history with the one at save time: any step on either side of where they diverge that
   * touches the document means it has changed (including edits undone past the save point).
   */
  isDirty(doc: object = ANY): boolean {
    const snap = this.saved.get(doc) ?? this.saved.get(ANY) ?? [];
    let k = 0;
    while (k < snap.length && k < this.done.length && snap[k] === this.done[k]) k++;
    const changed = [...snap.slice(k), ...this.done.slice(k)];
    return changed.some((tx) => doc === ANY || tx.files.size === 0 || tx.files.has(doc));
  }

  get dirty(): boolean {
    return this.isDirty();
  }
}
