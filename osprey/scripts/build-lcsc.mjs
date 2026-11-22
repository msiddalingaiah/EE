// Extracts the chip resistors and ceramic capacitors (0603, 0805) from a JLCPCB parts export
// (CSV, one row per part, its parametric attributes as JSON) into lcsc-passives.json, the table
// Osprey assigns LCSC part numbers from by value and package. Osprey reads it from the user
// directory's parts/ folder; by default it is written to samples/parts/ (which Preferences ▸ Add
// the samples copies in), or give where it goes, such as the user directory's parts/ folder.
//
// The export is jlcpcb-components-basic-preferred.csv from CDFER/jlcpcb-parts-database
// (https://github.com/CDFER/jlcpcb-parts-database, MIT license): JLCPCB's Basic and preferred
// parts in stock, rebuilt daily and published at the URL below. Give the URL or a downloaded copy:
//
//   node scripts/build-lcsc.mjs https://cdfer.github.io/jlcpcb-parts-database/jlcpcb-components-basic-preferred.csv
//   node scripts/build-lcsc.mjs data/jlcpcb-components-basic-preferred.csv
//   node scripts/build-lcsc.mjs data/jlcpcb-components-basic-preferred.csv <user directory>/parts/lcsc-passives.json
//
// Kept: Basic parts ("base") and JLCPCB's preferred Extended parts, in stock.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/build-lcsc.mjs <jlcpcb-components-basic-preferred.csv: a file, or its URL> [output .json]');
  process.exit(1);
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') (f += '"'), i++;
        else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(f), (f = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f), (f = ''), rows.push(row), (row = []);
    } else f += c;
  }
  if (f || row.length) row.push(f), rows.push(row);
  const [head, ...data] = rows;
  return data.filter((r) => r.length >= head.length - 3).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
/** "4.7kΩ", "100nF", "1μF", "0Ω" → a number in Ω or F. */
function quantity(s) {
  const m = /^\s*([\d.]+)\s*([pnuµμmkKMG]?)\s*(Ω|ohm|F)?\s*$/i.exec(s ?? '');
  if (!m) return undefined;
  return Number(m[1]) * (m[2] ? PREFIX[m[2]] : 1);
}

const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : readFileSync(src, 'utf8');
const rows = parseCsv(text);
const out = [];
for (const r of rows) {
  if (r.package !== '0603' && r.package !== '0805') continue;
  if (r.present === '0' || Number(r.stock) <= 0) continue;
  const basic = r.library_type === 'base';
  if (!basic && r.preferred !== '1') continue;
  let a;
  try {
    a = JSON.parse(r.attributes || '{}');
  } catch {
    continue;
  }
  const common = { lcsc: `C${r.lcsc}`, package: r.package, basic, stock: Number(r.stock), mpn: r.mfr };
  if (r.subcategory === 'Chip Resistor - Surface Mount') {
    const value = quantity(a.Resistance);
    if (value === undefined) continue;
    out.push({ kind: 'R', value, ...common, tolerance: a.Tolerance ?? '', power: a['Power(Watts)'] ?? '' });
  } else if (r.subcategory === 'Multilayer Ceramic Capacitors MLCC - SMD/SMT') {
    const value = quantity(a.Capacitance);
    const volts = Number(/^([\d.]+)\s*V$/i.exec(a['Voltage Rating'] ?? '')?.[1]);
    if (value === undefined || !volts) continue;
    out.push({ kind: 'C', value, ...common, tolerance: a.Tolerance ?? '', dielectric: a['Temperature Coefficient'] ?? '', volts });
  }
}
out.sort((a, b) => a.kind.localeCompare(b.kind) || a.package.localeCompare(b.package) || a.value - b.value || a.lcsc.localeCompare(b.lcsc, undefined, { numeric: true }));
const file = process.argv[3] ? resolve(process.argv[3]) : join(ROOT, 'samples', 'parts', 'lcsc-passives.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{')}\n`);
console.log(`${out.length} parts (${out.filter((x) => x.kind === 'R').length} resistors, ${out.filter((x) => x.kind === 'C').length} capacitors) → ${file}`);
