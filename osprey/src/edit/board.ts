// Board editing commands. Geometry changes go through transformBoardTargets, which applies
// an edit transform (translate, rotate about a point, or mirror) to the selected objects
// and drags the ends of traces attached to them.

import { findLibrary } from '../eagle/parse';
import type { Board, Element, Pad, Smd, Signal } from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, composeRotation, isMirrored, placement } from '../geom/transform';
import type { Target } from '../scene/types';
import {
  dragWireEnds, rotAttr, transformGraphic, transformPlacedAttributes, transformPoint,
  transformPolygon, transformWire, xyAttrs, type EditContext,
} from './common';
import { removeItem, setFields, type Transaction } from './ops';

export { mirrorAbout, rotationAbout, translation } from './common';

export function packageOf(board: Board, el: Element) {
  return findLibrary(board.libraries, el.library, el.libraryUrn)?.packages.get(el.package);
}

/** World position of an element's pad (or SMD) by name. */
export function padPosition(board: Board, el: Element, padName: string): Point | undefined {
  const pad = packageOf(board, el)?.pads.find((p: Pad | Smd) => p.name === padName);
  return pad ? apply(placement(el.x, el.y, el.rot), pad.x, pad.y) : undefined;
}

/** Can this target be changed by commands? Locked elements can't. */
export function isEditable(t: Target): boolean {
  return t.kind !== 'element' || !t.element.locked;
}

/**
 * Apply edit transform E to board targets inside transaction `tx`.
 * Traces of the same signal that end where a moved pad, via or trace end was are dragged along.
 */
export function transformBoardTargets(board: Board, targets: Target[], E: Transform, tx: Transaction): void {
  const c: EditContext = { E, mirrored: isMirrored(E), swapSides: true, tx };
  const moved = targets.filter(isEditable);
  const movedWires = new Set(moved.flatMap((t) => (t.kind === 'signal-wire' ? [t.wire] : [])));

  // Connection points that move, per signal, captured before anything changes.
  const anchors = new Map<Signal, Point[]>();
  const addAnchor = (s: Signal, p: Point) => {
    let list = anchors.get(s);
    if (!list) anchors.set(s, (list = []));
    list.push(p);
  };
  const movedElements = new Set(moved.flatMap((t) => (t.kind === 'element' ? [t.element.name] : [])));
  for (const s of board.signals) {
    for (const cr of s.contactrefs) {
      if (!movedElements.has(cr.element)) continue;
      const el = board.elements.find((e) => e.name === cr.element);
      const p = el && padPosition(board, el, cr.pad);
      if (p) addAnchor(s, p);
    }
  }
  for (const t of moved) {
    if (t.kind === 'via') addAnchor(t.signal, { x: t.via.x, y: t.via.y });
    if (t.kind === 'signal-wire') {
      addAnchor(t.signal, { x: t.wire.x1, y: t.wire.y1 });
      addAnchor(t.signal, { x: t.wire.x2, y: t.wire.y2 });
    }
  }

  for (const t of moved) {
    switch (t.kind) {
      case 'element': {
        const el = t.element;
        const p = apply(E, el.x, el.y);
        const rot = composeRotation(E, el.rot);
        tx.run(setFields(el, { x: p.x, y: p.y, rot }, { ...xyAttrs(p.x, p.y), rot: rotAttr(rot) }));
        transformPlacedAttributes(el.attributes, c);
        break;
      }
      case 'signal-wire': transformWire(t.wire, c); break;
      case 'via': transformPoint(t.via, c); break;
      case 'signal-polygon': transformPolygon(t.polygon, c); break;
      case 'plain': transformGraphic(t.graphic, c); break;
      default: break;
    }
  }

  for (const [s, pts] of anchors) dragWireEnds(s.wires, pts, movedWires, c);
}

/** Delete board targets. Deleting an element also removes its pads from every signal. */
export function deleteBoardTargets(board: Board, targets: Target[], tx: Transaction): void {
  for (const t of targets.filter(isEditable)) {
    switch (t.kind) {
      case 'element':
        for (const s of board.signals) {
          for (const cr of s.contactrefs.filter((c) => c.element === t.element.name)) {
            tx.run(removeItem(s.contactrefs, cr));
          }
        }
        tx.run(removeItem(board.elements, t.element));
        break;
      case 'signal-wire':
        tx.run(removeItem(t.signal.wires, t.wire));
        break;
      case 'via':
        tx.run(removeItem(t.signal.vias, t.via));
        break;
      case 'signal-polygon':
        tx.run(removeItem(t.signal.polygons, t.polygon));
        break;
      case 'plain':
        tx.run(removeItem(t.container, t.graphic));
        break;
      default:
        break;
    }
  }
}
