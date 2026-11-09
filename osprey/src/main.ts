// Osprey application shell: file loading and saving, panels, canvas interaction, commands.

import { Editor, subject, type MoveSession } from './app/editor';
import { canPickFiles, pickFile, saveFile, type FileHandle } from './app/files';
import { Selection, type SelectMode } from './app/selection';
import { parseEagle } from './eagle/parse';
import type { EagleFile, Layer } from './eagle/types';
import type { Point } from './geom/transform';
import { buildBoardScene } from './scene/board';
import { indexScene, type SceneIndex } from './scene/index';
import { buildLibraryScene, type LibraryItemKind, type LibraryItemRef } from './scene/library';
import { buildSchematicScene } from './scene/schematic';
import type { Bounds, Owner, Scene, Target } from './scene/types';
import { pick, pickBox } from './view/hittest';
import { layerColor, layerName } from './view/palette';
import { render } from './view/render';
import { Viewport } from './view/viewport';

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

// ---------------------------------------------------------------------------
// State

const vp = new Viewport();
const selection = new Selection();
let file: EagleFile | undefined;
let fileName = '';
let fileHandle: FileHandle | undefined;
let editor: Editor | undefined;
let index: SceneIndex | undefined;
let layerMap = new Map<number, Layer>();
const visibility = new Map<number, boolean>();
let hover: string | undefined;
let libraryItem: LibraryItemRef | undefined;
let box: { start: Point; end: Point } | undefined;
/** World position of the cursor (last known). */
let cursor: Point = { x: 0, y: 0 };

/** An interactive move: started by dragging a selected object (`drag`) or by the M key. */
let move: { session: MoveSession; start: Point; drag: boolean } | undefined;

const isVisible = (layer: number) => visibility.get(layer) ?? true;

// ---------------------------------------------------------------------------
// Loading and saving

const samples = import.meta.glob('../samples/eagle/*.{sch,brd,lbr}', { query: '?raw', import: 'default' });

function initSamples(): void {
  const names = Object.keys(samples).sort();
  sampleSelect.append(new Option('—', ''));
  for (const path of names) sampleSelect.append(new Option(path.split('/').pop()!, path));
  sampleSelect.addEventListener('change', async () => {
    const path = sampleSelect.value;
    const load = samples[path];
    if (!load) return;
    if (!confirmDiscard()) {
      sampleSelect.value = '';
      return;
    }
    const name = path.split('/').pop()!;
    openText((await load()) as string, name, undefined);
    storeSet('osprey.sample', path);
    history.replaceState(null, '', `#${encodeURIComponent(name)}`);
  });
  // A sample can be linked to as #<file name>, e.g. #TA7358A.brd
  const fromHash = names.find((n) => n.split('/').pop() === decodeURIComponent(location.hash.slice(1)));
  const remembered = storeGet('osprey.sample');
  const initial =
    fromHash ?? (remembered && samples[remembered] ? remembered : names.find((n) => n.endsWith('.sch'))) ?? names[0];
  if (initial) {
    sampleSelect.value = initial;
    sampleSelect.dispatchEvent(new Event('change'));
  }
}

