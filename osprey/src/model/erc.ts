// Electrical rule check (ERC) on the schematic: what the board's DRC can't see. Pins left
// unconnected, nets with a single pin, outputs driving each other or a supply, nets that only
// inputs listen to, supplies joined together, pins a net lists that no wire reaches, pins
// touching a wire they aren't connected to, and parts missing from the board.

import type { Point } from '../geom/transform';
import { componentName, ProjectIndex } from './derive';
import { pinPosition } from './geometry';
import type * as O from './types';

export type ErcKind = 'unconnected' | 'single' | 'conflict' | 'undriven' | 'nc' | 'supply' | 'unwired' | 'touching' | 'board';

export interface ErcProblem {
  kind: ErcKind;
  severity: 'error' | 'warning';
  message: string;
  /** Sheet id and point to look at, when the problem has a place on a sheet. */
  sheet?: string;
  at?: O.Pt;
  /** Model objects involved: gate placements, wires, footprint placements. */
  objects: object[];
  nets: string[];
  parts: string[];
  /** Accepted as it is (in the schematic's `approved` list). */
  approved?: true;
}

/** What identifies a problem in the schematic's `approved` list: its kind and message. */
export const ercKey = (p: Pick<ErcProblem, 'kind' | 'message'>) => `${p.kind}: ${p.message}`;

export interface ErcResult {
  /** All problems found, approved ones included (marked `approved`). */
  problems: ErcProblem[];
  /** How many pins and nets were checked. */
  pins: number;
  nets: number;
}

type Direction = O.PinDirection;

/** A pin of a part, placed on a sheet or not (unplaced gates matter only for implicit power). */
interface PinInfo {
  key: string;
  part: string;
  gate: string;
  pin: string;
  direction: Direction;
  /** The gate's placement and the pin's position, when the gate is on a sheet. */
  placement?: O.GatePlacement;
  sheet?: string;
  pos?: Point;
  /** Joins a net by name only (an unwired power pin). */
  implicit?: true;
}

const EPS = 1e-3;
const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const pt = (p: O.Pt): Point => ({ x: p[0], y: p[1] });
const toPt = (p: Point): O.Pt => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6];
const pinKey = (part: string, gate: string, pin: string) => `${part}\u0000${gate}\u0000${pin}`;

/** Whether p lies on the segment a–b. */
function onLine(p: Point, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS * EPS) return near(p, a);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < -EPS || t > 1 + EPS) return false;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < EPS;
}

const onWires = (p: Point, wires: O.Wire[]) => wires.some((w) => onLine(p, pt(w.line[0]), pt(w.line[1])));

