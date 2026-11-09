// Copy and paste: unique part and net names, supply nets joining, library items travelling
// with the clip, and paste + placement as one undo step.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { copyTargets, parseClip, pasteClip, type Clip } from '../src/edit/clipboard';
import { deletePart } from '../src/edit/delete';
import { Transaction } from '../src/edit/ops';
import { netPads } from '../src/model/derive';
import { readProject, writeProject } from '../src/model/file';
import type * as O from '../src/model/types';
import type { Target } from '../src/scene/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
let sheet: O.Sheet;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
  sheet = p.schematic!.sheets[0]!;
});

const gate = (part: string): Target => ({ kind: 'gate', sheet, gate: sheet.gates.find((g) => g.part === part)! });
/** All wires (and junctions) of the segment holding a pin of `part`. */
const wiring = (netName: string, part: string): Target[] => {
  const net = p.nets.find((n) => n.name === netName)!;
  const segment = net.segments!.find((s) => s.pins.some((r) => r.part === part))!;
  return [
    ...segment.wires.map((wire): Target => ({ kind: 'wire', net, segment, wire })),
    ...(segment.junctions ?? []).map((junction): Target => ({ kind: 'junction', net, segment, junction })),
  ];
};
const copy = (ts: Target[]) => copyTargets(p, ts, 2.54)!;
const paste = (clip: Clip, into = p) => {
  const tx = new Transaction('Paste');
  const res = pasteClip(into, clip, into.schematic!.sheets[0]!, tx);
  editor.history.push(tx);
  return res;
};
const maxNumber = (prefix: string) => Math.max(...p.parts.filter((x) => new RegExp(`^${prefix}\\d+$`).test(x.name)).map((x) => Number(x.name.slice(prefix.length))));

