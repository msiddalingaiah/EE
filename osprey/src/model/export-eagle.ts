// Osprey → Eagle: write a project as an Eagle 9 schematic (.sch) and board (.brd).
// (docs/format.md, "Import and export".) Elements are written in eagle.dtd order; data the
// native model derives (board contactrefs, airwires, the layer table, per-file library copies)
// is regenerated; Eagle data kept in the passthrough is written back where it came from.

import { writeEagleDocument } from '../eagle/parse';
import { componentName, netPads, ProjectIndex } from './derive';
import { layerNumber } from './layers';
import { ratsnest } from './ratsnest';
import type * as O from './types';
import type { JsonML } from './types';

export interface ExportResult {
  /** File name → contents (CRLF, as Eagle writes). */
  files: Map<string, string>;
}

const EAGLE_VERSION = '9.6.2';

/** Export a project to Eagle. Writes a .sch if it has a schematic and a .brd if it has a board. */
export function exportEagle(project: O.Project): ExportResult {
  const files = new Map<string, string>();
  const ctx = new ExportContext(project);
  if (project.schematic) files.set(`${project.project.name}.sch`, writeEagleDocument(openEmptyContainers(ctx.schematic())));
  if (project.board) files.set(`${project.project.name}.brd`, writeEagleDocument(openEmptyContainers(ctx.board())));
  return { files };
}

/** Export a library file as an Eagle library (.lbr): every symbol, footprint and component. */
export function exportEagleLibrary(f: O.LibraryFile): string {
  const project: O.Project = { osprey: f.osprey, project: { name: f.name }, library: f.library, parts: [], nets: [] };
  return writeEagleDocument(openEmptyContainers(new ExportContext(project).libraryDocument(f.description)));
}

/** Elements Eagle writes as <x>⏎</x> even when empty (leaf elements stay <x/>). */
const CONTAINERS = new Set([
  'drawing', 'settings', 'layers', 'schematic', 'board', 'libraries', 'library', 'packages', 'symbols',
  'devicesets', 'deviceset', 'gates', 'devices', 'device', 'connects', 'technologies', 'attributes',
  'variantdefs', 'classes', 'class', 'parts', 'sheets', 'sheet', 'plain', 'instances', 'busses', 'nets',
  'net', 'segment', 'elements', 'signals', 'signal', 'errors', 'package', 'symbol', 'polygon',
]);

function openEmptyContainers(root: Element): Element {
  const visit = (e: Element) => {
    if (!e.firstChild && CONTAINERS.has(e.tagName)) e.append(e.ownerDocument.createTextNode('\n'));
    for (const c of Array.from(e.children)) visit(c);
  };
  visit(root);
  return root;
}

// ---------------------------------------------------------------------------
// XML building

type Attr = [string, string | number | boolean | undefined];

const fmt = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
};

/** Eagle rotation attribute ("R90", "MR180", "SR0"); undefined for R0. */
function rotAttr(rot: number | undefined, mirror?: boolean, spin?: boolean): string | undefined {
  if (!rot && !mirror && !spin) return undefined;
  return `${spin ? 'S' : ''}${mirror ? 'M' : ''}R${fmt(rot ?? 0)}`;
}

class Xml {
  constructor(readonly doc: Document) {}

  /** Create an element. Attributes are written in the given order; undefined/false are skipped. */
  el(tag: string, attrs: Attr[] = [], extra?: O.ObjectPassthrough): Element {
    const e = this.doc.createElement(tag);
    for (const [k, v] of attrs) {
      if (v === undefined || v === false) continue;
      e.setAttribute(k, typeof v === 'number' ? fmt(v) : v === true ? 'yes' : v);
    }
    for (const [k, v] of Object.entries(extra?.attrs ?? {})) if (!e.hasAttribute(k)) e.setAttribute(k, v);
    for (const c of extra?.children ?? []) this.add(e, this.fromJsonML(c));
    return e;
  }

  /** Append a child on its own line, Eagle style: <p>\n<c/>\n<c/>\n</p>. */
  add(parent: Element, child: Element | undefined): Element | undefined {
    if (!child) return undefined;
    if (!parent.firstChild) parent.append(this.doc.createTextNode('\n'));
    parent.append(child, this.doc.createTextNode('\n'));
    return child;
  }

  text(tag: string, content: string, attrs: Attr[] = [], extra?: O.ObjectPassthrough): Element {
    const e = this.el(tag, attrs, extra);
    e.append(this.doc.createTextNode(content));
    return e;
  }

