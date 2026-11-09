// Editing on the native model: move/rotate/flip, delete, properties, smash, move sessions.
// Undo is checked by comparing the saved .osprey text before and after.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { deleteTargets } from '../src/edit/delete';
import { Transaction } from '../src/edit/ops';
import { mirrorAbout, rotationAbout, transformTargets, translation } from '../src/edit/transform';
import { netPads, ProjectIndex } from '../src/model/derive';
import { writeProject } from '../src/model/file';
import { padPosition, pinPosition } from '../src/model/geometry';
import { importEagle } from '../src/model/import-eagle';
import type * as O from '../src/model/types';
import type { Target } from '../src/scene/types';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const SCH = raw('TA7358A.sch');
const BRD = raw('TA7358A.brd');
const load = () => importEagle([{ name: 'TA7358A.sch', file: parseEagle(SCH) }, { name: 'TA7358A.brd', file: parseEagle(BRD) }], '2026-11-09').project;
const ORIGINAL = writeProject(load());

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = load();
  editor = new Editor(p, () => {});
});

const unchanged = () => expect(writeProject(p)).toBe(ORIGINAL);
const ix = () => new ProjectIndex(p);
const sheet = () => p.schematic!.sheets[0]!;
const net = (name: string) => p.nets.find((n) => n.name === name)!;
const fp = (part: string) => p.board!.footprints.find((f) => f.part === part)!;
const gate = (part: string, g?: string) => sheet().gates.find((x) => x.part === part && (g === undefined || x.gate === g))!;
const fpT = (part: string): Target => ({ kind: 'footprint', footprint: fp(part) });
const gateT = (part: string, g?: string): Target => ({ kind: 'gate', sheet: sheet(), gate: gate(part, g) });
const run = (fn: (tx: Transaction) => void) => {
  const tx = new Transaction('t');
  fn(tx);
  return tx;
};

/** Trace ends sitting exactly on a footprint's pads (per net). */
function attachedTraceEnds(part: string): number {
  const index = ix();
  const pads = netPads(p, index);
  let n = 0;
  for (const nt of p.nets) {
    for (const key of pads.get(nt.name) ?? []) {
      const [pp, pad] = key.split('\u0000') as [string, string];
      if (pp !== part) continue;
      const pos = padPosition(index, fp(part), pad)!;
      for (const t of nt.traces ?? []) for (const e of t.line) if (Math.abs(e[0] - pos.x) < 1e-4 && Math.abs(e[1] - pos.y) < 1e-4) n++;
    }
  }
  return n;
}

/** Pins of a part's gates sitting exactly on a wire end of their segment. */
function attachedPins(part: string): { total: number; attached: number } {
  const index = ix();
  let total = 0;
  let attached = 0;
  for (const nt of p.nets) {
    for (const seg of nt.segments ?? []) {
      for (const pr of seg.pins.filter((x) => x.part === part)) {
        total++;
        const pos = pinPosition(index, gate(pr.part, pr.gate), pr.pin)!;
        if (seg.wires.some((w) => w.line.some((e) => Math.abs(e[0] - pos.x) < 1e-4 && Math.abs(e[1] - pos.y) < 1e-4))) attached++;
      }
    }
  }
  return { total, attached };
}

