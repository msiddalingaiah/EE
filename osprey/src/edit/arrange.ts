// Arranging parts on the board by relation rather than by coordinates: beside a part or one of
// its pads, in a row, against a board edge, as a group; and turned to the rotation that gives the
// shortest, least crossed airwires. Positions come from footprint areas (model/placement.ts), so
// parts are placed against each other's real outlines; a spot that's taken slides to the nearest
// free one. Moves go through the move command, so traces on the pads follow.
//
// An Arrange works within one transaction: a script's whole placement can be one undo step.

import type { Point } from '../geom/transform';
import { ProjectIndex } from '../model/derive';
import type { FootprintInfo, PlacementMetrics, PlacementRules, Rect } from '../model/placement';
import {
  boardArea, DEFAULT_PLACEMENT_RULES, footprintInfo, footprintInfos, onBoard, partClearance, placementMetrics, rectCenter, rectGap, TOLERANCE,
} from '../model/placement';
import type * as O from '../model/types';
import { improve, type ImproveOptions, type ImproveResult } from './improve';
import type { Transaction } from './ops';
import { rotationAbout, transformTargets, translation } from './transform';

export type Side = 'left' | 'right' | 'above' | 'below';
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface NearOptions {
  /** Which side of the anchor part (default: for a pad, the side of its part the pad is on). */
  side?: Side;
  /** Space between the two outlines (default: the placement clearance). */
  gap?: number;
  /** Rotation, or 'best' to choose it by airwires once placed (default: as it is). */
  rot?: number | 'best';
  /**
   * Line up this pad of the moved part with the anchor (the anchor pad, or the anchor part's
   * centre) across the side; default: the part's centre.
   */
  pad?: string;
  /** Slide to the nearest free spot if the spot is taken (default true). */
  slide?: boolean;
}

/** Search for a free spot: this far along the side, in steps of STEP, before moving out. */
const SLIDE = 6;
const STEP = 0.25;
const r2 = (v: number) => Math.round(v * 100) / 100;

export class Arrange {
  readonly index: ProjectIndex;
  readonly rules: PlacementRules;

  constructor(readonly project: O.Project, readonly tx: Transaction, opts: { index?: ProjectIndex; rules?: PlacementRules } = {}) {
    this.index = opts.index ?? new ProjectIndex(project);
    this.rules = opts.rules ?? DEFAULT_PLACEMENT_RULES;
  }

  private fp(part: string): O.FootprintPlacement {
    const f = this.project.board?.footprints.find((x) => x.part === part);
    if (!f) throw new Error(`${part} has no footprint on the board`);
    return f;
  }

  /** A part's footprint geometry where it is, or where it would be. */
  info(part: string, where: { at?: O.Pt; rot?: number } = {}): FootprintInfo {
    const i = footprintInfo(this.project, part, where, this.index);
    if (!i) throw new Error(`${part} has no footprint on the board`);
    return i;
  }

