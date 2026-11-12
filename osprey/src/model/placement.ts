// Board placement as geometry: each footprint's area and pads (with their nets), what's wrong
// with a placement (parts overlapping each other, the mounting holes or the board edge), and how
// good it is (airwire length and crossings, decoupling, the board area the parts need, rows and columns).
//
// A footprint's area is the box around its pads and its body as drawn on the silkscreen, fab
// (Eagle's tDocu), keep-out and restrict layers; names and values aren't part of it. Boxes are
// axis-aligned in board coordinates, like a courtyard.

import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point, Transform } from '../geom/transform';
import { apply, compose, placement } from '../geom/transform';
import { padShapes, transformShape } from './copper';
import { netPads, ProjectIndex, supplySource } from './derive';
import { designRules, footprintTransform } from './geometry';
import { ratsnest } from './ratsnest';
import { DesignRules } from './rules';
import type * as O from './types';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PadInfo {
  name: string;
  /** The pad's net, if it has one. */
  net?: string;
  /** Centre (board coordinates). */
  at: Point;
  /** Copper box (board coordinates). */
  box: Rect;
  /** The pad is a power pin of its part (e.g. an IC's VCC or GND). */
  power?: true;
}

export interface FootprintInfo {
  part: string;
  placement: O.FootprintPlacement;
  /** Pads and body (board coordinates). */
  box: Rect;
  pads: PadInfo[];
  /** Copper layer the pads are on: SMD parts are on their side; through-hole parts on both. */
  smd: boolean;
}

/** Layers that show a footprint's body. */
const BODY_LAYERS = new Set([
  'silk.top', 'silk.bottom', 'fab.top', 'fab.bottom', 'keepout.top', 'keepout.bottom',
  'restrict.top', 'restrict.bottom', 'restrict.vias',
]);

const empty = (): Rect => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
function extend(r: Rect, x: number, y: number, grow = 0): void {
  r.minX = Math.min(r.minX, x - grow);
  r.minY = Math.min(r.minY, y - grow);
  r.maxX = Math.max(r.maxX, x + grow);
  r.maxY = Math.max(r.maxY, y + grow);
}

export const rectWidth = (r: Rect) => r.maxX - r.minX;
export const rectHeight = (r: Rect) => r.maxY - r.minY;
export const rectCenter = (r: Rect): Point => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

/** Gap between two boxes (negative when they overlap: the smaller of the two overlaps). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY);
  return dx < 0 && dy < 0 ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

/** The nets of every pad, as "part\0pad" → net. */
function padNets(project: O.Project, index: ProjectIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const [net, keys] of netPads(project, index)) for (const k of keys) out.set(k, net);
  return out;
}

/**
 * Geometry of a part's footprint, where it is or (with `at`, `rot`, `side`) where it would be.
 * Undefined for parts without a footprint on the board.
 */
export function footprintInfo(
  project: O.Project, part: string,
  where: { at?: O.Pt; rot?: number; side?: 'top' | 'bottom' } = {},
  index = new ProjectIndex(project), nets = padNets(project, index), rules = new DesignRules(designRules(project)),
): FootprintInfo | undefined {
  const placed = project.board?.footprints.find((f) => f.part === part);
  const p = index.parts.get(part);
  const fpId = p && index.variantOf(p)?.footprint;
  const fp = fpId ? index.footprints.get(fpId) : undefined;
  if (!placed || !fp) return undefined;
  const f: O.FootprintPlacement = { ...placed, ...(where.at ? { at: where.at } : {}) };
  if (where.rot !== undefined) f.rot = where.rot;
  if (where.side !== undefined) {
    if (where.side === 'bottom') f.side = 'bottom';
    else delete f.side;
  }
  // Pads of power pins.
  const powerPads = new Set<string>();
  const variant = index.variantOf(p!);
  for (const gate of index.components.get(p!.component)?.gates ?? []) {
    for (const pin of index.symbols.get(gate.symbol)?.pins ?? []) {
      if (pin.direction !== 'power' && pin.direction !== 'supply') continue;
      for (const pad of variant?.pads[`${gate.name}.${pin.name}`] ?? []) powerPads.add(pad);
    }
  }
  const T = footprintTransform(f);
  const box = empty();
  const pads: PadInfo[] = [];
  for (const pad of fp.pads) {
    const PT: Transform = compose(T, placement(pad.at[0], pad.at[1], { angle: pad.rot ?? 0, mirror: false, spin: false }));
    const pb = empty();
    for (const s of padShapes(pad, rules).map((sh) => transformShape(sh, (q) => apply(PT, q.x, q.y)))) {
      for (const q of s.t === 'cap' ? [s.a, s.b] : s.pts) extend(pb, q.x, q.y, s.r);
    }
    extend(box, pb.minX, pb.minY);
    extend(box, pb.maxX, pb.maxY);
    const net = nets.get(`${part}\u0000${pad.name}`);
    pads.push({ name: pad.name, ...(net ? { net } : {}), at: apply(PT, 0, 0), box: pb, ...(powerPads.has(pad.name) ? { power: true as const } : {}) });
  }
  for (const g of fp.graphics) bodyExtent(g, T, box);
  return { part, placement: placed, box, pads, smd: fp.pads.every((q) => !!q.smd) };
}

