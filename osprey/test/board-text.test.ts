// Board text: added on the board's drawing, edited (layer, mirroring, ratio, rotation), flipped
// to the other side, and plotted into the silkscreen Gerber files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { runCam } from '../src/cam/job';
import { readProject } from '../src/model/file';
import type * as O from '../src/model/types';

let p: O.Project;
let ed: Editor;
let text: O.TextShape;
const target = () => ({ kind: 'drawing' as const, doc: 'board' as const, graphic: text, container: p.board!.drawing });
/** Region count of a Gerber file (text is plotted as regions). */
const regions = (gerber: string | undefined) => (gerber?.match(/G36\*/g) ?? []).length;

beforeEach(() => {
  p = readProject(readFileSync(join(__dirname, '..', 'samples', 'osprey', 'wwvbfind.osprey'), 'utf8'));
  ed = new Editor(p, () => {});
  text = { text: 'REV A', at: [3, 24], size: 1.27, ratio: 15, layer: 'silk.top' };
});

describe('board text', () => {
  it('is added to the board as one undo step', () => {
    ed.addGraphic(p.board!.drawing, text, 'Add text');
    expect(p.board!.drawing).toContain(text);
    expect(ed.history.undoLabel).toBe('Add text');
    ed.undo();
    expect(p.board!.drawing).not.toContain(text);
  });

  it('is plotted into the top silkscreen, and the bottom one when flipped', () => {
    const before = runCam(p).files;
    ed.addGraphic(p.board!.drawing, text, 'Add text');
    const after = runCam(p).files;
    const top = [...after.keys()].find((n) => n.endsWith('.GTO'))!;
    const bottom = [...after.keys()].find((n) => n.endsWith('.GBO'))!;
    expect(regions(after.get(top))).toBeGreaterThan(regions(before.get(top)));
    expect(after.get(bottom)).toBe(before.get(bottom));
    // F on the board: to the other side, mirrored so it reads from below.
    ed.mirror([target()], { x: 3, y: 24 }, 'Flip side');
    expect([text.layer, text.mirror]).toEqual(['silk.bottom', true]);
    const flipped = runCam(p).files;
    expect(flipped.get(top)).toBe(before.get(top));
    expect(regions(flipped.get(bottom))).toBeGreaterThan(regions(before.get(bottom)));
  });

  it('warns when its strokes are too thin to print', () => {
    ed.addGraphic(p.board!.drawing, { ...text, ratio: 8, size: 1 }, 'Add text'); // 0.08 mm strokes
    expect(runCam(p).warnings.join(' ')).toMatch(/strokes thinner than 0.15 mm/);
  });

  it('changes wording, size, ratio, rotation and mirroring', () => {
    ed.addGraphic(p.board!.drawing, text, 'Add text');
    expect(ed.setGraphic(text, { text: 'WWVB  REV B' }, 'Change text')).toBeUndefined();
    expect(ed.setGraphic(text, { ratio: 40 }, 'Text ratio')).toMatch(/0 to 31/);
    expect(ed.setGraphic(text, { ratio: 8 }, 'Text ratio')).toBeUndefined();
    expect('ratio' in text && text.ratio !== undefined).toBe(false); // the default is stored as absent
    expect(ed.setGraphic(text, { rot: -90 }, 'Text rotation')).toBeUndefined();
    expect(text.rot).toBe(270);
    expect(ed.setGraphic(text, { layer: 'silk.bottom', mirror: true }, 'Change layer')).toBeUndefined();
    expect([text.text, text.layer, text.mirror]).toEqual(['WWVB  REV B', 'silk.bottom', true]);
  });
});

describe('text on a schematic sheet', () => {
  it('keeps several lines through export to Eagle and back', async () => {
    const { parseEagle } = await import('../src/eagle/parse');
    const { exportEagle } = await import('../src/model/export-eagle');
    const { importEagle } = await import('../src/model/import-eagle');
    const sheet = p.schematic!.sheets[0]!;
    const note: O.TextShape = { text: 'Notes:\nC2 is a film cap', at: [10.16, 10.16], size: 1.778, layer: 'info' };
    ed.addGraphic(sheet.drawing, note, 'Add text');
    const { files } = exportEagle(p);
    const back = importEagle([...files].map(([name, text]) => ({ name, file: parseEagle(text) })), 'D').project;
    expect(back.schematic!.sheets[0]!.drawing).toContainEqual(note);
  });
});
