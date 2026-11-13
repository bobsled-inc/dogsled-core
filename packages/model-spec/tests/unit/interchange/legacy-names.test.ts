import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { isOwnOssieVendor } from '../../../src/interchange/common.js';
import { translateOssieDocument } from '../../../src/ossie/translate.js';

// Compatibility test: the rename never rewrites this file. An Ossie file written by Dogsled Core
// (vendor DOGSLED, dogsled:// sources) and one written by Bobsled Core must translate alike.
const fixture = readFileSync(
  new URL('../../fixtures/ossie-native-legacy/sales.yml', import.meta.url),
  'utf8'
);
const spelled = (vendor: string, scheme: string) =>
  parse(
    fixture
      .replaceAll(/vendor_name: (?:DOGSLED|BOBSLED)/g, `vendor_name: ${vendor}`)
      .replaceAll(/(?:dogsled|bobsled):\/\//g, scheme)
  );

describe('Ossie files from either Core generation', () => {
  it('translates DOGSLED and BOBSLED extensions and source schemes to the same models', () => {
    // Translated specs, not the raw documents the origins keep for reference.
    const translate = (doc: unknown) => translateOssieDocument(doc, 'sales.yml').entries;
    const dogsled = translate(spelled('DOGSLED', 'dogsled://'));
    expect(translate(spelled('BOBSLED', 'bobsled://'))).toEqual(dogsled);
    expect(translate(spelled('BOBSLED', 'dogsled://'))).toEqual(dogsled);
  });

  it('treats both tags as Core’s own and TRACK as foreign', () => {
    expect(isOwnOssieVendor('DOGSLED')).toBe(true);
    expect(isOwnOssieVendor('BOBSLED')).toBe(true);
    expect(isOwnOssieVendor('TRACK')).toBe(false);
  });
});
