// Build a Scene for one sheet of an Eagle schematic.

import { objId } from '../eagle/dom';
import type { Bus, DeviceSet, EagleFile, Instance, Library, Net, Part, Schematic, Segment, Sheet } from '../eagle/types';
import { attributeOwner } from './text';
import { findLibrary, generatedValue } from '../eagle/parse';
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

  sheet.plain.forEach((g) => {
    const id = b.addOwner({
      id: `plain:${objId(g)}`, kind: 'plain', label: g.kind === 'text' ? `Text "${g.text}"` : g.kind,
      props: [['Type', g.kind]], target: { kind: 'plain', graphic: g, container: sheet.plain },
    });
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
      id: `instance:${objId(inst)}`,
      kind: 'instance',
      target: { kind: 'instance', sheet, instance: inst },
      origin: { x: inst.x, y: inst.y },
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
    if (inst.smashed) emitPlacedAttributes(b, inst, attrs);
  }

  for (const net of sheet.nets) for (const seg of net.segments) emitSegment(b, sheet, net, seg, 'net');
  for (const bus of sheet.busses) for (const seg of bus.segments) emitSegment(b, sheet, bus, seg, 'bus');

  return b.finish();
}

/** Smashed texts are separate owners, so they can be selected and moved on their own. */
function emitPlacedAttributes(b: SceneBuilder, inst: Instance, attrs: Record<string, string>): void {
  for (const a of inst.attributes) {
    if (a.x === undefined || a.y === undefined) continue;
    const text = placedAttributeText(a, a.value ?? attrs[a.name.toUpperCase()]);
    if (!text) continue;
    const owner = b.addOwner(attributeOwner(a, inst.part, 'schematic', inst));
    b.text(text, a.x, a.y, a.size ?? 1.778, a.rot, a.align, a.layer ?? 95, {
      owner, transform: IDENTITY, textContext: 'schematic',
    });
  }
}

function emitSegment(b: SceneBuilder, sheet: Sheet, net: Net | Bus, seg: Segment, kind: 'net' | 'bus'): void {
  const ctx = { transform: IDENTITY, textContext: 'schematic' as const };
  const name = net.name;
  const title = kind === 'net' ? 'Net' : 'Bus';
  seg.wires.forEach((w) => {
    const id = b.addOwner({
      id: `${kind}-wire:${objId(w)}`,
      target: { kind: 'net-wire', sheet, net, segment: seg, wire: w },
      kind: kind === 'net' ? 'net-wire' : 'bus-wire',
      label: `${title} ${name}`,
      net: name,
      props: [[title, name], ['From', fmtXY(w.x1, w.y1)], ['To', fmtXY(w.x2, w.y2)], ['Width', `${w.width} mm`]],
    });
    b.wire(w, { ...ctx, owner: id });
  });
  seg.junctions.forEach((j) => {
    const id = b.addOwner({
      id: `junction:${objId(j)}`, kind: 'junction', label: `Junction on ${name}`, net: name,
      origin: { x: j.x, y: j.y },
      ...(kind === 'net' ? { target: { kind: 'junction' as const, sheet, net: net as Net, segment: seg, junction: j } } : {}),
      props: [['Net', name], ['Position', fmtXY(j.x, j.y)]],
    });
    b.prims.push({ t: 'circle', cx: j.x, cy: j.y, r: JUNCTION_DIAMETER / 2, width: 0, layer: 91, owner: id });
  });
  seg.labels.forEach((l) => {
    const id = b.addOwner({
      id: `label:${objId(l)}`, kind: 'label', label: `Label ${name}`, net: name,
      origin: { x: l.x, y: l.y },
      target: { kind: 'label', sheet, net, segment: seg, label: l },
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
  return ds.uservalue ? '' : generatedValue(ds.name, part.device, part.technology);
}
