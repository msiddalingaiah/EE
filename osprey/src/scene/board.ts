// Build a Scene for an Eagle board.

import type { Board, EagleFile, Graphic, PlacedAttribute } from '../eagle/types';
import { objId } from '../eagle/dom';
import { findLibrary, parseDistance } from '../eagle/parse';
import { IDENTITY, placement } from '../geom/transform';
import { SceneBuilder, type EmitContext } from './builder';
import { fmtNum, fmtRot, fmtXY, placeholderResolver, placedAttributeText } from './text';
import type { Scene } from './types';

/** Layers that swap when a part is placed on the bottom side. */
const MIRROR_PAIRS: [number, number][] = [
  [1, 16], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32], [33, 34],
  [35, 36], [37, 38], [39, 40], [41, 42], [51, 52],
];
const MIRROR_LAYER = new Map<number, number>();
for (const [a, b] of MIRROR_PAIRS) {
  MIRROR_LAYER.set(a, b);
  MIRROR_LAYER.set(b, a);
}
for (let inner = 2; inner <= 15; inner++) MIRROR_LAYER.set(inner, 17 - inner);

export function mirrorLayer(layer: number): number {
  return MIRROR_LAYER.get(layer) ?? layer;
}

/** Design-rule lookups with Eagle's defaults. */
export class DesignRules {
  constructor(private readonly params: Map<string, string>) {}

  private ratio(name: string, dflt: number): number {
    const v = this.params.get(name);
    return v === undefined ? dflt : Number(v);
  }

  private dist(name: string, dflt: number): number {
    const v = this.params.get(name);
    return v === undefined ? dflt : parseDistance(v);
  }

  private restring(drill: number, kind: 'PadTop' | 'ViaOuter'): number {
    const rv = this.ratio(`rv${kind}`, 0.25);
    const min = this.dist(`rlMin${kind}`, 0.254);
    const max = this.dist(`rlMax${kind}`, 0.508);
    return Math.min(Math.max(drill * rv, min), max);
  }

  /** Effective outer diameter of a through-hole pad. */
  padDiameter(drill: number, diameter: number): number {
    return Math.max(diameter, drill + 2 * this.restring(drill, 'PadTop'));
  }

  viaDiameter(drill: number, diameter: number): number {
    return Math.max(diameter, drill + 2 * this.restring(drill, 'ViaOuter'));
  }

  elongation(shape: 'long' | 'offset'): number {
    return this.ratio(shape === 'long' ? 'psElongationLong' : 'psElongationOffset', 100);
  }
}

export function buildBoardScene(file: EagleFile): Scene {
  const brd = file.board;
  if (!brd) throw new Error('Not a board');
  const b = new SceneBuilder('board', file.layers);
  const rules = new DesignRules(brd.designRules);

  brd.plain.forEach((g) => {
    const id = b.addOwner({
      id: `plain:${objId(g)}`, kind: 'plain', label: plainLabel(g), props: [['Type', g.kind], ['Layer', String('layer' in g ? g.layer : 45)]],
      target: { kind: 'plain', graphic: g, container: brd.plain },
    });
    b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'board' });
  });

  emitElements(b, brd, rules);
  emitSignals(b, brd, rules);
  return b.finish();
}

function emitElements(b: SceneBuilder, brd: Board, rules: DesignRules): void {
  for (const el of brd.elements) {
    const lib = findLibrary(brd.libraries, el.library, el.libraryUrn);
    const pkg = lib?.packages.get(el.package);
    if (!pkg) continue;
    const bottom = el.rot.mirror;
    const id = b.addOwner({
      id: `element:${objId(el)}`,
      kind: 'element',
      label: el.name,
      target: { kind: 'element', element: el },
      origin: { x: el.x, y: el.y },
      props: [
        ['Name', el.name],
        ['Value', el.value],
        ['Library', el.library],
        ['Package', el.package],
        ['Position', fmtXY(el.x, el.y)],
        ['Rotation', fmtRot(el.rot)],
        ['Side', bottom ? 'bottom' : 'top'],
        ['Locked', el.locked ? 'yes' : 'no'],
      ],
    });
    const attrs: Record<string, string> = { NAME: el.name, VALUE: el.value };
    for (const a of el.attributes) if (a.value !== undefined) attrs[a.name.toUpperCase()] = a.value;
    const resolve = placeholderResolver(attrs);

    const ctx: EmitContext = {
      owner: id,
      transform: placement(el.x, el.y, el.rot),
      textContext: 'board',
      substitute: (t) => (el.smashed && t.startsWith('>') ? undefined : resolve(t)),
      ...(bottom ? { layerMap: mirrorLayer } : {}),
    };
    b.graphics(pkg.graphics, ctx);
    for (const p of pkg.pads) {
      if (p.kind === 'smd') {
        b.smd(p, ctx);
      } else {
        const elong = p.shape === 'long' || p.shape === 'offset' ? rules.elongation(p.shape) : 0;
        b.pad(p, rules.padDiameter(p.drill, p.diameter), elong, ctx);
      }
    }
    if (el.smashed) emitPlacedAttributes(b, el.attributes, attrs, id);
  }
}

