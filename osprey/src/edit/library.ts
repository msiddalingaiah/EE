// Edits to a library's symbols and footprints: pins and pads, and their properties. A
// component maps its gates' pins to its footprints' pads ("gate.pin" → pad names), so
// renaming or deleting a pin or pad updates the components of the same library that use it,
// and the library stays consistent. Validation runs first and returns a message instead of
// changing anything when the edit isn't allowed.

import { componentName } from '../model/derive';
import type * as O from '../model/types';
import { insert, remove, set, type Transaction } from './ops';
import { insertSorted } from './place';

/** Pin and pad names: any text without white space ("@" suffixes make pin names unique). */
function nameProblem(name: string, what: 'pin' | 'pad'): string | undefined {
  if (!name) return `A ${what} name can't be empty`;
  if (/\s/.test(name)) return `A ${what} name can't contain spaces`;
  return undefined;
}

/** The components' gates that use a symbol. */
function gatesUsing(lib: O.Library, symbol: O.Symbol): { component: O.Component; gate: O.Gate }[] {
  return lib.components.flatMap((component) => component.gates.filter((g) => g.symbol === symbol.id).map((gate) => ({ component, gate })));
}

/** The variants that use a footprint. */
function variantsUsing(lib: O.Library, footprint: O.Footprint): O.Variant[] {
  return lib.components.flatMap((c) => c.variants.filter((v) => v.footprint === footprint.id));
}

/** Replace a variant's pin-to-pad map with what `edit` makes of a copy of it. */
function editPads(v: O.Variant, edit: (pads: Record<string, string[]>) => void, tx: Transaction): void {
  const pads = structuredClone(v.pads);
  edit(pads);
  if (JSON.stringify(pads) !== JSON.stringify(v.pads)) tx.run(set(v, { pads }));
}

/** Delete a pin from a symbol, and from the pin-to-pad maps of the components that use it. */
export function deletePin(lib: O.Library, symbol: O.Symbol, pin: O.Pin, tx: Transaction): void {
  if (!symbol.pins.includes(pin)) return;
  tx.run(remove(symbol.pins, pin));
  for (const { component, gate } of gatesUsing(lib, symbol)) {
    for (const v of component.variants) editPads(v, (pads) => delete pads[`${gate.name}.${pin.name}`], tx);
  }
}

/** Delete a pad from a footprint, and from the pin-to-pad maps of the variants that use it. */
export function deletePad(lib: O.Library, footprint: O.Footprint, pad: O.Pad, tx: Transaction): void {
  if (!footprint.pads.includes(pad)) return;
  tx.run(remove(footprint.pads, pad));
  for (const v of variantsUsing(lib, footprint)) {
    editPads(v, (pads) => {
      for (const [key, list] of Object.entries(pads)) {
        const rest = list.filter((p) => p !== pad.name);
        if (rest.length) pads[key] = rest;
        else delete pads[key];
      }
    }, tx);
  }
}

/** Rename a pin, in the symbol and in the pin-to-pad maps. Returns an error message, or undefined. */
export function renamePin(lib: O.Library, symbol: O.Symbol, pin: O.Pin, raw: string, tx: Transaction): string | undefined {
  const name = raw.trim();
  const problem = nameProblem(name, 'pin');
  if (problem) return problem;
  if (name === pin.name) return undefined;
  if (symbol.pins.some((p) => p !== pin && p.name === name)) return `This symbol already has a pin named ${name}`;
  for (const { component, gate } of gatesUsing(lib, symbol)) {
    for (const v of component.variants) {
      editPads(v, (pads) => {
        const old = `${gate.name}.${pin.name}`;
        if (!(old in pads)) return;
        pads[`${gate.name}.${name}`] = pads[old]!;
        delete pads[old];
      }, tx);
    }
  }
  tx.run(set(pin, { name }));
  return undefined;
}

