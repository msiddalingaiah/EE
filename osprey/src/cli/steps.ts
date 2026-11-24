// The command line's steps: the design flow's commands (Place, Autoroute, Arrange labels, LCSC
// Assign, ERC, DRC, CAM…) run on a loaded project, in order, with results an agent can read.
// No Node or DOM here: what comes from outside (the user directory, files, saving) is `env`.
// Each step names the menu command it matches (src/main.ts), so the ids are shared.

import { Editor } from '../app/editor';
import { assemblyFiles } from '../cam/assembly';
import { DEFAULT_JOB, parseCamJob, runCam } from '../cam/job';
import { zip } from '../cam/zip';
import { blockPaths } from '../model/blocks';
import { componentName } from '../model/derive';
import { drc } from '../model/drc';
import { erc } from '../model/erc';
import { exportEagle } from '../model/export-eagle';
import { readLibrary, readProject, writeProject } from '../model/file';
import { subcircuitBlocks } from '../edit/subcircuit';
import { lcscStatus, readLcscTable, setLcscParts, type LcscPart, type LcscStatus } from '../model/lcsc';
import { parseDru } from '../model/rules';
import type * as O from '../model/types';

export type UserDirSub = 'libraries' | 'rules' | 'cam' | 'parts' | 'subcircuits';

export interface StepEnv {
  /** File names in the user directory's libraries/, rules/, cam/ or parts/ (none without one). */
  listUserDir(sub: UserDirSub): string[];
  readUserDir(sub: UserDirSub, name: string): string;
  /** A file given by path (rules=x.dru, cam=x.cam); undefined if there is none. */
  readPath(path: string): string | undefined;
  /** Write an output file (CAM zip, CSV, Eagle); returns where it went. */
  writeOutput(name: string, data: string | Uint8Array): string;
  /** Save the project's text; returns where it went. */
  save(text: string): string;
}

/**
 * Use the JLCPCB parts tables in the user directory's parts/ folder (for lcsc, info and check);
 * returns how many parts they hold. A table that can't be read is an error.
 */
export function loadLcscParts(env: StepEnv): number {
  const parts: LcscPart[] = [];
  for (const name of env.listUserDir('parts').filter((n) => n.toLowerCase().endsWith('.json'))) {
    parts.push(...readLcscTable(env.readUserDir('parts', name), `parts/${name}`));
  }
  setLcscParts(parts);
  return parts.length;
}

export interface Problem {
  severity: 'error' | 'warning';
  kind: string;
  message: string;
  at?: O.Pt;
  /** Line in a block description (generate). */
  line?: number;
}

export interface StepResult {
  /** As given ("cam=jlc.cam"). */
  step: string;
  /** The menu command it matches, if there is one. */
  id?: string;
  ok: boolean;
  summary: string;
  problems: Problem[];
  /** Files written. */
  files?: string[];
}

export interface RunResult {
  ok: boolean;
  steps: StepResult[];
  /** Where the project was saved, if it changed. */
  saved?: string;
}

/** A mistake in what was asked (an unknown step, a missing file): exit status 2. */
export class UsageError extends Error {}

interface Ctx {
  project: O.Project;
  editor: Editor;
  env: StepEnv;
  arg: string | undefined;
}

type Outcome = { summary: string; problems?: Problem[]; files?: string[]; id?: string };

