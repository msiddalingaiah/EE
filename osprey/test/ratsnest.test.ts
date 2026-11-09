import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { importEagle } from '../src/model/import-eagle';
import { ratsnest } from '../src/model/ratsnest';
import type { Project } from '../src/model/types';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
let p: Project;
beforeEach(() => {
  p = importEagle([
    { name: 'TA7358A.sch', file: parseEagle(raw('TA7358A.sch')) },
    { name: 'TA7358A.brd', file: parseEagle(raw('TA7358A.brd')) },
  ]).project;
});
const net = (name: string) => p.nets.find((n) => n.name === name)!;

describe('ratsnest', () => {
  it('has no airwires on a fully routed board (pours connect GND and VCC)', () => {
    expect(ratsnest(p)).toEqual([]);
  });

  it('a removed trace leaves one airwire, from the nearest copper to the pad', () => {
    // N$1 runs IC1 pad 4 (2.54, 13.97) → (3.821, 15.251) → C2 pad 2 (5.461, 15.251).
    net('N$1').traces!.pop();
    expect(ratsnest(p)).toEqual([{ net: 'N$1', from: [3.821, 15.251], to: [5.461, 15.251] }]);
  });

  it('an unrouted net of k pads gets k-1 airwires', () => {
    const n = p.nets.find((x) => x.name.startsWith('N$') && !x.pours && (x.segments ?? []).flatMap((s) => s.pins).length >= 3)!;
    delete n.traces;
    delete n.vias;
    const pins = (n.segments ?? []).flatMap((s) => s.pins).length;
    expect(ratsnest(p).filter((a) => a.net === n.name)).toHaveLength(pins - 1);
  });

  it('moving a part away from its traces creates airwires to it', () => {
    const c2 = p.board!.footprints.find((f) => f.part === 'C2')!;
    c2.at = [c2.at[0] + 5, c2.at[1]];
    const wires = ratsnest(p);
    expect(wires.length).toBeGreaterThan(0);
    // Every airwire lands on one of C2's moved pads (at x ≈ 10.46 ± pad offset) on one end.
    for (const w of wires) expect(Math.min(Math.abs(w.from[0] - 10.461), Math.abs(w.to[0] - 10.461))).toBeLessThan(1.5);
  });

  it('pours connect copper inside them; without the pour, GND needs airwires', () => {
    const gnd = net('GND');
    expect(gnd.pours?.length).toBeGreaterThan(0);
    delete gnd.pours;
    expect(ratsnest(p).some((a) => a.net === 'GND')).toBe(true);
  });
});
