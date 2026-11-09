// Build a Scene for a project's board (native model), including the computed airwires.

import { objId } from '../eagle/dom';
import type { Layer } from '../eagle/types';
import { ProjectIndex } from '../model/derive';
import { designRules, footprintTransform, rotation } from '../model/geometry';
import { layerNumber } from '../model/layers';
import { ratsnest } from '../model/ratsnest';
import { DesignRules } from '../model/rules';
import type * as O from '../model/types';
import { AIRWIRES_LAYER, SceneBuilder, type EmitContext } from './builder';
import { drawingKind } from './schematic';
import { fmtNum, fmtRot, fmtXY, labelOwner, labelText, placeholderResolver } from './text';
import type { Scene } from './types';

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Eagle layer number of the other board side (1 ↔ 16, 21 ↔ 22, …). */
export function mirrorLayerNumber(layer: number): number {
  const pairs: [number, number][] = [
    [1, 16], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32], [33, 34],
    [35, 36], [37, 38], [39, 40], [41, 42], [51, 52],
  ];
  for (const [a, b] of pairs) {
    if (layer === a) return b;
    if (layer === b) return a;
  }
  return layer >= 2 && layer <= 15 ? 17 - layer : layer;
}

export { DesignRules } from '../model/rules';

export function buildBoardScene(project: O.Project, layers: Layer[], index = new ProjectIndex(project)): Scene {
  const board = project.board;
  if (!board) throw new Error('The project has no board');
  const b = new SceneBuilder('board', layers);
  const rules = new DesignRules(designRules(project));

  for (const g of board.drawing) {
    const kind = drawingKind(g);
    const id = b.addOwner({
      id: `drawing:${objId(g)}`, kind: 'drawing',
      label: 'text' in g ? `Text "${g.text}"` : 'line' in g && g.layer === 'outline' ? 'Board outline' : kind,
      props: [['Type', kind], ['Layer', 'layer' in g ? g.layer : 'holes']],
      target: { kind: 'drawing', doc: 'board', graphic: g, container: board.drawing },
    });
    b.graphic(g, { owner: id, transform: IDENTITY, textContext: 'board' });
  }

  for (const fp of board.footprints) emitFootprint(b, fp, index, rules);
  emitNets(b, project, rules);

  for (const a of ratsnest(project)) {
    const id = b.addOwner({
      id: `airwire:${a.net}:${a.from.join(',')}:${a.to.join(',')}`, kind: 'airwire', label: `Airwire ${a.net}`, net: a.net,
      props: [['Net', a.net], ['From', fmtXY(a.from[0], a.from[1])], ['To', fmtXY(a.to[0], a.to[1])]],
    });
    b.prims.push({ t: 'line', x1: a.from[0], y1: a.from[1], x2: a.to[0], y2: a.to[1], width: 0, cap: 'round', layer: AIRWIRES_LAYER, owner: id });
  }
  return b.finish();
}

function emitFootprint(b: SceneBuilder, fp: O.FootprintPlacement, index: ProjectIndex, rules: DesignRules): void {
  const part = index.parts.get(fp.part);
  const fpId = part && index.variantOf(part)?.footprint;
  const footprint = fpId ? index.footprints.get(fpId) : undefined;
  if (!part || !footprint) return;
  const bottom = fp.side === 'bottom';
  const value = index.valueOf(part);
  const id = b.addOwner({
    id: `footprint:${objId(fp)}`,
    kind: 'footprint',
    label: part.name,
    props: [
      ['Name', part.name],
      ['Value', value],
      ['Footprint', footprint.id],
      ['Position', fmtXY(fp.at[0], fp.at[1])],
      ['Rotation', fmtRot(fp.rot, bottom)],
      ['Side', bottom ? 'bottom' : 'top'],
      ['Locked', fp.locked ? 'yes' : 'no'],
    ],
    target: { kind: 'footprint', footprint: fp },
    origin: { x: fp.at[0], y: fp.at[1] },
  });
  const attrs: Record<string, string> = { ...(part.attributes ?? {}), NAME: part.name, VALUE: value };
  const resolve = placeholderResolver(attrs);
  const smashed = fp.smashed || (fp.labels?.length ?? 0) > 0;
  const ctx: EmitContext = {
    owner: id,
    transform: footprintTransform(fp),
    textContext: 'board',
    substitute: (t) => (smashed && t.startsWith('>') ? undefined : resolve(t)),
    ...(bottom ? { layerMap: mirrorLayerNumber } : {}),
  };
  b.graphics(footprint.graphics, ctx);
  for (const pad of footprint.pads) {
    b.pad(pad, ctx, (drill, d) => rules.padDiameter(drill, d), (shape) => rules.elongation(shape));
  }
  for (const l of fp.labels ?? []) {
    const text = labelText(l, l.value ?? attrs[l.attr.toUpperCase()]);
    if (!text) continue;
    const owner = b.addOwner(labelOwner(l, part.name, 'board', fp));
    b.text(text, l.at[0], l.at[1], l.size, rotation(l.rot, l.mirror, l.spin), l.align ?? 'bottom-left', layerNumber(l.layer), {
      owner, transform: IDENTITY, textContext: 'board',
    });
  }
}

function emitNets(b: SceneBuilder, project: O.Project, rules: DesignRules): void {
  const base = { textContext: 'board' as const, transform: IDENTITY };
  for (const net of project.nets) {
    for (const t of net.traces ?? []) {
      const id = b.addOwner({
        id: `trace:${objId(t)}`,
        kind: 'trace',
        label: `Trace ${net.name}`,
        net: net.name,
        props: [
          ['Net', net.name], ['Layer', t.layer],
          ['From', fmtXY(t.line[0][0], t.line[0][1])], ['To', fmtXY(t.line[1][0], t.line[1][1])],
          ['Width', `${fmtNum(t.width)} mm`],
        ],
        target: { kind: 'trace', net, trace: t },
      });
      b.line(t, t.layer, { ...base, owner: id });
    }
    for (const v of net.vias ?? []) {
      const dia = rules.viaDiameter(v.drill, v.diameter ?? 0);
      const id = b.addOwner({
        id: `via:${objId(v)}`,
        kind: 'via',
        label: `Via ${net.name}`,
        net: net.name,
        props: [
          ['Net', net.name], ['Position', fmtXY(v.at[0], v.at[1])], ['Drill', `${fmtNum(v.drill)} mm`],
          ['Diameter', `${fmtNum(dia)} mm`], ['Layers', v.layers ?? '1-16'],
        ],
        target: { kind: 'via', net, via: v },
        origin: { x: v.at[0], y: v.at[1] },
      });
      b.via(v, dia, id);
    }
    for (const pour of net.pours ?? []) {
      const id = b.addOwner({
        id: `pour:${objId(pour)}`,
        kind: 'pour',
        label: `Pour ${net.name}`,
        net: net.name,
        props: [
          ['Net', net.name], ['Layer', pour.layer], ['Points', String(pour.polygon.length)],
          ['Isolate', pour.isolate === undefined ? '(default)' : `${fmtNum(pour.isolate)} mm`],
        ],
        target: { kind: 'pour', net, pour },
      });
      // Poured copper isn't computed yet: draw the outline, dashed like Eagle's unpoured view.
      b.graphic(pour, { ...base, owner: id });
      const last = b.prims[b.prims.length - 1];
      if (last?.t === 'poly') {
        last.fill = false;
        last.width = Math.max(pour.width, 0.1);
        last.dash = [pour.width * 4 || 0.5, pour.width * 4 || 0.5];
      }
    }
  }
}
