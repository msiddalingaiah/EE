// Passthrough: Eagle XML that the native model doesn't represent, kept as JsonML so it
// survives import and can be written back on export (docs/format.md, "Passthrough").

import { domOf } from '../eagle/dom';
import type { JsonML, ObjectPassthrough } from './types';

/** XML element → JsonML: ["tag", {attributes}?, ...children]; blank text between elements is dropped. */
export function toJsonML(el: Element): JsonML {
  const out: JsonML = [el.tagName];
  if (el.attributes.length) {
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    out.push(attrs);
  }
  for (let c: ChildNode | null = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(toJsonML(c as Element));
    else if (c.nodeType === 3 || c.nodeType === 4) {
      const t = c.nodeValue ?? '';
      if (!/^\s*$/.test(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Attributes and child elements of `obj`'s XML element that the model doesn't cover.
 * `attrs`: attribute names the model represents; `children`: child tags it represents.
 */
export function extrasOf(obj: object, attrs: readonly string[], children: readonly string[] = []): ObjectPassthrough | undefined {
  const el = domOf(obj);
  if (!el) return undefined;
  const out: ObjectPassthrough = {};
  for (const a of Array.from(el.attributes)) {
    if (!attrs.includes(a.name)) (out.attrs ??= {})[a.name] = a.value;
  }
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (!children.includes(c.tagName)) (out.children ??= []).push(toJsonML(c));
  }
  return out.attrs || out.children ? out : undefined;
}

/** Child elements of `el` not in `known`, as JsonML (for document-level passthrough). */
export function unknownChildren(el: Element | null | undefined, known: readonly string[]): JsonML[] {
  const out: JsonML[] = [];
  for (let c = el?.firstElementChild; c; c = c.nextElementSibling) {
    if (!known.includes(c.tagName)) out.push(toJsonML(c));
  }
  return out;
}
