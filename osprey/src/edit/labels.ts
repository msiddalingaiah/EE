// Arrange part labels: move names (designators) and values that sit on something they shouldn't
// (pads and vias, which the solder mask leaves bare and the silkscreen can't print on; holes;
// the board edge; silkscreen outlines; each other) to a clear spot next to their part.
//
// Labels that are already clear stay where they are, so hand placement is kept. A label that
// moves becomes a smashed label (its part is smashed if it wasn't), centred on its new spot,
// read left to right or bottom to top. Candidates are tried on a grid around the part, nearest
// first; a spot nearer another part than its own reads as that part's label, which costs.
// When nothing around a part is clear, the label goes where it overlaps least, and is reported.

import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point } from '../geom/transform';
import { apply } from '../geom/transform';
import { ProjectIndex } from '../model/derive';
import { footprintTransform, mirrorLayer, rotation } from '../model/geometry';
import { boardArea, footprintInfos, rectGap, type Rect } from '../model/placement';
import type * as O from '../model/types';
import { readableText } from '../scene/builder';
import { lineWidth, textCorners } from '../scene/font';
import { labelText } from '../scene/text';
import { set, type Transaction } from './ops';
import { smash, smashLabels } from './properties';

export interface ArrangeLabelsResult {
  /** Labels moved, as "R1 name", "C3 value". */
  moved: string[];
  /** Labels that found no clear spot (placed where they overlap least). */
  crowded: string[];
}

/** Clearances (mm): silkscreen to bare copper, to other text and outlines, to the board edge. */
const PAD_GAP = 0.15;
const TEXT_GAP = 0.15;
const SILK_GAP = 0.1;
const EDGE_GAP = 0.3;
/** Candidate grid step and how far from its part (mm) a label may go. */
const STEP = 0.127;
const REACH = [2.5, 5];

type Kind = 'copper' | 'text' | 'silk' | 'hole';
interface Obstacle { r: Rect; kind: Kind; side: 'top' | 'bottom' | 'both'; owner?: object }
const WEIGHT: Record<Kind, number> = { copper: 10, text: 10, hole: 10, silk: 2 };
const GAP: Record<Kind, number> = { copper: PAD_GAP, text: TEXT_GAP, hole: PAD_GAP, silk: SILK_GAP };

const box = (pts: Point[]): Rect => ({
  minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)),
  maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)),
});
const grow = (r: Rect, d: number): Rect => ({ minX: r.minX - d, minY: r.minY - d, maxX: r.maxX + d, maxY: r.maxY + d });
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
const area = (r: Rect) => (r.maxX - r.minX) * (r.maxY - r.minY);
const sideOf = (layer: string): 'top' | 'bottom' => (layer.endsWith('.bottom') ? 'bottom' : 'top');

/** Obstacles bucketed on a grid, for quick lookup near a rectangle. */
class Grid {
  private cells = new Map<string, Obstacle[]>();
  constructor(private size = 1) {}
  private keys(r: Rect): string[] {
    const out: string[] = [];
    for (let i = Math.floor(r.minX / this.size); i <= Math.floor(r.maxX / this.size); i++) {
      for (let j = Math.floor(r.minY / this.size); j <= Math.floor(r.maxY / this.size); j++) out.push(`${i},${j}`);
    }
    return out;
  }
  add(o: Obstacle): void {
    for (const k of this.keys(o.r)) {
      const c = this.cells.get(k);
      if (c) c.push(o);
      else this.cells.set(k, [o]);
    }
  }
  remove(o: Obstacle): void {
    for (const k of this.keys(o.r)) {
      const c = this.cells.get(k);
      if (c) this.cells.set(k, c.filter((x) => x !== o));
    }
  }
  near(r: Rect): Set<Obstacle> {
    const out = new Set<Obstacle>();
    for (const k of this.keys(r)) for (const o of this.cells.get(k) ?? []) out.add(o);
    return out;
  }
}

/** A label being arranged: its placement, label (real, or what smashing would give) and text. */
interface Item {
  f: O.FootprintPlacement;
  label: O.Label;
  /** NAME or VALUE: finds the label once its part is smashed (until then it may be virtual). */
  attr: string;
  text: string;
  side: 'top' | 'bottom';
  partBox: Rect;
  r: Rect;
  obstacle: Obstacle;
}

