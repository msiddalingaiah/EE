// Placing vias on their own (e.g. stitching a pour): the net comes from the copper under the
// cursor, the drill from the board, and clearance is checked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { anchors, DEFAULT_VIA_DRILL, viaDrill } from '../src/edit/route';
import { readProject, writeProject } from '../src/model/file';
import { inIsland, pourFills } from '../src/model/pour';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
});

const net = (name: string) => p.nets.find((n) => n.name === name)!;
const grid = () => 0.127;

/** A grid point well inside a pour's copper, clear of everything else. */
function inPour(name: string): { x: number; y: number } {
  const f = [...pourFills(p).values()].find((x) => x.net === name)!;
  const s = editor.beginVias(grid)!;
  for (let y = 2; y < 35; y += 0.635) {
    for (let x = 2; x < 35; x += 0.635) {
      if (!f.islands.some((isl) => inIsland(isl, { x, y }))) continue;
      s.moveTo({ x, y }, false, 0.01);
      if (s.over?.net === name && !s.snapped && s.conflicts.length === 0) return s.at;
    }
  }
  throw new Error(`no free spot in the ${name} pour`);
}

describe('placing vias', () => {
  it("defaults to Eagle's usual drill (0.35 mm) on a board without vias", () => {
    expect(DEFAULT_VIA_DRILL).toBe(0.35);
    for (const n of p.nets) delete n.vias;
    expect(viaDrill(p, 'GND')).toBe(0.35);
  });

  it("a click in a pour adds a via on the pour's net, as one undo step", () => {
    const at = inPour('GND');
    const before = net('GND').vias?.length ?? 0;
    const s = editor.beginVias(grid)!;
    s.moveTo(at, false, 0.01);
    expect(s.net).toBe('GND');
    expect(s.click()).toBe('placed');
    expect(net('GND').vias).toHaveLength(before + 1);
    expect(net('GND').vias!.at(-1)).toEqual({ at: [at.x, at.y], drill: viaDrill(p, 'GND') });
    expect(editor.history.undoLabel).toBe('Via on GND');
    // A second click on the same spot adds nothing.
    expect(s.click()).toBe('exists');
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it("snaps onto a pad and takes its net", () => {
    const pad = anchors(p).find((a) => a.kind === 'pad' && a.net === 'N$1')!;
    const s = editor.beginVias(grid)!;
    s.moveTo({ x: pad.at[0] + 0.1, y: pad.at[1] }, false, 0.3);
    expect(s.snapped).toBe(true);
    expect(s.at).toEqual({ x: pad.at[0], y: pad.at[1] });
    expect(s.net).toBe('N$1');
  });

  it('refuses a via that breaks clearance unless forced', () => {
    // Beside a pad of another net, on the edge of its copper.
    const pad = anchors(p).find((a) => a.kind === 'pad' && a.net === 'N$1')!;
    const s = editor.beginVias(grid)!;
    // Step out from the pad until off its copper (another net there), still too close to it.
    for (let dx = 0; dx < 3; dx += 0.127) {
      s.moveTo({ x: pad.at[0] + dx, y: pad.at[1] }, false, 0.01);
      if (s.net !== 'N$1' && s.conflicts.length) break;
    }
    expect(s.net).not.toBe('N$1');
    expect(s.conflicts.length).toBeGreaterThan(0);
    const n = net(s.net!).vias?.length ?? 0;
    expect(s.click()).toBe('blocked');
    expect(net(s.net!).vias?.length ?? 0).toBe(n);
    expect(s.click(true)).toBe('placed');
    expect(net(s.net!).vias).toHaveLength(n + 1);
  });

  it('away from copper, uses the last via\'s net', () => {
    const at = inPour('VCC');
    const s = editor.beginVias(grid)!;
    s.moveTo(at, false, 0.01);
    expect(s.click()).toBe('placed');
    // Outside the board: no copper there.
    s.moveTo({ x: -5, y: -5 }, false, 0.01);
    expect(s.over).toBeUndefined();
    expect(s.net).toBe('VCC');
  });
});
