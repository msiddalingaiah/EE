// Typed model of Eagle 6+ XML files (.sch, .brd, .lbr).
// Coordinates are in millimetres, y-up, exactly as stored in the file.

/** Eagle rotation spec such as "R90", "MR180", "SR0", "SMR270". */
export interface Rotation {
  /** Degrees counter-clockwise, normalised to [0, 360). */
  angle: number;
  /** Mirrored about the Y axis (applied before rotation). */
  mirror: boolean;
  /** Spin: text is not flipped to stay readable. */
  spin: boolean;
}

export interface Layer {
  number: number;
  name: string;
  color: number;
  fill: number;
  visible: boolean;
  active: boolean;
}

export interface Grid {
  distance: number;
  unitdist: string;
  unit: string;
  altdistance: number;
  altunitdist: string;
}

// ---------------------------------------------------------------------------
// Graphic primitives shared by symbols, packages, plain drawing, nets, signals

export interface Wire {
  kind: 'wire';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  layer: number;
  /** Arc sweep in degrees, counter-clockwise from (x1,y1) to (x2,y2). 0 = straight. */
  curve: number;
  cap: 'round' | 'flat';
  style: 'continuous' | 'longdash' | 'shortdash' | 'dashdot';
}

export interface Circle {
  kind: 'circle';
  x: number;
  y: number;
  radius: number;
  /** 0 means filled. */
  width: number;
  layer: number;
}

export interface Rectangle {
  kind: 'rectangle';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: number;
  rot: Rotation;
}

export interface Vertex {
  x: number;
  y: number;
  /** Arc sweep from this vertex to the next one. */
  curve: number;
}

export interface Polygon {
  kind: 'polygon';
  width: number;
  layer: number;
  vertices: Vertex[];
  pour: 'solid' | 'hatch' | 'cutout';
  isolate: number | undefined;
}

export type TextAlign =
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
  | 'center-left' | 'center' | 'center-right'
  | 'top-left' | 'top-center' | 'top-right';

export interface Text {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  layer: number;
  font: 'vector' | 'proportional' | 'fixed';
  ratio: number;
  rot: Rotation;
  align: TextAlign;
}

export interface Hole {
  kind: 'hole';
  x: number;
  y: number;
  drill: number;
}

export interface Frame {
  kind: 'frame';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  columns: number;
  rows: number;
  layer: number;
}

export type Graphic = Wire | Circle | Rectangle | Polygon | Text | Hole | Frame;

// ---------------------------------------------------------------------------
// Library contents

export type PadShape = 'round' | 'square' | 'octagon' | 'long' | 'offset';

export interface Pad {
  kind: 'pad';
  name: string;
  x: number;
  y: number;
  drill: number;
  /** 0 = automatic (derived from design rules). */
  diameter: number;
  shape: PadShape;
  rot: Rotation;
  first: boolean;
}

export interface Smd {
  kind: 'smd';
  name: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  layer: number;
  /** Corner roundness in percent (0..100). */
  roundness: number;
  rot: Rotation;
}

export interface Package {
  name: string;
  description: string;
  graphics: Graphic[];
  pads: (Pad | Smd)[];
}

export type PinLength = 'point' | 'short' | 'middle' | 'long';
export type PinVisible = 'off' | 'pad' | 'pin' | 'both';
export type PinDirection = 'nc' | 'in' | 'out' | 'io' | 'oc' | 'pwr' | 'pas' | 'hiz' | 'sup';
export type PinFunction = 'none' | 'dot' | 'clk' | 'dotclk';

export interface Pin {
  name: string;
  x: number;
  y: number;
  length: PinLength;
  visible: PinVisible;
  direction: PinDirection;
  function: PinFunction;
  rot: Rotation;
  swaplevel: number;
}

export interface Symbol {
  name: string;
  description: string;
  graphics: Graphic[];
  pins: Pin[];
}

export interface Gate {
  name: string;
  symbol: string;
  x: number;
  y: number;
  addlevel: string;
  swaplevel: number;
}

export interface Connect {
  gate: string;
  pin: string;
  /** Pad names; Eagle allows several pads per pin, space separated. */
  pads: string[];
}

