// Local improvement of a placement: small moves (toward what a part connects to, nudges, swaps
// of like parts, rotations) kept when they make the placement better and leave it legal.
//
// "Better" is a score: the length of the airwires on signal nets (supply nets aside: pours and
// planes connect them), plus a cost per crossing, plus decoupling capacitors' distance from the
// IC power pins they serve. Airwires here are each net's minimum spanning tree over its pads:
// right for an unrouted board, which is when placement is done. The search runs on its own copy
// of the geometry (footprint shapes per rotation are computed once), so thousands of moves take a
// moment; the result is then applied through the move command.

import type { Point } from '../geom/transform';
import type { Rect } from '../model/placement';
import { boardArea, footprintInfo, footprintInfos, isGroundNet, onBoard, partClearance, rectCenter, rectGap, supplyNets, TOLERANCE } from '../model/placement';
import type { Arrange } from './arrange';

export interface ImproveOptions {
  /** Parts that may move (default: every unlocked part on the board). */
  parts?: string[];
  /** Parts that stay put (e.g. connectors placed on edges), as well as locked ones. */
  fixed?: string[];
  /**
   * Which moves to try: moving parts toward their connections and nudging them, rotations, and
   * swaps of parts with the same footprint (all by default).
   */
  move?: boolean;
  rotate?: boolean;
  swap?: boolean;
  /** Longest single move (mm, default 3). */
  maxStep?: number;
  /** Passes over all parts at most (default 30). */
  passes?: number;
}

export interface ImproveResult {
  before: number;
  after: number;
  /** Parts moved or turned. */
  changed: string[];
  passes: number;
}

/** What a crossing costs, and how much a decoupling cap's distance counts, in mm of airwire. */
export const CROSSING_COST = 3;
export const DECOUPLING_WEIGHT = 2;
/** How far around its target a jumping part looks for a free spot (mm). */
const JUMP_RADIUS = 10;

interface Shape {
  /** Box and pads relative to the part's origin, at one rotation. */
  box: Rect;
  pads: { name: string; net?: string; x: number; y: number }[];
  /** Box centre relative to the origin (to turn about the centre). */
  cx: number;
  cy: number;
}

interface PartState {
  part: string;
  at: Point;
  rot: number;
  movable: boolean;
  shapes: Map<number, Shape>;
  footprint: string;
  smd: boolean;
  bottom: boolean;
}

interface Edge {
  net: string;
  a: Point;
  b: Point;
}

