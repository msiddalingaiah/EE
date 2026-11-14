// Placing a board block by block (model/blocks.ts), the way a designer does: each block laid out
// around its main part, the blocks arranged, the board sized to fit.
//
// A block's own parts: the main part (the one with the most pads, else the most connections) in
// the middle; every other part, in order of how much it connects to what is placed, goes on the
// side of the pad it connects to, its own pad lined up with that pad, turned so it faces it, as
// close as it fits. Parts on one side of an IC so form a row; parts wired to those go further
// out, forming columns. Decoupling caps go to their IC's power pin. This is done with the main
// part in each of its four rotations, and the layout with the shortest wiring and least area
// wins (a big part turned can leave room beside it for the rest).
//
// A block with blocks inside: its own parts (laid out as above) and each block inside it are
// rectangles, added one at a time (the most connected first) beside what is placed, edges lined
// up, in the rotation and spot that keep the wiring between them short and the whole compact.
// The board is the same at the top, its blocks and the parts in none.
//
// Then parts are nudged (2 mm at most) onto a neighbour's row or column where that fits and
// helps the placement score. Last, the board outline is fitted around the parts, grown where a corner's mounting hole would
// touch one, and everything is moved so the outline starts at 0, 0. Supply nets don't pull parts
// together (pours connect them), except decoupling caps to their pins.

import type { Point } from '../geom/transform';
import { blockOf, comparePaths } from '../model/blocks';
import type { Rect } from '../model/placement';
import { footprintInfo, misalignment, partClearance, rectCenter, rectGap, SCORE_WEIGHTS, supplyNets, TOLERANCE } from '../model/placement';
import type * as O from '../model/types';
import type { Arrange } from './arrange';
import { insert, remove } from './ops';

export interface AutoplaceResult {
  /** Parts placed. */
  parts: number;
  /** The board outline (mm). */
  width: number;
  height: number;
}

interface Pad {
  name: string;
  net?: string;
  power?: true;
  x: number;
  y: number;
}

interface Shape {
  box: Rect;
  pads: Pad[];
  smd: boolean;
}

interface Pose {
  x: number;
  y: number;
  rot: number;
}

/** Parts placed relative to each other. */
type Layout = Map<string, Pose>;

/** Space between blocks (mm), beyond the part clearance. */
const BLOCK_GAP = 0.5;
/** Mounting holes sit this far in from the board's corners (mm). */
const HOLE_INSET = 2.54;
const ROTS = [0, 90, 180, 270];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Positions stay on the 0.01 mm grid Arrange.moveTo rounds to, so clearances checked here still hold once moved. */
const r2 = (v: number) => Math.round(v * 100) / 100;

