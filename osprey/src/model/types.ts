// The native Osprey project model: the in-memory form of a `.osprey` file.
// See docs/format.md. Lengths are millimetres, points are [x, y] with y up,
// rotations are degrees counter-clockwise. Optional fields are omitted at their defaults.

export const FORMAT_VERSION = 1;

export type Pt = [number, number];
/** A polygon point; the optional third number is the arc sweep (degrees) to the next point. */
export type PolyPt = [number, number] | [number, number, number];

/** Layer names by role, e.g. "copper.top", "silk.top", "nets"; "eagle.N" for others. */
export type LayerName = string;

/** XML kept as data: ["tag", {attributes}?, ...children]. Used only by the passthrough. */
export type JsonML = [string, ...(Record<string, string> | JsonML | string)[]];

/** Eagle data on an object that Osprey doesn't model yet, written back on export. */
export interface ObjectPassthrough {
  attrs?: Record<string, string>;
  children?: JsonML[];
}

interface Extensible {
  eagle?: ObjectPassthrough;
}

// ---------------------------------------------------------------------------
// Graphics

export type TextAlign =
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
  | 'center-left' | 'center' | 'center-right'
  | 'top-left' | 'top-center' | 'top-right';

export interface TextStyle {
  rot?: number;
  mirror?: boolean;
  spin?: boolean;
  size: number;
  layer: LayerName;
  ratio?: number;
  align?: TextAlign;
  font?: 'vector' | 'fixed';
}

export interface LineShape extends Extensible {
  line: [Pt, Pt];
  width: number;
  layer: LayerName;
  curve?: number;
  cap?: 'flat';
  style?: 'longdash' | 'shortdash' | 'dashdot';
}

export interface CircleShape extends Extensible {
  circle: Pt;
  radius: number;
  width: number;
  layer: LayerName;
}

export interface RectShape extends Extensible {
  rect: [Pt, Pt];
  rot?: number;
  layer: LayerName;
}

export interface PolygonShape extends Extensible {
  polygon: PolyPt[];
  width: number;
  layer: LayerName;
  pour?: 'hatch' | 'cutout';
  isolate?: number;
  spacing?: number;
  rank?: number;
  thermals?: false;
  orphans?: true;
}

export interface TextShape extends TextStyle, Extensible {
  text: string;
  at: Pt;
}

export interface HoleShape extends Extensible {
  hole: Pt;
  drill: number;
}

export interface FrameShape extends Extensible {
  frame: [Pt, Pt];
  columns: number;
  rows: number;
  layer: LayerName;
}

export type Graphic = LineShape | CircleShape | RectShape | PolygonShape | TextShape | HoleShape | FrameShape;

// ---------------------------------------------------------------------------
// Library

export interface Library {
  symbols: Symbol[];
  footprints: Footprint[];
  components: Component[];
}

export type PinDirection = 'nc' | 'in' | 'out' | 'io' | 'oc' | 'power' | 'passive' | 'hiz' | 'supply';

export interface Pin extends Extensible {
  name: string;
  at: Pt;
  rot?: number;
  length?: 'point' | 'short' | 'middle';
  direction?: Exclude<PinDirection, 'io'>;
  function?: 'dot' | 'clock' | 'dotclock';
  visible?: 'pad' | 'pin' | 'none';
  swap?: number;
}

export interface Symbol extends Extensible {
  /** "library/name" */
  id: string;
  description?: string;
  graphics: Graphic[];
  pins: Pin[];
}

export interface Pad extends Extensible {
  name: string;
  /** SMD: copper size [dx, dy]. Absent for through-hole pads. */
  smd?: Pt;
  at: Pt;
  rot?: number;
  // SMD
  roundness?: number;
  side?: 'bottom';
  mask?: false;
  paste?: false;
  // Through-hole
  drill?: number;
  diameter?: number;
  shape?: 'square' | 'octagon' | 'long' | 'offset';
  first?: true;
  // Both
  thermals?: false;
}

export interface Footprint extends Extensible {
  id: string;
  description?: string;
  graphics: Graphic[];
  pads: Pad[];
}

export interface Gate extends Extensible {
  name: string;
  symbol: string;
  at: Pt;
  addLevel?: 'must' | 'can' | 'always' | 'request';
  swap?: number;
}

