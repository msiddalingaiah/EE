// Subcircuits: blocks drawn once in an ordinary project (the user directory's subcircuits/) and
// copied into designs. A copy is the design's own from then on: nothing links it back, so
// editing the subcircuits project changes no design that used it.
//
// A block is the parts with one BLOCK attribute, their wiring and the supply symbols on it. Its
// ports are its named nets other than supplies (VIN, OUT, RESET …): copying connects each to a
// net of the design by renaming it (a name the design has already joins that net).

import { BLOCK_ATTRIBUTE, blockOf } from '../model/blocks';
import { gateBoxes } from '../gen/score';
import { ProjectIndex } from '../model/derive';
import type * as O from '../model/types';
import type { Target } from '../scene/types';
import { copyTargets, pasteClip } from './clipboard';
import { set, type Transaction } from './ops';
import { renameNet, setPartValue, supplyReason } from './properties';
import { transformTargets, translation } from './transform';

const AUTO = /^N\$\d+$/;
const G = 2.54;
const snap = (v: number) => Math.round(Math.round(v / G) * G * 1e6) / 1e6;

export interface BlockInfo {
  name: string;
  /** Its parts (not the supply symbols), in the project's order. */
  parts: O.Part[];
  /** Named nets other than supplies, sorted. */
  ports: string[];
  /** Supply nets it uses (VCC, GND …), sorted. */
  supplies: string[];
}

/** The segments of a block's wiring: those on a sheet with a pin of one of its parts. */
function blockSegments(project: O.Project, parts: Set<string>): { net: O.Net; segment: O.Segment }[] {
  return project.nets.flatMap((net) => (net.segments ?? []).filter((s) => s.pins.some((r) => parts.has(r.part))).map((segment) => ({ net, segment })));
}

/** The blocks of a subcircuits project (top-level BLOCK paths), with their ports. */
export function subcircuitBlocks(project: O.Project): BlockInfo[] {
  const index = new ProjectIndex(project);
  const names = [...new Set(project.parts.map(blockOf).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const parts = project.parts.filter((p) => blockOf(p) === name);
    const nets = new Set(blockSegments(project, new Set(parts.map((p) => p.name))).map((x) => x.net));
    const ports: string[] = [];
    const supplies: string[] = [];
    for (const n of nets) {
      if (supplyReason(project, n, index)) supplies.push(n.name);
      else if (!AUTO.test(n.name)) ports.push(n.name);
    }
    return { name, parts, ports: ports.sort(), supplies: supplies.sort() };
  });
}

export interface CopyBlockOptions {
  /** Port → the design's net it joins (or the new name it takes). */
  ports?: Record<string, string>;
  /** Part (as named in the subcircuits project) → its value in the copy. */
  values?: Record<string, string>;
  /** Where the block's top-left corner goes; default: right of what the sheet holds. */
  at?: O.Pt;
  /** The copy's block name; default: the block's, numbered if the design has it already (LED2). */
  name?: string;
  sheet?: number;
}

export interface CopyBlockResult {
  block: string;
  /** Part names in the subcircuits project → in the design. */
  parts: Map<string, string>;
  /** Port → the design's net it is now. */
  ports: Map<string, string>;
  /** Library items the design already had in another version (its own are used). */
  notes: string[];
}

/** The extent of a sheet's drawing (symbols with their texts, wires, net labels), of the parts `only` names or of the rest. */
function extent(project: O.Project, sheet: O.Sheet, parts: Set<string>, only: boolean): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const pts: O.Pt[] = [];
  for (const b of gateBoxes(new ProjectIndex(project), sheet)) if (parts.has(b.part) === only) pts.push([b.box.x0, b.box.y0], [b.box.x1, b.box.y1]);
  for (const n of project.nets) {
    for (const s of n.segments ?? []) {
      if (s.sheet !== sheet.id || s.pins.some((r) => parts.has(r.part)) !== only) continue;
      for (const w of s.wires) pts.push(...w.line);
      for (const l of s.labels ?? []) pts.push(l.at, [l.at[0] + (l.rot === 180 ? -1 : 1) * l.size * 0.9 * n.name.length, l.at[1] + l.size]);
    }
  }
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Copy a block of `source` into `project` (one transaction): its parts under free names, its
 * wiring, its supply symbols joining the design's supplies; then its ports renamed as asked and
 * values set. Returns an error message when it can't.
 */