export function autoplace(arr: Arrange): AutoplaceResult {
  const project = arr.project;
  const board = project.board;
  if (!board) return { parts: 0, width: 0, height: 0 };
  const rules = arr.rules;
  const supplies = supplyNets(project, arr.index);

  // ---- footprint shapes, per rotation, relative to the origin ------------------
  const shapes = new Map<string, Shape>();
  const shapeOf = (part: string, rot: number): Shape => {
    const key = `${part}\u0000${rot}`;
    let s = shapes.get(key);
    if (!s) {
      const i = footprintInfo(project, part, { at: [0, 0], rot }, arr.index)!;
      s = { box: i.box, pads: i.pads.map((q) => ({ name: q.name, ...(q.net ? { net: q.net } : {}), ...(q.power ? { power: true as const } : {}), x: q.at.x, y: q.at.y })), smd: i.smd };
      shapes.set(key, s);
    }
    return s;
  };
  const boxAt = (part: string, p: Pose): Rect => {
    const b = shapeOf(part, p.rot).box;
    return { minX: b.minX + p.x, minY: b.minY + p.y, maxX: b.maxX + p.x, maxY: b.maxY + p.y };
  };
  const padsAt = (part: string, p: Pose): Pad[] => shapeOf(part, p.rot).pads.map((q) => ({ ...q, x: q.x + p.x, y: q.y + p.y }));
  const signal = (net?: string) => !!net && !supplies.has(net);
  const fits = (part: string, p: Pose, layout: Layout, gap = 0): boolean => {
    const b = boxAt(part, p);
    const smd = shapeOf(part, p.rot).smd;
    for (const [other, q] of layout) {
      if (other === part) continue;
      if (rectGap(b, boxAt(other, q)) < partClearance(rules, { smd }, shapeOf(other, q.rot)) + gap - TOLERANCE) return false;
    }
    return true;
  };

  // ---- the parts to place, by block ---------------------------------------------
  const onBoard = new Set(board.footprints.filter((f) => !f.locked).map((f) => f.part));
  const blockOfPart = new Map<string, string>();
  for (const p of project.parts) if (onBoard.has(p.name)) blockOfPart.set(p.name, blockOf(p) ?? '');

  // ---- a block's own parts --------------------------------------------------------
  /** A block's own parts, the main part tried in each rotation: the layout with the best blockScore. */
  const layoutParts = (parts: string[]): Layout => {
    let best: { layout: Layout; score: number } | undefined;
    for (const rot of ROTS) {
      const layout = layoutPartsAt(parts, rot);
      const score = blockScore(layout);
      if (!best || score < best.score - 1e-9) best = { layout, score };
    }
    return best?.layout ?? new Map();
  };

  /** How good a block's layout is: its signal wiring (half the perimeter of each net's pads) plus its area. */
  const blockScore = (u: Layout, b: Rect = unitBox(u)): number => {
    const nets = new Map<string, Rect>();
    for (const q of signalPads(u)) {
      const r = nets.get(q.net!);
      if (!r) nets.set(q.net!, { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y });
      else {
        r.minX = Math.min(r.minX, q.x);
        r.minY = Math.min(r.minY, q.y);
        r.maxX = Math.max(r.maxX, q.x);
        r.maxY = Math.max(r.maxY, q.y);
      }
    }
    let wire = 0;
    for (const r of nets.values()) wire += r.maxX - r.minX + (r.maxY - r.minY);
    return wire + BLOCK_AREA_WEIGHT * (b.maxX - b.minX) * (b.maxY - b.minY);
  };

  const layoutPartsAt = (parts: string[], mainRot: number): Layout => {
    const layout: Layout = new Map();
    if (!parts.length) return layout;
    const nets = (p: string) => new Set(shapeOf(p, 0).pads.map((q) => q.net).filter(signal));
    const degree = (p: string) => parts.filter((o) => o !== p && [...nets(o)].some((n) => nets(p).has(n))).length;
    const area = (p: string) => {
      const b = shapeOf(p, 0).box;
      return (b.maxX - b.minX) * (b.maxY - b.minY);
    };
    const main = [...parts].sort((a, b) => shapeOf(b, 0).pads.length - shapeOf(a, 0).pads.length || degree(b) - degree(a) || area(b) - area(a) || a.localeCompare(b))[0]!;
    layout.set(main, { x: 0, y: 0, rot: mainRot });

    /** How X connects to what is placed: the best pad pair, signal nets first, then power pins. */
    const target = (x: string): { own: string; to: Pad; on: string; rank: number } | undefined => {
      let best: { own: string; to: Pad; on: string; rank: number } | undefined;
      for (const s of shapeOf(x, 0).pads) {
        if (!s.net) continue;
        for (const [y, pose] of layout) {
          for (const t of padsAt(y, pose)) {
            if (t.net !== s.net) continue;
            const rank = signal(s.net) ? 0 : t.power ? 1 : 2;
            if (!best || rank < best.rank || (rank === best.rank && y === main && best.on !== main)) best = { own: s.name, to: t, on: y, rank };
          }
        }
      }
      return best;
    };
    const strength = (x: string) => {
      const placedNets = new Set([...layout].flatMap(([y, p]) => padsAt(y, p).map((q) => q.net).filter(signal)));
      return [...nets(x)].filter((n) => placedNets.has(n)).length;
    };

    const rest = parts.filter((p) => p !== main);
    while (rest.length) {
      // The most connected next; then those that reach a power pin; then the rest.
      rest.sort((a, b) => strength(b) - strength(a) || (target(a)?.rank ?? 9) - (target(b)?.rank ?? 9) || a.localeCompare(b, undefined, { numeric: true }));
      const x = rest.shift()!;
      const t = target(x);
      const anchorBox = t ? boxAt(t.on, layout.get(t.on)!) : boxAt(main, layout.get(main)!);
      const at: Point = t ? { x: t.to.x, y: t.to.y } : { x: rectCenter(anchorBox).x, y: anchorBox.minY };
      const side = t ? sideOf(anchorBox, at) : 'below';
      layout.set(x, besideSpot(x, at, side, anchorBox, t?.own, layout));
    }
    return layout;
  };

  /**
   * Where part X goes beside a box, on a side, its pad `own` (else its centre) lined up with
   * `at` across that side: for each rotation, the nearest spot that fits, moving out from the box
   * and along the side; the rotation whose pad ends up nearest `at` wins.
   */
  const besideSpot = (x: string, at: Point, side: Side, anchor: Rect, own: string | undefined, layout: Layout): Pose => {
    const out = OUT[side];
    const along = { x: Math.abs(out.y), y: Math.abs(out.x) };
    let best: { pose: Pose; score: number } | undefined;
    for (const rot of ROTS) {
      const sh = shapeOf(x, rot);
      const pad = own ? sh.pads.find((q) => q.name === own) : undefined;
      const ref = pad ?? { x: (sh.box.minX + sh.box.maxX) / 2, y: (sh.box.minY + sh.box.maxY) / 2 };
      // Lined up with `at` along the side; its near edge a clearance off the anchor's.
      const gap = partClearance(rules, sh, { smd: true });
      let px = at.x - ref.x;
      let py = at.y - ref.y;
      if (side === 'right') px = anchor.maxX + gap - sh.box.minX;
      if (side === 'left') px = anchor.minX - gap - sh.box.maxX;
      if (side === 'above') py = anchor.maxY + gap - sh.box.minY;
      if (side === 'below') py = anchor.minY - gap - sh.box.maxY;
      for (const [o, a] of SEARCH) {
        const pose = { x: r2(px + out.x * o + along.x * a), y: r2(py + out.y * o + along.y * a), rot };
        if (!fits(x, pose, layout)) continue;
        const p = { x: ref.x + pose.x, y: ref.y + pose.y };
        const score = Math.hypot(p.x - at.x, p.y - at.y) + 0.5 * (o + Math.abs(a));
        if (!best || score < best.score - 1e-9) best = { pose, score };
        break;
      }
    }
    return best?.pose ?? { x: r2(at.x), y: r2(at.y), rot: 0 };
  };

  // ---- blocks of blocks ------------------------------------------------------------
  const layoutBlock = (path: string): Layout => {
    const own = [...blockOfPart].filter(([, b]) => b === path).map(([p]) => p).sort();
    const children = new Set<string>();
    for (const b of blockOfPart.values()) {
      if (path === '' ? b && !b.includes('/') : b.startsWith(`${path}/`) && !b.slice(path.length + 1).includes('/')) children.add(b);
      // A block deeper down whose parent has no parts of its own still counts through it.
      if (b.startsWith(path ? `${path}/` : '')) {
        const next = b.slice(path ? path.length + 1 : 0).split('/')[0]!;
        if (next) children.add(path ? `${path}/${next}` : next);
      }
    }
    const units: Layout[] = [];
    if (path === '') {
      // Parts in no block are each a unit of their own at the top.
      for (const p of own) units.push(new Map([[p, { x: 0, y: 0, rot: 0 }]]));
    } else if (own.length) units.push(layoutParts(own));
    for (const c of [...children].sort(comparePaths)) units.push(layoutBlock(c));
    return arrangeUnits(units.filter((u) => u.size), path === '');
  };

  const unitBox = (u: Layout): Rect => {
    const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [p, pose] of u) {
      const b = boxAt(p, pose);
      r.minX = Math.min(r.minX, b.minX);
      r.minY = Math.min(r.minY, b.minY);
      r.maxX = Math.max(r.maxX, b.maxX);
      r.maxY = Math.max(r.maxY, b.maxY);
    }
    return r;
  };
  /** A layout turned by quarter turns about the origin, then moved. */
  const place = (u: Layout, quarter: number, dx: number, dy: number): Layout => {
    const out: Layout = new Map();
    for (const [p, pose] of u) {
      let { x, y } = pose;
      for (let k = 0; k < quarter; k++) [x, y] = [-y, x];
      out.set(p, { x: r2(x + dx), y: r2(y + dy), rot: (pose.rot + 90 * quarter) % 360 });
    }
    return out;
  };
  const signalPads = (u: Layout) => [...u].flatMap(([p, pose]) => padsAt(p, pose).filter((q) => signal(q.net)));

  const unitArea = (u: Layout) => {
    const b = unitBox(u);
    return (b.maxX - b.minX) * (b.maxY - b.minY);
  };

  /**
   * Units (blocks, or parts) beside each other, starting from the biggest. At the top, each unit
   * gets a turn at being the first, and the arrangement whose board (corner holes and all) and
   * wiring are best wins.
   */
  const arrangeUnits = (units: Layout[], top: boolean): Layout => {
    if (!units.length) return new Map();
    const sorted = [...units].sort((a, b) => unitArea(b) - unitArea(a));
    if (!top) return arrangeFrom(sorted);
    let best: { layout: Layout; score: number } | undefined;
    for (let i = 0; i < sorted.length; i++) {
      const layout = arrangeFrom([sorted[i]!, ...sorted.filter((_, j) => j !== i)]);
      const score = blockScore(layout, outlineOf(layout));
      if (!best || score < best.score - 1e-9) best = { layout, score };
    }
    return best!.layout;
  };

  /** Units beside each other: the first, then the most connected to what is placed, one at a time. */
  const arrangeFrom = (units: Layout[]): Layout => {
    const placed: Layout = new Map();
    const rest = [...units];
    for (const [p, pose] of rest.shift()!) placed.set(p, pose);
    while (rest.length) {
      const placedNets = new Set(signalPads(placed).map((q) => q.net));
      const links = (u: Layout) => new Set(signalPads(u).map((q) => q.net).filter((n) => placedNets.has(n))).size;
      rest.sort((a, b) => links(b) - links(a) || unitArea(b) - unitArea(a));
      const u = rest.shift()!;
      let best: { layout: Layout; score: number } | undefined;
      const cluster = unitBox(placed);
      const placedPads = signalPads(placed);
      for (let quarter = 0; quarter < 4; quarter++) {
        const turned = place(u, quarter, 0, 0);
        const ub = unitBox(turned);
        const w = ub.maxX - ub.minX;
        const h = ub.maxY - ub.minY;
        // Beside the cluster on each side, ends or centre lined up with its edges.
        const spots: Point[] = [];
        for (const t of [cluster.minX, (cluster.minX + cluster.maxX - w) / 2, cluster.maxX - w]) {
          spots.push({ x: t, y: cluster.maxY + BLOCK_GAP }, { x: t, y: cluster.minY - BLOCK_GAP - h });
        }
        for (const t of [cluster.minY, (cluster.minY + cluster.maxY - h) / 2, cluster.maxY - h]) {
          spots.push({ x: cluster.maxX + BLOCK_GAP, y: t }, { x: cluster.minX - BLOCK_GAP - w, y: t });
        }
        for (const s of spots) {
          // Slide in toward the cluster while it fits (blocks nest into each other's gaps).
          const dir = { x: s.x > cluster.maxX - 1e-9 ? -1 : s.x + w < cluster.minX + 1e-9 ? 1 : 0, y: s.y > cluster.maxY - 1e-9 ? -1 : s.y + h < cluster.minY + 1e-9 ? 1 : 0 };
          let at = s;
          const fitsAt = (q: Point) => {
            const cand = place(u, quarter, r2(q.x - ub.minX), r2(q.y - ub.minY));
            for (const [p, pose] of cand) if (!fits(p, pose, placed, BLOCK_GAP)) return undefined;
            return cand;
          };
          let cand = fitsAt(at);
          if (!cand) continue;
          for (let k = 0; k < 200; k++) {
            const next = { x: at.x + dir.x * 0.25, y: at.y + dir.y * 0.25 };
            const c = fitsAt(next);
            if (!c) break;
            at = next;
            cand = c;
          }
          const score = joinScore(cand, placed, placedPads);
          if (!best || score < best.score - 1e-9) best = { layout: cand, score };
        }
      }
      if (best) for (const [p, pose] of best.layout) placed.set(p, pose);
    }
    return placed;
  };

  /** Wiring between a unit and what is placed (nearest pads per shared net), plus the area both need. */
  const joinScore = (u: Layout, placed: Layout, placedPads: Pad[]): number => {
    let wire = 0;
    const byNet = new Map<string, number>();
    for (const q of signalPads(u)) {
      for (const r of placedPads) {
        if (r.net !== q.net) continue;
        const d = Math.hypot(r.x - q.x, r.y - q.y);
        if (d < (byNet.get(q.net!) ?? Infinity)) byNet.set(q.net!, d);
      }
    }
    for (const d of byNet.values()) wire += d;
    const both = new Map([...placed, ...u]);
    const all = unitBox(both);
    return wire + AREA_WEIGHT * (all.maxX - all.minX) * (all.maxY - all.minY);
  };

  // ---- rows and columns ----------------------------------------------------------------
  /**
   * Nudge parts onto a neighbour's row or column: each part, in turn, moved (up to ALIGN_MOVE) so
   * its centre lines up with a nearby part's, where it fits and the whole gets better (wiring,
   * area and misalignment, weighted as in the placement score). A few passes, until none helps.
   */
  const alignRows = (u: Layout): void => {
    const parts = [...u.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const centre = (p: string) => rectCenter(boxAt(p, u.get(p)!));
    const score = () => blockScore(u) + SCORE_WEIGHTS.misalignment * misalignment(parts.map(centre));
    let current = score();
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const p of parts) {
        const pose = u.get(p)!;
        const c = centre(p);
        const shifts: Point[] = [];
        for (const q of parts) {
          if (q === p) continue;
          const d = centre(q);
          if (Math.hypot(d.x - c.x, d.y - c.y) > ALIGN_REACH) continue;
          if (Math.abs(d.x - c.x) > 1e-6 && Math.abs(d.x - c.x) <= ALIGN_MOVE) shifts.push({ x: d.x - c.x, y: 0 });
          if (Math.abs(d.y - c.y) > 1e-6 && Math.abs(d.y - c.y) <= ALIGN_MOVE) shifts.push({ x: 0, y: d.y - c.y });
        }
        let best: { pose: Pose; score: number } | undefined;
        for (const s of shifts) {
          const next = { x: r2(pose.x + s.x), y: r2(pose.y + s.y), rot: pose.rot };
          if (!fits(p, next, u)) continue;
          u.set(p, next);
          const v = score();
          u.set(p, pose);
          if (v < (best?.score ?? current) - 1e-6) best = { pose: next, score: v };
        }
        if (best) {
          u.set(p, best.pose);
          current = best.score;
          moved = true;
        }
      }
      if (!moved) break;
    }
  };

  // ---- the board outline -------------------------------------------------------------
  const holes = board.drawing.filter((g): g is O.HoleShape => 'hole' in g);
  const drill = holes.length ? Math.max(...holes.map((h) => h.drill)) : 0;
  // A hair over the edge clearance, so rounding the final shift to 0.01 mm can't eat into it.
  const edge = rules.edge + 0.01;
  /** The outline around a layout: its box plus the edge clearance, grown where a corner hole would touch a part. */
  const outlineOf = (u: Layout): Rect => {
    const box = unitBox(u);
    const o = { minX: box.minX - edge, minY: box.minY - edge, maxX: box.maxX + edge, maxY: box.maxY + edge };
    if (!holes.length) return o;
    const boxes = [...u].map(([p, pose]) => boxAt(p, pose));
    const reach = drill / 2 + edge;
    // Each corner whose hole would touch parts is cleared by growing the board sideways or
    // up/down by enough to move the hole past all of them. Growing only moves holes away from
    // parts, so the corners don't interfere: try every choice, keep the smallest board.
    const needs: { cx: 0 | 1; cy: 0 | 1; x: number; y: number }[] = [];
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const hx = cx ? o.maxX - HOLE_INSET : o.minX + HOLE_INSET;
      const hy = cy ? o.maxY - HOLE_INSET : o.minY + HOLE_INSET;
      const zone = { minX: hx - reach, minY: hy - reach, maxX: hx + reach, maxY: hy + reach };
      const hit = boxes.filter((b) => rectGap(b, zone) < -TOLERANCE);
      if (!hit.length) continue;
      needs.push({
        cx, cy,
        x: Math.max(...hit.map((b) => (cx ? b.maxX - zone.minX : zone.maxX - b.minX))),
        y: Math.max(...hit.map((b) => (cy ? b.maxY - zone.minY : zone.maxY - b.minY))),
      });
    }
    let best: Rect = o;
    let bestArea = Infinity;
    for (let mask = 0; mask < 1 << needs.length; mask++) {
      const g = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      needs.forEach((n, i) => {
        if (mask & (1 << i)) {
          if (n.cx) g.maxX = Math.max(g.maxX, n.x);
          else g.minX = Math.max(g.minX, n.x);
        } else if (n.cy) g.maxY = Math.max(g.maxY, n.y);
        else g.minY = Math.max(g.minY, n.y);
      });
      const r = { minX: o.minX - g.minX, minY: o.minY - g.minY, maxX: o.maxX + g.maxX, maxY: o.maxY + g.maxY };
      const area = (r.maxX - r.minX) * (r.maxY - r.minY);
      if (area < bestArea - 1e-9) {
        best = r;
        bestArea = area;
      }
    }
    return best;
  };

  const layout = layoutBlock('');
  alignRows(layout);
  const o = outlineOf(layout);
  // Round the size up to the grid (1.27 mm / 50 mil), and put the outline's corner at 0, 0.
  const G = 0.127;
  const width = Math.ceil((o.maxX - o.minX) / G - 1e-6) * G;
  const height = Math.ceil((o.maxY - o.minY) / G - 1e-6) * G;
  const dx = r2(-o.minX + (width - (o.maxX - o.minX)) / 2);
  const dy = r2(-o.minY + (height - (o.maxY - o.minY)) / 2);

  for (const [p, pose] of [...layout].sort(([a], [b]) => a.localeCompare(b))) arr.moveTo(p, [r2(pose.x + dx), r2(pose.y + dy)], pose.rot);

  const W = r3(width);
  const H = r3(height);
  for (const g of board.drawing.filter((x) => 'line' in x && x.layer === 'outline')) arr.tx.run(remove(board.drawing, g));
  for (const h of holes) arr.tx.run(remove(board.drawing, h));
  const corners: O.Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  corners.forEach((c, i) => arr.tx.run(insert(board.drawing, { line: [c, corners[(i + 1) % 4]!], width: 0, layer: 'outline' } as O.Graphic, i)));
  if (holes.length) {
    const at: O.Pt[] = [[HOLE_INSET, HOLE_INSET], [r3(W - HOLE_INSET), HOLE_INSET], [HOLE_INSET, r3(H - HOLE_INSET)], [r3(W - HOLE_INSET), r3(H - HOLE_INSET)]];
    at.forEach((h, i) => arr.tx.run(insert(board.drawing, { hole: h, drill } as O.Graphic, 4 + i)));
  }
  return { parts: layout.size, width: W, height: H };
}

