// Shared machinery for turning Eagle graphics into scene primitives.

import type { Graphic, Layer, Pad, Rotation, Smd, TextAlign, Via, Wire } from '../eagle/types';
import { arcFromChord, arcPoints } from '../geom/arc';
import type { Point, Transform } from '../geom/transform';
import { apply, compose, composeRotation, placement } from '../geom/transform';
import type { Bounds, Owner, Prim, Scene } from './types';

export type TextContext = 'schematic' | 'board';

/** Context for emitting graphics of one owner. */
export interface EmitContext {
  owner: string;
  transform: Transform;
  /** Remaps layers, e.g. top->bottom for mirrored board elements. */
  layerMap?: (layer: number) => number;
  /** Resolves text placeholders such as ">NAME". Return undefined to drop the text. */
  substitute?: (text: string) => string | undefined;
  textContext: TextContext;
}

export class SceneBuilder {
  readonly prims: Prim[] = [];
  readonly owners = new Map<string, Owner>();

  constructor(private readonly kind: Scene['kind'], private readonly layers: Layer[]) {}

  addOwner(owner: Owner): string {
    this.owners.set(owner.id, owner);
    return owner.id;
  }

  finish(): Scene {
    return {
      kind: this.kind,
      prims: this.prims,
      owners: this.owners,
      layers: this.layers,
      bounds: computeBounds(this.prims),
    };
  }

  // -------------------------------------------------------------------------

  graphics(gs: Graphic[], ctx: EmitContext): void {
    for (const g of gs) this.graphic(g, ctx);
  }

  graphic(g: Graphic, ctx: EmitContext): void {
    const layer = (n: number) => (ctx.layerMap ? ctx.layerMap(n) : n);
    const T = ctx.transform;
    switch (g.kind) {
      case 'wire':
        this.wire(g, ctx);
        break;
      case 'circle': {
        const c = apply(T, g.x, g.y);
        this.prims.push({ t: 'circle', cx: c.x, cy: c.y, r: g.radius, width: g.width, layer: layer(g.layer), owner: ctx.owner });
        break;
      }
      case 'rectangle': {
        // Rectangle rotation is about its own centre.
        const cx = (g.x1 + g.x2) / 2;
        const cy = (g.y1 + g.y2) / 2;
        const local = compose(T, placement(cx, cy, g.rot));
        const hw = Math.abs(g.x2 - g.x1) / 2;
        const hh = Math.abs(g.y2 - g.y1) / 2;
        const pts = [
          apply(local, -hw, -hh), apply(local, hw, -hh), apply(local, hw, hh), apply(local, -hw, hh),
        ];
        this.prims.push({ t: 'poly', pts, width: 0, fill: true, layer: layer(g.layer), owner: ctx.owner });
        break;
      }
      case 'polygon': {
        const pts = polygonOutline(g.vertices).map((p) => apply(T, p.x, p.y));
        this.prims.push({ t: 'poly', pts, width: g.width, fill: true, layer: layer(g.layer), owner: ctx.owner });
        break;
      }
      case 'text': {
        const text = ctx.substitute ? ctx.substitute(g.text) : g.text;
        if (text === undefined || text === '') break;
        this.text(text, g.x, g.y, g.size, g.rot, g.align, layer(g.layer), ctx);
        break;
      }
      case 'hole': {
        const c = apply(T, g.x, g.y);
        this.prims.push({ t: 'circle', cx: c.x, cy: c.y, r: g.drill / 2, width: 0.1, layer: 45, owner: ctx.owner });
        this.prims.push({ t: 'drill', cx: c.x, cy: c.y, r: g.drill / 2, layer: 45, owner: ctx.owner });
        break;
      }
      case 'frame': {
        const pts = [
          apply(T, g.x1, g.y1), apply(T, g.x2, g.y1), apply(T, g.x2, g.y2), apply(T, g.x1, g.y2),
        ];
        this.prims.push({ t: 'poly', pts, width: 0.254, fill: false, layer: layer(g.layer), owner: ctx.owner });
        break;
      }
    }
  }

  wire(w: Wire, ctx: EmitContext, dash?: number[]): void {
    const layer = ctx.layerMap ? ctx.layerMap(w.layer) : w.layer;
    const p1 = apply(ctx.transform, w.x1, w.y1);
    const p2 = apply(ctx.transform, w.x2, w.y2);
    const d = dash ?? dashFor(w.style, w.width);
    if (w.curve) {
      // A mirrored transform reverses the sweep direction.
      const t = ctx.transform;
      const sweep = t.a * t.d - t.b * t.c < 0 ? -w.curve : w.curve;
      const arc = arcFromChord(p1, p2, sweep);
      this.prims.push({ t: 'arc', ...arc, width: w.width, cap: w.cap, layer, owner: ctx.owner });
    } else {
      this.prims.push({
        t: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, width: w.width, cap: w.cap, layer, owner: ctx.owner,
        ...(d ? { dash: d } : {}),
      });
    }
  }

