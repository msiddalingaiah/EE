// Build a Scene showing one item (component, symbol or footprint) of a library (native model).

import type { Layer } from '../eagle/types';
import { IDENTITY, placement } from '../geom/transform';
import { componentName } from '../model/derive';
import type * as O from '../model/types';
import { DesignRules } from './board';
import { SceneBuilder, type EmitContext } from './builder';
import { splitPinKey } from './schematic';
import { drawingKind } from './schematic';
import { buildSymbolInto, emitPin } from './symbol';
import { fmtRot, fmtXY } from './text';
import type { Owner, Scene } from './types';
import { objId } from '../eagle/dom';

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
      // Each graphic and pin is an object of its own, to select and edit.
      for (const g of sym.graphics) {
        const id = b.addOwner(drawingOwner(g, 'schematic', sym.graphics));
        b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'schematic' });
      }
      for (const pin of sym.pins) {
        const id = b.addOwner({
          id: `pin:${objId(pin)}`, kind: 'pin', label: `Pin ${pin.name}`, origin: { x: pin.at[0], y: pin.at[1] },
          props: [
            ['Name', pin.name], ['Direction', pin.direction ?? 'io'], ['Length', pin.length ?? 'long'],
            ['Function', pin.function ?? 'none'], ['Visible', pin.visible ?? 'both'], ['Swap level', String(pin.swap ?? 0)],
            ['Position', fmtXY(pin.at[0], pin.at[1])], ['Rotation', fmtRot(pin.rot)],
          ],
          target: { kind: 'pin', symbol: sym, pin },
        });
        emitPin(b, pin, '', IDENTITY, id);
      }
      break;
    }
    case 'footprint': {
      const fp = lib.footprints.find((f) => f.id === item.id);
      if (!fp) break;
      const rules = new DesignRules(new Map());
      for (const g of fp.graphics) {
        // 'schematic': mirroring keeps a graphic on its layer (in a placed footprint it flips side).
        const id = b.addOwner(drawingOwner(g, 'schematic', fp.graphics));
        b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'board' });
      }
      for (const pad of fp.pads) {
        const id = b.addOwner({
          id: `pad:${objId(pad)}`, kind: 'pad', label: `Pad ${pad.name}`, origin: { x: pad.at[0], y: pad.at[1] },
          props: pad.smd
            ? [['Name', pad.name], ['Type', 'SMD'], ['Size', `${fmtNum(pad.smd[0])} × ${fmtNum(pad.smd[1])} mm`], ['Roundness', `${pad.roundness ?? 0}%`],
              ['Side', pad.side ?? 'top'], ['Position', fmtXY(pad.at[0], pad.at[1])], ['Rotation', fmtRot(pad.rot)]]
            : [['Name', pad.name], ['Type', 'Through-hole'], ['Drill', `${fmtNum(pad.drill ?? 0)} mm`], ['Diameter', pad.diameter ? `${fmtNum(pad.diameter)} mm` : 'auto'],
              ['Shape', pad.shape ?? 'round'], ['Position', fmtXY(pad.at[0], pad.at[1])], ['Rotation', fmtRot(pad.rot)]],
          target: { kind: 'pad', footprint: fp, pad },
        });
        const ctx: EmitContext = { owner: id, transform: IDENTITY, textContext: 'board' };
        b.pad(pad, ctx, (d, dia) => rules.padDiameter(d, dia), (s) => rules.elongation(s));
      }
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

/** A symbol's or footprint's graphic, as an object of its own. */
function drawingOwner(g: O.Graphic, doc: 'schematic' | 'board', container: O.Graphic[]): Owner {
  return {
    id: `drawing:${objId(g)}`, kind: 'drawing', label: 'text' in g ? `Text "${g.text}"` : drawingKind(g),
    props: [['Type', drawingKind(g)], ...('layer' in g && g.layer ? [['Layer', g.layer] as [string, string]] : [])],
    target: { kind: 'drawing', doc, graphic: g, container },
  };
}

const fmtNum = (n: number) => String(Math.round(n * 10000) / 10000);

/** What a library item is, for the inspector when nothing in it is selected. */
export function libraryItemProps(lib: O.Library, item: LibraryItemRef): [string, string][] {
  const name = componentName(item.id);
  if (item.kind === 'symbol') {
    const sym = lib.symbols.find((s) => s.id === item.id);
    return sym ? [['Symbol', name], ['Pins', String(sym.pins.length)], ['Description', plain(sym.description)]] : [];
  }
  if (item.kind === 'footprint') {
    const fp = lib.footprints.find((f) => f.id === item.id);
    return fp ? [['Footprint', name], ['Pads', String(fp.pads.length)], ['Description', plain(fp.description)]] : [];
  }
  return [];
}

/** Strip HTML tags from descriptions for display. */
function plain(html: string | undefined): string {
  return (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