/** How much a mm² of the cluster's box counts against a mm of wiring when arranging blocks. */
const AREA_WEIGHT = 0.1;
/** The same, when choosing a block's own layout. */
const BLOCK_AREA_WEIGHT = SCORE_WEIGHTS.area;
/** Lining parts up: the furthest a part moves, and how near the part it lines up with must be (mm). */
const ALIGN_MOVE = 2;
const ALIGN_REACH = 8;

type Side = 'left' | 'right' | 'above' | 'below';
const OUT: Record<Side, Point> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, above: { x: 0, y: 1 }, below: { x: 0, y: -1 } };

/** The side of a box a point is nearest. */
function sideOf(box: Rect, p: Point): Side {
  const d: [Side, number][] = [['left', p.x - box.minX], ['right', box.maxX - p.x], ['below', p.y - box.minY], ['above', box.maxY - p.y]];
  d.sort((a, b) => a[1] - b[1]);
  return d[0]![0];
}

/** Offsets to try, out from the anchor (o) and along its side (a), nearest first. */
const SEARCH: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let o = 0; o <= 10 + 1e-9; o += 0.25) for (let a = -5; a <= 5 + 1e-9; a += 0.25) out.push([r3(o), r3(a)]);
  return out.sort((p, q) => p[0] + 1.5 * Math.abs(p[1]) - (q[0] + 1.5 * Math.abs(q[1])));
})();
