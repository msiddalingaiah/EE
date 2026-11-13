// Suggesting blocks from the netlist: which parts belong together, as a first cut for the
// designer to adjust (see blocks.ts).
//
// ICs and transistors anchor blocks; transistors wired straight to each other (a JFET's source
// to a transistor's base, say) share one. Every other part joins the anchor it reaches through
// the fewest, smallest signal nets (a 2-part net is a close tie, a 10-part net a loose one),
// never through another anchor; ties go to the anchor drawn nearest on the schematic. Parts
// wired only to supplies (decoupling caps) join the nearest anchor that takes power from the
// same supply, or a connector that brings it in, which starts a "power" block.
//
// A large new block gets blocks inside: each cluster of its other parts (wired to each other,
// not counting the anchors) hanging off one net the designer named becomes one, named after it
// ("ADC").
//
// Parts already in a block stay there and pull their neighbours in like anchors, so naming one
// part's block ("mcu" for U1) and suggesting again fills it in. Only parts without a block are
// given one.

import { netPads, ProjectIndex } from './derive';
import { blockOf } from './blocks';
import { supplyNets } from './placement';
import type * as O from './types';

/** Active parts, by prefix: ICs and transistors (Q, T), regulators, relays. */
const IC_PREFIX = /^(U|IC|N|VR|K)$/i;
const TRANSISTOR_PREFIX = /^(Q|T)$/i;
/** Components that are connectors: by prefix, or by name. */
const CONNECTOR_PREFIX = /^(J|P|CN|CON|X?CONN)$/i;
const CONNECTOR_NAME = /BERG|HEADER|PINHD|CONN|JST|MOLEX|USB|TERMINAL|SCREW/i;

interface Node {
  part: string;
  signal: Set<string>;
  supply: Set<string>;
  /** Pads that are power pins, by net. */
  powered: Set<string>;
  anchor: boolean;
  transistor: boolean;
  connector: boolean;
}

