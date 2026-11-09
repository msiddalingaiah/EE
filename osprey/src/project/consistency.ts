// Schematic/board consistency: the same check Eagle relies on before it will keep a
// schematic and board in sync (parts ↔ elements, values, packages, and net membership).

import { findLibrary, generatedValue } from '../eagle/parse';
import type { Board, DeviceSet, Library, Part, Schematic } from '../eagle/types';

export interface Issue {
  message: string;
}

export interface PartInfo {
  part: Part;
  library: Library | undefined;
  deviceset: DeviceSet | undefined;
  /** Package name of the part's device, or undefined for symbol-only parts (e.g. supply symbols). */
  pkg: string | undefined;
  /** "gate\0pin" → pad names */
  pads: Map<string, string[]>;
}

export function partInfo(sch: Schematic, part: Part): PartInfo {
  const library = findLibrary(sch.libraries, part.library, part.libraryUrn);
  const ds = library?.devicesets.get(part.deviceset);
  const device = ds?.devices.find((d) => d.name === part.device);
  const pads = new Map<string, string[]>();
  for (const c of device?.connects ?? []) pads.set(`${c.gate}\u0000${c.pin}`, c.pads);
  return { part, library, deviceset: ds, pkg: device?.package, pads };
}

/** Value as Eagle shows it: the explicit value, or the generated one for fixed-value parts. */
export function partValue(info: PartInfo): string {
  if (info.part.value !== undefined) return info.part.value;
  return info.deviceset && !info.deviceset.uservalue
    ? generatedValue(info.deviceset.name, info.part.device, info.part.technology)
    : '';
}

/**
 * Board pads each schematic net connects: net name → set of "element\0pad".
 * Includes Eagle's implicit power connections: a supply pin (direction "pwr") that isn't
 * wired anywhere, typically on an unplaced power gate, joins the net named after the pin.
 */
export function schematicNetPads(sch: Schematic): Map<string, Set<string>> {
  const infos = new Map<string, PartInfo>();
  const info = (name: string) => {
    let i = infos.get(name);
    if (!i) {
      const p = sch.parts.get(name);
      if (!p) return undefined;
      infos.set(name, (i = partInfo(sch, p)));
    }
    return i;
  };
  const out = new Map<string, Set<string>>();
  for (const sheet of sch.sheets) {
    for (const net of sheet.nets) {
      let set = out.get(net.name);
      if (!set) out.set(net.name, (set = new Set()));
      for (const seg of net.segments) {
        for (const pr of seg.pinrefs) {
          const i = info(pr.part);
          if (!i?.pkg) continue;
          for (const pad of i.pads.get(`${pr.gate}\u0000${pr.pin}`) ?? []) set.add(`${pr.part}\u0000${pad}`);
        }
      }
    }
  }

  // Implicit power pins.
  const wired = new Set<string>();
  for (const sheet of sch.sheets) {
    for (const net of sheet.nets) {
      for (const seg of net.segments) for (const pr of seg.pinrefs) wired.add(`${pr.part}\u0000${pr.gate}\u0000${pr.pin}`);
    }
  }
  for (const part of sch.parts.values()) {
    const i = info(part.name);
    if (!i?.pkg || !i.deviceset) continue;
    for (const gate of i.deviceset.gates) {
      for (const pin of i.library?.symbols.get(gate.symbol)?.pins ?? []) {
        if (pin.direction !== 'pwr' || wired.has(`${part.name}\u0000${gate.name}\u0000${pin.name}`)) continue;
        const netName = pin.name.replace(/@.*$/, '');
        let set = out.get(netName);
        if (!set) out.set(netName, (set = new Set()));
        for (const pad of i.pads.get(`${gate.name}\u0000${pin.name}`) ?? []) set.add(`${part.name}\u0000${pad}`);
      }
    }
  }
  return out;
}

/** Pads each board signal connects: signal name → set of "element\0pad". */
export function boardSignalPads(brd: Board): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of brd.signals) {
    const set = new Set(s.contactrefs.map((c) => `${c.element}\u0000${c.pad}`));
    out.set(s.name, set);
  }
  return out;
}

const MAX_ISSUES = 50;

/** Differences between a schematic and its board. Empty = consistent. */
export function checkConsistency(sch: Schematic, brd: Board): Issue[] {
  const issues: Issue[] = [];
  const add = (message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ message });
  };
  const elements = new Map(brd.elements.map((e) => [e.name, e]));

  for (const part of sch.parts.values()) {
    const info = partInfo(sch, part);
    if (!info.pkg) continue; // symbol-only parts have no footprint
    const el = elements.get(part.name);
    if (!el) {
      add(`Part ${part.name} is missing from the board`);
      continue;
    }
    const value = partValue(info);
    if (el.value !== value) add(`${part.name}: value is "${value}" in the schematic but "${el.value}" on the board`);
    if (el.package !== info.pkg) add(`${part.name}: package is ${info.pkg} in the schematic but ${el.package} on the board`);
  }
  for (const el of brd.elements) {
    const part = sch.parts.get(el.name);
    if (!part) add(`Board element ${el.name} has no schematic part`);
  }

  const schNets = schematicNetPads(sch);
  const brdNets = boardSignalPads(brd);
  const label = (key: string) => key.replace('\u0000', ' pad ');
  for (const [name, pads] of schNets) {
    const b = brdNets.get(name) ?? new Set<string>();
    for (const p of pads) if (!b.has(p)) add(`Net ${name}: ${label(p)} is connected in the schematic but not on the board`);
  }
  for (const [name, pads] of brdNets) {
    const s = schNets.get(name) ?? new Set<string>();
    for (const p of pads) if (!s.has(p)) add(`Net ${name}: ${label(p)} is connected on the board but not in the schematic`);
  }
  return issues;
}
