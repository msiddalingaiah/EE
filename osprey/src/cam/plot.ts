// What each Eagle layer of a board plots, for CAM output: graphics, text, traces and poured
// copper (from the board scene in CAM mode), plus pads, SMDs and vias on their copper layers,
// with the solder mask openings (layers 29/30) and solder paste (31/32) they generate, and holes.
//
// Pads are flashed with standard apertures where their orientation allows (Eagle does the same);
// other orientations, and rounded SMDs, are plotted as regions.

import type { Point, Transform } from '../geom/transform';
import { angleOf, apply, compose, placement } from '../geom/transform';
import { viaLayers } from '../model/copper';
import { ProjectIndex } from '../model/derive';
import { designRules, footprintTransform } from '../model/geometry';
import { layerNumber } from '../model/layers';
import { DesignRules } from '../model/rules';
import type * as O from '../model/types';
import { buildBoardScene } from '../scene/board';
import { HOLES_LAYER } from '../scene/builder';
import { strokeWidth } from '../scene/font';
import type { Drill } from './excellon';
import { textRegions } from './text';
import type { Aperture } from './gerber';

export type Feature =
  | { t: 'flash'; ap: Aperture; at: Point }
  | { t: 'stroke'; pts: Point[]; width: number }
  | { t: 'arc'; c: Point; r: number; start: number; sweep: number; width: number }
  | { t: 'region'; pts: Point[] }
  /** Poured copper: an island, with holes. */
  | { t: 'fill'; outer: Point[]; holes: Point[][] };

export interface Plot {
  /** Features by Eagle layer number. */
  layers: Map<number, Feature[]>;
  drills: Drill[];
  /** Texts by Eagle layer number: their stroke widths (mm), as plotted. */
  texts: Map<number, number[]>;
}

/** Board copper layer names (top to bottom) as Eagle layer numbers. */
function copperStack(board: O.Board): number[] {
  return (board.layers.length ? board.layers : ['copper.top', 'copper.bottom']).map(layerNumber);
}

export function plotBoard(project: O.Project, index = new ProjectIndex(project)): Plot {
  const board = project.board;
  if (!board) throw new Error('The project has no board');
  const rules = new DesignRules(designRules(project));
  const plot: Plot = { layers: new Map(), drills: [], texts: new Map() };
  const add = (layer: number, f: Feature) => {
    let list = plot.layers.get(layer);
    if (!list) plot.layers.set(layer, (list = []));
    list.push(f);
  };

  plotScene(project, index, plot, add, rules);

  const stack = copperStack(board);
  for (const f of board.footprints) {
    const part = index.parts.get(f.part);
    const fpId = part && index.variantOf(part)?.footprint;
    const fp = fpId ? index.footprints.get(fpId) : undefined;
    if (!fp) continue;
    const FT = footprintTransform(f);
    for (const pad of fp.pads) {
      const T = compose(FT, placement(pad.at[0], pad.at[1], { angle: pad.rot ?? 0, mirror: false, spin: false }));
      const form = padForm(pad, rules);
      const copper = place(form, T);
      if (pad.smd) {
        const bottom = (pad.side === 'bottom') !== (f.side === 'bottom');
        add(bottom ? 16 : 1, copper);
        const size = Math.min(pad.smd[0], pad.smd[1]);
        if (pad.mask !== false) add(bottom ? 30 : 29, place(grown(form, rules.stopFrame(size)), T));
        if (pad.paste !== false) {
          const paste = grown(form, -rules.creamFrame(size));
          if (paste.w > 0 && paste.h > 0) add(bottom ? 32 : 31, place(paste, T));
        }
      } else {
        for (const l of stack) add(l, copper);
        const mask = place(grown(form, rules.stopFrame(Math.min(form.w, form.h))), T);
        add(29, mask);
        add(30, mask);
        plot.drills.push({ at: apply(T, 0, 0), d: pad.drill ?? 0, plated: true });
      }
    }
  }

  const names = board.layers.length ? board.layers : ['copper.top', 'copper.bottom'];
  for (const net of project.nets) {
    for (const v of net.vias ?? []) {
      const D = rules.viaDiameter(v.drill, v.diameter ?? 0);
      const form: PadForm = v.shape === 'square' ? { kind: 'rect', w: D, h: D, rc: 0, dx: 0 } : v.shape === 'octagon' ? { kind: 'oct', w: D, h: D, rc: 0, dx: 0 } : { kind: 'circle', w: D, h: D, rc: 0, dx: 0 };
      const T = placement(v.at[0], v.at[1], { angle: 0, mirror: false, spin: false });
      const layers = [...viaLayers(v.layers ?? '1-16', names)].map(layerNumber);
      for (const l of layers) add(l, place(form, T));
      if (v.drill > rules.viaStopLimit) {
        const mask = place(grown(form, rules.stopFrame(D)), T);
        if (layers.includes(1)) add(29, mask);
        if (layers.includes(16)) add(30, mask);
      }
      plot.drills.push({ at: { x: v.at[0], y: v.at[1] }, d: v.drill, plated: true });
    }
  }
  return plot;
}

