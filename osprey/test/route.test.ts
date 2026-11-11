// Routing traces: 45° bends, starting and ending on copper of the net, layer changes through
// vias, and airwires disappearing once routed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { anchors, bend45, traceWidth, viaDrill } from '../src/edit/route';
import { drc } from '../src/model/drc';
import { readProject, writeProject } from '../src/model/file';
import { ratsnest } from '../src/model/ratsnest';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
let unrouted: string;
beforeEach(() => {
  p = readProject(ORIGINAL);
  // Unroute N$1 so it has an airwire to route.
  delete p.nets.find((n) => n.name === 'N$1')!.traces;
  unrouted = writeProject(p);
  editor = new Editor(p, () => {});
});

const airwires = (net: string) => ratsnest(p).filter((a) => a.net === net);
/** DRC problems other than connections still to make (these tests route part of a board). */
const copperProblems = () => drc(p).violations.filter((v) => v.kind !== 'unrouted').map((v) => v.message);
const padsOf = (net: string) => anchors(p).filter((a) => a.net === net && a.kind === 'pad');
const at = (a: O.Pt) => ({ x: a[0], y: a[1] });

describe('bend45', () => {
  it('runs straight, then diagonally (or the other way round)', () => {
    expect(bend45([0, 0], [10, 4], false)).toEqual([[6, 0], [10, 4]]);
    expect(bend45([0, 0], [10, 4], true)).toEqual([[4, 4], [10, 4]]);
    expect(bend45([0, 0], [-4, -10], false)).toEqual([[0, -6], [-4, -10]]);
    expect(bend45([0, 0], [5, 5], false)).toEqual([[5, 5]]);
    expect(bend45([0, 0], [0, 7], false)).toEqual([[0, 7]]);
  });
});

describe('defaults', () => {
  it('uses the board\'s usual trace width and via drill', () => {
    expect(traceWidth(p, 'N$1')).toBe(0.254);
    expect(viaDrill(p, 'N$1')).toBe(0.35);
  });
});

describe('routing', () => {
  it('a route from pad to pad replaces the airwire, as one undo step', () => {
    expect(airwires('N$1')).toHaveLength(1);
    const [a, b] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.moveTo(at(a!.at), false, 0.5);
    expect(s.click()).toBe('started');
    expect(s.netName).toBe('N$1');
    s.moveTo(at(b!.at), false, 0.5);
    expect(s.snappedTo?.kind).toBe('pad');
    expect(s.click()).toBe('finish');
    expect(s.finish()).toMatchObject({ net: 'N$1', vias: 0 });
    expect(airwires('N$1')).toHaveLength(0);
    const traces = p.nets.find((n) => n.name === 'N$1')!.traces!;
    expect(traces.every((t) => t.width === 0.254 && t.layer === 'copper.top')).toBe(true);
    expect(editor.history.undoLabel).toBe('Route N$1');
    editor.undo();
    expect(writeProject(p)).toBe(unrouted);
  });

  it('can\'t start away from copper', () => {
    const s = editor.beginRoute(() => 1.27)!;
    s.moveTo({ x: -50, y: -50 }, false, 0.5);
    expect(s.click()).toBe('nothing');
    expect(s.netName).toBeUndefined();
  });

  it('only snaps to the routed net once started', () => {
    const [a] = padsOf('N$1');
    const other = padsOf('GND')[0]!;
    const s = editor.beginRoute(() => 0.127)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo(at(other.at), false, 0.5);
    expect(s.snappedTo).toBeUndefined();
  });

  // These two are about layers and finishing, not clearance: clicks are forced.
  it('a layer change mid-route adds a via; the route still connects', () => {
    const [a, b] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo({ x: a!.at[0], y: a!.at[1] - 2.54 }, false, 0.01);
    s.click(true);
    expect(s.switchLayer(true)).toEqual({ layer: 'copper.bottom' });
    s.moveTo({ x: b!.at[0], y: a!.at[1] - 2.54 }, false, 0.01);
    s.click(true);
    s.switchLayer(true); // back to top for the SMD pad
    s.moveTo(at(b!.at), false, 0.5);
    expect(s.click(true)).toBe('finish');
    expect(s.finish()).toMatchObject({ vias: 2 });
    const net = p.nets.find((n) => n.name === 'N$1')!;
    expect(new Set(net.traces!.map((t) => t.layer))).toEqual(new Set(['copper.top', 'copper.bottom']));
    expect(net.vias!.every((v) => v.drill === 0.35)).toBe(true);
    expect(airwires('N$1')).toHaveLength(0);
  });

  it('Esc keeps the legs drawn so far; the airwire remains until connected', () => {
    const [a] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.avoid = false;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo({ x: a!.at[0] + 5, y: a!.at[1] }, false, 0.01);
    s.click(true);
    expect(s.finish()).toMatchObject({ traces: 1 });
    expect(airwires('N$1')).toHaveLength(1);
  });
});