/** Rename a pad, in the footprint and in the pin-to-pad maps. Returns an error message, or undefined. */
export function renamePad(lib: O.Library, footprint: O.Footprint, pad: O.Pad, raw: string, tx: Transaction): string | undefined {
  const name = raw.trim();
  const problem = nameProblem(name, 'pad');
  if (problem) return problem;
  if (name === pad.name) return undefined;
  if (footprint.pads.some((p) => p !== pad && p.name === name)) return `This footprint already has a pad named ${name}`;
  for (const v of variantsUsing(lib, footprint)) {
    editPads(v, (pads) => {
      for (const list of Object.values(pads)) for (let i = 0; i < list.length; i++) if (list[i] === pad.name) list[i] = name;
    }, tx);
  }
  tx.run(set(pad, { name }));
  return undefined;
}

/** `direction: 'io'` and the other defaults are stored as absent. */
export type PinPatch = Partial<Pick<O.Pin, 'length' | 'function' | 'visible' | 'swap'>> & { direction?: O.PinDirection };

/** Change a pin's electrical and drawing properties (defaults are stored as absent). */
export function setPin(pin: O.Pin, patch: PinPatch, tx: Transaction): string | undefined {
  if (patch.swap !== undefined && !(Number.isInteger(patch.swap) && patch.swap >= 0 && patch.swap <= 255)) return 'The swap level is a whole number from 0 to 255';
  const v = <T>(value: T | undefined, dflt: T) => (value === dflt ? undefined : value);
  const out: Record<string, unknown> = {};
  if ('direction' in patch) out.direction = v(patch.direction, 'io');
  if ('length' in patch) out.length = v(patch.length, 'long' as never);
  if ('function' in patch) out.function = patch.function;
  if ('visible' in patch) out.visible = v(patch.visible, 'both' as never);
  if ('swap' in patch) out.swap = v(patch.swap, 0);
  tx.run(set(pin, out));
  return undefined;
}

export interface PadPatch {
  /** SMD copper size [dx, dy] in mm. */
  smd?: O.Pt;
  roundness?: number;
  drill?: number;
  /** 0: automatic, from the drill and the design rules. */
  diameter?: number;
  shape?: O.Pad['shape'] | 'round';
  rot?: number;
}

/** Change a pad's size, drill or shape. Returns an error message, or undefined. */
export function setPad(pad: O.Pad, patch: PadPatch, tx: Transaction): string | undefined {
  const out: Record<string, unknown> = {};
  if (patch.smd) {
    if (!pad.smd) return 'Only an SMD pad has a size';
    if (!(patch.smd[0] > 0 && patch.smd[1] > 0)) return 'An SMD pad needs a width and height above 0';
    out.smd = patch.smd;
  }
  if (patch.roundness !== undefined) {
    if (!pad.smd) return 'Only an SMD pad has a roundness';
    if (!(patch.roundness >= 0 && patch.roundness <= 100)) return 'Roundness is a percentage, 0 to 100';
    out.roundness = patch.roundness || undefined;
  }
  if (patch.drill !== undefined) {
    if (pad.smd) return 'An SMD pad has no drill';
    if (!(patch.drill > 0)) return 'A drill needs a diameter above 0';
    out.drill = patch.drill;
  }
  if (patch.diameter !== undefined) {
    if (pad.smd) return 'An SMD pad has no diameter; set its size';
    if (patch.diameter < 0) return "A diameter can't be negative";
    if (patch.diameter && patch.diameter <= (patch.drill ?? pad.drill ?? 0)) return 'The pad must be wider than its drill';
    out.diameter = patch.diameter || undefined;
  }
  if (patch.shape !== undefined) {
    if (pad.smd) return 'An SMD pad has no shape; set its roundness';
    out.shape = patch.shape === 'round' ? undefined : patch.shape;
  }
  if (patch.rot !== undefined) {
    if (!Number.isFinite(patch.rot)) return 'The rotation is an angle in degrees';
    const r = Math.round((((patch.rot % 360) + 360) % 360) * 1e6) / 1e6;
    out.rot = r || undefined;
  }
  tx.run(set(pad, out));
  return undefined;
}

/**
 * A library file as a project for the editor, which edits projects: the library, with no
 * parts or nets, and grids for drawing symbols (0.1 inch) and footprints (0.635 mm, 25 mil).
 * Edits change the library file's own objects.
 */
