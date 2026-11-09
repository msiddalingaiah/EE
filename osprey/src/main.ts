// Osprey application shell: file loading, panels, and canvas interaction.

import { Selection, type SelectMode } from './app/selection';
import { parseEagle } from './eagle/parse';
import type { EagleFile, Layer } from './eagle/types';
import { buildBoardScene } from './scene/board';
import { indexScene, type SceneIndex } from './scene/index';
import { buildLibraryScene, type LibraryItemKind, type LibraryItemRef } from './scene/library';
import { buildSchematicScene } from './scene/schematic';
import type { Bounds, Owner, Scene } from './scene/types';
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

// ---------------------------------------------------------------------------
// State

const vp = new Viewport();
const selection = new Selection();
let file: EagleFile | undefined;
let fileName = '';
let index: SceneIndex | undefined;
let layerMap = new Map<number, Layer>();
const visibility = new Map<number, boolean>();
let hover: string | undefined;
let libraryItem: LibraryItemRef | undefined;
let box: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;

const isVisible = (layer: number) => visibility.get(layer) ?? true;

// ---------------------------------------------------------------------------
// Loading

const samples = import.meta.glob('../samples/eagle/*.{sch,brd,lbr}', { query: '?raw', import: 'default' });

function initSamples(): void {
  const names = Object.keys(samples).sort();
  sampleSelect.append(new Option('—', ''));
  for (const path of names) sampleSelect.append(new Option(path.split('/').pop()!, path));
  sampleSelect.addEventListener('change', async () => {
    const path = sampleSelect.value;
    const load = samples[path];
    if (!load) return;
    const name = path.split('/').pop()!;
    openText((await load()) as string, name);
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

function openText(text: string, name: string): void {
  try {
    const parsed = parseEagle(text);
    file = parsed;
    fileName = name;
    layerMap = new Map(parsed.layers.map((l) => [l.number, l]));
    visibility.clear();
    for (const l of parsed.layers) visibility.set(l.number, l.visible);
    libraryItem = undefined;
    hideError();
    setupDocumentChrome();
    rebuildScene(true);
  } catch (e) {
    showError(`Could not open ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openFile(f: File): Promise<void> {
  openText(await f.text(), f.name);
  sampleSelect.value = '';
}

function setupDocumentChrome(): void {
  if (!file) return;
  const kind = file.schematic ? 'Schematic' : file.board ? 'Board' : 'Library';
  docTitle.textContent = `${fileName} — ${kind}, Eagle ${file.version}`;
  document.title = `${fileName} · Osprey`;

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
}

function buildScene(): Scene | undefined {
  if (!file) return undefined;
  if (file.schematic) return buildSchematicScene(file, Number(sheetSelect.value || 0));
  if (file.board) return buildBoardScene(file);
  if (file.library && libraryItem) return buildLibraryScene(file, libraryItem);
  return undefined;
}

function rebuildScene(fit: boolean): void {
  try {
    const scene = buildScene();
    index = scene ? indexScene(scene) : undefined;
  } catch (e) {
    index = undefined;
    showError(`Could not display ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  hover = undefined;
  selection.clear();
  renderLayerList();
  renderInspector();
  if (fit) fitView();
  requestRender();
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
        rebuildScene(true);
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
  'signal-wire': 'Signal wire',
  via: 'Via',
  'signal-polygon': 'Signal polygon',
  plain: 'Drawing',
  'library-item': 'Library item',
};

function renderInspector(): void {
  inspector.replaceChildren();
  statusSel.textContent = selection.size ? `${selection.size} selected` : '';
  const owners = index ? [...selection.items].map((id) => index!.scene.owners.get(id)).filter((o): o is Owner => !!o) : [];

  if (owners.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML =
      '<p>Nothing selected.</p>' +
      '<p>Click an object to select it. Drag left-to-right to select objects fully inside the box, ' +
      'right-to-left to select anything the box touches. Hold Shift to add, Ctrl to toggle.</p>' +
      '<p>Selected objects are the targets for commands.</p>';
    inspector.append(hint);
    return;
  }

  const actions = document.createElement('div');
  actions.className = 'sel-actions';
  actions.append(button('Zoom to selection', zoomToSelection), button('Clear', () => selection.clear()));

  if (owners.length === 1) {
    const o = owners[0]!;
    inspector.append(el('p', 'sel-title', o.label), el('p', 'sel-kind', KIND_LABEL[o.kind]));
    const table = document.createElement('table');
    table.className = 'props';
    for (const [k, v] of o.props) {
      const tr = document.createElement('tr');
      tr.append(el('th', '', k), el('td', '', v));
      table.append(tr);
    }
    inspector.append(table, actions);
    return;
  }

  const counts = new Map<string, number>();
  for (const o of owners) counts.set(KIND_LABEL[o.kind], (counts.get(KIND_LABEL[o.kind]) ?? 0) + 1);
  inspector.append(
    el('p', 'sel-title', `${owners.length} objects`),
    el('p', 'sel-kind', [...counts].map(([k, n]) => `${n} × ${k}`).join(', ')),
    actions,
  );
  const list = document.createElement('ul');
  list.className = 'sel-list';
  for (const o of owners.slice(0, 200).sort((a, b) => a.label.localeCompare(b.label))) {
    const li = document.createElement('li');
    li.append(button(o.label, () => selection.select([o.id], 'replace')));
    list.append(li);
  }
  inspector.append(list);
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
    hover,
    ...(box ? { box: boxSelection(box) } : {}),
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

function zoomToSelection(): void {
  if (!index || !selection.size) return;
  let b: Bounds | undefined;
  for (const id of selection.items) {
    const ob = index.ownerBounds.get(id);
    if (!ob) continue;
    b = b
      ? { minX: Math.min(b.minX, ob.minX), minY: Math.min(b.minY, ob.minY), maxX: Math.max(b.maxX, ob.maxX), maxY: Math.max(b.maxY, ob.maxY) }
      : { ...ob };
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

// ---------------------------------------------------------------------------
// Interaction

const DRAG_THRESHOLD = 4;
const PICK_TOLERANCE_PX = 4;

let pointer: { id: number; x: number; y: number; mode: 'pending' | 'box' | 'pan'; mods: SelectMode } | undefined;
let spaceDown = false;

function localPoint(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
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

canvas.addEventListener('pointerdown', (e) => {
  const p = localPoint(e);
  canvas.setPointerCapture(e.pointerId);
  const pan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown);
  pointer = { id: e.pointerId, x: p.x, y: p.y, mode: pan ? 'pan' : 'pending', mods: modeFor(e) };
  if (pan) canvas.classList.add('panning');
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPoint(e);
  const w = vp.toWorld(p.x, p.y);
  statusPos.textContent = `x ${w.x.toFixed(3)}  y ${w.y.toFixed(3)} mm   (${(w.x / 0.0254).toFixed(0)}, ${(w.y / 0.0254).toFixed(0)} mil)`;

  if (pointer && pointer.id === e.pointerId) {
    if (pointer.mode === 'pan') {
      vp.panBy(p.x - pointer.x, p.y - pointer.y);
      pointer.x = p.x;
      pointer.y = p.y;
      requestRender();
      return;
    }
    if (pointer.mode === 'pending' && Math.hypot(p.x - pointer.x, p.y - pointer.y) > DRAG_THRESHOLD) {
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
  const h = pick(index, w, PICK_TOLERANCE_PX / vp.zoom, isVisible);
  if (h !== hover) {
    hover = h;
    canvas.title = h ? (index.scene.owners.get(h)?.label ?? '') : '';
    requestRender();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!pointer || pointer.id !== e.pointerId) return;
  const p = localPoint(e);
  const mode = pointer.mods;
  if (pointer.mode === 'pending' && index) {
    const hit = pick(index, vp.toWorld(p.x, p.y), PICK_TOLERANCE_PX / vp.zoom, isVisible);
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

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    spaceDown = true;
    e.preventDefault();
  } else if (e.key === 'Escape') {
    selection.clear();
  } else if (e.key === 'f' || e.key === 'F' || e.key === 'Home') {
    fitView();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && index) {
    e.preventDefault();
    const all = [...index.ownerPrims.entries()]
      .filter(([, ids]) => ids.some((i) => isVisible(index!.scene.prims[i]!.layer)))
      .map(([id]) => id);
    selection.select(all, 'replace');
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceDown = false;
});

selection.onChange(() => {
  renderInspector();
  requestRender();
});

// Toolbar
$('open-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = '';
});
$('fit-btn').addEventListener('click', fitView);
sheetSelect.addEventListener('change', () => rebuildScene(true));
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
  if (f) void openFile(f);
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