  fromJsonML(node: JsonML): Element {
    const [tag, ...rest] = node;
    const e = this.doc.createElement(tag);
    for (const r of rest) {
      if (typeof r === 'string') e.append(this.doc.createTextNode(r));
      else if (Array.isArray(r)) this.add(e, this.fromJsonML(r as JsonML));
      else for (const [k, v] of Object.entries(r)) e.setAttribute(k, v);
    }
    return e;
  }

  /** Re-order a parent's element children by tag, following a DTD content model. */
  order(parent: Element, tags: string[]): void {
    const kids = Array.from(parent.children);
    const rank = (t: string) => {
      const i = tags.indexOf(t);
      return i < 0 ? tags.length : i;
    };
    const sorted = kids.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k.tagName) - rank(b.k.tagName) || a.i - b.i);
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    for (const { k } of sorted) this.add(parent, k);
  }
}

// eagle.dtd content models for the elements whose children come from several places.
const DTD = {
  eagle: ['compatibility', 'drawing'],
  drawing: ['settings', 'grid', 'filters', 'layers', 'library', 'schematic', 'board'],
  schematic: ['description', 'libraries', 'attributes', 'variantdefs', 'classes', 'modules', 'groups', 'parts', 'sheets', 'errors'],
  // As Eagle 9 writes boards: <plain> comes first.
  board: ['description', 'fusionsync', 'fusionteam', 'plain', 'libraries', 'attributes', 'variantdefs', 'classes', 'designrules', 'autorouter', 'elements', 'signals', 'mfgpreviewcolors', 'errors'],
  library: ['description', 'packages', 'packages3d', 'symbols', 'devicesets'],
  sheet: ['description', 'plain', 'moduleinsts', 'instances', 'busses', 'nets'],
  deviceset: ['description', 'gates', 'devices', 'spice'],
  device: ['connects', 'package3dinstances', 'technologies'],
  part: ['attribute', 'variant', 'spice'],
  element: ['attribute', 'variant'],
};

/** Eagle's standard layers: [number, name]. Colours and visibility come from Osprey's defaults. */
const EAGLE_LAYERS: [number, string, number, number, boolean][] = [
  [1, 'Top', 4, 1, true], [2, 'Route2', 1, 3, false], [3, 'Route3', 4, 3, false], [4, 'Route4', 1, 4, false],
  [5, 'Route5', 4, 4, false], [6, 'Route6', 1, 8, false], [7, 'Route7', 4, 8, false], [8, 'Route8', 1, 2, false],
  [9, 'Route9', 4, 2, false], [10, 'Route10', 1, 7, false], [11, 'Route11', 4, 7, false], [12, 'Route12', 1, 5, false],
  [13, 'Route13', 4, 5, false], [14, 'Route14', 1, 6, false], [15, 'Route15', 4, 6, false], [16, 'Bottom', 1, 1, true],
  [17, 'Pads', 2, 1, true], [18, 'Vias', 2, 1, true], [19, 'Unrouted', 6, 1, true], [20, 'Dimension', 24, 1, true],
  [21, 'tPlace', 7, 1, true], [22, 'bPlace', 7, 1, true], [23, 'tOrigins', 15, 1, true], [24, 'bOrigins', 15, 1, true],
  [25, 'tNames', 7, 1, true], [26, 'bNames', 7, 1, true], [27, 'tValues', 7, 1, true], [28, 'bValues', 7, 1, true],
  [29, 'tStop', 7, 3, false], [30, 'bStop', 7, 6, false], [31, 'tCream', 7, 4, false], [32, 'bCream', 7, 5, false],
  [33, 'tFinish', 6, 3, false], [34, 'bFinish', 6, 6, false], [35, 'tGlue', 7, 4, false], [36, 'bGlue', 7, 5, false],
  [37, 'tTest', 7, 1, false], [38, 'bTest', 7, 1, false], [39, 'tKeepout', 4, 11, true], [40, 'bKeepout', 1, 11, true],
  [41, 'tRestrict', 4, 10, true], [42, 'bRestrict', 1, 10, true], [43, 'vRestrict', 2, 10, true], [44, 'Drills', 7, 1, false],
  [45, 'Holes', 7, 1, false], [46, 'Milling', 3, 1, false], [47, 'Measures', 7, 1, false], [48, 'Document', 7, 1, true],
  [49, 'Reference', 7, 1, true], [51, 'tDocu', 7, 1, true], [52, 'bDocu', 7, 1, true], [88, 'SimResults', 9, 1, true],
  [89, 'SimProbes', 9, 1, true], [90, 'Modules', 5, 1, true], [91, 'Nets', 2, 1, true], [92, 'Busses', 1, 1, true],
  [93, 'Pins', 2, 1, false], [94, 'Symbols', 4, 1, true], [95, 'Names', 7, 1, true], [96, 'Values', 7, 1, true],
  [97, 'Info', 7, 1, true], [98, 'Guide', 6, 1, true], [99, 'SpiceOrder', 7, 1, true],
];

