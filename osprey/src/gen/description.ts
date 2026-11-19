// Block descriptions: a circuit as blocks of parts and the nets between their pins, in a short
// text an agent writes from a person's words and the person can read. Parsed here, then
// resolved against libraries and checked; layout.ts draws the schematic from it.
//
//   # comments run to the end of a line
//   design wwvbfind2                  optional; the project's name
//   use ../lib/other.osprey           more libraries (.ospreylib, .osprey projects' libraries)
//   supply GND supply2/GND            a supply net and the symbol drawn at each of its pins
//   block Preamp/Input                the parts and nets after it are in this block (a path)
//   R1 madhu/RESISTOR 1.0M 0805-RES   a part: name, component, then a value, a variant
//                                     (package) and key=value attributes, in any order
//   net N1: IN.2 R1.2 Q1.G            a net (named, or "net:" for an unnamed one); pins are
//                                     part.pin, or part.gate.pin when the part has gates
//   GND: R1.1 IN.1                    pins on a supply net
//   nc: U1.PA2                        pins left unconnected on purpose
//
// A net named in two blocks connects them. Nets of the same name are one net.

import type * as O from '../model/types';

export interface Problem {
  severity: 'error' | 'warning';
  kind: string;
  message: string;
  /** Line in the description (1-based). */
  line?: number;
}

export interface DPart {
  name: string;
  component: string;
  value?: string;
  variant?: string;
  attributes: Record<string, string>;
  /** Words after the component without "=": sorted into value and variant once it is known. */
  bare?: string[];
  block: string;
  line: number;
}

export interface DNet {
  /** Absent: an unnamed net, local to this line. */
  name?: string;
  supply: boolean;
  pins: { ref: string; line: number }[];
  block: string;
  line: number;
}

export interface Description {
  name?: string;
  uses: { path: string; line: number }[];
  supplies: { net: string; component: string; line: number }[];
  blocks: string[];
  parts: DPart[];
  nets: DNet[];
  nc: { ref: string; line: number }[];
}

export function parseDescription(text: string): { description: Description; problems: Problem[] } {
  const d: Description = { uses: [], supplies: [], blocks: [], parts: [], nets: [], nc: [] };
  const problems: Problem[] = [];
  const err = (line: number, message: string) => problems.push({ severity: 'error', kind: 'syntax', message, line });
  let block = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/#.*$/, '').trim();
    if (!s) return;
    const colon = /^([^\s:]+)?(?:\s+([^\s:]+))?\s*:(.*)$/.exec(s);
    const words = s.split(/\s+/);
    const kw = words[0]!;
    if (kw === 'design') {
      d.name = words.slice(1).join(' ');
    } else if (kw === 'use') {
      if (!words[1]) err(line, 'use needs a file');
      else d.uses.push({ path: words.slice(1).join(' '), line });
    } else if (kw === 'supply') {
      if (words.length !== 3) err(line, 'supply needs a net and a component: supply GND supply2/GND');
      else d.supplies.push({ net: words[1]!, component: words[2]!, line });
    } else if (kw === 'block') {
      block = words.slice(1).join(' ').split('/').map((x) => x.trim()).filter(Boolean).join('/');
      if (!block) err(line, 'block needs a name');
      else if (!d.blocks.includes(block)) d.blocks.push(block);
    } else if (colon) {
      const [, first, second, rest] = colon;
      const pins = rest!.trim().split(/\s+/).filter(Boolean).map((ref) => ({ ref, line }));
      if (first === 'nc' && !second) d.nc.push(...pins);
      else if (first === 'net' || (first === undefined && !second)) {
        d.nets.push({ ...(second ? { name: second } : {}), supply: false, pins, block, line });
      } else if (first && !second) {
        // "GND: …": a supply's pins (checked against the supply lines once all are read).
        d.nets.push({ name: first, supply: true, pins, block, line });
      } else err(line, `Not understood: "${s}" (a net is "net NAME: pins")`);
    } else if (words.length >= 2) {
      if (!block) err(line, `Part ${kw} comes before any block`);
      const part: DPart = { name: kw, component: words[1]!, attributes: {}, block, line };
      for (const w of words.slice(2)) {
        const eq = w.indexOf('=');
        if (eq > 0) {
          const key = w.slice(0, eq);
          const v = w.slice(eq + 1);
          if (key === 'value') part.value = v;
          else if (key === 'variant' || key === 'package') part.variant = v;
          else part.attributes[key.toUpperCase() === 'LCSC' ? 'LCSC' : key] = v;
        } else (part.bare ??= []).push(w);
      }
      d.parts.push(part);
    } else err(line, `Not understood: "${s}"`);
  });
  for (const n of d.nets) {
    if (n.supply && !d.supplies.some((x) => x.net === n.name)) {
      problems.push({ severity: 'error', kind: 'syntax', message: `${n.name}: is not a supply (declare it: supply ${n.name} <component>), or write "net ${n.name}: …"`, line: n.line });
    }
  }
  return { description: d, problems };
}

// ---------------------------------------------------------------------------
// Resolving: components from libraries, pins, and the checks before drawing.

