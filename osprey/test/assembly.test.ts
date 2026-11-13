// Assembly files: the bill of materials and the pick-and-place list (JLCPCB's format).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { assemblyFiles, type AssemblyOptions } from '../src/cam/assembly';
import { parseEagle } from '../src/eagle/parse';
import { libraryProject } from '../src/edit/library';
import { ProjectIndex } from '../src/model/derive';
import { exportEagle, exportEagleLibrary } from '../src/model/export-eagle';
import { readLibrary, readProject, writeLibrary } from '../src/model/file';
import { padPosition } from '../src/model/geometry';
import { importEagle, importLibraryFile } from '../src/model/import-eagle';
import type * as O from '../src/model/types';

let p: O.Project;
let ed: Editor;
beforeEach(() => {
  p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind.osprey'), 'utf8'));
  ed = new Editor(p, () => {});
});

/** A CSV file as rows of fields (handles quoted fields with commas). */
function csv(text: string): string[][] {
  return text.trim().split('\r\n').map((line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].slice(0, -1).map((m) => m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')));
}
const files = (options: AssemblyOptions = {}) => {
  const r = assemblyFiles(p, options);
  return { bom: csv(r.files.get('wwvbfind_BOM.csv')!), cpl: csv(r.files.get('wwvbfind_CPL.csv')!), warnings: r.warnings };
};
const designators = (bom: string[][]) => bom.slice(1).flatMap((r) => r[1]!.split(',')).sort();
/** Placed parts whose footprint is through-hole only. */
const throughHole = () => {
  const index = new ProjectIndex(p);
  return p.board!.footprints.map((f) => f.part).filter((n) => index.footprints.get(index.variantOf(index.parts.get(n)!)!.footprint!)!.pads.every((pad) => !pad.smd)).sort();
};

describe('assembly files', () => {
  it('with through-hole parts: lists every placed part once in each file, and nothing without a footprint', () => {
    const { bom, cpl } = files({ throughHole: true });
    const placed = p.board!.footprints.map((f) => f.part).sort();
    expect(bom[0]).toEqual(['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity', 'Manufacturer', 'MPN', 'Mounting']);
    expect(cpl[0]).toEqual(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']);
    expect(designators(bom)).toEqual(placed);
    expect(cpl.slice(1).map((r) => r[0]).sort()).toEqual(placed);
    // Quantities add up; supply symbols (GND, VCC) have no footprint and are left out.
    expect(bom.slice(1).reduce((n, r) => n + Number(r[4]), 0)).toBe(placed.length);
    expect(bom).toContainEqual(['BERG-2', 'IN,VCC,VOUT', 'BERG-2', '', '3', '', '', 'THT']);
  });

  it('leaves through-hole parts out by default, and says which', () => {
    const tht = throughHole();
    expect(tht).toEqual(expect.arrayContaining(['IN', 'VCC', 'VOUT', 'UPDI', 'Q1']));
    const { bom, cpl, warnings } = files();
    expect(designators(bom).filter((n) => tht.includes(n))).toEqual([]);
    expect(cpl.slice(1).map((r) => r[0]).filter((n) => tht.includes(n!))).toEqual([]);
    expect(warnings[0]).toBe(`Not placed: ${tht.length} through-hole parts (${[...tht].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}); solder these yourself`);
  });

  it('leaves out parts marked do-not-place', () => {
    expect(ed.setDoNotPlace('R14', true)).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'R14')!.attributes).toMatchObject({ DNP: 'yes' });
    const { bom, cpl, warnings } = files();
    expect(designators(bom)).not.toContain('R14');
    expect(cpl.some((r) => r[0] === 'R14')).toBe(false);
    expect(warnings[0]).toMatch(/ and 1 marked do-not-place \(R14\); solder these yourself$/);
    ed.setDoNotPlace('R14', false);
    expect(p.parts.find((x) => x.name === 'R14')!.attributes).toEqual({ BLOCK: 'MCU/LED' });
  });

  it('groups identical parts into one row', () => {
    expect(files().bom).toContainEqual(['10u', 'C1,C3,C7,C13', '0805', '', '4', '', '', 'SMD']);
  });

  it('places each part at the centre of its pads, with its side and rotation', () => {
    const index = new ProjectIndex(p);
    const { cpl } = files({ throughHole: true });
    for (const f of p.board!.footprints) {
      const fp = index.footprints.get(index.variantOf(index.parts.get(f.part)!)!.footprint!)!;
      const pads = fp.pads.map((pad) => padPosition(index, f, pad.name)!);
      const x = (Math.min(...pads.map((q) => q.x)) + Math.max(...pads.map((q) => q.x))) / 2;
      const y = (Math.min(...pads.map((q) => q.y)) + Math.max(...pads.map((q) => q.y))) / 2;
      const r = cpl.find((row) => row[0] === f.part)!;
      expect(parseFloat(r[1]!)).toBeCloseTo(x, 3);
      expect(parseFloat(r[2]!)).toBeCloseTo(y, 3);
      expect(r[3]).toBe(f.side === 'bottom' ? 'Bottom' : 'Top');
      expect(Number(r[4])).toBe(f.rot ?? 0);
    }
  });

  it('takes LCSC part numbers from the parts, and checks them', () => {
    const smd = designators(files().bom).length;
    const lcscWarning = () => files().warnings.find((w) => w.includes('LCSC'));
    expect(lcscWarning()).toMatch(new RegExp(`^${smd} of ${smd} parts have no LCSC part number`));
    expect(ed.setLcsc('R1', 'x123')).toBe('An LCSC part number is C followed by digits, e.g. C25804');
    expect(ed.setLcsc('R1', ' c17414 ')).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'R1')!.attributes).toMatchObject({ LCSC: 'C17414' });
    expect(files().bom).toContainEqual(['3.3M', 'R1', '0805', 'C17414', '1', '', '', 'SMD']);
    expect(lcscWarning()).toMatch(new RegExp(`^${smd - 1} of ${smd}`));
    // The parts still without one are named (R1 no longer, in name order).
    const named = lcscWarning()!.slice(lcscWarning()!.lastIndexOf(': ') + 2).split(', ');
    expect(named).toEqual(designators(files().bom).filter((n) => n !== 'R1').sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    // Kept through export to Eagle (a part attribute) and back.
    const back = importEagle([...exportEagle(p).files].map(([name, text]) => ({ name, file: parseEagle(text) })), 'D').project;
    expect(back.parts.find((x) => x.name === 'R1')!.attributes?.LCSC).toBe('C17414');
    expect(ed.setLcsc('R1', '')).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'R1')!.attributes).toEqual({ BLOCK: 'Preamp' });
  });

  it('takes a component\'s default LCSC part number from the library, unless the part has its own', () => {
    const index = new ProjectIndex(p);
    const q2 = index.parts.get('Q2')!;
    const c = index.components.get(q2.component)!;
    const v = index.variantOf(q2)!;
    expect(ed.setVariantLcsc(c, v, q2.technology ?? '', 'c20526')).toBeUndefined();
    expect(files().bom.find((r) => r[1] === 'Q2')![3]).toBe('C20526');
    ed.setLcsc('Q2', 'C2145');
    expect(files().bom.find((r) => r[1] === 'Q2')![3]).toBe('C2145');
    // Removing the default drops a technology left empty, as an import would store it.
    ed.setLcsc('Q2', '');
    const before = structuredClone(v);
    ed.setVariantLcsc(c, v, q2.technology ?? '', '');
    expect(v.technologies?.[q2.technology ?? '']?.LCSC).toBeUndefined();
    ed.undo();
    expect(v).toEqual(before);
  });
});

describe('a library component\'s default LCSC part number', () => {
  it('is a technology attribute, kept through export to an Eagle library and back', () => {
    const f = readLibrary(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'madhu.ospreylib'), 'utf8'));
    const ed = new Editor(libraryProject(f), () => {});
    const c = f.library.components.find((x) => x.id === 'madhu/2N3904')!;
    const v = c.variants[0]!;
    expect(v.technologies).toBeUndefined();
    expect(ed.setVariantLcsc(c, v, '', 'C20526')).toBeUndefined();
    expect(v.technologies).toEqual({ '': { LCSC: 'C20526' } });
    expect(ed.setVariantLcsc(c, v, '', 'nope')).toMatch(/C followed by digits/);
    const back = importLibraryFile(`${f.name}.lbr`, parseEagle(exportEagleLibrary(f)));
    expect(back.library.components.find((x) => x.id === 'madhu/2N3904')!.variants[0]!.technologies).toEqual({ '': { LCSC: 'C20526' } });
    // Removed again: no technologies stored, so the library is as it was.
    const text = writeLibrary(readLibrary(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'madhu.ospreylib'), 'utf8')));
    ed.setVariantLcsc(c, v, '', '');
    expect(writeLibrary(f)).toBe(text);
  });
});
