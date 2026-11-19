// Schematic generation: block descriptions parsed, checked against libraries, and drawn.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSteps, type StepEnv } from '../src/cli/steps';
import { parseDescription, resolveDescription, type Source } from '../src/gen/description';
import { generateProject } from '../src/gen/layout';
import { ProjectIndex } from '../src/model/derive';
import { readProject, writeProject } from '../src/model/file';
import { pinPosition } from '../src/model/geometry';
import type * as O from '../src/model/types';

const ROOT = join(__dirname, '..');
const handDrawn = readProject(readFileSync(join(ROOT, 'samples', 'osprey', 'wwvbfind2.osprey'), 'utf8'));
const sources: Source[] = [{ name: 'wwvbfind2.osprey', library: handDrawn.library }];
const description = readFileSync(join(ROOT, 'samples', 'blocks', 'wwvbfind2.blocks'), 'utf8');

function generate(text: string) {
  const parsed = parseDescription(text);
  // As the command line does: syntax errors first, then the library checks.
  if (parsed.problems.some((p) => p.severity === 'error')) return { problems: parsed.problems, project: undefined };
  const r = resolveDescription(parsed.description, sources);
  return { problems: [...parsed.problems, ...r.problems], project: r.resolved && generateProject(r.resolved) };
}

/** The netlist: for each net, its pins (supply symbols left out), as sorted strings. */
function netlist(p: O.Project): string[] {
  const supply = new Set(p.parts.filter((x) => /SUPPLY/.test(x.name) || /supply2\//.test(x.component)).map((x) => x.name));
  return p.nets
    .map((n) => (n.segments ?? []).flatMap((s) => s.pins).filter((r) => !supply.has(r.part)).map((r) => `${r.part}.${r.gate}.${r.pin}`).sort().join(' '))
    .filter(Boolean)
    .sort();
}

describe('schematic generation', () => {
  it('draws wwvbfind2 from its block description with the same netlist as the hand-drawn one', () => {
    const { problems, project } = generate(description);
    expect(problems).toEqual([]);
    expect(netlist(project!)).toEqual(netlist(handDrawn));
    // Every part has its block, and the project is valid as a file.
    expect(project!.parts.filter((p) => !/SUPPLY/.test(p.name)).every((p) => p.attributes?.BLOCK)).toBe(true);
    expect(writeProject(readProject(writeProject(project!)))).toBe(writeProject(project!));
  });

  it('follows the drafting rules: a wire between any two pins, only T junctions, square wires', () => {
    const p = generate(description).project!;
    const index = new ProjectIndex(p);
    const sheet = p.schematic!.sheets[0]!;
    // No two pins at one point: pins never touch each other directly.
    const pins = sheet.gates.flatMap((g) => {
      const c = index.components.get(index.parts.get(g.part)!.component)!;
      const sym = index.symbols.get(c.gates.find((x) => x.name === g.gate)!.symbol)!;
      return sym.pins.map((pin) => pinPosition(index, g, pin.name)!).map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`);
    });
    expect(new Set(pins).size).toBe(pins.length);
    for (const net of p.nets) {
      for (const seg of net.segments ?? []) {
        const ends = new Map<string, number>();
        for (const w of seg.wires) {
          const [a, b] = w.line;
          expect(a[0] === b[0] || a[1] === b[1], `${net.name}: wires are horizontal or vertical`).toBe(true);
          expect(a[0] !== b[0] || a[1] !== b[1], `${net.name}: no zero-length wire`).toBe(true);
          for (const e of [a, b]) ends.set(`${e[0]},${e[1]}`, (ends.get(`${e[0]},${e[1]}`) ?? 0) + 1);
        }
        // At most three wires meet at a point (a T), and every T has its junction dot.
        for (const [pt, n] of ends) {
          expect(n, `${net.name} at ${pt}`).toBeLessThanOrEqual(3);
          if (n === 3) expect(seg.junctions?.some((j) => `${j[0]},${j[1]}` === pt), `${net.name}: junction at ${pt}`).toBe(true);
        }
      }
    }
  });

  it('goes on to placement and routing like any project', () => {
    const p = generate(description).project!;
    const env: StepEnv = { listUserDir: () => [], readUserDir: () => '', readPath: () => undefined, writeOutput: (n) => n, save: () => 'x' };
    const r = runSteps(p, ['place', 'route'], env);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true]);
    expect(r.steps[0]!.summary).toMatch(/^Placed 36 parts/);
  });

  it('reports what is wrong with a description, by line, and draws nothing', () => {
    const { problems, project } = generate(`supply GND supply2/GND
block A
R1 madhu/RESISTOR 10k
R2 madhu/NOPE
R3 madhu/RESISTOR 1k 0805-RES
R3 madhu/RESISTOR 1k 0805-RES
net: R3.1 R3.7
net X: R3.2
GND: R3.2
FOO: R3.1`);
    expect(project).toBeUndefined();
    expect(problems.map((p) => `${p.line} ${p.kind}: ${p.message}`)).toEqual([
      '10 syntax: FOO: is not a supply (declare it: supply FOO <component>), or write "net FOO: …"',
    ]);
    // Once it parses, the library checks: a package to choose, a missing component, a
    // duplicate, a pin that doesn't exist, a pin on two nets.
    const r = generate(`supply GND supply2/GND
block A
R1 madhu/RESISTOR 10k
R2 madhu/NOPE
R3 madhu/RESISTOR 1k 0805-RES
R3 madhu/RESISTOR 1k 0805-RES
net: R3.1 R3.7
net X: R3.2
GND: R3.2`);
    expect(r.project).toBeUndefined();
    expect(r.problems.filter((p) => p.severity === 'error').map((p) => `${p.line} ${p.kind}`)).toEqual(['3 variant', '4 component', '6 duplicate', '7 pin', '9 pin']);
    expect(r.problems[0]!.message).toMatch(/^R1 \(madhu\/RESISTOR\): choose a package: 1206, AXIAL-0.3, /);
  });

  it('warns about pins left unconnected and nets with one pin, unless marked nc', () => {
    const base = `supply GND supply2/GND
block A
R1 madhu/RESISTOR 1k 0805-RES
R2 madhu/RESISTOR 1k 0805-RES
net: R1.2 R2.1
GND: R1.1`;
    const r = generate(base);
    expect(r.problems.map((p) => `${p.severity} ${p.kind}: ${p.message}`)).toEqual(["warning unconnected: R2.2 isn't connected (list it under nc: if that's intended)"]);
    expect(r.project).toBeDefined();
    expect(generate(`${base}\nnc: R2.2`).problems).toEqual([]);
  });
});