describe('copying parts', () => {
  it('a copied part gets the next free name and keeps its value and variant', () => {
    const next = `C${maxNumber('C') + 1}`;
    const res = paste(copy([gate('C2')]));
    expect(res.parts).toEqual([next]);
    expect(res.renamed.get('C2')).toBe(next);
    const orig = p.parts.find((x) => x.name === 'C2')!;
    expect(p.parts.find((x) => x.name === next)).toEqual({ ...orig, name: next });
    expect(p.board!.footprints.some((f) => f.part === next)).toBe(true); // parked beside the board
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('a cut part pasted back keeps its name', () => {
    const clip = copy([gate('C2')]);
    const tx = new Transaction('Cut');
    deletePart(p, 'C2', tx);
    expect(paste(clip).parts).toEqual(['C2']);
  });
});

describe('copying wiring', () => {
  it('an automatic net becomes a new net connecting the copied pins', () => {
    const before = p.nets.length;
    const clip = copy([gate('C4'), gate('RF'), ...wiring('N$5', 'C4')]);
    const res = paste(clip);
    expect(p.nets).toHaveLength(before + 1);
    const name = res.renamed.get('N$5')!;
    expect(name).toBe('N$21');
    const [c4, rf] = [res.renamed.get('C4')!, res.renamed.get('RF')!];
    const seg = p.nets.find((n) => n.name === name)!.segments![0]!;
    expect(seg.pins.map((r) => r.part).sort()).toEqual([c4, rf].sort());
    // On the board the copy is its own net, with one pad of each new part.
    expect([...netPads(p).get(name)!].map((k) => k.split('\u0000')[0]).sort()).toEqual([c4, rf].sort());
  });

  it('a part named by hand keeps its stem', () => {
    expect(paste(copy([gate('RF')])).renamed.get('RF')).toBe('RF1');
  });

  it('junctions without their wires are not copied', () => {
    const net = p.nets.find((n) => n.name === 'N$3')!;
    const segment = net.segments![0]!;
    const junction = segment.junctions![0]!;
    expect(copyTargets(p, [{ kind: 'junction', net, segment, junction }], 2.54)).toBeUndefined();
    const clip = copy([gate('C4'), ...wiring('N$5', 'C4'), { kind: 'junction', net, segment, junction }]);
    expect(clip.nets.map((n) => n.name)).toEqual(['N$5']);
  });

  it('pins of parts not copied stay behind', () => {
    const clip = copy([gate('C4'), ...wiring('N$5', 'C4')]);
    expect(clip.nets[0]!.segments[0]!.pins.map((r) => r.part)).toEqual(['C4']);
  });

  it('a supply net joins the existing one', () => {
    const gnd = p.nets.find((n) => n.name === 'GND')!;
    const segs = gnd.segments!.length;
    const nets = p.nets.length;
    const res = paste(copy([gate('SUPPLY2'), gate('C1'), ...wiring('GND', 'SUPPLY2')]));
    expect(p.nets).toHaveLength(nets);
    expect(gnd.segments).toHaveLength(segs + 1);
    expect(gnd.segments!.at(-1)!.pins.map((r) => r.part).sort()).toEqual([res.renamed.get('C1'), res.renamed.get('SUPPLY2')].sort());
  });

  it('a named net gets a suffix; copies of the copy count on', () => {
    const clip = copy(wiring('MIX-OUT', 'IC1'));
    expect(paste(clip).renamed.get('MIX-OUT')).toBe('MIX-OUT_2');
    expect(paste(clip).renamed.get('MIX-OUT')).toBe('MIX-OUT_3');
    // A copy of a copy: MIX-OUT_4, not MIX-OUT_2_2.
    const net = p.nets.find((n) => n.name === 'MIX-OUT_2')!;
    const segment = net.segments![0]!;
    const again = copy(segment.wires.map((wire): Target => ({ kind: 'wire', net, segment, wire })));
    expect(paste(again).renamed.get('MIX-OUT_2')).toBe('MIX-OUT_4');
  });
});

describe('the clip', () => {
  it('survives JSON and carries the library items into another project', () => {
    const clip = parseClip(JSON.stringify(copy([gate('C4'), gate('RF'), ...wiring('N$5', 'C4')])))!;
    expect(clip).toBeDefined();
    expect(parseClip('{"hello": 1}')).toBeUndefined();
    expect(parseClip('not json')).toBeUndefined();

    // A project without the capacitor component (no parts use it).
    const other = readProject(ORIGINAL);
    const tx = new Transaction('');
    for (const part of other.parts.filter((x) => x.component === 'madhu/CAPACITOR-NP')) deletePart(other, part.name, tx);
    other.library.components = other.library.components.filter((c) => c.id !== 'madhu/CAPACITOR-NP');
    const res = paste(clip, other);
    expect(other.library.components.some((c) => c.id === 'madhu/CAPACITOR-NP')).toBe(true);
    expect(res.parts).toContain('C4'); // its name is free there
  });

  it('copying nothing copyable gives no clip', () => {
    expect(copyTargets(p, [], 2.54)).toBeUndefined();
  });
});

describe('paste and place', () => {
  it('floats the paste, places it with a click, one undo step', () => {
    const clip = copy([gate('C4'), gate('RF'), ...wiring('N$5', 'C4')]);
    const { session, pasted } = editor.beginPaste(clip, 0, () => 2.54)!;
    session.moveBy({ x: 0, y: -60 }, false);
    session.commit();
    const c4 = pasted.renamed.get('C4')!;
    const orig = sheet.gates.find((g) => g.part === 'C4')!;
    const copyGate = sheet.gates.find((g) => g.part === c4)!;
    expect(copyGate.at[0]).toBeCloseTo(orig.at[0]);
    expect(copyGate.at[1]).toBeCloseTo(orig.at[1] - 60.96); // snapped to the 2.54 grid
    expect(editor.history.undoLabel).toBe('Paste 2 parts and wiring');
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('cancelling a paste leaves the project untouched', () => {
    const { session } = editor.beginPaste(copy([gate('C2')]), 0, () => 2.54)!;
    session.moveBy({ x: 10, y: 10 }, false);
    session.cancel();
    expect(writeProject(p)).toBe(ORIGINAL);
    expect(editor.history.canUndo).toBe(false);
  });
});
