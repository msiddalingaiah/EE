// Drawing a schematic from a resolved block description (description.ts).
//
// Placement, as a person lays out a sheet (layoutSheet): the signal row across the top, the path
// from the input to the main IC on one line, each stage's other parts hanging below it (or above,
// nearer the supply); the blocks off the path (power, an oscillator, an MCU's outputs) in a band
// below, each under what it connects to. Within a block, gates stand in columns by signal flow,
// in the description's order. Parts in parallel stand side by side; two-pin parts on a supply
// stand upright; a series part lies across.
//
// Wiring: a grid router (Router, below) draws the sheet as one connected circuit: orthogonal
// wires around the symbols, joining a net's tree only in T's (never four ways, never pin to
// pin), crossing other nets only straight through. Every supply pin gets its own supply symbol,
// upright, in the nearest free spot. Only a net that leaves the group gets a net label, one per
// group; a pin the router can't reach gets a label too (nets connect by name).

import { labelFor } from '../edit/netlabels';
import { Transaction } from '../edit/ops';
import { addToLibrary, insertPart } from '../edit/place';
import type * as O from '../model/types';
import { FORMAT_VERSION } from '../model/types';
import { isConnector } from '../model/suggest-blocks';
import type { RNet, RPart, Resolved } from './description';

const G = 2.54;
const WIRE = 0.1524;
const LABEL_SIZE = 1.778;
/** Between parts stacked in a column, and around a column: room for wires and symbols. */
const GAP_Y = 3 * G;
const BLOCK_GAP = 8 * G;
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
function sideOf(pin: O.Pin, gateRot: number, mirror = false): Side {
  const r = (pin.rot ?? 0) + gateRot;
  const a = (((mirror ? 180 - r : r) % 360) + 360) % 360;
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
  /** Mirrored (after rotating, x negated, as Eagle's MR). */
  mirror: boolean;
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
  /** In a signal row: the path's gates, all at one height; the rest hang above or below. */
  private path?: Set<Node>;

  constructor(
    parts: RPart[],
    nets: RNet[],
    private readonly supplies: Map<string, SupplySymbol>,
    /** Each net's height in the circuit: 1 on the supply drawn above (VCC), 0 on ground. */
    private readonly potential: Map<string, number> = new Map(),
    /** Nets drawn as rails (VCCA): like a supply, they don't make parts neighbours. */
    private readonly rails: Set<string> = new Set(),
  ) {
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
        const node: Node = { part: p, gate: g, symbol, order: order++, powerOnly, rot: 0, mirror: false, pins, body: rotBox(bodyPoints(symbol), 0), box: { x0: 0, y0: 0, x1: 0, y1: 0 }, col: 0, above: 0, below: 0, at: [0, 0] };
        this.setRot(node, 0);
        this.nodes.push(node);
      }
    }
  }

  private setRot(n: Node, deg: number, mirror = false): void {
    n.rot = ((deg % 360) + 360) % 360;
    n.mirror = mirror;
    const place = (q: Vec): Vec => {
      const r = rot(q, n.rot);
      return mirror ? [-r[0], r[1]] : r;
    };
    n.body = boxOf(bodyPoints(n.symbol).map(place));
    n.box = boxOf([...bodyPoints(n.symbol), ...textBoxes(n.symbol).flat()].map(place));
    for (const p of n.pins) {
      p.local = place([p.pin.at[0], p.pin.at[1]]);
      p.side = sideOf(p.pin, n.rot, mirror);
    }
  }

  /** Which way a supply's symbol hangs: ground below (pin at the bottom), others above. */
  private supplyDown(net: RNet): boolean {
    const s = this.supplies.get(net.name);
    return !s || s.body[1] < 0;
  }

  /** Gates sharing a signal net with n (not a supply or a rail). */
  neighbours(n: Node): Node[] {
    const out = new Set<Node>();
    for (const p of n.pins) {
      if (!p.net || p.net.supply || this.rails.has(p.net.name)) continue;
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
    this.orient();
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
    this.layout(flip);
  }

  /** Place the gates in the columns given (any numbers: only their order counts). */
  placeIn(cols: Map<Node, number>, path: Node[], flip = true): void {
    this.path = new Set(path);
    this.orient();
    const values = [...new Set(cols.values())].sort((a, b) => a - b);
    for (const n of this.nodes) n.col = Math.max(0, values.indexOf(cols.get(n) ?? values[0] ?? 0));
    this.layout(flip);
  }

  /** Two-pin parts on a supply (a pin on each side: a resistor, a capacitor) stand upright, the supply pin down (ground) or up. */
  private orient(): void {
    for (const n of this.nodes) {
      if (n.pins.length !== 2 || new Set(n.pins.map((p) => p.side)).size !== 2 || n.pins.some((p) => p.side === 'T' || p.side === 'B')) continue;
      const sup = n.pins.filter((p) => p.net?.supply);
      if (!sup.length) continue;
      const s = sup.find((p) => this.supplyDown(p.net!)) ?? sup[0]!;
      const want: Side = this.supplyDown(s.net!) || sup.length === 2 ? 'B' : 'T';
      for (const deg of [90, 270]) if (sideOf(s.pin, deg) === want) this.setRot(n, deg);
    }
  }

  /**
   * Parts in parallel (on the same two nets, not both supplies: L1 and C4 across a tank, a
   * bypass capacitor across an emitter resistor) stand side by side: each follower in a column
   * of its own just beside its anchor (the part with more pins, else the one listed first),
   * turned the same way. Returns each follower's anchor and the net to line up.
   */
  private pairParallel(): Map<Node, { anchor: Node; net: string }> {
    const out = new Map<Node, { anchor: Node; net: string }>();
    const netsOf = (n: Node) => [...new Set(n.pins.filter((p) => p.net).map((p) => p.net!))];
    const key = (n: Node) => netsOf(n).map((x) => x.name).sort().join(KEY);
    const groups = new Map<string, Node[]>();
    for (const n of this.nodes) {
      const nets = netsOf(n);
      if (nets.length !== 2 || nets.every((x) => x.supply)) continue;
      groups.set(key(n), [...(groups.get(key(n)) ?? []), n]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const anchor = [...group].sort((a, b) => b.pins.length - a.pins.length || a.order - b.order)[0]!;
      // A connector isn't drawn beside the part across it: that part hangs from the wire.
      if (isConnector(anchor.part.component)) continue;
      // The net to line up: the one on the anchor's upper pin.
      const top = [...anchor.pins.filter((p) => p.net)].sort((a, b) => b.local[1] - a.local[1])[0]!;
      const net = top.net!.name;
      const followers = group.filter((n) => n !== anchor);
      followers.forEach((f, k) => {
        // Turned so its two pins lie the way the anchor's do (net above net, or left of it).
        if (f.pins.length === 2) {
          const mean = (ps: PinInfo[]): Vec => [ps.reduce((a, p) => a + p.local[0], 0) / ps.length, ps.reduce((a, p) => a + p.local[1], 0) / ps.length];
          const a = mean(anchor.pins.filter((p) => p.net?.name === net));
          const b = mean(anchor.pins.filter((p) => p.net && p.net.name !== net));
          const want: Side = Math.abs(a[1] - b[1]) >= Math.abs(a[0] - b[0]) ? (a[1] > b[1] ? "T" : "B") : a[0] > b[0] ? "R" : "L";
          for (const deg of [f.rot, 90, 270, 0, 180]) {
            this.setRot(f, deg);
            if (f.pins.find((p) => p.net?.name === net)!.side === want) break;
          }
        }
        const step = 0.5 * (k + 1) / followers.length;
        f.col = anchor.col + (f.order < anchor.order ? -step : step);
        out.set(f, { anchor, net });
      });
    }
    if (out.size) {
      const values = [...new Set(this.nodes.map((n) => n.col))].sort((a, b) => a - b);
      for (const n of this.nodes) n.col = values.indexOf(n.col);
    }
    return out;
  }

  /** Room above and below a gate for stubs and upright supply symbols. */
  private room(n: Node): void {
    n.above = 0;
    n.below = 0;
    for (const p of n.pins) {
      if (p.side !== 'T' && p.side !== 'B') continue;
      const s = p.net?.supply ? this.supplies.get(p.net.name) : undefined;
      const need = 2 * G + (s ? Math.max(s.box.y1 - s.box.y0, s.box.x1 - s.box.x0) : 0);
      const edge = p.side === 'T' ? n.box.y1 - p.local[1] : p.local[1] - n.box.y0;
      if (p.side === 'T') n.above = Math.max(n.above, need - edge);
      else n.below = Math.max(n.below, need - edge);
    }
  }

  /** Gates placed with a feedback loop rather than in a column. */
  private readonly riding = new Set<Node>();

  /**
   * Feedback loops, drawn as a person draws an oscillator: for a gate with one input and one
   * output (an inverter), the parts across them (R11) above it from input to output; the
   * return path from its output back to its input through two-pin parts (R12, X1) in a row
   * below it, right to left; and the parts from that path to a supply (C9, C10) hanging from
   * it. Returns each such part with its gate and its place relative to the gate.
   */
  private loops(): Map<Node, { gate: Node; at: Vec }> {
    const out = new Map<Node, { gate: Node; at: Vec }>();
    const nodeOf = (r: O.PinRef) => this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate);
    const on = (net: RNet) => net.pins.map(nodeOf).filter((x): x is Node => !!x);
    const twoPin = (n: Node) => n.pins.length === 2 && n.part.component.gates.length === 1 && n.pins.every((p) => p.net) && n.pins[0]!.net !== n.pins[1]!.net;
    const pinOn = (n: Node, net: RNet) => n.pins.find((p) => p.net === net)!;
    const turn = (n: Node, net: RNet, side: Side) => {
      for (const deg of [0, 90, 180, 270]) {
        this.setRot(n, deg);
        if (pinOn(n, net).side === side) break;
      }
      this.room(n);
    };
    const snapUp = (v: number) => r6(Math.ceil(v / G - 1e-6) * G);
    for (const g of this.nodes) {
      if (out.has(g) || g.rot !== 0) continue;
      const ins = g.pins.filter((p) => p.pin.direction === 'in' && p.net && !p.net.supply);
      const outs = g.pins.filter((p) => p.pin.direction === 'out' && p.net && !p.net.supply);
      if (ins.length !== 1 || outs.length !== 1 || ins[0]!.side !== 'L' || outs[0]!.side !== 'R') continue;
      const pi = ins[0]!;
      const po = outs[0]!;
      const A = pi.net!;
      const B = po.net!;
      const free = (n: Node) => n !== g && !out.has(n) && twoPin(n) && !this.path?.has(n);
      const feedback = on(A).filter((n) => free(n) && n.pins.some((p) => p.net === B));
      // The return path: breadth first from the output's net to the input's.
      const prev = new Map<RNet, { part: Node; from: RNet }>();
      const queue = [B];
      const seen = new Set<RNet>([B]);
      while (queue.length && !prev.has(A)) {
        const net = queue.shift()!;
        for (const n of on(net)) {
          if (!free(n) || feedback.includes(n)) continue;
          const other = n.pins.find((p) => p.net !== net)!.net!;
          if (other.supply || seen.has(other)) continue;
          seen.add(other);
          prev.set(other, { part: n, from: net });
          queue.push(other);
        }
      }
      const chain: { part: Node; from: RNet; to: RNet }[] = [];
      if (prev.has(A)) for (let net = A; net !== B; net = prev.get(net)!.from) chain.unshift({ part: prev.get(net)!.part, from: prev.get(net)!.from, to: net });
      if (!feedback.length && !chain.length) continue;

      // Above: the feedback parts, the input's pin on the left, stacked up.
      let top = g.box.y1 + G;
      for (const f of feedback) {
        turn(f, A, 'L');
        const a = pinOn(f, A).local;
        const b = pinOn(f, B).local;
        const y = snapUp(top + f.below - f.box.y0);
        out.set(f, { gate: g, at: [snap((pi.local[0] + po.local[0]) / 2 - (a[0] + b[0]) / 2), y] });
        top = y + f.box.y1 + f.above;
      }
      if (!chain.length) continue;
      // Below: the return path in a row, from the output side leftwards, pins in line.
      for (const c of chain) turn(c.part, c.from, 'R');
      const row = Math.min(...chain.map((c) => snapDown(g.box.y0 - 2 * G - (c.part.box.y1 - pinOn(c.part, c.from).local[1]))));
      let x = po.local[0] + 2 * G;
      const shuntAt = new Map<RNet, number>();
      for (const c of chain) {
        const r = pinOn(c.part, c.from).local;
        const at: Vec = [snap(x - r[0]), r6(row - r[1])];
        out.set(c.part, { gate: g, at });
        const left = at[0] + pinOn(c.part, c.to).local[0];
        shuntAt.set(c.to, left - 2 * G);
        x = left - 4 * G;
      }
      // Hanging from the path: parts from its nets to a supply.
      for (const [net, sx] of shuntAt) {
        let at = sx;
        for (const n of on(net)) {
          if (!free(n) || out.has(n) || !n.pins.some((p) => p.net !== net && p.net!.supply)) continue;
          turn(n, net, 'T');
          const t = pinOn(n, net).local;
          out.set(n, { gate: g, at: [snap(at - t[0]), r6(row - 2 * G - t[1])] });
          at -= 3 * G;
        }
      }
    }
    for (const n of out.keys()) this.riding.add(n);
    return out;
  }

  /** Rows, bands and x, once each gate has its column. */
  private layout(flip: boolean): void {
    const signal = this.nodes.filter((n) => !n.powerOnly);
    // A gate with only supply pins: a power gate goes with the part's other gates; a decoupling
    // capacitor (a part of its own) with the IC whose supply it is on, right after it.
    // A separate power gate (a logic IC's VCC and GND) stands in a column of its own after
    // the rest, its decoupling capacitor with it.
    const anchors = new Map<Node, Node>();
    const powerCol = Math.max(0, ...signal.map((x) => x.col)) + 1;
    for (const n of this.nodes) {
      if (!n.powerOnly) continue;
      const sibling = signal.find((x) => x.part === n.part);
      if (sibling) {
        n.col = powerCol;
        continue;
      }
      const supplies = new Set(n.pins.filter((p) => p.net?.supply).map((p) => p.net!.name));
      const anchor = signal.find((m) => (m.part.component.gates.length > 1 || m.pins.length >= 3)
        && this.nodes.some((g) => g.part === m.part && g.pins.some((p) => p.net && supplies.has(p.net.name))));
      const gate = anchor && this.nodes.find((g) => g.part === anchor.part && g.powerOnly);
      n.col = gate ? gate.col : anchor?.col ?? 0;
      if (gate) anchors.set(n, gate);
      else if (anchor) anchors.set(n, anchor);
    }

    // Two-pin parts off the supplies: lying across when they join parts in other columns (a
    // coupling capacitor, a series resistor), the pin toward the earlier column on the left;
    // standing upright when they hang in their column (an emitter resistor under its
    // transistor), the pin toward the part listed first on top.
    for (const n of flip ? signal : []) {
      if (n.pins.length !== 2 || n.part.component.gates.length !== 1 || n.pins.some((p) => !p.net || p.net.supply || p.pin.direction === 'in' || p.pin.direction === 'out') || n.pins[0]!.net === n.pins[1]!.net) continue;
      const others = (p: PinInfo) => (p.net?.pins ?? []).map((r) => this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate)).filter((x): x is Node => !!x && x !== n);
      const [p, q] = n.pins as [PinInfo, PinInfo];
      const a = others(p).map((x) => x.col);
      const b = others(q).map((x) => x.col);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : n.col);
      const apart = (xs: number[]) => xs.length > 0 && xs.every((c) => c !== n.col);
      const across = (apart(a) || apart(b)) && avg(a) !== avg(b);
      const turn = (pin: PinInfo, side: Side) => {
        for (const deg of [0, 90, 180, 270]) {
          this.setRot(n, deg);
          if (pin.side === side) return;
        }
      };
      if (across) turn(avg(a) <= avg(b) ? p : q, 'L');
      else {
        const first = (xs: Node[]) => Math.min(Infinity, ...xs.map((x) => x.order));
        turn(first(others(p)) <= first(others(q)) ? p : q, 'T');
      }
    }

    const nodeOf = (r: O.PinRef) => this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate);
    const shunt = (n: Node) => n.pins.length === 2 && n.part.component.gates.length === 1
      && n.pins.filter((p) => p.net?.supply).length === 1 && n.pins.filter((p) => p.net && !p.net.supply).length === 1;
    // In a block, a part from a junction to a supply (a filter's capacitor) hangs between the
    // two parts the junction joins.
    if (!this.path) {
      let moved = false;
      for (const n of signal) {
        if (!shunt(n)) continue;
        const net = n.pins.find((p) => p.net && !p.net.supply)!.net!;
        const cols = [...new Set(net.pins.map(nodeOf).filter((x): x is Node => !!x && x !== n && !shunt(x)).map((x) => x.col))].sort((a, b) => a - b);
        if (cols.length < 2) continue;
        n.col = cols[0]! + 0.5;
        moved = true;
      }
      if (moved) {
        const values = [...new Set(this.nodes.map((n) => n.col))].sort((a, b) => a - b);
        for (const n of this.nodes) n.col = values.indexOf(n.col);
      }
    }
    // A connector at the end of the signal (its pins all facing on, what they join all before
    // it) turned to face back toward it.
    for (const n of signal) {
      if (!isConnector(n.part.component) || n.pins.length < 2 || !n.pins.every((p) => p.side === 'R')) continue;
      const cols = n.pins.filter((p) => p.net && !p.net.supply).flatMap((p) => p.net!.pins.map(nodeOf)).filter((x): x is Node => !!x && x !== n).map((x) => x.col);
      if (cols.length && cols.every((c) => c < n.col)) this.setRot(n, n.rot, true);
    }

    // A part on a rail with other pins too (L1 in a tank) turned to put its rail pins on top,
    // toward the rail.
    for (const n of this.nodes) {
      if (this.path?.has(n) || n.pins.length < 3 || n.part.component.gates.length !== 1) continue;
      const railPins = n.pins.filter((p) => p.net && this.rails.has(p.net.name));
      const others = n.pins.filter((p) => p.net && !p.net.supply && !this.rails.has(p.net.name));
      if (!railPins.length || !others.length) continue;
      const ways = [[0, false], [180, true], [180, false], [0, true]] as const;
      const fits = ways.filter(([deg, m]) => {
        this.setRot(n, deg, m);
        return Math.min(...railPins.map((p) => p.local[1])) > Math.max(...others.map((p) => p.local[1]));
      });
      const left = fits.find(([deg, m]) => {
        this.setRot(n, deg, m);
        return others.every((p) => p.side === 'L');
      });
      const [deg, m] = left ?? fits[0] ?? ways[0];
      this.setRot(n, deg, m);
    }

    const parallel = this.pairParallel();
    // A power gate's decoupling capacitor stands beside it, level with it.
    let besides = false;
    for (const [cap, gate] of anchors) {
      if (!gate.powerOnly) continue;
      const shared = gate.pins.filter((p) => p.net && cap.pins.some((q) => q.net === p.net)).sort((a, b) => b.local[1] - a.local[1])[0];
      if (!shared) continue;
      cap.col = gate.col + 0.5;
      parallel.set(cap, { anchor: gate, net: shared.net!.name });
      besides = true;
    }
    if (besides) {
      const values = [...new Set(this.nodes.map((n) => n.col))].sort((a, b) => a - b);
      for (const n of this.nodes) n.col = values.indexOf(n.col);
    }

    const columns: Node[][] = [];
    for (const n of [...this.nodes].sort((a, b) => a.order - b.order)) (columns[n.col] ??= []).push(n);
    for (let c = 0; c < columns.length; c++) columns[c] ??= [];
    // Each column from top to bottom as the circuit goes from the supply to ground (a collector
    // load above its transistor, the emitter resistor below), then by its neighbours in the
    // column before.
    const level = (n: Node) => {
      const ps = n.pins.filter((p) => p.net).map((p) => this.potential.get(p.net!.name) ?? 0.5);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.5;
    };
    for (let c = 0; c < columns.length; c++) {
      const prev = columns[c - 1];
      const rank = (n: Node) => {
        const ns = prev ? this.neighbours(n).filter((m) => m.col === c - 1).map((m) => prev.indexOf(m)) : [];
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 1e9;
      };
      columns[c] = columns[c]!.map((n, i) => ({ n, l: Math.round(level(n) * 4), k: rank(n), i }))
        .sort((a, b) => (b.l - a.l) || (a.k - b.k) || (a.i - b.i)).map((x) => x.n);
      // Decoupling capacitors right below their IC (after its other gates).
      for (const [cap, ic] of anchors) {
        const col = columns[c]!;
        if (!col.includes(cap)) continue;
        col.splice(col.indexOf(cap), 1);
        const last = Math.max(...col.map((n, i) => (n.part === ic.part ? i : -1)));
        col.splice(last + 1, 0, cap);
      }
    }

    for (const n of this.nodes) this.room(n);

    // Feedback loops ride with their gate, out of the columns.
    const riders = this.loops();
    if (riders.size) {
      for (const [r, { gate, at }] of riders) {
        const b = gate.box;
        gate.box = {
          x0: Math.min(b.x0, at[0] + r.box.x0), x1: Math.max(b.x1, at[0] + r.box.x1),
          y0: Math.min(b.y0, at[1] + r.box.y0 - r.below), y1: Math.max(b.y1, at[1] + r.box.y1 + r.above),
        };
      }
      const kept = columns.map((col) => col.filter((n) => !riders.has(n))).filter((col) => col.length);
      columns.length = 0;
      columns.push(...kept);
      columns.forEach((col, c) => col.forEach((n) => (n.col = c)));
    }

    // Bands across the whole block, from the supply down to ground: a gate stands no higher
    // than its band's top in any column, so parts near VCC are above parts near GND throughout.
    const band = (n: Node): number => {
      const ic = anchors.get(n) ?? (n.powerOnly ? signal.find((x) => x.part === n.part) : undefined);
      const m = ic ?? n;
      if (this.path) return this.path.has(m) ? 2 : level(m) > 0.6 || m.pins.some((p) => p.net && this.rails.has(p.net.name)) ? 4 : 0;
      return Math.round(level(m) * 4);
    };
    if (this.path) this.stackRow(columns, band, level);
    else this.stackBands(columns, band);
    // A column of power gates (and their capacitors) starts level with its IC's top.
    for (const col of columns) {
      if (!col.length || !col.every((n) => n.powerOnly)) continue;
      const ic = col.map((n) => this.nodes.find((x) => x.part === n.part && !x.powerOnly)).find((x) => x);
      if (!ic) continue;
      const d = snap(ic.at[1] + ic.box.y1 + ic.above - (col[0]!.at[1] + col[0]!.box.y1 + col[0]!.above));
      for (const n of col) n.at = [n.at[0], r6(n.at[1] + d)];
    }
    // Parts in parallel level with each other: the pins on their shared net in line.
    for (const [follower, { anchor, net }] of parallel) {
      const a = anchor.pins.find((p) => p.net?.name === net)!;
      const f = follower.pins.find((p) => p.net?.name === net)!;
      follower.at = [follower.at[0], r6(anchor.at[1] + a.local[1] - f.local[1])];
    }

    // Columns' x: the widest gate, and a gap that grows with the nets between the columns.
    const colWidth = columns.map((col) => Math.max(2 * G, ...col.map((n) => n.box.x1 - n.box.x0)));
    let x = 0;
    for (let c = 0; c < columns.length; c++) {
      const between = new Set<RNet>();
      for (const n of [...columns[c]!, ...(columns[c + 1] ?? [])]) for (const p of n.pins) if (p.net && !p.net.supply) between.add(p.net);
      for (const n of columns[c]!) n.at = [snap(x + (colWidth[c]! - (n.box.x1 - n.box.x0)) / 2 - n.box.x0), n.at[1]];
      // Beside a part in parallel: just room for the wires joining their pins.
      const pairedNext = (columns[c + 1] ?? []).length > 0 && [...columns[c + 1]!, ...columns[c]!].some((n) => {
        const pa = parallel.get(n);
        return !!pa && columns[c]!.concat(columns[c + 1]!).includes(pa.anchor);
      }) && (columns[c + 1]!.every((n) => parallel.has(n)) || columns[c]!.every((n) => parallel.has(n)));
      x += colWidth[c]! + (c + 1 < columns.length ? (pairedNext ? 3 : 4 + Math.min(8, between.size)) * G : 0);
    }
    this.width = x;
    // A gate hanging from another in its column moves sideways to put its pin right under (or
    // over) the pin it hangs from, so the wire between drops straight (an emitter resistor
    // under the emitter); its partner in parallel moves with it.
    for (const [n, { from, down }] of this.hangs) {
      const pair = n.pins.flatMap((q) => from.pins.filter((p) => p.net && !p.net.supply && p.net === q.net && p.side === (down ? 'B' : 'T') && q.side === (down ? 'T' : 'B')).map((p) => [p, q] as const))[0];
      if (!pair) continue;
      const d = r6(snap(from.at[0] + pair[0].local[0] - pair[1].local[0]) - n.at[0]);
      if (!d) continue;
      n.at = [r6(n.at[0] + d), n.at[1]];
      for (const [f, { anchor }] of parallel) if (anchor === n) f.at = [r6(f.at[0] + d), f.at[1]];
    }
    for (const [r, { gate, at }] of riders) r.at = [r6(gate.at[0] + at[0]), r6(gate.at[1] + at[1])];
    if (this.path) this.placeRails();
  }

  /**
   * A rail as a person draws it: a straight line above the row, its feed resistor lying at its
   * left end with the supply on the left (R10), its capacitor hanging from it just after (C7),
   * the parts on it below (the router drops each pin straight up to it).
   */
  private placeRails(): void {
    const snapUp = (v: number) => r6(Math.ceil(v / G - 1e-6) * G);
    const turn = (n: Node, net: string, side: Side) => {
      for (const deg of [0, 90, 180, 270]) {
        this.setRot(n, deg);
        if (n.pins.find((p) => p.net?.name === net)!.side === side) break;
      }
      this.room(n);
    };
    for (const rail of this.rails) {
      const onRail = (n: Node) => n.pins.some((p) => p.net?.name === rail);
      const feeds = this.nodes.filter((n) => !this.path!.has(n) && onRail(n) && n.pins.every((p) => !p.net || p.net.supply || p.net.name === rail));
      const fed = feeds.find((n) => n.pins.some((p) => p.net?.supply && !this.supplyDown(p.net)));
      if (!fed) continue;
      const others = this.nodes.filter((n) => !feeds.includes(n));
      const xs = others.flatMap((n) => n.pins.filter((p) => p.net?.name === rail).map((p) => n.at[0] + p.local[0]));
      if (!xs.length) continue;
      const y = snapUp(Math.max(...others.map((n) => n.at[1] + n.box.y1 + n.above)) + 2 * G);
      turn(fed, rail, 'R');
      const fp = fed.pins.find((p) => p.net?.name === rail)!;
      let x = snap(Math.min(...xs) - 6 * G);
      fed.at = [r6(x - fp.local[0]), r6(y - fp.local[1])];
      for (const c of feeds) {
        if (c === fed) continue;
        x += 2 * G;
        turn(c, rail, 'T');
        const cp = c.pins.find((p) => p.net?.name === rail)!;
        c.at = [r6(x - cp.local[0]), r6(y - 2 * G - cp.local[1])];
        x += G;
      }
    }
  }

  /**
   * A signal row: the path's gates at heights that line their pins up with each other; in each
   * column the other gates stacked down from the path gate (or, between two, from the lower of
   * them), and those nearer the supply above it, as a person hangs a stage off the signal line.
   */
  /** In a signal row, the gate each stacked gate hangs from, and which way. */
  private readonly hangs = new Map<Node, { from: Node; down: boolean }>();

  private stackRow(columns: Node[][], band: (n: Node) => number, level: (n: Node) => number): void {
    const onPath = (n: Node) => this.path!.has(n);
    const path = this.nodes.filter(onPath).sort((a, b) => a.col - b.col);
    for (const n of path) n.at = [0, snapDown(-n.above - n.box.y1)];
    for (let pass = 0; pass < 6; pass++) {
      for (const n of path.slice(1)) {
        const ys = this.levelWith(n).sort((a, b) => a - b);
        if (ys.length) n.at = [0, ys[Math.floor((ys.length - 1) / 2)]!];
      }
    }
    const pathIn = (c: number) => columns[c]?.find(onPath);
    const near = (c: number, d: number) => {
      for (let k = c + d; k >= 0 && k < columns.length; k += d) if (pathIn(k)) return pathIn(k);
      return undefined;
    };
    const snapUp = (v: number) => r6(Math.ceil(v / G - 1e-6) * G);
    columns.forEach((col, c) => {
      const p = pathIn(c);
      const refs = p ? [p] : [near(c, -1), near(c, 1)].filter((x): x is Node => !!x);
      const bottom = refs.length ? Math.min(...refs.map((n) => n.at[1] + n.box.y0 - n.below)) : 0;
      const top = refs.length ? Math.max(...refs.map((n) => n.at[1] + n.box.y1 + n.above)) : 0;
      const up = col.filter((n) => !onPath(n) && band(n) > 2).sort((a, b) => level(a) - level(b));
      const down = col.filter((n) => !onPath(n) && band(n) <= 2);
      let cursor = bottom - GAP_Y;
      let from = p;
      for (const n of down) {
        n.at = [0, snapDown(cursor - n.above - n.box.y1)];
        cursor = n.at[1] + n.box.y0 - n.below - GAP_Y;
        if (from) this.hangs.set(n, { from, down: true });
        from = n;
      }
      cursor = top + GAP_Y;
      from = p;
      for (const n of up) {
        n.at = [0, snapUp(cursor + n.below - n.box.y0)];
        cursor = n.at[1] + n.box.y1 + n.above + GAP_Y;
        if (from) this.hangs.set(n, { from, down: false });
        from = n;
      }
    });
  }

  /** Bands across the whole block, from the supply down to ground, and rows lined up within them. */
  private stackBands(columns: Node[][], band: (n: Node) => number): void {
    const bandTop = new Map<number, number>();
    let top = 0;
    for (let b = 4; b >= 0; b--) {
      bandTop.set(b, top);
      let deepest = 0;
      for (const col of columns) {
        // (A column of power gates is placed level with its IC afterwards.)
        if (col.every((n) => n.powerOnly)) continue;
        const h = col.filter((n) => band(n) === b).reduce((s, n) => s + n.above + (n.box.y1 - n.box.y0) + n.below + GAP_Y, 0);
        deepest = Math.max(deepest, h);
      }
      top -= deepest;
    }

    // Rows: each gate at the height that lines its side pins up with the pins they connect to
    // in other columns, so the wires between run straight. A few passes; each column keeps its
    // order, stacked down from the top with nothing overlapping.
    const stack = (want: Map<Node, number>) => {
      for (const col of columns) {
        let cursor = 0;
        for (const n of col) {
          cursor = Math.min(cursor, bandTop.get(band(n))!);
          const highest = snapDown(cursor - n.above - n.box.y1);
          const w = want.get(n);
          n.at = [0, w !== undefined && w <= highest ? w : highest];
          cursor = n.at[1] + n.box.y0 - n.below - GAP_Y;
        }
      }
    };
    stack(new Map());
    for (let pass = 0; pass < 6; pass++) {
      const want = new Map<Node, number>();
      for (const n of this.nodes) {
        const ys = this.levelWith(n).sort((a, b) => a - b);
        if (ys.length) want.set(n, ys[Math.floor((ys.length - 1) / 2)]!);
      }
      stack(want);
    }
  }

  /**
   * The heights that would put a side pin of `n` level with a pin facing it in another column
   * (a left pin with a right pin in a column before, a right pin with a left pin after).
   */
  private levelWith(n: Node): number[] {
    const out: number[] = [];
    for (const p of n.pins) {
      if (!p.net || p.net.supply || this.rails.has(p.net.name) || (p.side !== 'L' && p.side !== 'R')) continue;
      for (const r of p.net.pins) {
        const m = this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate);
        const q = m?.pins.find((x) => x.ref.pin === r.pin);
        if (!m || !q || m === n || this.riding.has(m)) continue;
        const facing = (p.side === 'L' && m.col < n.col && q.side === 'R') || (p.side === 'R' && m.col > n.col && q.side === 'L');
        if (facing) out.push(snapDown(m.at[1] + q.local[1] - p.local[1]));
      }
    }
    return out;
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

  /** A straight wire from a pin rightwards to column i1, if nothing is in the way. */
  trunk(net: string, from: PinPoint, i1: number): boolean {
    const path: Vec[] = [];
    for (let i = from.i; i <= i1; i++) {
      const k = pk(i, from.j);
      if (i > from.i && (this.blocked.has(k) || this.pinAt.has(k) || [...this.nets.values()].some((n) => n.use.has(k) || n.labels.has(k)))) return false;
      path.push([i, from.j]);
    }
    this.commit(net, path);
    return true;
  }

  /** Is a pin already on its net's drawing? */
  reaches(p: PinPoint): boolean {
    return this.net(p.net).use.has(pk(p.i, p.j));
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
  label(net: string, pins: PinPoint[], text: string, fromPinsOnly = false): boolean {
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
    const sources = fromPinsOnly ? pins.map((p) => ({ i: p.i, j: p.j, dirs: [p.out] })) : this.branchSources(net, pins);
    const path = this.search(net, sources, target, 60);
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
    const path = this.search(p.net, [{ i: p.i, j: p.j, dirs: [p.out] }], target, 40) ?? this.search(p.net, [{ i: p.i, j: p.j, dirs: [p.out] }], target, 120);
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
function routeNodes(nodes: Node[], nets: RNet[], supplies: Map<string, SupplySymbol>, supplyName: (s: SupplySymbol) => string, groupOf?: (n: Node) => string, rails: Set<string> = new Set()): { router: Router; extent: Box; score: number } {
  const extent = boxOf(nodes.flatMap(extentOf));
  const router = new Router(extent);
  const blockOfPart = new Map(nodes.map((n) => [n.part.part.name, groupOf ? groupOf(n) : n.part.block]));
  const policy = new Map<string, { whole: boolean }>();
  for (const net of nets) {
    if (net.supply) continue;
    const here = new Set(net.pins.filter((r) => blockOfPart.has(r.part)).map((r) => blockOfPart.get(r.part)!));
    const elsewhere = net.pins.some((r) => !blockOfPart.has(r.part));
    policy.set(net.name, { whole: !elsewhere && here.size <= (groupOf ? 1 : 2) });
  }
  const keyOf = (net: RNet, block: string) => (net.supply || policy.get(net.name)!.whole ? net.name : `${net.name}${KEY}${block}`);

  const pins: PinPoint[] = [];
  const offGrid: PinPoint[] = [];
  for (const n of nodes) {
    router.addGate(
      { x0: n.at[0] + n.body.x0, y0: n.at[1] + n.body.y0, x1: n.at[0] + n.body.x1, y1: n.at[1] + n.body.y1 },
      textBoxes(n.symbol).map((t) => rotBox(t, n.rot)).map((b) => (n.mirror ? { x0: -b.x1, y0: b.y0, x1: -b.x0, y1: b.y1 } : b)).map((b) => ({ x0: n.at[0] + b.x0, y0: n.at[1] + b.y0, x1: n.at[0] + b.x1, y1: n.at[1] + b.y1 })),
    );
    for (const p of n.pins) {
      if (!p.net) continue;
      const x = n.at[0] + p.local[0];
      const y = n.at[1] + p.local[1];
      const pp: PinPoint = { ref: p.ref, net: keyOf(p.net, blockOfPart.get(n.part.part.name)!), out: dirOf(OUT[p.side]), i: Math.round(x / G), j: Math.round(y / G) };
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
  // A rail whose leftmost pin faces right and is its highest (a feed resistor at its left end):
  // a straight trunk from that pin to over its last pin, drawn first, for the rest to join.
  const trunked = new Set<string>();
  for (const [key, ps] of signal) {
    if (!rails.has(real(key).name)) continue;
    const lead = [...ps].sort((a, b) => a.i - b.i)[0]!;
    const end = Math.max(...ps.map((p) => p.i));
    if (lead.out !== 0 || end <= lead.i || ps.some((p) => p !== lead && (p.i <= lead.i || p.j >= lead.j))) continue;
    if (router.trunk(key, lead, end)) trunked.add(key);
  }
  for (const [key, ps] of signal) {
    if (trunked.has(key)) {
      for (const p of ps) {
        if (router.reaches(p)) continue;
        if (!router.connect(p)) {
          unrouted.push(p);
          brokenKeys.add(key);
        }
      }
      continue;
    }
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
    // (A supply pin with no room for its symbol: labelled right at the pin, not wherever the net is.)
    if (!router.label(p.net, [p], real(p.net).name, real(p.net).supply)) router.stubLabel(p);
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
  return { router, extent, score: s.length + 10 * s.bends + 8 * s.crossings + 30 * labels + 60 * unrouted.length + area / 40 + 2 * backwards };
}

/** A block laid out the best of several ways: each signal gate as the start, flipped or not. */
function bestPlacement(parts: RPart[], nets: RNet[], supplies: Map<string, SupplySymbol>, potential: Map<string, number>, rails: Set<string>): BlockPlacement {
  let best: { placement: BlockPlacement; score: number } | undefined;
  const starts = 1; // the description lists parts in signal order: start from the first
  for (let start = 0; start < starts; start++) {
    for (const flip of [true, false]) {
      const placement = new BlockPlacement(parts, nets, supplies, potential, rails);
      placement.place(start, flip);
      if (!placement.nodes.length) return placement;
      const { score } = routeNodes(placement.nodes, nets, supplies, () => 'S');
      if (!best || score < best.score) best = { placement, score };
    }
  }
  return best!.placement;
}

/**
 * Rails: nets that carry power to several parts without being a supply, such as VCCA, fed from
 * a supply drawn above (VCC) through a resistor or inductor and decoupled by a capacitor to a supply.
 */
function findRails(design: Resolved, supplies: Map<string, SupplySymbol>): Set<string> {
  const up = (n: RNet) => n.supply && (supplies.get(n.name)?.body[1] ?? 0) > 0;
  const capacitor = (part: string) => (design.parts.find((p) => p.part.name === part)?.component.prefix ?? '').toUpperCase() === 'C';
  const netsOf = new Map<string, Set<RNet>>();
  for (const n of design.nets) for (const r of n.pins) netsOf.set(r.part, (netsOf.get(r.part) ?? new Set()).add(n));
  const rails = new Set<string>();
  for (const n of design.nets) {
    if (n.supply || n.pins.length < 3) continue;
    let fed = false;
    let decoupled = false;
    for (const r of n.pins) {
      const nets = [...(netsOf.get(r.part) ?? [])];
      if (nets.length !== 2 || !nets.some((m) => m !== n && m.supply)) continue;
      if (capacitor(r.part)) decoupled = true;
      else if (nets.some((m) => m !== n && up(m))) fed = true;
    }
    if (fed && decoupled) rails.add(n.name);
  }
  return rails;
}

/**
 * The signal row: the path from the first signal part (an input) to the IC with the most signal
 * pins (or the farthest part), each gate on it two columns after the one before. Other gates
 * go between the two path gates they connect, or under the one they hang from (an emitter
 * resistor under its transistor); a connector on the last gate's right side after it; parts
 * only on a rail (its feed resistor and capacitor) just before the rail's first pin. Returns
 * the columns and the gates the path doesn't reach.
 */
function signalRow(pl: BlockPlacement, rails: Set<string>): { cols: Map<Node, number>; unreached: Node[]; spine: Node[] } {
  const cols = new Map<Node, number>();
  const signal = pl.nodes.filter((n) => !n.powerOnly);
  const sigPins = (n: Node) => n.pins.filter((p) => p.net && !p.net.supply && !rails.has(p.net.name)).length;
  const start = signal.find((n) => pl.neighbours(n).length);
  if (!start) {
    signal.forEach((n, i) => cols.set(n, i));
    return { cols, unreached: [], spine: [] };
  }
  const parent = new Map<Node, Node | undefined>([[start, undefined]]);
  const dist = new Map<Node, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of pl.neighbours(n).sort((a, b) => a.order - b.order)) {
      if (parent.has(m) || m.powerOnly) continue;
      parent.set(m, n);
      dist.set(m, dist.get(n)! + 1);
      queue.push(m);
    }
  }
  const reached = [...parent.keys()];
  const ic = reached.filter((n) => sigPins(n) >= 4).sort((a, b) => sigPins(b) - sigPins(a) || a.order - b.order)[0];
  // Else the farthest part that isn't a shunt to a supply, an active one (with an output) first.
  const shunt = (n: Node) => n.pins.length === 2 && n.pins.some((p) => p.net?.supply) && !isConnector(n.part.component);
  const active = (n: Node) => (n.pins.some((p) => p.pin.direction === 'out') ? 0 : 1);
  const ends = reached.filter((n) => !shunt(n));
  const end = ic ?? [...(ends.length ? ends : reached)].sort((a, b) => dist.get(b)! - dist.get(a)! || active(a) - active(b) || a.order - b.order)[0]!;
  const spine: Node[] = [];
  for (let n: Node | undefined = end; n; n = parent.get(n)) spine.unshift(n);
  const at = new Map(spine.map((n, i) => [n, i]));
  spine.forEach((n, i) => cols.set(n, 2 * i));

  // Out from the path, breadth first.
  const last = spine.length - 1;
  const q2 = [...spine];
  while (q2.length) {
    const n = q2.shift()!;
    for (const m of pl.neighbours(n).sort((a, b) => a.order - b.order)) {
      if (cols.has(m) || m.powerOnly) continue;
      if (at.has(n)) {
        const touching = pl.neighbours(m).filter((x) => at.has(x)).map((x) => at.get(x)!);
        const lo = Math.min(...touching);
        const hi = Math.max(...touching);
        if (lo !== hi) cols.set(m, lo + hi);
        else {
          const sides = n.pins.filter((p) => p.net && m.pins.some((x) => x.net === p.net)).map((p) => p.side);
          cols.set(m, lo === last && sides.includes('R') ? 2 * lo + 1 : lo === 0 && sides.includes('L') ? -1 : 2 * lo);
        }
      } else cols.set(m, cols.get(n)!);
      q2.push(m);
    }
  }
  // Parts only on rails (and supplies): before the rail's first pin in the row.
  const unreached: Node[] = [];
  const placed = new Set(cols.keys());
  for (const n of signal) {
    if (placed.has(n)) continue;
    const railPins = n.pins.filter((p) => p.net && rails.has(p.net.name));
    const firsts = railPins.flatMap((p) => p.net!.pins).map((r) => pl.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate)).filter((x): x is Node => !!x && placed.has(x)).map((x) => cols.get(x)!);
    if (railPins.length && railPins.length + n.pins.filter((p) => p.net?.supply).length === n.pins.filter((p) => p.net).length && firsts.length) cols.set(n, Math.min(...firsts) - 1);
    else unreached.push(n);
  }
  return { cols, unreached, spine };
}

/**
 * A block laid out as a small signal row of its own (its path on one line, the rest hanging
 * from it), the better of two ways; or in columns when it has no path (only power parts).
 */
function rowPlacement(parts: RPart[], nets: RNet[], supplies: Map<string, SupplySymbol>, potential: Map<string, number>, rails: Set<string>): BlockPlacement {
  let best: { pl: BlockPlacement; score: number } | undefined;
  for (const flip of [true, false]) {
    const pl = new BlockPlacement(parts, nets, supplies, potential, rails);
    const row = signalRow(pl, rails);
    if (!row.spine.length || row.unreached.length) return bestPlacement(parts, nets, supplies, potential, rails);
    pl.placeIn(row.cols, row.spine, flip);
    const { score } = routeNodes(pl.nodes, nets, supplies, () => 'S');
    if (!best || score < best.score) best = { pl, score };
  }
  return best!.pl;
}

/**
 * Lay out the whole sheet as a person would: the signal row across the top (the blocks the main
 * signal path runs through), and the other blocks (power, an oscillator, an MCU's outputs) in a
 * band below it, each under what it connects to.
 */
function layoutSheet(design: Resolved, supplies: Map<string, SupplySymbol>, potential: Map<string, number>, rails: Set<string>): { nodes: Node[]; groupOf: (n: Node) => string } {
  const ancestors = (b: string) => b.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
  // Find the row's blocks from the path through all the parts.
  const all = new BlockPlacement(design.parts, design.nets, supplies, potential, rails);
  const first = signalRow(all, rails);
  const pathBlocks = new Set<string>();
  for (const n of first.spine) for (const a of ancestors(n.part.block)) pathBlocks.add(a);
  const inRow = (p: RPart) => pathBlocks.has(p.block) || pathBlocks.size === 0;
  let rowParts = design.parts.filter(inRow);
  let side = design.parts.filter((p) => !inRow(p));

  let best: { pl: BlockPlacement; score: number } | undefined;
  for (const flip of [true, false]) {
    let pl = new BlockPlacement(rowParts, design.nets, supplies, potential, rails);
    let row = signalRow(pl, rails);
    if (row.unreached.length) {
      const away = new Set(row.unreached.map((n) => n.part));
      rowParts = rowParts.filter((p) => !away.has(p));
      side = [...side, ...away];
      pl = new BlockPlacement(rowParts, design.nets, supplies, potential, rails);
      row = signalRow(pl, rails);
    }
    pl.placeIn(row.cols, row.spine, flip);
    const { score } = routeNodes(pl.nodes, design.nets, supplies, () => 'S', () => 'row');
    if (!best || score < best.score) best = { pl, score };
  }
  const rowNodes = best?.pl.nodes ?? [];
  const groupOf = new Map<Node, string>(rowNodes.map((n) => [n, '']));

  // The other blocks, each laid out on its own, in a band below the row.
  const blocks = [...new Set(side.map((p) => p.block))];
  const rowBox = rowNodes.length ? boxOf(rowNodes.flatMap(extentOf)) : { x0: 0, y0: 0, x1: 0, y1: 0 };
  const pinAt = new Map<string, Vec>();
  for (const n of rowNodes) for (const p of n.pins) pinAt.set(`${p.ref.part}.${p.ref.gate}.${p.ref.pin}`, [n.at[0] + p.local[0], n.at[1] + p.local[1]]);
  const groups = blocks.map((b) => {
    const pl = rowPlacement(side.filter((p) => p.block === b), design.nets, supplies, potential, rails);
    const box = boxOf(pl.nodes.flatMap(extentOf));
    // Where it would like to be: its pins under the row's pins they connect to.
    const dx: number[] = [];
    for (const n of pl.nodes) {
      for (const p of n.pins) {
        if (!p.net || p.net.supply) continue;
        for (const r of p.net.pins) {
          const to = pinAt.get(`${r.part}.${r.gate}.${r.pin}`);
          if (to) dx.push(to[0] - (n.at[0] + p.local[0]));
        }
      }
    }
    const want = dx.length ? dx.reduce((a, b) => a + b, 0) / dx.length + box.x0 : rowBox.x0;
    return { block: b, pl, box, want };
  }).filter((g) => g.pl.nodes.length).sort((a, b) => a.want - b.want);

  // Left edges as near as can be to where each wants to be, in order, none overlapping: pool
  // adjacent violators (isotonic regression on the left edges less the widths before).
  const offsets: number[] = [];
  let acc = 0;
  for (const g of groups) {
    offsets.push(acc);
    acc += g.box.x1 - g.box.x0 + BLOCK_GAP;
  }
  const pools: { sum: number; n: number }[] = [];
  const members: number[] = [];
  groups.forEach((g, i) => {
    pools.push({ sum: g.want - offsets[i]!, n: 1 });
    members.push(1);
    while (pools.length > 1 && pools[pools.length - 2]!.sum / pools[pools.length - 2]!.n > pools[pools.length - 1]!.sum / pools[pools.length - 1]!.n) {
      const b = pools.pop()!;
      const nb = members.pop()!;
      pools[pools.length - 1]!.sum += b.sum;
      pools[pools.length - 1]!.n += b.n;
      members[members.length - 1]! += nb;
    }
  });
  const lefts: number[] = [];
  pools.forEach((p, k) => {
    for (let m = 0; m < members[k]!; m++) lefts.push(p.sum / p.n + offsets[lefts.length]!);
  });
  // Each as high as the row above it allows (tucked under its short stretches).
  const rowExtents = rowNodes.map((n) => boxOf(extentOf(n)));
  const nodes = [...rowNodes];
  groups.forEach((g, i) => {
    const x0 = lefts[i]!;
    const x1 = x0 + g.box.x1 - g.box.x0;
    const over = rowExtents.filter((b) => b.x1 + 2 * G > x0 && b.x0 - 2 * G < x1);
    const gap = (b: Box) => Math.max(0, b.x0 - x1, x0 - b.x1);
    const nearest = [...rowExtents].sort((a, b) => gap(a) - gap(b))[0];
    const top = (over.length ? Math.min(...over.map((b) => b.y0)) : nearest ? nearest.y0 : 0) - 4 * G;
    const d: Vec = [snap(x0 - g.box.x0), snap(top - g.box.y1)];
    for (const n of g.pl.nodes) {
      n.at = [r6(n.at[0] + d[0]), r6(n.at[1] + d[1])];
      groupOf.set(n, g.block);
      nodes.push(n);
    }
  });
  return { nodes, groupOf: (n) => groupOf.get(n) ?? n.part.block };
}

/**
 * Each net's height in the circuit, 0 to 1: how much nearer it is to a supply drawn above (VCC,
 * whose symbol points up) than to one drawn below (GND), counting two-pin parts between nets.
 * A transistor or IC (three pins or more) doesn't pass height on: its pins are at different
 * heights; nor does a capacitor (no path for DC: a decoupling capacitor doesn't pull a rail
 * down). VCCA, through R10 from VCC, is at the top; an emitter resistor near the bottom.
 */
function netPotential(design: Resolved, supplies: Map<string, SupplySymbol>): Map<string, number> {
  const capacitor = new Set(design.parts.filter((p) => (p.component.prefix ?? '').toUpperCase() === 'C').map((p) => p.part.name));
  const netsOf = new Map<string, Set<string>>();
  for (const n of design.nets) {
    for (const r of n.pins) {
      if (capacitor.has(r.part)) continue;
      if (!netsOf.has(r.part)) netsOf.set(r.part, new Set());
      netsOf.get(r.part)!.add(n.name);
    }
  }
  const neighbours = new Map<string, Set<string>>();
  for (const nets of netsOf.values()) {
    if (nets.size > 2) continue;
    for (const a of nets) {
      for (const b of nets) {
        if (a === b) continue;
        if (!neighbours.has(a)) neighbours.set(a, new Set());
        neighbours.get(a)!.add(b);
      }
    }
  }
  const distance = (from: string[]) => {
    const d = new Map<string, number>(from.map((n) => [n, 0]));
    const queue = [...from];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of neighbours.get(n) ?? []) {
        if (d.has(m)) continue;
        d.set(m, d.get(n)! + 1);
        queue.push(m);
      }
    }
    return d;
  };
  const up = [...supplies].filter(([, s]) => s.body[1] > 0).map(([n]) => n);
  const down = [...supplies].filter(([, s]) => s.body[1] <= 0).map(([n]) => n);
  const dUp = distance(up);
  const dDown = distance(down);
  const out = new Map<string, number>();
  for (const n of design.nets) {
    const a = dUp.get(n.name);
    const b = dDown.get(n.name);
    out.set(n.name, a === undefined && b === undefined ? 0.5 : a === undefined ? 0 : b === undefined ? 1 : b / (a + b || 1));
  }
  return out;
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

  let supplyCount = 0;
  const sheet = project.schematic!.sheets[0]!;
  const nets = new Map<string, O.Net>();
  const netOf = (name: string) => {
    let n = nets.get(name);
    if (!n) nets.set(name, (n = { name, segments: [] }));
    return n;
  };
  for (const n of design.nets) netOf(n.name);

  const potential = netPotential(design, supplies);
  const rails = findRails(design, supplies);
  let rowBottom = 0;
  {
    // The sheet laid out in one piece and wired as one circuit.
    const { nodes, groupOf } = layoutSheet(design, supplies, potential, rails);
    const { router } = routeNodes(nodes, design.nets, supplies, (s) => `${s.component.prefix || 'SUPPLY'}${++supplyCount}`, groupOf, rails);

    // The drawing, moved so its top left is at the origin.
    const segments = router.segments();
    const pts: Vec[] = nodes.flatMap(extentOf);
    for (const { segment } of segments) {
      for (const wr of segment.wires) pts.push(wr.line[0], wr.line[1]);
      for (const l of segment.labels ?? []) pts.push([l.at[0] + (l.align === 'bottom-right' ? -1 : 1) * labelWidth(''), l.at[1] + G]);
    }
    for (const sg of router.supplyGates) pts.push([sg.at[0] + sg.supply.box.x0 + sg.supply.pin.at[0], sg.at[1] + sg.supply.box.y0 + sg.supply.pin.at[1]]);
    const gb = boxOf(pts);
    const dx = snap(-gb.x0);
    const dy = snap(-gb.y1);
    const move = (p: O.Pt): O.Pt => [r6(p[0] + dx), r6(p[1] + dy)];
    for (const n of nodes) sheet.gates.push({ part: n.part.part.name, gate: n.gate.name, at: move(n.at), ...(n.rot ? { rot: n.rot } : {}), ...(n.mirror ? { mirror: true } : {}) });
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
    rowBottom = dy + gb.y0;
  }

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
