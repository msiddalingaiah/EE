import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle, serializeEagle } from '../src/eagle/parse';
import type { Board, Schematic, Sheet } from '../src/eagle/types';
import { translation } from '../src/edit/common';
import { Transaction } from '../src/edit/ops';
import { checkConsistency, schematicNetPads } from '../src/project/consistency';
import { Project, ProjectError } from '../src/project/project';
import { pinPosition } from '../src/edit/schematic';
import type { Target } from '../src/scene/types';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const schText = raw('TA7358A.sch');
const brdText = raw('TA7358A.brd');

let project: Project;
let sch: Schematic;
let brd: Board;
let sheet: Sheet;
let editor: Editor;
beforeEach(() => {
  project = Project.fromFiles([
    { name: 'TA7358A.sch', text: schText },
    { name: 'TA7358A.brd', text: brdText },
  ]);
  sch = project.schematic!.file.schematic!;
  brd = project.board!.file.board!;
  sheet = sch.sheets[0]!;
  editor = new Editor(project, () => {});
});

const unchanged = () => {
  expect(serializeEagle(project.schematic!.file)).toBe(serializeEagle(parseEagle(schText)));
  expect(serializeEagle(project.board!.file)).toBe(serializeEagle(parseEagle(brdText)));
};
const instance = (part: string): Target => ({ kind: 'instance', sheet, instance: sheet.instances.find((i) => i.part === part)! });
const element = (name: string): Target => ({ kind: 'element', element: brd.elements.find((e) => e.name === name)! });

describe('project', () => {
  it('pairs a schematic with its board', () => {
    expect(project.name).toBe('TA7358A');
    expect(project.views).toEqual(['schematic', 'board']);
    expect(project.paired).toBe(true);
    expect(project.notes).toEqual([]);
    expect(checkConsistency(sch, brd)).toEqual([]);
  });

  it('notes a missing counterpart, and rejects mixing a library in', () => {
    const solo = Project.fromFiles([{ name: 'TA7358A.sch', text: schText }]);
    expect(solo.paired).toBe(false);
    expect(solo.notes[0]).toMatch(/TA7358A\.brd/);
    expect(() => Project.fromFiles([{ name: 'a.sch', text: schText }, { name: 'madhu.lbr', text: raw('madhu.lbr') }])).toThrow(ProjectError);
  });
});

describe('annotated delete', () => {
  it('deleting a part in the schematic removes it from the board; undo restores both', () => {
    editor.delete([instance('L1')]);
    expect(sch.parts.has('L1')).toBe(false);
    expect(brd.elements.some((e) => e.name === 'L1')).toBe(false);
    expect(brd.signals.some((s) => s.contactrefs.some((c) => c.element === 'L1'))).toBe(false);
    expect(checkConsistency(sch, brd)).toEqual([]);
    expect(editor.isDirty(project.schematic!.file)).toBe(true);
    expect(editor.isDirty(project.board!.file)).toBe(true);
    editor.undo();
    unchanged();
    expect(editor.anyDirty).toBe(false);
  });

  it('deleting an element on the board removes the part from the schematic', () => {
    editor.delete([element('C2')]);
    expect(sch.parts.has('C2')).toBe(false);
    expect(sheet.instances.some((i) => i.part === 'C2')).toBe(false);
    expect(sheet.nets.some((n) => n.segments.some((s) => s.pinrefs.some((p) => p.part === 'C2')))).toBe(false);
    expect(checkConsistency(sch, brd)).toEqual([]);
    editor.undo();
    unchanged();
  });

  it('a schematic wire delete that disconnects a pin removes that pad from the board signal', () => {
    // Find a wire that alone connects a packaged part's pin.
    for (const net of sheet.nets) {
      for (const seg of net.segments) {
        for (const pr of seg.pinrefs) {
          const inst = sheet.instances.find((i) => i.part === pr.part && i.gate === pr.gate)!;
          const p = pinPosition(sch, inst, pr.pin)!;
          const at = seg.wires.filter((w) => (Math.abs(w.x1 - p.x) < 1e-4 && Math.abs(w.y1 - p.y) < 1e-4) ||
            (Math.abs(w.x2 - p.x) < 1e-4 && Math.abs(w.y2 - p.y) < 1e-4));
          if (at.length !== 1 || !brd.elements.some((e) => e.name === pr.part)) continue;
          const before = schematicNetPads(sch).get(net.name)!.size;
          editor.delete([{ kind: 'net-wire', sheet, net, segment: seg, wire: at[0]! }]);
          expect(schematicNetPads(sch).get(net.name)?.size ?? 0).toBeLessThan(before);
          expect(checkConsistency(sch, brd)).toEqual([]);
          editor.undo();
          unchanged();
          return;
        }
      }
    }
    throw new Error('no suitable wire');
  });

  it('deleting a board trace leaves the schematic alone', () => {
    const s = brd.signals.find((x) => x.wires.length)!;
    editor.delete([{ kind: 'signal-wire', signal: s, wire: s.wires[0]! }]);
    expect(editor.isDirty(project.board!.file)).toBe(true);
    expect(editor.isDirty(project.schematic!.file)).toBe(false);
    expect(serializeEagle(project.schematic!.file)).toBe(serializeEagle(parseEagle(schText)));
  });

  it('deleting a supply symbol (no footprint) leaves the board alone', () => {
    const supply = sheet.instances.find((i) => i.part.startsWith('SUPPLY'))!;
    editor.delete([{ kind: 'instance', sheet, instance: supply }]);
    expect(editor.isDirty(project.board!.file)).toBe(false);
    expect(checkConsistency(sch, brd)).toEqual([]);
  });

  it('refuses to delete a part whose board element is locked', () => {
    brd.elements.find((e) => e.name === 'L1')!.locked = true;
    expect(editor.delete([instance('L1')])).toEqual(['L1']);
    expect(sch.parts.has('L1')).toBe(true);
    expect(editor.history.canUndo).toBe(false);
  });
});

describe('per-file unsaved changes', () => {
  it('a board move marks only the board; saving one file clears only it', () => {
    const tx = new Transaction('Move');
    editor.transform([element('C2')], translation(1.27, 0), tx);
    editor.push(tx);
    expect(editor.isDirty(project.board!.file)).toBe(true);
    expect(editor.isDirty(project.schematic!.file)).toBe(false);
    editor.history.markSaved(project.board!.file);
    expect(editor.anyDirty).toBe(false);
    editor.undo();
    expect(editor.isDirty(project.board!.file)).toBe(true);
    expect(editor.isDirty(project.schematic!.file)).toBe(false);
  });
});
