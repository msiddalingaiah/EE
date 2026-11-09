// Forward/back annotation: keep a schematic and its board in step when an edit in one
// changes the netlist. Only netlist changes propagate; geometry is independent.

import type { Board, Schematic } from '../eagle/types';
import { deleteBoardTargets } from '../edit/board';
import { removeItem, removeMapEntry, type Transaction } from '../edit/ops';
import { deleteSchematicTargets } from '../edit/schematic';
import type { Target } from '../scene/types';
import { schematicNetPads } from './consistency';

const BOARD_KINDS = new Set<Target['kind']>(['element', 'signal-wire', 'via', 'signal-polygon']);

/** Split targets into those living in the board and those in the schematic. */
export function splitTargets(targets: Target[], board: Board | undefined): { board: Target[]; schematic: Target[] } {
  const out = { board: [] as Target[], schematic: [] as Target[] };
  for (const t of targets) {
    const onBoard = BOARD_KINDS.has(t.kind) ||
      (t.kind === 'plain' && !!board && t.container === board.plain) ||
      (t.kind === 'attribute' && t.doc === 'board');
    (onBoard ? out.board : out.schematic).push(t);
  }
  return out;
}

/**
 * Parts whose board element is locked can't be deleted from the schematic either
 * (the board half would be refused). Returns the targets that may go, and the names held back.
 */
export function deletableTargets(targets: Target[], board: Board | undefined): { ok: Target[]; locked: string[] } {
  if (!board) return { ok: targets, locked: [] };
  const lockedNames = new Set(board.elements.filter((e) => e.locked).map((e) => e.name));
  const locked = new Set<string>();
  const ok = targets.filter((t) => {
    const name = t.kind === 'instance' ? t.instance.part : t.kind === 'element' ? t.element.name : undefined;
    if (name !== undefined && lockedNames.has(name)) {
      locked.add(name);
      return false;
    }
    return true;
  });
  return { ok, locked: [...locked] };
}

/**
 * Delete targets from whichever document they belong to, annotating the other:
 * - a part removed from the schematic (its last gate deleted) is removed from the board;
 * - a pad that leaves a net in the schematic (e.g. its wire deleted) leaves that board signal;
 * - an element deleted on the board removes the part, with all its gates, from the schematic.
 * Traces on the board aren't part of the netlist, so deleting them changes nothing in the schematic.
 */
export function deleteAnnotated(
  sch: Schematic | undefined, brd: Board | undefined, targets: Target[], tx: Transaction,
): { schematic: boolean; board: boolean } {
  const { board: bt, schematic: st } = splitTargets(targets, brd);
  const touched = { schematic: false, board: false };
  const track = (doc: 'schematic' | 'board', fn: () => void) => {
    const n = tx.size;
    fn();
    if (tx.size > n) touched[doc] = true;
  };

  // Board elements going away take their schematic parts with them.
  if (sch) {
    for (const t of bt) {
      if (t.kind !== 'element') continue;
      const name = t.element.name;
      const gates: Target[] = sch.sheets.flatMap((sheet) =>
        sheet.instances.filter((i) => i.part === name).map((instance): Target => ({ kind: 'instance', sheet, instance })),
      );
      st.push(...gates.filter((g) => !st.some((s) => s.kind === 'instance' && g.kind === 'instance' && s.instance === g.instance)));
      if (!gates.length && sch.parts.has(name)) track('schematic', () => tx.run(removeMapEntry(sch.parts, name)));
    }
  }

  if (sch && st.length) {
    const partsBefore = new Set(sch.parts.keys());
    const padsBefore = brd ? schematicNetPads(sch) : undefined;
    track('schematic', () => deleteSchematicTargets(sch, st, tx));

    if (brd && padsBefore) {
      // Parts that left the schematic leave the board.
      const gone = [...partsBefore].filter((n) => !sch.parts.has(n));
      const elements: Target[] = brd.elements
        .filter((e) => gone.includes(e.name) && !bt.some((t) => t.kind === 'element' && t.element === e))
        .map((element) => ({ kind: 'element', element }));
      bt.push(...elements);

      // Pads that left a net leave the board signal of the same name.
      const padsAfter = schematicNetPads(sch);
      for (const [net, pads] of padsBefore) {
        const after = padsAfter.get(net) ?? new Set<string>();
        const signal = brd.signals.find((s) => s.name === net);
        if (!signal) continue;
        for (const key of pads) {
          if (after.has(key)) continue;
          const [element, pad] = key.split('\u0000');
          if (gone.includes(element!)) continue; // removed with the element below
          const cr = signal.contactrefs.find((c) => c.element === element && c.pad === pad);
          if (cr) track('board', () => tx.run(removeItem(signal.contactrefs, cr)));
        }
      }
    }
  }

  if (brd && bt.length) track('board', () => deleteBoardTargets(brd, bt, tx));
  return touched;
}
