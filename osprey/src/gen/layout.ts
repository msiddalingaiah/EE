// Drawing a schematic from a resolved block description (description.ts).
//
// Each block gets its own area. Inside it, gates stand in columns by signal flow: breadth
// first from the block's first part, so the description's order is the left-to-right order.
// Rows follow the previous column (a part lines up with what it connects to there).
// Two-pin parts on a supply stand upright with the supply symbol below (ground) or above.
//
// Wiring: a net whose pins all face one gap between columns is drawn there: a vertical trunk
// on its own track, a branch from each pin. Branches meet the trunk in T's, never four-way.
// A net that leaves the block (a port), spans more than two columns, or would need a four-way
// crossing gets a net label at each pin instead (nets connect by name). Each supply pin gets
// its own supply symbol on a short stub. So pins never touch each other directly.

import { labelFor } from '../edit/netlabels';
import { Transaction } from '../edit/ops';
import { addToLibrary, insertPart } from '../edit/place';
import type * as O from '../model/types';
import { FORMAT_VERSION } from '../model/types';
import type { RNet, RPart, Resolved } from './description';

const G = 2.54;
const WIRE = 0.1524;
const LABEL_SIZE = 1.778;
const GAP_Y = 2 * G;
const BLOCK_GAP = 6 * G;
/** Between blocks of one group (a block and the blocks inside it). */
const INNER_GAP = 3 * G;
const SHEET_WIDTH = 280;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const snapDown = (v: number) => r6(Math.floor(v / G + 1e-6) * G);
const snap = (v: number) => r6(Math.round(v / G) * G);

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

const angleOf = (v: Vec) => (v[0] > 0.5 ? 0 : v[1] > 0.5 ? 90 : v[0] < -0.5 ? 180 : 270);

/**
 * Points outlining a symbol: its drawing, pins, and its texts (>NAME, >VALUE) at a guessed
 * width, so neighbours keep clear of the part's name and value too.
 */