function bodyExtent(g: O.Graphic, T: Transform, box: Rect): void {
  const at = (x: number, y: number, grow = 0) => {
    const q = apply(T, x, y);
    extend(box, q.x, q.y, grow);
  };
  if ('hole' in g) return at(g.hole[0], g.hole[1], g.drill / 2);
  if (!('layer' in g) || !BODY_LAYERS.has(g.layer)) return;
  if ('line' in g) {
    const [a, b] = g.line;
    if (g.curve) {
      for (const q of arcPoints(arcFromChord({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, g.curve), 16)) at(q.x, q.y, g.width / 2);
    } else {
      at(a[0], a[1], g.width / 2);
      at(b[0], b[1], g.width / 2);
    }
  } else if ('circle' in g) {
    const r = g.radius + g.width / 2;
    for (let k = 0; k < 16; k++) at(g.circle[0] + r * Math.cos((k * Math.PI) / 8), g.circle[1] + r * Math.sin((k * Math.PI) / 8));
  } else if ('rect' in g) {
    const [[x1, y1], [x2, y2]] = g.rect;
    const R = compose(T, placement((x1 + x2) / 2, (y1 + y2) / 2, { angle: g.rot ?? 0, mirror: false, spin: false }));
    const hw = Math.abs(x2 - x1) / 2;
    const hh = Math.abs(y2 - y1) / 2;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
      const q = apply(R, x, y);
      extend(box, q.x, q.y);
    }
  } else if ('polygon' in g) {
    for (const [x, y] of g.polygon) at(x, y, g.width / 2);
  }
}

/** Every footprint on the board. */
export function footprintInfos(project: O.Project, index = new ProjectIndex(project)): FootprintInfo[] {
  const nets = padNets(project, index);
  const rules = new DesignRules(designRules(project));
  const out: FootprintInfo[] = [];
  for (const f of project.board?.footprints ?? []) {
    const info = footprintInfo(project, f.part, {}, index, nets, rules);
    if (info) out.push(info);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The board

export interface BoardArea {
  /** The box around the board outline. */
  outline: Rect;
  /** Board holes (mounting holes), as boxes. */
  holes: Rect[];
}

export function boardArea(board: O.Board): BoardArea | undefined {
  const outline = empty();
  const holes: Rect[] = [];
  for (const g of board.drawing) {
    if ('line' in g && g.layer === 'outline') for (const [x, y] of g.line) extend(outline, x, y);
    else if ('circle' in g && g.layer === 'outline') extend(outline, g.circle[0], g.circle[1], g.radius);
    else if ('hole' in g) {
      const r = empty();
      extend(r, g.hole[0], g.hole[1], g.drill / 2);
      holes.push(r);
    }
  }
  return Number.isFinite(outline.minX) ? { outline, holes } : undefined;
}

// ---------------------------------------------------------------------------
// Problems

export interface PlacementRules {
  /** Space to keep between two through-hole parts (mm). */
  clearance: number;
  /** Space to keep when either part is SMD (mm): SMD parts can sit closer. */
  smdClearance: number;
  /** Space to keep between parts and the board edge or holes (mm). */
  edge: number;
}

export const DEFAULT_PLACEMENT_RULES: PlacementRules = { clearance: 0.25, smdClearance: 0.15, edge: 0.5 };

/** The space to keep between two parts. */
export const partClearance = (rules: PlacementRules, a: { smd: boolean }, b: { smd: boolean }) =>
  a.smd || b.smd ? rules.smdClearance : rules.clearance;

/** Shortfalls smaller than this (mm) don't count: positions are rounded to 0.01 mm. */
export const TOLERANCE = 0.005;

export type PlacementIssue =
  | { kind: 'overlap'; parts: [string, string]; gap: number }
  | { kind: 'hole'; part: string; gap: number }
  | { kind: 'edge'; part: string; gap: number };

/**
 * Parts closer than the clearance to each other, or than the edge distance to a hole or the
 * board edge (or over it). Parts parked off the board, not touching it, are ignored.
 */
export function placementIssues(project: O.Project, rules = DEFAULT_PLACEMENT_RULES, infos = footprintInfos(project)): PlacementIssue[] {
  const area = project.board && boardArea(project.board);
  if (!area) return [];
  const on = infos.filter((f) => onBoard(f.box, area.outline));
  const out: PlacementIssue[] = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i]!;
      const b = on[j]!;
      // A top SMD part and a bottom SMD part don't collide.
      if (a.smd && b.smd && (a.placement.side === 'bottom') !== (b.placement.side === 'bottom')) continue;
      const gap = rectGap(a.box, b.box);
      if (gap < partClearance(rules, a, b) - TOLERANCE) out.push({ kind: 'overlap', parts: [a.part, b.part], gap });
    }
  }
  for (const f of on) {
    for (const h of area.holes) {
      const gap = rectGap(f.box, h);
      if (gap < rules.edge - TOLERANCE) out.push({ kind: 'hole', part: f.part, gap });
    }
    const o = area.outline;
    const gap = Math.min(f.box.minX - o.minX, f.box.minY - o.minY, o.maxX - f.box.maxX, o.maxY - f.box.maxY);
    if (gap < rules.edge - TOLERANCE) out.push({ kind: 'edge', part: f.part, gap });
  }
  return out;
}

