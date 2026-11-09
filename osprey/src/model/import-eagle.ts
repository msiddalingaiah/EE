// Eagle → Osprey: convert a parsed schematic and/or board into the native project model
// (docs/format.md, "Import and export"). Eagle data the model doesn't cover goes into the
// passthrough; disagreements between schematic and board are reported, never hidden.

import { domOf } from '../eagle/dom';
import type * as E from '../eagle/types';
import { checkConsistency } from '../project/consistency';
import { isStandardLayer, layerName } from './layers';
import { extrasOf, toJsonML, unknownChildren } from './passthrough';
import type * as O from './types';
import { FORMAT_VERSION } from './types';

export interface ImportSource {
  name: string;
  file: E.EagleFile;
}

export interface ImportResult {
  project: O.Project;
  /** Things the user should know: inconsistencies, conflicting library copies… */
  report: string[];
}

// Attributes and children each XML element type maps to native fields; anything else is passthrough.
const KNOWN = {
  part: ['name', 'library', 'library_urn', 'deviceset', 'device', 'technology', 'value'],
  instance: ['part', 'gate', 'x', 'y', 'smashed', 'rot'],
  element: ['name', 'library', 'library_urn', 'package', 'value', 'x', 'y', 'locked', 'smashed', 'rot'],
  attribute: ['name', 'value', 'x', 'y', 'size', 'layer', 'ratio', 'rot', 'display', 'align', 'font'],
  wire: ['x1', 'y1', 'x2', 'y2', 'width', 'layer', 'curve', 'cap', 'style'],
  text: ['x', 'y', 'size', 'layer', 'font', 'ratio', 'rot', 'align'],
  circle: ['x', 'y', 'radius', 'width', 'layer'],
  rectangle: ['x1', 'y1', 'x2', 'y2', 'layer', 'rot'],
  polygon: ['width', 'layer', 'spacing', 'pour', 'isolate', 'rank', 'thermals', 'orphans'],
  hole: ['x', 'y', 'drill'],
  frame: ['x1', 'y1', 'x2', 'y2', 'columns', 'rows', 'layer'],
  pad: ['name', 'x', 'y', 'drill', 'diameter', 'shape', 'rot', 'first', 'thermals'],
  smd: ['name', 'x', 'y', 'dx', 'dy', 'layer', 'roundness', 'rot', 'stop', 'cream', 'thermals'],
  pin: ['name', 'x', 'y', 'visible', 'length', 'direction', 'function', 'swaplevel', 'rot'],
  gate: ['name', 'symbol', 'x', 'y', 'addlevel', 'swaplevel'],
  device: ['name', 'package'],
  deviceset: ['name', 'prefix', 'uservalue'],
  symbol: ['name'],
  package: ['name'],
  via: ['x', 'y', 'extent', 'drill', 'diameter', 'shape'],
  signal: ['name', 'class'],
  net: ['name', 'class'],
  label: ['x', 'y', 'size', 'layer', 'font', 'ratio', 'rot', 'xref', 'align'],
  class: ['number', 'name', 'width', 'drill'],
} as const;
const GRAPHIC_CHILDREN = ['description', 'wire', 'circle', 'rectangle', 'polygon', 'text', 'hole', 'frame'];

