// LCSC part numbers for chip resistors and ceramic capacitors, from JLCPCB's Basic and preferred
// Extended parts, by value and package. The table isn't built into the app: it is read from the
// user directory's parts/ folder (lcsc-passives.json there, cut down by scripts/build-lcsc.mjs
// from the CSV of https://github.com/CDFER/jlcpcb-parts-database) and set with setLcscParts.
//
// A resistor matches on its resistance; Basic parts come first, then the tightest tolerance,
// then the most in stock. A capacitor matches on its capacitance: C0G/NP0 or X7R first, then X5R,
// then the lowest voltage at least MIN_VOLTS, Basic before Extended, then stock. A dielectric or a
// voltage in the part's value ("10u 50V", "100n X5R") narrows the choice.

import { attribute, mounting } from '../cam/assembly';
import { componentName, ProjectIndex } from './derive';
import type * as O from './types';

export interface LcscPart {
  kind: 'R' | 'C';
  /** Ω or F. */
  value: number;
  lcsc: string;
  package: string;
  /** A Basic part (else a preferred Extended one). */
  basic: boolean;
  stock: number;
  mpn: string;
  tolerance: string;
  power?: string;
  dielectric?: string;
  volts?: number;
}

let PASSIVES: LcscPart[] = [];
let BY_LCSC = new Map<string, LcscPart>();
/** The packages the table covers. */
let PACKAGES = new Set<string>();

/** The user directory's folder for parts tables. */
export const PARTS_FOLDER = 'parts';

/**
 * Use these parts (every table in the user directory's parts/ folder, together); none until
 * set. A part number in more than one table is taken from the first.
 */
export function setLcscParts(parts: readonly LcscPart[]): void {
  BY_LCSC = new Map();
  for (const p of parts) if (!BY_LCSC.has(p.lcsc)) BY_LCSC.set(p.lcsc, p);
  PASSIVES = [...BY_LCSC.values()];
  PACKAGES = new Set(PASSIVES.map((p) => p.package));
}

/** The parts in use (setLcscParts). */
export function lcscParts(): readonly LcscPart[] {
  return PASSIVES;
}

/** A parts table file (a JSON list, as scripts/build-lcsc.mjs writes); entries it can't use are skipped. */
export function readLcscTable(text: string, name = 'parts table'): LcscPart[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${name}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(data)) throw new Error(`${name}: expected a list of parts`);
  return (data as Partial<LcscPart>[])
    .filter((p) => !!p && typeof p === 'object' && (p.kind === 'R' || p.kind === 'C') && typeof p.value === 'number'
      && typeof p.lcsc === 'string' && /^C\d+$/.test(p.lcsc) && typeof p.package === 'string')
    .map((p) => ({ ...p, basic: !!p.basic, stock: Number(p.stock) || 0, mpn: String(p.mpn ?? ''), tolerance: String(p.tolerance ?? '') }) as LcscPart);
}

/** The lowest capacitor voltage chosen when the value doesn't say. */
export const MIN_VOLTS = 25;

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1 };

/** What a part's value asks for: "4.7k", "4k7", "100R", "100n", "4u7 16V", "27p C0G". */
export interface ValueSpec {
  value: number;
  volts?: number;
  dielectric?: string;
}

/** A resistor's or capacitor's value as written on a part, in Ω or F. */
export function parseValue(raw: string, kind: 'R' | 'C'): ValueSpec | undefined {
  const words = raw.trim().split(/\s+/);
  const first = words.shift() ?? '';
  // 4k7, 4u7, 2R2: the unit letter is the decimal point.
  const m = /^(\d+)([pnuµμmkKMGRr])(\d+)(?:Ω|F|ohm)?$/i.exec(first) ?? /^(\d*\.?\d+)\s*([pnuµμmkKMGRr]?)(?:Ω|F|ohm)?$/i.exec(first);
  if (!m) return undefined;
  const num = m.length === 4 && m[3] !== undefined ? Number(`${m[1]}.${m[3]}`) : Number(m[1]);
  let unit = m[2] ?? '';
  // "m" is milli for a resistor (rare) and for a capacitor; "M" mega. "R" is a decimal point only.
  if (kind === 'C' && unit === 'M') unit = 'm';
  const value = num * (unit ? PREFIX[unit] ?? 1 : 1);
  const spec: ValueSpec = { value };
  for (const w of words) {
    const v = /^(\d+(?:\.\d+)?)V$/i.exec(w);
    if (v) spec.volts = Number(v[1]);
    else if (/^(C0G|NP0|X7R|X5R|X7S|X6S|Y5V)$/i.test(w)) spec.dielectric = w.toUpperCase();
  }
  return spec;
}

