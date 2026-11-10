// Showing and hiding airwires net by net.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProject } from '../src/model/file';
import { ratsnest } from '../src/model/ratsnest';
import { airwireNets, hideAirwires } from '../src/scene/airwires';
import { buildBoardScene } from '../src/scene/board';
import { AIRWIRES_LAYER } from '../src/scene/builder';

const p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind.osprey'), 'utf8'));
const scene = buildBoardScene(p, []);
const drawn = (s: typeof scene, net: string) => s.prims.filter((q) => q.layer === AIRWIRES_LAYER && s.owners.get(q.owner)?.net === net).length;

describe('airwires by net', () => {
  it('lists every net with airwires, and how many', () => {
    const nets = new Map(airwireNets(scene).map((a) => [a.net, a.count]));
    const expected = new Map<string, number>();
    for (const a of ratsnest(p)) expected.set(a.net, (expected.get(a.net) ?? 0) + 1);
    expect(nets).toEqual(expected);
    expect(nets.get('GND')).toBeGreaterThan(5);
  });

  it('hides the airwires of chosen nets, and still lists them', () => {
    const hidden = hideAirwires(scene, new Set(['GND', 'VCC']));
    expect(drawn(hidden, 'GND')).toBe(0);
    expect(drawn(hidden, 'VCC')).toBe(0);
    expect(drawn(hidden, 'ADC')).toBe(drawn(scene, 'ADC'));
    expect(airwireNets(hidden)).toEqual(airwireNets(scene));
    // Everything else is untouched.
    expect(hidden.prims.length).toBe(scene.prims.length - drawn(scene, 'GND') - drawn(scene, 'VCC'));
  });

  it('hiding nothing changes nothing', () => {
    expect(hideAirwires(scene, new Set())).toBe(scene);
  });
});
