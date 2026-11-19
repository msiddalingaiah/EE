// Drawing a schematic from a resolved block description (description.ts).
//
// Placement: each block gets its own area. Inside it, gates stand in columns by signal flow:
// breadth first from the block's first part, so the description's order is the left-to-right
// order, rows lined up with what they connect to in the column before. Two-pin parts on a
// supply stand upright. A top-level block and the blocks inside it sit side by side: a group.
//
// Wiring: a grid router (Router, below) draws each group as one connected circuit: orthogonal
// wires around the symbols, joining a net's tree only in T's (never four ways, never pin to
// pin), crossing other nets only straight through. Every supply pin gets its own supply symbol,
// upright, in the nearest free spot. Only a net that leaves the group gets a net label, one per
// group; a pin the router can't reach gets a label too (nets connect by name).

import { labelFor } from '../edit/netlabels';
import { Transaction } from '../edit/ops';
import { addToLibrary, insertPart } from '../edit/place';
import type * as O from '../model/types';
import { FORMAT_VERSION } from '../model/types';
import type { RNet, RPart, Resolved } from './description';

const G = 2.54;
const WIRE = 0.1524;
const LABEL_SIZE = 1.778;
/** Between parts stacked in a column, and around a column: room for wires and symbols. */
const GAP_Y = 3 * G;
const BLOCK_GAP = 8 * G;
/** Between blocks of one group (a block and the blocks inside it). */
const INNER_GAP = 5 * G;
const SHEET_WIDTH = 300;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const snapDown = (v: number) => r6(Math.floor(v / G + 1e-6) * G);
const snap = (v: number) => r6(Math.round(v / G) * G);
const onGrid = (v: number) => Math.abs(v / G - Math.round(v / G)) < 1e-4;

type Side = 'L' | 'R' | 'T' | 'B';
type Vec = [number, number];
const OUT: Record<Side, Vec> = { L: [-1, 0], R: [1, 0], T: [0, 1], B: [0, -1] };

/** A point rotated counter-clockwise by a multiple of 90°. */
function rot(p: Vec, deg: number): Vec {
  const d = ((deg % 360) + 360) % 360;
  if (d === 90) return [-p[1], p[0]];
  if (d === 180) return [-p[0], -p[1]];
  if (d === 270) return [p[1], -p[0]];
  return [p[0], p[1]];
}

/** The side of the body a pin connects on: opposite to where its line points. */
function sideOf(pin: O.Pin, gateRot: number): Side {
  const a = (((pin.rot ?? 0) + gateRot) % 360 + 360) % 360;
  return a === 0 ? 'L' : a === 90 ? 'B' : a === 180 ? 'R' : 'T';
}

/** Points outlining a symbol's drawing and pins. */
function bodyPoints(s: O.Symbol): Vec[] {
  const pts: Vec[] = s.pins.map((p) => [p.at[0], p.at[1]]);
  for (const g of s.graphics) {
    if ('line' in g) pts.push(g.line[0], g.line[1]);
    else if ('circle' in g) pts.push([g.circle[0] - g.radius, g.circle[1] - g.radius], [g.circle[0] + g.radius, g.circle[1] + g.radius]);
    else if ('rect' in g) pts.push(g.rect[0], g.rect[1]);
    else if ('polygon' in g) for (const v of g.polygon) pts.push([v[0], v[1]]);
  }
  return pts;
}

