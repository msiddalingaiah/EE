// Eagle layer numbers ↔ Osprey layer names (see docs/format.md, "Layers").

const NAMES: Record<number, string> = {
  1: 'copper.top', 16: 'copper.bottom',
  20: 'outline',
  21: 'silk.top', 22: 'silk.bottom',
  23: 'origins.top', 24: 'origins.bottom',
  25: 'names.top', 26: 'names.bottom',
  27: 'values.top', 28: 'values.bottom',
  29: 'mask.top', 30: 'mask.bottom',
  31: 'paste.top', 32: 'paste.bottom',
  33: 'finish.top', 34: 'finish.bottom',
  35: 'glue.top', 36: 'glue.bottom',
  37: 'test.top', 38: 'test.bottom',
  39: 'keepout.top', 40: 'keepout.bottom',
  41: 'restrict.top', 42: 'restrict.bottom', 43: 'restrict.vias',
  44: 'drills', 45: 'holes', 46: 'milling', 47: 'measures', 48: 'document', 49: 'reference',
  51: 'fab.top', 52: 'fab.bottom',
  91: 'nets', 92: 'busses', 93: 'pins', 94: 'symbols', 95: 'names', 96: 'values', 97: 'info', 98: 'guide',
};
for (let n = 2; n <= 15; n++) NAMES[n] = `copper.in${n - 1}`;

const NUMBERS = new Map(Object.entries(NAMES).map(([n, name]) => [name, Number(n)]));

/** Is this one of Eagle's standard layers (as opposed to a user-defined one)? */
export function isStandardLayer(n: number): boolean {
  return n in NAMES || (n >= 17 && n <= 19) || n === 50 || n === 99;
}

/** Osprey name for an Eagle layer number; unknown layers keep their number as "eagle.N". */
export function layerName(n: number): string {
  return NAMES[n] ?? `eagle.${n}`;
}

/** Eagle layer number for an Osprey layer name. */
export function layerNumber(name: string): number {
  const n = NUMBERS.get(name);
  if (n !== undefined) return n;
  const m = /^eagle\.(\d+)$/.exec(name);
  if (m) return Number(m[1]);
  throw new Error(`Unknown layer "${name}"`);
}
