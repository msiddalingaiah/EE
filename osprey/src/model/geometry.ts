// Geometry of the native model: placement transforms, pin and pad positions, layer
// mirroring for bottom-side parts, and design-rule lookups.

import type { Rotation } from '../eagle/types';
import type { Point, Transform } from '../geom/transform';
import { apply, placement } from '../geom/transform';
import type { ProjectIndex } from './derive';
import { layerName, layerNumber } from './layers';
import type { FootprintPlacement, GatePlacement, JsonML, Project, Pt } from './types';

export function rotation(rot: number | undefined, mirror: boolean | undefined, spin?: boolean): Rotation {
  return { angle: rot ?? 0, mirror: !!mirror, spin: !!spin };
}

export const pt = (p: Pt): Point => ({ x: p[0], y: p[1] });

export function gateTransform(g: GatePlacement): Transform {
  return placement(g.at[0], g.at[1], rotation(g.rot, g.mirror));
}

/** Footprints on the bottom side are mirrored (Eagle's "MR"). */
export function footprintTransform(f: FootprintPlacement): Transform {
  return placement(f.at[0], f.at[1], rotation(f.rot, f.side === 'bottom'));
}

/** World position of a pin of a placed gate. */
export function pinPosition(index: ProjectIndex, g: GatePlacement, pinName: string): Point | undefined {
  const component = index.components.get(index.parts.get(g.part)?.component ?? '');
  const gate = component?.gates.find((x) => x.name === g.gate);
  const pin = gate && index.symbols.get(gate.symbol)?.pins.find((p) => p.name === pinName);
  return pin ? apply(gateTransform(g), pin.at[0], pin.at[1]) : undefined;
}

/** World position of a pad of a placed footprint. */
export function padPosition(index: ProjectIndex, f: FootprintPlacement, padName: string): Point | undefined {
  const part = index.parts.get(f.part);
  const fpId = part && index.variantOf(part)?.footprint;
  const pad = fpId ? index.footprints.get(fpId)?.pads.find((p) => p.name === padName) : undefined;
  return pad ? apply(footprintTransform(f), pad.at[0], pad.at[1]) : undefined;
}

/** The layer on the other side of the board ("silk.top" ↔ "silk.bottom"); others unchanged. */
export function mirrorLayer(name: string): string {
  const n = layerNumber(name);
  const pairs: Record<number, number> = {
    1: 16, 21: 22, 23: 24, 25: 26, 27: 28, 29: 30, 31: 32, 33: 34, 35: 36, 37: 38, 39: 40, 41: 42, 51: 52,
  };
  for (const [a, b] of Object.entries(pairs)) {
    if (n === Number(a)) return layerName(b);
    if (n === b) return layerName(Number(a));
  }
  if (n >= 2 && n <= 15) return layerName(17 - n);
  return name;
}

/** Eagle design-rule parameters kept in the board's passthrough (name → raw value). */
export function designRules(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: JsonML) => {
    const [tag, ...rest] = node;
    if (tag === 'param') {
      const attrs = rest[0];
      if (attrs && !Array.isArray(attrs) && typeof attrs === 'object') out.set(attrs.name ?? '', attrs.value ?? '');
      return;
    }
    for (const c of rest) if (Array.isArray(c)) visit(c as JsonML);
  };
  for (const entry of project.eagle?.board ?? []) {
    const [tag, ...rest] = entry;
    if (tag !== 'board') continue;
    for (const c of rest) if (Array.isArray(c) && c[0] === 'designrules') visit(c as JsonML);
  }
  return out;
}
