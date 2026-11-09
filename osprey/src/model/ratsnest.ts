// Ratsnest: the airwires of a board — for each net, the shortest connections that would
// join its copper pieces (pads, vias, traces, pours) that aren't connected yet.
//
// 1. Collect the net's copper: pads (placed through their footprint), vias, traces, pours.
// 2. Union what touches: traces with traces on the same layer (end on end, or end on the
//    other trace), traces with pads and vias, vias spanning a layer with pads on it, and
//    anything a pour's poured island reaches on the pour's layer (pour.ts computes the fill;
//    each island connects separately).
// 3. Join the resulting groups with a minimum spanning tree over the closest pair of points
//    (pad centres, via centres, trace ends), as Eagle does.

import type { Point } from '../geom/transform';
import { apply, placement } from '../geom/transform';
import { netPads, ProjectIndex } from './derive';
import { pourFills, type PourFill } from './pour';
import type { Footprint, FootprintPlacement, Net, Pad, PolygonShape, PolyPt, Project, Pt } from './types';

export interface Airwire {
  net: string;
  from: Pt;
  to: Pt;
}

const EPS = 1e-4;

interface Node {
  /** Identity shared with pour islands: "part\0pad", or the via or trace object. */
  ref: string | object;
  /** Points an airwire may attach to. */
  points: Point[];
  /** Copper layers this item is on. */
  layers: Set<string>;
}

interface PadNode extends Node {
  kind: 'pad';
  center: Point;
  /** Rough copper extent: radius for round/through-hole pads, half sizes for SMDs (unrotated frame). */
  hit: (p: Point) => boolean;
  reach: number;
}

interface ViaNode extends Node {
  kind: 'via';
  center: Point;
  radius: number;
}

interface TraceNode extends Node {
  kind: 'trace';
  a: Point;
  b: Point;
  halfWidth: number;
  layer: string;
}

type CopperNode = PadNode | ViaNode | TraceNode;

