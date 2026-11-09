// Eagle arcs are stored as a chord (x1,y1)->(x2,y2) plus a signed sweep angle.

import type { Point } from './transform';

export interface Arc {
  cx: number;
  cy: number;
  r: number;
  /** Start angle in radians (world, y-up, CCW positive). */
  start: number;
  /** Signed sweep in radians; positive = counter-clockwise. */
  sweep: number;
}

/** Arc through p1 and p2 sweeping `curveDeg` degrees CCW (negative = CW). */
export function arcFromChord(p1: Point, p2: Point, curveDeg: number): Arc {
  const theta = (curveDeg * Math.PI) / 180;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const chord = Math.hypot(dx, dy);
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // Centre lies on the chord's perpendicular bisector, left of p1->p2 for small CCW sweeps.
  const d = chord / 2 / Math.tan(theta / 2);
  const cx = (p1.x + p2.x) / 2 - (dy / chord) * d;
  const cy = (p1.y + p2.y) / 2 + (dx / chord) * d;
  return { cx, cy, r, start: Math.atan2(p1.y - cy, p1.x - cx), sweep: theta };
}

/** Is angle `a` (radians) within the arc's swept range? */
export function arcContainsAngle(arc: Arc, a: number): boolean {
  const twoPi = 2 * Math.PI;
  let rel = (a - arc.start) * Math.sign(arc.sweep);
  rel = ((rel % twoPi) + twoPi) % twoPi;
  return rel <= Math.abs(arc.sweep) + 1e-9;
}

/** Points along the arc, `segments` pieces (endpoints included). */
export function arcPoints(arc: Arc, segments: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = arc.start + (arc.sweep * i) / segments;
    pts.push({ x: arc.cx + arc.r * Math.cos(a), y: arc.cy + arc.r * Math.sin(a) });
  }
  return pts;
}