/** Import a schematic and/or board. Throws if neither is given. */
export function importEagle(sources: ImportSource[], date = new Date().toISOString().slice(0, 10)): ImportResult {
  const sch = sources.find((s) => s.file.schematic);
  const brd = sources.find((s) => s.file.board);
  if (!sch && !brd) throw new Error('Import needs an Eagle schematic (.sch) and/or board (.brd)');
  const report: string[] = [];
  const S = sch?.file.schematic;
  const B = brd?.file.board;

  if (S && B) {
    for (const issue of checkConsistency(S, B)) report.push(`Inconsistent: ${issue.message}`);
  }

  const lib = new LibraryBuilder(report);
  if (S) for (const l of S.libraries) lib.addSchematicLibrary(l);
  if (B) for (const l of B.libraries) lib.addBoardLibrary(l);

  const project: O.Project = {
    osprey: FORMAT_VERSION,
    project: {
      name: (sch ?? brd)!.name.replace(/\.[^.]*$/, ''),
      imported: { from: sources.map((s) => s.name), date, eagleVersion: (sch ?? brd)!.file.version },
    },
    library: lib.result(),
    parts: [],
    nets: [],
  };

  // Parts: from the schematic; board-only elements get a footprint-only component.
  const partNames = new Set<string>();
  if (S) {
    for (const p of S.parts.values()) {
      project.parts.push(convertPart(p, lib.key(p.library, p.libraryUrn)));
      partNames.add(p.name);
    }
  }
  if (B) {
    for (const el of B.elements) {
      if (partNames.has(el.name)) continue;
      const fp = `${lib.key(el.library, el.libraryUrn)}/${el.package}`;
      project.parts.push({ name: el.name, component: lib.footprintOnlyComponent(fp), variant: '', value: el.value });
      partNames.add(el.name);
      if (S) report.push(`Board element ${el.name} has no schematic part; imported as a board-only part`);
    }
    project.library = lib.result();
  }

  // Nets: schematic wiring (segments) + board routing (traces, vias, pours).
  const nets = new Map<string, O.Net>();
  const netFor = (name: string, cls: number): O.Net => {
    let n = nets.get(name);
    if (!n) {
      n = { name };
      if (cls) n.class = cls;
      nets.set(name, n);
    }
    return n;
  };
  if (S) {
    S.sheets.forEach((sheet, i) => {
      for (const net of sheet.nets) {
        const n = netFor(net.name, net.netClass);
        const ex = extrasOf(net, KNOWN.net, ['segment']);
        if (ex) n.eagle = ex;
        for (const seg of net.segments) (n.segments ??= []).push(convertSegment(seg, String(i + 1), 'nets'));
      }
    });
  }
  if (B) {
    for (const sig of B.signals) {
      const n = netFor(sig.name, sig.netClass);
      const traces = sig.wires.filter((w) => w.layer !== 19).map((w) => convertLine(w) as O.Trace);
      if (traces.length) n.traces = traces;
      if (sig.vias.length) n.vias = sig.vias.map(convertVia);
      if (sig.polygons.length) n.pours = sig.polygons.map(convertPolygon);
      const ex = extrasOf(sig, KNOWN.signal, ['contactref', 'wire', 'via', 'polygon']);
      if (ex) n.eagle = { ...n.eagle, ...ex };
      // Without schematic wiring, the board's pad list is the only record of connectivity.
      if (!n.segments?.length && sig.contactrefs.length) {
        n.pads = sig.contactrefs.map((c) => ({ part: c.element, pad: c.pad }));
        if (S) report.push(`Net ${sig.name} exists only on the board`);
      }
    }
  }
  project.nets = [...nets.values()];

  // Busses (schematic only, graphical).
  if (S) {
    const busses = new Map<string, O.Bus>();
    S.sheets.forEach((sheet, i) => {
      for (const bus of sheet.busses) {
        let b = busses.get(bus.name);
        if (!b) busses.set(bus.name, (b = { name: bus.name, segments: [] }));
        for (const seg of bus.segments) {
          const s = convertSegment(seg, String(i + 1), 'busses');
          b.segments.push({ sheet: s.sheet, wires: s.wires, ...(s.labels ? { labels: s.labels } : {}) });
        }
      }
    });
    if (busses.size) project.busses = [...busses.values()];
  }

  if (S) {
    project.schematic = {
      grid: convertGrid(sch!.file.grid, 2.54),
      sheets: S.sheets.map((sheet, i) => convertSheet(sheet, String(i + 1))),
    };
  }
  if (B) {
    const board: O.Board = {
      grid: convertGrid(brd!.file.grid, 1.27),
      layers: copperStack(B),
      footprints: B.elements.map(convertElement),
      drawing: B.plain.map(convertGraphic),
    };
    const classes = (B.classes.length ? B.classes : S?.classes ?? []).map(convertClass);
    if (classes.length) board.classes = classes;
    project.board = board;
  }

  // Document-level passthrough: everything in each Eagle file the model doesn't cover.
  const passthrough: O.DocumentPassthrough = {};
  if (sch) passthrough.schematic = documentExtras(sch.file, 'schematic');
  if (brd) passthrough.board = documentExtras(brd.file, 'board');
  project.eagle = passthrough;

  return { project, report };
}