/**
 * Is a part on the board, rather than parked beside it? Any part touching the board counts, so
 * one that sticks out over the edge is a problem, not a parked part.
 */
export function onBoard(box: Rect, outline: Rect): boolean {
  return box.maxX > outline.minX && box.minX < outline.maxX && box.maxY > outline.minY && box.minY < outline.maxY;
}

// ---------------------------------------------------------------------------
// Measures

export interface Decoupling {
  /** The capacitor. */
  part: string;
  /** Its supply net, and the nearest IC pad on that net. */
  net: string;
  ic: string;
  pad: string;
  /** Distance from the capacitor's supply pad to that IC pad (mm). */
  distance: number;
}

export interface PlacementMetrics {
  airwires: number;
  /** Total airwire length (mm). */
  length: number;
  /** Pairs of airwires that cross. */
  crossings: number;
  /**
   * The same without supply nets (ground, VCC, …), which pours, planes or a few wide traces
   * connect wherever the parts are: what placement should shorten and untangle.
   */
  signalLength: number;
  signalCrossings: number;
  decoupling: Decoupling[];
}

/** Ground nets, by name (GND, AGND, VSS, …). */
export const isGroundNet = (net: string) => GROUND.test(net);

/**
 * Supply nets: ground, and nets named by a supply symbol or by power pins (VCC, say). Placement
 * mostly leaves them aside: they only need a path to every power pin, which a pour, a plane or a
 * few wide traces give whatever the arrangement.
 */
export function supplyNets(project: O.Project, index = new ProjectIndex(project)): Set<string> {
  const out = new Set<string>();
  for (const n of project.nets) if (isGroundNet(n.name) || supplySource(project, n, index)) out.add(n.name);
  return out;
}

export function placementMetrics(project: O.Project, infos = footprintInfos(project), supplies = supplyNets(project)): PlacementMetrics {
  const air = ratsnest(project);
  const signal = (net: string) => !supplies.has(net) && !isGroundNet(net);
  let length = 0;
  let signalLength = 0;
  for (const a of air) {
    const l = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]);
    length += l;
    if (signal(a.net)) signalLength += l;
  }
  let crossings = 0;
  let signalCrossings = 0;
  for (let i = 0; i < air.length; i++) {
    for (let j = i + 1; j < air.length; j++) {
      if (!cross(air[i]!.from, air[i]!.to, air[j]!.from, air[j]!.to)) continue;
      crossings++;
      if (signal(air[i]!.net) && signal(air[j]!.net)) signalCrossings++;
    }
  }
  return { airwires: air.length, length, crossings, signalLength, signalCrossings, decoupling: decoupling(infos) };
}

// ---------------------------------------------------------------------------
// The score

