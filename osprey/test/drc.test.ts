// Design-rule check: the sample is clean; each kind of violation is found where it is made;
// .dru files load as undoable edits and survive an Eagle round trip.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { Transaction } from '../src/edit/ops';
import { applyDru } from '../src/edit/rules';
import { anchors } from '../src/edit/route';
import { drc } from '../src/model/drc';
import { exportEagle } from '../src/model/export-eagle';
import { readProject, writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';
import { DesignRules, designRules, parseDru } from '../src/model/rules';
import type * as O from '../src/model/types';

const samples = join(__dirname, '..', 'samples');
const ORIGINAL = readFileSync(join(samples, 'osprey', 'TA7358A.osprey'), 'utf8');
const DRU = readFileSync(join(samples, 'eagle', 'oshpark-2layer.dru'), 'utf8');

let p: O.Project;
beforeEach(() => {
  p = readProject(ORIGINAL);
});

const net = (name: string) => p.nets.find((n) => n.name === name)!;
const kinds = () => drc(p).violations.map((v) => v.kind);

describe('the sample board', () => {
  it('passes its own rules (OSH Park 2-layer)', () => {
    const r = drc(p);
    expect(r.rules.name).toBe('oshpark-2layer');
    expect(r.checked).toBeGreaterThan(100);
    expect(r.violations).toEqual([]);
  });
});

describe('violations', () => {
  /** A pad of `netName` and a point beside it at `gap` mm from its copper (pads are 0805 SMDs or round). */
  const padOf = (netName: string) => anchors(p).find((a) => a.net === netName && a.kind === 'pad')!;

  it('a trace of another net crossing a pad is a short', () => {
    const pad = padOf('N$1');
    net('GND').traces!.push({ line: [[pad.at[0] - 3, pad.at[1]], [pad.at[0] + 3, pad.at[1]]], width: 0.254, layer: pad.layers[0]! });
    const v = drc(p).violations.find((x) => x.kind === 'overlap')!;
    expect(v.nets.sort()).toEqual(['GND', 'N$1']);
    expect(v.message).toMatch(/^Short: wire on GND and pad .* \(N\$1\) touch/);
    expect(Math.hypot(v.at[0] - pad.at[0], v.at[1] - pad.at[1])).toBeLessThan(1.5);
  });

  it('two traces closer than the wire–wire rule', () => {
    const rules = drc(p).rules;
    const w = rules.clearance('wire', 'wire'); // 6 mil
    const gapMm = w / 2;
    const y = -20;
    net('GND').traces!.push({ line: [[0, y], [10, y]], width: 0.254, layer: 'copper.top' });
    net('VCC').traces = [{ line: [[0, y + 0.254 + gapMm], [10, y + 0.254 + gapMm]], width: 0.254, layer: 'copper.top' }];
    const v = drc(p).violations.filter((x) => x.kind === 'clearance');
    expect(v).toHaveLength(1);
    expect(v[0]!.actual).toBeCloseTo(gapMm, 6);
    expect(v[0]!.required).toBeCloseTo(w, 6);
    // On different layers there's no conflict.
    net('VCC').traces![0]!.layer = 'copper.bottom';
    expect(kinds()).not.toContain('clearance');
  });

  it('a trace exactly at the clearance passes', () => {
    const w = new DesignRules(designRules(p)).clearance('wire', 'wire');
    net('GND').traces!.push({ line: [[0, -20], [10, -20]], width: 0.254, layer: 'copper.top' });
    net('VCC').traces = [{ line: [[0, -20 + 0.254 + w], [10, -20 + 0.254 + w]], width: 0.254, layer: 'copper.top' }];
    expect(kinds()).not.toContain('clearance');
  });

  it('a trace narrower than the minimum width', () => {
    net('GND').traces!.push({ line: [[0, -20], [10, -20]], width: 0.1, layer: 'copper.top' });
    const v = drc(p).violations.find((x) => x.kind === 'width')!;
    expect(v.required).toBeCloseTo(6 * 0.0254, 6);
    expect(v.at).toEqual([5, -20]);
  });

  it('a via drill below the minimum', () => {
    net('GND').vias!.push({ at: [5, -20], drill: 0.2 });
    expect(drc(p).violations.find((x) => x.kind === 'drill')?.message).toMatch(/via on GND/);
  });

  it('copper too close to the board outline', () => {
    // The outline's left edge is at x = 0: a trace 0.2 mm inside it (15 mil rule).
    net('GND').traces!.push({ line: [[0.2 + 0.127, 10], [0.2 + 0.127, 20]], width: 0.254, layer: 'copper.top' });
    const v = drc(p).violations.find((x) => x.kind === 'dimension')!;
    expect(v.actual).toBeCloseTo(0.2, 3);
    expect(v.message).toMatch(/board edge/);
  });

  it('pads on no net still keep their distance', () => {
    const pad = padOf('N$1');
    // A via of GND right next to the pad.
    net('GND').vias!.push({ at: [pad.at[0], pad.at[1]], drill: 0.35 });
    expect(kinds()).toContain('overlap');
  });
});

describe('.dru files', () => {
  it('parses parameters and the description', () => {
    const dru = parseDru(DRU);
    expect(dru.description).toMatch(/^<b>OSH Park Design Rules<\/b>\n/);
    expect(new Map(dru.params).get('mdWireWire')).toBe('6mil');
    expect(new Map(dru.params).get('msDrill')).toBe('10mil');
    expect(() => parseDru('nothing here')).toThrow();
  });

  it('loading rules is undoable and changes what DRC checks', () => {
    const editor = new Editor(p, () => {});
    const strict = DRU.replace('msWidth = 6mil', 'msWidth = 20mil');
    expect(editor.loadRules('strict', parseDru(strict))).toBeUndefined();
    expect(designRules(p).get('@name')).toBe('strict');
    expect(drc(p).violations.filter((v) => v.kind === 'width').length).toBeGreaterThan(0); // 10 mil traces
    expect(editor.history.undoLabel).toBe('Load design rules strict');
    editor.undo();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('loading merges: the file\'s values win, parameters it doesn\'t mention are kept', () => {
    const before = designRules(p);
    const tx = new Transaction('');
    // The same rules: every value the board had stays (the file adds checkGrid).
    applyDru(p, 'oshpark-2layer', parseDru(DRU), tx);
    const after = designRules(p);
    // (Numbers may be written differently: "0.5" on the board, "0.500000" in the file.)
    const same = (a: string | undefined, b: string) => (Number.isFinite(Number(b)) && b !== '' ? Number(a) === Number(b) : a === b);
    for (const [k, v] of before) expect(same(after.get(k), v), k).toBe(true);
    expect(after.get('checkGrid')).toBe('0');
    // A file that changes one value and doesn't mention a newer check flag.
    applyDru(p, 'tight', parseDru('mdWireWire = 4mil\nmsWidth = 4mil'), tx);
    expect(designRules(p).get('mdWireWire')).toBe('4mil');
    expect(designRules(p).get('checkWireStubs')).toBe(before.get('checkWireStubs'));
    tx.revert();
    expect(writeProject(p)).toBe(ORIGINAL);
  });

  it('a project without rules gets them; they survive an Eagle round trip', () => {
    delete p.eagle;
    expect(designRules(p).size).toBe(0);
    const tx = new Transaction('');
    applyDru(p, 'oshpark-2layer', parseDru(DRU.replace('mdWireWire = 6mil', 'mdWireWire = 7mil')), tx);
    expect(designRules(p).get('mdWireWire')).toBe('7mil');
    const files = exportEagle(p).files;
    const back = importEagle([...files].map(([n, text]) => ({ name: n, file: parseEagle(text) })), '2026-11-09').project;
    expect(designRules(back).get('mdWireWire')).toBe('7mil');
    expect(designRules(back).get('@name')).toBe('oshpark-2layer');
  });
});

const corpus = process.env.OSPREY_CORPUS;
describe.skipIf(!corpus || !existsSync(corpus))('DRC corpus', () => {
  function* pairs(dir: string, depth = 0): Generator<[string, string]> {
    if (depth > 6) return;
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      try {
        if (statSync(f).isDirectory()) yield* pairs(f, depth + 1);
        else if (n.endsWith('.sch') && existsSync(f.replace(/\.sch$/, '.brd'))) yield [f, f.replace(/\.sch$/, '.brd')];
      } catch { /* skip */ }
    }
  }

  it('finds only the known violations (boards designed with Eagle\'s DRC)', () => {
    let boards = 0;
    let clean = 0;
    const totals: Record<string, number> = {};
    for (const [sch, brd] of pairs(corpus!)) {
      const proj = importEagle([
        { name: 'x.sch', file: parseEagle(readFileSync(sch, 'utf8')) },
        { name: 'x.brd', file: parseEagle(readFileSync(brd, 'utf8')) },
      ], '2026-11-09').project;
      const r = drc(proj);
      boards++;
      if (!r.violations.length) clean++;
      for (const v of r.violations) totals[v.kind] = (totals[v.kind] ?? 0) + 1;
    }
    // Reviewed by hand (2026-11-09): small vias on default rules, edge connectors near the
    // outline, tightly placed SOT packages and two touching pads. Poured copper adds nothing.
    expect({ boards, clean, totals }).toEqual({ boards: 152, clean: 145, totals: { drill: 3, dimension: 14, overlap: 2, clearance: 4 } });
  }, 600000);
});
