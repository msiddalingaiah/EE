import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { domOf } from '../src/eagle/dom';
import { parseEagle, serializeEagle } from '../src/eagle/parse';
import type { EagleFile, Instance, Schematic, Sheet } from '../src/eagle/types';
import { mirrorAbout, rotationAbout, translation } from '../src/edit/common';
import { Transaction } from '../src/edit/ops';
import { deleteSchematicTargets, pinPosition, transformSchematicTargets } from '../src/edit/schematic';
import type { Target } from '../src/scene/types';

const text = readFileSync(join(__dirname, '..', 'samples', 'eagle', 'TA7358A.sch'), 'utf8');
const original = () => serializeEagle(parseEagle(text));

let file: EagleFile;
let sch: Schematic;
let sheet: Sheet;
beforeEach(() => {
  file = parseEagle(text);
  sch = file.schematic!;
  sheet = sch.sheets[0]!;
});

const inst = (part: string, gate?: string) =>
  sheet.instances.find((i) => i.part === part && (gate === undefined || i.gate === gate))!;
const target = (i: Instance): Target => ({ kind: 'instance', sheet, instance: i });

/** Pinrefs of `part` (all, and those whose pin sits on a wire end of their segment). */
function pinConnections(part: string): { total: number; attached: number } {
  let total = 0;
  let attached = 0;
  for (const net of sheet.nets) {
    for (const seg of net.segments) {
      for (const pr of seg.pinrefs.filter((p) => p.part === part)) {
        total++;
        const p = pinPosition(sch, inst(pr.part, pr.gate), pr.pin)!;
        if (seg.wires.some((w) => (Math.abs(w.x1 - p.x) < 1e-4 && Math.abs(w.y1 - p.y) < 1e-4) ||
          (Math.abs(w.x2 - p.x) < 1e-4 && Math.abs(w.y2 - p.y) < 1e-4))) attached++;
      }
    }
  }
  return { total, attached };
}

describe('schematic move / rotate / mirror', () => {
  it('moving a gate drags the net wires on its pins; undo restores the file exactly', () => {
    const ic = inst('IC1');
    const before = pinConnections('IC1');
    expect(before.attached).toBeGreaterThan(5);
    const tx = new Transaction('Move');
    transformSchematicTargets(sch, [target(ic)], translation(5.08, -2.54), tx);
    expect([ic.x, ic.y]).toEqual([35.56 + 5.08, 35.56 - 2.54]);
    expect(domOf(ic)!.getAttribute('x')).toBe('40.64');
    expect(pinConnections('IC1')).toEqual(before);
    // Smashed name text moved with it.
    expect(ic.attributes.find((a) => a.name === 'NAME')!.x).toBeCloseTo(22.86 + 5.08);
    tx.revert();
    expect(serializeEagle(file)).toBe(original());
  });

  it('rotating and mirroring keep pins attached', () => {
    for (const name of ['IC1', 'L1', 'C3']) {
      const i = inst(name);
      const before = pinConnections(name);
      const tx = new Transaction('Rotate');
      transformSchematicTargets(sch, [target(i)], rotationAbout({ x: i.x, y: i.y }, 1), tx);
      expect(pinConnections(name)).toEqual(before);
      transformSchematicTargets(sch, [target(i)], mirrorAbout(i.x), tx);
      expect(i.rot.mirror).toBe(true);
      expect(pinConnections(name)).toEqual(before);
    }
  });

  it('moving a net wire drags connected wire ends and the junction at its end', () => {
    const vcc = sheet.nets.find((n) => n.segments.some((s) => s.junctions.length && s.pinrefs.some((p) => p.part === 'L1')))!;
    const seg = vcc.segments.find((s) => s.pinrefs.some((p) => p.part === 'L1'))!;
    const j = seg.junctions[0]!;
    const w = seg.wires.find((x) => (x.x1 === j.x && x.y1 === j.y) || (x.x2 === j.x && x.y2 === j.y))!;
    const others = seg.wires.filter((x) => x !== w && ((x.x1 === j.x && x.y1 === j.y) || (x.x2 === j.x && x.y2 === j.y)));
    expect(others.length).toBeGreaterThan(0);
    const tx = new Transaction('Move');
    transformSchematicTargets(sch, [{ kind: 'net-wire', sheet, net: vcc, segment: seg, wire: w }], translation(0, 2.54), tx);
    expect(j.y).toBeCloseTo(60.96 + 2.54);
    for (const o of others) {
      expect((Math.abs(o.x1 - j.x) < 1e-6 && Math.abs(o.y1 - j.y) < 1e-6) || (Math.abs(o.x2 - j.x) < 1e-6 && Math.abs(o.y2 - j.y) < 1e-6)).toBe(true);
    }
    tx.revert();
    expect(serializeEagle(file)).toBe(original());
  });
});

