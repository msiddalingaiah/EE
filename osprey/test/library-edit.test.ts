// Editing a library's symbols and footprints: pins and pads move, rotate, change and go, and
// the components using them follow. Runs the project editor on the library (libraryProject).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { libraryProject } from '../src/edit/library';
import { readLibrary, writeLibrary } from '../src/model/file';
import type * as O from '../src/model/types';

const TEXT = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'madhu.ospreylib'), 'utf8');

let f: O.LibraryFile;
let ed: Editor;
let diode: O.Symbol;
let do41: O.Footprint;
const component = (name: string) => f.library.components.find((c) => c.id === `madhu/${name}`)!;
const pin = (name: string) => diode.pins.find((p) => p.name === name)!;
const pad = (name: string) => do41.pads.find((p) => p.name === name)!;
const pinT = (p: O.Pin) => ({ kind: 'pin' as const, symbol: diode, pin: p });
const padT = (p: O.Pad) => ({ kind: 'pad' as const, footprint: do41, pad: p });
/** Variants of a component that use DO-41. */
const onDo41 = (name: string) => component(name).variants.filter((v) => v.footprint === 'madhu/DO-41');

beforeEach(() => {
  f = readLibrary(TEXT);
  ed = new Editor(libraryProject(f), () => {});
  diode = f.library.symbols.find((s) => s.id === 'madhu/DIODE')!;
  do41 = f.library.footprints.find((x) => x.id === 'madhu/DO-41')!;
});

describe('library editing', () => {
  it('moves a pin on the symbol grid, and undoes', () => {
    const a = pin('A');
    const [x, y] = a.at;
    const move = ed.beginMove([pinT(a)], (alt) => ed.grid('schematic', alt), { x, y }, { x, y })!;
    move.moveBy({ x: 2.6, y: -0.1 }, false);
    move.commit();
    expect(a.at).toEqual([x + 2.54, y]);
    expect(ed.history.undoLabel).toBe('Move pin A');
    ed.undo();
    expect(a.at).toEqual([x, y]);
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('rotates pins and pads, keeping pins at right angles', () => {
    const a = pin('A');
    const rot = a.rot ?? 0;
    ed.rotate([pinT(a)], { x: a.at[0], y: a.at[1] }, 1);
    expect(a.rot ?? 0).toBe((rot + 90) % 360);
    const p = pad('A');
    ed.rotate([padT(p)], { x: 0, y: 0 }, 1);
    expect(p.rot).toBe(90);
    ed.mirror([padT(p)], { x: 0, y: 0 }, 'Mirror');
    expect(p.rot).toBe(90); // a vertical pad mirrored left-right still points up
  });

  it('renames a pin and the components using its symbol follow', () => {
    expect(ed.renamePin(diode, pin('A'), 'ANODE')).toBeUndefined();
    for (const name of ['1N4001', '1N914']) {
      for (const v of component(name).variants) {
        expect(v.pads['A.ANODE']).toBeDefined();
        expect(v.pads['A.A']).toBeUndefined();
      }
    }
    expect(ed.renamePin(diode, pin('ANODE'), 'C')).toBe('This symbol already has a pin named C');
    expect(ed.renamePin(diode, pin('ANODE'), 'A B')).toBe("A pin name can't contain spaces");
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('renames a pad and the variants using its footprint follow', () => {
    expect(ed.renamePad(do41, pad('A'), '1')).toBeUndefined();
    for (const v of onDo41('1N4001')) expect(v.pads['A.A']).toEqual(['1']);
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('deletes a pin or pad and drops it from the pin-to-pad maps', () => {
    ed.delete([pinT(pin('C'))]);
    expect(diode.pins.map((p) => p.name)).toEqual(['A']);
    for (const v of component('1N4001').variants) expect(v.pads['A.C']).toBeUndefined();
    ed.undo();
    ed.delete([padT(pad('A'))]);
    expect(do41.pads.map((p) => p.name)).toEqual(['C']);
    for (const v of onDo41('1N4001')) expect(v.pads['A.A']).toBeUndefined();
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('changes pin and pad properties, storing defaults as absent', () => {
    const a = pin('A');
    expect(ed.setPin(a, { direction: 'in' }, 'Direction')).toBeUndefined();
    expect(a.direction).toBe('in');
    ed.setPin(a, { direction: 'io' }, 'Direction');
    expect('direction' in a && a.direction !== undefined).toBe(false);
    expect(ed.setPin(a, { swap: -1 }, 'Swap level')).toMatch(/0 to 255/);
    const p = pad('A');
    expect(ed.setPad(p, { drill: 1.2 }, 'Drill')).toBeUndefined();
    expect(p.drill).toBe(1.2);
    expect(ed.setPad(p, { diameter: 1 }, 'Diameter')).toBe('The pad must be wider than its drill');
    expect(ed.setPad(p, { smd: [1, 1] }, 'Size')).toBe('Only an SMD pad has a size');
    expect(ed.setPad(p, { shape: 'octagon' }, 'Shape')).toBeUndefined();
    expect(p.shape).toBe('octagon');
  });
});
