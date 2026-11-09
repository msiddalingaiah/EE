// 2D affine transforms in Eagle's y-up world (millimetres).

import type { Rotation } from '../eagle/types';

export interface Point {
  x: number;
  y: number;
}

/** Affine matrix [a c e; b d f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Exact sin/cos for multiples of 90°, so placements stay on-grid. */
function sincos(deg: number): [number, number] {
  const n = ((deg % 360) + 360) % 360;
  if (n === 0) return [0, 1];
  if (n === 90) return [1, 0];
  if (n === 180) return [0, -1];
  if (n === 270) return [-1, 0];
  const r = (n * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/**
 * Placement transform for an Eagle rotation: rotate CCW, then mirror about the Y axis
 * (if set), then translate. So "MR90" = mirror(rotate90(p)). This order was confirmed
 * against routed boards: trace ends land on pad centres only with this convention.
 */
export function placement(x: number, y: number, rot: Rotation): Transform {
  const [s, c] = sincos(rot.angle);
  const m = rot.mirror ? -1 : 1;
  return { a: c * m, b: s, c: -s * m, d: c, e: x, f: y };
}

/** Returns p ∘ q (apply q first, then p). */
export function compose(p: Transform, q: Transform): Transform {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    e: p.a * q.e + p.c * q.f + p.e,
    f: p.b * q.e + p.d * q.f + p.f,
  };
}

export function apply(t: Transform, x: number, y: number): Point {
  return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
}

export function invert(t: Transform): Transform {
  const det = t.a * t.d - t.b * t.c;
  return {
    a: t.d / det,
    b: -t.b / det,
    c: -t.c / det,
    d: t.a / det,
    e: (t.c * t.f - t.d * t.e) / det,
    f: (t.b * t.e - t.a * t.f) / det,
  };
}

/** True if the transform reverses orientation (contains a mirror). */
export function isMirrored(t: Transform): boolean {
  return t.a * t.d - t.b * t.c < 0;
}

/** Eagle rotation angle (degrees CCW) of a transform, in the convention of `placement`. */
export function angleOf(t: Transform): number {
  // Unmirrored: x axis = (a, b) = (cos θ, sin θ). Mirrored (M·R): (a, b) = (-cos θ, sin θ).
  const raw = (Math.atan2(t.b, isMirrored(t) ? -t.a : t.a) * 180) / Math.PI;
  return ((Math.round(raw * 1e6) / 1e6) % 360 + 360) % 360;
}

/** Combine a parent transform with a child Rotation: resulting angle and mirror. */
export function composeRotation(parent: Transform, rot: Rotation): Rotation {
  const t = compose(parent, placement(0, 0, rot));
  return { angle: angleOf(t), mirror: isMirrored(t), spin: rot.spin };
}