/** A technology attribute: its value, or { value, constant: false } when users may change it. */
export type AttributeValue = string | { value: string; constant: false };

export interface Variant extends Extensible {
  name: string;
  footprint?: string;
  /** "gate.pin" → pad names */
  pads: Record<string, string[]>;
  /** technology → attribute → value (omitted when there is only the empty technology) */
  technologies?: Record<string, Record<string, AttributeValue>>;
}

export interface Component extends Extensible {
  id: string;
  prefix?: string;
  userValue?: true;
  description?: string;
  gates: Gate[];
  variants: Variant[];
}

// ---------------------------------------------------------------------------
// Design

export interface Part extends Extensible {
  name: string;
  component: string;
  variant: string;
  technology?: string;
  /** Absent when the value is generated from the component (see generatedValue). */
  value?: string;
  attributes?: Record<string, string>;
}

export interface PinRef {
  part: string;
  gate: string;
  pin: string;
}

/** A board pad reference, used for nets only in board-only projects. */
export interface PadRef {
  part: string;
  pad: string;
}

export interface Wire extends Extensible {
  line: [Pt, Pt];
  width: number;
  /** Default "nets" (or "busses" in a bus). */
  layer?: LayerName;
  curve?: number;
  cap?: 'flat';
  style?: 'longdash' | 'shortdash' | 'dashdot';
}

export interface Trace extends LineShape {}

export interface NetLabel extends TextStyle, Extensible {
  at: Pt;
  xref?: true;
}

export interface Segment extends Extensible {
  sheet: string;
  pins: PinRef[];
  wires: Wire[];
  junctions?: Pt[];
  labels?: NetLabel[];
}

export interface Via extends Extensible {
  at: Pt;
  drill: number;
  diameter?: number;
  /** Copper layer span as Eagle writes it, e.g. "1-16". Default "1-16". */
  layers?: string;
  shape?: 'square' | 'octagon';
}

export interface Net extends Extensible {
  name: string;
  class?: number;
  segments?: Segment[];
  /** Only in board-only projects (no schematic to derive pads from). */
  pads?: PadRef[];
  traces?: Trace[];
  vias?: Via[];
  pours?: PolygonShape[];
}

export interface Bus extends Extensible {
  name: string;
  segments: { sheet: string; wires: Wire[]; labels?: NetLabel[] }[];
}

/** A smashed part's independently placed name/value/attribute text. */
export interface Label extends TextStyle, Extensible {
  attr: string;
  /** Present only when the label carries its own value (e.g. a board element attribute). */
  value?: string;
  at: Pt;
  display?: 'name' | 'both' | 'none';
}

export interface GatePlacement extends Extensible {
  part: string;
  gate: string;
  at: Pt;
  rot?: number;
  mirror?: true;
  smashed?: true;
  labels?: Label[];
}

export interface Sheet extends Extensible {
  id: string;
  description?: string;
  gates: GatePlacement[];
  drawing: Graphic[];
}

export interface Grid {
  step: number;
  fine: number;
  /** Unit shown to the user for this grid: "mm" | "mil" | "inch" | "mic". */
  unit?: string;
}

export interface Schematic extends Extensible {
  grid: Grid;
  sheets: Sheet[];
}

export interface FootprintPlacement extends Extensible {
  part: string;
  at: Pt;
  rot?: number;
  side?: 'bottom';
  locked?: true;
  smashed?: true;
  labels?: Label[];
}

export interface NetClass extends Extensible {
  number: number;
  name: string;
  width?: number;
  drill?: number;
}

export interface Board extends Extensible {
  grid: Grid;
  /** Copper stack, top to bottom. */
  layers: LayerName[];
  classes?: NetClass[];
  footprints: FootprintPlacement[];
  drawing: Graphic[];
}

export interface ProjectInfo {
  name: string;
  imported?: { from: string[]; date: string; eagleVersion: string };
}

/** Document-level Eagle data not modelled yet, per source document, as JsonML. */
export interface DocumentPassthrough {
  schematic?: JsonML[];
  board?: JsonML[];
}

export interface Project {
  osprey: number;
  project: ProjectInfo;
  library: Library;
  parts: Part[];
  nets: Net[];
  busses?: Bus[];
  schematic?: Schematic;
  board?: Board;
  eagle?: DocumentPassthrough;
}
