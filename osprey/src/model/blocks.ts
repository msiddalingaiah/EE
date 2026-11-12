// Blocks: groups of parts that belong together (a filter, an oscillator), nested like folders.
// A part's block is a path in its BLOCK attribute ("rx/frontend"), so the tree is the set of
// paths and their ancestors, and it survives export to Eagle with the rest of the attributes.
// Placement is to work block by block; the views draw each block as an outline
// around its parts.
//
// Outlines are drawn on a grid: a block's parts (as boxes, grown by a margin) and its child
// blocks' outlines (grown by a further gap, so they nest) are filled in, the gaps between them
// closed (grown, then shrunk by the same amount), and the boxes of parts outside the block cut
// away. Tracing the cells' edges gives polygons with only right-angled corners.

import type { Point } from '../geom/transform';
import type * as O from './types';

export const BLOCK_ATTRIBUTE = 'BLOCK';

/** A part's block path, if it has one. */
export function blockOf(part: O.Part): string | undefined {
  return part.attributes?.[BLOCK_ATTRIBUTE] || undefined;
}

/**
 * A block path as typed: names separated by "/", spaces around them trimmed, empty names
 * dropped ("rx / front end/" → "rx/front end"). Empty means no block.
 */
export function normalizeBlockPath(raw: string): string {
  return raw.split('/').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join('/');
}

/** "a/b/c" → ["a", "a/b", "a/b/c"] */
export function blockAncestry(path: string): string[] {
  const names = path.split('/');
  return names.map((_, i) => names.slice(0, i + 1).join('/'));
}

/** Is `path` the block `ancestor` or inside it? */
export const inBlock = (path: string | undefined, ancestor: string) =>
  path !== undefined && (path === ancestor || path.startsWith(`${ancestor}/`));

/** Every block in the project, parents included, sorted (parents before their children). */
export function blockPaths(project: O.Project): string[] {
  const out = new Set<string>();
  for (const p of project.parts) {
    const b = blockOf(p);
    if (b) for (const a of blockAncestry(b)) out.add(a);
  }
  return [...out].sort(comparePaths);
}

/** Path order: by name at each level, so a block comes right before its children. */
export function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i]!.localeCompare(y[i]!);
    if (c) return c;
  }
  return x.length - y.length;
}

// ---------------------------------------------------------------------------
// Outlines

export interface BlockItem {
  /** The item's block path (none: outside every block, but still kept out of them). */
  block?: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface OutlineOptions {
  /** Grid cell (mm): outlines are made of its edges. */
  cell: number;
  /** Space between a block's own parts and its outline (mm). */
  margin: number;
  /** Space between a child block's outline and its parent's (mm). */
  nest: number;
  /** Gaps up to twice this between a block's parts are filled in (mm). */
  close: number;
  /** Space kept between an outline and parts outside the block (mm). */
  keepOut: number;
}

export interface BlockOutline {
  path: string;
  /** Nesting depth (0 for a top-level block). */
  depth: number;
  /** Closed rings, counter-clockwise for areas and clockwise for holes (fill even-odd). */
  rings: Point[][];
  /** The outline's top-left corner: where its name goes. */
  corner: Point;
}

/** Outlines of every block with parts among `items`, parents included. */
export function blockOutlines(items: BlockItem[], opts: OutlineOptions): BlockOutline[] {
  const paths = new Set<string>();
  for (const it of items) if (it.block) for (const a of blockAncestry(it.block)) paths.add(a);
  if (!paths.size) return [];
  const maxDepth = Math.max(...[...paths].map((p) => p.split('/').length));
  const pad = opts.margin + opts.nest * maxDepth + opts.close + opts.keepOut + 2 * opts.cell;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.minX);
    minY = Math.min(minY, it.minY);
    maxX = Math.max(maxX, it.maxX);
    maxY = Math.max(maxY, it.maxY);
  }
  const grid = new Grid(minX - pad, minY - pad, maxX + pad, maxY + pad, opts.cell);
  const cells = (mm: number) => Math.max(0, Math.round(mm / opts.cell));

  // Deepest first, so each block's children are done before it.
  const order = [...paths].sort((a, b) => b.split('/').length - a.split('/').length || comparePaths(a, b));
  const masks = new Map<string, Uint8Array>();
  const out: BlockOutline[] = [];
  for (const path of order) {
    let m = grid.empty();
    for (const it of items) if (it.block === path) grid.fill(m, it, opts.margin);
    for (const [child, cm] of masks) {
      if (child.lastIndexOf('/') === path.length && child.startsWith(`${path}/`)) grid.or(m, grid.dilate(cm, cells(opts.nest)));
    }
    m = grid.erode(grid.dilate(m, cells(opts.close)), cells(opts.close));
    const foreign = grid.empty();
    for (const it of items) if (!inBlock(it.block, path)) grid.fill(foreign, it, opts.keepOut);
    for (let i = 0; i < m.length; i++) if (foreign[i]) m[i] = 0;
    masks.set(path, m);
    const rings = grid.trace(m);
    if (rings.length) out.push({ path, depth: path.split('/').length - 1, rings, corner: grid.topLeft(m) });
  }
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/** A grid of cells over an area, with masks (one byte per cell) and their operations. */
class Grid {
  readonly w: number;
  readonly h: number;

  constructor(readonly x0: number, readonly y0: number, x1: number, y1: number, readonly cell: number) {
    this.w = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.h = Math.max(1, Math.ceil((y1 - y0) / cell));
  }

  empty(): Uint8Array {
    return new Uint8Array(this.w * this.h);
  }

