// Routing traces on the board. A route starts on copper of a net (a pad, via or trace end),
// runs in legs on one copper layer at a time, changes layer through vias, and ends on copper
// of the same net. Traces and vias are stored on the net; the airwires they replace are derived
// (see ratsnest.ts), so they disappear by themselves.

import { netPads, ProjectIndex } from '../model/derive';
import { padPosition } from '../model/geometry';
import type * as O from '../model/types';
import { insert, set, type Transaction } from './ops';

const EPS = 1e-4;
const round = (v: number) => Math.round(v * 1e6) / 1e6;
export const DEFAULT_TRACE_WIDTH = 0.254;
/** The drill most of Eagle's boards use for vias (13.8 mil). */
export const DEFAULT_VIA_DRILL = 0.35;

/** Copper a route can start or end on. */
export interface Anchor {
  at: O.Pt;
  net: string;
  kind: 'pad' | 'via' | 'trace';
  /** Copper layers it is on. */
  layers: string[];
  /** For pads: which. */
  pad?: { part: string; pad: string };
}

/** The copper layers of the board, top to bottom. */
export function copperLayers(project: O.Project): string[] {
  const stack = project.board?.layers ?? [];
  return stack.length ? stack : ['copper.top', 'copper.bottom'];
}

/** Pads (on a net), vias and trace ends of the board, as route anchors. */
export function anchors(project: O.Project, index = new ProjectIndex(project)): Anchor[] {
  const board = project.board;
  if (!board) return [];
  const stack = copperLayers(project);
  const out: Anchor[] = [];
  const netOfPad = new Map<string, string>();
  for (const [net, keys] of netPads(project, index)) for (const k of keys) netOfPad.set(k, net);
  for (const f of board.footprints) {
    const part = index.parts.get(f.part);
    const fpId = part && index.variantOf(part)?.footprint;
    const fp = fpId ? index.footprints.get(fpId) : undefined;
    for (const pad of fp?.pads ?? []) {
      const net = netOfPad.get(`${f.part}\u0000${pad.name}`);
      const p = net && padPosition(index, f, pad.name);
      if (!net || !p) continue;
      const layers = pad.smd ? [(pad.side === 'bottom') !== (f.side === 'bottom') ? 'copper.bottom' : 'copper.top'] : stack;
      out.push({ at: [round(p.x), round(p.y)], net, kind: 'pad', layers, pad: { part: f.part, pad: pad.name } });
    }
  }
  for (const net of project.nets) {
    for (const v of net.vias ?? []) out.push({ at: v.at, net: net.name, kind: 'via', layers: stack });
    for (const t of net.traces ?? []) {
      if (!stack.includes(t.layer)) continue;
      for (const at of t.line) out.push({ at, net: net.name, kind: 'trace', layers: [t.layer] });
    }
  }
  return out;
}

/** The width for new traces of a net: its class's width, else the board's usual width. */
export function traceWidth(project: O.Project, netName: string): number {
  const net = project.nets.find((n) => n.name === netName);
  const cls = project.board?.classes?.find((c) => c.number === (net?.class ?? 0));
  if (cls?.width) return cls.width;
  return mostCommon(project.nets.flatMap((n) => (n.traces ?? []).map((t) => t.width))) ?? DEFAULT_TRACE_WIDTH;
}

/** The drill for new vias of a net: its class's drill, else the board's usual drill. */
export function viaDrill(project: O.Project, netName: string): number {
  const net = project.nets.find((n) => n.name === netName);
  const cls = project.board?.classes?.find((c) => c.number === (net?.class ?? 0));
  if (cls?.drill) return cls.drill;
  return mostCommon(project.nets.flatMap((n) => (n.vias ?? []).map((v) => v.drill))) ?? DEFAULT_VIA_DRILL;
}

function mostCommon(values: number[]): number | undefined {
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best: number | undefined;
  let n = 0;
  for (const [v, c] of count) if (c > n) [best, n] = [v, c];
  return best;
}

/**
 * The bend from `from` to `to` in 45° style: a straight run and a diagonal. `diagonalFirst`
 * puts the diagonal at the start. Returns the points after `from`.
 */
export function bend45(from: O.Pt, to: O.Pt, diagonalFirst: boolean): O.Pt[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < EPS || ay < EPS || Math.abs(ax - ay) < EPS) return [to];
  const m = Math.min(ax, ay);
  const sx = Math.sign(dx) * m;
  const sy = Math.sign(dy) * m;
  const corner: O.Pt = diagonalFirst ? [round(from[0] + sx), round(from[1] + sy)] : [round(to[0] - sx), round(to[1] - sy)];
  return [corner, to];
}

export interface Leg {
  line: [O.Pt, O.Pt];
  layer: string;
}

/** Add a route's traces and vias to a net (one transaction). */
export function addRoute(project: O.Project, netName: string, legs: Leg[], vias: O.Pt[], tx: Transaction): { traces: O.Trace[]; vias: O.Via[] } {
  const net = project.nets.find((n) => n.name === netName);
  if (!net) throw new Error(`No net ${netName}`);
  const width = traceWidth(project, netName);
  const traces: O.Trace[] = [];
  for (const l of legs) {
    const [a, b] = l.line;
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) continue;
    traces.push({ line: [[round(a[0]), round(a[1])], [round(b[0]), round(b[1])]], width, layer: l.layer });
  }
  if (traces.length && !net.traces) tx.run(set(net, { traces: [] }));
  for (const t of traces) tx.run(insert(net.traces!, t));
  const drill = viaDrill(project, netName);
  const added: O.Via[] = [];
  for (const at of vias) {
    if (net.vias?.some((v) => Math.abs(v.at[0] - at[0]) < EPS && Math.abs(v.at[1] - at[1]) < EPS)) continue;
    if (!net.vias) tx.run(set(net, { vias: [] }));
    const via: O.Via = { at: [round(at[0]), round(at[1])], drill };
    tx.run(insert(net.vias!, via));
    added.push(via);
  }
  tx.subjects.push(...traces, ...added);
  return { traces, vias: added };
}
