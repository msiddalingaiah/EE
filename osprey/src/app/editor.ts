// Editing controller: turns selected targets + a verb into undoable transactions.
// Works on boards and schematics; the verbs are the same, the rules behind them differ.

import { gridSpacing, serializeEagle } from '../eagle/parse';
import type { EagleFile } from '../eagle/types';
import { deleteBoardTargets, isEditable, transformBoardTargets } from '../edit/board';
import { mirrorAbout, rotationAbout, translation } from '../edit/common';
import { History, Transaction } from '../edit/ops';
import { deleteSchematicTargets, transformSchematicTargets } from '../edit/schematic';
import type { Point, Transform } from '../geom/transform';
import { compose } from '../geom/transform';
import type { Target } from '../scene/types';

export class Editor {
  readonly history = new History();

  constructor(readonly file: EagleFile, private readonly onChange: () => void) {}

  /** Whether this file can be edited (libraries can't yet). */
  get canEdit(): boolean {
    return !!(this.file.board || this.file.schematic);
  }

  /** Name of the mirror verb: boards flip parts to the other side; schematics mirror. */
  get mirrorVerb(): string {
    return this.file.board ? 'Flip' : 'Mirror';
  }

  /** Grid spacing in mm; `alt` = the fine grid (Alt held). */
  grid(alt = false): number {
    return gridSpacing(this.file.grid, alt);
  }

  snap(v: number, alt = false): number {
    const g = this.grid(alt);
    return Math.round(v / g) * g;
  }

  /** Targets that commands may change (locked board parts are excluded). */
  editable(targets: Target[]): Target[] {
    return this.canEdit ? targets.filter(isEditable) : [];
  }

  rotate(targets: Target[], pivot: Point, quarterTurns: number): void {
    this.commit(quarterTurns > 0 ? 'Rotate' : 'Rotate clockwise', targets, rotationAbout(pivot, quarterTurns));
  }

  /** Mirror about the vertical line through the pivot (on boards: flip to the other side). */
  mirror(targets: Target[], pivot: Point): void {
    this.commit(this.mirrorVerb, targets, mirrorAbout(pivot.x));
  }

  delete(targets: Target[]): void {
    const ts = this.editable(targets);
    if (!ts.length) return;
    const tx = new Transaction(`Delete ${describe(ts)}`);
    tx.subjects = ts.map(subject);
    if (this.file.board) deleteBoardTargets(this.file.board, ts, tx);
    else if (this.file.schematic) deleteSchematicTargets(this.file.schematic, ts, tx);
    this.push(tx);
  }

  /**
   * Start an interactive move; the session previews edits live and commits or cancels.
   * `reference` is the point that snaps to the grid (a part's origin, a wire's grabbed end);
   * without one, the displacement itself is snapped. Rotation and mirroring happen about `pivot`.
   */
  beginMove(targets: Target[], pivot: Point, reference?: Point): MoveSession | undefined {
    const ts = this.editable(targets);
    if (!ts.length) return undefined;
    return new MoveSession(this, ts, pivot, reference);
  }

  /** Undo the last step; returns the objects it affected (for reselection). */
  undo(): object[] {
    const tx = this.history.undo();
    if (tx) this.onChange();
    return tx?.subjects ?? [];
  }

  redo(): object[] {
    const tx = this.history.redo();
    if (tx) this.onChange();
    return tx?.subjects ?? [];
  }

  serialize(): string {
    return serializeEagle(this.file);
  }

  /** Apply an edit transform to targets within `tx` (board or schematic rules). */
  transform(targets: Target[], E: Transform, tx: Transaction): void {
    if (this.file.board) transformBoardTargets(this.file.board, targets, E, tx);
    else if (this.file.schematic) transformSchematicTargets(this.file.schematic, targets, E, tx);
  }

  /** @internal */
  push(tx: Transaction): void {
    this.history.push(tx);
    this.onChange();
  }

