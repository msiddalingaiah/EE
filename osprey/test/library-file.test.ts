// Library files (.ospreylib): reading and writing, importing an Eagle .lbr, exporting one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEagle } from '../src/eagle/parse';
import { exportEagleLibrary } from '../src/model/export-eagle';
import { OspreyFormatError, readLibrary, writeLibrary } from '../src/model/file';
import { importLibraryFile } from '../src/model/import-eagle';

const LBR = readFileSync(join(__dirname, '..', 'samples', 'eagle', 'madhu.lbr'), 'utf8');
const imported = () => importLibraryFile('madhu.lbr', parseEagle(LBR));

describe('library files', () => {
  it('imports an Eagle library under its file name, with its description', () => {
    const f = imported();
    expect(f.name).toBe('madhu');
    expect(f.description).toBe('Commonly used parts.');
    expect(f.library.components.length).toBeGreaterThan(10);
    for (const item of [...f.library.symbols, ...f.library.footprints, ...f.library.components]) expect(item.id).toMatch(/^madhu\//);
  });

  it('writes and reads back unchanged', () => {
    const text = writeLibrary(imported());
    expect(writeLibrary(readLibrary(text))).toBe(text);
    expect(text.startsWith('{\n  "osprey": 1,\n  "name": "madhu",\n  "description": "Commonly used parts.",\n  "library": {')).toBe(true);
  });

  it('exports an Eagle .lbr that imports back to the same library', () => {
    const f = imported();
    const lbr = exportEagleLibrary(f);
    expect(lbr).toContain('<library>');
    expect(writeLibrary(importLibraryFile('madhu.lbr', parseEagle(lbr)))).toBe(writeLibrary(f));
  });

  it('refuses files that are not libraries', () => {
    expect(() => readLibrary('{"osprey": 1, "library": {}}')).toThrow(OspreyFormatError);
    expect(() => readLibrary('{"osprey": 1, "name": "x", "library": {"symbols": []}}')).toThrow(/library has no footprints/);
    expect(() => readLibrary('{"osprey": 99, "name": "x"}')).toThrow(/format version 99/);
  });
});