export function libraryProject(f: O.LibraryFile): O.Project {
  return {
    osprey: f.osprey, project: { name: f.name }, library: f.library, parts: [], nets: [],
    schematic: { grid: { step: 2.54, fine: 0.254, unit: 'inch' }, sheets: [] },
    board: { grid: { step: 0.635, fine: 0.127, unit: 'mm' }, layers: ['copper.top', 'copper.bottom'], footprints: [], drawing: [] },
  };
}

// ---------------------------------------------------------------------------
// New pins, pads, graphics and items

/** The next free pin name in a symbol: P$1, P$2… (Eagle's default names). */
export function nextPinName(symbol: O.Symbol): string {
  const used = new Set(symbol.pins.map((p) => p.name));
  let n = 1;
  while (used.has(`P$${n}`)) n++;
  return `P$${n}`;
}

/** The next free pad name in a footprint: one more than the highest number used (1, 2…). */
export function nextPadName(footprint: O.Footprint): string {
  const used = new Set(footprint.pads.map((p) => p.name));
  let n = Math.max(0, ...footprint.pads.map((p) => (/^\d+$/.test(p.name) ? Number(p.name) : 0))) + 1;
  while (used.has(String(n))) n++;
  return String(n);
}

/** Library item names: upper case (as Eagle stores them), no white space or "/". */
function itemName(raw: string, what: string): { name?: string; problem?: string } {
  const name = raw.trim().toUpperCase();
  if (!name) return { problem: `A ${what} name can't be empty` };
  if (/[\s/]/.test(name)) return { problem: `A ${what} name can't contain spaces or "/"` };
  return { name };
}

export type ItemKind = 'symbol' | 'footprint' | 'component';
type Item = O.Symbol | O.Footprint | O.Component;

const listOf = (lib: O.Library, kind: ItemKind): Item[] =>
  kind === 'symbol' ? lib.symbols : kind === 'footprint' ? lib.footprints : lib.components;

/** The library part of an id: "madhu/DIODE" → "madhu". */
const prefixOf = (id: string) => id.slice(0, id.indexOf('/'));

/** A new, empty symbol or footprint named NEW (NEW-2… if taken), in library `libName`. */
export function addItem(lib: O.Library, libName: string, kind: 'symbol' | 'footprint', tx: Transaction): O.Symbol | O.Footprint {
  const list = listOf(lib, kind);
  let name = 'NEW';
  for (let n = 2; list.some((x) => x.id === `${libName}/${name}`); n++) name = `NEW-${n}`;
  if (kind === 'symbol') {
    const item: O.Symbol = { id: `${libName}/${name}`, graphics: [], pins: [] };
    tx.run(insert(lib.symbols, item));
    return item;
  }
  const item: O.Footprint = { id: `${libName}/${name}`, graphics: [], pads: [] };
  tx.run(insert(lib.footprints, item));
  return item;
}

/** Rename a symbol, footprint or component (its id), and the library's references to it. */
export function renameItem(lib: O.Library, kind: ItemKind, item: Item, raw: string, tx: Transaction): string | undefined {
  const { name, problem } = itemName(raw, kind);
  if (problem) return problem;
  const id = `${prefixOf(item.id)}/${name}`;
  if (id === item.id) return undefined;
  if (listOf(lib, kind).some((x) => x !== item && x.id === id)) return `There is already a ${kind} named ${name}`;
  renameId(lib, kind, item, id, tx);
  return undefined;
}

/** Give an item a new id, where the new id sorts (files stay in name order); references follow. */
function renameId(lib: O.Library, kind: ItemKind, item: Item, id: string, tx: Transaction): void {
  const old = item.id;
  for (const c of lib.components) {
    if (kind === 'symbol') for (const g of c.gates) if (g.symbol === old) tx.run(set(g, { symbol: id }));
    if (kind === 'footprint') for (const v of c.variants) if (v.footprint === old) tx.run(set(v, { footprint: id }));
  }
  const list = listOf(lib, kind) as Item[];
  tx.run(remove(list, item));
  tx.run(set(item, { id }));
  insertSorted(list, item, tx);
}

/**
 * Rename a library file, and the ids of its items that carry its name ("old/X" → "new/X"),
 * so new parts placed from it are named after it. Items from other libraries keep theirs.
 */
