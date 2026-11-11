// Dragging the ends of drawing lines (e.g. resizing a board outline).

import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject, writeProject } from '../src/model/file';
import type * as O from '../src/model/types';

const BOARD = JSON.stringify({
  osprey: 1,
  project: { name: 'outline' },
  library: { symbols: [], footprints: [], components: [] },
  parts: [],
  nets: [],
  board: {
    layers: ['copper.top', 'copper.bottom'],
    drawing: [
      { line: [[0, 0], [40, 0]], width: 0, layer: 'outline' },
      { line: [[40, 0], [40, 30]], width: 0, layer: 'outline' },
      { line: [[40, 30], [0, 30]], width: 0, layer: 'outline' },
      { line: [[0, 30], [0, 0]], width: 0, layer: 'outline' },
      { line: [[40, 30], [45, 35]], width: 0.2, layer: 'silk.top' },
    ],
  },
});

let p: O.Project;
let editor: Editor;
beforeEach(() => {
  p = readProject(BOARD);
  editor = new Editor(p, () => {});
});

const drawing = () => p.board!.drawing as O.LineShape[];
const lines = () => drawing().map((g) => g.line);
const grid = () => 1.27;

describe('dragging a line end', () => {
  it('moves an outline corner with both lines that meet there, snapped, as one undo step', () => {
    const before = lines();
    const d = editor.dragLineEnd(drawing()[1]!, 1, p.board!.drawing, grid);
    expect(d.joined).toBe(true);
    d.moveTo({ x: 35.3, y: 25.2 }, false);
    expect(lines()[1]).toEqual([[40, 0], [35.56, 25.4]]); // previewed in the model
    expect(lines()[2]).toEqual([[35.56, 25.4], [0, 30]]);
    expect(d.commit()).toBe(true);
    expect(lines()[1]![1]).toEqual([35.56, 25.4]);
    expect(lines()[2]![0]).toEqual([35.56, 25.4]);
    expect(lines()[4]).toEqual(before[4]); // another layer's line stays
    expect(editor.history.undoLabel).toBe('Move corner');
    editor.undo();
    expect(lines()).toEqual(before);
    expect(writeProject(p)).toBe(writeProject(readProject(BOARD)));
  });

  it('moves a lone end by itself; a drag back to where it started changes nothing', () => {
    const silk = drawing()[4]!;
    const d = editor.dragLineEnd(silk, 1, p.board!.drawing, grid);
    expect(d.joined).toBe(false);
    d.moveTo({ x: 50.8, y: 35 }, false);
    expect(d.commit()).toBe(true);
    expect(silk.line).toEqual([[40, 30], [50.8, 35.56]]);
    expect(editor.history.undoLabel).toBe('Move line end');

    const back = editor.dragLineEnd(silk, 1, p.board!.drawing, grid);
    back.moveTo({ x: 60, y: 60 }, false);
    back.moveTo({ x: 50.8, y: 35.56 }, false);
    expect(back.commit()).toBe(false);
    expect(editor.history.undoLabel).toBe('Move line end');
    expect(editor.dragLineEnd(silk, 0, p.board!.drawing, grid).commit()).toBe(false);
  });
});
