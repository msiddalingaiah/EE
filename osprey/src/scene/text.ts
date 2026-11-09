// Text helpers: placeholder substitution and formatting.

import type { PlacedAttribute, Rotation } from '../eagle/types';

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

/** The visible text of a smashed attribute according to its display mode. */
export function placedAttributeText(a: PlacedAttribute, value: string | undefined): string | undefined {
  switch (a.display) {
    case 'off': return undefined;
    case 'name': return a.name;
    case 'both': return `${a.name} = ${value ?? ''}`;
    case 'value': return value || undefined;
  }
}

export function fmtNum(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

export function fmtXY(x: number, y: number): string {
  return `(${fmtNum(x)}, ${fmtNum(y)}) mm`;
}

export function fmtRot(r: Rotation): string {
  return `${r.spin ? 'S' : ''}${r.mirror ? 'M' : ''}R${fmtNum(r.angle)}`;
}