describe('clearance while routing', () => {
  // N$1 runs from IC1 pin 4 to C2 pin 2; C2's other pad (N$3) sits beside the straight line.
  const start = (avoid = false) => {
    const [a] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.avoid = avoid;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    return { s, a: a! };
  };

  it("a leg through another net's pad is refused; forcing places it", () => {
    const { s, a } = start();
    s.moveTo({ x: a.at[0] + 5, y: a.at[1] }, false, 0.01);
    expect(s.conflicts[0]).toMatchObject({ other: 'pad C2.1 (N$3)', message: 'Would touch pad C2.1 (N$3)' });
    expect(s.preview.paths.at(-1)!.blocked).toBe(true);
    expect(s.click()).toBe('blocked');
    expect(s.click(true)).toBe('added');
  });

  it('the direct route to its own pad is clear', () => {
    const { s } = start();
    const b = padsOf('N$1')[1]!;
    s.moveTo(at(b.at), false, 0.5);
    expect(s.conflicts).toEqual([]);
    expect(s.click()).toBe('finish');
  });

  it('too close (not touching) reports the gap against the rule', () => {
    // A GND trace parallel to the leg, centres 0.354 mm apart: a 0.1 mm gap between two
    // 0.254 mm traces, under the 6 mil (0.1524 mm) wire–wire rule.
    const [a] = padsOf('N$1');
    const y = a!.at[1] + 0.354;
    p.nets.find((n) => n.name === 'GND')!.traces!.push({ line: [[a!.at[0] - 3, y], [a!.at[0] - 0.5, y]], width: 0.254, layer: 'copper.top' });
    const { s } = start();
    s.moveTo({ x: a!.at[0] - 1.27, y: a!.at[1] }, false, 0.001);
    const c = s.conflicts.find((x) => x.other === 'wire on GND')!;
    expect(c.gap).toBeCloseTo(0.1, 6);
    expect(c.required).toBeCloseTo(0.1524, 6);
    expect(c.message).toBe('Too close to wire on GND: 0.100 mm (3.9 mil) < 0.152 mm (6.0 mil)');
  });

  it('a via where it would touch another net is refused; forcing adds it', () => {
    const { s } = start();
    const other = anchors(p).find((x) => x.pad?.part === 'C2' && x.pad.pad === '1')!;
    s.moveTo(at(other.at), false, 0.001);
    s.click(true);
    const r = s.switchLayer();
    expect(r.layer).toBe('copper.top');
    // The pad and the N$3 trace into it are both in the way.
    expect(r.blocked?.map((c) => c.other)).toContain('pad C2.1 (N$3)');
    expect(s.switchLayer(true)).toEqual({ layer: 'copper.bottom' });
  });

  it('a leg too close to the board edge is refused', () => {
    const { s, a } = start();
    s.moveTo({ x: 0.1, y: a.at[1] }, false, 0.001);
    expect(s.conflicts.some((c) => c.other === 'the board edge')).toBe(true);
  });
});