  /** Emit text at local (x, y) with a local rotation, applying Eagle's readability rules. */
  text(
    text: string, x: number, y: number, size: number, rot: Rotation, align: TextAlign,
    layer: number, ctx: EmitContext,
  ): void {
    const p = apply(ctx.transform, x, y);
    const abs = composeRotation(ctx.transform, rot);
    const placed = readableText(abs, align, ctx.textContext);
    this.prims.push({
      t: 'text', x: p.x, y: p.y, text, size, angle: placed.angle, mirror: placed.mirror,
      align: placed.align, layer, owner: ctx.owner,
    });
  }

  /** Through-hole pad on the Pads layer (17), plus its drill. */
  pad(pad: Pad, diameter: number, elongation: number, ctx: EmitContext): void {
    const T = compose(ctx.transform, placement(pad.x, pad.y, pad.rot));
    const r = diameter / 2;
    let local: Point[] | undefined;
    switch (pad.shape) {
      case 'square':
        local = [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }];
        break;
      case 'octagon':
        local = octagon(r);
        break;
      case 'long': {
        const half = (r * (100 + elongation)) / 100;
        local = stadium(-(half - r), half - r, r);
        break;
      }
      case 'offset': {
        const len = (diameter * elongation) / 100;
        local = stadium(0, len, r);
        break;
      }
      case 'round':
        break;
    }
    if (local) {
      this.prims.push({ t: 'poly', pts: local.map((q) => apply(T, q.x, q.y)), width: 0, fill: true, layer: 17, owner: ctx.owner });
    } else {
      const c = apply(T, 0, 0);
      this.prims.push({ t: 'circle', cx: c.x, cy: c.y, r, width: 0, layer: 17, owner: ctx.owner });
    }
    const c = apply(T, 0, 0);
    this.prims.push({ t: 'drill', cx: c.x, cy: c.y, r: pad.drill / 2, layer: 17, owner: ctx.owner });
  }

  smd(smd: Smd, ctx: EmitContext): void {
    const layer = ctx.layerMap ? ctx.layerMap(smd.layer) : smd.layer;
    const T = compose(ctx.transform, placement(smd.x, smd.y, smd.rot));
    const hw = smd.dx / 2;
    const hh = smd.dy / 2;
    const corner = (Math.min(hw, hh) * smd.roundness) / 100;
    const local = roundedRect(hw, hh, corner);
    this.prims.push({ t: 'poly', pts: local.map((q) => apply(T, q.x, q.y)), width: 0, fill: true, layer, owner: ctx.owner });
  }

  via(v: Via, diameter: number, owner: string): void {
    const r = diameter / 2;
    if (v.shape === 'round') {
      this.prims.push({ t: 'circle', cx: v.x, cy: v.y, r, width: 0, layer: 18, owner });
    } else {
      const local = v.shape === 'square'
        ? [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }]
        : octagon(r);
      this.prims.push({ t: 'poly', pts: local.map((q) => ({ x: q.x + v.x, y: q.y + v.y })), width: 0, fill: true, layer: 18, owner });
    }
    this.prims.push({ t: 'drill', cx: v.x, cy: v.y, r: v.drill / 2, layer: 18, owner });
  }
}

// ---------------------------------------------------------------------------
// Text readability

const H_FLIP: Record<string, string> = { left: 'right', right: 'left', center: 'center' };
const V_FLIP: Record<string, string> = { top: 'bottom', bottom: 'top', center: 'center' };

function splitAlign(a: TextAlign): [string, string] {
  if (a === 'center') return ['center', 'center'];
  const [v, h] = a.split('-') as [string, string];
  return [v, h];
}

function joinAlign(v: string, h: string): TextAlign {
  return (v === 'center' && h === 'center' ? 'center' : `${v}-${h}`) as TextAlign;
}

/**
 * Eagle keeps text readable: text that would read upside down (angle in (90°, 270°])
 * is turned by 180° with its alignment flipped, unless it has the spin flag.
 *
 * Input is an Eagle rotation (rotate, then mirror). Output is for drawing: glyphs are
 * rotated by `angle` with the mirror applied first (R·M), which for mirrored text means
 * angle = -θ. In schematics mirrored text is drawn unmirrored, with horizontal alignment
 * flipped; on boards it stays mirrored, readable when the board is viewed from below.
 */
export function readableText(
  rot: Rotation, align: TextAlign, context: TextContext,
): { angle: number; mirror: boolean; align: TextAlign } {
  let [v, h] = splitAlign(align);
  let angle = rot.angle;
  let mirror = rot.mirror;
  const flipUpright = () => {
    if (!rot.spin && angle > 90 && angle <= 270) {
      angle -= 180;
      h = H_FLIP[h]!;
      v = V_FLIP[v]!;
    }
  };
  if (!mirror) {
    flipUpright();
  } else if (context === 'board') {
    flipUpright(); // judged as seen from below, where the text reads at θ
    angle = -angle;
  } else {
    mirror = false;
    angle = -angle;
    h = H_FLIP[h]!;
    angle = ((angle % 360) + 360) % 360;
    flipUpright(); // drawn unmirrored, so judged as drawn
  }
  return { angle: ((angle % 360) + 360) % 360, mirror, align: joinAlign(v, h) };
}