export function renameLibrary(file: O.LibraryFile, raw: string, tx: Transaction): string | undefined {
  const name = raw.trim();
  if (!name) return "A library name can't be empty";
  if (/[\s/]/.test(name)) return 'A library name can\'t contain spaces or "/"';
  if (name === file.name) return undefined;
  const lib = file.library;
  const kinds = ['symbol', 'footprint', 'component'] as const;
  const renamed = (id: string) => `${name}/${id.slice(id.indexOf('/') + 1)}`;
  for (const kind of kinds) {
    for (const item of listOf(lib, kind)) {
      if (prefixOf(item.id) === file.name && listOf(lib, kind).some((x) => x.id === renamed(item.id))) {
        return `The library already has a ${kind} ${renamed(item.id)}`;
      }
    }
  }
  for (const kind of kinds) {
    for (const item of [...listOf(lib, kind)]) if (prefixOf(item.id) === file.name) renameId(lib, kind, item, renamed(item.id), tx);
  }
  tx.run(set(file, { name }));
  return undefined;
}

export interface GraphicPatch {
  layer?: string;
  width?: number;
  radius?: number;
  text?: string;
  size?: number;
  /** A text's stroke width as a percentage of its size (Eagle's ratio, default 8). */
  ratio?: number;
  /** A text's rotation in degrees (any angle). */
  rot?: number;
  /** A text read from the other side (bottom-side silkscreen). */
  mirror?: boolean;
}

/** Change a graphic's layer, width, radius, or a text's wording, size, ratio, rotation or mirroring. Returns an error message, or undefined. */
export function setGraphic(g: O.Graphic, patch: GraphicPatch, tx: Transaction): string | undefined {
  const out: Record<string, unknown> = {};
  if (patch.layer !== undefined) out.layer = patch.layer;
  if (patch.width !== undefined) {
    if (!('width' in g)) return 'This has no line width';
    if (!(patch.width >= 0)) return "A width can't be negative";
    out.width = patch.width;
  }
  if (patch.radius !== undefined) {
    if (!('circle' in g)) return 'Only a circle has a radius';
    if (!(patch.radius > 0)) return 'A radius needs to be above 0';
    out.radius = patch.radius;
  }
  if (patch.text !== undefined) {
    if (!('text' in g)) return 'This is not a text';
    if (!patch.text.trim()) return "A text can't be empty";
    out.text = patch.text;
  }
  if (patch.size !== undefined) {
    if (!('text' in g)) return 'Only a text has a size';
    if (!(patch.size > 0)) return 'A text size needs to be above 0';
    out.size = patch.size;
  }
  if (patch.ratio !== undefined) {
    if (!('text' in g)) return 'Only a text has a ratio';
    if (!(patch.ratio >= 0 && patch.ratio <= 31)) return 'The ratio is the stroke width as a percentage of the size, 0 to 31';
    out.ratio = patch.ratio === 8 ? undefined : patch.ratio;
  }
  if (patch.rot !== undefined) {
    if (!('text' in g)) return 'Only a text has a rotation here';
    if (!Number.isFinite(patch.rot)) return 'The rotation is an angle in degrees';
    const r = Math.round((((patch.rot % 360) + 360) % 360) * 1e6) / 1e6;
    out.rot = r || undefined;
  }
  if (patch.mirror !== undefined) {
    if (!('text' in g)) return 'Only a text can be mirrored here';
    out.mirror = patch.mirror || undefined;
  }
  tx.run(set(g, out));
  return undefined;
}

// ---------------------------------------------------------------------------
// Components: gates, variants and the pin-to-pad map

/** A new component named NEW (NEW-2… if taken), with one variant ('') and no gates yet. */
export function addComponent(lib: O.Library, libName: string, tx: Transaction): O.Component {
  let name = 'NEW';
  for (let n = 2; lib.components.some((x) => x.id === `${libName}/${name}`); n++) name = `NEW-${n}`;
  const c: O.Component = { id: `${libName}/${name}`, gates: [], variants: [{ name: '', pads: {} }] };
  tx.run(insert(lib.components, c));
  return c;
}

export interface ComponentPatch {
  prefix?: string;
  /** The value is typed for each part (a resistor's 10k), rather than the component's name. */
  userValue?: boolean;
  description?: string;
}

