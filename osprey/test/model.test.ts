import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import type { Board } from '../src/eagle/types';
import { netPads, ProjectIndex } from '../src/model/derive';
import { OspreyFormatError, readProject, writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';
import { layerName, layerNumber } from '../src/model/layers';
import { ratsnest } from '../src/model/ratsnest';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const importSample = () =>
  importEagle(
    [
      { name: 'TA7358A.sch', file: parseEagle(raw('TA7358A.sch')) },
      { name: 'TA7358A.brd', file: parseEagle(raw('TA7358A.brd')) },
    ],
    '2026-11-09',
  );

/** Board contactrefs per signal, as "element\0pad". */
function boardPads(b: Board): Map<string, Set<string>> {
  return new Map(b.signals.map((s) => [s.name, new Set(s.contactrefs.map((c) => `${c.element}\u0000${c.pad}`))]));
}

/** Do the derived net pads match the board's own contactrefs, for every net? */
function padsMatch(derived: Map<string, Set<string>>, board: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  for (const name of new Set([...derived.keys(), ...board.keys()])) {
    const a = [...(derived.get(name) ?? [])].sort().join(',');
    const b = [...(board.get(name) ?? [])].sort().join(',');
    if (a !== b) problems.push(`${name}: derived {${a.replace(/\u0000/g, ':')}} board {${b.replace(/\u0000/g, ':')}}`);
  }
  return problems;
}

describe('layers', () => {
  it('maps Eagle numbers to names and back', () => {
    expect(layerName(1)).toBe('copper.top');
    expect(layerName(2)).toBe('copper.in1');
    expect(layerName(25)).toBe('names.top');
    expect(layerName(95)).toBe('names');
    expect(layerName(121)).toBe('eagle.121');
    for (const n of [1, 2, 15, 16, 20, 21, 25, 51, 91, 94, 96, 121]) expect(layerNumber(layerName(n))).toBe(n);
  });
});

describe('import TA7358A', () => {
  const { project: p, report } = importSample();

  it('reports no problems for a consistent pair', () => {
    expect(report).toEqual([]);
  });

  it('builds one project: parts, nets, placements, library', () => {
    expect(p.project).toEqual({ name: 'TA7358A', imported: { from: ['TA7358A.sch', 'TA7358A.brd'], date: '2026-11-09', eagleVersion: '9.6.2' } });
    expect(p.parts).toHaveLength(42);
    expect(p.nets).toHaveLength(18);
    expect(p.schematic!.sheets[0]!.gates).toHaveLength(43);
    expect(p.board!.footprints).toHaveLength(32);
    expect(p.board!.layers).toEqual(['copper.top', 'copper.bottom']);
    expect(p.schematic!.grid).toEqual({ step: 2.54, fine: 0.254, unit: 'inch' });
    expect(p.board!.grid.step).toBeCloseTo(1.27);
  });

  it('converts parts and placements as in the spec', () => {
    expect(p.parts.find((x) => x.name === 'C2')).toEqual({ name: 'C2', component: 'madhu/CAPACITOR-NP', variant: '0805', value: '22p' });
    const gate = p.schematic!.sheets[0]!.gates.find((g) => g.part === 'C2')!;
    expect(gate).toMatchObject({ part: 'C2', gate: 'A', at: [2.54, 38.1], rot: 90, smashed: true });
    expect(gate.labels![0]).toEqual({ attr: 'NAME', at: [-0.381, 39.624], rot: 90, size: 1.778, layer: 'names' });
    const fp = p.board!.footprints.find((f) => f.part === 'C2')!;
    expect(fp).toMatchObject({ part: 'C2', at: [5.461, 14.351], rot: 90, smashed: true });
    expect(fp.labels).toHaveLength(2);
    // A smashed element with no texts keeps the flag.
    expect(p.board!.footprints.find((f) => f.part === 'RF')).toMatchObject({ smashed: true });
  });

  it('stores each net once: schematic wiring plus board routing, no airwires', () => {
    const n1 = p.nets.find((n) => n.name === 'N$1')!;
    expect(n1.segments![0]!.pins).toEqual([{ part: 'C2', gate: 'A', pin: '2' }, { part: 'IC1', gate: 'G$1', pin: 'MIX-IN' }]);
    expect(n1.segments![0]!.wires).toEqual([{ line: [[5.08, 38.1], [20.32, 38.1]], width: 0.1524 }]);
    expect(n1.traces).toEqual([
      { line: [[2.54, 13.97], [3.821, 15.251]], width: 0.254, layer: 'copper.top' },
      { line: [[3.821, 15.251], [5.461, 15.251]], width: 0.254, layer: 'copper.top' },
    ]);
    expect(p.nets.flatMap((n) => n.traces ?? []).some((t) => t.layer === 'eagle.19')).toBe(false);
    expect(p.nets.some((n) => n.pads)).toBe(false); // pads are derived when there is a schematic
  });

  it('derives exactly the board pads Eagle stored', () => {
    const b = parseEagle(raw('TA7358A.brd')).board!;
    expect(padsMatch(netPads(p), boardPads(b))).toEqual([]);
  });

  it('merges the library: one copy of each item, keyed library/name', () => {
    const ids = p.library.components.map((c) => c.id);
    expect(ids).toContain('madhu/CAPACITOR-NP');
    expect(ids).toContain('linear/TA7358P');
    const cap = p.library.components.find((c) => c.id === 'madhu/CAPACITOR-NP')!;
    expect(cap.variants.find((v) => v.name === '0805')).toEqual({ name: '0805', footprint: 'madhu/0805', pads: { 'A.1': ['1'], 'A.2': ['2'] } });
    const sym = p.library.symbols.find((s) => s.id === 'madhu/CAPACITOR-NP')!;
    expect(sym.pins[0]).toEqual({ name: '1', at: [0, 5.08], rot: 270, length: 'short', direction: 'passive', visible: 'none', swap: 1 });
    expect(new ProjectIndex(p).valueOf(p.parts.find((x) => x.name === 'IC1')!)).toBe('TA7358P');
  });

  it('keeps unmodelled Eagle data in the passthrough', () => {
    const boardExtras = JSON.stringify(p.eagle!.board);
    expect(boardExtras).toContain('"designrules"');
    expect(boardExtras).toContain('"autorouter"');
    expect(boardExtras).not.toContain('"layers"'); // only used non-standard layers are kept; this design has none
    const ic1 = p.parts.find((x) => x.name === 'IC1')!;
    expect(ic1.eagle?.attrs).toMatchObject({ package3d_urn: 'urn:adsk.eagle:package:16491/1' });
    expect(boardExtras).toContain('urn:adsk.eagle:library:262'); // library URN, kept per library
  });
});

describe('.osprey file', () => {
  const { project } = importSample();
  const text = writeProject(project);

  it('writes canonically: write → read → write is identical', () => {
    expect(writeProject(readProject(text))).toBe(text);
    expect(writeProject(importSample().project)).toBe(text); // deterministic
  });

  it('puts one record per line, in the documented layout', () => {
    const lines = text.split('\n');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    expect(lines[0]).toBe('{');
    expect(lines[1]).toBe('  "osprey": 1,');
    expect(lines).toContain('    { "name": "C2", "component": "madhu/CAPACITOR-NP", "variant": "0805", "value": "22p" },');
    expect(lines.some((l) => l.trim().startsWith('{ "line": [[2.54, 13.97], [3.821, 15.251]], "width": 0.254, "layer": "copper.top" }'))).toBe(true);
    expect(lines.some((l) => l.trim() === '{ "name": "N$1",')).toBe(true);
    expect(lines.some((l) => l.length > 2000)).toBe(false);
  });

  it('keeps unknown fields', () => {
    const data = JSON.parse(text);
    data.parts[0].futureField = { x: 1 };
    data.newSection = [1, 2];
    const again = writeProject(readProject(JSON.stringify(data)));
    expect(again).toContain('"futureField": { "x": 1 }');
    expect(again).toContain('"newSection": [1, 2]');
  });

  it('refuses newer formats and damaged files with clear messages', () => {
    expect(() => readProject('{"osprey": 99}')).toThrow(/format version 99/);
    expect(() => readProject('{"hello": 1}')).toThrow(OspreyFormatError);
    expect(() => readProject('not json')).toThrow(/Not a valid Osprey file/);
    expect(() => readProject('{"osprey": 1, "project": {"name": "x"}}')).toThrow(/missing library/);
  });
});

// Optional: import every schematic/board pair under $OSPREY_CORPUS and check the derived
// connectivity against Eagle's own. Skipped unless the variable is set.
const corpus = process.env.OSPREY_CORPUS;
describe.skipIf(!corpus || !existsSync(corpus))('corpus', () => {
  function* pairs(dir: string, depth = 0): Generator<[string, string]> {
    if (depth > 6) return;
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) yield* pairs(p, depth + 1);
        else if (n.endsWith('.sch') && existsSync(p.replace(/\.sch$/, '.brd'))) yield [p, p.replace(/\.sch$/, '.brd')];
      } catch { /* unreadable: skip */ }
    }
  }

  it('imports every pair; derived pads match Eagle; files round-trip', () => {
    const failures: string[] = [];
    let count = 0;
    for (const [s, b] of pairs(corpus!)) {
      count++;
      try {
        const sf = parseEagle(readFileSync(s, 'utf8'));
        const bf = parseEagle(readFileSync(b, 'utf8'));
        const { project } = importEagle([{ name: 's.sch', file: sf }, { name: 'b.brd', file: bf }]);
        const problems = padsMatch(netPads(project), boardPads(bf.board!));
        if (problems.length) failures.push(`${s}: ${problems.slice(0, 2).join('; ')}`);
        const text = writeProject(project);
        if (writeProject(readProject(text)) !== text) failures.push(`${s}: not canonical`);
      } catch (e) {
        failures.push(`${s}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 300_000);

  it('computes the same airwires as Eagle stored, for every net without a pour', () => {
    // Pours are approximated by their outline (the poured copper isn't computed), so nets
    // with pours may differ where Eagle's pour is split into islands.
    const failures: string[] = [];
    for (const [s, b] of pairs(corpus!)) {
      const bf = parseEagle(readFileSync(b, 'utf8'));
      const { project } = importEagle([{ name: 's.sch', file: parseEagle(readFileSync(s, 'utf8')) }, { name: 'b.brd', file: bf }]);
      const ours = new Map<string, number>();
      for (const a of ratsnest(project)) ours.set(a.net, (ours.get(a.net) ?? 0) + 1);
      for (const sig of bf.board!.signals) {
        if (sig.polygons.length) continue;
        const eagle = sig.wires.filter((w) => w.layer === 19).length;
        if ((ours.get(sig.name) ?? 0) !== eagle) failures.push(`${b} ${sig.name}: Eagle ${eagle}, ours ${ours.get(sig.name) ?? 0}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