function openText(text: string, name: string, handle: FileHandle | undefined): void {
  try {
    const parsed = parseEagle(text);
    cancelMove();
    file = parsed;
    fileName = name;
    fileHandle = handle;
    editor = new Editor(parsed, onEdited);
    layerMap = new Map(parsed.layers.map((l) => [l.number, l]));
    visibility.clear();
    for (const l of parsed.layers) visibility.set(l.number, l.visible);
    libraryItem = undefined;
    hideError();
    setupDocumentChrome();
    rebuildScene({ fit: true, keepSelection: false });
  } catch (e) {
    showError(`Could not open ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openViaDialog(): Promise<void> {
  if (!confirmDiscard()) return;
  if (!canPickFiles()) {
    fileInput.click();
    return;
  }
  try {
    const f = await pickFile();
    if (!f) return;
    openText(f.text, f.name, f.handle);
    sampleSelect.value = '';
  } catch (e) {
    showError(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openDropped(f: File): Promise<void> {
  if (!confirmDiscard()) return;
  openText(await f.text(), f.name, undefined);
  sampleSelect.value = '';
}

async function save(): Promise<void> {
  if (!editor) return;
  if (move) commitMove();
  try {
    const result = await saveFile(editor.serialize(), fileName, fileHandle);
    if (!result) return;
    if (result.handle) {
      fileHandle = result.handle;
      fileName = result.handle.name;
    }
    editor.history.markSaved();
    flash(result.method === 'written' ? `Saved ${fileName}` : `Downloaded ${fileName}`);
    updateChrome();
  } catch (e) {
    showError(`Could not save ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function confirmDiscard(): boolean {
  return !editor?.history.dirty || window.confirm(`Discard unsaved changes to ${fileName}?`);
}

function setupDocumentChrome(): void {
  if (!file) return;
  const sheets = file.schematic?.sheets ?? [];
  sheetField.hidden = sheets.length < 2;
  sheetSelect.replaceChildren(...sheets.map((_, i) => new Option(`${i + 1}`, String(i))));

  libraryPanel.hidden = !file.library;
  if (file.library) {
    const lib = file.library;
    const kind: LibraryItemKind = lib.devicesets.size ? 'deviceset' : lib.symbols.size ? 'symbol' : 'package';
    const names = kind === 'deviceset' ? lib.devicesets.keys() : kind === 'symbol' ? lib.symbols.keys() : lib.packages.keys();
    const first = [...names].sort()[0];
    libraryItem = first !== undefined ? { kind, name: first } : undefined;
    libraryFilter.value = '';
    renderLibraryList();
  }
  statusHint.textContent = file.board
    ? 'Drag or M moves · R rotates · F flips side · Del deletes · Ctrl+Z undo · Ctrl+S save · Home fits'
    : 'Click to select · Shift adds · Ctrl toggles · drag to box-select · right-drag pans · Home fits';
  updateChrome();
}

/** Title, dirty marker and toolbar button states. */
function updateChrome(): void {
  if (!file) return;
  const kind = file.schematic ? 'Schematic' : file.board ? 'Board' : 'Library';
  const dirty = editor?.history.dirty ?? false;
  docTitle.textContent = `${dirty ? '● ' : ''}${fileName} — ${kind}, Eagle ${file.version}`;
  document.title = `${dirty ? '• ' : ''}${fileName} · Osprey`;
  const h = editor?.history;
  undoBtn.disabled = !h?.canUndo;
  redoBtn.disabled = !h?.canRedo;
  undoBtn.title = h?.undoLabel ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  redoBtn.title = h?.redoLabel ? `Redo ${h.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  saveBtn.disabled = !editor;
  saveBtn.textContent = dirty ? 'Save •' : 'Save';
}

function buildScene(): Scene | undefined {
  if (!file) return undefined;
  if (file.schematic) return buildSchematicScene(file, Number(sheetSelect.value || 0));
  if (file.board) return buildBoardScene(file);
  if (file.library && libraryItem) return buildLibraryScene(file, libraryItem);
  return undefined;
}

function rebuildScene(opts: { fit: boolean; keepSelection: boolean }): void {
  try {
    const scene = buildScene();
    index = scene ? indexScene(scene) : undefined;
  } catch (e) {
    index = undefined;
    showError(`Could not display ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  hover = undefined;
  if (opts.keepSelection && index) {
    // Owner ids are stable across edits, so the selection survives a rebuild.
    selection.select([...selection.items].filter((id) => index!.scene.owners.has(id)), 'replace');
  } else {
    selection.clear();
  }
  if (!opts.keepSelection) renderLayerList();
  renderInspector();
  if (opts.fit) fitView();
  requestRender();
}

/** Called by the editor after every change to the design (edit, undo, redo). */
function onEdited(): void {
  rebuildScene({ fit: false, keepSelection: true });
  updateChrome();
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
  return { x: editor.snap((b.minX + b.maxX) / 2), y: editor.snap((b.minY + b.maxY) / 2) };
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
  if (o.target?.kind === 'signal-wire') {
    const w = o.target.wire;
    const d1 = Math.hypot(w.x1 - grab.x, w.y1 - grab.y);
    const d2 = Math.hypot(w.x2 - grab.x, w.y2 - grab.y);
    return d1 <= d2 ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 };
  }
  return undefined;
}

/** Rotation/flip pivot while moving: the snap reference if any, else the grab point on the grid. */
function pivotFor(grab: Point): Point {
  return snapReference(grab) ?? (editor ? { x: editor.snap(grab.x), y: editor.snap(grab.y) } : grab);
}

/** Explain why a command does nothing, or return the editable targets. */
function commandTargets(verb: string): Target[] | undefined {
  if (!editor?.board) {
    flash(`${verb} works on boards only for now`);
    return undefined;
  }
  const ts = selectedTargets();
  if (!ts.length) {
    flash(`Select something to ${verb.toLowerCase()}`);
    return undefined;
  }
  const editable = editor.editable(ts);
  if (!editable.length) {
    flash('The selection is locked');
    return undefined;
  }
  if (editable.length < ts.length) flash(`${ts.length - editable.length} locked part(s) left in place`);
  return editable;
}

function rotateCmd(quarterTurns: number): void {
  if (move) {
    move.session.rotate(quarterTurns);
    onEdited();
    return;
  }
  const ts = commandTargets('Rotate');
  if (ts) editor!.rotate(ts, pivot(), quarterTurns);
}

function flipCmd(): void {
  if (move) {
    move.session.flip();
    onEdited();
    return;
  }
  const ts = commandTargets('Flip');
  if (ts) editor!.flip(ts, pivot());
}

function deleteCmd(): void {
  if (move) return;
  const ts = commandTargets('Delete');
  if (!ts) return;
  editor!.delete(ts);
  selection.clear();
}

/** Start a move. `drag` = following a held mouse button; otherwise it follows the cursor until a click. */
function beginMove(start: Point, drag: boolean): void {
  if (move || !editor) return;
  const ts = commandTargets('Move');
  if (!ts) return;
  const session = editor.beginMove(ts, pivotFor(start), snapReference(start));
  if (!session) return;
  move = { session, start, drag };
  canvas.classList.add('moving');
  flash(drag ? 'Moving: release to place · Esc cancels' : 'Moving: click to place · R rotates · F flips · Esc cancels');
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
  m.session.commit();
  flash(x || y ? `Moved by (${round(x)}, ${round(y)}) mm` : '');
}

function cancelMove(): void {
  if (!move) return;
  move.session.cancel();
  move = undefined;
  canvas.classList.remove('moving');
  flash('Move cancelled');
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
  selection.select(ids, 'replace');
}

// ---------------------------------------------------------------------------
// Panels

function renderLayerList(): void {
  layerList.replaceChildren();
  if (!index || !file) return;
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
    name.textContent = layerName(file.layers, n);
    label.append(cb, sw, num, name);
    li.append(label);
    layerList.append(li);
  }
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
  const lib = file?.library;
  libraryList.replaceChildren();
  if (!lib) return;
  const q = libraryFilter.value.trim().toLowerCase();
  const groups: [string, LibraryItemKind, Iterable<string>][] = [
    ['Device sets', 'deviceset', lib.devicesets.keys()],
    ['Symbols', 'symbol', lib.symbols.keys()],
    ['Packages', 'package', lib.packages.keys()],
  ];
  for (const [title, kind, names] of groups) {
    const matches = [...names].filter((n) => !q || n.toLowerCase().includes(q)).sort();
    if (!matches.length) continue;
    const h = document.createElement('h3');
    h.textContent = `${title} (${matches.length})`;
    libraryList.append(h);
    for (const name of matches) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.title = name;
      if (libraryItem?.kind === kind && libraryItem.name === name) btn.className = 'active';
      btn.addEventListener('click', () => {
        libraryItem = { kind, name };
        renderLibraryList();
        rebuildScene({ fit: true, keepSelection: false });
      });
      libraryList.append(btn);
    }
  }
}

