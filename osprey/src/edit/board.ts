// Board editing commands. All geometry changes go through one function, transformTargets,
// which applies an affine edit transform (translate, rotate about a point, or mirror)
// to the selected objects and drags the ends of traces attached to them.

import { fmtCoord } from '../eagle/dom';
import { findLibrary } from '../eagle/parse';
import type {
  Board, Element, Graphic, Pad, Polygon, Rotation, Signal, Smd, Text, Via, Wire,
} from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, compose, composeRotation, isMirrored, placement } from '../geom/transform';
import { mirrorLayer } from '../scene/board';
import type { Target } from '../scene/types';
import { removeItem, setFields, type Transaction } from './ops';

const EPS = 1e-4;

// ---------------------------------------------------------------------------
// Edit transforms

export function translation(dx: number, dy: number): Transform {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

/** Rotate by `quarterTurns` × 90° counter-clockwise about `p`. */
export function rotationAbout(p: Point, quarterTurns: number): Transform {
  const t = placement(0, 0, { angle: (((quarterTurns % 4) + 4) % 4) * 90, mirror: false, spin: false });
  return compose(translation(p.x, p.y), compose(t, translation(-p.x, -p.y)));
}

/** Mirror left-right about the vertical line x = `x`. */
export function mirrorAbout(x: number): Transform {
  return { a: -1, b: 0, c: 0, d: 1, e: 2 * x, f: 0 };
}

// ---------------------------------------------------------------------------
// Formatting attributes the way Eagle writes them

/** Eagle omits rot for R0, and writes e.g. "R90", "MR180", "SMR270". */
function rotAttr(r: Rotation): string | null {
  const angle = Math.round(r.angle * 1e6) / 1e6;
  if (angle === 0 && !r.mirror && !r.spin) return null;
  return `${r.spin ? 'S' : ''}${r.mirror ? 'M' : ''}R${angle}`;
}

const xy = (x: number, y: number) => ({ x: fmtCoord(x), y: fmtCoord(y) });

// ---------------------------------------------------------------------------
// Queries

export function packageOf(board: Board, el: Element) {
  return findLibrary(board.libraries, el.library, el.libraryUrn)?.packages.get(el.package);
}

/** World position of an element's pad (or SMD) by name. */
export function padPosition(board: Board, el: Element, padName: string): Point | undefined {
  const pad = packageOf(board, el)?.pads.find((p: Pad | Smd) => p.name === padName);
  return pad ? apply(placement(el.x, el.y, el.rot), pad.x, pad.y) : undefined;
}

/** Can this target be changed by board commands? Locked elements can't. */
export function isEditable(t: Target): boolean {
  return t.kind !== 'element' || !t.element.locked;
}

// ---------------------------------------------------------------------------
// Transform

/**
 * Apply edit transform E to the targets inside transaction `tx`.
 * Wires of the same signal that end where a moved pad, via or wire end was are dragged along.
 */
export function transformTargets(board: Board, targets: Target[], E: Transform, tx: Transaction): void {
  const mirrored = isMirrored(E);
  const movedWires = new Set<Wire>();
  for (const t of targets) if (t.kind === 'signal-wire') movedWires.add(t.wire);

  // Connection points that move, per signal, captured before anything changes.
  const anchors = new Map<Signal, Point[]>();
  const addAnchor = (s: Signal, p: Point) => {
    let list = anchors.get(s);
    if (!list) anchors.set(s, (list = []));
    list.push(p);
  };
  const moved = targets.filter(isEditable);
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
      case 'element': transformElement(t.element, E, mirrored, tx); break;
      case 'signal-wire': transformWire(t.wire, E, mirrored, tx); break;
      case 'via': transformVia(t.via, E, tx); break;
      case 'signal-polygon': transformPolygon(t.polygon, E, mirrored, tx); break;
      case 'plain': transformGraphic(t.graphic, E, mirrored, tx); break;
    }
  }

  // Rubber-band: drag the attached ends of wires that weren't themselves moved.
  const near = (pts: Point[], x: number, y: number) => pts.some((p) => Math.abs(p.x - x) < EPS && Math.abs(p.y - y) < EPS);
  for (const [s, pts] of anchors) {
    for (const w of s.wires) {
      if (movedWires.has(w)) continue;
      const m1 = near(pts, w.x1, w.y1);
      const m2 = near(pts, w.x2, w.y2);
      if (!m1 && !m2) continue;
      const p1 = m1 ? apply(E, w.x1, w.y1) : { x: w.x1, y: w.y1 };
      const p2 = m2 ? apply(E, w.x2, w.y2) : { x: w.x2, y: w.y2 };
      tx.run(setFields(w, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, {
        x1: fmtCoord(p1.x), y1: fmtCoord(p1.y), x2: fmtCoord(p2.x), y2: fmtCoord(p2.y),
      }));
    }
  }
}

