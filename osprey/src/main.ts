// Osprey application shell: opening, importing and saving, panels, canvas interaction, commands.

import { Editor, subject, type CornerDrag, type MoveSession, type PlaceSession, type PourSession, type RouteSession, type WireSession } from './app/editor';
import { edgeMiddle } from './edit/pours';
import { layerNumber } from './model/layers';
import { canPickFiles, pickFiles, saveFile, type FileHandle } from './app/files';
import { Selection, type SelectMode } from './app/selection';
import { parseEagle } from './eagle/parse';
import { parseClip, type Clip, type Pasted } from './edit/clipboard';
import type { Layer } from './eagle/types';
import type { Point } from './geom/transform';
import { componentName, ProjectIndex } from './model/derive';
import { drc, type DrcResult, type Violation } from './model/drc';
import { readProject } from './model/file';
import { freezePours } from './model/pour';
import { designRules, parseDru } from './model/rules';
import { exportEagle } from './model/export-eagle';
import { DEFAULT_JOB, parseCamJob, runCam, type CamJob } from './cam/job';
import { zip } from './cam/zip';
import { importEagle, importLibrary } from './model/import-eagle';
import type * as O from './model/types';
import { buildBoardScene } from './scene/board';
import { indexScene, type SceneIndex } from './scene/index';
import { buildLibraryScene, type LibraryItemKind, type LibraryItemRef } from './scene/library';
import { buildSchematicScene } from './scene/schematic';
import type { Bounds, Owner, Scene, Target } from './scene/types';
import { pick, pickBox } from './view/hittest';
import { displayLayers, layerColor, layerName } from './view/palette';
import { render } from './view/render';
import { Viewport } from './view/viewport';

type ViewKind = 'schematic' | 'board' | 'library';

interface SourceFile {
  name: string;
  text: string;
  handle?: FileHandle;
}

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const stage = $<HTMLDivElement>('stage');
const ctx = canvas.getContext('2d')!;
const fileInput = $<HTMLInputElement>('file-input');
const sampleSelect = $<HTMLSelectElement>('sample-select');
const sheetField = $<HTMLLabelElement>('sheet-field');
const sheetSelect = $<HTMLSelectElement>('sheet-select');
const docTitle = $<HTMLSpanElement>('doc-title');
const layerList = $<HTMLUListElement>('layer-list');
const libraryPanel = $<HTMLElement>('library-panel');
const libraryFilter = $<HTMLInputElement>('library-filter');
const libraryList = $<HTMLDivElement>('library-list');
const inspector = $<HTMLDivElement>('inspector');
const errorBox = $<HTMLDivElement>('error');
const dropOverlay = $<HTMLDivElement>('drop-overlay');
const statusPos = $<HTMLSpanElement>('status-pos');
const statusZoom = $<HTMLSpanElement>('status-zoom');
const statusSel = $<HTMLSpanElement>('status-sel');
const statusMsg = $<HTMLSpanElement>('status-msg');
const statusHint = $<HTMLSpanElement>('status-hint');
const undoBtn = $<HTMLButtonElement>('undo-btn');
const redoBtn = $<HTMLButtonElement>('redo-btn');
const saveBtn = $<HTMLButtonElement>('save-btn');
const exportBtn = $<HTMLButtonElement>('export-btn');
const camSelect = $<HTMLSelectElement>('cam-select');
const camInput = $<HTMLInputElement>('cam-input');
const viewToggle = $<HTMLDivElement>('view-toggle');
const projectPanel = $<HTMLElement>('project-panel');
const partsPanel = $<HTMLElement>('parts-panel');
const partsSource = $<HTMLSelectElement>('parts-source');
const partsFilter = $<HTMLInputElement>('parts-filter');
const partsList = $<HTMLDivElement>('parts-list');
const partsChoice = $<HTMLDivElement>('parts-choice');
const lbrInput = $<HTMLInputElement>('lbr-input');
const wireBtn = $<HTMLButtonElement>('wire-btn');
const pourBtn = $<HTMLButtonElement>('pour-btn');
const layerField = $<HTMLLabelElement>('layer-field');
const layerSelect = $<HTMLSelectElement>('layer-select');
const drcPanel = $<HTMLElement>('drc-panel');
const drcName = $<HTMLSpanElement>('drc-name');
const drcLoad = $<HTMLSelectElement>('drc-load');
const drcSummary = $<HTMLDivElement>('drc-summary');
const drcList = $<HTMLDivElement>('drc-list');
const druInput = $<HTMLInputElement>('dru-input');

// ---------------------------------------------------------------------------
// State

const vp = new Viewport();
const selection = new Selection();
/** The open project (schematic and/or board), or a library being viewed. */
let project: O.Project | undefined;
let library: { name: string; lib: O.Library } | undefined;
/** File name the project saves to, and where (when opened through the native dialog). */
let saveName = '';
let saveHandle: FileHandle | undefined;
/** What the Eagle import reported (inconsistencies, conflicting library copies…). */
let importReport: string[] = [];
let view: ViewKind = 'schematic';
let editor: Editor | undefined;

/** What each view remembers while another is shown. */
interface ViewState {
  cx: number;
  cy: number;
  zoom: number;
  visibility: Map<number, boolean>;
  selection: string[];
}
const viewStates = new Map<ViewKind, ViewState>();
let index: SceneIndex | undefined;
const layers: Layer[] = displayLayers();
const layerMap = new Map<number, Layer>(layers.map((l) => [l.number, l]));
let visibility = new Map<number, boolean>();
let hover: string | undefined;
let libraryItem: LibraryItemRef | undefined;
let box: { start: Point; end: Point } | undefined;
/** World position of the cursor (last known). */
let cursor: Point = { x: 0, y: 0 };

/** Adding parts: the session places gates under the cursor until stopped. */
let placing: PlaceSession | undefined;
/** Libraries loaded for adding parts (Eagle .lbr files), by file name. */
const loadedLibraries = new Map<string, O.Library>();
/** The component chosen in the Add part panel. */
let chosen: { source: string; id: string } | undefined;

/** The last design-rule check (kept up to date after edits once run), and the violation in focus. */
let drcResult: DrcResult | undefined;
let drcActive: Violation | undefined;

/** Show poured copper, or only pour outlines. */
let showPours = storeGet('osprey.showPours') !== 'no';

/** Drawing wires (the W key): active until stopped. */
let wiring: WireSession | undefined;
/** Routing traces (the W key on the board): active until stopped. */
let routing: RouteSession | undefined;
/** Drawing a pour (the Pour button): ends when the pour is closed or cancelled. */
let pouring: PourSession | undefined;
/** A pour corner being dragged (from its handle), and the corner last clicked (Del removes it). */
let cornerDrag: CornerDrag | undefined;
let activeCorner: { pour: O.PolygonShape; index: number } | undefined;
/** The net of the last pour drawn (the default for the next one). */
let lastPour: { net?: string } = {};
/** The copper layer Route and Pour work on (the toolbar's Layer selector; remembered while the project is open). */
let activeLayer: string | undefined;

/** An interactive move: started by dragging a selected object (`drag`) or by the M key. */
let move: { session: MoveSession; start: Point; drag: boolean; paste?: Pasted } | undefined;
/** The last clip copied here (used when the system clipboard can't be read). */
let lastClip: Clip | undefined;

const isVisible = (layer: number) => visibility.get(layer) ?? true;

function views(): ViewKind[] {
  if (library) return ['library'];
  const out: ViewKind[] = [];
  if (project?.schematic) out.push('schematic');
  if (project?.board) out.push('board');
  return out;
}

const editable = () => !!editor && view !== 'library';

// ---------------------------------------------------------------------------
// Opening, importing and saving

const samples = {
  ...import.meta.glob('../samples/osprey/*.osprey', { query: '?raw', import: 'default' }),
  ...import.meta.glob('../samples/eagle/*.{sch,brd,lbr}', { query: '?raw', import: 'default' }),
};

interface Sample {
  label: string;
  paths: string[];
}

/**
 * Samples, in menu order: Osprey projects ("TA7358A.osprey"), then Eagle pairs to import
 * ("TA7358A.sch+brd"), then Eagle libraries ("madhu.lbr").
 */
function sampleList(): Map<string, Sample> {
  const paths = Object.keys(samples).sort();
  const file = (p: string) => p.split('/').pop()!;
  const out = new Map<string, Sample>();
  for (const p of paths.filter((x) => x.endsWith('.osprey'))) out.set(file(p), { label: `${file(p).replace(/\.osprey$/, '')} (Osprey project)`, paths: [p] });
  const pairs = new Map<string, string[]>();
  for (const p of paths.filter((x) => /\.(sch|brd)$/.test(x))) {
    const base = file(p).replace(/\.(sch|brd)$/, '');
    pairs.set(base, [...(pairs.get(base) ?? []), p]);
  }
  for (const [base, ps] of pairs) {
    const exts = ps.map((p) => p.slice(p.lastIndexOf('.') + 1)).sort().reverse(); // sch before brd
    out.set(`${base}.${exts.join('+')}`, { label: `${base} (import Eagle .${exts.join(' + .')})`, paths: ps });
  }
  for (const p of paths.filter((x) => x.endsWith('.lbr'))) out.set(file(p), { label: `${file(p)} (Eagle library)`, paths: [p] });
  return out;
}

