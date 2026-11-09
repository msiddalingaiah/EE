// Parser for Eagle 6+ XML into the typed model in ./types.
// Uses the standard DOMParser (browser, or jsdom in tests).

import type {
  Attribute, Board, Bus, Circle, Connect, ContactRef, Device, DeviceSet, EagleFile, Element,
  Frame, Gate, Graphic, Grid, Hole, Instance, Junction, Label, Layer, Library, Net, NetClass,
  Package, Pad, PadShape, Part, Pin, PinDirection, PinFunction, PinLength, PinVisible,
  PlacedAttribute, Polygon, Rectangle, Rotation, Schematic, Segment, Sheet, Signal, Smd, Symbol,
  Text, TextAlign, Vertex, Via, Wire,
} from './types';
import { link } from './dom';

export class EagleParseError extends Error {}

/** Parse the text of an Eagle .sch, .brd or .lbr file. */
export function parseEagle(xml: string): EagleFile {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new EagleParseError(`Invalid XML: ${err.textContent?.trim() ?? ''}`);

  const root = doc.documentElement;
  if (root.tagName !== 'eagle') {
    throw new EagleParseError(
      `Not an Eagle XML file (root element <${root.tagName}>). ` +
        'Files from Eagle 5 or earlier must be re-saved in Eagle 6+.',
    );
  }
  const drawing = req(root, 'drawing');

  const file: EagleFile = {
    dom: doc,
    lineEnding: xml.includes('\r\n') ? '\r\n' : '\n',
    ...splitProlog(xml),
    version: str(root, 'version', ''),
    layers: all(child(drawing, 'layers'), 'layer').map(parseLayer),
    grid: optMap(child(drawing, 'grid'), parseGrid),
  };

  const sch = child(drawing, 'schematic');
  const brd = child(drawing, 'board');
  const lbr = child(drawing, 'library');
  if (sch) file.schematic = parseSchematic(sch);
  else if (brd) file.board = parseBoard(brd);
  else if (lbr) file.library = parseLibrary(lbr);
  else throw new EagleParseError('Drawing contains no schematic, board or library');
  return file;
}

// ---------------------------------------------------------------------------
// DOM helpers

function child(el: Element_ | undefined, tag: string): Element_ | undefined {
  if (!el) return undefined;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.tagName === tag) return c;
  }
  return undefined;
}

function req(el: Element_, tag: string): Element_ {
  const c = child(el, tag);
  if (!c) throw new EagleParseError(`<${el.tagName}> is missing <${tag}>`);
  return c;
}

/** Direct children with the given tag (or all element children if tag is omitted). */
function all(el: Element_ | undefined, tag?: string): Element_[] {
  const out: Element_[] = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (tag === undefined || c.tagName === tag) out.push(c);
  }
  return out;
}

function optMap<T>(el: Element_ | undefined, fn: (e: Element_) => T): T | undefined {
  return el ? fn(el) : undefined;
}

function str(el: Element_, name: string, dflt: string): string {
  return el.getAttribute(name) ?? dflt;
}

function optStr(el: Element_, name: string): string | undefined {
  return el.getAttribute(name) ?? undefined;
}

