// Board text in Roboto (font-data.ts): layout, outlines and bounds. The board view draws text
// from these outlines and CAM output plots them, so the screen shows exactly what is fabricated
// and the result is the same on every computer.
//
// Layout follows the canvas text drawing it replaces: the em is 1.2 × the text size, lines are
// 1.5 × size apart, the anchor is on the first line's baseline (bottom alignment: the last
// line's), and horizontal alignment uses the line's advance width.
//
// Boldness: a text's ratio (Eagle's stroke width, % of size) sets the stroke width it should
// have; where that is wider than Roboto's own strokes, the outlines are grown to match.

import type { TextAlign } from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, placement } from '../geom/transform';
import { FONT } from './font-data';

export const EM_PER_SIZE = 1.2;
export const LINE_PITCH = 1.5;
/** Eagle's default ratio (stroke width as % of size). */
export const DEFAULT_RATIO = 8;

/** Where and how a text is drawn (a scene text primitive has these). */
export interface PlacedText {
  x: number;
  y: number;
  text: string;
  size: number;
  /** Drawing angle, degrees CCW (after readability), with the mirror applied first. */
  angle: number;
  mirror: boolean;
  align: TextAlign;
  ratio?: number;
}

const glyphOf = (ch: string) => FONT.glyphs[ch] ?? FONT.glyphs['�']!;

/** Font units → mm, for a text size. */
export const unitScale = (size: number) => (size * EM_PER_SIZE) / FONT.unitsPerEm;

/** Advance width of a line (mm). */
export function lineWidth(line: string, size: number): number {
  let w = 0;
  for (const ch of line) w += glyphOf(ch)[0];
  return w * unitScale(size);
}

/** Placement of text-local coordinates (x right, y up, origin at the anchor) in the world. */
export function textTransform(p: PlacedText): Transform {
  // Drawing convention is R(angle)·M, which equals placement's M·R(-angle).
  return placement(p.x, p.y, { angle: p.mirror ? -p.angle : p.angle, mirror: p.mirror, spin: false });
}

function splitAlign(a: TextAlign): [string, string] {
  return a === 'center' ? ['center', 'center'] : (a.split('-') as [string, string]);
}

export interface GlyphPlacement {
  ch: string;
  /** Glyph origin (on the baseline), text-local mm. */
  x: number;
  y: number;
}

/** Each character's origin in text-local coordinates. */
export function layout(text: string, size: number, align: TextAlign): GlyphPlacement[] {
  const [v, h] = splitAlign(align);
  const lines = text.split('\n');
  const pitch = size * LINE_PITCH;
  const block = size + (lines.length - 1) * pitch;
  const first = v === 'bottom' ? (lines.length - 1) * pitch : v === 'top' ? -size : block / 2 - size;
  const k = unitScale(size);
  const out: GlyphPlacement[] = [];
  lines.forEach((line, i) => {
    const w = lineWidth(line, size);
    let x = h === 'left' ? 0 : h === 'right' ? -w : -w / 2;
    const y = first - i * pitch;
    for (const ch of line) {
      out.push({ ch, x, y });
      x += glyphOf(ch)[0] * k;
    }
  });
  return out;
}

/** How much to grow the outlines (mm) so strokes are as wide as the text's ratio asks. */
export function boldness(size: number, ratio = DEFAULT_RATIO): number {
  const want = (size * ratio) / 100;
  const have = FONT.stem * unitScale(size);
  return Math.max(0, (want - have) / 2);
}

/** The text's stroke width as fabricated (mm): Roboto's own, or wider when the ratio asks. */
export function strokeWidth(size: number, ratio = DEFAULT_RATIO): number {
  return FONT.stem * unitScale(size) + 2 * boldness(size, ratio);
}

/** Corners of the text's box (world), for bounds and hit testing. */
export function textCorners(p: PlacedText): Point[] {
  const lines = p.text.split('\n');
  const w = Math.max(...lines.map((l) => lineWidth(l, p.size)));
  const hgt = p.size * (1 + (lines.length - 1) * LINE_PITCH);
  const [v, hz] = splitAlign(p.align);
  const x0 = hz === 'left' ? 0 : hz === 'right' ? -w : -w / 2;
  const y0 = v === 'bottom' ? 0 : v === 'top' ? -hgt : -hgt / 2;
  const T = textTransform(p);
  return [apply(T, x0, y0), apply(T, x0 + w, y0), apply(T, x0 + w, y0 + hgt), apply(T, x0, y0 + hgt)];
}

// ---------------------------------------------------------------------------
// Outlines

type Cmd = { op: 'M' | 'L'; x: number; y: number } | { op: 'Q'; cx: number; cy: number; x: number; y: number } | { op: 'Z' };

const parsed = new Map<string, Cmd[]>();

/** A glyph's outline commands, in font units (y up). */
export function glyphCommands(ch: string): Cmd[] {
  let cmds = parsed.get(ch);
  if (cmds) return cmds;
  cmds = [];
  const re = /([MLQZ])([^MLQZ]*)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(glyphOf(ch)[1])); ) {
    const n = m[2]!.trim() ? m[2]!.trim().split(/\s+/).map(Number) : [];
    if (m[1] === 'Q') cmds.push({ op: 'Q', cx: n[0]!, cy: n[1]!, x: n[2]!, y: n[3]! });
    else if (m[1] === 'Z') cmds.push({ op: 'Z' });
    else cmds.push({ op: m[1] as 'M' | 'L', x: n[0]!, y: n[1]! });
  }
  parsed.set(ch, cmds);
  return cmds;
}

/** The SVG path of a glyph, in font units (y up), for canvas Path2D. */
export function glyphPath(ch: string): string {
  return glyphOf(ch)[1];
}

/**
 * The text's outlines as world polygons (curves flattened to within `tolerance` mm). Contours
 * keep the font's winding: fill them with the non-zero rule.
 */
export function textOutlines(p: PlacedText, tolerance = 0.002): Point[][] {
  const T = textTransform(p);
  const k = unitScale(p.size);
  const out: Point[][] = [];
  for (const g of layout(p.text, p.size, p.align)) {
    let cur: Point[] = [];
    let last = { x: 0, y: 0 };
    const at = (x: number, y: number) => apply(T, g.x + x * k, g.y + y * k);
    for (const c of glyphCommands(g.ch)) {
      if (c.op === 'M') {
        if (cur.length > 2) out.push(cur);
        cur = [at(c.x, c.y)];
        last = c;
      } else if (c.op === 'L') {
        cur.push(at(c.x, c.y));
        last = c;
      } else if (c.op === 'Q') {
        const bend = Math.hypot(last.x - 2 * c.cx + c.x, last.y - 2 * c.cy + c.y) * k;
        const n = Math.min(16, Math.max(1, Math.ceil(Math.sqrt(bend / (8 * tolerance)))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          cur.push(at(u * u * last.x + 2 * u * t * c.cx + t * t * c.x, u * u * last.y + 2 * u * t * c.cy + t * t * c.y));
        }
        last = c;
      } else {
        if (cur.length > 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length > 2) out.push(cur);
  }
  return out;
}
