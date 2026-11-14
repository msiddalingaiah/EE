// A basic autorouter for the easy part of a board, the way one is often finished by hand:
//
// 1. Each SMD pad on ground gets a short trace to its own via (a dogbone: the via set back from
//    every pad, outside the part), for the ground pour below.
// 2. Signal connections (airwires), shortest first, on the top layer; where the top is blocked,
//    a short run on the bottom through two vias. Nothing is ripped up: what doesn't route stays
//    an airwire to finish by hand.
// 3. Pours over the whole board: the main supply (VCC) on top, ground on the bottom.
// 4. Supply pads the pours leave unconnected (an island cut off by traces) are routed like
//    signals.
//
// Traces are the net's width (10 mil by default), clear of everything by the design rules: each
// route is found around obstacles (walkaround.ts) and checked exactly before it is added.

import { ProjectIndex } from '../model/derive';
import { ClearanceChecker, type ObstacleGrid } from '../model/drc';
import { boardArea, footprintInfos, isGroundNet, rectCenter, supplyNets, type Rect } from '../model/placement';
import { ratsnest, type Airwire } from '../model/ratsnest';
import type * as O from '../model/types';
import type { Transaction } from './ops';
import { addPour } from './pours';
import { addRoute, anchors, copperLayers, traceWidth, viaDrill, type Anchor, type Leg } from './route';
import { findDetour } from './walkaround';

export interface AutorouteOptions {
  /** Longest run on the bottom layer, through two vias, when the top is blocked (mm; 0: top only). */
  maxBottomRun?: number;
}

export interface AutorouteResult {
  /** Connections routed. */
  routed: number;
  /** Connections left as airwires. */
  left: Airwire[];
  /** Ground vias added for SMD pads. */
  groundVias: number;
  /** Pours added, as "NET on layer". */
  pours: string[];
}

