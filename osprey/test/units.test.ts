// Positions are shown in mm and in inches (to the thousandth).

import { expect, it } from 'vitest';
import { fmtIn, fmtXY, parsePt } from '../src/scene/text';

it('reads a typed point in mm, inches or mils', () => {
  expect(parsePt('10.16, 5.08')).toEqual([10.16, 5.08]);
  expect(parsePt('10.16mm 5.08mm')).toEqual([10.16, 5.08]);
  expect(parsePt('0.4in, 0.2in')).toEqual([10.16, 5.08]);
  expect(parsePt('0.4, 0.2 in')).toEqual([10.16, 5.08]);
  expect(parsePt('0.4", 0.2"')).toEqual([10.16, 5.08]);
  expect(parsePt('400mil, -200mil')).toEqual([10.16, -5.08]);
  expect(parsePt('1, 2, 3')).toBeUndefined();
});

it('shows a position in mm and inches', () => {
  expect(fmtXY(10.16, 5.08)).toBe('(10.16, 5.08) mm · (0.400, 0.200) in');
  expect(fmtXY(-2.54, 0)).toBe('(-2.54, 0) mm · (-0.100, 0.000) in');
  expect(fmtIn(1)).toBe('0.039');
});
