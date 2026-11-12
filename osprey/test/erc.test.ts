// Electrical rule check: the samples, and each check on a sample broken on purpose.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { erc, ercKey } from '../src/model/erc';
import { readProject, writeProject } from '../src/model/file';
import type * as O from '../src/model/types';

const load = (name: string) => readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', name), 'utf8'));
const messages = (p: O.Project) => erc(p).problems.map((x) => x.message);

describe('ERC', () => {
  it('passes TA7358A, and finds the one unused pin of wwvbfind', () => {
    expect(messages(load('TA7358A.osprey'))).toEqual([]);
    const r = erc(load('wwvbfind.osprey'));
    expect(r.problems.map((x) => [x.kind, x.message])).toEqual([['unconnected', 'U1 pin PA2 is unconnected']]);
    expect(r.problems[0]!.sheet).toBe('1');
    expect(r.pins).toBeGreaterThan(100);
  });

  let p: O.Project;
  beforeEach(() => {
    p = load('wwvbfind.osprey');
  });
  const net = (name: string) => p.nets.find((n) => n.name === name)!;
  const pin = (symbol: string, name: string) => p.library.symbols.find((s) => s.id.endsWith(`/${symbol}`))!.pins.find((x) => x.name === name)!;

  it('finds a pin touching a wire it is not connected to, and a net left with one pin', () => {
    const seg = net('N$4').segments![0]!;
    seg.pins = seg.pins.filter((x) => x.part !== 'R5');
    const ms = messages(p);
    expect(ms).toContain("R5 pin 2 touches a wire of N$4 but isn't connected to it");
    expect(ms).toContain('N$4 connects only Q2 pin E');
  });

  it('finds pins no wire reaches when a part moves away from its wires', () => {
    const g = p.schematic!.sheets[0]!.gates.find((x) => x.part === 'R13')!;
    g.at = [g.at[0], g.at[1] + 5.08];
    const ms = messages(p);
    expect(ms).toContain('R13 pin 1 is on AUDIO, but no wire reaches it');
    expect(ms).toContain('R13 pin 2 is on N$11, but no wire reaches it');
  });

  it('finds a pin on two nets', () => {
    net('N$5').segments![0]!.pins.push({ part: 'R5', gate: 'A', pin: '2' });
    expect(messages(p)).toContain('R5 pin 2 is on 2 nets: N$4, N$5');
  });

  it('finds outputs driving each other, and an output driving a supply', () => {
    pin('ATTINY412', 'PA3/EXTCLK').direction = 'out';
    pin('BERG-3', '3').direction = 'out';
    const r = erc(p);
    const ms = r.problems.map((x) => x.message);
    expect(ms.some((m) => /^Outputs drive each other on CLK: U1 pin PA3\/EXTCLK, U2 \w+ pin O$/.test(m))).toBe(true);
    expect(ms).toContain('UPDI pin 3 drives supply VCC on VCC');
    expect(r.problems[0]!.severity).toBe('error');
  });

  it('finds supplies joined together', () => {
    const vcc = net('VCC');
    net('GND').segments!.push(...vcc.segments!);
    p.nets = p.nets.filter((n) => n !== vcc);
    expect(messages(p)).toContain('Supplies GND and VCC are joined on GND');
  });

  it('finds a net that only inputs listen to', () => {
    pin('ATTINY412', 'PA3/EXTCLK').direction = 'in';
    pin('INVERTER', 'O').direction = 'in';
    expect(messages(p).some((m) => m.startsWith('Only inputs on CLK: nothing drives U1 pin PA3/EXTCLK'))).toBe(true);
  });

  it('finds a not-connect pin that is wired', () => {
    pin('ATTINY412', 'PA6').direction = 'nc';
    expect(messages(p)).toContain('U1 pin PA6 is marked not to connect, but is on AUDIO');
  });

  it('finds power pins that nothing supplies', () => {
    p.nets = p.nets.filter((n) => n.name !== 'VCC');
    const ms = messages(p);
    expect(ms.some((m) => /^Nothing supplies VDD: power pins of U1 join it/.test(m))).toBe(true);
    expect(ms.some((m) => /^Nothing supplies VCC: power pins of U2 join it/.test(m))).toBe(true);
  });

  it('marks approved problems, keeps approvals in the saved project, and reports a problem again when its message changes', () => {
    p.schematic!.approved = [ercKey({ kind: 'unconnected', message: 'U1 pin PA2 is unconnected' })];
    const again = readProject(writeProject(p));
    expect(again.schematic!.approved).toEqual(['unconnected: U1 pin PA2 is unconnected']);
    expect(erc(again).problems.map((x) => [x.message, x.approved])).toEqual([['U1 pin PA2 is unconnected', true]]);
    again.parts.find((x) => x.name === 'U1')!.name = 'IC1';
    for (const s of again.schematic!.sheets) for (const g of s.gates) if (g.part === 'U1') g.part = 'IC1';
    expect(erc(again).problems.find((x) => x.message === 'IC1 pin PA2 is unconnected')?.approved).toBeUndefined();
  });

  it('approves and unapproves through the editor, with undo', () => {
    const ed = new Editor(p, () => {});
    ed.approve(['unconnected: U1 pin PA2 is unconnected'], true);
    expect(erc(p).problems[0]!.approved).toBe(true);
    expect(ed.history.undoLabel).toBe('Approve ERC problem');
    ed.undo();
    expect(p.schematic!.approved).toBeUndefined();
    ed.redo();
    ed.approve(['unconnected: U1 pin PA2 is unconnected'], false);
    expect(p.schematic!.approved).toBeUndefined();
  });

  it('finds a part missing from the board', () => {
    p.board!.footprints = p.board!.footprints.filter((f) => f.part !== 'R1');
    expect(messages(p).some((m) => /^R1 \(.+\) isn't on the board$/.test(m))).toBe(true);
  });
});
