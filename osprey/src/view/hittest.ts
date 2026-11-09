// Picking: which owner is under a point, and which owners fall in a box.

import { arcContainsAngle, arcPoints } from '../geom/arc';
import type { Point } from '../geom/transform';
import { textCorners } from '../scene/builder';
import type { SceneIndex } from '../scene/index';
import type { Bounds, Prim } from '../scene/types';

/**
 * Distance from p to the primitive's drawn shape (0 when inside a filled shape),
 * or Infinity when the primitive can't be hit.
 */
export function primDistance(prim: Prim, p: Point): number {
  switch (prim.t) {
    case 'line':
      return Math.max(0, segDist(p, prim.x1, prim.y1, prim.x2, prim.y2) - prim.width / 2);
    case 'arc': {
      const a = Math.atan2(p.y - prim.cy, p.x - prim.cx);
      const ring = Math.abs(Math.hypot(p.x - prim.cx, p.y - prim.cy) - prim.r) - prim.width / 2;
      if (arcContainsAngle(prim, a)) return Math.max(0, ring);
      const s = prim.start;
      const e = prim.start + prim.sweep;
      const d1 = Math.hypot(p.x - (prim.cx + prim.r * Math.cos(s)), p.y - (prim.cy + prim.r * Math.sin(s)));
      const d2 = Math.hypot(p.x - (prim.cx + prim.r * Math.cos(e)), p.y - (prim.cy + prim.r * Math.sin(e)));
      return Math.max(0, Math.min(d1, d2) - prim.width / 2);
    }
    case 'circle': {
      const d = Math.hypot(p.x - prim.cx, p.y - prim.cy);
      if (prim.width === 0) return Math.max(0, d - prim.r);
      return Math.max(0, Math.abs(d - prim.r) - prim.width / 2);
    }
    case 'poly': {
      if (prim.fill && pointInPolygon(p, prim.pts)) return 0;
      return Math.max(0, polyEdgeDist(p, prim.pts) - prim.width / 2);
    }
    case 'text': {
      const c = textCorners(prim);
      return pointInPolygon(p, c) ? 0 : polyEdgeDist(p, c);
    }
    case 'drill':
      return Infinity;
  }
}

/**
 * The owner under point p within tolerance `tol` (world units), considering visible layers.
 * Prefers the closest primitive; among primitives the point is inside, the smallest one wins,
 * so a pad inside a large filled area is still pickable.
 */
export function pick(index: SceneIndex, p: Point, tol: number, visible: (layer: number) => boolean): string | undefined {
  let best: { owner: string; d: number; area: number } | undefined;
  const prims = index.scene.prims;
  for (const { layer, prims: ids } of index.layers) {
    if (!visible(layer)) continue;
    for (const i of ids) {
      const b = index.primBounds[i]!;
      if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
      const prim = prims[i]!;
      const d = primDistance(prim, p);
      if (d > tol) continue;
      const area = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && area <= best.area)) {
        best = { owner: prim.owner, d, area };
      }
    }
  }
  if (best) return best.owner;

  // Nothing drawn under the point: fall back to the smallest part whose body contains it,
  // so clicking inside a symbol or footprint outline selects it.
  let body: { owner: string; area: number } | undefined;
  for (const [owner, b] of index.ownerBounds) {
    const kind = index.scene.owners.get(owner)?.kind;
    if (kind !== 'instance' && kind !== 'element') continue;
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
    const ids = index.ownerPrims.get(owner) ?? [];
    // Body = the extent of the owner's non-text graphics (labels can sit far away).
    const shapes = ids.filter((i) => prims[i]!.t !== 'text' && visible(prims[i]!.layer));
    if (!shapes.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of shapes) {
      const sb = index.primBounds[i]!;
      minX = Math.min(minX, sb.minX); minY = Math.min(minY, sb.minY);
      maxX = Math.max(maxX, sb.maxX); maxY = Math.max(maxY, sb.maxY);
    }
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
    const area = (maxX - minX) * (maxY - minY);
    if (!body || area < body.area) body = { owner, area };
  }
  return body?.owner;
}

