// Drawing schematic wires. A wire's ends (and corners) connect to the pins and wires they land
// on. When those belong to different nets, the nets are joined into one; its name is the
// strongest of theirs (supply > named by the user > automatic N$n), and when two equally strong
// names meet, the caller must choose. Junctions are added where three or more wire ends meet,
// or a wire ends on the middle of another.

import { apply } from '../geom/transform';
import { ProjectIndex } from '../model/derive';
import { gateTransform } from '../model/geometry';
import type * as O from '../model/types';
import { insert, remove, set, type Transaction } from './ops';
import { supplyReason } from './properties';

const EPS = 1e-4;
/** Eagle's default width for net wires (6 mil). */
export const DEFAULT_WIRE_WIDTH = 0.1524;

const same = (a: O.Pt, b: O.Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export interface SheetPin {
  ref: O.PinRef;
  at: O.Pt;
  pin: O.Pin;
}

/** Every pin of the gates placed on a sheet, with its world position. */
export function sheetPins(project: O.Project, sheet: O.Sheet, index = new ProjectIndex(project)): SheetPin[] {
  const out: SheetPin[] = [];
  for (const g of sheet.gates) {
    const component = index.components.get(index.parts.get(g.part)?.component ?? '');
    const gate = component?.gates.find((x) => x.name === g.gate);
    const symbol = gate && index.symbols.get(gate.symbol);
    if (!symbol) continue;
    const T = gateTransform(g);
    for (const pin of symbol.pins) {
      const p = apply(T, pin.at[0], pin.at[1]);
      out.push({ ref: { part: g.part, gate: g.gate, pin: pin.name }, at: [round(p.x), round(p.y)], pin });
    }
  }
  return out;
}

/** Is `p` on the wire strictly between its ends? (Arcs only connect at their ends.) */
function onInterior(w: O.Wire, p: O.Pt): boolean {
  if (w.curve) return false;
  const [a, b] = w.line;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return false;
  const cross = Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len;
  const t = (dx * (p[0] - a[0]) + dy * (p[1] - a[1])) / (len * len);
  return cross < EPS && t * len > EPS && (1 - t) * len > EPS;
}

export interface SegmentRef {
  net: O.Net;
  segment: O.Segment;
}

/** What a point on a sheet touches: pins, and wired segments (by a wire or a connected pin). */
export interface Touch {
  pins: SheetPin[];
  segments: SegmentRef[];
}

export function touchAt(project: O.Project, sheet: O.Sheet, p: O.Pt, pins: SheetPin[]): Touch {
  const hitPins = pins.filter((x) => same(x.at, p));
  const segments: SegmentRef[] = [];
  for (const net of project.nets) {
    for (const segment of net.segments ?? []) {
      if (segment.sheet !== sheet.id) continue;
      const byWire = segment.wires.some((w) => same(w.line[0], p) || same(w.line[1], p) || onInterior(w, p));
      const byPin = hitPins.some((h) => segment.pins.some((r) => r.part === h.ref.part && r.gate === h.ref.gate && r.pin === h.ref.pin));
      if (byWire || byPin) segments.push({ net, segment });
    }
  }
  return { pins: hitPins, segments };
}

/** Points a wire end snaps to on a sheet: pins and existing wire ends. */
export function snapPoints(project: O.Project, sheet: O.Sheet, index = new ProjectIndex(project)): O.Pt[] {
  const out: O.Pt[] = sheetPins(project, sheet, index).map((p) => p.at);
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) if (seg.sheet === sheet.id) for (const w of seg.wires) out.push(w.line[0], w.line[1]);
  }
  return out;
}

/** The width most net wires in the project have (Eagle's 6 mil default without any). */
export function usualWireWidth(project: O.Project): number {
  const count = new Map<number, number>();
  for (const net of project.nets) for (const seg of net.segments ?? []) for (const w of seg.wires) count.set(w.width, (count.get(w.width) ?? 0) + 1);
  let best = DEFAULT_WIRE_WIDTH;
  let n = 0;
  for (const [w, c] of count) if (c > n) [best, n] = [w, c];
  return best;
}

