// Poured copper: what a net's polygon pour actually fills, as Eagle computes it.
//
// For each pour, on its layer, in rank order (rank 1 first):
// 1. Start from the pour's outline (arcs flattened), within the board outline less the pour's
//    isolate.
// 2. Cut out other nets' copper (pads, SMDs, vias, traces, and the fills of pours of lower rank
//    number) and holes, each grown by the pour's isolate; cut out cutout polygons and keep-out
//    areas (restrict layers).
//
// The isolate is the one gap a pour keeps, whatever the design rules say (unlike Eagle, which
// takes the larger of it and the clearance rules, and the copper-to-edge rule at the edge):
// 10 mil unless the pour sets it.
// 3. Thermals: the net's own pads (and vias, if the rules say so) get a gap of the thermal
//    isolate, crossed by four spokes along the pad's axes; with thermals off they connect fully.
// 4. The copper reaches half the pour's width beyond its outline. (Eagle also removes copper
//    narrower than the width; that isn't done here.)
// 5. Islands that touch none of the net's copper are dropped (unless orphans are kept).
//
// Hatched pours are filled solid (the hatch pattern isn't drawn yet).
//
// Geometry runs in integer units of 0.1 µm (Clipper2).

import { Clipper64, ClipType, FillRule, Path64, Paths64, Point64 } from 'clipper2-js';
import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point } from '../geom/transform';
import { apply } from '../geom/transform';
import { footprintTransform, mirrorLayer } from './geometry';
import { collect, dimension, type Item, type Shape } from './copper';
import { ProjectIndex } from './derive';
import { designRules, DesignRules } from './rules';
import type * as O from './types';

/** A pour's gap to other nets' copper, the board edge and holes when it doesn't set one: 10 mil. */
export const DEFAULT_POUR_ISOLATE = 0.254;

/** The gap a pour keeps to other nets' copper, the board edge and holes (mm). */
export function pourIsolate(pour: O.PolygonShape): number {
  return pour.isolate && pour.isolate > 0 ? pour.isolate : DEFAULT_POUR_ISOLATE;
}

/** Integer units per mm. */
const S = 10_000;
/** Maximum deviation of round edges from true arcs (mm). */
const ARC_TOLERANCE = 0.005;
/** Added to every clearance so integer rounding never leaves copper a hair too close (mm). */
const MARGIN = 0.0005;

export interface Island {
  outer: O.Pt[];
  holes: O.Pt[][];
  /** The net's copper on this layer the island reaches: "part\0pad" for pads, via and trace objects. */
  reaches: Set<string | object>;
}

export interface PourFill {
  net: string;
  pour: O.PolygonShape;
  layer: string;
  islands: Island[];
}

const cache = new WeakMap<O.Project, { key: string; fills: Map<O.PolygonShape, PourFill> }>();
const frozen = new WeakSet<O.Project>();

/**
 * While frozen (e.g. during a drag, when the model changes on every mouse move), the last fills
 * are reused instead of being recomputed; unfreezing brings them up to date on the next use.
 */
export function freezePours(project: O.Project, on: boolean): void {
  if (on) frozen.add(project);
  else frozen.delete(project);
}

/**
 * The fill of every pour of the board, by pour. Results are cached per project until its copper,
 * parts or rules change.
 */
export function pourFills(project: O.Project, index?: ProjectIndex): Map<O.PolygonShape, PourFill> {
  if (!project.board || !project.nets.some((n) => n.pours?.length)) return new Map();
  const hit = cache.get(project);
  if (hit && frozen.has(project)) return hit.fills;
  const key = fingerprint(project);
  if (hit && hit.key === key) return hit.fills;
  const fills = computePours(project, index ?? new ProjectIndex(project));
  cache.set(project, { key, fills });
  return fills;
}

/** What pour fills depend on: copper, footprints, parts and the rules. */
function fingerprint(project: O.Project): string {
  return JSON.stringify([
    project.nets.map((n) => [n.name, n.traces, n.vias, n.pours, n.segments?.map((s) => s.pins), n.pads]),
    project.board!.footprints,
    project.board!.drawing,
    project.parts,
    [...designRules(project)],
  ]);
}

// ---------------------------------------------------------------------------