const DIRECTION: Record<O.PinDirection, string> = {
  nc: 'nc', in: 'in', out: 'out', io: 'io', oc: 'oc', power: 'pwr', passive: 'pas', hiz: 'hiz', supply: 'sup',
};

// ---------------------------------------------------------------------------

interface LibraryRef {
  name: string;
  urn?: string;
}

class ExportContext {
  private readonly index: ProjectIndex;
  /** Library key ("name" or "name@urn") → { name, urn } as Eagle knows it. */
  private readonly libraries = new Map<string, LibraryRef>();
  /** Library keys in each document's original order, with the passthrough entry kept for each. */
  private readonly order: Record<'schematic' | 'board', { key: string; kept: JsonML }[]> = { schematic: [], board: [] };

  constructor(private readonly project: O.Project) {
    this.index = new ProjectIndex(project);
    // Replay the import's key assignment over the libraries it recorded (schematic first, then
    // board, each in file order): the first library with a name gets the plain key, another
    // with the same name but a different URN gets "name@urn".
    const firstUrn = new Map<string, string | undefined>();
    for (const doc of ['schematic', 'board'] as const) {
      for (const entry of project.eagle?.[doc] ?? []) {
        const attrs = entry[1];
        if (entry[0] !== 'library' || !attrs || Array.isArray(attrs) || typeof attrs !== 'object') continue;
        const name = attrs.name ?? '';
        const urn = attrs.urn;
        if (!firstUrn.has(name)) firstUrn.set(name, urn);
        const key = firstUrn.get(name) === urn ? name : `${name}@${urn ?? 'local'}`;
        if (!this.libraries.has(key)) this.libraries.set(key, { name, ...(urn ? { urn } : {}) });
        this.order[doc].push({ key, kept: entry });
      }
    }
    // Libraries the passthrough didn't record (e.g. projects created in Osprey).
    for (const item of [...project.library.symbols, ...project.library.footprints, ...project.library.components]) {
      const key = item.id.slice(0, item.id.indexOf('/'));
      if (this.libraries.has(key)) continue;
      const at = key.indexOf('@');
      const urn = at < 0 ? undefined : key.slice(at + 1);
      this.libraries.set(key, { name: at < 0 ? key : key.slice(0, at), ...(urn && urn !== 'local' ? { urn } : {}) });
    }
  }

  /** Library keys for a document: its original order, then any others, alphabetically. */
  private keysFor(doc: 'schematic' | 'board'): { key: string; lib: LibraryRef; kept?: JsonML }[] {
    const listed = this.order[doc].map((o) => ({ key: o.key, lib: this.libraries.get(o.key)!, kept: o.kept }));
    const rest = [...this.libraries.keys()].filter((k) => !listed.some((l) => l.key === k)).sort();
    return [...listed, ...rest.map((key) => ({ key, lib: this.libraries.get(key)! }))];
  }

  private libOf(id: string): LibraryRef {
    return this.libraries.get(id.slice(0, id.indexOf('/'))) ?? { name: id.slice(0, id.indexOf('/')) };
  }

  // -------------------------------------------------------------------------
  // Documents

