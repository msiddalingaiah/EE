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

export function fmtXY(x: number, y: number): string {
  return `(${fmtNum(x)}, ${fmtNum(y)}) mm`;
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
