// The editor's mouse and keyboard handling, driven in headless Chrome (scripts/drive.mjs).
// Run with `npm run test:ui`; skipped when no Chrome, Edge or Chromium is installed.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findChrome, launch, type Driver } from '../../scripts/drive.mjs';
import { JSDOM } from 'jsdom';
import { parseEagle } from '../../src/eagle/parse';
import { writeLibrary } from '../../src/model/file';
import { importLibraryFile } from '../../src/model/import-eagle';

const ROOT = join(__dirname, '..', '..');

describe.skipIf(!findChrome())('editor in the browser', () => {
  let d: Driver;
  beforeAll(async () => {
    d = await launch();
  });
  afterAll(async () => {
    await d?.close();
  });
  beforeEach(async () => {
    d.problems.length = 0;
    await d.open('wwvbfind.osprey', 'board');
  });

  const footprint = (part: string) =>
    d.evaluate<{ at: [number, number]; rot?: number }>(`__osprey.project.board.footprints.find((f) => f.part === ${JSON.stringify(part)})`);

  it('selects a part by clicking it, rotates it with R and undoes with Ctrl+Z', async () => {
    const { at, rot } = await footprint('R1');
    await d.click(at[0], at[1]);
    expect((await d.state()).selection).toEqual([{ kind: 'footprint', label: 'R1' }]);
    await d.key('r');
    expect((await footprint('R1')).rot).toBe(((rot ?? 0) + 90) % 360);
    expect((await d.state()).undo).toBe('Rotate R1');
    await d.key('Ctrl+z');
    expect((await footprint('R1')).rot).toBe(rot);
    expect((await d.state()).redo).toBe('Rotate R1');
    expect(d.problems).toEqual([]);
  });

  it('finishes a pour with a double click', async () => {
    await d.button('Pour');
    expect((await d.state()).mode).toBe('pour');
    await d.click(30, 2);
    await d.click(37, 2);
    await d.dblclick(37, 6);
    const s = await d.state();
    expect(s.undo).toBe('Add pour on GND');
    expect(s.selection).toEqual([{ kind: 'pour', label: 'Pour GND', net: 'GND' }]);
    expect(d.problems).toEqual([]);
  });

  it('counts two quick separate presses as a double click (pointer events carry no click count)', async () => {
    await d.button('Pour');
    await d.click(30, 2);
    await d.click(37, 2);
    await d.click(37, 6);
    await d.click(37, 6);
    expect((await d.state()).undo).toBe('Add pour on GND');
  });

  it('changes a value typed in the inspector, and switches views with Tab', async () => {
    const { at } = await footprint('R1');
    await d.click(at[0], at[1]);
    await d.type('value', '4.7M');
    expect(await d.evaluate(`__osprey.project.parts.find((p) => p.name === 'R1').value`)).toBe('4.7M');
    await d.key('Tab');
    expect((await d.state()).view).toBe('schematic');
    expect(d.problems).toEqual([]);
  });

  it('checks the electrical rules, selects what a problem involves, and keeps the list up to date', async () => {
    await d.view('schematic');
    await d.button('#erc-run');
    expect((await d.state()).erc).toEqual(['unconnected: U1 pin PA2 is unconnected']);
    await d.button('#erc-list button');
    expect((await d.state()).selection).toEqual([{ kind: 'gate', label: 'U1' }]);
    // Deleting U1 leaves nets it was on with a single pin.
    await d.key('Delete');
    expect((await d.state()).erc).toContain('single: AUDIO connects only R13 pin 1');
    await d.key('Ctrl+z');
    expect((await d.state()).erc).toEqual(['unconnected: U1 pin PA2 is unconnected']);
    expect(d.problems).toEqual([]);
  });

  it('approves an ERC problem, and undoes the approval', async () => {
    await d.view('schematic');
    await d.button('#erc-run');
    await d.button('#erc-list .erc-approve');
    let s = await d.state();
    expect(s.erc).toEqual([]);
    expect(s.ercApproved).toEqual(['unconnected: U1 pin PA2 is unconnected']);
    expect(s.undo).toBe('Approve ERC problem');
    expect(await d.evaluate('document.getElementById("erc-summary").textContent')).toBe('✓ No problems (1 approved)');
    await d.key('Ctrl+z');
    s = await d.state();
    expect(s.erc).toEqual(['unconnected: U1 pin PA2 is unconnected']);
    expect(s.ercApproved).toBeUndefined();
    expect(d.problems).toEqual([]);
  });

  it('checks the design rules from the panel', async () => {
    await d.button('#drc-run');
    expect((await d.state()).drc).toEqual([]);
  });
});