  schematic(): globalThis.Element {
    const { x, root, drawing, body } = this.document('schematic');
    const sch = this.project.schematic!;

    // Libraries: every symbol and component, plus the footprints their variants use.
    const libs = x.add(body, x.el('libraries'))!;
    for (const { key, lib, kept } of this.keysFor('schematic')) {
      const symbols = this.project.library.symbols.filter((s) => s.id.startsWith(`${key}/`));
      const components = this.project.library.components.filter((c) => c.id.startsWith(`${key}/`) && !c.id.endsWith('#footprint'));
      const used = new Set(components.flatMap((c) => c.variants.flatMap((v) => (v.footprint ? [v.footprint] : []))));
      const footprints = this.project.library.footprints.filter((f) => used.has(f.id));
      if (!symbols.length && !components.length) continue;
      x.add(libs, this.library(x, lib, kept, footprints, symbols, components));
    }

    const classes = this.classes(x);
    if (classes) x.add(body, classes);

    const parts = x.add(body, x.el('parts'))!;
    for (const p of this.project.parts) {
      const component = this.index.components.get(p.component);
      if (!component || component.id.endsWith('#footprint')) continue;
      const lib = this.libOf(p.component);
      const e = x.el('part', [
        ['name', p.name], ['library', lib.name], ['library_urn', lib.urn], ['deviceset', componentName(p.component)],
        ['device', p.variant], ['technology', p.technology || undefined], ['value', p.value],
      ], p.eagle);
      for (const [k, v] of Object.entries(p.attributes ?? {})) x.add(e, x.el('attribute', [['name', k], ['value', v]]));
      x.order(e, DTD.part);
      x.add(parts, e);
    }

    const sheets = x.add(body, x.el('sheets'))!;
    for (const sheet of sch.sheets) x.add(sheets, this.sheet(x, sheet));

    this.finish(x, root, drawing, body, 'schematic');
    return root;
  }

  board(): globalThis.Element {
    const { x, root, drawing, body } = this.document('board');
    const board = this.project.board!;

    // Libraries: the footprints placed on the board.
    const placed = new Set(board.footprints.flatMap((f) => {
      const part = this.index.parts.get(f.part);
      const fp = part && this.index.variantOf(part)?.footprint;
      return fp ? [fp] : [];
    }));
    const libs = x.add(body, x.el('libraries'))!;
    for (const { key, lib, kept } of this.keysFor('board')) {
      const footprints = this.project.library.footprints.filter((f) => f.id.startsWith(`${key}/`) && placed.has(f.id));
      if (footprints.length) x.add(libs, this.library(x, lib, kept, footprints, [], []));
    }

    const classes = this.classes(x);
    if (classes) x.add(body, classes);

    const plain = x.add(body, x.el('plain'))!;
    for (const g of board.drawing) x.add(plain, this.graphic(x, g));

    const elements = x.add(body, x.el('elements'))!;
    for (const f of board.footprints) {
      const part = this.index.parts.get(f.part);
      const fpId = part && this.index.variantOf(part)?.footprint;
      if (!part || !fpId) continue;
      const lib = this.libOf(fpId);
      const e = x.el('element', [
        ['name', f.part], ['library', lib.name], ['library_urn', lib.urn], ['package', componentName(fpId)],
        ['value', this.index.valueOf(part)], ['x', f.at[0]], ['y', f.at[1]], ['locked', f.locked],
        ['smashed', f.smashed], ['rot', rotAttr(f.rot, f.side === 'bottom')],
      ], f.eagle);
      for (const l of f.labels ?? []) x.add(e, this.label(x, l));
      x.order(e, DTD.element);
      x.add(elements, e);
    }

    // Signals: every net with pads or copper. Contactrefs and airwires are regenerated.
    const pads = netPads(this.project, this.index);
    const airwires = ratsnest(this.project);
    const signals = x.add(body, x.el('signals'))!;
    for (const net of this.project.nets) {
      const netPadsOf = [...(pads.get(net.name) ?? [])];
      if (!netPadsOf.length && !net.traces && !net.vias && !net.pours) continue;
      const s = x.el('signal', [['name', net.name], ['class', net.class || undefined]], net.eagle);
      for (const p of net.pours ?? []) x.add(s, this.polygon(x, p));
      for (const key of netPadsOf) {
        const [element, pad] = key.split('\u0000') as [string, string];
        x.add(s, x.el('contactref', [['element', element], ['pad', pad]]));
      }
      for (const t of net.traces ?? []) x.add(s, this.line(x, t, t.layer));
      for (const a of airwires.filter((w) => w.net === net.name)) {
        x.add(s, x.el('wire', [['x1', a.from[0]], ['y1', a.from[1]], ['x2', a.to[0]], ['y2', a.to[1]], ['width', 0], ['layer', 19]]));
      }
      for (const v of net.vias ?? []) {
        x.add(s, x.el('via', [['x', v.at[0]], ['y', v.at[1]], ['extent', v.layers ?? '1-16'], ['drill', v.drill], ['diameter', v.diameter], ['shape', v.shape]], v.eagle));
      }
      x.add(signals, s);
    }

    this.finish(x, root, drawing, body, 'board');
    return root;
  }