const KIND_LABEL: Record<Owner['kind'], string> = {
  instance: 'Part instance',
  'net-wire': 'Net wire',
  'bus-wire': 'Bus wire',
  junction: 'Junction',
  label: 'Net label',
  element: 'Element',
  'signal-wire': 'Trace',
  via: 'Via',
  'signal-polygon': 'Polygon',
  plain: 'Drawing',
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
      (file?.board
        ? '<p>Then act on the selection: drag it or press <b>M</b> to move, <b>R</b> to rotate, ' +
          '<b>F</b> to flip to the other side, <b>Del</b> to delete.</p>'
        : '<p>Editing is available for boards so far.</p>');
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
    const table = document.createElement('table');
    table.className = 'props';
    for (const [k, v] of owners[0]!.props) {
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
  if (!editor?.board) return [];
  const ts = selectedTargets();
  if (!ts.length) return [];
  const editable = editor.editable(ts);
  const out: HTMLElement[] = [];
  if (editable.length < ts.length) {
    out.push(el('p', 'locked-note', editable.length ? 'Locked parts will stay in place.' : 'Locked: unlock it in Eagle to edit.'));
  }
  const grid = document.createElement('div');
  grid.className = 'commands';
  const cmd = (label: string, key: string, run: () => void) => {
    const b = button('', run);
    b.disabled = !editable.length;
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
    cmd('Flip side', 'F', flipCmd),
    cmd('Delete', 'Del', deleteCmd),
  );
  out.push(grid);
  return out;
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

function showError(msg: string): void {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

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
    hover: move ? undefined : hover,
    ...(box ? { box: boxSelection(box) } : {}),
    ...(editor && !file?.library ? { grid: editor.grid() } : {}),
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
  e.preventDefault();

  // A keyboard-started move ends with a click: left places, right cancels.
  if (move && !move.drag) {
    if (e.button === 0) commitMove();
    else if (e.button === 2) cancelMove();
    return;
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

  if (pointer && pointer.id === e.pointerId) {
    if (pointer.mode === 'pan') {
      vp.panBy(p.x - pointer.x, p.y - pointer.y);
      pointer.x = p.x;
      pointer.y = p.y;
      requestRender();
      return;
    }
    if (pointer.mode === 'pending' && Math.hypot(p.x - pointer.x, p.y - pointer.y) > DRAG_THRESHOLD) {
      if (pointer.onSelected && pointer.mods === 'replace' && editor?.board) {
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
    canvas.classList.toggle('can-drag', !!h && selection.has(h) && !!editor?.board);
    requestRender();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (move?.drag) {
    commitMove();
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

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

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
  } else if (e.key === 'Escape') {
    if (move) cancelMove();
    else selection.clear();
  } else if (e.key === 'Home') {
    fitView();
  } else if (key === 'm') {
    beginMove(cursor, false);
  } else if (key === 'r') {
    rotateCmd(e.shiftKey ? -1 : 1);
  } else if (key === 'f') {
    flipCmd();
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
  renderInspector();
  requestRender();
});

// Toolbar
$('open-btn').addEventListener('click', () => void openViaDialog());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openDropped(f);
  fileInput.value = '';
});
$('fit-btn').addEventListener('click', fitView);
undoBtn.addEventListener('click', undoCmd);
redoBtn.addEventListener('click', redoCmd);
saveBtn.addEventListener('click', () => void save());
sheetSelect.addEventListener('change', () => rebuildScene({ fit: true, keepSelection: false }));
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
  const f = e.dataTransfer?.files[0];
  if (f) void openDropped(f);
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
