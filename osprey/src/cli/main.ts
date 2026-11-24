// osprey: the design flow on files, for agents and scripts (README "Command line").
//
//   osprey <file.osprey> <step>... [options]
//   osprey import <x.sch> <x.brd> [-o x.osprey] [<step>...]
//   osprey generate <x.blocks> [-o x.osprey] [<step>...]
//   osprey compare <generated.osprey> <reference.osprey>
//   osprey subcircuits [x.osprey]
//   osprey commands
//
// Run through scripts/osprey.mjs, which bundles this for Node. The steps are in steps.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEagle } from '../eagle/parse';
import { parseDescription, resolveDescription, type Source } from '../gen/description';
import { generateProject } from '../gen/layout';
import { compareSheets } from '../gen/score';
import { subcircuitBlocks } from '../edit/subcircuit';
import { readLibrary, readProject, writeProject } from '../model/file';
import { importEagle, importLibrary } from '../model/import-eagle';
import type * as O from '../model/types';
import { loadLcscParts, parseStep, runSteps, STEPS, UsageError, type RunResult, type StepEnv, type StepResult, type UserDirSub } from './steps';

const USAGE = `Usage:
  osprey <file.osprey> <step>... [options]
  osprey import <x.sch> <x.brd> [-o x.osprey] [<step>...] [options]
  osprey generate <x.blocks> [-o x.osprey] [<step>...] [options]
  osprey compare <generated.osprey> <reference.osprey>
  osprey subcircuits [x.osprey] [--json]
  osprey commands

generate draws a schematic from a block description (README "Schematic generation"), after
checking it; with errors it writes nothing. Components come from the description's "use"
files, then the user directory's libraries.

compare measures two drawings of the same netlist block by block (wire length, bends, size,
and how far parts are from where the reference has them): a generated sheet against one drawn
by hand.

subcircuits lists the blocks of the user directory's subcircuits/ projects (or of one project):
each block's ports, supplies and parts, for the copy step.

Steps run in order on the project, which is saved (in place, or to -o) if one changed it.
The run stops at the first step that finds an error.

Options:
  -o <file>          save the project here instead
  --out <dir>        where CAM, assembly and Eagle files go (default: the project's folder)
  --userdir <dir>    the user directory, with libraries/, rules/, cam/, parts/, subcircuits/ (default: $OSPREY_USERDIR)
  --json             print the results as one JSON object
  --strict           warnings fail a step too
  --dry-run          don't save the project (output files are still written)

Exit status: 0 all steps OK, 1 a step found problems, 2 bad usage or a file error.`;

