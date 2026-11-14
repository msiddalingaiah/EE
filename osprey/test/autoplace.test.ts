// Placing a board block by block (edit/autoplace.ts), on the wwvbfind sample with its routing
// taken out: every part placed with its clearances, the outline fitted around them, a score
// better than the hand layout's, and one undo step.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject, writeProject } from '../src/model/file';
import { boardArea, placementIssues, placementScore } from '../src/model/placement';
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
    const hand = placementScore(readProject(SAMPLE)).total;
    expect(placementScore(p).total).toBeLessThan(hand);
  });

  it('places wwvbfind2, a changed design, with its clearances', () => {
    const p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind2.osprey'), 'utf8'));
    const res = new Editor(p, () => {}).autoplace();
    expect(res.parts).toBe(p.board!.footprints.length);
    expect(placementIssues(p)).toEqual([]);
  });

  it('is one undo step, and gives the same placement every time', () => {
    const { p, editor } = placed();
    const once = writeProject(p);
    expect(writeProject(placed().p)).toBe(once);
    editor.undo();
    expect(writeProject(p)).toBe(SAMPLE);
  });
});