/** A footprint's chip size (0603, 0805, …) from its or its variant's name. */
export function chipPackage(...names: string[]): string | undefined {
  for (const n of names) {
    const m = /(?:^|[^0-9])(0201|0402|0603|0805|1206|1210)(?![0-9])/.exec(n);
    if (m) return m[1];
  }
  return undefined;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
const tolerance = (t: string) => Number(/([\d.]+)\s*%/.exec(t)?.[1] ?? 100);
const dielectricRank = (d = '') => (/^(C0G|NP0)$/i.test(d) || /^X7R$/i.test(d) ? 0 : /^X5R$/i.test(d) ? 1 : 2);

/** The best part in the table for a value and package, if any. */
export function findPassive(kind: 'R' | 'C', pkg: string, spec: ValueSpec): LcscPart | undefined {
  let c = PASSIVES.filter((p) => p.kind === kind && p.package === pkg && same(p.value, spec.value));
  if (kind === 'R') {
    return c.sort((a, b) => Number(b.basic) - Number(a.basic) || tolerance(a.tolerance) - tolerance(b.tolerance) || b.stock - a.stock)[0];
  }
  if (spec.dielectric) {
    const d = spec.dielectric === 'NP0' ? 'C0G' : spec.dielectric;
    c = c.filter((p) => (p.dielectric === 'NP0' ? 'C0G' : p.dielectric) === d);
  }
  const min = spec.volts ?? MIN_VOLTS;
  if (spec.volts) c = c.filter((p) => (p.volts ?? 0) >= min);
  return c.sort((a, b) =>
    dielectricRank(a.dielectric) - dielectricRank(b.dielectric)
    || Number((b.volts ?? 0) >= min) - Number((a.volts ?? 0) >= min)
    || Number(b.basic) - Number(a.basic)
    || ((a.volts ?? 0) >= min ? (a.volts ?? 0) - (b.volts ?? 0) : (b.volts ?? 0) - (a.volts ?? 0))
    || b.stock - a.stock)[0];
}

/** One part's LCSC status. */
export type LcscStatus =
  /** It has a number (its own, or its component's). */
  | { part: string; lcsc: string; from: 'part' | 'library' }
  /** The table has one for it. */
  | { part: string; match: LcscPart }
  /**
   * Its own number is a table part of another value or package (left from before the value
   * changed, say): the right one (`replacement`), or why there is none (`why`).
   */
  | { part: string; wrong: string; is: LcscPart; replacement?: LcscPart; why?: string }
  /** No number, and why none was found. */
  | { part: string; missing: string }
  /** Left aside: a through-hole part (soldered by hand, like the assembly files leave it). */
  | { part: string; throughHole: true };

/**
 * Every part with a footprint (and not marked DNP): its LCSC number, or the one the table has
 * for it, or why there is none. Through-hole parts are left aside unless `throughHole`, as the
 * assembly files leave them out (a part with SMD pads and through-hole pegs counts as SMD).
 */
export function lcscStatus(project: O.Project, index = new ProjectIndex(project), opts: { throughHole?: boolean } = {}): LcscStatus[] {
  const out: LcscStatus[] = [];
  const parts = [...project.parts].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const part of parts) {
    const variant = index.variantOf(part);
    if (!variant?.footprint) continue;
    if (/^(yes|true|1)$/i.test(part.attributes?.DNP ?? '')) continue;
    const fp = index.footprints.get(variant.footprint);
    if (!opts.throughHole && fp && mounting(fp) === 'THT') {
      out.push({ part: part.name, throughHole: true });
      continue;
    }
    const own = part.attributes?.LCSC;
    if (own) {
      // A number the table knows can be checked against the part's value and package.
      const is = BY_LCSC.get(own);
      const want = is && wanted(part, variant, index);
      if (is && want && 'spec' in want && (is.kind !== want.kind || is.package !== want.pkg || !same(is.value, want.spec.value))) {
        const found = tableLookup(part, variant, index);
        out.push({ part: part.name, wrong: own, is, ...('match' in found ? { replacement: found.match } : { why: found.missing }) });
      } else {
        out.push({ part: part.name, lcsc: own, from: 'part' });
      }
      continue;
    }
    const lib = attribute(index, part, 'LCSC');
    if (lib) {
      out.push({ part: part.name, lcsc: lib, from: 'library' });
      continue;
    }
    out.push({ part: part.name, ...tableLookup(part, variant, index) });
  }
  return out;
}

