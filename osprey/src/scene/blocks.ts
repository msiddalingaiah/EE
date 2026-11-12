// Block outlines for a view: the parts' drawn extents in the scene (symbols or footprints, with
// their names and values; supply symbols aside), grouped by block, outlined (model/blocks.ts) and coloured. A block has
// the same colour in the schematic and on the board.

import type { Point } from '../geom/transform';
import { blockOf, blockOutlines, blockPaths, type BlockItem, type OutlineOptions } from '../model/blocks';
import { ProjectIndex } from '../model/derive';
import type * as O from '../model/types';
import type { SceneIndex } from './index';

export interface BlockShape {
  path: string;
  /** The block's own name (the last part of its path). */
  name: string;
  color: string;
  depth: number;
  rings: Point[][];
  corner: Point;
  /** Height of the block's name (mm). */
  labelSize: number;
}

/** Distinct hues that read on the dark background, in the order blocks take them. */
export const BLOCK_COLORS = [
  '#4f9dff', '#ff8a3d', '#3ddc84', '#d36bff', '#ffd23d', '#ff5c8a', '#3dd6e0', '#a0d14f',
  '#ff6b4f', '#8a8aff', '#e0a03d', '#4fd1a5',
];

/**
 * Outlines sized for each view: schematic symbols sit on a 2.54 mm grid; board parts are packed
 * tight. A child block sits far enough inside its parent for the parent's name to fit above it.
 */
const OPTIONS: Record<'schematic' | 'board', OutlineOptions & { label: number }> = {
  schematic: { cell: 0.635, margin: 1.27, nest: 3.81, close: 7.62, keepOut: 0.635, label: 1.778 },
  board: { cell: 0.127, margin: 0.254, nest: 0.889, close: 1.524, keepOut: 0.127, label: 0.6 },
};

/** The colour of each block in the project. */
export function blockColors(project: O.Project): Map<string, string> {
  return new Map(blockPaths(project).map((p, i) => [p, BLOCK_COLORS[i % BLOCK_COLORS.length]!]));
}

export function blockShapes(project: O.Project, index: SceneIndex): BlockShape[] {
  const kind = index.scene.kind;
  if (kind === 'library') return [];
  const colors = blockColors(project);
  if (!colors.size) return [];
  const blocks = new Map(project.parts.map((p) => [p.name, blockOf(p)]));
  // Parts with no footprint (supply symbols, frames) belong to no block and keep none out.
  const ix = new ProjectIndex(project);
  const placed = new Set(project.parts.filter((p) => ix.variantOf(p)?.footprint).map((p) => p.name));
  const items: BlockItem[] = [];
  for (const [id, owner] of index.scene.owners) {
    const t = owner.target;
    const part = t?.kind === 'gate' ? t.gate.part : t?.kind === 'footprint' ? t.footprint.part : t?.kind === 'label' ? t.placement.part : undefined;
    const b = part !== undefined ? index.ownerBounds.get(id) : undefined;
    if (!b || part === undefined || !placed.has(part)) continue;
    const block = blocks.get(part);
    items.push({ ...(block ? { block } : {}), minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
  }
  const opts = OPTIONS[kind];
  return blockOutlines(items, opts).map((o) => ({
    ...o,
    labelSize: opts.label,
    name: o.path.slice(o.path.lastIndexOf('/') + 1),
    color: colors.get(o.path) ?? BLOCK_COLORS[0]!,
  }));
}
