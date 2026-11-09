// Links between model objects and the XML elements they were parsed from.
// Edits update both, so saving writes back the original document with only the
// edited attributes changed: everything Osprey doesn't model survives untouched.

const DOM = new WeakMap<object, Element>();
const IDS = new WeakMap<object, number>();
let nextId = 1;

/** Record that `obj` was parsed from `el`. Returns `obj`. */
export function link<T extends object>(obj: T, el: Element): T {
  DOM.set(obj, el);
  return obj;
}

/** The XML element a model object came from (undefined for synthesized objects). */
export function domOf(obj: object): Element | undefined {
  return DOM.get(obj);
}

/** A stable identity for a model object, unchanged by edits to it or its siblings. */
export function objId(obj: object): number {
  let id = IDS.get(obj);
  if (id === undefined) IDS.set(obj, (id = nextId++));
  return id;
}

/** Format a number the way Eagle writes coordinates: up to 6 decimals, no trailing zeros, no "-0". */
export function fmtCoord(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}