const P = (x: number, y: number) => new Point64(Math.round(x * S), Math.round(y * S));

function path(pts: Point[]): Path64 {
  const p = new Path64();
  for (const q of pts) p.push(P(q.x, q.y));
  return p;
}

function paths(...ps: Path64[]): Paths64 {
  const out = new Paths64();
  for (const p of ps) out.push(p);
  return out;
}

function clip(type: ClipType, subject: Paths64, clipPaths: Paths64): Paths64 {
  const c = new Clipper64();
  c.addSubjectPaths(subject);
  if (clipPaths.length) c.addClipPaths(clipPaths);
  const out = new Paths64();
  c.execute(type, FillRule.NonZero, out);
  return out;
}

/**
 * Grow polygons (with holes, Clipper-oriented) by `mm`, with round corners: the polygons plus
 * every edge grown into a rounded strip. (Clipper2-js's own offsetting is wrong for shrinking,
 * so it isn't used.)
 */
function inflate(ps: Paths64, mm: number): Paths64 {
  if (!ps.length || mm <= 0) return ps;
  const strips = new Paths64();
  for (const p of ps) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      strips.push(grown({ t: 'cap', a: { x: a.x / S, y: a.y / S }, b: { x: b.x / S, y: b.y / S }, r: 0 }, mm));
    }
  }
  return clip(ClipType.Union, ps, strips);
}

/** Shrink polygons by `mm`: remove everything within that distance of their edges. */
function deflate(ps: Paths64, mm: number): Paths64 {
  if (!ps.length || mm <= 0) return ps;
  const strips = new Paths64();
  for (const p of ps) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      strips.push(grown({ t: 'cap', a: { x: a.x / S, y: a.y / S }, b: { x: b.x / S, y: b.y / S }, r: 0 }, mm));
    }
  }
  return clip(ClipType.Difference, ps, strips);
}

/** Steps for a full circle of radius r within the arc tolerance. */
function circleSteps(r: number): number {
  if (r <= ARC_TOLERANCE) return 8;
  return Math.max(8, Math.ceil(Math.PI / Math.acos(1 - ARC_TOLERANCE / r)));
}

/**
 * A shape (segment or convex polygon grown by its radius) grown by `extra` mm more, as a polygon:
 * the core's edges pushed out, joined by arcs around its corners. Arcs are drawn just outside the
 * true circle (their chords touch it), so a cut-out is never smaller than the clearance asks.
 */
