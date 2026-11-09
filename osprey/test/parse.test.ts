import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EagleParseError, parseDistance, parseEagle, parseRotation } from '../src/eagle/parse';

const sample = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');

describe('values', () => {
  it('parses rotations', () => {
    expect(parseRotation(undefined)).toEqual({ angle: 0, mirror: false, spin: false });
    expect(parseRotation('R90')).toEqual({ angle: 90, mirror: false, spin: false });
    expect(parseRotation('MR180')).toEqual({ angle: 180, mirror: true, spin: false });
    expect(parseRotation('SMR270')).toEqual({ angle: 270, mirror: true, spin: true });
    expect(parseRotation('R-90').angle).toBe(270);
    expect(parseRotation('R22.5').angle).toBe(22.5);
    expect(() => parseRotation('X90')).toThrow(EagleParseError);
  });

  it('parses design-rule distances to mm', () => {
    expect(parseDistance('10mil')).toBeCloseTo(0.254);
    expect(parseDistance('0.4mm')).toBe(0.4);
    expect(parseDistance('0.1inch')).toBeCloseTo(2.54);
    expect(parseDistance('100mic')).toBeCloseTo(0.1);
    expect(parseDistance('1.5')).toBe(1.5);
  });
});

describe('errors', () => {
  it('rejects non-XML and non-Eagle input', () => {
    expect(() => parseEagle('not xml')).toThrow(EagleParseError);
    expect(() => parseEagle('<?xml version="1.0"?><svg/>')).toThrow(/Not an Eagle XML file/);
  });
});

describe('TA7358A.sch', () => {
  const f = parseEagle(sample('TA7358A.sch'));
  const sch = f.schematic!;

  it('reads the header', () => {
    expect(f.version).toBe('9.6.2');
    expect(f.layers.find((l) => l.number === 91)?.name).toBe('Nets');
    expect(f.board).toBeUndefined();
  });

  it('reads libraries, parts and the sheet', () => {
    expect(sch.libraries.map((l) => l.name)).toEqual(['madhu', 'supply2', 'linear']);
    expect(sch.libraries[1]!.urn).toBe('urn:adsk.eagle:library:372');
    expect(sch.parts.size).toBe(42);
    expect(sch.sheets).toHaveLength(1);
    const sheet = sch.sheets[0]!;
    expect(sheet.instances).toHaveLength(43);
    expect(sheet.nets).toHaveLength(18);
  });

  it('reads instance placement and smashed attributes', () => {
    const l1 = sch.sheets[0]!.instances.find((i) => i.part === 'L1')!;
    expect(l1).toMatchObject({ gate: 'A', x: -48.26, y: 55.88, smashed: true });
    expect(l1.rot.angle).toBe(180);
    expect(l1.attributes[0]).toMatchObject({ name: 'NAME', x: -44.45, y: 54.864, size: 1.778, layer: 95 });
  });

  it('reads net segments with wires, junctions and pinrefs', () => {
    const totals = { wires: 0, junctions: 0, pinrefs: 0 };
    for (const n of sch.sheets[0]!.nets) {
      for (const s of n.segments) {
        totals.wires += s.wires.length;
        totals.junctions += s.junctions.length;
        totals.pinrefs += s.pinrefs.length;
      }
    }
    expect(totals.junctions).toBe(38);
    expect(totals.pinrefs).toBe(89);
    expect(totals.wires).toBeGreaterThan(0);
  });

  it('resolves device connects to pads', () => {
    const lib = sch.libraries.find((l) => l.name === 'linear')!;
    const ds = [...lib.devicesets.values()][0]!;
    expect(ds.devices[0]!.connects.length).toBeGreaterThan(0);
    for (const c of ds.devices[0]!.connects) expect(c.pads.length).toBeGreaterThan(0);
  });
});

describe('TA7358A.brd', () => {
  const f = parseEagle(sample('TA7358A.brd'));
  const brd = f.board!;

  it('reads elements, signals and design rules', () => {
    expect(brd.elements).toHaveLength(32);
    expect(brd.signals).toHaveLength(18);
    expect(brd.designRules.get('rlMinPadTop')).toBe('5mil');
    const ic = brd.elements.find((e) => e.name === 'IC1')!;
    expect(ic).toMatchObject({ package: 'SIP9-P-2.54A', value: 'TA7358P', libraryUrn: 'urn:adsk.eagle:library:262' });
  });

  it('reads vias, holes and signal polygons', () => {
    expect(brd.signals.flatMap((s) => s.vias)).toHaveLength(4);
    expect(brd.plain.filter((g) => g.kind === 'hole')).toHaveLength(4);
    const gnd = brd.signals.find((s) => s.name === 'GND')!;
    expect(gnd.polygons[0]).toMatchObject({ layer: 16, isolate: 0.254 });
    expect(gnd.polygons[0]!.vertices).toHaveLength(4);
  });
});

describe('madhu.lbr', () => {
  const lib = parseEagle(sample('madhu.lbr')).library!;

  it('reads every symbol, package and device set', () => {
    expect(lib.symbols.size).toBe(111);
    expect(lib.packages.size).toBe(123);
    expect(lib.devicesets.size).toBe(135);
  });

  it('every device references an existing package, and every gate an existing symbol', () => {
    for (const ds of lib.devicesets.values()) {
      for (const g of ds.gates) expect(lib.symbols.has(g.symbol), `${ds.name} gate ${g.name}`).toBe(true);
      for (const d of ds.devices) {
        if (d.package) expect(lib.packages.has(d.package), `${ds.name} device ${d.name}`).toBe(true);
      }
    }
  });
});
