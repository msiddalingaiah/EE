// Design-rule check (DRC) of a board against its design rules (rules.ts):
//
// - Clearance: copper of different nets on a shared layer must be at least the rule's distance
//   apart (Eagle's per-pair distances: wire, pad, SMD, via). Touching copper is a short.
//   Pads on no net count as their own net.
// - Width: traces at least the minimum width. Drill: vias, pads and holes at least the minimum.
// - Dimension: copper at least the rule's distance from the board outline and holes (poured
//   copper: the pour's isolate, which it keeps whatever the rules say); every
//   end of an outline line meets another (an open outline isn't a board shape).
// - Unrouted: every airwire left (ratsnest.ts) is a problem, so a board passes only when each
//   net's copper is joined (by traces, vias or pours).
//
// Copper shapes are exact for traces, vias, round/long/offset pads and SMDs (with roundness);
// square and octagon pads are polygons. Arcs are split into short chords. Pours are checked as
// their computed copper (pour.ts), as edges: they are built clear of everything, so this finds
// overlapping pours of different nets and anything closer than the rules.

import type { Point } from '../geom/transform';
import { apply } from '../geom/transform';
import { boxOf, collect, coreDistance, dimension, gap, lineShapes, type Box, type Item, type Near, type Shape } from './copper';
import { ProjectIndex } from './derive';
import { footprintTransform } from './geometry';
import { pourFills, pourIsolate } from './pour';
import { ratsnest } from './ratsnest';
import { designRules, DesignRules, type CopperKind } from './rules';
import type * as O from './types';

export type ViolationKind = 'overlap' | 'clearance' | 'width' | 'drill' | 'dimension' | 'unrouted';

export interface Violation {
  kind: ViolationKind;
  message: string;
  /** Where to look. */
  at: O.Pt;
  layer?: string;
  /** The model objects involved (traces, vias, footprint placements). */
  objects: object[];
  nets: string[];
  actual?: number;
  required?: number;
}

export interface DrcResult {
  rules: DesignRules;
  violations: Violation[];
  /** How many copper items were checked. */
  checked: number;
}

const EPS = 1e-6;

// ---------------------------------------------------------------------------

const fmt = (mm: number) => `${(Math.round(mm * 1000) / 1000).toFixed(3)} mm (${(mm / 0.0254).toFixed(1)} mil)`;
const mid = (n: Near): O.Pt => [Math.round(((n.p.x + n.q.x) / 2) * 1e6) / 1e6, Math.round(((n.p.y + n.q.y) / 2) * 1e6) / 1e6];
const KIND_NAME: Record<CopperKind, string> = { wire: 'wire', pad: 'pad', smd: 'SMD', via: 'via' };

