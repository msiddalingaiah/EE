// The selection set: the "noun" half of noun-verb editing.
// Commands (verbs) will operate on whatever is selected here.

export type SelectMode = 'replace' | 'add' | 'toggle';

export class Selection {
  private ids = new Set<string>();
  private listeners: (() => void)[] = [];

  get items(): ReadonlySet<string> {
    return this.ids;
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Apply a pick result. An empty pick in replace mode clears the selection. */
  select(ids: Iterable<string>, mode: SelectMode): void {
    const next = mode === 'replace' ? new Set<string>() : new Set(this.ids);
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id);
      else next.add(id);
    }
    this.set(next);
  }

  clear(): void {
    this.set(new Set());
  }

  private set(next: Set<string>): void {
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    for (const fn of this.listeners) fn();
  }
}
