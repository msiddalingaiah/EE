// Board copper as geometry: every pad, SMD, via and trace as shapes (a segment or convex
// polygon grown by a radius) on its layers, with its net, plus the board outline and holes.
// Shared by the design-rule check (drc.ts) and pour computation (pour.ts).

import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point } from '../geom/transform';
import { apply, placement } from '../geom/transform';
import { netPads, ProjectIndex } from './derive';
import { footprintTransform } from './geometry';
import type { CopperKind, DesignRules } from './rules';
import type * as O from './types';

const EPS = 1e-6;

// Shapes: a core (segment or convex polygon) grown by a radius.

export type Shape = { t: 'cap'; a: Point; b: Point; r: number } | { t: 'poly'; pts: Point[]; r: number };

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Item {
  kind: CopperKind;
  net: string;
  label: string;
  layers: Set<string>;
  shapes: Shape[];
  box: Box;
  obj: object;
  /** What the item is: "part\0pad" for pads, the via or trace object otherwise. */
  ref: string | object;
  /** Pads and vias: the centre, and (pads) the pad's own x and y directions (for thermal spokes). */
  center?: Point;
  axes?: [Point, Point];
}

export function boxOf(shapes: Shape[]): Box {
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
export function closestOnSeg(p: Point, a: Point, b: Point): Point {
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

export interface Near {
  d: number;
  p: Point;
  q: Point;
}

export function segSeg(a: Point, b: Point, c: Point, d: Point): Near {
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

export function inside(p: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(sub(poly[(i + 1) % poly.length]!, poly[i]!), sub(p, poly[i]!));
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  // A polygon with no area (all points on a line) contains nothing.
  return sign !== 0;
}

export const edges = (pts: Point[]): [Point, Point][] => (pts.length === 1 ? [[pts[0]!, pts[0]!]] : pts.map((p, i) => [p, pts[(i + 1) % pts.length]!]));

/** Distance between two cores (0 when they overlap). */
export function coreDistance(s: Shape, t: Shape): Near {
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
export function gap(a: Item, b: Item): Near {
  let best: Near = { d: Infinity, p: { x: 0, y: 0 }, q: { x: 0, y: 0 } };
  // Items with many shapes (pour outlines) are compared shape by shape: skip pairs whose boxes
  // are already further apart than the best gap found, and stop at the first overlap.
  const many = a.shapes.length * b.shapes.length > 64;
  for (const s of a.shapes) {
    const sb = many ? shapeBox(s) : undefined;
    for (const t of b.shapes) {
      if (sb) {
        const tb = shapeBox(t);
        const dx = Math.max(sb.minX - tb.maxX, tb.minX - sb.maxX, 0);
        const dy = Math.max(sb.minY - tb.maxY, tb.minY - sb.maxY, 0);
        if (Math.hypot(dx, dy) > best.d) continue;
      }
      const n = coreDistance(s, t);
      const d = n.d - s.r - t.r;
      if (d < best.d) best = { d, p: n.p, q: n.q };
      if (best.d <= 0) return best;
    }
  }
  return best;
}

const shapeBoxes = new WeakMap<Shape, Box>();
function shapeBox(s: Shape): Box {
  let b = shapeBoxes.get(s);
  if (!b) shapeBoxes.set(s, (b = boxOf([s])));
  return b;
}

// ---------------------------------------------------------------------------
// Collecting copper

export function lineShapes(line: [O.Pt, O.Pt], curve: number | undefined, r: number): Shape[] {
  const a = { x: line[0][0], y: line[0][1] };
  const b = { x: line[1][0], y: line[1][1] };
  if (!curve) return [{ t: 'cap', a, b, r }];
  const pts = arcPoints(arcFromChord(a, b, curve), Math.max(4, Math.ceil(Math.abs(curve) / 10)));
  const out: Shape[] = [];
  for (let i = 1; i < pts.length; i++) out.push({ t: 'cap', a: pts[i - 1]!, b: pts[i]!, r });
  return out;
}

export function regular(n: number, apothem: number, phase: number): Point[] {
  const R = apothem / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return { x: R * Math.cos(a), y: R * Math.sin(a) };
  });
}

export function padShapes(pad: O.Pad, rules: DesignRules): Shape[] {
  if (pad.smd) {
    const [dx, dy] = pad.smd;
    const rc = ((pad.roundness ?? 0) / 100) * (Math.min(dx, dy) / 2);
    const hx = dx / 2 - rc;
    const hy = dy / 2 - rc;
    // Fully rounded: the core shrinks to a point (round pad) or a line (oblong pad).
    const tiny = 1e-9;
    if (hx < tiny && hy < tiny) return [{ t: 'cap', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, r: rc }];
    if (hy < tiny) return [{ t: 'cap', a: { x: -hx, y: 0 }, b: { x: hx, y: 0 }, r: rc }];
    if (hx < tiny) return [{ t: 'cap', a: { x: 0, y: -hy }, b: { x: 0, y: hy }, r: rc }];
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

export function transformShape(s: Shape, f: (p: Point) => Point): Shape {
  return s.t === 'cap' ? { t: 'cap', a: f(s.a), b: f(s.b), r: s.r } : { t: 'poly', pts: s.pts.map(f), r: s.r };
}

export function viaLayers(span: string, stack: string[]): Set<string> {
  const m = /^(\d+)-(\d+)$/.exec(span);
  if (!m) return new Set(stack);
  const lo = Math.min(Number(m[1]), Number(m[2]));
  const hi = Math.max(Number(m[1]), Number(m[2]));
  const number = (name: string) => (name === 'copper.top' ? 1 : name === 'copper.bottom' ? 16 : Number(name.replace('copper.in', '')) + 1);
  return new Set(stack.filter((l) => number(l) >= lo && number(l) <= hi));
}

/** Unit x and y directions of a frame, in world coordinates. */
function axesOf(toWorld: (p: Point) => Point): [Point, Point] {
  const o = toWorld({ x: 0, y: 0 });
  const unit = (p: Point) => {
    const d = Math.hypot(p.x - o.x, p.y - o.y) || 1;
    return { x: (p.x - o.x) / d, y: (p.y - o.y) / d };
  };
  return [unit(toWorld({ x: 1, y: 0 })), unit(toWorld({ x: 0, y: 1 }))];
}

export function collect(project: O.Project, rules: DesignRules, index: ProjectIndex): Item[] {
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
        label: `pad ${f.part}.${pad.name}${net ? ` (${net})` : ''}`, layers, shapes, box: boxOf(shapes), obj: f, ref: `${f.part}\u0000${pad.name}`,
        center: toWorld({ x: 0, y: 0 }), axes: axesOf(toWorld),
      });
    }
  }
  for (const net of project.nets) {
    for (const t of net.traces ?? []) {
      if (!stack.includes(t.layer)) continue;
      const shapes = lineShapes(t.line, t.curve, t.width / 2);
      items.push({ kind: 'wire', net: net.name, label: `wire on ${net.name}`, layers: new Set([t.layer]), shapes, box: boxOf(shapes), obj: t, ref: t });
    }
    for (const v of net.vias ?? []) {
      const D = rules.viaDiameter(v.drill, v.diameter ?? 0);
      const c = { x: v.at[0], y: v.at[1] };
      const core: Shape = v.shape === 'square'
        ? { t: 'poly', pts: [{ x: c.x - D / 2, y: c.y - D / 2 }, { x: c.x + D / 2, y: c.y - D / 2 }, { x: c.x + D / 2, y: c.y + D / 2 }, { x: c.x - D / 2, y: c.y + D / 2 }], r: 0 }
        : v.shape === 'octagon'
          ? { t: 'poly', pts: regular(8, D / 2, Math.PI / 8).map((p) => ({ x: p.x + c.x, y: p.y + c.y })), r: 0 }
          : { t: 'cap', a: c, b: c, r: D / 2 };
      items.push({ kind: 'via', net: net.name, label: `via on ${net.name}`, layers: viaLayers(v.layers ?? '1-16', stack), shapes: [core], box: boxOf([core]), obj: v, ref: v, center: c, axes: [{ x: 1, y: 0 }, { x: 0, y: 1 }] });
    }
  }
  return items;
}

/** The board outline and holes, as shapes (for the copper-to-dimension check). */
export function dimension(board: O.Board): { shapes: Shape[]; obj: object }[] {
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

