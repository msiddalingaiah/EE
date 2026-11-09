// Editing controller: turns selected targets + a verb into undoable transactions on the
// native project. Schematic and board are one model, so every command keeps them in step.

import type { Point, Transform } from '../geom/transform';
import { compose } from '../geom/transform';
import { ProjectIndex } from '../model/derive';
import { writeProject } from '../model/file';
import type * as O from '../model/types';
import type { Grid, Project } from '../model/types';
import { deleteTargets } from '../edit/delete';
import { History, insert, remove, Transaction } from '../edit/ops';
import { addToLibrary, createPart, gatesToPlace } from '../edit/place';
import { addWire, cleanPath, sheetPins, snapPoints, touchAt, usualWireWidth, type WireResult } from '../edit/wire';
import { renameNet, renamePart, setPartValue, smash, unsmash } from '../edit/properties';
import { isEditable, mirrorAbout, rotationAbout, transformTargets, translation } from '../edit/transform';
import type { Target } from '../scene/types';

export class Editor {
  readonly history = new History();

  constructor(readonly project: Project, private readonly onChange: () => void) {}

  /** A fresh index: the project changes with every edit. */
  index(): ProjectIndex {
    return new ProjectIndex(this.project);
  }

  /** Grid spacing in mm of the schematic or board; `alt` = the fine grid (Alt held). */
  grid(view: 'schematic' | 'board', alt = false): number {
    const g: Grid | undefined = view === 'board' ? this.project.board?.grid : this.project.schematic?.grid;
    return (alt ? g?.fine : g?.step) ?? (alt ? 0.127 : 1.27);
  }

  /** Targets that commands may change (locked footprints are excluded). */
  editable(targets: Target[]): Target[] {
    return targets.filter(isEditable);
  }

  rotate(targets: Target[], pivot: Point, quarterTurns: number): void {
    this.commit(quarterTurns > 0 ? 'Rotate' : 'Rotate clockwise', targets, rotationAbout(pivot, quarterTurns));
  }

  /** Mirror about the vertical line through the pivot (on the board: flip to the other side). */
  mirror(targets: Target[], pivot: Point, verb: string): void {
    this.commit(verb, targets, mirrorAbout(pivot.x));
  }