/** What the table should have for a part: its kind, package and value, or why it can't say. */
function wanted(part: O.Part, variant: O.Variant, index: ProjectIndex): { kind: 'R' | 'C'; pkg: string; spec: ValueSpec } | { missing: string } {
  const component = index.components.get(part.component);
  const kind = component?.prefix === 'R' ? 'R' : component?.prefix === 'C' ? 'C' : undefined;
  const pkg = chipPackage(componentName(variant.footprint ?? ''), variant.name);
  if (!kind) return { missing: `${componentName(part.component)}: not a resistor or capacitor; set its LCSC number` };
  if (!pkg) return { missing: `footprint ${componentName(variant.footprint ?? '')} isn't a chip package (0603, 0805); set its LCSC number` };
  if (!PACKAGES.size) return { missing: `no JLCPCB parts table: put one (lcsc-passives.json) in the user directory's ${PARTS_FOLDER}/ folder` };
  if (!PACKAGES.has(pkg)) return { missing: `${pkg}: the parts table has only ${[...PACKAGES].sort().join(' and ')}` };
  const value = index.valueOf(part);
  const spec = parseValue(value, kind);
  if (!spec) return { missing: `can't read the value "${value}"` };
  return { kind, pkg, spec };
}

/** The table's part for a part, or why there is none. */
function tableLookup(part: O.Part, variant: O.Variant, index: ProjectIndex): { match: LcscPart } | { missing: string } {
  const want = wanted(part, variant, index);
  if ('missing' in want) return want;
  const { kind, pkg, spec } = want;
  const match = findPassive(kind, pkg, spec);
  if (match) return { match };
  // Another package may have it: a variant change away.
  const other = [...PACKAGES].filter((p) => p !== pkg && findPassive(kind, p, spec));
  const value = index.valueOf(part);
  return {
    missing: `no Basic or preferred ${value} ${kind === 'R' ? 'resistor' : 'capacitor'} in ${pkg}${spec.volts ? ` at ${spec.volts} V or more` : ''}${spec.dielectric ? ` in ${spec.dielectric}` : ''}${other.length ? ` (there is one in ${other.join(', ')})` : ''}`,
  };
}

/** A table part in words: "C25804 · 10kΩ ±1% 125mW 0805 · Basic". */
export function describePassive(p: LcscPart): string {
  const v = p.kind === 'R' ? `${fmtValue(p.value)}Ω ${p.tolerance} ${p.power ?? ''}` : `${fmtValue(p.value)}F ${p.volts} V ${p.dielectric ?? ''}`;
  return `${p.lcsc} · ${v.replace(/\s+/g, ' ').trim()} ${p.package} · ${p.basic ? 'Basic' : 'Preferred'}`;
}

function fmtValue(v: number): string {
  for (const [s, f] of [['G', 1e9], ['M', 1e6], ['k', 1e3], ['', 1], ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12]] as const) {
    if (Math.abs(v) >= f * 0.9999) return `${Math.round((v / f) * 1000) / 1000}${s}`;
  }
  return String(v);
}