export interface Source {
  /** For messages: the file it came from. */
  name: string;
  library: O.Library;
}

export interface RPart {
  part: O.Part;
  component: O.Component;
  source: O.Library;
  block: string;
  line: number;
}

export interface RNet {
  name: string;
  supply: boolean;
  /** Given a name in the description (not N$…). */
  named: boolean;
  pins: O.PinRef[];
  /** The blocks it has pins in. */
  blocks: Set<string>;
}

export interface Resolved {
  name: string;
  blocks: string[];
  parts: RPart[];
  nets: RNet[];
  supplies: Map<string, { component: O.Component; source: O.Library }>;
}

const key = (r: O.PinRef) => `${r.part}.${r.gate}.${r.pin}`;

/** Find a component by id ("madhu/RESISTOR") or by name ("RESISTOR") when only one library has it. */
function findComponent(sources: Source[], id: string): { component: O.Component; source: O.Library } | string {
  for (const s of sources) {
    const c = s.library.components.find((x) => x.id === id);
    if (c) return { component: c, source: s.library };
  }
  const byName = sources.flatMap((s) => s.library.components.filter((x) => x.id.split('/').pop() === id).map((component) => ({ component, source: s.library })));
  const ids = [...new Set(byName.map((x) => x.component.id))];
  if (ids.length === 1) return byName[0]!;
  if (ids.length > 1) return `${id} is in several libraries: ${ids.join(', ')}; give the full id`;
  return `No component ${id} in the libraries (${sources.map((s) => s.name).join(', ') || 'none'})`;
}

function symbolOf(source: O.Library, gate: O.Gate): O.Symbol | undefined {
  return source.symbols.find((s) => s.id === gate.symbol);
}

const isSupplyDirection = (d: O.PinDirection | undefined) => d === 'power' || d === 'supply';

