// Property edits: rename parts and nets, change values, smash/unsmash part labels.
// Each updates the schematic and the board together when both are open. Validation runs
// first and returns a message instead of changing anything when the edit isn't allowed.

import { domOf, fmtCoord } from '../eagle/dom';
import { findLibrary } from '../eagle/parse';
import type { Board, Element, Instance, PlacedAttribute, Schematic, Text } from '../eagle/types';
import type { Transform } from '../geom/transform';
import { apply, composeRotation, placement } from '../geom/transform';
import { mirrorLayer } from '../scene/board';
import { rotAttr } from './common';
import { insertChild, removeItem, renameMapKey, setFields, type Transaction } from './ops';

/** Eagle stores part and net names in upper case and doesn't allow white space in them. */
export function normalizeName(raw: string): string {
  return raw.trim().toUpperCase();
}

function nameProblem(name: string, what: string): string | undefined {
  if (!name) return `A ${what} name can't be empty`;
  if (/\s/.test(name)) return `A ${what} name can't contain spaces`;
  return undefined;
}

export interface Docs {
  sch: Schematic | undefined;
  brd: Board | undefined;
}

export interface Touched {
  schematic: boolean;
  board: boolean;
}

// ---------------------------------------------------------------------------
// Part name

/**
 * Rename a part everywhere it is referenced: the schematic part, its gates and pinrefs,
 * and the board element and its contactrefs. Returns an error message, or undefined.
 */
