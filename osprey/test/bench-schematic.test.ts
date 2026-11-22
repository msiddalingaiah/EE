// Schematic generation against hand drawings: a benchmark over a folder of imported Eagle designs
// (.osprey files), set in OSPREY_BENCH_DIR. Skipped without it, so private designs stay out of
// the repo. For each single-sheet design: its parts, values, nets and blocks (the ones it has,
// else suggested) go to the generator as a resolved description, and the generated sheet is
// measured block by block against the hand drawing (gen/score.ts, as `osprey compare` does).
// Prints the totals and writes the rows as bench-schematic.json in the folder.
//
//   OSPREY_BENCH_DIR=<folder> npx vitest run test/bench-schematic.test.ts

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import type { Resolved, RNet, RPart } from '../src/gen/description';
import { generateProject } from '../src/gen/layout';
import { blocksOf, placementError, scoreSheet, type BlockScore } from '../src/gen/score';
import { ProjectIndex } from '../src/model/derive';
import { readProject } from '../src/model/file';
import type * as O from '../src/model/types';

const DIR = process.env.OSPREY_BENCH_DIR;

interface Totals {
  wire: number;
  wires: number;
  bends: number;
  overlaps: number;
  /** Sum of the blocks' areas (mm²). */
  area: number;
  /** Net labels on the sheet. */
  labels: number;
}
interface Row {
  design: string;
  parts: number;
  blocks: number;
  gen?: Totals;
  hand?: Totals;
  /** Mean distance of parts from where the hand drawing has them, within their block (mm). */
  off?: number;
  ms?: number;
  skipped?: string;
  error?: string;
}

/** The design as the generator takes it: parts with their blocks, nets, and supply symbols by net. */
export function resolvedOf(p: O.Project): Resolved {
  const index = new ProjectIndex(p);
  const pinsOf = (c: O.Component) => c.gates.flatMap((g) => index.symbols.get(g.symbol)?.pins ?? []);
  const supplyPart = new Set<string>();
  const supplies: Resolved['supplies'] = new Map();
  for (const part of p.parts) {
    const c = index.components.get(part.component);
    if (!c) continue;
    const pins = pinsOf(c);
    if (pins.length === 1 && pins[0]!.direction === 'supply') supplyPart.add(part.name);
  }
  const parts: RPart[] = [];
  for (const part of p.parts) {
    const c = index.components.get(part.component);
    if (!c || supplyPart.has(part.name) || !pinsOf(c).length) continue;
    parts.push({ part: structuredClone(part), component: c, source: p.library, block: part.attributes?.BLOCK ?? '', line: 0 });
  }
  const placed = new Set(parts.map((x) => x.part.name));
  const blockOf = new Map(parts.map((x) => [x.part.name, x.block]));
  const nets: RNet[] = [];
  for (const n of p.nets) {
    const all = (n.segments ?? []).flatMap((s) => s.pins);
    const symbol = all.find((r) => supplyPart.has(r.part));
    if (symbol) {
      const c = index.components.get(index.parts.get(symbol.part)!.component)!;
      if (!supplies.has(n.name)) supplies.set(n.name, { component: c, source: p.library });
    }
    const seen = new Set<string>();
    const pins = all.filter((r) => placed.has(r.part) && !seen.has(`${r.part}.${r.gate}.${r.pin}`) && seen.add(`${r.part}.${r.gate}.${r.pin}`));
    if (!pins.length) continue;
    nets.push({ name: n.name, supply: !!symbol, named: !/^N\$\d+$/.test(n.name), pins, blocks: new Set(pins.map((r) => blockOf.get(r.part)!)) });
  }
  return { name: p.project.name, blocks: [...new Set(parts.map((x) => x.block))].sort(), parts, nets, supplies };
}

function totals(scores: BlockScore[], p: O.Project): Totals {
  const t = { wire: 0, wires: 0, bends: 0, overlaps: 0, area: 0, labels: 0 };
  for (const s of scores) {
    t.wire += s.wire;
    t.wires += s.wires;
    t.bends += s.bends;
    t.overlaps += s.overlaps;
    t.area += s.width * s.height;
  }
  const sheet = p.schematic!.sheets[0]!.id;
  for (const n of p.nets) for (const s of n.segments ?? []) if (s.sheet === sheet) t.labels += s.labels?.length ?? 0;
  return t;
}

describe.skipIf(!DIR || !existsSync(DIR))('schematic generation benchmark', () => {
  it('generates every single-sheet design', () => {
    const rows: Row[] = [];
    for (const f of readdirSync(DIR!).filter((f) => f.endsWith('.osprey')).sort()) {
      const hand = readProject(readFileSync(join(DIR!, f), 'utf8'));
      const row: Row = { design: f.replace(/\.osprey$/, ''), parts: hand.parts.length, blocks: 0 };
      rows.push(row);
      const sheets = hand.schematic?.sheets.length ?? 0;
      if (sheets !== 1) {
        row.skipped = `${sheets} sheets`;
        continue;
      }
      try {
        // Blocks as the design has them, else suggested (the import gives none).
        if (hand.parts.some((x) => !x.attributes?.BLOCK)) new Editor(hand, () => {}).suggestBlocks();
        const design = resolvedOf(hand);
        row.parts = design.parts.length;
        row.blocks = design.blocks.length;
        const t = performance.now();
        const gen = generateProject(design);
        row.ms = performance.now() - t;
        row.gen = totals(scoreSheet(gen), gen);
        row.hand = totals(scoreSheet(hand, blocksOf(gen)), hand);
        const err = placementError(gen, hand);
        const sizes = new Map<string, number>();
        for (const x of design.parts) sizes.set(x.block, (sizes.get(x.block) ?? 0) + 1);
        let off = 0;
        let n = 0;
        for (const [b, e] of err) {
          off += e * (sizes.get(b) ?? 0);
          n += sizes.get(b) ?? 0;
        }
        row.off = n ? off / n : 0;
      } catch (e) {
        row.error = String(e).slice(0, 200);
      }
    }
    writeFileSync(join(DIR!, 'bench-schematic.json'), JSON.stringify(rows, null, 1));
    const ok = rows.filter((r) => r.gen && r.hand);
    const sum = (k: keyof Totals, w: 'gen' | 'hand') => ok.reduce((s, r) => s + r[w]![k], 0);
    const lines = [
      `${ok.length} generated, ${rows.filter((r) => r.error).length} failed, ${rows.filter((r) => r.skipped).length} skipped (several sheets)`,
      ...(['wire', 'wires', 'bends', 'overlaps', 'area', 'labels'] as const).map((k) => `${k.padEnd(9)} generated ${sum(k, 'gen').toFixed(0).padStart(7)}  hand ${sum(k, 'hand').toFixed(0).padStart(7)}`),
    ];
    console.log(lines.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 600_000);
});
