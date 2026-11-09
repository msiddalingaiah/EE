// Property edits on the native model: rename parts and nets, change values, smash/unsmash.
// Each part and net is stored once, so a rename updates its references in one place each,
// and schematic and board stay in step by construction. Validation runs first and returns
// a message instead of changing anything when the edit isn't allowed.

import { composeRotation } from '../geom/transform';
import { componentName, ProjectIndex } from '../model/derive';
import { footprintTransform, gateTransform, mirrorLayer, rotation } from '../model/geometry';
import type * as O from '../model/types';
import { apply } from '../geom/transform';
import { dropIfEmpty, insert, remove, set, type Transaction } from './ops';

/** Eagle stores part and net names in upper case and doesn't allow white space in them. */
export function normalizeName(raw: string): string {
  return raw.trim().toUpperCase();
}

function nameProblem(name: string, what: string): string | undefined {
  if (!name) return `A ${what} name can't be empty`;
  if (/\s/.test(name)) return `A ${what} name can't contain spaces`;
  return undefined;
}

/** Rename a part and every reference to it. Returns an error message, or undefined. */
export function renamePart(project: O.Project, oldName: string, raw: string, tx: Transaction): string | undefined {
  const name = normalizeName(raw);
  const problem = nameProblem(name, 'part');
  if (problem) return problem;
  if (name === oldName) return undefined;
  if (project.parts.some((p) => p.name === name)) return `There is already a part named ${name}`;
  const part = project.parts.find((p) => p.name === oldName);
  if (!part) return `No part named ${oldName}`;

  tx.run(set(part, { name }));
  for (const sheet of project.schematic?.sheets ?? []) {
    for (const g of sheet.gates) if (g.part === oldName) tx.run(set(g, { part: name }));
  }
  for (const f of project.board?.footprints ?? []) if (f.part === oldName) tx.run(set(f, { part: name }));
  for (const net of project.nets) {
    for (const seg of net.segments ?? []) for (const pr of seg.pins) if (pr.part === oldName) tx.run(set(pr, { part: name }));
    for (const pad of net.pads ?? []) if (pad.part === oldName) tx.run(set(pad, { part: name }));
  }
  return undefined;
}

/** Set a part's value. Parts whose component fixes the value (e.g. 74*151 → 74LS151D) refuse, as in Eagle. */
export function setPartValue(project: O.Project, partName: string, value: string, tx: Transaction, index = new ProjectIndex(project)): string | undefined {
  const part = index.parts.get(partName);
  if (!part) return `No part named ${partName}`;
  const component = index.components.get(part.component);
  const fixed = component && !component.userValue && component.gates.length > 0;
  if (fixed) return `${partName}'s value is fixed by its component (${componentName(component.id)}); change the variant instead`;
  if (part.value !== value) tx.run(set(part, { value }));
  return undefined;
}

/**
 * Rename a net. Refused when the new name is taken (that would join nets, a connectivity
 * change) or when the net's name comes from a supply symbol or implicit power pins.
 */
export function renameNet(project: O.Project, oldName: string, raw: string, tx: Transaction, index = new ProjectIndex(project)): string | undefined {
  const name = normalizeName(raw);
  const problem = nameProblem(name, 'net');
  if (problem) return problem;
  if (name === oldName) return undefined;
  if (project.nets.some((n) => n.name === name)) return `Net ${name} already exists; joining nets isn't supported yet`;
  const net = project.nets.find((n) => n.name === oldName);
  if (!net) return `No net named ${oldName}`;
  const supply = supplyReason(project, net, index);
  if (supply) return supply;
  tx.run(set(net, { name }));
  return undefined;
}

function pinOf(index: ProjectIndex, partName: string, gateName: string, pinName: string): O.Pin | undefined {
  const component = index.components.get(index.parts.get(partName)?.component ?? '');
  const gate = component?.gates.find((g) => g.name === gateName);
  return gate ? index.symbols.get(gate.symbol)?.pins.find((p) => p.name === pinName) : undefined;
}