/** "#<sample>" or "#<sample>/board"; older links "#TA7358A" and "#TA7358A.brd" still work. */
function parseSampleLink(hash: string, list: Map<string, Sample>): { key?: string; view?: ViewKind } {
  const [raw, viewPart] = decodeURIComponent(hash.replace(/^#/, '')).split('/');
  let key = raw ?? '';
  let view: ViewKind | undefined = viewPart === 'board' ? 'board' : viewPart === 'schematic' ? 'schematic' : undefined;
  if (!list.has(key)) {
    const base = key.replace(/\.(sch|brd)$/, '');
    if (key.endsWith('.brd')) view = 'board';
    key = list.has(`${base}.osprey`) ? `${base}.osprey` : [...list.keys()].find((k) => k.startsWith(`${base}.`)) ?? '';
  }
  return { ...(key ? { key } : {}), ...(view ? { view } : {}) };
}

/** The sample currently open (its key), to keep the address bar pointing at it. */
let openSample = '';

function initSamples(): void {
  const list = sampleList();
  sampleSelect.append(new Option('—', ''));
  for (const [key, s] of list) sampleSelect.append(new Option(s.label, key));
  const open = async (key: string, initialView?: ViewKind) => {
    const sample = list.get(key);
    if (!sample) return;
    const sources = await Promise.all(
      sample.paths.map(async (p): Promise<SourceFile> => ({ name: p.split('/').pop()!, text: (await samples[p]!()) as string })),
    );
    openSample = key;
    openSources(sources, initialView);
    storeSet('osprey.sample', key);
    updateSampleLink();
  };
  sampleSelect.addEventListener('change', async () => {
    if (!sampleSelect.value) return;
    if (!confirmDiscard()) {
      sampleSelect.value = '';
      return;
    }
    await open(sampleSelect.value);
    canvas.focus({ preventScroll: true });
  });
  const link = parseSampleLink(location.hash, list);
  const remembered = storeGet('osprey.sample');
  const initial = link.key ?? (remembered && list.has(remembered) ? remembered : [...list.keys()][0]);
  if (initial) {
    sampleSelect.value = initial;
    void open(initial, link.key ? link.view : undefined);
  }
}

/** A file of your own is open: the address bar no longer points at a sample. */
function clearSampleLink(): void {
  sampleSelect.value = '';
  openSample = '';
  history.replaceState(null, '', location.pathname + location.search);
}

/** Point the address bar at the open sample and view, so a reload comes back to it. */
function updateSampleLink(): void {
  if (!openSample || sampleSelect.value !== openSample) return;
  history.replaceState(null, '', `#${encodeURIComponent(openSample)}${view === 'board' ? '/board' : ''}`);
}

/**
 * Open files: an Osprey project (.osprey), an Eagle schematic and/or board (imported into a
 * new project), or an Eagle library (viewed).
 */
function openSources(sources: SourceFile[], initialView?: ViewKind): void {
  const ext = (s: SourceFile) => s.name.slice(s.name.lastIndexOf('.')).toLowerCase();
  try {
    const kinds = new Set(sources.map(ext));
    let next: { project?: O.Project; library?: { name: string; lib: O.Library }; report: string[]; name: string; handle?: FileHandle };
    if (kinds.has('.osprey')) {
      if (sources.length > 1) throw new Error('Open one Osprey project at a time');
      const src = sources[0]!;
      next = { project: readProject(src.text), report: [], name: src.name, ...(src.handle ? { handle: src.handle } : {}) };
    } else if (kinds.has('.lbr')) {
      if (sources.length > 1) throw new Error('Open a library on its own');
      const src = sources[0]!;
      next = { library: { name: src.name, lib: importLibrary(src.name, parseEagle(src.text)) }, report: [], name: src.name };
    } else {
      const eagle = sources.filter((s) => ['.sch', '.brd'].includes(ext(s)));
      if (!eagle.length) throw new Error('Choose an .osprey project, or Eagle .sch/.brd files to import');
      const { project: p, report } = importEagle(eagle.map((s) => ({ name: s.name, file: parseEagle(s.text) })));
      const missing = !p.schematic ? '.sch' : !p.board ? '.brd' : undefined;
      if (missing) report.unshift(`Only one file was imported; select the ${missing} too to import the whole project.`);
      next = { project: p, report, name: `${p.project.name}.osprey` };
    }
    cancelMove();
    stopPlacing();
    stopWiring();
    stopRouting();
    stopPouring();
    lastPour = {};
    activeLayer = undefined;
    drcResult = undefined;
    drcActive = undefined;
    project = next.project;
    library = next.library;
    importReport = next.report;
    saveName = next.name;
    saveHandle = next.handle;
    editor = project ? new Editor(project, onEdited) : undefined;
    viewStates.clear();
    libraryItem = undefined;
    hideError();
    if (library) setupLibrary();
    const vs = views();
    showView(initialView && vs.includes(initialView) ? initialView : vs[0]!, false);
    if (importReport.length) flash(`Imported with ${importReport.length} note(s); see the Project panel`);
  } catch (e) {
    const what = sources.map((x) => x.name).join(' + ');
    showError(`Could not open ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openViaDialog(): Promise<void> {
  if (!confirmDiscard()) return;
  if (!canPickFiles()) {
    fileInput.click();
    return;
  }
  try {
    const files = await pickFiles();
    if (!files.length) return;
    openSources(files);
    clearSampleLink();
  } catch (e) {
    showError(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openDropped(files: File[]): Promise<void> {
  if (!files.length || !confirmDiscard()) return;
  openSources(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
  clearSampleLink();
}

/** Save the project as one `.osprey` file. */
async function save(): Promise<void> {
  if (!editor || !project) return;
  if (move) commitMove();
  try {
    const result = await saveFile(editor.serialize(), saveName, saveHandle);
    if (!result) return; // cancelled
    if (result.handle) {
      saveHandle = result.handle;
      saveName = result.handle.name;
    }
    editor.history.markSaved();
    flash(`${result.method === 'written' ? 'Saved' : 'Downloaded'} ${saveName}`);
    updateChrome();
  } catch (e) {
    showError(`Could not save ${saveName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Export the project as an Eagle schematic and board (one save dialog or download each). */
async function exportToEagle(): Promise<void> {
  if (!project) return;
  if (move) commitMove();
  try {
    const { files } = exportEagle(project);
    const done: string[] = [];
    for (const [name, text] of files) {
      const result = await saveFile(text, name, undefined, 'eagle');
      if (!result) break; // cancelled
      done.push(result.handle?.name ?? name);
    }
    if (done.length) flash(`Exported ${done.join(' and ')}`);
  } catch (e) {
    showError(`Could not export: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// CAM output

const sampleCamJobs = import.meta.glob('../samples/eagle/*.cam', { query: '?raw', import: 'default' });

camSelect.append(new Option('CAM…', ''), new Option(`${DEFAULT_JOB.name} (.zip)`, 'default'));
for (const path of Object.keys(sampleCamJobs).sort()) camSelect.append(new Option(`Job ${path.split('/').pop()!}`, path));
camSelect.append(new Option('From a .cam job file…', 'open'));

/** Run a CAM job on the board and save the files as one zip. */
async function makeCam(job: CamJob): Promise<void> {
  if (!project?.board) return;
  if (move) commitMove();
  try {
    const { files, warnings } = runCam(project, job);
    const name = `${project.project.name}_CAM.zip`;
    const result = await saveFile(zip(files), name, undefined, 'zip');
    if (!result) return;
    hideError();
    flash(`${result.method === 'written' ? 'Saved' : 'Downloaded'} ${result.handle?.name ?? name} (${files.size} files)`);
    if (warnings.length) showError(`CAM: ${warnings.join('; ')}.`, 'notice');
  } catch (e) {
    showError(`Could not make CAM files: ${e instanceof Error ? e.message : String(e)}`);
  }
}

camSelect.addEventListener('change', async () => {
  const v = camSelect.value;
  camSelect.value = '';
  if (v === 'open') camInput.click();
  else if (v === 'default') await makeCam(DEFAULT_JOB);
  else if (v && sampleCamJobs[v]) {
    const name = v.split('/').pop()!;
    try {
      await makeCam(parseCamJob((await sampleCamJobs[v]!()) as string, name));
    } catch (e) {
      showError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
});
camInput.addEventListener('change', async () => {
  const file = camInput.files?.[0];
  camInput.value = '';
  if (!file) return;
  try {
    await makeCam(parseCamJob(await file.text(), file.name));
  } catch (e) {
    showError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
});

function confirmDiscard(): boolean {
  return !editor?.history.dirty || window.confirm(`Discard unsaved changes to ${saveName}?`);
}

function setupLibrary(): void {
  const lib = library?.lib;
  if (!lib) return;
  const kind: LibraryItemKind = lib.components.length ? 'component' : lib.symbols.length ? 'symbol' : 'footprint';
  const items = kind === 'component' ? lib.components : kind === 'symbol' ? lib.symbols : lib.footprints;
  const first = [...items].sort((a, b) => a.id.localeCompare(b.id))[0];
  libraryItem = first ? { kind, id: first.id } : undefined;
  libraryFilter.value = '';
  renderLibraryList();
}

/** Panels and hints that depend on which view is shown. */
function setupViewChrome(): void {
  const sheets = view === 'schematic' ? project?.schematic?.sheets ?? [] : [];
  sheetField.hidden = sheets.length < 2;
  if (sheetSelect.options.length !== sheets.length) {
    sheetSelect.replaceChildren(...sheets.map((_, i) => new Option(`${i + 1}`, String(i))));
  }
  libraryPanel.hidden = view !== 'library';
  partsPanel.hidden = !(project && view === 'schematic');
  wireBtn.hidden = !(project && (view === 'schematic' || view === 'board'));
  drcPanel.hidden = !(project?.board && view === 'board');
  if (!drcPanel.hidden) renderDrcPanel();
  wireBtn.textContent = view === 'board' ? 'Route' : 'Wire';
  pourBtn.hidden = !(project?.board && view === 'board');
  layerField.hidden = pourBtn.hidden;
  if (!layerField.hidden) renderLayerSelect();
  wireBtn.title = view === 'board'
    ? 'Route traces (W): start on a pad, via or trace end; click adds corners; L changes layer; ends on copper of the same net, or with a double click or Esc'
    : 'Draw wires (W): click to start, click to add corners; a wire ends on a pin or wire, or with a double click or Esc';
  if (!partsPanel.hidden) renderPartsPanel();
  viewToggle.hidden = views().length < 2;
  for (const b of viewToggle.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.view === view);
    b.hidden = !views().includes(b.dataset.view as ViewKind);
  }
  statusHint.textContent = view !== 'library'
    ? `${view === 'schematic' ? 'A adds part · W draws wires · Ctrl+C/V copies · ' : 'W routes · L layer · P pours · '}Drag or M moves · R rotates · F ${view === 'board' ? 'flips side' : 'mirrors'} · Del deletes · N name · V value · Ctrl+Z undo · Ctrl+S save · Space+drag pans · Home fits`
    : 'Click to select · Shift adds · Ctrl toggles · drag to box-select · Space+drag or right-drag pans · Home fits';
  // The hint is cut off on narrow windows; the tooltip always has all of it.
  statusHint.title = statusHint.textContent;
  updateChrome();
}

/** Title, unsaved marker, project panel and toolbar button states. */
function updateChrome(): void {
  const dirty = editor?.history.dirty ?? false;
  const name = library ? library.name : project?.project.name ?? '';
  const kinds = library ? 'Library (view only)' : views().map((v) => v[0]!.toUpperCase() + v.slice(1)).join(' + ');
  docTitle.textContent = `${dirty ? '● ' : ''}${name} — ${kinds}`;
  docTitle.title = project ? `Saves to ${saveName}` : '';
  document.title = `${dirty ? '• ' : ''}${name} · Osprey`;
  renderProjectPanel();
  const h = editor?.history;
  undoBtn.disabled = !h?.canUndo;
  redoBtn.disabled = !h?.canRedo;
  undoBtn.title = h?.undoLabel ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  redoBtn.title = h?.redoLabel ? `Redo ${h.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  saveBtn.disabled = !editor;
  exportBtn.disabled = !project;
  camSelect.disabled = !project?.board;
  saveBtn.textContent = dirty ? 'Save •' : 'Save';
  saveBtn.title = project ? `Save ${saveName} (Ctrl+S)` : 'Save (Ctrl+S)';
}

function buildScene(): Scene | undefined {
  if (view === 'library') return library && libraryItem ? buildLibraryScene(library.lib, layers, libraryItem) : undefined;
  if (!project) return undefined;
  const ix = new ProjectIndex(project);
  if (view === 'schematic') return buildSchematicScene(project, layers, Number(sheetSelect.value || 0), ix);
  return buildBoardScene(project, layers, ix, { showPours });
}

function rebuildScene(opts: { fit: boolean; keepSelection: boolean }): void {
  try {
    const scene = buildScene();
    index = scene ? indexScene(scene) : undefined;
  } catch (e) {
    index = undefined;
    showError(`Could not display the ${view}: ${e instanceof Error ? e.message : String(e)}`);
  }
  hover = undefined;
  if (opts.keepSelection && index) {
    // Owner ids are stable across edits, so the selection survives a rebuild.
    selection.select([...selection.items].filter((id) => index!.scene.owners.has(id)), 'replace');
  } else {
    selection.clear();
  }
  // The layer list changes when it must: a new view, or an edit that adds or empties a layer
  // (e.g. airwires appearing when a trace is deleted).
  const used = index?.usedLayers.join(',') ?? '';
  if (!opts.keepSelection || used !== listedLayers) renderLayerList();
  listedLayers = used;
  renderInspector();
  if (opts.fit) fitView();
  requestRender();
}

/** The layers the layer panel currently lists (to know when it needs refreshing). */
let listedLayers = '';

/** Called by the editor after every change to the design (edit, undo, redo). */
function onEdited(): void {
  wiring?.refresh();
  routing?.refresh();
  // While moving or drawing, the model changes on every mouse move: check once it settles.
  if (drcResult && project && !move && !placing) {
    drcResult = drc(project);
    if (drcActive) drcActive = drcResult.violations.find((v) => v.message === drcActive!.message);
    if (view === 'board') renderDrcPanel();
  }
  rebuildScene({ fit: false, keepSelection: true });
  updateChrome();
}

// ---------------------------------------------------------------------------
// Views: schematic ↔ board

/** Switch to a view, carrying the selected parts and nets across (cross-probing). */
function switchView(next: ViewKind): void {
  if (next === view || !views().includes(next)) return;
  if (move) commitMove();
  const probe = crossProbeKeys();
  showView(next, true);
  if (probe.parts.size || probe.nets.size) {
    selection.select(ownersFor(probe), 'replace');
    if (selection.size) flash(`${selection.size} matching object(s) selected in the ${next}`);
  }
}

function saveViewState(): void {
  viewStates.set(view, { cx: vp.cx, cy: vp.cy, zoom: vp.zoom, visibility, selection: [...selection.items] });
}

/** Show a view, restoring what it remembered. */
function showView(next: ViewKind, rememberCurrent: boolean): void {
  stopPlacing();
  stopWiring();
  stopRouting();
  stopPouring();
  if (rememberCurrent) saveViewState();
  view = next;
  const state = viewStates.get(next);
  visibility = state?.visibility ?? new Map(layers.map((l) => [l.number, l.visible]));
  setupViewChrome();
  rebuildScene({ fit: !state, keepSelection: false });
  if (state) {
    vp.cx = state.cx;
    vp.cy = state.cy;
    vp.zoom = state.zoom;
    selection.select(state.selection.filter((id) => index?.scene.owners.has(id)), 'replace');
  }
  updateChrome();
  requestRender();
  updateSampleLink();
}

/** Part and net names of the current selection. */
function crossProbeKeys(): { parts: Set<string>; nets: Set<string> } {
  const parts = new Set<string>();
  const nets = new Set<string>();
  for (const o of selectedOwners()) {
    if (o.target?.kind === 'gate') parts.add(o.target.gate.part);
    else if (o.target?.kind === 'footprint') parts.add(o.target.footprint.part);
    else if (o.net) nets.add(o.net);
  }
  return { parts, nets };
}

/** Owners in the current scene standing for these parts and nets. */
function ownersFor(keys: { parts: Set<string>; nets: Set<string> }): string[] {
  if (!index) return [];
  return [...index.scene.owners.values()]
    .filter((o) =>
      (o.target?.kind === 'gate' && keys.parts.has(o.target.gate.part)) ||
      (o.target?.kind === 'footprint' && keys.parts.has(o.target.footprint.part)) ||
      (o.net !== undefined && o.kind !== 'airwire' && keys.nets.has(o.net)))
    .map((o) => o.id);
}

/** Left panel: where the project came from, and anything the import reported. */
function renderProjectPanel(): void {
  projectPanel.replaceChildren();
  const imported = project?.project.imported;
  if (!project || (!imported && !importReport.length)) {
    projectPanel.hidden = true;
    return;
  }
  projectPanel.hidden = false;
  const h = document.createElement('h2');
  h.textContent = 'Project';
  projectPanel.append(h);
  if (imported) projectPanel.append(el('p', 'project-note', `Imported from Eagle ${imported.eagleVersion}: ${imported.from.join(' + ')}`));
  if (!importReport.length) {
    projectPanel.append(el('p', 'sync-ok', '✓ Imported without problems'));
    return;
  }
  projectPanel.append(el('p', 'sync-bad', `⚠ ${importReport.length} note(s) from the import`));
  const list = document.createElement('ul');
  list.className = 'issue-list';
  for (const msg of importReport) list.append(el('li', '', msg));
  projectPanel.append(list);
}

/** Grid spacing of the current view (`alt` = fine grid). */
function gridOf(alt = false): number {
  return editor && view !== 'library' ? editor.grid(view, alt) : 1.27;
}

function snap(v: number, alt = false): number {
  const g = gridOf(alt);
  return Math.round(v / g) * g;
}

// ---------------------------------------------------------------------------
// Commands (verbs) on the selection

function selectedOwners(): Owner[] {
  if (!index) return [];
  return [...selection.items].map((id) => index!.scene.owners.get(id)).filter((o): o is Owner => !!o);
}

function selectedTargets(): Target[] {
  return selectedOwners().flatMap((o) => (o.target ? [o.target] : []));
}

/**
 * The point commands pivot about: a single part's origin, otherwise the centre
 * of the selection snapped to the grid (as Eagle does for groups).
 */
function pivot(): Point {
  const owners = selectedOwners();
  if (owners.length === 1 && owners[0]!.origin) return owners[0]!.origin;
  let b: Bounds | undefined;
  for (const o of owners) {
    const ob = index?.ownerBounds.get(o.id);
    if (ob) b = b ? unionBounds(b, ob) : { ...ob };
  }
  if (!b || !editor) return cursor;
  return { x: snap((b.minX + b.maxX) / 2), y: snap((b.minY + b.maxY) / 2) };
}

/**
 * The point that should land on the grid when moving: a single part's origin, or the
 * end of a single trace nearest to where it was grabbed. Undefined = snap the displacement.
 */
function snapReference(grab: Point): Point | undefined {
  const owners = selectedOwners();
  if (owners.length !== 1) return undefined;
  const o = owners[0]!;
  if (o.origin) return o.origin;
  if (o.target?.kind === 'trace' || o.target?.kind === 'wire') {
    const [a, b] = (o.target.kind === 'trace' ? o.target.trace : o.target.wire).line;
    const d1 = Math.hypot(a[0] - grab.x, a[1] - grab.y);
    const d2 = Math.hypot(b[0] - grab.x, b[1] - grab.y);
    return d1 <= d2 ? { x: a[0], y: a[1] } : { x: b[0], y: b[1] };
  }
  return undefined;
}

/** Rotation/flip pivot while moving: the snap reference if any, else the grab point on the grid. */
function pivotFor(grab: Point): Point {
  return snapReference(grab) ?? { x: snap(grab.x), y: snap(grab.y) };
}

/** Explain why a command does nothing, or return the editable targets. */
function commandTargets(verb: string): Target[] | undefined {
  if (!editable()) {
    flash(`${verb} works on projects; libraries are view-only`);
    return undefined;
  }
  if (!editor) return undefined;
  const ts = selectedTargets();
  if (!ts.length) {
    flash(`Select something to ${verb.toLowerCase()}`);
    return undefined;
  }
  const ok = editor.editable(ts);
  if (!ok.length) {
    flash('The selection is locked');
    return undefined;
  }
  if (ok.length < ts.length) flash(`${ts.length - ok.length} locked part(s) left in place`);
  return ok;
}

function rotateCmd(quarterTurns: number): void {
  if (placing) {
    placing.rotate(quarterTurns);
    onEdited();
    return;
  }
  if (move) {
    move.session.rotate(quarterTurns);
    onEdited();
    return;
  }
  const ts = commandTargets('Rotate');
  if (ts) editor!.rotate(ts, pivot(), quarterTurns);
}

function mirrorCmd(): void {
  if (placing) {
    placing.mirror();
    onEdited();
    return;
  }
  if (move) {
    move.session.mirror();
    onEdited();
    return;
  }
  const verb = view === 'board' ? 'Flip' : 'Mirror';
  const ts = commandTargets(verb);
  if (ts) editor!.mirror(ts, pivot(), verb);
}

function deleteCmd(): void {
  if (move) return;
  const ts = commandTargets('Delete');
  if (!ts) return;
  const locked = editor!.delete(ts);
  selection.clear();
  if (locked.length) flash(`Not deleted: ${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} locked on the board`);
}

// ---------------------------------------------------------------------------
// Copy and paste (schematic)

/** The selection as a clip, or undefined (with a message) when there's nothing to copy. */
function copyClip(verb: string): Clip | undefined {
  if (!editor || view !== 'schematic') {
    flash(`${verb} works in the schematic`);
    return undefined;
  }
  const clip = editor.copy(selectedTargets());
  if (!clip) flash(`Select parts, wires or drawing to ${verb.toLowerCase()}`);
  return clip;
}

function describeClip(clip: Clip): string {
  const parts = clip.parts.length;
  const wires = clip.nets.reduce((n, net) => n + net.segments.reduce((m, sg) => m + sg.wires.length, 0), 0);
  const bits = [parts && `${parts} part${parts > 1 ? 's' : ''}`, wires && `${wires} wire${wires > 1 ? 's' : ''}`, clip.drawing.length && 'drawing'].filter(Boolean);
  return bits.join(', ') || 'selection';
}

function startPaste(clip: Clip): void {
  if (!editor || view !== 'schematic') {
    flash('Paste works in the schematic');
    return;
  }
  stopPlacing();
  stopWiring();
  stopRouting();
  if (move) commitMove();
  const r = editor.beginPaste(clip, Number(sheetSelect.value || 0), gridOf);
  if (!r) return;
  move = { session: r.session, start: { x: clip.origin[0], y: clip.origin[1] }, drag: false, paste: r.pasted };
  if (project) freezePours(project, true);
  selection.clear();
  canvas.classList.add('moving');
  canvas.focus({ preventScroll: true });
  updateMove(cursor, false);
  const notes = r.pasted.libraryNotes.length ? ` (using the project's own ${r.pasted.libraryNotes.join(', ')})` : '';
  flash(`Pasting ${describeClip(clip)}: click to place · R rotates · F mirrors · Esc cancels${notes}`);
}

/** Text selected on the page (e.g. in the inspector) is copied as text, not as design. */
const pageTextSelected = () => !!window.getSelection()?.toString();

document.addEventListener('copy', (e) => {
  if (isTextEntry(e.target) || !editor || pageTextSelected()) return;
  e.preventDefault();
  const clip = copyClip('Copy');
  if (!clip) return;
  lastClip = clip;
  e.clipboardData?.setData('text/plain', JSON.stringify(clip));
  flash(`Copied ${describeClip(clip)} · Ctrl+V pastes`);
});
document.addEventListener('cut', (e) => {
  if (isTextEntry(e.target) || !editor || pageTextSelected()) return;
  e.preventDefault();
  const clip = copyClip('Cut');
  if (!clip) return;
  lastClip = clip;
  e.clipboardData?.setData('text/plain', JSON.stringify(clip));
  deleteCmd();
  flash(`Cut ${describeClip(clip)} · Ctrl+V pastes`);
});
document.addEventListener('paste', (e) => {
  if (isTextEntry(e.target) || !editor) return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  const clip = text ? parseClip(text) : lastClip;
  if (clip) startPaste(clip);
  else flash('The clipboard holds no Osprey selection');
});

/** Start a move. `drag` = following a held mouse button; otherwise it follows the cursor until a click. */
function beginMove(start: Point, drag: boolean): void {
  if (move || !editor) return;
  const ts = commandTargets('Move');
  if (!ts) return;
  const session = editor.beginMove(ts, gridOf, pivotFor(start), snapReference(start));
  if (!session) return;
  move = { session, start, drag };
  // Pours aren't recomputed on every mouse move; they catch up when the move ends.
  if (project) freezePours(project, true);
  canvas.classList.add('moving');
  flash(drag ? 'Moving: release to place · Esc cancels' : `Moving: click to place · R rotates · F ${view === 'board' ? 'flips' : 'mirrors'} · Esc cancels`);
}

function updateMove(p: Point, fineGrid: boolean): void {
  if (!move) return;
  move.session.moveBy({ x: p.x - move.start.x, y: p.y - move.start.y }, fineGrid);
  onEdited();
}

function commitMove(): void {
  if (!move) return;
  const m = move;
  move = undefined;
  canvas.classList.remove('moving');
  const { x, y } = m.session.offset;
  if (project) freezePours(project, false);
  m.session.commit();
  if (m.paste) {
    reselect(m.session.targets.map(subject));
    const renamed = [...m.paste.renamed].map(([a, b]) => `${a} → ${b}`);
    flash(`Pasted${renamed.length ? `: ${renamed.slice(0, 6).join(', ')}${renamed.length > 6 ? ', …' : ''}` : ''}`);
  } else {
    flash(x || y ? `Moved by (${round(x)}, ${round(y)}) mm` : '');
  }
}

function cancelMove(): void {
  if (!move) return;
  const wasPaste = !!move.paste;
  if (project) freezePours(project, false);
  move.session.cancel();
  move = undefined;
  canvas.classList.remove('moving');
  flash(wasPaste ? 'Paste cancelled' : 'Move cancelled');
  if (editor) onEdited();
}

function undoCmd(): void {
  if (move) cancelMove();
  else if (editor) reselect(editor.undo());
}

function redoCmd(): void {
  if (!move && editor) reselect(editor.redo());
}

/** Select the owners standing for these model objects (those that still exist). */
function reselect(objects: object[]): void {
  if (!index || !objects.length) return;
  const wanted = new Set(objects);
  const ids = [...index.scene.owners.values()].filter((o) => o.target && wanted.has(subject(o.target))).map((o) => o.id);
  // A step made in the other view (e.g. a schematic delete undone while viewing the board)
  // reselects the same parts here by name.
  const parts = new Set<string>();
  // Gate and footprint placements both name their part.
  for (const obj of objects) if ('part' in obj && 'at' in obj) parts.add((obj as { part: string }).part);
  const probed = parts.size ? ownersFor({ parts, nets: new Set() }) : [];
  selection.select([...new Set([...ids, ...probed])], 'replace');
}

// ---------------------------------------------------------------------------
// Panels

function renderLayerList(): void {
  layerList.replaceChildren();
  if (!index) return;
  // Poured copper on or off (P): a display choice, kept in the browser.
  if (view === 'board' && project?.nets.some((n) => n.pours?.length)) {
    const li = document.createElement('li');
    li.className = 'pours-toggle';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'pours-toggle';
    cb.checked = showPours;
    cb.addEventListener('change', () => setShowPours(cb.checked));
    // Laid out like a layer row: no colour, the key where the layer number goes.
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.visibility = 'hidden';
    const key = document.createElement('span');
    key.className = 'layer-num';
    key.textContent = 'P';
    const name = document.createElement('span');
    name.textContent = 'pour fill';
    label.append(cb, sw, key, name);
    label.title = 'Show poured copper, or only the pour outlines (P). Airwires and the DRC count the copper either way.';
    li.append(label);
    layerList.append(li);
  }
  for (const n of index.usedLayers) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isVisible(n);
    cb.addEventListener('change', () => {
      visibility.set(n, cb.checked);
      pruneHiddenSelection();
      requestRender();
    });
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = layerColor(layerMap.get(n));
    const num = document.createElement('span');
    num.className = 'layer-num';
    num.textContent = String(n);
    const name = document.createElement('span');
    name.textContent = layerName(layers, n);
    label.append(cb, sw, num, name);
    li.append(label);
    layerList.append(li);
  }
}

function setShowPours(on: boolean): void {
  showPours = on;
  storeSet('osprey.showPours', on ? 'yes' : 'no');
  rebuildScene({ fit: false, keepSelection: true });
  const cb = document.getElementById('pours-toggle') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  flash(on ? 'Pours shown filled' : 'Pours shown as outlines (P shows them filled)');
}

function setAllLayers(on: boolean): void {
  if (!index) return;
  for (const n of index.usedLayers) visibility.set(n, on);
  renderLayerList();
  pruneHiddenSelection();
  requestRender();
}

/** Drop selected objects that no longer have anything visible. */
function pruneHiddenSelection(): void {
  if (!index) return;
  const keep = [...selection.items].filter((id) =>
    (index!.ownerPrims.get(id) ?? []).some((i) => isVisible(index!.scene.prims[i]!.layer)),
  );
  if (keep.length !== selection.size) selection.select(keep, 'replace');
}

function renderLibraryList(): void {
  const lib = library?.lib;
  libraryList.replaceChildren();
  if (!lib) return;
  const q = libraryFilter.value.trim().toLowerCase();
  const groups: [string, LibraryItemKind, { id: string }[]][] = [
    ['Components', 'component', lib.components],
    ['Symbols', 'symbol', lib.symbols],
    ['Footprints', 'footprint', lib.footprints],
  ];
  for (const [title, kind, items] of groups) {
    const matches = items.map((i) => i.id).filter((id) => !q || componentName(id).toLowerCase().includes(q)).sort();
    if (!matches.length) continue;
    const h = document.createElement('h3');
    h.textContent = `${title} (${matches.length})`;
    libraryList.append(h);
    for (const id of matches) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = componentName(id);
      btn.title = id;
      if (libraryItem?.kind === kind && libraryItem.id === id) btn.className = 'active';
      btn.addEventListener('click', () => {
        libraryItem = { kind, id };
        renderLibraryList();
        rebuildScene({ fit: true, keepSelection: false });
      });
      libraryList.append(btn);
    }
  }
}

const KIND_LABEL: Record<Owner['kind'], string> = {
  gate: 'Part (gate)',
  wire: 'Net wire',
  'bus-wire': 'Bus wire',
  junction: 'Junction',
  netlabel: 'Net label',
  footprint: 'Part (footprint)',
  trace: 'Trace',
  via: 'Via',
  pour: 'Copper pour',
  drawing: 'Drawing',
  label: 'Smashed text',
  airwire: 'Airwire (computed)',
  'library-item': 'Library item',
};

function renderInspector(): void {
  inspector.replaceChildren();
  statusSel.textContent = selection.size ? `${selection.size} selected` : '';
  const owners = selectedOwners();

  if (owners.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML =
      '<p>Nothing selected.</p>' +
      '<p>Click an object to select it. Drag left-to-right to select objects fully inside the box, ' +
      'right-to-left to select anything the box touches. Hold Shift to add, Ctrl to toggle.</p>' +
      (view !== 'library'
        ? '<p>Then act on the selection: drag it or press <b>M</b> to move, <b>R</b> to rotate, ' +
          `<b>F</b> to ${view === 'board' ? 'flip to the other side' : 'mirror'}, <b>Del</b> to delete.</p>`
        : '<p>Libraries are view-only so far.</p>');
    inspector.append(hint);
    return;
  }

  if (owners.length === 1) {
    const o = owners[0]!;
    inspector.append(el('p', 'sel-title', o.label), el('p', 'sel-kind', KIND_LABEL[o.kind]));
  } else {
    const counts = new Map<string, number>();
    for (const o of owners) counts.set(KIND_LABEL[o.kind], (counts.get(KIND_LABEL[o.kind]) ?? 0) + 1);
    inspector.append(
      el('p', 'sel-title', `${owners.length} objects`),
      el('p', 'sel-kind', [...counts].map(([k, n]) => `${n} × ${k}`).join(', ')),
    );
  }

  inspector.append(...commandButtons());

  if (owners.length === 1) {
    const fields = propertyFields(owners[0]!);
    if (fields) inspector.append(fields.table);
    const table = document.createElement('table');
    table.className = 'props';
    for (const [k, v] of owners[0]!.props) {
      if (fields?.covers.has(k)) continue;
      const tr = document.createElement('tr');
      tr.append(el('th', '', k), el('td', '', v));
      table.append(tr);
    }
    inspector.append(table);
  }

  const actions = document.createElement('div');
  actions.className = 'sel-actions';
  actions.append(button('Zoom to selection', zoomToSelection), button('Clear', () => selection.clear()));
  inspector.append(actions);

  if (owners.length > 1) {
    const list = document.createElement('ul');
    list.className = 'sel-list';
    for (const o of owners.slice(0, 200).sort((a, b) => a.label.localeCompare(b.label))) {
      const li = document.createElement('li');
      li.append(button(o.label, () => selection.select([o.id], 'replace')));
      list.append(li);
    }
    inspector.append(list);
  }
}

/** The verbs available for the current selection. */
function commandButtons(): HTMLElement[] {
  if (!editable() || !editor) return [];
  const ts = selectedTargets();
  if (!ts.length) return [];
  const editableTs = editor.editable(ts);
  const out: HTMLElement[] = [];
  if (editableTs.length < ts.length) {
    out.push(el('p', 'locked-note', editableTs.length ? 'Locked parts will stay in place.' : 'Locked on the board.'));
  }
  const grid = document.createElement('div');
  grid.className = 'commands';
  const cmd = (label: string, key: string, run: () => void) => {
    const b = button('', run);
    b.disabled = !editableTs.length;
    b.append(document.createTextNode(label));
    const k = document.createElement('kbd');
    k.textContent = key;
    b.append(k);
    b.title = `${label} (${key})`;
    return b;
  };
  grid.append(
    cmd('Move', 'M', () => beginMove(pivot(), false)),
    cmd('Rotate', 'R', () => rotateCmd(1)),
    cmd(view === 'board' ? 'Flip side' : 'Mirror', 'F', mirrorCmd),
    cmd('Delete', 'Del', deleteCmd),
  );
  // Smash/unsmash applies to parts: detach (or reattach) their name/value texts.
  const parts = editableTs.flatMap((t) => (t.kind === 'gate' ? [t.gate] : t.kind === 'footprint' ? [t.footprint] : []));
  if (parts.length) {
    const allSmashed = parts.every((p) => p.smashed || (p.labels?.length ?? 0) > 0);
    const b = button(allSmashed ? 'Unsmash' : 'Smash', () => smashCmd(!allSmashed));
    b.title = allSmashed
      ? 'Reattach the name and value texts to the part'
      : 'Detach the name and value texts so they can be moved on their own';
    grid.append(b);
  }
  out.push(grid);
  return out;
}

function smashCmd(on: boolean): void {
  if (!editor) return;
  const n = editor.setSmashed(selectedTargets(), on);
  flash(n ? `${on ? 'Smashed' : 'Unsmashed'} ${n} part(s)` : `Nothing to ${on ? 'smash' : 'unsmash'}`);
}

/**
 * Editable properties of a selected object: part name and value, or net name.
 * Enter applies (one undo step, in both schematic and board); Esc cancels.
 * Returns the rows and the names of read-only props they replace.
 */
function propertyFields(o: Owner): { table: HTMLTableElement; covers: Set<string> } | undefined {
  if (!editable() || !editor) return undefined;
  if (o.target?.kind === 'pour') return pourFields(o.target.pour, o.target.net.name);
  const ed = editor;
  const rows: [label: string, field: string, value: string, commit: (v: string) => string | undefined][] = [];
  const covers = new Set<string>();
  const part = o.target?.kind === 'gate' ? o.target.gate.part : o.target?.kind === 'footprint' ? o.target.footprint.part : undefined;
  if (part !== undefined) {
    const value = o.props.find(([k]) => k === 'Value')?.[1] ?? '';
    rows.push(['Name', 'name', part, (v) => ed.renamePart(part, v)]);
    rows.push(['Value', 'value', value, (v) => ed.setValue(part, v)]);
    for (const k of ['Name', 'Part', 'Value']) covers.add(k);
  } else if (o.net !== undefined && o.kind !== 'bus-wire' && o.kind !== 'airwire') {
    const net = o.net;
    rows.push(['Net', 'net', net, (v) => ed.renameNet(net, v)]);
    for (const k of ['Net', 'Signal']) covers.add(k);
  }
  if (!rows.length) return undefined;

  const table = document.createElement('table');
  table.className = 'props fields';
  for (const [label, field, value, commit] of rows) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.dataset.field = field;
    input.spellcheck = false;
    input.setAttribute('aria-label', label);
    const done = () => canvas.focus({ preventScroll: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (input.value === value) return done();
        const err = commit(input.value);
        if (err) {
          input.classList.add('invalid');
          flash(err);
        } else {
          flash(`${label} changed`);
          done();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = value;
        input.classList.remove('invalid');
        done();
      }
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.append(input);
    tr.append(el('th', '', label), td);
    table.append(tr);
  }
  return { table, covers };
}

/**
 * A pour's settings, editable: net (moves the pour), layer, outline width, isolation, rank,
 * thermals, orphans and fill. Each change is one undo step.
 */
function pourFields(pour: O.PolygonShape, netName: string): { table: HTMLTableElement; covers: Set<string> } {
  const ed = editor!;
  const table = document.createElement('table');
  table.className = 'props fields';
  const covers = new Set(['Net', 'Layer', 'Points', 'Isolate', 'Width', 'Rank']);
  const row = (label: string, control: HTMLElement) => {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.append(control);
    tr.append(el('th', '', label), td);
    table.append(tr);
  };
  const done = (err: string | undefined, what: string, input?: HTMLElement) => {
    if (err) {
      input?.classList.add('invalid');
      flash(err);
    } else {
      flash(`${what} changed`);
      canvas.focus({ preventScroll: true });
    }
  };
  const text = (label: string, field: string, value: string, commit: (v: string) => string | undefined) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.dataset.field = field;
    input.spellcheck = false;
    input.setAttribute('aria-label', label);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (input.value === value) return canvas.focus({ preventScroll: true });
        done(commit(input.value), label, input);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = value;
        input.classList.remove('invalid');
        canvas.focus({ preventScroll: true });
      }
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    row(label, input);
  };
  const mm = (v: string): number | undefined => {
    const t = v.trim();
    if (!t) return undefined;
    const n = Number(t.replace(/mm$/, ''));
    return Number.isFinite(n) ? n : NaN;
  };
  text('Net', 'net', netName, (v) => ed.setPourNet(pour, v));
  const layerSel = document.createElement('select');
  for (const l of project!.board?.layers.length ? project!.board.layers : ['copper.top', 'copper.bottom']) layerSel.append(new Option(l.replace('copper.', ''), l));
  layerSel.value = pour.layer;
  layerSel.addEventListener('change', () => done(ed.setPour(pour, { layer: layerSel.value }, 'Pour layer'), 'Layer'));
  row('Layer', layerSel);
  text('Width (mm)', 'width', String(pour.width), (v) => ed.setPour(pour, { width: mm(v) ?? NaN }, 'Pour width'));
  text('Isolate (mm)', 'isolate', pour.isolate === undefined ? '' : String(pour.isolate), (v) => ed.setPour(pour, { isolate: mm(v) }, 'Pour isolation'));
  text('Rank', 'rank', String(pour.rank ?? 1), (v) => ed.setPour(pour, { rank: v.trim() ? Number(v) : 1 }, 'Pour rank'));
  const fill = document.createElement('select');
  fill.append(new Option('solid', 'solid'), new Option('hatched (drawn solid)', 'hatch'));
  fill.value = pour.pour === 'hatch' ? 'hatch' : 'solid';
  fill.addEventListener('change', () => done(ed.setPour(pour, { hatch: fill.value === 'hatch' }, 'Pour fill'), 'Fill'));
  row('Fill', fill);
  const check = (label: string, on: boolean, patch: (v: boolean) => object) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.addEventListener('change', () => done(ed.setPour(pour, patch(cb.checked), `Pour ${label.toLowerCase()}`), label));
    row(label, cb);
  };
  check('Thermals', pour.thermals !== false, (v) => ({ thermals: v }));
  check('Keep orphans', !!pour.orphans, (v) => ({ orphans: v }));
  return { table, covers };
}

/** Jump to a property field of the selection (N: name/net, V: value). */
function focusField(fields: string[]): void {
  for (const f of fields) {
    const input = inspector.querySelector<HTMLInputElement>(`input[data-field="${f}"]`);
    if (input) {
      input.focus();
      input.select();
      return;
    }
  }
  flash(selection.size === 1 ? 'This object has no such property' : 'Select a single object first');
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** Show a message above the canvas until closed: an error (red) or a notice (amber). */
function showError(msg: string, kind: 'error' | 'notice' = 'error'): void {
  $<HTMLSpanElement>('error-text').textContent = msg;
  errorBox.classList.toggle('notice', kind === 'notice');
  errorBox.hidden = false;
}

$<HTMLButtonElement>('error-close').addEventListener('click', () => hideError());

function hideError(): void {
  errorBox.hidden = true;
}

let flashTimer: number | undefined;
function flash(msg: string): void {
  statusMsg.textContent = msg;
  window.clearTimeout(flashTimer);
  if (msg) flashTimer = window.setTimeout(() => (statusMsg.textContent = ''), 4000);
}

// ---------------------------------------------------------------------------
// View

let renderQueued = false;
let dpr = 1;

function requestRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    draw();
  });
}

function draw(): void {
  if (!index) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  render(ctx, vp, dpr, {
    index,
    layers: layerMap,
    visible: isVisible,
    selection: selection.items,
    hover: move || placing || wiring || routing || pouring ? undefined : hover,
    ...(pourHandles().length ? { handles: pourHandles() } : {}),
    ...(wiring ? { sketch: { paths: [{ points: wiring.path, width: wiring.width, layer: 91 }], layer: 91, cursor: wiring.at, snapped: wiring.snapped } } : {}),
    ...(routing ? { sketch: routeSketch(routing) } : {}),
    ...(pouring ? { sketch: { paths: [{ points: pouring.path, width: 0, layer: layerNumber(pouring.layer) }], layer: layerNumber(pouring.layer), cursor: pouring.at, snapped: pouring.closing || !!pouring.over } } : {}),
    ...(view === 'board' && (drcResult || routing?.conflicts.length)
      ? {
        markers: [
          ...(drcResult?.violations ?? []).map((v) => ({ at: { x: v.at[0], y: v.at[1] }, active: v === drcActive })),
          ...(routing?.conflicts.slice(0, 1) ?? []).map((c) => ({ at: { x: c.at[0], y: c.at[1] }, active: true })),
        ],
      }
      : {}),
    ...(box ? { box: boxSelection(box) } : {}),
    ...(editor && view !== 'library' ? { grid: gridOf() } : {}),
  });
  statusZoom.textContent = `${vp.zoom < 10 ? vp.zoom.toFixed(2) : vp.zoom.toFixed(0)} px/mm`;
}

function resize(): void {
  const r = stage.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  vp.resize(r.width, r.height);
  requestRender();
}

function fitView(): void {
  if (index) vp.fit(index.scene.bounds);
  requestRender();
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function zoomToSelection(): void {
  if (!index || !selection.size) return;
  let b: Bounds | undefined;
  for (const id of selection.items) {
    const ob = index.ownerBounds.get(id);
    if (ob) b = b ? unionBounds(b, ob) : { ...ob };
  }
  if (!b) return;
  // Don't zoom in absurdly far on tiny objects.
  const minSpan = 10;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = Math.max(b.maxX - b.minX, minSpan) / 2;
  const hh = Math.max(b.maxY - b.minY, minSpan) / 2;
  vp.fit({ minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh }, 60);
  requestRender();
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Pointer interaction

// ---------------------------------------------------------------------------
// Adding parts

const PROJECT_SOURCE = 'project';
const sampleLibraries = import.meta.glob('../samples/eagle/*.lbr', { query: '?raw', import: 'default' });

/** The library a source key stands for (loading a sample library on first use). */
async function librarySource(key: string): Promise<O.Library | undefined> {
  if (key === PROJECT_SOURCE) return project?.library;
  if (loadedLibraries.has(key)) return loadedLibraries.get(key);
  const path = Object.keys(sampleLibraries).find((p) => p.endsWith(`/${key}`));
  if (!path) return undefined;
  const lib = importLibrary(key, parseEagle((await sampleLibraries[path]!()) as string));
  loadedLibraries.set(key, lib);
  return lib;
}

function renderPartsSources(): void {
  const current = partsSource.value || PROJECT_SOURCE;
  partsSource.replaceChildren(new Option('This project', PROJECT_SOURCE));
  const names = new Set([...loadedLibraries.keys(), ...Object.keys(sampleLibraries).map((p) => p.split('/').pop()!)]);
  for (const name of [...names].sort()) partsSource.append(new Option(name, name));
  partsSource.append(new Option('Open library…', 'open'));
  partsSource.value = [...partsSource.options].some((o) => o.value === current) ? current : PROJECT_SOURCE;
}

/** Renders start in order but loading a library is asynchronous: only the latest one draws. */
let partsRender = 0;

async function renderPartsPanel(): Promise<void> {
  if (partsSource.options.length === 0) renderPartsSources();
  const key = partsSource.value;
  const token = ++partsRender;
  const lib = await librarySource(key);
  if (token !== partsRender) return;
  partsList.replaceChildren();
  if (!lib) return;
  const q = partsFilter.value.trim().toLowerCase();
  const items = lib.components
    .filter((c) => !c.id.endsWith('#footprint') && c.gates.length)
    .filter((c) => !q || componentName(c.id).toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
    .sort((a, b) => componentName(a.id).localeCompare(componentName(b.id)));
  const h = document.createElement('h3');
  h.textContent = `Components (${items.length})`;
  partsList.append(h);
  for (const c of items.slice(0, 300)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = componentName(c.id);
    btn.title = (c.description ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || c.id;
    if (chosen?.source === key && chosen.id === c.id) btn.className = 'active';
    btn.addEventListener('click', () => {
      chosen = { source: key, id: c.id };
      void renderPartsPanel();
    });
    btn.addEventListener('dblclick', () => void startPlacing());
    partsList.append(btn);
  }
  renderPartChoice(lib);
}

/** Variant and technology choices for the chosen component, and the Place button. */
function renderPartChoice(lib: O.Library): void {
  partsChoice.replaceChildren();
  const c = chosen && chosen.source === partsSource.value ? lib.components.find((x) => x.id === chosen!.id) : undefined;
  partsChoice.hidden = !c;
  if (!c) return;
  partsChoice.append(el('div', 'choice-title', componentName(c.id)));
  const desc = (c.description ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc) partsChoice.append(el('div', 'choice-desc', desc));
  const variant = document.createElement('select');
  variant.id = 'parts-variant';
  for (const v of c.variants) {
    variant.append(new Option(`${v.name || "''"} — ${v.footprint ? componentName(v.footprint) : 'no footprint'}`, v.name));
  }
  const tech = document.createElement('select');
  tech.id = 'parts-technology';
  const refreshTech = () => {
    const v = c.variants.find((x) => x.name === variant.value);
    const names = Object.keys(v?.technologies ?? { '': {} });
    tech.replaceChildren(...names.map((n) => new Option(n || "''", n)));
    techRow.hidden = names.length < 2;
  };
  variant.addEventListener('change', refreshTech);
  const row = (label: string, control: HTMLElement) => {
    const l = document.createElement('label');
    l.append(document.createTextNode(label), control);
    return l;
  };
  const techRow = row('Technology', tech);
  partsChoice.append(row('Variant', variant), techRow);
  refreshTech();
  const go = button('Place', () => void startPlacing());
  go.title = 'Place this part on the schematic (click to place each gate; R rotates, F mirrors, Esc stops)';
  partsChoice.append(go);
}

async function startPlacing(): Promise<void> {
  if (!editor || !project || view !== 'schematic' || !chosen) return;
  const lib = await librarySource(chosen.source);
  if (!lib) return;
  stopPlacing();
  stopWiring();
  if (move) commitMove();
  const variant = (document.getElementById('parts-variant') as HTMLSelectElement | null)?.value ?? '';
  const tech = (document.getElementById('parts-technology') as HTMLSelectElement | null)?.value ?? '';
  placing = editor.beginPlace(lib, chosen.id, variant, tech, Number(sheetSelect.value || 0), gridOf);
  if (!placing) return;
  placing.moveTo(cursor, false);
  selection.clear();
  canvas.classList.add('placing');
  canvas.focus({ preventScroll: true });
  if (placing.libraryNotes.length) flash(`Using the project's own copy of ${placing.libraryNotes.join(', ')}`);
  else flashPlacing();
  onEdited();
}

function flashPlacing(): void {
  const p = placing?.placing;
  if (p) flash(`Placing ${p.part}${p.gate ? ` gate ${p.gate}` : ''}: click to place · R rotates · F mirrors · Esc stops`);
}

function placeClick(): void {
  if (!placing) return;
  const done = placing.click();
  if (done) flash(`Added ${done}; placing the next one (Esc stops)`);
  else flashPlacing();
  onEdited();
}

/** Stop adding parts (a part with gates already placed is kept). */
function stopPlacing(announce = false): void {
  if (!placing) return;
  placing.cancel();
  placing = undefined;
  canvas.classList.remove('placing');
  if (announce) flash('Stopped adding parts');
  if (editor) onEdited();
}

partsSource.addEventListener('change', () => {
  if (partsSource.value === 'open') {
    lbrInput.click();
    partsSource.value = PROJECT_SOURCE;
  }
  chosen = undefined;
  void renderPartsPanel();
});
partsFilter.addEventListener('input', () => void renderPartsPanel());
partsFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Enter places the only (or chosen) match.
    const first = partsList.querySelector('button');
    if (!chosen && first) first.click();
    void startPlacing();
  } else if (e.key === 'Escape') {
    canvas.focus({ preventScroll: true });
  }
});
lbrInput.addEventListener('change', async () => {
  for (const f of [...(lbrInput.files ?? [])]) {
    try {
      loadedLibraries.set(f.name, importLibrary(f.name, parseEagle(await f.text())));
    } catch (e) {
      showError(`Could not open ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const last = lbrInput.files?.[lbrInput.files.length - 1]?.name;
  lbrInput.value = '';
  renderPartsSources();
  if (last) partsSource.value = last;
  void renderPartsPanel();
});

// ---------------------------------------------------------------------------
// Drawing wires

// ---------------------------------------------------------------------------
// The active copper layer (Route and Pour)

function boardCopper(): string[] {
  const stack = project?.board?.layers ?? [];
  return stack.length ? stack : ['copper.top', 'copper.bottom'];
}

function renderLayerSelect(): void {
  const stack = boardCopper();
  if ([...layerSelect.options].map((o) => o.value).join() !== stack.join()) {
    layerSelect.replaceChildren(...stack.map((l) => new Option(l.replace('copper.', ''), l)));
  }
  if (!activeLayer || !stack.includes(activeLayer)) activeLayer = stack[0];
  layerSelect.value = activeLayer!;
}

/** The other outer layer (what L switches to). */
function nextLayer(l: string | undefined): string {
  const stack = boardCopper();
  return l === stack[0] ? stack[stack.length - 1]! : stack[0]!;
}

/** Make `l` the active layer (and the layer of the route or pour being drawn). */
function setActiveLayer(l: string): void {
  if (routing) {
    const res = routing.switchLayer(false, l);
    if (res.blocked) flash(`No room for a via: ${res.blocked[0]!.message.replace(/^Would touch/, 'it would touch')} · Shift+L adds it anyway`);
    else flash(`Routing on ${res.layer.replace('copper.', '')}${routing.netName ? ' (via added)' : ''}`);
  } else if (pouring) {
    flash(`Pour on ${pouring.switchLayer(l).replace('copper.', '')}`);
  } else {
    activeLayer = l;
    flash(`Layer: ${l.replace('copper.', '')} (Route and Pour start here)`);
  }
  syncLayer();
  requestRender();
}

/** Take the layer the route or pour is on now as the active layer, and show it. */
function syncLayer(): void {
  if (routing) activeLayer = routing.currentLayer;
  else if (pouring) activeLayer = pouring.layer;
  if (activeLayer) layerSelect.value = activeLayer;
}

layerSelect.addEventListener('change', () => {
  setActiveLayer(layerSelect.value);
  canvas.focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Drawing pours

function startPouring(): void {
  if (!editor || !project?.board || view !== 'board') return;
  stopRouting();
  if (move) commitMove();
  pouring = editor.beginPour(gridOf, lastPour.net, activeLayer);
  if (!pouring) return;
  pouring.moveTo(cursor, false, WIRE_SNAP_PX / vp.zoom);
  selection.clear();
  canvas.classList.add('wiring');
  pourBtn.classList.add('active');
  canvas.focus({ preventScroll: true });
  const on = pouring.net ? `on ${pouring.net}` : 'on a new net';
  flash(`Pour ${on}, ${pouring.layer.replace('copper.', '')}: click the corners (the first click on copper picks its net) · click the first corner or Enter closes · L layer · / angles · Esc stops`);
  onEdited();
}

function stopPouring(announce = false): void {
  if (!pouring) return;
  pouring.cancel();
  pouring = undefined;
  canvas.classList.remove('wiring');
  pourBtn.classList.remove('active');
  if (announce) flash('Stopped drawing pours');
  requestRender();
}

function pourClick(double: boolean): void {
  if (!pouring) return;
  queueMicrotask(syncLayer);
  const r = pouring.click();
  if (r === 'started') flash(`Pour on ${pouring.net ?? 'a new net'} (${pouring.layer.replace('copper.', '')}): click the corners; click the first corner, double-click or Enter closes`);
  if (r === 'close' || double) finishPour();
  requestRender();
}

/** Close the pour being drawn: add it, select it (its settings show in the inspector) and stop. */
function finishPour(): void {
  if (!pouring) return;
  const res = pouring.finish();
  if (!res) {
    flash('A pour needs at least three corners');
    requestRender();
    return;
  }
  lastPour = { net: res.net };
  stopPouring();
  reselect([res.pour]);
  flash(`Added a pour on ${res.net} (${res.pour.layer.replace('copper.', '')}); its settings are in the inspector`);
}

// ---------------------------------------------------------------------------
// Routing traces

function startRouting(): void {
  if (!editor || !project?.board || view !== 'board') return;
  stopPouring();
  queueMicrotask(syncLayer);
  if (move) commitMove();
  routing = editor.beginRoute(gridOf, activeLayer);
  if (!routing) return;
  routing.moveTo(cursor, false, WIRE_SNAP_PX / vp.zoom);
  selection.clear();
  canvas.classList.add('wiring');
  wireBtn.classList.add('active');
  canvas.focus({ preventScroll: true });
  flash(`Route on ${routing.currentLayer.replace('copper.', '')}: click a pad, via or trace end to start · L changes layer · / flips the bend · Esc finishes`);
  onEdited();
}

/** Stop routing (a route in progress is dropped). */
function stopRouting(announce = false): void {
  if (!routing) return;
  routing.cancel();
  routing = undefined;
  canvas.classList.remove('wiring');
  wireBtn.classList.remove('active');
  if (announce) flash('Stopped routing');
  requestRender();
}

/** The latest cursor position for the route, not yet applied (see applyRouteMove). */
let routeMove: { p: Point; alt: boolean } | undefined;

function applyRouteMove(): void {
  if (!routing || !routeMove) {
    routeMove = undefined;
    return;
  }
  const { p, alt } = routeMove;
  routeMove = undefined;
  const before = routing.conflicts[0]?.message;
  const viasBefore = routing.detourVias;
  routing.moveTo(p, alt, WIRE_SNAP_PX / vp.zoom);
  // Say what the leg runs into as soon as it does (and clear it when it no longer does), and
  // when it goes through vias to get round.
  const now = routing.conflicts[0]?.message;
  const vias = routing.detourVias;
  if (now !== before) flash(now ? `${now} · Shift+click places it anyway` : '');
  else if (vias !== viasBefore) flash(vias ? `Going round through ${vias} via${vias > 1 ? 's' : ''} (other layer)` : '');
  requestRender();
}

function routeClick(double: boolean, force: boolean): void {
  if (!routing) return;
  applyRouteMove();
  queueMicrotask(syncLayer);
  const forcing = force && routing.conflicts[0]?.message;
  const r = routing.click(force);
  if (forcing && (r === 'added' || r === 'finish')) flash(`Placed anyway (${forcing.replace(/^Would touch/, 'touches').replace(/^Too close to/, 'too close to')}); the DRC will list it`);
  if (r === 'blocked') flash(`${routing.conflicts[0]!.message} · Shift+click places it anyway`);
  else if (r === 'nothing') flash('Start a route on a pad, via or trace end of a net');
  else if (r === 'started') flash(`Routing ${routing.netName} on ${routing.currentLayer.replace('copper.', '')} · L changes layer · ends on copper of ${routing.netName}`);
  else if (r === 'finish' || (double && routing.netName)) finishRoute();
  requestRender();
}

function finishRoute(): void {
  if (!routing) return;
  const res = routing.finish();
  if (res) {
    const left = index ? airwiresLeft(res.net) : 0;
    flash(`Routed ${res.net}: ${res.traces} trace${res.traces === 1 ? '' : 's'}${res.vias ? `, ${res.vias} via${res.vias > 1 ? 's' : ''}` : ''}${left ? ` · ${left} airwire${left > 1 ? 's' : ''} left` : ' · fully routed'}`);
  }
  requestRender();
}

/** Airwires still shown for a net. */
function airwiresLeft(net: string): number {
  let n = 0;
  for (const o of index!.scene.owners.values()) if (o.kind === 'airwire' && o.net === net) n++;
  return n;
}

function routeSketch(r: RouteSession) {
  const { paths, vias } = r.preview;
  const radius = (r.drill + 0.5) / 2;
  return {
    paths: paths.map((p) => ({ points: p.points, width: r.width, layer: layerNumber(p.layer), ...(p.blocked ? { color: '#ff4d4d' } : {}) })),
    vias: vias.map((at) => ({ at, radius })),
    layer: layerNumber(r.currentLayer),
    cursor: r.at,
    snapped: !!r.snappedTo,
  };
}

// ---------------------------------------------------------------------------
// Design rules and DRC

const sampleRules = import.meta.glob('../samples/eagle/*.dru', { query: '?raw', import: 'default' });
const DRC_KIND: Record<Violation['kind'], string> = { overlap: 'Short', clearance: 'Clearance', width: 'Width', drill: 'Drill', dimension: 'Edge' };

function renderDrcPanel(): void {
  if (!project) return;
  const rules = designRules(project);
  drcName.textContent = rules.get('@name') ?? (rules.size ? 'unnamed' : "Eagle's defaults");
  if (drcLoad.options.length === 0) {
    drcLoad.append(new Option('Load rules…', ''));
    for (const path of Object.keys(sampleRules).sort()) drcLoad.append(new Option(path.split('/').pop()!, path));
    drcLoad.append(new Option('From a .dru file…', 'open'));
  }
  drcList.replaceChildren();
  if (!drcResult) {
    drcSummary.className = 'drc-summary';
    drcSummary.textContent = 'Not checked yet.';
    return;
  }
  const n = drcResult.violations.length;
  drcSummary.className = `drc-summary ${n ? 'bad' : 'ok'}`;
  drcSummary.textContent = n ? `${n} problem${n > 1 ? 's' : ''}` : `✓ No problems (${drcResult.checked} copper items checked)`;
  for (const v of drcResult.violations.slice(0, 500)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.append(el('span', 'drc-kind', DRC_KIND[v.kind]), document.createTextNode(v.message.replace(/^Short: /, '')));
    b.title = v.message;
    if (v === drcActive) b.className = 'active';
    b.addEventListener('click', () => showViolation(v));
    drcList.append(b);
  }
}

function runDrc(): void {
  if (!project?.board) return;
  if (move) commitMove();
  drcResult = drc(project);
  drcActive = undefined;
  renderDrcPanel();
  const n = drcResult.violations.length;
  flash(n ? `DRC: ${n} problem${n > 1 ? 's' : ''} (marked on the board)` : 'DRC: no problems');
  requestRender();
}

/** Zoom to a violation and select what is involved. */
function showViolation(v: Violation): void {
  drcActive = v;
  const r = 2.5;
  vp.fit({ minX: v.at[0] - r, minY: v.at[1] - r, maxX: v.at[0] + r, maxY: v.at[1] + r });
  reselect(v.objects);
  renderDrcPanel();
  flash(v.message);
  canvas.focus({ preventScroll: true });
  requestRender();
}

async function loadRules(name: string, text: string): Promise<void> {
  if (!editor) return;
  try {
    const err = editor.loadRules(name.replace(/\.dru$/i, ''), parseDru(text));
    if (err) return showError(err);
  } catch (e) {
    return showError(`Could not read ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  runDrc();
  flash(`Loaded design rules ${name} · ${drcResult?.violations.length ? `${drcResult.violations.length} problem(s)` : 'no problems'}`);
}

$('drc-run').addEventListener('click', runDrc);
drcLoad.addEventListener('change', async () => {
  const v = drcLoad.value;
  drcLoad.value = '';
  if (v === 'open') druInput.click();
  else if (v && sampleRules[v]) await loadRules(v.split('/').pop()!, (await sampleRules[v]!()) as string);
});
druInput.addEventListener('change', async () => {
  const file = druInput.files?.[0];
  druInput.value = '';
  if (file) await loadRules(file.name, await file.text());
});

// ---------------------------------------------------------------------------
// Pour corner handles

/** The pour, when one pour alone is selected on the board (and nothing else is going on). */
function selectedPour(): O.PolygonShape | undefined {
  if (view !== 'board' || !editor || move || routing || pouring || selection.size !== 1) return undefined;
  const t = selectedOwners()[0]?.target;
  return t?.kind === 'pour' ? t.pour : undefined;
}

/** Handles of the selected pour: its corners, and the middle of each edge. */
function pourHandles(): NonNullable<Parameters<typeof render>[3]['handles']> {
  const pour = cornerDrag?.pour ?? selectedPour();
  if (!pour) return [];
  const pts = pour.polygon;
  const active = activeCorner?.pour === pour ? activeCorner.index : -1;
  return [
    ...pts.map((q, i) => ({ at: { x: q[0], y: q[1] }, kind: 'corner' as const, active: i === active })),
    ...pts.map((_, i) => {
      const [x, y] = edgeMiddle(pts, i);
      return { at: { x, y }, kind: 'middle' as const, active: false };
    }),
  ];
}

/** The handle under a screen point (corners first), if any. */
function handleAt(p: Point): { pour: O.PolygonShape; index: number; kind: 'corner' | 'middle' } | undefined {
  const pour = selectedPour();
  if (!pour) return undefined;
  const near = (x: number, y: number) => {
    const s = vp.toScreen(x, y);
    return Math.hypot(s.x - p.x, s.y - p.y) <= 7;
  };
  const corner = pour.polygon.findIndex((q) => near(q[0], q[1]));
  if (corner >= 0) return { pour, index: corner, kind: 'corner' };
  const middle = pour.polygon.findIndex((_, i) => {
    const [x, y] = edgeMiddle(pour.polygon, i);
    return near(x, y);
  });
  return middle >= 0 ? { pour, index: middle, kind: 'middle' } : undefined;
}

/** Wire ends snap to pins and wire ends within this many pixels. */
const WIRE_SNAP_PX = 8;

function startWiring(): void {
  if (!editor || !project || view !== 'schematic') return;
  stopPlacing();
  stopRouting();
  if (move) commitMove();
  wiring = editor.beginWire(Number(sheetSelect.value || 0), gridOf);
  if (!wiring) return;
  wiring.moveTo(cursor, false, WIRE_SNAP_PX / vp.zoom);
  selection.clear();
  canvas.classList.add('wiring');
  wireBtn.classList.add('active');
  canvas.focus({ preventScroll: true });
  flash('Wire: click to start · click adds a corner · ends on a pin or wire · double click or Esc finishes · / flips the bend');
  onEdited();
}

/** Stop drawing wires (a wire in progress is dropped). */
function stopWiring(announce = false): void {
  if (!wiring) return;
  wiring.cancel();
  wiring = undefined;
  canvas.classList.remove('wiring');
  wireBtn.classList.remove('active');
  if (announce) flash('Stopped drawing wires');
  requestRender();
}

async function wireClick(double: boolean): Promise<void> {
  if (!wiring) return;
  const r = wiring.click();
  if (r === 'finish' || (double && wiring.path.length > 1)) await finishWire();
  requestRender();
}

/** Add the wire drawn so far; asks which name to keep when equally named nets meet. */
async function finishWire(name?: string): Promise<void> {
  if (!wiring) return;
  const res = wiring.finish(name);
  if (!res) {
    requestRender();
    return;
  }
  if ('choose' in res) {
    const pick = await chooseNetName(res.choose);
    if (pick) await finishWire(pick);
    else flash('Wire not added: choose a name to join the nets, or keep drawing');
    return;
  }
  flash(res.joined.length ? `Joined ${res.joined.join(', ')} into ${res.net}` : `Wire on ${res.net}`);
}

/** Ask which net name survives a join (undefined if cancelled). */
function chooseNetName(names: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'choose-net';
    dlg.append(el('p', '', 'This wire joins nets that each have a name. Which name should the joined net keep?'));
    const row = el('div', 'choose-net-buttons', '');
    for (const n of names) {
      row.append(button(n, () => {
        resolve(n);
        dlg.close();
      }));
    }
    const cancel = button('Cancel', () => dlg.close());
    cancel.className = 'secondary';
    row.append(cancel);
    dlg.append(row);
    dlg.addEventListener('close', () => {
      resolve(undefined);
      dlg.remove();
      canvas.focus({ preventScroll: true });
    });
    document.body.append(dlg);
    dlg.showModal();
    (row.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}

const DRAG_THRESHOLD = 4;
const PICK_TOLERANCE_PX = 4;

let pointer:
  | { id: number; x: number; y: number; mode: 'pending' | 'box' | 'pan'; mods: SelectMode; onSelected: boolean }
  | undefined;
let spaceDown = false;

function localPoint(e: PointerEvent | WheelEvent | MouseEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function modeFor(e: PointerEvent | MouseEvent): SelectMode {
  return e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
}

function boxSelection(b: NonNullable<typeof box>): { rect: Bounds; crossing: boolean } {
  const a = vp.toWorld(b.start.x, b.start.y);
  const c = vp.toWorld(b.end.x, b.end.y);
  return {
    rect: { minX: Math.min(a.x, c.x), minY: Math.min(a.y, c.y), maxX: Math.max(a.x, c.x), maxY: Math.max(a.y, c.y) },
    // CAD convention: dragging right-to-left selects anything the box crosses.
    crossing: b.end.x < b.start.x,
  };
}

const pickAt = (p: Point) => (index ? pick(index, vp.toWorld(p.x, p.y), PICK_TOLERANCE_PX / vp.zoom, isVisible) : undefined);

canvas.addEventListener('pointerdown', (e) => {
  const p = localPoint(e);
  canvas.setPointerCapture(e.pointerId);
  // preventDefault stops the browser from moving focus, so take it explicitly:
  // otherwise keyboard shortcuts would keep going to the last-used dropdown or checkbox.
  e.preventDefault();
  canvas.focus({ preventScroll: true });

  // Adding parts: left click places the gate, right click stops.
  if (placing && e.button !== 1 && !spaceDown) {
    if (e.button === 0) placeClick();
    else if (e.button === 2) stopPlacing(true);
    return;
  }

  // Drawing wires: left click adds a leg (double click finishes), right click finishes or stops.
  if (wiring && e.button !== 1 && !spaceDown) {
    if (e.button === 0) void wireClick(e.detail >= 2);
    else if (e.button === 2) {
      if (wiring.drawing) void finishWire();
      else stopWiring(true);
    }
    return;
  }

  // Drawing a pour: left click adds a corner (double click closes), right click closes or stops.
  if (pouring && e.button !== 1 && !spaceDown) {
    if (e.button === 0) pourClick(e.detail >= 2);
    else if (e.button === 2) {
      if (pouring.drawing) finishPour();
      else stopPouring(true);
    }
    return;
  }

  // Routing: left click adds a leg (double click finishes), right click finishes or stops.
  if (routing && e.button !== 1 && !spaceDown) {
    if (e.button === 0) routeClick(e.detail >= 2, e.shiftKey);
    else if (e.button === 2) {
      if (routing.netName) finishRoute();
      else stopRouting(true);
    }
    return;
  }

  // A keyboard-started move ends with a click: left places, right cancels.
  if (move && !move.drag) {
    if (e.button === 0) commitMove();
    else if (e.button === 2) cancelMove();
    return;
  }

  // A selected pour's handles: drag a corner, or an edge's middle to add a corner.
  if (e.button === 0 && !spaceDown && !move) {
    const h = handleAt(p);
    if (h && editor && project) {
      cornerDrag = editor.dragCorner(h.pour, h.index, h.kind === 'middle', gridOf);
      if (h.kind === 'corner') activeCorner = { pour: h.pour, index: h.index };
      freezePours(project, true);
      requestRender();
      return;
    }
  }

  const pan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown);
  if (pan) {
    pointer = { id: e.pointerId, x: p.x, y: p.y, mode: 'pan', mods: 'replace', onSelected: false };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;

  // Pressing on an object selects it (without modifiers) so it can be dragged straight away.
  const mods = modeFor(e);
  const hit = pickAt(p);
  if (hit && mods === 'replace' && !selection.has(hit)) selection.select([hit], 'replace');
  pointer = { id: e.pointerId, x: p.x, y: p.y, mode: 'pending', mods, onSelected: !!hit && selection.has(hit) };
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPoint(e);
  const w = vp.toWorld(p.x, p.y);
  cursor = w;
  statusPos.textContent = `x ${w.x.toFixed(3)}  y ${w.y.toFixed(3)} mm   (${(w.x / 0.0254).toFixed(0)}, ${(w.y / 0.0254).toFixed(0)} mil)`;

  if (move) {
    updateMove(w, e.altKey);
    return;
  }
  if (cornerDrag) {
    cornerDrag.moveTo(w, e.altKey);
    onEdited();
    return;
  }
  if (pouring && !(pointer?.mode === 'pan')) {
    pouring.moveTo(w, e.altKey, WIRE_SNAP_PX / vp.zoom);
    requestRender();
    return;
  }
  if (routing && !(pointer?.mode === 'pan')) {
    // Searching for a detour can take a while: at most one update per frame, for the latest point.
    const scheduled = !!routeMove;
    routeMove = { p: w, alt: e.altKey };
    if (!scheduled) requestAnimationFrame(applyRouteMove);
    return;
  }
  if (wiring && !(pointer?.mode === 'pan')) {
    wiring.moveTo(w, e.altKey, WIRE_SNAP_PX / vp.zoom);
    requestRender();
    return;
  }
  if (placing && !(pointer?.mode === 'pan')) {
    placing.moveTo(w, e.altKey);
    onEdited();
    return;
  }

  if (pointer && pointer.id === e.pointerId) {
    if (pointer.mode === 'pan') {
      vp.panBy(p.x - pointer.x, p.y - pointer.y);
      pointer.x = p.x;
      pointer.y = p.y;
      requestRender();
      return;
    }
    if (pointer.mode === 'pending' && Math.hypot(p.x - pointer.x, p.y - pointer.y) > DRAG_THRESHOLD) {
      if (pointer.onSelected && pointer.mods === 'replace' && editable()) {
        // Drag on a selected object: move the selection.
        const start = vp.toWorld(pointer.x, pointer.y);
        pointer = undefined;
        beginMove(start, true);
        updateMove(w, e.altKey);
        return;
      }
      pointer.mode = 'box';
      box = { start: { x: pointer.x, y: pointer.y }, end: p };
    }
    if (pointer.mode === 'box' && box) {
      box.end = p;
      requestRender();
      return;
    }
  }

  if (!index) return;
  const h = pickAt(p);
  if (h !== hover) {
    hover = h;
    canvas.title = h ? (index.scene.owners.get(h)?.label ?? '') : '';
    canvas.classList.toggle('can-drag', !!h && selection.has(h) && editable());
    requestRender();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (move?.drag) {
    commitMove();
    return;
  }
  if (cornerDrag) {
    const d = cornerDrag;
    cornerDrag = undefined;
    if (project) freezePours(project, false);
    if (d.commit()) {
      activeCorner = { pour: d.pour, index: d.corner };
      flash(d.adding ? 'Corner added (Del removes it)' : 'Corner moved');
    } else if (!d.adding) {
      flash('Corner selected: drag to move it, Del removes it');
    }
    onEdited();
    return;
  }
  if (!pointer || pointer.id !== e.pointerId) return;
  const p = localPoint(e);
  const mode = pointer.mods;
  if (pointer.mode === 'pending' && index) {
    const hit = pickAt(p);
    if (hit) selection.select([hit], mode);
    else if (mode === 'replace') selection.clear();
  } else if (pointer.mode === 'box' && box && index) {
    const { rect, crossing } = boxSelection(box);
    selection.select(pickBox(index, rect, crossing, isVisible), mode === 'replace' ? 'replace' : 'add');
  }
  pointer = undefined;
  box = undefined;
  canvas.classList.remove('panning');
  requestRender();
});

canvas.addEventListener('pointercancel', () => {
  if (move?.drag) cancelMove();
  pointer = undefined;
  box = undefined;
  canvas.classList.remove('panning');
  requestRender();
});

canvas.addEventListener('pointerleave', () => {
  if (hover) {
    hover = undefined;
    requestRender();
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = localPoint(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    vp.zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
    requestRender();
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Keyboard

/** Is the user typing into a text field (where keys must not trigger commands)? */
function isTextEntry(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLElement && t.isContentEditable) return true;
  return t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'file'].includes(t.type);
}

window.addEventListener('keydown', (e) => {
  if (isTextEntry(e.target)) return;
  // A modal dialog (e.g. choosing a net name) handles its own keys.
  if (document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // A focused dropdown keeps plain keys for type-ahead; shortcuts with Ctrl still apply.
  if (e.target instanceof HTMLSelectElement && !ctrl) return;

  if (ctrl && key === 's') {
    e.preventDefault();
    void save();
  } else if (ctrl && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoCmd();
  } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redoCmd();
  } else if (ctrl && key === 'a' && index) {
    e.preventDefault();
    const all = [...index.ownerPrims.entries()]
      .filter(([, ids]) => ids.some((i) => isVisible(index!.scene.prims[i]!.layer)))
      .map(([id]) => id);
    selection.select(all, 'replace');
  } else if (ctrl) {
    return;
  } else if (e.key === ' ') {
    spaceDown = true;
    e.preventDefault();
  } else if (e.key === 'Escape' && pouring) {
    if (pouring.drawing) {
      pouring.cancel();
      flash('Pour cancelled (click to start again, Esc stops)');
      requestRender();
    } else stopPouring(true);
  } else if (e.key === 'Enter' && pouring) {
    e.preventDefault();
    finishPour();
  } else if (key === 'l' && pouring) {
    flash(`Pour on ${pouring.switchLayer().replace('copper.', '')}`);
    syncLayer();
    requestRender();
  } else if (e.key === '/' && pouring) {
    e.preventDefault();
    pouring.freeAngle = !pouring.freeAngle;
    flash(pouring.freeAngle ? 'Edges at any angle (/ for 45°)' : 'Edges at 45° (/ for any angle)');
    requestRender();
  } else if (e.key === 'Escape') {
    if (routing?.netName) finishRoute();
    else if (routing) stopRouting(true);
    else if (wiring?.drawing) void finishWire();
    else if (wiring) stopWiring(true);
    else if (placing) stopPlacing(true);
    else if (move) cancelMove();
    else selection.clear();
  } else if (e.key === 'Tab' && views().length > 1) {
    e.preventDefault();
    const vs = views();
    switchView(vs[(vs.indexOf(view) + 1) % vs.length]!);
  } else if (e.key === 'Home') {
    fitView();
  } else if (key === 'n') {
    e.preventDefault();
    focusField(['name', 'net']);
  } else if (key === 'v') {
    e.preventDefault();
    focusField(['value']);
  } else if (key === 'a' && project && view === 'schematic') {
    e.preventDefault();
    partsFilter.focus();
    partsFilter.select();
  } else if (key === 'w' && project && view === 'schematic') {
    if (wiring) stopWiring(true);
    else startWiring();
  } else if (key === 'w' && project && view === 'board') {
    if (routing) stopRouting(true);
    else startRouting();
  } else if (key === 'p' && view === 'board' && project?.board) {
    setShowPours(!showPours);
  } else if (key === 'l' && view === 'board' && project?.board && !routing && !pouring) {
    setActiveLayer(nextLayer(activeLayer));
  } else if (key === 'l' && routing) {
    applyRouteMove();
    const res = routing.switchLayer(e.shiftKey);
    if (res.blocked) flash(`No room for a via: ${res.blocked[0]!.message.replace(/^Would touch/, 'it would touch')} · Shift+L adds it anyway`);
    else flash(`Routing on ${res.layer.replace('copper.', '')}${routing.netName ? ' (via added)' : ''}`);
    syncLayer();
    requestRender();
  } else if (e.key === '/' && (wiring || routing)) {
    e.preventDefault();
    (wiring ?? routing)!.flipBend();
    requestRender();
  } else if (key === 'm') {
    beginMove(cursor, false);
  } else if (key === 'r') {
    rotateCmd(e.shiftKey ? -1 : 1);
  } else if (key === 'f') {
    mirrorCmd();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && activeCorner && selectedPour() === activeCorner.pour && editor) {
    e.preventDefault();
    const err = editor.removePourCorner(activeCorner.pour, activeCorner.index);
    flash(err ?? 'Corner removed');
    if (!err) activeCorner = undefined;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteCmd();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceDown = false;
});

window.addEventListener('beforeunload', (e) => {
  if (editor?.history.dirty) e.preventDefault();
});

selection.onChange(() => {
  if (activeCorner && selectedPour() !== activeCorner.pour) activeCorner = undefined;
  renderInspector();
  requestRender();
});

// Toolbar
$('open-btn').addEventListener('click', () => void openViaDialog());
fileInput.addEventListener('change', () => {
  void openDropped([...(fileInput.files ?? [])]);
  fileInput.value = '';
});
for (const b of viewToggle.querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    switchView(b.dataset.view as ViewKind);
    canvas.focus({ preventScroll: true });
  });
}
$('fit-btn').addEventListener('click', fitView);
pourBtn.addEventListener('click', () => (pouring ? stopPouring(true) : startPouring()));
wireBtn.addEventListener('click', () => {
  if (view === 'board') {
    if (routing) stopRouting(true);
    else startRouting();
  } else if (wiring) stopWiring(true);
  else startWiring();
});
undoBtn.addEventListener('click', undoCmd);
redoBtn.addEventListener('click', redoCmd);
saveBtn.addEventListener('click', () => void save());
exportBtn.addEventListener('click', () => void exportToEagle());
sheetSelect.addEventListener('change', () => {
  stopWiring();
  stopPlacing();
  rebuildScene({ fit: true, keepSelection: false });
  canvas.focus({ preventScroll: true });
});
$('layers-all').addEventListener('click', () => setAllLayers(true));
$('layers-none').addEventListener('click', () => setAllLayers(false));
libraryFilter.addEventListener('input', renderLibraryList);

// Drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  void openDropped([...(e.dataTransfer?.files ?? [])]);
});

new ResizeObserver(resize).observe(stage);

// ---------------------------------------------------------------------------

function storeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode etc.): not essential.
  }
}

resize();
initSamples();
