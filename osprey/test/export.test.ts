// Eagle export: import → export → re-import must give back the same project.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { parseEagle } from '../src/eagle/parse';
import { exportEagle } from '../src/model/export-eagle';
import { writeProject } from '../src/model/file';
import { importEagle } from '../src/model/import-eagle';
import type * as O from '../src/model/types';
import { checkConsistency } from '../src/project/consistency';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const load = () => importEagle([{ name: 'TA7358A.sch', file: parseEagle(raw('TA7358A.sch')) }, { name: 'TA7358A.brd', file: parseEagle(raw('TA7358A.brd')) }], 'D').project;

/** Export, re-import, and return the re-imported project plus the import's report. */
function roundTrip(p: O.Project): { project: O.Project; report: string[]; files: Map<string, string> } {
  const { files } = exportEagle(p);
  const r = importEagle([...files].map(([name, text]) => ({ name, file: parseEagle(text) })), p.project.imported?.date ?? 'D');
  if (r.project.project.imported && p.project.imported) r.project.project.imported.from = p.project.imported.from;
  return { project: r.project, report: r.report, files };
}

describe('Eagle export', () => {
  it('round-trips the sample exactly', () => {
    const p = load();
    const { project, report, files } = roundTrip(p);
    expect([...files.keys()]).toEqual(['TA7358A.sch', 'TA7358A.brd']);
    expect(report).toEqual([]);
    expect(writeProject(project)).toBe(writeProject(p));
  });

  it('writes Eagle-style files: declaration, DOCTYPE, CRLF, one element per line', () => {
    const { files } = exportEagle(load());
    const brd = files.get('TA7358A.brd')!;
    expect(brd.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\r\n<eagle version="9.6.2">\r\n<drawing>\r\n')).toBe(true);
    expect(brd.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(brd).toContain('<element name="C2" library="madhu" package="0805" value="22p" x="5.461" y="14.351" smashed="yes" rot="R90">');
    expect(brd).toContain('<contactref element="C2" pad="2"/>');
    expect(brd).toContain('<plain>\r\n<wire x1="0" y1="0" x2="36.246" y2="0" width="0" layer="20"/>');
    expect(brd).toContain('<param name="layerSetup" value="(1*16)"/>'); // design rules from the passthrough
  });

  it('exported schematic and board are consistent with each other', () => {
    const { files } = exportEagle(load());
    const sch = parseEagle(files.get('TA7358A.sch')!).schematic!;
    const brd = parseEagle(files.get('TA7358A.brd')!).board!;
    expect(checkConsistency(sch, brd)).toEqual([]);
  });

  it('carries edits across: moves, renames, values, deletes', () => {
    const p = load();
    const ed = new Editor(p, () => {});
    expect(ed.renamePart('C2', 'C22')).toBeUndefined();
    expect(ed.setValue('C3', '220p')).toBeUndefined();
    ed.delete([{ kind: 'footprint', footprint: p.board!.footprints.find((f) => f.part === 'L1')! }]);
    const { project, report } = roundTrip(p);
    expect(report).toEqual([]);
    expect(writeProject(project)).toBe(writeProject(p));
    expect(project.parts.some((x) => x.name === 'C22')).toBe(true);
    expect(project.parts.some((x) => x.name === 'L1')).toBe(false);
  });

  it('regenerates airwires for unrouted connections', () => {
    const p = load();
    p.nets.find((n) => n.name === 'N$1')!.traces!.pop();
    const brd = parseEagle(exportEagle(p).files.get('TA7358A.brd')!).board!;
    const n1 = brd.signals.find((s) => s.name === 'N$1')!;
    expect(n1.wires.filter((w) => w.layer === 19)).toHaveLength(1);
  });
});

const corpus = process.env.OSPREY_CORPUS;
describe.skipIf(!corpus || !existsSync(corpus))('Eagle export corpus', () => {
  function* pairs(dir: string, depth = 0): Generator<[string, string]> {
    if (depth > 6) return;
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) yield* pairs(p, depth + 1);
        else if (n.endsWith('.sch') && existsSync(p.replace(/\.sch$/, '.brd'))) yield [p, p.replace(/\.sch$/, '.brd')];
      } catch { /* skip */ }
    }
  }

  it('every pair round-trips through Eagle export unchanged', () => {
    const failures: string[] = [];
    let count = 0;
    for (const [s, b] of pairs(corpus!)) {
      count++;
      try {
        const p = importEagle([{ name: 'x.sch', file: parseEagle(readFileSync(s, 'utf8')) }, { name: 'x.brd', file: parseEagle(readFileSync(b, 'utf8')) }], 'D').project;
        const { project } = roundTrip(p);
        const a = writeProject(p).split('\n');
        const z = writeProject(project).split('\n');
        const i = a.findIndex((l, k) => l !== z[k]);
        if (i >= 0) failures.push(`${s}: line ${i + 1}: ${a[i]?.trim().slice(0, 120)} ≠ ${z[i]?.trim().slice(0, 120)}`);
      } catch (e) {
        failures.push(`${s}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 600_000);
});
