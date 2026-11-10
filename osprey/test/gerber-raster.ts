// Test helper: read Gerber (RS-274X) and Excellon files, and rasterise Gerber images, so CAM
// output can be compared with Eagle's by geometry rather than by text. Covers what Eagle and
// Osprey write: mm or inch, standard apertures C/R/O plus the OC8 macro, linear and circular
// (multi-quadrant) interpolation, regions and polarity.

import { deflateSync } from 'node:zlib';

export interface Raster {
  res: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  px: Uint8Array;
}

export function raster(x0: number, y0: number, x1: number, y1: number, res: number): Raster {
  const w = Math.ceil((x1 - x0) / res);
  const h = Math.ceil((y1 - y0) / res);
  return { res, x0, y0, w, h, px: new Uint8Array(w * h) };
}

type P = { x: number; y: number };
type Ap = { t: string; p: number[] };

/**
 * Plot a Gerber file into the raster. `lineWidth`: draw every line this wide (to compare centre
 * lines). `only`: plot only regions (poured copper), or everything but regions.
 */
export function plotGerber(text: string, r: Raster, opts: { lineWidth?: number; only?: 'regions' | 'other' } = {}): void {
  const regions = opts.only !== 'other';
  const other = opts.only !== 'regions';
  let scale = 1;
  let dec = 4;
  const aps = new Map<number, Ap>();
  let ap: Ap | undefined;
  let mode = 'G01';
  let dark = true;
  let cur: P = { x: 0, y: 0 };
  let region: P[][] | undefined;
  let contour: P[] = [];
  const val = (s: string) => (Number(s) / 10 ** dec) * scale;

  // Split into commands: extended (%...%) blocks and *-terminated words.
  const cmds: string[] = [];
  const re = /%([^%]*)%|([^%*]+)\*/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m[1] !== undefined) for (const part of m[1].split('*')) { if (part.trim()) cmds.push(`%${part.trim()}`); }
    else if (m[2]!.trim()) cmds.push(m[2]!.trim());
  }
  for (const c of cmds) {
    if (c.startsWith('%')) {
      const e = c.slice(1);
      if (e.startsWith('FS')) dec = Number(/X(\d)(\d)/.exec(e)![2]);
      else if (e === 'MOIN') scale = 25.4;
      else if (e === 'MOMM') scale = 1;
      else if (e === 'LPD') dark = true;
      else if (e === 'LPC') dark = false;
      else if (e.startsWith('ADD')) {
        const m = /^ADD(\d+)([A-Za-z0-9_]+),?(.*)$/.exec(e)!;
        aps.set(Number(m[1]), { t: m[2]!, p: m[3] ? m[3].split('X').map((v) => Number(v) * scale) : [] });
      }
      continue;
    }
    if (c.startsWith('G04')) continue;
    let rest = c;
    const g = /^G0?(\d+)/.exec(rest);
    if (g) {
      const n = Number(g[1]);
      if (n === 1 || n === 2 || n === 3) mode = `G0${n}`;
      else if (n === 36) { region = []; contour = []; }
      else if (n === 37) {
        if (contour.length) region!.push(contour);
        if (regions) fillPolys(r, region!, dark);
        region = undefined;
      }
      rest = rest.slice(g[0].length);
      if (!rest) continue;
    }
    const d = /^D(\d+)$/.exec(rest);
    if (d && Number(d[1]) >= 10) { ap = aps.get(Number(d[1])); continue; }
    const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0?([123])$/.exec(rest);
    if (!m) continue;
    const to = { x: m[1] !== undefined ? val(m[1]) : cur.x, y: m[2] !== undefined ? val(m[2]) : cur.y };
    const op = Number(m[5]);
    if (op === 2) {
      if (region && contour.length) region.push(contour);
      if (region) contour = [to];
      cur = to;
      continue;
    }
    if (op === 3) {
      if (ap && other) flash(r, ap, to, dark);
      cur = to;
      continue;
    }
    // D01: draw
    let pts: P[] = [cur, to];
    if (mode !== 'G01') {
      const c = { x: cur.x + (m[3] ? val(m[3]) : 0), y: cur.y + (m[4] ? val(m[4]) : 0) };
      const rad = Math.hypot(cur.x - c.x, cur.y - c.y);
      const a0 = Math.atan2(cur.y - c.y, cur.x - c.x);
      let a1 = Math.atan2(to.y - c.y, to.x - c.x);
      const ccw = mode === 'G03';
      if (ccw) { while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI; } else { while (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI; }
      const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) * rad) / (r.res * 2)));
      pts = Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + rad * Math.cos(a0 + ((a1 - a0) * i) / n), y: c.y + rad * Math.sin(a0 + ((a1 - a0) * i) / n) }));
    }
    if (region) contour.push(...pts.slice(1));
    else if (ap && other) {
      const width = opts.lineWidth ?? ap.p[0] ?? 0;
      for (let i = 1; i < pts.length; i++) capsule(r, pts[i - 1]!, pts[i]!, width / 2, dark);
    }
    cur = to;
  }
}

function set(r: Raster, i: number, j: number, dark: boolean): void {
  if (i >= 0 && j >= 0 && i < r.w && j < r.h) r.px[j * r.w + i] = dark ? 1 : 0;
}