describe.skipIf(!findChrome())('libraries in the browser', () => {
  let d: Driver;
  let dir: string;
  beforeAll(async () => {
    d = await launch();
    dir = mkdtempSync(join(tmpdir(), 'osprey-downloads-'));
  });
  afterAll(async () => {
    await d?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const downloaded = async (name: string) => {
    const file = join(dir, name);
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100)); // let the download finish writing
    return readFileSync(file, 'utf8');
  };
  const sample = readFileSync(join(ROOT, 'samples', 'osprey', 'madhu.ospreylib'), 'utf8');

  it('imports an Eagle library, saves it as an Osprey library, and exports it back to Eagle', async () => {
    await d.open('madhu.lbr');
    expect((await d.state()).view).toBe('library');
    expect(await d.evaluate('document.getElementById("doc-title").textContent')).toBe('madhu — Library');
    await d.downloads(dir);
    await d.button('#save-btn');
    expect(await downloaded('madhu.ospreylib')).toBe(sample);
    await d.button('#export-btn');
    const lbr = await downloaded('madhu.lbr');
    // The UI tests run in Node, which has no DOMParser; the Eagle parser needs one.
    globalThis.DOMParser ??= new JSDOM().window.DOMParser;
    expect(writeLibrary(importLibraryFile('madhu.lbr', parseEagle(lbr)))).toBe(sample);
    expect(d.problems).toEqual([]);
  });

  it('opens an Osprey library, and places parts from one', async () => {
    await d.open('madhu.ospreylib');
    expect((await d.state()).view).toBe('library');
    await d.open('wwvbfind.osprey', 'schematic');
    await d.choose('#parts-source', 'madhu.ospreylib');
    await d.waitFor(() => document.querySelectorAll('#parts-list button').length > 10, 'the library parts');
    expect(d.problems).toEqual([]);
  });
});

describe.skipIf(!findChrome())('installed app', () => {
  it('opens with no server once installed', async () => {
    const { build, preview } = await import('vite');
    const outDir = mkdtempSync(join(tmpdir(), 'osprey-build-'));
    // Vitest sets NODE_ENV=test, which would build without the service worker (PROD false).
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({ root: ROOT, mode: 'production', logLevel: 'error', build: { outDir, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = env;
    }
    const server = await preview({ root: ROOT, logLevel: 'error', build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
    const url = server.resolvedUrls!.local[0]!;
    const d = await launch({ url });
    try {
      const title = () => d.evaluate<string>('document.getElementById("doc-title").textContent');
      const opened = async () => {
        for (let i = 0; i < 200 && !(await title()).includes('wwvbfind'); i++) await new Promise((r) => setTimeout(r, 50));
        return title();
      };
      await d.goto(`${url}#wwvbfind.osprey/board`);
      expect(await opened()).toContain('wwvbfind');
      expect(await d.evaluate('Promise.race([navigator.serviceWorker.ready.then(() => "installed"), new Promise((r) => setTimeout(() => r("no service worker"), 10000))])')).toBe('installed');
      const http = server.httpServer as import('node:http').Server;
      const closed = new Promise<void>((r) => http.close(() => r()));
      http.closeAllConnections();
      await closed;
      await d.goto(`${url}#wwvbfind.osprey/board`);
      expect(await opened()).toContain('wwvbfind');
    } finally {
      await d.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60000);
});