export function setComponent(c: O.Component, patch: ComponentPatch, tx: Transaction): string | undefined {
  const out: Record<string, unknown> = {};
  if (patch.prefix !== undefined) {
    const prefix = patch.prefix.trim().toUpperCase();
    if (/[\s/.]/.test(prefix)) return 'A prefix is letters such as R or U, without spaces';
    out.prefix = prefix || undefined;
  }
  if (patch.userValue !== undefined) out.userValue = patch.userValue || undefined;
  if (patch.description !== undefined) out.description = patch.description.trim() || undefined;
  tx.run(set(c, out));
  return undefined;
}

/** Add a gate showing `symbol` at a point, named G$1, G$2… */
export function addGate(c: O.Component, symbol: O.Symbol, at: O.Pt, tx: Transaction): O.Gate {
  let n = 1;
  while (c.gates.some((g) => g.name === `G$${n}`)) n++;
  const gate: O.Gate = { name: `G$${n}`, symbol: symbol.id, at };
  tx.run(insert(c.gates, gate));
  return gate;
}

/** Delete a gate, and its pins' connections in every variant. */
export function deleteGate(c: O.Component, gate: O.Gate, tx: Transaction): void {
  if (!c.gates.includes(gate)) return;
  tx.run(remove(c.gates, gate));
  for (const v of c.variants) {
    editPads(v, (pads) => {
      for (const key of Object.keys(pads)) if (key.startsWith(`${gate.name}.`)) delete pads[key];
    }, tx);
  }
}

/** Rename a gate, in the component and in its variants' pin-to-pad maps. */
export function renameGate(c: O.Component, gate: O.Gate, raw: string, tx: Transaction): string | undefined {
  const name = raw.trim().toUpperCase();
  if (!name) return "A gate name can't be empty";
  if (/[\s.]/.test(name)) return 'A gate name can\'t contain spaces or "."';
  if (name === gate.name) return undefined;
  if (c.gates.some((g) => g !== gate && g.name === name)) return `This component already has a gate named ${name}`;
  for (const v of c.variants) {
    editPads(v, (pads) => {
      for (const key of Object.keys(pads)) {
        if (!key.startsWith(`${gate.name}.`)) continue;
        pads[`${name}.${key.slice(gate.name.length + 1)}`] = pads[key]!;
        delete pads[key];
      }
    }, tx);
  }
  tx.run(set(gate, { name }));
  return undefined;
}

export interface GatePatch {
  addLevel?: O.Gate['addLevel'] | 'next';
  swap?: number;
}

export function setGate(gate: O.Gate, patch: GatePatch, tx: Transaction): string | undefined {
  const out: Record<string, unknown> = {};
  if (patch.addLevel !== undefined) out.addLevel = patch.addLevel === 'next' ? undefined : patch.addLevel;
  if (patch.swap !== undefined) {
    if (!(Number.isInteger(patch.swap) && patch.swap >= 0 && patch.swap <= 255)) return 'The swap level is a whole number from 0 to 255';
    out.swap = patch.swap || undefined;
  }
  tx.run(set(gate, out));
  return undefined;
}

/** Add a variant (a package option) using a footprint, or none (a symbol only, e.g. a supply). */
export function addVariant(c: O.Component, raw: string, footprint: string | undefined, tx: Transaction): string | undefined {
  const name = raw.trim().toUpperCase();
  if (/\s/.test(name)) return "A variant name can't contain spaces";
  if (c.variants.some((v) => v.name === name)) return name ? `There is already a variant ${name}` : "There is already a variant named '' (no name)";
  tx.run(insert(c.variants, { name, ...(footprint ? { footprint } : {}), pads: {} }));
  return undefined;
}

export function renameVariant(c: O.Component, v: O.Variant, raw: string, tx: Transaction): string | undefined {
  const name = raw.trim().toUpperCase();
  if (/\s/.test(name)) return "A variant name can't contain spaces";
  if (name === v.name) return undefined;
  if (c.variants.some((x) => x !== v && x.name === name)) return `There is already a variant ${name || "''"}`;
  tx.run(set(v, { name }));
  return undefined;
}

export function deleteVariant(c: O.Component, v: O.Variant, tx: Transaction): string | undefined {
  if (c.variants.length <= 1) return 'A component needs at least one variant';
  tx.run(remove(c.variants, v));
  return undefined;
}

