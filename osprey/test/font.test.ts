// Board text in Roboto: layout, boldness, and CAM regions without holes.

import { describe, expect, it } from 'vitest';
import { textRegions } from '../src/cam/text';
import { boldness, layout, lineWidth, strokeWidth, textCorners, textOutlines, unitScale } from '../src/scene/font';
import { FONT } from '../src/scene/font-data';

const area = (pts: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

describe('layout', () => {
  it('advances by each glyph\'s width; alignment moves the line', () => {
    const w = lineWidth('RF', 1);
    expect(w).toBeCloseTo((FONT.glyphs.R![0] + FONT.glyphs.F![0]) * unitScale(1), 9);
    expect(layout('RF', 1, 'bottom-left').map((g) => [g.ch, g.x, g.y])).toEqual([['R', 0, 0], ['F', FONT.glyphs.R![0] * unitScale(1), 0]]);
    expect(layout('RF', 1, 'bottom-right')[0]!.x).toBeCloseTo(-w, 9);
    expect(layout('RF', 1, 'center')[0]!.x).toBeCloseTo(-w / 2, 9);
  });

  it('places lines 1.5 × size apart, anchored as the canvas text was', () => {
    const y = (align: Parameters<typeof layout>[2]) => [...new Set(layout('A\nB', 2, align).map((g) => g.y))];
    expect(y('bottom-left')).toEqual([3, 0]);
    expect(y('top-left')).toEqual([-2, -5]);
    expect(y('center-left')).toEqual([0.5, -2.5]);
  });

  it('measures its box with real widths, rotated', () => {
    const c = textCorners({ x: 10, y: 5, text: 'RF', size: 1, angle: 90, mirror: false, align: 'bottom-left' });
    expect(c[0]!.x).toBeCloseTo(10, 9);
    expect(c[1]!.y).toBeCloseTo(5 + lineWidth('RF', 1), 9);
  });

  it('cap height is 85% of the size; an unknown character draws as a box', () => {
    const ys = textOutlines({ x: 0, y: 0, text: 'H', size: 1, angle: 0, mirror: false, align: 'bottom-left' }).flat().map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo((FONT.capHeight / FONT.unitsPerEm) * 1.2, 3);
    expect(textOutlines({ x: 0, y: 0, text: '中', size: 1, angle: 0, mirror: false, align: 'bottom-left' }).length).toBeGreaterThan(0);
  });
});

describe('boldness', () => {
  it('Roboto\'s own strokes unless the ratio asks for wider ones', () => {
    expect(boldness(1)).toBe(0);
    expect(strokeWidth(1)).toBeCloseTo(FONT.stem * unitScale(1), 9);
    expect(strokeWidth(1, 30)).toBeCloseTo(0.3, 9);
  });
});

describe('CAM text regions', () => {
  const text = { x: 3, y: 4, text: 'o8B', size: 2, angle: 30, mirror: false, align: 'center' as const };

  it('have no holes, and cover the same area as the letters', () => {
    const regions = textRegions(text);
    expect(regions.every((r) => area(r) > 0)).toBe(true);
    // Letters: outer rings minus their counters (TrueType outer rings run clockwise).
    const letters = textOutlines(text).reduce((a, c) => a + area(c), 0);
    expect(regions.reduce((a, r) => a + area(r), 0)).toBeCloseTo(Math.abs(letters), 3);
  });

  it('a larger ratio makes them bolder', () => {
    const plain = textRegions(text).reduce((a, r) => a + area(r), 0);
    const bold = textRegions({ ...text, ratio: 25 }).reduce((a, r) => a + area(r), 0);
    expect(bold).toBeGreaterThan(plain * 1.3);
  });
});