  /** An Eagle library document: <eagle><drawing><grid/><layers/><library>, the library unnamed (the file names it). */
  libraryDocument(description: string | undefined): globalThis.Element {
    const doc = new DOMParser().parseFromString('<eagle/>', 'application/xml');
    const x = new Xml(doc);
    const root = doc.documentElement;
    root.setAttribute('version', EAGLE_VERSION);
    const drawing = x.add(root, x.el('drawing'))!;
    // Eagle's own default for a new library: a 0.1 inch grid.
    x.add(drawing, x.el('grid', [
      ['distance', 0.1], ['unitdist', 'inch'], ['unit', 'inch'], ['style', 'lines'], ['multiple', 1], ['display', 'no'],
      ['altdistance', 0.01], ['altunitdist', 'inch'], ['altunit', 'inch'],
    ]));
    x.add(drawing, this.layers(x, 'library'));
    const lib = this.project.library;
    const e = this.library(x, { name: '' }, ['library', {}], lib.footprints, lib.symbols, lib.components.filter((c) => !c.id.endsWith('#footprint')));
    if (description) x.add(e, x.text('description', description));
    x.order(e, DTD.library);
    x.add(drawing, e);
    x.order(drawing, DTD.drawing);
    return root;
  }

  /** The common skeleton: <eagle><drawing><grid/><layers/><schematic|board/>. */
  private document(kind: 'schematic' | 'board') {
    const doc = new DOMParser().parseFromString('<eagle/>', 'application/xml');
    const x = new Xml(doc);
    const root = doc.documentElement;
    const extras = this.extras(kind);
    root.setAttribute('version', extras.get('eagle')?.attrs.version ?? EAGLE_VERSION);
    const drawing = x.add(root, x.el('drawing'))!;
    x.add(drawing, this.grid(x, kind));
    x.add(drawing, this.layers(x, kind));
    const body = x.add(drawing, x.el(kind, Object.entries(extras.get(kind)?.attrs ?? {})))!;
    return { x, root, drawing, body };
  }

  /** Add the document-level passthrough and put every container's children in DTD order. */
  private finish(x: Xml, root: Element, drawing: Element, body: Element, kind: 'schematic' | 'board'): void {
    const extras = this.extras(kind);
    for (const c of extras.get('eagle')?.children ?? []) x.add(root, x.fromJsonML(c));
    for (const c of extras.get('drawing')?.children ?? []) x.add(drawing, x.fromJsonML(c));
    for (const c of extras.get(kind)?.children ?? []) x.add(body, x.fromJsonML(c));
    x.order(root, DTD.eagle);
    x.order(drawing, DTD.drawing);
    x.order(body, DTD[kind]);
  }

  /** The import's document-level passthrough, grouped by parent element. */
  private extras(kind: 'schematic' | 'board'): Map<string, { attrs: Record<string, string>; children: JsonML[] }> {
    const out = new Map<string, { attrs: Record<string, string>; children: JsonML[] }>();
    for (const entry of this.project.eagle?.[kind] ?? []) {
      const [tag, ...rest] = entry;
      if (tag === 'library' || tag === 'grid' || tag === 'layers') continue; // handled where they belong
      const g = out.get(tag) ?? { attrs: {}, children: [] };
      for (const r of rest) {
        if (Array.isArray(r)) g.children.push(r as JsonML);
        else if (typeof r === 'object') Object.assign(g.attrs, r);
      }
      out.set(tag, g);
    }
    return out;
  }

  private grid(x: Xml, kind: 'schematic' | 'board'): Element {
    const g = kind === 'schematic' ? this.project.schematic!.grid : this.project.board!.grid;
    const kept = (this.project.eagle?.[kind] ?? []).find((e) => e[0] === 'grid');
    const keptAttrs = kept && kept[1] && !Array.isArray(kept[1]) && typeof kept[1] === 'object' ? kept[1] : {};
    const unit = g.unit ?? 'mm';
    const perUnit: Record<string, number> = { mm: 1, mil: 0.0254, mic: 0.001, inch: 25.4 };
    const inUnit = (mm: number, u: string) => fmt(mm / (perUnit[u] ?? 1));
    // Start from the kept attributes (display settings) and override the spacing.
    const attrs: Attr[] = Object.entries(keptAttrs).map(([k, v]): Attr => [k, v]);
    const setA = (k: string, v: string) => {
      const i = attrs.findIndex((a) => a[0] === k);
      if (i >= 0) attrs[i] = [k, v];
      else attrs.push([k, v]);
    };
    const distUnit = String(keptAttrs.unitdist ?? unit);
    const altUnit = String(keptAttrs.altunitdist ?? unit);
    setA('distance', inUnit(g.step, distUnit));
    setA('unitdist', distUnit);
    setA('unit', String(keptAttrs.unit ?? unit));
    setA('altdistance', inUnit(g.fine, altUnit));
    setA('altunitdist', altUnit);
    return x.el('grid', attrs);
  }