describe('board geometry', () => {
  it('moving a footprint drags the traces on its pads; undo restores the file exactly', () => {
    const before = attachedTraceEnds('C2');
    expect(before).toBeGreaterThan(0);
    const tx = run((t) => transformTargets(p, [fpT('C2')], translation(1.27, 0), t));
    expect(fp('C2').at).toEqual([6.731, 14.351]);
    expect(attachedTraceEnds('C2')).toBe(before);
    expect(net('N$1').traces![1]!.line).toEqual([[3.821, 15.251], [6.731, 15.251]]);
    expect(net('N$1').traces![0]!.line[0]).toEqual([2.54, 13.97]); // the far trace is untouched
    tx.revert();
    unchanged();
  });

  it('rotating and flipping keep traces attached; flip moves the part to the bottom', () => {
    const before = attachedTraceEnds('IC1');
    const ic = fp('IC1');
    run((t) => transformTargets(p, [fpT('IC1')], rotationAbout({ x: ic.at[0], y: ic.at[1] }, 1), t));
    expect(ic.rot).toBe(180);
    expect(attachedTraceEnds('IC1')).toBe(before);
    const name = ic.labels!.find((l) => l.attr === 'VALUE')!;
    const layer = name.layer;
    run((t) => transformTargets(p, [fpT('IC1')], mirrorAbout(ic.at[0]), t));
    expect(ic.side).toBe('bottom');
    expect(name.layer).toBe(layer.replace('.top', '.bottom'));
    expect(attachedTraceEnds('IC1')).toBe(before);
  });

  it('moving a trace drags the trace joined to its end', () => {
    const [t0, t1] = net('N$1').traces!;
    run((t) => transformTargets(p, [{ kind: 'trace', net: net('N$1'), trace: t0! }], translation(0, 0.635), t));
    expect(t0!.line[0]).toEqual([2.54, 14.605]);
    expect(t1!.line[0]).toEqual(t0!.line[1]); // the shared corner followed
    expect(t1!.line[1]).toEqual([5.461, 15.251]); // its far end stays on the pad
  });

  it('a smashed label moves alone, or once with its part when both are selected', () => {
    const f = fp('IC1');
    const v = f.labels!.find((l) => l.attr === 'VALUE')!;
    const x0 = v.at[0];
    const label: Target = { kind: 'label', doc: 'board', placement: f, label: v };
    const tx = run((t) => transformTargets(p, [label], translation(1.27, 0), t));
    expect(v.at[0]).toBeCloseTo(x0 + 1.27);
    expect(f.at[0]).toBe(2.54);
    tx.revert();
    run((t) => transformTargets(p, [fpT('IC1'), label], translation(1.27, 0), t));
    expect(v.at[0]).toBeCloseTo(x0 + 1.27);
    expect(f.at[0]).toBeCloseTo(3.81);
  });
});

describe('schematic geometry', () => {
  it('moving a gate drags the wires on its pins; undo restores', () => {
    const before = attachedPins('IC1');
    expect(before.attached).toBeGreaterThan(5);
    const tx = run((t) => transformTargets(p, [gateT('IC1')], translation(5.08, -2.54), t));
    expect(gate('IC1').at).toEqual([40.64, 33.02]);
    expect(attachedPins('IC1')).toEqual(before);
    tx.revert();
    unchanged();
  });

  it('rotating and mirroring gates keep pins attached', () => {
    for (const part of ['IC1', 'L1', 'C3']) {
      const before = attachedPins(part);
      const g = gate(part);
      run((t) => transformTargets(p, [gateT(part)], rotationAbout({ x: g.at[0], y: g.at[1] }, 1), t));
      run((t) => transformTargets(p, [gateT(part)], mirrorAbout(g.at[0]), t));
      expect(g.mirror).toBe(true);
      expect(attachedPins(part)).toEqual(before);
    }
  });

  it('moving a wire drags the junction and wires at its end', () => {
    const vcc = p.nets.find((n) => n.segments?.some((s) => s.junctions?.length && s.pins.some((x) => x.part === 'L1')))!;
    const seg = vcc.segments!.find((s) => s.pins.some((x) => x.part === 'L1'))!;
    const j = seg.junctions![0]!;
    const at = (e: O.Pt) => Math.abs(e[0] - j[0]) < 1e-6 && Math.abs(e[1] - j[1]) < 1e-6;
    const w = seg.wires.find((x) => x.line.some(at))!;
    const others = seg.wires.filter((x) => x !== w && x.line.some(at));
    run((t) => transformTargets(p, [{ kind: 'wire', net: vcc, segment: seg, wire: w }], translation(0, 2.54), t));
    expect(j[1]).toBeCloseTo(60.96 + 2.54);
    for (const o of others) expect(o.line.some(at)).toBe(true);
  });
});

