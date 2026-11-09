// Facts derived from a project rather than stored in it (docs/format.md, "Nets"):
// which board pads each net connects, including Eagle's implicit power connections.

import { generatedValue } from '../eagle/parse';
import type { Component, Net, Part, Project, Symbol, Variant } from './types';

/** Lookup tables for a project's library and parts. */
export class ProjectIndex {
  readonly components = new Map<string, Component>();
  readonly symbols = new Map<string, Symbol>();
  readonly parts = new Map<string, Part>();

  constructor(readonly project: Project) {
    for (const c of project.library.components) this.components.set(c.id, c);
    for (const s of project.library.symbols) this.symbols.set(s.id, s);
    for (const p of project.parts) this.parts.set(p.name, p);
  }

  variantOf(part: Part): Variant | undefined {
    return this.components.get(part.component)?.variants.find((v) => v.name === part.variant);
  }

  /** The part's value as shown: its own, or generated from the component (e.g. 74LS151D). */
  valueOf(part: Part): string {
    if (part.value !== undefined) return part.value;
    const c = this.components.get(part.component);
    return c && !c.userValue ? generatedValue(componentName(c.id), part.variant, part.technology ?? '') : '';
  }
}

/** "library/name" → "name" */
export function componentName(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}

const key = (part: string, pad: string) => `${part}\u0000${pad}`;

/**
 * Board pads of every net ("part\0pad"), from the pins its schematic segments touch, the
 * explicit pads of board-only nets, and implicit power pins: supply pins wired nowhere join
 * the net named after the pin.
 */
export function netPads(project: Project, index = new ProjectIndex(project)): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const setFor = (name: string) => {
    let s = out.get(name);
    if (!s) out.set(name, (s = new Set()));
    return s;
  };
  const wired = new Set<string>();
  for (const net of project.nets) {
    const set = setFor(net.name);
    for (const seg of net.segments ?? []) {
      for (const pr of seg.pins) {
        wired.add(`${pr.part}\u0000${pr.gate}\u0000${pr.pin}`);
        const part = index.parts.get(pr.part);
        const variant = part && index.variantOf(part);
        if (!variant?.footprint) continue;
        for (const pad of variant.pads[`${pr.gate}.${pr.pin}`] ?? []) set.add(key(pr.part, pad));
      }
    }
    for (const p of net.pads ?? []) set.add(key(p.part, p.pad));
  }
  if (project.schematic) {
    for (const part of project.parts) {
      const variant = index.variantOf(part);
      const component = index.components.get(part.component);
      if (!variant?.footprint || !component) continue;
      for (const gate of component.gates) {
        for (const pin of index.symbols.get(gate.symbol)?.pins ?? []) {
          if (pin.direction !== 'power' || wired.has(`${part.name}\u0000${gate.name}\u0000${pin.name}`)) continue;
          const set = setFor(pin.name.replace(/@.*$/, ''));
          for (const pad of variant.pads[`${gate.name}.${pin.name}`] ?? []) set.add(key(part.name, pad));
        }
      }
    }
  }
  return out;
}

export function netByName(project: Project, name: string): Net | undefined {
  return project.nets.find((n) => n.name === name);
}
