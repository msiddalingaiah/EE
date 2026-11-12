// Making a placement legal: move parts the least needed so none overlap each other, the mounting
// holes or the board edge (with the clearances of PlacementRules), keeping their arrangement.
//
// Each round, every conflict pushes its parts apart along the axis that needs the smaller move:
// both halfway when both can move, the movable one all the way otherwise; the board edge pulls
// parts back in. Moves only translate, so footprint boxes are computed once and shifted.

import { ProjectIndex } from '../model/derive';
import type { FootprintInfo, PlacementIssue, PlacementRules, Rect } from '../model/placement';
import { boardArea, DEFAULT_PLACEMENT_RULES, footprintInfos, onBoard, partClearance, placementIssues, TOLERANCE } from '../model/placement';
import type * as O from '../model/types';
import type { Transaction } from './ops';
import { transformTargets, translation } from './transform';

export interface LegalizeResult {
  /** Parts moved, with how far (mm). */
  moved: { part: string; dx: number; dy: number }[];
  /** Conflicts left (e.g. among locked parts, or a board too small). */
  issues: PlacementIssue[];
}

const ROUNDS = 400;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Spread the board's parts apart until they meet the placement rules. `movable` limits which
 * parts may move (default: every unlocked part on the board); others stay put.
 */
export function legalize(
  project: O.Project, tx: Transaction,
  opts: { movable?: Iterable<string>; rules?: PlacementRules; index?: ProjectIndex } = {},
): LegalizeResult {
  const rules = opts.rules ?? DEFAULT_PLACEMENT_RULES;
  const board = project.board;
  const area = board && boardArea(board);
  if (!board || !area) return { moved: [], issues: [] };
  const index = opts.index ?? new ProjectIndex(project);
  const infos = footprintInfos(project, index).filter((f) => onBoard(f.box, area.outline));
  const allowed = opts.movable ? new Set(opts.movable) : undefined;
  const canMove = (f: FootprintInfo) => !f.placement.locked && (!allowed || allowed.has(f.part));
  const off = infos.map(() => ({ x: 0, y: 0 }));
  const box = (i: number): Rect => {
    const b = infos[i]!.box;
    const o = off[i]!;
    return { minX: b.minX + o.x, minY: b.minY + o.y, maxX: b.maxX + o.x, maxY: b.maxY + o.y };
  };

  for (let round = 0; round < ROUNDS; round++) {
    const push = infos.map(() => ({ x: 0, y: 0 }));
    let conflicts = 0;
    const separate = (i: number, other: Rect, gap: number, share: number) => {
      // Smallest move of box i that puts `gap` between it and `other`; returns it, or undefined if clear.
      const a = box(i);
      const right = other.maxX + gap - a.minX; // move i right by this
      const left = a.maxX + gap - other.minX; // move i left by this
      const up = other.maxY + gap - a.minY;
      const down = a.maxY + gap - other.minY;
      if (right <= TOLERANCE / 2 || left <= TOLERANCE / 2 || up <= TOLERANCE / 2 || down <= TOLERANCE / 2) return false;
      const options: [number, number][] = [[right, 0], [-left, 0], [0, up], [0, -down]];
      options.sort((p, q) => Math.abs(p[0] + p[1]) - Math.abs(q[0] + q[1]));
      const [mx, my] = options[0]!;
      push[i]!.x += mx * share;
      push[i]!.y += my * share;
      return true;
    };
    for (let i = 0; i < infos.length; i++) {
      for (let j = i + 1; j < infos.length; j++) {
        const a = infos[i]!;
        const b = infos[j]!;
        if (a.smd && b.smd && (a.placement.side === 'bottom') !== (b.placement.side === 'bottom')) continue;
        const ma = canMove(a);
        const mb = canMove(b);
        if (!ma && !mb) continue;
        const share = ma && mb ? 0.5 : 1;
        // Push i away from j, and j by the opposite of i's move.
        const before = { ...push[i]! };
        if (!separate(i, box(j), partClearance(rules, a, b), 1)) continue;
        conflicts++;
        const mx = push[i]!.x - before.x;
        const my = push[i]!.y - before.y;
        push[i]!.x = before.x + (ma ? mx * share : 0);
        push[i]!.y = before.y + (ma ? my * share : 0);
        if (mb) {
          push[j]!.x -= mx * (ma ? share : 1);
          push[j]!.y -= my * (ma ? share : 1);
        }
      }
    }
    for (let i = 0; i < infos.length; i++) {
      if (!canMove(infos[i]!)) continue;
      for (const h of area.holes) if (separate(i, h, rules.edge, 1)) conflicts++;
      const b = box(i);
      const o = area.outline;
      const e = rules.edge;
      if (b.minX < o.minX + e) (push[i]!.x += o.minX + e - b.minX, conflicts++);
      if (b.maxX > o.maxX - e) (push[i]!.x -= b.maxX - (o.maxX - e), conflicts++);
      if (b.minY < o.minY + e) (push[i]!.y += o.minY + e - b.minY, conflicts++);
      if (b.maxY > o.maxY - e) (push[i]!.y -= b.maxY - (o.maxY - e), conflicts++);
    }
    if (!conflicts) break;
    // A little extra each round so pushes don't stall exactly at the clearance.
    for (let i = 0; i < infos.length; i++) {
      off[i]!.x += push[i]!.x * 1.05;
      off[i]!.y += push[i]!.y * 1.05;
    }
  }

  const moved: LegalizeResult['moved'] = [];
  infos.forEach((f, i) => {
    const o = off[i]!;
    if (Math.abs(o.x) < 1e-4 && Math.abs(o.y) < 1e-4) return;
    // Through the move command, so traces on the part's pads follow.
    const dx = r3(f.placement.at[0] + o.x) - f.placement.at[0];
    const dy = r3(f.placement.at[1] + o.y) - f.placement.at[1];
    transformTargets(project, [{ kind: 'footprint', footprint: f.placement }], translation(dx, dy), tx, index);
    tx.subjects.push(f.placement);
    moved.push({ part: f.part, dx: r3(dx), dy: r3(dy) });
  });
  return { moved, issues: placementIssues(project, rules, footprintInfos(project, index)) };
}
