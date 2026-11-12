// A Scene is a flat list of drawable primitives in world coordinates (mm, y-up).
// Every primitive belongs to an owner: the selectable design object (the "noun").

import type { Layer, TextAlign } from '../eagle/types';
import type { Point } from '../geom/transform';
import type * as O from '../model/types';

/** A schematic wiring piece: a net segment, or a bus segment. */
export type WireSegment = O.Segment | O.Bus['segments'][number];

/** The model object an owner stands for: what edit commands operate on. */
export type Target =
  // Schematic
  | { kind: 'gate'; sheet: O.Sheet; gate: O.GatePlacement }
  | { kind: 'wire'; net: O.Net | O.Bus; segment: WireSegment; wire: O.Wire; bus?: true }
  | { kind: 'junction'; net: O.Net; segment: O.Segment; junction: O.Pt }
  | { kind: 'netlabel'; net: O.Net | O.Bus; segment: WireSegment; label: O.NetLabel }
  // Board
  | { kind: 'footprint'; footprint: O.FootprintPlacement }
  | { kind: 'trace'; net: O.Net; trace: O.Trace }
  | { kind: 'via'; net: O.Net; via: O.Via }
  | { kind: 'pour'; net: O.Net; pour: O.PolygonShape }
  // Library: a symbol's pins, a footprint's pads (their graphics are drawings)
  | { kind: 'pin'; symbol: O.Symbol; pin: O.Pin }
  | { kind: 'pad'; footprint: O.Footprint; pad: O.Pad }
  // Library: a component's gate (where its symbol sits in the component)
  | { kind: 'libgate'; component: O.Component; gate: O.Gate }
  // Either
  | { kind: 'drawing'; doc: 'schematic' | 'board'; graphic: O.Graphic; container: O.Graphic[] }
  | { kind: 'label'; doc: 'schematic' | 'board'; placement: O.GatePlacement | O.FootprintPlacement; label: O.Label };

export type OwnerKind =
  | Target['kind']
  | 'bus-wire'
  | 'airwire' // computed; selectable for inspection, not editable
  | 'library-item'; // a symbol/footprint/component shown in the library view

export interface Owner {
  id: string;
  kind: OwnerKind;
  /** Short human label, e.g. "R1" or "wire on GND". */
  label: string;
  /** Properties for the inspector. */
  props: [string, string][];
  /** Net/signal name, for highlighting connectivity. */
  net?: string;
  /** Editable model object (board objects only, for now). */
  target?: Target;
  /** Reference point for snapping and rotating a single object (e.g. a part's origin). */
  origin?: Point;
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
  /** Holes in a filled polygon (e.g. poured copper around other nets). */
  holes?: Point[][];
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
  /** Stroke width as % of size (Eagle's ratio); board text is drawn bolder when it's large. */
  ratio?: number;
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
