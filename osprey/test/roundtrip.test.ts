import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEagle, serializeEagle } from '../src/eagle/parse';

const raw = (name: string) => readFileSync(join(__dirname, '..', 'samples', 'eagle', name), 'utf8');

/**
 * Eagle is inconsistent about escaping `"` in text content (both `"` and `&quot;` occur);
 * the two are equivalent XML. Normalize that one variation, nothing else.
 */
const normalizeTextQuotes = (xml: string) => xml.replace(/>([^<]*)</g, (_, t: string) => `>${t.replace(/&quot;/g, '"')}<`);

describe('lossless round trip', () => {
  for (const name of ['TA7358A.sch', 'TA7358A.brd', 'madhu.lbr']) {
    it(`${name} serializes back unchanged`, () => {
      const text = raw(name);
      expect(serializeEagle(parseEagle(text))).toBe(normalizeTextQuotes(text));
    });
  }

  it('keeps CRLF line endings and the original prolog', () => {
    const text = raw('TA7358A.brd');
    const out = serializeEagle(parseEagle(text));
    expect(out.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
});
