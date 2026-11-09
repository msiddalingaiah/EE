// Finding a route around obstacles (Eagle's "follow-me" routing, for one leg): when the direct
// 45° leg from the last corner to the cursor would break a clearance rule, search the obstacle
// raster (drc.ts) for a path in 45° steps that prefers few bends, then straighten it. Every
// segment of the result is checked exactly, so a path that is returned is clear.

import type { ClearanceChecker, ObstacleGrid } from '../model/drc';
import type * as O from '../model/types';

/** Moves: E, NE, N, NW, W, SW, S, SE. */
const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** Search no further than this many cells around the two ends (keeps it interactive). */
const MARGIN_CELLS = 150;
const MAX_EXPANSIONS = 250_000;

export interface Leg {
  net: string;
  layer: string;
  width: number;
}

/**
 * A path from `from` to `to` avoiding other nets' copper (both ends included), or undefined
 * when there is none nearby. `grid` is the obstacle raster for this net, layer and width.
 */
export function findPath(checker: ClearanceChecker, grid: ObstacleGrid, leg: Leg, from: O.Pt, to: O.Pt): O.Pt[] | undefined {
  const { x0, y0, w, h, step, blocked } = grid;
  const cellOf = (p: O.Pt): [number, number] => [Math.round((p[0] - x0) / step), Math.round((p[1] - y0) / step)];
  const at = (i: number, j: number): O.Pt => [round(x0 + i * step), round(y0 + j * step)];
  const clear = (a: O.Pt, b: O.Pt) => checker.clear(leg.net, a, b, leg.layer, leg.width);

  // The ends attach to nearby free cells by a short exact-checked stub.
  const attach = (p: O.Pt): number[] => {
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
  const starts = attach(from);
  const goals = new Set(attach(to));
  if (!starts.length || !goals.size) return undefined;

  // Search window around both ends.
  const [fi, fj] = cellOf(from);
  const [ti, tj] = cellOf(to);
  const minI = Math.max(0, Math.min(fi, ti) - MARGIN_CELLS);
  const maxI = Math.min(w - 1, Math.max(fi, ti) + MARGIN_CELLS);
  const minJ = Math.max(0, Math.min(fj, tj) - MARGIN_CELLS);
  const maxJ = Math.min(h - 1, Math.max(fj, tj) + MARGIN_CELLS);

  // A* over (cell, direction of arrival); turning costs extra so paths keep few corners.
  // States are numbered within the window: (local cell) * 9 + direction (8 = start).
  const ww = maxI - minI + 1;
  const local = (k: number) => (Math.floor(k / w) - minJ) * ww + ((k % w) - minI);
  const global = (l: number) => (Math.floor(l / ww) + minJ) * w + ((l % ww) + minI);
  const inWindow = (k: number) => {
    const i = k % w;
    const j = Math.floor(k / w);
    return i >= minI && i <= maxI && j >= minJ && j <= maxJ;
  };
  const turnCost = 0.6;
  const n = ww * (maxJ - minJ + 1) * 9;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const hEst = (k: number) => {
    const dx = Math.abs((k % w) - ti);
    const dy = Math.abs(Math.floor(k / w) - tj);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  for (const k of starts) {
    if (!inWindow(k)) continue;
    const s = local(k) * 9 + 8;
    g[s] = 0;
    heap.push(s, hEst(k));
  }
  let found = -1;
  let expansions = 0;
  while (heap.size && expansions++ < MAX_EXPANSIONS) {
    const s = heap.pop();
    const k = global(Math.floor(s / 9));
    const dir = s % 9;
    if (goals.has(k)) {
      found = s;
      break;
    }
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
      const cost = g[s]! + (d % 2 ? Math.SQRT2 : 1) + turn;
      const ns = local(nk) * 9 + d;
      if (cost < g[ns]!) {
        g[ns] = cost;
        prev[ns] = s;
        heap.push(ns, cost + hEst(nk));
      }
    }
  }
  if (found < 0) return undefined;

  const cells: O.Pt[] = [];
  for (let s = found; s >= 0; s = prev[s]!) {
    const k = global(Math.floor(s / 9));
    cells.push(at(k % w, Math.floor(k / w)));
  }
  cells.reverse();
  const path = straighten(dedupe([from, ...cells, to]), clear);
  for (let i = 1; i < path.length; i++) if (!clear(path[i - 1]!, path[i]!)) return undefined;
  return path;
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