const TOP = 'copper.top';
const BOTTOM = 'copper.bottom';
/** The search raster's step (mm): 5 mil, fine enough for 10 mil traces at 6 mil clearance. */
const STEP = 0.127;
/** Room between an SMD pad's via and any pad's copper, for a solder mask dam (mm, ≈ 12 mil). */
const VIA_PAD_GAP = 0.3;
/** How far from an SMD ground pad its via may go (mm). */
const VIA_REACH = 2.5;
const DEFAULT_BOTTOM_RUN = 8;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function autoroute(project: O.Project, tx: Transaction, opts: AutorouteOptions = {}): AutorouteResult {
  const board = project.board;
  const result: AutorouteResult = { routed: 0, left: [], groundVias: 0, pours: [] };
  if (!board) return result;
  const stack = copperLayers(project);
  const twoLayers = stack.includes(TOP) && stack.includes(BOTTOM);
  const maxBottom = twoLayers ? opts.maxBottomRun ?? DEFAULT_BOTTOM_RUN : 0;

  const supplies = supplyNets(project);
  const ground = project.nets.filter((n) => isGroundNet(n.name)).map((n) => n.name);
  const index0 = new ProjectIndex(project);
  const padCount = new Map<string, number>();
  for (const a of anchors(project, index0)) if (a.kind === 'pad') padCount.set(a.net, (padCount.get(a.net) ?? 0) + 1);
  // The supply poured on top: the one with the most pads.
  const power = [...supplies].filter((n) => !isGroundNet(n)).sort((a, b) => (padCount.get(b) ?? 0) - (padCount.get(a) ?? 0))[0];
  const poured = new Set([...ground, ...(power ? [power] : [])]);

  // The model changes with every route: re-read the copper before each one.
  let checker = new ClearanceChecker(project);
  let anchorList = anchors(project);
  const grids = new Map<string, ObstacleGrid>();
  const refresh = () => {
    const index = new ProjectIndex(project);
    checker = new ClearanceChecker(project, index);
    anchorList = anchors(project, index);
    grids.clear();
  };
  const grid = (net: string, layer: string, width: number) => {
    const key = `${net}|${layer}|${width}`;
    let g = grids.get(key);
    if (!g) grids.set(key, (g = checker.obstacles(net, layer, width, STEP)));
    return g;
  };
  const viaGrid = (net: string, drill: number) => {
    const D = checker.rules.viaDiameter(drill, 0);
    const key = `${net}|via|${D}`;
    let g = grids.get(key);
    if (!g) {
      const per = stack.map((l) => checker.obstacles(net, l, D, STEP, 'via'));
      const blocked = new Uint8Array(per[0]!.blocked.length);
      for (const p of per) for (let i = 0; i < blocked.length; i++) blocked[i] = blocked[i]! | p.blocked[i]!;
      grids.set(key, (g = { ...per[0]!, blocked }));
    }
    return g;
  };
  const anchorAt = (net: string, p: O.Pt): Anchor | undefined =>
    anchorList.filter((a) => a.net === net).sort((a, b) => Math.hypot(a.at[0] - p[0], a.at[1] - p[1]) - Math.hypot(b.at[0] - p[0], b.at[1] - p[1]))[0];

  // ---- 1. ground vias for SMD pads ----------------------------------------------------------
  if (twoLayers) {
    for (const net of ground) {
      const drill = viaDrill(project, net);
      const width = traceWidth(project, net);
      const pads = anchorList.filter((a) => a.net === net && a.kind === 'pad' && a.layers.length === 1 && a.layers[0] === TOP);
      const viaR = checker.rules.viaDiameter(drill, 0) / 2;
      for (const pad of pads) {
        // Every pad's copper (any net) and the centre of this pad's part, for the via's spacing
        // and side; the vias already placed count as copper to keep clear of as well.
        const infos = footprintInfos(project);
        const boxes = infos.flatMap((f) => f.pads.map((q) => q.box));
        const part = infos.find((f) => f.part === pad.pad?.part);
        const centre = part ? rectCenter(part.box) : { x: pad.at[0], y: pad.at[1] };
        const spot = viaSpot(checker, net, pad.at, [centre.x, centre.y], boxes, viaR, drill, width);
        if (!spot) continue;
        addRoute(project, net, [{ line: [pad.at, spot], layer: TOP }], [spot], tx);
        result.groundVias++;
        refresh();
      }
    }
  }

  // ---- 2. signals, shortest first ------------------------------------------------------------
  const routeAll = (nets: (n: string) => boolean) => {
    const wires = ratsnest(project).filter((a) => nets(a.net)).sort((a, b) => length(a) - length(b));
    for (const a of wires) {
      if (routeOne(a)) result.routed++;
      else result.left.push(a);
    }
  };
  const routeOne = (a: Airwire): boolean => {
    const from = anchorAt(a.net, a.from);
    const to = anchorAt(a.net, a.to);
    if (!from || !to) return false;
    const width = traceWidth(project, a.net);
    const drill = viaDrill(project, a.net);
    const startOn = from.layers.includes(TOP) ? TOP : from.layers[0]!;
    const tryRoute = (layers: string[], vias: boolean) => {
      const order = [startOn, ...layers.filter((l) => l !== startOn)].filter((l) => layers.includes(l));
      return findDetour(checker, {
        net: a.net,
        width,
        layers: order.map((name) => ({ name, grid: grid(a.net, name, width) })),
        ...(vias ? { vias: { grid: viaGrid(a.net, drill), drill } } : {}),
        from: from.at,
        to: to.at,
        endLayers: to.layers.filter((l) => layers.includes(l)),
      });
    };
    let found = from.layers.includes(TOP) && to.layers.includes(TOP) ? tryRoute([TOP], false) : undefined;
    if (!found && maxBottom > 0) {
      const d = tryRoute([TOP, BOTTOM], true);
      const bottom = d?.runs.filter((r) => r.layer === BOTTOM).reduce((s, r) => s + polyLength(r.pts), 0) ?? 0;
      if (d && bottom <= maxBottom + 1e-9) found = d;
    }
    if (!found) return false;
    const legs: Leg[] = [];
    for (const run of found.runs) for (let i = 1; i < run.pts.length; i++) legs.push({ line: [run.pts[i - 1]!, run.pts[i]!], layer: run.layer });
    // Checked again as a whole: the pieces were found one at a time.
    for (const l of legs) if (!checker.clear(a.net, l.line[0], l.line[1], l.layer, width)) return false;
    for (const v of found.vias) if (checker.via(a.net, v, drill).length) return false;
    addRoute(project, a.net, legs, found.vias, tx);
    refresh();
    return true;
  };
  routeAll((n) => !poured.has(n) && !supplies.has(n));
  // Supplies other than the poured ones (a second rail) are routed like signals.
  routeAll((n) => supplies.has(n) && !poured.has(n));

  // ---- 3. pours --------------------------------------------------------------------------------
  const area = boardArea(board);
  if (area) {
    const o = area.outline;
    const rect: O.PolyPt[] = [[r4(o.minX), r4(o.minY)], [r4(o.maxX), r4(o.minY)], [r4(o.maxX), r4(o.maxY)], [r4(o.minX), r4(o.maxY)]];
    const pour = (net: string, layer: string) => {
      if (project.nets.find((n) => n.name === net)?.pours?.some((p) => p.layer === layer)) return;
      addPour(project, net, rect, layer, tx);
      result.pours.push(`${net} on ${layer.replace('copper.', '')}`);
    };
    if (power) pour(power, TOP);
    if (twoLayers && ground[0]) pour(ground[0], BOTTOM);
    refresh();
  }

  // ---- 4. supply pads the pours don't reach ----------------------------------------------------
  routeAll((n) => poured.has(n));
  return result;
}

