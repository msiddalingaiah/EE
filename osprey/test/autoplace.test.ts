// Placing a board block by block (edit/autoplace.ts), on the wwvbfind sample with its routing
// taken out: every part placed with its clearances, the outline fitted around them, a score
// better than the hand layout's, and one undo step.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject, writeProject } from '../src/model/file';
import { boardArea, footprintInfos, onBoard, placementIssues, placementScore, SCORE_WEIGHTS } from '../src/model/placement';
import { unroutedSample } from './unrouted';

const SAMPLE = unroutedSample('wwvbfind');

function placed() {
  const p = readProject(SAMPLE);
  const editor = new Editor(p, () => {});
  const res = editor.autoplace();
  return { p, editor, res };
}

describe('autoplace', () => {
  it('places every part with its clearances, inside an outline fitted around them', () => {
    const { p, res } = placed();
    expect(res.parts).toBe(p.board!.footprints.length);
    expect(placementIssues(p)).toEqual([]);
    const area = boardArea(p.board!)!;
    expect(area.outline).toEqual({ minX: 0, minY: 0, maxX: res.width, maxY: res.height });
    expect(area.holes).toHaveLength(4);
  });

  it('scores better than the hand layout', () => {
    const { p } = placed();
    // Leaving out connectors on the edge, which Place doesn't aim for yet (the hand layout has
    // them there; Place's are up to a few mm in).
    const withoutEdge = (s: ReturnType<typeof placementScore>) => s.total - SCORE_WEIGHTS.connectorEdge * s.connectorEdge;
    const hand = withoutEdge(placementScore(readProject(SAMPLE)));
    expect(withoutEdge(placementScore(p))).toBeLessThan(hand);
    // Parts turned so signal airwires (almost) don't cross: the hand layout has none. Lining parts
    // up by their pads leaves one (N$2 over N$6) that lining them up by centres didn't.
    expect(placementScore(p).signalCrossings).toBeLessThanOrEqual(1);
  });

  it('places wwvbfind2, a changed design, with its clearances', () => {
    const p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind2.osprey'), 'utf8'));
    const res = new Editor(p, () => {}).autoplace();
    expect(res.parts).toBe(p.board!.footprints.length);
    expect(placementIssues(p)).toEqual([]);
  });

  // Found by placing old Eagle boards (test/bench-place.test.ts): parts at 45°, SMD parts on the
  // bottom in a block that gets turned, and every part on the board, none left where it was.
  it('places parts at 45° and on the bottom with their clearances, all on the board', () => {
    const p = readProject(SAMPLE);
    for (const f of p.board!.footprints) {
      if (f.part === 'R1' || f.part === 'R11') f.rot = 45;
      if (/^(C9|C10|C11|R12|R13|C12|C13|R14|D1)$/.test(f.part)) f.side = 'bottom';
    }
    new Editor(p, () => {}).autoplace();
    expect(placementIssues(p)).toEqual([]);
    for (const f of p.board!.footprints) expect((f.rot ?? 0) % 90, f.part).toBe(0);
    const area = boardArea(p.board!)!;
    for (const i of footprintInfos(p)) expect(onBoard(i.box, area.outline), i.part).toBe(true);
  });

  it('is one undo step, and gives the same placement every time', () => {
    const { p, editor } = placed();
    const once = writeProject(p);
    expect(writeProject(placed().p)).toBe(once);
    editor.undo();
    expect(writeProject(p)).toBe(SAMPLE);
  });
});