function num(el: Element_, name: string, dflt = 0): number {
  const v = el.getAttribute(name);
  if (v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new EagleParseError(`<${el.tagName} ${name}="${v}"> is not a number`);
  return n;
}

function optNum(el: Element_, name: string): number | undefined {
  return el.hasAttribute(name) ? num(el, name) : undefined;
}

function bool(el: Element_, name: string, dflt: boolean): boolean {
  const v = el.getAttribute(name);
  return v === null ? dflt : v === 'yes';
}

function oneOf<T extends string>(el: Element_, name: string, allowed: readonly T[], dflt: T): T {
  const v = el.getAttribute(name);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

function descriptionOf(el: Element_): string {
  return child(el, 'description')?.textContent ?? '';
}

// DOM Element, aliased so it doesn't clash with the board Element type.
type Element_ = globalThis.Element;

/** Wrap a parse function so its result is linked to the element it came from. */
function linked<T extends object>(fn: (el: Element_) => T): (el: Element_) => T {
  return (el) => link(fn(el), el);
}

// ---------------------------------------------------------------------------
// Values

/** Parse an Eagle rotation like "R90", "MR180", "SR0", "SMR270". */
export function parseRotation(spec: string | null | undefined): Rotation {
  if (!spec) return { angle: 0, mirror: false, spin: false };
  const m = /^(S?)(M?)R(-?\d+(?:\.\d+)?)$/.exec(spec);
  if (!m) throw new EagleParseError(`Bad rotation "${spec}"`);
  const angle = ((Number(m[3]) % 360) + 360) % 360;
  return { angle, mirror: m[2] === 'M', spin: m[1] === 'S' };
}

const UNIT_MM: Record<string, number> = { mm: 1, mil: 0.0254, mic: 0.001, inch: 25.4 };

/** Grid spacing in mm (`alt` = the alternate grid Eagle uses while Alt is held). */
export function gridSpacing(grid: Grid | undefined, alt = false): number {
  if (!grid) return alt ? 0.127 : 1.27;
  return alt
    ? grid.altdistance * (UNIT_MM[grid.altunitdist] ?? 1)
    : grid.distance * (UNIT_MM[grid.unitdist] ?? 1);
}

/** Parse a design-rule distance such as "10mil", "0.4mm", "0.1inch", "100mic" into mm. */
export function parseDistance(v: string): number {
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(mm|mil|mic|inch|in)?\s*$/i.exec(v);
  if (!m) throw new EagleParseError(`Bad distance "${v}"`);
  const n = Number(m[1]);
  switch ((m[2] ?? 'mm').toLowerCase()) {
    case 'mil': return n * 0.0254;
    case 'mic': return n / 1000;
    case 'inch':
    case 'in': return n * 25.4;
    default: return n;
  }
}

const ALIGNS: readonly TextAlign[] = [
  'bottom-left', 'bottom-center', 'bottom-right',
  'center-left', 'center', 'center-right',
  'top-left', 'top-center', 'top-right',
];

// ---------------------------------------------------------------------------
// Header

function parseLayer(el: Element_): Layer {
  return {
    number: num(el, 'number'),
    name: str(el, 'name', ''),
    color: num(el, 'color'),
    fill: num(el, 'fill', 1),
    visible: bool(el, 'visible', true),
    active: bool(el, 'active', true),
  };
}

function parseGrid(el: Element_): Grid {
  return {
    distance: num(el, 'distance', 0.1),
    unitdist: str(el, 'unitdist', 'inch'),
    unit: str(el, 'unit', 'inch'),
    altdistance: num(el, 'altdistance', 0.01),
    altunitdist: str(el, 'altunitdist', 'inch'),
  };
}

// ---------------------------------------------------------------------------
// Graphics

export function parseWire(el: Element_): Wire {
  return {
    kind: 'wire',
    x1: num(el, 'x1'),
    y1: num(el, 'y1'),
    x2: num(el, 'x2'),
    y2: num(el, 'y2'),
    width: num(el, 'width'),
    layer: num(el, 'layer'),
    curve: num(el, 'curve'),
    cap: oneOf(el, 'cap', ['round', 'flat'] as const, 'round'),
    style: oneOf(el, 'style', ['continuous', 'longdash', 'shortdash', 'dashdot'] as const, 'continuous'),
  };
}

function parseCircle(el: Element_): Circle {
  return {
    kind: 'circle',
    x: num(el, 'x'),
    y: num(el, 'y'),
    radius: num(el, 'radius'),
    width: num(el, 'width'),
    layer: num(el, 'layer'),
  };
}

function parseRectangle(el: Element_): Rectangle {
  return {
    kind: 'rectangle',
    x1: num(el, 'x1'),
    y1: num(el, 'y1'),
    x2: num(el, 'x2'),
    y2: num(el, 'y2'),
    layer: num(el, 'layer'),
    rot: parseRotation(el.getAttribute('rot')),
  };
}

export function parsePolygon(el: Element_): Polygon {
  return {
    kind: 'polygon',
    width: num(el, 'width'),
    layer: num(el, 'layer'),
    vertices: all(el, 'vertex').map(
      (v): Vertex => link({ x: num(v, 'x'), y: num(v, 'y'), curve: num(v, 'curve') }, v),
    ),
    pour: oneOf(el, 'pour', ['solid', 'hatch', 'cutout'] as const, 'solid'),
    isolate: optNum(el, 'isolate'),
  };
}

function parseText(el: Element_): Text {
  return {
    kind: 'text',
    x: num(el, 'x'),
    y: num(el, 'y'),
    text: el.textContent ?? '',
    size: num(el, 'size'),
    layer: num(el, 'layer'),
    font: oneOf(el, 'font', ['vector', 'proportional', 'fixed'] as const, 'proportional'),
    ratio: num(el, 'ratio', 8),
    rot: parseRotation(el.getAttribute('rot')),
    align: oneOf(el, 'align', ALIGNS, 'bottom-left'),
  };
}

function parseHole(el: Element_): Hole {
  return { kind: 'hole', x: num(el, 'x'), y: num(el, 'y'), drill: num(el, 'drill') };
}

function parseFrame(el: Element_): Frame {
  return {
    kind: 'frame',
    x1: num(el, 'x1'),
    y1: num(el, 'y1'),
    x2: num(el, 'x2'),
    y2: num(el, 'y2'),
    columns: num(el, 'columns', 1),
    rows: num(el, 'rows', 1),
    layer: num(el, 'layer'),
  };
}

/** Parse the graphic children of a container; unknown children are ignored. */
function parseGraphics(container: Element_ | undefined): Graphic[] {
  const out: Graphic[] = [];
  for (const el of all(container)) {
    const g = parseGraphic(el);
    if (g) out.push(g);
  }
  return out;
}

function parseGraphic(el: Element_): Graphic | undefined {
  const g = parseGraphicUnlinked(el);
  return g && link(g, el);
}

function parseGraphicUnlinked(el: Element_): Graphic | undefined {
  switch (el.tagName) {
    case 'wire': return parseWire(el);
    case 'circle': return parseCircle(el);
    case 'rectangle': return parseRectangle(el);
    case 'polygon': return parsePolygon(el);
    case 'text': return parseText(el);
    case 'hole': return parseHole(el);
    case 'frame': return parseFrame(el);
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Libraries

function parsePad(el: Element_): Pad {
  return {
    kind: 'pad',
    name: str(el, 'name', ''),
    x: num(el, 'x'),
    y: num(el, 'y'),
    drill: num(el, 'drill'),
    diameter: num(el, 'diameter'),
    shape: oneOf<PadShape>(el, 'shape', ['round', 'square', 'octagon', 'long', 'offset'], 'round'),
    rot: parseRotation(el.getAttribute('rot')),
    first: bool(el, 'first', false),
  };
}

function parseSmd(el: Element_): Smd {
  return {
    kind: 'smd',
    name: str(el, 'name', ''),
    x: num(el, 'x'),
    y: num(el, 'y'),
    dx: num(el, 'dx'),
    dy: num(el, 'dy'),
    layer: num(el, 'layer', 1),
    roundness: num(el, 'roundness'),
    rot: parseRotation(el.getAttribute('rot')),
  };
}

function parsePackage(el: Element_): Package {
  const pads: (Pad | Smd)[] = [];
  for (const c of all(el)) {
    if (c.tagName === 'pad') pads.push(link(parsePad(c), c));
    else if (c.tagName === 'smd') pads.push(link(parseSmd(c), c));
  }
  return { name: str(el, 'name', ''), description: descriptionOf(el), graphics: parseGraphics(el), pads };
}

function parsePin(el: Element_): Pin {
  return {
    name: str(el, 'name', ''),
    x: num(el, 'x'),
    y: num(el, 'y'),
    length: oneOf<PinLength>(el, 'length', ['point', 'short', 'middle', 'long'], 'long'),
    visible: oneOf<PinVisible>(el, 'visible', ['off', 'pad', 'pin', 'both'], 'both'),
    direction: oneOf<PinDirection>(
      el, 'direction', ['nc', 'in', 'out', 'io', 'oc', 'pwr', 'pas', 'hiz', 'sup'], 'io',
    ),
    function: oneOf<PinFunction>(el, 'function', ['none', 'dot', 'clk', 'dotclk'], 'none'),
    rot: parseRotation(el.getAttribute('rot')),
    swaplevel: num(el, 'swaplevel'),
  };
}

function parseSymbol(el: Element_): Symbol {
  return {
    name: str(el, 'name', ''),
    description: descriptionOf(el),
    graphics: parseGraphics(el),
    pins: all(el, 'pin').map(parsePin),
  };
}

function parseDeviceSet(el: Element_): DeviceSet {
  return {
    name: str(el, 'name', ''),
    prefix: str(el, 'prefix', ''),
    uservalue: bool(el, 'uservalue', false),
    description: descriptionOf(el),
    gates: all(child(el, 'gates'), 'gate').map(
      (g): Gate => ({
        name: str(g, 'name', ''),
        symbol: str(g, 'symbol', ''),
        x: num(g, 'x'),
        y: num(g, 'y'),
        addlevel: str(g, 'addlevel', 'next'),
        swaplevel: num(g, 'swaplevel'),
      }),
    ),
    devices: all(child(el, 'devices'), 'device').map(parseDevice),
  };
}

function parseDevice(el: Element_): Device {
  const technologies = new Map<string, Attribute[]>();
  for (const t of all(child(el, 'technologies'), 'technology')) {
    technologies.set(
      str(t, 'name', ''),
      all(t, 'attribute').map(
        (a): Attribute => ({
          name: str(a, 'name', ''),
          value: str(a, 'value', ''),
          constant: bool(a, 'constant', true),
        }),
      ),
    );
  }
  return {
    name: str(el, 'name', ''),
    package: optStr(el, 'package'),
    connects: all(child(el, 'connects'), 'connect').map(
      (c): Connect => ({
        gate: str(c, 'gate', ''),
        pin: str(c, 'pin', ''),
        pads: str(c, 'pad', '').split(/\s+/).filter(Boolean),
      }),
    ),
    technologies,
  };
}

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.name, i]));
}