describe('schematic delete', () => {
  it('deleting a single-gate part removes the instance, its pinrefs and the part', () => {
    const l1 = inst('L1');
    const tx = new Transaction('Delete');
    deleteSchematicTargets(sch, [target(l1)], tx);
    expect(sheet.instances.includes(l1)).toBe(false);
    expect(sch.parts.has('L1')).toBe(false);
    const saved = serializeEagle(file);
    expect(saved).not.toContain('part="L1"');
    expect(saved).not.toContain('<part name="L1"');
    // No new blank lines (some descriptions in the file legitimately contain them).
    const blanks = (x: string) => x.split('\r\n\r\n').length;
    expect(blanks(saved)).toBe(blanks(original()));
    tx.revert();
    expect(sch.parts.has('L1')).toBe(true);
    expect([...sch.parts.keys()]).toEqual([...parseEagle(text).schematic!.parts.keys()]); // order kept
    expect(serializeEagle(file)).toBe(original());
  });

  it('keeps a multi-gate part until its last gate is deleted', () => {
    const gates = sheet.instances.filter((i) => i.part === 'Q1');
    expect(gates).toHaveLength(2);
    const tx = new Transaction('Delete');
    deleteSchematicTargets(sch, [target(gates[0]!)], tx);
    expect(sch.parts.has('Q1')).toBe(true);
    deleteSchematicTargets(sch, [target(gates[1]!)], tx);
    expect(sch.parts.has('Q1')).toBe(false);
    tx.revert();
    expect(serializeEagle(file)).toBe(original());
  });

  it('deleting every wire of a net removes its segments and the net', () => {
    const net = sheet.nets.find((n) => n.segments.length === 1 && n.segments[0]!.wires.length <= 3)!;
    const seg = net.segments[0]!;
    const targets: Target[] = seg.wires.map((wire) => ({ kind: 'net-wire', sheet, net, segment: seg, wire }));
    const tx = new Transaction('Delete');
    deleteSchematicTargets(sch, targets, tx);
    expect(sheet.nets.includes(net)).toBe(false);
    expect(serializeEagle(file)).not.toContain(`<net name="${net.name}"`);
    tx.revert();
    expect(serializeEagle(file)).toBe(original());
  });

  it('deleting one wire drops pinrefs that no longer touch any wire', () => {
    // Find a wire ending on a pin that no other wire in the segment touches.
    for (const net of sheet.nets) {
      for (const seg of net.segments) {
        for (const pr of seg.pinrefs) {
          const p = pinPosition(sch, inst(pr.part, pr.gate), pr.pin)!;
          const at = seg.wires.filter((w) => (Math.abs(w.x1 - p.x) < 1e-4 && Math.abs(w.y1 - p.y) < 1e-4) ||
            (Math.abs(w.x2 - p.x) < 1e-4 && Math.abs(w.y2 - p.y) < 1e-4));
          if (at.length !== 1 || seg.wires.length < 2) continue;
          const tx = new Transaction('Delete');
          deleteSchematicTargets(sch, [{ kind: 'net-wire', sheet, net, segment: seg, wire: at[0]! }], tx);
          expect(seg.pinrefs.includes(pr)).toBe(false);
          tx.revert();
          expect(serializeEagle(file)).toBe(original());
          return;
        }
      }
    }
    throw new Error('no suitable wire in sample');
  });
});

describe('editor on a schematic', () => {
  it('moves with grid snapping and undoes in one step', async () => {
    const { Editor } = await import('../src/app/editor');
    const ed = new Editor(file, () => {});
    expect(ed.canEdit).toBe(true);
    expect(ed.mirrorVerb).toBe('Mirror');
    expect(ed.grid()).toBeCloseTo(2.54);
    const ic = inst('IC1');
    const s = ed.beginMove([target(ic)], { x: ic.x, y: ic.y }, { x: ic.x, y: ic.y })!;
    s.moveBy({ x: 3, y: 1 }, false);
    expect(ic.x).toBeCloseTo(35.56 + 2.54);
    expect(ic.y).toBeCloseTo(35.56);
    s.commit();
    expect(ed.history.undoLabel).toBe('Move IC1');
    expect(ed.undo()).toEqual([ic]);
    expect(serializeEagle(file)).toBe(original());
  });
});
