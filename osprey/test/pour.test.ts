// Poured copper: isolation from other nets, thermals, orphans, ranks, keep-outs, the board
// edge, and caching.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { collect, padShapes, type Item } from '../src/model/copper';
import { ProjectIndex } from '../src/model/derive';
import { drc } from '../src/model/drc';
import { readProject } from '../src/model/file';
import { computePours, DEFAULT_POUR_ISOLATE, freezePours, inIsland, pourFills, pourIsolate, type PourFill } from '../src/model/pour';
import { ratsnest } from '../src/model/ratsnest';
import { DesignRules, designRules } from '../src/model/rules';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
beforeEach(() => {
  p = readProject(ORIGINAL);
});

const net = (name: string) => p.nets.find((n) => n.name === name)!;
const fillOf = (name: string): PourFill => [...computePours(p).values()].find((f) => f.net === name)!;
const copperAt = (f: PourFill, x: number, y: number) => f.islands.some((isl) => inIsland(isl, { x, y }));
const rules = () => new DesignRules(designRules(p));
const items = () => collect(p, rules(), new ProjectIndex(p));
/** A through-hole pad of a net on the pour's layer (with a centre and axes). */
const thPad = (name: string): Item => items().find((it) => it.net === name && it.kind === 'pad')!;

describe('the sample board', () => {
  it('pours VCC on top and GND on the bottom, each one island with holes', () => {
    const fills = [...computePours(p).values()];
    expect(fills.map((f) => [f.net, f.layer, f.islands.length])).toEqual([['VCC', 'copper.top', 1], ['GND', 'copper.bottom', 1]]);
    for (const f of fills) expect(f.islands[0]!.holes.length).toBeGreaterThan(50);
  });

  it('keeps every clearance and the board-edge distance (the DRC finds nothing)', () => {
    expect(drc(p).violations).toEqual([]);
  });

  it('stays its isolate inside the board outline, whatever the copper-to-edge rule', () => {
    const f = fillOf('VCC');
    expect(f.pour.isolate).toBeUndefined();
    expect(pourIsolate(f.pour)).toBe(DEFAULT_POUR_ISOLATE); // 10 mil
    expect(rules().copperDimension).toBeCloseTo(0.381, 6); // 15 mil: not used
    const xs = f.islands[0]!.outer.map((q) => q[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(DEFAULT_POUR_ISOLATE);
    expect(Math.min(...xs)).toBeLessThan(DEFAULT_POUR_ISOLATE + 0.01);
    f.pour.isolate = 0.5;
    const ys = fillOf('VCC').islands.flatMap((i) => i.outer.map((q) => q[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0.5);
    expect(Math.min(...ys)).toBeLessThan(0.51);
  });

  it("keeps its isolate from holes and other nets' copper, not the clearance rules", () => {
    const f = fillOf('GND');
    const hole = p.board!.drawing.find((g): g is O.HoleShape => 'hole' in g);
    if (hole) {
      const r = hole.drill / 2 + pourIsolate(f.pour);
      expect(copperAt(f, hole.hole[0] + r - 0.02, hole.hole[1])).toBe(false);
    }
    // A pad of another net: no copper closer than the isolate (10 mil), though the rules ask only 6 mil.
    const pad = items().find((it) => it.net !== 'GND' && it.kind === 'pad' && it.layers.has('copper.bottom'))!;
    const x = pad.box.maxX + pourIsolate(f.pour) - 0.03;
    const y = (pad.box.minY + pad.box.maxY) / 2;
    expect(copperAt(f, x, y)).toBe(false);
  });

  it('connects GND and VCC through the pours: no airwires', () => {
    expect(ratsnest(p)).toEqual([]);
  });
});

describe('thermals', () => {
  it('a pad of the net gets a gap crossed by four spokes along its axes', () => {
    const pad = thPad('VCC');
    const f = fillOf('VCC');
    const r = Math.max(pad.box.maxX - pad.box.minX, pad.box.maxY - pad.box.minY) / 2;
    const gap = r + rules().thermalIsolate / 2;
    const c = pad.center!;
    // On the diagonals: the gap. Along the axes: a spoke.
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) expect(copperAt(f, c.x + (dx! * gap) / Math.SQRT2, c.y + (dy! * gap) / Math.SQRT2)).toBe(false);
    const spokes = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => copperAt(f, c.x + dx! * gap, c.y + dy! * gap));
    expect(spokes.length).toBeGreaterThanOrEqual(2); // a spoke may be cut by a neighbouring net
    expect(f.islands[0]!.reaches.has(pad.ref)).toBe(true);
  });

  it('with thermals off the pad connects fully', () => {
    net('VCC').pours![0]!.thermals = false;
    const pad = thPad('VCC');
    const r = Math.max(pad.box.maxX - pad.box.minX, pad.box.maxY - pad.box.minY) / 2;
    const gap = r + rules().thermalIsolate / 2;
    const c = pad.center!;
    const diagonals = [[1, 1], [-1, 1], [1, -1], [-1, -1]].filter(([dx, dy]) => copperAt(fillOf('VCC'), c.x + (dx! * gap) / Math.SQRT2, c.y + (dy! * gap) / Math.SQRT2));
    expect(diagonals.length).toBeGreaterThan(0);
  });

  it('a pad half outside the pour still connects through its spoke', () => {
    // Pull the VCC pour's right edge to run through the middle of a VCC pad.
    const pad = thPad('VCC');
    const pour = net('VCC').pours![0]!;
    pour.polygon = [[0, 0], [0, 36.83], [pad.center!.x, 36.83], [pad.center!.x, 0]];
    const f = fillOf('VCC');
    expect(f.islands.some((isl) => isl.reaches.has(pad.ref))).toBe(true);
  });
});

describe('islands', () => {
  it('drops islands that reach none of the net\'s copper, unless orphans are kept', () => {
    // A small pour in a corner with no GND copper in it.
    const corner: O.PolygonShape = { polygon: [[1, 1], [1, 3], [3, 3], [3, 1]], width: 0.254, layer: 'copper.top' };
    net('GND').pours!.push(corner);
    expect(computePours(p).get(corner)!.islands).toEqual([]);
    corner.orphans = true;
    expect(computePours(p).get(corner)!.islands).toHaveLength(1);
  });

  it('a pour of lower rank number goes first; later ones keep clear of it', () => {
    // A GND pour on top overlapping VCC's: rank 2 yields to VCC (rank 1).
    const gnd: O.PolygonShape = { polygon: [[0, 0], [0, 36.83], [36.83, 36.83], [36.83, 0]], width: 0.254, layer: 'copper.top', rank: 2, orphans: true };
    net('GND').pours!.push(gnd);
    expect(drc(p).violations.filter((v) => v.kind === 'overlap')).toEqual([]);
    // At the same rank the two overlap, and the DRC says so.
    gnd.rank = 1;
    expect(drc(p).violations.some((v) => v.kind === 'overlap' && v.nets.includes('GND') && v.nets.includes('VCC'))).toBe(true);
  });

  it('keeps out of keep-out (restrict) areas', () => {
    const f0 = fillOf('VCC');
    expect(copperAt(f0, 20, 33)).toBe(true);
    const bottomBefore = copperAt(fillOf('GND'), 20, 33);
    p.board!.drawing.push({ rect: [[18, 32], [22, 35]], layer: 'restrict.top' });
    const f = fillOf('VCC');
    expect(copperAt(f, 20, 33)).toBe(false);
    // Only on its own layer: the bottom pour is unchanged there.
    expect(copperAt(fillOf('GND'), 20, 33)).toBe(bottomBefore);
  });
});

describe('round SMD pads (fiducials)', () => {
  it('a fully rounded pad is a disc, not a degenerate polygon', () => {
    const shapes = padShapes({ name: '1', at: [0, 0], smd: [1.016, 1.016], roundness: 100 }, rules());
    expect(shapes).toEqual([{ t: 'cap', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, r: 0.508 }]);
    const oblong = padShapes({ name: '1', at: [0, 0], smd: [2, 1], roundness: 100 }, rules());
    expect(oblong).toEqual([{ t: 'cap', a: { x: -0.5, y: 0 }, b: { x: 0.5, y: 0 }, r: 0.5 }]);
  });
});

describe('caching', () => {
  it('reuses fills until the copper changes; frozen, it keeps the last ones', () => {
    const a = pourFills(p);
    expect(pourFills(p)).toBe(a);
    net('GND').traces![0]!.width += 0.1;
    const b = pourFills(p);
    expect(b).not.toBe(a);
    freezePours(p, true);
    net('GND').traces![0]!.width += 0.1;
    expect(pourFills(p)).toBe(b);
    freezePours(p, false);
    expect(pourFills(p)).not.toBe(b);
  });
});