// ---------------------------------------------------------------------------
// Shapes

function dashFor(style: Wire['style'], width: number): number[] | undefined {
  const u = Math.max(width, 0.1524);
  switch (style) {
    case 'longdash': return [u * 8, u * 4];
    case 'shortdash': return [u * 3, u * 3];
    case 'dashdot': return [u * 8, u * 3, u * 1, u * 3];
    default: return undefined;
  }
}

/** Flatten a polygon's vertex list (with optional per-edge arcs) into points. */
export function polygonOutline(vs: { x: number; y: number; curve: number }[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    out.push({ x: a.x, y: a.y });
    if (a.curve) {
      const pts = arcPoints(arcFromChord(a, b, a.curve), Math.max(4, Math.ceil(Math.abs(a.curve) / 10)));
      out.push(...pts.slice(1, -1));
    }
  }
  return out;
}

function octagon(r: number): Point[] {
  const k = r * Math.tan(Math.PI / 8);
  return [
    { x: -k, y: -r }, { x: k, y: -r }, { x: r, y: -k }, { x: r, y: k },
    { x: k, y: r }, { x: -k, y: r }, { x: -r, y: k }, { x: -r, y: -k },
  ];
}

/** Obround from x0 to x1 (centres of the end caps) with radius r. */
function stadium(x0: number, x1: number, r: number): Point[] {
  const pts: Point[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    pts.push({ x: x1 + r * Math.cos(a), y: r * Math.sin(a) });
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / n;
    pts.push({ x: x0 + r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

function roundedRect(hw: number, hh: number, r: number): Point[] {
  if (r <= 0) return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  const pts: Point[] = [];
  const corners = [
    { x: hw - r, y: -hh + r, a: -Math.PI / 2 },
    { x: hw - r, y: hh - r, a: 0 },
    { x: -hw + r, y: hh - r, a: Math.PI / 2 },
    { x: -hw + r, y: -hh + r, a: Math.PI },
  ];
  for (const c of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = c.a + (Math.PI / 2) * (i / 6);
      pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Bounds

export function primBounds(p: Prim): Bounds {
  switch (p.t) {
    case 'line': {
      const h = p.width / 2;
      return {
        minX: Math.min(p.x1, p.x2) - h, minY: Math.min(p.y1, p.y2) - h,
        maxX: Math.max(p.x1, p.x2) + h, maxY: Math.max(p.y1, p.y2) + h,
      };
    }
    case 'arc': {
      const b = emptyBounds();
      for (const q of arcPoints(p, 16)) extend(b, q.x, q.y);
      return pad(b, p.width / 2);
    }
    case 'circle':
    case 'drill': {
      const r = p.r + (p.t === 'circle' ? p.width / 2 : 0);
      return { minX: p.cx - r, minY: p.cy - r, maxX: p.cx + r, maxY: p.cy + r };
    }
    case 'poly': {
      const b = emptyBounds();
      for (const q of p.pts) extend(b, q.x, q.y);
      return pad(b, p.width / 2);
    }
    case 'text': {
      const b = emptyBounds();
      for (const q of textCorners(p)) extend(b, q.x, q.y);
      return b;
    }
  }
}

/** Approximate rotated bounding box of a text primitive (assumes ~0.7em average glyph width). */
export function textCorners(p: {
  x: number; y: number; text: string; size: number; angle: number; mirror: boolean; align: TextAlign;
}): Point[] {
  const lines = p.text.split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * p.size * 0.75;
  const h = p.size * (1 + (lines.length - 1) * 1.5);
  const [v, hz] = splitAlign(p.align);
  const x0 = hz === 'left' ? 0 : hz === 'right' ? -w : -w / 2;
  const y0 = v === 'bottom' ? 0 : v === 'top' ? -h : -h / 2;
  // Drawing convention is R(angle)·M, which equals placement's M·R(-angle).
  const T = placement(p.x, p.y, { angle: p.mirror ? -p.angle : p.angle, mirror: p.mirror, spin: false });
  return [
    apply(T, x0, y0), apply(T, x0 + w, y0), apply(T, x0 + w, y0 + h), apply(T, x0, y0 + h),
  ];
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extend(b: Bounds, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

export function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function pad(b: Bounds, d: number): Bounds {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

function computeBounds(prims: Prim[]): Bounds {
  let b = emptyBounds();
  for (const p of prims) b = union(b, primBounds(p));
  if (!Number.isFinite(b.minX)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  return b;
}