/** A suggested block for each part that has none (part name → block path). */
export function suggestBlocks(project: O.Project, index = new ProjectIndex(project)): Map<string, string> {
  const supplies = supplyNets(project, index);
  const nodes = new Map<string, Node>();
  for (const part of project.parts) {
    const variant = index.variantOf(part);
    if (!variant?.footprint) continue;
    const component = index.components.get(part.component);
    const pads = new Set(Object.values(variant.pads).flat());
    const prefix = component?.prefix ?? '';
    const connector = !!component && (CONNECTOR_PREFIX.test(prefix) || CONNECTOR_NAME.test(component.id));
    const transistor = !connector && TRANSISTOR_PREFIX.test(prefix);
    // Without a prefix to go by, a part with four or more pads counts as an IC.
    const ic = !connector && (IC_PREFIX.test(prefix) || (!prefix && pads.size >= 4));
    nodes.set(part.name, {
      part: part.name, signal: new Set(), supply: new Set(), powered: new Set(),
      anchor: ic || transistor, transistor, connector,
    });
  }
  // Nets of each part, and power pins.
  const powerPads = new Set<string>();
  for (const part of project.parts) {
    const variant = index.variantOf(part);
    const component = index.components.get(part.component);
    if (!variant || !component) continue;
    for (const gate of component.gates) {
      for (const pin of index.symbols.get(gate.symbol)?.pins ?? []) {
        if (pin.direction !== 'power') continue;
        for (const pad of variant.pads[`${gate.name}.${pin.name}`] ?? []) powerPads.add(`${part.name}\u0000${pad}`);
      }
    }
  }
  const netParts = new Map<string, Set<string>>();
  for (const [net, keys] of netPads(project, index)) {
    const parts = new Set<string>();
    for (const k of keys) {
      const part = k.slice(0, k.indexOf('\u0000'));
      const n = nodes.get(part);
      if (!n) continue;
      parts.add(part);
      if (supplies.has(net)) {
        n.supply.add(net);
        if (powerPads.has(k)) n.powered.add(net);
      } else n.signal.add(net);
    }
    if (!supplies.has(net)) netParts.set(net, parts);
  }

  // Where parts are drawn: for ties, the nearest wins.
  const drawn = new Map<string, { sheet: number; x: number; y: number }[]>();
  project.schematic?.sheets.forEach((sheet, i) => {
    for (const g of sheet.gates) (drawn.get(g.part) ?? drawn.set(g.part, []).get(g.part)!).push({ sheet: i, x: g.at[0], y: g.at[1] });
  });
  const apart = (a: string, b: string): number => {
    let d = 1e6;
    for (const p of drawn.get(a) ?? []) for (const q of drawn.get(b) ?? []) if (p.sheet === q.sheet) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    return d;
  };

  // Anchors, transistors wired to each other merged.
  const group = new Map<string, string>(); // anchor part → representative
  const find = (p: string): string => {
    const r = group.get(p)!;
    if (r === p) return p;
    const root = find(r);
    group.set(p, root);
    return root;
  };
  for (const n of nodes.values()) if (n.anchor) group.set(n.part, n.part);
  for (const parts of netParts.values()) {
    const ts = [...parts].filter((p) => nodes.get(p)!.transistor);
    for (let i = 1; i < ts.length; i++) group.set(find(ts[i]!), find(ts[0]!));
  }

  // The label each source gives its block: a part's own block, else its anchor group's (a block
  // one of them is in already, or their names: "U1", "Q1-Q2").
  const parts = new Map(project.parts.map((p) => [p.name, p]));
  const labelOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const a of group.keys()) (members.get(find(a)) ?? members.set(find(a), []).get(find(a))!).push(a);
  for (const list of members.values()) {
    list.sort(byName);
    const named = list.map((p) => blockOf(parts.get(p)!)).find(Boolean);
    const label = named ?? list.join('-');
    for (const p of list) labelOf.set(p, label);
  }
  for (const n of nodes.values()) {
    const b = blockOf(parts.get(n.part)!);
    if (b) labelOf.set(n.part, b);
  }

  // Signal parts: the nearest source, through signal nets.
  type Best = { cost: number; dist: number; label: string };
  const best = new Map<string, Best>();
  const better = (a: Best, b: Best | undefined) => !b || a.cost < b.cost - 1e-9 || (Math.abs(a.cost - b.cost) <= 1e-9 && a.dist < b.dist);
  const queue: { part: string; source: string; b: Best }[] = [];
  for (const [part, label] of labelOf) {
    const b = { cost: 0, dist: 0, label };
    best.set(part, b);
    queue.push({ part, source: part, b });
  }
  while (queue.length) {
    queue.sort((x, y) => x.b.cost - y.b.cost || x.b.dist - y.b.dist);
    const { part, source, b } = queue.shift()!;
    if (best.get(part) !== b) continue;
    // Sources expand; other anchors and connectors don't pass anything on.
    const n = nodes.get(part)!;
    if (part !== source && (n.anchor || n.connector)) continue;
    for (const net of n.signal) {
      const on = netParts.get(net)!;
      for (const other of on) {
        if (other === part || labelOf.has(other)) continue;
        const c = { cost: b.cost + on.size - 1, dist: apart(other, source), label: b.label };
        if (better(c, best.get(other))) {
          best.set(other, c);
          queue.push({ part: other, source, b: c });
        }
      }
    }
  }

  // Supply-only parts: the nearest part that takes power from (or brings in) the same supply.
  const out = new Map<string, string>();
  for (const n of nodes.values()) {
    if (blockOf(parts.get(n.part)!)) continue;
    const b = best.get(n.part);
    if (b && n.signal.size) {
      out.set(n.part, b.label);
      continue;
    }
    if (n.signal.size) continue; // signal parts no anchor reaches stay as they are
    if (n.connector) {
      out.set(n.part, POWER);
      continue;
    }
    let pick: { label: string; dist: number } | undefined;
    for (const m of nodes.values()) {
      if (m === n || ![...n.supply].some((s) => m.powered.has(s) || (m.connector && !m.signal.size && m.supply.has(s)))) continue;
      const label = m.connector && !m.signal.size ? blockOf(parts.get(m.part)!) ?? POWER : labelOf.get(m.part) ?? best.get(m.part)?.label;
      if (!label) continue;
      const dist = apart(n.part, m.part);
      if (!pick || dist < pick.dist) pick = { label, dist };
    }
    if (pick) out.set(n.part, pick.label);
  }

  // Large new blocks get blocks inside: the clusters of parts hanging off their anchors.
  const byLabel = new Map<string, string[]>();
  for (const [part, label] of out) (byLabel.get(label) ?? byLabel.set(label, []).get(label)!).push(part);
  for (const [label, list] of byLabel) {
    const anchors = [...group.keys()].filter((a) => labelOf.get(a) === label);
    // Only blocks made here, not ones the designer named.
    if (!anchors.length || anchors.some((a) => blockOf(parts.get(a)!)) || list.length < SPLIT_SIZE) continue;
    const rest = list.filter((p) => !nodes.get(p)!.anchor && nodes.get(p)!.signal.size);
    const root = new Map(rest.map((p) => [p, p]));
    const top = (p: string): string => (root.get(p) === p ? p : top(root.get(p)!));
    for (const a of rest) {
      for (const b of rest) {
        if (a < b && [...nodes.get(a)!.signal].some((net) => nodes.get(b)!.signal.has(net))) root.set(top(a), top(b));
      }
    }
    const clusters = new Map<string, string[]>();
    for (const p of rest) (clusters.get(top(p)) ?? clusters.set(top(p), []).get(top(p))!).push(p);
    const anchorNets = new Set(anchors.flatMap((a) => [...nodes.get(a)!.signal]));
    const used = new Set<string>();
    for (const cluster of [...clusters.values()].filter((c) => c.length >= 2)) {
      cluster.sort(byName);
      const via = [...new Set(cluster.flatMap((p) => [...nodes.get(p)!.signal].filter((n) => anchorNets.has(n))))];
      // Only clusters hanging off one net the designer named (ADC, AUDIO): that name says what
      // they are. Others stay in the block.
      if (via.length !== 1 || AUTO_NET.test(via[0]!)) continue;
      let name = via[0]!.replaceAll('/', '-');
      const base = name;
      for (let k = 2; used.has(name); k++) name = `${base} ${k}`;
      used.add(name);
      for (const p of cluster) out.set(p, `${label}/${name}`);
    }
  }
  return out;
}

/** Blocks this big or bigger get blocks inside them. */
const SPLIT_SIZE = 8;
/** Net names made up by the tool (N$3), not given by the designer. */
const AUTO_NET = /^N\$\d+$/;

const POWER = 'power';

/** R2 before R10. */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
