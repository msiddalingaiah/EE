import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { DesignRules, buildBoardScene, mirrorLayer } from '../src/scene/board';
import { indexScene } from '../src/scene/index';
import { buildLibraryScene } from '../src/scene/library';
import { buildSchematicScene } from '../src/scene/schematic';
import type { Prim, TextPrim } from '../src/scene/types';
import { pick, pickBox } from '../src/view/hittest';

const sample = (name: string) => parseEagle(readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8'));
const all = () => true;
const finite = (p: Prim) => Object.values(p).every((v) => typeof v !== 'number' || Number.isFinite(v));

describe('schematic scene', () => {
  const file = sample('TA7358A.sch');
  const scene = buildSchematicScene(file);

  it('produces an owner for every instance and finite primitives', () => {
    const instances = [...scene.owners.values()].filter((o) => o.kind === 'instance');
    expect(instances).toHaveLength(file.schematic!.sheets[0]!.instances.length);
    expect(scene.prims.every(finite)).toBe(true);
    expect(scene.bounds.maxX).toBeGreaterThan(scene.bounds.minX);
  });

  it('substitutes placeholders and hides symbol placeholders on smashed parts', () => {
    const texts = scene.prims.filter((p): p is TextPrim => p.t === 'text').map((t) => t.text);
    expect(texts).toContain('IC1');
    expect(texts.some((t) => /^>(NAME|VALUE)$/i.test(t))).toBe(false);
  });

  it('picks a net wire by clicking on it', () => {
    const idx = indexScene(scene);
    const w = file.schematic!.sheets[0]!.nets[0]!.segments[0]!.wires[0]!;
    const mid = { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
    const hit = pick(idx, mid, 0.2, all);
    expect(scene.owners.get(hit!)?.kind).toBe('net-wire');
  });

  it('box-selects everything inside the full bounds', () => {
    const idx = indexScene(scene);
    const b = scene.bounds;
    const sel = pickBox(idx, { minX: b.minX - 1, minY: b.minY - 1, maxX: b.maxX + 1, maxY: b.maxY + 1 }, false, all);
    expect(sel.length).toBe(idx.ownerPrims.size);
  });
});

describe('board scene', () => {
  const file = sample('TA7358A.brd');
  const scene = buildBoardScene(file);

  it('emits elements, traces, vias and drills', () => {
    const kinds = new Set([...scene.owners.values()].map((o) => o.kind));
    for (const k of ['element', 'signal-wire', 'via', 'signal-polygon', 'plain'] as const) expect(kinds).toContain(k);
    expect(scene.prims.some((p) => p.t === 'drill')).toBe(true);
    expect(scene.prims.every(finite)).toBe(true);
  });

  it('places the board outline at its stored coordinates', () => {
    // Dimension wires in <plain> run from (0,0) to (36.246, 36.82).
    expect(scene.bounds.minX).toBeLessThanOrEqual(0);
    expect(scene.bounds.maxX).toBeGreaterThanOrEqual(36.2);
  });

  it('crossing box inside an unpoured polygon does not select it', () => {
    const idx = indexScene(scene);
    // A small box in the middle of the board touches no polygon outline (they follow the board edge).
    const sel = pickBox(idx, { minX: 17, minY: 17, maxX: 19, maxY: 19 }, true, all);
    expect(sel.some((id) => id.startsWith('signal-polygon:'))).toBe(false);
    // But one crossing the board edge does.
    const edge = pickBox(idx, { minX: -1, minY: 17, maxX: 1, maxY: 19 }, true, all);
    expect(edge.some((id) => id.startsWith('signal-polygon:'))).toBe(true);
  });

  it('mirrors layers for bottom-side parts', () => {
    expect(mirrorLayer(1)).toBe(16);
    expect(mirrorLayer(21)).toBe(22);
    expect(mirrorLayer(2)).toBe(15);
    expect(mirrorLayer(20)).toBe(20);
  });

  it('derives pad diameters from design rules', () => {
    const rules = new DesignRules(new Map([['rvPadTop', '0.25'], ['rlMinPadTop', '10mil'], ['rlMaxPadTop', '20mil']]));
    expect(rules.padDiameter(0.8, 0)).toBeCloseTo(0.8 + 2 * 0.254); // 25% of 0.8 = 0.2 < min 0.254
    expect(rules.padDiameter(3, 0)).toBeCloseTo(3 + 2 * 0.508); // clamped to max
    expect(rules.padDiameter(0.8, 2)).toBe(2); // explicit diameter wins when larger
  });
});

describe('library scene', () => {
  const file = sample('madhu.lbr');
  const lib = file.library!;

  it('renders every symbol, package and device set without throwing', () => {
    for (const name of lib.symbols.keys()) expect(buildLibraryScene(file, { kind: 'symbol', name }).prims.every(finite)).toBe(true);
    for (const name of lib.packages.keys()) expect(buildLibraryScene(file, { kind: 'package', name }).prims.every(finite)).toBe(true);
    for (const name of lib.devicesets.keys()) expect(buildLibraryScene(file, { kind: 'deviceset', name }).prims.every(finite)).toBe(true);
  });
});
