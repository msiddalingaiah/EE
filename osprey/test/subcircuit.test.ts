// Subcircuits (src/edit/subcircuit.ts): blocks of the sample subcircuits project, copied into a
// design with the editor and with the command line's copy step.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { runSteps, type StepEnv } from '../src/cli/steps';
import { subcircuitBlocks } from '../src/edit/subcircuit';
import { blockOf } from '../src/model/blocks';
import { erc } from '../src/model/erc';
import { readProject, writeProject } from '../src/model/file';
import type * as O from '../src/model/types';

const text = readFileSync(join(__dirname, '..', 'samples', 'subcircuits', 'subcircuits.osprey'), 'utf8');
const source = () => readProject(text);

/** An empty design: one sheet and a board. */
const empty = (): O.Project => readProject(JSON.stringify({
  osprey: 1, project: { name: 't' }, library: { symbols: [], footprints: [], components: [] }, parts: [], nets: [],
  schematic: { grid: { step: 2.54, fine: 0.254, unit: 'inch' }, sheets: [{ id: '1', drawing: [], gates: [] }] },
  board: { layers: ['copper.top', 'copper.bottom'], grid: { step: 0.635, fine: 0.127, unit: 'mm' }, footprints: [], drawing: [] },
}));

/** Each net's pins, as "PART.PIN" sorted, by net name. */
const netlist = (p: O.Project) => new Map(p.nets.map((n) => [n.name, (n.segments ?? []).flatMap((s) => s.pins.map((r) => `${r.part}.${r.pin}`)).sort()]));