function grown(s: Shape, extra: number): Path64 {
  const R = s.r + extra + MARGIN;
  let core: Point[] = s.t === 'cap' ? (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 1e-9 ? [s.a] : [s.a, s.b]) : s.pts;
  // Counter-clockwise.
  if (core.length >= 3) {
    let area = 0;
    for (let i = 0; i < core.length; i++) {
      const a = core[i]!;
      const b = core[(i + 1) % core.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) core = [...core].reverse();
  }
  if (R <= 0) return path(core.length >= 3 ? core : []);
  const n = core.length;
  if (n === 1) {
    const steps = circleSteps(R);
    const Ro = R / Math.cos(Math.PI / steps);
    return path(Array.from({ length: steps }, (_, i) => ({ x: core[0]!.x + Ro * Math.cos((2 * Math.PI * i) / steps), y: core[0]!.y + Ro * Math.sin((2 * Math.PI * i) / steps) })));
  }
  // Outward normal angle of edge i (from core[i] to core[i+1]) for a counter-clockwise loop;
  // a segment is the loop a → b → a.
  const normal = (i: number) => {
    const a = core[i]!;
    const b = core[(i + 1) % n]!;
    return Math.atan2(-(b.x - a.x), b.y - a.y);
  };
  const out: Point[] = [];
  const steps = circleSteps(R);
  for (let i = 0; i < n; i++) {
    const v = core[i]!;
    let a0 = normal((i - 1 + n) % n);
    let a1 = normal(i);
    while (a1 < a0) a1 += 2 * Math.PI;
    const k = Math.max(1, Math.ceil(((a1 - a0) / (2 * Math.PI)) * steps));
    // Ends on the edges' offset lines (radius R); points between at R / cos(half a step).
    const Ro = R / Math.cos((a1 - a0) / k / 2);
    out.push({ x: v.x + R * Math.cos(a0), y: v.y + R * Math.sin(a0) });
    for (let j = 0; j < k; j++) {
      const t = a0 + ((a1 - a0) * (j + 0.5)) / k;
      out.push({ x: v.x + Ro * Math.cos(t), y: v.y + Ro * Math.sin(t) });
    }
    out.push({ x: v.x + R * Math.cos(a1), y: v.y + R * Math.sin(a1) });
  }
  return path(out);
}

/** A pour's outline as points, arcs flattened. */
function outline(poly: O.PolygonShape): Point[] {
  const pts: Point[] = [];
  const n = poly.polygon.length;
  for (let i = 0; i < n; i++) {
    const [x, y, curve] = poly.polygon[i]!;
    const next = poly.polygon[(i + 1) % n]!;
    pts.push({ x, y });
    if (curve) {
      const arc = arcFromChord({ x, y }, { x: next[0], y: next[1] }, curve);
      const seg = arcPoints(arc, Math.max(4, Math.ceil(Math.abs(curve) / 5)));
      pts.push(...seg.slice(1, -1));
    }
  }
  return pts;
}

/** Outline ends this close count as joined when finding the board's area (the DRC reports them as open). */
const OUTLINE_JOIN = 0.05;

/**
 * The board's area from its outline: closed loops chained from the outline segments (inner
 * loops are cutouts). Ends a hair apart (within OUTLINE_JOIN) still join, so a slightly open
 * corner doesn't lose the pour's inset from the edge.
 */
function boardArea(board: O.Board): Paths64 | undefined {
  const segs: [Point, Point][] = [];
  for (const d of dimension(board)) {
    for (const s of d.shapes) if (s.t === 'cap' && (s.a.x !== s.b.x || s.a.y !== s.b.y)) segs.push([s.a, s.b]);
  }
  if (segs.length < 3) return undefined;
  const near = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) < OUTLINE_JOIN;
  const used = new Array<boolean>(segs.length).fill(false);
  const loops: Path64[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop: Point[] = [segs[i]![0], segs[i]![1]];
    for (;;) {
      const end = loop[loop.length - 1]!;
      if (loop.length > 2 && near(end, loop[0]!)) break;
      const j = segs.findIndex((s, k) => !used[k] && (near(s[0], end) || near(s[1], end)));
      if (j < 0) break;
      used[j] = true;
      loop.push(near(segs[j]![0], end) ? segs[j]![1] : segs[j]![0]);
    }
    if (loop.length > 3 && near(loop[loop.length - 1]!, loop[0]!)) loops.push(path(loop.slice(0, -1)));
  }
  if (!loops.length) return undefined;
  const c = new Clipper64();
  c.addSubjectPaths(paths(...loops));
  const out = new Paths64();
  c.execute(ClipType.Union, FillRule.EvenOdd, out);
  return out;
}

/**
 * Copper keep-out areas by copper layer: shapes on restrict.top / restrict.bottom, on the board
 * and in footprints (a bottom-side footprint's keep-out moves to the bottom).
 */