function symbolPoints(s: O.Symbol): Vec[] {
  const pts: Vec[] = s.pins.map((p) => [p.at[0], p.at[1]]);
  for (const g of s.graphics) {
    if ('line' in g) pts.push(g.line[0], g.line[1]);
    else if ('circle' in g) pts.push([g.circle[0] - g.radius, g.circle[1] - g.radius], [g.circle[0] + g.radius, g.circle[1] + g.radius]);
    else if ('rect' in g) pts.push(g.rect[0], g.rect[1]);
    else if ('polygon' in g) for (const v of g.polygon) pts.push([v[0], v[1]]);
    else if ('text' in g) {
      // ">NAME" and ">VALUE" become a name or value of about that length.
      const w = g.size * 0.8 * Math.max(4, g.text.replace(/^>/, '').length);
      const h = g.size;
      const vertical = (g.rot ?? 0) % 180 === 90;
      const [dx, dy] = vertical ? [h, w] : [w, h];
      const align = g.align ?? 'bottom-left';
      const x0 = align.endsWith('right') ? -dx : align.endsWith('center') ? -dx / 2 : 0;
      const y0 = align.startsWith('top') ? -dy : align.startsWith('center') ? -dy / 2 : 0;
      pts.push([g.at[0] + x0, g.at[1] + y0], [g.at[0] + x0 + dx, g.at[1] + y0 + dy]);
    }
  }
  return pts;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
function boxOf(pts: Vec[]): Box {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** A supply symbol: its pin, and which way its body points from the pin. */
interface SupplySymbol {
  component: O.Component;
  gate: O.Gate;
  symbol: O.Symbol;
  pin: O.Pin;
  /** Direction from the pin into the body (rotation 0). */
  body: Vec;
  /** How far the body reaches from the pin, along `body`. */
  reach: number;
}

function supplySymbol(component: O.Component, source: O.Library): SupplySymbol {
  const gate = component.gates[0]!;
  const symbol = source.symbols.find((s) => s.id === gate.symbol)!;
  const pin = symbol.pins[0]!;
  const body = [-OUT[sideOf(pin, 0)][0], -OUT[sideOf(pin, 0)][1]] as Vec;
  const reach = Math.max(...symbolPoints(symbol).map((p) => (p[0] - pin.at[0]) * body[0] + (p[1] - pin.at[1]) * body[1]));
  return { component, gate, symbol, pin, body, reach: Math.max(reach, G) };
}

interface PinInfo {
  ref: O.PinRef;
  pin: O.Pin;
  net?: RNet;
  local: Vec;
  side: Side;
  /** How it is drawn: a supply symbol, a net label, a wire in a channel, or nothing. */
  role?: 'supply' | 'label' | 'wire';
  /** For a wire: the side it leaves on (top and bottom pins pick left or right). */
  exit?: 'L' | 'R';
}

interface Node {
  part: RPart;
  gate: O.Gate;
  symbol: O.Symbol;
  order: number;
  powerOnly: boolean;
  rot: number;
  pins: PinInfo[];
  box: Box;
  col: number;
  /** Extra room above and below the box (stubs, supply symbols, vertical labels). */
  above: number;
  below: number;
  at: Vec;
}

/** What one block draws, in its own coordinates (x from 0, y from 0 down). */
interface Drawn {
  gates: O.GatePlacement[];
  segments: { net: string; segment: Omit<O.Segment, 'sheet'> }[];
  supplyParts: O.Part[];
  box: Box;
}

const labelWidth = (name: string) => name.length * LABEL_SIZE * 0.85 + G;

class BlockLayout {
  readonly nodes: Node[] = [];
  private readonly pinNet = new Map<string, RNet>();

  constructor(
    readonly block: string,
    parts: RPart[],
    nets: RNet[],
    private readonly supplies: Map<string, SupplySymbol>,
    /** The next supply symbol's part name (SUPPLY1, SUPPLY2… across the sheet). */
    private readonly supplyName: (s: SupplySymbol) => string,
  ) {
    for (const n of nets) for (const r of n.pins) this.pinNet.set(`${r.part}.${r.gate}.${r.pin}`, n);
    let order = 0;
    for (const p of parts) {
      for (const g of p.component.gates) {
        const symbol = p.source.symbols.find((s) => s.id === g.symbol);
        if (!symbol) continue;
        const pins: PinInfo[] = symbol.pins.map((pin) => {
          const ref = { part: p.part.name, gate: g.name, pin: pin.name };
          const net = this.pinNet.get(`${ref.part}.${ref.gate}.${ref.pin}`);
          return { ref, pin, ...(net ? { net } : {}), local: [pin.at[0], pin.at[1]], side: sideOf(pin, 0) };
        });
        const powerOnly = pins.every((x) => !x.net || x.net.supply);
        this.nodes.push({ part: p, gate: g, symbol, order: order++, powerOnly, rot: 0, pins, box: boxOf(symbolPoints(symbol)), col: 0, above: 0, below: 0, at: [0, 0] });
      }
    }
  }

  private setRot(n: Node, deg: number): void {
    n.rot = ((deg % 360) + 360) % 360;
    n.box = boxOf(symbolPoints(n.symbol).map((p) => rot(p, n.rot)));
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

  private signalNeighbours(n: Node): Node[] {
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

  layout(): Drawn {
    // Two-pin parts on a supply stand upright: the supply pin down (ground) or up. Only parts
    // with a pin on each side (a resistor, a capacitor), not a connector's pins in a row.
    for (const n of this.nodes) {
      if (n.pins.length !== 2 || new Set(n.pins.map((p) => p.side)).size !== 2 || n.pins.some((p) => p.side === 'T' || p.side === 'B')) continue;
      const [a, b] = n.pins as [PinInfo, PinInfo];
      const sup = [a, b].filter((p) => p.net?.supply);
      if (!sup.length) continue;
      // The supply pin (the ground one, when both are) goes to the bottom, or the top for VCC.
      const s = sup.find((p) => this.supplyDown(p.net!)) ?? sup[0]!;
      const down = this.supplyDown(s.net!) || sup.length === 2;
      const want: Side = down ? 'B' : 'T';
      for (const deg of [90, 270]) {
        if (sideOf(s.pin, deg) === want) this.setRot(n, deg);
      }
    }

    // Columns: breadth first through signal nets, from the first part listed.
    const signal = this.nodes.filter((n) => !n.powerOnly);
    const seen = new Set<Node>();
    for (const start of signal) {
      if (seen.has(start)) continue;
      start.col = 0;
      seen.add(start);
      const queue = [start];
      while (queue.length) {
        const n = queue.shift()!;
        for (const m of this.signalNeighbours(n).sort((x, y) => x.order - y.order)) {
          if (seen.has(m) || m.powerOnly) continue;
          seen.add(m);
          m.col = n.col + 1;
          queue.push(m);
        }
      }
    }
    for (const n of this.nodes) {
      if (!n.powerOnly) continue;
      const sibling = signal.find((x) => x.part === n.part);
      n.col = sibling?.col ?? 0;
    }

    // Two-pin parts lying across: the pin toward the earlier column on the left.
    for (const n of signal) {
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
    // Order each column by where its neighbours stand in the column before.
    for (let c = 1; c < columns.length; c++) {
      const prev = columns[c - 1]!;
      const rank = (n: Node) => {
        const ns = this.signalNeighbours(n).filter((m) => m.col === c - 1).map((m) => prev.indexOf(m));
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : Infinity;
      };
      columns[c] = columns[c]!.map((n, i) => ({ n, k: rank(n), i })).sort((a, b) => (a.k - b.k) || (a.i - b.i)).map((x) => x.n);
    }

    this.assignRoles();
    for (const n of this.nodes) this.measure(n);

    // Rows: each column stacks down from the top; a part lines up with a pin it connects to in
    // the column before when there is room.
    const y0 = new Map<Node, number>();
    for (let c = 0; c < columns.length; c++) {
      let cursor = 0;
      for (const n of columns[c]!) {
        const highest = snapDown(cursor - n.above - n.box.y1);
        let y = highest;
        const target = this.alignTarget(n, c);
        if (target !== undefined && target <= highest) y = target;
        n.at = [0, y];
        y0.set(n, y);
        cursor = y + n.box.y0 - n.below - GAP_Y;
      }
    }

    // Channels between columns (-1: left of the first, last: right of the last).
    const channels = this.route();
    // Column x: each channel's left lane, tracks, right lane; then the column.
    const colLeft: number[] = [];
    const colWidth = columns.map((col) => Math.max(2 * G, ...col.map((n) => n.box.x1 - n.box.x0)));
    const chanLeft = new Map<number, number>();
    let x = 0;
    for (let c = -1; c < columns.length; c++) {
      if (c >= 0) {
        colLeft[c] = x;
        x += colWidth[c]!;
      }
      chanLeft.set(c, x);
      x += this.channelWidth(c, channels.get(c));
    }
    for (let c = 0; c < columns.length; c++) {
      for (const n of columns[c]!) n.at = [snap(colLeft[c]! + (colWidth[c]! - (n.box.x1 - n.box.x0)) / 2 - n.box.x0), y0.get(n)!];
    }
    return this.emit(channels, chanLeft, x);
  }

  /** The y that puts a pin of `n` level with the pin it connects to in column c - 1. */
  private alignTarget(n: Node, c: number): number | undefined {
    if (c === 0) return undefined;
    for (const p of n.pins) {
      if (p.role !== 'wire' || (p.side !== 'L' && p.side !== 'R')) continue;
      for (const r of p.net!.pins) {
        const m = this.nodes.find((x) => x.part.part.name === r.part && x.gate.name === r.gate && x.col === c - 1);
        const q = m?.pins.find((x) => x.ref.pin === r.pin);
        if (m && q && (q.side === 'R')) return snapDown(m.at[1] + q.local[1] - p.local[1]);
      }
    }
    return undefined;
  }

  /** How each pin is drawn: supply symbol, wire (when its net fits one channel), or label. */
  private assignRoles(): void {
    const byNet = new Map<RNet, { node: Node; pin: PinInfo }[]>();
    for (const n of this.nodes) {
      for (const p of n.pins) {
        if (!p.net) continue;
        if (p.net.supply) {
          // A symbol above or below the part; on a side (pins 2.54 mm apart) a label of the
          // supply's name, which connects it just the same.
          p.role = p.side === 'T' || p.side === 'B' ? 'supply' : 'label';
          continue;
        }
        const list = byNet.get(p.net) ?? [];
        list.push({ node: n, pin: p });
        byNet.set(p.net, list);
      }
    }
    for (const [net, list] of byNet) {
      const label = () => list.forEach(({ pin }) => (pin.role = 'label'));
      if (net.blocks.size > 1 || list.length < 2) {
        label();
        continue;
      }
      const cols = list.map((x) => x.node.col);
      const lo = Math.min(...cols);
      const hi = Math.max(...cols);
      if (hi - lo > 1) {
        label();
        continue;
      }
      // Facing one gap: pins in the left column on their right side, in the right one on their left.
      const fits = (chan: number) => list.every(({ node, pin }) => {
        const want = node.col === chan ? 'R' : node.col === chan + 1 ? 'L' : undefined;
        return want && (pin.side === want || pin.side === 'T' || pin.side === 'B');
      });
      const chan = hi > lo ? (fits(lo) ? lo : undefined) : fits(lo) ? lo : fits(lo - 1) ? lo - 1 : undefined;
      if (chan === undefined) {
        label();
        continue;
      }
      for (const { node, pin } of list) {
        pin.role = 'wire';
        pin.exit = node.col === chan ? 'R' : 'L';
      }
    }
  }

  /** Room around a gate for what its top and bottom pins carry. */
  private measure(n: Node): void {
    for (const p of n.pins) {
      if (p.side !== 'T' && p.side !== 'B') continue;
      const need = p.role === 'supply' ? G + (this.supplies.get(p.net!.name)?.reach ?? G)
        : p.role === 'label' ? G + labelWidth(p.net!.name)
        : p.role === 'wire' ? G
        : 0;
      const edge = p.side === 'T' ? n.box.y1 - p.local[1] : p.local[1] - n.box.y0;
      if (p.side === 'T') n.above = Math.max(n.above, need - edge);
      else n.below = Math.max(n.below, need - edge);
    }
  }

  private pinAt(n: Node, p: PinInfo): Vec {
    return [r6(n.at[0] + p.local[0]), r6(n.at[1] + p.local[1])];
  }

  /** The nets wired in each channel, with their tracks. */
  private route(): Map<number, { net: RNet; exits: { node: Node; pin: PinInfo; y: number }[]; track: number }[]> {
    const out = new Map<number, { net: RNet; exits: { node: Node; pin: PinInfo; y: number }[]; track: number }[]>();
    const byNet = new Map<RNet, { node: Node; pin: PinInfo }[]>();
    for (const n of this.nodes) for (const p of n.pins) if (p.role === 'wire') byNet.set(p.net!, [...(byNet.get(p.net!) ?? []), { node: n, pin: p }]);
    for (const [net, list] of byNet) {
      const chan = Math.min(...list.map(({ node, pin }) => (pin.exit === 'R' ? node.col : node.col - 1)));
      const exits = list.map(({ node, pin }) => ({
        node, pin,
        y: r6(node.at[1] + pin.local[1] + (pin.side === 'T' ? G : pin.side === 'B' ? -G : 0)),
      }));
      const ys = exits.map((e) => e.y);
      const top = Math.max(...ys);
      const bottom = Math.min(...ys);
      // A four-way crossing: pins from both sides meeting the trunk at one point inside it.
      const crossing = exits.some((a) => a.y < top && a.y > bottom && exits.some((b) => b !== a && b.y === a.y && b.pin.exit !== a.pin.exit));
      if (crossing) {
        for (const { pin } of list) pin.role = 'label';
        continue;
      }
      const list2 = out.get(chan) ?? [];
      list2.push({ net, exits, track: -1 });
      out.set(chan, list2);
    }
    // Tracks: left edge first (by top), each on the first track free below its span.
    for (const nets of out.values()) {
      const spans = nets.map((n) => ({ n, top: Math.max(...n.exits.map((e) => e.y)), bottom: Math.min(...n.exits.map((e) => e.y)) }))
        .filter((s) => s.top > s.bottom || s.n.exits.length > 2)
        .sort((a, b) => b.top - a.top);
      const lastBottom: number[] = [];
      for (const s of spans) {
        let t = lastBottom.findIndex((b) => b > s.top + G / 2);
        if (t < 0) t = lastBottom.length;
        lastBottom[t] = s.bottom;
        s.n.track = t;
      }
    }
    return out;
  }

  /** Lane width beside a column's side: label stubs and text, sideways supply symbols. */
  private lane(col: number, side: 'L' | 'R'): number {
    let w = 0;
    for (const n of this.nodes) {
      if (n.col !== col) continue;
      for (const p of n.pins) {
        if (p.side !== side) continue;
        if (p.role === 'label') w = Math.max(w, G + labelWidth(p.net!.name));
        else if (p.role === 'supply') w = Math.max(w, G + (this.supplies.get(p.net!.name)?.reach ?? G) + G / 2);
      }
    }
    return w;
  }

  private channelWidth(c: number, nets: { track: number }[] | undefined): number {
    const tracks = Math.max(0, ...(nets ?? []).map((n) => n.track + 1));
    return snap(this.lane(c, 'R') + (tracks + 1) * G + this.lane(c + 1, 'L')) || 2 * G;
  }

  private emit(channels: Map<number, { net: RNet; exits: { node: Node; pin: PinInfo; y: number }[]; track: number }[]>, chanLeft: Map<number, number>, width: number): Drawn {
    const gates: O.GatePlacement[] = [];
    const segments: Drawn['segments'] = [];
    const supplyParts: Drawn['supplyParts'] = [];
    const wire = (a: Vec, b: Vec): O.Wire => ({ line: [[r6(a[0]), r6(a[1])], [r6(b[0]), r6(b[1])]], width: WIRE });
    for (const n of this.nodes) {
      gates.push({ part: n.part.part.name, gate: n.gate.name, at: [n.at[0], n.at[1]], ...(n.rot ? { rot: n.rot } : {}) });
      for (const p of n.pins) {
        if (!p.net || p.role === 'wire') continue;
        const at = this.pinAt(n, p);
        const out = OUT[p.side];
        const end: Vec = [at[0] + out[0] * G, at[1] + out[1] * G];
        if (p.role === 'supply') {
          const s = this.supplies.get(p.net.name);
          if (!s) continue;
          const turn = (angleOf(out) - angleOf(s.body) + 360) % 360;
          const pinLocal = rot([s.pin.at[0], s.pin.at[1]], turn);
          const name = this.supplyName(s);
          supplyParts.push({ name, component: s.component.id, variant: s.component.variants[0]?.name ?? '' });
          gates.push({ part: name, gate: s.gate.name, at: [r6(end[0] - pinLocal[0]), r6(end[1] - pinLocal[1])], ...(turn ? { rot: turn } : {}) });
          segments.push({ net: p.net.name, segment: { pins: [p.ref, { part: name, gate: s.gate.name, pin: s.pin.name }], wires: [wire(at, end)] } });
        } else {
          const w = wire(at, end);
          const seg: Omit<O.Segment, 'sheet'> = { pins: [p.ref], wires: [w] };
          seg.labels = [labelFor(seg as O.Segment, w, [at])];
          segments.push({ net: p.net.name, segment: seg });
        }
      }
    }
    for (const [c, nets] of channels) {
      const left = chanLeft.get(c)!;
      for (const { net, exits, track } of nets) {
        const tx = snap(left + this.lane(c, 'R') + G * (track + 1));
        const wires: O.Wire[] = [];
        const junctions: O.Pt[] = [];
        const points: Vec[] = [];
        for (const e of exits) {
          const at = this.pinAt(e.node, e.pin);
          let from = at;
          if (e.pin.side === 'T' || e.pin.side === 'B') {
            from = [at[0], e.y];
            wires.push(wire(at, from));
          }
          points.push(from);
        }
        if (track < 0) {
          // Two pins facing each other at one height: one wire straight across.
          wires.push(wire(points[0]!, points[1]!));
        } else {
          const ys = [...new Set(exits.map((e) => e.y))].sort((a, b) => b - a);
          for (const from of points) wires.push(wire(from, [tx, from[1]]));
          for (let i = 0; i + 1 < ys.length; i++) wires.push(wire([tx, ys[i]!], [tx, ys[i + 1]!]));
          for (const y of ys) {
            const meeting = exits.filter((e) => e.y === y).length + (y === ys[0] ? 0 : 1) + (y === ys[ys.length - 1] ? 0 : 1);
            if (meeting >= 3) junctions.push([tx, y]);
          }
        }
        segments.push({ net: net.name, segment: { pins: exits.map((e) => e.pin.ref), wires, ...(junctions.length ? { junctions } : {}) } });
      }
    }
    // The block's extent: gates with their room, wires and labels.
    const pts: Vec[] = [[0, 0], [width, 0]];
    for (const n of this.nodes) pts.push([n.at[0] + n.box.x0, n.at[1] + n.box.y0 - n.below], [n.at[0] + n.box.x1, n.at[1] + n.box.y1 + n.above]);
    for (const { segment } of segments) for (const w of segment.wires) pts.push(w.line[0], w.line[1]);
    return { gates, segments, supplyParts, box: boxOf(pts) };
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

  // Blocks, in the order described (parts outside any block form one more), then laid out in
  // rows across the sheet.
  const blocks = [...design.blocks, ...(design.parts.some((p) => !p.block) ? [''] : [])];
  let supplyCount = 0;
  const supplyName = (s: SupplySymbol) => `${s.component.prefix || 'SUPPLY'}${++supplyCount}`;
  const drawn = blocks.map((b) => new BlockLayout(b, design.parts.filter((p) => p.block === b), design.nets, supplies, supplyName).layout());
  const sheet = project.schematic!.sheets[0]!;
  const nets = new Map<string, O.Net>();
  const netOf = (name: string) => {
    let n = nets.get(name);
    if (!n) nets.set(name, (n = { name, segments: [] }));
    return n;
  };
  for (const n of design.nets) netOf(n.name);
  // A top-level block and the blocks inside it stay together, side by side (its own parts
  // first), so its outline is one area; rows wrap between such groups.
  const top = (b: string) => b.split('/')[0]!;
  const groups: number[][] = [];
  for (const t of [...new Set(blocks.map(top))]) {
    const members = blocks.map((b, i) => ({ b, i })).filter(({ b }) => top(b) === t);
    groups.push([...members.filter(({ b }) => b === t), ...members.filter(({ b }) => b !== t)].map(({ i }) => i));
  }
  const width = (i: number) => drawn[i]!.box.x1 - drawn[i]!.box.x0;
  let x = 0;
  let rowTop = 0;
  let rowBottom = 0;
  for (const group of groups) {
    const gw = group.reduce((s, i) => s + width(i), 0) + INNER_GAP * (group.length - 1);
    if (x > 0 && x + gw > SHEET_WIDTH) {
      x = 0;
      rowTop = rowBottom - BLOCK_GAP;
    }
    group.forEach((i, k) => {
      place(drawn[i]!);
      x = snap(x + (k < group.length - 1 ? INNER_GAP : BLOCK_GAP));
    });
  }
  function place(d: Drawn): void {
    const bw = d.box.x1 - d.box.x0;
    const dx = snap(x - d.box.x0);
    const dy = snap(rowTop - d.box.y1);
    const move = (p: O.Pt): O.Pt => [r6(p[0] + dx), r6(p[1] + dy)];
    project.parts.push(...d.supplyParts);
    for (const g of d.gates) sheet.gates.push({ ...g, at: move(g.at) });
    for (const { net, segment } of d.segments) {
      const seg: O.Segment = {
        sheet: '1',
        pins: segment.pins,
        wires: segment.wires.map((w) => ({ ...w, line: [move(w.line[0]), move(w.line[1])] })),
        ...(segment.junctions ? { junctions: segment.junctions.map(move) } : {}),
        ...(segment.labels ? { labels: segment.labels.map((l) => ({ ...l, at: move(l.at) })) } : {}),
      };
      netOf(net).segments!.push(seg);
    }
    x = snap(x + bw);
    rowBottom = Math.min(rowBottom, dy + d.box.y0);
  }
  // Sheet coordinates from the origin up, as Eagle's are.
  const lift = snap(-rowBottom + 2 * G);
  for (const g of sheet.gates) g.at = [g.at[0] + 2 * G, r6(g.at[1] + lift)];
  const shift = (p: O.Pt): O.Pt => [r6(p[0] + 2 * G), r6(p[1] + lift)];
  for (const n of nets.values()) {
    for (const s of n.segments!) {
      for (const w of s.wires) w.line = [shift(w.line[0]), shift(w.line[1])];
      if (s.junctions) s.junctions = s.junctions.map(shift);
      if (s.labels) for (const l of s.labels) l.at = shift(l.at);
    }
  }
  project.nets = [...nets.values()].filter((n) => n.segments!.length);
  return project;
}