describe('delete', () => {
  it('deleting a footprint removes the part everywhere; undo restores', () => {
    const tx = run((t) => deleteTargets(p, [fpT('C2')], t));
    expect(p.parts.some((x) => x.name === 'C2')).toBe(false);
    expect(sheet().gates.some((g) => g.part === 'C2')).toBe(false);
    expect(p.nets.some((n) => n.segments?.some((s) => s.pins.some((x) => x.part === 'C2')))).toBe(false);
    expect([...netPads(p).values()].some((set) => [...set].some((k) => k.startsWith('C2\u0000')))).toBe(false);
    tx.revert();
    unchanged();
  });

  it('deleting the only gate removes the part and its footprint', () => {
    run((t) => deleteTargets(p, [gateT('L1')], t));
    expect(p.parts.some((x) => x.name === 'L1')).toBe(false);
    expect(p.board!.footprints.some((f) => f.part === 'L1')).toBe(false);
  });

  it('keeps a multi-gate part until its last gate is deleted', () => {
    const [a, b] = sheet().gates.filter((g) => g.part === 'Q1');
    run((t) => deleteTargets(p, [{ kind: 'gate', sheet: sheet(), gate: a! }], t));
    expect(p.parts.some((x) => x.name === 'Q1')).toBe(true);
    run((t) => deleteTargets(p, [{ kind: 'gate', sheet: sheet(), gate: b! }], t));
    expect(p.parts.some((x) => x.name === 'Q1')).toBe(false);
  });

  it('deleting the wire on a pin disconnects that pad on the board too', () => {
    const index = ix();
    for (const nt of p.nets) {
      for (const seg of nt.segments ?? []) {
        for (const pr of seg.pins) {
          const pos = pinPosition(index, gate(pr.part, pr.gate), pr.pin)!;
          const on = seg.wires.filter((w) => w.line.some((e) => Math.abs(e[0] - pos.x) < 1e-4 && Math.abs(e[1] - pos.y) < 1e-4));
          if (on.length !== 1 || seg.wires.length < 2 || !p.board!.footprints.some((f) => f.part === pr.part)) continue;
          const before = netPads(p).get(nt.name)!.size;
          const tx = run((t) => deleteTargets(p, [{ kind: 'wire', net: nt, segment: seg, wire: on[0]! }], t));
          expect(seg.pins.includes(pr)).toBe(false);
          expect(netPads(p).get(nt.name)?.size ?? 0).toBeLessThan(before);
          tx.revert();
          unchanged();
          return;
        }
      }
    }
    throw new Error('no suitable wire in the sample');
  });

  it('deleting every wire of a net removes the net (and keeps its board routing only if it has any)', () => {
    const n = p.nets.find((x) => x.segments?.length === 1 && !x.traces && !x.vias && !x.pours);
    if (n) {
      const seg = n.segments![0]!;
      run((t) => deleteTargets(p, seg.wires.map((wire): Target => ({ kind: 'wire', net: n, segment: seg, wire })), t));
      expect(p.nets.includes(n)).toBe(false);
    }
    const routed = p.nets.find((x) => x.segments?.length === 1 && x.traces?.length)!;
    const seg = routed.segments![0]!;
    run((t) => deleteTargets(p, seg.wires.map((wire): Target => ({ kind: 'wire', net: routed, segment: seg, wire })), t));
    expect(p.nets.includes(routed)).toBe(true);
    expect(routed.segments).toBeUndefined();
  });

  it('refuses to delete a locked part from either view', () => {
    fp('L1').locked = true;
    expect(run((t) => expect(deleteTargets(p, [gateT('L1')], t)).toEqual(['L1'])).empty).toBe(true);
    expect(run((t) => expect(deleteTargets(p, [fpT('L1')], t)).toEqual(['L1'])).empty).toBe(true);
  });
});