/** Import an Eagle library (.lbr) as a native library, keyed by the library's file name. */
export function importLibrary(name: string, file: E.EagleFile): O.Library {
  if (!file.library) throw new Error(`${name} is not an Eagle library`);
  const builder = new LibraryBuilder([]);
  // A .lbr file's <library> element has no name; the file name stands in for it.
  builder.addSchematicLibrary({ ...file.library, name: file.library.name || name.replace(/\.[^.]*$/, '') });
  return builder.result();
}

// ---------------------------------------------------------------------------
// Library

class LibraryBuilder {
  private symbols = new Map<string, O.Symbol>();
  private footprints = new Map<string, O.Footprint>();
  private components = new Map<string, O.Component>();
  /** Library keys: the name, plus the URN when two libraries share a name. */
  private keys = new Map<string, string>();
  private namesSeen = new Map<string, string | undefined>();

  constructor(private readonly report: string[]) {}

  key(name: string, urn: string | undefined): string {
    const k = `${name}\u0000${urn ?? ''}`;
    let key = this.keys.get(k);
    if (!key) {
      const clash = this.namesSeen.has(name) && this.namesSeen.get(name) !== urn;
      key = clash ? `${name}@${urn ?? 'local'}` : name;
      if (!this.namesSeen.has(name)) this.namesSeen.set(name, urn);
      this.keys.set(k, key);
    }
    return key;
  }

  addSchematicLibrary(l: E.Library): void {
    const k = this.key(l.name, l.urn);
    for (const s of l.symbols.values()) this.symbols.set(`${k}/${s.name}`, convertSymbol(s, `${k}/${s.name}`));
    for (const d of l.devicesets.values()) this.components.set(`${k}/${d.name}`, convertComponent(d, k));
    // Footprints too, in case the board is missing; the board's copies win below.
    for (const p of l.packages.values()) this.footprints.set(`${k}/${p.name}`, convertFootprint(p, `${k}/${p.name}`));
  }

  addBoardLibrary(l: E.Library): void {
    const k = this.key(l.name, l.urn);
    for (const p of l.packages.values()) {
      const id = `${k}/${p.name}`;
      const fp = convertFootprint(p, id);
      const prev = this.footprints.get(id);
      if (prev && JSON.stringify(prev) !== JSON.stringify(fp)) {
        this.report.push(`Footprint ${id} differs between the schematic's and the board's library copies; using the board's`);
      }
      this.footprints.set(id, fp);
    }
  }

  /** A component standing for a bare footprint (a board element with no schematic part). */
  footprintOnlyComponent(footprint: string): string {
    const id = `${footprint}#footprint`;
    if (!this.components.has(id)) {
      this.components.set(id, { id, gates: [], variants: [{ name: '', footprint, pads: {} }] });
    }
    return id;
  }

