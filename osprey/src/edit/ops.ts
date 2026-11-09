// Undoable primitive edits on the native model, and the undo history.

export interface Op {
  apply(): void;
  revert(): void;
}

/**
 * Set fields of a model object. A value of `undefined` removes the field, so optional
 * fields return to their (omitted) default. Old values are captured when the op is created.
 */
export function set<T extends object>(obj: T, patch: Partial<Record<keyof T, unknown>>): Op {
  const rec = obj as Record<string, unknown>;
  const before = new Map<string, { had: boolean; value: unknown }>();
  for (const k of Object.keys(patch)) before.set(k, { had: k in rec, value: rec[k] });
  const write = (values: Map<string, { had: boolean; value: unknown }>) => {
    for (const [k, v] of values) {
      if (!v.had || v.value === undefined) delete rec[k];
      else rec[k] = v.value;
    }
  };
  const after = new Map(Object.entries(patch).map(([k, v]) => [k, { had: v !== undefined, value: v }]));
  return { apply: () => write(after), revert: () => write(before) };
}

/** Remove `item` from `list`; revert puts it back at the same index. */
export function remove<T>(list: T[], item: T): Op {
  let index = -1;
  return {
    apply() {
      index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
    },
    revert() {
      if (index >= 0) list.splice(index, 0, item);
    },
  };
}

/** Insert `item` into `list` (at the end, or at `index`). */
export function insert<T>(list: T[], item: T, index?: number): Op {
  return {
    apply() {
      list.splice(index ?? list.length, 0, item);
    },
    revert() {
      const i = list.lastIndexOf(item);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

/** Remove an optional array field from its owner when the array becomes empty (and restore it). */
export function dropIfEmpty<T extends object>(owner: T, key: keyof T): Op {
  let dropped: unknown;
  return {
    apply() {
      const v = owner[key];
      if (Array.isArray(v) && v.length === 0) {
        dropped = v;
        delete owner[key];
      } else dropped = undefined;
    },
    revert() {
      if (dropped !== undefined) (owner as Record<string, unknown>)[key as string] = dropped;
    },
  };
}

/** A group of ops applied as one undoable step. */
export class Transaction {
  private readonly ops: Op[] = [];

  /** The model objects the user acted on, so undo/redo can reselect them. */
  subjects: object[] = [];

  constructor(public label: string) {}

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

/** Undo/redo stacks plus the save point. */
export class History {
  private done: Transaction[] = [];
  private undone: Transaction[] = [];
  /** The `done` stack as it was when last saved. */
  private saved: Transaction[] = [];

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

  markSaved(): void {
    this.saved = [...this.done];
  }

  /** Unsaved changes: the history differs from the one at the last save. */
  get dirty(): boolean {
    return this.saved.length !== this.done.length || this.saved.some((tx, i) => tx !== this.done[i]);
  }
}
