// Editing controller: turns selected targets + a verb into undoable transactions on the
// native project. Schematic and board are one model, so every command keeps them in step.

import type { Point, Transform } from '../geom/transform';
import { compose } from '../geom/transform';
import { componentName, ProjectIndex } from '../model/derive';
import { writeProject } from '../model/file';
import type * as O from '../model/types';
import type { Grid, Project } from '../model/types';
import { deleteTargets } from '../edit/delete';
import { History, insert, remove, set, Transaction } from '../edit/ops';
import { copyTargets, pasteClip, type Clip, type Pasted } from '../edit/clipboard';
import { addToLibrary, createPart, gatesToPlace } from '../edit/place';
import { addPour, defaultPourNet, setOutline, setPourNet, setPourProps, withCornerAdded, withCornerMoved, withCornerRemoved, type PourPatch } from '../edit/pours';
import { applyDru } from '../edit/rules';
import { legalize, type LegalizeResult } from '../edit/legalize';
import { Arrange } from '../edit/arrange';
import type { PlacementRules } from '../model/placement';
import type { DruFile } from '../model/rules';
import { ClearanceChecker, type Conflict, type ObstacleGrid } from '../model/drc';
import { findDetour, findPath, type Detour } from '../edit/walkaround';
import { addRoute, anchors, bend45, copperLayers, traceWidth, viaDrill, type Anchor, type Leg } from '../edit/route';
import { addWire, cleanPath, sheetPins, snapPoints, touchAt, usualWireWidth, type WireResult } from '../edit/wire';
import { renameNet, renamePart, setPartValue, smash, unsmash } from '../edit/properties';
import {
  addItem, nextPadName, nextPinName, renameItem, renameLibrary, renamePad, renamePin, setGraphic, setPad, setPin,
  type GraphicPatch, type ItemKind, type PadPatch, type PinPatch,
} from '../edit/library';
import { isEditable, mirrorAbout, rotationAbout, transformTargets, translation } from '../edit/transform';
import type { Target } from '../scene/types';
import { collect, coreDistance, type Item } from '../model/copper';
import { inIsland, pourFills } from '../model/pour';

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

  /** Copy schematic targets to a clip (undefined if nothing among them can be copied). */
  copy(targets: Target[]): Clip | undefined {
    return copyTargets(this.project, targets, this.grid('schematic'), this.index());
  }

  /**
   * Paste a clip onto a sheet. The pasted objects float as a move (anchored at the clip's
   * origin) until placed; placing commits the paste and the move as one undo step.
   */
  beginPaste(clip: Clip, sheetIndex: number, grid: (alt: boolean) => number): { session: MoveSession; pasted: Pasted } | undefined {
    const sheet = this.project.schematic?.sheets[sheetIndex];
    if (!sheet) return undefined;
    const tx = new Transaction('');
    const pasted = pasteClip(this.project, clip, sheet, tx);
    if (!pasted.targets.length) {
      tx.revert();
      return undefined;
    }
    const n = pasted.parts.length;
    tx.label = n === 1 && pasted.targets.length === pasted.targets.filter((t) => t.kind === 'gate').length
      ? `Paste ${pasted.parts[0]}`
      : n ? `Paste ${n} part${n > 1 ? 's' : ''} and wiring` : `Paste ${describe(pasted.targets)}`;
    const origin = { x: clip.origin[0], y: clip.origin[1] };
    return { session: new MoveSession(this, pasted.targets, grid, origin, origin, tx), pasted };
  }

  /**
   * Spread board parts apart until none overlap each other, the holes or the board edge (one
   * undo step). `parts` limits which may move (default: every unlocked part on the board).
   */
  legalize(parts?: string[], rules?: PlacementRules): LegalizeResult {
    const tx = new Transaction('Spread parts apart');
    const res = legalize(this.project, tx, { ...(parts ? { movable: parts } : {}), ...(rules ? { rules } : {}), index: this.index() });
    if (res.moved.length) this.push(tx);
    return res;
  }

  /**
   * Arrange board parts with the placement toolkit (near, row, edge, bestRotation, …), as one
   * undo step. If `run` throws, nothing changes.
   */
  arrange<T>(label: string, run: (a: Arrange) => T, rules?: PlacementRules): T {
    const tx = new Transaction(label);
    try {
      const out = run(new Arrange(this.project, tx, { index: this.index(), ...(rules ? { rules } : {}) }));
      if (!tx.empty) this.push(tx);
      return out;
    } catch (e) {
      tx.revert();
      throw e;
    }
  }

  /** Replace the board's design rules with a .dru file's (one undo step). */
  loadRules(name: string, dru: DruFile): string | undefined {
    if (!this.project.board) return 'The project has no board';
    const tx = new Transaction(`Load design rules ${name}`);
    applyDru(this.project, name, dru, tx);
    this.push(tx);
    return undefined;
  }

  /** Start drawing a pour on the board (on `net` and `layer` unless the first click picks a net). */
  beginPour(grid: (alt: boolean) => number, net?: string, layer?: string): PourSession | undefined {
    return this.project.board ? new PourSession(this, grid, net, layer) : undefined;
  }

  /** Start dragging a pour corner, or a new corner out of edge `index` (`adding`). */
  dragCorner(pour: O.PolygonShape, index: number, adding: boolean, grid: (alt: boolean) => number): CornerDrag {
    return new CornerDrag(this, pour, index, adding, grid);
  }

  /**
   * Start dragging one end of a drawing line (e.g. a board outline edge). Ends of other lines
   * on the same layer that meet it there move with it, so a closed outline stays closed.
   */
  dragLineEnd(line: O.LineShape, end: 0 | 1, container: O.Graphic[], grid: (alt: boolean) => number): LineEndDrag {
    return new LineEndDrag(this, line, end, container, grid);
  }

  /**
   * Put one end of a drawing line at a point, as typed (no grid); ends of same-layer lines that
   * meet it move too, as when dragging. One undo step; false when nothing changed.
   */
  setLineEnd(line: O.LineShape, end: 0 | 1, container: O.Graphic[], at: O.Pt): boolean {
    const d = new LineEndDrag(this, line, end, container, () => 1);
    d.place(at);
    return d.commit();
  }

  /** Move a pour corner to a point, as typed (no grid). */
  movePourCorner(pour: O.PolygonShape, index: number, at: O.Pt): string | undefined {
    if (!pour.polygon[index]) return 'No such corner';
    return this.property('Move pour corner', (tx) => {
      setOutline(pour, withCornerMoved(pour.polygon, index, at), tx);
      return undefined;
    });
  }

  /** Remove a pour corner (an outline keeps at least three). */
  removePourCorner(pour: O.PolygonShape, index: number): string | undefined {
    const outline = withCornerRemoved(pour.polygon, index);
    if (!outline) return 'A pour keeps at least three corners';
    return this.property('Delete pour corner', (tx) => {
      setOutline(pour, outline, tx);
      return undefined;
    });
  }

  /** Move a pour to another net. */
  setPourNet(pour: O.PolygonShape, net: string): string | undefined {
    return this.property(`Move pour to ${net.trim()}`, (tx) => setPourNet(this.project, pour, net, tx));
  }

  /** Change pour properties. */
  setPour(pour: O.PolygonShape, patch: PourPatch, label: string): string | undefined {
    return this.property(label, (tx) => setPourProps(pour, patch, tx));
  }

  /** Start placing vias on the board. */
  beginVias(grid: (alt: boolean) => number): ViaSession | undefined {
    return this.project.board ? new ViaSession(this, grid) : undefined;
  }

  /** Start routing traces on the board. */
  beginRoute(grid: (alt: boolean) => number, layer?: string): RouteSession | undefined {
    return this.project.board ? new RouteSession(this, grid, layer) : undefined;
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

  /** Move objects by typing a position: the point `from` (e.g. a pin's origin) goes to `to`. */
  moveTo(targets: Target[], from: Point, to: Point): void {
    if (Math.abs(to.x - from.x) < 1e-9 && Math.abs(to.y - from.y) < 1e-9) return;
    this.commit('Move', targets, translation(to.x - from.x, to.y - from.y));
  }

  // Library: new pins, pads, graphics and items (each one undo step)

  /**
   * Add a pin to a symbol at a point, named P$n, pointing in toward the symbol's origin (a pin
   * to the right of it points left, one above it points down), where the body usually is.
   */
  addPin(symbol: O.Symbol, at: O.Pt): O.Pin {
    const [x, y] = at;
    const rot = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 180 : 0) : y > 0 ? 270 : 90;
    const pin: O.Pin = { name: nextPinName(symbol), at, ...(rot ? { rot } : {}) };
    this.add(`Add pin ${pin.name}`, symbol.pins, pin);
    return pin;
  }

  /** Add a pad to a footprint at a point, numbered after the others: through-hole (0.8 mm drill) or SMD (1.27 × 0.635 mm). */
  addPad(footprint: O.Footprint, at: O.Pt, smd: boolean): O.Pad {
    const name = nextPadName(footprint);
    const pad: O.Pad = smd ? { name, smd: [1.27, 0.635], at } : { name, at, drill: 0.8 };
    this.add(`Add ${smd ? 'SMD ' : ''}pad ${name}`, footprint.pads, pad);
    return pad;
  }

  /** Add a line, shape or text to a symbol's or footprint's graphics. */
  addGraphic(container: O.Graphic[], g: O.Graphic, label: string): void {
    this.add(label, container, g);
  }

  /** A new, empty symbol or footprint in the library being edited. */
  addLibraryItem(kind: 'symbol' | 'footprint'): O.Symbol | O.Footprint {
    const tx = new Transaction(`New ${kind}`);
    const item = addItem(this.project.library, this.project.project.name, kind, tx);
    this.push(tx);
    return item;
  }

  /** Rename a library symbol, footprint or component; the library's references follow. */
  renameLibraryItem(kind: ItemKind, item: O.Symbol | O.Footprint | O.Component, name: string): string | undefined {
    return this.property(`Rename ${kind} ${componentName(item.id)}`, (tx) => renameItem(this.project.library, kind, item, name, tx));
  }

  /** Rename the library being edited (and the ids that carry its name). */
  renameLibrary(file: O.LibraryFile, name: string): string | undefined {
    return this.property(`Rename library ${file.name}`, (tx) => {
      const err = renameLibrary(file, name, tx);
      if (!err) tx.run(set(this.project.project, { name: file.name }));
      return err;
    });
  }

  setGraphic(g: O.Graphic, patch: GraphicPatch, label: string): string | undefined {
    return this.property(label, (tx) => setGraphic(g, patch, tx));
  }

  private add<T>(label: string, list: T[], item: T): void {
    const tx = new Transaction(label);
    tx.run(insert(list, item));
    this.push(tx);
  }

  /** Rename a pin of a library symbol (the components using it follow). */
  renamePin(symbol: O.Symbol, pin: O.Pin, name: string): string | undefined {
    return this.property(`Rename pin ${pin.name}`, (tx) => renamePin(this.project.library, symbol, pin, name, tx));
  }

  /** Rename a pad of a library footprint (the components using it follow). */
  renamePad(footprint: O.Footprint, pad: O.Pad, name: string): string | undefined {
    return this.property(`Rename pad ${pad.name}`, (tx) => renamePad(this.project.library, footprint, pad, name, tx));
  }

  setPin(pin: O.Pin, patch: PinPatch, label: string): string | undefined {
    return this.property(`${label} of pin ${pin.name}`, (tx) => setPin(pin, patch, tx));
  }

  setPad(pad: O.Pad, patch: PadPatch, label: string): string | undefined {
    return this.property(`${label} of pad ${pad.name}`, (tx) => setPad(pad, patch, tx));
  }

  /** Approve electrical rule check problems (by key), or withdraw their approval. */
  approve(keys: string[], on: boolean): void {
    const schematic = this.project.schematic;
    if (!schematic || !keys.length) return;
    const next = new Set(schematic.approved ?? []);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    const tx = new Transaction(`${on ? 'Approve' : 'Unapprove'} ${keys.length > 1 ? `${keys.length} ERC problems` : 'ERC problem'}`);
    tx.run(set(schematic, { approved: next.size ? [...next].sort() : undefined }));
    this.push(tx);
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
    /**
     * Edits made before the move that belong to the same undo step (a paste): the move is
     * committed into it, and cancelling reverts it too.
     */
    private readonly base?: Transaction,
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
    const final = this.base ?? new Transaction(`${verb} ${describe(this.targets)}`);
    final.subjects = this.targets.map(subject);
    this.tx.revert();
    this.editor.transform(this.targets, this.transform(), final);
    this.editor.push(final);
  }

  cancel(): void {
    this.tx.revert();
    this.tx = new Transaction('');
    this.base?.revert();
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

/**
 * Routing traces. The first click must be on copper of a net (pad, via or trace end): the route
 * takes that net. Each click adds legs in 45° style on the current layer; switching layer puts
 * a via at the last point. A click on copper of the same net, a double click or Esc finishes the
 * route as one undo step. The route in progress isn't in the model until finished.
 *
 * The leg to the cursor is checked against other nets' copper and the board edge as it moves
 * (`conflicts`); a click or layer change that would break a clearance rule is refused unless
 * forced.
 */
export class RouteSession {
  private net: string | undefined;
  private layer: string;
  private legs: Leg[] = [];
  private vias: O.Pt[] = [];
  /** The route's points on the current layer since the last via. */
  private points: O.Pt[] = [];
  private cursor: O.Pt = [0, 0];
  private diagonalFirst = false;
  private anchors: Anchor[] = [];
  /** The copper the cursor sits on, if any. */
  snappedTo: Anchor | undefined;
  private checker!: ClearanceChecker;
  /** Rules the leg to the cursor would break (nearest first); empty when it is clear or detours. */
  conflicts: Conflict[] = [];
  /** Go around other nets' copper when the direct leg is blocked (Eagle's follow-me routing). */
  avoid = true;
  /** The leg to the cursor (points after the last corner): the direct bend, or a detour. */
  private floating: O.Pt[] = [];
  /** Whether `floating` goes around obstacles. */
  detour = false;
  /** A detour that changes layer (runs joined by vias), when one is needed. */
  private runs: Detour | undefined;
  /** How many vias the leg to the cursor goes through (0 unless it detours across layers). */
  get detourVias(): number {
    return this.runs?.vias.length ?? 0;
  }
  /** Obstacle rasters by net, layer and width (rebuilt when the model changes). */
  private grids = new Map<string, ObstacleGrid>();
  private lastKey = '';

  constructor(
    private readonly editor: Editor,
    private readonly grid_: (alt: boolean) => number,
    layer?: string,
  ) {
    const stack = copperLayers(editor.project);
    this.layer = layer && stack.includes(layer) ? layer : stack[0]!;
    this.refresh();
  }

  /** The net being routed (undefined before the route starts). */
  get netName(): string | undefined {
    return this.net;
  }

  get currentLayer(): string {
    return this.layer;
  }

  get at(): Point {
    return { x: this.cursor[0], y: this.cursor[1] };
  }

  get width(): number {
    return this.net ? traceWidth(this.editor.project, this.net) : traceWidth(this.editor.project, '');
  }

  get drill(): number {
    return viaDrill(this.editor.project, this.net ?? '');
  }

  /** What to draw: the legs so far, the bend to the cursor, and the vias. */
  get preview(): { paths: { points: Point[]; layer: string; blocked?: true }[]; vias: Point[] } {
    const P = ([x, y]: O.Pt) => ({ x, y });
    const paths: { points: Point[]; layer: string; blocked?: true }[] = this.legs.map((l) => ({ points: l.line.map(P), layer: l.layer }));
    if (this.points.length) {
      const last = this.points[this.points.length - 1]!;
      paths.push({ points: this.points.map(P), layer: this.layer });
      if (this.runs) for (const r of this.runs.runs) paths.push({ points: r.pts.map(P), layer: r.layer });
      else paths.push({ points: [last, ...this.floating].map(P), layer: this.layer, ...(this.conflicts.length ? { blocked: true as const } : {}) });
    }
    return { paths, vias: [...this.vias, ...(this.runs?.vias ?? [])].map(P) };
  }

  /** Move the cursor: onto copper within `tolerance` (any net before starting, then the route's net), else the grid. */
  moveTo(p: Point, fineGrid: boolean, tolerance: number): void {
    let best: Anchor | undefined;
    let d = tolerance;
    for (const a of this.anchors) {
      if (this.net && a.net !== this.net) continue;
      const e = Math.hypot(a.at[0] - p.x, a.at[1] - p.y);
      // Prefer copper on the current layer, then pads over trace ends, at the same spot.
      const score = (x: Anchor) => (x.layers.includes(this.layer) ? 2 : 0) + (x.kind === 'pad' ? 1 : 0);
      if (e < d || (e === d && best && score(a) > score(best))) [best, d] = [a, e];
    }
    this.snappedTo = best;
    if (best) {
      this.cursor = [best.at[0], best.at[1]];
    } else {
      const g = this.grid_(fineGrid);
      const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
      this.cursor = this.alignToPads([snap(p.x), snap(p.y)], g);
    }
    this.update();
  }

  /**
   * While routing, a grid point within half a grid step of a pad of the net's row or column
   * moves onto it (the nearest such pad for each axis), so a leg can run straight into a pad
   * that is off the grid.
   */
  private alignToPads(c: O.Pt, g: number): O.Pt {
    if (!this.net) return c;
    const out: O.Pt = [c[0], c[1]];
    for (const axis of [0, 1] as const) {
      let best: number | undefined;
      let d = Infinity;
      for (const a of this.anchors) {
        if (a.net !== this.net || a.kind !== 'pad' || Math.abs(a.at[axis] - c[axis]) >= g / 2 - 1e-9) continue;
        const e = Math.hypot(a.at[0] - c[0], a.at[1] - c[1]);
        if (e < d) [best, d] = [a.at[axis], e];
      }
      if (best !== undefined) out[axis] = best;
    }
    return out;
  }

  flipBend(): void {
    this.diagonalFirst = !this.diagonalFirst;
    this.update();
  }

  /**
   * Work out the leg to the cursor: the direct 45° bend if it is clear; otherwise (with
   * `avoid`) a path around the obstacles; otherwise the direct bend, with its conflicts.
   */
  private update(): void {
    this.runs = undefined;
    if (!this.net || !this.points.length) {
      this.conflicts = [];
      this.floating = [];
      this.detour = false;
      return;
    }
    const last = this.points[this.points.length - 1]!;
    const key = `${last}|${this.cursor}|${this.layer}|${this.diagonalFirst}|${this.avoid}|${this.snappedTo?.layers}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const stack = copperLayers(this.editor.project);
    // Where the leg may end: on the copper it snapped to (any of its layers), else this layer.
    const endLayers = this.snappedTo ? this.snappedTo.layers.filter((l) => stack.includes(l)) : [this.layer];
    const sameLayer = endLayers.includes(this.layer);
    const direct = bend45(last, this.cursor, this.diagonalFirst);
    const conflicts: Conflict[] = sameLayer ? this.legConflicts([last, ...direct]) : [this.otherLayerConflict(endLayers)];
    this.floating = direct;
    this.detour = false;
    this.conflicts = conflicts;
    if (!conflicts.length || !this.avoid) return;
    const width = this.width;
    if (sameLayer) {
      const path = findPath(this.checker, this.grid(width, this.layer), { net: this.net, layer: this.layer, width }, last, this.cursor);
      if (path) {
        this.floating = path.slice(1);
        this.detour = true;
        this.conflicts = [];
        return;
      }
    }
    // Through vias: the current layer first, then the others.
    if (stack.length < 2) return;
    const order = [this.layer, ...stack.filter((l) => l !== this.layer)];
    const runs = findDetour(this.checker, {
      net: this.net,
      width,
      layers: order.map((name) => ({ name, grid: this.grid(width, name) })),
      vias: { grid: this.viaGrid(), drill: this.drill },
      from: last,
      to: this.cursor,
      endLayers,
    });
    if (runs) {
      this.runs = runs;
      this.floating = [];
      this.detour = true;
      this.conflicts = [];
    }
  }

  /** Why the direct leg can't end on copper that is only on another layer. */
  private otherLayerConflict(layers: string[]): Conflict {
    const a = this.snappedTo!;
    const what = a.pad ? `Pad ${a.pad.part}.${a.pad.pad}` : 'That copper';
    return { message: `${what} is on ${layers.map((l) => l.replace('copper.', '')).join('/')}: change layer (L)`, at: this.cursor, gap: 0, required: 0, other: what };
  }

  /** Clearance problems of a polyline on the current layer. */
  private legConflicts(pts: O.Pt[]): Conflict[] {
    const width = this.width;
    const out: Conflict[] = [];
    for (let i = 1; i < pts.length; i++) out.push(...this.checker.trace(this.net!, [pts[i - 1]!, pts[i]!], this.layer, width));
    return out.sort((a, b) => a.gap - a.required - (b.gap - b.required));
  }

  /** The search raster's step: an eighth of the routing grid (≈ 6 mil on a 50 mil grid). */
  private get step(): number {
    const routing = this.grid_(false);
    return routing / Math.max(1, Math.round(routing / 0.16));
  }

  /** The obstacle raster for the route's net on a layer. */
  private grid(width: number, layer: string): ObstacleGrid {
    const key = `${this.net}|${layer}|${width}`;
    let g = this.grids.get(key);
    if (!g) {
      g = this.checker.obstacles(this.net!, layer, width, this.step);
      this.grids.set(key, g);
    }
    return g;
  }

  /** Where a via of the route's net fits: clear of other nets on every copper layer. */
  private viaGrid(): ObstacleGrid {
    const D = this.checker.rules.viaDiameter(this.drill, 0);
    const key = `${this.net}|via|${D}`;
    let g = this.grids.get(key);
    if (!g) {
      const per = copperLayers(this.editor.project).map((l) => this.checker.obstacles(this.net!, l, D, this.step, 'via'));
      const blocked = new Uint8Array(per[0]!.blocked.length);
      for (const p of per) for (let i = 0; i < blocked.length; i++) blocked[i] = blocked[i]! | p.blocked[i]!;
      g = { ...per[0]!, blocked };
      this.grids.set(key, g);
    }
    return g;
  }

  /**
   * Click at the cursor. Returns 'nothing' when a route can't start here (not on copper of a
   * net), 'blocked' when the leg would break a clearance rule (see `conflicts`; `force` places
   * it anyway), 'finish' when the route reached copper of its net (the caller then finishes it).
   */
  click(force = false): 'nothing' | 'started' | 'added' | 'finish' | 'blocked' {
    if (!this.net) {
      const a = this.snappedTo;
      if (!a) return 'nothing';
      this.net = a.net;
      if (!a.layers.includes(this.layer)) this.layer = a.layers[0]!;
      this.points = [this.cursor];
      return 'started';
    }
    if (this.conflicts.length && !force) return 'blocked';
    const last = this.points[this.points.length - 1]!;
    // Forcing places the direct bend; otherwise what is shown (direct or detour).
    if (this.runs && !(force && this.conflicts.length)) {
      // A detour through vias: the first run continues this layer; each via changes layer.
      const [first, ...rest] = this.runs.runs;
      this.points = cleanPath([...this.points, ...first!.pts.slice(1)]);
      this.runs.vias.forEach((v, i) => {
        this.flush();
        this.vias.push(v);
        this.layer = rest[i]!.layer;
        this.points = cleanPath([...rest[i]!.pts]);
      });
    } else {
      const leg = force && this.conflicts.length ? bend45(last, this.cursor, this.diagonalFirst) : this.floating;
      this.points = cleanPath([...this.points, ...leg]);
    }
    this.lastKey = '';
    this.update();
    return this.snappedTo && (this.points.length >= 2 || this.legs.length) ? 'finish' : 'added';
  }

  /**
   * Change to another copper layer (`to`; by default the other outer one); while routing,
   * through a via at the last point. A via that would break a clearance rule is refused (the
   * layer stays) unless forced.
   */
  switchLayer(force = false, to?: string): { layer: string; blocked?: Conflict[] } {
    const stack = copperLayers(this.editor.project);
    const other = to && stack.includes(to) ? to : this.layer === stack[0] ? stack[stack.length - 1]! : stack[0]!;
    if (other === this.layer) return { layer: other };
    if (this.net && this.points.length) {
      const last = this.points[this.points.length - 1]!;
      // No via needed where the copper already spans the layers (a via or through-hole pad).
      const spans = this.anchors.some((a) => a.net === this.net && a.layers.length > 1 && Math.abs(a.at[0] - last[0]) < 1e-4 && Math.abs(a.at[1] - last[1]) < 1e-4);
      const needVia = !spans && !this.vias.some((v) => v[0] === last[0] && v[1] === last[1]);
      if (needVia && !force) {
        const blocked = this.checker.via(this.net, last, this.drill);
        if (blocked.length) return { layer: this.layer, blocked };
      }
      this.flush();
      if (needVia) this.vias.push(last);
      this.points = [last];
    }
    this.layer = other;
    this.update();
    return { layer: other };
  }

  /** Add the route to the model (one undo step). Undefined when there was nothing to add. */
  finish(): { net: string; traces: number; vias: number } | undefined {
    const net = this.net;
    this.flush();
    const legs = this.legs;
    const vias = this.vias;
    this.reset();
    if (!net || (!legs.length && !vias.length)) return undefined;
    const tx = new Transaction(`Route ${net}`);
    const res = addRoute(this.editor.project, net, legs, vias, tx);
    this.editor.push(tx);
    this.refresh();
    return { net, traces: res.traces.length, vias: res.vias.length };
  }

  /** Drop the route in progress. */
  cancel(): void {
    this.reset();
  }

  /** Re-read the copper to snap to (after the model changed). */
  refresh(): void {
    const index = this.editor.index();
    this.anchors = anchors(this.editor.project, index);
    this.checker = new ClearanceChecker(this.editor.project, index);
    this.grids.clear();
    this.lastKey = '';
    this.update();
  }

  private flush(): void {
    for (let i = 1; i < this.points.length; i++) this.legs.push({ line: [this.points[i - 1]!, this.points[i]!], layer: this.layer });
    this.points = this.points.slice(-1);
  }

  private reset(): void {
    this.conflicts = [];
    this.runs = undefined;
    this.floating = [];
    this.detour = false;
    this.lastKey = '';
    this.net = undefined;
    this.legs = [];
    this.vias = [];
    this.points = [];
  }
}

/**
 * Drawing a polygon pour. Clicks place corners (on the grid; in 45° steps unless free angles are
 * on); clicking the first corner, a double click or Enter closes it, as one undo step. The first
 * click picks the net when it lands on copper (a pad, trace or via); otherwise the pour goes on
 * the last net used, or GND. The pour is drawn on the current copper layer (switchLayer).
 */
export class PourSession {
  private points: O.Pt[] = [];
  private cursor: O.Pt = [0, 0];
  private anchors: Anchor[];
  /** The net the pour will be on (picked by the first click, or the default). */
  net: string | undefined;
  layer: string;
  /** Edges at any angle (else horizontal, vertical and 45°). */
  freeAngle = false;
  /** Whether the cursor is on the first corner (a click closes the outline). */
  closing = false;
  /** Copper under the cursor before the first corner (its net would be used). */
  over: Anchor | undefined;

  constructor(
    private readonly editor: Editor,
    private readonly grid: (alt: boolean) => number,
    net: string | undefined,
    layer: string | undefined,
  ) {
    const stack = copperLayers(editor.project);
    this.layer = layer && stack.includes(layer) ? layer : stack[0]!;
    this.net = net ?? defaultPourNet(editor.project);
    this.anchors = anchors(editor.project, editor.index());
  }

  get drawing(): boolean {
    return this.points.length > 0;
  }

  get at(): Point {
    return { x: this.cursor[0], y: this.cursor[1] };
  }

  /** The outline so far, the edge(s) to the cursor, and back to the first corner. */
  get path(): Point[] {
    if (!this.points.length) return [];
    return [...this.points, ...this.leg(), this.points[0]!].map(([x, y]) => ({ x, y }));
  }

  moveTo(p: Point, fineGrid: boolean, tolerance: number): void {
    const g = this.grid(fineGrid);
    const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
    this.cursor = [snap(p.x), snap(p.y)];
    this.closing = false;
    this.over = undefined;
    if (this.points.length >= 3) {
      const [fx, fy] = this.points[0]!;
      if (Math.hypot(fx - p.x, fy - p.y) <= tolerance) {
        this.cursor = [fx, fy];
        this.closing = true;
      }
    } else if (!this.points.length) {
      let d = tolerance;
      for (const a of this.anchors) {
        const e = Math.hypot(a.at[0] - p.x, a.at[1] - p.y);
        if (e <= d) [this.over, d] = [a, e];
      }
    }
  }

  /** Click: start, add a corner, or close ('close': call finish). */
  click(): 'started' | 'added' | 'close' {
    if (!this.points.length) {
      if (this.over) this.net = this.over.net;
      this.points = [this.cursor];
      return 'started';
    }
    if (this.closing) return 'close';
    this.points = cleanPath([...this.points, ...this.leg()]);
    return 'added';
  }

  /** Change to another copper layer (`to`; by default the other outer one). */
  switchLayer(to?: string): string {
    const stack = copperLayers(this.editor.project);
    this.layer = to && stack.includes(to) ? to : this.layer === stack[0] ? stack[stack.length - 1]! : stack[0]!;
    return this.layer;
  }

  /** Add the pour (needs three corners). Returns it, or undefined when the outline is too small. */
  finish(): { net: string; pour: O.PolygonShape } | undefined {
    const pts = cleanPath(this.points);
    if (pts.length > 2 && Math.abs(pts[0]![0] - pts[pts.length - 1]![0]) < 1e-9 && Math.abs(pts[0]![1] - pts[pts.length - 1]![1]) < 1e-9) pts.pop();
    this.points = [];
    if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1e-6) return undefined;
    const tx = new Transaction('');
    const { net, pour } = addPour(this.editor.project, this.net, pts, this.layer, tx);
    tx.label = `Add pour on ${net.name}`;
    this.net = net.name;
    this.editor.push(tx);
    return { net: net.name, pour };
  }

  cancel(): void {
    this.points = [];
  }

  /** The edge(s) from the last corner to the cursor. */
  private leg(): O.Pt[] {
    const last = this.points[this.points.length - 1]!;
    return this.freeAngle ? [this.cursor] : bend45(last, this.cursor, false);
  }
}

/**
 * Placing vias, one per click (each one undo step), e.g. to stitch a ground pour. A via takes
 * the net of the copper under the cursor (a pad, trace, via or poured copper), else the net of
 * the last via placed, else the usual pour net (GND). Its drill is the net class's, else the
 * board's usual one. A via that would break a clearance rule is refused unless forced.
 */
export class ViaSession {
  private cursor: O.Pt = [0, 0];
  private anchors: Anchor[] = [];
  private items: Item[] = [];
  private checker!: ClearanceChecker;
  /** The copper under the cursor (a via there takes its net). */
  over: { net: string; label: string } | undefined;
  /** Whether the cursor snapped onto a pad, via or trace end. */
  snapped = false;
  /** The net of the last via placed. */
  private lastNet: string | undefined;
  /** Rules a via at the cursor would break (nearest first). */
  conflicts: Conflict[] = [];

  constructor(
    private readonly editor: Editor,
    private readonly grid: (alt: boolean) => number,
  ) {
    this.refresh();
  }

  get at(): Point {
    return { x: this.cursor[0], y: this.cursor[1] };
  }

  /** The net a via at the cursor would be on. */
  get net(): string | undefined {
    return this.over?.net ?? this.lastNet ?? defaultPourNet(this.editor.project);
  }

  get drill(): number {
    return viaDrill(this.editor.project, this.net ?? '');
  }

  /** The via's copper diameter (by the rules' annular ring). */
  get diameter(): number {
    return this.checker.rules.viaDiameter(this.drill, 0);
  }

  /** Move the cursor: onto a pad, via or trace end within `tolerance`, else the grid. */
  moveTo(p: Point, fineGrid: boolean, tolerance: number): void {
    let best: Anchor | undefined;
    let d = tolerance;
    for (const a of this.anchors) {
      const e = Math.hypot(a.at[0] - p.x, a.at[1] - p.y);
      if (e < d) [best, d] = [a, e];
    }
    this.snapped = !!best;
    if (best) this.cursor = [best.at[0], best.at[1]];
    else {
      const g = this.grid(fineGrid);
      const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
      this.cursor = [snap(p.x), snap(p.y)];
    }
    this.update();
  }

  /** Place a via at the cursor. */
  click(force = false): 'placed' | 'blocked' | 'exists' | 'nonet' {
    const net = this.net;
    if (!net) return 'nonet';
    if (this.editor.project.nets.find((n) => n.name === net)?.vias?.some((v) => Math.abs(v.at[0] - this.cursor[0]) < 1e-4 && Math.abs(v.at[1] - this.cursor[1]) < 1e-4)) return 'exists';
    if (this.conflicts.length && !force) return 'blocked';
    const tx = new Transaction(`Via on ${net}`);
    addRoute(this.editor.project, net, [], [this.cursor], tx);
    this.editor.push(tx);
    this.lastNet = net;
    this.refresh();
    return 'placed';
  }

  /** Re-read the copper (after the model changed). */
  refresh(): void {
    const index = this.editor.index();
    this.anchors = anchors(this.editor.project, index);
    this.checker = new ClearanceChecker(this.editor.project, index);
    this.items = collect(this.editor.project, this.checker.rules, index);
    this.update();
  }

  private update(): void {
    this.over = this.copperAt(this.cursor);
    const net = this.net;
    this.conflicts = net ? this.checker.via(net, this.cursor, this.drill) : [];
  }

  /** The copper of a net at a point, on any layer: pads, traces and vias first, then pours. */
  private copperAt([x, y]: O.Pt): { net: string; label: string } | undefined {
    const pt = { t: 'cap' as const, a: { x, y }, b: { x, y }, r: 0 };
    for (const it of this.items) {
      if (it.net.startsWith('\u0000')) continue; // pads on no net
      if (x < it.box.minX || x > it.box.maxX || y < it.box.minY || y > it.box.maxY) continue;
      if (it.shapes.some((s) => coreDistance(pt, s).d - s.r <= 1e-6)) return { net: it.net, label: it.label };
    }
    for (const f of pourFills(this.editor.project).values()) {
      if (f.islands.some((isl) => inIsland(isl, { x, y }))) return { net: f.net, label: `pour of ${f.net}` };
    }
    return undefined;
  }
}

/**
 * Dragging a pour corner (or a new corner out of the middle of an edge). The outline is
 * previewed in the model while dragging; commit makes it one undo step.
 */
export class CornerDrag {
  private tx = new Transaction('');
  private readonly original: O.PolyPt[];
  moved = false;

  constructor(
    private readonly editor: Editor,
    readonly pour: O.PolygonShape,
    /** The corner dragged, or (when `adding`) the edge whose middle becomes a corner. */
    readonly index: number,
    readonly adding: boolean,
    private readonly grid: (alt: boolean) => number,
  ) {
    this.original = pour.polygon;
  }

  /** The index of the corner being dragged (after adding, the new one). */
  get corner(): number {
    return this.adding ? this.index + 1 : this.index;
  }

  moveTo(p: Point, fineGrid: boolean): void {
    const g = this.grid(fineGrid);
    const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
    const at: O.Pt = [snap(p.x), snap(p.y)];
    this.tx.revert();
    this.tx = new Transaction('');
    setOutline(this.pour, this.adding ? withCornerAdded(this.original, this.index, at) : withCornerMoved(this.original, this.index, at), this.tx);
    this.moved = true;
  }

  /** Keep the change (one undo step); false when nothing moved. */
  commit(): boolean {
    if (!this.moved) return false;
    const outline = this.pour.polygon;
    this.tx.revert();
    const tx = new Transaction(this.adding ? 'Add pour corner' : 'Move pour corner');
    setOutline(this.pour, outline, tx);
    this.editor.push(tx);
    return true;
  }

  cancel(): void {
    this.tx.revert();
    this.tx = new Transaction('');
  }
}

/**
 * Dragging the end of a drawing line, with the ends of same-layer lines that meet it. Previewed
 * in the model while dragging; commit makes it one undo step.
 */
export class LineEndDrag {
  private tx = new Transaction('');
  /** Every line end that moves: the dragged one first. */
  private readonly ends: { line: O.LineShape; end: 0 | 1; original: [O.Pt, O.Pt] }[];
  moved = false;

  constructor(
    private readonly editor: Editor,
    readonly line: O.LineShape,
    readonly end: 0 | 1,
    container: O.Graphic[],
    private readonly grid: (alt: boolean) => number,
  ) {
    const [x, y] = line.line[end];
    const at = (q: O.Pt) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6;
    this.ends = [{ line, end, original: line.line }];
    for (const g of container) {
      if (g === line || !('line' in g) || g.layer !== line.layer) continue;
      for (const e of [0, 1] as const) if (at(g.line[e])) this.ends.push({ line: g, end: e, original: g.line });
    }
  }

  /** Whether other lines' ends move with the dragged one. */
  get joined(): boolean {
    return this.ends.length > 1;
  }

  moveTo(p: Point, fineGrid: boolean): void {
    const g = this.grid(fineGrid);
    const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
    this.tx.revert();
    this.tx = new Transaction('');
    this.apply([snap(p.x), snap(p.y)], this.tx);
    this.moved = true;
  }

  /** Put the end exactly at `at` (no grid). */
  place(at: O.Pt): void {
    this.tx.revert();
    this.tx = new Transaction('');
    this.apply(at, this.tx);
    this.moved = true;
  }

  private apply(at: O.Pt, tx: Transaction): void {
    // A line may meet the dragged end with both of its ends (a zero-length line): set each once.
    const lines = new Map<O.LineShape, [O.Pt, O.Pt]>();
    for (const { line, end } of this.ends) {
      const pts = lines.get(line) ?? [...line.line] as [O.Pt, O.Pt];
      pts[end] = at;
      lines.set(line, pts);
    }
    for (const [line, pts] of lines) tx.run(set(line, { line: pts }));
    tx.subjects.push(this.line);
  }

  /** Keep the change (one undo step); false when nothing moved. */
  commit(): boolean {
    if (!this.moved) return false;
    const at = this.line.line[this.end];
    this.tx.revert();
    this.tx = new Transaction('');
    if (at[0] === this.ends[0]!.original[this.end][0] && at[1] === this.ends[0]!.original[this.end][1]) return false;
    const tx = new Transaction(this.joined ? 'Move corner' : 'Move line end');
    this.apply(at, tx);
    this.editor.push(tx);
    return true;
  }

  cancel(): void {
    this.tx.revert();
    this.tx = new Transaction('');
  }
}

function polygonArea(pts: O.Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
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
      case 'pin': return `pin ${t.pin.name}`;
      case 'pad': return `pad ${t.pad.name}`;
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
    case 'pin': return t.pin;
    case 'pad': return t.pad;
  }
}
