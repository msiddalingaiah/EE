// A Scene is a flat list of drawable primitives in world coordinates (mm, y-up).
// Every primitive belongs to an owner: the selectable design object (the "noun").

import type { Layer, TextAlign } from '../eagle/types';
import type { Point } from '../geom/transform';

export type OwnerKind =
  | 'instance' // schematic: placed gate of a part
  | 'net-wire'
  | 'bus-wire'
  | 'junction'
  | 'label'
  | 'element' // board: placed package
  | 'signal-wire'
  | 'via'
  | 'signal-polygon'
  | 'plain' // free graphics in schematic/board plain
  | 'library-item'; // a symbol/package/deviceset shown in library view

export interface Owner {
  id: string;
  kind: OwnerKind;
  /** Short human label, e.g. "R1" or "wire on GND". */
  label: string;
  /** Properties for the inspector. */
  props: [string, string][];
  /** Net/signal name, for highlighting connectivity. */
  net?: string;
}

interface PrimBase {
  layer: number;
  owner: string;
}

export interface LinePrim extends PrimBase {
  t: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  cap: 'round' | 'flat';
  dash?: number[];
}

export interface ArcPrim extends PrimBase {
  t: 'arc';
  cx: number;
  cy: number;
  r: number;
  start: number;
  sweep: number;
  width: number;
  cap: 'round' | 'flat';
}

export interface CirclePrim extends PrimBase {
  t: 'circle';
  cx: number;
  cy: number;
  r: number;
  /** 0 = filled disc. */
  width: number;
}

export interface PolyPrim extends PrimBase {
  t: 'poly';
  pts: Point[];
  /** Outline width; 0 = no outline. */
  width: number;
  fill: boolean;
  dash?: number[];
}

export interface TextPrim extends PrimBase {
  t: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  /** Final on-screen angle in degrees CCW, after readability adjustment. */
  angle: number;
  /** Draw glyphs mirrored (bottom-side board text). */
  mirror: boolean;
  align: TextAlign;
}

/** A drilled hole: drawn as a cut-out through everything below it. */
export interface DrillPrim extends PrimBase {
  t: 'drill';
  cx: number;
  cy: number;
  r: number;
}

export type Prim = LinePrim | ArcPrim | CirclePrim | PolyPrim | TextPrim | DrillPrim;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Scene {
  kind: 'schematic' | 'board' | 'library';
  prims: Prim[];
  owners: Map<string, Owner>;
  layers: Layer[];
  bounds: Bounds;
}