/** Change a variant's footprint; connections to pads the new footprint doesn't have are dropped. */
export function setVariantFootprint(lib: O.Library, v: O.Variant, footprintId: string | undefined, tx: Transaction): string | undefined {
  const fp = footprintId ? lib.footprints.find((f) => f.id === footprintId) : undefined;
  if (footprintId && !fp) return `No footprint ${footprintId} in this library`;
  const names = new Set(fp?.pads.map((p) => p.name) ?? []);
  editPads(v, (pads) => {
    for (const [key, list] of Object.entries(pads)) {
      const rest = list.filter((p) => names.has(p));
      if (rest.length) pads[key] = rest;
      else delete pads[key];
    }
  }, tx);
  tx.run(set(v, { footprint: footprintId }));
  return undefined;
}

/**
 * Connect a gate's pin to pads of the variant's footprint (none: unconnected). A pad belongs
 * to one pin at most; a pin may have several pads (e.g. GND on two pads).
 */
export function connectPin(lib: O.Library, v: O.Variant, key: string, padNames: string[], tx: Transaction): string | undefined {
  const fp = v.footprint ? lib.footprints.find((f) => f.id === v.footprint) : undefined;
  if (!fp) return 'Choose a footprint for this variant first';
  const names = [...new Set(padNames.map((p) => p.trim()).filter(Boolean))];
  for (const p of names) {
    if (!fp.pads.some((x) => x.name === p)) return `${componentName(fp.id)} has no pad ${p}`;
    const other = Object.entries(v.pads).find(([k, list]) => k !== key && list.includes(p));
    if (other) return `Pad ${p} is already connected to ${other[0]}`;
  }
  editPads(v, (pads) => {
    if (names.length) pads[key] = names;
    else delete pads[key];
  }, tx);
  return undefined;
}

/** An LCSC part number as typed (" c20526 " → C20526), or why it isn't one. Empty is allowed (none). */
export function lcscNumber(raw: string): { value: string; problem?: string } {
  const value = raw.trim().toUpperCase();
  if (value && !/^C\d+$/.test(value)) return { value, problem: 'An LCSC part number is C followed by digits, e.g. C25804' };
  return { value };
}

/**
 * Set (or with an empty value, remove) an attribute of one of a variant's technologies, as Eagle
 * keeps MF, MPN and the like: a component's default LCSC part number, say. A variant left with
 * only the unnamed technology and no attributes stores no technologies, as an import would.
 */
export function setVariantAttribute(v: O.Variant, technology: string, name: string, value: string, tx: Transaction): void {
  const techs = structuredClone(v.technologies ?? {});
  const attrs = { ...(techs[technology] ?? {}) };
  if (value) attrs[name] = value;
  else delete attrs[name];
  techs[technology] = attrs;
  const names = Object.keys(techs);
  const trivial = names.length === 1 && names[0] === '' && Object.keys(techs['']!).length === 0;
  tx.run(set(v, { technologies: trivial ? undefined : techs }));
}

/**
 * Connect the pins left unconnected to the pads left free: first a pin to the pad of the same
 * name (A to A, GND to GND), then the rest in order (gates, then pins, in order; pads by
 * number). Returns how many pins were connected.
 */
export function autoConnect(lib: O.Library, c: O.Component, v: O.Variant, tx: Transaction): number {
  const fp = v.footprint ? lib.footprints.find((f) => f.id === v.footprint) : undefined;
  if (!fp) return 0;
  const used = new Set(Object.values(v.pads).flat());
  const free = fp.pads.map((p) => p.name).filter((p) => !used.has(p));
  const open: string[] = [];
  for (const g of c.gates) {
    for (const pin of lib.symbols.find((s) => s.id === g.symbol)?.pins ?? []) {
      const key = `${g.name}.${pin.name}`;
      if (!v.pads[key]?.length) open.push(key);
    }
  }
  const out: Record<string, string[]> = {};
  const take = (key: string, pad: string) => {
    out[key] = [pad];
    free.splice(free.indexOf(pad), 1);
  };
  for (const key of open) {
    const pin = key.slice(key.indexOf('.') + 1).replace(/@.*$/, '');
    if (free.includes(pin)) take(key, pin);
  }
  const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  free.sort(byNumber);
  for (const key of open) if (!out[key] && free.length) take(key, free[0]!);
  if (Object.keys(out).length) editPads(v, (pads) => Object.assign(pads, out), tx);
  return Object.keys(out).length;
}

