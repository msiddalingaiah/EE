// Geometry edits on the native model: every move, rotation and mirror goes through
// transformTargets, which applies an edit transform E to the selected objects and drags
// the ends of wires and traces attached to them (rubber-banding).

import type { Point, Transform } from '../geom/transform';
import { apply, compose, composeRotation, isMirrored, placement } from '../geom/transform';
import { netPads, ProjectIndex } from '../model/derive';
import { mirrorLayer, padPosition, pinPosition, rotation } from '../model/geometry';
import type * as O from '../model/types';
import type { Target, WireSegment } from '../scene/types';
import { set, type Transaction } from './ops';

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

/** Can commands change this target? Locked footprints (and their labels) can't move. */
export function isEditable(t: Target): boolean {
  if (t.kind === 'footprint') return !t.footprint.locked;
  if (t.kind === 'label' && t.doc === 'board') return !(t.placement as O.FootprintPlacement).locked;
  return true;
}

/** Which document a target lives in. */
export function docOf(t: Target): 'schematic' | 'board' {
  switch (t.kind) {
    case 'gate': case 'wire': case 'junction': case 'netlabel': return 'schematic';
    case 'footprint': case 'trace': case 'via': case 'pour': return 'board';
    case 'drawing': case 'label': return t.doc;
    // In a library: symbols are schematic-like, footprints board-like (layers mirror).
    case 'pin': case 'libgate': return 'schematic';
    case 'pad': return 'board';
  }
}

// ---------------------------------------------------------------------------

interface Ctx {
  E: Transform;
  mirrored: boolean;
  tx: Transaction;
}

const round = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const at = (E: Transform, p: O.Pt): O.Pt => {
  const q = apply(E, p[0], p[1]);
  return [round(q.x), round(q.y)];
};

/** rot/mirror fields after applying E (undefined = default, so the field is omitted). */
function turned(E: Transform, rot: number | undefined, mirror: boolean | undefined, spin?: boolean) {
  const r = composeRotation(E, rotation(rot, mirror, spin));
  return { rot: r.angle || undefined, mirror: r.mirror || undefined };
}

/**
 * The rotation of something that has a direction but no mirrored form (a pin, a pad) after E:
 * the direction it points, turned (and reflected) by E, as an angle snapped to `step` degrees
 * (any angle when 0). undefined for 0, so the field is omitted.
 */
function turnedDirection(E: Transform, rot: number | undefined, step: number): number | undefined {
  const a = ((rot ?? 0) * Math.PI) / 180;
  const dx = E.a * Math.cos(a) + E.c * Math.sin(a);
  const dy = E.b * Math.cos(a) + E.d * Math.sin(a);
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (step) deg = Math.round(deg / step) * step;
  deg = round(((deg % 360) + 360) % 360);
  return deg === 0 || deg === 360 ? undefined : deg;
}

