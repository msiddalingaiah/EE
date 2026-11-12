// The placement score, against a benchmark: the wwvbfind sample as laid out by hand must score
// better than the placement the toolkit made of it before (commit bb0e3c8: arranged, then
// improved by small moves), which had shorter airwires and fewer crossings but needed a board
// 27% bigger, with parts out of line.

import { describe, expect, it } from 'vitest';
import { readProject } from '../src/model/file';
import {
  DEFAULT_PLACEMENT_RULES, misalignment, partClearance, placementIssues, placementScore, supplyNets,
} from '../src/model/placement';
import type * as O from '../src/model/types';
import { unroutedSample } from './unrouted';

const SAMPLE = unroutedSample('wwvbfind');

/** The toolkit's placement (bb0e3c8), connectors under their names of today, on its 47 x 30 mm board. */
const TOOLKIT: [string, number, number, number][] = [
  ['VCC', 8.998, 1.85, 180], ['C1', 13.592, 1.85, 0], ['IN', 1.85, 15, 270], ['R1', 4.1, 15.18, 90],
  ['Q1', 10.53, 15.63, 180], ['R2', 11.99, 12.11, 0], ['Q2', 17.67, 15.7, 0], ['R5', 18.37, 12.7, 90],
  ['R6', 18.37, 9.42, 90], ['C3', 19.82, 9.49, 270], ['C4', 25.77, 22.53, 270], ['L1', 21.03, 21.58, 270],
  ['C5', 25.76, 19.02, 270], ['R7', 25.98, 16.87, 0], ['R8', 26.27, 14.29, 270], ['C6', 26.72, 10.79, 270],
  ['R9', 29.44, 11.48, 0], ['R10', 15.27, 13.43, 90], ['C7', 14.34, 16.84, 90], ['U1', 31.43, 14.87, 270],
  ['C8', 29.78, 18.29, 0], ['UPDI', 33, 28.15, 0], ['U2', 37.77, 15.64, 180], ['R11', 40.37, 16.4, 270],
  ['X1', 43.96, 14.89, 270], ['R12', 40.52, 13.36, 90], ['C9', 39.23, 19.04, 180], ['C10', 39.441, 10.73, 180],
  ['C11', 38.17, 13.19, 0], ['R13', 31.8, 9.76, 0], ['C12', 35.51, 6.72, 90], ['C13', 37.73, 4.05, 0],
  ['VOUT', 39, 1.85, 180], ['R14', 28.72, 8.72, 270], ['D1', 29.66, 6.43, 180],
];

function toolkitPlacement(): O.Project {
  const p = readProject(SAMPLE);
  const board = p.board!;
  board.footprints = TOOLKIT.map(([part, x, y, rot]) => ({ part, at: [x, y] as O.Pt, ...(rot ? { rot } : {}) }));
  const W = 47;
  const H = 30;
  board.drawing = [
    ...[[[0, 0], [W, 0]], [[W, 0], [W, H]], [[W, H], [0, H]], [[0, H], [0, 0]]].map((line) => ({ line: line as [O.Pt, O.Pt], width: 0, layer: 'outline' })),
    ...[[2.54, 2.54], [W - 2.54, 2.54], [2.54, H - 2.54], [W - 2.54, H - 2.54]].map((h) => ({ hole: h as O.Pt, drill: 3.175 })),
  ];
  return p;
}

describe('the placement score', () => {
  it('ranks the hand layout above the toolkit placement', () => {
    const hand = placementScore(readProject(SAMPLE));
    const toolkit = placementScore(toolkitPlacement());
    expect(hand.total).toBeLessThan(toolkit.total);
    // Where the hand layout wins: a smaller board, and parts in rows and columns.
    expect(hand.area).toBeLessThan(0.7 * toolkit.area);
    expect(hand.misalignment).toBeLessThan(0.5 * toolkit.misalignment);
  });

  it('leaves supply nets aside: ground, and nets named by supply symbols or power pins', () => {
    const p = readProject(SAMPLE);
    const supplies = supplyNets(p);
    expect(supplies.has('GND')).toBe(true);
    expect(supplies.has('VCC')).toBe(true);
    expect(supplies.has('AUDIO')).toBe(false);
    expect(supplies.has('CLK')).toBe(false);
  });

  it('counts a part on a neighbour\'s row or column as lined up', () => {
    // Three in a row: lined up.
    expect(misalignment([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }])).toBe(0);
    // One 0.3 mm off: it and its nearest neighbour are both 0.3 off.
    expect(misalignment([{ x: 0, y: 0 }, { x: 2, y: 0.3 }])).toBeCloseTo(0.6);
    // Far apart: nothing to line up with, so each counts in full.
    expect(misalignment([{ x: 0, y: 0 }, { x: 20, y: 7 }])).toBe(2);
  });
});

describe('placement clearances', () => {
  it('lets SMD parts sit closer than through-hole parts', () => {
    const r = DEFAULT_PLACEMENT_RULES;
    expect(partClearance(r, { smd: true }, { smd: true })).toBe(0.15);
    expect(partClearance(r, { smd: true }, { smd: false })).toBe(0.15);
    expect(partClearance(r, { smd: false }, { smd: false })).toBe(0.25);
  });

  it('accepts the hand layout\'s 0.16 mm gaps beside SMD parts', () => {
    expect(placementIssues(readProject(SAMPLE))).toEqual([]);
  });
});
