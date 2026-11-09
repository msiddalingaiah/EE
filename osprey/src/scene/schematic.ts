// Build a Scene for one sheet of an Eagle schematic.

import type { DeviceSet, EagleFile, Library, Part, PlacedAttribute, Schematic, Segment } from '../eagle/types';
import { findLibrary } from '../eagle/parse';
import { IDENTITY, placement } from '../geom/transform';
import { SceneBuilder } from './builder';
import { buildSymbolInto } from './symbol';
import { fmtRot, fmtXY, placeholderResolver, placedAttributeText } from './text';
import type { Scene } from './types';

const JUNCTION_DIAMETER = 1.016;

interface Resolved {
  part: Part;
  library: Library;
  deviceset: DeviceSet;
}

export function buildSchematicScene(file: EagleFile, sheetIndex = 0): Scene {
  const sch = file.schematic;
  if (!sch) throw new Error('Not a schematic');
  const sheet = sch.sheets[sheetIndex];
  if (!sheet) throw new Error(`Sheet ${sheetIndex + 1} does not exist`);
  const b = new SceneBuilder('schematic', file.layers);

  sheet.plain.forEach((g, i) => {
    const id = b.addOwner({ id: `plain:${i}`, kind: 'plain', label: g.kind, props: [['Type', g.kind]] });
    b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'schematic' });
  });

  for (const inst of sheet.instances) {
    const r = resolvePart(sch, inst.part);
    if (!r) continue;
    const gate = r.deviceset.gates.find((g) => g.name === inst.gate);
    const symbol = gate && r.library.symbols.get(gate.symbol);
    if (!gate || !symbol) continue;

    const device = r.deviceset.devices.find((d) => d.name === r.part.device);
    const multiGate = r.deviceset.gates.length > 1;
    const value = partValue(r.part, r.deviceset);

    const attrs: Record<string, string> = {};
    for (const a of device?.technologies.get(r.part.technology) ?? []) attrs[a.name.toUpperCase()] = a.value;
    for (const a of r.part.attributes) if (a.value !== undefined) attrs[a.name.toUpperCase()] = a.value;
    Object.assign(attrs, {
      NAME: multiGate ? `${r.part.name}${gate.name}` : r.part.name,
      VALUE: value,
      PART: r.part.name,
      GATE: gate.name,
    });
    const resolve = placeholderResolver(attrs);

    const id = b.addOwner({
      id: `instance:${inst.part}:${inst.gate}`,
      kind: 'instance',
      label: multiGate ? `${inst.part} (gate ${inst.gate})` : inst.part,
      props: [
        ['Part', inst.part],
        ['Gate', inst.gate],
        ['Value', value],
        ['Library', r.library.name],
        ['Device set', r.deviceset.name],
        ['Device', r.part.device || "''"],
        ['Symbol', symbol.name],
        ['Position', fmtXY(inst.x, inst.y)],
        ['Rotation', fmtRot(inst.rot)],
      ],
    });

    const pads = new Map<string, string>();
    for (const c of device?.connects ?? []) if (c.gate === gate.name) pads.set(c.pin, c.pads.join(' '));

    // Smashed instances carry their own attribute texts in place of the symbol's placeholders.
    buildSymbolInto(b, symbol, placement(inst.x, inst.y, inst.rot), id, pads, (t) =>
      inst.smashed && t.startsWith('>') ? undefined : resolve(t),
    );
    if (inst.smashed) emitPlacedAttributes(b, inst.attributes, attrs, id);
  }

  for (const net of sheet.nets) net.segments.forEach((seg, si) => emitSegment(b, seg, net.name, si, 'net'));
  for (const bus of sheet.busses) bus.segments.forEach((seg, si) => emitSegment(b, seg, bus.name, si, 'bus'));

  return b.finish();
}

function emitPlacedAttributes(
  b: SceneBuilder, placed: PlacedAttribute[], attrs: Record<string, string>, owner: string,
): void {
  for (const a of placed) {
    if (a.x === undefined || a.y === undefined) continue;
    const text = placedAttributeText(a, a.value ?? attrs[a.name.toUpperCase()]);
    if (!text) continue;
    b.text(text, a.x, a.y, a.size ?? 1.778, a.rot, a.align, a.layer ?? 95, {
      owner, transform: IDENTITY, textContext: 'schematic',
    });
  }
}

function emitSegment(b: SceneBuilder, seg: Segment, name: string, si: number, kind: 'net' | 'bus'): void {
  const ctx = { transform: IDENTITY, textContext: 'schematic' as const };
  const title = kind === 'net' ? 'Net' : 'Bus';
  seg.wires.forEach((w, wi) => {
    const id = b.addOwner({
      id: `${kind}-wire:${name}:${si}:${wi}`,
      kind: kind === 'net' ? 'net-wire' : 'bus-wire',
      label: `${title} ${name}`,
      net: name,
      props: [[title, name], ['From', fmtXY(w.x1, w.y1)], ['To', fmtXY(w.x2, w.y2)], ['Width', `${w.width} mm`]],
    });
    b.wire(w, { ...ctx, owner: id });
  });
  seg.junctions.forEach((j, ji) => {
    const id = b.addOwner({
      id: `junction:${name}:${si}:${ji}`, kind: 'junction', label: `Junction on ${name}`, net: name,
      props: [['Net', name], ['Position', fmtXY(j.x, j.y)]],
    });
    b.prims.push({ t: 'circle', cx: j.x, cy: j.y, r: JUNCTION_DIAMETER / 2, width: 0, layer: 91, owner: id });
  });
  seg.labels.forEach((l, li) => {
    const id = b.addOwner({
      id: `label:${name}:${si}:${li}`, kind: 'label', label: `Label ${name}`, net: name,
      props: [['Net', name], ['Position', fmtXY(l.x, l.y)], ['Cross-reference', l.xref ? 'yes' : 'no']],
    });
    b.text(name, l.x, l.y, l.size, l.rot, l.align, l.layer, { ...ctx, owner: id });
  });
}

function resolvePart(sch: Schematic, partName: string): Resolved | undefined {
  const part = sch.parts.get(partName);
  if (!part) return undefined;
  const library = findLibrary(sch.libraries, part.library, part.libraryUrn);
  const deviceset = library?.devicesets.get(part.deviceset);
  if (!library || !deviceset) return undefined;
  return { part, library, deviceset };
}

/** Eagle shows the deviceset+device name as the value when none was set. */
export function partValue(part: Part, ds: DeviceSet): string {
  if (part.value !== undefined) return part.value;
  return ds.uservalue ? '' : `${ds.name}${part.device}`;
}
