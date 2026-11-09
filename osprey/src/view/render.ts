// Canvas2D renderer for a Scene.

import type { Layer } from '../eagle/types';
import type { SceneIndex } from '../scene/index';
import type { Bounds, Prim, TextPrim } from '../scene/types';
import { BACKGROUND, layerAlpha, layerColor } from './palette';
import { fillPattern } from './patterns';
import type { Viewport } from './viewport';

export const SELECT_COLOR = '#ffd84d';
export const HOVER_COLOR = '#ffffff';
const GRID_COLOR = '#3a414d';

/** Ratio of the em size to Eagle's text size (Eagle size ≈ cap height). */
const EM_PER_SIZE = 1.2;
const TEXT_FONT = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/** Text smaller than this (CSS px) is skipped: it would be unreadable and is slow to draw. */
const MIN_TEXT_PX = 3;

export interface RenderState {
  index: SceneIndex;
  layers: Map<number, Layer>;
  visible: (layer: number) => boolean;
  selection: ReadonlySet<string>;
  hover: string | undefined;
  /** Drag rectangle for box selection, in world coordinates. */
  box?: { rect: Bounds; crossing: boolean };
  /** Grid spacing in mm; dots are drawn when it is coarse enough to see. */
  grid?: number;
  /** A wire being drawn (world coordinates), in the colour of `layer`, and the cursor. */
  sketch?: Sketch;
  /** Design-rule violations to mark (the active one stands out). */
  markers?: { at: { x: number; y: number }; active: boolean }[];
}

type XY = { x: number; y: number };

/** A wire or route being drawn, in world coordinates. `layer` is the current one (for the cursor). */
export interface Sketch {
  /** `color` overrides the layer colour (e.g. red for a leg that breaks a clearance rule). */
  paths: { points: XY[]; width: number; layer: number; color?: string }[];
  vias?: { at: XY; radius: number }[];
  layer: number;
  cursor: XY;
  snapped: boolean;
}

export function render(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, s: RenderState): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, vp.width, vp.height);
  if (s.grid) drawGrid(ctx, vp, s.grid);

  const view = vp.visibleBounds();
  const prims = s.index.scene.prims;
  const inView = (i: number) => {
    const b = s.index.primBounds[i]!;
    return b.maxX >= view.minX && b.minX <= view.maxX && b.maxY >= view.minY && b.minY <= view.maxY;
  };

  // Patterns are defined in device pixels: undo the world transform for them.
  const z = vp.zoom * dpr;
  const patternSpace = new DOMMatrix([1 / z, 0, 0, -1 / z, -(vp.width / 2 - vp.cx * vp.zoom) / vp.zoom, (vp.height / 2 + vp.cy * vp.zoom) / vp.zoom]);

  /** Area fill for a layer in a colour, following the layer's fill style. */
  const areaFor = (layer: number, color: string): Area => {
    const pat = fillPattern(ctx, s.layers.get(layer)?.fill ?? 1, color);
    if (pat === 'none') return null;
    if (pat === 'solid') return color;
    pat.setTransform(patternSpace);
    return pat;
  };

  for (const { layer, prims: ids } of s.index.layers) {
    if (!s.visible(layer)) continue;
    const color = layerColor(s.layers.get(layer));
    const area = areaFor(layer, color);
    ctx.globalAlpha = layerAlpha(layer);
    for (const i of ids) if (inView(i)) drawPrim(ctx, vp, dpr, prims[i]!, color, 0, area);
  }
  ctx.globalAlpha = 1;

  // Drills cut through everything.
  for (const i of s.index.drills) {
    const p = prims[i]!;
    if (s.visible(p.layer) && inView(i)) drawPrim(ctx, vp, dpr, p, BACKGROUND, 0);
  }

  // Highlights draw over the whole design so selected objects stand out.
  const highlight = (owner: string, color: string, grow: number) => {
    const ids = s.index.ownerPrims.get(owner) ?? [];
    for (const i of ids) {
      const p = prims[i]!;
      if (p.t !== 'drill' && s.visible(p.layer) && inView(i)) drawPrim(ctx, vp, dpr, p, color, grow, areaFor(p.layer, color));
    }
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    for (const i of ids) {
      const p = prims[i]!;
      if (p.t === 'drill' && s.visible(p.layer) && inView(i)) drawPrim(ctx, vp, dpr, p, BACKGROUND, 0);
    }
    ctx.globalAlpha = alpha;
  };
  if (s.hover && !s.selection.has(s.hover)) {
    ctx.globalAlpha = 0.55;
    highlight(s.hover, HOVER_COLOR, 0);
    ctx.globalAlpha = 1;
  }
  for (const owner of s.selection) highlight(owner, SELECT_COLOR, 1.5);

  if (s.box) drawBox(ctx, vp, dpr, s.box.rect, s.box.crossing);
  if (s.markers) drawMarkers(ctx, vp, dpr, s.markers);
  if (s.sketch) drawSketch(ctx, vp, dpr, s.sketch, (layer) => layerColor(s.layers.get(layer)));
}

