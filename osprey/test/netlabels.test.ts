// Net labels shown on renaming and toggled per wire; trace widths chosen when routing and
// edited on existing traces.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { labelFor } from '../src/edit/netlabels';
import { anchors, milToMm, parseWidth, TRACE_WIDTHS_MIL, widthLabel } from '../src/edit/route';
import { readProject, writeProject } from '../src/model/file';
import type * as O from '../src/model/types';

const ORIGINAL = readFileSync(join(__dirname, '..', 'samples', 'osprey', 'TA7358A.osprey'), 'utf8');

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(ORIGINAL);
  editor = new Editor(p, () => {});
});

const unchanged = () => expect(writeProject(p)).toBe(ORIGINAL);
const net = (name: string) => p.nets.find((n) => n.name === name)!;
/** An automatically named net with wiring and no labels. */
const unlabelled = () => p.nets.find((n) => /^N\$/.test(n.name) && n.segments?.length && n.segments.every((s) => s.wires.length && !s.labels?.length))!;

describe('labels on renaming', () => {
  it('labels each piece of a renamed net\'s wiring, on one of its wires, in the same undo step', () => {
    const n = unlabelled();
    const segs = n.segments!;
    expect(editor.renameNet(n.name, 'rf_in2')).toBeUndefined();
    for (const s of segs) {
      expect(s.labels).toHaveLength(1);
      const l = s.labels![0]!;
      expect(l.layer).toBe('names');
      // On one of the piece's wires: at an end, or in the middle.
      const onWire = s.wires.some((w) => {
        const [a, b] = w.line;
        const cross = (b[0] - a[0]) * (l.at[1] - a[1]) - (b[1] - a[1]) * (l.at[0] - a[0]);
        const within = Math.min(a[0], b[0]) - 1e-6 <= l.at[0] && l.at[0] <= Math.max(a[0], b[0]) + 1e-6
          && Math.min(a[1], b[1]) - 1e-6 <= l.at[1] && l.at[1] <= Math.max(a[1], b[1]) + 1e-6;
        return Math.abs(cross) < 1e-6 && within;
      });
      expect(onWire).toBe(true);
    }
    editor.undo();
    unchanged();
  });

  it('doesn\'t add labels to a net that has them, or for an automatic name', () => {
    const labelled = p.nets.find((n) => n.segments?.some((s) => s.labels?.length) && !/^(GND|VCC)/.test(n.name) && !n.segments.some((s) => !s.labels?.length));
    if (labelled) {
      const before = labelled.segments!.map((s) => s.labels!.length);
      expect(editor.renameNet(labelled.name, 'SOMETHING_ELSE')).toBeUndefined();
      expect(labelled.segments!.map((s) => s.labels!.length)).toEqual(before);
      editor.undo();
    }
    const n = unlabelled();
    expect(editor.renameNet(n.name, 'N$999')).toBeUndefined();
    expect(n.segments!.every((s) => !s.labels?.length)).toBe(true);
  });

  it('a label at a loose end runs away from the wire', () => {
    const seg: O.Segment = { sheet: '1', pins: [], wires: [{ line: [[0, 0], [10, 0]], width: 0.15 }, { line: [[10, 0], [10, 5]], width: 0.15 }] };
    // Horizontal wire: its loose end is the left one, so the text ends there.
    expect(labelFor(seg, seg.wires[0]!, [])).toMatchObject({ at: [0, 0], align: 'bottom-right' });
    // Vertical wire: loose at the top, text runs up from it.
    const up = labelFor(seg, seg.wires[1]!, []);
    expect(up).toMatchObject({ at: [10, 5], rot: 90 });
    expect(up.align).toBeUndefined();
    // Both ends taken (a pin at the left): in the middle.
    expect(labelFor(seg, seg.wires[0]!, [[0, 0]])).toMatchObject({ at: [5, 0], align: 'bottom-center' });
  });
});

describe('show label on a wire', () => {
  it('adds and removes the label of the wire\'s piece of wiring, each one undo step', () => {
    const n = unlabelled();
    const seg = n.segments![0]!;
    const wire = seg.wires[0]!;
    expect(editor.setWireLabel(seg, wire, true)).toBe(true);
    expect(seg.labels).toHaveLength(1);
    expect(editor.history.undoLabel).toBe('Show net label');
    expect(editor.setWireLabel(seg, wire, true)).toBe(false); // already shown
    expect(editor.setWireLabel(seg, wire, false)).toBe(true);
    expect(seg.labels).toBeUndefined();
    editor.undo();
    expect(seg.labels).toHaveLength(1);
    editor.undo();
    unchanged();
  });
});

describe('trace widths', () => {
  it('reads widths in mm or mil and names them', () => {
    expect(parseWidth('0.3')).toBe(0.3);
    expect(parseWidth('0.3mm')).toBe(0.3);
    expect(parseWidth('10mil')).toBe(0.254);
    expect(parseWidth('12 MIL')).toBe(0.3048);
    expect(parseWidth('wide')).toBeNaN();
    expect(widthLabel(0.254)).toBe('10 mil (0.254 mm)');
    expect(widthLabel(0.3)).toBe('0.3 mm');
    expect(TRACE_WIDTHS_MIL.map(milToMm)).toContain(0.1524);
  });

  it('edits the width and layer of several traces at once, one undo step; refuses bad values', () => {
    const traces = p.nets.flatMap((n) => n.traces ?? []).slice(0, 3);
    expect(traces.length).toBe(3);
    expect(editor.setTraces(traces, { width: 0.508 })).toBeUndefined();
    expect(traces.every((t) => t.width === 0.508)).toBe(true);
    expect(editor.history.undoLabel).toBe('Trace width');
    editor.undo();
    unchanged();
    expect(editor.setTraces(traces, { layer: 'copper.bottom' })).toBeUndefined();
    expect(traces.every((t) => t.layer === 'copper.bottom')).toBe(true);
    editor.undo();
    unchanged();
    expect(editor.setTraces(traces, { width: 0 })).toMatch(/width/);
    expect(editor.setTraces(traces, { width: NaN })).toMatch(/width/);
    expect(editor.setTraces(traces, { layer: 'silk.top' })).toMatch(/copper layer/);
    unchanged();
  });

  it('routes with the width chosen, the leg in progress too; undefined goes back to the net\'s', () => {
    delete net('N$1').traces;
    const [a, b] = anchors(p).filter((x) => x.net === 'N$1' && x.kind === 'pad');
    const s = editor.beginRoute(() => 0.127)!;
    s.setWidth(0.508);
    s.moveTo({ x: a!.at[0], y: a!.at[1] }, false, 0.5);
    s.click();
    expect(s.width).toBe(0.508);
    s.moveTo({ x: b!.at[0], y: b!.at[1] }, false, 0.5);
    s.click(true);
    s.finish();
    expect(net('N$1').traces!.every((t) => t.width === 0.508)).toBe(true);
    s.setWidth(undefined);
    expect(s.width).toBe(0.254);
  });
});
