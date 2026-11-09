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

/**
 * Display settings for every layer: Eagle's usual colours and fill patterns, named by role.
 * Projects don't store display settings (docs/format.md), so these are the defaults.
 * [number, name, colour index, fill pattern, visible]
 */
const DISPLAY: [number, string, number, number, boolean][] = [
  [1, 'copper.top', 4, 1, true], [16, 'copper.bottom', 1, 1, true],
  [17, 'pads', 2, 1, true], [18, 'vias', 2, 1, true], [19, 'airwires', 6, 1, true],
  [20, 'outline', 7, 1, true],
  [21, 'silk.top', 7, 1, true], [22, 'silk.bottom', 7, 1, true],
  [23, 'origins.top', 15, 1, false], [24, 'origins.bottom', 15, 1, false],
  [25, 'names.top', 7, 1, true], [26, 'names.bottom', 7, 1, true],
  [27, 'values.top', 7, 1, true], [28, 'values.bottom', 7, 1, true],
  [29, 'mask.top', 7, 3, false], [30, 'mask.bottom', 7, 6, false],
  [31, 'paste.top', 7, 4, false], [32, 'paste.bottom', 7, 5, false],
  [33, 'finish.top', 6, 3, false], [34, 'finish.bottom', 6, 6, false],
  [35, 'glue.top', 7, 4, false], [36, 'glue.bottom', 7, 5, false],
  [37, 'test.top', 7, 1, false], [38, 'test.bottom', 7, 1, false],
  [39, 'keepout.top', 4, 11, true], [40, 'keepout.bottom', 1, 11, true],
  [41, 'restrict.top', 4, 10, true], [42, 'restrict.bottom', 1, 10, true], [43, 'restrict.vias', 2, 10, true],
  [44, 'drills', 7, 1, false], [45, 'holes', 7, 1, true], [46, 'milling', 3, 1, true],
  [47, 'measures', 7, 1, false], [48, 'document', 7, 1, true], [49, 'reference', 7, 1, false],
  [51, 'fab.top', 7, 1, true], [52, 'fab.bottom', 7, 1, true],
  [91, 'nets', 2, 1, true], [92, 'busses', 1, 1, true], [93, 'pins', 2, 1, false],
  [94, 'symbols', 4, 1, true], [95, 'names', 7, 1, true], [96, 'values', 7, 1, true],
  [97, 'info', 7, 1, true], [98, 'guide', 6, 1, true],
];
for (let n = 2; n <= 15; n++) DISPLAY.push([n, `copper.in${n - 1}`, n % 2 ? 3 : 5, 1, true]);

/** The display layer table (Eagle numbers, Osprey names), plus any extra user layers in use. */
export function displayLayers(extra: Iterable<number> = []): Layer[] {
  const out: Layer[] = DISPLAY.map(([number, name, color, fill, visible]) => ({ number, name, color, fill, visible, active: true }));
  for (const n of extra) {
    if (!out.some((l) => l.number === n)) out.push({ number: n, name: `eagle.${n}`, color: 7, fill: 1, visible: true, active: true });
  }
  return out.sort((a, b) => a.number - b.number);
}