/** Graphics, text, traces, pour fills and holes, from the board scene. */
function plotScene(project: O.Project, index: ProjectIndex, plot: Plot, add: (layer: number, f: Feature) => void, rules: DesignRules): void {
  const scene = buildBoardScene(project, [], index, { cam: true });
  for (const p of scene.prims) {
    switch (p.t) {
      case 'line': {
        const a = { x: p.x1, y: p.y1 };
        const b = { x: p.x2, y: p.y2 };
        if (p.cap === 'flat' && p.width > 0) add(p.layer, { t: 'region', pts: band(a, b, p.width / 2) });
        else add(p.layer, { t: 'stroke', pts: [a, b], width: p.width });
        break;
      }
      case 'arc':
        if (p.cap === 'flat' && p.width > 0) add(p.layer, { t: 'region', pts: arcBand(p.cx, p.cy, p.r, p.start, p.sweep, p.width / 2) });
        else add(p.layer, { t: 'arc', c: { x: p.cx, y: p.cy }, r: p.r, start: p.start, sweep: p.sweep, width: p.width });
        break;
      case 'circle':
        if (p.layer === HOLES_LAYER) break; // the hole itself is plotted from its drill
        if (p.width === 0) add(p.layer, { t: 'flash', ap: { t: 'C', d: 2 * p.r }, at: { x: p.cx, y: p.cy } });
        else add(p.layer, { t: 'arc', c: { x: p.cx, y: p.cy }, r: p.r, start: 0, sweep: 2 * Math.PI, width: p.width });
        break;
      case 'poly':
        if (p.holes) {
          add(p.layer, { t: 'fill', outer: p.pts, holes: p.holes });
          break;
        }
        if (p.fill) add(p.layer, { t: 'region', pts: p.pts });
        if (p.width > 0 || !p.fill) add(p.layer, { t: 'stroke', pts: [...p.pts, p.pts[0]!], width: p.width });
        break;
      case 'text': {
        for (const pts of textRegions(p)) add(p.layer, { t: 'region', pts });
        let widths = plot.texts.get(p.layer);
        if (!widths) plot.texts.set(p.layer, (widths = []));
        widths.push(strokeWidth(p.size, p.ratio));
        break;
      }
      case 'drill': {
        // A hole (unplated): drilled, cleared in both masks, and drawn on the board outline.
        const at = { x: p.cx, y: p.cy };
        const d = 2 * p.r;
        plot.drills.push({ at, d, plated: false });
        const mask: Feature = { t: 'flash', ap: { t: 'C', d: d + 2 * rules.stopFrame(d) }, at };
        add(29, mask);
        add(30, mask);
        add(20, { t: 'arc', c: at, r: p.r, start: 0, sweep: 2 * Math.PI, width: 0 });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pad shapes

/**
 * A pad's shape in its own frame: a rectangle (with corner radius `rc`), circle, octagon (across
 * flats) or obround, `w` × `h`, centred `dx` along its x axis.
 */
interface PadForm {
  kind: 'rect' | 'circle' | 'oct' | 'obround';
  w: number;
  h: number;
  rc: number;
  dx: number;
}

function padForm(pad: O.Pad, rules: DesignRules): PadForm {
  if (pad.smd) {
    const [w, h] = pad.smd;
    return normal({ kind: 'rect', w, h, rc: ((pad.roundness ?? 0) / 100) * (Math.min(w, h) / 2), dx: 0 });
  }
  const D = rules.padDiameter(pad.drill ?? 0, pad.diameter ?? 0);
  switch (pad.shape) {
    case 'square':
      return { kind: 'rect', w: D, h: D, rc: 0, dx: 0 };
    case 'octagon':
      return { kind: 'oct', w: D, h: D, rc: 0, dx: 0 };
    case 'long':
      return { kind: 'obround', w: D * (1 + rules.elongation('long') / 100), h: D, rc: 0, dx: 0 };
    case 'offset': {
      const e = (D * rules.elongation('offset')) / 100;
      return { kind: 'obround', w: D + e, h: D, rc: 0, dx: e / 2 };
    }
    default:
      return { kind: 'circle', w: D, h: D, rc: 0, dx: 0 };
  }
}

/** Fully rounded rectangles are obrounds; equal-sided obrounds are circles. */
function normal(f: PadForm): PadForm {
  const tiny = 1e-9;
  if (f.kind === 'rect' && f.rc > 0 && f.rc >= Math.min(f.w, f.h) / 2 - tiny) f = { ...f, kind: 'obround', rc: 0 };
  if (f.kind === 'obround' && Math.abs(f.w - f.h) < tiny) f = { ...f, kind: 'circle' };
  return f;
}

/** The form grown by `g` on every side (shrunk when negative). */
function grown(f: PadForm, g: number): PadForm {
  return normal({ ...f, w: f.w + 2 * g, h: f.h + 2 * g, rc: f.rc > 0 ? Math.max(f.rc + g, 0) : 0 });
}

const ARC_STEPS = 8; // per quarter turn

/** A flash where the orientation allows one, else a region. */
function place(f: PadForm, T: Transform): Feature {
  const at = apply(T, f.dx, 0);
  const a = angleOf(T);
  const quarter = Math.abs(a / 90 - Math.round(a / 90)) < 1e-9;
  const turned = quarter && Math.round(a / 90) % 2 !== 0;
  const [w, h] = turned ? [f.h, f.w] : [f.w, f.h];
  if (f.kind === 'circle') return { t: 'flash', ap: { t: 'C', d: f.w }, at };
  if (f.kind === 'oct' && Math.abs(a / 45 - Math.round(a / 45)) < 1e-9) return { t: 'flash', ap: { t: 'OC8', d: f.w }, at };
  if (f.kind === 'rect' && f.rc === 0 && quarter) return { t: 'flash', ap: { t: 'R', w, h }, at };
  if (f.kind === 'obround' && quarter) return { t: 'flash', ap: { t: 'O', w, h }, at };
  return { t: 'region', pts: outline(f).map((p) => apply(T, p.x, p.y)) };
}

/** The form's outline in its own frame (counter-clockwise). */
function outline(f: PadForm): Point[] {
  const hw = f.w / 2;
  const hh = f.h / 2;
  if (f.kind === 'oct') {
    const R = hw / Math.cos(Math.PI / 8);
    return Array.from({ length: 8 }, (_, i) => {
      const t = Math.PI / 8 + (i * Math.PI) / 4;
      return { x: f.dx + R * Math.cos(t), y: R * Math.sin(t) };
    });
  }
  const r = f.kind === 'rect' ? f.rc : f.kind === 'obround' ? Math.min(hw, hh) : hw;
  const pts: Point[] = [];
  const corners: [number, number][] = [[hw - r, hh - r], [-(hw - r), hh - r], [-(hw - r), -(hh - r)], [hw - r, -(hh - r)]];
  corners.forEach(([cx, cy], q) => {
    if (r <= 0) {
      pts.push({ x: f.dx + (q === 0 || q === 3 ? hw : -hw), y: q < 2 ? hh : -hh });
      return;
    }
    for (let i = 0; i <= ARC_STEPS; i++) {
      const t = (q * Math.PI) / 2 + (i * Math.PI) / 2 / ARC_STEPS;
      pts.push({ x: f.dx + cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
  });
  return pts;
}

/** A flat-ended band around segment ab. */
function band(a: Point, b: Point, r: number): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * r;
  const ny = ((b.x - a.x) / len) * r;
  return [{ x: a.x + nx, y: a.y + ny }, { x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny }];
}

/** A flat-ended band along an arc. */
function arcBand(cx: number, cy: number, r: number, start: number, sweep: number, hw: number): Point[] {
  const n = Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * ARC_STEPS));
  const at = (rr: number, i: number) => {
    const t = start + (sweep * i) / n;
    return { x: cx + rr * Math.cos(t), y: cy + rr * Math.sin(t) };
  };
  const outer = Array.from({ length: n + 1 }, (_, i) => at(r + hw, i));
  const inner = Array.from({ length: n + 1 }, (_, i) => at(Math.max(r - hw, 0), n - i));
  return [...outer, ...inner];
}