/** Why a net's name is fixed by power connections, if it is. */
export function supplyReason(project: O.Project, net: O.Net, index: ProjectIndex): string | undefined {
  for (const seg of net.segments ?? []) {
    for (const pr of seg.pins) {
      if (pinOf(index, pr.part, pr.gate, pr.pin)?.direction === 'supply') {
        return `${net.name} is named by its supply symbol (${pr.part}); it can't be renamed`;
      }
    }
  }
  for (const part of project.parts) {
    for (const gate of index.components.get(part.component)?.gates ?? []) {
      for (const pin of index.symbols.get(gate.symbol)?.pins ?? []) {
        if (pin.direction === 'power' && pin.name.replace(/@.*$/, '') === net.name) {
          return `${net.name} is a supply net (power pins of ${part.name} connect to it by name); it can't be renamed`;
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Smash / unsmash

/**
 * Smash a gate or footprint: give its name/value (and attribute) placeholders their own
 * labels, where they are drawn now, so they can be moved independently.
 */
export function smash(project: O.Project, placement: O.GatePlacement | O.FootprintPlacement, tx: Transaction, index = new ProjectIndex(project)): boolean {
  if (placement.smashed || placement.labels?.length) return false;
  const isGate = 'gate' in placement;
  let texts: O.TextShape[] = [];
  if (isGate) {
    const component = index.components.get(index.parts.get(placement.part)?.component ?? '');
    const gate = component?.gates.find((g) => g.name === (placement as O.GatePlacement).gate);
    texts = (gate ? index.symbols.get(gate.symbol)?.graphics ?? [] : []).filter((g): g is O.TextShape => 'text' in g);
  } else {
    const part = index.parts.get(placement.part);
    const fpId = part && index.variantOf(part)?.footprint;
    texts = (fpId ? index.footprints.get(fpId)?.graphics ?? [] : []).filter((g): g is O.TextShape => 'text' in g);
  }
  texts = texts.filter((t) => t.text.startsWith('>'));
  if (!texts.length) return false;

  const T = isGate ? gateTransform(placement as O.GatePlacement) : footprintTransform(placement as O.FootprintPlacement);
  const bottom = !isGate && (placement as O.FootprintPlacement).side === 'bottom';
  const labels: O.Label[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const attr = t.text.slice(1).trim().toUpperCase();
    if (seen.has(attr)) continue;
    seen.add(attr);
    const p = apply(T, t.at[0], t.at[1]);
    const r = composeRotation(T, rotation(t.rot, t.mirror, t.spin));
    const l: O.Label = {
      attr,
      at: [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6],
      size: t.size,
      layer: bottom ? mirrorLayer(t.layer) : t.layer,
    };
    if (r.angle) l.rot = r.angle;
    if (r.mirror) l.mirror = true;
    if (t.spin) l.spin = true;
    if (t.ratio !== undefined) l.ratio = t.ratio;
    if (t.align) l.align = t.align;
    if (t.font) l.font = t.font;
    labels.push(l);
  }
  if (!placement.labels) tx.run(set(placement, { labels: [] }));
  for (const l of labels) tx.run(insert(placement.labels!, l));
  tx.run(set(placement, { smashed: true }));
  return true;
}

/** Unsmash: drop the placed name/value labels so the part's own placeholders show again. */
export function unsmash(placement: O.GatePlacement | O.FootprintPlacement, tx: Transaction): boolean {
  if (!placement.smashed && !placement.labels?.length) return false;
  // Labels carrying their own value are attribute data, not just placements: keep them.
  for (const l of (placement.labels ?? []).filter((x) => x.value === undefined)) tx.run(remove(placement.labels!, l));
  if (placement.labels) tx.run(dropIfEmpty(placement, 'labels'));
  tx.run(set(placement, { smashed: undefined }));
  return true;
}