  private layers(x: Xml, kind: 'schematic' | 'board' | 'library'): Element {
    const layers = x.el('layers');
    const user = new Map<number, Element>();
    for (const entry of (kind === 'library' ? undefined : this.project.eagle?.[kind]) ?? []) {
      if (entry[0] !== 'layers') continue;
      for (const l of entry.slice(1)) {
        if (!Array.isArray(l)) continue;
        const e = x.fromJsonML(l as JsonML);
        user.set(Number(e.getAttribute('number')), e);
      }
    }
    const all = [...EAGLE_LAYERS.map(([n]) => n), ...user.keys()].sort((a, b) => a - b);
    for (const n of new Set(all)) {
      const kept = user.get(n);
      if (kept) {
        x.add(layers, kept);
        continue;
      }
      const [, name, color, fill, visible] = EAGLE_LAYERS.find(([m]) => m === n)!;
      const active = kind === 'library' || (kind === 'board' ? n < 90 : n >= 90 || (n >= 1 && n <= 16) || n === 17 || n === 18);
      x.add(layers, x.el('layer', [['number', n], ['name', name], ['color', color], ['fill', fill], ['visible', visible ? 'yes' : 'no'], ['active', active ? 'yes' : 'no']]));
    }
    return layers;
  }

  private classes(x: Xml): Element | undefined {
    const list = this.project.board?.classes ?? [];
    if (!list.length) return undefined;
    const e = x.el('classes');
    for (const c of list) x.add(e, x.el('class', [['number', c.number], ['name', c.name], ['width', c.width ?? 0], ['drill', c.drill ?? 0]], c.eagle));
    return e;
  }

  // -------------------------------------------------------------------------
  // Library

  private library(
    x: Xml, lib: LibraryRef, kept: JsonML | undefined,
    footprints: O.Footprint[], symbols: O.Symbol[], components: O.Component[],
  ): Element {
    const keptAttrs = kept && kept[1] && !Array.isArray(kept[1]) && typeof kept[1] === 'object' ? kept[1] : { name: lib.name, ...(lib.urn ? { urn: lib.urn } : {}) };
    const e = x.el('library', Object.entries(keptAttrs));
    for (const c of kept?.slice(2) ?? []) if (Array.isArray(c)) x.add(e, x.fromJsonML(c as JsonML));
    if (footprints.length) {
      const pk = x.add(e, x.el('packages'))!;
      for (const f of footprints) x.add(pk, this.footprint(x, f));
    }
    if (symbols.length) {
      const sy = x.add(e, x.el('symbols'))!;
      for (const s of symbols) x.add(sy, this.symbol(x, s));
    }
    if (components.length) {
      const ds = x.add(e, x.el('devicesets'))!;
      for (const c of components) x.add(ds, this.component(x, c));
    }
    x.order(e, DTD.library);
    return e;
  }

  private footprint(x: Xml, f: O.Footprint): Element {
    const e = x.el('package', [['name', componentName(f.id)]], f.eagle);
    if (f.description !== undefined) x.add(e, x.text('description', f.description));
    for (const g of f.graphics) x.add(e, this.graphic(x, g));
    for (const p of f.pads) x.add(e, this.pad(x, p));
    return e;
  }

  private pad(x: Xml, p: O.Pad): Element {
    if (p.smd) {
      return x.el('smd', [
        ['name', p.name], ['x', p.at[0]], ['y', p.at[1]], ['dx', p.smd[0]], ['dy', p.smd[1]],
        ['layer', p.side === 'bottom' ? 16 : 1], ['roundness', p.roundness], ['rot', rotAttr(p.rot)],
        ['stop', p.mask === false ? 'no' : undefined], ['thermals', p.thermals === false ? 'no' : undefined],
        ['cream', p.paste === false ? 'no' : undefined],
      ], p.eagle);
    }
    return x.el('pad', [
      ['name', p.name], ['x', p.at[0]], ['y', p.at[1]], ['drill', p.drill ?? 0], ['diameter', p.diameter],
      ['shape', p.shape], ['rot', rotAttr(p.rot)], ['thermals', p.thermals === false ? 'no' : undefined], ['first', p.first],
    ], p.eagle);
  }

