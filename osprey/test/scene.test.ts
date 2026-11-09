import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { importEagle, importLibrary } from '../src/model/import-eagle';
import { buildBoardScene } from '../src/scene/board';
import { indexScene } from '../src/scene/index';
import { buildLibraryScene } from '../src/scene/library';
import { buildSchematicScene } from '../src/scene/schematic';
import type { Prim, TextPrim } from '../src/scene/types';
import { pick, pickBox } from '../src/view/hittest';
import { displayLayers } from '../src/view/palette';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');
const load = () => importEagle([{ name: 'TA7358A.sch', file: parseEagle(raw('TA7358A.sch')) }, { name: 'TA7358A.brd', file: parseEagle(raw('TA7358A.brd')) }]).project;
const layers = displayLayers();
const all = () => true;
const finite = (p: Prim) => Object.values(p).every((v) => typeof v !== 'number' || Number.isFinite(v));

describe('schematic scene', () => {
  const p = load();
  const scene = buildSchematicScene(p, layers);

  it('has an owner per gate, finite primitives, resolved placeholders', () => {
    const gates = [...scene.owners.values()].filter((o) => o.kind === 'gate');
    expect(gates).toHaveLength(p.schematic!.sheets[0]!.gates.length);
    expect(scene.prims.every(finite)).toBe(true);
    const texts = scene.prims.filter((x): x is TextPrim => x.t === 'text').map((t) => t.text);
    expect(texts).toContain('IC1');
    expect(texts).toContain('TA7358P');
    expect(texts.some((t) => /^>(NAME|VALUE)$/i.test(t))).toBe(false);
  });

  it('picks a net wire, and window-selects a part by its origin', () => {
    const idx = indexScene(scene);
    const w = p.nets.find((n) => n.name === 'N$1')!.segments![0]!.wires[0]!;
    const mid = { x: (w.line[0][0] + w.line[1][0]) / 2, y: (w.line[0][1] + w.line[1][1]) / 2 };
    expect(scene.owners.get(pick(idx, mid, 0.2, all)!)?.kind).toBe('wire');
    const ic = [...scene.owners.values()].find((o) => o.kind === 'gate' && o.label === 'IC1')!;
    const box = { minX: ic.origin!.x - 1, minY: ic.origin!.y - 1, maxX: ic.origin!.x + 1, maxY: ic.origin!.y + 1 };
    expect(pickBox(idx, box, false, all)).toContain(ic.id);
  });
});

describe('board scene', () => {
  it('draws footprints, traces, vias, pours and drills; no airwires when routed', () => {
    const p = load();
    const scene = buildBoardScene(p, layers);
    const kinds = new Set([...scene.owners.values()].map((o) => o.kind));
    for (const k of ['footprint', 'trace', 'via', 'pour', 'drawing', 'label'] as const) expect(kinds).toContain(k);
    expect(kinds.has('airwire')).toBe(false);
    expect(scene.prims.some((x) => x.t === 'drill')).toBe(true);
    expect(scene.prims.every(finite)).toBe(true);
    expect(scene.bounds.minX).toBeLessThanOrEqual(0);
    expect(scene.bounds.maxX).toBeGreaterThanOrEqual(36.2);
  });

  it('shows airwires once a connection is broken', () => {
    const p = load();
    p.nets.find((n) => n.name === 'N$1')!.traces!.pop();
    const airwires = [...buildBoardScene(p, layers).owners.values()].filter((o) => o.kind === 'airwire');
    expect(airwires).toHaveLength(1);
    expect(airwires[0]!.net).toBe('N$1');
  });

  it('draws pours filled (with holes), or as dashed outlines only; airwires count the copper either way', () => {
    const p = load();
    const pourPrims = (showPours: boolean) => {
      const scene = buildBoardScene(p, layers, undefined, { showPours });
      const ids = new Set([...scene.owners.values()].filter((o) => o.kind === 'pour').map((o) => o.id));
      return { prims: scene.prims.filter((x) => ids.has(x.owner)), airwires: [...scene.owners.values()].filter((o) => o.kind === 'airwire') };
    };
    const shown = pourPrims(true);
    expect(shown.prims.some((x) => x.t === 'poly' && x.fill && (x.holes?.length ?? 0) > 0)).toBe(true);
    const hidden = pourPrims(false);
    expect(hidden.prims.every((x) => x.t === 'poly' && !x.fill && x.dash && x.width > 0)).toBe(true);
    expect(hidden.prims).toHaveLength(2);
    expect(hidden.airwires).toEqual(shown.airwires);
  });
});

describe('library scene', () => {
  it('renders every component, symbol and footprint of a library', () => {
    const lib = importLibrary('madhu.lbr', parseEagle(raw('madhu.lbr')));
    expect(lib.components.length).toBe(135);
    expect(lib.symbols.length).toBe(111);
    expect(lib.footprints.length).toBe(123);
    for (const c of lib.components) expect(buildLibraryScene(lib, layers, { kind: 'component', id: c.id }).prims.every(finite)).toBe(true);
    for (const s of lib.symbols) expect(buildLibraryScene(lib, layers, { kind: 'symbol', id: s.id }).prims.every(finite)).toBe(true);
    for (const f of lib.footprints) expect(buildLibraryScene(lib, layers, { kind: 'footprint', id: f.id }).prims.every(finite)).toBe(true);
  });
});
