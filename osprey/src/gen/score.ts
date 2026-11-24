// A schematic's drawing measured block by block (the BLOCK attribute on its parts), to compare a
// generated sheet with a person's drawing of the same netlist: wire length, bends, size, and how
// far each part is from where the person put it. Blocks are compared by positions within each
// block, so moving a whole block around the sheet changes nothing.

import { ProjectIndex } from '../model/derive';
import { apply } from '../geom/transform';
import { gateTransform, pinPosition } from '../model/geometry';
import type * as O from '../model/types';
import { textBox } from './layout';

export interface BlockScore {
  block: string;
  parts: number;
  /** Total wire length, mm. */
  wire: number;
  wires: number;
  /** Corners: two wires meeting at right angles with nothing else there. */
  bends: number;
  /** The block's extent (parts' pins, supply symbols and wires), mm. */
  width: number;
  height: number;
  /** Pairs of parts (supply symbols too) whose drawings with their texts overlap: crowding. */
  overlaps: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Each gate's drawing (lines and shapes, not its pins) and each of its texts (name and value as shown), as boxes on the sheet. */
export function gateBoxes(index: ProjectIndex, sheet: O.Sheet): { part: string; box: Box; text: boolean }[] {
  return sheet.gates.flatMap((g) => {
    const part = index.parts.get(g.part);
    const c = part && index.components.get(part.component);
    const sym = c && index.symbols.get(c.gates.find((x) => x.name === g.gate)?.symbol ?? '');
    if (!part || !sym) return [];
    // No value given: the component's name and variant, as Eagle generates it (GND, MMBT3904L).
    const shown: Record<string, string> = { '>NAME': part.name, '>VALUE': part.value ?? (c.id.split('/').pop() ?? '').replace('*', '') + part.variant };
    const t = gateTransform(g);
    const boxOf = (pts: Pt[]): Box => {
      const q = pts.map(([x, y]) => apply(t, x, y));
      return { x0: Math.min(...q.map((v) => v.x)), y0: Math.min(...q.map((v) => v.y)), x1: Math.max(...q.map((v) => v.x)), y1: Math.max(...q.map((v) => v.y)) };
    };
    const body: Pt[] = [];
    const out: { part: string; box: Box; text: boolean }[] = [];
    for (const gr of sym.graphics) {
      if ('line' in gr) body.push(gr.line[0] as Pt, gr.line[1] as Pt);
      else if ('circle' in gr) body.push([gr.circle[0] - gr.radius, gr.circle[1] - gr.radius], [gr.circle[0] + gr.radius, gr.circle[1] + gr.radius]);
      else if ('rect' in gr) body.push(gr.rect[0] as Pt, gr.rect[1] as Pt);
      else if ('polygon' in gr) for (const v of gr.polygon) body.push([v[0], v[1]]);
      else if ('text' in gr) {
        const text = shown[gr.text.toUpperCase()] ?? gr.text;
        if (!text) continue;
        out.push({ part: g.part, box: boxOf(textBox(gr, text)), text: true });
      }
    }
    if (body.length) out.push({ part: g.part, box: boxOf(body), text: false });
    return out;
  });
}

type Pt = [number, number];
const key = (p: Pt) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/** The block of each part, from its BLOCK attribute. */
export const blocksOf = (p: O.Project) => new Map(p.parts.map((x) => [x.name, x.attributes?.BLOCK]));

/** Each block's drawing on the first sheet (blocks: by default the parts' own). */
export function scoreSheet(p: O.Project, blockOf = blocksOf(p)): BlockScore[] {
  const index = new ProjectIndex(p);
  const sheet = p.schematic?.sheets[0];
  if (!sheet) return [];
  const gates = new Map(sheet.gates.map((g) => [`${g.part}.${g.gate}`, g]));
  const acc = new Map<string, { parts: Set<string>; pts: Pt[]; wire: number; wires: number; bends: number }>();
  /** Net labels' texts, with their segment's block. */
  const labels: { part: string; box: Box; text: boolean; block: string }[] = [];
  const get = (b: string) => acc.get(b) ?? acc.set(b, { parts: new Set(), pts: [], wire: 0, wires: 0, bends: 0 }).get(b)!;

  for (const net of p.nets) {
    for (const seg of net.segments ?? []) {
      if (seg.sheet !== sheet.id) continue;
      // The segment belongs to the block most of its (non-supply) pins are in.
      const count = new Map<string, number>();
      for (const r of seg.pins) {
        const b = blockOf.get(r.part);
        if (b) count.set(b, (count.get(b) ?? 0) + 1);
      }
      const b = [...count].sort((x, y) => y[1] - x[1])[0]?.[0];
      if (!b) continue;
      const s = get(b);
      for (const [i, l] of (seg.labels ?? []).entries()) {
        const [lo, hi] = textBox({ ...l, text: net.name }, net.name);
        labels.push({ part: `label ${net.name} ${b} ${i}`, box: { x0: lo[0], y0: lo[1], x1: hi[0], y1: hi[1] }, text: true, block: b });
      }
      const ends = new Map<string, Pt[]>();
      for (const w of seg.wires) {
        const [a, c] = w.line as [Pt, Pt];
        const len = Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]);
        if (len === 0) continue;
        s.wire += len;
        s.wires++;
        s.pts.push(a, c);
        for (const [e, o] of [[a, c], [c, a]] as [Pt, Pt][]) ends.set(key(e), [...(ends.get(key(e)) ?? []), [o[0] - e[0], o[1] - e[1]]]);
      }
      const pinAt = new Set<string>();
      for (const r of seg.pins) {
        const g = gates.get(`${r.part}.${r.gate}`);
        const q = g && pinPosition(index, g, r.pin);
        if (!q) continue;
        pinAt.add(key([q.x, q.y]));
        s.pts.push([q.x, q.y]);
        // A supply symbol's own position counts toward the block's size too.
        if (!blockOf.get(r.part)) s.pts.push(g.at as Pt);
      }
      for (const [k, dirs] of ends) {
        if (dirs.length !== 2 || pinAt.has(k)) continue;
        const [u, v] = dirs as [Pt, Pt];
        if (u[0] * v[0] + u[1] * v[1] === 0) s.bends++;
      }
    }
  }
  for (const g of sheet.gates) {
    const b = blockOf.get(g.part);
    if (!b) continue;
    const s = get(b);
    s.parts.add(g.part);
    s.pts.push(g.at as Pt);
  }
  // Crowding: a text (a part's or a net label) over another part's drawing or text, or two
  // drawings overlapping; each pair once, in the block of the first that has one.
  const overlaps = new Map<string, number>();
  const boxes: { part: string; box: Box; text: boolean; block?: string }[] = [...gateBoxes(index, sheet), ...labels];
  const E = 0.25;
  const seen = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.part === b.part || seen.has(`${a.part} ${b.part}`)) continue;
      if (a.box.x1 - E <= b.box.x0 || b.box.x1 - E <= a.box.x0 || a.box.y1 - E <= b.box.y0 || b.box.y1 - E <= a.box.y0) continue;
      seen.add(`${a.part} ${b.part}`).add(`${b.part} ${a.part}`);
      const block = blockOf.get(a.part) ?? a.block ?? blockOf.get(b.part) ?? b.block;
      if (block) overlaps.set(block, (overlaps.get(block) ?? 0) + 1);
    }
  }
  return [...acc].map(([block, s]) => {
    const xs = s.pts.map((q) => q[0]);
    const ys = s.pts.map((q) => q[1]);
    return {
      block, parts: s.parts.size, wire: s.wire, wires: s.wires, bends: s.bends, overlaps: overlaps.get(block) ?? 0,
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    };
  }).sort((a, b) => a.block.localeCompare(b.block));
}