  /** The box around several parts. */
  box(parts: string[]): Rect {
    const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of parts) {
      const b = this.info(p).box;
      r.minX = Math.min(r.minX, b.minX);
      r.minY = Math.min(r.minY, b.minY);
      r.maxX = Math.max(r.maxX, b.maxX);
      r.maxY = Math.max(r.maxY, b.maxY);
    }
    return r;
  }

  metrics(): PlacementMetrics {
    return placementMetrics(this.project, footprintInfos(this.project, this.index));
  }

  // ---- moving --------------------------------------------------------------

  /** Put a part's origin at `at`, turned to `rot` (traces follow). */
  moveTo(part: string, at: O.Pt, rot?: number): void {
    const f = this.fp(part);
    if (f.locked) throw new Error(`${part} is locked`);
    const target = { kind: 'footprint' as const, footprint: f };
    // Quarter turns about the origin until the rotation is right (a bottom-side part turns the
    // other way in its own terms).
    const norm = (v: number) => (((Math.round(v) % 360) + 360) % 360);
    for (let k = 0; rot !== undefined && norm(f.rot ?? 0) !== norm(rot) && k < 4; k++) {
      transformTargets(this.project, [target], rotationAbout({ x: f.at[0], y: f.at[1] }, 1), this.tx, this.index);
    }
    const dx = r2(at[0]) - f.at[0];
    const dy = r2(at[1]) - f.at[1];
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) transformTargets(this.project, [target], translation(dx, dy), this.tx, this.index);
    this.tx.subjects.push(f);
  }

  /** Move parts together, keeping their arrangement. */
  shift(parts: string[], dx: number, dy: number): void {
    const targets = parts.map((p) => ({ kind: 'footprint' as const, footprint: this.fp(p) }));
    transformTargets(this.project, targets, translation(dx, dy), this.tx, this.index);
  }

  /** Move parts together so the box around them has its centre (or a corner) at `to`. */
  moveGroup(parts: string[], to: Point, anchor: 'center' | 'bottom-left' = 'center'): void {
    const b = this.box(parts);
    const from = anchor === 'center' ? rectCenter(b) : { x: b.minX, y: b.minY };
    this.shift(parts, r2(to.x - from.x), r2(to.y - from.y));
  }

  /** Where the part's origin goes so its box (at `rot`) has its centre at `c`. */
  private originFor(part: string, rot: number, c: Point): O.Pt {
    const f = this.fp(part);
    const b = this.info(part, { at: f.at, rot }).box;
    const bc = rectCenter(b);
    return [f.at[0] + c.x - bc.x, f.at[1] + c.y - bc.y];
  }

  // ---- relative placement -----------------------------------------------------

  /**
   * Place `part` beside `anchor`: a part ("U1") or one of its pads ("U1.3"). Returns where it
   * went, and whether that spot is free (if no free spot was found nearby, it goes where asked,
   * conflicts and all: legalize, or place it elsewhere).
   */
  near(part: string, anchor: string, opts: NearOptions = {}): { at: O.Pt; rot: number; free: boolean } {
    const [aPart, aPad] = anchor.split('.') as [string, string | undefined];
    const a = this.info(aPart);
    const pad = aPad !== undefined ? a.pads.find((q) => q.name === aPad) : undefined;
    if (aPad !== undefined && !pad) throw new Error(`${aPart} has no pad ${aPad}`);
    const side = opts.side ?? (pad ? sideOf(a.box, pad.at) : undefined);
    if (!side) throw new Error('near: give a side when the anchor is a whole part');
    const f = this.fp(part);
    const gap = opts.gap ?? partClearance(this.rules, this.info(part), a);
    const rot = typeof opts.rot === 'number' ? opts.rot : f.rot ?? 0;
    const target = pad ? pad.at : rectCenter(a.box);
    const at = this.besideSpot(part, rot, a.box, side, gap, target, opts.pad);
    const spot = opts.slide === false ? at : this.freeSpot(part, rot, at, side);
    this.moveTo(part, spot, rot);
    if (opts.rot === 'best') this.bestRotation(part);
    const f2 = this.fp(part);
    return { at: [...f2.at] as O.Pt, rot: f2.rot ?? 0, free: this.fits(part, f2.at, f2.rot ?? 0) };
  }

  /** Origin for `part` (at `rot`) just beyond `box` on `side`, lined up with `target` across it. */
  private besideSpot(part: string, rot: number, box: Rect, side: Side, gap: number, target: Point, padName?: string): O.Pt {
    const f = this.fp(part);
    const here = this.info(part, { at: f.at, rot });
    const b = here.box;
    // The point of the part to line up with the target: a pad, or the box centre.
    const ref = padName ? here.pads.find((q) => q.name === padName)?.at : rectCenter(b);
    if (!ref) throw new Error(`${part} has no pad ${padName}`);
    let dx = 0;
    let dy = 0;
    if (side === 'above' || side === 'below') {
      dx = target.x - ref.x;
      dy = side === 'above' ? box.maxY + gap - b.minY : box.minY - gap - b.maxY;
    } else {
      dy = target.y - ref.y;
      dx = side === 'right' ? box.maxX + gap - b.minX : box.minX - gap - b.maxX;
    }
    return [f.at[0] + dx, f.at[1] + dy];
  }

  /** Is the part free of conflicts (other parts, holes, the board edge) at this spot? */
  fits(part: string, at: O.Pt, rot?: number): boolean {
    const b = this.info(part, { at, ...(rot !== undefined ? { rot } : {}) });
    const area = this.project.board && boardArea(this.project.board);
    if (area) {
      const o = area.outline;
      const e = this.rules.edge;
      if (b.box.minX < o.minX + e || b.box.minY < o.minY + e || b.box.maxX > o.maxX - e || b.box.maxY > o.maxY - e) return false;
      for (const h of area.holes) if (rectGap(b.box, h) < e - TOLERANCE) return false;
    }
    for (const other of footprintInfos(this.project, this.index)) {
      if (other.part === part) continue;
      if (area && !onBoard(other.box, area.outline)) continue;
      if (b.smd && other.smd && (other.placement.side === 'bottom') !== (this.fp(part).side === 'bottom')) continue;
      if (rectGap(b.box, other.box) < partClearance(this.rules, b, other) - TOLERANCE) return false;
    }
    return true;
  }

  /**
   * The nearest free spot to `at`: sliding along the side first (alternately each way), then
   * stepping further out from the anchor. Falls back to `at` when nothing is free nearby.
   */
  private freeSpot(part: string, rot: number, at: O.Pt, side: Side): O.Pt {
    const along: [number, number] = side === 'above' || side === 'below' ? [1, 0] : [0, 1];
    const out: [number, number] = side === 'above' ? [0, 1] : side === 'below' ? [0, -1] : side === 'right' ? [1, 0] : [-1, 0];
    for (let o = 0; o <= SLIDE; o += STEP) {
      for (let s = 0; s <= SLIDE; s += STEP) {
        for (const sign of s ? [1, -1] : [1]) {
          const p: O.Pt = [at[0] + along[0] * s * sign + out[0] * o, at[1] + along[1] * s * sign + out[1] * o];
          if (this.fits(part, p, rot)) return p;
        }
      }
    }
    return at;
  }

  /**
   * Lay parts out in a row, outlines `gap` apart, centres on one line. `start` is the centre of
   * the first part.
   */
  row(parts: string[], start: Point, opts: { dir?: 'right' | 'left' | 'up' | 'down'; gap?: number; rot?: number } = {}): void {
    const dir = opts.dir ?? 'right';
    let c = { ...start };
    let prev: Rect | undefined;
    let prevInfo: { smd: boolean } | undefined;
    for (const part of parts) {
      const rot = opts.rot ?? this.fp(part).rot ?? 0;
      const info = this.info(part, { rot });
      const size = info.box;
      const w = size.maxX - size.minX;
      const h = size.maxY - size.minY;
      if (prev && prevInfo) {
        const gap = opts.gap ?? partClearance(this.rules, prevInfo, info);
        const pw = prev.maxX - prev.minX;
        const ph = prev.maxY - prev.minY;
        if (dir === 'right') c = { x: c.x + pw / 2 + gap + w / 2, y: c.y };
        else if (dir === 'left') c = { x: c.x - pw / 2 - gap - w / 2, y: c.y };
        else if (dir === 'up') c = { x: c.x, y: c.y + ph / 2 + gap + h / 2 };
        else c = { x: c.x, y: c.y - ph / 2 - gap - h / 2 };
      }
      this.moveTo(part, this.originFor(part, rot, c), rot);
      prev = this.info(part).box;
      prevInfo = info;
    }
  }

  /**
   * Put a part against a board edge (the edge distance in from it), its centre at `pos` along
   * the edge. With no rotation given, a connector-like part (longer than wide) is turned to lie
   * along the edge.
   */
  edge(part: string, edge: Edge, pos: number, opts: { rot?: number; margin?: number } = {}): void {
    const area = this.project.board && boardArea(this.project.board);
    if (!area) throw new Error('The board has no outline');
    const o = area.outline;
    const m = opts.margin ?? this.rules.edge;
    let rot = opts.rot;
    if (rot === undefined) {
      const cur = this.fp(part).rot ?? 0;
      const b = this.info(part, { rot: cur }).box;
      const along = (b.maxX - b.minX >= b.maxY - b.minY) === (edge === 'top' || edge === 'bottom');
      rot = along ? cur : (cur + 90) % 360;
    }
    const b = this.info(part, { rot }).box;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const c =
      edge === 'bottom' ? { x: pos, y: o.minY + m + h / 2 }
        : edge === 'top' ? { x: pos, y: o.maxY - m - h / 2 }
          : edge === 'left' ? { x: o.minX + m + w / 2, y: pos }
            : { x: o.maxX - m - w / 2, y: pos };
    this.moveTo(part, this.originFor(part, rot, c), rot);
  }

  // ---- rotation ---------------------------------------------------------------

  /**
   * Turn a part to the rotation (of 0, 90, 180, 270) with the shortest and least crossed
   * airwires (ground nets aside: a pour connects those), among those that don't add conflicts;
   * it turns about its box centre.
   * Returns the rotation chosen.
   */
  bestRotation(part: string, candidates = [0, 90, 180, 270]): number {
    const f = this.fp(part);
    if (f.locked) return f.rot ?? 0;
    const start = { at: [...f.at] as O.Pt, rot: f.rot ?? 0 };
    const centre = rectCenter(this.info(part).box);
    const fitsNow = this.fits(part, start.at, start.rot);
    let best: { rot: number; at: O.Pt; score: number } | undefined;
    for (const rot of candidates) {
      const at = this.originFor(part, rot, centre);
      if (fitsNow && !this.fits(part, at, rot)) continue;
      this.setRaw(f, at, rot);
      const m = placementMetrics(this.project, footprintInfos(this.project, this.index));
      const score = m.signalLength + m.signalCrossings * CROSSING_COST;
      if (!best || score < best.score - 1e-6) best = { rot, at, score };
    }
    this.setRaw(f, start.at, start.rot);
    if (best && best.rot !== start.rot) this.moveTo(part, best.at, best.rot);
    return this.fp(part).rot ?? 0;
  }

  /**
   * Turn each part (default: every unlocked part on the board) to its best rotation, repeating
   * until nothing improves. Returns the parts turned.
   */
  orient(parts?: string[], passes = 3): string[] {
    const list = parts ?? this.project.board!.footprints.filter((f) => !f.locked).map((f) => f.part);
    const turned = new Set<string>();
    for (let k = 0; k < passes; k++) {
      let changed = false;
      for (const p of list) {
        const before = this.fp(p).rot ?? 0;
        if (this.bestRotation(p) !== before) {
          turned.add(p);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return [...turned];
  }

  /**
   * Improve the placement with small moves (toward connections, nudges, swaps of like parts,
   * rotations) that shorten and untangle signal airwires and bring decoupling caps to their pins,
   * keeping it legal. See improve.ts.
   */
  improve(opts: ImproveOptions = {}): ImproveResult {
    return improve(this, opts);
  }

  /** Try a position without recording it (for scoring). */
  private setRaw(f: O.FootprintPlacement, at: O.Pt, rot: number): void {
    f.at = at;
    if (rot) f.rot = rot;
    else delete f.rot;
  }
}

/** One airwire crossing costs as much as this much airwire length (mm), when choosing. */
const CROSSING_COST = 3;

/** The side of a box a point is nearest to. */
function sideOf(box: Rect, p: Point): Side {
  const d: [Side, number][] = [
    ['left', p.x - box.minX], ['right', box.maxX - p.x], ['below', p.y - box.minY], ['above', box.maxY - p.y],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0]![0];
}
