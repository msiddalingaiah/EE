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
import { copyTargets, pasteClip, type Clip, type Pasted } from '../edit/clipboard';
import { addToLibrary, createPart, gatesToPlace } from '../edit/place';
import { applyDru } from '../edit/rules';
import type { DruFile } from '../model/rules';
import { ClearanceChecker, type Conflict, type ObstacleGrid } from '../model/drc';
import { findPath } from '../edit/walkaround';
import { addRoute, anchors, bend45, copperLayers, traceWidth, viaDrill, type Anchor, type Leg } from '../edit/route';
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

  /** Replace the board's design rules with a .dru file's (one undo step). */
  loadRules(name: string, dru: DruFile): string | undefined {
    if (!this.project.board) return 'The project has no board';
    const tx = new Transaction(`Load design rules ${name}`);
    applyDru(this.project, name, dru, tx);
    this.push(tx);
    return undefined;
  }

  /** Start routing traces on the board. */
  beginRoute(grid: (alt: boolean) => number): RouteSession | undefined {
    return this.project.board ? new RouteSession(this, grid) : undefined;
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
  /** Obstacle rasters by net, layer and width (rebuilt when the model changes). */
  private grids = new Map<string, ObstacleGrid>();
  private lastKey = '';

  constructor(
    private readonly editor: Editor,
    private readonly grid_: (alt: boolean) => number,
  ) {
    this.layer = copperLayers(editor.project)[0]!;
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
      paths.push({ points: [last, ...this.floating].map(P), layer: this.layer, ...(this.conflicts.length ? { blocked: true as const } : {}) });
    }
    return { paths, vias: this.vias.map(P) };
  }

  /** Move the cursor: onto copper within `tolerance` (any net before starting, then the route's net), else the grid. */
  moveTo(p: Point, fineGrid: boolean, tolerance: number): void {
    let best: Anchor | undefined;
    let d = tolerance;
    for (const a of this.anchors) {
      if (this.net && (a.net !== this.net || !a.layers.includes(this.layer))) continue;
      const e = Math.hypot(a.at[0] - p.x, a.at[1] - p.y);
      // Prefer pads over trace ends at the same spot.
      if (e < d || (e === d && best && best.kind !== 'pad' && a.kind === 'pad')) [best, d] = [a, e];
    }
    this.snappedTo = best;
    if (best) {
      this.cursor = [best.at[0], best.at[1]];
    } else {
      const g = this.grid_(fineGrid);
      const snap = (v: number) => Math.round(Math.round(v / g) * g * 1e6) / 1e6;
      this.cursor = [snap(p.x), snap(p.y)];
    }
    this.update();
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
    if (!this.net || !this.points.length) {
      this.conflicts = [];
      this.floating = [];
      this.detour = false;
      return;
    }
    const last = this.points[this.points.length - 1]!;
    const key = `${last}|${this.cursor}|${this.layer}|${this.diagonalFirst}|${this.avoid}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const direct = bend45(last, this.cursor, this.diagonalFirst);
    const conflicts = this.legConflicts([last, ...direct]);
    this.floating = direct;
    this.detour = false;
    this.conflicts = conflicts;
    if (!conflicts.length || !this.avoid) return;
    const width = this.width;
    const path = findPath(this.checker, this.grid(width), { net: this.net, layer: this.layer, width }, last, this.cursor);
    if (path) {
      this.floating = path.slice(1);
      this.detour = true;
      this.conflicts = [];
    }
  }

  /** Clearance problems of a polyline on the current layer. */
  private legConflicts(pts: O.Pt[]): Conflict[] {
    const width = this.width;
    const out: Conflict[] = [];
    for (let i = 1; i < pts.length; i++) out.push(...this.checker.trace(this.net!, [pts[i - 1]!, pts[i]!], this.layer, width));
    return out.sort((a, b) => a.gap - a.required - (b.gap - b.required));
  }

  /** The obstacle raster for the current net and layer: an eighth of the routing grid (≈ 6 mil on a 50 mil grid). */
  private grid(width: number): ObstacleGrid {
    const key = `${this.net}|${this.layer}|${width}`;
    let g = this.grids.get(key);
    if (!g) {
      const routing = this.grid_(false);
      const step = routing / Math.max(1, Math.round(routing / 0.16));
      g = this.checker.obstacles(this.net!, this.layer, width, step);
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
    const leg = force && this.conflicts.length ? bend45(last, this.cursor, this.diagonalFirst) : this.floating;
    this.points = cleanPath([...this.points, ...leg]);
    this.lastKey = '';
    this.update();
    return this.snappedTo && (this.points.length >= 2 || this.legs.length) ? 'finish' : 'added';
  }

  /**
   * Change to the other outer copper layer; while routing, through a via at the last point.
   * A via that would break a clearance rule is refused (the layer stays) unless forced.
   */
  switchLayer(force = false): { layer: string; blocked?: Conflict[] } {
    const stack = copperLayers(this.editor.project);
    const other = this.layer === stack[0] ? stack[stack.length - 1]! : stack[0]!;
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
    this.floating = [];
    this.detour = false;
    this.lastKey = '';
    this.net = undefined;
    this.legs = [];
    this.vias = [];
    this.points = [];
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
