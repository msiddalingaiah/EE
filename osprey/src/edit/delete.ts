// Delete on the native model. A part is stored once, so deleting it in either view
// removes it everywhere; board pad connections are derived, so they follow on their own.
//
// - A gate: its placement and pin connections; the part itself once no gate of it is placed.
// - A footprint: the whole part (gates, pins, placement), as in Eagle.
// - A wire: then pins and junctions no wire end touches any more, empty segments and nets.
// - Traces, vias, pours, junctions, net labels, drawing, smashed labels: just themselves.

import { ProjectIndex } from '../model/derive';
import { pinPosition } from '../model/geometry';
import type * as O from '../model/types';
import type { Target, WireSegment } from '../scene/types';
import { dropIfEmpty, remove, type Transaction } from './ops';
import { isEditable } from './transform';

const EPS = 1e-4;

/**
 * Delete targets inside `tx`. Returns the names of parts that were kept because their
 * footprint is locked on the board.
 */
export function deleteTargets(project: O.Project, targets: Target[], tx: Transaction, index = new ProjectIndex(project)): string[] {
  const locked = new Set<string>();
  const lockedPart = (name: string) => !!project.board?.footprints.find((f) => f.part === name)?.locked;

  for (const t of targets) {
    if (!isEditable(t)) {
      if (t.kind === 'footprint') locked.add(t.footprint.part);
      continue;
    }
    switch (t.kind) {
      case 'gate':
        if (lockedPart(t.gate.part)) {
          locked.add(t.gate.part);
          break;
        }
        deleteGate(project, t.sheet, t.gate, tx);
        break;
      case 'footprint':
        deletePart(project, t.footprint.part, tx);
        break;
      case 'wire':
        if (!t.segment.wires.includes(t.wire)) break;
        tx.run(remove(t.segment.wires, t.wire));
        if (t.bus) tidyBus(project, t.net as O.Bus, t.segment, tx);
        else tidySegment(project, t.net as O.Net, t.segment as O.Segment, tx, index);
        break;
      case 'junction':
        if (t.segment.junctions?.includes(t.junction)) {
          tx.run(remove(t.segment.junctions, t.junction));
          tx.run(dropIfEmpty(t.segment, 'junctions'));
        }
        break;
      case 'netlabel':
        if (t.segment.labels?.includes(t.label)) {
          tx.run(remove(t.segment.labels, t.label));
          tx.run(dropIfEmpty(t.segment, 'labels'));
        }
        break;
      case 'trace': removeFromNet(project, t.net, 'traces', t.trace, tx); break;
      case 'via': removeFromNet(project, t.net, 'vias', t.via, tx); break;
      case 'pour': removeFromNet(project, t.net, 'pours', t.pour, tx); break;
      case 'drawing':
        if (t.container.includes(t.graphic)) tx.run(remove(t.container, t.graphic));
        break;
      case 'label':
        if (t.placement.labels?.includes(t.label)) {
          tx.run(remove(t.placement.labels, t.label));
          tx.run(dropIfEmpty(t.placement, 'labels'));
        }
        break;
    }
  }
  return [...locked];
}

/** Remove a part and everything that refers to it. */
export function deletePart(project: O.Project, name: string, tx: Transaction): void {
  const part = project.parts.find((p) => p.name === name);
  if (part) tx.run(remove(project.parts, part));
  for (const sheet of project.schematic?.sheets ?? []) {
    for (const g of sheet.gates.filter((x) => x.part === name)) tx.run(remove(sheet.gates, g));
  }
  const fp = project.board?.footprints.find((f) => f.part === name);
  if (fp) tx.run(remove(project.board!.footprints, fp));
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) {
      for (const pr of seg.pins.filter((p) => p.part === name)) tx.run(remove(seg.pins, pr));
    }
    for (const pad of (net.pads ?? []).filter((p) => p.part === name)) tx.run(remove(net.pads!, pad));
    if (net.pads) tx.run(dropIfEmpty(net, 'pads'));
  }
}

function deleteGate(project: O.Project, sheet: O.Sheet, g: O.GatePlacement, tx: Transaction): void {
  if (!sheet.gates.includes(g)) return;
  tx.run(remove(sheet.gates, g));
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) {
      for (const pr of seg.pins.filter((p) => p.part === g.part && p.gate === g.gate)) tx.run(remove(seg.pins, pr));
    }
  }
  const stillPlaced = project.schematic?.sheets.some((s) => s.gates.some((x) => x.part === g.part));
  if (!stillPlaced) deletePart(project, g.part, tx);
}

/** After removing wires: drop pins and junctions nothing touches, empty segments and nets. */
function tidySegment(project: O.Project, net: O.Net, seg: O.Segment, tx: Transaction, index: ProjectIndex): void {
  if (!net.segments?.includes(seg)) return;
  if (seg.wires.length === 0) {
    tx.run(remove(net.segments, seg));
    tx.run(dropIfEmpty(net, 'segments'));
  } else {
    const ends = seg.wires.flatMap((w) => w.line);
    const touches = (x: number, y: number) => ends.some((e) => Math.abs(e[0] - x) < EPS && Math.abs(e[1] - y) < EPS);
    const sheet = project.schematic?.sheets.find((s) => s.id === seg.sheet);
    for (const pr of [...seg.pins]) {
      const g = sheet?.gates.find((x) => x.part === pr.part && x.gate === pr.gate);
      const p = g && pinPosition(index, g, pr.pin);
      if (p && !touches(p.x, p.y)) tx.run(remove(seg.pins, pr));
    }
    for (const j of [...(seg.junctions ?? [])]) if (!touches(j[0], j[1])) tx.run(remove(seg.junctions!, j));
    if (seg.junctions) tx.run(dropIfEmpty(seg, 'junctions'));
  }
  removeNetIfEmpty(project, net, tx);
}

function tidyBus(project: O.Project, bus: O.Bus, seg: WireSegment, tx: Transaction): void {
  if (seg.wires.length) return;
  const segs = bus.segments as WireSegment[];
  if (segs.includes(seg)) tx.run(remove(segs, seg));
  if (!bus.segments.length && project.busses?.includes(bus)) {
    tx.run(remove(project.busses, bus));
    tx.run(dropIfEmpty(project, 'busses'));
  }
}

function removeFromNet<K extends 'traces' | 'vias' | 'pours'>(project: O.Project, net: O.Net, key: K, item: NonNullable<O.Net[K]>[number], tx: Transaction): void {
  const list = net[key] as unknown[] | undefined;
  if (!list?.includes(item)) return;
  tx.run(remove(list, item));
  tx.run(dropIfEmpty(net, key));
  removeNetIfEmpty(project, net, tx);
}

function removeNetIfEmpty(project: O.Project, net: O.Net, tx: Transaction): void {
  const empty = !net.segments?.length && !net.traces?.length && !net.vias?.length && !net.pours?.length && !net.pads?.length;
  if (empty && project.nets.includes(net)) tx.run(remove(project.nets, net));
}
