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

  it('a layer change mid-route adds a via; the route still connects', () => {
    const [a, b] = padsOf('N$1');
    const s = editor.beginRoute(() => 0.127)!;
    s.moveTo(at(a!.at), false, 0.5);
    s.click();
    s.moveTo({ x: a!.at[0], y: a!.at[1] - 2.54 }, false, 0.01);
    s.click();
    expect(s.switchLayer()).toBe('copper.bottom');
    s.moveTo({ x: b!.at[0], y: a!.at[1] - 2.54 }, false, 0.01);
    s.click();
    s.switchLayer(); // back to top for the SMD pad
    s.moveTo(at(b!.at), false, 0.5);
    expect(s.click()).toBe('finish');
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
    s.click();
    expect(s.finish()).toMatchObject({ traces: 1 });
    expect(airwires('N$1')).toHaveLength(1);
  });
});
