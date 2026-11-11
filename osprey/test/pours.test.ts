// Drawing pours and changing their net and properties.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor, type PourSession } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { edgeMiddle, withCornerAdded, withCornerMoved, withCornerRemoved } from '../src/edit/pours';
import { anchors } from '../src/edit/route';
import { arcFromChord, arcPoints } from '../src/geom/arc';
import { drc } from '../src/model/drc';
import { exportEagle } from '../src/model/export-eagle';
import { readProject, writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';
import { pourFills } from '../src/model/pour';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
});

const net = (name: string) => p.nets.find((n) => n.name === name);
const grid = () => 1.27;
/** Click through corners (world mm) with a session. */
const draw = (s: PourSession, corners: [number, number][]) => {
  for (const [x, y] of corners) {
    s.moveTo({ x, y }, false, 0.3);
    s.click();
  }
};

describe('drawing a pour', () => {
  it('a square on GND (the default net), closed by clicking the first corner; one undo step', () => {
    const s = editor.beginPour(grid)!;
    expect(s.net).toBe('GND');
    expect(s.layer).toBe('copper.top');
    draw(s, [[2.54, 2.54], [12.7, 2.54], [12.7, 10.16], [2.54, 10.16]]);
    s.moveTo({ x: 2.6, y: 2.5 }, false, 0.3);
    expect(s.closing).toBe(true);
    expect(s.click()).toBe('close');
    const res = s.finish()!;
    expect(res.net).toBe('GND');
    expect(res.pour).toMatchObject({ polygon: [[2.54, 2.54], [12.7, 2.54], [12.7, 10.16], [2.54, 10.16]], layer: 'copper.top', width: 0.254 });
    expect(net('GND')!.pours).toContain(res.pour);
    expect(editor.history.undoLabel).toBe('Add pour on GND');
    // Nothing of GND on top in that square: its island is an orphan, and is dropped.
    expect(pourFills(p).get(res.pour)?.islands).toEqual([]);
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it("pours around the net's own pad, with the board staying clean at a lower rank", () => {
    const gnd = anchors(p).find((a) => a.net === 'GND' && a.kind === 'pad' && a.layers.includes('copper.top'))!;
    const [x, y] = gnd.at;
    const s = editor.beginPour(grid)!;
    draw(s, [[x - 2.54, y - 2.54], [x + 2.54, y - 2.54], [x + 2.54, y + 2.54], [x - 2.54, y + 2.54]]);
    const { pour } = s.finish()!;
    expect(pourFills(p).get(pour)!.islands.length).toBeGreaterThan(0);
    // Same rank as the VCC pour on top: they overlap, and the DRC says so; rank 2 yields.
    expect(drc(p).violations.some((v) => v.kind === 'overlap')).toBe(true);
    editor.setPour(pour, { rank: 2 }, 'Rank');
    expect(drc(p).violations).toEqual([]);
  });

  it('the first click on copper picks its net', () => {
    const vcc = anchors(p).find((a) => a.net === 'VCC' && a.kind === 'pad')!;
    const s = editor.beginPour(grid)!;
    s.moveTo({ x: vcc.at[0] + 0.1, y: vcc.at[1] }, false, 0.5);
    expect(s.over?.net).toBe('VCC');
    s.click();
    expect(s.net).toBe('VCC');
  });

  it('edges run at 45° unless free angles are on', () => {
    const s = editor.beginPour(grid)!;
    draw(s, [[0, 0]]);
    s.moveTo({ x: 6.35, y: 2.54 }, false, 0.1);
    expect(s.path.map((q) => [q.x, q.y])).toEqual([[0, 0], [3.81, 0], [6.35, 2.54], [0, 0]]);
    s.freeAngle = true;
    s.moveTo({ x: 6.35, y: 2.54 }, false, 0.1);
    expect(s.path.map((q) => [q.x, q.y])).toEqual([[0, 0], [6.35, 2.54], [0, 0]]);
  });

  it('an outline with less than three corners adds nothing', () => {
    const s = editor.beginPour(grid)!;
    draw(s, [[0, 0], [5.08, 0]]);
    expect(s.finish()).toBeUndefined();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('starts on the layer given (the remembered one), and switches to a named layer', () => {
    const s = editor.beginPour(grid, undefined, 'copper.bottom')!;
    expect(s.layer).toBe('copper.bottom');
    expect(s.switchLayer('copper.top')).toBe('copper.top');
    expect(s.switchLayer('copper.inner9')).toBe('copper.bottom'); // not a layer here: the other one
  });

  it('switching layer pours on the bottom', () => {
    const s = editor.beginPour(grid)!;
    expect(s.switchLayer()).toBe('copper.bottom');
    draw(s, [[2.54, 2.54], [7.62, 2.54], [7.62, 7.62]]);
    expect(s.finish()!.pour.layer).toBe('copper.bottom');
  });

  it('survives an Eagle round trip', () => {
    const s = editor.beginPour(grid)!;
    draw(s, [[2.54, 2.54], [12.7, 2.54], [12.7, 10.16], [2.54, 10.16]]);
    const { pour } = s.finish()!;
    const back = importEagle([...exportEagle(p).files].map(([n, text]) => ({ name: n, file: parseEagle(text) })), '2026-11-09').project;
    const gnd = back.nets.find((n) => n.name === 'GND')!;
    expect(gnd.pours!.some((q) => q.layer === 'copper.top' && JSON.stringify(q.polygon) === JSON.stringify(pour.polygon))).toBe(true);
  });
});

describe('changing a pour', () => {
  const pourOf = (name: string) => net(name)!.pours![0]!;

  it('moves to another net (an emptied net disappears; a new name makes a net)', () => {
    const s = editor.beginPour(grid)!;
    s.net = 'POUR1';
    draw(s, [[2.54, 2.54], [7.62, 2.54], [7.62, 7.62]]);
    const { pour } = s.finish()!;
    expect(net('POUR1')!.pours).toEqual([pour]);
    expect(editor.setPourNet(pour, 'VCC')).toBeUndefined();
    expect(net('POUR1')).toBeUndefined();
    expect(net('VCC')!.pours).toContain(pour);
    expect(editor.setPourNet(pour, 'NEW NET')).toBe('Net names have no spaces');
    expect(editor.setPourNet(pour, 'SHIELD')).toBeUndefined();
    expect(net('SHIELD')!.pours).toEqual([pour]);
    editor.undo();
    editor.undo();
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('checks and sets properties; defaults are left out of the file', () => {
    const pour = pourOf('GND');
    expect(editor.setPour(pour, { width: 0 }, 'Width')).toBe('The width must be more than 0');
    expect(editor.setPour(pour, { rank: 7 }, 'Rank')).toBe('The rank is a whole number from 1 to 6');
    expect(editor.setPour(pour, { width: 0.4, isolate: 0.5, rank: 2, thermals: false, orphans: true, hatch: true }, 'Pour settings')).toBeUndefined();
    expect(pour).toMatchObject({ width: 0.4, isolate: 0.5, rank: 2, thermals: false, orphans: true, pour: 'hatch' });
    editor.setPour(pour, { isolate: undefined, rank: 1, thermals: true, orphans: false, hatch: false }, 'Pour settings');
    for (const k of ['isolate', 'rank', 'thermals', 'orphans', 'pour'] as const) expect(k in pour).toBe(false);
    editor.undo();
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('changing the layer re-pours on the other side', () => {
    const pour = pourOf('VCC');
    editor.setPour(pour, { layer: 'copper.bottom' }, 'Layer');
    expect(pourFills(p).get(pour)!.layer).toBe('copper.bottom');
  });
});

describe('editing a pour outline', () => {
  it('moves a corner to a typed point (off the grid), one undo step', () => {
    const pour = net('GND')!.pours![0]!;
    const before = writeProject(p);
    expect(editor.movePourCorner(pour, 2, [36.5, 36.123])).toBeUndefined();
    expect(pour.polygon[2]!.slice(0, 2)).toEqual([36.5, 36.123]);
    expect(editor.history.undoLabel).toBe('Move pour corner');
    expect(editor.movePourCorner(pour, 99, [0, 0])).toBe('No such corner');
    editor.undo();
    expect(writeProject(p)).toBe(before);
  });

  const square: O.PolyPt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('moves, adds and removes corners (curved edges keep their curve)', () => {
    expect(withCornerMoved(square, 2, [12, 12])).toEqual([[0, 0], [10, 0], [12, 12], [0, 10]]);
    expect(withCornerMoved([[0, 0, 90], [10, 0], [10, 10]], 0, [1, 1])).toEqual([[1, 1, 90], [10, 0], [10, 10]]);
    expect(withCornerAdded(square, 1, [11, 5])).toEqual([[0, 0], [10, 0], [11, 5], [10, 10], [0, 10]]);
    expect(withCornerAdded([[0, 0, 90], [10, 0], [10, 10]], 0, [5, -5])).toEqual([[0, 0, 45], [5, -5, 45], [10, 0], [10, 10]]);
    expect(withCornerRemoved(square, 0)).toEqual([[10, 0], [10, 10], [0, 10]]);
    expect(withCornerRemoved([[0, 0], [1, 0], [0, 1]], 0)).toBeUndefined();
  });

  it("an edge's middle is on its arc when it is curved", () => {
    expect(edgeMiddle(square, 0)).toEqual([5, 0]);
    const curved: O.PolyPt[] = [[0, 0, 90], [10, 0], [10, 10]];
    const arc = arcFromChord({ x: 0, y: 0 }, { x: 10, y: 0 }, 90);
    const mid = arcPoints(arc, 2)[1]!;
    const [x, y] = edgeMiddle(curved, 0);
    expect(x).toBeCloseTo(mid.x, 9);
    expect(y).toBeCloseTo(mid.y, 9);
  });

  it('dragging a corner previews live and commits as one undo step; a click without moving changes nothing', () => {
    const pour = net('VCC')!.pours![0]!;
    const before = pour.polygon;
    const d = editor.dragCorner(pour, 2, false, grid);
    d.moveTo({ x: 30.1, y: 30.2 }, false);
    expect(pour.polygon[2]).toEqual([30.48, 30.48]); // snapped, already in the model
    d.moveTo({ x: 25.4, y: 30.2 }, false);
    expect(d.commit()).toBe(true);
    expect(pour.polygon[2]).toEqual([25.4, 30.48]);
    expect(editor.history.undoLabel).toBe('Move pour corner');
    editor.undo();
    expect(pour.polygon).toEqual(before);
    expect(editor.dragCorner(pour, 2, false, grid).commit()).toBe(false);
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('dragging an edge middle adds a corner; Del removes it again', () => {
    const pour = net('VCC')!.pours![0]!;
    const n = pour.polygon.length;
    const d = editor.dragCorner(pour, 0, true, grid);
    d.moveTo({ x: -2.54, y: 15.24 }, false);
    d.commit();
    expect(pour.polygon).toHaveLength(n + 1);
    expect(d.corner).toBe(1);
    expect(pour.polygon[1]).toEqual([-2.54, 15.24]);
    expect(editor.history.undoLabel).toBe('Add pour corner');
    expect(editor.removePourCorner(pour, 1)).toBeUndefined();
    expect(pour.polygon).toHaveLength(n);
    expect(editor.history.undoLabel).toBe('Delete pour corner');
  });
});

describe('the board outline', () => {
  /** The extent of all poured copper. */
  const extent = () => {
    const pts = [...pourFills(p).values()].flatMap((f) => f.islands.flatMap((i) => i.outer));
    return { minX: Math.min(...pts.map((q) => q[0])), minY: Math.min(...pts.map((q) => q[1])), maxX: Math.max(...pts.map((q) => q[0])), maxY: Math.max(...pts.map((q) => q[1])) };
  };
  const outline = () => p.board!.drawing.filter((g): g is O.Graphic & { line: [O.Pt, O.Pt] } => 'line' in g && g.layer === 'outline');

  it('a corner a hair open still keeps pours inside the edge; the DRC reports the gap', () => {
    // A pour over the whole board and beyond: only the outline limits it.
    const xs = outline().flatMap((g) => g.line.map((q) => q[0]));
    const ys = outline().flatMap((g) => g.line.map((q) => q[1]));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    net('GND')!.pours = [{ polygon: [[x0 - 5, y0 - 5], [x1 + 5, y0 - 5], [x1 + 5, y1 + 5], [x0 - 5, y1 + 5]], width: 0.254, layer: 'copper.bottom' }];
    const closed = extent();
    expect(closed.minX).toBeGreaterThan(x0);
    expect(closed.maxY).toBeLessThan(y1);
    expect(drc(p).violations.some((v) => v.message.startsWith('Board outline is open'))).toBe(false);

    const g = outline()[0]!;
    g.line = [[g.line[0][0] + 0.01, g.line[0][1]], g.line[1]];
    for (const [k, v] of Object.entries(extent())) expect(v).toBeCloseTo(closed[k as keyof typeof closed], 2);
    const open = drc(p).violations.filter((v) => v.message.startsWith('Board outline is open'));
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe('dimension');
    expect(open[0]!.actual).toBeCloseTo(0.01, 6);
  });
});