export function improve(arr: Arrange, opts: ImproveOptions = {}): ImproveResult {
  const project = arr.project;
  const board = project.board;
  const area = board && boardArea(board);
  if (!board || !area) return { before: 0, after: 0, changed: [], passes: 0 };
  const rules = arr.rules;
  const fixed = new Set(opts.fixed ?? []);
  const allowed = opts.parts ? new Set(opts.parts) : undefined;
  const maxStep = opts.maxStep ?? 3;

  // ---- the model ------------------------------------------------------------
  const states: PartState[] = [];
  for (const info of footprintInfos(project, arr.index)) {
    if (!onBoard(info.box, area.outline)) continue;
    const f = info.placement;
    const part = arr.index.parts.get(info.part)!;
    states.push({
      part: info.part, at: { x: f.at[0], y: f.at[1] }, rot: f.rot ?? 0,
      movable: !f.locked && !fixed.has(info.part) && (!allowed || allowed.has(info.part)),
      shapes: new Map(), footprint: arr.index.variantOf(part)?.footprint ?? '', smd: info.smd, bottom: f.side === 'bottom',
    });
  }
  const shape = (s: PartState, rot: number): Shape => {
    let sh = s.shapes.get(rot);
    if (sh) return sh;
    const i = footprintInfo(project, s.part, { at: [0, 0], rot }, arr.index)!;
    const c = rectCenter(i.box);
    sh = { box: i.box, pads: i.pads.map((q) => ({ name: q.name, ...(q.net ? { net: q.net } : {}), x: q.at.x, y: q.at.y })), cx: c.x, cy: c.y };
    s.shapes.set(rot, sh);
    return sh;
  };
  const boxOf = (s: PartState): Rect => {
    const b = shape(s, s.rot).box;
    return { minX: b.minX + s.at.x, minY: b.minY + s.at.y, maxX: b.maxX + s.at.x, maxY: b.maxY + s.at.y };
  };
  const padsOf = (s: PartState) => shape(s, s.rot).pads.map((q) => ({ net: q.net, x: q.x + s.at.x, y: q.y + s.at.y }));

  // Nets that count (supply nets aside), and which parts are on each.
  const supplies = supplyNets(project, arr.index);
  const netParts = new Map<string, Set<PartState>>();
  for (const s of states) {
    for (const q of shape(s, s.rot).pads) {
      if (!q.net || isGroundNet(q.net) || supplies.has(q.net)) continue;
      let set = netParts.get(q.net);
      if (!set) netParts.set(q.net, (set = new Set()));
      set.add(s);
    }
  }
  // Decoupling caps: a capacitor with one pad on ground and the other on a net with IC power pins.
  const decoupling: { cap: PartState; net: string }[] = [];
  const infos = footprintInfos(project, arr.index);
  const powerNets = new Set(infos.flatMap((i) => i.pads.filter((q) => q.power && q.net).map((q) => q.net!)));
  const powerPads = new Map<string, { part: string; pad: string }[]>();
  for (const i of infos) for (const q of i.pads) if (q.power && q.net) (powerPads.get(q.net) ?? powerPads.set(q.net, []).get(q.net)!).push({ part: i.part, pad: q.name });
  for (const s of states) {
    const pads = shape(s, s.rot).pads;
    if (!/^C\d/.test(s.part) || pads.length !== 2) continue;
    const g = pads.findIndex((q) => q.net && isGroundNet(q.net));
    const other = pads[1 - g];
    if (g >= 0 && other?.net && !isGroundNet(other.net) && powerNets.has(other.net)) decoupling.push({ cap: s, net: other.net });
  }
  const byPart = new Map(states.map((s) => [s.part, s]));

  // ---- scoring ---------------------------------------------------------------
  const netEdges = new Map<string, Edge[]>();
  const mst = (net: string): Edge[] => {
    const pts: Point[] = [];
    for (const s of netParts.get(net) ?? []) for (const q of padsOf(s)) if (q.net === net) pts.push({ x: q.x, y: q.y });
    const edges: Edge[] = [];
    if (pts.length < 2) return edges;
    const inTree = pts.map((_, i) => i === 0);
    const dist = pts.map((p) => Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y));
    const from = pts.map(() => 0);
    for (let k = 1; k < pts.length; k++) {
      let best = -1;
      for (let i = 0; i < pts.length; i++) if (!inTree[i] && (best < 0 || dist[i]! < dist[best]!)) best = i;
      inTree[best] = true;
      if (dist[best]! > 1e-9) edges.push({ net, a: pts[from[best]!]!, b: pts[best]! });
      for (let i = 0; i < pts.length; i++) {
        if (inTree[i]) continue;
        const d = Math.hypot(pts[i]!.x - pts[best]!.x, pts[i]!.y - pts[best]!.y);
        if (d < dist[i]!) [dist[i], from[i]] = [d, best];
      }
    }
    return edges;
  };
  for (const net of netParts.keys()) netEdges.set(net, mst(net));
  /** A decoupling cap's supply pad, and the nearest IC power pad on its net. */
  const decouplingPair = (d: { cap: PartState; net: string }): { from: Point; to?: Point; distance: number } => {
    const pad = padsOf(d.cap).find((q) => q.net === d.net)!;
    let best: { to?: Point; distance: number } = { distance: Infinity };
    for (const pp of powerPads.get(d.net) ?? []) {
      if (pp.part === d.cap.part) continue;
      const s = byPart.get(pp.part);
      if (!s) continue;
      const q = shape(s, s.rot).pads.find((x) => x.name === pp.pad);
      if (!q) continue;
      const to = { x: q.x + s.at.x, y: q.y + s.at.y };
      const distance = Math.hypot(to.x - pad.x, to.y - pad.y);
      if (distance < best.distance) best = { to, distance };
    }
    return { from: { x: pad.x, y: pad.y }, ...best, distance: Number.isFinite(best.distance) ? best.distance : 0 };
  };
  const decouplingDistance = (d: { cap: PartState; net: string }) => decouplingPair(d).distance;
  const decouplingOf = new Map(decoupling.map((d) => [d.cap, d]));
  const score = (): number => {
    const all: Edge[] = [];
    let length = 0;
    for (const edges of netEdges.values()) {
      for (const e of edges) {
        length += Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
        all.push(e);
      }
    }
    let crossings = 0;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (crosses(all[i]!, all[j]!)) crossings++;
    let dec = 0;
    for (const d of decoupling) dec += decouplingDistance(d);
    return length + CROSSING_COST * crossings + DECOUPLING_WEIGHT * dec;
  };
  const touch = (s: PartState) => {
    for (const q of shape(s, s.rot).pads) if (q.net && netParts.has(q.net)) netEdges.set(q.net, mst(q.net));
  };

  // ---- legality ----------------------------------------------------------------
  const fits = (s: PartState): boolean => {
    const b = boxOf(s);
    const o = area.outline;
    const e = rules.edge - TOLERANCE;
    if (b.minX < o.minX + e || b.minY < o.minY + e || b.maxX > o.maxX - e || b.maxY > o.maxY - e) return false;
    for (const h of area.holes) if (rectGap(b, h) < e) return false;
    for (const t of states) {
      if (t === s) continue;
      if (s.smd && t.smd && s.bottom !== t.bottom) continue;
      if (rectGap(b, boxOf(t)) < partClearance(rules, s, t) - TOLERANCE) return false;
    }
    return true;
  };

  // ---- search ------------------------------------------------------------------
  const before = score();
  let current = before;
  const original = new Map(states.map((s) => [s, { at: { ...s.at }, rot: s.rot }]));
  /** Try a change; keep it if legal and better. */
  const attempt = (changed: PartState[], apply: () => void, undo: () => void): boolean => {
    apply();
    if (changed.every(fits)) {
      for (const s of changed) touch(s);
      const sc = score();
      if (sc < current - 1e-6) {
        current = sc;
        return true;
      }
    }
    undo();
    for (const s of changed) touch(s);
    return false;
  };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const moveBy = (s: PartState, dx: number, dy: number) =>
    attempt([s], () => {
      s.at = { x: r2(s.at.x + dx), y: r2(s.at.y + dy) };
    }, (() => {
      const at = { ...s.at };
      return () => {
        s.at = at;
      };
    })());

  /** Where a part's connections pull it: the mean offset to the nearest pad on each net. */
  const pull = (s: PartState): Point => {
    // A decoupling cap goes to the IC power pin it serves.
    const dec = decouplingOf.get(s);
    if (dec) {
      const p = decouplingPair(dec);
      if (p.to) return { x: p.to.x - p.from.x, y: p.to.y - p.from.y };
    }
    let x = 0;
    let y = 0;
    let n = 0;
    for (const q of padsOf(s)) {
      if (!q.net || !netParts.has(q.net)) continue;
      let best: Point | undefined;
      let d = Infinity;
      for (const t of netParts.get(q.net)!) {
        if (t === s) continue;
        for (const r of padsOf(t)) {
          if (r.net !== q.net) continue;
          const e = Math.hypot(r.x - q.x, r.y - q.y);
          if (e < d) [d, best] = [e, { x: r.x, y: r.y }];
        }
      }
      if (best) {
        x += best.x - q.x;
        y += best.y - q.y;
        n++;
      }
    }
    return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
  };

  /** Try the free spots nearest `target` (rings out to JUMP_RADIUS), keeping the first that improves. */
  const jump = (s: PartState, target: Point): boolean => {
    const home = { ...s.at };
    for (let r = 0; r <= JUMP_RADIUS; r += 0.5) {
      const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 0.5);
      for (let k = 0; k < n; k++) {
        const t = (2 * Math.PI * k) / n;
        const at = { x: r2(target.x + r * Math.cos(t)), y: r2(target.y + r * Math.sin(t)) };
        s.at = at;
        const free = fits(s);
        s.at = home;
        if (!free) continue;
        if (attempt([s], () => { s.at = at; }, () => { s.at = home; })) return true;
      }
    }
    return false;
  };

  const movable = states.filter((s) => s.movable);
  let passes = 0;
  for (; passes < (opts.passes ?? 30); passes++) {
    let improved = false;
    for (const s of movable) {
      // Toward its connections, then nudges.
      if (opts.move ?? true) {
        const p = pull(s);
        const len = Math.hypot(p.x, p.y);
        // Far from them: jump to the nearest free spot around where they pull it (steps can't
        // get past parts in the way).
        if (len > maxStep && jump(s, { x: s.at.x + p.x, y: s.at.y + p.y })) improved = true;
        if (len > 0.05) {
          const scale = Math.min(1, maxStep / len);
          for (const f of [1, 0.5, 0.25]) if (moveBy(s, p.x * scale * f, p.y * scale * f)) improved = true;
        }
        for (const step of [1, 0.5, 0.25]) {
          for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) if (moveBy(s, dx, dy)) improved = true;
        }
      }
      // Rotations about the box centre.
      if (opts.rotate ?? true) {
        for (const rot of [0, 90, 180, 270]) {
          if (rot === s.rot) continue;
          const old = { at: { ...s.at }, rot: s.rot };
          const c0 = shape(s, s.rot);
          const c1 = shape(s, rot);
          const ok = attempt([s], () => {
            s.at = { x: r2(s.at.x + c0.cx - c1.cx), y: r2(s.at.y + c0.cy - c1.cy) };
            s.rot = rot;
          }, () => {
            s.at = old.at;
            s.rot = old.rot;
          });
          if (ok) improved = true;
        }
      }
    }
    // Swaps of parts with the same footprint (centre for centre).
    if (opts.swap ?? true) {
      for (let i = 0; i < movable.length; i++) {
        for (let j = i + 1; j < movable.length; j++) {
          const a = movable[i]!;
          const b = movable[j]!;
          if (a.footprint !== b.footprint || a.bottom !== b.bottom) continue;
          const sa = { at: { ...a.at }, rot: a.rot };
          const sb = { at: { ...b.at }, rot: b.rot };
          const ok = attempt([a, b], () => {
            [a.at, a.rot, b.at, b.rot] = [sb.at, sb.rot, sa.at, sa.rot];
          }, () => {
            [a.at, a.rot, b.at, b.rot] = [sa.at, sa.rot, sb.at, sb.rot];
          });
          if (ok) improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // ---- apply ---------------------------------------------------------------------
  const changed: string[] = [];
  for (const s of states) {
    const o = original.get(s)!;
    if (Math.abs(o.at.x - s.at.x) < 1e-6 && Math.abs(o.at.y - s.at.y) < 1e-6 && o.rot === s.rot) continue;
    arr.moveTo(s.part, [s.at.x, s.at.y], s.rot);
    changed.push(s.part);
  }
  return { before, after: current, changed, passes };
}

function crosses(e: Edge, f: Edge): boolean {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const eps = 1e-9;
  const d1 = o(e.a, e.b, f.a);
  const d2 = o(e.a, e.b, f.b);
  const d3 = o(f.a, f.b, e.a);
  const d4 = o(f.a, f.b, e.b);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}
