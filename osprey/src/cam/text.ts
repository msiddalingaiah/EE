// Board text as Gerber regions: the glyph outlines (font.ts), merged, grown to the text's
// stroke width where its ratio asks for bolder strokes, and cut into pieces without holes.
//
// A Gerber region can't have holes of its own; they would need clear polarity, which would also
// erase other silkscreen under a letter's counter. Instead each polygon with holes is sliced by
// vertical lines through its holes, so every piece is a plain outline; the pieces meet exactly
// along the cuts, so the letters plot the same.

import { Clipper64, ClipType, FillRule, Path64, Paths64, Point64 } from 'clipper2-js';
import type { Point } from '../geom/transform';
import { boldness, textOutlines, type PlacedText } from '../scene/font';

/** Integer units per mm (0.1 µm). */
const S = 10_000;

const toPath = (pts: Point[]) => {
  const p = new Path64();
  for (const q of pts) p.push(new Point64(Math.round(q.x * S), Math.round(q.y * S)));
  return p;
};

function run(type: ClipType, subject: Paths64, clip: Paths64 | undefined, rule: FillRule): Paths64 {
  const c = new Clipper64();
  c.addSubjectPaths(subject);
  if (clip?.length) c.addClipPaths(clip);
  const out = new Paths64();
  c.execute(type, rule, out);
  return out;
}

const area = (p: Path64) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const u = p[i]!;
    const v = p[(i + 1) % p.length]!;
    a += u.x * v.y - v.x * u.y;
  }
  return a / 2;
};

/** Polygons (counter-clockwise rings) grown by `mm`, with round corners. */
function grow(ps: Paths64, mm: number): Paths64 {
  const g = mm * S;
  const parts = new Paths64();
  for (const p of ps) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      // A segment grown by g: a stadium (rectangle plus round ends, as polygons).
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const nx = (-(b.y - a.y) / len) * g;
      const ny = ((b.x - a.x) / len) * g;
      const strip = new Path64();
      const base = Math.atan2(ny, nx);
      for (let k = 0; k <= 8; k++) {
        const t = base + (k * Math.PI) / 8;
        strip.push(new Point64(Math.round(a.x + g * Math.cos(t)), Math.round(a.y + g * Math.sin(t))));
      }
      for (let k = 0; k <= 8; k++) {
        const t = base + Math.PI + (k * Math.PI) / 8;
        strip.push(new Point64(Math.round(b.x + g * Math.cos(t)), Math.round(b.y + g * Math.sin(t))));
      }
      parts.push(strip);
    }
  }
  return run(ClipType.Union, ps, parts, FillRule.NonZero);
}

/** Cut polygons with holes into pieces without holes (see the file comment). */
export function fracture(ps: Paths64): Paths64 {
  const holes = ps.filter((p) => area(p) < 0);
  if (!holes.length) return ps;
  const cuts = [...new Set(holes.map((h) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of h) {
      lo = Math.min(lo, q.x);
      hi = Math.max(hi, q.x);
    }
    return Math.round((lo + hi) / 2);
  }))].sort((a, b) => a - b);
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of ps) for (const q of p) {
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
  }
  const edges = [minX - 1, ...cuts, maxX + 1];
  const out = new Paths64();
  for (let i = 0; i + 1 < edges.length; i++) {
    const strip = new Path64();
    for (const [x, y] of [[edges[i]!, minY - 1], [edges[i + 1]!, minY - 1], [edges[i + 1]!, maxY + 1], [edges[i]!, maxY + 1]] as const) strip.push(new Point64(x, y));
    const clip = new Paths64();
    clip.push(strip);
    for (const p of run(ClipType.Intersection, ps, clip, FillRule.NonZero)) out.push(p);
  }
  return out;
}

/** A text's regions (world mm): plain outlines, to fill dark. */
export function textRegions(p: PlacedText): Point[][] {
  const subject = new Paths64();
  for (const c of textOutlines(p)) subject.push(toPath(c));
  let merged = run(ClipType.Union, subject, undefined, FillRule.NonZero);
  const g = boldness(p.size, p.ratio);
  if (g > 0) merged = grow(merged, g);
  return fracture(merged).map((path) => path.map((q) => ({ x: q.x / S, y: q.y / S })));
}