describe('properties', () => {
  it('renames a part and every reference, upper-cased; undo restores', () => {
    expect(editor.renamePart('L1', 'l9')).toBeUndefined();
    expect(p.parts.some((x) => x.name === 'L9')).toBe(true);
    expect(gate('L9')).toBeDefined();
    expect(fp('L9')).toBeDefined();
    expect(p.nets.some((n) => n.segments?.some((s) => s.pins.some((x) => x.part === 'L1')))).toBe(false);
    editor.undo();
    unchanged();
  });

  it('refuses taken names, empty names and spaces', () => {
    expect(editor.renamePart('L1', 'c1')).toMatch(/already a part named C1/);
    expect(editor.renamePart('L1', '  ')).toMatch(/empty/);
    expect(editor.renamePart('L1', 'L 2')).toMatch(/spaces/);
    expect(editor.history.canUndo).toBe(false);
    unchanged();
  });

  it('sets user values; refuses values fixed by the component', () => {
    expect(editor.setValue('C3', '220p')).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'C3')!.value).toBe('220p');
    editor.undo();
    unchanged();
    expect(editor.setValue('IC1', 'X')).toMatch(/fixed by its component/);
  });

  it('renames nets; refuses supply nets and existing names', () => {
    const n = p.nets.find((x) => x.name.startsWith('N$'))!;
    expect(editor.renameNet(n.name, 'rf_in2')).toBeUndefined();
    expect(n.name).toBe('RF_IN2');
    editor.undo();
    unchanged();
    expect(editor.renameNet('GND', 'GROUND')).toMatch(/supply/);
    const [a, b] = p.nets.filter((x) => x.name.startsWith('N$'));
    expect(editor.renameNet(a!.name, b!.name)).toMatch(/already exists/);
  });

  it('unsmash then smash puts the labels back where they were', () => {
    const g = gate('C3');
    const original = JSON.stringify(g.labels);
    expect(editor.setSmashed([gateT('C3')], false)).toBe(1);
    expect(g.labels).toBeUndefined();
    expect(g.smashed).toBeUndefined();
    expect(editor.setSmashed([gateT('C3')], true)).toBe(1);
    expect(JSON.stringify(g.labels)).toBe(original);
    editor.undo();
    editor.undo();
    unchanged();
  });

  it('smashes a board footprint, mirrored layers on the bottom', () => {
    const f = fp('RF'); // smashed with no labels: unsmash first
    editor.setSmashed([fpT('RF')], false);
    expect(editor.setSmashed([fpT('RF')], true)).toBe(1);
    expect(f.labels?.map((l) => l.attr)).toContain('NAME');
  });
});

describe('move sessions', () => {
  it('snaps a footprint origin to the 50 mil grid and drags traces live; cancel restores', () => {
    const f = fp('C2'); // (5.461, 14.351) is off grid
    const s = editor.beginMove([fpT('C2')], (alt) => editor.grid('board', alt), { x: f.at[0], y: f.at[1] }, { x: f.at[0], y: f.at[1] })!;
    s.moveBy({ x: 2, y: 0.3 }, false);
    expect(f.at[0] / 1.27).toBeCloseTo(Math.round(f.at[0] / 1.27));
    expect(f.at[1] / 1.27).toBeCloseTo(Math.round(f.at[1] / 1.27));
    expect(attachedTraceEnds('C2')).toBeGreaterThan(0);
    s.cancel();
    unchanged();
    expect(editor.history.canUndo).toBe(false);
  });

  it('a gate move with rotation is one undo step', () => {
    const g = gate('IC1');
    const s = editor.beginMove([gateT('IC1')], (alt) => editor.grid('schematic', alt), { x: g.at[0], y: g.at[1] }, { x: g.at[0], y: g.at[1] })!;
    s.moveBy({ x: 3, y: 1 }, false);
    expect(g.at).toEqual([38.1, 35.56]);
    s.rotate(1);
    s.commit();
    expect(editor.history.undoLabel).toBe('Move/rotate IC1');
    expect(editor.undo()).toEqual([g]);
    unchanged();
  });
});
