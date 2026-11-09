// Creating and changing polygon pours: adding one to a net, moving it to another net, and
// setting its properties. (The poured copper itself is computed: model/pour.ts.)

import type * as O from '../model/types';
import { insert, remove, set, type Transaction } from './ops';
import { nextNetName } from './wire';

/** Eagle's usual pour outline width (10 mil), when the board has no pours to copy from. */
export const DEFAULT_POUR_WIDTH = 0.254;

/** The width new pours get: the board's most common pour width, else 10 mil. */
export function usualPourWidth(project: O.Project): number {
  const count = new Map<number, number>();
  for (const n of project.nets) for (const p of n.pours ?? []) count.set(p.width, (count.get(p.width) ?? 0) + 1);
  let best = DEFAULT_POUR_WIDTH;
  let most = 0;
  for (const [w, c] of count) if (c > most) [best, most] = [w, c];
  return best;
}

/** The net a new pour goes on when none was picked: GND if there is one. */
export function defaultPourNet(project: O.Project): string | undefined {
  return project.nets.find((n) => n.name === 'GND')?.name;
}

/** Add a pour to a net (created, as an automatic N$n, when `netName` is undefined or new). */
export function addPour(project: O.Project, netName: string | undefined, polygon: O.PolyPt[], layer: string, tx: Transaction): { net: O.Net; pour: O.PolygonShape } {
  const name = netName ?? nextNetName(project);
  let net = project.nets.find((n) => n.name === name);
  if (!net) {
    net = { name };
    tx.run(insert(project.nets, net));
  }
  const pour: O.PolygonShape = { polygon: polygon.map((p) => [...p] as O.PolyPt), width: usualPourWidth(project), layer };
  if (!net.pours) tx.run(set(net, { pours: [] }));
  tx.run(insert(net.pours!, pour));
  tx.subjects.push(pour);
  return { net, pour };
}

/** Move a pour to another net (created if it doesn't exist; an emptied net is removed). */
export function setPourNet(project: O.Project, pour: O.PolygonShape, toName: string, tx: Transaction): string | undefined {
  const name = toName.trim();
  if (!name) return 'A net name is needed';
  if (/\s/.test(name)) return 'Net names have no spaces';
  const from = project.nets.find((n) => n.pours?.includes(pour));
  if (!from) return 'This pour is not on a net';
  if (from.name === name) return undefined;
  let to = project.nets.find((n) => n.name === name);
  if (!to) {
    to = { name };
    tx.run(insert(project.nets, to));
  }
  tx.run(remove(from.pours!, pour));
  if (!from.pours!.length) tx.run(set(from, { pours: undefined }));
  if (!to.pours) tx.run(set(to, { pours: [] }));
  tx.run(insert(to.pours!, pour));
  const empty = !from.segments?.length && !from.traces?.length && !from.vias?.length && !from.pours?.length && !from.pads?.length;
  if (empty) tx.run(remove(project.nets, from));
  tx.subjects.push(pour);
  return undefined;
}

/** Pour properties the inspector edits. Undefined values return a property to its default. */
export interface PourPatch {
  layer?: string;
  width?: number;
  isolate?: number | undefined;
  rank?: number | undefined;
  thermals?: boolean;
  orphans?: boolean;
  hatch?: boolean;
}

/** Check and apply property changes. Returns an error message when a value isn't allowed. */
export function setPourProps(pour: O.PolygonShape, patch: PourPatch, tx: Transaction): string | undefined {
  const p: Partial<Record<keyof O.PolygonShape, unknown>> = {};
  if ('width' in patch) {
    if (!(patch.width! > 0)) return 'The width must be more than 0';
    p.width = patch.width;
  }
  if ('isolate' in patch) {
    if (patch.isolate !== undefined && !(patch.isolate >= 0)) return 'The isolation can\'t be negative';
    p.isolate = patch.isolate || undefined;
  }
  if ('rank' in patch) {
    if (patch.rank !== undefined && !(Number.isInteger(patch.rank) && patch.rank >= 1 && patch.rank <= 6)) return 'The rank is a whole number from 1 to 6';
    p.rank = patch.rank === 1 ? undefined : patch.rank;
  }
  if ('layer' in patch) p.layer = patch.layer;
  if ('thermals' in patch) p.thermals = patch.thermals ? undefined : false;
  if ('orphans' in patch) p.orphans = patch.orphans ? true : undefined;
  if ('hatch' in patch) p.pour = patch.hatch ? 'hatch' : undefined;
  tx.run(set(pour, p));
  tx.subjects.push(pour);
  return undefined;
}

// ---------------------------------------------------------------------------
// Editing the outline: corners

/** A pour outline with corner `i` moved to `to` (curved edges keep their curve). */
export function withCornerMoved(polygon: O.PolyPt[], i: number, to: O.Pt): O.PolyPt[] {
  return polygon.map((p, k) => (k === i ? ((p.length > 2 ? [to[0], to[1], p[2]] : [to[0], to[1]]) as O.PolyPt) : p));
}

/**
 * A pour outline with a corner added in the middle of edge `i` (from corner i to the next),
 * at `at`. A curved edge is split into two curves of half the angle each.
 */
export function withCornerAdded(polygon: O.PolyPt[], i: number, at: O.Pt): O.PolyPt[] {
  const p = polygon[i]!;
  const curve = p.length > 2 ? p[2] : undefined;
  const first: O.PolyPt = curve ? [p[0], p[1], curve / 2] : [p[0], p[1]];
  const added: O.PolyPt = curve ? [at[0], at[1], curve / 2] : [at[0], at[1]];
  return [...polygon.slice(0, i), first, added, ...polygon.slice(i + 1)];
}

/** Where a corner goes when edge `i` is split: its middle (on the arc, for a curved edge). */
export function edgeMiddle(polygon: O.PolyPt[], i: number): O.Pt {
  const a = polygon[i]!;
  const b = polygon[(i + 1) % polygon.length]!;
  const curve = a.length > 2 ? a[2]! : 0;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  if (!curve) return [mx, my];
  // The arc's middle: from the chord's middle along its normal by the arc's sagitta.
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  const t = (curve * Math.PI) / 180;
  const r = chord / (2 * Math.sin(Math.abs(t) / 2));
  const sag = r * (1 - Math.cos(Math.abs(t) / 2));
  // Counter-clockwise (positive) curves bulge to the right of a → b.
  const s = Math.sign(t);
  return [mx + (dy / chord) * sag * s, my - (dx / chord) * sag * s];
}

/** A pour outline without corner `i` (an outline keeps at least three corners). */
export function withCornerRemoved(polygon: O.PolyPt[], i: number): O.PolyPt[] | undefined {
  if (polygon.length <= 3) return undefined;
  return polygon.filter((_, k) => k !== i);
}

/** Replace a pour's outline (one undoable change). */
export function setOutline(pour: O.PolygonShape, polygon: O.PolyPt[], tx: Transaction): void {
  tx.run(set(pour, { polygon }));
  tx.subjects.push(pour);
}