/** What each thing costs, in mm of signal airwire. */
export const SCORE_WEIGHTS = {
  /** Per crossing of two signal airwires. */
  crossing: 3,
  /** Per mm from a decoupling capacitor to its IC power pin. */
  decoupling: 2,
  /** Per mm² of the box around all the parts: the board they need, which is what it costs. */
  area: 0.1,
  /** Per mm a part is off the nearest row or column line of a neighbour (see `misalignment`). */
  misalignment: 5,
};

/** Neighbours a part lines up with are within this distance (centre to centre, mm). */
const ALIGN_RADIUS = 8;
/** A part this far (mm) or more off every neighbour's lines counts as not lined up at all. */
const ALIGN_CAP = 1;

export interface PlacementScore {
  signalLength: number;
  signalCrossings: number;
  /** Sum of decoupling capacitors' distances to their IC power pins (mm). */
  decoupling: number;
  /** The box around all the parts on the board (mm²). */
  area: number;
  /** Sum over parts of how far each is off lining up with a neighbour (mm, see `misalignment`). */
  misalignment: number;
  /** All of it, weighted (SCORE_WEIGHTS): lower is better. */
  total: number;
}

/**
 * How good a placement is, as one number (lower is better) and its parts: short, untangled
 * signal airwires, decoupling caps at their pins, a small board, and parts in rows and columns.
 */
export function placementScore(project: O.Project, infos = footprintInfos(project)): PlacementScore {
  const area = project.board && boardArea(project.board);
  const on = area ? infos.filter((f) => onBoard(f.box, area.outline)) : infos;
  const m = placementMetrics(project, infos);
  const box = empty();
  for (const f of on) {
    extend(box, f.box.minX, f.box.minY);
    extend(box, f.box.maxX, f.box.maxY);
  }
  const s = {
    signalLength: m.signalLength,
    signalCrossings: m.signalCrossings,
    decoupling: m.decoupling.reduce((t, d) => t + d.distance, 0),
    area: on.length ? rectWidth(box) * rectHeight(box) : 0,
    misalignment: misalignment(on.map((f) => rectCenter(f.box))),
  };
  const w = SCORE_WEIGHTS;
  const total = s.signalLength + w.crossing * s.signalCrossings + w.decoupling * s.decoupling + w.area * s.area + w.misalignment * s.misalignment;
  return { ...s, total };
}

/**
 * How far parts are from rows and columns: for each part, the smallest offset in x or y between
 * its centre and a neighbour's (within ALIGN_RADIUS), capped at ALIGN_CAP, summed. Zero when
 * every part shares a centre line with some neighbour.
 */
export function misalignment(centers: Point[]): number {
  let sum = 0;
  centers.forEach((a, i) => {
    let best = ALIGN_CAP;
    centers.forEach((b, j) => {
      if (i === j || Math.hypot(a.x - b.x, a.y - b.y) > ALIGN_RADIUS) return;
      best = Math.min(best, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    });
    sum += best;
  });
  return sum;
}

/** Do segments ab and cd cross at a point that isn't an end of either? */
function cross(a: O.Pt, b: O.Pt, c: O.Pt, d: O.Pt): boolean {
  const o = (p: O.Pt, q: O.Pt, r: O.Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

const GROUND = /^(A|D|P)?GND\d*$|^VSS$|^0V$/i;

/**
 * Decoupling capacitors: two-pad parts named C… with one pad on a ground net and the other on a
 * net that reaches a power pin of another part (an IC's VCC, say). Measured to the nearest such
 * power pad.
 */
function decoupling(infos: FootprintInfo[]): Decoupling[] {
  const out: Decoupling[] = [];
  const ics = infos.filter((f) => f.pads.some((q) => q.power));
  for (const f of infos) {
    if (!/^C\d/.test(f.part) || f.pads.length !== 2) continue;
    const [p, q] = f.pads as [PadInfo, PadInfo];
    const supply = p.net && GROUND.test(p.net) ? q : q.net && GROUND.test(q.net) ? p : undefined;
    if (!supply?.net || GROUND.test(supply.net)) continue;
    let best: Decoupling | undefined;
    for (const ic of ics) {
      for (const pad of ic.pads) {
        if (!pad.power || pad.net !== supply.net || ic.part === f.part) continue;
        const distance = Math.hypot(pad.at.x - supply.at.x, pad.at.y - supply.at.y);
        if (!best || distance < best.distance) best = { part: f.part, net: supply.net, ic: ic.part, pad: pad.name, distance };
      }
    }
    if (best) out.push(best);
  }
  return out;
}
