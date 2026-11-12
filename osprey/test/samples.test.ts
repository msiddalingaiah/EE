// TA7358A.osprey is the import of the Eagle sample pair. This test keeps the two in step: it
// fails if the importer or writer would now produce something different. After an intended
// change, regenerate it with `npm run samples` and review the diff. (madhu.ospreylib is edited
// by hand in Osprey, so it is only checked, never regenerated.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { readLibrary, readProject, writeLibrary, writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';

const eagle = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');

/** Fixed import date, so the sample only changes when the design or the format does. */
const DATE = '2026-11-09';

it('samples/osprey/TA7358A.osprey is the import of the Eagle TA7358A pair', async () => {
  const { project, report } = importEagle([
    { name: 'TA7358A.sch', file: parseEagle(eagle('TA7358A.sch')) },
    { name: 'TA7358A.brd', file: parseEagle(eagle('TA7358A.brd')) },
  ], DATE);
  expect(report).toEqual([]);
  const text = writeProject(project);
  expect(writeProject(readProject(text))).toBe(text);
  await expect(text).toMatchFileSnapshot('../samples/osprey/TA7358A.osprey');
});

// madhu.ospreylib started as the import of madhu.lbr and is edited in Osprey since: it isn't
// regenerated, only checked to be a library file in the canonical layout.
it('samples/osprey/madhu.ospreylib is an Osprey library in the canonical layout', () => {
  const text = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'madhu.ospreylib'), 'utf8');
  const lib = readLibrary(text);
  expect(writeLibrary(lib)).toBe(text);
  expect(lib.name).toBe('madhu');
  // Every reference inside it resolves.
  const symbols = new Set(lib.library.symbols.map((s) => s.id));
  const footprints = new Set(lib.library.footprints.map((f) => f.id));
  for (const c of lib.library.components) {
    for (const g of c.gates) expect(symbols.has(g.symbol), `${c.id} gate ${g.name}`).toBe(true);
    for (const v of c.variants) if (v.footprint) expect(footprints.has(v.footprint), `${c.id} variant ${v.name}`).toBe(true);
  }
});