export function erc(project: O.Project, index = new ProjectIndex(project)): ErcResult {
  const problems: ErcProblem[] = [];
  const schematic = project.schematic;
  if (!schematic) return { problems, pins: 0, nets: 0 };

  // How pins are named in messages: "R1 pin 2", or "U1 A pin 3" for parts with several gates.
  const gateCount = (part: string) => index.components.get(index.parts.get(part)?.component ?? '')?.gates.length ?? 1;
  const describe = (p: { part: string; gate: string; pin: string }) =>
    `${p.part}${gateCount(p.part) > 1 ? ` ${p.gate}` : ''} pin ${p.pin.replace(/@.*$/, '')}`;

  // Every pin of every part, with its placement where the gate is on a sheet.
  const pins = new Map<string, PinInfo>();
  const placements = new Map<string, { sheet: string; g: O.GatePlacement }>();
  for (const sheet of schematic.sheets) for (const g of sheet.gates) placements.set(`${g.part}\u0000${g.gate}`, { sheet: sheet.id, g });
  for (const part of project.parts) {
    const component = index.components.get(part.component);
    for (const gate of component?.gates ?? []) {
      const placed = placements.get(`${part.name}\u0000${gate.name}`);
      for (const pin of index.symbols.get(gate.symbol)?.pins ?? []) {
        const key = pinKey(part.name, gate.name, pin.name);
        const pos = placed && pinPosition(index, placed.g, pin.name);
        pins.set(key, {
          key, part: part.name, gate: gate.name, pin: pin.name, direction: pin.direction ?? 'io',
          ...(placed ? { placement: placed.g, sheet: placed.sheet } : {}),
          ...(pos ? { pos } : {}),
        });
      }
    }
  }

  // Which nets each pin is wired to, and each net's pins (wired, then implicit power).
  const wiredTo = new Map<string, Set<string>>();
  const members = new Map<string, PinInfo[]>();
  const memberOf = (net: string) => {
    let m = members.get(net);
    if (!m) members.set(net, (m = []));
    return m;
  };
  for (const net of project.nets) {
    if (!net.segments?.length) continue;
    const m = memberOf(net.name);
    for (const seg of net.segments) {
      for (const pr of seg.pins) {
        const key = pinKey(pr.part, pr.gate, pr.pin);
        const info = pins.get(key);
        if (!info) continue;
        let nets = wiredTo.get(key);
        if (!nets) wiredTo.set(key, (nets = new Set()));
        if (!nets.has(net.name)) m.push(info);
        nets.add(net.name);
      }
    }
  }
  for (const info of pins.values()) {
    if (info.direction !== 'power' || wiredTo.has(info.key)) continue;
    const implicit = { ...info, implicit: true as const };
    pins.set(info.key, implicit);
    memberOf(info.pin.replace(/@.*$/, '')).push(implicit);
  }

  const at = (p: PinInfo) => ({ ...(p.sheet ? { sheet: p.sheet } : {}), ...(p.pos ? { at: toPt(p.pos) } : {}) });
  const objectsOf = (ps: PinInfo[]) => [...new Set(ps.flatMap((p) => (p.placement ? [p.placement] : [])))];
  const netWires = (name: string) => project.nets.find((n) => n.name === name)?.segments?.flatMap((s) => s.wires) ?? [];

  // Wire ends on each sheet, by net, for pins that touch a wire without being connected.
  const wiresBySheet = new Map<string, { net: string; wires: O.Wire[] }[]>();
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) {
      const list = wiresBySheet.get(seg.sheet) ?? [];
      list.push({ net: net.name, wires: seg.wires });
      wiresBySheet.set(seg.sheet, list);
    }
  }

  // Pins: unconnected, touching a wire of a net they aren't on, on two nets, not-connect pins wired.
  for (const p of pins.values()) {
    if (!p.placement) continue;
    const nets = wiredTo.get(p.key);
    if (nets && nets.size > 1) {
      problems.push({
        kind: 'conflict', severity: 'error', message: `${describe(p)} is on ${nets.size} nets: ${[...nets].join(', ')}`,
        ...at(p), objects: [p.placement, ...[...nets].flatMap(netWires)], nets: [...nets], parts: [p.part],
      });
    }
    if (nets && p.direction === 'nc') {
      problems.push({
        kind: 'nc', severity: 'warning', message: `${describe(p)} is marked not to connect, but is on ${[...nets].join(', ')}`,
        ...at(p), objects: [p.placement], nets: [...nets], parts: [p.part],
      });
    }
    if (nets || p.implicit || p.direction === 'nc') continue;
    const touched = p.pos && p.sheet ? wiresBySheet.get(p.sheet)?.find((s) => onWires(p.pos!, s.wires)) : undefined;
    if (touched) {
      problems.push({
        kind: 'touching', severity: 'warning', message: `${describe(p)} touches a wire of ${touched.net} but isn't connected to it`,
        ...at(p), objects: [p.placement, ...touched.wires], nets: [touched.net], parts: [p.part],
      });
    } else {
      problems.push({
        kind: 'unconnected', severity: 'warning', message: `${describe(p)} is unconnected`,
        ...at(p), objects: [p.placement], nets: [], parts: [p.part],
      });
    }
  }

  // Pins a segment lists that no wire of it reaches (nor another of its pins, pin on pin).
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) {
      const segPins = seg.pins.map((pr) => pins.get(pinKey(pr.part, pr.gate, pr.pin))).filter((p): p is PinInfo => !!p?.pos);
      for (const p of segPins) {
        if (onWires(p.pos!, seg.wires) || segPins.some((q) => q !== p && near(q.pos!, p.pos!))) continue;
        problems.push({
          kind: 'unwired', severity: 'warning', message: `${describe(p)} is on ${net.name}, but no wire reaches it`,
          ...at(p), objects: [p.placement!, ...seg.wires], nets: [net.name], parts: [p.part],
        });
      }
    }
  }

  // Nets: a single pin, outputs driving each other or a supply, supplies joined, only inputs,
  // implicit power with nothing supplying it.
  for (const [name, m] of members) {
    const wires = netWires(name);
    const where = m.find((p) => p.pos) ?? m[0];
    const loc = where ? at(where) : firstWire(project, name);
    const base = { ...loc, nets: [name], parts: [...new Set(m.map((p) => p.part))] };
    const by = (...ds: Direction[]) => m.filter((p) => ds.includes(p.direction));
    const list = (ps: PinInfo[]) => ps.map(describe).join(', ');

    if (m.length === 0) {
      problems.push({ kind: 'single', severity: 'warning', message: `${name} has wires but no pins`, ...base, objects: wires });
      continue;
    }
    if (m.every((p) => p.implicit)) {
      const ps = [...new Set(m.map((p) => p.part))];
      problems.push({
        kind: 'supply', severity: 'warning',
        message: `Nothing supplies ${name}: power pins of ${ps.join(', ')} join it, but no supply or wire does`,
        ...base, objects: objectsOf(m),
      });
      continue;
    }
    if (m.length === 1) {
      problems.push({ kind: 'single', severity: 'warning', message: `${name} connects only ${describe(m[0]!)}`, ...base, objects: [...objectsOf(m), ...wires] });
      continue;
    }
    const outs = by('out');
    const ocs = by('oc');
    const supplies = by('supply');
    if (outs.length > 1) {
      problems.push({ kind: 'conflict', severity: 'error', message: `Outputs drive each other on ${name}: ${list(outs)}`, ...base, objects: [...objectsOf(outs), ...wires] });
    } else if (outs.length && ocs.length) {
      problems.push({ kind: 'conflict', severity: 'error', message: `${describe(outs[0]!)} drives open-collector ${list(ocs)} on ${name}`, ...base, objects: [...objectsOf([...outs, ...ocs]), ...wires] });
    }
    if (outs.length && supplies.length) {
      problems.push({ kind: 'conflict', severity: 'error', message: `${list(outs)} drives supply ${supplies[0]!.pin.replace(/@.*$/, '')} on ${name}`, ...base, objects: [...objectsOf([...outs, ...supplies]), ...wires] });
    }
    const supplyNames = [...new Set(supplies.map((p) => p.pin.replace(/@.*$/, '')))];
    if (supplyNames.length > 1) {
      problems.push({ kind: 'supply', severity: 'error', message: `Supplies ${supplyNames.join(' and ')} are joined on ${name}`, ...base, objects: [...objectsOf(supplies), ...wires] });
    }
    const listeners = by('in');
    if (listeners.length && m.every((p) => p.direction === 'in' || p.direction === 'power' || p.direction === 'nc')) {
      problems.push({ kind: 'undriven', severity: 'warning', message: `Only inputs on ${name}: nothing drives ${list(listeners)}`, ...base, objects: [...objectsOf(listeners), ...wires] });
    }
  }

  // Parts with a footprint that aren't on the board.
  if (project.board) {
    const onBoard = new Set(project.board.footprints.map((f) => f.part));
    for (const part of project.parts) {
      if (onBoard.has(part.name) || !index.variantOf(part)?.footprint) continue;
      const placed = [...placements.values()].find((x) => x.g.part === part.name);
      if (!placed) continue;
      problems.push({
        kind: 'board', severity: 'warning', message: `${part.name} (${componentName(part.component)}) isn't on the board`,
        sheet: placed.sheet, at: placed.g.at, objects: [placed.g], nets: [], parts: [part.name],
      });
    }
  }

  const approved = new Set(schematic.approved ?? []);
  for (const p of problems) if (approved.has(ercKey(p))) p.approved = true;
  const order = (p: ErcProblem) => (p.severity === 'error' ? 0 : 1);
  problems.sort((a, b) => order(a) - order(b));
  return { problems, pins: [...pins.values()].filter((p) => p.placement).length, nets: members.size };
}

function firstWire(project: O.Project, name: string): { sheet?: string; at?: O.Pt } {
  const seg = project.nets.find((n) => n.name === name)?.segments?.find((s) => s.wires.length);
  return seg ? { sheet: seg.sheet, at: seg.wires[0]!.line[0] } : {};
}