export function parseLibrary(el: Element_): Library {
  return {
    name: str(el, 'name', ''),
    urn: optStr(el, 'urn'),
    description: descriptionOf(el),
    packages: byName(all(child(el, 'packages'), 'package').map(parsePackage)),
    symbols: byName(all(child(el, 'symbols'), 'symbol').map(parseSymbol)),
    devicesets: byName(all(child(el, 'devicesets'), 'deviceset').map(parseDeviceSet)),
  };
}

// ---------------------------------------------------------------------------
// Schematic

function parsePlacedAttribute(el: Element_): PlacedAttribute {
  return {
    name: str(el, 'name', ''),
    value: optStr(el, 'value'),
    x: optNum(el, 'x'),
    y: optNum(el, 'y'),
    size: optNum(el, 'size'),
    layer: optNum(el, 'layer'),
    rot: parseRotation(el.getAttribute('rot')),
    ratio: optNum(el, 'ratio'),
    align: oneOf(el, 'align', ALIGNS, 'bottom-left'),
    display: oneOf(el, 'display', ['off', 'value', 'name', 'both'] as const, 'value'),
  };
}

function parseClasses(el: Element_ | undefined): NetClass[] {
  return all(el, 'class').map((c) => ({
    number: num(c, 'number'),
    name: str(c, 'name', ''),
    width: num(c, 'width'),
    drill: num(c, 'drill'),
  }));
}