function keepOuts(board: O.Board, index: ProjectIndex): Map<string, Paths64> {
  const out = new Map<string, Paths64>();
  const COPPER: Record<string, string> = { 'restrict.top': 'copper.top', 'restrict.bottom': 'copper.bottom' };
  const add = (g: O.Graphic, layer: string, f: (p: Point) => Point) => {
    const copper = COPPER[layer];
    if (!copper) return;
    let list = out.get(copper);
    if (!list) out.set(copper, (list = new Paths64()));
    const at = (x: number, y: number) => f({ x, y });
    if ('rect' in g) {
      const [[x1, y1], [x2, y2]] = g.rect;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const a = ((g.rot ?? 0) * Math.PI) / 180;
      const corner = (dx: number, dy: number) => at(cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a));
      const hx = Math.abs(x2 - x1) / 2;
      const hy = Math.abs(y2 - y1) / 2;
      list.push(path([corner(-hx, -hy), corner(hx, -hy), corner(hx, hy), corner(-hx, hy)]));
    } else if ('polygon' in g) {
      list.push(...inflate(clip(ClipType.Union, paths(path(outline(g).map((p) => at(p.x, p.y)))), new Paths64()), g.width / 2));
    } else if ('circle' in g) {
      const c = at(g.circle[0], g.circle[1]);
      list.push(grown({ t: 'cap', a: c, b: c, r: 0 }, g.radius + g.width / 2));
    } else if ('line' in g) {
      const a = at(g.line[0][0], g.line[0][1]);
      const b = at(g.line[1][0], g.line[1][1]);
      list.push(grown({ t: 'cap', a, b, r: 0 }, g.width / 2));
    }
  };
  for (const g of board.drawing) if ('layer' in g) add(g, g.layer, (p) => p);
  for (const fp of board.footprints) {
    const part = index.parts.get(fp.part);
    const footprint = part && index.footprints.get(index.variantOf(part)?.footprint ?? '');
    if (!footprint) continue;
    const T = footprintTransform(fp);
    for (const g of footprint.graphics) {
      if (!('layer' in g)) continue;
      add(g, fp.side === 'bottom' ? mirrorLayer(g.layer) : g.layer, (p) => apply(T, p.x, p.y));
    }
  }
  return out;
}

/** Fills of all pours. */
export function computePours(project: O.Project, index = new ProjectIndex(project)): Map<O.PolygonShape, PourFill> {
  const board = project.board!;
  const rules = new DesignRules(designRules(project));
  const items = collect(project, rules, index);
  const area = boardArea(board);
  const holes = board.drawing.flatMap((g) => ('hole' in g ? [g] : []));
  const keepouts = keepOuts(board, index);
  const out = new Map<O.PolygonShape, PourFill>();

  const pours: { net: string; pour: O.PolygonShape }[] = [];
  for (const net of project.nets) for (const pour of net.pours ?? []) pours.push({ net: net.name, pour });
  pours.sort((a, b) => (a.pour.rank ?? 1) - (b.pour.rank ?? 1));
  const filled: { net: string; rank: number; layer: string; copper: Paths64 }[] = [];

  for (const { net, pour } of pours) {
    const layer = pour.layer;
    const w = pour.width;
    const half = w / 2;
    const rank = pour.rank ?? 1;
    const iso = pourIsolate(pour);

    // 1. The pour's copper extends half its width beyond the outline's centre line, and stays
    //    the isolate inside the board.
    let room = inflate(clip(ClipType.Union, paths(path(outline(pour))), new Paths64()), half);
    if (area) room = clip(ClipType.Intersection, room, deflate(area, iso));

    // 2. Cut-outs: other nets' copper (grown by the isolation), holes, cutouts, and fills of
    //    other nets' pours of lower rank number.
    const cut = new Paths64();
    for (const it of items) {
      if (it.net === net || !it.layers.has(layer)) continue;
      for (const s of it.shapes) cut.push(grown(s, iso));
    }
    for (const h of holes) cut.push(grown({ t: 'cap', a: { x: h.hole[0], y: h.hole[1] }, b: { x: h.hole[0], y: h.hole[1] }, r: h.drill / 2 }, iso));
    for (const g of board.drawing) {
      if ('polygon' in g && g.pour === 'cutout' && g.layer === layer) cut.push(...inflate(clip(ClipType.Union, paths(path(outline(g))), new Paths64()), g.width / 2));
    }
    cut.push(...keepouts.get(layer) ?? []);
    for (const f of filled) {
      if (f.layer === layer && f.net !== net && f.rank < rank) cut.push(...inflate(f.copper, iso));
    }

    // 3. Thermals: the net's own pads (and vias, by the rules) get a gap of the thermal
    //    isolate around them, crossed by four spokes of the pour's width along the pad's axes.
    //    The gap is cut with the spokes taken out of it, so one difference makes both.
    if (pour.thermals !== false) {
      for (const it of items) {
        if (it.net !== net || !it.layers.has(layer)) continue;
        if (!(it.kind === 'pad' || it.kind === 'smd' || (it.kind === 'via' && rules.thermalsForVias))) continue;
        const gap = paths(...it.shapes.map((s) => grown(s, rules.thermalIsolate)));
        if (!it.center || !it.axes) {
          cut.push(...gap);
          continue;
        }
        const reach = Math.max(it.box.maxX - it.box.minX, it.box.maxY - it.box.minY) / 2 + rules.thermalIsolate + w;
        const spokes = new Paths64();
        for (const [ax, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]] as const) {
          const d = it.axes[ax]!;
          spokes.push(grown({ t: 'cap', a: it.center, b: { x: it.center.x + d.x * reach * sign, y: it.center.y + d.y * reach * sign }, r: 0 }, half));
        }
        cut.push(...clip(ClipType.Difference, gap, spokes));
      }
    }

    // 4. The copper: one difference.
    const copper = cut.length ? clip(ClipType.Difference, room, cut) : room;

    // 5. Islands; drop orphans.
    const islands = toIslands(copper);
    const own = items.filter((it) => it.net === net && it.layers.has(layer));
    for (const isl of islands) for (const it of own) if (touches(isl, it)) isl.reaches.add(it.ref);
    const kept = pour.orphans ? islands : islands.filter((isl) => isl.reaches.size > 0);
    const keptPaths = new Paths64();
    for (const isl of kept) {
      keptPaths.push(path(isl.outer.map(([x, y]) => ({ x, y }))));
      for (const h of isl.holes) keptPaths.push(path(h.map(([x, y]) => ({ x, y }))));
    }
    filled.push({ net, rank, layer, copper: keptPaths });
    out.set(pour, { net, pour, layer, islands: kept });
  }
  return out;
}

