// Schematic editing commands: the same verbs as on boards. Net wires follow the pins
// they end on (via the segment's pinrefs); junctions follow moved wire ends.

import { findLibrary } from '../eagle/parse';
import type { Bus, Instance, Net, Schematic, Segment, Sheet, Wire } from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, composeRotation, isMirrored, placement } from '../geom/transform';
import type { Target } from '../scene/types';
import {
  dragPoints, dragWireEnds, rotAttr, samePoint, transformGraphic, transformPlacedAttributes,
  transformPoint, transformText, transformWire, xyAttrs, type EditContext,
} from './common';
import { removeItem, removeMapEntry, setFields, type Transaction } from './ops';

/** World position of a pin of a placed gate, or undefined if it can't be resolved. */
export function pinPosition(sch: Schematic, inst: Instance, pinName: string): Point | undefined {
  const part = sch.parts.get(inst.part);
  const lib = part && findLibrary(sch.libraries, part.library, part.libraryUrn);
  const gate = lib?.devicesets.get(part!.deviceset)?.gates.find((g) => g.name === inst.gate);
  const pin = gate && lib?.symbols.get(gate.symbol)?.pins.find((p) => p.name === pinName);
  return pin ? apply(placement(inst.x, inst.y, inst.rot), pin.x, pin.y) : undefined;
}

/** Every segment of a sheet's nets and busses. */
function segmentsOf(sheet: Sheet): Segment[] {
  return [...sheet.nets, ...sheet.busses].flatMap((n) => n.segments);
}

/**
 * Apply edit transform E to schematic targets inside `tx`. Wires whose ends sit on a moved
 * pin (per the segment's pinrefs), a moved wire end or a moved junction are dragged along,
 * as are junctions at those points.
 */
export function transformSchematicTargets(sch: Schematic, targets: Target[], E: Transform, tx: Transaction): void {
  const c: EditContext = { E, mirrored: isMirrored(E), swapSides: false, tx };
  const movedWires = new Set<Wire>();
  const movedJunctions = new Set<{ x: number; y: number }>();
  const movedGates = new Set<string>();
  const sheets = new Set<Sheet>();
  for (const t of targets) {
    if (t.kind === 'net-wire') movedWires.add(t.wire);
    if (t.kind === 'junction') movedJunctions.add(t.junction);
    if (t.kind === 'instance') movedGates.add(`${t.instance.part}\u0000${t.instance.gate}`);
    if ('sheet' in t) sheets.add(t.sheet);
  }

  // Old positions of everything that moves, per segment, captured before changes.
  const anchors = new Map<Segment, Point[]>();
  const add = (s: Segment, p: Point) => {
    let list = anchors.get(s);
    if (!list) anchors.set(s, (list = []));
    list.push(p);
  };
  for (const sheet of sheets) {
    for (const seg of segmentsOf(sheet)) {
      for (const pr of seg.pinrefs) {
        if (!movedGates.has(`${pr.part}\u0000${pr.gate}`)) continue;
        const inst = sheet.instances.find((i) => i.part === pr.part && i.gate === pr.gate);
        const p = inst && pinPosition(sch, inst, pr.pin);
        if (p) add(seg, p);
      }
    }
  }
  for (const t of targets) {
    if (t.kind === 'net-wire') {
      add(t.segment, { x: t.wire.x1, y: t.wire.y1 });
      add(t.segment, { x: t.wire.x2, y: t.wire.y2 });
    }
    if (t.kind === 'junction') add(t.segment, { x: t.junction.x, y: t.junction.y });
  }

  for (const t of targets) {
    switch (t.kind) {
      case 'instance': {
        const inst = t.instance;
        const p = apply(E, inst.x, inst.y);
        const rot = composeRotation(E, inst.rot);
        tx.run(setFields(inst, { x: p.x, y: p.y, rot }, { ...xyAttrs(p.x, p.y), rot: rotAttr(rot) }));
        transformPlacedAttributes(inst.attributes, c);
        break;
      }
      case 'net-wire': transformWire(t.wire, c); break;
      case 'junction': transformPoint(t.junction, c); break;
      case 'label': transformText(t.label, c); break;
      case 'plain': transformGraphic(t.graphic, c); break;
      case 'attribute':
        // A smashed text moves with its gate when both are selected.
        if (!targets.some((m) => m.kind === 'instance' && m.instance === t.parent)) transformPlacedAttributes([t.attribute], c);
        break;
      default: break;
    }
  }

  for (const [seg, pts] of anchors) {
    dragWireEnds(seg.wires, pts, movedWires, c);
    dragPoints(seg.junctions, pts, movedJunctions, c);
  }
}

/**
 * Delete schematic targets. Deleting a gate removes its pinrefs, and the part itself once
 * no gate of it is placed on any sheet. Deleting wires drops pinrefs and junctions that no
 * longer touch a wire end, then empty segments and nets.
 */
export function deleteSchematicTargets(sch: Schematic, targets: Target[], tx: Transaction): void {
  for (const t of targets) {
    switch (t.kind) {
      case 'instance': deleteInstance(sch, t.sheet, t.instance, tx); break;
      case 'net-wire':
        if (!t.segment.wires.includes(t.wire)) break;
        tx.run(removeItem(t.segment.wires, t.wire));
        tidySegment(sch, t.sheet, t.net, t.segment, tx);
        break;
      case 'junction':
        if (t.segment.junctions.includes(t.junction)) tx.run(removeItem(t.segment.junctions, t.junction));
        break;
      case 'label':
        if (t.segment.labels.includes(t.label)) tx.run(removeItem(t.segment.labels, t.label));
        break;
      case 'plain': tx.run(removeItem(t.container, t.graphic)); break;
      case 'attribute':
        if (t.parent.attributes.includes(t.attribute)) tx.run(removeItem(t.parent.attributes, t.attribute));
        break;
      default: break;
    }
  }
}

function deleteInstance(sch: Schematic, sheet: Sheet, inst: Instance, tx: Transaction): void {
  if (!sheet.instances.includes(inst)) return;
  for (const seg of segmentsOf(sheet)) {
    for (const pr of seg.pinrefs.filter((p) => p.part === inst.part && p.gate === inst.gate)) {
      tx.run(removeItem(seg.pinrefs, pr));
    }
  }
  tx.run(removeItem(sheet.instances, inst));
  const stillPlaced = sch.sheets.some((s) => s.instances.some((i) => i.part === inst.part));
  if (!stillPlaced) tx.run(removeMapEntry(sch.parts, inst.part));
}

/** After removing wires: drop what no longer connects, and empty containers. */
function tidySegment(sch: Schematic, sheet: Sheet, net: Net | Bus, seg: Segment, tx: Transaction): void {
  if (!net.segments.includes(seg)) return;
  if (seg.wires.length === 0) {
    tx.run(removeItem(net.segments, seg));
  } else {
    const ends: Point[] = seg.wires.flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]);
    const touches = (p: Point) => ends.some((e) => samePoint(e, p.x, p.y));
    for (const pr of [...seg.pinrefs]) {
      const inst = sheet.instances.find((i) => i.part === pr.part && i.gate === pr.gate);
      const p = inst && pinPosition(sch, inst, pr.pin);
      if (p && !touches(p)) tx.run(removeItem(seg.pinrefs, pr));
    }
    for (const j of [...seg.junctions]) if (!touches(j)) tx.run(removeItem(seg.junctions, j));
  }
  if (net.segments.length === 0) {
    const list: (Net | Bus)[] = sheet.nets.includes(net as Net) ? sheet.nets : sheet.busses;
    tx.run(removeItem(list, net));
  }
}