interface Step {
  /** The menu command id (src/main.ts) this step matches. */
  id?: string;
  /** What it does, for `osprey commands`. */
  help: string;
  /** "=<x>" it takes, for help; `argRequired`: it must be given. */
  arg?: string;
  argRequired?: true;
  /** Writes files from the project as saved (CAM, assembly, Eagle): the project is saved first. */
  output?: boolean;
  run(c: Ctx): Outcome;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const needBoard = (c: Ctx) => {
  if (!c.project.board) throw new UsageError('The project has no board');
};

/** Read a named file: from the user directory's sub/ (with or without its extension), else as a path. */
function named(c: Ctx, sub: UserDirSub, ext: string): { name: string; text: string } {
  const want = c.arg!;
  const inDir = c.env.listUserDir(sub).find((n) => n.toLowerCase() === want.toLowerCase() || n.toLowerCase() === `${want}${ext}`.toLowerCase());
  if (inDir) return { name: inDir, text: c.env.readUserDir(sub, inDir) };
  const text = c.env.readPath(want);
  if (text === undefined) throw new UsageError(`No ${want} in the user directory's ${sub}/, nor as a file`);
  return { name: want.split(/[\\/]/).pop()!, text };
}

function lcscProblems(status: LcscStatus[]): Problem[] {
  const out: Problem[] = [];
  for (const s of status) {
    if ('missing' in s) out.push({ severity: 'warning', kind: 'lcsc-missing', message: `${s.part}: no LCSC part (${s.missing})` });
    else if ('match' in s) out.push({ severity: 'warning', kind: 'lcsc-unassigned', message: `${s.part}: no LCSC number yet; lcsc assigns ${s.match.lcsc}` });
    else if ('wrong' in s) {
      out.push({
        severity: 'warning', kind: 'lcsc-wrong',
        message: `${s.part}: ${s.wrong} is for another value or package${s.replacement ? `; lcsc assigns ${s.replacement.lcsc}` : s.why ? ` (${s.why})` : ''}`,
      });
    }
  }
  return out;
}

function ercProblems(project: O.Project): Problem[] {
  if (!project.schematic) return [];
  return erc(project).problems.filter((p) => !p.approved).map((p) => ({
    severity: p.severity, kind: `erc-${p.kind}`, message: p.message, ...(p.at ? { at: p.at } : {}),
  }));
}

function drcProblems(project: O.Project): { problems: Problem[]; checked: number } {
  if (!project.board) return { problems: [], checked: 0 };
  const r = drc(project);
  return {
    problems: r.violations.map((v) => ({ severity: 'error' as const, kind: `drc-${v.kind}`, message: v.message, at: v.at })),
    checked: r.checked,
  };
}

/** The board outline's size (mm), from the outline layer's extent. */
function boardSize(project: O.Project): string | undefined {
  const pts = (project.board?.drawing ?? []).flatMap((g) => ('line' in g && g.layer === 'outline' ? g.line : []));
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const r = (n: number) => Math.round(n * 100) / 100;
  return `${r(Math.max(...xs) - Math.min(...xs))} × ${r(Math.max(...ys) - Math.min(...ys))} mm`;
}

export const STEPS: Record<string, Step> = {
  info: {
    help: 'Parts, nets, blocks, board size, unrouted connections and LCSC coverage',
    run: ({ project }) => {
      const status = lcscStatus(project, undefined);
      const counted = status.filter((s) => !('throughHole' in s));
      const unrouted = project.board ? drc(project).violations.filter((v) => v.kind === 'unrouted').length : 0;
      const size = boardSize(project);
      return {
        summary: [
          plural(project.parts.length, 'part'), plural(project.nets.length, 'net'), plural(blockPaths(project).length, 'block'),
          ...(project.schematic ? [plural(project.schematic.sheets.length, 'sheet')] : []),
          ...(project.board ? [`board ${size ?? 'without an outline'}`, `${unrouted} unrouted`] : []),
          `LCSC ${counted.filter((s) => 'lcsc' in s).length}/${counted.length}`,
        ].join(', '),
      };
    },
  },
  update: {
    id: 'tools.update-library',
    help: "Update the project from the user directory's Osprey libraries (as the app does on opening)",
    run: ({ editor, env }) => {
      const sources = env.listUserDir('libraries').filter((n) => n.toLowerCase().endsWith('.ospreylib'))
        .map((n) => ({ name: n.replace(/\.ospreylib$/i, ''), library: readLibrary(env.readUserDir('libraries', n)).library }));
      if (!sources.length) return { summary: 'No Osprey libraries in the user directory (--userdir, or OSPREY_USERDIR)' };
      const changed = editor.updateFromLibraries(sources);
      return { summary: changed.length ? `Updated ${changed.map(componentName).join(', ')}` : `Up to date with ${sources.map((s) => s.name).join(', ')}` };
    },
  },
  rules: {
    id: 'tools.load-rules',
    arg: '<name.dru>',
    argRequired: true,
    help: "Load design rules from the user directory's rules/, or a .dru file",
    run: (c) => {
      needBoard(c);
      if (!c.arg) throw new UsageError('rules needs a file: rules=<name.dru>');
      const { name, text } = named(c, 'rules', '.dru');
      const err = c.editor.loadRules(name.replace(/\.dru$/i, ''), parseDru(text));
      if (err) throw new UsageError(err);
      return { summary: `Loaded design rules ${name}` };
    },
  },
  copy: {
    arg: '<Block>[,<PORT>=<net>…][,<part>.value=<v>…][,from=<file>][,at=<x>:<y>][,as=<name>]',
    argRequired: true,
    help: "Copy a subcircuit (a block of a project in the user directory's subcircuits/, or from=) into the schematic; ports join the nets named",
    run: (c) => {
      const [block, ...opts] = (c.arg ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!block) throw new UsageError('copy needs a block: copy=<Block>[,PORT=net…]');
      const ports: Record<string, string> = {};
      const values: Record<string, string> = {};
      let from: string | undefined;
      let at: O.Pt | undefined;
      let name: string | undefined;
      for (const o of opts) {
        const i = o.indexOf('=');
        if (i < 1) throw new UsageError(`copy: "${o}" isn't key=value`);
        const [k, v] = [o.slice(0, i), o.slice(i + 1)];
        if (k === 'from') from = v;
        else if (k === 'as') name = v;
        else if (k === 'at') {
          const xy = v.split(':').map(Number);
          if (xy.length !== 2 || xy.some((n) => !Number.isFinite(n))) throw new UsageError(`copy: at=${v}: give at=<x>:<y> in mm`);
          at = [xy[0]!, xy[1]!];
        } else if (k.toLowerCase().endsWith('.value')) values[k.slice(0, -6)] = v;
        else ports[k] = v;
      }
      // The project holding it: from=, else whichever in subcircuits/ has a block of that name.
      let source: { name: string; project: O.Project } | undefined;
      if (from) {
        const f = named({ ...c, arg: from }, 'subcircuits', '.osprey');
        source = { name: f.name, project: readProject(f.text) };
      } else {
        const found = c.env.listUserDir('subcircuits').filter((n) => n.toLowerCase().endsWith('.osprey'))
          .map((n) => ({ name: n, project: readProject(c.env.readUserDir('subcircuits', n)) }))
          .filter((x) => subcircuitBlocks(x.project).some((b) => b.name.toLowerCase() === block.toLowerCase()));
        if (!found.length) throw new UsageError(`No subcircuit ${block} in the user directory's subcircuits/ (osprey subcircuits lists them; or give from=<file>)`);
        if (found.length > 1) throw new UsageError(`${block} is in ${found.map((x) => x.name).join(' and ')}: say which with from=`);
        source = found[0]!;
      }
      const r = c.editor.copyBlock(source.project, block, { ports, values, ...(at ? { at } : {}), ...(name ? { name } : {}) });
      if (typeof r === 'string') throw new UsageError(r);
      const renamed = [...r.parts].filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`);
      return {
        summary: `Copied ${r.block} from ${source.name}: ${plural(r.parts.size, 'part')}${renamed.length ? ` (${renamed.join(' ')})` : ''}${r.ports.size ? `; ports ${[...r.ports].map(([p, n]) => (p === n ? p : `${p}→${n}`)).join(' ')}` : ''}`,
        problems: r.notes.map((message) => ({ severity: 'warning' as const, kind: 'library', message })),
      };
    },
  },
  suggest: {
    id: 'tools.suggest-blocks',
    help: 'Suggest blocks for the parts that have none',
    run: ({ editor }) => {
      const n = editor.suggestBlocks();
      return { summary: n ? `Suggested blocks for ${plural(n, 'part')}` : 'Every part has a block already' };
    },
  },
  place: {
    id: 'tools.place',
    help: "Place the board's unlocked parts block by block, and fit the outline",
    run: (c) => {
      needBoard(c);
      const r = c.editor.autoplace();
      return { summary: r.parts ? `Placed ${plural(r.parts, 'part')} on a ${r.width} × ${r.height} mm board` : 'No unlocked parts to place' };
    },
  },
  route: {
    id: 'tools.autoroute',
    help: 'Autoroute: ground vias, signals, then VCC and GND pours',
    run: (c) => {
      needBoard(c);
      const r = c.editor.autoroute();
      return {
        summary: `Routed ${plural(r.routed, 'connection')}${r.groundVias ? `, ${plural(r.groundVias, 'ground via')}` : ''}${r.pours.length ? `, pours: ${r.pours.join(', ')}` : ''}; ${r.left.length ? `${r.left.length} left to route by hand` : 'nothing left'}`,
        problems: r.left.map((a) => ({ severity: 'warning' as const, kind: 'unrouted', message: `Unrouted: ${a.net}`, at: a.from })),
      };
    },
  },
  labels: {
    id: 'tools.labels',
    help: 'Move part names and values that sit on something to a clear spot',
    run: (c) => {
      needBoard(c);
      const r = c.editor.arrangeLabels();
      return {
        summary: r.moved.length ? `Moved ${plural(r.moved.length, 'label')}` : 'Labels are all clear',
        problems: r.crowded.map((l) => ({ severity: 'warning' as const, kind: 'label-crowded', message: `${l}: no clear spot` })),
      };
    },
  },
  lcsc: {
    id: 'tools.lcsc',
    help: 'Give chip resistors and capacitors their JLCPCB part numbers',
    run: ({ editor, project }) => {
      const done = editor.assignLcsc();
      const left = lcscProblems(lcscStatus(project));
      return { summary: `Assigned ${plural(done.length, 'LCSC number')}${left.length ? `; ${left.length} part(s) still need one` : ''}`, problems: left };
    },
  },
  erc: {
    id: 'tools.erc',
    help: 'Electrical rule check of the schematic',
    run: ({ project }) => {
      const problems = ercProblems(project);
      return { summary: problems.length ? plural(problems.length, 'ERC problem') : 'ERC: no problems', problems };
    },
  },
  drc: {
    id: 'tools.drc',
    help: 'Design-rule check of the board (unrouted connections included)',
    run: ({ project }) => {
      const { problems, checked } = drcProblems(project);
      return { summary: problems.length ? plural(problems.length, 'DRC problem') : `DRC: no problems (${checked} copper items)`, problems };
    },
  },
  check: {
    help: 'Ready to order? ERC, DRC with unrouted connections, LCSC numbers, labels on copper or each other',
    run: ({ project }) => {
      const problems = [...ercProblems(project), ...drcProblems(project).problems];
      if (project.board) {
        problems.push(...lcscProblems(lcscStatus(project)));
        // Labels: what Arrange labels would move, on a copy (this step changes nothing).
        const copy = readProject(writeProject(project));
        const moved = new Editor(copy, () => {}).arrangeLabels().moved;
        problems.push(...moved.map((l) => ({ severity: 'warning' as const, kind: 'label-overlap', message: `${l} sits on copper, an outline or another label (labels moves it)` })));
      }
      const errors = problems.filter((p) => p.severity === 'error').length;
      return {
        summary: problems.length ? `${plural(errors, 'error')}, ${plural(problems.length - errors, 'warning')}` : 'Ready to order: no problems',
        problems,
      };
    },
  },
  cam: {
    id: 'cam.default',
    arg: '<job.cam>',
    output: true,
    help: "Gerber and drill files as one zip (x_CAM.zip): the built-in job, or one from the user directory's cam/ or a file",
    run: (c) => {
      needBoard(c);
      const job = c.arg ? (({ name, text }) => parseCamJob(text, name))(named(c, 'cam', '.cam')) : DEFAULT_JOB;
      const { files, warnings } = runCam(c.project, job);
      const out = c.env.writeOutput(`${c.project.project.name}_CAM.zip`, zip(files));
      return {
        id: c.arg ? `cam.job.${c.arg}` : 'cam.default',
        summary: `${job.name}: ${plural(files.size, 'file')} in ${out}`,
        files: [out],
        problems: warnings.map((w) => ({ severity: 'warning' as const, kind: 'cam', message: w })),
      };
    },
  },
  assembly: {
    id: 'cam.assembly',
    arg: 'tht',
    output: true,
    help: "Bill of materials and pick-and-place (x_BOM.csv, x_CPL.csv) in JLCPCB's format; =tht adds through-hole parts",
    run: (c) => {
      needBoard(c);
      if (c.arg && c.arg !== 'tht') throw new UsageError(`assembly takes =tht or nothing, not =${c.arg}`);
      const { files, warnings } = assemblyFiles(c.project, { throughHole: c.arg === 'tht' });
      const written = [...files].map(([name, text]) => c.env.writeOutput(name, text));
      return {
        id: c.arg ? 'cam.assembly-tht' : 'cam.assembly',
        summary: `Wrote ${written.join(' and ')}`,
        files: written,
        problems: warnings.map((w) => ({ severity: 'warning' as const, kind: 'assembly', message: w })),
      };
    },
  },
  eagle: {
    id: 'file.export-eagle',
    output: true,
    help: 'Export as an Eagle schematic and board (x.sch, x.brd)',
    run: (c) => {
      const written = [...exportEagle(c.project).files].map(([name, text]) => c.env.writeOutput(name, text));
      return { summary: `Wrote ${written.join(' and ')}`, files: written };
    },
  },
};

/** Split "cam=jlc.cam" into the step and its argument. */
export function parseStep(s: string): { name: string; arg?: string } {
  const i = s.indexOf('=');
  return i < 0 ? { name: s } : { name: s.slice(0, i), arg: s.slice(i + 1) };
}

/**
 * Run the steps on a project, in order, stopping at the first that fails. The project is saved
 * when a step changed it: at the end, and before a step that writes files from it.
 * `strict`: warnings fail a step too.
 */
export function runSteps(project: O.Project, steps: string[], env: StepEnv, opts: { strict?: boolean } = {}): RunResult {
  for (const s of steps) if (!STEPS[parseStep(s).name]) throw new UsageError(`Unknown step "${s}" (osprey commands lists them)`);
  const editor = new Editor(project, () => {});
  const results: StepResult[] = [];
  let saved: string | undefined;
  const save = () => {
    if (!editor.history.dirty) return;
    saved = env.save(editor.serialize());
    editor.history.markSaved();
  };
  let ok = true;
  for (const s of steps) {
    const { name, arg } = parseStep(s);
    const step = STEPS[name]!;
    if (step.output) save();
    let out: Outcome;
    try {
      out = step.run({ project, editor, env, arg });
    } catch (e) {
      // The step couldn't run (no board, a missing file…): it fails; what came before is kept.
      const message = e instanceof Error ? e.message : String(e);
      out = { summary: message, problems: [{ severity: 'error', kind: 'step', message }] };
    }
    const problems = out.problems ?? [];
    const failed = problems.some((p) => p.severity === 'error' || (opts.strict && p.severity === 'warning'));
    const id = out.id ?? step.id;
    results.push({ step: s, ...(id ? { id } : {}), ok: !failed, summary: out.summary, problems, ...(out.files ? { files: out.files } : {}) });
    if (failed) {
      ok = false;
      break;
    }
  }
  save();
  return { ok, steps: results, ...(saved ? { saved } : {}) };
}

