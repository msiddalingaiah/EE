// Adding parts: copy a component (with its symbols and footprints) into the project library,
// name the new part after its prefix, put its footprint beside the board, and place its gates.

import type * as O from '../model/types';
import { insert, type Transaction } from './ops';

/** Insert into an id-sorted library list at its sorted position (keeps the file canonical). */
/** Insert an item where its id sorts, so library files stay in order. */
export function insertSorted<T extends { id: string }>(list: T[], item: T, tx: Transaction): void {
  const i = list.findIndex((x) => x.id.localeCompare(item.id) > 0);
  tx.run(insert(list, item, i < 0 ? list.length : i));
}

/**
 * Make sure the project library has `componentId` from `source`, with every symbol its gates
 * use and every footprint its variants use. Items already in the project are kept as they are.
 * Returns the ids of items that differ from the source (the project's copies are used).
 */
export function addToLibrary(project: O.Project, source: O.Library, componentId: string, tx: Transaction): string[] {
  const differs: string[] = [];
  const copy = <T extends { id: string }>(list: T[], from: T[], id: string) => {
    const src = from.find((x) => x.id === id);
    if (!src) return;
    const have = list.find((x) => x.id === id);
    if (have) {
      if (JSON.stringify(have) !== JSON.stringify(src)) differs.push(id);
      return;
    }
    insertSorted(list, structuredClone(src), tx);
  };
  const component = source.components.find((c) => c.id === componentId);
  if (!component) throw new Error(`No component ${componentId}`);
  copy(project.library.components, source.components, componentId);
  for (const g of component.gates) copy(project.library.symbols, source.symbols, g.symbol);
  for (const v of component.variants) if (v.footprint) copy(project.library.footprints, source.footprints, v.footprint);
  return differs;
}

/** The next free part name for a prefix, e.g. "C17" after C1…C16 ("U$1" without a prefix). */
export function nextPartName(project: O.Project, prefix: string | undefined): string {
  const p = prefix || 'U$';
  const taken = new Set(project.parts.map((x) => x.name));
  let n = 1;
  for (const name of taken) {
    if (!name.startsWith(p)) continue;
    const num = Number(name.slice(p.length));
    if (Number.isInteger(num) && num >= n) n = num + 1;
  }
  while (taken.has(`${p}${n}`)) n++;
  return `${p}${n}`;
}

/** Gates placed by an add, in order (Eagle places "next", "must" and "always" gates; others on request). */
export function gatesToPlace(component: O.Component): O.Gate[] {
  return component.gates.filter((g) => g.addLevel !== 'can' && g.addLevel !== 'request');
}

/**
 * Create a part and, when the project has a board and the variant has a footprint, place the
 * footprint to the left of the board outline (stacked below earlier new parts).
 */
export function createPart(
  project: O.Project, component: O.Component, variant: string, technology: string, tx: Transaction,
): { part: O.Part; footprint?: O.FootprintPlacement } {
  const part: O.Part = { name: nextPartName(project, component.prefix), component: component.id, variant };
  if (technology) part.technology = technology;
  return insertPart(project, part, component, tx);
}

/** Add a part to the project, parking its footprint beside the board if it has one. */
export function insertPart(project: O.Project, part: O.Part, component: O.Component, tx: Transaction): { part: O.Part; footprint?: O.FootprintPlacement } {
  tx.run(insert(project.parts, part));
  const v = component.variants.find((x) => x.name === part.variant);
  if (!project.board || !v?.footprint) return { part };
  const fp: O.FootprintPlacement = { part: part.name, at: parkingSpot(project.board) };
  tx.run(insert(project.board.footprints, fp));
  return { part, footprint: fp };
}

/** Where new footprints go: 10 mm left of the board outline, below the last one parked there. */
function parkingSpot(board: O.Board): O.Pt {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of board.drawing) {
    if ('line' in g && g.layer === 'outline') for (const [x, y] of g.line) (xs.push(x), ys.push(y));
  }
  const left = xs.length ? Math.min(...xs) : 0;
  const top = ys.length ? Math.max(...ys) : 0;
  const x = Math.round((left - 10) / 1.27) * 1.27;
  const parked = board.footprints.filter((f) => Math.abs(f.at[0] - x) < 1e-6);
  const y = Math.round((top - 5.08 * parked.length) / 1.27) * 1.27;
  return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
}
