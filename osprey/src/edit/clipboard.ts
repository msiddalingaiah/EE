// Copy and paste of schematic selections. A clip is self-contained JSON: the parts, gates,
// wiring and drawing that were selected, plus the library items the parts use, so it can be
// pasted into another project.
//
// Names stay unique: a part or net keeps its name when the project doesn't use it (so cut and
// paste keeps names); otherwise parts get the next free number for their prefix, automatic nets
// a new N$n, and named nets a suffix (IN → IN_2). Supply nets (GND, VCC) are the exception: a
// pasted supply net joins the existing one, as a copied supply symbol should.

import { ProjectIndex } from '../model/derive';
import { pinPosition } from '../model/geometry';
import type * as O from '../model/types';
import type { Target } from '../scene/types';
import { insert, set, type Transaction } from './ops';
import { addToLibrary, insertPart, nextPartName } from './place';
import { supplyReason } from './properties';
import { nextNetName } from './wire';

export const CLIP_FORMAT = 'osprey-clip';

export interface ClipSegment {
  pins: O.PinRef[];
  wires: O.Wire[];
  junctions?: O.Pt[];
  labels?: O.NetLabel[];
}

export interface ClipNet {
  name: string;
  /** Named by a supply symbol or power pins: pasted wiring joins the net of that name. */
  supply?: true;
  segments: ClipSegment[];
}

export interface Clip {
  format: typeof CLIP_FORMAT;
  version: 1;
  /** The grid point the clip floats by when pasted (the centre of what was copied). */
  origin: O.Pt;
  library: O.Library;
  parts: O.Part[];
  gates: O.GatePlacement[];
  nets: ClipNet[];
  drawing: O.Graphic[];
}

const EPS = 1e-4;
const same = (a: O.Pt, x: number, y: number) => Math.abs(a[0] - x) < EPS && Math.abs(a[1] - y) < EPS;

/**
 * Copy schematic targets to a clip. Pins come along when their gate and a wire reaching them
 * are both copied. Returns undefined when nothing copyable is selected.
 */
export function copyTargets(project: O.Project, targets: Target[], grid: number, index = new ProjectIndex(project)): Clip | undefined {
  const gates = targets.flatMap((t) => (t.kind === 'gate' ? [t.gate] : []));
  const copied = new Set(gates.map((g) => `${g.part}\u0000${g.gate}`));
  const partNames = [...new Set(gates.map((g) => g.part))];
  const parts = project.parts.filter((p) => partNames.includes(p.name));

  // Wiring, grouped by the segment it came from.
  const bySegment = new Map<O.Segment, { net: O.Net; seg: ClipSegment }>();
  const entry = (net: O.Net, segment: O.Segment) => {
    let e = bySegment.get(segment);
    if (!e) bySegment.set(segment, (e = { net, seg: { pins: [], wires: [] } }));
    return e.seg;
  };
  for (const t of targets) {
    if (t.kind === 'wire' && !t.bus) entry(t.net as O.Net, t.segment as O.Segment).wires.push(structuredClone(t.wire));
    else if (t.kind === 'junction') (entry(t.net, t.segment).junctions ??= []).push([...t.junction] as O.Pt);
    else if (t.kind === 'netlabel' && 'pins' in t.segment) (entry(t.net as O.Net, t.segment).labels ??= []).push(structuredClone(t.label));
  }
  const sheetOf = new Map(gates.map((g) => [`${g.part}\u0000${g.gate}`, g]));
  const nets = new Map<O.Net, ClipNet>();
  for (const [segment, { net, seg }] of bySegment) {
    // Junctions and labels only travel with wires they sit on.
    if (!seg.wires.length) continue;
    const onWire = (x: number, y: number) => seg.wires.some((w) => same(w.line[0], x, y) || same(w.line[1], x, y));
    if (seg.junctions) {
      seg.junctions = seg.junctions.filter((j) => onWire(j[0], j[1]));
      if (!seg.junctions.length) delete seg.junctions;
    }
    for (const r of segment.pins) {
      const g = sheetOf.get(`${r.part}\u0000${r.gate}`);
      if (!g || !copied.has(`${r.part}\u0000${r.gate}`)) continue;
      const p = pinPosition(index, g, r.pin);
      if (p && seg.wires.some((w) => same(w.line[0], p.x, p.y) || same(w.line[1], p.x, p.y))) seg.pins.push({ ...r });
    }
    let cn = nets.get(net);
    if (!cn) {
      cn = { name: net.name, segments: [] };
      if (supplyReason(project, net, index)) cn.supply = true;
      nets.set(net, cn);
    }
    cn.segments.push(seg);
  }
  const drawing = targets.flatMap((t) => (t.kind === 'drawing' && t.doc === 'schematic' ? [structuredClone(t.graphic)] : []));
  if (!gates.length && !nets.size && !drawing.length) return undefined;

  // Library items the parts use.
  const library: O.Library = { symbols: [], footprints: [], components: [] };
  for (const id of new Set(parts.map((p) => p.component))) {
    const c = index.components.get(id);
    if (!c) continue;
    library.components.push(structuredClone(c));
    for (const g of c.gates) {
      const s = index.symbols.get(g.symbol);
      if (s && !library.symbols.some((x) => x.id === s.id)) library.symbols.push(structuredClone(s));
    }
    for (const v of c.variants) {
      const f = v.footprint ? index.footprints.get(v.footprint) : undefined;
      if (f && !library.footprints.some((x) => x.id === f.id)) library.footprints.push(structuredClone(f));
    }
  }

  // Origin: the centre of everything, on the grid.
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (p: O.Pt) => (xs.push(p[0]), ys.push(p[1]));
  for (const g of gates) add(g.at);
  for (const n of nets.values()) for (const s of n.segments) for (const w of s.wires) (add(w.line[0]), add(w.line[1]));
  for (const d of drawing) {
    if ('line' in d) d.line.forEach(add);
    else if ('rect' in d) d.rect.forEach(add);
    else if ('frame' in d) d.frame.forEach(add);
    else if ('circle' in d) add(d.circle);
    else if ('hole' in d) add(d.hole);
    else if ('at' in d) add(d.at);
    else if ('polygon' in d) for (const p of d.polygon) add([p[0], p[1]]);
  }
  const snap = (v: number) => Math.round(Math.round(v / grid) * grid * 1e6) / 1e6;
  const origin: O.Pt = xs.length ? [snap((Math.min(...xs) + Math.max(...xs)) / 2), snap((Math.min(...ys) + Math.max(...ys)) / 2)] : [0, 0];

  return {
    format: CLIP_FORMAT,
    version: 1,
    origin,
    library,
    parts: structuredClone(parts),
    gates: structuredClone(gates),
    nets: [...nets.values()],
    drawing,
  };
}

