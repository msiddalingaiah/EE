// The schematic score (src/gen/score.ts): generated sheets measured against hand drawings, as
// a guard that changes to the generator don't make its drawings worse.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDescription, resolveDescription } from '../src/gen/description';
import { generateProject } from '../src/gen/layout';
import { compareSheets, placementError, scoreSheet, blocksOf } from '../src/gen/score';
import { readLibrary, readProject } from '../src/model/file';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const wwvbHand = readProject(read('samples', 'osprey', 'wwvbfind2.osprey'));
const subHand = readProject(read('samples', 'schematics', 'subcircuits-hand.osprey'));
const sources = [
  { name: 'wwvbfind2.osprey', library: wwvbHand.library },
  { name: 'madhu.ospreylib', library: readLibrary(read('samples', 'osprey', 'madhu.ospreylib')).library },
];

function generate(text: string) {
  const r = resolveDescription(parseDescription(text).description, sources);
  return generateProject(r.resolved!);
}

const total = (p: ReturnType<typeof generate>, blocks = blocksOf(p)) => {
  const s = scoreSheet(p, blocks);
  return { wire: s.reduce((a, b) => a + b.wire, 0), bends: s.reduce((a, b) => a + b.bends, 0), overlaps: s.reduce((a, b) => a + b.overlaps, 0) };
};

describe('schematic score', { timeout: 60000 }, () => {
  it('finds a drawing where it is: no distance from itself, and a table of every block', () => {
    for (const err of placementError(subHand, subHand).values()) expect(err).toBeCloseTo(0, 6);
    const table = compareSheets(subHand, subHand);
    for (const b of ['CE-amp', 'Divider', 'Inverting-amp', 'LC-tank', 'LED', 'RC-lowpass', 'total']) expect(table).toContain(b);
  });

  // Ceilings a little above what the generator draws today (wwvbfind2 by hand: 574 mm, 11
  // bends; the subcircuits: 599 mm, 21 bends): lower them as it improves.
  it('draws wwvbfind2 compactly, with no text over another part', () => {
    const t = total(generate(read('samples', 'blocks', 'wwvbfind2.blocks')));
    expect(t.wire).toBeLessThan(850);
    expect(t.bends).toBeLessThanOrEqual(40);
    expect(t.overlaps).toBe(0);
  });

  it('draws the subcircuits compactly', () => {
    const t = total(generate(read('samples', 'schematics', 'subcircuits.blocks')));
    expect(t.wire).toBeLessThan(950);
    expect(t.bends).toBeLessThanOrEqual(41);
    expect(t.overlaps).toBeLessThanOrEqual(1);
  });
});
