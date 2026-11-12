// Placement geometry, checks and measures, and spreading parts apart (on the wwvbfind sample).

import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { ratsnest } from '../src/model/ratsnest';
import { readProject } from '../src/model/file';
import { footprintInfo, footprintInfos, placementIssues, placementMetrics, rectHeight, rectWidth } from '../src/model/placement';
import type * as O from '../src/model/types';
import { unroutedSample } from './unrouted';

// Unrouted: placement is measured by airwires.
const SAMPLE = unroutedSample('wwvbfind');

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(SAMPLE);
  editor = new Editor(p, () => {});
});

const fp = (part: string) => p.board!.footprints.find((f) => f.part === part)!;
/** The board's right edge (x of the outline's rightmost point). */
const right = () => Math.max(...p.board!.drawing.flatMap((g) => ('line' in g && g.layer === 'outline' ? g.line.map((q) => q[0]) : [])));
const kinds = () => placementIssues(p).map((i) => (i.kind === 'overlap' ? `${i.parts.join('/')}` : `${i.kind} ${i.part}`)).sort();

describe('footprint geometry', () => {
  it('covers the body as drawn, not just the pads (the HC49/S crystal)', () => {
    const x1 = footprintInfo(p, 'X1')!;
    // Standing upright (rotated 270): the can is 5.08 mm wide and 11.43 mm long.
    expect(rectWidth(x1.box)).toBeCloseTo(5.08, 2);
    expect(rectHeight(x1.box)).toBeCloseTo(11.43, 2);
    const pads = x1.pads.map((q) => rectHeight(q.box));
    expect(Math.max(...pads)).toBeLessThan(2);
  });

  it('can say where a part would be, at another rotation, without moving it', () => {
    const lying = footprintInfo(p, 'X1', { rot: 0 })!;
    expect(rectWidth(lying.box)).toBeCloseTo(11.43, 2);
    expect(fp('X1').rot).toBe(270);
  });

  it('gives each pad its net, and marks power pins', () => {
    const u1 = footprintInfo(p, 'U1')!;
    const pad = (n: string) => u1.pads.find((q) => q.name === n)!;
    expect(pad('1')).toMatchObject({ net: 'VCC', power: true });
    expect(pad('8')).toMatchObject({ net: 'GND', power: true });
    expect(pad('3')).toMatchObject({ net: 'ADC' });
    expect(pad('3').power).toBeUndefined();
    expect(pad('5').net).toBeUndefined();
  });
});

describe('placement checks and measures', () => {
  it('finds a crystal pushed into its neighbours', () => {
    // The hand layout's tightest gaps (0.16 mm, beside SMD parts) are within the SMD spacing.
    expect(kinds()).toEqual([]);
    fp('X1').at = [fp('X1').at[0] - 2, fp('X1').at[1]];
    const issues = placementIssues(p);
    expect(issues.length).toBeGreaterThan(1);
    for (const i of issues) expect(i.kind === 'overlap' ? i.parts : [i.part]).toContain('X1');
  });

  it('a part sticking out over the board edge is a problem, not a part parked beside the board', () => {
    fp('C9').at = [right() + 0.2, 20];
    expect(kinds()).toContain('edge C9');
    fp('C9').at = [right() + 13, 20]; // wholly off the board: parked
    expect(kinds()).not.toContain('edge C9');
  });

  it('finds parts on a hole or over the edge', () => {
    fp('C1').at = [2.54, 2.54];
    fp('R1').at = [right() - 0.2, 15];
    expect(kinds()).toEqual(expect.arrayContaining(['hole C1', 'edge R1']));
  });

  it('measures airwires, crossings and decoupling', () => {
    const m = placementMetrics(p);
    expect(m.airwires).toBe(ratsnest(p).length);
    expect(m.length).toBeGreaterThan(100);
    expect(m.crossings).toBeGreaterThan(0);
    const byPart = new Map(m.decoupling.map((d) => [d.part, d]));
    // U1's and U2's decoupling caps, and the bulk cap by the power connector; not the crystal's
    // load caps or the front end's VCCA filter cap (no power pins on those nets).
    expect([...byPart.keys()].sort()).toEqual(['C1', 'C11', 'C8']);
    expect(byPart.get('C8')).toMatchObject({ ic: 'U1', pad: '1', net: 'VCC' });
    expect(byPart.get('C8')!.distance).toBeLessThan(4);
    expect(byPart.get('C11')).toMatchObject({ ic: 'U2', net: 'VCC' });
  });
});

/** Crowd the board: the crystal into its neighbours, the bulk cap into the power connector. */
const crowd = () => {
  fp('X1').at = [fp('X1').at[0] - 0.6, fp('X1').at[1]];
  fp('C1').at = [fp('C1').at[0] - 0.5, fp('C1').at[1]];
};

describe('spreading parts apart', () => {
  it('clears every conflict with small moves, as one undo step', () => {
    crowd();
    expect(placementIssues(p).length).toBeGreaterThan(1);
    const before = new Map(p.board!.footprints.map((f) => [f.part, [...f.at]]));
    const air = ratsnest(p).length;
    const res = editor.legalize();
    expect(res.issues).toEqual([]);
    expect(placementIssues(p)).toEqual([]);
    expect(res.moved.length).toBeGreaterThan(0);
    for (const m of res.moved) expect(Math.hypot(m.dx, m.dy)).toBeLessThan(1);
    expect(ratsnest(p).length).toBe(air);
    editor.undo();
    expect(new Map(p.board!.footprints.map((f) => [f.part, [...f.at]]))).toEqual(before);
  });

  it('leaves locked parts, and parts not listed, where they are', () => {
    crowd();
    fp('X1').locked = true;
    const x1 = [...fp('X1').at];
    const c1 = [...fp('C1').at];
    editor.legalize(p.board!.footprints.map((f) => f.part).filter((q) => !['C1', 'VCC'].includes(q)));
    expect(fp('X1').at).toEqual(x1);
    expect(fp('C1').at).toEqual(c1);
    expect(kinds()).toEqual(['VCC/C1']);
  });

  it('pulls apart two parts dropped on each other, and brings a part back inside the board', () => {
    fp('R1').at = [...fp('R2').at];
    fp('R14').at = [right() - 0.4, 20];
    editor.legalize();
    expect(placementIssues(p)).toEqual([]);
    expect(footprintInfo(p, 'R14')!.box.maxX).toBeLessThanOrEqual(right() - 0.5 + 1e-6);
  });

  it('moves traces with the parts', () => {
    // A trace from C10's pad: after the spread it still starts on the pad.
    const c10 = footprintInfo(p, 'C10')!;
    const pad = c10.pads.find((q) => q.net)!;
    const net = p.nets.find((n) => n.name === pad.net)!;
    const trace: O.Trace = { line: [[pad.at.x, pad.at.y], [pad.at.x - 3, pad.at.y]], width: 0.254, layer: 'copper.top' };
    (net.traces ??= []).push(trace);
    editor.legalize();
    const now = footprintInfo(p, 'C10')!.pads.find((q) => q.name === pad.name)!;
    expect(trace.line[0][0]).toBeCloseTo(now.at.x, 6);
    expect(trace.line[0][1]).toBeCloseTo(now.at.y, 6);
  });

  it('every footprint on the board is checked', () => {
    expect(footprintInfos(p).length).toBe(p.board!.footprints.length);
  });
});
