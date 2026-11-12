// Reading and writing `.osprey` files: JSON in a canonical layout (docs/format.md):
// keys in a fixed order, one record per line, numbers to 1 nm, LF line endings.
// The same project always produces the same bytes, so git diffs show real changes only.

import { FORMAT_VERSION, type Project } from './types';

export class OspreyFormatError extends Error {}

// ---------------------------------------------------------------------------
// Key order

/**
 * Global key order. Identity keys first, then the shape key (so a graphic line starts with
 * what it is), then geometry, style, and finally collections. Unknown keys go last, in the
 * order they were found.
 */
const KEY_ORDER = [
  // top level
  'osprey', 'project',
  // identity
  'id', 'number', 'name', 'attr', 'part', 'gate', 'pin', 'pad', 'sheet',
  // shape keys
  'line', 'circle', 'rect', 'polygon', 'text', 'hole', 'frame', 'smd',
  // geometry and properties
  'at', 'radius', 'drill', 'diameter', 'shape', 'first', 'roundness', 'side', 'mask', 'paste',
  'thermals', 'rot', 'mirror', 'spin', 'length', 'direction', 'function', 'visible', 'swap',
  'size', 'width', 'layer', 'layers', 'curve', 'cap', 'style', 'ratio', 'align', 'font',
  'display', 'xref', 'pour', 'isolate', 'spacing', 'rank', 'orphans', 'columns', 'rows',
  'component', 'variant', 'technology', 'value', 'constant', 'prefix', 'userValue', 'symbol',
  'footprint', 'addLevel', 'class', 'locked', 'smashed', 'step', 'fine', 'unit',
  'description', 'imported', 'from', 'date', 'eagleVersion', 'attributes', 'grid', 'approved',
  // collections
  'graphics', 'pins', 'pads', 'gates', 'variants', 'technologies', 'labels', 'segments', 'wires',
  'junctions', 'traces', 'vias', 'pours', 'classes', 'symbols', 'footprints', 'components',
  'sheets', 'drawing', 'library', 'parts', 'nets', 'busses', 'schematic', 'board',
  // passthrough always last
  'attrs', 'children', 'eagle',
];
const RANK = new Map(KEY_ORDER.map((k, i) => [k, i]));

function orderedKeys(o: Record<string, unknown>): string[] {
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  return keys
    .map((k, i) => ({ k, i, r: RANK.get(k) ?? KEY_ORDER.length }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.k);
}

// ---------------------------------------------------------------------------
// Writing

/** Serialize a project in the canonical layout. */
export function writeProject(p: Project): string {
  return write(p, 0, true) + '\n';
}

const pad = (n: number) => '  '.repeat(n);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JsonML element: ["tag", {attrs}?, ...children] with at least one attribute object or child element. */
function isJsonML(v: unknown): v is unknown[] {
  return Array.isArray(v) && typeof v[0] === 'string' && v.length >= 2 && (isObject(v[1]) || Array.isArray(v[1]));
}

/** Does this value need several lines (it holds records or XML elements)? */
function isBlock(v: unknown): boolean {
  if (Array.isArray(v)) return isJsonML(v) ? v.slice(1).some((c) => Array.isArray(c)) : v.some((x) => isObject(x) || isJsonML(x) || isBlock(x));
  if (isObject(v)) return Object.values(v).some(isBlock);
  return false;
}

/** Lengths to 1 nm; no "-0"; JSON number syntax. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new OspreyFormatError(`Not a finite number: ${n}`);
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

function write(v: unknown, indent: number, top = false): string {
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v !== 'object' || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (isJsonML(v)) return writeJsonML(v, indent);
    if (!isBlock(v)) return `[${v.map((x) => write(x, indent)).join(', ')}]`;
    return `[\n${v.map((x) => pad(indent + 1) + write(x, indent + 1)).join(',\n')}\n${pad(indent)}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = orderedKeys(o);
  const entry = (k: string, at: number) => `${JSON.stringify(k)}: ${write(o[k], at)}`;
  if (!keys.length) return '{}';
  if (top) return `{\n${keys.map((k) => pad(indent + 1) + entry(k, indent + 1)).join(',\n')}\n${pad(indent)}}`;
  if (!keys.some((k) => isBlock(o[k]))) return `{ ${keys.map((k) => entry(k, indent)).join(', ')} }`;
  // A record with collections: its simple fields on the first line, collections below.
  const simple = keys.filter((k) => !isBlock(o[k]));
  const block = keys.filter((k) => isBlock(o[k]));
  const head = simple.length ? `{ ${simple.map((k) => entry(k, indent)).join(', ')},\n` : '{\n';
  return `${head}${block.map((k) => pad(indent + 1) + entry(k, indent + 1)).join(',\n')}\n${pad(indent)}}`;
}

/** JsonML: the element and its attributes on one line, child elements on the lines below. */
function writeJsonML(v: unknown[], indent: number): string {
  const [tag, ...rest] = v;
  const head = [JSON.stringify(tag)];
  let children = rest;
  if (isObject(rest[0])) {
    head.push(write(rest[0], indent));
    children = rest.slice(1);
  }
  if (!children.some((c) => Array.isArray(c))) {
    return `[${[...head, ...children.map((c) => JSON.stringify(c))].join(', ')}]`;
  }
  const lines = children.map((c) => pad(indent + 1) + (Array.isArray(c) ? writeJsonML(c, indent + 1) : JSON.stringify(c)));
  return `[${head.join(', ')},\n${lines.join(',\n')}]`;
}

// ---------------------------------------------------------------------------
// Reading

/**
 * Parse a `.osprey` file. Checks the format version and the presence of the required
 * sections; unknown fields are kept (they are written back unchanged).
 */
export function readProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new OspreyFormatError(`Not a valid Osprey file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(data) || typeof data.osprey !== 'number') {
    throw new OspreyFormatError('Not an Osprey project (no "osprey" version field)');
  }
  if (data.osprey > FORMAT_VERSION) {
    throw new OspreyFormatError(`This project uses format version ${data.osprey}; this Osprey supports up to ${FORMAT_VERSION}. Update Osprey to open it.`);
  }
  const need = (cond: boolean, what: string) => {
    if (!cond) throw new OspreyFormatError(`Damaged Osprey project: ${what}`);
  };
  need(isObject(data.project) && typeof data.project.name === 'string', 'missing project name');
  need(isObject(data.library), 'missing library');
  const lib = data.library as Record<string, unknown>;
  for (const k of ['symbols', 'footprints', 'components']) need(Array.isArray(lib[k]), `library has no ${k}`);
  need(Array.isArray(data.parts), 'missing parts');
  need(Array.isArray(data.nets), 'missing nets');
  need(data.schematic !== undefined || data.board !== undefined, 'neither a schematic nor a board');
  return data as unknown as Project;
}
