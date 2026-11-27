// Subcircuits (src/edit/subcircuit.ts): blocks of the sample subcircuits project, copied into a
// design with the editor and with the command line's copy step.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { runSteps, type StepEnv } from '../src/cli/steps';
import { subcircuitBlocks } from '../src/edit/subcircuit';
import { blockOf } from '../src/model/blocks';
import { drc } from '../src/model/drc';
import { erc } from '../src/model/erc';
import { layoutGroups } from '../src/model/groups';
import { readLibrary, readProject, writeProject } from '../src/model/file';
import { parseDescription, resolveDescription } from '../src/gen/description';
import { generateProject } from '../src/gen/layout';
import type * as O from '../src/model/types';

// The sample subcircuits: one project per function.
const FILES = ['analog', 'audio', 'clock', 'indicators', 'mcu', 'power', 'rf'];
const texts = new Map(FILES.map((f) => [`${f}.osprey`, readFileSync(join(__dirname, '..', 'samples', 'subcircuits', `${f}.osprey`), 'utf8')]));
const source = (file: string) => readProject(texts.get(`${file}.osprey`)!);

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
    const blocks = FILES.flatMap((f) => subcircuitBlocks(source(f))).sort((a, b) => a.name.localeCompare(b.name));
    expect(blocks.map((b) => [b.name, b.ports, b.supplies])).toEqual([
      ['ATtiny412', ['UPDI'], ['GND', 'VCC']],
      ['Battery-monitor', ['ADC', 'VBATT'], ['GND', 'VCC']],
      ['Boost-MAX17225', ['VOUT'], ['GND', 'VCC']],
      ['Boost-TPS61021A', ['POWER_EN', 'VBATT'], ['GND', 'VCC']],
      ['CE-amp', ['IN', 'OUT'], ['GND', 'VCC']],
      ['Colpitts-CB', ['DET', 'OUT', 'VIN'], ['GND', 'VCC']],
      ['Colpitts-CC', ['OUT', 'VIN'], ['GND', 'VCC']],
      ['Divider', ['OUT'], ['GND', 'VCC']],
      ['ESP12F', ['ADC', 'SCL', 'SDA'], ['GND', 'VCC']],
      ['IF-amp', ['BIAS', 'IN', 'OUT'], ['GND', 'VCC']],
      ['Inverting-amp', ['IN', 'OUT'], ['GND', 'VCC']],
      ['JFET-preamp', ['IN', 'OUT'], ['GND', 'VCC']],
      ['LED', [], ['GND', 'VCC']],
      ['LM386', ['IN'], ['GND', 'VCC']],
      ['Lowside-driver', ['CTRL'], ['+12V', 'GND', 'V+']],
      ['MOSFET-switch', ['CTRL'], ['GND', 'VCC']],
      ['Oscillator', ['CLK'], ['GND', 'VCC']],
      ['Peak-detector', ['IN', 'OUT'], ['GND', 'VCC']],
      ['PMOS-polarity', ['VIN'], ['GND', 'VCC']],
      ['RC-lowpass', ['IN', 'OUT'], ['GND']],
      ['Regulator', ['VIN'], ['GND', 'VCC']],
      ['Reset-button', ['RESET'], ['GND', 'VCC']],
      ['RTC-PCF85063A', ['INT', 'SCL', 'SDA', 'VBATT'], ['GND']],
      ['Timer-TPL5010', ['POWER_EN', 'RST', 'VBATT'], ['GND']],
      ['Tuned-amp', ['IN', 'OUT'], ['GND', 'VCC']],
      ['Wake-latch', ['INT', 'POWER_EN', 'RST', 'VBATT'], ['GND']],
    ]);
  });

  it('copies every sample block on its own, wired as in its project, with no ERC errors', () => {
    for (const f of FILES) {
      const s = source(f);
      for (const b of subcircuitBlocks(s)) {
        const p = empty();
        const r = new Editor(p, () => {}).copyBlock(s, b.name);
        if (typeof r === 'string') throw new Error(`${b.name}: ${r}`);
        // Every pin of the block's parts on the same net as in the subcircuits project.
        // Pins with their gate: a part can have two gates with a pin of one name (a JST header's + and -).
        const gated = (q: O.Project) => new Map(q.nets.map((n) => [n.name, (n.segments ?? []).flatMap((sg) => sg.pins.map((x) => `${x.part}.${x.gate}.${x.pin}`))]));
        const want = gated(s);
        const got = gated(p);
        for (const part of b.parts) {
          const now = r.parts.get(part.name)!;
          for (const [net, pins] of want) for (const x of pins.filter((q) => q.startsWith(`${part.name}.`))) {
            const n = [...got].find(([, ps]) => ps.includes(`${now}.${x.slice(part.name.length + 1)}`));
            expect(n?.[0] === net || /^N\$/.test(net), `${b.name} ${x} on ${net}, now ${n?.[0]}`).toBe(true);
          }
        }
        expect(erc(p).problems.filter((x) => x.severity === 'error').map((x) => x.message), b.name).toEqual([]);
      }
    }
  });

  it('copies a block with its wiring, so its netlist is the same, and undo takes it out', () => {
    const p = empty();
    const ed = new Editor(p, () => {});
    const r = ed.copyBlock(source('power'), 'Regulator');
    if (typeof r === 'string') throw new Error(r);
    expect(r.block).toBe('Regulator');
    expect(p.parts.filter((x) => blockOf(x) === 'Regulator').map((x) => x.name).sort()).toEqual(['C1', 'C2', 'D1', 'U1']);
    const s = source('power');
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
    const a = ed.copyBlock(source('power'), 'PMOS-polarity', { ports: { VIN: 'VBAT' } });
    const b = ed.copyBlock(source('power'), 'Regulator', { ports: { VIN: 'VBAT' }, values: { C2: '10u' } });
    const c = ed.copyBlock(source('indicators'), 'LED');
    const d = ed.copyBlock(source('indicators'), 'led');
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
    expect(ed.copyBlock(source('mcu'), 'Nope')).toBe('No block Nope (there are: ATtiny412, ESP12F, Reset-button)');
    expect(ed.copyBlock(source('indicators'), 'LED', { ports: { OUT: 'X' } })).toBe('LED has no port OUT (its ports: none)');
    expect(ed.copyBlock(source('indicators'), 'LED', { values: { R9: '1k' } })).toBe('LED has no part R9 (its parts: R2, D2)');
  });

  it('copies from the user directory with the copy step', () => {
    const saves: string[] = [];
    const env: StepEnv = {
      listUserDir: (sub) => (sub === 'subcircuits' ? [...texts.keys()] : []),
      readUserDir: (_, name) => texts.get(name)!,
      readPath: () => undefined,
      writeOutput: (n) => n,
      save: (t) => (saves.push(t), 'saved.osprey'),
    };
    const r = runSteps(empty(), ['copy=Oscillator,CLK=CLKIN,R12.value=330', 'copy=Divider,OUT=VREF,at=100:50', 'copy=Nope'], env);
    expect(r.steps.map((s) => [s.ok, s.summary])).toEqual([
      [true, 'Copied Oscillator from clock.osprey: 7 parts; ports CLK→CLKIN'],
      [true, 'Copied Divider from analog.osprey: 3 parts; ports OUT→VREF'],
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

  it('wires bare pins to nets with a labelled stub (connect step)', () => {
    const p = empty();
    const ed = new Editor(p, () => {});
    for (const b of ['ATtiny412', 'Oscillator']) if (typeof ed.copyBlock(source(b === 'Oscillator' ? 'clock' : 'mcu'), b, b === 'Oscillator' ? { ports: { CLK: 'CLKIN' } } : {}) === 'string') throw new Error(b);
    const r = ed.connectPins(['U2.PA3', 'U2.PA6'], 'CLKIN');
    expect(r).toEqual([{ pin: 'U2.PA3/EXTCLK', net: 'CLKIN' }, { pin: 'U2.PA6', net: 'CLKIN' }]);
    expect(netlist(p).get('CLKIN')).toEqual(['U2.PA3/EXTCLK', 'U2.PA6', 'U3.O']);
    // Each stub leaves its pin away from the body: PA6 (left side) to the left, PA3 (right side) to the right.
    const seg = (pin: string) => p.nets.find((n) => n.name === 'CLKIN')!.segments!.find((s) => s.pins.some((x) => x.pin === pin))!;
    const u2 = p.schematic!.sheets[0]!.gates.find((g) => g.part === 'U2')!;
    expect(Math.min(...seg('PA6').wires[0]!.line.map((q) => q[0]))).toBeLessThan(u2.at[0] - 17.78);
    expect(Math.max(...seg('PA3/EXTCLK').wires[0]!.line.map((q) => q[0]))).toBeGreaterThan(u2.at[0] + 17.78);
    expect(seg('PA6').labels).toHaveLength(1);
    expect(erc(p).problems.filter((x) => /no wire|crosses|overlap/.test(x.message))).toEqual([]);
    expect(ed.connectPins(['U2.PA3'], 'X')).toBe('U2.PA3/EXTCLK is on CLKIN already');
    expect(ed.connectPins(['U2.ZZ'], 'X')).toBe('U2 has no pin ZZ');
    expect(ed.connectPins(['U3.O'], 'X')).toBe('U3.O is ambiguous: U3.A.O, U3.B.O');
    // A failure takes back the pins before it.
    expect(ed.connectPins(['U2.PA7', 'U2.ZZ'], 'X')).toBe('U2 has no pin ZZ');
    expect(netlist(p).has('X')).toBe(false);
  });
});

describe('layout groups', () => {
  /** A group's geometry as its pairwise distances (footprint origins, trace ends, vias): moving and turning keep them. */
  const shape = (p: O.Project, group: string) => {
    const g = layoutGroups(p).get(group)!;
    const pts = [...g.footprints.map((f) => f.at), ...g.copper.flatMap((c) => (c.kind === 'trace' ? c.trace.line : [c.via.at]))];
    const d: number[] = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) d.push(Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1]));
    return d.sort((a, b) => a - b);
  };
  /** The largest difference between two shapes (mm). */
  const drift = (a: number[], b: number[]) => (a.length === b.length ? Math.max(0, ...a.map((x, i) => Math.abs(x - b[i]!))) : Infinity);
  /** The group of a DRC object (a footprint placement, trace or via), '' for none. */
  const groupOf = (o: object) => ('group' in o ? String((o as { group?: string }).group ?? '') : '');

  it('copies a block with its board layout, as a layout group on the design\'s nets', () => {
    const s = source('power');
    const p = empty();
    const ed = new Editor(p, () => {});
    const r = ed.copyBlock(s, 'Boost-TPS61021A', { ports: { VBATT: 'BATT' } });
    if (typeof r === 'string') throw new Error(r);
    expect(r.group).toBe('Boost-TPS61021A');
    const want = layoutGroups(s).get('Boost-TPS61021A')!;
    const got = layoutGroups(p).get('Boost-TPS61021A')!;
    expect(got.footprints).toHaveLength(want.footprints.length);
    expect(got.copper).toHaveLength(want.copper.length);
    expect(drift(shape(p, 'Boost-TPS61021A'), shape(s, 'Boost-TPS61021A'))).toBeLessThan(1e-6);
    // The port's copper is on the net it joined.
    expect(p.nets.find((n) => n.name === 'BATT')!.traces!.length).toBe(s.nets.find((n) => n.name === 'VBATT')!.traces!.filter((t) => t.group === 'Boost-TPS61021A').length);
    // A second copy is a group of its own, clear of the first.
    const r2 = ed.copyBlock(s, 'Boost-TPS61021A');
    if (typeof r2 === 'string') throw new Error(r2);
    expect(r2.group).toBe('Boost-TPS61021A2');
    const between = drc(p).violations.filter((v) => v.kind !== 'unrouted' && new Set(v.objects.map(groupOf)).size > 1);
    expect(between.map((v) => v.message)).toEqual([]);
    ed.undo();
    ed.undo();
    expect(p.nets.flatMap((n) => [...(n.traces ?? []), ...(n.vias ?? [])])).toEqual([]);
  });

  it('autoplace moves each group whole, its copper with it, clear of the rest', () => {
    const p = empty();
    const ed = new Editor(p, () => {});
    for (const [file, block, ports] of [
      ['power', 'Boost-TPS61021A', { VBATT: 'VBATT', POWER_EN: 'POWER_EN' }],
      ['power', 'Wake-latch', { VBATT: 'VBATT', POWER_EN: 'POWER_EN' }],
      ['analog', 'Battery-monitor', { VBATT: 'VBATT' }],
      ['indicators', 'LED', {}],
    ] as const) {
      const r = ed.copyBlock(source(file), block, { ports });
      if (typeof r === 'string') throw new Error(r);
    }
    const groups = [...layoutGroups(p).keys()].sort();
    expect(groups).toEqual(['Battery-monitor', 'Boost-TPS61021A', 'Wake-latch']);
    const before = new Map(groups.map((g) => [g, shape(p, g)]));
    const internal = (q: O.Project) => drc(q).violations.filter((v) => v.kind !== 'unrouted' && new Set(v.objects.map(groupOf)).size === 1 && groupOf(v.objects[0]!)).length;
    const inside = internal(p);
    ed.autoplace();
    for (const g of groups) expect(drift(shape(p, g), before.get(g)!), g).toBeLessThan(1e-6);
    // Nothing new: no violation between groups or with the other parts, and the groups' own
    // (pads closer than the default rules allow) as many as before.
    // (The board edge is kept by autoplace's own margin, not the default DRC edge rule: left aside.)
    expect(drc(p).violations.filter((v) => v.kind !== 'unrouted' && v.kind !== 'dimension' && new Set(v.objects.map(groupOf)).size > 1).map((v) => v.message)).toEqual([]);
    expect(internal(p)).toBe(inside);
    // Every group's copper still meets its pads: no airwire inside a group.
    const unroutedInside = drc(p).violations.filter((v) => v.kind === 'unrouted' && v.objects.length && new Set(v.objects.map(groupOf)).size === 1 && groupOf(v.objects[0]!));
    expect(unroutedInside).toEqual([]);
  });
});

