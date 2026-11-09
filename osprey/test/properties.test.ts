import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { domOf } from '../src/eagle/dom';
import { parseEagle, serializeEagle } from '../src/eagle/parse';
import type { Board, Schematic, Sheet } from '../src/eagle/types';
import { translation } from '../src/edit/common';
import { Transaction } from '../src/edit/ops';
import { checkConsistency } from '../src/project/consistency';
import { Project } from '../src/project/project';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const schText = raw('TA7358A.sch');
const brdText = raw('TA7358A.brd');

let project: Project;
let sch: Schematic;
let brd: Board;
let sheet: Sheet;
let editor: Editor;
beforeEach(() => {
  project = Project.fromFiles([{ name: 'TA7358A.sch', text: schText }, { name: 'TA7358A.brd', text: brdText }]);
  sch = project.schematic!.file.schematic!;
  brd = project.board!.file.board!;
  sheet = sch.sheets[0]!;
  editor = new Editor(project, () => {});
});

const unchanged = () => {
  expect(serializeEagle(project.schematic!.file)).toBe(serializeEagle(parseEagle(schText)));
  expect(serializeEagle(project.board!.file)).toBe(serializeEagle(parseEagle(brdText)));
};
const consistent = () => expect(checkConsistency(sch, brd)).toEqual([]);

describe('rename part', () => {
  it('renames every reference in both documents, upper-cased; undo restores', () => {
    expect(editor.renamePart('L1', 'l9')).toBeUndefined();
    expect(sch.parts.has('L9') && !sch.parts.has('L1')).toBe(true);
    expect([...sch.parts.keys()].indexOf('L9')).toBe([...parseEagle(schText).schematic!.parts.keys()].indexOf('L1'));
    expect(sheet.instances.some((i) => i.part === 'L9')).toBe(true);
    expect(sheet.nets.some((n) => n.segments.some((s) => s.pinrefs.some((p) => p.part === 'L1')))).toBe(false);
    expect(brd.elements.some((e) => e.name === 'L9')).toBe(true);
    expect(brd.signals.some((s) => s.contactrefs.some((c) => c.element === 'L1'))).toBe(false);
    expect(serializeEagle(project.board!.file)).toContain('<element name="L9"');
    consistent();
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
});

describe('value', () => {
  it('sets a user value in both documents', () => {
    expect(editor.setValue('C3', '220p')).toBeUndefined();
    expect(sch.parts.get('C3')!.value).toBe('220p');
    expect(brd.elements.find((e) => e.name === 'C3')!.value).toBe('220p');
    expect(editor.isDirty(project.schematic!.file) && editor.isDirty(project.board!.file)).toBe(true);
    consistent();
    editor.undo();
    unchanged();
  });

  it('refuses parts whose device fixes the value', () => {
    const fixed = [...sch.parts.values()].find((p) => {
      const lib = sch.libraries.find((l) => l.name === p.library)!;
      return lib.devicesets.get(p.deviceset)?.uservalue === false && brd.elements.some((e) => e.name === p.name);
    })!;
    expect(editor.setValue(fixed.name, 'X')).toMatch(/fixed by its device/);
    unchanged();
  });
});

describe('rename net', () => {
  it('renames the schematic net and the board signal', () => {
    const net = sheet.nets.find((n) => n.name.startsWith('N$'))!;
    expect(editor.renameNet(net.name, 'rf_in2')).toBeUndefined();
    expect(net.name).toBe('RF_IN2');
    expect(brd.signals.some((s) => s.name === 'RF_IN2')).toBe(true);
    consistent();
    editor.undo();
    unchanged();
  });

  it('refuses supply nets and existing names', () => {
    expect(editor.renameNet('GND', 'GROUND')).toMatch(/supply/);
    const [a, b] = sheet.nets.filter((n) => n.name.startsWith('N$'));
    expect(editor.renameNet(a!.name, b!.name)).toMatch(/already exists/);
    unchanged();
  });
});

describe('smash / unsmash', () => {
  it('unsmashing then smashing a gate recreates positioned name/value texts; undo restores', () => {
    const inst = sheet.instances.find((i) => i.part === 'C3')!;
    expect(inst.smashed).toBe(true);
    const t = [{ kind: 'instance' as const, sheet, instance: inst }];
    expect(editor.setSmashed(t, false)).toBe(1);
    expect(inst.smashed).toBe(false);
    expect(inst.attributes.filter((a) => a.x !== undefined)).toHaveLength(0);
    expect(domOf(inst)!.hasAttribute('smashed')).toBe(false);
    // With no texts left, the element collapses to <instance .../> as Eagle writes it.
    expect(serializeEagle(project.schematic!.file)).toContain('<instance part="C3" gate="A" x="-30.48" y="50.8"/>');
    expect(editor.setSmashed(t, true)).toBe(1);
    expect(inst.attributes.map((a) => a.name).sort()).toEqual(['NAME', 'VALUE']);
    expect(serializeEagle(project.schematic!.file)).toMatch(/<instance part="C3"[^>]*smashed="yes"[^>]*>\r\n<attribute name="NAME" x="[^"]+" y="[^"]+" size="1\.778" layer="95"\/>/);
    editor.undo();
    editor.undo();
    unchanged();
  });

  it('smashing an element with no children formats them one per line', () => {
    const rf = brd.elements.find((e) => e.name === 'RF')!;
    const t = [{ kind: 'element' as const, element: rf }];
    editor.setSmashed(t, false);
    expect(editor.setSmashed(t, true)).toBe(1);
    const xml = serializeEagle(project.board!.file);
    expect(xml).toMatch(/<element name="RF"[^>]*>\r\n<attribute name="NAME"[^>]*\/>\r\n(<attribute[^>]*\/>\r\n)*<\/element>/);
    editor.undo();
    editor.undo();
    unchanged();
  });

  it('a smashed text moves alone, or with its part (once) when both are selected', () => {
    const ic = brd.elements.find((e) => e.name === 'IC1')!;
    const value = ic.attributes.find((a) => a.name === 'VALUE')!;
    const x0 = value.x!;
    const attrTarget = { kind: 'attribute' as const, doc: 'board' as const, parent: ic, attribute: value };
    let tx = new Transaction('Move');
    editor.transform([attrTarget], translation(1.27, 0), tx);
    expect(value.x).toBeCloseTo(x0 + 1.27);
    expect(ic.x).toBe(2.54);
    tx.revert();
    tx = new Transaction('Move');
    editor.transform([{ kind: 'element', element: ic }, attrTarget], translation(1.27, 0), tx);
    expect(value.x).toBeCloseTo(x0 + 1.27);
    expect(ic.x).toBeCloseTo(2.54 + 1.27);
  });
});
