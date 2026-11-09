// Build a Scene showing one item (component, symbol or footprint) of a library (native model).

import type { Layer } from '../eagle/types';
import { IDENTITY, placement } from '../geom/transform';
import { componentName } from '../model/derive';
import type * as O from '../model/types';
import { DesignRules } from './board';
import { SceneBuilder, type EmitContext } from './builder';
import { splitPinKey } from './schematic';
import { buildSymbolInto } from './symbol';
import type { Scene } from './types';

export type LibraryItemKind = 'component' | 'symbol' | 'footprint';

export interface LibraryItemRef {
  kind: LibraryItemKind;
  /** Item id ("library/name"). */
  id: string;
}

export function buildLibraryScene(lib: O.Library, layers: Layer[], item: LibraryItemRef): Scene {
  const b = new SceneBuilder('library', layers);
  const owner = `library-item:${item.kind}:${item.id}`;
  const name = componentName(item.id);

  switch (item.kind) {
    case 'symbol': {
      const sym = lib.symbols.find((s) => s.id === item.id);
      if (!sym) break;
      b.addOwner({
        id: owner, kind: 'library-item', label: `Symbol ${name}`,
        props: [['Symbol', name], ['Pins', String(sym.pins.length)], ['Description', plain(sym.description)]],
      });
      buildSymbolInto(b, sym, IDENTITY, owner, new Map(), (t) => t);
      break;
    }
    case 'footprint': {
      const fp = lib.footprints.find((f) => f.id === item.id);
      if (!fp) break;
      b.addOwner({
        id: owner, kind: 'library-item', label: `Footprint ${name}`,
        props: [['Footprint', name], ['Pads', String(fp.pads.length)], ['Description', plain(fp.description)]],
      });
      const rules = new DesignRules(new Map());
      const ctx: EmitContext = { owner, transform: IDENTITY, textContext: 'board' };
      b.graphics(fp.graphics, ctx);
      for (const pad of fp.pads) b.pad(pad, ctx, (d, dia) => rules.padDiameter(d, dia), (s) => rules.elongation(s));
      break;
    }
    case 'component': {
      const c = lib.components.find((x) => x.id === item.id);
      if (!c) break;
      const variant = c.variants[0];
      b.addOwner({
        id: owner, kind: 'library-item', label: `Component ${name}`,
        props: [
          ['Component', name],
          ['Prefix', c.prefix ?? ''],
          ['Gates', c.gates.map((g) => g.name).join(', ')],
          ['Variants', c.variants.map((v) => `${v.name || "''"}${v.footprint ? ` (${componentName(v.footprint)})` : ''}`).join(', ')],
          ['Description', plain(c.description)],
        ],
      });
      for (const gate of c.gates) {
        const sym = lib.symbols.find((s) => s.id === gate.symbol);
        if (!sym) continue;
        const pads = new Map<string, string>();
        for (const [key, list] of Object.entries(variant?.pads ?? {})) {
          const [g, pin] = splitPinKey(key);
          if (g === gate.name) pads.set(pin, list.join(' '));
        }
        const prefix = c.prefix ?? '';
        const shown = c.gates.length > 1 ? `${prefix}1${gate.name}` : `${prefix}1`;
        buildSymbolInto(b, sym, placement(gate.at[0], gate.at[1], { angle: 0, mirror: false, spin: false }), owner, pads, (t) => {
          const k = t.toUpperCase();
          if (k === '>NAME') return shown;
          if (k === '>VALUE') return name;
          if (k === '>GATE') return gate.name;
          return t;
        });
      }
      break;
    }
  }
  return b.finish();
}

/** Strip HTML tags from descriptions for display. */
function plain(html: string | undefined): string {
  return (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
