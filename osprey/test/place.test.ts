// Adding parts: library copy, naming, footprint parking, gate-by-gate placement, undo.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { gatesToPlace, nextPartName } from '../src/edit/place';
import { netPads } from '../src/model/derive';
import { exportEagle } from '../src/model/export-eagle';
import { readProject, writeProject } from '../src/model/file';
import { importEagle, importLibrary } from '../src/model/import-eagle';
import type * as O from '../src/model/types';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', name), 'utf8');
const ORIGINAL = raw('osprey/TA7358A.osprey');
const LBR = importLibrary('madhu.lbr', parseEagle(raw('eagle/madhu.lbr')));

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
});
const grid = (alt: boolean) => editor.grid('schematic', alt);
const place = (source: O.Library, id: string, variant: string) => editor.beginPlace(source, id, variant, '', 0, grid)!;

describe('naming', () => {
  it('takes the next number after the highest with the prefix', () => {
    const highest = Math.max(...p.parts.filter((x) => /^C\d+$/.test(x.name)).map((x) => Number(x.name.slice(1))));
    expect(nextPartName(p, 'C')).toBe(`C${highest + 1}`);
    expect(nextPartName(p, 'ZZ')).toBe('ZZ1');
    expect(nextPartName(p, '')).toBe('U$1');
  });
});

describe('placing a part from the project library', () => {
  it('places the gate where clicked, parks the footprint beside the board; one undo step', () => {
    const name = nextPartName(p, 'C');
    const s = place(p.library, 'madhu/CAPACITOR-NP', '0805');
    s.moveTo({ x: 101.1, y: 49.9 }, false);
    s.rotate(1);
    expect(s.click()).toBe(name);
    s.cancel(); // stop before placing another one
    const gate = p.schematic!.sheets[0]!.gates.find((g) => g.part === name)!;
    expect(gate).toMatchObject({ gate: 'A', at: [101.6, 50.8], rot: 90 });
    const fp = p.board!.footprints.find((f) => f.part === name)!;
    expect(fp.at[0]).toBeLessThan(0); // left of the board outline at x = 0
    expect(p.parts.find((x) => x.name === name)).toEqual({ name, component: 'madhu/CAPACITOR-NP', variant: '0805' });
    // Not wired yet: no net has its pads.
    expect([...netPads(p).values()].some((set) => [...set].some((k) => k.startsWith(`${name}\u0000`)))).toBe(false);
    expect(editor.history.undoLabel).toBe(`Add ${name}`);
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('keeps placing parts of the same component until cancelled', () => {
    const s = place(p.library, 'madhu/CAPACITOR-NP', '0805');
    const a = s.click();
    s.moveTo({ x: 10, y: 0 }, false);
    const b = s.click();
    s.cancel();
    expect(a).not.toBe(b);
    expect(p.parts.filter((x) => x.name === a || x.name === b)).toHaveLength(2);
    editor.undo();
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('cancelling before the first click leaves the project untouched', () => {
    const s = place(p.library, 'madhu/CAPACITOR-NP', '0805');
    s.moveTo({ x: 5, y: 5 }, false);
    s.cancel();
    expect(writeProject(p)).toBe(ORIGINAL);
    expect(editor.history.canUndo).toBe(false);
  });

  it('places multi-gate parts gate by gate', () => {
    const component = p.library.components.find((c) => gatesToPlace(c).length > 1)!;
    const s = place(p.library, component.id, component.variants[0]!.name);
    const gates = gatesToPlace(component);
    const name = s.placing!.part;
    for (let i = 0; i < gates.length; i++) {
      expect(s.placing).toEqual({ part: name, gate: gates[i]!.name });
      s.moveTo({ x: 20 * i, y: 100 }, false);
      expect(s.click()).toBe(i === gates.length - 1 ? name : undefined);
    }
    s.cancel();
    expect(p.schematic!.sheets[0]!.gates.filter((g) => g.part === name)).toHaveLength(gates.length);
  });

  it('a symbol-only part (supply) gets no footprint', () => {
    const supply = p.library.components.find((c) => c.variants.every((v) => !v.footprint) && c.gates.length)!;
    const s = place(p.library, supply.id, supply.variants[0]!.name);
    const name = s.click()!;
    s.cancel();
    expect(p.board!.footprints.some((f) => f.part === name)).toBe(false);
  });
});

describe('placing a part from another library', () => {
  it('copies the component, its symbols and footprints into the project', () => {
    const c = LBR.components.find((x) => !p.library.components.some((y) => y.id === x.id) && x.variants.some((v) => v.footprint))!;
    const variant = c.variants.find((v) => v.footprint)!;
    const s = place(LBR, c.id, variant.name);
    const name = s.click()!;
    s.cancel();
    expect(p.library.components.some((x) => x.id === c.id)).toBe(true);
    for (const g of c.gates) expect(p.library.symbols.some((x) => x.id === g.symbol)).toBe(true);
    expect(p.library.footprints.some((x) => x.id === variant.footprint)).toBe(true);
    // Library lists stay sorted, so the file stays canonical.
    const ids = p.library.components.map((x) => x.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    // The new part survives an Eagle round trip.
    const files = exportEagle(p).files;
    const back = importEagle([...files].map(([n, text]) => ({ name: n, file: parseEagle(text) })), p.project.imported!.date).project;
    expect(back.parts.some((x) => x.name === name)).toBe(true);
    expect(back.board!.footprints.some((f) => f.part === name)).toBe(true);
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });
});
