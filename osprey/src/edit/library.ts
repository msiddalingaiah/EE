// Edits to a library's symbols and footprints: pins and pads, and their properties. A
// component maps its gates' pins to its footprints' pads ("gate.pin" → pad names), so
// renaming or deleting a pin or pad updates the components of the same library that use it,
// and the library stays consistent. Validation runs first and returns a message instead of
// changing anything when the edit isn't allowed.

import type * as O from '../model/types';
import { insert, remove, set, type Transaction } from './ops';

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

function renameId(lib: O.Library, kind: ItemKind, item: Item, id: string, tx: Transaction): void {
  const old = item.id;
  for (const c of lib.components) {
    if (kind === 'symbol') for (const g of c.gates) if (g.symbol === old) tx.run(set(g, { symbol: id }));
    if (kind === 'footprint') for (const v of c.variants) if (v.footprint === old) tx.run(set(v, { footprint: id }));
  }
  tx.run(set(item, { id }));
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
}

/** Change a graphic's layer, width, radius, text or text size. Returns an error message, or undefined. */
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
  tx.run(set(g, out));
  return undefined;
}