/**
 * Owners selected by a box. `crossing` selects anything touching the box (right-to-left drag);
 * otherwise only owners entirely inside it (left-to-right drag).
 */
export function pickBox(
  index: SceneIndex, box: Bounds, crossing: boolean, visible: (layer: number) => boolean,
): string[] {
  const out: string[] = [];
  for (const [owner, ids] of index.ownerPrims) {
    const shown = ids.filter((i) => index.scene.prims[i]!.t !== 'drill' && visible(index.scene.prims[i]!.layer));
    if (shown.length === 0) continue;
    // Parts count as inside when their origin is (as in Eagle), so a name or value
    // text sticking out of the box doesn't silently leave the part behind.
    const o = index.scene.owners.get(owner);
    if (!crossing && o?.origin && (o.kind === 'instance' || o.kind === 'element')) {
      if (o.origin.x >= box.minX && o.origin.x <= box.maxX && o.origin.y >= box.minY && o.origin.y <= box.maxY) out.push(owner);
      continue;
    }
    const hit = crossing
      ? shown.some((i) => intersects(index.primBounds[i]!, box) && primTouchesBox(index.scene.prims[i]!, box))
      : shown.every((i) => contains(box, index.primBounds[i]!));
    if (hit) out.push(owner);
  }
  return out;
}

/** Does the primitive's drawn shape touch the box? (Bounding boxes alone over-select long outlines.) */
export function primTouchesBox(prim: Prim, box: Bounds): boolean {
  const corners: Point[] = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  const inBox = (p: Point) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
  const polyline = (pts: Point[], closed: boolean, filled: boolean, halfWidth: number): boolean => {
    if (pts.some(inBox)) return true;
    if (filled && corners.some((c) => pointInPolygon(c, pts))) return true;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if (segmentTouchesBox(a, b, box, halfWidth)) return true;
    }
    return false;
  };

  switch (prim.t) {
    case 'line':
      return segmentTouchesBox({ x: prim.x1, y: prim.y1 }, { x: prim.x2, y: prim.y2 }, box, prim.width / 2);
    case 'arc':
      return polyline(arcPoints(prim, 32), false, false, prim.width / 2);
    case 'circle': {
      const nx = Math.max(box.minX, Math.min(prim.cx, box.maxX));
      const ny = Math.max(box.minY, Math.min(prim.cy, box.maxY));
      const near = Math.hypot(nx - prim.cx, ny - prim.cy);
      if (prim.width === 0) return near <= prim.r;
      const far = Math.max(...corners.map((c) => Math.hypot(c.x - prim.cx, c.y - prim.cy)));
      return near <= prim.r + prim.width / 2 && far >= prim.r - prim.width / 2;
    }
    case 'poly':
      return polyline(prim.pts, true, prim.fill, prim.width / 2);
    case 'text':
      return polyline(textCorners(prim), true, true, 0);
    case 'drill':
      return false;
  }
}

function segmentTouchesBox(a: Point, b: Point, box: Bounds, halfWidth: number): boolean {
  const grown = {
    minX: box.minX - halfWidth, minY: box.minY - halfWidth,
    maxX: box.maxX + halfWidth, maxY: box.maxY + halfWidth,
  };
  // Liang–Barsky clip of segment a->b against the (grown) box.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - grown.minX) && clip(dx, grown.maxX - a.x) &&
    clip(-dy, a.y - grown.minY) && clip(dy, grown.maxY - a.y)
  );
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function segDist(p: Point, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - x1) * dx + (p.y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

function polyEdgeDist(p: Point, pts: Point[]): number {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    d = Math.min(d, segDist(p, a.x, a.y, b.x, b.y));
  }
  return d;
}

export function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
