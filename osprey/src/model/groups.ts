// Layout groups: footprints, traces and vias with the same `group` are one piece of layout (a
// subcircuit's tuned placement and routing, copied in with it). Autoplace moves and turns a
// group whole, its copper with it; autoroute adds to the board around it and leaves its copper.

import type { Rect } from './placement';
import type * as O from './types';

export type GroupCopper = { kind: 'trace'; net: O.Net; trace: O.Trace } | { kind: 'via'; net: O.Net; via: O.Via };

export interface GroupContents {
  footprints: O.FootprintPlacement[];
  copper: GroupCopper[];
}

/** The project's layout groups, by name. */
export function layoutGroups(project: O.Project): Map<string, GroupContents> {
  const out = new Map<string, GroupContents>();
  const get = (g: string) => out.get(g) ?? out.set(g, { footprints: [], copper: [] }).get(g)!;
  for (const f of project.board?.footprints ?? []) if (f.group) get(f.group).footprints.push(f);
  for (const net of project.nets) {
    for (const trace of net.traces ?? []) if (trace.group) get(trace.group).copper.push({ kind: 'trace', net, trace });
    for (const via of net.vias ?? []) if (via.group) get(via.group).copper.push({ kind: 'via', net, via });
  }
  return out;
}

/** A group name not used in the project: `want`, else want-2, want-3 … */
export function freeGroupName(project: O.Project, want: string): string {
  const used = new Set(layoutGroups(project).keys());
  let name = want;
  for (let k = 2; used.has(name); k++) name = `${want}-${k}`;
  return name;
}

/** The box around a group's copper (traces with their width, vias with their diameter), if it has any. */
export function copperBox(copper: GroupCopper[], viaDiameter: (v: O.Via) => number): Rect | undefined {
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number, grow: number) => {
    r.minX = Math.min(r.minX, x - grow);
    r.minY = Math.min(r.minY, y - grow);
    r.maxX = Math.max(r.maxX, x + grow);
    r.maxY = Math.max(r.maxY, y + grow);
  };
  for (const c of copper) {
    if (c.kind === 'trace') for (const [x, y] of c.trace.line) add(x, y, c.trace.width / 2);
    else add(c.via.at[0], c.via.at[1], viaDiameter(c.via) / 2);
  }
  return r.minX <= r.maxX ? r : undefined;
}
