import { globSync, readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs', () => ({
  globSync: vi.fn(() => [...fsMockState.files.keys()]),
  readFileSync: vi.fn((path: string) => {
    const text = fsMockState.files.get(String(path));
    if (text === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return text;
  }),
}));

function findTempMainOffenders(): string[] {
  const offenders: string[] = [];

  for (const file of globSync('packages/{dogsled,loader}/src/**/*.ts')) {
    const text = readFileSync(file, 'utf8');
    const matches = text.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TEMP\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/gi
    );

    for (const match of matches) {
      const rawName = match[1] ?? '';
      const normalizedName = rawName.toLowerCase();
      if (normalizedName.startsWith('temp.main.') || /^\$\{.+\}$/.test(rawName)) continue;
      offenders.push(`${file}: ${match[0]}`);
    }
  }

  return offenders;
}

describe('DuckDB temp table naming', () => {
  beforeEach(() => {
    fsMockState.files.clear();
  });

  it('qualifies every CREATE TEMP TABLE or VIEW in dogsled/loader source with temp.main', () => {
    fsMockState.files.set(
      'packages/dogsled/src/runtime/source-materializer/materializer.ts',
      'const scratchSql = `CREATE TEMP TABLE temp.main."issues_scratch_123" AS SELECT 1`;'
    );
    fsMockState.files.set(
      'packages/loader/src/runtime/destinations/duckdb.ts',
      [
        "const viewSql = 'CREATE OR REPLACE TEMP VIEW IF NOT EXISTS TEMP.MAIN.issues_live AS SELECT 1';",
        'const templateSql = `CREATE TEMP TABLE ${stagingTable} AS SELECT 1`;',
      ].join('\n')
    );

    expect(findTempMainOffenders()).toEqual([]);
  });

  it('reports unqualified temp objects', () => {
    fsMockState.files.set(
      'packages/dogsled/src/runtime/source-materializer/bad-temp.ts',
      "const scratchSql = 'CREATE TEMP TABLE issues_scratch AS SELECT 1';"
    );

    expect(findTempMainOffenders()).toEqual([
      'packages/dogsled/src/runtime/source-materializer/bad-temp.ts: CREATE TEMP TABLE issues_scratch',
    ]);
  });
});
