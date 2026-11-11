// Local improvement of a placement (Arrange.improve), on the wwvbfind sample.

import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject } from '../src/model/file';
import { placementIssues, placementMetrics } from '../src/model/placement';
import type * as O from '../src/model/types';
import { unroutedSample } from './unrouted';

// Unrouted: placement is measured by airwires.
const SAMPLE = unroutedSample('wwvbfind');
const CONNECTORS = ['VCC', 'IN', 'VOUT', 'UPDI'];

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(SAMPLE);
  editor = new Editor(p, () => {});
});

const fp = (part: string) => p.board!.footprints.find((f) => f.part === part)!;
const where = () => new Map(p.board!.footprints.map((f) => [f.part, [f.at[0], f.at[1], f.rot ?? 0]]));
const decoupling = (part: string) => placementMetrics(p).decoupling.find((d) => d.part === part)!;

describe('improving a placement', () => {
  it('shortens and untangles the signal airwires, keeping the placement legal', () => {
    const before = placementMetrics(p);
    const res = editor.arrange('Improve', (a) => a.improve({ fixed: CONNECTORS }));
    const after = placementMetrics(p);
    expect(res.after).toBeLessThan(res.before);
    expect(after.signalLength).toBeLessThan(before.signalLength);
    expect(after.signalCrossings).toBeLessThanOrEqual(before.signalCrossings);
    expect(placementIssues(p)).toEqual([]);
    expect(res.changed.length).toBeGreaterThan(0);
  });

  it('leaves fixed and locked parts where they are; one undo step undoes it all', () => {
    fp('U1').locked = true;
    const before = where();
    editor.arrange('Improve', (a) => a.improve({ fixed: CONNECTORS }));
    for (const part of [...CONNECTORS, 'U1']) expect(where().get(part)).toEqual(before.get(part));
    editor.undo();
    expect(where()).toEqual(before);
  });

  it('swaps like parts that are in each other\'s places', () => {
    // R1 (the JFET's gate resistor, by the antenna input) and R12 (the oscillator's series
    // resistor, by X1): put each where the other belongs; only a swap can put them back.
    const home = where();
    const [a, b] = [fp('R1'), fp('R12')];
    [a.at, b.at] = [b.at, a.at];
    [a.rot, b.rot] = [b.rot, a.rot];
    for (const f of [a, b]) if (f.rot === undefined) delete f.rot;
    editor.arrange('Improve', (x) => x.improve({ parts: ['R1', 'R12'], move: false, rotate: false }));
    const near = (part: string) => where().get(part)!.map((v, i) => expect(v).toBeCloseTo(home.get(part)![i]!, 1));
    near('R1');
    near('R12');
  });

  it('brings a stray decoupling cap back to its IC', () => {
    const issues = placementIssues(p); // the sample's own tight spots
    editor.arrange('Move', (a) => a.moveTo('C11', [20, 4]));
    expect(decoupling('C11').distance).toBeGreaterThan(10);
    editor.arrange('Improve', (a) => a.improve({ parts: ['C11'], maxStep: 3 }));
    expect(decoupling('C11').distance).toBeLessThan(3);
    expect(placementIssues(p)).toEqual(issues);
  });

  it('gives the same result every time', () => {
    editor.arrange('Improve', (a) => a.improve({ fixed: CONNECTORS }));
    const once = where();
    const q = readProject(SAMPLE);
    new Editor(q, () => {}).arrange('Improve', (a) => a.improve({ fixed: CONNECTORS }));
    expect(new Map(q.board!.footprints.map((f) => [f.part, [f.at[0], f.at[1], f.rot ?? 0]]))).toEqual(once);
  });
});