  /** Mark the cells a box (grown by `grow`) covers. */
  fill(m: Uint8Array, r: BlockItem, grow: number): void {
    const eps = 1e-9;
    const ix0 = Math.max(0, Math.floor((r.minX - grow - this.x0) / this.cell + eps));
    const iy0 = Math.max(0, Math.floor((r.minY - grow - this.y0) / this.cell + eps));
    const ix1 = Math.min(this.w, Math.ceil((r.maxX + grow - this.x0) / this.cell - eps));
    const iy1 = Math.min(this.h, Math.ceil((r.maxY + grow - this.y0) / this.cell - eps));
    for (let y = iy0; y < iy1; y++) m.fill(1, y * this.w + ix0, y * this.w + Math.max(ix0, ix1));
  }

  or(m: Uint8Array, n: Uint8Array): void {
    for (let i = 0; i < m.length; i++) m[i] = m[i]! | n[i]!;
  }

  /** Grow a mask by `r` cells each way (a square brush): one pass along rows, one down columns. */
  dilate(m: Uint8Array, r: number): Uint8Array {
    if (r <= 0) return m.slice();
    const { w, h } = this;
    // A cell is set if a set cell is within r of it: on its left, or on its right.
    const a = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) {
      let last = -Infinity;
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) last = x;
        if (x - last <= r) a[y * w + x] = 1;
      }
      let next = Infinity;
      for (let x = w - 1; x >= 0; x--) {
        if (m[y * w + x]) next = x;
        if (next - x <= r) a[y * w + x] = 1;
      }
    }
    const b = new Uint8Array(m.length);
    for (let x = 0; x < w; x++) {
      let last = -Infinity;
      for (let y = 0; y < h; y++) {
        if (a[y * w + x]) last = y;
        if (y - last <= r) b[y * w + x] = 1;
      }
      let next = Infinity;
      for (let y = h - 1; y >= 0; y--) {
        if (a[y * w + x]) next = y;
        if (next - y <= r) b[y * w + x] = 1;
      }
    }
    return b;
  }

  /** Shrink a mask by `r` cells: what stays is at least r cells inside it (the grid's edge counts as outside). */
  erode(m: Uint8Array, r: number): Uint8Array {
    if (r <= 0) return m.slice();
    const inv = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
    const { w, h } = this;
    for (let x = 0; x < w; x++) inv[x] = inv[(h - 1) * w + x] = 1;
    for (let y = 0; y < h; y++) inv[y * w] = inv[y * w + w - 1] = 1;
    const g = this.dilate(inv, r);
    const out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = m[i] && !g[i] ? 1 : 0;
    return out;
  }

  /** The top-left corner of the topmost row of a mask (world coordinates, y up). */
  topLeft(m: Uint8Array): Point {
    for (let y = this.h - 1; y >= 0; y--) {
      for (let x = 0; x < this.w; x++) if (m[y * this.w + x]) return { x: this.x0 + x * this.cell, y: this.y0 + (y + 1) * this.cell };
    }
    return { x: this.x0, y: this.y0 };
  }

  /**
   * The outlines of a mask: every cell edge with a set cell on its left (walking it), joined end
   * to end into rings, straight runs merged. Where two rings touch at a corner, the walk turns
   * left, so they stay separate.
   */
  trace(m: Uint8Array): Point[][] {
    const { w, h } = this;
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    // Edges keyed by their start vertex (vx + vy * (w + 1)); a vertex starts at most two.
    const edges = new Map<number, number[]>(); // start -> [end, ...]
    const key = (x: number, y: number) => x + y * (w + 1);
    const add = (x1: number, y1: number, x2: number, y2: number) => {
      const k = key(x1, y1);
      const list = edges.get(k);
      if (list) list.push(key(x2, y2));
      else edges.set(k, [key(x2, y2)]);
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!at(x, y)) continue;
        // Counter-clockwise around the cell, edges facing empty neighbours.
        if (!at(x, y - 1)) add(x, y, x + 1, y);
        if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) add(x, y + 1, x, y);
      }
    }
    const xy = (k: number) => ({ x: k % (w + 1), y: Math.floor(k / (w + 1)) });
    const rings: Point[][] = [];
    for (const [start, ends] of edges) {
      while (ends.length) {
        const ring: number[] = [start];
        let prev = start;
        let cur = ends.pop()!;
        while (cur !== start) {
          ring.push(cur);
          const outs = edges.get(cur)!;
          let pick = 0;
          if (outs.length > 1) {
            // Turn left: the outgoing edge making the largest left turn from the incoming one.
            const p = xy(prev);
            const c = xy(cur);
            const din = { x: c.x - p.x, y: c.y - p.y };
            const left = { x: -din.y, y: din.x };
            pick = Math.max(0, outs.findIndex((o) => {
              const n = xy(o);
              return n.x - c.x === left.x && n.y - c.y === left.y;
            }));
          }
          prev = cur;
          cur = outs.splice(pick, 1)[0]!;
        }
        // Keep the corners only.
        const pts = ring.map(xy);
        const corners = pts.filter((p, i) => {
          const a = pts[(i + pts.length - 1) % pts.length]!;
          const b = pts[(i + 1) % pts.length]!;
          return (a.x - p.x) * (b.y - p.y) - (a.y - p.y) * (b.x - p.x) !== 0;
        });
        rings.push(corners.map((p) => ({ x: this.x0 + p.x * this.cell, y: this.y0 + p.y * this.cell })));
      }
    }
    return rings;
  }
}