/**
 * How far each block's parts are from where they are in `ref` (the same netlist drawn by hand):
 * the mean distance, mm, after moving the whole block to fit best (by the mean offset).
 */
export function placementError(p: O.Project, ref: O.Project): Map<string, number> {
  const at = (q: O.Project) => new Map(q.schematic!.sheets[0]!.gates.map((g) => [`${g.part}.${g.gate}`, g.at as Pt]));
  const mine = at(p);
  const theirs = at(ref);
  const blockOf = blocksOf(p);
  const pairs = new Map<string, [Pt, Pt][]>();
  for (const [k, a] of mine) {
    const b = blockOf.get(k.split('.')[0]!);
    const r = theirs.get(k);
    if (b && r) pairs.set(b, [...(pairs.get(b) ?? []), [a, r]]);
  }
  const out = new Map<string, number>();
  for (const [b, ps] of pairs) {
    const dx = ps.reduce((s, [a, r]) => s + r[0] - a[0], 0) / ps.length;
    const dy = ps.reduce((s, [a, r]) => s + r[1] - a[1], 0) / ps.length;
    out.set(b, ps.reduce((s, [a, r]) => s + Math.hypot(a[0] + dx - r[0], a[1] + dy - r[1]), 0) / ps.length);
  }
  return out;
}

/**
 * A table comparing a drawing with a reference drawing, block by block, and the totals. The
 * blocks are p's (a hand drawing may not name them).
 */
export function compareSheets(p: O.Project, ref: O.Project): string {
  const mine = new Map(scoreSheet(p).map((s) => [s.block, s]));
  const theirs = new Map(scoreSheet(ref, blocksOf(p)).map((s) => [s.block, s]));
  const err = placementError(p, ref);
  const f = (n: number) => n.toFixed(0);
  const rows = [['block', 'wire mm', 'bends', 'overlaps', 'size mm', 'off mm']];
  const total = { a: 0, b: 0, ba: 0, bb: 0, oa: 0, ob: 0, area: 0, areb: 0, off: 0, n: 0 };
  for (const [block, a] of mine) {
    const b = theirs.get(block);
    if (!b) continue;
    const off = err.get(block) ?? 0;
    rows.push([block, `${f(a.wire)} / ${f(b.wire)}`, `${a.bends} / ${b.bends}`, `${a.overlaps} / ${b.overlaps}`,
      `${f(a.width)}×${f(a.height)} / ${f(b.width)}×${f(b.height)}`, off.toFixed(1)]);
    total.a += a.wire; total.b += b.wire; total.ba += a.bends; total.bb += b.bends; total.oa += a.overlaps; total.ob += b.overlaps;
    total.area += a.width * a.height; total.areb += b.width * b.height; total.off += off * a.parts; total.n += a.parts;
  }
  rows.push(['total', `${f(total.a)} / ${f(total.b)}`, `${total.ba} / ${total.bb}`, `${total.oa} / ${total.ob}`,
    `area ${f(total.area)} / ${f(total.areb)}`, (total.off / Math.max(1, total.n)).toFixed(1)]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n') + '\n(generated / reference)';
}
