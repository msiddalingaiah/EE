// Geometry edits shared by board and schematic commands.

import { fmtCoord } from '../eagle/dom';
import type { Graphic, PlacedAttribute, Polygon, Rotation, Text, Wire } from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, compose, composeRotation, placement } from '../geom/transform';
import { mirrorLayer } from '../scene/board';
import { setFields, type Transaction } from './ops';

export const EPS = 1e-4;

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

/**
 * How an edit transform applies: whether it mirrors, and whether mirroring also moves
 * objects to the opposite board side (top/bottom layers). Schematics have no sides.
 */
export interface EditContext {
  E: Transform;
  mirrored: boolean;
  swapSides: boolean;
  tx: Transaction;
}

// ---------------------------------------------------------------------------
// Attribute formatting, the way Eagle writes it

/** Eagle omits rot for R0, and writes e.g. "R90", "MR180", "SMR270". */
export function rotAttr(r: Rotation): string | null {
  const angle = Math.round(r.angle * 1e6) / 1e6;
  if (angle === 0 && !r.mirror && !r.spin) return null;
  return `${r.spin ? 'S' : ''}${r.mirror ? 'M' : ''}R${angle}`;
}

export const xyAttrs = (x: number, y: number) => ({ x: fmtCoord(x), y: fmtCoord(y) });

function layerFor(layer: number, c: EditContext): number {
  return c.mirrored && c.swapSides ? mirrorLayer(layer) : layer;
}

// ---------------------------------------------------------------------------
// Transforming objects

/** Move a point-like object with x/y fields. */
export function transformPoint(obj: { x: number; y: number }, c: EditContext): void {
  const p = apply(c.E, obj.x, obj.y);
  c.tx.run(setFields(obj, { x: p.x, y: p.y }, xyAttrs(p.x, p.y)));
}

export function transformWire(w: Wire, c: EditContext): void {
  const p1 = apply(c.E, w.x1, w.y1);
  const p2 = apply(c.E, w.x2, w.y2);
  const curve = c.mirrored ? -w.curve : w.curve;
  const layer = layerFor(w.layer, c);
  c.tx.run(setFields(w, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, curve, layer }, {
    x1: fmtCoord(p1.x), y1: fmtCoord(p1.y), x2: fmtCoord(p2.x), y2: fmtCoord(p2.y),
    curve: curve ? fmtCoord(curve) : null, layer: String(layer),
  }));
}

export function transformPolygon(poly: Polygon, c: EditContext): void {
  for (const v of poly.vertices) {
    const p = apply(c.E, v.x, v.y);
    const curve = c.mirrored ? -v.curve : v.curve;
    c.tx.run(setFields(v, { x: p.x, y: p.y, curve }, { ...xyAttrs(p.x, p.y), curve: curve ? fmtCoord(curve) : null }));
  }
  const layer = layerFor(poly.layer, c);
  if (layer !== poly.layer) c.tx.run(setFields(poly, { layer }, { layer: String(layer) }));
}

/** Text or a text-like object (label) with a position, rotation and layer. */
export function transformText(t: Pick<Text, 'x' | 'y' | 'rot' | 'layer'>, c: EditContext): void {
  const p = apply(c.E, t.x, t.y);
  const rot = composeRotation(c.E, t.rot);
  const layer = layerFor(t.layer, c);
  c.tx.run(setFields(t, { x: p.x, y: p.y, rot, layer }, { ...xyAttrs(p.x, p.y), rot: rotAttr(rot), layer: String(layer) }));
}

/** Smashed attribute texts are placed in absolute coordinates and travel with their part. */
export function transformPlacedAttributes(attrs: PlacedAttribute[], c: EditContext): void {
  for (const a of attrs) {
    if (a.x === undefined || a.y === undefined) continue;
    const q = apply(c.E, a.x, a.y);
    const rot = composeRotation(c.E, a.rot);
    const layer = a.layer !== undefined ? layerFor(a.layer, c) : undefined;
    c.tx.run(setFields(a, { x: q.x, y: q.y, rot, layer }, {
      ...xyAttrs(q.x, q.y), rot: rotAttr(rot), ...(layer !== undefined ? { layer: String(layer) } : {}),
    }));
  }
}

export function transformGraphic(g: Graphic, c: EditContext): void {
  switch (g.kind) {
    case 'wire':
      transformWire(g, c);
      break;
    case 'polygon':
      transformPolygon(g, c);
      break;
    case 'text':
      transformText(g, c);
      break;
    case 'circle': {
      const p = apply(c.E, g.x, g.y);
      const layer = layerFor(g.layer, c);
      c.tx.run(setFields(g, { x: p.x, y: p.y, layer }, { ...xyAttrs(p.x, p.y), layer: String(layer) }));
      break;
    }
    case 'hole':
      transformPoint(g, c);
      break;
    case 'rectangle': {
      // Rectangles rotate about their centre; a mirrored rectangle is just a rotated one.
      const hw = Math.abs(g.x2 - g.x1) / 2;
      const hh = Math.abs(g.y2 - g.y1) / 2;
      const ctr = apply(c.E, (g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2);
      const r = composeRotation(c.E, g.rot);
      const rot: Rotation = { angle: r.angle, mirror: false, spin: false };
      const layer = layerFor(g.layer, c);
      const [x1, y1, x2, y2] = [ctr.x - hw, ctr.y - hh, ctr.x + hw, ctr.y + hh];
      c.tx.run(setFields(g, { x1, y1, x2, y2, rot, layer }, {
        x1: fmtCoord(x1), y1: fmtCoord(y1), x2: fmtCoord(x2), y2: fmtCoord(y2),
        rot: rotAttr(rot), layer: String(layer),
      }));
      break;
    }
    case 'frame': {
      const a = apply(c.E, g.x1, g.y1);
      const b = apply(c.E, g.x2, g.y2);
      const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      c.tx.run(setFields(g, { x1, y1, x2, y2 }, { x1: fmtCoord(x1), y1: fmtCoord(y1), x2: fmtCoord(x2), y2: fmtCoord(y2) }));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Rubber-banding

export const samePoint = (a: Point, x: number, y: number) => Math.abs(a.x - x) < EPS && Math.abs(a.y - y) < EPS;
const nearAny = (pts: Point[], x: number, y: number) => pts.some((p) => samePoint(p, x, y));

/**
 * Drag the ends of `wires` (other than those in `skip`) that sit on one of the `anchors`
 * (old positions of moved connection points) to where E takes them.
 */
export function dragWireEnds(wires: Wire[], anchors: Point[], skip: Set<Wire>, c: EditContext): void {
  for (const w of wires) {
    if (skip.has(w)) continue;
    const m1 = nearAny(anchors, w.x1, w.y1);
    const m2 = nearAny(anchors, w.x2, w.y2);
    if (!m1 && !m2) continue;
    const p1 = m1 ? apply(c.E, w.x1, w.y1) : { x: w.x1, y: w.y1 };
    const p2 = m2 ? apply(c.E, w.x2, w.y2) : { x: w.x2, y: w.y2 };
    c.tx.run(setFields(w, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, {
      x1: fmtCoord(p1.x), y1: fmtCoord(p1.y), x2: fmtCoord(p2.x), y2: fmtCoord(p2.y),
    }));
  }
}

/** Move point objects (junctions, vias) not in `skip` that sit on an anchor. */
export function dragPoints<T extends { x: number; y: number }>(items: T[], anchors: Point[], skip: Set<T>, c: EditContext): void {
  for (const it of items) {
    if (!skip.has(it) && nearAny(anchors, it.x, it.y)) transformPoint(it, c);
  }
}