function emitPlacedAttributes(
  b: SceneBuilder, placed: PlacedAttribute[], attrs: Record<string, string>, owner: string,
): void {
  for (const a of placed) {
    if (a.x === undefined || a.y === undefined || a.layer === undefined) continue;
    const text = placedAttributeText(a, attrs[a.name.toUpperCase()]);
    if (!text) continue;
    b.text(text, a.x, a.y, a.size ?? 1.27, a.rot, a.align, a.layer, {
      owner, transform: IDENTITY, textContext: 'board',
    });
  }
}

function emitSignals(b: SceneBuilder, brd: Board, rules: DesignRules): void {
  for (const sig of brd.signals) {
    const base = { textContext: 'board' as const, transform: IDENTITY };
    sig.wires.forEach((w) => {
      const id = b.addOwner({
        id: `signal-wire:${objId(w)}`,
        target: { kind: 'signal-wire', signal: sig, wire: w },
        kind: 'signal-wire',
        label: w.layer === 19 ? `Airwire ${sig.name}` : `Trace ${sig.name}`,
        net: sig.name,
        props: [
          ['Signal', sig.name],
          ['Layer', String(w.layer)],
          ['From', fmtXY(w.x1, w.y1)],
          ['To', fmtXY(w.x2, w.y2)],
          ['Width', `${fmtNum(w.width)} mm`],
        ],
      });
      b.wire(w, { ...base, owner: id });
    });
    sig.vias.forEach((v) => {
      const dia = rules.viaDiameter(v.drill, v.diameter);
      const id = b.addOwner({
        id: `via:${objId(v)}`,
        target: { kind: 'via', signal: sig, via: v },
        origin: { x: v.x, y: v.y },
        kind: 'via',
        label: `Via ${sig.name}`,
        net: sig.name,
        props: [
          ['Signal', sig.name],
          ['Position', fmtXY(v.x, v.y)],
          ['Drill', `${fmtNum(v.drill)} mm`],
          ['Diameter', `${fmtNum(dia)} mm`],
          ['Layers', v.extent],
        ],
      });
      b.via(v, dia, id);
    });
    sig.polygons.forEach((poly) => {
      const id = b.addOwner({
        id: `signal-polygon:${objId(poly)}`,
        target: { kind: 'signal-polygon', signal: sig, polygon: poly },
        kind: 'signal-polygon',
        label: `Polygon ${sig.name}`,
        net: sig.name,
        props: [
          ['Signal', sig.name],
          ['Layer', String(poly.layer)],
          ['Vertices', String(poly.vertices.length)],
          ['Isolate', poly.isolate === undefined ? '(default)' : `${fmtNum(poly.isolate)} mm`],
        ],
      });
      // Pours aren't computed yet: draw the polygon's outline only, dashed like Eagle's unpoured view.
      b.graphic(poly, { ...base, owner: id });
      const last = b.prims[b.prims.length - 1];
      if (last?.t === 'poly') {
        last.fill = false;
        last.width = Math.max(poly.width, 0.1);
        last.dash = [poly.width * 4 || 0.5, poly.width * 4 || 0.5];
      }
    });
  }
}

function plainLabel(g: Graphic): string {
  switch (g.kind) {
    case 'text': return `Text "${g.text}"`;
    case 'hole': return 'Hole';
    case 'wire': return g.layer === 20 ? 'Board outline' : 'Line';
    default: return g.kind[0]!.toUpperCase() + g.kind.slice(1);
  }
}