/** The next free automatic net name, e.g. "N$12". */
export function nextNetName(project: O.Project): string {
  let max = 0;
  for (const n of project.nets) {
    const m = /^N\$(\d+)$/.exec(n.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `N$${max + 1}`;
}

const AUTO = /^N\$(\d+)$/;

/** How strongly a net holds on to its name when joined: supply 3, user-named 2, automatic 1. */
function strength(project: O.Project, net: O.Net, index: ProjectIndex): number {
  if (supplyReason(project, net, index)) return 3;
  return AUTO.test(net.name) ? 1 : 2;
}

/** Clean up a drawn path: snap to 1e-6 mm, drop repeated points and straight-through corners. */
export function cleanPath(path: O.Pt[]): O.Pt[] {
  const out: O.Pt[] = [];
  for (const raw of path) {
    const p: O.Pt = [round(raw[0]), round(raw[1])];
    if (out.length && same(out[out.length - 1]!, p)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
      if (Math.abs(cross) < EPS && dot > 0) out.pop();
    }
    out.push(p);
  }
  return out;
}

export type WireResult =
  /** The wire was added to this net. */
  | { net: string; joined: string[] }
  /** Equally strong net names meet: call again with one of them. */
  | { choose: string[] };

/**
 * Add a wire along `path` (a polyline) on a sheet. Returns undefined for a path with no length.
 * When the wire would join nets whose names are equally strong and `name` doesn't pick one,
 * nothing is changed and the names to choose from are returned.
 */
export function addWire(project: O.Project, sheet: O.Sheet, path: O.Pt[], tx: Transaction, opts: { width?: number; name?: string; index?: ProjectIndex } = {}): WireResult | undefined {
  const pts = cleanPath(path);
  if (pts.length < 2) return undefined;
  const index = opts.index ?? new ProjectIndex(project);
  const pins = sheetPins(project, sheet, index);

  // What the wire's ends and corners touch.
  const segs: SegmentRef[] = [];
  const newPins: SheetPin[] = [];
  for (const p of pts) {
    const t = touchAt(project, sheet, p, pins);
    for (const s of t.segments) if (!segs.some((x) => x.segment === s.segment)) segs.push(s);
    for (const pin of t.pins) if (!newPins.some((x) => sameRef(x.ref, pin.ref))) newPins.push(pin);
  }
  const nets = [...new Set(segs.map((s) => s.net))];

  // The joined net's name: the strongest; supply pins wired here name it too.
  const candidates = new Map<string, number>();
  for (const n of nets) candidates.set(n.name, strength(project, n, index));
  for (const p of newPins) if (p.pin.direction === 'supply') candidates.set(p.pin.name.replace(/@.*$/, ''), 3);
  let winner: string;
  if (candidates.size === 0) {
    winner = nextNetName(project);
  } else {
    const top = Math.max(...candidates.values());
    const names = [...candidates].filter(([, s]) => s === top).map(([n]) => n).sort(naturalCompare);
    if (top > 1 && names.length > 1) {
      if (!opts.name || !names.includes(opts.name)) return { choose: names };
      winner = opts.name;
    } else {
      winner = names[0]!; // automatic names: keep the lowest number
    }
  }

  let target = project.nets.find((n) => n.name === winner);
  if (!target) {
    target = { name: winner, segments: [] };
    tx.run(insert(project.nets, target));
  }
  const joined: string[] = [];
  for (const n of nets) {
    if (n === target) continue;
    joinNet(project, n, target, tx);
    joined.push(n.name);
  }
  if (!target.segments) tx.run(set(target, { segments: [] }));

  // One segment on this sheet holds everything the wire connects.
  let host = segs[0]?.segment;
  if (!host) {
    host = { sheet: sheet.id, pins: [], wires: [] };
    tx.run(insert(target.segments!, host));
  }
  for (const { segment } of segs.slice(1)) {
    if (segment === host) continue;
    for (const r of segment.pins) if (!host.pins.some((x) => sameRef(x, r))) tx.run(insert(host.pins, r));
    for (const w of segment.wires) tx.run(insert(host.wires, w));
    for (const j of segment.junctions ?? []) addJunction(host, j, tx);
    for (const l of segment.labels ?? []) {
      if (!host.labels) tx.run(set(host, { labels: [] }));
      tx.run(insert(host.labels!, l));
    }
    tx.run(remove(target.segments!, segment));
  }

  const width = opts.width ?? usualWireWidth(project);
  const wires: O.Wire[] = [];
  for (let i = 1; i < pts.length; i++) wires.push({ line: [pts[i - 1]!, pts[i]!], width });
  for (const w of wires) tx.run(insert(host.wires, w));
  for (const p of newPins) if (!host.pins.some((x) => sameRef(x, p.ref))) tx.run(insert(host.pins, { ...p.ref }));

  // Junctions where three or more wire ends meet, or a wire ends on another's middle.
  for (const p of pts) {
    let n = 0;
    for (const w of host.wires) {
      if (same(w.line[0], p)) n++;
      if (same(w.line[1], p)) n++;
      if (onInterior(w, p)) n += 2;
    }
    if (n >= 3) addJunction(host, p, tx);
  }
  tx.subjects.push(...wires);
  return { net: winner, joined };
}

/** Move everything of net `from` into `into` and remove `from`. */
export function joinNet(project: O.Project, from: O.Net, into: O.Net, tx: Transaction): void {
  for (const key of ['segments', 'traces', 'vias', 'pours', 'pads'] as const) {
    const items = from[key] as unknown[] | undefined;
    if (!items?.length) continue;
    if (!into[key]) tx.run(set(into, { [key]: [] }));
    const list = into[key] as unknown[];
    for (const item of items) tx.run(insert(list, item));
  }
  tx.run(remove(project.nets, from));
}

function addJunction(seg: O.Segment, p: O.Pt, tx: Transaction): void {
  if (seg.junctions?.some((j) => same(j, p))) return;
  if (!seg.junctions) tx.run(set(seg, { junctions: [] }));
  tx.run(insert(seg.junctions!, [p[0], p[1]]));
}

const sameRef = (a: O.PinRef, b: O.PinRef) => a.part === b.part && a.gate === b.gate && a.pin === b.pin;

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