interface Args {
  files: string[];
  steps: string[];
  output?: string;
  out?: string;
  userdir?: string;
  json: boolean;
  strict: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { files: [], steps: [], json: false, strict: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${s} needs a value`);
      return v;
    };
    if (s === '-o') a.output = value();
    else if (s === '--out') a.out = value();
    else if (s === '--userdir') a.userdir = value();
    else if (s === '--json') a.json = true;
    else if (s === '--strict') a.strict = true;
    else if (s === '--dry-run') a.dryRun = true;
    else if (s.startsWith('-')) throw new UsageError(`Unknown option ${s}`);
    else if (/\.(osprey|sch|brd|blocks)$/i.test(s) && !s.includes('=')) a.files.push(s);
    else a.steps.push(s);
  }
  return a;
}

/** Eagle files are XML read (and written) through DOMParser: jsdom's, in Node. */
async function useDomParser(): Promise<void> {
  if (typeof globalThis.DOMParser === 'function') return;
  const { JSDOM } = await import('jsdom');
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function listCommands(): string {
  const rows = Object.entries(STEPS).map(([name, s]) => [`${name}${s.arg ? (s.argRequired ? `=${s.arg}` : `[=${s.arg}]`) : ''}`, s.id ?? '', s.help]);
  const w0 = Math.max(...rows.map((r) => r[0]!.length));
  const w1 = Math.max(...rows.map((r) => r[1]!.length));
  return rows.map(([a, b, c]) => `  ${a!.padEnd(w0)}  ${b!.padEnd(w1)}  ${c}`).join('\n');
}

function print(r: RunResult, file: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ file, ...r }, null, 2));
    return;
  }
  for (const s of r.steps) {
    console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step}: ${s.summary}`);
    const shown = s.problems.filter((p) => p.message !== s.summary);
    for (const p of shown.slice(0, 50)) console.log(`       ${p.severity === 'error' ? 'error  ' : 'warning'} ${p.line ? `line ${p.line}: ` : ''}${p.message}`);
    if (shown.length > 50) console.log(`       … and ${shown.length - 50} more (--json lists all)`);
  }
  if (r.saved) console.log(`Saved ${r.saved}`);
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return argv.length ? 0 : 2;
  }
  if (argv[0] === 'commands') {
    console.log(`Steps (and the menu commands they match):\n${listCommands()}`);
    return 0;
  }
  if (argv[0] === 'subcircuits') {
    const args = parseArgs(argv.slice(1));
    const userdir = args.userdir ?? process.env.OSPREY_USERDIR;
    const dir = userdir ? join(userdir, 'subcircuits') : undefined;
    const files = args.files.length ? args.files
      : dir && existsSync(dir) ? readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.osprey')).sort().map((n) => join(dir, n)) : [];
    if (!files.length) throw new UsageError("No subcircuits: give a project, or a user directory (--userdir, OSPREY_USERDIR) with subcircuits/");
    const out = files.map((file) => ({
      file: basename(file),
      blocks: subcircuitBlocks(readProject(readText(file))).map((b) => ({
        name: b.name, ports: b.ports, supplies: b.supplies,
        parts: b.parts.map((p) => ({ name: p.name, component: p.component.split('/').pop(), ...(p.value ? { value: p.value } : {}), ...(p.variant ? { variant: p.variant } : {}) })),
      })),
    }));
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else for (const f of out) {
      console.log(f.file);
      for (const b of f.blocks) {
        console.log(`  ${b.name}: ports ${b.ports.join(' ') || '(none)'}; supplies ${b.supplies.join(' ') || '(none)'}`);
        console.log(`    ${b.parts.map((p) => `${p.name} ${p.value ?? p.component}`).join(', ')}`);
      }
    }
    return 0;
  }
  if (argv[0] === 'compare') {
    if (argv.length !== 3) throw new UsageError('compare needs two projects: the generated one, then the reference');
    const [a, b] = argv.slice(1).map((f) => readProject(readFileSync(f, 'utf8')));
    console.log(compareSheets(a!, b!));
    return 0;
  }
  const importing = argv[0] === 'import';
  const generating = argv[0] === 'generate';
  const args = parseArgs(importing || generating ? argv.slice(1) : argv);
  for (const s of args.steps) if (!STEPS[parseStep(s).name]) throw new UsageError(`Unknown step "${s}" (osprey commands lists them)`);
  if (importing || args.steps.some((s) => parseStep(s).name === 'eagle')) await useDomParser();
  const userdir = args.userdir ?? process.env.OSPREY_USERDIR;

  let project: O.Project;
  let target: string;
  /** The generate step's own result, ahead of the steps that follow. */
  let generated: StepResult | undefined;
  if (generating) {
    const file = args.files.find((f) => f.toLowerCase().endsWith('.blocks'));
    if (!file || args.files.length > 1) throw new UsageError('generate needs one block description (.blocks)');
    const g = await generate(file, userdir, args.strict);
    generated = g.result;
    if (!g.project) {
      print({ ok: false, steps: [g.result] }, resolve(file), args.json);
      return 1;
    }
    project = g.project;
    target = resolve(args.output ?? join(dirname(file), `${basename(file).replace(/\.blocks$/i, '')}.osprey`));
  } else if (importing) {
    const eagle = args.files.filter((f) => /\.(sch|brd)$/i.test(f));
    if (!eagle.length) throw new UsageError('import needs an Eagle .sch and/or .brd');
    const r = importEagle(eagle.map((f) => ({ name: basename(f), file: parseEagle(readText(f)) })));
    project = r.project;
    target = resolve(args.output ?? join(dirname(eagle[0]!), `${project.project.name}.osprey`));
    for (const note of r.report) if (!args.json) console.log(`note ${note}`);
  } else {
    const file = args.files.find((f) => f.toLowerCase().endsWith('.osprey'));
    if (!file || args.files.length > 1) throw new UsageError('Give one .osprey project (or: osprey import x.sch x.brd)');
    try {
      project = readProject(readText(file));
    } catch (e) {
      throw new UsageError(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    target = resolve(args.output ?? file);
  }
  // As in the app, a project is named after its file: CAM and assembly files follow it.
  project.project.name = basename(target).replace(/\.osprey$/i, '');

  const outDir = resolve(args.out ?? dirname(target));
  const env: StepEnv = {
    listUserDir: (sub: UserDirSub) => {
      if (!userdir || !existsSync(join(userdir, sub))) return [];
      return readdirSync(join(userdir, sub)).sort((a, b) => a.localeCompare(b));
    },
    readUserDir: (sub, name) => readText(join(userdir!, sub, name)),
    readPath: (path) => (existsSync(path) ? readText(path) : undefined),
    writeOutput: (name, data) => {
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, name);
      writeFileSync(path, data);
      return path;
    },
    save: (text) => {
      if (args.dryRun) return `${target} (not saved: --dry-run)`;
      writeFileSync(target, text);
      return target;
    },
  };

  // An import or a generated schematic is a new file: saved even when no step changes it.
  try {
    loadLcscParts(env);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }

  const fresh = importing || generating;
  if (fresh && !args.dryRun) writeFileSync(target, writeProject(project));
  const result = runSteps(project, args.steps, env, { strict: args.strict });
  if (fresh && !result.saved) result.saved = args.dryRun ? `${target} (not saved: --dry-run)` : target;
  if (generated) result.steps.unshift(generated);
  print(result, target, args.json);
  return result.ok ? 0 : 1;
}

