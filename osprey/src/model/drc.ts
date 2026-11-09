// Design-rule check (DRC) of a board against its design rules (rules.ts):
//
// - Clearance: copper of different nets on a shared layer must be at least the rule's distance
//   apart (Eagle's per-pair distances: wire, pad, SMD, via). Touching copper is a short.
//   Pads on no net count as their own net.
// - Width: traces at least the minimum width. Drill: vias, pads and holes at least the minimum.
// - Dimension: copper at least the rule's distance from the board outline and holes.
//
// Copper shapes are exact for traces, vias, round/long/offset pads and SMDs (with roundness);
// square and octagon pads are polygons. Arcs are split into short chords. Pours (polygons) are
// not checked: the poured copper isn't computed.

import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point } from '../geom/transform';
import { apply, placement } from '../geom/transform';
import { netPads, ProjectIndex } from './derive';
import { footprintTransform } from './geometry';
import { designRules, DesignRules, type CopperKind } from './rules';
import type * as O from './types';

export type ViolationKind = 'overlap' | 'clearance' | 'width' | 'drill' | 'dimension';

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
// Shapes: a core (segment or convex polygon) grown by a radius.

type Shape = { t: 'cap'; a: Point; b: Point; r: number } | { t: 'poly'; pts: Point[]; r: number };

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Item {
  kind: CopperKind;
  net: string;
  label: string;
  layers: Set<string>;
  shapes: Shape[];
  box: Box;
  obj: object;
}

function boxOf(shapes: Shape[]): Box {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of shapes) {
    const pts = s.t === 'cap' ? [s.a, s.b] : s.pts;
    for (const p of pts) {
      b.minX = Math.min(b.minX, p.x - s.r);
      b.minY = Math.min(b.minY, p.y - s.r);
      b.maxX = Math.max(b.maxX, p.x + s.r);
      b.maxY = Math.max(b.maxY, p.y + s.r);
    }
  }
  return b;
}

const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Closest point on segment ab to p. */
function closestOnSeg(p: Point, a: Point, b: Point): Point {
  const d = sub(b, a);
  const len2 = d.x * d.x + d.y * d.y;
  if (len2 < EPS * EPS) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2));
  return lerp(a, b, t);
}

/** Do segments ab and cd cross (or touch)? Returns the crossing point. */
function intersect(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return undefined; // parallel: the endpoint distances cover it
  const t = cross(sub(c, a), s) / den;
  const u = cross(sub(c, a), r) / den;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? lerp(a, b, t) : undefined;
}

interface Near {
  d: number;
  p: Point;
  q: Point;
}

function segSeg(a: Point, b: Point, c: Point, d: Point): Near {
  const x = intersect(a, b, c, d);
  if (x) return { d: 0, p: x, q: x };
  let best: Near = { d: Infinity, p: a, q: c };
  const consider = (p: Point, q: Point) => {
    const e = Math.hypot(p.x - q.x, p.y - q.y);
    if (e < best.d) best = { d: e, p, q };
  };
  consider(a, closestOnSeg(a, c, d));
  consider(b, closestOnSeg(b, c, d));
  consider(closestOnSeg(c, a, b), c);
  consider(closestOnSeg(d, a, b), d);
  return best;
}