  private symbol(x: Xml, s: O.Symbol): Element {
    const e = x.el('symbol', [['name', componentName(s.id)]], s.eagle);
    if (s.description !== undefined) x.add(e, x.text('description', s.description));
    for (const g of s.graphics) x.add(e, this.graphic(x, g));
    for (const p of s.pins) {
      x.add(e, x.el('pin', [
        ['name', p.name], ['x', p.at[0]], ['y', p.at[1]],
        ['visible', p.visible === 'none' ? 'off' : p.visible], ['length', p.length],
        ['direction', p.direction ? DIRECTION[p.direction] : undefined],
        ['function', p.function === 'clock' ? 'clk' : p.function === 'dotclock' ? 'dotclk' : p.function],
        ['swaplevel', p.swap], ['rot', rotAttr(p.rot)],
      ], p.eagle));
    }
    return e;
  }

  private component(x: Xml, c: O.Component): Element {
    const e = x.el('deviceset', [['name', componentName(c.id)], ['prefix', c.prefix], ['uservalue', c.userValue]], c.eagle);
    if (c.description !== undefined) x.add(e, x.text('description', c.description));
    const gates = x.add(e, x.el('gates'))!;
    for (const g of c.gates) {
      x.add(gates, x.el('gate', [
        ['name', g.name], ['symbol', componentName(g.symbol)], ['x', g.at[0]], ['y', g.at[1]],
        ['addlevel', g.addLevel], ['swaplevel', g.swap],
      ], g.eagle));
    }
    const devices = x.add(e, x.el('devices'))!;
    for (const v of c.variants) {
      const d = x.el('device', [['name', v.name], ['package', v.footprint ? componentName(v.footprint) : undefined]], v.eagle);
      const entries = Object.entries(v.pads);
      if (entries.length) {
        const connects = x.add(d, x.el('connects'))!;
        for (const [pinKey, pads] of entries) {
          const dot = pinKey.indexOf('.');
          x.add(connects, x.el('connect', [['gate', pinKey.slice(0, dot)], ['pin', pinKey.slice(dot + 1)], ['pad', pads.join(' ')]]));
        }
      }
      const techs = x.add(d, x.el('technologies'))!;
      for (const [name, attrs] of Object.entries(v.technologies ?? { '': {} })) {
        const t = x.add(techs, x.el('technology', [['name', name]]))!;
        for (const [k, val] of Object.entries(attrs)) {
          const value = typeof val === 'string' ? val : val.value;
          x.add(t, x.el('attribute', [['name', k], ['value', value], ['constant', typeof val === 'string' ? undefined : 'no']]));
        }
      }
      x.order(d, DTD.device);
      x.add(devices, d);
    }
    x.order(e, DTD.deviceset);
    return e;
  }

  // -------------------------------------------------------------------------
  // Schematic

  private sheet(x: Xml, sheet: O.Sheet): Element {
    const e = x.el('sheet', [], sheet.eagle);
    if (sheet.description !== undefined) x.add(e, x.text('description', sheet.description));
    const plain = x.add(e, x.el('plain'))!;
    for (const g of sheet.drawing) x.add(plain, this.graphic(x, g));
    const instances = x.add(e, x.el('instances'))!;
    for (const g of sheet.gates) {
      const i = x.el('instance', [
        ['part', g.part], ['gate', g.gate], ['x', g.at[0]], ['y', g.at[1]], ['smashed', g.smashed], ['rot', rotAttr(g.rot, g.mirror)],
      ], g.eagle);
      for (const l of g.labels ?? []) x.add(i, this.label(x, l));
      x.add(instances, i);
    }
    const busses = x.add(e, x.el('busses'))!;
    for (const bus of this.project.busses ?? []) {
      const segs = bus.segments.filter((s) => s.sheet === sheet.id);
      if (!segs.length) continue;
      const b = x.add(busses, x.el('bus', [['name', bus.name]], bus.eagle))!;
      for (const s of segs) x.add(b, this.segment(x, { ...s, pins: [] }, 92));
    }
    const nets = x.add(e, x.el('nets'))!;
    for (const net of this.project.nets) {
      const segs = (net.segments ?? []).filter((s) => s.sheet === sheet.id);
      if (!segs.length) continue;
      const n = x.add(nets, x.el('net', [['name', net.name], ['class', net.class ?? 0]]))!;
      for (const s of segs) x.add(n, this.segment(x, s, 91));
    }
    x.order(e, DTD.sheet);
    return e;
  }