describe('generation with subcircuits', () => {
  const lib = (f: string) => join(__dirname, '..', 'samples', 'osprey', f);
  const sources = [
    { name: 'madhu.ospreylib', library: readLibrary(readFileSync(lib('madhu.ospreylib'), 'utf8')).library },
    { name: 'wwvbfind2.osprey', library: readProject(readFileSync(lib('wwvbfind2.osprey'), 'utf8')).library },
  ];
  const stored = FILES.map((f) => ({ name: `${f}.osprey`, project: source(f) }));
  const head = 'supply VCC supply2/VCC\nsupply GND supply2/GND\n';
  const run = (body: string) => resolveDescription(parseDescription(head + body).description, sources, 't', stored);

  it('copies stored blocks in as drawn, their ports joining the described nets', () => {
    const r = run([
      'block Power', 'J1 madhu/BERG-2', 'net VBAT: J1.2', 'GND: J1.1',
      'subcircuit PMOS-polarity VIN=VBAT', 'subcircuit Regulator VIN=VBAT C2.value=10u',
      'block Clock', 'subcircuit Oscillator CLK=CLKIN',
      'block MCU', 'U1 madhu/ATTINY412', 'VCC: U1.VDD', 'GND: U1.GND', 'net CLKIN: U1.PA3', 'nc: U1.PA6 U1.PA7 U1.PA1 U1.PA2 U1.PA0',
    ].join('\n'));
    // No "only one pin" warnings for VBAT and CLKIN: the stored blocks' ports join them.
    expect(r.problems).toEqual([]);
    expect(r.resolved!.subcircuits!.map((s) => [s.name, s.as])).toEqual([['PMOS-polarity', 'Power/PMOS-polarity'], ['Regulator', 'Power/Regulator'], ['Oscillator', 'Clock']]);
    const p = generateProject(r.resolved!);
    const blocks = new Map(p.parts.map((x) => [x.name, blockOf(x)]));
    expect(blocks.get('Q1')).toBe('Power/PMOS-polarity');
    expect(blocks.get('U3')).toBe('Clock');
    const nets = netlist(p);
    expect(nets.get('VBAT')).toEqual(expect.arrayContaining(['J1.2', 'Q1.D']));
    expect(nets.get('VBAT')!.some((x) => /^D\d+\.A$/.test(x))).toBe(true);
    expect(nets.get('CLKIN')).toEqual(['U1.PA3/EXTCLK', 'U3.O']);
    expect(p.parts.find((x) => blocks.get(x.name) === 'Power/Regulator' && x.value === '10u')).toBeDefined();
    expect(erc(p).problems.filter((x) => x.severity === 'error' || /no wire|only/.test(x.message))).toEqual([]);
  });

  it('says what is wrong with a subcircuit line', () => {
    const msgs = (body: string) => run(body).problems.map((x) => x.message);
    expect(msgs('block A\nsubcircuit Nope')).toEqual([expect.stringMatching(/^No subcircuit Nope \(the blocks are ATtiny412, Battery-monitor, Boost-MAX17225, .*, Tuned-amp, Wake-latch\)$/)]);
    expect(msgs('block A\nsubcircuit LED OUT=X')).toEqual(['subcircuit LED has no port OUT (its ports: none)']);
    expect(msgs('block A\nsubcircuit LED R9.value=1k')).toEqual(['subcircuit LED has no part R9 (its parts: R2, D2)']);
    expect(msgs('block A\nsubcircuit LED from=other')).toEqual(['subcircuit LED: no subcircuits project other (analog.osprey, audio.osprey, clock.osprey, indicators.osprey, mcu.osprey, power.osprey, rf.osprey)']);
    expect(parseDescription('subcircuit LED').problems.map((x) => x.message)).toEqual(['subcircuit LED comes before any block']);
  });
});