/** Check a project's board. */
export function drc(project: O.Project): DrcResult {
  const rules = new DesignRules(designRules(project));
  const board = project.board;
  if (!board) return { rules, violations: [], checked: 0 };
  const index = new ProjectIndex(project);
  const poured = pourItems(project, index);
  const items = [...collect(project, rules, index), ...poured];
  const out: Violation[] = [];

  // Clearance and shorts: sweep over x, comparing items whose boxes come within the margin.
  const margin = rules.maxClearance;
  const sorted = [...items].sort((a, b) => a.box.minX - b.box.minX);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.box.minX > a.box.maxX + margin) break;
      if (a.net === b.net) continue;
      if (b.box.minY > a.box.maxY + margin || a.box.minY > b.box.maxY + margin) continue;
      const shared = [...a.layers].filter((l) => b.layers.has(l));
      if (!shared.length) continue;
      const required = rules.clearance(a.kind, b.kind);
      const n = gap(a, b);
      if (n.d >= required - EPS) continue;
      const layer = shared.length === 1 ? shared[0]! : undefined;
      const where = layer ? ` on ${layer.replace('copper.', '')}` : '';
      const pair = `${a.label} and ${b.label}`;
      out.push(n.d <= EPS
        ? { kind: 'overlap', message: `Short: ${pair} touch${where}`, at: mid(n), ...(layer ? { layer } : {}), objects: [a.obj, b.obj], nets: realNets(a, b), actual: Math.max(n.d, 0), required }
        : { kind: 'clearance', message: `Clearance ${fmt(n.d)} < ${fmt(required)} (${KIND_NAME[a.kind]}–${KIND_NAME[b.kind]}) between ${pair}${where}`, at: mid(n), ...(layer ? { layer } : {}), objects: [a.obj, b.obj], nets: realNets(a, b), actual: n.d, required });
    }
  }

  // Minimum width and drill.
  const minWidth = rules.minWidth;
  const minDrill = rules.minDrill;
  for (const net of project.nets) {
    for (const t of net.traces ?? []) {
      if (t.width < minWidth - EPS) {
        out.push({ kind: 'width', message: `Width ${fmt(t.width)} < ${fmt(minWidth)}: wire on ${net.name}`, at: mid({ d: 0, p: pt(t.line[0]), q: pt(t.line[1]) }), layer: t.layer, objects: [t], nets: [net.name], actual: t.width, required: minWidth });
      }
    }
    for (const v of net.vias ?? []) {
      if (v.drill < minDrill - EPS) out.push({ kind: 'drill', message: `Drill ${fmt(v.drill)} < ${fmt(minDrill)}: via on ${net.name}`, at: v.at, objects: [v], nets: [net.name], actual: v.drill, required: minDrill });
    }
  }
  for (const f of board.footprints) {
    const part = index.parts.get(f.part);
    const fp = part && index.footprints.get(index.variantOf(part)?.footprint ?? '');
    for (const pad of fp?.pads ?? []) {
      if (pad.smd || pad.drill === undefined || pad.drill >= minDrill - EPS) continue;
      const p = apply(footprintTransform(f), pad.at[0], pad.at[1]);
      out.push({ kind: 'drill', message: `Drill ${fmt(pad.drill)} < ${fmt(minDrill)}: pad ${f.part}.${pad.name}`, at: [p.x, p.y], objects: [f], nets: [], actual: pad.drill, required: minDrill });
    }
  }
  for (const g of board.drawing) {
    if ('hole' in g && g.drill < minDrill - EPS) out.push({ kind: 'drill', message: `Drill ${fmt(g.drill)} < ${fmt(minDrill)}: hole`, at: g.hole, objects: [g], nets: [], actual: g.drill, required: minDrill });
  }

  // Copper to the board outline and holes.
  const edges = dimension(board);
  if (edges.length) {
    const pours = new Set(poured);
    for (const item of items) {
      const dim = pours.has(item) ? pourIsolate(item.obj as O.PolygonShape) : rules.copperDimension;
      let worst: { n: Near; obj: object } | undefined;
      for (const e of edges) {
        const box = boxOf(e.shapes);
        if (box.minX > item.box.maxX + dim || item.box.minX > box.maxX + dim || box.minY > item.box.maxY + dim || item.box.minY > box.maxY + dim) continue;
        for (const s of e.shapes) {
          for (const c of item.shapes) {
            const n = coreDistance(c, s);
            const d = n.d - c.r - s.r;
            if (d < dim - EPS && (!worst || d < worst.n.d)) worst = { n: { d, p: n.p, q: n.q }, obj: e.obj };
          }
        }
      }
      if (worst) {
        out.push({
          kind: 'dimension', message: `Copper ${fmt(Math.max(worst.n.d, 0))} from the board edge or a hole (< ${fmt(dim)}): ${item.label}`,
          at: mid(worst.n), objects: [item.obj, worst.obj], nets: realNets(item), actual: Math.max(worst.n.d, 0), required: dim,
        });
      }
    }
  }

  // Open ends of the board outline.
  for (const gap of outlineGaps(board)) {
    out.push({
      kind: 'dimension',
      message: gap.b
        ? `Board outline is open: ends ${fmt(gap.d)} apart at (${gap.a[0]}, ${gap.a[1]}) and (${gap.b[0]}, ${gap.b[1]})`
        : `Board outline is open at (${gap.a[0]}, ${gap.a[1]})`,
      at: gap.b ? [(gap.a[0] + gap.b[0]) / 2, (gap.a[1] + gap.b[1]) / 2] : gap.a, objects: gap.objects, nets: [], actual: gap.d,
    });
  }

  // Connections not made yet.
  const xy = (p: O.Pt) => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;
  for (const a of ratsnest(project)) {
    out.push({
      kind: 'unrouted', message: `Unrouted: ${a.net} from ${xy(a.from)} to ${xy(a.to)}`,
      at: mid({ d: 0, p: pt(a.from), q: pt(a.to) }), objects: [], nets: [a.net],
    });
  }

  const order: ViolationKind[] = ['overlap', 'clearance', 'width', 'drill', 'dimension', 'unrouted'];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { rules, violations: out, checked: items.length };
}

// ---------------------------------------------------------------------------
// Checking new copper as it is drawn

/** A raster of cells a trace centre can't enter (1 = blocked); cell (i, j) is at (x0 + i·step, y0 + j·step). */
export interface ObstacleGrid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  step: number;
  blocked: Uint8Array;
}

const EMPTY: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
const union = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });

/** A rule a piece of new copper would break. */
export interface Conflict {
  message: string;
  /** Where (between the new copper and what it comes too close to). */
  at: O.Pt;
  /** Gap to the other copper (≤ 0 when touching), and what the rule asks for. */
  gap: number;
  required: number;
  /** What it comes too close to, e.g. "pad C2.1 (N$1)" or "the board edge". */
  other: string;
}

/**
 * Checks new traces and vias against the board's existing copper and outline, before they are
 * added (for routing). Build one per model state; it indexes the copper once.
 */
export class ClearanceChecker {
  readonly rules: DesignRules;
  private readonly items: Item[];
  private readonly edges: { shapes: Shape[]; box: Box }[];
  private readonly stack: string[];

  constructor(project: O.Project, index = new ProjectIndex(project)) {
    this.rules = new DesignRules(designRules(project));
    const board = project.board;
    this.items = board ? collect(project, this.rules, index) : [];
    this.edges = board ? dimension(board).map((e) => ({ shapes: e.shapes, box: boxOf(e.shapes) })) : [];
    this.stack = board?.layers.length ? board.layers : ['copper.top', 'copper.bottom'];
  }

  /** Problems a new trace of `net` would have, nearest first. */
  trace(net: string, line: [O.Pt, O.Pt], layer: string, width: number): Conflict[] {
    const shapes = lineShapes(line, undefined, width / 2);
    return this.check({ kind: 'wire', net, label: `wire on ${net}`, layers: new Set([layer]), shapes, box: boxOf(shapes), obj: {}, ref: {} });
  }

  /** Problems a new via of `net` would have (on every copper layer), nearest first. */
  via(net: string, at: O.Pt, drill: number): Conflict[] {
    const D = this.rules.viaDiameter(drill, 0);
    const c = { x: at[0], y: at[1] };
    const shapes: Shape[] = [{ t: 'cap', a: c, b: c, r: D / 2 }];
    return this.check({ kind: 'via', net, label: `via on ${net}`, layers: new Set(this.stack), shapes, box: boxOf(shapes), obj: {}, ref: {} });
  }

  /** Can a trace of `net` run straight from a to b on `layer`? (Exact, like `trace`.) */
  clear(net: string, a: O.Pt, b: O.Pt, layer: string, width: number): boolean {
    return this.trace(net, [a, b], layer, width).length === 0;
  }

  /**
   * Where the centre line of a trace of `net` (on `layer`, `width` wide) can't go, as a raster
   * of `step` cells aligned to multiples of `step`. A cell is blocked when a trace centre there
   * would come within the clearance of other nets' copper or the board edge, with `slack` added
   * so that straight and diagonal moves between free cells are clear too; cells outside the
   * board outline are blocked. Used to search for routes around obstacles.
   */
  obstacles(net: string, layer: string, width: number, step: number, kind: CopperKind = 'wire'): ObstacleGrid {
    const slack = step * Math.SQRT1_2 + EPS;
    // Region: the board outline's bounds (else all copper), on the grid.
    let box = this.edges.length ? this.edges.map((e) => e.box).reduce(union) : this.items.map((i) => i.box).reduce(union, EMPTY);
    if (!Number.isFinite(box.minX)) box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const x0 = Math.floor(box.minX / step) * step;
    const y0 = Math.floor(box.minY / step) * step;
    const w = Math.max(1, Math.ceil((box.maxX - x0) / step) + 1);
    const h = Math.max(1, Math.ceil((box.maxY - y0) / step) + 1);
    const blocked = new Uint8Array(w * h);
    const half = width / 2;

    const mark = (shapes: Shape[], bounds: Box, reach: number) => {
      const i0 = Math.max(0, Math.floor((bounds.minX - reach - x0) / step));
      const i1 = Math.min(w - 1, Math.ceil((bounds.maxX + reach - x0) / step));
      const j0 = Math.max(0, Math.floor((bounds.minY - reach - y0) / step));
      const j1 = Math.min(h - 1, Math.ceil((bounds.maxY + reach - y0) / step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * w + i;
          if (blocked[k]) continue;
          const c = { x: x0 + i * step, y: y0 + j * step };
          const p: Shape = { t: 'cap', a: c, b: c, r: 0 };
          for (const s of shapes) {
            if (coreDistance(p, s).d - s.r < reach) {
              blocked[k] = 1;
              break;
            }
          }
        }
      }
    };
    for (const other of this.items) {
      if (other.net === net || !other.layers.has(layer)) continue;
      mark(other.shapes, other.box, this.rules.clearance(kind, other.kind) + half + slack);
    }
    const dim = this.rules.copperDimension + half + slack;
    const outline: [Point, Point][] = [];
    for (const e of this.edges) {
      mark(e.shapes, e.box, dim);
      for (const s of e.shapes) if (s.t === 'cap' && s.r < 1) outline.push([s.a, s.b]);
    }
    // Outside the outline (when it encloses anything): odd-even test along each row.
    if (outline.length >= 3) {
      for (let j = 0; j < h; j++) {
        const y = y0 + j * step + 1e-7;
        const xs: number[] = [];
        for (const [a, b] of outline) {
          if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i < w; i++) {
          const x = x0 + i * step;
          let n = 0;
          for (const v of xs) if (v < x) n++;
          if (n % 2 === 0) blocked[j * w + i] = 1;
        }
      }
    }
    return { x0, y0, w, h, step, blocked };
  }

