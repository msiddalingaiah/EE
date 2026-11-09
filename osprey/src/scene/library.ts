// Build a Scene showing one item (symbol, package or device set) from a library.

import type { EagleFile } from '../eagle/types';
import type { Transform } from '../geom/transform';
import { IDENTITY, placement } from '../geom/transform';
import { DesignRules } from './board';
import { SceneBuilder, type EmitContext } from './builder';
import { buildSymbolInto } from './symbol';
import type { Scene } from './types';

export type LibraryItemKind = 'deviceset' | 'symbol' | 'package';

export interface LibraryItemRef {
  kind: LibraryItemKind;
  name: string;
}


export function buildLibraryScene(file: EagleFile, item: LibraryItemRef): Scene {
  const lib = file.library;
  if (!lib) throw new Error('Not a library');
  const b = new SceneBuilder('library', file.layers);
  const id = `library-item:${item.kind}:${item.name}`;

  switch (item.kind) {
    case 'symbol': {
      const sym = lib.symbols.get(item.name);
      if (!sym) break;
      b.addOwner({
        id, kind: 'library-item', label: `Symbol ${sym.name}`,
        props: [['Symbol', sym.name], ['Pins', String(sym.pins.length)], ['Description', plain(sym.description)]],
      });
      buildSymbolInto(b, sym, IDENTITY, id, new Map(), (t) => t);
      break;
    }
    case 'package': {
      const pkg = lib.packages.get(item.name);
      if (!pkg) break;
      b.addOwner({
        id, kind: 'library-item', label: `Package ${pkg.name}`,
        props: [['Package', pkg.name], ['Pads', String(pkg.pads.length)], ['Description', plain(pkg.description)]],
      });
      const rules = new DesignRules(new Map());
      const ctx: EmitContext = { owner: id, transform: IDENTITY, textContext: 'board' };
      b.graphics(pkg.graphics, ctx);
      for (const p of pkg.pads) {
        if (p.kind === 'smd') b.smd(p, ctx);
        else {
          const elong = p.shape === 'long' || p.shape === 'offset' ? rules.elongation(p.shape) : 0;
          b.pad(p, rules.padDiameter(p.drill, p.diameter), elong, ctx);
        }
      }
      break;
    }
    case 'deviceset': {
      const ds = lib.devicesets.get(item.name);
      if (!ds) break;
      const device = ds.devices[0];
      b.addOwner({
        id, kind: 'library-item', label: `Device set ${ds.name}`,
        props: [
          ['Device set', ds.name],
          ['Prefix', ds.prefix],
          ['Gates', ds.gates.map((g) => g.name).join(', ')],
          ['Devices', ds.devices.map((d) => `${d.name || "''"}${d.package ? ` (${d.package})` : ''}`).join(', ')],
          ['Description', plain(ds.description)],
        ],
      });
      for (const gate of ds.gates) {
        const sym = lib.symbols.get(gate.symbol);
        if (!sym) continue;
        const T: Transform = placement(gate.x, gate.y, { angle: 0, mirror: false, spin: false });
        const pads = new Map<string, string>();
        for (const c of device?.connects ?? []) if (c.gate === gate.name) pads.set(c.pin, c.pads.join(' '));
        const name = ds.gates.length > 1 ? `${ds.prefix}1${gate.name}` : `${ds.prefix}1`;
        buildSymbolInto(b, sym, T, id, pads, (t) => {
          const k = t.toUpperCase();
          if (k === '>NAME') return name;
          if (k === '>VALUE') return ds.name;
          if (k === '>GATE') return gate.name;
          return t;
        });
      }
      break;
    }
  }
  return b.finish();
}

/** Strip HTML tags from Eagle descriptions for display. */
function plain(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
