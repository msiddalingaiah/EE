// Convert a WOFF (1.0) font's glyphs into src/scene/font-data.ts: outlines (TrueType quadratic
// contours, as M/L/Q/Z paths in font units) and advance widths, for ASCII and Latin-1. Osprey
// draws board text, and plots it in CAM output, from this data, so it needs no font at runtime.
//
//   node scripts/build-font.mjs path/to/roboto-latin-400-normal.woff
//
// The font used is Roboto (from the @fontsource/roboto package), under the SIL Open Font License.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/build-font.mjs font.woff');
const woff = readFileSync(file);
if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('Not a WOFF 1.0 file');

const tables = {};
const numTables = woff.readUInt16BE(12);
for (let i = 0; i < numTables; i++) {
  const at = 44 + i * 20;
  const tag = woff.toString('latin1', at, at + 4);
  const offset = woff.readUInt32BE(at + 4);
  const comp = woff.readUInt32BE(at + 8);
  const orig = woff.readUInt32BE(at + 12);
  const raw = woff.subarray(offset, offset + comp);
  tables[tag] = comp < orig ? inflateSync(raw) : raw;
}

const head = tables.head;
const unitsPerEm = head.readUInt16BE(18);
const longLoca = head.readInt16BE(50) === 1;
const numGlyphs = tables.maxp.readUInt16BE(4);
const hhea = tables.hhea;
const ascender = hhea.readInt16BE(4);
const descender = hhea.readInt16BE(6);
const numHMetrics = hhea.readUInt16BE(34);
const os2 = tables['OS/2'];
const capHeight = os2.readUInt16BE(0) >= 2 ? os2.readInt16BE(88) : Math.round(ascender * 0.7);

const advance = (g) => tables.hmtx.readUInt16BE(4 * Math.min(g, numHMetrics - 1));
const loca = (g) => (longLoca ? tables.loca.readUInt32BE(4 * g) : 2 * tables.loca.readUInt16BE(2 * g));

// cmap: format 4 subtable (Windows, Unicode BMP).
function cmap4() {
  const c = tables.cmap;
  const n = c.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const platform = c.readUInt16BE(4 + i * 8);
    const encoding = c.readUInt16BE(6 + i * 8);
    const off = c.readUInt32BE(8 + i * 8);
    if (platform === 3 && encoding === 1 && c.readUInt16BE(off) === 4) return c.subarray(off);
  }
  throw new Error('No format 4 cmap');
}
const cm = cmap4();
const segX2 = cm.readUInt16BE(6);
function glyphOf(code) {
  for (let s = 0; s < segX2 / 2; s++) {
    const end = cm.readUInt16BE(14 + 2 * s);
    if (code > end) continue;
    const start = cm.readUInt16BE(16 + segX2 + 2 * s);
    if (code < start) return 0;
    const delta = cm.readInt16BE(16 + 2 * segX2 + 2 * s);
    const roAt = 16 + 3 * segX2 + 2 * s;
    const ro = cm.readUInt16BE(roAt);
    if (!ro) return (code + delta) & 0xffff;
    const g = cm.readUInt16BE(roAt + ro + 2 * (code - start));
    return g ? (g + delta) & 0xffff : 0;
  }
  return 0;
}

/** Contours of a glyph: arrays of {x, y, on}. Composite glyphs are flattened. */
function contours(g, dx = 0, dy = 0, m = [1, 0, 0, 1]) {
  const start = loca(g);
  if (loca(g + 1) === start) return [];
  const d = tables.glyf.subarray(start);
  const n = d.readInt16BE(0);
  const xf = (x, y) => Math.round(m[0] * x + m[2] * y + dx);
  const yf = (x, y) => Math.round(m[1] * x + m[3] * y + dy);
  if (n >= 0) {
    const ends = Array.from({ length: n }, (_, i) => d.readUInt16BE(10 + 2 * i));
    const count = n ? ends[n - 1] + 1 : 0;
    let at = 10 + 2 * n;
    at += 2 + d.readUInt16BE(at); // instructions
    const flags = [];
    while (flags.length < count) {
      const f = d[at++];
      flags.push(f);
      if (f & 8) for (let r = d[at++]; r > 0; r--) flags.push(f);
    }
    const coords = (short, same) => {
      const out = [];
      let v = 0;
      for (const f of flags) {
        if (f & short) v += f & same ? d[at++] : -d[at++];
        else if (!(f & same)) { v += d.readInt16BE(at); at += 2; }
        out.push(v);
      }
      return out;
    };
    const xs = coords(2, 16);
    const ys = coords(4, 32);
    const out = [];
    let s = 0;
    for (const e of ends) {
      const c = [];
      for (let i = s; i <= e; i++) c.push({ x: xf(xs[i], ys[i]), y: yf(xs[i], ys[i]), on: !!(flags[i] & 1) });
      out.push(c);
      s = e + 1;
    }
    return out;
  }
  // Composite
  const out = [];
  let at = 10;
  for (;;) {
    const f = d.readUInt16BE(at);
    const sub = d.readUInt16BE(at + 2);
    at += 4;
    let a1, a2;
    if (f & 1) { a1 = d.readInt16BE(at); a2 = d.readInt16BE(at + 2); at += 4; }
    else { a1 = d.readInt8(at); a2 = d.readInt8(at + 1); at += 2; }
    let sm = [1, 0, 0, 1];
    const f2 = (o) => d.readInt16BE(o) / 16384;
    if (f & 8) { sm = [f2(at), 0, 0, f2(at)]; at += 2; }
    else if (f & 0x40) { sm = [f2(at), 0, 0, f2(at + 2)]; at += 4; }
    else if (f & 0x80) { sm = [f2(at), f2(at + 2), f2(at + 4), f2(at + 6)]; at += 8; }
    if (!(f & 2)) throw new Error('Composite glyphs aligned by points are not supported');
    const mm = [m[0] * sm[0] + m[2] * sm[1], m[1] * sm[0] + m[3] * sm[1], m[0] * sm[2] + m[2] * sm[3], m[1] * sm[2] + m[3] * sm[3]];
    out.push(...contours(sub, dx + m[0] * a1 + m[2] * a2, dy + m[1] * a1 + m[3] * a2, mm));
    if (!(f & 0x20)) break;
  }
  return out;
}

