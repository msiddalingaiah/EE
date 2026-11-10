// Design rules: Eagle's parameter set (as in a board's <designrules> or a .dru file), lookups
// with Eagle's defaults, and loading a .dru file into a project.
//
// The rules live in the board's Eagle passthrough (docs/format.md, "Passthrough"), so they are
// written back on export unchanged.

import { parseDistance } from '../eagle/parse';
import type { JsonML, Project } from './types';

/** Kinds of copper the clearance rules distinguish. */
export type CopperKind = 'wire' | 'pad' | 'smd' | 'via';

const MIL = 0.0254;

/** Design-rule lookups with Eagle's defaults. */
export class DesignRules {
  constructor(private readonly params: Map<string, string>) {}

  get name(): string | undefined {
    return this.params.get('@name');
  }

  private ratio(name: string, dflt: number): number {
    const v = this.params.get(name);
    return v === undefined || !Number.isFinite(Number(v)) ? dflt : Number(v);
  }

  private dist(name: string, dflt: number): number {
    const v = this.params.get(name);
    if (v === undefined) return dflt;
    try {
      // Multi-value parameters (one per layer) start with the outer layer's value.
      return parseDistance(v.trim().split(/\s+/)[0]!);
    } catch {
      return dflt;
    }
  }

  private restring(drill: number, kind: 'PadTop' | 'ViaOuter'): number {
    const rv = this.ratio(`rv${kind}`, 0.25);
    const min = this.dist(`rlMin${kind}`, 10 * MIL);
    const max = this.dist(`rlMax${kind}`, 20 * MIL);
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

  /** Minimum distance between copper of different nets. */
  clearance(a: CopperKind, b: CopperKind): number {
    const [x, y] = [a, b].sort((p, q) => ORDER.indexOf(p) - ORDER.indexOf(q)) as [CopperKind, CopperKind];
    return this.dist(CLEARANCE[`${x}-${y}`]!, 8 * MIL);
  }

  /** The largest clearance of any pair (for search margins). */
  get maxClearance(): number {
    return Math.max(...Object.values(CLEARANCE).map((n) => this.dist(n, 8 * MIL)));
  }

  /** Minimum trace width. */
  get minWidth(): number {
    return this.dist('msWidth', 10 * MIL);
  }

  /** Minimum drill. */
  get minDrill(): number {
    return this.dist('msDrill', 24 * MIL);
  }

  /** Minimum distance from copper to the board outline. */
  get copperDimension(): number {
    return this.dist('mdCopperDimension', 40 * MIL);
  }

  /** Gap between a pad and the pour around it, crossed by thermal spokes. */
  get thermalIsolate(): number {
    return this.dist('slThermalIsolate', 10 * MIL);
  }

  /** Whether vias get thermals in pours (else they connect fully). */
  get thermalsForVias(): boolean {
    return this.ratio('slThermalsForVias', 0) !== 0;
  }

  /**
   * How far the solder mask opening extends beyond a pad, SMD, via or hole whose smaller
   * dimension is `size`: a ratio of it, limited by a minimum and maximum.
   */
  stopFrame(size: number): number {
    return Math.min(Math.max(size * this.ratio('rvStopMask', 1), this.dist('mlMinStopFrame', 4 * MIL)), this.dist('mlMaxStopFrame', 4 * MIL));
  }

  /** How far the solder paste is drawn in from an SMD's edge (the same way as the stop frame). */
  creamFrame(size: number): number {
    return Math.min(Math.max(size * this.ratio('rvCreamMask', 0), this.dist('mlMinCreamFrame', 0)), this.dist('mlMaxCreamFrame', 0));
  }

  /** Vias with a larger drill get a solder mask opening; smaller ones are covered (tented). */
  get viaStopLimit(): number {
    return this.dist('mlViaStopLimit', 100 * MIL);
  }
}

const ORDER: CopperKind[] = ['wire', 'pad', 'smd', 'via'];
const CLEARANCE: Record<string, string> = {
  'wire-wire': 'mdWireWire',
  'wire-pad': 'mdWirePad',
  'wire-smd': 'mdWirePad',
  'wire-via': 'mdWireVia',
  'pad-pad': 'mdPadPad',
  'pad-smd': 'mdSmdPad',
  'pad-via': 'mdPadVia',
  'smd-smd': 'mdSmdSmd',
  'smd-via': 'mdSmdVia',
  'via-via': 'mdViaVia',
};

/** The design-rule parameters of a project's board (name → raw value; "@name" is the rule set's name). */
export function designRules(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  const node = rulesNode(project);
  if (!node) return out;
  const attrs = node[1];
  if (attrs && !Array.isArray(attrs) && typeof attrs === 'object' && attrs.name) out.set('@name', attrs.name);
  for (const c of node.slice(1)) {
    if (!Array.isArray(c) || c[0] !== 'param') continue;
    const a = c[1];
    if (a && !Array.isArray(a) && typeof a === 'object') out.set(a.name ?? '', a.value ?? '');
  }
  return out;
}

export function boardGroup(project: Project): JsonML | undefined {
  return project.eagle?.board?.find((e) => e[0] === 'board');
}

export function rulesNode(project: Project): JsonML | undefined {
  return boardGroup(project)?.find((c): c is JsonML => Array.isArray(c) && c[0] === 'designrules');
}

/** A parsed .dru file. */
export interface DruFile {
  description?: string;
  params: [string, string][];
}

/** Parse an Eagle .dru file: "name = value" lines; "description[en] = …" is the description. */
export function parseDru(text: string): DruFile {
  const params: [string, string][] = [];
  let description: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w]*)(\[[\w-]+\])?\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'description') {
      if (!m[2] || m[2] === '[en]' || description === undefined) description = m[3]!.replace(/\\n/g, '\n');
      continue;
    }
    params.push([m[1]!, m[3]!]);
  }
  if (!params.length) throw new Error('No design rules found (expected "name = value" lines)');
  return description === undefined ? { params } : { description, params };
}