export function renamePart(docs: Docs, oldName: string, raw: string, tx: Transaction): string | Touched {
  const name = normalizeName(raw);
  const problem = nameProblem(name, 'part');
  if (problem) return problem;
  if (name === oldName) return { schematic: false, board: false };
  const taken = docs.sch?.parts.has(name) || docs.brd?.elements.some((e) => e.name === name);
  if (taken) return `There is already a part named ${name}`;

  const touched = { schematic: false, board: false };
  const { sch, brd } = docs;
  if (sch?.parts.has(oldName)) {
    const part = sch.parts.get(oldName)!;
    tx.run(renameMapKey(sch.parts, oldName, name));
    tx.run(setFields(part, { name }, { name }));
    for (const sheet of sch.sheets) {
      for (const inst of sheet.instances) if (inst.part === oldName) tx.run(setFields(inst, { part: name }, { part: name }));
      for (const net of [...sheet.nets, ...sheet.busses]) {
        for (const seg of net.segments) {
          for (const pr of seg.pinrefs) if (pr.part === oldName) tx.run(setFields(pr, { part: name }, { part: name }));
        }
      }
    }
    touched.schematic = true;
  }
  const el = brd?.elements.find((e) => e.name === oldName);
  if (brd && el) {
    tx.run(setFields(el, { name }, { name }));
    for (const s of brd.signals) {
      for (const cr of s.contactrefs) if (cr.element === oldName) tx.run(setFields(cr, { element: name }, { element: name }));
    }
    touched.board = true;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Value

/**
 * Set a part's value in the schematic and on the board. Parts whose device set fixes the
 * value (e.g. 74*151 → 74LS151D) can't take a user value, as in Eagle.
 */
export function setPartValue(docs: Docs, partName: string, value: string, tx: Transaction): string | Touched {
  const { sch, brd } = docs;
  const part = sch?.parts.get(partName);
  if (sch && part) {
    const ds = findLibrary(sch.libraries, part.library, part.libraryUrn)?.devicesets.get(part.deviceset);
    if (ds && !ds.uservalue) return `${partName}'s value is fixed by its device (${ds.name}); change the device instead`;
  }
  const touched = { schematic: false, board: false };
  if (part && part.value !== value) {
    tx.run(setFields(part, { value }, { value }));
    touched.schematic = true;
  }
  const el = brd?.elements.find((e) => e.name === partName);
  if (el && el.value !== value) {
    tx.run(setFields(el, { value }, { value }));
    touched.board = true;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Net name

/**
 * Rename a net: every schematic net of that name (on all sheets) and the board signal.
 * Refused when the new name is taken (that would merge nets, a connectivity change) or
 * when the net's name comes from a supply symbol or implicit power pins.
 */
export function renameNet(docs: Docs, oldName: string, raw: string, tx: Transaction): string | Touched {
  const name = normalizeName(raw);
  const problem = nameProblem(name, 'net');
  if (problem) return problem;
  const { sch, brd } = docs;
  if (name === oldName) return { schematic: false, board: false };
  const schTaken = sch?.sheets.some((s) => s.nets.some((n) => n.name === name));
  const brdTaken = brd?.signals.some((s) => s.name === name);
  if (schTaken || brdTaken) return `Net ${name} already exists; joining nets isn't supported yet`;
  if (sch) {
    const supply = supplyReason(sch, oldName);
    if (supply) return supply;
  }

  const touched = { schematic: false, board: false };
  for (const sheet of sch?.sheets ?? []) {
    for (const net of sheet.nets) {
      if (net.name !== oldName) continue;
      tx.run(setFields(net, { name }, { name }));
      touched.schematic = true;
    }
  }
  for (const s of brd?.signals ?? []) {
    if (s.name !== oldName) continue;
    tx.run(setFields(s, { name }, { name }));
    touched.board = true;
  }
  return touched;
}

/** Why a net's name is fixed by power connections, if it is. */
function supplyReason(sch: Schematic, netName: string): string | undefined {
  for (const sheet of sch.sheets) {
    for (const net of sheet.nets.filter((n) => n.name === netName)) {
      for (const seg of net.segments) {
        for (const pr of seg.pinrefs) {
          const pin = pinOf(sch, pr.part, pr.gate, pr.pin);
          if (pin?.direction === 'sup') return `${netName} is named by its supply symbol (${pr.part}); it can't be renamed`;
        }
      }
    }
  }
  // Unwired power pins join the net with their own name.
  for (const part of sch.parts.values()) {
    const lib = findLibrary(sch.libraries, part.library, part.libraryUrn);
    for (const gate of lib?.devicesets.get(part.deviceset)?.gates ?? []) {
      for (const pin of lib?.symbols.get(gate.symbol)?.pins ?? []) {
        if (pin.direction === 'pwr' && pin.name.replace(/@.*$/, '') === netName) {
          return `${netName} is a supply net (power pins of ${part.name} connect to it by name); it can't be renamed`;
        }
      }
    }
  }
  return undefined;
}

function pinOf(sch: Schematic, partName: string, gateName: string, pinName: string) {
  const part = sch.parts.get(partName);
  const lib = part && findLibrary(sch.libraries, part.library, part.libraryUrn);
  const gate = lib?.devicesets.get(part!.deviceset)?.gates.find((g) => g.name === gateName);
  return gate && lib?.symbols.get(gate.symbol)?.pins.find((p) => p.name === pinName);
}

// ---------------------------------------------------------------------------
// Smash / unsmash

/**
 * Smash a gate or element: give its name/value (and attribute) placeholders their own
 * positioned texts, where they are drawn now, so they can be moved independently.
 */
export function smash(docs: Docs, target: Instance | Element, tx: Transaction): boolean {
  if (target.smashed) return false;
  const placeholders = placeholderTexts(docs, target);
  if (!placeholders) return false;
  const { texts, T, mirrored } = placeholders;
  const have = new Set(target.attributes.map((a) => a.name.toUpperCase()));
  for (const t of texts) {
    const name = t.text.slice(1).trim().toUpperCase();
    if (have.has(name)) continue;
    have.add(name);
    const p = apply(T, t.x, t.y);
    const rot = composeRotation(T, t.rot);
    const layer = mirrored ? mirrorLayer(t.layer) : t.layer;
    const attr: PlacedAttribute = {
      name, value: undefined, x: p.x, y: p.y, size: t.size, layer, rot, ratio: t.ratio,
      align: t.align, display: 'value',
    };
    const attrs: Record<string, string> = {
      name, x: fmtCoord(p.x), y: fmtCoord(p.y), size: fmtCoord(t.size), layer: String(layer),
    };
    if (t.ratio !== 8) attrs.ratio = String(t.ratio);
    const r = rotAttr(rot);
    if (r) attrs.rot = r;
    if (t.align !== 'bottom-left') attrs.align = t.align;
    tx.run(insertChild(target.attributes, attr, domParent(target), 'attribute', attrs));
  }
  tx.run(setFields(target as { smashed: boolean }, { smashed: true }, { smashed: 'yes' }));
  return true;
}

/** Unsmash: drop the positioned name/value texts so the part's own placeholders show again. */
export function unsmash(target: Instance | Element, tx: Transaction): boolean {
  if (!target.smashed) return false;
  // Positioned attributes without a value of their own are just label placements.
  for (const a of target.attributes.filter((x) => x.value === undefined && x.x !== undefined)) {
    tx.run(removeItem(target.attributes, a));
  }
  tx.run(setFields(target as { smashed: boolean }, { smashed: false }, { smashed: null }));
  return true;
}

function domParent(obj: object): globalThis.Element {
  const el = domOf(obj);
  if (!el) throw new Error('Object is not linked to the document');
  return el;
}

/** Placeholder texts (">NAME", ">VALUE", attributes) of a gate's symbol or element's package. */
function placeholderTexts(docs: Docs, target: Instance | Element): { texts: Text[]; T: Transform; mirrored: boolean } | undefined {
  const isText = (g: { kind: string }): g is Text => g.kind === 'text';
  if ('gate' in target) {
    const sch = docs.sch;
    const part = sch?.parts.get(target.part);
    const lib = part && findLibrary(sch!.libraries, part.library, part.libraryUrn);
    const gate = lib?.devicesets.get(part!.deviceset)?.gates.find((g) => g.name === target.gate);
    const symbol = gate && lib?.symbols.get(gate.symbol);
    if (!symbol) return undefined;
    const texts = symbol.graphics.filter(isText).filter((t) => t.text.startsWith('>'));
    return { texts, T: placement(target.x, target.y, target.rot), mirrored: false };
  }
  const brd = docs.brd;
  const pkg = brd && findLibrary(brd.libraries, target.library, target.libraryUrn)?.packages.get(target.package);
  if (!pkg) return undefined;
  const texts = pkg.graphics.filter(isText).filter((t) => t.text.startsWith('>'));
  return { texts, T: placement(target.x, target.y, target.rot), mirrored: target.rot.mirror };
}
