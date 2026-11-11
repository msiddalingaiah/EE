// A sample with its routing taken out (traces, vias and pours), for tests of placement and
// airwires that shouldn't depend on how far the sample has been routed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject, writeProject } from '../src/model/file';

export function unroutedSample(name: string): string {
  const p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', `${name}.osprey`), 'utf8'));
  for (const n of p.nets) {
    delete n.traces;
    delete n.vias;
    delete n.pours;
  }
  return writeProject(p);
}