describe('routing around obstacles', () => {
  const grid = () => 1.27; // the board's 50 mil grid: the search raster is 6.25 mil
  const start = (g = grid) => {
    const [a] = padsOf('N$1');
    const s = editor.beginRoute(g)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    return { s, a: a! };
  };
  const is45 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6;
  };

  it("a blocked leg detours around the other net's pad, and the result passes the DRC", () => {
    // On a 5 mil grid, so the cursor lands at a free spot just past C2.1.
    const { s, a } = start(() => 0.127);
    s.moveTo({ x: a.at[0] + 5, y: a.at[1] }, false, 0.01);
    expect(s.detour).toBe(true);
    expect(s.conflicts).toEqual([]);
    expect(s.preview.vias).toEqual([]); // stays on one layer when it can
    const leg = s.preview.paths.at(-1)!.points;
    expect(leg[0]).toEqual(at(a.at));
    expect(leg.at(-1)).toEqual(s.at);
    // 45° segments, apart from the short stubs at the ends.
    for (let i = 2; i < leg.length - 1; i++) expect(is45(leg[i - 1]!, leg[i]!)).toBe(true);
    expect(leg.length).toBeLessThanOrEqual(8);
    expect(s.click()).toBe('added');
    s.finish();
    expect(copperProblems()).toEqual([]);
  });

  it('routes pad to pad around obstacles, connecting the net', () => {
    // Make the direct route impossible: a GND trace across the straight line between the pads.
    const [a, b] = padsOf('N$1');
    const mx = (a!.at[0] + b!.at[0]) / 2;
    p.nets.find((n) => n.name === 'GND')!.traces!.push({ line: [[mx, a!.at[1] - 1.5], [mx, b!.at[1] + 1.5]], width: 0.254, layer: 'copper.top' });
    // (That trace itself crosses an N$3 trace: the route must add nothing to the DRC's list.)
    const before = copperProblems();
    const s = editor.beginRoute(grid)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo(at(b!.at), false, 0.5);
    expect(s.detour).toBe(true);
    expect(s.click()).toBe('finish');
    s.finish();
    expect(airwires('N$1')).toHaveLength(0);
    expect(copperProblems()).toEqual(before);
  });

  it('with no way through, the direct leg stays blocked', () => {
    const { s } = start();
    const other = anchors(p).find((x) => x.pad?.part === 'C2' && x.pad.pad === '1')!;
    s.moveTo(at(other.at), false, 0.001); // the cursor on another net's pad
    expect(s.detour).toBe(false);
    expect(s.conflicts.length).toBeGreaterThan(0);
    expect(s.click()).toBe('blocked');
  });

  it('a second route on another net detours too (obstacles are per net)', () => {
    // First a detour on N$1 (its obstacle map counts C2.1, of N$3, as an obstacle) …
    const { s, a } = start(() => 0.127);
    s.moveTo({ x: a.at[0] + 5, y: a.at[1] }, false, 0.01);
    expect(s.detour).toBe(true);
    s.cancel();
    // … then a route from C2.1 itself, aimed past C2.2 (N$1): it must find its way round.
    const c21 = anchors(p).find((x) => x.pad?.part === 'C2' && x.pad.pad === '1')!;
    const c22 = anchors(p).find((x) => x.pad?.part === 'C2' && x.pad.pad === '2')!;
    s.moveTo(at(c21.at), false, 0.3);
    expect(s.click()).toBe('started');
    expect(s.netName).toBe('N$3');
    const dx = c22.at[0] - c21.at[0];
    const dy = c22.at[1] - c21.at[1];
    const len = Math.hypot(dx, dy);
    s.moveTo({ x: c22.at[0] + (dx / len) * 2.5, y: c22.at[1] + (dy / len) * 2.5 }, false, 0.001);
    expect(s.conflicts).toEqual([]);
  });

  it('is quick enough to follow the mouse', () => {
    const { s, a } = start();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) s.moveTo({ x: a.at[0] + 5 + i * 0.3, y: a.at[1] + (i % 3) * 0.6 }, false, 0.01);
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});