describe('subcircuits', () => {
  it('lists the sample blocks with their ports and supplies', () => {
    const blocks = subcircuitBlocks(source());
    expect(blocks.map((b) => [b.name, b.ports, b.supplies])).toEqual([
      ['ATtiny412', ['UPDI'], ['GND', 'VCC']],
      ['Divider', ['OUT'], ['GND', 'VCC']],
      ['LED', [], ['GND', 'VCC']],
      ['Oscillator', ['CLK'], ['GND', 'VCC']],
      ['PMOS-polarity', ['VIN'], ['GND', 'VCC']],
      ['Regulator', ['VIN'], ['GND', 'VCC']],
      ['Reset-button', ['RESET'], ['GND', 'VCC']],
    ]);
  });

  it('copies a block with its wiring, so its netlist is the same, and undo takes it out', () => {
    const p = empty();
    const ed = new Editor(p, () => {});
    const r = ed.copyBlock(source(), 'Regulator');
    if (typeof r === 'string') throw new Error(r);
    expect(r.block).toBe('Regulator');
    expect(p.parts.filter((x) => blockOf(x) === 'Regulator').map((x) => x.name).sort()).toEqual(['C1', 'C2', 'D1', 'U1']);
    const s = source();
    const want = netlist(s);
    for (const [name, pins] of netlist(p)) {
      expect(pins.filter((x) => !x.startsWith('SUPPLY')), name).toEqual((want.get(name) ?? []).filter((x) => /^(C1|C2|D1|U1)\./.test(x)));
    }
    expect(erc(p).problems.filter((x) => !/connects only/.test(x.message))).toEqual([]);
    expect(p.board!.footprints.map((f) => f.part).sort()).toEqual(['C1', 'C2', 'D1', 'U1']);
    ed.undo();
    expect(p.parts).toEqual([]);
  });

  it('renames what the design has already, joins ports to its nets and sets values', () => {
    const p = empty();
    const ed = new Editor(p, () => {});
    const a = ed.copyBlock(source(), 'PMOS-polarity', { ports: { VIN: 'VBAT' } });
    const b = ed.copyBlock(source(), 'Regulator', { ports: { VIN: 'VBAT' }, values: { C2: '10u' } });
    const c = ed.copyBlock(source(), 'LED');
    const d = ed.copyBlock(source(), 'led');
    if ([a, b, c, d].some((x) => typeof x === 'string')) throw new Error(String([a, b, c, d].find((x) => typeof x === 'string')));
    if (typeof b === 'string' || typeof d === 'string') return;
    // Names the design doesn't use stay (C2); taken ones get the next free number (the second LED).
    expect(b.parts.get('C2')).toBe('C2');
    expect(p.parts.find((x) => x.name === 'C2')!.value).toBe('10u');
    expect(d.block).toBe('LED2');
    expect([...d.parts.values()].every((n) => !['R2', 'D2'].includes(n))).toBe(true);
    // Both VIN ports joined VBAT: the MOSFET's drain and the diode's anode are one net.
    const vbat = netlist(p).get('VBAT')!;
    expect(vbat).toContain('Q1.D');
    expect(vbat).toContain(`${b.parts.get('D1')}.A`);
    expect(p.nets.some((n) => n.name === 'VIN' || n.name === 'VIN_2')).toBe(false);
    // One VCC and one GND for everything.
    expect(p.nets.filter((n) => n.name === 'VCC' || n.name === 'GND')).toHaveLength(2);
    // Blocks don't overlap: each starts right of the one before.
    const x = (blk: string) => {
      const names = new Set(p.parts.filter((q) => blockOf(q) === blk).map((q) => q.name));
      const xs = p.schematic!.sheets[0]!.gates.filter((g) => names.has(g.part)).map((g) => g.at[0]);
      return [Math.min(...xs), Math.max(...xs)] as const;
    };
    expect(x('Regulator')[0]).toBeGreaterThan(x('PMOS-polarity')[1]);
    expect(x('LED2')[0]).toBeGreaterThan(x('LED')[1]);
  });

  it('says what is wrong: no such block, port or part', () => {
    const ed = new Editor(empty(), () => {});
    expect(ed.copyBlock(source(), 'Nope')).toMatch(/^No block Nope \(there are: ATtiny412, /);
    expect(ed.copyBlock(source(), 'LED', { ports: { OUT: 'X' } })).toBe('LED has no port OUT (its ports: none)');
    expect(ed.copyBlock(source(), 'LED', { values: { R9: '1k' } })).toBe('LED has no part R9 (its parts: R2, D2)');
  });

  it('copies from the user directory with the copy step', () => {
    const saves: string[] = [];
    const env: StepEnv = {
      listUserDir: (sub) => (sub === 'subcircuits' ? ['subcircuits.osprey'] : []),
      readUserDir: () => text,
      readPath: () => undefined,
      writeOutput: (n) => n,
      save: (t) => (saves.push(t), 'saved.osprey'),
    };
    const r = runSteps(empty(), ['copy=Oscillator,CLK=CLKIN,R12.value=330', 'copy=Divider,OUT=VREF,at=100:50', 'copy=Nope'], env);
    expect(r.steps.map((s) => [s.ok, s.summary])).toEqual([
      [true, 'Copied Oscillator from subcircuits.osprey: 7 parts; ports CLK→CLKIN'],
      [true, 'Copied Divider from subcircuits.osprey: 3 parts; ports OUT→VREF'],
      [false, "No subcircuit Nope in the user directory's subcircuits/ (osprey subcircuits lists them; or give from=<file>)"],
    ]);
    const p = readProject(saves[0]!);
    expect(p.parts.find((x) => x.name === 'R12')!.value).toBe('330');
    expect(netlist(p).get('CLKIN')).toEqual(['U3.O']);
    // at=100:50 puts the Divider's top-left corner there.
    const div = new Set(p.parts.filter((x) => blockOf(x) === 'Divider').map((x) => x.name));
    expect(Math.min(...p.schematic!.sheets[0]!.gates.filter((g) => div.has(g.part)).map((g) => g.at[0]))).toBeGreaterThanOrEqual(100);
    expect(writeProject(p)).toContain('"VREF"');
  });
});