export interface Attribute {
  name: string;
  value: string;
  constant: boolean;
}

export interface Device {
  name: string;
  package: string | undefined;
  connects: Connect[];
  /** technology name -> attributes */
  technologies: Map<string, Attribute[]>;
}

export interface DeviceSet {
  name: string;
  prefix: string;
  uservalue: boolean;
  description: string;
  gates: Gate[];
  devices: Device[];
}

export interface Library {
  name: string;
  urn: string | undefined;
  description: string;
  packages: Map<string, Package>;
  symbols: Map<string, Symbol>;
  devicesets: Map<string, DeviceSet>;
}

// ---------------------------------------------------------------------------
// Schematic

/** Placed attribute text (on smashed instances/elements). */
export interface PlacedAttribute {
  name: string;
  value: string | undefined;
  x: number | undefined;
  y: number | undefined;
  size: number | undefined;
  layer: number | undefined;
  rot: Rotation;
  ratio: number | undefined;
  align: TextAlign;
  display: 'off' | 'value' | 'name' | 'both';
}

export interface Part {
  name: string;
  library: string;
  libraryUrn: string | undefined;
  deviceset: string;
  device: string;
  technology: string;
  value: string | undefined;
  attributes: PlacedAttribute[];
}

export interface Instance {
  part: string;
  gate: string;
  x: number;
  y: number;
  smashed: boolean;
  rot: Rotation;
  attributes: PlacedAttribute[];
}

export interface PinRef {
  part: string;
  gate: string;
  pin: string;
}

export interface Junction {
  kind: 'junction';
  x: number;
  y: number;
}

export interface Label {
  kind: 'label';
  x: number;
  y: number;
  size: number;
  layer: number;
  rot: Rotation;
  xref: boolean;
  align: TextAlign;
}

export interface Segment {
  wires: Wire[];
  junctions: Junction[];
  labels: Label[];
  pinrefs: PinRef[];
}

export interface Net {
  name: string;
  netClass: number;
  segments: Segment[];
}

export interface Bus {
  name: string;
  segments: Segment[];
}

export interface Sheet {
  description: string;
  plain: Graphic[];
  instances: Instance[];
  nets: Net[];
  busses: Bus[];
}

export interface NetClass {
  number: number;
  name: string;
  width: number;
  drill: number;
}

export interface Schematic {
  libraries: Library[];
  classes: NetClass[];
  parts: Map<string, Part>;
  sheets: Sheet[];
}

// ---------------------------------------------------------------------------
// Board

export interface Element {
  name: string;
  library: string;
  libraryUrn: string | undefined;
  package: string;
  value: string;
  x: number;
  y: number;
  locked: boolean;
  smashed: boolean;
  rot: Rotation;
  attributes: PlacedAttribute[];
}

export interface ContactRef {
  element: string;
  pad: string;
}

export interface Via {
  kind: 'via';
  x: number;
  y: number;
  /** Layer span, e.g. "1-16". */
  extent: string;
  drill: number;
  /** 0 = automatic. */
  diameter: number;
  shape: 'round' | 'square' | 'octagon';
}

export interface Signal {
  name: string;
  netClass: number;
  contactrefs: ContactRef[];
  wires: Wire[];
  vias: Via[];
  polygons: Polygon[];
}

export interface Board {
  libraries: Library[];
  classes: NetClass[];
  /** Design-rule parameters, raw string values keyed by name. */
  designRules: Map<string, string>;
  plain: Graphic[];
  elements: Element[];
  signals: Signal[];
}

// ---------------------------------------------------------------------------

export interface EagleFile {
  /** The parsed XML document. Edits are written into it; saving serializes it. */
  dom: Document;
  /** Line ending used by the original file, restored on save. */
  lineEnding: '\n' | '\r\n';
  /** Original text before and after the root element (XML declaration, DOCTYPE, whitespace). */
  prolog: string;
  epilog: string;
  version: string;
  layers: Layer[];
  grid: Grid | undefined;
  schematic?: Schematic;
  board?: Board;
  library?: Library;
}