/** Apply edit transform E to targets (schematic and/or board) inside `tx`. */
export function transformTargets(project: O.Project, targets: Target[], E: Transform, tx: Transaction, index = new ProjectIndex(project)): void {
  const c: Ctx = { E, mirrored: isMirrored(E), tx };
  const moved = targets.filter(isEditable);
  const placements = new Set<object>(moved.flatMap((t) => (t.kind === 'gate' ? [t.gate] : t.kind === 'footprint' ? [t.footprint] : [])));

  // Rubber-band anchors, captured before anything moves.
  const schAnchors = schematicAnchors(project, moved, index);
  const brdAnchors = boardAnchors(project, moved, index);

  for (const t of moved) {
    switch (t.kind) {
      case 'gate': {
        const g = t.gate;
        c.tx.run(set(g, { at: at(E, g.at), ...turned(E, g.rot, g.mirror) }));
        for (const l of g.labels ?? []) moveLabel(l, c, false);
        break;
      }
      case 'footprint': {
        const f = t.footprint;
        const r = composeRotation(E, rotation(f.rot, f.side === 'bottom'));
        c.tx.run(set(f, { at: at(E, f.at), rot: r.angle || undefined, side: r.mirror ? 'bottom' : undefined }));
        for (const l of f.labels ?? []) moveLabel(l, c, true);
        break;
      }
      case 'wire': moveLine(t.wire, c, false); break;
      case 'junction': {
        const p = at(E, t.junction);
        c.tx.run(set(t.junction, { 0: p[0], 1: p[1] }));
        break;
      }
      case 'netlabel': moveText(t.label, c, false); break;
      case 'trace': moveLine(t.trace, c, true); break;
      case 'via': c.tx.run(set(t.via, { at: at(E, t.via.at) })); break;
      case 'pour': movePolygon(t.pour, c, true); break;
      case 'drawing': moveGraphic(t.graphic, c, t.doc === 'board'); break;
      case 'label':
        // A label moves with its part when both are selected.
        if (!placements.has(t.placement)) moveLabel(t.label, c, t.doc === 'board');
        break;
      case 'pin': c.tx.run(set(t.pin, { at: at(E, t.pin.at), rot: turnedDirection(E, t.pin.rot, 90) })); break;
      case 'pad': c.tx.run(set(t.pad, { at: at(E, t.pad.at), rot: turnedDirection(E, t.pad.rot, 0) })); break;
      // A gate has a place in its component but no rotation (Eagle's gates don't turn).
      case 'libgate': c.tx.run(set(t.gate, { at: at(E, t.gate.at) })); break;
    }
  }

  const movedWires = new Set<object>(moved.flatMap((t): object[] => (t.kind === 'wire' ? [t.wire] : t.kind === 'trace' ? [t.trace] : t.kind === 'junction' ? [t.junction] : [])));
  for (const [seg, pts] of schAnchors) {
    dragLines(seg.wires, pts, movedWires, c);
    if ('junctions' in seg) {
      for (const j of seg.junctions ?? []) {
        if (movedWires.has(j) || !pts.some((p) => near(p, j[0], j[1]))) continue;
        const p = at(E, j);
        c.tx.run(set(j, { 0: p[0], 1: p[1] }));
      }
    }
  }
  for (const [net, pts] of brdAnchors) dragLines(net.traces ?? [], pts, movedWires, c);
}

// ---------------------------------------------------------------------------
// Rubber-banding

const near = (p: Point, x: number, y: number) => Math.abs(p.x - x) < EPS && Math.abs(p.y - y) < EPS;

function addTo<K>(m: Map<K, Point[]>, k: K, p: Point): void {
  const list = m.get(k);
  if (list) list.push(p);
  else m.set(k, [p]);
}

/** Old positions of moved pins, wire ends and junctions, per schematic segment. */
function schematicAnchors(project: O.Project, moved: Target[], index: ProjectIndex): Map<WireSegment, Point[]> {
  const out = new Map<WireSegment, Point[]>();
  const gates = new Set(moved.flatMap((t) => (t.kind === 'gate' ? [t.gate] : [])));
  if (gates.size && project.schematic) {
    const sheets = new Map(project.schematic.sheets.map((s) => [s.id, s]));
    for (const net of project.nets) {
      for (const seg of net.segments ?? []) {
        const sheet = sheets.get(seg.sheet);
        for (const pr of seg.pins) {
          const g = sheet?.gates.find((x) => x.part === pr.part && x.gate === pr.gate);
          if (!g || !gates.has(g)) continue;
          const p = pinPosition(index, g, pr.pin);
          if (p) addTo(out, seg, p);
        }
      }
    }
  }
  for (const t of moved) {
    if (t.kind === 'wire') {
      addTo(out, t.segment, { x: t.wire.line[0][0], y: t.wire.line[0][1] });
      addTo(out, t.segment, { x: t.wire.line[1][0], y: t.wire.line[1][1] });
    }
    if (t.kind === 'junction') addTo(out, t.segment, { x: t.junction[0], y: t.junction[1] });
  }
  return out;
}

