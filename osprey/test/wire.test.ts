// Drawing schematic wires: connecting pins, joining nets (and naming the result), junctions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { Transaction } from '../src/edit/ops';
import { addWire, cleanPath, sheetPins } from '../src/edit/wire';
import { netPads } from '../src/model/derive';
import { exportEagle } from '../src/model/export-eagle';
import { readProject, writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
let sheet: O.Sheet;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
  sheet = p.schematic!.sheets[0]!;
});

const pinAt = (part: string, pin: string): O.Pt => {
  const found = sheetPins(p, sheet).find((x) => x.ref.part === part && x.ref.pin === pin);
  if (!found) throw new Error(`no pin ${part}.${pin}`);
  return found.at;
};
const net = (name: string) => p.nets.find((n) => n.name === name);
const wire = (path: O.Pt[], name?: string) => {
  const tx = new Transaction('Wire');
  const res = addWire(p, sheet, path, tx, name ? { name } : {});
  editor.history.push(tx);
  return res;
};
/** Add a part of a component somewhere empty and return its name. */
const addPart = (component: string, variant: string, at: O.Pt): string => {
  const s = editor.beginPlace(p.library, component, variant, '', 0, () => 1.27)!;
  s.moveTo({ x: at[0], y: at[1] }, false);
  const name = s.click()!;
  s.cancel();
  return name;
};

describe('cleanPath', () => {
  it('drops repeated points and corners that go straight on', () => {
    expect(cleanPath([[0, 0], [0, 0], [1, 0], [2, 0], [2, 1]])).toEqual([[0, 0], [2, 0], [2, 1]]);
    expect(cleanPath([[0, 0], [2, 0], [1, 0]])).toEqual([[0, 0], [2, 0], [1, 0]]); // doubles back: kept
  });
});

