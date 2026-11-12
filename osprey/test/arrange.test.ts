// Arranging parts by relation: beside a part or pad, rows, board edges, groups, best rotation.

import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import type { Arrange } from '../src/edit/arrange';
import { readProject } from '../src/model/file';
import { footprintInfo, placementIssues, placementMetrics, rectCenter } from '../src/model/placement';
import type * as O from '../src/model/types';
import { unroutedSample } from './unrouted';

// Unrouted: placement is measured by airwires.
const SAMPLE = unroutedSample('wwvbfind');

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(SAMPLE);
  editor = new Editor(p, () => {});
  editor.legalize(); // start from a legal placement
});

const fp = (part: string) => p.board!.footprints.find((f) => f.part === part)!;
const box = (part: string) => footprintInfo(p, part)!.box;
const pad = (part: string, name: string) => footprintInfo(p, part)!.pads.find((q) => q.name === name)!;
const run = <T>(f: (a: Arrange) => T) => editor.arrange('test', f);
const score = () => {
  const m = placementMetrics(p);
  return m.signalLength + 3 * m.signalCrossings;
};

describe('beside a pad or part', () => {
  it('puts a decoupling cap right by the IC pin it serves, its own pad lined up', () => {
    run((a) => a.moveTo('C8', [20, 4])); // far from U1
    const before = placementMetrics(p).decoupling.find((d) => d.part === 'C8')!.distance;
    run((a) => a.near('C8', 'U1.1', { pad: '1' }));
    // U1 pin 1 (VDD) is on its top edge, so C8 goes above, pad 1 straight above pin 1.
    expect(box('C8').minY).toBeGreaterThanOrEqual(box('U1').maxY + 0.15 - 1e-6);
    expect(pad('C8', '1').at.x).toBeCloseTo(pad('U1', '1').at.x, 2);
    const after = placementMetrics(p).decoupling.find((d) => d.part === 'C8')!.distance;
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(2);
    expect(placementIssues(p)).toEqual([]);
  });

  it('beside a whole part needs a side, and a failed arrangement changes nothing', () => {
    const at = [...fp('C8').at];
    expect(() => run((a) => {
      a.moveTo('C8', [10, 10]);
      a.near('C8', 'U1');
    })).toThrow(/give a side/);
    expect(fp('C8').at).toEqual(at);
  });

  it('slides along to the nearest free spot when the spot is taken', () => {
    // Left of U1 is the bias network; R14 has to find room.
    run((a) => a.near('R14', 'U1', { side: 'left' }));
    expect(placementIssues(p)).toEqual([]);
    expect(box('R14').maxX).toBeLessThanOrEqual(box('U1').minX);
  });

  it('can choose the rotation once there', () => {
    fp('Q1').rot = 0; // backwards: gate away from the antenna
    const res = run((a) => a.near('Q1', 'IN', { side: 'right', gap: 2, rot: 'best' }));
    expect(res.rot).toBe(180);
  });
});

describe('rows, edges and groups', () => {
  it('lays parts out in a row, outlines a clearance apart', () => {
    run((a) => a.row(['R5', 'R6', 'C3'], { x: 20, y: 6 }, { dir: 'right', gap: 0.5, rot: 0 }));
    const [b1, b2, b3] = ['R5', 'R6', 'C3'].map(box) as [ReturnType<typeof box>, ReturnType<typeof box>, ReturnType<typeof box>];
    expect(b2.minX - b1.maxX).toBeCloseTo(0.5, 2);
    expect(b3.minX - b2.maxX).toBeCloseTo(0.5, 2);
    expect(rectCenter(b1).y).toBeCloseTo(6, 2);
    expect(rectCenter(b3).y).toBeCloseTo(6, 2);
    expect(rectCenter(b1).x).toBeCloseTo(20, 2);
  });

  it('puts a connector against an edge, lying along it', () => {
    fp('IN').rot = 90; // standing up
    run((a) => a.edge('IN', 'bottom', 20));
    const b = box('IN');
    expect(b.minY).toBeCloseTo(0.5, 2);
    expect(rectCenter(b).x).toBeCloseTo(20, 2);
    expect(b.maxX - b.minX).toBeGreaterThan(b.maxY - b.minY);
  });

  it('moves a group together, keeping its arrangement', () => {
    const parts = ['U2', 'X1', 'R11', 'R12', 'C9', 'C10', 'C11'];
    const rel = () => parts.map((q) => [fp(q).at[0] - fp('U2').at[0], fp(q).at[1] - fp('U2').at[1]]);
    const before = rel();
    run((a) => a.moveGroup(parts, { x: 30, y: 10 }));
    const after = rel();
    after.forEach((v, i) => {
      expect(v[0]).toBeCloseTo(before[i]![0]!, 6);
      expect(v[1]).toBeCloseTo(before[i]![1]!, 6);
    });
    const c = run((a) => rectCenter(a.box(parts)));
    expect(c.x).toBeCloseTo(30, 2);
    expect(c.y).toBeCloseTo(10, 2);
  });
});

describe('rotation', () => {
  it('turns a part to the rotation with the shortest, least crossed airwires', () => {
    fp('Q1').rot = 0; // gate away from the antenna
    const before = score();
    const rot = run((a) => a.bestRotation('Q1'));
    expect(rot).not.toBe(0);
    expect(score()).toBeLessThan(before);
  });

  it('orienting every part never makes the placement worse or adds conflicts', () => {
    const before = score();
    run((a) => a.orient());
    expect(score()).toBeLessThanOrEqual(before + 1e-6);
    expect(placementIssues(p)).toEqual([]);
  });

  it('one undo step undoes a whole arrangement', () => {
    const before = p.board!.footprints.map((f) => [f.part, [...f.at], f.rot]);
    run((a) => {
      a.near('C8', 'U1.1');
      a.orient(['Q1', 'Q2', 'D1']);
      a.edge('VOUT', 'bottom', 38);
    });
    editor.undo();
    expect(p.board!.footprints.map((f) => [f.part, [...f.at], f.rot])).toEqual(before);
  });

  it('locked parts stay put', () => {
    fp('U1').locked = true;
    expect(() => run((a) => a.moveTo('U1', [10, 10]))).toThrow(/locked/);
    expect(run((a) => a.bestRotation('U1'))).toBe(270);
  });
});