/** Airwires for every net of the board (empty when the project has no board). */
export function ratsnest(project: Project): Airwire[] {
  const board = project.board;
  if (!board) return [];
  const index = new ProjectIndex(project);
  const footprints = new Map(project.library.footprints.map((f) => [f.id, f]));
  const placements = new Map(board.footprints.map((f) => [f.part, f]));
  const pads = netPads(project, index);
  const fills = pourFills(project, index);
  const out: Airwire[] = [];
  for (const net of project.nets) {
    const nodes = collect(net, pads.get(net.name) ?? new Set(), board.layers, index, footprints, placements);
    out.push(...connect(net, nodes, board.layers, fills));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collecting copper

function collect(
  net: Net, padKeys: Set<string>, stack: string[], index: ProjectIndex,
  footprints: Map<string, Footprint>, placements: Map<string, FootprintPlacement>,
): CopperNode[] {
  const nodes: CopperNode[] = [];
  for (const key of padKeys) {
    const [partName, padName] = key.split('\u0000') as [string, string];
    const part = index.parts.get(partName);
    const place = placements.get(partName);
    const fpId = part && index.variantOf(part)?.footprint;
    const pad = fpId ? footprints.get(fpId)?.pads.find((p) => p.name === padName) : undefined;
    if (!place || !pad) continue;
    nodes.push(padNode(pad, place, stack, key));
  }
  for (const v of net.vias ?? []) {
    const radius = Math.max(v.diameter ?? 0, v.drill * 1.5) / 2;
    nodes.push({ kind: 'via', ref: v, center: pt(v.at), radius, points: [pt(v.at)], layers: viaLayers(v.layers ?? '1-16', stack) });
  }
  for (const t of net.traces ?? []) {
    const a = pt(t.line[0]);
    const b = pt(t.line[1]);
    nodes.push({ kind: 'trace', ref: t, a, b, halfWidth: t.width / 2, layer: t.layer, points: [a, b], layers: new Set([t.layer]) });
  }
  return nodes;
}

function padNode(pad: Pad, place: FootprintPlacement, stack: string[], ref: string): PadNode {
  const bottom = place.side === 'bottom';
  const T = placement(place.at[0], place.at[1], { angle: place.rot ?? 0, mirror: bottom, spin: false });
  const center = apply(T, pad.at[0], pad.at[1]);
  if (pad.smd) {
    const onBottom = (pad.side === 'bottom') !== bottom;
    const [dx, dy] = pad.smd;
    // Test points in the pad's own frame: undo placement and pad rotation.
    const Tp = placement(0, 0, { angle: pad.rot ?? 0, mirror: false, spin: false });
    const toLocal = (p: Point) => {
      const q = unapply(T, p);
      const r = unapply(Tp, { x: q.x - pad.at[0], y: q.y - pad.at[1] });
      return r;
    };
    return {
      kind: 'pad', ref, center, points: [center], reach: Math.max(dx, dy) / 2,
      layers: new Set([onBottom ? 'copper.bottom' : 'copper.top']),
      hit: (p) => {
        const r = toLocal(p);
        return Math.abs(r.x) <= dx / 2 + EPS && Math.abs(r.y) <= dy / 2 + EPS;
      },
    };
  }
  const drill = pad.drill ?? 0;
  const radius = Math.max(pad.diameter ?? 0, drill * 1.5) / 2;
  return {
    kind: 'pad', ref, center, points: [center], reach: radius,
    layers: new Set(stack),
    hit: (p) => Math.hypot(p.x - center.x, p.y - center.y) <= radius + EPS,
  };
}

function viaLayers(span: string, stack: string[]): Set<string> {
  const m = /^(\d+)-(\d+)$/.exec(span);
  if (!m) return new Set(stack);
  const lo = Math.min(Number(m[1]), Number(m[2]));
  const hi = Math.max(Number(m[1]), Number(m[2]));
  const number = (name: string) => (name === 'copper.top' ? 1 : name === 'copper.bottom' ? 16 : Number(name.replace('copper.in', '')) + 1);
  return new Set(stack.filter((l) => number(l) >= lo && number(l) <= hi));
}

// ---------------------------------------------------------------------------
// Connecting

function connect(net: Net, nodes: CopperNode[], stack: string[], fills: Map<PolygonShape, PourFill>): Airwire[] {
  if (nodes.length < 2) return [];
  const islands = (net.pours ?? []).flatMap((pour) => (stack.includes(pour.layer) ? (fills.get(pour)?.islands ?? []).map((isl) => ({ isl, layer: pour.layer })) : []));
  const uf = new UnionFind(nodes.length + (net.pours?.length ?? 0) + islands.length);
  const shares = (a: CopperNode, b: CopperNode) => [...a.layers].some((l) => b.layers.has(l));

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (shares(a, b) && touches(a, b)) uf.union(i, j);
    }
  }

  // Pours connect the net's copper their poured islands reach (on the pour's layer): each
  // island separately. A pour whose fill isn't known counts as its whole outline.
  const base = nodes.length + (net.pours?.length ?? 0);
  islands.forEach(({ isl, layer }, k) => {
    nodes.forEach((n, i) => {
      if (n.layers.has(layer) && isl.reaches.has(n.ref)) uf.union(i, base + k);
    });
  });
  (net.pours ?? []).forEach((pour, k) => {
    if (!stack.includes(pour.layer) || fills.has(pour)) return;
    const poly = pour.polygon.map((p: PolyPt) => ({ x: p[0], y: p[1] }));
    const pourId = nodes.length + k;
    nodes.forEach((n, i) => {
      if (!n.layers.has(pour.layer)) return;
      if (n.points.some((p) => pointInPolygon(p, poly))) uf.union(i, pourId);
    });
  });

  // Groups of connected copper, with the points airwires may attach to.
  const groups = new Map<number, Point[]>();
  nodes.forEach((n, i) => {
    const root = uf.find(i);
    groups.set(root, [...(groups.get(root) ?? []), ...n.points]);
  });
  return spanningTree(net.name, [...groups.values()]);
}