/**
 * A wire or route in progress: its paths (each in the colour of its layer), vias, and a
 * cursor mark (a ring when it sits on copper or a pin it can connect to).
 */
function drawSketch(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, k: Sketch, colorOf: (layer: number) => string): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of k.paths) {
    if (path.points.length < 2) continue;
    ctx.strokeStyle = path.color ?? colorOf(path.layer);
    ctx.lineWidth = Math.max(path.width * vp.zoom, 1.5);
    ctx.beginPath();
    path.points.forEach((p, i) => {
      const q = vp.toScreen(p.x, p.y);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.stroke();
  }
  for (const v of k.vias ?? []) {
    const q = vp.toScreen(v.at.x, v.at.y);
    ctx.fillStyle = colorOf(18);
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(v.radius * vp.zoom, 3), 0, Math.PI * 2);
    ctx.fill();
  }
  const c = vp.toScreen(k.cursor.x, k.cursor.y);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = k.snapped ? SELECT_COLOR : colorOf(k.layer);
  ctx.beginPath();
  if (k.snapped) {
    ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
  } else {
    ctx.moveTo(c.x - 6, c.y);
    ctx.lineTo(c.x + 6, c.y);
    ctx.moveTo(c.x, c.y - 6);
    ctx.lineTo(c.x, c.y + 6);
  }
  ctx.stroke();
}

/** Design-rule violations: a ring with a cross, in screen space so it stays visible at any zoom. */
function drawMarkers(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, markers: NonNullable<RenderState['markers']>): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const m of [...markers].sort((a, b) => Number(a.active) - Number(b.active))) {
    const c = vp.toScreen(m.at.x, m.at.y);
    const r = m.active ? 11 : 7;
    const width = m.active ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.moveTo(c.x - r * 0.6, c.y - r * 0.6);
    ctx.lineTo(c.x + r * 0.6, c.y + r * 0.6);
    ctx.moveTo(c.x + r * 0.6, c.y - r * 0.6);
    ctx.lineTo(c.x - r * 0.6, c.y + r * 0.6);
    // A dark halo keeps the mark visible on copper and on selected (yellow) objects.
    ctx.lineWidth = width + 3;
    ctx.strokeStyle = BACKGROUND;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = m.active ? '#ff4dff' : '#ff4d4d';
    ctx.stroke();
  }
}

function worldTransform(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number): void {
  const z = vp.zoom * dpr;
  ctx.setTransform(z, 0, 0, -z, (vp.width / 2 - vp.cx * vp.zoom) * dpr, (vp.height / 2 + vp.cy * vp.zoom) * dpr);
}

/** Fill for filled areas: a colour, a layer fill pattern, or null for outline-only. */
type Area = string | CanvasPattern | null;

/**
 * Draw one primitive. `growPx` widens strokes by that many CSS pixels (for highlights).
 * Zero-width lines are drawn as 1px hairlines. Filled areas use `area` (defaults to `color`).
 */