/** Old positions of moved pads, vias and trace ends, per net. */
function boardAnchors(project: O.Project, moved: Target[], index: ProjectIndex): Map<O.Net, Point[]> {
  const out = new Map<O.Net, Point[]>();
  const fps = moved.flatMap((t) => (t.kind === 'footprint' ? [t.footprint] : []));
  if (fps.length) {
    const pads = netPads(project, index);
    const byPart = new Map(fps.map((f) => [f.part, f]));
    for (const net of project.nets) {
      for (const key of pads.get(net.name) ?? []) {
        const [part, pad] = key.split('\u0000') as [string, string];
        const f = byPart.get(part);
        const p = f && padPosition(index, f, pad);
        if (p) addTo(out, net, p);
      }
    }
  }
  for (const t of moved) {
    if (t.kind === 'via') addTo(out, t.net, { x: t.via.at[0], y: t.via.at[1] });
    if (t.kind === 'trace') {
      addTo(out, t.net, { x: t.trace.line[0][0], y: t.trace.line[0][1] });
      addTo(out, t.net, { x: t.trace.line[1][0], y: t.trace.line[1][1] });
    }
  }
  return out;
}

/** Drag the ends of lines (not themselves moved) that sit on an anchor. */
function dragLines(lines: { line: [O.Pt, O.Pt] }[], anchors: Point[], skip: Set<object>, c: Ctx): void {
  for (const w of lines) {
    if (skip.has(w)) continue;
    const [a, b] = w.line;
    const ma = anchors.some((p) => near(p, a[0], a[1]));
    const mb = anchors.some((p) => near(p, b[0], b[1]));
    if (!ma && !mb) continue;
    c.tx.run(set(w, { line: [ma ? at(c.E, a) : a, mb ? at(c.E, b) : b] }));
  }
}

// ---------------------------------------------------------------------------
// Moving shapes

const flipLayer = (layer: string, c: Ctx, board: boolean) => (c.mirrored && board ? mirrorLayer(layer) : layer);

function moveLine(w: O.Wire | O.LineShape, c: Ctx, board: boolean): void {
  const patch: Record<string, unknown> = { line: [at(c.E, w.line[0]), at(c.E, w.line[1])] };
  if (c.mirrored && w.curve) patch.curve = -w.curve;
  if (board && w.layer) patch.layer = flipLayer(w.layer, c, board);
  c.tx.run(set(w, patch));
}

function moveText(t: { at: O.Pt; rot?: number; mirror?: boolean; spin?: boolean; layer: string }, c: Ctx, board: boolean): void {
  c.tx.run(set(t, { at: at(c.E, t.at), ...turned(c.E, t.rot, t.mirror, t.spin), layer: flipLayer(t.layer, c, board) }));
}

function moveLabel(l: O.Label, c: Ctx, board: boolean): void {
  moveText(l, c, board);
}

function movePolygon(p: O.PolygonShape, c: Ctx, board: boolean): void {
  const pts = p.polygon.map((v): O.PolyPt => {
    const q = at(c.E, [v[0], v[1]]);
    return v[2] ? [q[0], q[1], c.mirrored ? -v[2] : v[2]] : q;
  });
  c.tx.run(set(p, { polygon: pts, layer: flipLayer(p.layer, c, board) }));
}

function moveGraphic(g: O.Graphic, c: Ctx, board: boolean): void {
  if ('line' in g) moveLine(g, c, board);
  else if ('polygon' in g) movePolygon(g, c, board);
  else if ('text' in g) moveText(g, c, board);
  else if ('circle' in g) c.tx.run(set(g, { circle: at(c.E, g.circle), layer: flipLayer(g.layer, c, board) }));
  else if ('hole' in g) c.tx.run(set(g, { hole: at(c.E, g.hole) }));
  else if ('rect' in g) {
    // Rectangles rotate about their centre; a mirrored rectangle is just a rotated one.
    const [[x1, y1], [x2, y2]] = g.rect;
    const hw = Math.abs(x2 - x1) / 2;
    const hh = Math.abs(y2 - y1) / 2;
    const ctr = at(c.E, [(x1 + x2) / 2, (y1 + y2) / 2]);
    const r = composeRotation(c.E, rotation(g.rot, false)).angle;
    c.tx.run(set(g, {
      rect: [[round(ctr[0] - hw), round(ctr[1] - hh)], [round(ctr[0] + hw), round(ctr[1] + hh)]],
      rot: r || undefined, layer: flipLayer(g.layer, c, board),
    }));
  } else if ('frame' in g) {
    const a = at(c.E, g.frame[0]);
    const b = at(c.E, g.frame[1]);
    c.tx.run(set(g, { frame: [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]] }));
  }
}