/**
 * Where an SMD pad's via goes: a "dogbone", a short trace out to a via set back from the pad.
 * The via's copper keeps VIA_PAD_GAP from every pad (room for a solder mask dam: an untented via
 * next to a pad wicks solder away from the joint in reflow, and one in the pad sinks the iron's
 * heat into the plane), and it goes on the pad's outer side, away from its part's other pads,
 * where it can. The nearest such spot within VIA_REACH that fits and the trace reaches.
 */
function viaSpot(checker: ClearanceChecker, net: string, pad: O.Pt, partCentre: O.Pt, pads: Rect[], viaR: number, drill: number, width: number): O.Pt | undefined {
  const out = { x: pad[0] - partCentre[0], y: pad[1] - partCentre[1] };
  const outLen = Math.hypot(out.x, out.y);
  let best: { at: O.Pt; score: number } | undefined;
  for (let r = 0.3; r <= VIA_REACH + 1e-9; r += 0.1) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.15));
    for (let k = 0; k < n; k++) {
      const t = (2 * Math.PI * k) / n;
      const s: O.Pt = [r4(pad[0] + r * Math.cos(t)), r4(pad[1] + r * Math.sin(t))];
      if (pads.some((b) => rectDistance(b, s) < viaR + VIA_PAD_GAP - 1e-9)) continue;
      // Toward the part's middle (between its pads) costs extra length.
      const inward = outLen > 1e-6 ? -((s[0] - pad[0]) * out.x + (s[1] - pad[1]) * out.y) / (outLen * r) : 0;
      const score = r + Math.max(0, inward) * 1.0;
      if (best && score >= best.score - 1e-9) continue;
      if (checker.via(net, s, drill).length) continue;
      if (!checker.clear(net, pad, s, TOP, width)) continue;
      best = { at: s, score };
    }
  }
  return best?.at;
}

/** Distance from a point to a box (0 inside). */
function rectDistance(b: Rect, p: O.Pt): number {
  const dx = Math.max(b.minX - p[0], 0, p[0] - b.maxX);
  const dy = Math.max(b.minY - p[1], 0, p[1] - b.maxY);
  return Math.hypot(dx, dy);
}

const length = (a: Airwire) => Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]);

function polyLength(pts: O.Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return s;
}