  private check(item: Item): Conflict[] {
    const out: Conflict[] = [];
    const margin = this.rules.maxClearance;
    for (const other of this.items) {
      if (other.net === item.net) continue;
      const b = other.box;
      if (b.minX > item.box.maxX + margin || item.box.minX > b.maxX + margin || b.minY > item.box.maxY + margin || item.box.minY > b.maxY + margin) continue;
      if (![...other.layers].some((l) => item.layers.has(l))) continue;
      const required = this.rules.clearance(item.kind, other.kind);
      const n = gap(item, other);
      if (n.d >= required - EPS) continue;
      out.push({
        message: n.d <= EPS ? `Would touch ${other.label}` : `Too close to ${other.label}: ${fmt(n.d)} < ${fmt(required)}`,
        at: mid(n), gap: n.d, required, other: other.label,
      });
    }
    const dim = this.rules.copperDimension;
    for (const e of this.edges) {
      if (e.box.minX > item.box.maxX + dim || item.box.minX > e.box.maxX + dim || e.box.minY > item.box.maxY + dim || item.box.minY > e.box.maxY + dim) continue;
      for (const s of e.shapes) {
        for (const c of item.shapes) {
          const n = coreDistance(c, s);
          const d = n.d - c.r - s.r;
          if (d < dim - EPS) out.push({ message: `Too close to the board edge or a hole: ${fmt(Math.max(d, 0))} < ${fmt(dim)}`, at: mid({ d, p: n.p, q: n.q }), gap: d, required: dim, other: 'the board edge' });
        }
      }
    }
    return out.sort((a, b) => a.gap - a.required - (b.gap - b.required));
  }
}

const pt = (p: O.Pt): Point => ({ x: p[0], y: p[1] });

/**
 * Ends of outline lines that meet no other outline line's end, paired with the nearest other
 * open end (each gap once). Outline circles are closed by themselves.
 */
function outlineGaps(board: O.Board): { a: O.Pt; b?: O.Pt; d: number; objects: object[] }[] {
  const ends: { p: O.Pt; line: object }[] = [];
  for (const g of board.drawing) if ('line' in g && g.layer === 'outline') ends.push({ p: g.line[0], line: g }, { p: g.line[1], line: g });
  const dist = (a: O.Pt, b: O.Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const open = ends.filter((e) => !ends.some((o) => o !== e && o.line !== e.line && dist(o.p, e.p) < 1e-3));
  const done = new Set<object>();
  const out: { a: O.Pt; b?: O.Pt; d: number; objects: object[] }[] = [];
  for (const e of open) {
    if (done.has(e)) continue;
    done.add(e);
    let best: { p: O.Pt; line: object } | undefined;
    for (const o of open) if (!done.has(o) && o.line !== e.line && (!best || dist(o.p, e.p) < dist(best.p, e.p))) best = o;
    if (best) done.add(best);
    out.push(best ? { a: e.p, b: best.p, d: dist(e.p, best.p), objects: [e.line, best.line] } : { a: e.p, d: 0, objects: [e.line] });
  }
  return out;
}

/** Poured copper as items: each island's outline and holes as edges (checked like a wire). */
function pourItems(project: O.Project, index: ProjectIndex): Item[] {
  const out: Item[] = [];
  for (const f of pourFills(project, index).values()) {
    for (const isl of f.islands) {
      const shapes: Shape[] = [];
      for (const ring of [isl.outer, ...isl.holes]) {
        ring.forEach((p, i) => shapes.push({ t: 'cap', a: pt(p), b: pt(ring[(i + 1) % ring.length]!), r: 0 }));
      }
      out.push({ kind: 'wire', net: f.net, label: `pour of ${f.net}`, layers: new Set([f.layer]), shapes, box: boxOf(shapes), obj: f.pour, ref: f.pour });
    }
  }
  return out;
}
const realNets = (...items: Item[]) => [...new Set(items.map((i) => i.net).filter((n) => !n.startsWith('\u0000')))];
