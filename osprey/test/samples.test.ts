// The native samples are imports of the Eagle samples. This test keeps them in step: it fails
// if the importer or writer would now produce something different. After an intended change,
// regenerate them with `npm run samples` and review the diff.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { readProject, writeProject } from '../src/model/file';
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