/** Check a description against libraries; the resolved design, if there are no errors. */
export function resolveDescription(d: Description, sources: Source[], fallbackName = 'untitled'): { resolved?: Resolved; problems: Problem[] } {
  const problems: Problem[] = [];
  const error = (kind: string, message: string, line?: number) => problems.push({ severity: 'error', kind, message, ...(line ? { line } : {}) });
  const warn = (kind: string, message: string, line?: number) => problems.push({ severity: 'warning', kind, message, ...(line ? { line } : {}) });

  const supplies = new Map<string, { component: O.Component; source: O.Library }>();
  for (const s of d.supplies) {
    const found = findComponent(sources, s.component);
    if (typeof found === 'string') error('component', found, s.line);
    else {
      const pins = found.component.gates.flatMap((g) => symbolOf(found.source, g)?.pins ?? []);
      if (found.component.gates.length !== 1 || pins.length !== 1) error('supply', `${s.component} isn't a supply symbol (one gate with one pin)`, s.line);
      else supplies.set(s.net, found);
    }
  }

  const parts: RPart[] = [];
  const seen = new Map<string, number>();
  for (const p of d.parts) {
    if (seen.has(p.name)) {
      error('duplicate', `Part ${p.name} is defined twice (lines ${seen.get(p.name)} and ${p.line})`, p.line);
      continue;
    }
    seen.set(p.name, p.line);
    const found = findComponent(sources, p.component);
    if (typeof found === 'string') {
      error('component', `${p.name}: ${found}`, p.line);
      continue;
    }
    const variants = found.component.variants.map((v) => v.name);
    let variant = p.variant;
    let value = p.value;
    for (const w of p.bare ?? []) {
      if (variant === undefined && variants.includes(w)) variant = w;
      else if (value === undefined) value = w;
      else error('syntax', `${p.name}: "${w}" is neither a variant of ${found.component.id} (${variants.join(', ')}) nor needed as its value`, p.line);
    }
    if (variant === undefined) {
      if (variants.length === 1) variant = variants[0]!;
      else {
        error('variant', `${p.name} (${found.component.id}): choose a package: ${variants.map((v) => v || '""').join(', ')}`, p.line);
        continue;
      }
    } else if (!variants.includes(variant)) {
      error('variant', `${p.name}: ${found.component.id} has no variant ${variant} (${variants.join(', ')})`, p.line);
      continue;
    }
    const part: O.Part = { name: p.name, component: found.component.id, variant };
    if (value !== undefined) part.value = value;
    const attributes = { ...(p.block ? { BLOCK: p.block } : {}), ...p.attributes };
    if (Object.keys(attributes).length) part.attributes = attributes;
    parts.push({ part, component: found.component, source: found.source, block: p.block, line: p.line });
  }
  const byName = new Map(parts.map((p) => [p.part.name, p]));

  /** "R1.2", "U2.A.I", "U1.PA3" → a pin, or why not. */
  const pinRef = (ref: string): O.PinRef | string => {
    const dot = ref.indexOf('.');
    if (dot < 0) return `${ref}: a pin is part.pin or part.gate.pin`;
    const p = byName.get(ref.slice(0, dot));
    if (!p) return `${ref}: no part ${ref.slice(0, dot)}${seen.has(ref.slice(0, dot)) ? ' (it has errors)' : ''}`;
    const rest = ref.slice(dot + 1);
    const candidates: { gate: string; pin: O.Pin }[] = [];
    for (const g of p.component.gates) {
      const pins = symbolOf(p.source, g)?.pins ?? [];
      const prefix = rest.startsWith(`${g.name}.`) ? rest.slice(g.name.length + 1) : undefined;
      for (const pin of pins) {
        const names = [pin.name, pin.name.split('/')[0]!];
        if (prefix !== undefined && names.includes(prefix)) candidates.push({ gate: g.name, pin });
        else if (prefix === undefined && names.includes(rest)) candidates.push({ gate: g.name, pin });
      }
    }
    // An exact name beats the part before a "/" (PA3 for PA3/EXTCLK).
    const exact = candidates.filter((c) => c.pin.name === rest || `${c.gate}.${c.pin.name}` === rest);
    const pick = exact.length ? exact : candidates;
    if (pick.length === 1) return { part: p.part.name, gate: pick[0]!.gate, pin: pick[0]!.pin.name };
    if (pick.length > 1) return `${ref}: several pins match (${pick.map((c) => `${c.gate}.${c.pin.name}`).join(', ')}); name the gate`;
    const all = p.component.gates.flatMap((g) => (symbolOf(p.source, g)?.pins ?? []).map((x) => (p.component.gates.length > 1 ? `${g.name}.${x.name}` : x.name)));
    return `${ref}: ${p.part.name} (${p.component.id}) has no such pin; its pins are ${all.join(' ')}`;
  };

  const nets = new Map<string, RNet>();
  const used = new Map<string, { net: string; line: number }>();
  let unnamed = 0;
  for (const n of d.nets) {
    const name = n.name ?? `\0${++unnamed}`;
    let net = nets.get(name);
    if (!net) nets.set(name, (net = { name, supply: n.supply || supplies.has(name), named: !!n.name, pins: [], blocks: new Set() }));
    for (const { ref, line } of n.pins) {
      const r = pinRef(ref);
      if (typeof r === 'string') {
        error('pin', r, line);
        continue;
      }
      const k = key(r);
      const before = used.get(k);
      if (before && before.net !== name) {
        error('pin', `${ref} is on two nets (lines ${before.line} and ${line})`, line);
        continue;
      }
      if (before) continue;
      used.set(k, { net: name, line });
      net.pins.push(r);
      net.blocks.add(byName.get(r.part)!.block);
    }
  }
  const nc = new Set<string>();
  for (const { ref, line } of d.nc) {
    const r = pinRef(ref);
    if (typeof r === 'string') error('pin', r, line);
    else if (used.has(key(r))) error('pin', `${ref} is marked nc but is on a net (line ${used.get(key(r))!.line})`, line);
    else nc.add(key(r));
  }

  // Power pins named like a supply (VCC, GND) join it unless the description says otherwise.
  for (const p of parts) {
    for (const g of p.component.gates) {
      for (const pin of symbolOf(p.source, g)?.pins ?? []) {
        const r = { part: p.part.name, gate: g.name, pin: pin.name };
        if (used.has(key(r)) || nc.has(key(r)) || !isSupplyDirection(pin.direction) || !supplies.has(pin.name)) continue;
        let net = nets.get(pin.name);
        if (!net) nets.set(pin.name, (net = { name: pin.name, supply: true, named: true, pins: [], blocks: new Set() }));
        net.pins.push(r);
        net.blocks.add(p.block);
        used.set(key(r), { net: pin.name, line: p.line });
      }
    }
  }

  for (const p of parts) {
    for (const g of p.component.gates) {
      for (const pin of symbolOf(p.source, g)?.pins ?? []) {
        const k = key({ part: p.part.name, gate: g.name, pin: pin.name });
        if (used.has(k) || nc.has(k) || pin.direction === 'nc') continue;
        const ref = p.component.gates.length > 1 ? `${p.part.name}.${g.name}.${pin.name}` : `${p.part.name}.${pin.name}`;
        warn('unconnected', `${ref} isn't connected (list it under nc: if that's intended)`, p.line);
      }
    }
  }
  for (const n of nets.values()) {
    if (!n.supply && n.pins.length === 1) warn('single-pin', `Net ${n.named ? n.name : `with ${n.pins[0]!.part}.${n.pins[0]!.pin}`} has only one pin`);
  }

  if (problems.some((p) => p.severity === 'error')) return { problems };
  // Unnamed nets get Eagle's N$1, N$2… (numbers no named net uses).
  const taken = new Set([...nets.values()].filter((n) => n.named).map((n) => n.name));
  let next = 1;
  for (const n of nets.values()) {
    if (n.named) continue;
    while (taken.has(`N$${next}`)) next++;
    n.name = `N$${next++}`;
  }
  return {
    resolved: { name: d.name || fallbackName, blocks: d.blocks, parts, nets: [...nets.values()].filter((n) => n.pins.length), supplies },
    problems,
  };
}
