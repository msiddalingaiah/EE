// Assembly files: the bill of materials and the pick-and-place list (JLCPCB's format).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { assemblyFiles } from '../src/cam/assembly';
import { parseEagle } from '../src/eagle/parse';
import { ProjectIndex } from '../src/model/derive';
import { exportEagle } from '../src/model/export-eagle';
import { readProject } from '../src/model/file';
import { padPosition } from '../src/model/geometry';
import { importEagle } from '../src/model/import-eagle';
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
const files = () => {
  const r = assemblyFiles(p);
  return { bom: csv(r.files.get('wwvbfind_BOM.csv')!), cpl: csv(r.files.get('wwvbfind_CPL.csv')!), warnings: r.warnings };
};

describe('assembly files', () => {
  it('lists every placed part once in each file, and nothing without a footprint', () => {
    const { bom, cpl } = files();
    const placed = p.board!.footprints.map((f) => f.part).sort();
    expect(bom[0]).toEqual(['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity', 'Manufacturer', 'MPN', 'Mounting']);
    expect(cpl[0]).toEqual(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']);
    const inBom = bom.slice(1).flatMap((r) => r[1]!.split(','));
    expect(inBom.sort()).toEqual(placed);
    expect(cpl.slice(1).map((r) => r[0]).sort()).toEqual(placed);
    // Quantities add up; supply symbols (GND, VCC) have no footprint and are left out.
    expect(bom.slice(1).reduce((n, r) => n + Number(r[4]), 0)).toBe(placed.length);
    expect(inBom.some((n) => n.startsWith('SUPPLY'))).toBe(false);
  });

  it('groups identical parts into one row', () => {
    const { bom } = files();
    expect(bom).toContainEqual(['10u', 'C1,C3,C7,C13', '0805', '', '4', '', '', 'SMD']);
    expect(bom).toContainEqual(['BERG-2', 'IN,VCC,VOUT', 'BERG-2', '', '3', '', '', 'THT']);
  });

  it('places each part at the centre of its pads, with its side and rotation', () => {
    const index = new ProjectIndex(p);
    const { cpl } = files();
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
    expect(files().warnings[0]).toMatch(/^35 of 35 parts have no LCSC part number/);
    expect(ed.setLcsc('R1', 'x123')).toBe('An LCSC part number is C followed by digits, e.g. C25804');
    expect(ed.setLcsc('R1', ' c17414 ')).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'R1')!.attributes).toEqual({ LCSC: 'C17414' });
    const { bom, warnings } = files();
    expect(bom).toContainEqual(['3.3M', 'R1', '0805', 'C17414', '1', '', '', 'SMD']);
    expect(warnings[0]).toMatch(/^34 of 35/);
    // Kept through export to Eagle (a part attribute) and back.
    const back = importEagle([...exportEagle(p).files].map(([name, text]) => ({ name, file: parseEagle(text) })), 'D').project;
    expect(back.parts.find((x) => x.name === 'R1')!.attributes?.LCSC).toBe('C17414');
    // Empty removes it.
    expect(ed.setLcsc('R1', '')).toBeUndefined();
    expect(p.parts.find((x) => x.name === 'R1')!.attributes).toBeUndefined();
  });

  it('marks parts on the bottom, and says to check their rotations', () => {
    const f = p.board!.footprints.find((x) => x.part === 'R1')!;
    ed.mirror([{ kind: 'footprint', footprint: f }], { x: f.at[0], y: f.at[1] }, 'Flip side');
    const { cpl, warnings } = files();
    expect(cpl.find((r) => r[0] === 'R1')![3]).toBe('Bottom');
    expect(warnings.join(' ')).toMatch(/on the bottom: check their rotations/);
  });
});
