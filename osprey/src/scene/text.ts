// Text helpers: placeholder substitution, smashed labels, and formatting.

import { objId } from '../eagle/dom';
import type * as O from '../model/types';
import type { Owner } from './types';

/**
 * Returns a function that replaces Eagle placeholders (">NAME", ">VALUE", ">ANY_ATTR")
 * with their values. Matching is case-insensitive; unknown placeholders are kept verbatim.
 */
export function placeholderResolver(values: Record<string, string>): (text: string) => string | undefined {
  const upper = new Map(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v]));
  return (text) => {
    if (!text.startsWith('>')) return text;
    const v = upper.get(text.slice(1).trim().toUpperCase());
    return v ?? text;
  };
}

/** The visible text of a smashed label according to its display mode. */
export function labelText(l: O.Label, value: string | undefined): string | undefined {
  switch (l.display) {
    case 'none': return undefined;
    case 'name': return l.attr;
    case 'both': return `${l.attr} = ${value ?? ''}`;
    default: return value || undefined;
  }
}

export function fmtNum(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** A length in mm as inches, to the thousandth (a mil). */
export function fmtIn(mm: number): string {
  return (mm / 25.4).toFixed(3);
}

/** A position in mm and in inches: "(10.16, 5.08) mm · (0.400, 0.200) in". */
export function fmtXY(x: number, y: number): string {
  return `(${fmtNum(x)}, ${fmtNum(y)}) mm · (${fmtIn(x)}, ${fmtIn(y)}) in`;
}

export function fmtRot(rot: number | undefined, mirror?: boolean, spin?: boolean): string {
  return `${spin ? 'S' : ''}${mirror ? 'M' : ''}R${fmtNum(rot ?? 0)}`;
}

/** Owner for a smashed name/value text of a part. */
export function labelOwner(
  l: O.Label, partName: string, doc: 'schematic' | 'board', placement: O.GatePlacement | O.FootprintPlacement,
): Owner {
  return {
    id: `label:${objId(l)}`,
    kind: 'label',
    label: `${partName} ${l.attr.toLowerCase()}`,
    props: [
      ['Part', partName],
      ['Attribute', l.attr],
      ['Position', fmtXY(l.at[0], l.at[1])],
      ['Rotation', fmtRot(l.rot, l.mirror, l.spin)],
      ['Size', `${fmtNum(l.size)} mm`],
      ['Layer', l.layer],
    ],
    target: { kind: 'label', doc, placement, label: l },
    origin: { x: l.at[0], y: l.at[1] },
  };
}

/**
 * A point as typed in the inspector: "x, y" in mm (a space works too), or in inches or mils
 * with a unit ("0.4in, 0.2in", "400mil 200mil"; a unit after the second number covers both).
 */
export function parsePt(v: string): [number, number] | undefined {
  const unit = '(mm|in|"|mil)?';
  const m = new RegExp(`^\\s*(-?\\d*\\.?\\d+)\\s*${unit}\\s*[,\\s]\\s*(-?\\d*\\.?\\d+)\\s*${unit}\\s*$`, 'i').exec(v);
  if (!m) return undefined;
  const scale = (u: string | undefined) => {
    const k = u?.toLowerCase();
    return k === 'in' || k === '"' ? 25.4 : k === 'mil' ? 0.0254 : 1;
  };
  const uy = m[4];
  const ux = m[2] ?? uy;
  const mm = (n: string, u: string | undefined) => Math.round(Number(n) * scale(u) * 1e6) / 1e6;
  return [mm(m[1]!, ux), mm(m[3]!, uy)];
}