  /** Delete targets; returns the names of parts kept because their footprint is locked. */
  delete(targets: Target[]): string[] {
    const tx = new Transaction(`Delete ${describe(targets)}`);
    tx.subjects = targets.map(subject);
    const locked = deleteTargets(this.project, targets, tx, this.index());
    this.push(tx);
    return locked;
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

  /** Start adding parts of a component (from the project library or a loaded one) on a sheet. */
  beginPlace(source: O.Library, componentId: string, variant: string, technology: string, sheetIndex: number, grid: (alt: boolean) => number): PlaceSession | undefined {
    const sheet = this.project.schematic?.sheets[sheetIndex];
    if (!sheet) return undefined;
    return new PlaceSession(this, source, componentId, variant, technology, sheet, grid);
  }

  /** Start drawing wires on a sheet. */
  beginWire(sheetIndex: number, grid: (alt: boolean) => number): WireSession | undefined {
    const sheet = this.project.schematic?.sheets[sheetIndex];
    return sheet ? new WireSession(this, sheet, grid) : undefined;
  }

  // Properties. Each returns an error message when the change isn't allowed.

  renamePart(oldName: string, newName: string): string | undefined {
    return this.property(`Rename ${oldName}`, (tx) => renamePart(this.project, oldName, newName, tx));
  }

  setValue(partName: string, value: string): string | undefined {
    return this.property(`Set value of ${partName}`, (tx) => setPartValue(this.project, partName, value, tx, this.index()));
  }

  renameNet(oldName: string, newName: string): string | undefined {
    return this.property(`Rename net ${oldName}`, (tx) => renameNet(this.project, oldName, newName, tx, this.index()));
  }

  /** Smash (detach name/value texts) or unsmash gates and footprints. Returns how many changed. */
  setSmashed(targets: Target[], on: boolean): number {
    const tx = new Transaction(on ? 'Smash' : 'Unsmash');
    const index = this.index();
    let n = 0;
    for (const t of this.editable(targets)) {
      const placement = t.kind === 'gate' ? t.gate : t.kind === 'footprint' ? t.footprint : undefined;
      if (!placement) continue;
      if (on ? smash(this.project, placement, tx, index) : unsmash(placement, tx)) {
        n++;
        tx.subjects.push(placement);
      }
    }
    if (n) this.push(tx);
    return n;
  }

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

  /** The project as `.osprey` text. */
  serialize(): string {
    return writeProject(this.project);
  }

  /** Apply an edit transform to targets within `tx`. */
  transform(targets: Target[], E: Transform, tx: Transaction): void {
    transformTargets(this.project, targets, E, tx, this.index());
  }

  /** @internal */
  push(tx: Transaction): void {
    this.history.push(tx);
    this.onChange();
  }

  private property(label: string, run: (tx: Transaction) => string | undefined): string | undefined {
    const tx = new Transaction(label);
    const err = run(tx);
    if (err) {
      tx.revert();
      return err;
    }
    if (!tx.empty) this.push(tx);
    return undefined;
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
    const dx = snap(r.x + raw.x) - r.x;
    const dy = snap(r.y + raw.y) - r.y;
    if (dx === this.delta.x && dy === this.delta.y) return;
    this.delta = { x: dx, y: dy };
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

/**
 * Adding parts. A gate floats under the cursor; each click places it, then the next gate of
 * the part, then starts the next part of the same component, until cancelled. Each part is one
 * undo step. The floating gate is a real placement in the model, so the views show it.
 */
export class PlaceSession {
  private tx: Transaction | undefined;
  private part: O.Part | undefined;
  private queue: O.Gate[] = [];
  private current: O.GatePlacement | undefined;
  private placed = 0;
  private at: O.Pt = [0, 0];
  private rot = 0;
  private mirrored = false;
  /** Items the project already had in a different version (its copies are used). */
  readonly libraryNotes: string[] = [];

  constructor(
    private readonly editor: Editor,
    private readonly source: O.Library,
    readonly componentId: string,
    private readonly variant: string,
    private readonly technology: string,
    private readonly sheet: O.Sheet,
    private readonly grid: (alt: boolean) => number,
  ) {
    this.startPart();
  }

  /** Name of the part being placed, and of the gate floating now. */
  get placing(): { part: string; gate: string } | undefined {
    return this.part && this.current ? { part: this.part.name, gate: this.current.gate } : undefined;
  }

  moveTo(p: Point, fineGrid: boolean): void {
    const g = this.grid(fineGrid);
    const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
    this.at = [snap(p.x), snap(p.y)];
    if (this.current) this.current.at = this.at;
  }

  rotate(quarterTurns: number): void {
    this.rot = (((this.rot + quarterTurns * 90) % 360) + 360) % 360;
    this.applyOrientation();
  }

  mirror(): void {
    this.mirrored = !this.mirrored;
    this.applyOrientation();
  }

  /** Place the floating gate. Returns the part name when a part was completed. */
  click(): string | undefined {
    if (!this.current || !this.tx || !this.part) return undefined;
    this.placed++;
    this.tx.subjects.push(this.current);
    const next = this.queue.shift();
    if (next) {
      this.floatGate(next);
      return undefined;
    }
    const done = this.part.name;
    this.current = undefined;
    this.editor.push(this.tx);
    this.startPart();
    return done;
  }

  /** Stop: drop the floating gate; a part with gates already placed is kept. */
  cancel(): void {
    if (!this.tx) return;
    if (this.placed === 0) {
      this.tx.revert();
    } else if (this.current) {
      this.tx.run(remove(this.sheet.gates, this.current));
      this.editor.push(this.tx);
    }
    this.tx = undefined;
    this.current = undefined;
  }

  private startPart(): void {
    const project = this.editor.project;
    const tx = new Transaction('');
    this.libraryNotes.push(...addToLibrary(project, this.source, this.componentId, tx));
    const component = project.library.components.find((c) => c.id === this.componentId)!;
    const { part, footprint } = createPart(project, component, this.variant, this.technology, tx);
    if (footprint) tx.subjects.push(footprint);
    tx.label = `Add ${part.name}`;
    this.tx = tx;
    this.part = part;
    this.placed = 0;
    this.queue = gatesToPlace(component);
    const first = this.queue.shift();
    if (first) this.floatGate(first);
  }

  private floatGate(gate: O.Gate): void {
    const g: O.GatePlacement = { part: this.part!.name, gate: gate.name, at: this.at };
    this.current = g;
    this.applyOrientation();
    this.tx!.run(insert(this.sheet.gates, g));
  }

  private applyOrientation(): void {
    if (!this.current) return;
    if (this.rot) this.current.rot = this.rot;
    else delete this.current.rot;
    if (this.mirrored) this.current.mirror = true;
    else delete this.current.mirror;
  }
}

/**
 * Drawing wires. The first click starts a wire; each click adds a leg (an L bend to the
 * cursor); a click on a pin or wire, a double click or Esc finishes it as one undo step. The
 * wire in progress isn't in the model until finished: `path` gives it for drawing.
 */
export class WireSession {
  private points: O.Pt[] = [];
  private cursor: O.Pt = [0, 0];
  /** The first leg of an L bend runs vertically (instead of horizontally). */
  private verticalFirst = false;
  private snaps: O.Pt[] = [];
  /** Whether the cursor sits on a pin or wire end. */
  snapped = false;
  readonly width: number;

  constructor(
    private readonly editor: Editor,
    readonly sheet: O.Sheet,
    private readonly grid: (alt: boolean) => number,
  ) {
    this.width = usualWireWidth(editor.project);
    this.refresh();
  }

  get drawing(): boolean {
    return this.points.length > 0;
  }

  /** The wire as drawn so far, plus the bend to the cursor. */
  get path(): Point[] {
    if (!this.points.length) return [];
    return [...this.points, ...this.leg()].map(([x, y]) => ({ x, y }));
  }

  get at(): Point {
    return { x: this.cursor[0], y: this.cursor[1] };
  }

  /** Move the cursor: onto a pin or wire end within `tolerance`, else onto the grid. */
  moveTo(p: Point, fineGrid: boolean, tolerance: number): void {
    let best: O.Pt | undefined;
    let d = tolerance;
    for (const s of this.snaps) {
      const e = Math.hypot(s[0] - p.x, s[1] - p.y);
      if (e <= d) [best, d] = [s, e];
    }
    this.snapped = !!best;
    if (best) {
      this.cursor = [best[0], best[1]];
    } else {
      const g = this.grid(fineGrid);
      const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
      this.cursor = [snap(p.x), snap(p.y)];
    }
  }

  flipBend(): void {
    this.verticalFirst = !this.verticalFirst;
  }

  /**
   * Click at the cursor: start a wire or add a leg. Returns 'finish' when the wire reached a
   * pin or another wire (the caller then finishes it).
   */
  click(): 'started' | 'added' | 'finish' {
    if (!this.points.length) {
      this.points = [this.cursor];
      return 'started';
    }
    this.points = cleanPath([...this.points, ...this.leg()]);
    const t = touchAt(this.editor.project, this.sheet, this.cursor, sheetPins(this.editor.project, this.sheet, this.editor.index()));
    return this.points.length >= 2 && (t.pins.length || t.segments.length) ? 'finish' : 'added';
  }

  /**
   * Add the wire drawn so far to the model (one undo step). Returns the result, or undefined
   * when there was nothing to add. On `choose`, nothing changes: call again with a name.
   */
  finish(name?: string): WireResult | undefined {
    const tx = new Transaction('');
    const res = addWire(this.editor.project, this.sheet, this.points, tx, { width: this.width, ...(name ? { name } : {}), index: this.editor.index() });
    if (!res || 'choose' in res) {
      tx.revert();
      if (!res) this.points = [];
      return res;
    }
    tx.label = res.joined.length ? `Wire joining ${[...res.joined, res.net].join(', ')}` : `Wire on ${res.net}`;
    this.points = [];
    this.editor.push(tx);
    this.refresh();
    return res;
  }

  /** Drop the wire in progress. */
  cancel(): void {
    this.points = [];
  }

  /** Re-read the pins and wire ends to snap to (after the model changed). */
  refresh(): void {
    this.snaps = snapPoints(this.editor.project, this.sheet, this.editor.index());
  }

  private leg(): O.Pt[] {
    const last = this.points[this.points.length - 1]!;
    const c = this.cursor;
    if (Math.abs(last[0] - c[0]) < 1e-9 || Math.abs(last[1] - c[1]) < 1e-9) return [c];
    const corner: O.Pt = this.verticalFirst ? [last[0], c[1]] : [c[0], last[1]];
    return [corner, c];
  }
}

/** Short description of targets for undo labels, e.g. "C2" or "3 objects". */
function describe(ts: Target[]): string {
  if (ts.length === 1) {
    const t = ts[0]!;
    switch (t.kind) {
      case 'gate': return t.gate.part;
      case 'footprint': return t.footprint.part;
      case 'wire': return `wire on ${t.net.name}`;
      case 'junction': return `junction on ${t.net.name}`;
      case 'netlabel': return `label ${t.net.name}`;
      case 'trace': return `trace on ${t.net.name}`;
      case 'via': return `via on ${t.net.name}`;
      case 'pour': return `pour on ${t.net.name}`;
      case 'drawing': return 'drawing';
      case 'label': return `${t.placement.part} ${t.label.attr.toLowerCase()}`;
    }
  }
  return `${ts.length} objects`;
}

/** The model object a target stands for. */
export function subject(t: Target): object {
  switch (t.kind) {
    case 'gate': return t.gate;
    case 'footprint': return t.footprint;
    case 'wire': return t.wire;
    case 'junction': return t.junction;
    case 'netlabel': return t.label;
    case 'trace': return t.trace;
    case 'via': return t.via;
    case 'pour': return t.pour;
    case 'drawing': return t.graphic;
    case 'label': return t.label;
  }
}