function drawPrim(
  ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, p: Prim, color: string, growPx: number,
  area: Area = color,
): void {
  if (p.t === 'text') {
    drawText(ctx, vp, dpr, p, color);
    return;
  }
  worldTransform(ctx, vp, dpr);
  const px = 1 / vp.zoom;
  const grow = growPx * px;
  const strokeWidth = (w: number) => Math.max(w, px) + grow;
  ctx.fillStyle = area ?? color;
  ctx.strokeStyle = color;
  // An empty fill style draws filled shapes as outlines.
  const fillArea = (rule: CanvasFillRule = 'nonzero') => {
    if (area !== null) ctx.fill(rule);
    else {
      ctx.lineWidth = px;
      ctx.stroke();
    }
  };

  switch (p.t) {
    case 'line':
      ctx.lineWidth = strokeWidth(p.width);
      ctx.lineCap = p.cap === 'flat' ? 'butt' : 'round';
      ctx.setLineDash(p.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    case 'arc':
      ctx.lineWidth = strokeWidth(p.width);
      ctx.lineCap = p.cap === 'flat' ? 'butt' : 'round';
      ctx.beginPath();
      // In y-up world space increasing angle is CCW, which is canvas's non-"anticlockwise" direction.
      ctx.arc(p.cx, p.cy, p.r, p.start, p.start + p.sweep, p.sweep < 0);
      ctx.stroke();
      break;
    case 'circle':
      ctx.beginPath();
      if (p.width === 0) {
        ctx.arc(p.cx, p.cy, p.r + grow / 2, 0, 2 * Math.PI);
        fillArea();
      } else {
        ctx.lineWidth = strokeWidth(p.width);
        ctx.arc(p.cx, p.cy, p.r, 0, 2 * Math.PI);
        ctx.stroke();
      }
      break;
    case 'poly': {
      if (p.pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(p.pts[0]!.x, p.pts[0]!.y);
      for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i]!.x, p.pts[i]!.y);
      ctx.closePath();
      for (const h of p.holes ?? []) {
        if (h.length < 3) continue;
        ctx.moveTo(h[0]!.x, h[0]!.y);
        for (let i = 1; i < h.length; i++) ctx.lineTo(h[i]!.x, h[i]!.y);
        ctx.closePath();
      }
      if (p.fill) fillArea(p.holes ? 'evenodd' : 'nonzero');
      if (p.width > 0 || grow > 0 || !p.fill) {
        ctx.lineWidth = strokeWidth(p.width);
        ctx.lineJoin = 'round';
        ctx.setLineDash(p.dash ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      break;
    }
    case 'drill':
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r, 0, 2 * Math.PI);
      ctx.fill();
      break;
  }
}

function drawText(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, p: TextPrim, color: string): void {
  const sizePx = p.size * vp.zoom;
  if (sizePx < MIN_TEXT_PX) return;
  const o = vp.toScreen(p.x, p.y);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(o.x, o.y);
  ctx.rotate((-p.angle * Math.PI) / 180);
  if (p.mirror) ctx.scale(-1, 1);

  ctx.fillStyle = color;
  ctx.font = `${sizePx * EM_PER_SIZE}px ${TEXT_FONT}`;
  const [v, h] = p.align === 'center' ? ['center', 'center'] : p.align.split('-');
  ctx.textAlign = h === 'left' ? 'left' : h === 'right' ? 'right' : 'center';
  ctx.textBaseline = 'alphabetic';

  const lines = p.text.split('\n');
  const pitch = sizePx * 1.5;
  const blockHeight = sizePx + (lines.length - 1) * pitch;
  // Baseline of the first line, measured downward from the anchor (screen y grows down).
  const firstBaseline =
    v === 'bottom' ? -(lines.length - 1) * pitch : v === 'top' ? sizePx : sizePx - blockHeight / 2;
  lines.forEach((line, i) => ctx.fillText(line, 0, firstBaseline + i * pitch));
}

function drawBox(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number, r: Bounds, crossing: boolean): void {
  const a = vp.toScreen(r.minX, r.maxY);
  const b = vp.toScreen(r.maxX, r.minY);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = crossing ? 'rgba(80, 200, 120, 0.12)' : 'rgba(80, 140, 255, 0.12)';
  ctx.strokeStyle = crossing ? '#50c878' : '#508cff';
  ctx.lineWidth = 1;
  ctx.setLineDash(crossing ? [5, 4] : []);
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  ctx.setLineDash([]);
}

/** Grid dots, in screen space. Coarsens by 2×/5× steps until dots are at least 12px apart. */
function drawGrid(ctx: CanvasRenderingContext2D, vp: Viewport, spacing: number): void {
  let step = spacing;
  for (const k of [2, 5, 10, 20, 50, 100]) {
    if (step * vp.zoom >= 12) break;
    step = spacing * k;
  }
  if (step * vp.zoom < 12) return;
  const view = vp.visibleBounds();
  ctx.fillStyle = GRID_COLOR;
  for (let x = Math.ceil(view.minX / step) * step; x <= view.maxX; x += step) {
    for (let y = Math.ceil(view.minY / step) * step; y <= view.maxY; y += step) {
      const p = vp.toScreen(x, y);
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
  }
}
