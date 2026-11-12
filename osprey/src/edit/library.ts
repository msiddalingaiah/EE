// Edits to a library's symbols and footprints: pins and pads, and their properties. A
// component maps its gates' pins to its footprints' pads ("gate.pin" → pad names), so
// renaming or deleting a pin or pad updates the components of the same library that use it,
// and the library stays consistent. Validation runs first and returns a message instead of
// changing anything when the edit isn't allowed.

import type * as O from '../model/types';
import { remove, set, type Transaction } from './ops';

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