function parseSegment(el: Element_): Segment {
  const seg: Segment = { wires: [], junctions: [], labels: [], pinrefs: [] };
  for (const c of all(el)) {
    switch (c.tagName) {
      case 'wire':
        seg.wires.push(link(parseWire(c), c));
        break;
      case 'junction':
        seg.junctions.push(link({ kind: 'junction', x: num(c, 'x'), y: num(c, 'y') } satisfies Junction, c));
        break;
      case 'label':
        seg.labels.push(link({
          kind: 'label',
          x: num(c, 'x'),
          y: num(c, 'y'),
          size: num(c, 'size'),
          layer: num(c, 'layer'),
          rot: parseRotation(c.getAttribute('rot')),
          xref: bool(c, 'xref', false),
          align: oneOf(c, 'align', ALIGNS, 'bottom-left'),
        } satisfies Label, c));
        break;
      case 'pinref':
        seg.pinrefs.push(link({ part: str(c, 'part', ''), gate: str(c, 'gate', ''), pin: str(c, 'pin', '') }, c));
        break;
    }
  }
  return seg;
}

function parseSheet(el: Element_): Sheet {
  return {
    description: descriptionOf(el),
    plain: parseGraphics(child(el, 'plain')),
    instances: all(child(el, 'instances'), 'instance').map(
      linked((i): Instance => ({
        part: str(i, 'part', ''),
        gate: str(i, 'gate', ''),
        x: num(i, 'x'),
        y: num(i, 'y'),
        smashed: bool(i, 'smashed', false),
        rot: parseRotation(i.getAttribute('rot')),
        attributes: all(i, 'attribute').map(linked(parsePlacedAttribute)),
      })),
    ),
    nets: all(child(el, 'nets'), 'net').map(
      linked((n): Net => ({
        name: str(n, 'name', ''),
        netClass: num(n, 'class'),
        segments: all(n, 'segment').map(linked(parseSegment)),
      })),
    ),
    busses: all(child(el, 'busses'), 'bus').map(
      linked((b): Bus => ({ name: str(b, 'name', ''), segments: all(b, 'segment').map(linked(parseSegment)) })),
    ),
  };
}