  private segment(x: Xml, s: O.Segment, wireLayer: number): Element {
    const e = x.el('segment', [], s.eagle);
    for (const p of s.pins) x.add(e, x.el('pinref', [['part', p.part], ['gate', p.gate], ['pin', p.pin]]));
    for (const w of s.wires) x.add(e, this.line(x, w, w.layer ?? (wireLayer === 91 ? 'nets' : 'busses')));
    for (const j of s.junctions ?? []) x.add(e, x.el('junction', [['x', j[0]], ['y', j[1]]]));
    for (const l of s.labels ?? []) {
      x.add(e, x.el('label', [
        ['x', l.at[0]], ['y', l.at[1]], ['size', l.size], ['layer', layerNumber(l.layer)], ['font', l.font],
        ['ratio', l.ratio], ['rot', rotAttr(l.rot, l.mirror, l.spin)], ['xref', l.xref], ['align', l.align],
      ], l.eagle));
    }
    return e;
  }

  private label(x: Xml, l: O.Label): Element {
    return x.el('attribute', [
      ['name', l.attr], ['value', l.value], ['x', l.at[0]], ['y', l.at[1]], ['size', l.size], ['layer', layerNumber(l.layer)],
      ['font', l.font], ['ratio', l.ratio], ['rot', rotAttr(l.rot, l.mirror, l.spin)],
      ['display', l.display === 'none' ? 'off' : l.display], ['align', l.align],
    ], l.eagle);
  }

  // -------------------------------------------------------------------------
  // Graphics

  private line(x: Xml, w: { line: [O.Pt, O.Pt]; width: number; curve?: number; cap?: 'flat'; style?: string; eagle?: O.ObjectPassthrough }, layer: string): Element {
    return x.el('wire', [
      ['x1', w.line[0][0]], ['y1', w.line[0][1]], ['x2', w.line[1][0]], ['y2', w.line[1][1]], ['width', w.width],
      ['layer', layerNumber(layer)], ['style', w.style], ['curve', w.curve], ['cap', w.cap],
    ], w.eagle);
  }

  private polygon(x: Xml, p: O.PolygonShape): Element {
    const e = x.el('polygon', [
      ['width', p.width], ['layer', layerNumber(p.layer)], ['spacing', p.spacing], ['pour', p.pour], ['isolate', p.isolate],
      ['orphans', p.orphans], ['thermals', p.thermals === false ? 'no' : undefined], ['rank', p.rank],
    ], p.eagle);
    for (const v of p.polygon) x.add(e, x.el('vertex', [['x', v[0]], ['y', v[1]], ['curve', v[2]]]));
    return e;
  }

  private graphic(x: Xml, g: O.Graphic): Element {
    if ('line' in g) return this.line(x, g, g.layer);
    if ('polygon' in g) return this.polygon(x, g);
    if ('text' in g) {
      return x.text('text', g.text, [
        ['x', g.at[0]], ['y', g.at[1]], ['size', g.size], ['layer', layerNumber(g.layer)], ['font', g.font],
        ['ratio', g.ratio], ['rot', rotAttr(g.rot, g.mirror, g.spin)], ['align', g.align],
      ], g.eagle);
    }
    if ('circle' in g) return x.el('circle', [['x', g.circle[0]], ['y', g.circle[1]], ['radius', g.radius], ['width', g.width], ['layer', layerNumber(g.layer)]], g.eagle);
    if ('rect' in g) {
      return x.el('rectangle', [['x1', g.rect[0][0]], ['y1', g.rect[0][1]], ['x2', g.rect[1][0]], ['y2', g.rect[1][1]], ['layer', layerNumber(g.layer)], ['rot', rotAttr(g.rot)]], g.eagle);
    }
    if ('hole' in g) return x.el('hole', [['x', g.hole[0]], ['y', g.hole[1]], ['drill', g.drill]], g.eagle);
    return x.el('frame', [['x1', g.frame[0][0]], ['y1', g.frame[0][1]], ['x2', g.frame[1][0]], ['y2', g.frame[1][1]], ['columns', g.columns], ['rows', g.rows], ['layer', layerNumber(g.layer)]], g.eagle);
  }
}