  result(): O.Library {
    const sorted = <T extends { id: string }>(m: Map<string, T>) => [...m.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { symbols: sorted(this.symbols), footprints: sorted(this.footprints), components: sorted(this.components) };
  }
}

const DIRECTION: Record<E.PinDirection, O.PinDirection> = {
  nc: 'nc', in: 'in', out: 'out', io: 'io', oc: 'oc', pwr: 'power', pas: 'passive', hiz: 'hiz', sup: 'supply',
};

function convertSymbol(s: E.Symbol, id: string): O.Symbol {
  const out: O.Symbol = { id, graphics: s.graphics.map(convertGraphic), pins: s.pins.map(convertPin) };
  if (s.description) out.description = s.description;
  return withExtras(out, s, KNOWN.symbol, [...GRAPHIC_CHILDREN, 'pin']);
}

function convertPin(p: E.Pin): O.Pin {
  const out: O.Pin = { name: p.name, at: [p.x, p.y] };
  if (p.rot.angle) out.rot = p.rot.angle;
  if (p.length !== 'long') out.length = p.length;
  const dir = DIRECTION[p.direction];
  if (dir !== 'io') out.direction = dir;
  if (p.function !== 'none') out.function = p.function === 'clk' ? 'clock' : p.function === 'dotclk' ? 'dotclock' : 'dot';
  if (p.visible !== 'both') out.visible = p.visible === 'off' ? 'none' : p.visible;
  if (p.swaplevel) out.swap = p.swaplevel;
  return withExtras(out, p, KNOWN.pin);
}

function convertFootprint(p: E.Package, id: string): O.Footprint {
  const out: O.Footprint = { id, graphics: p.graphics.map(convertGraphic), pads: p.pads.map(convertPad) };
  if (p.description) out.description = p.description;
  return withExtras(out, p, KNOWN.package, [...GRAPHIC_CHILDREN, 'pad', 'smd']);
}

function convertPad(p: E.Pad | E.Smd): O.Pad {
  const out: O.Pad = { name: p.name, at: [p.x, p.y] };
  const el = domOf(p);
  if (p.kind === 'smd') {
    out.smd = [p.dx, p.dy];
    if (p.roundness) out.roundness = p.roundness;
    if (p.layer === 16) out.side = 'bottom';
    if (el?.getAttribute('stop') === 'no') out.mask = false;
    if (el?.getAttribute('cream') === 'no') out.paste = false;
  } else {
    out.drill = p.drill;
    if (p.diameter) out.diameter = p.diameter;
    if (p.shape !== 'round') out.shape = p.shape;
    if (p.first) out.first = true;
  }
  if (p.rot.angle) out.rot = p.rot.angle;
  if (el?.getAttribute('thermals') === 'no') out.thermals = false;
  return withExtras(out, p, p.kind === 'smd' ? KNOWN.smd : KNOWN.pad);
}

function convertComponent(d: E.DeviceSet, libKey: string): O.Component {
  const out: O.Component = {
    id: `${libKey}/${d.name}`,
    gates: d.gates.map((g) => {
      const gate: O.Gate = { name: g.name, symbol: `${libKey}/${g.symbol}`, at: [g.x, g.y] };
      if (g.addlevel !== 'next') gate.addLevel = g.addlevel as O.Gate['addLevel'];
      if (g.swaplevel) gate.swap = g.swaplevel;
      return withExtras(gate, g, KNOWN.gate);
    }),
    variants: d.devices.map((dev) => convertVariant(dev, libKey)),
  };
  if (d.prefix) out.prefix = d.prefix;
  if (d.uservalue) out.userValue = true;
  if (d.description) out.description = d.description;
  return withExtras(out, d, KNOWN.deviceset, ['description', 'gates', 'devices']);
}

function convertVariant(dev: E.Device, libKey: string): O.Variant {
  const pads: Record<string, string[]> = {};
  for (const c of dev.connects) pads[`${c.gate}.${c.pin}`] = c.pads;
  const v: O.Variant = { name: dev.name, pads };
  if (dev.package) v.footprint = `${libKey}/${dev.package}`;
  const techs = [...dev.technologies.entries()];
  const trivial = techs.length === 1 && techs[0]![0] === '' && techs[0]![1].length === 0;
  if (techs.length && !trivial) {
    v.technologies = {};
    for (const [name, attrs] of techs) {
      const rec: Record<string, O.AttributeValue> = {};
      for (const a of attrs) rec[a.name] = a.constant ? a.value : { value: a.value, constant: false };
      v.technologies[name] = rec;
    }
  }
  return withExtras(v, dev, KNOWN.device, ['connects', 'technologies']);
}

// ---------------------------------------------------------------------------
// Graphics

function rotFields(r: E.Rotation): { rot?: number; mirror?: boolean; spin?: boolean } {
  const out: { rot?: number; mirror?: boolean; spin?: boolean } = {};
  if (r.angle) out.rot = r.angle;
  if (r.mirror) out.mirror = true;
  if (r.spin) out.spin = true;
  return out;
}

function convertLine(w: E.Wire): O.LineShape {
  const out: O.LineShape = { line: [[w.x1, w.y1], [w.x2, w.y2]], width: w.width, layer: layerName(w.layer) };
  if (w.curve) out.curve = w.curve;
  if (w.cap === 'flat') out.cap = 'flat';
  if (w.style !== 'continuous') out.style = w.style;
  return withExtras(out, w, KNOWN.wire);
}

function convertText(t: E.Text): O.TextShape {
  const out: O.TextShape = { text: t.text, at: [t.x, t.y], ...rotFields(t.rot), size: t.size, layer: layerName(t.layer) };
  if (t.ratio !== 8) out.ratio = t.ratio;
  if (t.align !== 'bottom-left') out.align = t.align;
  if (t.font !== 'proportional') out.font = t.font;
  return withExtras(out, t, KNOWN.text);
}

function convertPolygon(p: E.Polygon): O.PolygonShape {
  const out: O.PolygonShape = {
    polygon: p.vertices.map((v): O.PolyPt => (v.curve ? [v.x, v.y, v.curve] : [v.x, v.y])),
    width: p.width,
    layer: layerName(p.layer),
  };
  const el = domOf(p);
  if (p.pour !== 'solid') out.pour = p.pour;
  if (p.isolate !== undefined) out.isolate = p.isolate;
  const spacing = el?.getAttribute('spacing');
  if (spacing) out.spacing = Number(spacing);
  const rank = el?.getAttribute('rank');
  if (rank) out.rank = Number(rank);
  if (el?.getAttribute('thermals') === 'no') out.thermals = false;
  if (el?.getAttribute('orphans') === 'yes') out.orphans = true;
  return withExtras(out, p, KNOWN.polygon, ['vertex']);
}

function convertGraphic(g: E.Graphic): O.Graphic {
  switch (g.kind) {
    case 'wire': return convertLine(g);
    case 'text': return convertText(g);
    case 'polygon': return convertPolygon(g);
    case 'circle':
      return withExtras<O.CircleShape>({ circle: [g.x, g.y], radius: g.radius, width: g.width, layer: layerName(g.layer) }, g, KNOWN.circle);
    case 'rectangle': {
      const out: O.RectShape = { rect: [[g.x1, g.y1], [g.x2, g.y2]], layer: layerName(g.layer) };
      if (g.rot.angle) out.rot = g.rot.angle;
      return withExtras(out, g, KNOWN.rectangle);
    }
    case 'hole':
      return withExtras<O.HoleShape>({ hole: [g.x, g.y], drill: g.drill }, g, KNOWN.hole);
    case 'frame':
      return withExtras<O.FrameShape>({ frame: [[g.x1, g.y1], [g.x2, g.y2]], columns: g.columns, rows: g.rows, layer: layerName(g.layer) }, g, KNOWN.frame);
  }
}

function convertVia(v: E.Via): O.Via {
  const out: O.Via = { at: [v.x, v.y], drill: v.drill };
  if (v.diameter) out.diameter = v.diameter;
  if (v.extent !== '1-16') out.layers = v.extent;
  if (v.shape !== 'round') out.shape = v.shape;
  return withExtras(out, v, KNOWN.via);
}

// ---------------------------------------------------------------------------
// Design

function convertPart(p: E.Part, libKey: string): O.Part {
  const out: O.Part = { name: p.name, component: `${libKey}/${p.deviceset}`, variant: p.device };
  if (p.technology) out.technology = p.technology;
  if (p.value !== undefined) out.value = p.value;
  // Plain name/value attributes map to `attributes`; anything richer stays in the passthrough.
  const attrs: Record<string, string> = {};
  const extra: O.JsonML[] = [];
  for (const a of p.attributes) {
    const el = domOf(a);
    const plain = el && Array.from(el.attributes).every((x) => x.name === 'name' || x.name === 'value');
    if (plain && a.value !== undefined) attrs[a.name] = a.value;
    else if (el) extra.push(toJsonML(el));
  }
  if (Object.keys(attrs).length) out.attributes = attrs;
  withExtras(out, p, KNOWN.part, ['attribute']);
  if (extra.length) (out.eagle ??= {}).children = [...(out.eagle.children ?? []), ...extra];
  return out;
}

function convertLabels(attrs: E.PlacedAttribute[], defaultSize: number, defaultLayer: number): { labels: O.Label[]; extra: O.JsonML[] } {
  const labels: O.Label[] = [];
  const extra: O.JsonML[] = [];
  for (const a of attrs) {
    if (a.x === undefined || a.y === undefined) {
      const el = domOf(a);
      if (el) extra.push(toJsonML(el));
      continue;
    }
    const l: O.Label = { attr: a.name, at: [a.x, a.y], ...rotFields(a.rot), size: a.size ?? defaultSize, layer: layerName(a.layer ?? defaultLayer) };
    if (a.value !== undefined) l.value = a.value;
    if (a.ratio !== undefined && a.ratio !== 8) l.ratio = a.ratio;
    if (a.align !== 'bottom-left') l.align = a.align;
    if (a.display !== 'value') l.display = a.display === 'off' ? 'none' : a.display;
    const font = domOf(a)?.getAttribute('font');
    if (font === 'vector' || font === 'fixed') l.font = font;
    labels.push(withExtras(l, a, KNOWN.attribute));
  }
  return { labels, extra };
}

function convertSheet(sheet: E.Sheet, id: string): O.Sheet {
  const out: O.Sheet = {
    id,
    gates: sheet.instances.map((inst) => {
      const g: O.GatePlacement = { part: inst.part, gate: inst.gate, at: [inst.x, inst.y] };
      if (inst.rot.angle) g.rot = inst.rot.angle;
      if (inst.rot.mirror) g.mirror = true;
      if (inst.smashed) g.smashed = true;
      const { labels, extra } = convertLabels(inst.attributes, 1.778, 95);
      if (labels.length) g.labels = labels;
      withExtras(g, inst, KNOWN.instance, ['attribute']);
      if (extra.length) (g.eagle ??= {}).children = [...(g.eagle.children ?? []), ...extra];
      return g;
    }),
    drawing: sheet.plain.map(convertGraphic),
  };
  if (sheet.description) out.description = sheet.description;
  return withExtras(out, sheet, [], ['description', 'plain', 'instances', 'busses', 'nets']);
}

function convertSegment(seg: E.Segment, sheet: string, wireLayer: 'nets' | 'busses'): O.Segment {
  const out: O.Segment = {
    sheet,
    pins: seg.pinrefs.map((p) => ({ part: p.part, gate: p.gate, pin: p.pin })),
    wires: seg.wires.map((w) => {
      const { layer, ...rest } = convertLine(w);
      return layer === wireLayer ? rest : { ...rest, layer };
    }),
  };
  if (seg.junctions.length) out.junctions = seg.junctions.map((j) => [j.x, j.y]);
  if (seg.labels.length) {
    out.labels = seg.labels.map((l) => {
      const label: O.NetLabel = { at: [l.x, l.y], ...rotFields(l.rot), size: l.size, layer: layerName(l.layer) };
      if (l.xref) label.xref = true;
      if (l.align !== 'bottom-left') label.align = l.align;
      const el = domOf(l);
      const ratio = el?.getAttribute('ratio');
      if (ratio && ratio !== '8') label.ratio = Number(ratio);
      const font = el?.getAttribute('font');
      if (font === 'vector' || font === 'fixed') label.font = font;
      return withExtras(label, l, KNOWN.label);
    });
  }
  return withExtras(out, seg, [], ['pinref', 'wire', 'junction', 'label']);
}

function convertElement(el: E.Element): O.FootprintPlacement {
  const out: O.FootprintPlacement = { part: el.name, at: [el.x, el.y] };
  if (el.rot.angle) out.rot = el.rot.angle;
  if (el.rot.mirror) out.side = 'bottom';
  if (el.locked) out.locked = true;
  if (el.smashed) out.smashed = true;
  const { labels, extra } = convertLabels(el.attributes, 1.27, 25);
  if (labels.length) out.labels = labels;
  withExtras(out, el, KNOWN.element, ['attribute']);
  if (extra.length) (out.eagle ??= {}).children = [...(out.eagle.children ?? []), ...extra];
  return out;
}

function convertClass(c: E.NetClass): O.NetClass {
  const out: O.NetClass = { number: c.number, name: c.name };
  if (c.width) out.width = c.width;
  if (c.drill) out.drill = c.drill;
  return withExtras(out, c, KNOWN.class);
}

const UNIT_MM: Record<string, number> = { mm: 1, mil: 0.0254, mic: 0.001, inch: 25.4 };

function convertGrid(g: E.Grid | undefined, fallback: number): O.Grid {
  if (!g) return { step: fallback, fine: fallback / 10 };
  const out: O.Grid = {
    step: g.distance * (UNIT_MM[g.unitdist] ?? 1),
    fine: g.altdistance * (UNIT_MM[g.altunitdist] ?? 1),
  };
  if (g.unit !== 'mm') out.unit = g.unit;
  return out;
}

/** Copper layers, top to bottom, from the design rules' layer setup (e.g. "(1*16)"). */
function copperStack(b: E.Board): string[] {
  const setup = b.designRules.get('layerSetup');
  const nums = setup ? [...setup.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 16) : [];
  const unique = [...new Set(nums.length ? nums : [1, 16])].sort((a, z) => a - z);
  return unique.map(layerName);
}

/**
 * Everything at document level the model doesn't cover, as JsonML grouped by parent:
 * ["eagle", …], ["drawing", …], ["schematic"|"board", {attrs}, …], ["library", {name}, …].
 */
function documentExtras(file: E.EagleFile, kind: 'schematic' | 'board'): O.JsonML[] {
  const root = file.dom.documentElement;
  const drawing = root.querySelector(':scope > drawing');
  const body = drawing?.querySelector(`:scope > ${kind}`);
  const out: O.JsonML[] = [];
  const group = (el: Element | null | undefined, known: string[]) => {
    if (!el) return;
    const kids = unknownChildren(el, known);
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    if (kids.length || Object.keys(attrs).length) out.push([el.tagName, ...(Object.keys(attrs).length ? [attrs] : []), ...kids]);
  };
  // Eagle's compatibility notes are boilerplate it writes itself; the standard layer table
  // is display settings (colours, visibility). Only user-defined layers are design data.
  group(root, ['drawing', 'compatibility']);
  group(drawing, ['grid', 'layers', kind]);
  // Eagle 9 declares ~120 extra layers by default; keep a non-standard one only if the
  // design actually draws on it (its name then matters for export).
  const used = new Set(Array.from(root.querySelectorAll('[layer]')).map((e) => Number(e.getAttribute('layer'))));
  const userLayers = Array.from(drawing?.querySelectorAll(':scope > layers > layer') ?? [])
    .filter((l) => {
      const n = Number(l.getAttribute('number'));
      return !isStandardLayer(n) && used.has(n);
    })
    .map(toJsonML);
  if (userLayers.length) out.push(['layers', ...userLayers]);
  if (kind === 'schematic') group(body, ['libraries', 'classes', 'parts', 'sheets']);
  else group(body, ['libraries', 'classes', 'plain', 'elements', 'signals']);
  // Every library, in file order, with its attributes (name, URN) and extras (descriptions,
  // 3D package lists). The order and URNs identify libraries that share a name.
  for (const libEl of Array.from(body?.querySelectorAll(':scope > libraries > library') ?? [])) {
    const kids = unknownChildren(libEl, ['packages', 'symbols', 'devicesets']);
    const attrs: Record<string, string> = {};
    for (const a of Array.from(libEl.attributes)) attrs[a.name] = a.value;
    out.push(['library', attrs, ...kids]);
  }
  // The grid's display settings (the model keeps only the spacing).
  const grid = drawing?.querySelector(':scope > grid');
  if (grid) out.push(toJsonML(grid));
  return out;
}

/** Attach the passthrough for a converted object. */
function withExtras<T extends { eagle?: O.ObjectPassthrough }>(out: T, src: object, attrs: readonly string[], children: readonly string[] = []): T {
  const ex = extrasOf(src, attrs, children);
  if (ex) out.eagle = ex;
  return out;
}
