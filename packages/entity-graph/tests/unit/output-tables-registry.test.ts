import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OUTPUT_TABLES, type OutputTableDef } from '../../src/compiler/output-tables/index.js';

interface OutputTableModuleExports {
  readonly [exportName: string]: unknown;
}

function flattenOutputTables(value: unknown): OutputTableDef[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(
    (item): item is OutputTableDef =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as OutputTableDef).suffix === 'string'
  );
}

describe('output table registry', () => {
  it('registers every exported output-table module definition', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourceDir = path.resolve(here, '../../src/compiler/output-tables');
    const files = fs
      .readdirSync(sourceDir)
      .filter((file) => file.endsWith('.ts') && file !== 'index.ts');
    const registered = new Set(OUTPUT_TABLES.suffixes());

    for (const file of files) {
      const modulePath = path.join(sourceDir, file);
      const mod = (await import(pathToFileURL(modulePath).href)) as OutputTableModuleExports;
      for (const [name, value] of Object.entries(mod)) {
        if (!/_(OUTPUT_TABLE|OUTPUT_TABLES|VIEW_TABLES)$/.test(name)) continue;
        for (const table of flattenOutputTables(value)) {
          expect(registered.has(table.suffix), `${name} exported ${table.suffix}`).toBe(true);
        }
      }
    }
  });

  it('keeps internal relationship staging tables out of public registry walks', () => {
    expect(OUTPUT_TABLES.get('__entity_relationship_edge').visibility).toBe('internal');
    expect(OUTPUT_TABLES.publicSuffixes()).not.toContain('__entity_relationship_edge');
    expect(OUTPUT_TABLES.publicSuffixes()).toContain('__document_mentions');
    expect(OUTPUT_TABLES.publicSuffixes()).toContain('__document_mentions__quality');
  });
});
