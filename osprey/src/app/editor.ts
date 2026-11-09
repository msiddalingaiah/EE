// Editing controller: turns selected targets + a verb into undoable transactions.
// Works on a project (schematic and/or board): geometry edits apply to the document the
// targets live in; netlist edits (delete) are annotated to the other document too.

import { gridSpacing, serializeEagle } from '../eagle/parse';
import type { EagleFile } from '../eagle/types';
import { isEditable, transformBoardTargets } from '../edit/board';
import { mirrorAbout, rotationAbout, translation } from '../edit/common';
import { History, Transaction } from '../edit/ops';
import { transformSchematicTargets } from '../edit/schematic';
import {
  renameNet, renamePart, setPartValue, smash, unsmash, type Docs, type Touched,
} from '../edit/properties';
import type { Point, Transform } from '../geom/transform';
import { compose } from '../geom/transform';
import { deletableTargets, deleteAnnotated, splitTargets } from '../project/annotate';
import type { Project } from '../project/project';
import type { Target } from '../scene/types';

export class Editor {
  readonly history = new History();

  constructor(readonly project: Project, private readonly onChange: () => void) {}

  private get sch() {
    return this.project.schematic?.file.schematic;
  }

  private get brd() {
    return this.project.board?.file.board;
  }

  /** Whether the project can be edited (libraries can't yet). */
  get canEdit(): boolean {
    return !!(this.sch || this.brd);
  }

  /** Grid spacing in mm of a document; `alt` = the fine grid (Alt held). */
  grid(file: EagleFile, alt = false): number {
    return gridSpacing(file.grid, alt);
  }

  /** Targets that commands may change (locked board parts are excluded). */
  editable(targets: Target[]): Target[] {
    return this.canEdit ? targets.filter(isEditable) : [];
  }

  rotate(targets: Target[], pivot: Point, quarterTurns: number): void {
    this.commit(quarterTurns > 0 ? 'Rotate' : 'Rotate clockwise', targets, rotationAbout(pivot, quarterTurns));
  }

  /** Mirror about the vertical line through the pivot (on boards: flip to the other side). */
  mirror(targets: Target[], pivot: Point, verb: string): void {
    this.commit(verb, targets, mirrorAbout(pivot.x));
  }

  /**
   * Delete targets, keeping schematic and board consistent when both are open.
   * Returns the names of parts that weren't deleted because their board element is locked.
   */
  delete(targets: Target[]): string[] {
    const { ok, locked } = deletableTargets(this.editable(targets), this.brd);
    if (!ok.length) return locked;
    const tx = new Transaction(`Delete ${describe(ok)}`);
    tx.subjects = ok.map(subject);
    const touched = deleteAnnotated(this.sch, this.brd, ok, tx);
    if (touched.schematic) tx.files.add(this.project.schematic!.file);
    if (touched.board) tx.files.add(this.project.board!.file);
    this.push(tx);
    return locked;
  }

  // -------------------------------------------------------------------------
  // Properties. Each returns an error message when the change isn't allowed.

  renamePart(oldName: string, newName: string): string | undefined {
    return this.property(`Rename ${oldName}`, (tx) => renamePart(this.docs, oldName, newName, tx));
  }

  setValue(partName: string, value: string): string | undefined {
    return this.property(`Set value of ${partName}`, (tx) => setPartValue(this.docs, partName, value, tx));
  }

  renameNet(oldName: string, newName: string): string | undefined {
    return this.property(`Rename net ${oldName}`, (tx) => renameNet(this.docs, oldName, newName, tx));
  }

  /** Smash (detach name/value texts) or unsmash gates and elements. Returns how many changed. */
  setSmashed(targets: Target[], on: boolean): number {
    const tx = new Transaction(on ? 'Smash' : 'Unsmash');
    let n = 0;
    for (const t of this.editable(targets)) {
      if (t.kind !== 'instance' && t.kind !== 'element') continue;
      const obj = t.kind === 'instance' ? t.instance : t.element;
      const changed = on ? smash(this.docs, obj, tx) : unsmash(obj, tx);
      if (!changed) continue;
      n++;
      tx.subjects.push(obj);
      tx.files.add(t.kind === 'instance' ? this.project.schematic!.file : this.project.board!.file);
    }
    if (n) this.push(tx);
    return n;
  }

  private get docs(): Docs {
    return { sch: this.sch, brd: this.brd };
  }

  private property(label: string, run: (tx: Transaction) => string | Touched): string | undefined {
    const tx = new Transaction(label);
    const result = run(tx);
    if (typeof result === 'string') {
      tx.revert();
      return result;
    }
    if (result.schematic) tx.files.add(this.project.schematic!.file);
    if (result.board) tx.files.add(this.project.board!.file);
    if (!tx.empty) this.push(tx);
    return undefined;
  }

  /**
   * Start an interactive move; the session previews edits live and commits or cancels.
   * `reference` is the point that snaps to the grid (a part's origin, a wire's grabbed end);
   * without one, the displacement itself is snapped. Rotation and mirroring happen about `pivot`.
   */
  beginMove(targets: Target[], grid: (alt: boolean) => number, pivot: Point, reference?: Point): MoveSession | undefined {
    const ts = this.editable(targets);
    if (!ts.length) return undefined;
    return new MoveSession(this, ts, grid, pivot, reference);
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

  isDirty(file: EagleFile): boolean {
    return this.history.isDirty(file);
  }

  get anyDirty(): boolean {
    return this.project.files.some((f) => this.history.isDirty(f.file));
  }

  serialize(file: EagleFile): string {
    return serializeEagle(file);
  }

  /** Apply an edit transform to targets within `tx`, each in the document it belongs to. */
  transform(targets: Target[], E: Transform, tx: Transaction): void {
    const { board, schematic } = splitTargets(targets, this.brd);
    if (board.length && this.brd) {
      transformBoardTargets(this.brd, board, E, tx);
      tx.files.add(this.project.board!.file);
    }
    if (schematic.length && this.sch) {
      transformSchematicTargets(this.sch, schematic, E, tx);
      tx.files.add(this.project.schematic!.file);
    }
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
    /** Grid spacing of the document being edited (`alt` = fine grid). */
    private readonly grid: (alt: boolean) => number,
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
    const g = this.grid(fineGrid);
    const snap = (v: number) => Math.round(v / g) * g;
    const r = this.reference ?? { x: 0, y: 0 };
    const tx = snap(r.x + raw.x) - r.x;
    const ty = snap(r.y + raw.y) - r.y;
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
      case 'attribute': return `${'gate' in t.parent ? t.parent.part : t.parent.name} ${t.attribute.name.toLowerCase()}`;
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
    case 'attribute': return t.attribute;
  }
}
