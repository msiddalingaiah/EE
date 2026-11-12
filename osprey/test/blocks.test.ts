// Blocks: paths in a part's BLOCK attribute, and the outlines drawn around them.

import { describe, expect, it } from 'vitest';
import type { BlockItem } from '../src/model/blocks';
import { blockAncestry, blockOutlines, blockPaths, comparePaths, normalizeBlockPath } from '../src/model/blocks';
import type * as O from '../src/model/types';

const OPTS = { cell: 0.5, margin: 1, nest: 1, close: 2, keepOut: 0.5 };
const box = (block: string | undefined, x: number, y: number, w = 2, h = 2): BlockItem => ({ ...(block ? { block } : {}), minX: x, minY: y, maxX: x + w, maxY: y + h });

/** Area of a ring (positive counter-clockwise). */
const area = (r: { x: number; y: number }[]) => r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length]!;
  return s + (p.x * q.y - q.x * p.y) / 2;
}, 0);
/** Is a point inside the rings (even-odd)? */
const inside = (rings: { x: number; y: number }[][], x: number, y: number) => rings.reduce((n, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!;
    const b = r[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return n + (c ? 1 : 0);
}, 0) % 2 === 1;

describe('block paths', () => {
  it('tidies a typed path', () => {
    expect(normalizeBlockPath(' rx /  front   end/ ')).toBe('rx/front end');
    expect(normalizeBlockPath(' / ')).toBe('');
  });

  it('lists every block with its parents, parents first', () => {
    const p = { parts: [
      { name: 'R1', attributes: { BLOCK: 'rx/frontend' } },
      { name: 'R2', attributes: { BLOCK: 'mcu' } },
      { name: 'R3' },
    ] } as unknown as O.Project;
    expect(blockPaths(p)).toEqual(['mcu', 'rx', 'rx/frontend']);
    expect(blockAncestry('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(['a/b', 'a', 'a-b'].sort(comparePaths)).toEqual(['a', 'a/b', 'a-b']);
  });
});

describe('block outlines', () => {
  it('draws one right-angled outline around a block, filling small gaps between its parts', () => {
    const [o, ...rest] = blockOutlines([box('a', 0, 0), box('a', 3, 0), box('a', 0, 3)], OPTS);
    expect(rest).toEqual([]);
    expect(o!.rings).toHaveLength(1);
    const ring = o!.rings[0]!;
    expect(area(ring)).toBeGreaterThan(0);
    // Every edge is horizontal or vertical.
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
    });
    // The parts, their margin, and the gap between them are inside.
    for (const [x, y] of [[1, 1], [4, 1], [1, 4], [2.5, 1], [-0.75, 1]]) expect(inside(o!.rings, x!, y!)).toBe(true);
    expect(o!.corner).toEqual({ x: -1, y: 6 });
  });

  it('keeps parts outside the block out of its outline', () => {
    // An outsider sits in the gap the block would close over.
    const [o] = blockOutlines([box('a', 0, 0), box('a', 4, 0), box(undefined, 2, 0, 2, 2)], { ...OPTS, close: 3 });
    expect(inside(o!.rings, 3, 1)).toBe(false);
    expect(inside(o!.rings, 1, 1)).toBe(true);
    expect(inside(o!.rings, 5, 1)).toBe(true);
  });

  it('nests a child block inside its parent, with a gap between the outlines', () => {
    const out = blockOutlines([box('p/c', 0, 0), box('p', 10, 0)], OPTS);
    expect(out.map((o) => [o.path, o.depth])).toEqual([['p', 0], ['p/c', 1]]);
    const [p, c] = out;
    // The child's outline (1 mm around its part) lies within the parent's, a further 1 mm out.
    expect(inside(c!.rings, -0.75, 1)).toBe(true);
    expect(inside(p!.rings, -1.75, 1)).toBe(true);
    expect(inside(c!.rings, -1.75, 1)).toBe(false);
    expect(inside(p!.rings, 11, 1)).toBe(true);
  });

  it('draws apart blocks as separate rings', () => {
    const [o] = blockOutlines([box('a', 0, 0), box('a', 20, 0)], OPTS);
    expect(o!.rings).toHaveLength(2);
  });
});
