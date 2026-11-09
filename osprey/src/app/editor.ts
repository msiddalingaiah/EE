// Editing controller: turns selected targets + a verb into undoable transactions.

import { gridSpacing, serializeEagle } from '../eagle/parse';
import type { Board, EagleFile } from '../eagle/types';
import {
  deleteTargets, isEditable, mirrorAbout, rotationAbout, transformTargets, translation,
} from '../edit/board';
import { History, Transaction } from '../edit/ops';
import type { Point, Transform } from '../geom/transform';
import { compose } from '../geom/transform';
import type { Target } from '../scene/types';

export class Editor {
  readonly history = new History();

  constructor(readonly file: EagleFile, private readonly onChange: () => void) {}

  get board(): Board | undefined {
    return this.file.board;
  }

  /** Grid spacing in mm; `alt` = the fine grid (Alt held). */
  grid(alt = false): number {
    return gridSpacing(this.file.grid, alt);
  }

  snap(v: number, alt = false): number {
    const g = this.grid(alt);
    return Math.round(v / g) * g;
  }

  /** Targets that commands may change (locked parts are excluded). */
  editable(targets: Target[]): Target[] {
    return this.board ? targets.filter(isEditable) : [];
  }

  rotate(targets: Target[], pivot: Point, quarterTurns: number): void {
    this.commit(quarterTurns > 0 ? 'Rotate' : 'Rotate clockwise', targets, rotationAbout(pivot, quarterTurns));
  }

  /** Flip to the other side of the board, mirroring about the vertical line through the pivot. */
  flip(targets: Target[], pivot: Point): void {
    this.commit('Flip', targets, mirrorAbout(pivot.x));
  }

  delete(targets: Target[]): void {
    const board = this.board;
    const ts = this.editable(targets);
    if (!board || !ts.length) return;
    const tx = new Transaction(`Delete ${describe(ts)}`);
    tx.subjects = ts.map(subject);
    deleteTargets(board, ts, tx);
    this.push(tx);
  }

  /**
   * Start an interactive move; the session previews edits live and commits or cancels.
   * `reference` is the point that snaps to the grid (a part's origin, a trace's grabbed end);
   * without one, the displacement itself is snapped. Rotation and flip happen about `pivot`.
   */
  beginMove(targets: Target[], pivot: Point, reference?: Point): MoveSession | undefined {
    const board = this.board;
    const ts = this.editable(targets);
    if (!board || !ts.length) return undefined;
    return new MoveSession(this, board, ts, pivot, reference);
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

  /** @internal */
  push(tx: Transaction): void {
    this.history.push(tx);
    this.onChange();
  }

  private commit(verb: string, targets: Target[], E: Transform): void {
    const board = this.board;
    const ts = this.editable(targets);
    if (!board || !ts.length) return;
    const tx = new Transaction(`${verb} ${describe(ts)}`);
    tx.subjects = ts.map(subject);
    transformTargets(board, ts, E, tx);
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
    private readonly board: Board,
    readonly targets: Target[],
    /** Rotation and flip happen about this point (before the displacement). */
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

  // The floating transform is R(turns)·M^mirrored about the reference point.
  // Rotating it on screen adds turns; flipping it on screen (M·R(t) = R(-t)·M) negates them.
  rotate(quarterTurns: number): void {
    this.turns += quarterTurns;
    this.preview();
  }

  flip(): void {
    this.turns = -this.turns;
    this.mirrored = !this.mirrored;
    this.preview();
  }

  commit(): void {
    const verb = this.turns % 4 || this.mirrored ? 'Move/rotate' : 'Move';
    const final = new Transaction(`${verb} ${describe(this.targets)}`);
    final.subjects = this.targets.map(subject);
    this.tx.revert();
    transformTargets(this.board, this.targets, this.transform(), final);
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
    transformTargets(this.board, this.targets, this.transform(), this.tx);
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
    case 'plain': return t.graphic;
  }
}