/** The boxes of a symbol's texts (>NAME, >VALUE), at a guessed width. */
function textBoxes(s: O.Symbol): [Vec, Vec][] {
  const out: [Vec, Vec][] = [];
  for (const g of s.graphics) {
    if (!('text' in g)) continue;
    const w = g.size * 0.8 * Math.max(4, g.text.replace(/^>/, '').length);
    const h = g.size;
    const vertical = (g.rot ?? 0) % 180 === 90;
    const [dx, dy] = vertical ? [h, w] : [w, h];
    const align = g.align ?? 'bottom-left';
    const x0 = align.endsWith('right') ? -dx : align.endsWith('center') ? -dx / 2 : 0;
    const y0 = align.startsWith('top') ? -dy : align.startsWith('center') ? -dy / 2 : 0;
    out.push([[g.at[0] + x0, g.at[1] + y0], [g.at[0] + x0 + dx, g.at[1] + y0 + dy]]);
  }
  return out;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
function boxOf(pts: Vec[]): Box {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const rotBox = (pts: Vec[], deg: number) => boxOf(pts.map((p) => rot(p, deg)));

/** A supply symbol: its pin, and which way its body points from the pin (upright, as drawn). */
interface SupplySymbol {
  component: O.Component;
  gate: O.Gate;
  symbol: O.Symbol;
  pin: O.Pin;
  /** Direction from the pin into the body. */
  body: Vec;
  /** Its outline (with its text) relative to its pin. */
  box: Box;
}

function supplySymbol(component: O.Component, source: O.Library): SupplySymbol {
  const gate = component.gates[0]!;
  const symbol = source.symbols.find((s) => s.id === gate.symbol)!;
  const pin = symbol.pins[0]!;
  const out = OUT[sideOf(pin, 0)];
  const body: Vec = [-out[0], -out[1]];
  const pts = [...bodyPoints(symbol), ...textBoxes(symbol).flat()].map((p): Vec => [p[0] - pin.at[0], p[1] - pin.at[1]]);
  return { component, gate, symbol, pin, body, box: boxOf(pts) };
}

interface PinInfo {
  ref: O.PinRef;
  pin: O.Pin;
  net?: RNet;
  local: Vec;
  side: Side;
}

interface Node {
  part: RPart;
  gate: O.Gate;
  symbol: O.Symbol;
  order: number;
  powerOnly: boolean;
  rot: number;
  pins: PinInfo[];
  /** The drawing and pins; and with the texts. */
  body: Box;
  box: Box;
  col: number;
  /** Extra room above and below the box (stubs, supply symbols). */
  above: number;
  below: number;
  at: Vec;
}

/** Separates a net's name from the block in a routing key for a piece of it. */
const KEY = '\u0001';
const labelWidth = (name: string) => name.length * LABEL_SIZE * 0.85 + G / 2;

// ---------------------------------------------------------------------------
// Placing a block's gates

class BlockPlacement {
  readonly nodes: Node[] = [];
  width = 0;

  constructor(parts: RPart[], nets: RNet[], private readonly supplies: Map<string, SupplySymbol>) {
    const pinNet = new Map<string, RNet>();
    for (const n of nets) for (const r of n.pins) pinNet.set(`${r.part}.${r.gate}.${r.pin}`, n);
    let order = 0;
    for (const p of parts) {
      for (const g of p.component.gates) {
        const symbol = p.source.symbols.find((s) => s.id === g.symbol);
        if (!symbol) continue;
        const pins: PinInfo[] = symbol.pins.map((pin) => {
          const ref = { part: p.part.name, gate: g.name, pin: pin.name };
          const net = pinNet.get(`${ref.part}.${ref.gate}.${ref.pin}`);
          return { ref, pin, ...(net ? { net } : {}), local: [pin.at[0], pin.at[1]], side: sideOf(pin, 0) };
        });
        const powerOnly = pins.every((x) => !x.net || x.net.supply);
        const node: Node = { part: p, gate: g, symbol, order: order++, powerOnly, rot: 0, pins, body: rotBox(bodyPoints(symbol), 0), box: { x0: 0, y0: 0, x1: 0, y1: 0 }, col: 0, above: 0, below: 0, at: [0, 0] };
        this.setRot(node, 0);
        this.nodes.push(node);
      }
    }
  }

  private setRot(n: Node, deg: number): void {
    n.rot = ((deg % 360) + 360) % 360;
    n.body = rotBox(bodyPoints(n.symbol), n.rot);
    n.box = rotBox([...bodyPoints(n.symbol), ...textBoxes(n.symbol).flat()], n.rot);
    for (const p of n.pins) {
      p.local = rot([p.pin.at[0], p.pin.at[1]], n.rot);
      p.side = sideOf(p.pin, n.rot);
    }
  }

  /** Which way a supply's symbol hangs: ground below (pin at the bottom), others above. */
  private supplyDown(net: RNet): boolean {
    const s = this.supplies.get(net.name);
    return !s || s.body[1] < 0;
  }

  private neighbours(n: Node): Node[] {
    const out = new Set<Node>();
    for (const p of n.pins) {
      if (!p.net || p.net.supply) continue;
      for (const r of p.net.pins) {
        const m = this.nodes.find((x) => x !== n && x.part.part.name === r.part && x.gate.name === r.gate);
        if (m) out.add(m);
      }
    }
    return [...out];
  }

  /** Place the gates; positions are relative to the block's top left (y down is negative). */
  /** The gates the left-to-right order can start from (one per variant tried). */
  get starts(): number {
    return Math.max(1, this.nodes.filter((n) => !n.powerOnly).length);
  }

  /**
   * `start`: which signal gate the left-to-right order starts from; `flip`: turn two-pin
   * parts so their pin toward the earlier column is on the left.
   */
  place(start = 0, flip = true): void {
    // Two-pin parts on a supply (a pin on each side: a resistor, a capacitor) stand upright,
    // the supply pin down (ground) or up.
    for (const n of this.nodes) {
      if (n.pins.length !== 2 || new Set(n.pins.map((p) => p.side)).size !== 2 || n.pins.some((p) => p.side === 'T' || p.side === 'B')) continue;
      const sup = n.pins.filter((p) => p.net?.supply);
      if (!sup.length) continue;
      const s = sup.find((p) => this.supplyDown(p.net!)) ?? sup[0]!;
      const want: Side = this.supplyDown(s.net!) || sup.length === 2 ? 'B' : 'T';
      for (const deg of [90, 270]) if (sideOf(s.pin, deg) === want) this.setRot(n, deg);
    }

    // Columns: breadth first through signal nets, from the first part listed.
    const signal = this.nodes.filter((n) => !n.powerOnly);
    const seen = new Set<Node>();
    for (const first of [...signal.slice(start), ...signal.slice(0, start)]) {
      const start = first;
      if (seen.has(start)) continue;
      start.col = 0;
      seen.add(start);
      const queue = [start];
      while (queue.length) {
        const n = queue.shift()!;
        for (const m of this.neighbours(n).sort((x, y) => x.order - y.order)) {
          if (seen.has(m) || m.powerOnly) continue;
          seen.add(m);
          m.col = n.col + 1;
          queue.push(m);
        }
      }
    }
    for (const n of this.nodes) if (n.powerOnly) n.col = signal.find((x) => x.part === n.part)?.col ?? 0;

    // Two-pin parts lying across: the pin toward the earlier column on the left.
    for (const n of flip ? signal : []) {
      if (n.pins.length !== 2 || n.rot !== 0) continue;
      const left = n.pins.find((p) => p.side === 'L');
      const right = n.pins.find((p) => p.side === 'R');
      if (!left || !right) continue;
      const cols = (p: PinInfo) => (p.net?.pins ?? []).map((r) => this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate)).filter((x): x is Node => !!x && x !== n).map((x) => x.col);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : n.col);
      if (avg(cols(left)) > avg(cols(right))) this.setRot(n, 180);
    }

    const columns: Node[][] = [];
    for (const n of [...this.nodes].sort((a, b) => a.order - b.order)) (columns[n.col] ??= []).push(n);
    for (let c = 0; c < columns.length; c++) columns[c] ??= [];
    // Each column in the order of its neighbours in the column before.
    for (let c = 1; c < columns.length; c++) {
      const prev = columns[c - 1]!;
      const rank = (n: Node) => {
        const ns = this.neighbours(n).filter((m) => m.col === c - 1).map((m) => prev.indexOf(m));
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : Infinity;
      };
      columns[c] = columns[c]!.map((n, i) => ({ n, k: rank(n), i })).sort((a, b) => (a.k - b.k) || (a.i - b.i)).map((x) => x.n);
    }

    // Room above and below for stubs and upright supply symbols.
    for (const n of this.nodes) {
      for (const p of n.pins) {
        if (p.side !== 'T' && p.side !== 'B') continue;
        const s = p.net?.supply ? this.supplies.get(p.net.name) : undefined;
        const need = 2 * G + (s ? Math.max(s.box.y1 - s.box.y0, s.box.x1 - s.box.x0) : 0);
        const edge = p.side === 'T' ? n.box.y1 - p.local[1] : p.local[1] - n.box.y0;
        if (p.side === 'T') n.above = Math.max(n.above, need - edge);
        else n.below = Math.max(n.below, need - edge);
      }
    }

    // Rows: each column stacks down from the top; a gate lines up with a pin it connects to in
    // the column before, when there is room.
    for (let c = 0; c < columns.length; c++) {
      let cursor = 0;
      for (const n of columns[c]!) {
        const highest = snapDown(cursor - n.above - n.box.y1);
        const target = this.alignTarget(n, c);
        n.at = [0, target !== undefined && target <= highest ? target : highest];
        cursor = n.at[1] + n.box.y0 - n.below - GAP_Y;
      }
    }

    // Columns' x: the widest gate, and a gap that grows with the nets between the columns.
    const colWidth = columns.map((col) => Math.max(2 * G, ...col.map((n) => n.box.x1 - n.box.x0)));
    let x = 0;
    for (let c = 0; c < columns.length; c++) {
      const between = new Set<RNet>();
      for (const n of [...columns[c]!, ...(columns[c + 1] ?? [])]) for (const p of n.pins) if (p.net && !p.net.supply) between.add(p.net);
      for (const n of columns[c]!) n.at = [snap(x + (colWidth[c]! - (n.box.x1 - n.box.x0)) / 2 - n.box.x0), n.at[1]];
      x += colWidth[c]! + (c + 1 < columns.length ? (4 + Math.min(8, between.size)) * G : 0);
    }
    this.width = x;
  }

  /** The y that puts a pin of `n` level with the pin it connects to in column c - 1. */
  private alignTarget(n: Node, c: number): number | undefined {
    if (c === 0) return undefined;
    for (const p of n.pins) {
      if (!p.net || p.net.supply || p.side !== 'L') continue;
      for (const r of p.net.pins) {
        const m = this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate && x.col === c - 1);
        const q = m?.pins.find((x) => x.ref.pin === r.pin);
        if (m && q && q.side === 'R') return snapDown(m.at[1] + q.local[1] - p.local[1]);
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The router: a grid of 2.54 mm. Wires run along grid lines between points.

type Dir = 0 | 1 | 2 | 3; // right, up, left, down
const STEP: Vec[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const BIT = [1, 2, 4, 8];
const opposite = (d: Dir) => ((d + 2) % 4) as Dir;
const dirOf = (v: Vec): Dir => (v[0] > 0 ? 0 : v[1] > 0 ? 1 : v[0] < 0 ? 2 : 3);
const pk = (i: number, j: number) => `${i},${j}`;
const count = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

/** A small binary heap of [cost, state]. */
class Heap {
  private readonly a: [number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(c: number, s: number): void {
    const a = this.a;
    a.push([c, s]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

interface PinPoint {
  ref: O.PinRef;
  net: string;
  out: Dir;
  i: number;
  j: number;
}

/** What a net draws: its wire edges, pins, labels and supply symbols, on the grid. */
interface NetDrawing {
  /** Point → directions its wires leave in (bits). */
  use: Map<string, number>;
  pins: Map<string, O.PinRef>;
  labels: Map<string, Dir>;
}

class Router {
  /** Symbol bodies: no wire passes; texts: a wire may, at a cost. */
  private readonly blocked = new Set<string>();
  private readonly soft = new Set<string>();
  /** Pins by point (any net). */
  private readonly pinAt = new Map<string, PinPoint>();
  /** Which net uses each edge ("i,j,h" from (i,j) to (i+1,j); "i,j,v" to (i,j+1)). */
  private readonly edges = new Map<string, string>();
  readonly nets = new Map<string, NetDrawing>();
  readonly supplyGates: { name: string; supply: SupplySymbol; at: Vec }[] = [];
  private readonly i0: number;
  private readonly i1: number;
  private readonly j0: number;
  private readonly j1: number;

  constructor(bounds: Box) {
    this.i0 = Math.floor(bounds.x0 / G) - 8;
    this.i1 = Math.ceil(bounds.x1 / G) + 8;
    this.j0 = Math.floor(bounds.y0 / G) - 8;
    this.j1 = Math.ceil(bounds.y1 / G) + 8;
  }

  net(name: string): NetDrawing {
    let n = this.nets.get(name);
    if (!n) this.nets.set(name, (n = { use: new Map(), pins: new Map(), labels: new Map() }));
    return n;
  }

  /** A box's grid points (inside or on its edge). */
  private cells(b: Box, grow = 0): string[] {
    const out: string[] = [];
    for (let i = Math.ceil((b.x0 - grow) / G - 1e-6); i <= Math.floor((b.x1 + grow) / G + 1e-6); i++) {
      for (let j = Math.ceil((b.y0 - grow) / G - 1e-6); j <= Math.floor((b.y1 + grow) / G + 1e-6); j++) out.push(pk(i, j));
    }
    return out;
  }

  addGate(body: Box, text: Box[]): void {
    for (const c of this.cells(body)) this.blocked.add(c);
    for (const t of text) for (const c of this.cells(t)) this.soft.add(c);
  }

  addPin(p: PinPoint): void {
    this.pinAt.set(pk(p.i, p.j), p);
    this.net(p.net).pins.set(pk(p.i, p.j), p.ref);
  }

  private edgeKey(i: number, j: number, d: Dir): string {
    if (d === 0) return `${i},${j},h`;
    if (d === 2) return `${i - 1},${j},h`;
    if (d === 1) return `${i},${j},v`;
    return `${i},${j - 1},v`;
  }

  private inBounds(i: number, j: number): boolean {
    return i >= this.i0 && i <= this.i1 && j >= this.j0 && j <= this.j1;
  }

  /** Free for a drawing (a supply symbol, a label's text): no body, wire or pin there. */
  private free(k: string): boolean {
    if (this.blocked.has(k) || this.pinAt.has(k)) return false;
    for (const n of this.nets.values()) if (n.use.has(k) || n.labels.has(k)) return false;
    return true;
  }

  /** Could net `net` join its own drawing at k, arriving moving in d? */
  private joinable(net: NetDrawing, k: string, d: Dir): boolean {
    const m = net.use.get(k) ?? 0;
    if (!m) return false;
    if (net.pins.has(k) || net.labels.has(k)) return false;
    return !(m & BIT[opposite(d)]!) && count(m) < 3;
  }

  /**
   * The cheapest path from one of `sources` (each with the directions it may leave in) to a
   * point `target` accepts, avoiding bodies, other nets' pins and wires (crossing one straight
   * through is allowed), and the net's own drawing except where `target` takes it.
   */
  private search(net: string, sources: { i: number; j: number; dirs: Dir[] }[], target: (i: number, j: number, d: Dir) => boolean, maxCost = 400): Vec[] | undefined {
    const W = this.i1 - this.i0 + 1;

    const state = (i: number, j: number, d: Dir, straight: boolean) => ((((j - this.j0) * W + (i - this.i0)) * 4 + d) * 2) + (straight ? 1 : 0);
    const best = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap = new Heap();
    const own = this.net(net);
    const starts = new Set<number>();
    for (const s of sources) {
      for (const d of s.dirs) {
        // A source's first step is made like any other, from a virtual state before it.
        const st = state(s.i, s.j, d, false);
        best.set(st, 0);
        heap.push(0, st);
        starts.add(st);
      }
    }
    const decode = (st: number) => {
      const straight = (st & 1) === 1;
      let x = st >> 1;
      const d = (x % 4) as Dir;
      x = Math.floor(x / 4);
      return { i: (x % W) + this.i0, j: Math.floor(x / W) + this.j0, d, straight };
    };
    while (heap.size) {
      const [cost, st] = heap.pop();
      if (cost > (best.get(st) ?? Infinity) || cost > maxCost) continue;
      const { i, j, d, straight } = decode(st);
      const moves: Dir[] = starts.has(st) ? [d] : straight ? [d] : [d, ((d + 1) % 4) as Dir, ((d + 3) % 4) as Dir];
      for (const m of moves) {
        const ni = i + STEP[m]![0];
        const nj = j + STEP[m]![1];
        if (!this.inBounds(ni, nj)) continue;
        if (this.edges.has(this.edgeKey(i, j, m))) continue;
        const k = pk(ni, nj);
        const nextCost = cost + 1 + (m !== d && !starts.has(st) ? 3 : 0) + (this.soft.has(k) ? 2 : 0);
        if (target(ni, nj, m)) {
          // Found: walk back.
          const path: Vec[] = [[ni, nj], [i, j]];
          let s = st;
          while (!starts.has(s)) {
            s = prev.get(s)!;
            const q = decode(s);
            const last = path[path.length - 1]!;
            if (last[0] !== q.i || last[1] !== q.j) path.push([q.i, q.j]);
          }
          return path.reverse();
        }
        if (this.blocked.has(k) || this.pinAt.has(k) || own.use.has(k) || own.labels.has(k)) continue;
        // Another net's wire: cross it only at right angles where it runs straight through.
        let crossing = false;
        let ok = true;
        for (const [name, other] of this.nets) {
          if (name === net) continue;
          if (other.labels.has(k)) ok = false;
          const om = other.use.get(k);
          if (!om) continue;
          const horizontal = om === (BIT[0]! | BIT[2]!);
          const vertical = om === (BIT[1]! | BIT[3]!);
          if ((m % 2 === 0 && vertical) || (m % 2 === 1 && horizontal)) crossing = true;
          else ok = false;
        }
        if (!ok) continue;
        const ns = state(ni, nj, m, crossing);
        const c = nextCost + (crossing ? 3 : 0);
        if (c < (best.get(ns) ?? Infinity)) {
          best.set(ns, c);
          prev.set(ns, st);
          heap.push(c, ns);
        }
      }
    }
    return undefined;
  }

  /** How the drawing came out, for comparing layouts: grid steps of wire, bends, crossings. */
  readonly stats = { length: 0, bends: 0, crossings: 0 };

  private commit(net: string, path: Vec[]): void {
    const own = this.net(net);
    let last: Dir | undefined;
    for (let n = 0; n + 1 < path.length; n++) {
      const [i, j] = path[n]!;
      const d = dirOf([path[n + 1]![0] - i, path[n + 1]![1] - j]);
      this.stats.length++;
      if (last !== undefined && last !== d) this.stats.bends++;
      last = d;
      if (n > 0) for (const [name, other] of this.nets) if (name !== net && other.use.has(pk(i, j))) this.stats.crossings++;
      this.edges.set(this.edgeKey(i, j, d), net);
      own.use.set(pk(i, j), (own.use.get(pk(i, j)) ?? 0) | BIT[d]!);
      const k2 = pk(path[n + 1]![0], path[n + 1]![1]);
      own.use.set(k2, (own.use.get(k2) ?? 0) | BIT[opposite(d)]!);
    }
  }

  /** Wire a pin to its net's drawing so far (or, the first time, to `first`); false if no way. */
  connect(p: PinPoint, first?: PinPoint, maxLength = Infinity): boolean {
    const own = this.net(p.net);
    const target = first
      ? (i: number, j: number, d: Dir) => i === first.i && j === first.j && d === opposite(first.out)
      : (i: number, j: number, d: Dir) => this.joinable(own, pk(i, j), d);
    const path = this.search(p.net, [{ i: p.i, j: p.j, dirs: [p.out] }], target);
    if (!path || path.length - 1 > maxLength) return false;
    this.commit(p.net, path);
    return true;
  }

  /** Points of a net's drawing a branch may leave from, and the directions it may take. */
  private branchSources(net: string, pins: PinPoint[]): { i: number; j: number; dirs: Dir[] }[] {
    const own = this.net(net);
    const out: { i: number; j: number; dirs: Dir[] }[] = [];
    for (const p of pins) if (!own.use.has(pk(p.i, p.j))) out.push({ i: p.i, j: p.j, dirs: [p.out] });
    for (const [k, m] of own.use) {
      if (own.pins.has(k) || own.labels.has(k) || count(m) >= 3) continue;
      const [i, j] = k.split(',').map(Number) as [number, number];
      out.push({ i, j, dirs: ([0, 1, 2, 3] as Dir[]).filter((d) => !(m & BIT[d]!)) });
    }
    return out;
  }

  /** A net label on a short branch from the net's drawing (or from a lone pin). */
  label(net: string, pins: PinPoint[], text: string): boolean {
    const len = Math.ceil(labelWidth(text) / G) + 1;
    const own = this.net(net);
    const target = (i: number, j: number, d: Dir) => {
      if (!this.free(pk(i, j))) return false;
      // The text runs on from the end, over free points (and the row it sits in).
      const [dx, dy] = STEP[d]!;
      for (let n = 1; n <= len; n++) {
        const a = pk(i + dx * n, j + dy * n);
        const b = d % 2 === 0 ? pk(i + dx * n, j + 1) : pk(i - 1, j + dy * n);
        if (!this.free(a) || !this.free(b)) return false;
      }
      return true;
    };
    const path = this.search(net, this.branchSources(net, pins), target, 60);
    if (!path) return false;
    this.commit(net, path);
    const end = path[path.length - 1]!;
    const before = path[path.length - 2]!;
    own.labels.set(pk(end[0], end[1]), dirOf([end[0] - before[0], end[1] - before[1]]));
    return true;
  }

  /** A supply symbol for a pin: upright, in the nearest free spot, wired to it. */
  supply(p: PinPoint, s: SupplySymbol, name: string): boolean {
    const arrive = dirOf(s.body);
    const target = (i: number, j: number, d: Dir) => {
      if (d !== arrive || !this.free(pk(i, j))) return false;
      const b = { x0: i * G + s.box.x0, y0: j * G + s.box.y0, x1: i * G + s.box.x1, y1: j * G + s.box.y1 };
      return this.cells(b).every((k) => k === pk(i, j) || this.free(k));
    };
    const path = this.search(p.net, [{ i: p.i, j: p.j, dirs: [p.out] }], target, 40);
    if (!path) return false;
    this.commit(p.net, path);
    const [i, j] = path[path.length - 1]!;
    const own = this.net(p.net);
    own.pins.set(pk(i, j), { part: name, gate: s.gate.name, pin: s.pin.name });
    this.supplyGates.push({ name, supply: s, at: [r6(i * G - s.pin.at[0]), r6(j * G - s.pin.at[1])] });
    for (const k of this.cells({ x0: i * G + s.box.x0, y0: j * G + s.box.y0, x1: i * G + s.box.x1, y1: j * G + s.box.y1 })) {
      if (k !== pk(i, j)) this.blocked.add(k);
    }
    return true;
  }

  /** A short stub straight out of a pin with a label at its end: the fallback for any pin. */
  stubLabel(p: PinPoint): void {
    const own = this.net(p.net);
    const [dx, dy] = STEP[p.out]!;
    const path: Vec[] = [[p.i, p.j], [p.i + dx, p.j + dy]];
    this.commit(p.net, path);
    own.labels.set(pk(p.i + dx, p.j + dy), p.out);
  }

  /** Each net's drawing as segments: connected pieces with their wires, junctions and labels. */
  segments(): { net: string; segment: Omit<O.Segment, 'sheet'> }[] {
    const out: { net: string; segment: Omit<O.Segment, 'sheet'> }[] = [];
    for (const [name, net] of this.nets) {
      // Pieces: points joined by wires (pins and labels sit on points).
      const parent = new Map<string, string>();
      const find = (k: string): string => {
        let r = k;
        while (parent.get(r) !== r) r = parent.get(r)!;
        parent.set(k, r);
        return r;
      };
      const add = (k: string) => {
        if (!parent.has(k)) parent.set(k, k);
      };
      for (const k of [...net.use.keys(), ...net.pins.keys(), ...net.labels.keys()]) add(k);
      for (const [k, m] of net.use) {
        const [i, j] = k.split(',').map(Number) as [number, number];
        for (const d of [0, 1] as Dir[]) {
          if (!(m & BIT[d]!)) continue;
          const k2 = pk(i + STEP[d]![0], j + STEP[d]![1]);
          add(k2);
          parent.set(find(k), find(k2));
        }
      }
      const pieces = new Map<string, string[]>();
      for (const k of parent.keys()) pieces.set(find(k), [...(pieces.get(find(k)) ?? []), k]);
      for (const points of pieces.values()) {
        const set = new Set(points);
        // Where a wire must end: pins, labels, junctions, corners, ends.
        const stop = (k: string) => {
          const m = net.use.get(k) ?? 0;
          return net.pins.has(k) || net.labels.has(k) || !(m === 5 || m === 10);
        };
        const wires: O.Wire[] = [];
        for (const k of points) {
          const m = net.use.get(k) ?? 0;
          if (!stop(k)) continue;
          const [i, j] = k.split(',').map(Number) as [number, number];
          for (const d of [0, 1] as Dir[]) {
            if (!(m & BIT[d]!)) continue;
            let [a, b] = [i, j];
            do {
              a += STEP[d]![0];
              b += STEP[d]![1];
            } while (!stop(pk(a, b)));
            wires.push({ line: [[r6(i * G), r6(j * G)], [r6(a * G), r6(b * G)]], width: WIRE });
          }
          // Wires running left or down from a stop to the previous stop are found from that one.
        }
        const pins = points.filter((k) => net.pins.has(k)).map((k) => net.pins.get(k)!);
        const junctions = points.filter((k) => count(net.use.get(k) ?? 0) >= 3).map((k) => k.split(',').map((v) => r6(Number(v) * G)) as O.Pt);
        const seg: Omit<O.Segment, 'sheet'> = { pins, wires, ...(junctions.length ? { junctions } : {}) };
        const labels = points.filter((k) => net.labels.has(k));
        if (labels.length) {
          const pinPts = points.filter((k) => net.pins.has(k)).map((k) => k.split(',').map((v) => r6(Number(v) * G)) as O.Pt);
          seg.labels = labels.map((k) => {
            const [x, y] = k.split(',').map((v) => r6(Number(v) * G)) as [number, number];
            const w = wires.find((w) => w.line.some((e) => e[0] === x && e[1] === y))!;
            return labelFor(seg as O.Segment, w, pinPts);
          });
        }
        // A routing key "NET0001block" is a piece of NET drawn on its own (a rail in one block).
      if (set.size) out.push({ net: name.split(KEY)[0]!, segment: seg });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routing a set of placed gates, and judging the result

/** Where a gate's drawing reaches, room for its stubs and supply symbols included. */
const extentOf = (n: Node): Vec[] => [[n.at[0] + n.box.x0, n.at[1] + n.box.y0 - n.below], [n.at[0] + n.box.x1, n.at[1] + n.box.y1 + n.above]];

/**
 * Route placed gates. A net wholly among them in one block, or in two, is wired; a net in
 * three or more blocks (a rail such as VCCA) or reaching gates not among them is wired within
 * each block and labelled there once. Then a supply symbol at each supply pin, then labels.
 * The score adds wire length, bends, crossings, labels, pins left unwired and area: lower is
 * better.
 */
function routeNodes(nodes: Node[], nets: RNet[], supplies: Map<string, SupplySymbol>, supplyName: (s: SupplySymbol) => string): { router: Router; extent: Box; score: number } {
  const extent = boxOf(nodes.flatMap(extentOf));
  const router = new Router(extent);
  const blockOfPart = new Map(nodes.map((n) => [n.part.part.name, n.part.block]));
  const policy = new Map<string, { whole: boolean }>();
  for (const net of nets) {
    if (net.supply) continue;
    const here = new Set(net.pins.filter((r) => blockOfPart.has(r.part)).map((r) => blockOfPart.get(r.part)!));
    const elsewhere = net.pins.some((r) => !blockOfPart.has(r.part));
    policy.set(net.name, { whole: !elsewhere && here.size <= 2 });
  }
  const keyOf = (net: RNet, block: string) => (net.supply || policy.get(net.name)!.whole ? net.name : `${net.name}${KEY}${block}`);

  const pins: PinPoint[] = [];
  const offGrid: PinPoint[] = [];
  for (const n of nodes) {
    router.addGate(
      { x0: n.at[0] + n.body.x0, y0: n.at[1] + n.body.y0, x1: n.at[0] + n.body.x1, y1: n.at[1] + n.body.y1 },
      textBoxes(n.symbol).map((t) => rotBox(t, n.rot)).map((b) => ({ x0: n.at[0] + b.x0, y0: n.at[1] + b.y0, x1: n.at[0] + b.x1, y1: n.at[1] + b.y1 })),
    );
    for (const p of n.pins) {
      if (!p.net) continue;
      const x = n.at[0] + p.local[0];
      const y = n.at[1] + p.local[1];
      const pp: PinPoint = { ref: p.ref, net: keyOf(p.net, n.part.block), out: dirOf(OUT[p.side]), i: Math.round(x / G), j: Math.round(y / G) };
      if (onGrid(x) && onGrid(y)) {
        router.addPin(pp);
        pins.push(pp);
      } else offGrid.push(pp);
    }
  }
  const byKey = new Map<string, PinPoint[]>();
  for (const p of pins) byKey.set(p.net, [...(byKey.get(p.net) ?? []), p]);
  const rnet = new Map(nets.map((n) => [n.name, n]));
  const real = (key: string) => rnet.get(key.split(KEY)[0]!)!;
  const span = (ps: PinPoint[]) => Math.max(...ps.map((p) => p.i)) - Math.min(...ps.map((p) => p.i)) + Math.max(...ps.map((p) => p.j)) - Math.min(...ps.map((p) => p.j));
  const signal = [...byKey].filter(([k]) => !real(k).supply).sort((a, b) => span(a[1]) - span(b[1]));

  let labels = 0;
  const unrouted: PinPoint[] = [];
  const brokenKeys = new Set<string>();
  for (const [key, ps] of signal) {
    // A net between two blocks is wired only if the wire stays reasonably short.
    const blocks = new Set(ps.map((p) => blockOfPart.get(p.ref.part)));
    const limit = blocks.size > 1 ? 2 * span(ps) + 12 : Infinity;
    const order = [...ps].sort((a, b) => a.i - b.i || b.j - a.j);
    const first = order[0]!;
    let connected = 0;
    for (const p of order.slice(1)) {
      if (router.connect(p, connected === 0 ? first : undefined, limit)) connected++;
      else {
        unrouted.push(p);
        brokenKeys.add(key);
      }
    }
    if (!connected && order.length > 1) unrouted.push(first);
  }
  for (const [key, ps] of byKey) {
    const net = real(key);
    if (!net.supply) continue;
    for (const p of ps) {
      const s = supplies.get(net.name);
      if (!s || !router.supply(p, s, supplyName(s))) unrouted.push(p);
    }
  }
  // Labels: a piece of a net drawn on its own (a rail's, a net leaving these gates), a net cut
  // short, a lone pin; then a label at each pin left unwired.
  for (const [key, ps] of signal) {
    const lone = ps.length === 1 && !unrouted.includes(ps[0]!);
    const drawn = ps.filter((p) => !unrouted.includes(p));
    if ((key.includes(KEY) || brokenKeys.has(key) || lone) && drawn.length) {
      if (router.label(key, drawn, real(key).name)) labels++;
      else for (const p of drawn) if (!unrouted.includes(p)) unrouted.push(p);
    }
  }
  for (const p of unrouted) {
    if (!router.label(p.net, [p], real(p.net).name)) router.stubLabel(p);
    labels++;
  }
  for (const p of offGrid) {
    router.stubLabel(p);
    labels++;
  }
  let backwards = 0;
  const where = new Map<string, number>();
  for (const n of nodes) for (const p of n.pins) where.set(`${p.ref.part}.${p.ref.gate}.${p.ref.pin}`, n.at[0] + p.local[0]);
  for (const n of nodes) {
    for (const p of n.pins) {
      if (p.pin.direction !== 'out' || !p.net) continue;
      for (const q of nodes) for (const r of q.pins) if (r.net === p.net && r.pin.direction === 'in') backwards += Math.max(0, (where.get(`${p.ref.part}.${p.ref.gate}.${p.ref.pin}`)! - (q.at[0] + r.local[0])) / G);
    }
  }
  const s = router.stats;
  const area = ((extent.x1 - extent.x0) / G) * ((extent.y1 - extent.y0) / G);
  return { router, extent, score: s.length + 4 * s.bends + 8 * s.crossings + 30 * labels + 60 * unrouted.length + area / 40 + 2 * backwards };
}

/** A block laid out the best of several ways: each signal gate as the start, flipped or not. */
function bestPlacement(parts: RPart[], nets: RNet[], supplies: Map<string, SupplySymbol>): BlockPlacement {
  let best: { placement: BlockPlacement; score: number } | undefined;
  const starts = Math.min(8, new BlockPlacement(parts, nets, supplies).starts);
  for (let start = 0; start < starts; start++) {
    for (const flip of [true, false]) {
      const placement = new BlockPlacement(parts, nets, supplies);
      placement.place(start, flip);
      if (!placement.nodes.length) return placement;
      const { score } = routeNodes(placement.nodes, nets, supplies, () => 'S');
      if (!best || score < best.score) best = { placement, score };
    }
  }
  return best!.placement;
}

/**
 * Arrange a group's blocks: the first where it is; each next one beside the block it connects
 * to most (by nets between just the two), on the side and at the height that brings the pins
 * closest, slid along that side until it is clear of the others. A block with no such link
 * goes to the right of the rest.
 */
function arrange(placements: { block: string; placement: BlockPlacement }[], netBlocks: Map<string, Set<string>>): void {
  const placed: { block: string; box: Box }[] = [];
  const pinsAt = new Map<string, { at: Vec; side: Side }>();
  const local = (n: Node, p: PinInfo): Vec => [n.at[0] + p.local[0], n.at[1] + p.local[1]];
  const clear = (b: Box) => placed.every(({ box }) => b.x1 + INNER_GAP <= box.x0 || box.x1 + INNER_GAP <= b.x0 || b.y1 + INNER_GAP <= box.y0 || box.y1 + INNER_GAP <= b.y0);
  const shift = (b: Box, d: Vec): Box => ({ x0: b.x0 + d[0], y0: b.y0 + d[1], x1: b.x1 + d[0], y1: b.y1 + d[1] });
  for (const { block, placement } of placements) {
    const nodes = placement.nodes;
    if (!nodes.length) continue;
    const box = boxOf(nodes.flatMap(extentOf));
    // Links: this block's pins on a net shared with exactly one block placed before it.
    const links: { from: Vec; to: Vec; side: Side; block: string }[] = [];
    for (const n of nodes) {
      for (const p of n.pins) {
        if (!p.net || p.net.supply) continue;
        const bs = netBlocks.get(p.net.name)!;
        if (bs.size !== 2) continue;
        for (const r of p.net.pins) {
          const to = pinsAt.get(`${r.part}.${r.gate}.${r.pin}`);
          const other = placed.find((x) => x.block !== block && bs.has(x.block));
          if (to && other) links.push({ from: local(n, p), to: to.at, side: to.side, block: other.block });
        }
      }
    }
    let offset: Vec = [0, 0];
    if (placed.length && !links.length) {
      const all = boxOf(placed.flatMap(({ box: b }) => [[b.x0, b.y0], [b.x1, b.y1]] as Vec[]));
      offset = [all.x1 + INNER_GAP - box.x0, all.y1 - box.y1];
    } else if (links.length) {
      const counts = new Map<string, number>();
      for (const l of links) counts.set(l.block, (counts.get(l.block) ?? 0) + 1);
      const target = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      const tb = placed.find((x) => x.block === target)!.box;
      const mean = (vs: Vec[]): Vec => [vs.reduce((s, v) => s + v[0], 0) / vs.length, vs.reduce((s, v) => s + v[1], 0) / vs.length];
      const [px, py] = mean(links.map((l) => l.from));
      const [tx, ty] = mean(links.map((l) => l.to));
      // The side the linked pins face is best; else right (signal flows on), left, below, above.
      const facing = new Map<Side, number>();
      // (A pin on top or bottom, a transistor's collector, says little: such a link counts for right.)
      for (const l of links) {
        const side: Side = l.side === 'L' ? 'L' : 'R';
        facing.set(side, (facing.get(side) ?? 0) + 1);
      }
      const face = [...facing].sort((a, b) => b[1] - a[1])[0]![0];
      const bias = (side: Side, fallback: number) => (side === face ? 0 : fallback);
      const sides: { d: Vec; along: Vec; bias: number }[] = [
        { d: [tb.x1 + INNER_GAP - box.x0, ty - py], along: [0, 1], bias: bias('R', 10) },
        { d: [tb.x0 - INNER_GAP - box.x1, ty - py], along: [0, 1], bias: bias('L', 15) },
        { d: [tx - px, tb.y0 - INNER_GAP - box.y1], along: [1, 0], bias: bias('B', 25) },
        { d: [tx - px, tb.y1 + INNER_GAP - box.y0], along: [1, 0], bias: bias('T', 35) },
      ];
      let best: { d: Vec; cost: number } | undefined;
      for (const side of sides) {
        for (let k = 0; k < 120; k++) {
          const slide = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * G;
          const d: Vec = [snap(side.d[0] + side.along[0] * slide), snap(side.d[1] + side.along[1] * slide)];
          if (!clear(shift(box, d))) continue;
          const cost = links.reduce((s, l) => s + Math.abs(l.from[0] + d[0] - l.to[0]) + Math.abs(l.from[1] + d[1] - l.to[1]), 0) / G / links.length + side.bias;
          if (!best || cost < best.cost) best = { d, cost };
          break;
        }
      }
      if (best) offset = best.d;
    }
    offset = [snap(offset[0]), snap(offset[1])];
    for (const n of nodes) {
      n.at = [r6(n.at[0] + offset[0]), r6(n.at[1] + offset[1])];
      for (const p of n.pins) pinsAt.set(`${p.ref.part}.${p.ref.gate}.${p.ref.pin}`, { at: local(n, p), side: p.side });
    }
    placed.push({ block, box: shift(box, offset) });
  }
}

/** Build a project (schematic, board with footprints parked beside it) from a resolved description. */
export function generateProject(design: Resolved): O.Project {
  const supplies = new Map<string, SupplySymbol>();
  const supplySource = new Map<string, O.Library>();
  for (const [net, s] of design.supplies) {
    supplies.set(net, supplySymbol(s.component, s.source));
    supplySource.set(s.component.id, s.source);
  }

  const [w, h] = [50, 40];
  const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
  const project: O.Project = {
    osprey: FORMAT_VERSION, project: { name: design.name },
    library: { symbols: [], footprints: [], components: [] }, parts: [], nets: [],
    schematic: { grid: { step: 2.54, fine: 0.254, unit: 'inch' }, sheets: [{ id: '1', gates: [], drawing: [] }] },
    board: {
      grid: { step: 0.635, fine: 0.127, unit: 'mm' }, layers: ['copper.top', 'copper.bottom'], footprints: [],
      drawing: corners.map((a, i) => ({ line: [a, corners[(i + 1) % 4]!], width: 0, layer: 'outline' })),
    },
  };
  const tx = new Transaction('Generate');
  for (const p of design.parts) {
    addToLibrary(project, p.source, p.component.id, tx);
    insertPart(project, structuredClone(p.part), p.component, tx);
  }
  for (const [id, source] of supplySource) addToLibrary(project, source, id, tx);

  // Groups: a top-level block and the blocks inside it (its own parts first), side by side.
  const blocks = [...design.blocks, ...(design.parts.some((p) => !p.block) ? [''] : [])];
  const top = (b: string) => b.split('/')[0]!;
  const groups: string[][] = [];
  for (const t of [...new Set(blocks.map(top))]) groups.push([...blocks.filter((b) => b === t), ...blocks.filter((b) => b !== t && top(b) === t)]);

  let supplyCount = 0;
  const sheet = project.schematic!.sheets[0]!;
  const nets = new Map<string, O.Net>();
  const netOf = (name: string) => {
    let n = nets.get(name);
    if (!n) nets.set(name, (n = { name, segments: [] }));
    return n;
  };
  for (const n of design.nets) netOf(n.name);

  let sheetX = 0;
  let rowTop = 0;
  let rowBottom = 0;
  // How many blocks each net has pins in (a rail through three or more is labelled per block).
  const partBlock = new Map(design.parts.map((p) => [p.part.name, p.block]));
  const netBlocks = new Map(design.nets.map((n) => [n.name, new Set(n.pins.map((r) => partBlock.get(r.part)).filter((b): b is string => b !== undefined))]));

  groups.forEach((group) => {
    // Each block laid out the best of several ways; then the group's blocks arranged, each
    // beside what it connects to.
    const placements = group.map((b) => ({ block: b, placement: bestPlacement(design.parts.filter((p) => p.block === b), design.nets, supplies) }));
    arrange(placements, netBlocks);
    const nodes = placements.flatMap((x) => x.placement.nodes);
    const { router, extent } = routeNodes(nodes, design.nets, supplies, (s) => `${s.component.prefix || 'SUPPLY'}${++supplyCount}`);

    // The group's drawing, moved to its place on the sheet.
    const segments = router.segments();
    const pts: Vec[] = [[extent.x0, extent.y0], [extent.x1, extent.y1]];
    for (const { segment } of segments) {
      for (const wr of segment.wires) pts.push(wr.line[0], wr.line[1]);
      for (const l of segment.labels ?? []) pts.push([l.at[0] + (l.align === 'bottom-right' ? -1 : 1) * labelWidth(''), l.at[1] + G]);
    }
    for (const sg of router.supplyGates) pts.push([sg.at[0] + sg.supply.box.x0 + sg.supply.pin.at[0], sg.at[1] + sg.supply.box.y0 + sg.supply.pin.at[1]]);
    const gb = boxOf(pts);
    const gw = gb.x1 - gb.x0;
    if (sheetX > 0 && sheetX + gw > SHEET_WIDTH) {
      sheetX = 0;
      rowTop = rowBottom - BLOCK_GAP;
    }
    const dx = snap(sheetX - gb.x0);
    const dy = snap(rowTop - gb.y1);
    const move = (p: O.Pt): O.Pt => [r6(p[0] + dx), r6(p[1] + dy)];
    for (const n of nodes) sheet.gates.push({ part: n.part.part.name, gate: n.gate.name, at: move(n.at), ...(n.rot ? { rot: n.rot } : {}) });
    for (const sg of router.supplyGates) {
      project.parts.push({ name: sg.name, component: sg.supply.component.id, variant: sg.supply.component.variants[0]?.name ?? '' });
      sheet.gates.push({ part: sg.name, gate: sg.supply.gate.name, at: move(sg.at) });
    }
    for (const { net, segment } of segments) {
      netOf(net).segments!.push({
        sheet: '1',
        pins: segment.pins,
        wires: segment.wires.map((wr) => ({ ...wr, line: [move(wr.line[0]), move(wr.line[1])] })),
        ...(segment.junctions ? { junctions: segment.junctions.map(move) } : {}),
        ...(segment.labels ? { labels: segment.labels.map((l) => ({ ...l, at: move(l.at) })) } : {}),
      });
    }
    sheetX = snap(sheetX + gw + BLOCK_GAP);
    rowBottom = Math.min(rowBottom, dy + gb.y0);
  });

  // Sheet coordinates from the origin up, as Eagle's are.
  const lift = snap(-rowBottom + 2 * G);
  const shift = (p: O.Pt): O.Pt => [r6(p[0] + 2 * G), r6(p[1] + lift)];
  for (const g of sheet.gates) g.at = shift(g.at);
  for (const n of nets.values()) {
    for (const s of n.segments!) {
      for (const wr of s.wires) wr.line = [shift(wr.line[0]), shift(wr.line[1])];
      if (s.junctions) s.junctions = s.junctions.map(shift);
      if (s.labels) for (const l of s.labels) l.at = shift(l.at);
    }
  }
  project.nets = [...nets.values()].filter((n) => n.segments!.length);
  return project;
}
