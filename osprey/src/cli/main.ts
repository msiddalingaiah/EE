// osprey: the design flow on files, for agents and scripts (README "Command line").
//
//   osprey <file.osprey> <step>... [options]
//   osprey import <x.sch> <x.brd> [-o x.osprey] [<step>...]
//   osprey commands
//
// Run through scripts/osprey.mjs, which bundles this for Node. The steps are in steps.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEagle } from '../eagle/parse';
import { readProject, writeProject } from '../model/file';
import { importEagle } from '../model/import-eagle';
import type * as O from '../model/types';
import { parseStep, runSteps, STEPS, UsageError, type RunResult, type StepEnv, type UserDirSub } from './steps';

const USAGE = `Usage:
  osprey <file.osprey> <step>... [options]
  osprey import <x.sch> <x.brd> [-o x.osprey] [<step>...] [options]
  osprey commands

Steps run in order on the project, which is saved (in place, or to -o) if one changed it.
The run stops at the first step that finds an error.

Options:
  -o <file>          save the project here instead
  --out <dir>        where CAM, assembly and Eagle files go (default: the project's folder)
  --userdir <dir>    the user directory, with libraries/, rules/, cam/ (default: $OSPREY_USERDIR)
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
    else if (/\.(osprey|sch|brd)$/i.test(s) && !s.includes('=')) a.files.push(s);
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
    for (const p of shown.slice(0, 50)) console.log(`       ${p.severity === 'error' ? 'error  ' : 'warning'} ${p.message}`);
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
  const importing = argv[0] === 'import';
  const args = parseArgs(importing ? argv.slice(1) : argv);
  for (const s of args.steps) if (!STEPS[parseStep(s).name]) throw new UsageError(`Unknown step "${s}" (osprey commands lists them)`);
  if (importing || args.steps.some((s) => parseStep(s).name === 'eagle')) await useDomParser();

  let project: O.Project;
  let target: string;
  if (importing) {
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

  const userdir = args.userdir ?? process.env.OSPREY_USERDIR;
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

  // An import is a new file: saved even when no step changes it.
  if (importing && !args.dryRun) writeFileSync(target, writeProject(project));
  const result = runSteps(project, args.steps, env, { strict: args.strict });
  if (importing && !result.saved) result.saved = args.dryRun ? `${target} (not saved: --dry-run)` : target;
  print(result, target, args.json);
  return result.ok ? 0 : 1;
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