  private commit(verb: string, targets: Target[], E: Transform): void {
    const ts = this.editable(targets);
    if (!ts.length) return;
    const tx = new Transaction(`${verb} ${describe(ts)}`);
    tx.subjects = ts.map(subject);
    this.transform(ts, E, tx);
    this.push(tx);
  }
}

/**
 * A move in progress. Each update reverts the previous preview and applies the new
 * placement, so the model always shows exactly what will be committed.
 */
export class MoveSession {
  private tx: Transaction;
  private delta: Point = { x: 0, y: 0 };
  private turns = 0;
  private mirrored = false;

  constructor(
    private readonly editor: Editor,
    readonly targets: Target[],
    /** Rotation and mirroring happen about this point (before the displacement). */
    private readonly pivot: Point,
    /** If set, this point lands on the grid; otherwise the displacement is snapped. */
    private readonly reference?: Point,
  ) {
    this.tx = new Transaction(`Move ${describe(targets)}`);
  }

  get offset(): Point {
    return this.delta;
  }

  /** Displace by `raw`, snapped so the reference point (or the displacement) is on the grid. */
  moveBy(raw: Point, fineGrid: boolean): void {
    const r = this.reference ?? { x: 0, y: 0 };
    const tx = this.editor.snap(r.x + raw.x, fineGrid) - r.x;
    const ty = this.editor.snap(r.y + raw.y, fineGrid) - r.y;
    if (tx === this.delta.x && ty === this.delta.y) return;
    this.delta = { x: tx, y: ty };
    this.preview();
  }

  // The floating transform is R(turns)·M^mirrored about the pivot.
  // Rotating it on screen adds turns; mirroring it on screen (M·R(t) = R(-t)·M) negates them.
  rotate(quarterTurns: number): void {
    this.turns += quarterTurns;
    this.preview();
  }

  mirror(): void {
    this.turns = -this.turns;
    this.mirrored = !this.mirrored;
    this.preview();
  }

  commit(): void {
    const verb = this.turns % 4 || this.mirrored ? 'Move/rotate' : 'Move';
    const final = new Transaction(`${verb} ${describe(this.targets)}`);
    final.subjects = this.targets.map(subject);
    this.tx.revert();
    this.editor.transform(this.targets, this.transform(), final);
    this.editor.push(final);
  }

  cancel(): void {
    this.tx.revert();
    this.tx = new Transaction('');
  }

  private transform(): Transform {
    const r = this.pivot;
    let E = rotationAbout(r, this.turns);
    if (this.mirrored) E = compose(E, mirrorAbout(r.x));
    return compose(translation(this.delta.x, this.delta.y), E);
  }

  private preview(): void {
    this.tx.revert();
    this.tx = new Transaction('');
    this.editor.transform(this.targets, this.transform(), this.tx);
  }
}

/** Short description of targets for undo labels, e.g. "C2" or "3 objects". */
function describe(ts: Target[]): string {
  if (ts.length === 1) {
    const t = ts[0]!;
    switch (t.kind) {
      case 'element': return t.element.name;
      case 'signal-wire': return `trace on ${t.signal.name}`;
      case 'via': return `via on ${t.signal.name}`;
      case 'signal-polygon': return `polygon on ${t.signal.name}`;
      case 'instance': return t.instance.part;
      case 'net-wire': return `wire on ${t.net.name}`;
      case 'junction': return `junction on ${t.net.name}`;
      case 'label': return `label ${t.net.name}`;
      case 'plain': return t.graphic.kind;
    }
  }
  return `${ts.length} objects`;
}

/** The model object a target stands for. */
export function subject(t: Target): object {
  switch (t.kind) {
    case 'element': return t.element;
    case 'signal-wire': return t.wire;
    case 'via': return t.via;
    case 'signal-polygon': return t.polygon;
    case 'instance': return t.instance;
    case 'net-wire': return t.wire;
    case 'junction': return t.junction;
    case 'label': return t.label;
    case 'plain': return t.graphic;
  }
}