// ---------------------------------------------------------------------------
// Duplicating and copying items

/** A free id in `list` for `name` in library `libName`: the name itself, else NAME-2, NAME-3… */
function freeId(list: { id: string }[], libName: string, name: string): string {
  if (!list.some((x) => x.id === `${libName}/${name}`)) return `${libName}/${name}`;
  // Always a suffix on the whole name: BERG-2 (a 2-pin header) becomes BERG-2-2, not BERG-3.
  for (let n = 2; ; n++) if (!list.some((x) => x.id === `${libName}/${name}-${n}`)) return `${libName}/${name}-${n}`;
}

/**
 * Duplicate a symbol, footprint or component in its library, as NAME-2 (or the next free
 * name). A duplicated component uses the same symbols and footprints as the original.
 */
export function duplicateItem(lib: O.Library, kind: ItemKind, item: Item, tx: Transaction): Item {
  const list = listOf(lib, kind);
  const copy = structuredClone(item);
  copy.id = freeId(list, prefixOf(item.id), componentName(item.id));
  insertSorted(list as Item[], copy, tx);
  return copy;
}

/** Library items equal apart from their ids (a footprint already copied, say). */
const sameContent = (a: Item, b: Item) => JSON.stringify({ ...a, id: '' }) === JSON.stringify({ ...b, id: '' });

export interface CopyResult {
  /** The copied item, as named in this library. */
  item: Item;
  /** Symbols and footprints copied with a component (ids in this library). */
  brought: string[];
  /** Items this library already had, used instead of a copy. */
  reused: string[];
}

/**
 * Copy an item from another library (or a project's) into `lib`, under this library's name
 * ("madhu/DIODE" → "mine/DIODE"). A component brings the symbols and footprints it uses. An
 * item this library already has with the same name and content is used as it is; one with the
 * same name but different content is copied as NAME-2, so nothing is overwritten.
 */
export function copyItem(source: O.Library, kind: ItemKind, id: string, lib: O.Library, libName: string, tx: Transaction): CopyResult | undefined {
  const src = listOf(source, kind).find((x) => x.id === id);
  if (!src) return undefined;
  const brought: string[] = [];
  const reused: string[] = [];
  const place = (k: ItemKind, item: Item): Item => {
    const list = listOf(lib, k);
    const name = componentName(item.id);
    const same = list.find((x) => x.id === `${libName}/${name}` && sameContent(x, item));
    if (same) return same;
    const copy = structuredClone(item);
    copy.id = freeId(list, libName, name);
    insertSorted(list as Item[], copy, tx);
    return copy;
  };
  if (kind !== 'component') {
    const existing = listOf(lib, kind).find((x) => x.id === `${libName}/${componentName(id)}` && sameContent(x, src));
    if (existing) return { item: existing, brought, reused: [existing.id] };
    return { item: place(kind, src), brought, reused };
  }
  // A component: its symbols and footprints first, then the component pointing at the copies.
  const c = structuredClone(src as O.Component);
  const ids = new Map<string, string>();
  const bring = (k: 'symbol' | 'footprint', from: string) => {
    if (ids.has(from)) return ids.get(from)!;
    const item = listOf(source, k).find((x) => x.id === from);
    if (!item) return from;
    const had = new Set(listOf(lib, k).map((x) => x.id));
    const copied = place(k, item);
    (had.has(copied.id) ? reused : brought).push(copied.id);
    ids.set(from, copied.id);
    return copied.id;
  };
  for (const g of c.gates) g.symbol = bring('symbol', g.symbol);
  for (const v of c.variants) if (v.footprint) v.footprint = bring('footprint', v.footprint);
  const list = lib.components;
  const same = list.find((x) => x.id === `${libName}/${componentName(id)}` && sameContent(x, c));
  if (same) return { item: same, brought, reused: [...reused, same.id] };
  c.id = freeId(list, libName, componentName(id));
  insertSorted(list, c, tx);
  return { item: c, brought, reused };
}