describe('wiring pins', () => {
  it('a wire between two unconnected pins makes a new net', () => {
    const a = addPart('madhu/CAPACITOR-NP', '0805', [10, 150]);
    const b = addPart('madhu/CAPACITOR-NP', '0805', [30, 150]);
    const before = p.nets.length;
    const res = wire([pinAt(a, '2'), pinAt(b, '1')]);
    expect(res).toEqual({ net: 'N$21', joined: [] });
    expect(p.nets).toHaveLength(before + 1);
    const seg = net('N$21')!.segments![0]!;
    expect(seg.pins).toEqual([{ part: a, gate: 'A', pin: '2' }, { part: b, gate: 'A', pin: '1' }]);
    // The board now has an airwire's worth of connection between the two pads.
    expect(netPads(p).get('N$21')?.size).toBe(2);
  });

  it('a wire from a free pin to a wired pin joins that net', () => {
    const a = addPart('madhu/CAPACITOR-NP', '0805', [10, 150]);
    const res = wire([pinAt(a, '1'), [pinAt(a, '1')[0], 120], pinAt('C2', '2')]);
    expect(res).toEqual({ net: 'N$1', joined: [] });
    const segs = net('N$1')!.segments!;
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pins).toContainEqual({ part: a, gate: 'A', pin: '1' });
    editor.undo();
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('a supply symbol names the net it is wired to', () => {
    const gnd = addPart('supply2/GND', '', [10, 150]);
    const a = addPart('madhu/CAPACITOR-NP', '0805', [30, 150]);
    expect(wire([pinAt(gnd, 'GND'), pinAt(a, '1')])).toEqual({ net: 'GND', joined: [] });
    expect(net('GND')!.segments!.some((s) => s.pins.some((r) => r.part === a))).toBe(true);
  });
});

describe('joining nets', () => {
  it('two automatic nets: the lower number survives and takes the other net\'s traces', () => {
    const traces = net('N$1')!.traces!.length + net('N$2')!.traces!.length;
    const pads = new Set([...netPads(p).get('N$1')!, ...netPads(p).get('N$2')!]);
    const res = wire([pinAt('C2', '2'), pinAt('C4', '2')]);
    expect(res).toEqual({ net: 'N$1', joined: ['N$2'] });
    expect(net('N$2')).toBeUndefined();
    expect(net('N$1')!.traces).toHaveLength(traces);
    expect(net('N$1')!.segments).toHaveLength(1); // both segments on the sheet merged into one
    expect(netPads(p).get('N$1')).toEqual(pads);
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('a user-named net wins over an automatic one', () => {
    expect(wire([pinAt('IC1', 'MIX-OUT'), pinAt('C2', '2')])).toEqual({ net: 'MIX-OUT', joined: ['N$1'] });
  });

  it('a supply net wins over a user-named one', () => {
    expect(wire([pinAt('L4', 'A'), pinAt('C5', '2')])).toEqual({ net: 'GND', joined: ['VCC1'] });
  });

  it('equally strong names must be chosen; nothing changes until then', () => {
    const res = wire([pinAt('IC1', 'MIX-OUT'), pinAt('L4', 'A')]);
    expect(res).toEqual({ choose: ['MIX-OUT', 'VCC1'] });
    expect(writeProject(p)).toBe(ORIGINAL);
    expect(wire([pinAt('IC1', 'MIX-OUT'), pinAt('L4', 'A')], 'VCC1')).toEqual({ net: 'VCC1', joined: ['MIX-OUT'] });
    expect(net('MIX-OUT')).toBeUndefined();
  });

  it('joined nets survive an Eagle round trip', () => {
    wire([pinAt('C2', '2'), pinAt('C4', '2')]);
    const files = exportEagle(p).files;
    const back = importEagle([...files].map(([n, text]) => ({ name: n, file: parseEagle(text) })), p.project.imported!.date).project;
    expect(back.nets.map((n) => n.name)).not.toContain('N$2');
    expect(netPads(back).get('N$1')).toEqual(netPads(p).get('N$1'));
  });
});

describe('junctions', () => {
  it('a wire ending on the middle of another wire adds a junction', () => {
    const seg = net('N$3')!.segments![0]!;
    const w = seg.wires.find((x) => x.line[0][1] === x.line[1][1] && Math.abs(x.line[0][0] - x.line[1][0]) > 5)!;
    const mid: O.Pt = [Math.round(((w.line[0][0] + w.line[1][0]) / 2) / 1.27) * 1.27, w.line[0][1]];
    mid[0] = Math.round(mid[0] * 1e6) / 1e6;
    const a = addPart('madhu/CAPACITOR-NP', '0805', [10, 150]);
    const before = seg.junctions?.length ?? 0;
    expect(wire([pinAt(a, '1'), [mid[0], pinAt(a, '1')[1]], mid])).toMatchObject({ net: 'N$3' });
    expect(seg.junctions).toHaveLength(before + 1);
    expect(seg.junctions!.at(-1)).toEqual(mid);
  });

  it('no junction at a plain corner', () => {
    const a = addPart('madhu/CAPACITOR-NP', '0805', [10, 150]);
    const b = addPart('madhu/CAPACITOR-NP', '0805', [30, 160]);
    wire([pinAt(a, '2'), [pinAt(b, '1')[0], pinAt(a, '2')[1]], pinAt(b, '1')]);
    expect(net('N$21')!.segments![0]!.junctions).toBeUndefined();
  });
});

describe('the wire tool', () => {
  it('clicks draw legs with an L bend and finish on a pin, as one undo step', () => {
    const s = editor.beginWire(0, () => 1.27)!;
    const from = pinAt('C2', '2');
    const to = pinAt('C4', '2');
    s.moveTo({ x: from[0] + 0.2, y: from[1] - 0.2 }, false, 0.5); // snaps onto the pin
    expect(s.snapped).toBe(true);
    expect(s.click()).toBe('started');
    s.moveTo({ x: to[0], y: to[1] }, false, 0.5);
    expect(s.path).toHaveLength(from[0] === to[0] || from[1] === to[1] ? 2 : 3);
    expect(s.click()).toBe('finish');
    expect(s.finish()).toEqual({ net: 'N$1', joined: ['N$2'] });
    expect(editor.history.undoLabel).toBe('Wire joining N$2, N$1');
    expect(s.drawing).toBe(false);
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('a click in empty space adds a corner and keeps drawing', () => {
    const s = editor.beginWire(0, () => 1.27)!;
    s.moveTo({ x: 0, y: 200 }, false, 0.1);
    s.click();
    s.moveTo({ x: 10, y: 200 }, false, 0.1);
    expect(s.click()).toBe('added');
    expect(s.drawing).toBe(true);
    s.finish();
    expect(net('N$21')!.segments![0]!.wires).toHaveLength(1);
  });
});