/** The box a label covers as drawn. */
function labelBox(l: O.Label, text: string): Rect {
  const d = readableText(rotation(l.rot, l.mirror, l.spin), l.align ?? 'bottom-left', 'board');
  return box(textCorners({ x: l.at[0], y: l.at[1], text, size: l.size, angle: d.angle, mirror: d.mirror, align: d.align }));
}

export function arrangeLabels(project: O.Project, tx: Transaction, index = new ProjectIndex(project)): ArrangeLabelsResult {
  const result: ArrangeLabelsResult = { moved: [], crowded: [] };
  const board = project.board;
  const area0 = board && boardArea(board);
  if (!board || !area0) return result;
  const inside = grow(area0.outline, -EDGE_GAP);
  const grid = new Grid();
  const add = (o: Obstacle) => grid.add(o);

  // Bare copper: pads (an SMD part's on its side, through-hole on both) and vias; holes.
  const infos = footprintInfos(project, index);
  const infoOf = new Map(infos.map((i) => [i.placement, i]));
  for (const i of infos) {
    const side = i.smd ? (i.placement.side === 'bottom' ? 'bottom' : 'top') : 'both';
    for (const p of i.pads) add({ r: p.box, kind: 'copper', side });
  }
  for (const n of project.nets) {
    for (const v of n.vias ?? []) {
      const r = (v.diameter || v.drill + 0.3) / 2;
      add({ r: { minX: v.at[0] - r, minY: v.at[1] - r, maxX: v.at[0] + r, maxY: v.at[1] + r }, kind: 'copper', side: 'both' });
    }
  }
  for (const h of area0.holes) add({ r: h, kind: 'hole', side: 'both' });

  // Silkscreen drawn by footprints (outlines, pin 1 marks) and on the board.
  const silk = (g: O.Graphic, map: (x: number, y: number) => Point, layer: string) => {
    if (!layer.startsWith('silk.')) return;
    const side = sideOf(layer);
    const seg = (a: Point, b: Point, w: number) => add({ r: grow(box([a, b]), w / 2), kind: 'silk', side });
    if ('line' in g) {
      const [a, b] = g.line;
      const pts = g.curve
        ? arcPoints(arcFromChord({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, g.curve), Math.max(4, Math.ceil(Math.abs(g.curve) / 15)))
        : [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }];
      for (let k = 0; k + 1 < pts.length; k++) seg(map(pts[k]!.x, pts[k]!.y), map(pts[k + 1]!.x, pts[k + 1]!.y), g.width);
    }
    else if ('circle' in g) {
      const r = g.radius;
      const pts = Array.from({ length: 17 }, (_, k) => map(g.circle[0] + r * Math.cos((k * Math.PI) / 8), g.circle[1] + r * Math.sin((k * Math.PI) / 8)));
      if (g.width === 0) add({ r: box(pts), kind: 'silk', side });
      else for (let k = 0; k < 16; k++) seg(pts[k]!, pts[k + 1]!, g.width);
    } else if ('rect' in g) {
      add({ r: box([map(g.rect[0][0], g.rect[0][1]), map(g.rect[1][0], g.rect[1][1]), map(g.rect[0][0], g.rect[1][1]), map(g.rect[1][0], g.rect[0][1])]), kind: 'silk', side });
    } else if ('polygon' in g) {
      const pts = g.polygon.map(([x, y]) => map(x, y));
      for (let k = 0; k < pts.length; k++) seg(pts[k]!, pts[(k + 1) % pts.length]!, g.width);
    } else if ('text' in g && !g.text.startsWith('>')) {
      const d = readableText(rotation(g.rot, g.mirror, g.spin), g.align ?? 'bottom-left', 'board');
      const at = map(g.at[0], g.at[1]);
      add({ r: box(textCorners({ x: at.x, y: at.y, text: g.text, size: g.size, angle: d.angle, mirror: d.mirror, align: d.align })), kind: 'text', side });
    }
  };
  for (const g of board.drawing) if ('layer' in g) silk(g, (x, y) => ({ x, y }), g.layer);

  // The labels: names and values of parts on the board, as drawn now.
  const items: Item[] = [];
  for (const f of board.footprints) {
    const info = infoOf.get(f);
    const part = index.parts.get(f.part);
    const fpId = part && index.variantOf(part)?.footprint;
    const fp = fpId ? index.footprints.get(fpId) : undefined;
    if (!info || !part || !fp) continue;
    const T = footprintTransform(f);
    const flip = f.side === 'bottom';
    for (const g of fp.graphics) {
      if (!('layer' in g)) continue;
      const layer = flip ? mirrorLayer(g.layer) : g.layer;
      silk(g, (x, y) => apply(T, x, y), layer);
    }
    const values: Record<string, string> = { ...(part.attributes ?? {}), NAME: part.name, VALUE: index.valueOf(part) };
    const labels = f.smashed || f.labels?.length ? f.labels ?? [] : smashLabels(f, index);
    for (const l of labels) {
      if (l.attr !== 'NAME' && l.attr !== 'VALUE') continue;
      const text = labelText(l, l.value ?? values[l.attr]);
      if (!text) continue;
      const side = sideOf(l.layer);
      const r = labelBox(l, text);
      const obstacle: Obstacle = { r, kind: 'text', side, owner: l };
      items.push({ f, label: l, attr: l.attr, text, side, partBox: info.box, r, obstacle });
      add(obstacle);
    }
  }

  /** What a label's box costs where it is: overlaps with obstacles on its side, and off the board. */
  const violation = (r: Rect, side: 'top' | 'bottom', self: Obstacle) => {
    let v = 0;
    for (const o of grid.near(grow(r, PAD_GAP))) {
      if (o === self || (o.side !== 'both' && o.side !== side)) continue;
      v += WEIGHT[o.kind] * overlap(grow(r, GAP[o.kind]), o.r);
    }
    return v + 10 * (area(r) - overlap(r, inside));
  };

  // Names first, then values; the larger text first within each, as it is the harder to fit.
  const order = [...items].sort((a, b) => (a.attr === b.attr ? area(b.r) - area(a.r) : a.attr === 'NAME' ? -1 : 1));
  const others = infos.map((i) => ({ placement: i.placement, box: i.box }));
  for (const it of order) {
    if (violation(it.r, it.side, it.obstacle) <= 1e-9) continue;
    grid.remove(it.obstacle);
    const w = lineWidth(it.text, it.label.size);
    const h = it.label.size;
    let best: { at: Point; rot: number; cost: number; v: number } | undefined;
    for (const reach of REACH) {
      const region = grow(it.partBox, reach);
      for (const rot of [0, 90]) {
        const [hw, hh] = rot ? [h / 2, w / 2] : [w / 2, h / 2];
        for (let x = region.minX + hw; x <= region.maxX - hw + 1e-9; x += STEP) {
          for (let y = region.minY + hh; y <= region.maxY - hh + 1e-9; y += STEP) {
            const r = { minX: x - hw, minY: y - hh, maxX: x + hw, maxY: y + hh };
            const v = violation(r, it.side, it.obstacle);
            if (best && best.v === 0 && v > 0) continue;
            // Near its own part, nearer to it than to any other, and read left to right.
            const own = Math.max(0, rectGap(r, it.partBox));
            let nearest = Infinity;
            for (const o of others) if (o.placement !== it.f) nearest = Math.min(nearest, rectGap(r, o.box));
            // Centred on the part along one axis looks tidier.
            const off = Math.min(Math.abs(x - (it.partBox.minX + it.partBox.maxX) / 2), Math.abs(y - (it.partBox.minY + it.partBox.maxY) / 2));
            const cost = own + (nearest < own + 0.2 ? 3 + own - nearest : 0) + (rot ? 0.3 : 0) + 0.2 * off;
            if (!best || v < best.v - 1e-9 || (Math.abs(v - best.v) <= 1e-9 && cost < best.cost)) best = { at: { x, y }, rot, cost, v };
          }
        }
      }
      if (best && best.v === 0) break;
    }
    const name = `${it.f.part} ${it.attr === 'NAME' ? 'name' : 'value'}`;
    const before = violation(it.r, it.side, it.obstacle);
    if (!best || best.v >= before) {
      grid.add(it.obstacle);
      result.crowded.push(name);
      continue;
    }
    if (best.v > 0) result.crowded.push(name);
    // Move it: smash the part first if its labels are still the footprint's.
    if (!it.f.smashed && !it.f.labels?.length) smash(project, it.f, tx, index);
    const label = it.f.labels!.find((l) => l.attr === it.attr)!;
    const at: O.Pt = [Math.round(best.at.x * 1e4) / 1e4, Math.round(best.at.y * 1e4) / 1e4];
    tx.run(set(label, { at, rot: best.rot || undefined, align: 'center', spin: undefined }));
    it.r = labelBox(label, it.text);
    it.obstacle = { r: it.r, kind: 'text', side: it.side, owner: label };
    grid.add(it.obstacle);
    result.moved.push(name);
  }
  return result;
}