function each(r: Raster, minX: number, minY: number, maxX: number, maxY: number, test: (x: number, y: number) => boolean, dark: boolean): void {
  const i0 = Math.max(0, Math.floor((minX - r.x0) / r.res));
  const i1 = Math.min(r.w - 1, Math.ceil((maxX - r.x0) / r.res));
  const j0 = Math.max(0, Math.floor((minY - r.y0) / r.res));
  const j1 = Math.min(r.h - 1, Math.ceil((maxY - r.y0) / r.res));
  for (let j = j0; j <= j1; j++) {
    const y = r.y0 + (j + 0.5) * r.res;
    for (let i = i0; i <= i1; i++) if (test(r.x0 + (i + 0.5) * r.res, y)) set(r, i, j, dark);
  }
}

function capsule(r: Raster, a: P, b: P, rad: number, dark: boolean): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  each(r, Math.min(a.x, b.x) - rad, Math.min(a.y, b.y) - rad, Math.max(a.x, b.x) + rad, Math.max(a.y, b.y) + rad, (x, y) => {
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= rad;
  }, dark);
}

function flash(r: Raster, ap: Ap, c: P, dark: boolean): void {
  const [p0 = 0, p1 = p0] = ap.p;
  if (ap.t === 'C') return capsule(r, c, c, p0 / 2, dark);
  if (ap.t === 'R') return each(r, c.x - p0 / 2, c.y - p1 / 2, c.x + p0 / 2, c.y + p1 / 2, () => true, dark);
  if (ap.t === 'O') {
    const rad = Math.min(p0, p1) / 2;
    const ex = (p0 - 2 * rad) / 2;
    const ey = (p1 - 2 * rad) / 2;
    return capsule(r, { x: c.x - ex, y: c.y - ey }, { x: c.x + ex, y: c.y + ey }, rad, dark);
  }
  if (ap.t === 'OC8') {
    const R = (p0 * 1.08239) / 2;
    const pts = Array.from({ length: 8 }, (_, i) => ({ x: c.x + R * Math.cos(Math.PI / 8 + (i * Math.PI) / 4), y: c.y + R * Math.sin(Math.PI / 8 + (i * Math.PI) / 4) }));
    return fillPolys(r, [pts], dark);
  }
  throw new Error(`Unsupported aperture ${ap.t}`);
}

/** Even-odd fill of contours, by pixel centres (scanlines). */
function fillPolys(r: Raster, polys: P[][], dark: boolean): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of polys) for (const q of p) { minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const j0 = Math.max(0, Math.floor((minY - r.y0) / r.res));
  const j1 = Math.min(r.h - 1, Math.ceil((maxY - r.y0) / r.res));
  for (let j = j0; j <= j1; j++) {
    const y = r.y0 + (j + 0.5) * r.res;
    const xs: number[] = [];
    for (const p of polys) {
      for (let k = 0; k < p.length; k++) {
        const a = p[k]!;
        const b = p[(k + 1) % p.length]!;
        if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - r.x0) / r.res - 0.5));
      const i1 = Math.min(r.w - 1, Math.floor((xs[k + 1]! - r.x0) / r.res - 0.5));
      for (let i = i0; i <= i1; i++) set(r, i, j, dark);
    }
  }
}

/** Pixels set in exactly one of the rasters, and in each. */
export function compare(a: Raster, b: Raster): { onlyA: number; onlyB: number; a: number; b: number } {
  let onlyA = 0;
  let onlyB = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.px.length; k++) {
    const p = a.px[k]!;
    const q = b.px[k]!;
    na += p;
    nb += q;
    if (p && !q) onlyA++;
    else if (q && !p) onlyB++;
  }
  return { onlyA, onlyB, a: na, b: nb };
}

/** A PNG of two rasters: both grey, only the first red, only the second blue (for inspection). */
export function diffPng(a: Raster, b: Raster): Buffer {
  const rows: Buffer[] = [];
  for (let j = a.h - 1; j >= 0; j--) {
    const row = Buffer.alloc(1 + a.w * 3);
    for (let i = 0; i < a.w; i++) {
      const p = a.px[j * a.w + i];
      const q = b.px[j * a.w + i];
      const c = p && q ? [150, 150, 150] : p ? [220, 30, 30] : q ? [30, 60, 230] : [255, 255, 255];
      row.set(c, 1 + i * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(a.w, 0);
  ihdr.writeUInt32BE(a.h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Holes of an Excellon file: diameter (mm, 3 decimals) and position. */
export function readExcellon(text: string): { d: string; x: number; y: number }[] {
  const tools = new Map<string, number>();
  const out: { d: string; x: number; y: number }[] = [];
  let dec = 3;
  let scale = 1;
  let tool: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if (/^INCH/.test(line)) scale = 25.4;
    if ((m = /^(?:METRIC|INCH),\w+,(0*)\.(0+)/.exec(line))) dec = m[2]!.length;
    if ((m = /^T(\d+)C([\d.]+)/.exec(line))) tools.set(m[1]!, Number(m[2]) * scale);
    else if ((m = /^T(\d+)$/.exec(line))) tool = tools.get(m[1]!);
    else if ((m = /^X(-?\d+)Y(-?\d+)$/.exec(line)) && tool !== undefined) {
      out.push({ d: tool.toFixed(3), x: (Number(m[1]) / 10 ** dec) * scale, y: (Number(m[2]) / 10 ** dec) * scale });
    }
  }
  return out;
}