/** The libraries a description draws from: its "use" files, then the user directory's. */
async function librariesFor(file: string, uses: { path: string; line: number }[], userdir: string | undefined): Promise<{ sources: Source[]; missing: { path: string; line: number }[] }> {
  const sources: Source[] = [];
  const missing: { path: string; line: number }[] = [];
  const load = async (path: string): Promise<O.Library> => {
    const text = readText(path);
    const lower = path.toLowerCase();
    if (lower.endsWith('.osprey')) return readProject(text).library;
    if (lower.endsWith('.ospreylib')) return readLibrary(text).library;
    if (lower.endsWith('.lbr')) {
      await useDomParser();
      return importLibrary(basename(path), parseEagle(text));
    }
    throw new UsageError(`${path}: a library is an .ospreylib, an Eagle .lbr or an .osprey project`);
  };
  for (const u of uses) {
    const path = resolve(dirname(file), u.path);
    if (!existsSync(path)) missing.push(u);
    else sources.push({ name: u.path, library: await load(path) });
  }
  const dir = userdir && join(userdir, 'libraries');
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      if (/\.(ospreylib|lbr)$/i.test(name)) sources.push({ name, library: await load(join(dir, name)) });
    }
  }
  return { sources, missing };
}

/** Read, check and draw a block description; the project when there are no errors. */
async function generate(file: string, userdir: string | undefined, strict: boolean): Promise<{ project?: O.Project; result: StepResult }> {
  const { description, problems } = parseDescription(readText(file));
  const { sources, missing } = await librariesFor(file, description.uses, userdir);
  for (const m of missing) problems.push({ severity: 'error', kind: 'use', message: `No file ${m.path} (relative to the description)`, line: m.line });
  const stem = basename(file).replace(/\.blocks$/i, '');
  // Subcircuits: the user directory's subcircuits/; a project the description uses, when from= names it.
  const stored: { name: string; project: O.Project; used?: true }[] = [];
  for (const u of description.uses) {
    const path = resolve(dirname(file), u.path);
    if (u.path.toLowerCase().endsWith('.osprey') && existsSync(path)) stored.push({ name: basename(path), project: readProject(readText(path)), used: true });
  }
  const subDir = userdir && join(userdir, 'subcircuits');
  if (subDir && existsSync(subDir)) {
    for (const n of readdirSync(subDir).filter((x) => x.toLowerCase().endsWith('.osprey')).sort()) stored.push({ name: n, project: readProject(readText(join(subDir, n))) });
  }
  const r = problems.some((p) => p.severity === 'error') ? { problems: [] } : resolveDescription(description, sources, stem, description.subcircuits.length ? stored : []);
  problems.push(...r.problems);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const failed = errors > 0 || (strict && problems.length > 0);
  const resolved = 'resolved' in r ? r.resolved : undefined;
  const result: StepResult = {
    step: 'generate', ok: !failed, problems,
    summary: resolved && !failed
      ? `${resolved.parts.length} parts${resolved.subcircuits ? ` and ${resolved.subcircuits.length} subcircuit(s)` : ''} in ${resolved.blocks.length} blocks, ${resolved.nets.length} nets${problems.length ? `; ${problems.length} warning(s)` : ''}`
      : `${errors} error(s)${problems.length > errors ? `, ${problems.length - errors} warning(s)` : ''}: nothing written`,
  };
  return { ...(resolved && !failed ? { project: generateProject(resolved) } : {}), result };
}

// exitCode, not exit(): output piped to another program is flushed first.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof UsageError ? e.message : e instanceof Error ? e.stack ?? e.message : String(e));
    if (e instanceof UsageError) console.error('(osprey --help for usage)');
    process.exitCode = 2;
  },
);
