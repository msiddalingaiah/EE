// A project's design as the schematic generator takes it (a resolved description): for comparing
// a generated sheet with the project's own drawing (test/bench-schematic.test.ts).

import type { Resolved, RNet, RPart } from '../src/gen/description';
import { ProjectIndex } from '../src/model/derive';
import type * as O from '../src/model/types';

/** The design as the generator takes it: parts with their blocks, nets, and supply symbols by net. */
export function resolvedOf(p: O.Project): Resolved {
  const index = new ProjectIndex(p);
  const pinsOf = (c: O.Component) => c.gates.flatMap((g) => index.symbols.get(g.symbol)?.pins ?? []);
  const supplyPart = new Set<string>();
  const supplies: Resolved['supplies'] = new Map();
  for (const part of p.parts) {
    const c = index.components.get(part.component);
    if (!c) continue;
    const pins = pinsOf(c);
    if (pins.length === 1 && pins[0]!.direction === 'supply') supplyPart.add(part.name);
  }
  const parts: RPart[] = [];
  for (const part of p.parts) {
    const c = index.components.get(part.component);
    if (!c || supplyPart.has(part.name) || !pinsOf(c).length) continue;
    parts.push({ part: structuredClone(part), component: c, source: p.library, block: part.attributes?.BLOCK ?? '', line: 0 });
  }
  const placed = new Set(parts.map((x) => x.part.name));
  const blockOf = new Map(parts.map((x) => [x.part.name, x.block]));
  const nets: RNet[] = [];
  for (const n of p.nets) {
    const all = (n.segments ?? []).flatMap((s) => s.pins);
    const symbol = all.find((r) => supplyPart.has(r.part));
    if (symbol) {
      const c = index.components.get(index.parts.get(symbol.part)!.component)!;
      if (!supplies.has(n.name)) supplies.set(n.name, { component: c, source: p.library });
    }
    const seen = new Set<string>();
    const pins = all.filter((r) => placed.has(r.part) && !seen.has(`${r.part}.${r.gate}.${r.pin}`) && seen.add(`${r.part}.${r.gate}.${r.pin}`));
    if (!pins.length) continue;
    nets.push({ name: n.name, supply: !!symbol, named: !/^N\$\d+$/.test(n.name), pins, blocks: new Set(pins.map((r) => blockOf.get(r.part)!)) });
  }
  return { name: p.project.name, blocks: [...new Set(parts.map((x) => x.block))].sort(), parts, nets, supplies };
}
