#!/usr/bin/env node
// The osprey command line (src/cli/main.ts; README "Command line"). The app's sources are
// TypeScript, so this bundles the CLI for Node with Vite, into node_modules/.cache/osprey-cli,
// again only when a file under src/ has changed, then runs it.
//
//   node scripts/osprey.mjs wwvbfind2.osprey place route labels lcsc check
//   npm run osprey -- commands

import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'osprey-cli');
const BUNDLE = join(OUT, 'main.js');

/** The newest modification time of any file under dir. */
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

if (!existsSync(BUNDLE) || newest(join(ROOT, 'src')) > statSync(BUNDLE).mtimeMs) {
  const { build } = await import('vite');
  // Built beside, then moved into place: a run started meanwhile never sees half a bundle.
  const tmp = `${OUT}-${process.pid}`;
  await build({
    root: ROOT,
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: { ssr: join(ROOT, 'src', 'cli', 'main.ts'), outDir: tmp, emptyOutDir: true, target: 'node20', minify: false },
  });
  rmSync(OUT, { recursive: true, force: true });
  try {
    renameSync(tmp, OUT);
  } catch {
    rmSync(tmp, { recursive: true, force: true }); // another run got there first
  }
}

await import(pathToFileURL(BUNDLE).href);