function transformElement(el: Element, E: Transform, mirrored: boolean, tx: Transaction): void {
  const p = apply(E, el.x, el.y);
  const rot = composeRotation(E, el.rot);
  tx.run(setFields(el, { x: p.x, y: p.y, rot }, { ...xy(p.x, p.y), rot: rotAttr(rot) }));
  // Smashed attribute texts are placed in board coordinates and travel with the part.
  for (const a of el.attributes) {
    if (a.x === undefined || a.y === undefined) continue;
    const q = apply(E, a.x, a.y);
    const arot = composeRotation(E, a.rot);
    const layer = a.layer !== undefined && mirrored ? mirrorLayer(a.layer) : a.layer;
    tx.run(setFields(a, { x: q.x, y: q.y, rot: arot, layer }, {
      ...xy(q.x, q.y), rot: rotAttr(arot), ...(layer !== undefined ? { layer: String(layer) } : {}),
    }));
  }
}

function transformWire(w: Wire, E: Transform, mirrored: boolean, tx: Transaction): void {
  const p1 = apply(E, w.x1, w.y1);
  const p2 = apply(E, w.x2, w.y2);
  const curve = mirrored ? -w.curve : w.curve;
  const layer = mirrored ? mirrorLayer(w.layer) : w.layer;
  tx.run(setFields(w, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, curve, layer }, {
    x1: fmtCoord(p1.x), y1: fmtCoord(p1.y), x2: fmtCoord(p2.x), y2: fmtCoord(p2.y),
    curve: curve ? fmtCoord(curve) : null, layer: String(layer),
  }));
}

function transformVia(v: Via, E: Transform, tx: Transaction): void {
  const p = apply(E, v.x, v.y);
  tx.run(setFields(v, { x: p.x, y: p.y }, xy(p.x, p.y)));
}

function transformPolygon(poly: Polygon, E: Transform, mirrored: boolean, tx: Transaction): void {
  for (const v of poly.vertices) {
    const p = apply(E, v.x, v.y);
    const curve = mirrored ? -v.curve : v.curve;
    tx.run(setFields(v, { x: p.x, y: p.y, curve }, { ...xy(p.x, p.y), curve: curve ? fmtCoord(curve) : null }));
  }
  if (mirrored) {
    const layer = mirrorLayer(poly.layer);
    tx.run(setFields(poly, { layer }, { layer: String(layer) }));
  }
}

function transformText(t: Text, E: Transform, mirrored: boolean, tx: Transaction): void {
  const p = apply(E, t.x, t.y);
  const rot = composeRotation(E, t.rot);
  const layer = mirrored ? mirrorLayer(t.layer) : t.layer;
  tx.run(setFields(t, { x: p.x, y: p.y, rot, layer }, { ...xy(p.x, p.y), rot: rotAttr(rot), layer: String(layer) }));
}

function transformGraphic(g: Graphic, E: Transform, mirrored: boolean, tx: Transaction): void {
  switch (g.kind) {
    case 'wire':
      transformWire(g, E, mirrored, tx);
      break;
    case 'polygon':
      transformPolygon(g, E, mirrored, tx);
      break;
    case 'text':
      transformText(g, E, mirrored, tx);
      break;
    case 'circle': {
      const p = apply(E, g.x, g.y);
      const layer = mirrored ? mirrorLayer(g.layer) : g.layer;
      tx.run(setFields(g, { x: p.x, y: p.y, layer }, { ...xy(p.x, p.y), layer: String(layer) }));
      break;
    }
    case 'hole': {
      const p = apply(E, g.x, g.y);
      tx.run(setFields(g, { x: p.x, y: p.y }, xy(p.x, p.y)));
      break;
    }
    case 'rectangle': {
      // Rectangles rotate about their centre; a mirrored rectangle is just a rotated one.
      const hw = Math.abs(g.x2 - g.x1) / 2;
      const hh = Math.abs(g.y2 - g.y1) / 2;
      const c = apply(E, (g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2);
      const r = composeRotation(E, g.rot);
      const rot: Rotation = { angle: r.angle, mirror: false, spin: false };
      const layer = mirrored ? mirrorLayer(g.layer) : g.layer;
      const [x1, y1, x2, y2] = [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
      tx.run(setFields(g, { x1, y1, x2, y2, rot, layer }, {
        x1: fmtCoord(x1), y1: fmtCoord(y1), x2: fmtCoord(x2), y2: fmtCoord(y2),
        rot: rotAttr(rot), layer: String(layer),
      }));
      break;
    }
    case 'frame': {
      const a = apply(E, g.x1, g.y1);
      const b = apply(E, g.x2, g.y2);
      const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      tx.run(setFields(g, { x1, y1, x2, y2 }, { x1: fmtCoord(x1), y1: fmtCoord(y1), x2: fmtCoord(x2), y2: fmtCoord(y2) }));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Delete

/** Delete targets. Deleting an element also removes its pads from every signal. */
export function deleteTargets(board: Board, targets: Target[], tx: Transaction): void {
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
    }
  }
}
