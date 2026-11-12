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

describe('library drawing and items', () => {
  it('adds pins pointing toward the origin, and pads numbered after the others', () => {
    const sym = ed.addLibraryItem('symbol') as O.Symbol;
    expect(sym.id).toBe('madhu/NEW');
    expect(ed.addPin(sym, [-5.08, 0])).toEqual({ name: 'P$1', at: [-5.08, 0] });
    expect(ed.addPin(sym, [5.08, 0])).toEqual({ name: 'P$2', at: [5.08, 0], rot: 180 });
    expect(ed.addPin(sym, [0, 5.08]).rot).toBe(270);
    expect((ed.addLibraryItem('symbol') as O.Symbol).id).toBe('madhu/NEW-2');
    expect(ed.addPad(do41, [0, 0], false)).toEqual({ name: '1', at: [0, 0], drill: 0.8 });
    expect(ed.addPad(do41, [1, 0], true)).toEqual({ name: '2', smd: [1.27, 0.635], at: [1, 0] });
    expect(ed.history.undoLabel).toBe('Add SMD pad 2');
  });

  it('renames a symbol or footprint, and the components using it follow', () => {
    expect(ed.renameLibraryItem('symbol', diode, 'diode-x')).toBeUndefined();
    expect(diode.id).toBe('madhu/DIODE-X');
    expect(component('1N4001').gates[0]!.symbol).toBe('madhu/DIODE-X');
    expect(ed.renameLibraryItem('footprint', do41, 'DO-35')).toBe('There is already a footprint named DO-35');
    expect(ed.renameLibraryItem('footprint', do41, 'DO 41')).toMatch(/can't contain spaces/);
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('renames the library, and the ids that carry its name', () => {
    expect(ed.renameLibrary(f, 'parts')).toBeUndefined();
    expect(f.name).toBe('parts');
    expect(diode.id).toBe('parts/DIODE');
    expect(component('1N4001')).toBeUndefined();
    expect(f.library.components.find((c) => c.id === 'parts/1N4001')!.variants[0]!.footprint).toBe('parts/DO-41');
    // New items are named after the library.
    expect(ed.addLibraryItem('footprint').id).toBe('parts/NEW');
    ed.undo();
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('changes a graphic: layer, width, text', () => {
    const line = diode.graphics.find((g): g is O.LineShape => 'line' in g)!;
    expect(ed.setGraphic(line, { width: 0.5 }, 'Line width')).toBeUndefined();
    expect(line.width).toBe(0.5);
    expect(ed.setGraphic(line, { radius: 1 }, 'Radius')).toBe('Only a circle has a radius');
    const text: O.TextShape = { text: '>NAME', at: [0, 0], size: 1.778, layer: 'names' };
    ed.addGraphic(diode.graphics, text, 'Add text');
    expect(ed.setGraphic(text, { text: '' }, 'Change text')).toBe("A text can't be empty");
    expect(ed.setGraphic(text, { text: '>VALUE', layer: 'values' }, 'Change text')).toBeUndefined();
    expect([text.text, text.layer]).toEqual(['>VALUE', 'values']);
  });
});

describe('components', () => {
  const c = () => component('1N4001');
  const v = () => c().variants.find((x) => x.name === 'H')!; // on DO-41

  it('adds a component with one variant, and gates named G$n beside each other', () => {
    const n = ed.addComponent();
    expect(n).toEqual({ id: 'madhu/NEW', gates: [], variants: [{ name: '', pads: {} }] });
    expect(ed.addGate(n, diode)).toEqual({ name: 'G$1', symbol: 'madhu/DIODE', at: [0, 0] });
    expect(ed.addGate(n, diode).at).toEqual([25.4, 0]);
    expect(ed.setComponent(n, { prefix: 'd', userValue: true }, 'Prefix')).toBeUndefined();
    expect([n.prefix, n.userValue]).toEqual(['D', true]);
  });

  it('renames and deletes a gate, and its pins\' connections follow', () => {
    const gate = c().gates[0]!;
    expect(ed.renameGate(c(), gate, 'g')).toBeUndefined();
    expect(Object.keys(v().pads).sort()).toEqual(['G.A', 'G.C']);
    ed.delete([{ kind: 'libgate', component: c(), gate }]);
    expect(c().gates).toEqual([]);
    expect(v().pads).toEqual({});
    ed.undo();
    ed.undo();
    expect(writeLibrary(f)).toBe(TEXT);
  });

  it('connects pins to pads: one pin to several pads, but not a pad to two pins', () => {
    expect(ed.connectPin(v(), 'A.A', ['A', 'C'])).toBe('Pad C is already connected to A.C');
    expect(ed.connectPin(v(), 'A.A', ['X'])).toBe('DO-41 has no pad X');
    expect(ed.connectPin(v(), 'A.C', [])).toBeUndefined();
    expect(v().pads['A.C']).toBeUndefined();
    expect(ed.connectPin(v(), 'A.A', ['A', 'C'])).toBeUndefined();
    expect(v().pads['A.A']).toEqual(['A', 'C']);
  });

  it('connects the rest: same names first, then in order', () => {
    ed.connectPin(v(), 'A.A', []);
    ed.connectPin(v(), 'A.C', []);
    expect(ed.autoConnect(c(), v())).toBe(2);
    expect(v().pads).toEqual({ 'A.A': ['A'], 'A.C': ['C'] });
    expect(ed.autoConnect(c(), v())).toBe(0);
    // A footprint with numbered pads: in order.
    ed.connectPin(v(), 'A.A', []);
    ed.connectPin(v(), 'A.C', []);
    expect(ed.setVariantFootprint(v(), 'madhu/TO-92')).toBeUndefined();
    expect(ed.autoConnect(c(), v())).toBe(2);
    expect(v().pads).toEqual({ 'A.A': ['1'], 'A.C': ['2'] });
  });

  it('changes a variant\'s footprint, dropping connections to pads it lacks; adds, renames and deletes variants', () => {
    expect(ed.setVariantFootprint(v(), 'madhu/TO-92')).toBeUndefined();
    const changed = c().variants.find((x) => x.footprint === 'madhu/TO-92')!;
    expect(changed.pads).toEqual({});
    ed.undo();
    expect(ed.addVariant(c(), 'smd', 'madhu/SOD-123')).toBe('No footprint madhu/SOD-123 in this library');
    expect(ed.addVariant(c(), 'smd', 'madhu/DO-35')).toBeUndefined();
    const smd = c().variants.find((x) => x.name === 'SMD')!;
    expect(smd).toEqual({ name: 'SMD', footprint: 'madhu/DO-35', pads: {} });
    expect(ed.renameVariant(c(), smd, 'v')).toBe('There is already a variant V');
    expect(ed.deleteVariant(c(), smd)).toBeUndefined();
    const only = ed.addComponent();
    expect(ed.deleteVariant(only, only.variants[0]!)).toBe('A component needs at least one variant');
  });
});
