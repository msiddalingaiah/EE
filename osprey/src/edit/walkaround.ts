// Finding a route around obstacles (Eagle's "follow-me" routing, for one leg): when the direct
// 45° leg from the last corner to the cursor would break a clearance rule, search the obstacle
// rasters (drc.ts) for a path in 45° steps that prefers few bends, then straighten it. With
// more than one layer the path may change layer through vias (each costs as much as a stretch
// of trace, so it stays on one layer when it can). Every segment and via of the result is
// checked exactly, so a route that is returned is clear.

import type { ClearanceChecker, ObstacleGrid } from '../model/drc';
import type * as O from '../model/types';

/** Moves: E, NE, N, NW, W, SW, S, SE. */
const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** Search no further than this many cells around the two ends (keeps it interactive). */
const MARGIN_CELLS = 150;
const MAX_EXPANSIONS = 250_000;
/** A via costs as much as this length of trace (mm). */
const VIA_COST_MM = 1.6;

export interface Leg {
  net: string;
  layer: string;
  width: number;
}

/** A route found around obstacles: runs on layers, joined by vias at the runs' ends. */
export interface Detour {
  runs: { layer: string; pts: O.Pt[] }[];
  vias: O.Pt[];
}

export interface DetourSearch {
  net: string;
  width: number;
  /** Obstacle raster per layer the route may use (the first is where it starts). */
  layers: { name: string; grid: ObstacleGrid }[];
  /** Where a via fits (all layers); undefined = no layer changes. */
  vias?: { grid: ObstacleGrid; drill: number };
  from: O.Pt;
  to: O.Pt;
  /** Layers the route may end on. */
  endLayers: string[];
}

/** A path on one layer from `from` to `to` (both ends included), or undefined. */
export function findPath(checker: ClearanceChecker, grid: ObstacleGrid, leg: Leg, from: O.Pt, to: O.Pt): O.Pt[] | undefined {
  return findDetour(checker, { net: leg.net, width: leg.width, layers: [{ name: leg.layer, grid }], from, to, endLayers: [leg.layer] })?.runs[0]?.pts;
}

