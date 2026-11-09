// Eagle's colour palette (dark background) and layer drawing order.

import type { Layer } from '../eagle/types';

/** Eagle's 16 base colours for the black-background palette. */
const BASE = [
  '#000000', '#3232c8', '#32c832', '#32c8c8', '#c83232', '#c832c8', '#c8c832', '#c8c8c8',
  '#646464', '#0000ff', '#00ff00', '#00ffff', '#ff0000', '#ff00ff', '#ffff00', '#ffffff',
];

export const BACKGROUND = '#0d0f12';

/** Colour for an Eagle palette index. Indices beyond 15 (Eagle 9's extended palette) fold onto the base set. */
export function paletteColor(index: number): string {
  const c = BASE[index % 16] ?? '#c8c8c8';
  return c === '#000000' ? '#c8c8c8' : c;
}

export function layerColor(layer: Layer | undefined): string {
  return layer ? paletteColor(layer.color) : '#c8c8c8';
}

const BOTTOM_SIDE = new Set([22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 52]);

/** Sort key so that bottom-side layers draw first and top copper, pads and vias draw above them. */
export function layerOrder(n: number): number {
  if (BOTTOM_SIDE.has(n)) return 0;
  if (n === 16) return 1;
  if (n >= 2 && n <= 15) return 2 + (15 - n) / 100;
  if (n === 1) return 3;
  if (n === 17) return 4;
  if (n === 18) return 5;
  return 10 + n;
}

/** Copper layers are drawn slightly translucent so overlaps stay visible. */
export function layerAlpha(n: number): number {
  return n >= 1 && n <= 16 ? 0.8 : 1;
}

export function layerName(layers: Layer[], n: number): string {
  return layers.find((l) => l.number === n)?.name ?? `Layer ${n}`;
}
