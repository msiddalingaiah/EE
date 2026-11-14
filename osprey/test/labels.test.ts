// Arranging part labels: names and values moved off pads, vias, outlines, the edge and each other.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/app/editor';
import { readProject, writeProject } from '../src/model/file';

const load = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'osprey', `${name}.osprey`), 'utf8');

describe('arrange labels', () => {
  for (const name of ['wwvbfind', 'wwvbfind2-hand']) {
    it(`clears the labels of ${name}`, () => {
      const text = load(name);
      const p = readProject(text);
      const ed = new Editor(p, () => {});
      const r = ed.arrangeLabels();
      // Every label found a clear spot.
      expect(r.crowded).toEqual([]);
      // A second run finds nothing more to move.
      const again = ed.arrangeLabels();
      expect(again.moved).toEqual([]);
      if (r.moved.length) {
        ed.undo();
        expect(writeProject(p)).toBe(text);
      }
    });
  }

  it('leaves autoplaced boards with nothing to move (Place arranges labels too)', () => {
    for (const name of ['wwvbfind-placed', 'wwvbfind2-placed']) {
      const r = new Editor(readProject(load(name)), () => {}).arrangeLabels();
      expect(r).toEqual({ moved: [], crowded: [] });
    }
  });
});