/** A route from `from` (on the first layer) to `to` (on one of `endLayers`), or undefined. */
export function findDetour(checker: ClearanceChecker, q: DetourSearch): Detour | undefined {
  const { x0, y0, w, h, step } = q.layers[0]!.grid;
  const L = q.layers.length;
  const cells = w * h;
  const cellOf = (p: O.Pt): [number, number] => [Math.round((p[0] - x0) / step), Math.round((p[1] - y0) / step)];
  const at = (i: number, j: number): O.Pt => [round(x0 + i * step), round(y0 + j * step)];
  const clearOn = (layer: string) => (a: O.Pt, b: O.Pt) => checker.clear(q.net, a, b, layer, q.width);

  // The ends attach to nearby free cells by a short exact-checked stub.
  const attach = (p: O.Pt, li: number): number[] => {
    const { blocked } = q.layers[li]!.grid;
    const clear = clearOn(q.layers[li]!.name);
    const [ci, cj] = cellOf(p);
    const out: { k: number; d: number }[] = [];
    for (let r = 0; r <= 4 && out.length < 3; r++) {
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= w || j >= h) continue;
          const k = j * w + i;
          if (blocked[k]) continue;
          const c = at(i, j);
          if (clear(p, c)) out.push({ k, d: Math.hypot(c[0] - p[0], c[1] - p[1]) });
        }
      }
    }
    return out.sort((a, b) => a.d - b.d).slice(0, 4).map((x) => x.k);
  };
  const starts = attach(q.from, 0);
  const goals = new Set<number>();
  q.layers.forEach((l, li) => {
    if (q.endLayers.includes(l.name)) for (const k of attach(q.to, li)) goals.add(li * cells + k);
  });
  if (!starts.length || !goals.size) return undefined;

  // Search window around both ends.
  const [fi, fj] = cellOf(q.from);
  const [ti, tj] = cellOf(q.to);
  const minI = Math.max(0, Math.min(fi, ti) - MARGIN_CELLS);
  const maxI = Math.min(w - 1, Math.max(fi, ti) + MARGIN_CELLS);
  const minJ = Math.max(0, Math.min(fj, tj) - MARGIN_CELLS);
  const maxJ = Math.min(h - 1, Math.max(fj, tj) + MARGIN_CELLS);

  // A* over (layer, cell, direction of arrival); turning costs extra so paths keep few corners.
  // States are numbered within the window: ((layer * window cells) + local cell) * 9 + direction
  // (8 = no direction: at the start, or just through a via).
  const ww = maxI - minI + 1;
  const wcells = ww * (maxJ - minJ + 1);
  const local = (k: number) => (Math.floor(k / w) - minJ) * ww + ((k % w) - minI);
  const global = (l: number) => (Math.floor(l / ww) + minJ) * w + ((l % ww) + minI);
  const turnCost = 0.6;
  const viaCost = VIA_COST_MM / step;
  const n = L * wcells * 9;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const hEst = (k: number) => {
    const dx = Math.abs((k % w) - ti);
    const dy = Math.abs(Math.floor(k / w) - tj);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const stateOf = (li: number, k: number, dir: number) => (li * wcells + local(k)) * 9 + dir;
  for (const k of starts) {
    const i = k % w;
    const j = Math.floor(k / w);
    if (i < minI || i > maxI || j < minJ || j > maxJ) continue;
    const s = stateOf(0, k, 8);
    g[s] = 0;
    heap.push(s, hEst(k));
  }
  const relax = (from: number, to: number, cost: number, k: number) => {
    if (cost < g[to]!) {
      g[to] = cost;
      prev[to] = from;
      heap.push(to, cost + hEst(k));
    }
  };
  let found = -1;
  let expansions = 0;
  while (heap.size && expansions++ < MAX_EXPANSIONS) {
    const s = heap.pop();
    const dir = s % 9;
    const li = Math.floor(Math.floor(s / 9) / wcells);
    const k = global(Math.floor(s / 9) % wcells);
    if (goals.has(li * cells + k)) {
      found = s;
      break;
    }
    const { blocked } = q.layers[li]!.grid;
    const i = k % w;
    const j = Math.floor(k / w);
    for (let d = 0; d < 8; d++) {
      const ni = i + DIRS[d]![0];
      const nj = j + DIRS[d]![1];
      if (ni < minI || nj < minJ || ni > maxI || nj > maxJ) continue;
      const nk = nj * w + ni;
      if (blocked[nk]) continue;
      let turn = 0;
      if (dir !== 8) {
        const diff = Math.abs(d - dir);
        const steps = Math.min(diff, 8 - diff);
        if (steps > 2) continue; // no sharper than 90°
        turn = steps * turnCost;
      }
      relax(s, stateOf(li, nk, d), g[s]! + (d % 2 ? Math.SQRT2 : 1) + turn, nk);
    }
    // Through a via to another layer, where a via fits.
    if (q.vias && !q.vias.grid.blocked[k]) {
      for (let lj = 0; lj < L; lj++) {
        if (lj === li || q.layers[lj]!.grid.blocked[k]) continue;
        relax(s, stateOf(lj, k, 8), g[s]! + viaCost, k);
      }
    }
  }
  if (found < 0) return undefined;

  // Back along the path: cells per layer, split where the layer changes.
  const steps: { li: number; p: O.Pt }[] = [];
  for (let s = found; s >= 0; s = prev[s]!) {
    const li = Math.floor(Math.floor(s / 9) / wcells);
    const k = global(Math.floor(s / 9) % wcells);
    steps.push({ li, p: at(k % w, Math.floor(k / w)) });
  }
  steps.reverse();
  const runs: { layer: string; pts: O.Pt[] }[] = [];
  const vias: O.Pt[] = [];
  let cur: { li: number; pts: O.Pt[] } = { li: steps[0]!.li, pts: [q.from] };
  for (const st of steps) {
    if (st.li !== cur.li) {
      runs.push({ layer: q.layers[cur.li]!.name, pts: cur.pts });
      vias.push(st.p);
      cur = { li: st.li, pts: [st.p] };
    } else {
      cur.pts.push(st.p);
    }
  }
  cur.pts.push(q.to);
  runs.push({ layer: q.layers[cur.li]!.name, pts: cur.pts });

  // Straighten each run (its ends stay: the start, vias, the end), then check it all exactly.
  for (const r of runs) r.pts = straighten(dedupe(r.pts), clearOn(r.layer));
  for (const r of runs) {
    const clear = clearOn(r.layer);
    for (let i = 1; i < r.pts.length; i++) if (!clear(r.pts[i - 1]!, r.pts[i]!)) return undefined;
  }
  if (q.vias) for (const v of vias) if (checker.via(q.net, v, q.vias.drill).length) return undefined;
  return { runs, vias };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function dedupe(pts: O.Pt[]): O.Pt[] {
  const out: O.Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

/** Is a → b horizontal, vertical or diagonal? */
function is45(a: O.Pt, b: O.Pt): boolean {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6;
}

/**
 * Remove corners: drop points on a straight run, then repeatedly jump from each point to the
 * farthest later point reachable by a clear 45° segment. (The short end stubs, from the exact
 * ends to the raster, may be at any angle.)
 */
function straighten(pts: O.Pt[], clear: (a: O.Pt, b: O.Pt) => boolean): O.Pt[] {
  const collinear: O.Pt[] = [];
  for (const p of pts) {
    while (collinear.length >= 2) {
      const a = collinear[collinear.length - 2]!;
      const b = collinear[collinear.length - 1]!;
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0) collinear.pop();
      else break;
    }
    collinear.push(p);
  }
  const out: O.Pt[] = [collinear[0]!];
  let i = 0;
  while (i < collinear.length - 1) {
    let next = i + 1;
    for (let j = collinear.length - 1; j > i + 1; j--) {
      if (is45(collinear[i]!, collinear[j]!) && clear(collinear[i]!, collinear[j]!)) {
        next = j;
        break;
      }
    }
    out.push(collinear[next]!);
    i = next;
  }
  return out;
}

/** A binary min-heap of (id, priority). */
class Heap {
  private ids: number[] = [];
  private pri: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, p: number): void {
    const { ids, pri } = this;
    ids.push(id);
    pri.push(p);
    let i = ids.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pri[up]! <= p) break;
      ids[i] = ids[up]!;
      pri[i] = pri[up]!;
      i = up;
    }
    ids[i] = id;
    pri[i] = p;
  }

  pop(): number {
    const { ids, pri } = this;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastP = pri.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= ids.length) break;
        const r = l + 1;
        const c = r < ids.length && pri[r]! < pri[l]! ? r : l;
        if (pri[c]! >= lastP) break;
        ids[i] = ids[c]!;
        pri[i] = pri[c]!;
        i = c;
      }
      ids[i] = lastId;
      pri[i] = lastP;
    }
    return top;
  }
}
