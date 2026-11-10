// CAM jobs: which Eagle layers go into which Gerber file, and the drill file. Eagle `.cam` job
// files (JSON, Eagle 8.6+) can be read; the default job is the common two-layer set (the same
// files and layers as JLCPCB's Eagle job).

import type { Point } from '../geom/transform';
import { ProjectIndex } from '../model/derive';
import type * as O from '../model/types';
import { writeExcellon } from './excellon';
import { GerberWriter } from './gerber';
import { plotBoard, type Feature } from './plot';

export interface GerberOutput {
  /** Shown in the file (%IN) and to the user, e.g. "Top Copper". */
  name: string;
  /** File name; "%N" is the board's name. */
  file: string;
  layers: number[];
  /** X2 file function, e.g. "Copper,L1,Top" or "Legend,Top". */
  function?: string;
}

export interface CamJob {
  name: string;
  gerbers: GerberOutput[];
  /** Excellon file name ("%N" is the board's name), plated and unplated holes merged. */
  drill?: string;
}

export const DEFAULT_JOB: CamJob = {
  name: '2-layer Gerber and drill',
  gerbers: [
    { name: 'Board Outline', file: '%N.GKO', layers: [46, 20], function: 'Profile,NP' },
    { name: 'Top Copper', file: '%N.GTL', layers: [1, 18, 17], function: 'Copper,L1,Top' },
    { name: 'Bottom Copper', file: '%N.GBL', layers: [16, 17, 18], function: 'Copper,L2,Bot' },
    { name: 'Soldermask Top', file: '%N.GTS', layers: [29], function: 'Soldermask,Top' },
    { name: 'Soldermask Bottom', file: '%N.GBS', layers: [30], function: 'Soldermask,Bot' },
    { name: 'Solderpaste Top', file: '%N.GTP', layers: [31], function: 'Paste,Top' },
    { name: 'Solderpaste Bottom', file: '%N.GBP', layers: [32], function: 'Paste,Bot' },
    { name: 'Silkscreen Top', file: '%N.GTO', layers: [21, 25], function: 'Legend,Top' },
    { name: 'Silkscreen Bottom', file: '%N.GBO', layers: [22, 26], function: 'Legend,Bot' },
  ],
  drill: '%N.XLN',
};

interface CamFile {
  description?: Record<string, string>;
  outputs?: {
    output_type?: string;
    outputs?: {
      type?: string;
      name?: string;
      filename_format?: string;
      layers?: number[] | object;
      polarity?: string;
      config?: { file_function?: string; layer?: number; layer_type?: string; index?: number };
    }[];
  }[];
}

/** Read an Eagle `.cam` job file (JSON). Outputs Osprey doesn't make (drawings, assembly) are skipped. */
export function parseCamJob(text: string, name = 'CAM job'): CamJob {
  let cam: CamFile;
  try {
    cam = JSON.parse(text) as CamFile;
  } catch {
    throw new Error('Not an Eagle CAM job: only the JSON .cam files of Eagle 8.6 and later can be read');
  }
  const job: CamJob = { name, gerbers: [] };
  for (const group of cam.outputs ?? []) {
    for (const o of group.outputs ?? []) {
      if (group.output_type === 'gerber' && o.type === 'gerber_layer' && Array.isArray(o.layers) && o.filename_format) {
        const c = o.config ?? {};
        const side = c.layer_type === 'bottom' ? 'Bot' : 'Top';
        const fn =
          c.file_function === 'Copper' ? `Copper,L${c.layer ?? 1},${side}`
            : c.file_function === 'Profile' ? 'Profile,NP'
              : c.file_function ? `${c.file_function},${side}` : undefined;
        job.gerbers.push({ name: o.name ?? o.filename_format, file: o.filename_format, layers: o.layers, ...(fn ? { function: fn } : {}) });
      } else if (group.output_type === 'drill' && o.type === 'excellon' && o.filename_format && !job.drill) {
        job.drill = o.filename_format;
      }
    }
  }
  if (!job.gerbers.length && !job.drill) throw new Error('The CAM job has no Gerber or Excellon outputs');
  return job;
}

/** Silkscreen layers: placement, names and values, top and bottom. */
const SILK_LAYERS = new Set([21, 22, 25, 26, 27, 28]);
/** The thinnest silkscreen line fabs commonly print reliably (JLCPCB: 0.15 mm). */
export const MIN_SILK_STROKE = 0.15;

export interface CamResult {
  /** File name → contents. */
  files: Map<string, string>;
  /** Things that were left out or can't be trusted, for the user. */
  warnings: string[];
}

/** Run a CAM job on a project's board. */
export function runCam(project: O.Project, job: CamJob = DEFAULT_JOB, index = new ProjectIndex(project)): CamResult {
  const plot = plotBoard(project, index);
  const name = project.project.name;
  const files = new Map<string, string>();
  const warnings: string[] = [];
  for (const out of job.gerbers) {
    const w = new GerberWriter(out.name, out.function ? [`FileFunction,${out.function}`] : []);
    const features = out.layers.flatMap((l) => plot.layers.get(l) ?? []);
    writeFeatures(w, features);
    files.set(out.file.replace(/%N/g, name), w.toString());
    const thin = out.layers.filter((l) => SILK_LAYERS.has(l)).flatMap((l) => plot.texts.get(l) ?? []).filter((w) => w < MIN_SILK_STROKE - 1e-9);
    if (thin.length) {
      warnings.push(
        `${out.name}: ${thin.length} text${thin.length === 1 ? ' has' : 's have'} strokes thinner than ${MIN_SILK_STROKE} mm ` +
          `(thinnest ${Math.min(...thin).toFixed(3)} mm), which fabs may print faintly or not at all; a larger size or ratio makes them bolder`,
      );
    }
  }
  if (job.drill) files.set(job.drill.replace(/%N/g, name), writeExcellon(plot.drills));
  return { files, warnings };
}

/**
 * Poured copper first, largest island first: each island dark with its holes cleared, so an
 * island inside another's hole comes later and stays. Everything else after, dark, so a clear
 * hole never removes a pad or trace.
 */
function writeFeatures(w: GerberWriter, features: Feature[]): void {
  const fills = features.filter((f): f is Extract<Feature, { t: 'fill' }> => f.t === 'fill');
  fills.sort((a, b) => Math.abs(area(b.outer)) - Math.abs(area(a.outer)));
  for (const f of fills) {
    w.polarity(true);
    w.region(f.outer);
    if (f.holes.length) {
      w.polarity(false);
      for (const h of f.holes) w.region(h);
    }
  }
  w.polarity(true);
  for (const f of features) {
    switch (f.t) {
      case 'flash':
        w.flash(f.ap, f.at);
        break;
      case 'stroke':
        w.stroke(f.pts, f.width);
        break;
      case 'arc':
        w.arc(f.c, f.r, f.start, f.sweep, f.width);
        break;
      case 'region':
        w.region(f.pts);
        break;
    }
  }
}

function area(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