/** A contour as an SVG-like path: M, L, Q, Z with integer coordinates. */
function path(cs) {
  const parts = [];
  for (const c of cs) {
    if (c.length < 2) continue;
    // Start on an on-curve point (or the midpoint of two off-curve points).
    let k = c.findIndex((p) => p.on);
    let pts;
    if (k < 0) {
      const mid = { x: Math.round((c[0].x + c[1].x) / 2), y: Math.round((c[0].y + c[1].y) / 2), on: true };
      pts = [mid, ...c.slice(1), c[0]];
    } else pts = [...c.slice(k), ...c.slice(0, k)];
    parts.push(`M${pts[0].x} ${pts[0].y}`);
    let ctrl;
    for (const p of [...pts.slice(1), pts[0]]) {
      if (p.on) {
        parts.push(ctrl ? `Q${ctrl.x} ${ctrl.y} ${p.x} ${p.y}` : `L${p.x} ${p.y}`);
        ctrl = undefined;
      } else if (ctrl) {
        const mx = Math.round((ctrl.x + p.x) / 2);
        const my = Math.round((ctrl.y + p.y) / 2);
        parts.push(`Q${ctrl.x} ${ctrl.y} ${mx} ${my}`);
        ctrl = p;
      } else ctrl = p;
    }
    parts.push('Z');
  }
  return parts.join('');
}

const glyphs = {};
const codes = [];
for (let c = 0x20; c <= 0x7e; c++) codes.push(c);
for (let c = 0xa0; c <= 0xff; c++) codes.push(c);
for (const c of codes) {
  const g = glyphOf(c);
  if (!g || g >= numGlyphs) continue;
  glyphs[String.fromCharCode(c)] = [advance(g), path(contours(g))];
}
const missing = glyphOf(0x25a1) || 0; // fallback: .notdef
glyphs['�'] = [advance(missing), path(contours(missing))];

// The vertical stem width: the width of "l" (a single upright stroke in sans-serif fonts).
const l = contours(glyphOf(0x6c)).flat();
const stem = Math.max(...l.map((p) => p.x)) - Math.min(...l.map((p) => p.x));

const name = 'Roboto';
const out = `// Generated by scripts/build-font.mjs from ${file.split(/[\\/]/).pop()}: do not edit.
//
// ${name} glyph outlines (ASCII and Latin-1). Copyright 2011 The Roboto Project Authors
// (https://github.com/googlefonts/roboto-classic). This Font Software is licensed under the SIL
// Open Font License, Version 1.1 (see ./font-license.txt, https://openfontlicense.org).
//
// Units are font units (unitsPerEm per em), y up. Each glyph: [advance width, outline path]. The
// path uses M (move), L (line), Q (quadratic curve: control point, end point) and Z (close).

export const FONT = {
  name: ${JSON.stringify(name)},
  unitsPerEm: ${unitsPerEm},
  ascender: ${ascender},
  descender: ${descender},
  capHeight: ${capHeight},
  /** Width of a vertical stroke (the letter l). */
  stem: ${stem},
  glyphs: {
${Object.entries(glyphs).map(([ch, [a, p]]) => `    ${JSON.stringify(ch)}: [${a}, ${JSON.stringify(p)}],`).join('\n')}
  } as Record<string, [number, string]>,
};
`;
const dest = join(import.meta.dirname, '..', 'src', 'scene', 'font-data.ts');
writeFileSync(dest, out);
console.log(`${Object.keys(glyphs).length} glyphs, unitsPerEm ${unitsPerEm}, cap height ${capHeight}, stem ${stem} → ${dest}`);
