import { describe, expect, it } from 'vitest';
import { arcContainsAngle, arcFromChord } from '../src/geom/arc';
import { angleOf, apply, compose, composeRotation, invert, isMirrored, placement } from '../src/geom/transform';
import { readableText } from '../src/scene/builder';

const rot = (angle: number, mirror = false, spin = false) => ({ angle, mirror, spin });

describe('placement transforms', () => {
  it('rotates CCW about the origin, then translates', () => {
    const p = apply(placement(10, 20, rot(90)), 1, 0);
    expect(p).toEqual({ x: 10, y: 21 });
  });

  it('rotates, then mirrors about Y (Eagle "MR" convention)', () => {
    const t = placement(0, 0, rot(90, true));
    // (0,1) -> R90 -> (-1,0) -> mirror -> (1,0)
    const p = apply(t, 0, 1);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(0);
    expect(isMirrored(t)).toBe(true);
    expect(angleOf(t)).toBe(90);
  });

  it('composes and inverts', () => {
    const a = placement(5, 3, rot(90));
    const b = placement(1, 2, rot(180, true));
    const ab = compose(a, b);
    const p = apply(ab, 3, 4);
    const q = apply(a, ...(Object.values(apply(b, 3, 4)) as [number, number]));
    expect(p.x).toBeCloseTo(q.x);
    expect(p.y).toBeCloseTo(q.y);
    const back = apply(invert(ab), p.x, p.y);
    expect(back.x).toBeCloseTo(3);
    expect(back.y).toBeCloseTo(4);
  });

  it('combines rotations through a mirrored parent', () => {
    // mirrored parent MR90 = M·R90; with child R90: M·R180
    expect(composeRotation(placement(0, 0, rot(90, true)), rot(90))).toEqual(rot(180, true));
    // a child MR90 under an unmirrored R90 parent: R90·M·R90 = M·R(-90)·R90 = M·R0
    expect(composeRotation(placement(0, 0, rot(90)), rot(90, true))).toEqual(rot(0, true));
    // child mirror cancels parent mirror
    expect(composeRotation(placement(0, 0, rot(0, true)), rot(0, true))).toEqual(rot(0, false));
  });
});

describe('arcs', () => {
  it('finds the centre of a 90° CCW arc', () => {
    const a = arcFromChord({ x: 1, y: 0 }, { x: 0, y: 1 }, 90);
    expect(a.cx).toBeCloseTo(0);
    expect(a.cy).toBeCloseTo(0);
    expect(a.r).toBeCloseTo(1);
    expect(a.start).toBeCloseTo(0);
    expect(arcContainsAngle(a, Math.PI / 4)).toBe(true);
    expect(arcContainsAngle(a, -Math.PI / 4)).toBe(false);
  });

  it('handles clockwise and 180° arcs', () => {
    const cw = arcFromChord({ x: 1, y: 0 }, { x: 0, y: -1 }, -90);
    expect(cw.cx).toBeCloseTo(0);
    expect(cw.cy).toBeCloseTo(0);
    const half = arcFromChord({ x: -1, y: 0 }, { x: 1, y: 0 }, 180);
    expect(half.cx).toBeCloseTo(0);
    expect(half.cy).toBeCloseTo(0);
    // CCW from (-1,0) to (1,0) passes through the bottom.
    expect(arcContainsAngle(half, -Math.PI / 2)).toBe(true);
  });
});

describe('text readability', () => {
  it('flips upside-down text and its alignment', () => {
    expect(readableText(rot(180), 'bottom-left', 'board')).toEqual({ angle: 0, mirror: false, align: 'top-right' });
    expect(readableText(rot(270), 'center-left', 'board')).toEqual({ angle: 90, mirror: false, align: 'center-right' });
    expect(readableText(rot(90), 'bottom-left', 'board').angle).toBe(90);
  });

  it('respects spin', () => {
    expect(readableText(rot(180, false, true), 'bottom-left', 'board')).toEqual({ angle: 180, mirror: false, align: 'bottom-left' });
  });

  it('draws mirrored schematic text unmirrored with flipped alignment', () => {
    expect(readableText(rot(0, true), 'bottom-left', 'schematic')).toEqual({ angle: 0, mirror: false, align: 'bottom-right' });
    expect(readableText(rot(0, true), 'bottom-left', 'board').mirror).toBe(true);
    // MR90 in a schematic is drawn upright at 90°, reading bottom-to-top.
    expect(readableText(rot(90, true), 'bottom-left', 'schematic')).toEqual({ angle: 90, mirror: false, align: 'top-left' });
  });
});