function parseSchematic(el: Element_): Schematic {
  return {
    libraries: all(child(el, 'libraries'), 'library').map(parseLibrary),
    classes: parseClasses(child(el, 'classes')),
    parts: byName(
      all(child(el, 'parts'), 'part').map(
        linked((p): Part => ({
          name: str(p, 'name', ''),
          library: str(p, 'library', ''),
          libraryUrn: optStr(p, 'library_urn'),
          deviceset: str(p, 'deviceset', ''),
          device: str(p, 'device', ''),
          technology: str(p, 'technology', ''),
          value: optStr(p, 'value'),
          attributes: all(p, 'attribute').map(linked(parsePlacedAttribute)),
        })),
      ),
    ),
    sheets: all(child(el, 'sheets'), 'sheet').map(linked(parseSheet)),
  };
}

// ---------------------------------------------------------------------------
// Board

function parseVia(el: Element_): Via {
  return {
    kind: 'via',
    x: num(el, 'x'),
    y: num(el, 'y'),
    extent: str(el, 'extent', '1-16'),
    drill: num(el, 'drill'),
    diameter: num(el, 'diameter'),
    shape: oneOf(el, 'shape', ['round', 'square', 'octagon'] as const, 'round'),
  };
}

function parseSignal(el: Element_): Signal {
  const sig: Signal = {
    name: str(el, 'name', ''),
    netClass: num(el, 'class'),
    contactrefs: [],
    wires: [],
    vias: [],
    polygons: [],
  };
  for (const c of all(el)) {
    switch (c.tagName) {
      case 'contactref':
        sig.contactrefs.push(link({ element: str(c, 'element', ''), pad: str(c, 'pad', '') } satisfies ContactRef, c));
        break;
      case 'wire':
        sig.wires.push(link(parseWire(c), c));
        break;
      case 'via':
        sig.vias.push(link(parseVia(c), c));
        break;
      case 'polygon':
        sig.polygons.push(link(parsePolygon(c), c));
        break;
    }
  }
  return sig;
}

