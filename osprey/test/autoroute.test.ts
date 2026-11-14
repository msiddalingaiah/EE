// The basic autorouter: ground vias for SMD pads, signals on top (short bottom hops if blocked),
// VCC poured on top and GND on the bottom; everything clear by the design rules, one undo step.

import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { anchors } from '../src/edit/route';
import { drc } from '../src/model/drc';
import { boardArea, footprintInfos } from '../src/model/placement';
import { readProject, writeProject } from '../src/model/file';
import { unroutedSample } from './unrouted';

/** DRC problems other than unrouted connections, as messages. */
const problems = (p: ReturnType<typeof readProject>) => drc(p).violations.filter((v) => v.kind !== 'unrouted').map((v) => v.message);

describe('autoroute', () => {
  for (const name of ['wwvbfind', 'wwvbfind2-hand']) {
    it(`routes all of ${name}, adding no DRC problems`, () => {
      const text = unroutedSample(name);
      const p = readProject(text);
      const before = problems(p);
      const editor = new Editor(p, () => {});
      const r = editor.autoroute();
      expect(r.left).toEqual([]);
      expect(drc(p).violations.filter((v) => v.kind === 'unrouted')).toEqual([]);
      // Whatever DRC finds was there before (placement), not made by the routes.
      expect(problems(p).filter((m) => !before.includes(m))).toEqual([]);
      expect(r.pours).toEqual(['VCC on top', 'GND on bottom']);
      expect(editor.history.undoLabel).toBe('Autoroute');
      editor.undo();
      expect(writeProject(p)).toBe(text);
    });
  }

  it('gives every SMD ground pad its own via, and routes signals on top', () => {
    const p = readProject(unroutedSample('wwvbfind'));
    const smdGround = anchors(p).filter((a) => a.net === 'GND' && a.kind === 'pad' && a.layers.length === 1).length;
    const r = new Editor(p, () => {}).autoroute();
    expect(r.groundVias).toBe(smdGround);
    expect(p.nets.find((n) => n.name === 'GND')!.vias).toHaveLength(smdGround);
    // This board needs no bottom hops: signal traces all on top.
    for (const n of p.nets) for (const t of n.traces ?? []) expect(t.layer).toBe('copper.top');
  });

  it('hops under a wall on the top layer through two vias', () => {
    const p = readProject(unroutedSample('wwvbfind'));
    // A ground trace on top across the whole board, along the line that crosses fewest parts:
    // signals crossing it must go under it.
    const infos = footprintInfos(p);
    const o = boardArea(p.board!)!.outline;
    let x: number | undefined;
    let fewest = Infinity;
    for (let t = o.minX + 8; t < o.maxX - 8; t += 0.25) {
      const n = infos.filter((f) => f.box.maxX >= t - 0.6 && f.box.minX <= t + 0.6).length;
      if (n < fewest) (fewest = n), (x = t);
    }
    const gnd = p.nets.find((n) => n.name === 'GND')!;
    gnd.traces = [...(gnd.traces ?? []), { line: [[x!, o.minY], [x!, o.maxY]], width: 0.5, layer: 'copper.top' }];
    const before = problems(p);
    const r = new Editor(p, () => {}).autoroute();
    // Signals crossing the wall went under it, a short way, and nothing else broke.
    const bottom = p.nets.flatMap((n) => (n.traces ?? []).filter((t) => t.layer === 'copper.bottom').map((t) => ({ net: n.name, t })));
    expect(bottom.length).toBeGreaterThan(0);
    for (const { t } of bottom) expect(Math.min(t.line[0][0], t.line[1][0])).toBeLessThan(x! + 8);
    expect(problems(p).filter((m) => !before.includes(m))).toEqual([]);
    expect(r.routed).toBeGreaterThan(0);
  });

  it('keeps to the top layer when bottom hops are off', () => {
    const p = readProject(unroutedSample('wwvbfind2-hand'));
    new Editor(p, () => {}).autoroute({ maxBottomRun: 0 });
    for (const n of p.nets) for (const t of n.traces ?? []) expect(t.layer).toBe('copper.top');
  });
});
