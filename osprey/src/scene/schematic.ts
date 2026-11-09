// Build a Scene for one sheet of a project's schematic (native model).

import { objId } from '../eagle/dom';
import type { Layer } from '../eagle/types';
import { componentName, ProjectIndex } from '../model/derive';
import { gateTransform, rotation } from '../model/geometry';
import { layerNumber } from '../model/layers';
import type * as O from '../model/types';
import { SceneBuilder } from './builder';
import { buildSymbolInto } from './symbol';
import { fmtRot, fmtXY, labelOwner, labelText, placeholderResolver } from './text';
import type { Scene, WireSegment } from './types';

const JUNCTION_DIAMETER = 1.016;
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function buildSchematicScene(project: O.Project, layers: Layer[], sheetIndex = 0, index = new ProjectIndex(project)): Scene {
  const sch = project.schematic;
  if (!sch) throw new Error('The project has no schematic');
  const sheet = sch.sheets[sheetIndex];
  if (!sheet) throw new Error(`Sheet ${sheetIndex + 1} does not exist`);
  const b = new SceneBuilder('schematic', layers);

  for (const g of sheet.drawing) {
    const id = b.addOwner({
      id: `drawing:${objId(g)}`, kind: 'drawing', label: 'text' in g ? `Text "${g.text}"` : drawingKind(g),
      props: [['Type', drawingKind(g)]], target: { kind: 'drawing', doc: 'schematic', graphic: g, container: sheet.drawing },
    });
    b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'schematic' });
  }

  for (const gp of sheet.gates) {
    const part = index.parts.get(gp.part);
    const component = part && index.components.get(part.component);
    const gate = component?.gates.find((x) => x.name === gp.gate);
    const symbol = gate && index.symbols.get(gate.symbol);
    if (!part || !component || !gate || !symbol) continue;

    const variant = index.variantOf(part);
    const multiGate = component.gates.length > 1;
    const value = index.valueOf(part);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(variant?.technologies?.[part.technology ?? ''] ?? {})) {
      attrs[k.toUpperCase()] = typeof v === 'string' ? v : v.value;
    }
    for (const [k, v] of Object.entries(part.attributes ?? {})) attrs[k.toUpperCase()] = v;
    Object.assign(attrs, { NAME: multiGate ? `${part.name}${gate.name}` : part.name, VALUE: value, PART: part.name, GATE: gate.name });
    const resolve = placeholderResolver(attrs);

    const id = b.addOwner({
      id: `gate:${objId(gp)}`,
      kind: 'gate',
      label: multiGate ? `${part.name} (gate ${gate.name})` : part.name,
      props: [
        ['Part', part.name],
        ['Gate', gate.name],
        ['Value', value],
        ['Component', componentName(component.id)],
        ['Library', component.id.slice(0, component.id.indexOf('/'))],
        ['Variant', part.variant || "''"],
        ['Position', fmtXY(gp.at[0], gp.at[1])],
        ['Rotation', fmtRot(gp.rot, gp.mirror)],
      ],
      target: { kind: 'gate', sheet, gate: gp },
      origin: { x: gp.at[0], y: gp.at[1] },
    });

    const pads = new Map<string, string>();
    for (const [key, list] of Object.entries(variant?.pads ?? {})) {
      const [g, pin] = splitPinKey(key);
      if (g === gate.name) pads.set(pin, list.join(' '));
    }
    // Smashed gates show their own labels instead of the symbol's placeholders.
    const smashed = gp.smashed || (gp.labels?.length ?? 0) > 0;
    buildSymbolInto(b, symbol, gateTransform(gp), id, pads, (t) => (smashed && t.startsWith('>') ? undefined : resolve(t)));
    for (const l of gp.labels ?? []) {
      const text = labelText(l, l.value ?? attrs[l.attr.toUpperCase()]);
      if (!text) continue;
      const owner = b.addOwner(labelOwner(l, part.name, 'schematic', gp));
      b.text(text, l.at[0], l.at[1], l.size, rotation(l.rot, l.mirror, l.spin), l.align ?? 'bottom-left', layerNumber(l.layer), {
        owner, transform: IDENTITY, textContext: 'schematic',
      });
    }
  }

  const sheetId = sheet.id;
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) if (seg.sheet === sheetId) emitSegment(b, net, seg, 'nets');
  }
  for (const bus of project.busses ?? []) {
    for (const seg of bus.segments) if (seg.sheet === sheetId) emitSegment(b, bus, seg, 'busses');
  }
  return b.finish();
}

function emitSegment(b: SceneBuilder, net: O.Net | O.Bus, seg: WireSegment, layer: 'nets' | 'busses'): void {
  const ctx = { transform: IDENTITY, textContext: 'schematic' as const };
  const isBus = layer === 'busses';
  const title = isBus ? 'Bus' : 'Net';
  for (const w of seg.wires) {
    const id = b.addOwner({
      id: `wire:${objId(w)}`,
      kind: isBus ? 'bus-wire' : 'wire',
      label: `${title} ${net.name}`,
      net: net.name,
      props: [[title, net.name], ['From', fmtXY(w.line[0][0], w.line[0][1])], ['To', fmtXY(w.line[1][0], w.line[1][1])], ['Width', `${w.width} mm`]],
      target: { kind: 'wire', net, segment: seg, wire: w, ...(isBus ? { bus: true as const } : {}) },
    });
    b.line(w, w.layer ?? layer, { ...ctx, owner: id });
  }
  if ('junctions' in seg) {
    for (const j of seg.junctions ?? []) {
      const id = b.addOwner({
        id: `junction:${objId(j)}`, kind: 'junction', label: `Junction on ${net.name}`, net: net.name,
        props: [['Net', net.name], ['Position', fmtXY(j[0], j[1])]],
        target: { kind: 'junction', net: net as O.Net, segment: seg as O.Segment, junction: j },
        origin: { x: j[0], y: j[1] },
      });
      b.prims.push({ t: 'circle', cx: j[0], cy: j[1], r: JUNCTION_DIAMETER / 2, width: 0, layer: 91, owner: id });
    }
  }
  for (const l of seg.labels ?? []) {
    const id = b.addOwner({
      id: `netlabel:${objId(l)}`, kind: 'netlabel', label: `Label ${net.name}`, net: net.name,
      props: [[title, net.name], ['Position', fmtXY(l.at[0], l.at[1])], ['Cross-reference', l.xref ? 'yes' : 'no']],
      target: { kind: 'netlabel', net, segment: seg, label: l },
      origin: { x: l.at[0], y: l.at[1] },
    });
    b.text(net.name, l.at[0], l.at[1], l.size, rotation(l.rot, l.mirror, l.spin), l.align ?? 'bottom-left', layerNumber(l.layer), { ...ctx, owner: id });
  }
}

/** "gate.pin" → [gate, pin]; pin names may contain dots, gate names don't. */
export function splitPinKey(key: string): [string, string] {
  const i = key.indexOf('.');
  return [key.slice(0, i), key.slice(i + 1)];
}

export function drawingKind(g: O.Graphic): string {
  return 'line' in g ? 'line' : 'circle' in g ? 'circle' : 'rect' in g ? 'rectangle' : 'polygon' in g ? 'polygon'
    : 'text' in g ? 'text' : 'hole' in g ? 'hole' : 'frame';
}
