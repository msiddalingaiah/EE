// LCSC part numbers for chip resistors and capacitors from JLCPCB's Basic parts, by value and
// package: reading values, choosing among matches, and assigning them to a project.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject, writeProject } from '../src/model/file';
import { chipPackage, findPassive, lcscParts, lcscStatus, parseValue, readLcscTable, setLcscParts } from '../src/model/lcsc';

describe('reading values', () => {
  it('reads resistances', () => {
    expect(parseValue('10k', 'R')?.value).toBe(10e3);
    expect(parseValue('4k7', 'R')?.value).toBeCloseTo(4.7e3);
    expect(parseValue('4.7K', 'R')?.value).toBeCloseTo(4.7e3);
    expect(parseValue('3.3M', 'R')?.value).toBeCloseTo(3.3e6);
    expect(parseValue('220', 'R')?.value).toBe(220);
    expect(parseValue('100R', 'R')?.value).toBe(100);
    expect(parseValue('2R2', 'R')?.value).toBeCloseTo(2.2);
    expect(parseValue('', 'R')).toBeUndefined();
  });

  it('reads capacitances, with a voltage or dielectric if given', () => {
    expect(parseValue('100n', 'C')?.value).toBeCloseTo(100e-9);
    expect(parseValue('0.1u', 'C')?.value).toBeCloseTo(100e-9);
    expect(parseValue('4u7', 'C')?.value).toBeCloseTo(4.7e-6);
    expect(parseValue('27p', 'C')?.value).toBeCloseTo(27e-12);
    expect(parseValue('10uF', 'C')?.value).toBeCloseTo(10e-6);
    expect(parseValue('10u 16V X5R', 'C')).toEqual({ value: expect.closeTo(10e-6), volts: 16, dielectric: 'X5R' });
  });

  it('finds the chip size in a footprint or variant name', () => {
    expect(chipPackage('0805')).toBe('0805');
    expect(chipPackage('0603-RES')).toBe('0603');
    expect(chipPackage('C1206')).toBe('1206');
    expect(chipPackage('CAP-0.2', '0.2"')).toBeUndefined();
  });
});

const TEXT = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind2.osprey'), 'utf8');

