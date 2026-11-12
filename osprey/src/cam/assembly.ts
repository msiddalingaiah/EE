// Assembly files for a board house (JLCPCB's format): a bill of materials, one row per group of
// identical parts, and a pick-and-place list (JLCPCB calls it CPL), one row per placed part with
// where its centre is, which side it is on, and how it is turned.
//
// The position is the centre of the part's pads, not its footprint's origin: a footprint's
// origin can be anywhere (pin 1 of a connector, say), and the machine needs the part's middle.
// Rotations are the footprint's as placed; a board house's zero orientation for a package can
// differ from the library's (SOT-23 and diodes, often), which their preview shows and fixes.

import { apply } from '../geom/transform';
import { componentName, ProjectIndex } from '../model/derive';
import { footprintTransform } from '../model/geometry';
import type * as O from '../model/types';

/** The part attribute holding an LCSC part number (C25804…), which JLCPCB uses to pick the part. */
export const LCSC_ATTRIBUTE = 'LCSC';

export interface AssemblyResult {
  /** File name → contents. */
  files: Map<string, string>;
  warnings: string[];
}

/** A text field of a CSV row, quoted when it has to be. */
const field = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (vs: string[]) => vs.map(field).join(',');
const mm = (n: number) => `${(Math.round(n * 1e4) / 1e4).toFixed(4)}mm`;
/** R2 before R10. */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** A part attribute: the part's own, else its component technology's (Eagle's MF, MPN…). */
function attribute(index: ProjectIndex, part: O.Part, name: string): string {
  const own = part.attributes?.[name];
  if (own) return own;
  const tech = index.variantOf(part)?.technologies?.[part.technology ?? ''];
  const v = tech?.[name];
  return typeof v === 'string' ? v : v?.value ?? '';
}

/** How a footprint is mounted: by its pads. */
function mounting(fp: O.Footprint): 'SMD' | 'THT' | 'SMD+THT' {
  const smd = fp.pads.some((p) => p.smd);
  const tht = fp.pads.some((p) => !p.smd);
  return smd && tht ? 'SMD+THT' : tht ? 'THT' : 'SMD';
}

/** A part marked not to be placed by the assembler (its DNP attribute: yes, true or 1). */
export function doNotPlace(part: O.Part): boolean {
  return /^(yes|true|1)$/i.test(part.attributes?.DNP ?? '');
}

export interface AssemblyOptions {
  /**
   * Include through-hole parts. Off by default: a board house's standard assembly places SMD
   * parts, and through-hole ones (headers, connectors) are usually soldered by hand. A part
   * with SMD pads and some through-hole ones (pegs) counts as SMD.
   */
  throughHole?: boolean;
}

export function assemblyFiles(project: O.Project, options: AssemblyOptions = {}, index = new ProjectIndex(project)): AssemblyResult {
  const warnings: string[] = [];
  const board = project.board;
  const files = new Map<string, string>();
  if (!board) return { files, warnings: ['The project has no board'] };

  // The parts to assemble: those placed on the board with a footprint that has pads, unless
  // marked not to place, or through-hole when those are left for hand soldering.
  const placed: { part: O.Part; f: O.FootprintPlacement; fp: O.Footprint }[] = [];
  const leftOut = { tht: [] as string[], dnp: [] as string[] };
  for (const f of board.footprints) {
    const part = index.parts.get(f.part);
    const fpId = part && index.variantOf(part)?.footprint;
    const fp = fpId ? index.footprints.get(fpId) : undefined;
    if (!part || !fp?.pads.length) continue;
    if (doNotPlace(part)) leftOut.dnp.push(part.name);
    else if (!options.throughHole && mounting(fp) === 'THT') leftOut.tht.push(part.name);
    else placed.push({ part, f, fp });
  }
  placed.sort((a, b) => natural(a.part.name, b.part.name));
  const list = (names: string[]) => names.sort(natural).join(', ');
  const notPlaced = [
    leftOut.tht.length ? `${leftOut.tht.length} through-hole part${leftOut.tht.length > 1 ? 's' : ''} (${list(leftOut.tht)})` : '',
    leftOut.dnp.length ? `${leftOut.dnp.length} marked do-not-place (${list(leftOut.dnp)})` : '',
  ].filter(Boolean);
  if (notPlaced.length) warnings.push(`Not placed: ${notPlaced.join(' and ')}; solder these yourself`);

  // Bill of materials: parts with the same value, footprint and part numbers share a row.
  const groups = new Map<string, { value: string; footprint: string; lcsc: string; mf: string; mpn: string; type: string; names: string[] }>();
  for (const { part, fp } of placed) {
    const g = {
      value: index.valueOf(part), footprint: componentName(fp.id), lcsc: attribute(index, part, LCSC_ATTRIBUTE),
      mf: attribute(index, part, 'MF'), mpn: attribute(index, part, 'MPN'), type: mounting(fp),
    };
    const key = [g.value, g.footprint, g.lcsc, g.mf, g.mpn].join('\u0000');
    const have = groups.get(key);
    if (have) have.names.push(part.name);
    else groups.set(key, { ...g, names: [part.name] });
  }
  const bom = [row(['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity', 'Manufacturer', 'MPN', 'Mounting'])];
  for (const g of [...groups.values()].sort((a, b) => natural(a.names[0]!, b.names[0]!))) {
    bom.push(row([g.value, g.names.join(','), g.footprint, g.lcsc, String(g.names.length), g.mf, g.mpn, g.type]));
  }

  // Pick and place: each part's centre (the middle of its pads), side and rotation.
  const cpl = [row(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])];
  for (const { part, f, fp } of placed) {
    const T = footprintTransform(f);
    const pts = fp.pads.map((p) => apply(T, p.at[0], p.at[1]));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rot = (((f.rot ?? 0) % 360) + 360) % 360;
    cpl.push(row([part.name, mm(x), mm(y), f.side === 'bottom' ? 'Bottom' : 'Top', String(Math.round(rot * 1e4) / 1e4)]));
  }

  const missing = placed.filter(({ part }) => !attribute(index, part, LCSC_ATTRIBUTE)).map(({ part }) => part.name);
  if (missing.length) {
    const named = missing.length > 30 ? `${missing.slice(0, 30).join(', ')} and ${missing.length - 30} more` : missing.join(', ');
    warnings.push(`${missing.length} of ${placed.length} parts have no LCSC part number (JLCPCB matches those by value and footprint, to check by hand): ${named}`);
  }
  if (placed.some(({ f }) => f.side === 'bottom')) warnings.push('Some parts are on the bottom: check their rotations in the board house\'s preview');
  const name = project.project.name;
  files.set(`${name}_BOM.csv`, bom.join('\r\n') + '\r\n');
  files.set(`${name}_CPL.csv`, cpl.join('\r\n') + '\r\n');
  return { files, warnings };
}