function inside(p: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(sub(poly[(i + 1) % poly.length]!, poly[i]!), sub(p, poly[i]!));
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const edges = (pts: Point[]): [Point, Point][] => (pts.length === 1 ? [[pts[0]!, pts[0]!]] : pts.map((p, i) => [p, pts[(i + 1) % pts.length]!]));

/** Distance between two cores (0 when they overlap). */
function coreDistance(s: Shape, t: Shape): Near {
  const segsS = s.t === 'cap' ? [[s.a, s.b] as [Point, Point]] : edges(s.pts);
  const segsT = t.t === 'cap' ? [[t.a, t.b] as [Point, Point]] : edges(t.pts);
  if (t.t === 'poly') {
    const p = s.t === 'cap' ? s.a : s.pts[0]!;
    if (inside(p, t.pts)) return { d: 0, p, q: p };
  }
  if (s.t === 'poly') {
    const p = t.t === 'cap' ? t.a : t.pts[0]!;
    if (inside(p, s.pts)) return { d: 0, p, q: p };
  }
  let best: Near = { d: Infinity, p: { x: 0, y: 0 }, q: { x: 0, y: 0 } };
  for (const [a, b] of segsS) {
    for (const [c, d] of segsT) {
      const n = segSeg(a, b, c, d);
      if (n.d < best.d) best = n;
      if (best.d === 0) return best;
    }
  }
  return best;
}

/** Gap between two items' copper (negative or zero when they touch). */
function gap(a: Item, b: Item): Near {
  let best: Near = { d: Infinity, p: { x: 0, y: 0 }, q: { x: 0, y: 0 } };
  for (const s of a.shapes) {
    for (const t of b.shapes) {
      const n = coreDistance(s, t);
      const d = n.d - s.r - t.r;
      if (d < best.d) best = { d, p: n.p, q: n.q };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Collecting copper

function lineShapes(line: [O.Pt, O.Pt], curve: number | undefined, r: number): Shape[] {
  const a = { x: line[0][0], y: line[0][1] };
  const b = { x: line[1][0], y: line[1][1] };
  if (!curve) return [{ t: 'cap', a, b, r }];
  const pts = arcPoints(arcFromChord(a, b, curve), Math.max(4, Math.ceil(Math.abs(curve) / 10)));
  const out: Shape[] = [];
  for (let i = 1; i < pts.length; i++) out.push({ t: 'cap', a: pts[i - 1]!, b: pts[i]!, r });
  return out;
}

function regular(n: number, apothem: number, phase: number): Point[] {
  const R = apothem / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return { x: R * Math.cos(a), y: R * Math.sin(a) };
  });
}

function padShapes(pad: O.Pad, rules: DesignRules): Shape[] {
  if (pad.smd) {
    const [dx, dy] = pad.smd;
    const rc = ((pad.roundness ?? 0) / 100) * (Math.min(dx, dy) / 2);
    const hx = dx / 2 - rc;
    const hy = dy / 2 - rc;
    return [{ t: 'poly', pts: [{ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy }], r: rc }];
  }
  const D = rules.padDiameter(pad.drill ?? 0, pad.diameter ?? 0);
  switch (pad.shape) {
    case 'square':
      return [{ t: 'poly', pts: [{ x: -D / 2, y: -D / 2 }, { x: D / 2, y: -D / 2 }, { x: D / 2, y: D / 2 }, { x: -D / 2, y: D / 2 }], r: 0 }];
    case 'octagon':
      return [{ t: 'poly', pts: regular(8, D / 2, Math.PI / 8), r: 0 }];
    case 'long': {
      const e = (D * rules.elongation('long')) / 100 / 2;
      return [{ t: 'cap', a: { x: -e, y: 0 }, b: { x: e, y: 0 }, r: D / 2 }];
    }
    case 'offset': {
      const e = (D * rules.elongation('offset')) / 100;
      return [{ t: 'cap', a: { x: 0, y: 0 }, b: { x: e, y: 0 }, r: D / 2 }];
    }
    default:
      return [{ t: 'cap', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, r: D / 2 }];
  }
}

function transformShape(s: Shape, f: (p: Point) => Point): Shape {
  return s.t === 'cap' ? { t: 'cap', a: f(s.a), b: f(s.b), r: s.r } : { t: 'poly', pts: s.pts.map(f), r: s.r };
}

function viaLayers(span: string, stack: string[]): Set<string> {
  const m = /^(\d+)-(\d+)$/.exec(span);
  if (!m) return new Set(stack);
  const lo = Math.min(Number(m[1]), Number(m[2]));
  const hi = Math.max(Number(m[1]), Number(m[2]));
  const number = (name: string) => (name === 'copper.top' ? 1 : name === 'copper.bottom' ? 16 : Number(name.replace('copper.in', '')) + 1);
  return new Set(stack.filter((l) => number(l) >= lo && number(l) <= hi));
}

function collect(project: O.Project, rules: DesignRules, index: ProjectIndex): Item[] {
  const board = project.board!;
  const stack = board.layers.length ? board.layers : ['copper.top', 'copper.bottom'];
  const items: Item[] = [];
  const netOfPad = new Map<string, string>();
  for (const [net, keys] of netPads(project, index)) for (const k of keys) netOfPad.set(k, net);

  for (const f of board.footprints) {
    const part = index.parts.get(f.part);
    const fpId = part && index.variantOf(part)?.footprint;
    const fp = fpId ? index.footprints.get(fpId) : undefined;
    if (!fp) continue;
    const FT = footprintTransform(f);
    for (const pad of fp.pads) {
      const PT = placement(pad.at[0], pad.at[1], { angle: pad.rot ?? 0, mirror: false, spin: false });
      const toWorld = (p: Point) => {
        const q = apply(PT, p.x, p.y);
        return apply(FT, q.x, q.y);
      };
      const shapes = padShapes(pad, rules).map((s) => transformShape(s, toWorld));
      const layers = pad.smd ? new Set([(pad.side === 'bottom') !== (f.side === 'bottom') ? 'copper.bottom' : 'copper.top']) : new Set(stack);
      const net = netOfPad.get(`${f.part}\u0000${pad.name}`);
      items.push({
        kind: pad.smd ? 'smd' : 'pad', net: net ?? `\u0000${f.part}.${pad.name}`,
        label: `pad ${f.part}.${pad.name}${net ? ` (${net})` : ''}`, layers, shapes, box: boxOf(shapes), obj: f,
      });
    }
  }
  for (const net of project.nets) {
    for (const t of net.traces ?? []) {
      if (!stack.includes(t.layer)) continue;
      const shapes = lineShapes(t.line, t.curve, t.width / 2);
      items.push({ kind: 'wire', net: net.name, label: `wire on ${net.name}`, layers: new Set([t.layer]), shapes, box: boxOf(shapes), obj: t });
    }
    for (const v of net.vias ?? []) {
      const D = rules.viaDiameter(v.drill, v.diameter ?? 0);
      const c = { x: v.at[0], y: v.at[1] };
      const core: Shape = v.shape === 'square'
        ? { t: 'poly', pts: [{ x: c.x - D / 2, y: c.y - D / 2 }, { x: c.x + D / 2, y: c.y - D / 2 }, { x: c.x + D / 2, y: c.y + D / 2 }, { x: c.x - D / 2, y: c.y + D / 2 }], r: 0 }
        : v.shape === 'octagon'
          ? { t: 'poly', pts: regular(8, D / 2, Math.PI / 8).map((p) => ({ x: p.x + c.x, y: p.y + c.y })), r: 0 }
          : { t: 'cap', a: c, b: c, r: D / 2 };
      items.push({ kind: 'via', net: net.name, label: `via on ${net.name}`, layers: viaLayers(v.layers ?? '1-16', stack), shapes: [core], box: boxOf([core]), obj: v });
    }
  }
  return items;
}

/** The board outline and holes, as shapes (for the copper-to-dimension check). */
function dimension(board: O.Board): { shapes: Shape[]; obj: object }[] {
  const out: { shapes: Shape[]; obj: object }[] = [];
  for (const g of board.drawing) {
    if ('line' in g && g.layer === 'outline') out.push({ shapes: lineShapes(g.line, g.curve, g.width / 2), obj: g });
    else if ('circle' in g && g.layer === 'outline') {
      const pts = regular(36, g.radius, 0).map((p) => ({ x: p.x + g.circle[0], y: p.y + g.circle[1] }));
      out.push({ shapes: edges(pts).map(([a, b]) => ({ t: 'cap', a, b, r: g.width / 2 })), obj: g });
    } else if ('hole' in g) out.push({ shapes: [{ t: 'cap', a: { x: g.hole[0], y: g.hole[1] }, b: { x: g.hole[0], y: g.hole[1] }, r: g.drill / 2 }], obj: g });
  }
  return out;
}

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
  const items = collect(project, rules, index);
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
  const dim = rules.copperDimension;
  const edges = dimension(board);
  if (edges.length) {
    for (const item of items) {
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

  const order: ViolationKind[] = ['overlap', 'clearance', 'width', 'drill', 'dimension'];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { rules, violations: out, checked: items.length };
}

// ---------------------------------------------------------------------------
// Checking new copper as it is drawn

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
    return this.check({ kind: 'wire', net, label: `wire on ${net}`, layers: new Set([layer]), shapes, box: boxOf(shapes), obj: {} });
  }

  /** Problems a new via of `net` would have (on every copper layer), nearest first. */
  via(net: string, at: O.Pt, drill: number): Conflict[] {
    const D = this.rules.viaDiameter(drill, 0);
    const c = { x: at[0], y: at[1] };
    const shapes: Shape[] = [{ t: 'cap', a: c, b: c, r: D / 2 }];
    return this.check({ kind: 'via', net, label: `via on ${net}`, layers: new Set(this.stack), shapes, box: boxOf(shapes), obj: {} });
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
const realNets = (...items: Item[]) => [...new Set(items.map((i) => i.net).filter((n) => !n.startsWith('\u0000')))];