describe('choosing a part', () => {
  it('takes a Basic resistor, tightest tolerance first', () => {
    const r = findPassive('R', '0805', { value: 10e3 })!;
    expect(r.basic).toBe(true);
    expect(r.lcsc).toBe('C17414');
  });

  it('takes C0G or X7R capacitors before X5R, then the lowest voltage from 25 V', () => {
    const c = findPassive('C', '0805', { value: 100e-9 })!;
    expect(['C0G', 'NP0', 'X7R']).toContain(c.dielectric);
    expect(c.volts).toBeGreaterThanOrEqual(25);
    // 10u comes in X5R only: still found.
    expect(findPassive('C', '0805', { value: 10e-6 })?.dielectric).toBe('X5R');
    // A dielectric asked for is kept to.
    expect(findPassive('C', '0805', { value: 100e-9, dielectric: 'C0G' })?.dielectric ?? 'C0G').toMatch(/C0G|NP0/);
  });

  it('finds nothing for a value the table lacks', () => {
    expect(findPassive('R', '0805', { value: 3.3e6 })).toBeUndefined();
  });
});
describe('assigning LCSC numbers', () => {

  it('gives chip resistors and capacitors theirs, says why the rest have none, in one undo step', () => {
    const p = readProject(TEXT);
    // A value only 0603 has in the table.
    p.parts.find((x) => x.name === 'C9')!.value = '27p';
    const start = writeProject(p);
    const editor = new Editor(p, () => {});
    const before = lcscStatus(p);
    const matches = before.filter((s) => 'match' in s).map((s) => s.part);
    expect(matches).toContain('R15');
    const done = editor.assignLcsc();
    expect(done.map((d) => d.part)).toEqual(matches);
    expect(p.parts.find((x) => x.name === 'R15')!.attributes?.LCSC).toBe('C17520');
    const after = lcscStatus(p, undefined, { throughHole: true });
    expect(after.filter((s) => 'match' in s)).toEqual([]);
    const why = new Map(after.flatMap((s) => ('missing' in s ? [[s.part, s.missing]] : [])));
    expect(why.get('C9')).toMatch(/27p capacitor in 0805 \(there is one in 0603\)/);
    expect(why.get('R16')).toMatch(/RM-065 isn't a chip package/);
    expect(why.get('U1')).toMatch(/not a resistor or capacitor/);
    expect(editor.history.undoLabel).toBe('Assign LCSC part numbers');
    editor.undo();
    expect(writeProject(p)).toBe(start);
  });

  it('leaves through-hole parts aside unless asked, as the assembly files do', () => {
    const p = readProject(TEXT);
    const aside = lcscStatus(p).filter((s) => 'throughHole' in s).map((s) => s.part);
    // Headers, the TO-92 JFETs, the coil, the crystal and the trimpot; not the SOT-23 or SMD parts.
    expect(aside).toEqual(expect.arrayContaining(['IN', 'UPDI', 'Q1', 'Q3', 'L1', 'X1', 'R16']));
    expect(aside).not.toContain('Q2');
    expect(aside).not.toContain('R15');
    expect(lcscStatus(p, undefined, { throughHole: true }).some((s) => 'throughHole' in s)).toBe(false);
  });

  it("keeps a number a part or its library component already has", () => {
    const p = readProject(TEXT);
    p.parts.find((x) => x.name === 'R15')!.attributes = { ...p.parts.find((x) => x.name === 'R15')!.attributes, LCSC: 'C99' };
    new Editor(p, () => {}).assignLcsc();
    expect(p.parts.find((x) => x.name === 'R15')!.attributes?.LCSC).toBe('C99');
    expect(lcscStatus(p).find((s) => s.part === 'R15')).toEqual({ part: 'R15', lcsc: 'C99', from: 'part' });
  });

  it('finds a number for another value (left from before a value change), and Assign replaces it', () => {
    const p = readProject(TEXT);
    const r15 = p.parts.find((x) => x.name === 'R15')!;
    // C17513 is the table's 1k 0805 resistor; R15 is 2.2k.
    r15.attributes = { ...r15.attributes, LCSC: 'C17513' };
    const start = writeProject(p);
    const s = lcscStatus(p).find((x) => x.part === 'R15')!;
    expect(s).toMatchObject({ wrong: 'C17513', is: { value: 1000, package: '0805' }, replacement: { lcsc: 'C17520' } });
    const editor = new Editor(p, () => {});
    expect(editor.assignLcsc()).toContainEqual({ part: 'R15', lcsc: 'C17520', was: 'C17513' });
    expect(r15.attributes?.LCSC).toBe('C17520');
    expect(lcscStatus(p).find((x) => x.part === 'R15')).toEqual({ part: 'R15', lcsc: 'C17520', from: 'part' });
    editor.undo();
    expect(writeProject(p)).toBe(start);
    // A value the table has nothing for: Assign removes the wrong number.
    r15.value = '1.234k';
    expect(lcscStatus(p).find((x) => x.part === 'R15')).toMatchObject({ wrong: 'C17513', why: expect.stringMatching(/no Basic or preferred 1.234k resistor/) });
    expect(new Editor(p, () => {}).assignLcsc()).toContainEqual({ part: 'R15', lcsc: '', was: 'C17513' });
    expect(r15.attributes?.LCSC).toBeUndefined();
  });
});

describe('the parts table', () => {
  // test/setup.ts loads the sample table; put it back after each change.
  const sample = [...lcscParts()];
  afterEach(() => setLcscParts(sample));

  it('reads a table file, skipping entries it cannot use', () => {
    const t = readLcscTable(JSON.stringify([
      { kind: 'R', value: 1000, lcsc: 'C17513', package: '0805', basic: true, stock: 5, mpn: 'X', tolerance: '±1%' },
      { kind: 'L', value: 1e-6, lcsc: 'C1', package: '0805' },
      { kind: 'R', value: 1000, lcsc: 'nope', package: '0805' },
      null,
    ]));
    expect(t.map((x) => x.lcsc)).toEqual(['C17513']);
    expect(() => readLcscTable('{"a":1}', 'parts/x.json')).toThrow('parts/x.json: expected a list');
    expect(() => readLcscTable('nope', 'parts/x.json')).toThrow('parts/x.json: not JSON');
  });

  it('has nothing to assign without a table, and says where one goes', () => {
    setLcscParts([]);
    const p = readProject(TEXT);
    expect(findPassive('R', '0805', { value: 10e3 })).toBeUndefined();
    const r15 = lcscStatus(p).find((x) => x.part === 'R15')!;
    expect(r15).toMatchObject({ missing: expect.stringMatching(/no JLCPCB parts table.*parts\/ folder/) });
    expect(new Editor(p, () => {}).assignLcsc()).toEqual([]);
  });

  it('takes a part number found in two tables from the first', () => {
    const a = { kind: 'R' as const, value: 1000, lcsc: 'C1', package: '0805', basic: true, stock: 1, mpn: 'A', tolerance: '' };
    setLcscParts([a, { ...a, mpn: 'B' }, { ...a, lcsc: 'C2' }]);
    expect(lcscParts().map((x) => `${x.lcsc} ${x.mpn}`)).toEqual(['C1 A', 'C2 A']);
  });
});