export function copyBlock(project: O.Project, source: O.Project, block: string, opts: CopyBlockOptions, tx: Transaction): CopyBlockResult | string {
  const info = subcircuitBlocks(source).find((b) => b.name.toLowerCase() === block.toLowerCase());
  if (!info) return `No block ${block} (there are: ${subcircuitBlocks(source).map((b) => b.name).join(', ') || 'none'})`;
  for (const p of Object.keys(opts.ports ?? {})) if (!info.ports.includes(p)) return `${info.name} has no port ${p} (its ports: ${info.ports.join(', ') || 'none'})`;
  for (const p of Object.keys(opts.values ?? {})) if (!info.parts.some((x) => x.name === p)) return `${info.name} has no part ${p} (its parts: ${info.parts.map((x) => x.name).join(', ')})`;
  const sheet = project.schematic?.sheets[opts.sheet ?? 0];
  if (!sheet) return 'The design has no schematic sheet';

  // What to copy: the block's gates, its wiring, and the supply symbols on that wiring.
  const own = new Set(info.parts.map((p) => p.name));
  const segs = blockSegments(source, own);
  const onWiring = new Set(segs.flatMap(({ segment }) => segment.pins.map((r) => r.part)));
  const supplyParts = new Set(source.parts.filter((p) => !own.has(p.name) && onWiring.has(p.name) && !blockOf(p)).map((p) => p.name));
  const targets: Target[] = [];
  for (const s of source.schematic?.sheets ?? []) {
    for (const g of s.gates) if (own.has(g.part) || supplyParts.has(g.part)) targets.push({ kind: 'gate', sheet: s, gate: g });
  }
  for (const { net, segment } of segs) {
    for (const wire of segment.wires) targets.push({ kind: 'wire', net, segment, wire });
    for (const junction of segment.junctions ?? []) targets.push({ kind: 'junction', net, segment, junction });
    for (const label of segment.labels ?? []) targets.push({ kind: 'netlabel', net, segment, label });
  }
  const clip = copyTargets(source, targets, G);
  if (!clip) return `${info.name} has nothing to copy`;

  const index = new ProjectIndex(project);
  const pasted = pasteClip(project, clip, sheet, tx);

  // Place it: its top-left corner at `at`, or 7.62 mm right of the sheet's drawing, level with its top.
  const newParts = new Set(pasted.parts);
  const before = extent(project, sheet, newParts, false);
  const mine = extent(project, sheet, newParts, true)!;
  const at: O.Pt = opts.at ?? (before ? [before.x1 + 7.62, before.y1] : [0, 0]);
  transformTargets(project, pasted.targets, translation(snap(at[0] - mine.x0), snap(at[1] - mine.y1)), tx, index);

  // Its block name, free in the design.
  const taken = new Set(project.parts.filter((p) => !pasted.parts.includes(p.name)).map(blockOf).filter(Boolean));
  let name = opts.name ?? info.name;
  if (!opts.name) for (let k = 2; taken.has(name); k++) name = `${info.name}${k}`;
  // Parts: source name → design name.
  const parts = new Map(info.parts.map((p) => [p.name, pasted.renamed.get(p.name) ?? p.name]));
  for (const n of parts.values()) {
    const part = project.parts.find((p) => p.name === n)!;
    if (blockOf(part) !== name) tx.run(set(part, { attributes: { ...part.attributes, [BLOCK_ATTRIBUTE]: name } }));
  }
  for (const [p, value] of Object.entries(opts.values ?? {})) {
    const err = setPartValue(project, parts.get(p)!, value, tx);
    if (err) return err;
  }

  // Ports: pasted under their own name (or a numbered one, when the design had it); then joined or renamed as asked.
  const ports = new Map<string, string>();
  for (const port of info.ports) {
    const now = pasted.renamed.get(port) ?? port;
    const want = opts.ports?.[port];
    if (want && want !== now) {
      const err = renameNet(project, now, want, tx);
      if (err) return `${port}: ${err}`;
      ports.set(port, project.nets.find((n) => n.name.toLowerCase() === want.toLowerCase())?.name ?? want);
    } else ports.set(port, now);
  }
  return { block: name, parts, ports, notes: pasted.libraryNotes };
}
