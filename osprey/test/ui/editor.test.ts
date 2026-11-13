// The editor's mouse and keyboard handling, driven in headless Chrome (scripts/drive.mjs).
// Run with `npm run test:ui`; skipped when no Chrome, Edge or Chromium is installed.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findChrome, launch, type Driver } from '../../scripts/drive.mjs';
import { JSDOM } from 'jsdom';
import { parseEagle } from '../../src/eagle/parse';
import { readLibrary, writeLibrary } from '../../src/model/file';
import { unzip } from '../unzip';
import { importLibraryFile } from '../../src/model/import-eagle';
import type * as O from '../../src/model/types';

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

  it('adds board text with T, types it, flips it to the bottom, and undoes', async () => {
    // The sample's own texts stay as they are; a new one is added after them.
    const texts = () => d.evaluate<O.TextShape[]>('__osprey.project.board.drawing.filter((g) => "text" in g)');
    const before = await texts();
    const added = async () => (await texts()).slice(before.length);
    await d.key('t');
    expect((await d.state()).mode).toBe('text');
    await d.click(3, 24.5);
    // The new text is selected, with its text field ready to type into.
    expect(await d.evaluate('document.activeElement.dataset.field')).toBe('text');
    await d.type('text', 'REV A');
    expect(await added()).toEqual([{ text: 'REV A', at: [2.54, 24.13], size: 1.27, ratio: 15, layer: 'silk.top' }]);
    await d.key('f');
    expect(await added()).toMatchObject([{ layer: 'silk.bottom', mirror: true }]);
    await d.choose('#inspector select[data-field="layer"]', 'silk.top');
    expect((await added())[0]!.mirror).toBeUndefined();
    await d.key('Ctrl+z');
    await d.key('Ctrl+z');
    await d.key('Ctrl+z');
    await d.key('Ctrl+z');
    expect(await texts()).toEqual(before);
    expect(d.problems).toEqual([]);
  });

  it('adds a note of several lines to a schematic sheet', async () => {
    await d.view('schematic');
    const drawing = () => d.evaluate<O.Graphic[]>('__osprey.project.schematic.sheets[0].drawing');
    const before = (await drawing()).length;
    await d.key('t');
    await d.click(10, 10);
    expect(await d.evaluate('document.activeElement.tagName')).toBe('TEXTAREA');
    // Line breaks are typed into the field; Enter (without Shift) applies.
    await d.type('text', 'Notes:\nC2 is a film cap');
    const added = (await drawing()).slice(before);
    expect(added).toEqual([{ text: 'Notes:\nC2 is a film cap', at: [10.16, 10.16], size: 1.778, layer: 'info' }]);
    expect(await d.evaluate('document.querySelector("#inspector textarea[data-field=text]").rows')).toBe(2);
    await d.choose('#inspector select[data-field="layer"]', 'names');
    expect(((await drawing()).at(-1) as O.TextShape).layer).toBe('names');
    expect(d.problems).toEqual([]);
  });

  it('sets a part\'s LCSC number, and makes the assembly files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osprey-assembly-'));
    try {
      const { at } = await footprint('R1');
      await d.click(at[0], at[1]);
      await d.type('lcsc', 'c17414');
      expect(await d.evaluate('__osprey.project.parts.find((p) => p.name === "R1").attributes')).toEqual({ LCSC: 'C17414' });
      await d.downloads(dir);
      await d.choose('#cam-select', 'assembly');
      const file = join(dir, 'wwvbfind_assembly.zip');
      for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      const files = unzip(readFileSync(file));
      expect([...files.keys()].sort()).toEqual(['wwvbfind_BOM.csv', 'wwvbfind_CPL.csv']);
      expect(files.get('wwvbfind_BOM.csv')).toContain('3.3M,R1,0805,C17414,1,,,SMD');
      expect(files.get('wwvbfind_CPL.csv')!.split('\r\n')[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
      // SMD parts only, by default: the through-hole ones, and parts still without LCSC numbers, are pointed out.
      expect(files.get('wwvbfind_BOM.csv')).not.toContain('BERG-2');
      expect((await d.state()).error).toMatch(/Not placed: \d+ through-hole parts \(.*IN.*\); solder these yourself; \d+ of \d+ parts have no LCSC part number/);
      // Do not place: a checkbox on the part.
      await d.button('#inspector input[data-field="dnp"]');
      expect(await d.evaluate('__osprey.project.parts.find((p) => p.name === "R1").attributes')).toEqual({ LCSC: 'C17414', DNP: 'yes' });
      expect(d.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts parts in a block from the inspector, outlines it, selects it, and undoes', async () => {
    const r1 = await footprint('R1');
    const r2 = await footprint('R2');
    await d.click(r1.at[0], r1.at[1]);
    await d.click(r2.at[0], r2.at[1], { modifiers: 8 }); // Shift
    await d.type('block', ' rx / frontend ');
    const block = (part: string) => d.evaluate(`__osprey.project.parts.find((p) => p.name === ${JSON.stringify(part)}).attributes?.BLOCK`);
    expect(await block('R1')).toBe('rx/frontend');
    expect(await block('R2')).toBe('rx/frontend');
    expect((await d.state()).undo).toBe('Put 2 parts in block rx/frontend');
    // The display toggle appears with the first block.
    expect(await d.evaluate('!!document.getElementById("blocks-toggle")')).toBe(true);
    // Select the block from one of its parts.
    await d.key('Escape');
    await d.click(r1.at[0], r1.at[1]);
    await d.button('Select block frontend');
    expect((await d.state()).selection.map((s: { label: string }) => s.label).sort()).toEqual(['R1', 'R2']);
    await d.key('Ctrl+z');
    expect(await block('R1')).toBeUndefined();
    expect(d.problems).toEqual([]);
  });

  it('suggests blocks from the Blocks panel, lists the tree, and selects a block from it', async () => {
    expect(await d.evaluate('document.getElementById("blocks-list").textContent')).toMatch(/No blocks yet/);
    await d.button('Suggest');
    expect((await d.state()).undo).toBe('Suggest blocks');
    const rows = await d.evaluate<string[]>('[...document.querySelectorAll("#blocks-list .block-name")].map((e) => e.textContent)');
    expect(rows).toEqual(['power', 'Q1-Q2', 'U1', 'ADC', 'AUDIO', 'TICK', 'U2']);
    await d.button('#blocks-list .block-row:nth-child(4)'); // ADC
    expect((await d.state()).selection.map((s: { label: string }) => s.label).sort()).toEqual(['C5', 'C6', 'R7', 'R8', 'R9']);
    // The whole of U1 selected (ADC, AUDIO and TICK inside it): the field renames the block.
    await d.button('#blocks-list .block-row:nth-child(3)'); // U1
    expect(await d.evaluate(`document.querySelector('#inspector input[data-field="block"]').value`)).toBe('U1');
    await d.type('block', 'mcu');
    expect((await d.state()).undo).toBe('Rename block U1 to mcu');
    const block = (part: string) => d.evaluate(`__osprey.project.parts.find((p) => p.name === ${JSON.stringify(part)}).attributes.BLOCK`);
    expect(await block('U1')).toBe('mcu');
    expect(await block('R7')).toBe('mcu/ADC');
    await d.key('Ctrl+z');
    await d.key('Ctrl+z');
    expect(await d.evaluate('__osprey.project.parts.some((p) => p.attributes?.BLOCK)')).toBe(false);
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
  /** The sample library (edited in Osprey since its import, so its counts aren't fixed). */
  const sample = JSON.parse(readFileSync(join(ROOT, 'samples', 'osprey', 'madhu.ospreylib'), 'utf8')) as { library: Record<'components' | 'symbols' | 'footprints', unknown[]> };
  const counts = (selected: 'Components' | 'Symbols' | 'Footprints') =>
    (['components', 'symbols', 'footprints'] as const).map((k) => {
      const label = k[0]!.toUpperCase() + k.slice(1);
      return `${label === selected ? '*' : ''}${label}${sample.library[k].length}`;
    });

  it('imports an Eagle library, saves it as an Osprey library, and exports it back to Eagle', async () => {
    globalThis.DOMParser ??= new JSDOM().window.DOMParser;
    const imported = writeLibrary(importLibraryFile('madhu.lbr', parseEagle(readFileSync(join(ROOT, 'samples', 'eagle', 'madhu.lbr'), 'utf8'))));
    await d.open('madhu.lbr');
    expect((await d.state()).view).toBe('library');
    expect(await d.evaluate('document.getElementById("doc-title").textContent')).toBe('madhu — Library');
    await d.downloads(dir);
    await d.button('#save-btn');
    expect(await downloaded('madhu.ospreylib')).toBe(imported);
    await d.button('#export-btn');
    const lbr = await downloaded('madhu.lbr');
    // (The UI tests run in Node, which has no DOMParser: the Eagle parser uses jsdom's.)
    expect(writeLibrary(importLibraryFile('madhu.lbr', parseEagle(lbr)))).toBe(imported);
    expect(d.problems).toEqual([]);
  });

  const lib = <T>(expr: string) => d.evaluate<T>(`(() => { const lib = __osprey.editor.project.library; return ${expr}; })()`);

  it('edits a symbol: drags a pin on the grid, renames it, and undoes both', async () => {
    await d.open('madhu.ospreylib');
    await d.button('#library-tabs [data-kind="symbol"]');
    await d.button('#library-list button[title="madhu/DIODE"]');
    await d.click(-2.3, 0);
    expect((await d.state()).selection).toEqual([{ kind: 'pin', label: 'Pin A' }]);
    await d.drag(-2.3, 0, -4.8, 0.1);
    expect(await lib(`lib.symbols.find((s) => s.id === 'madhu/DIODE').pins[0].at`)).toEqual([-5.08, 0]);
    await d.type('name', 'ANODE');
    let s = await d.state();
    expect([s.undo, s.dirty]).toEqual(['Rename pin A', true]);
    expect(await lib(`Object.keys(lib.components.find((c) => c.id === 'madhu/1N4001').variants[0].pads)`)).toContain('A.ANODE');
    await d.key('Ctrl+z');
    await d.key('Ctrl+z');
    s = await d.state();
    expect([s.undo, s.dirty]).toEqual([undefined, false]);
    expect(d.problems).toEqual([]);
  });

  it('edits a footprint: changes a pad drill from the inspector, and deletes the pad', async () => {
    await d.open('madhu.ospreylib');
    await d.button('#library-tabs [data-kind="footprint"]');
    await d.button('#library-list button[title="madhu/DO-41"]');
    await d.click(4.4, 0.5);
    expect((await d.state()).selection).toEqual([{ kind: 'pad', label: 'Pad A' }]);
    await d.type('drill', '1.2');
    expect(await lib(`lib.footprints.find((f) => f.id === 'madhu/DO-41').pads[1].drill`)).toBe(1.2);
    await d.key('Delete');
    expect(await lib(`lib.footprints.find((f) => f.id === 'madhu/DO-41').pads.map((p) => p.name)`)).toEqual(['C']);
    expect((await d.state()).undo).toBe('Delete pad A');
    expect(d.problems).toEqual([]);
  });

  it('starts a new library, draws a footprint with the tools, and saves it', async () => {
    await d.open('madhu.ospreylib');
    await d.button('#new-lib-btn');
    await d.button('#new-footprint-btn');
    await d.type('library-name', 'mine');
    await d.type('item-name', 'pads-2');
    await d.button('#draw-tools [data-tool="pad"]');
    expect((await d.state()).mode).toBe('draw:pad');
    await d.click(-1.27, 0);
    await d.click(1.27, 0);
    await d.key('Escape');
    await d.button('#draw-tools [data-tool="line"]');
    await d.click(-2.54, 1.27);
    // A double click on the last corner adds it and ends the line.
    await d.dblclick(2.54, 1.27);
    await d.key('Escape');
    expect((await d.state()).mode).toBeUndefined();
    await d.downloads(dir);
    await d.button('#save-btn');
    const saved = readLibrary(await downloaded('untitled.ospreylib'));
    expect(saved.name).toBe('mine');
    expect(saved.library.footprints).toEqual([{
      id: 'mine/PADS-2',
      graphics: [{ line: [[-2.54, 1.27], [2.54, 1.27]], width: 0.127, layer: 'silk.top' }],
      pads: [{ name: '1', at: [-1.27, 0], drill: 0.8 }, { name: '2', at: [1.27, 0], drill: 0.8 }],
    }]);
    expect((await d.state()).dirty).toBe(false);
    expect(d.problems).toEqual([]);
  });

  it('builds a component: a gate, a footprint, pins connected to pads, and edits the gate', async () => {
    await d.open('madhu.ospreylib');
    await d.button('#new-lib-btn');
    await d.button('#new-symbol-btn');
    await d.type('item-name', 'RES');
    await d.button('#draw-tools [data-tool="pin"]');
    await d.click(-5.08, 0);
    await d.click(5.08, 0);
    await d.key('Escape');
    await d.button('#new-footprint-btn');
    await d.type('item-name', 'R0805');
    await d.button('#draw-tools [data-tool="smd"]');
    await d.click(-1.27, 0);
    await d.click(1.27, 0);
    await d.key('Escape');
    await d.button('#new-component-btn');
    await d.type('item-name', 'R');
    await d.type('prefix', 'R');
    await d.button('Add gate');
    await d.choose('#inspector select[data-field="footprint"]', 'untitled/R0805');
    await d.button('Connect the rest');
    expect(await lib('lib.components')).toEqual([{
      id: 'untitled/R', prefix: 'R', gates: [{ name: 'G$1', symbol: 'untitled/RES', at: [0, 0] }],
      variants: [{ name: '', footprint: 'untitled/R0805', pads: { 'G$1.P$1': ['1'], 'G$1.P$2': ['2'] } }],
    }]);
    // The gate is an object: rename it (the connections follow), then drag it.
    await d.click(-3, 0);
    expect((await d.state()).selection).toEqual([{ kind: 'libgate', label: 'Gate G$1' }]);
    await d.type('name', 'A');
    expect(await lib(`Object.keys(lib.components[0].variants[0].pads)`)).toEqual(['A.P$1', 'A.P$2']);
    // A pin typed to a pad another pin has is refused.
    await d.key('Escape');
    await d.type('pads:A.P$1', '2');
    expect((await d.state()).status).toBe('Pad 2 is already connected to A.P$2');
    expect(d.problems).toEqual([]);
  });

  it('lists one kind of item at a time, and links components to their symbols and footprints', async () => {
    await d.open('madhu.ospreylib');
    const tabs = () => d.evaluate<string[]>(`[...document.querySelectorAll('#library-tabs button')].map((b) => (b.getAttribute('aria-selected') === 'true' ? '*' : '') + b.textContent)`);
    const listed = () => d.evaluate<string[]>(`[...document.querySelectorAll('#library-list button')].map((b) => b.textContent)`);
    expect(await tabs()).toEqual(counts('Components'));
    expect(await listed()).toContain('1N4001');
    expect(await listed()).not.toContain('DO-41');
    // A component links to its gates' symbols and its variant's footprint.
    await d.button('#library-list button[title="madhu/1N4001"]');
    await d.button('#inspector [data-link="footprint:madhu/DO-41"]');
    expect(await tabs()).toEqual(counts('Footprints'));
    expect(await d.evaluate('document.querySelector("#library-list .active").textContent')).toBe('DO-41');
    // The footprint links back to the components that use it.
    expect(await d.evaluate('document.querySelector("#inspector .links").textContent')).toBe('Used by: 1N4001, 1N4733');
    await d.button('#inspector [data-link="component:madhu/1N4733"]');
    expect(await tabs()).toEqual(counts('Components'));
    await d.button('#inspector [data-link="symbol:madhu/DIODE-ZENER"]');
    expect(await d.evaluate('document.querySelector("#inspector input[data-field=item-name]").value')).toBe('DIODE-ZENER');
    // The filter matches descriptions too, and the counts follow it.
    await d.button('#library-tabs [data-kind="component"]');
    await d.evaluate(`(() => { const f = document.getElementById('library-filter'); f.value = 'schottky'; f.dispatchEvent(new Event('input')); })()`);
    expect(await listed()).toEqual(['20TQ035PBF', '20TQ040PBF', '20TQ045PBF', 'BAS70-05', 'DSS6-015AS']);
    expect((await tabs())[0]).toBe('*Components5');
    expect(d.problems).toEqual([]);
  });

  it('copies items from another library and from a project, and duplicates one', async () => {
    await d.open('madhu.ospreylib');
    await d.button('#new-lib-btn');
    await d.type('library-name', 'mine');
    await d.choose('#copy-from', 'lib:madhu.ospreylib');
    expect(await d.evaluate('document.getElementById("copy-banner").hidden')).toBe(false);
    await d.button('#library-list button[title="Copy 1N4001 into mine"]');
    expect((await d.state()).status).toBe('Copied 1N4001 as 1N4001 (with DIODE, DO-41, DO-41V)');
    await d.button('#library-list button[title="Copy 1N914 into mine"]');
    expect((await d.state()).status).toBe('Copied 1N914 as 1N914 (with DO-35, DO-35V; DIODE already here)');
    expect(await d.evaluate('document.querySelector("#library-list button.copied")?.textContent')).toBe('1N4001');
    // A project's library is a source too.
    await d.choose('#copy-from', 'project:../samples/osprey/wwvbfind.osprey');
    await d.button('#library-list button[title="Copy ATTINY412 into mine"]');
    await d.button('Done');
    expect(await lib('lib.components.map((c) => c.id)')).toEqual(['mine/1N4001', 'mine/1N914', 'mine/ATTINY412']);
    expect(await d.evaluate('document.querySelector("#inspector input[data-field=item-name]").value')).toBe('1N4001');
    await d.button('#inspector [data-action="duplicate"]');
    expect(await d.evaluate('document.querySelector("#inspector input[data-field=item-name]").value')).toBe('1N4001-2');
    expect((await d.state()).undo).toBe('Duplicate component 1N4001');
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