describe('detours through vias', () => {
  const grid = () => 1.27;
  /** GND traces on top in a closed square around a point: nothing gets in or out on top. */
  const wall = (c: O.Pt, r: number) => {
    const [x, y] = c;
    const pts: O.Pt[] = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    const gnd = p.nets.find((n) => n.name === 'GND')!;
    pts.forEach((a, i) => gnd.traces!.push({ line: [a, pts[(i + 1) % 4]!], width: 0.254, layer: 'copper.top' }));
  };

  it('goes under a wall on the other layer, through vias, and comes back up', () => {
    const [a, b] = padsOf('N$1'); // a: IC1 pin 4 (through-hole), b: C2 pin 2 (top SMD)
    wall(b!.at, 2.2);
    const before = copperProblems();
    const s = editor.beginRoute(grid)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo(at(b!.at), false, 0.5);
    expect(s.snappedTo?.pad).toEqual({ part: 'C2', pad: '2' });
    expect(s.detour).toBe(true);
    expect(s.conflicts).toEqual([]);
    const { paths, vias } = s.preview;
    expect(vias.length).toBeGreaterThanOrEqual(1);
    expect(paths.some((x) => x.layer === 'copper.bottom')).toBe(true);
    expect(paths.at(-1)!.layer).toBe('copper.top'); // back up to reach the top SMD
    expect(s.click()).toBe('finish');
    const res = s.finish()!;
    expect(res.vias).toBe(vias.length);
    expect(airwires('N$1')).toHaveLength(0);
    expect(copperProblems()).toEqual(before);
  });

  it('reaches copper only on the other layer through a via', () => {
    // C2 flipped to the bottom: its pad 2 (N$1) is a bottom SMD now.
    p.board!.footprints.find((f) => f.part === 'C2')!.side = 'bottom';
    const [a] = padsOf('N$1').filter((x) => x.pad?.part === 'IC1');
    const b = padsOf('N$1').find((x) => x.pad?.part === 'C2')!;
    expect(b.layers).toEqual(['copper.bottom']);
    const s = editor.beginRoute(grid)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    expect(s.currentLayer).toBe('copper.top');
    s.moveTo(at(b.at), false, 0.5);
    expect(s.snappedTo?.pad).toEqual({ part: 'C2', pad: '2' });
    expect(s.detour).toBe(true);
    expect(s.preview.vias.length).toBeGreaterThanOrEqual(1);
    expect(s.preview.paths.at(-1)!.layer).toBe('copper.bottom');
    expect(s.click()).toBe('finish');
    expect(s.currentLayer).toBe('copper.bottom');
    s.finish();
    expect(airwires('N$1')).toHaveLength(0);
    // Without detours the leg says why it can't end there.
    const t2 = editor.beginRoute(grid)!;
    t2.avoid = false;
    t2.moveTo(at(a!.at), false, 0.5);
    t2.click();
    t2.moveTo(at(b.at), false, 0.5);
    expect(t2.conflicts[0]?.message).toBe('Pad C2.2 is on bottom: change layer (L)');
    expect(t2.click()).toBe('blocked');
  });
});

describe('the routing layer', () => {
  it('starts on the layer given (the remembered one), else on top', () => {
    expect(editor.beginRoute(() => 1.27)!.currentLayer).toBe('copper.top');
    expect(editor.beginRoute(() => 1.27, 'copper.bottom')!.currentLayer).toBe('copper.bottom');
    expect(editor.beginRoute(() => 1.27, 'copper.inner5')!.currentLayer).toBe('copper.top'); // not on this board
  });

  it('switches to a named layer; to the same layer is no change (and no via)', () => {
    const [a] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo({ x: a!.at[0], y: a!.at[1] - 2.54 }, false, 0.01);
    s.click(true);
    expect(s.switchLayer(false, 'copper.top')).toEqual({ layer: 'copper.top' });
    expect(s.preview.vias).toEqual([]);
    expect(s.switchLayer(true, 'copper.bottom')).toEqual({ layer: 'copper.bottom' }); // forced: no room for a via there
    expect(s.preview.vias).toHaveLength(1);
  });
});