/** Read a clip from clipboard text (undefined when it isn't one). */
export function parseClip(text: string): Clip | undefined {
  try {
    const c = JSON.parse(text) as Partial<Clip>;
    if (c?.format !== CLIP_FORMAT || c.version !== 1 || !Array.isArray(c.gates) || !Array.isArray(c.nets) || !c.library) return undefined;
    return { drawing: [], parts: [], ...c } as Clip;
  } catch {
    return undefined;
  }
}

export interface Pasted {
  /** The new objects, for moving into place and selecting. */
  targets: Target[];
  /** Old name → new name, for parts and nets that were renamed. */
  renamed: Map<string, string>;
  parts: string[];
  /** Library items the project already had in a different version (its copies are used). */
  libraryNotes: string[];
}

/** Add a clip's contents to a sheet, at the positions they were copied from. */
export function pasteClip(project: O.Project, clip: Clip, sheet: O.Sheet, tx: Transaction): Pasted {
  const targets: Target[] = [];
  const renamed = new Map<string, string>();
  const libraryNotes: string[] = [];

  // Parts, under free names.
  const partName = new Map<string, string>();
  for (const src of clip.parts) {
    const notes = addToLibrary(project, clip.library, src.component, tx);
    for (const n of notes) if (!libraryNotes.includes(n)) libraryNotes.push(n);
    const component = project.library.components.find((c) => c.id === src.component)!;
    const taken = project.parts.some((p) => p.name === src.name);
    // C4 → the next free C; a part named by hand (RF) keeps its stem (RF1).
    const name = taken ? nextPartName(project, src.name.replace(/\d+$/, '') || component.prefix) : src.name;
    if (name !== src.name) renamed.set(src.name, name);
    partName.set(src.name, name);
    insertPart(project, { ...structuredClone(src), name }, component, tx);
  }
  for (const src of clip.gates) {
    const name = partName.get(src.part);
    if (!name) continue;
    const g: O.GatePlacement = { ...structuredClone(src), part: name };
    tx.run(insert(sheet.gates, g));
    targets.push({ kind: 'gate', sheet, gate: g });
  }

  // Wiring, each net under a free name (supply nets join theirs).
  for (const cn of clip.nets) {
    const existing = project.nets.find((n) => n.name === cn.name);
    let net: O.Net;
    if (!existing) {
      net = { name: cn.name, segments: [] };
      tx.run(insert(project.nets, net));
    } else if (cn.supply) {
      net = existing;
      if (!net.segments) tx.run(set(net, { segments: [] }));
    } else {
      net = { name: AUTO.test(cn.name) ? nextNetName(project) : suffixed(project, cn.name), segments: [] };
      renamed.set(cn.name, net.name);
      tx.run(insert(project.nets, net));
    }
    for (const cs of cn.segments) {
      const seg: O.Segment = { sheet: sheet.id, pins: [], wires: [] };
      for (const r of cs.pins) {
        const part = partName.get(r.part);
        if (part) seg.pins.push({ ...r, part });
      }
      tx.run(insert(net.segments!, seg));
      for (const w of cs.wires) {
        const wire = structuredClone(w);
        tx.run(insert(seg.wires, wire));
        targets.push({ kind: 'wire', net, segment: seg, wire });
      }
      if (cs.junctions?.length) {
        tx.run(set(seg, { junctions: [] }));
        for (const j of cs.junctions) {
          const junction: O.Pt = [j[0], j[1]];
          tx.run(insert(seg.junctions!, junction));
          targets.push({ kind: 'junction', net, segment: seg, junction });
        }
      }
      if (cs.labels?.length) {
        tx.run(set(seg, { labels: [] }));
        for (const l of cs.labels) {
          const label = structuredClone(l);
          tx.run(insert(seg.labels!, label));
          targets.push({ kind: 'netlabel', net, segment: seg, label });
        }
      }
    }
  }

  for (const d of clip.drawing) {
    const graphic = structuredClone(d);
    tx.run(insert(sheet.drawing, graphic));
    targets.push({ kind: 'drawing', doc: 'schematic', graphic, container: sheet.drawing });
  }
  return { targets, renamed, parts: [...partName.values()], libraryNotes };
}

const AUTO = /^N\$\d+$/;

/** A free name for a copy of a named net: IN → IN_2 (IN_3, …). */
function suffixed(project: O.Project, name: string): string {
  // Copies of IN_2 are IN_3, … (not IN_2_2) while IN itself exists.
  const stripped = name.replace(/_\d+$/, '');
  const base = stripped !== name && project.nets.some((n) => n.name === stripped) ? stripped : name;
  let k = 2;
  while (project.nets.some((n) => n.name === `${base}_${k}`)) k++;
  return `${base}_${k}`;
}