function touches(a: CopperNode, b: CopperNode): boolean {
  if (a.kind === 'trace' && b.kind === 'trace') {
    if (a.layer !== b.layer) return false;
    // End on end, or an end on the other trace (copper overlaps).
    return segDist(a.a, b) <= b.halfWidth + EPS || segDist(a.b, b) <= b.halfWidth + EPS ||
      segDist(b.a, a) <= a.halfWidth + EPS || segDist(b.b, a) <= a.halfWidth + EPS;
  }
  if (a.kind === 'trace' || b.kind === 'trace') {
    const t = (a.kind === 'trace' ? a : b) as TraceNode;
    const o = (a.kind === 'trace' ? b : a) as PadNode | ViaNode;
    if (o.kind === 'via') return segDist(o.center, t) <= o.radius + t.halfWidth + EPS;
    // A trace end inside the pad, or the trace running over the pad's centre.
    return o.hit(t.a) || o.hit(t.b) || segDist(o.center, t) <= t.halfWidth + EPS;
  }
  // Overlapping pads aren't connected (Eagle draws an airwire between them): pads join
  // only through traces, vias and pours. A via on a pad does connect to it.
  if (a.kind === 'pad' && b.kind === 'pad') return false;
  const ra = a.kind === 'via' ? a.radius : a.reach;
  const rb = b.kind === 'via' ? b.radius : b.reach;
  return Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <= ra + rb + EPS;
}

/** Minimum spanning tree between groups (Prim), each edge the closest pair of their points. */
function spanningTree(net: string, groups: Point[][]): Airwire[] {
  if (groups.length < 2) return [];
  const inTree = new Array(groups.length).fill(false);
  const best = new Array(groups.length).fill(Infinity);
  const link: ([Point, Point] | undefined)[] = new Array(groups.length).fill(undefined);
  inTree[0] = true;
  const relax = (from: number) => {
    for (let g = 0; g < groups.length; g++) {
      if (inTree[g]) continue;
      const [d, pair] = closest(groups[from]!, groups[g]!);
      if (d < best[g]) {
        best[g] = d;
        link[g] = pair;
      }
    }
  };
  relax(0);
  const out: Airwire[] = [];
  for (let added = 1; added < groups.length; added++) {
    let next = -1;
    for (let g = 0; g < groups.length; g++) if (!inTree[g] && (next < 0 || best[g] < best[next])) next = g;
    inTree[next] = true;
    // Deterministic output: coordinates to 1 nm (as in the file), ends ordered by x, then y.
    const [p, q] = link[next]!.map((v) => ({ x: round(v.x), y: round(v.y) })) as [Point, Point];
    const [from, to] = p.x < q.x || (p.x === q.x && p.y <= q.y) ? [p, q] : [q, p];
    out.push({ net, from: [from.x, from.y], to: [to.x, to.y] });
    relax(next);
  }
  return out;
}

function closest(a: Point[], b: Point[]): [number, [Point, Point]] {
  let d = Infinity;
  let pair: [Point, Point] = [a[0]!, b[0]!];
  for (const p of a) {
    for (const q of b) {
      const e = Math.hypot(p.x - q.x, p.y - q.y);
      if (e < d) {
        d = e;
        pair = [p, q];
      }
    }
  }
  return [d, pair];
}

// ---------------------------------------------------------------------------
// Geometry helpers

const pt = (p: Pt): Point => ({ x: p[0], y: p[1] });
const round = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

function segDist(p: Point, s: { a: Point; b: Point }): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
  return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy));
}

function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Inverse of an affine transform applied to a point. */
function unapply(t: ReturnType<typeof placement>, p: Point): Point {
  const det = t.a * t.d - t.b * t.c;
  const x = p.x - t.e;
  const y = p.y - t.f;
  return { x: (t.d * x - t.c * y) / det, y: (-t.b * x + t.a * y) / det };
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}