function parseBoard(el: Element_): Board {
  const designRules = new Map<string, string>();
  for (const p of all(child(el, 'designrules'), 'param')) {
    designRules.set(str(p, 'name', ''), str(p, 'value', ''));
  }
  return {
    libraries: all(child(el, 'libraries'), 'library').map(parseLibrary),
    classes: parseClasses(child(el, 'classes')),
    designRules,
    plain: parseGraphics(child(el, 'plain')),
    elements: all(child(el, 'elements'), 'element').map(
      linked((e): Element => ({
        name: str(e, 'name', ''),
        library: str(e, 'library', ''),
        libraryUrn: optStr(e, 'library_urn'),
        package: str(e, 'package', ''),
        value: str(e, 'value', ''),
        x: num(e, 'x'),
        y: num(e, 'y'),
        locked: bool(e, 'locked', false),
        smashed: bool(e, 'smashed', false),
        rot: parseRotation(e.getAttribute('rot')),
        attributes: all(e, 'attribute').map(linked(parsePlacedAttribute)),
      })),
    ),
    signals: all(child(el, 'signals'), 'signal').map(linked(parseSignal)),
  };
}

/** Find a library by name, preferring an exact URN match when one is given. */
export function findLibrary(libs: Library[], name: string, urn: string | undefined): Library | undefined {
  return (
    libs.find((l) => l.name === name && l.urn === urn) ??
    libs.find((l) => l.name === name)
  );
}

/**
 * Serialize a parsed (and possibly edited) file back to Eagle XML.
 * The original document is written out, so content Osprey doesn't model is preserved.
 */
export function serializeEagle(file: EagleFile): string {
  // The DOM doesn't keep the XML declaration or whitespace around the root, so the
  // original prolog/epilog text is reused verbatim.
  const out: string[] = [];
  writeNode(file.dom.documentElement, out);
  const body = out.join('').replace(/\r\n/g, '\n');
  return file.prolog + (file.lineEnding === '\r\n' ? body.replace(/\n/g, '\r\n') : body) + file.epilog;
}

/** Escape as Eagle does: & < > (plus " inside attribute values). */
function escapeXml(s: string, attr = false): string {
  return s.replace(attr ? /[&<>"]/g : /[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** Serialize in Eagle's style: attributes in document order, childless elements as `<x/>`. */
function writeNode(node: Node, out: string[]): void {
  switch (node.nodeType) {
    case 1: {
      const el = node as Element_;
      out.push('<', el.tagName);
      for (const a of Array.from(el.attributes)) out.push(' ', a.name, '="', escapeXml(a.value, true), '"');
      if (!el.firstChild) {
        out.push('/>');
        return;
      }
      out.push('>');
      for (let c: ChildNode | null = el.firstChild; c; c = c.nextSibling) writeNode(c, out);
      out.push('</', el.tagName, '>');
      return;
    }
    case 3:
      out.push(escapeXml(node.nodeValue ?? ''));
      return;
    case 4:
      out.push('<![CDATA[', node.nodeValue ?? '', ']]>');
      return;
    case 7: {
      const pi = node as ProcessingInstruction;
      out.push('<?', pi.target, pi.data ? ` ${pi.data}` : '', '?>');
      return;
    }
    case 8:
      out.push('<!--', node.nodeValue ?? '', '-->');
      return;
  }
}

function splitProlog(xml: string): { prolog: string; epilog: string } {
  const start = /<eagle[\s>]/.exec(xml)?.index ?? 0;
  const end = xml.lastIndexOf('</eagle>');
  return {
    prolog: xml.slice(0, start),
    epilog: end >= 0 ? xml.slice(end + '</eagle>'.length) : '',
  };
}
