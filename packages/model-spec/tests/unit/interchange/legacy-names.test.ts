import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { updateSource } from '../../../src/edit/index.js';
import { isOwnOssieVendor } from '../../../src/interchange/common.js';
import { translateOssieDocument } from '../../../src/ossie/translate.js';

// Compatibility test: the rename never rewrites this file. An Ossie file written by Dogsled Core
// (vendor DOGSLED, dogsled:// sources) and one written by Bobsled Core must translate alike.
const fixture = readFileSync(
  new URL('../../fixtures/ossie-native-legacy/sales.yml', import.meta.url),
  'utf8'
);
const spelledText = (vendor: string, scheme: string) =>
  fixture
    .replaceAll(/vendor_name: (?:DOGSLED|BOBSLED)/g, `vendor_name: ${vendor}`)
    .replaceAll(/(?:dogsled|bobsled):\/\//g, scheme);
const spelled = (vendor: string, scheme: string) => parse(spelledText(vendor, scheme));
const OLD = { vendor: 'DOGSLED', scheme: 'dogsled://' } as const;

describe('Ossie files from either Core generation', () => {
  it('translates DOGSLED and BOBSLED extensions and source schemes to the same models', () => {
    // Translated specs, not the raw documents the origins keep for reference.
    const translate = (doc: unknown) => translateOssieDocument(doc, 'sales.yml').entries;
    const dogsled = translate(spelled(OLD.vendor, OLD.scheme));
    expect(translate(spelled('BOBSLED', 'bobsled://'))).toEqual(dogsled);
    expect(translate(spelled('BOBSLED', 'dogsled://'))).toEqual(dogsled);
  });

  it('treats both tags as Core’s own and TRACK as foreign', () => {
    expect(isOwnOssieVendor('DOGSLED')).toBe(true);
    expect(isOwnOssieVendor('BOBSLED')).toBe(true);
    expect(isOwnOssieVendor('TRACK')).toBe(false);
  });

  it('edits an earlier-generation file in place, keeping its tag and adding no new one', () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), 'ossie-legacy-edit-'));
    try {
      const filePath = path.join(projectDir, 'sales.yml');
      writeFileSync(filePath, spelledText(OLD.vendor, OLD.scheme));
      const count = (text: string, tag: string) => text.split(`vendor_name: ${tag}`).length - 1;
      const before = count(readFileSync(filePath, 'utf8'), OLD.vendor);

      const result = updateSource({
        projectDir,
        sourceName: 'raw_orders',
        connection: 'warehouse',
        patch: { description: 'Edited', trust_tier: 'gold' },
      });

      expect(result.ok).toBe(true);
      const after = readFileSync(filePath, 'utf8');
      expect(count(after, OLD.vendor)).toBe(before);
      expect(count(after, 'BOBSLED')).toBe(0);
      const dataset = (
        parse(after) as {
          datasets: {
            name: string;
            description: string;
            custom_extensions: { vendor_name: string; data: string }[];
          }[];
        }
      ).datasets.find((entry) => entry.name === 'raw_orders')!;
      expect(dataset.description).toBe('Edited');
      expect(
        JSON.parse(dataset.custom_extensions.find((ext) => ext.vendor_name === OLD.vendor)!.data)
      ).toMatchObject({ connection: 'warehouse', trust_tier: 'gold' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
