// Net labels: a net's name drawn on its schematic wires. Renaming a net labels each piece of
// its wiring that has none, at a loose wire end; the wire inspector's "Show label" adds or
// removes the label of one piece. Labels only show the name: nets connect by name either way.

import { ProjectIndex } from '../model/derive';
import { pinPosition } from '../model/geometry';
import type * as O from '../model/types';
import { insert, remove, set, type Transaction } from './ops';

const EPS = 1e-4;
/** Eagle's net label text: 70 mil on the names layer. */
const LABEL_SIZE = 1.778;
const same = (a: O.Pt, b: O.Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** The pin positions a segment's wires connect to. */
function pinPoints(project: O.Project, seg: O.Segment, index: ProjectIndex): O.Pt[] {
  const sheet = project.schematic?.sheets.find((s) => s.id === seg.sheet);
  const out: O.Pt[] = [];
  for (const ref of seg.pins) {
    const g = sheet?.gates.find((x) => x.part === ref.part && x.gate === ref.gate);
    const p = g && pinPosition(index, g, ref.pin);
    if (p) out.push([p.x, p.y]);
  }
  return out;
}

/** An end of `wire` no other wire of the segment, and no pin, touches. */
function looseEnd(seg: O.Segment, wire: O.Wire, pins: O.Pt[]): O.Pt | undefined {
  for (const end of [wire.line[1], wire.line[0]]) {
    const touched = seg.wires.some((w) => w !== wire && (same(w.line[0], end) || same(w.line[1], end)));
    if (!touched && !pins.some((p) => same(p, end))) return end;
  }
  return undefined;
}

/**
 * A label for `wire`: at its loose end (the text running away from the wire), else at its
 * middle. Vertical wires get vertical text.
 */
export function labelFor(seg: O.Segment, wire: O.Wire, pins: O.Pt[]): O.NetLabel {
  const [a, b] = wire.line;
  const vertical = Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) >= EPS;
  const end = looseEnd(seg, wire, pins);
  const label: O.NetLabel = { at: [0, 0], size: LABEL_SIZE, layer: 'names' };
  if (vertical) label.rot = 90;
  if (end) {
    const other = same(end, a) ? b : a;
    label.at = [end[0], end[1]];
    // The text runs on from the end: right or up from it, else ending at it.
    const outward = vertical ? end[1] >= other[1] : end[0] >= other[0];
    if (!outward) label.align = 'bottom-right';
  } else {
    label.at = [Math.round(((a[0] + b[0]) / 2) * 1e6) / 1e6, Math.round(((a[1] + b[1]) / 2) * 1e6) / 1e6];
    label.align = 'bottom-center';
  }
  return label;
}

/** The wire to label a segment on: one with a loose end (the longest), else the longest. */
function wireToLabel(seg: O.Segment, pins: O.Pt[]): O.Wire | undefined {
  const len = (w: O.Wire) => Math.hypot(w.line[1][0] - w.line[0][0], w.line[1][1] - w.line[0][1]);
  const byLength = [...seg.wires].sort((x, y) => len(y) - len(x));
  return byLength.find((w) => looseEnd(seg, w, pins)) ?? byLength[0];
}

/** Label each of `segments` (of a net) that has wires but no label. Returns how many were labelled. */
export function labelSegments(project: O.Project, segments: O.Segment[], tx: Transaction, index = new ProjectIndex(project)): number {
  let n = 0;
  for (const seg of segments) {
    if (seg.labels?.length || !seg.wires.length) continue;
    const pins = pinPoints(project, seg, index);
    const wire = wireToLabel(seg, pins);
    if (!wire) continue;
    addLabel(seg, labelFor(seg, wire, pins), tx);
    n++;
  }
  return n;
}

function addLabel(seg: O.Segment, label: O.NetLabel, tx: Transaction): void {
  if (!seg.labels) tx.run(set(seg, { labels: [] }));
  tx.run(insert(seg.labels!, label));
}

/**
 * Show or hide the net label of the piece of wiring `wire` belongs to: on adds one at the
 * wire (if the piece has none), off removes the piece's labels. Returns whether anything changed.
 */
export function setSegmentLabel(project: O.Project, seg: O.Segment, wire: O.Wire, on: boolean, tx: Transaction, index = new ProjectIndex(project)): boolean {
  if (on) {
    if (seg.labels?.length) return false;
    addLabel(seg, labelFor(seg, wire, pinPoints(project, seg, index)), tx);
    return true;
  }
  if (!seg.labels?.length) return false;
  for (const l of [...seg.labels]) tx.run(remove(seg.labels, l));
  tx.run(set(seg, { labels: undefined }));
  return true;
}