/**
 * Polygons with holes from a fill (a Clipper result: outer rings counter-clockwise, holes
 * clockwise); each hole belongs to the smallest outer ring around it. (Islands inside holes are
 * outer rings of their own.) Clipper's PolyTree output isn't used: it fails silently here.
 */
function toIslands(ps: Paths64): Island[] {
  const rings = ps.map((p) => {
    const pts = p.map((q) => [q.x / S, q.y / S] as O.Pt);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      a += x1 * y2 - x2 * y1;
    }
    return { pts, area: a / 2 };
  });
  const outers = rings.filter((r) => r.area > 0).sort((a, b) => a.area - b.area);
  const islands = outers.map((r) => ({ outer: r.pts, holes: [] as O.Pt[][], area: r.area, reaches: new Set<string | object>() }));
  for (const hole of rings.filter((r) => r.area < 0)) {
    const [x, y] = hole.pts[0]!;
    const owner = islands.find((isl) => isl.area >= -hole.area && evenOdd(isl.outer.map(([u, v]) => ({ x: u, y: v })), { x, y }));
    owner?.holes.push(hole.pts);
  }
  return islands.map(({ outer, holes, reaches }) => ({ outer, holes, reaches }));
}

/** Is a point inside an island's copper (inside the outer ring, outside its holes)? */
export function inIsland(isl: Island, p: Point): boolean {
  const ring = (r: O.Pt[]) => r.map(([x, y]) => ({ x, y }));
  return evenOdd(ring(isl.outer), p) && !isl.holes.some((h) => evenOdd(ring(h), p));
}

function evenOdd(poly: Point[], p: Point): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Does an island reach the item's copper? Quick tests first (its centre or a core point inside
 * the island), then the exact one: the island and the item's copper overlap.
 */
function touches(isl: Island, it: Item): boolean {
  const xs = isl.outer.map((p) => p[0]);
  const ys = isl.outer.map((p) => p[1]);
  if (it.box.maxX < Math.min(...xs) || it.box.minX > Math.max(...xs) || it.box.maxY < Math.min(...ys) || it.box.minY > Math.max(...ys)) return false;
  const probes: Point[] = [];
  if (it.center) probes.push(it.center);
  for (const s of it.shapes) {
    if (s.t === 'cap') probes.push(s.a, s.b, { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 });
    else probes.push(...s.pts);
  }
  if (probes.some((p) => inIsland(isl, p))) return true;
  const island = paths(path(isl.outer.map(([x, y]) => ({ x, y }))), ...isl.holes.map((h) => path(h.map(([x, y]) => ({ x, y })))));
  const copper = paths(...it.shapes.map((sh) => grown(sh, 0)));
  return clip(ClipType.Intersection, island, copper).length > 0;
}
