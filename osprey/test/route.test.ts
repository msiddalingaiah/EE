// Routing traces: 45° bends, starting and ending on copper of the net, layer changes through
// vias, and airwires disappearing once routed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { anchors, bend45, traceWidth, viaDrill } from '../src/edit/route';
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
  const start = () => {
    const [a] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
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
