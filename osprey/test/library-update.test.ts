// Updating a project from a library: the project's copies of components, symbols and footprints
// are replaced by the library's, the schematic and board follow, and what no longer fits shows in
// ERC and DRC instead of breaking anything.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { drc } from '../src/model/drc';
import { erc } from '../src/model/erc';
import { readLibrary, readProject, writeProject } from '../src/model/file';
import { footprintInfo } from '../src/model/placement';
import type * as O from '../src/model/types';
import { buildBoardScene } from '../src/scene/board';
import { buildSchematicScene } from '../src/scene/schematic';

const sample = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'osprey', name), 'utf8');
const MADHU = readLibrary(sample('madhu.ospreylib')).library;
const TEXT = sample('wwvbfind.osprey');

let p: O.Project;
let editor: Editor;
let lib: O.Library;
beforeEach(() => {
  p = readProject(TEXT);
  editor = new Editor(p, () => {});
  lib = structuredClone(MADHU);
});

/** Everything that reads the model still works. */
function stillDraws(): void {
  buildSchematicScene(p, []);
  buildBoardScene(p, []);
  drc(p);
}

describe('updating a project from a library', () => {
  it('brings in what changed in the library (LCSC numbers, a description), as one undo step', () => {
    // What differs between the project's copies and the library (the library moves on).
    const differs = (['components', 'symbols', 'footprints'] as const).flatMap((k) => (p.library[k] as { id: string }[])
      .filter((x) => { const s = (lib[k] as { id: string }[]).find((y) => y.id === x.id); return s && JSON.stringify(s) !== JSON.stringify(x); })
      .map((x) => x.id));
    expect(differs).toEqual(expect.arrayContaining(['madhu/LED', 'madhu/MMBT3904', 'madhu/NL27WZ14']));
    const changed = editor.updateFromLibrary('madhu', lib);
    expect(changed.sort()).toEqual(differs.sort());
    const led = p.library.components.find((c) => c.id === 'madhu/LED')!;
    expect(led.variants.find((v) => v.name === '0805')!.technologies?.['']?.LCSC).toBe('C84256');
    expect(editor.history.undoLabel).toBe('Update from library madhu');
    // Up to date now: nothing more to do.
    expect(editor.updateFromLibrary('madhu', lib)).toEqual([]);
    editor.undo();
    expect(writeProject(p)).toBe(TEXT);
  });

  it('moves the board with a footprint change: pads where the library now has them', () => {
    const fp = lib.footprints.find((f) => f.id === 'madhu/0805')!;
    const before = footprintInfo(p, 'R1')!.pads.map((q) => q.at);
    for (const pad of fp.pads) pad.at = [pad.at[0] * 1.5, pad.at[1]];
    editor.updateFromLibrary('madhu', lib);
    const after = footprintInfo(p, 'R1')!.pads.map((q) => q.at);
    expect(after).not.toEqual(before);
    stillDraws();
  });

  it('copies in a footprint an updated component now uses', () => {
    const r = lib.components.find((c) => c.id === 'madhu/RESISTOR')!;
    const fp = structuredClone(lib.footprints.find((f) => f.id === 'madhu/0805')!);
    fp.id = 'madhu/0805-NEW';
    lib.footprints.push(fp);
    r.variants.push({ name: 'NEW', footprint: fp.id, pads: { 'A.1': ['1'], 'A.2': ['2'] } } as O.Variant);
    const changed = editor.updateFromLibrary('madhu', lib);
    expect(changed).toContain('madhu/0805-NEW');
    expect(p.library.footprints.some((f) => f.id === 'madhu/0805-NEW')).toBe(true);
  });

  it('leaves what no longer fits for ERC, without breaking anything', () => {
    // A symbol loses a pin R1 is wired by; a component loses the variant R2 uses.
    const sym = lib.symbols.find((s) => s.id === 'madhu/RESISTOR')!;
    sym.pins = sym.pins.filter((q) => q.name !== '2');
    const r = lib.components.find((c) => c.id === 'madhu/RESISTOR')!;
    for (const v of r.variants) for (const k of Object.keys(v.pads ?? {})) if (k.endsWith('.2')) delete v.pads![k];
    const led = lib.components.find((c) => c.id === 'madhu/LED')!;
    led.variants = led.variants.filter((v) => v.name !== '0805');
    editor.updateFromLibrary('madhu', lib);
    stillDraws();
    const problems = erc(p).problems.filter((x) => x.kind === 'library').map((x) => x.message);
    expect(problems).toContain('R1 pin 2 is wired to N$1, but its symbol has no such pin any more');
    expect(problems.some((m) => m.startsWith("D1's variant 0805 isn't in LED"))).toBe(true);
  });

  it('reports nothing for an up-to-date project', () => {
    expect(erc(p).problems.filter((x) => x.kind === 'library')).toEqual([]);
  });
});
