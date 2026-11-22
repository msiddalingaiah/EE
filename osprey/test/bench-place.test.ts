// Autoplace against hand layouts: a benchmark over a folder of imported, hand-placed boards
// (.osprey files), set in OSPREY_BENCH_DIR. Skipped without it, so private designs stay out of
// the repo. For each board: take the routing out, score the hand placement, unlock every part,
// suggest blocks where there are none, autoplace, and score again. Prints a table and writes it
// as bench-place.json in the folder, to compare runs.
//
//   OSPREY_BENCH_DIR=../../private-bench npx vitest run test/bench-place.test.ts

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject } from '../src/model/file';
import { boardArea, footprintInfos, onBoard, placementIssues, placementScore } from '../src/model/placement';
import type * as O from '../src/model/types';

const DIR = process.env.OSPREY_BENCH_DIR;

interface Row {
  board: string;
  parts: number;
  hand: Summary;
  auto?: Summary & { issues: number; issueKinds: Record<string, number>; ms: number };
  error?: string;
}
interface Summary {
  total: number;
  length: number;
  crossings: number;
  area: number;
  misalignment: number;
  outline: number;
  /** Parts not touching the outline. */
  off: number;
}

function summary(p: O.Project): Summary {
  const s = placementScore(p);
  const a = p.board && boardArea(p.board);
  const outline = a ? (a.outline.maxX - a.outline.minX) * (a.outline.maxY - a.outline.minY) : 0;
  const off = a ? footprintInfos(p).filter((f) => !onBoard(f.box, a.outline)).length : 0;
  return { total: s.total, length: s.signalLength, crossings: s.signalCrossings, area: s.area, misalignment: s.misalignment, outline, off };
}

function unrouted(p: O.Project) {
  for (const n of p.nets) {
    delete n.traces;
    delete n.vias;
    delete n.pours;
  }
  for (const f of p.board?.footprints ?? []) delete f.locked;
}

const r0 = (x: number) => x.toFixed(0).padStart(6);

describe.skipIf(!DIR || !existsSync(DIR))('autoplace benchmark', () => {
  it('places every board', () => {
    const rows: Row[] = [];
    for (const f of readdirSync(DIR!).filter((f) => f.endsWith('.osprey')).sort()) {
      const p = readProject(readFileSync(join(DIR!, f), 'utf8'));
      if (!p.board?.footprints.length) continue;
      unrouted(p);
      const row: Row = { board: f.replace(/\.osprey$/, ''), parts: p.board.footprints.length, hand: summary(p) };
      try {
        const editor = new Editor(p, () => {});
        editor.suggestBlocks();
        const t = performance.now();
        editor.autoplace();
        const ms = performance.now() - t;
        const issues = placementIssues(p);
        const issueKinds: Record<string, number> = {};
        for (const i of issues) issueKinds[i.kind] = (issueKinds[i.kind] ?? 0) + 1;
        row.auto = { ...summary(p), issues: issues.length, issueKinds, ms };
      } catch (e) {
        row.error = String(e);
      }
      rows.push(row);
    }
    writeFileSync(join(DIR!, 'bench-place.json'), JSON.stringify(rows, null, 1));

    const lines = [`${'board'.padEnd(34)} parts   hand   auto  ratio   len(h/a)   x(h/a)  area mm² (h/a)  mis(h/a) issues`];
    for (const r of rows) {
      const a = r.auto;
      lines.push(
        a
          ? `${r.board.padEnd(34)} ${String(r.parts).padStart(5)} ${r0(r.hand.total)} ${r0(a.total)} ${(a.total / r.hand.total).toFixed(2).padStart(6)} ${r0(r.hand.length)}/${r0(a.length).trim()} ${String(r.hand.crossings).padStart(4)}/${a.crossings} ${r0(r.hand.area)}/${r0(a.area).trim()} ${r0(r.hand.misalignment)}/${r0(a.misalignment).trim()} ${a.issues}`
          : `${r.board.padEnd(34)} ${String(r.parts).padStart(5)} ${r0(r.hand.total)}  ERROR ${r.error}`,
      );
    }
    const ok = rows.filter((r) => r.auto);
    const ratios = ok.map((r) => r.auto!.total / r.hand.total).sort((a, b) => a - b);
    lines.push(
      `${ok.length} placed, ${rows.length - ok.length} failed; auto beats hand on ${ratios.filter((x) => x < 1).length}; median ratio ${ratios[Math.floor(ratios.length / 2)]?.toFixed(2)}`,
    );
    console.log(lines.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 600_000);
});
