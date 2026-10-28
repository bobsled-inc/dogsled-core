import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveProjectIndex } from '@bobsled-inc/project-index';
import { afterEach, describe, expect, it } from 'vitest';

import { diffSeeds, loadSeeds, validateSeeds } from '../../../src/api/seed-project.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-seed-validation-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function spec(name: string, payloadPath: string): string {
  return [
    "spec_version: '0.2'",
    `name: ${name}`,
    'payload:',
    '  format: csv',
    `  path: ${payloadPath}`,
    'schema:',
    '  columns:',
    '    - name: id',
    '      type: STRING',
    '',
  ].join('\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('validateSeeds', () => {
  it('reuses a supplied Project index and returns nested spec paths', () => {
    const root = project();
    write(root, 'golf/datagolf/pga/seeds/events.csv', 'id\n1\n');
    const specPath = 'golf/datagolf/pga/seeds/specs/events.yml';
    write(root, specPath, spec('pga_events', '../events.csv'));
    const index = resolveProjectIndex(root);
    const indexedSnapshot = structuredClone(index);
    const changedSpec = spec('disk_only_events', '../events.csv');
    write(root, specPath, changedSpec);
    write(
      root,
      'golf/datagolf/pga/seeds/specs/new-events.yml',
      spec('new_disk_seed', '../events.csv')
    );

    const result = validateSeeds(root, { index });

    expect(result.ok).toBe(true);
    expect(result.seeds).toEqual([
      expect.objectContaining({
        name: 'pga_events',
        specPath: 'golf/datagolf/pga/seeds/specs/events.yml',
        status: 'valid',
      }),
    ]);
    expect(index).toEqual(indexedSnapshot);
    expect(readFileSync(path.join(root, specPath), 'utf-8')).toBe(changedSpec);
    const freshIndex = resolveProjectIndex(root);
    expect(freshIndex.entries.map(({ path: entryPath }) => entryPath)).toContain(
      'golf/datagolf/pga/seeds/specs/new-events.yml'
    );
    expect(freshIndex.entries.map(({ document }) => document)).toContainEqual(
      expect.objectContaining({ name: 'disk_only_events' })
    );
    expect(freshIndex.entries.map(({ document }) => document)).not.toContainEqual(
      expect.objectContaining({ name: 'pga_events' })
    );
  });

  it('reports an invalid seed spec with its owning path', () => {
    const root = project();
    const secretMarker = 'synthetic-seed-secret-marker';
    write(root, 'golf/seeds/broken.yml', `name: [${secretMarker}`);

    let message = '';
    try {
      validateSeeds(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('golf/seeds/broken.yml: Invalid YAML:');
    expect(message).toMatch(/at line \d+, column \d+/u);
    expect(message).not.toContain(secretMarker);
  });

  it('does not quote malformed seed YAML supplied by an index', () => {
    const root = project();
    write(root, 'golf/seeds/broken.yml', spec('broken', 'broken.csv'));
    const index = resolveProjectIndex(root);
    const secretMarker = 'synthetic-seed-secret-marker';
    const malformed = {
      ...index,
      entries: index.entries.map((entry) =>
        entry.path === 'golf/seeds/broken.yml'
          ? { ...entry, content: `name: [${secretMarker}`, document: undefined }
          : entry
      ),
    };

    let message = '';
    try {
      validateSeeds(root, { index: malformed });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('golf/seeds/broken.yml: invalid YAML:');
    expect(message).toMatch(/at line \d+, column \d+/u);
    expect(message).not.toContain(secretMarker);
  });

  it('applies the explicit seedsDir override to specs and bare CSV files', () => {
    const root = project();
    write(root, 'custom/seeds/events.csv', 'id\n1\n');
    write(root, 'custom/seeds/events.yml', spec('custom_events', 'events.csv'));
    write(root, 'seeds/legacy.csv', 'id\n2\n');
    write(root, 'seeds/legacy.yml', spec('legacy_events', 'legacy.csv'));

    const result = validateSeeds(root, { seedsDir: 'custom/seeds' });

    expect(result.seeds.map(({ name, specPath }) => ({ name, specPath }))).toEqual([
      { name: 'custom_events', specPath: 'custom/seeds/events.yml' },
    ]);
    expect(result.bareCsvFiles).toEqual([]);
  });
});

describe('loadSeeds', () => {
  it('sends one statement per runner call and sums the affected rows', async () => {
    const root = project();
    write(root, 'seeds/data/orders.csv', 'id,amount\n1,10.5\n2,\n');
    write(
      root,
      'seeds/orders.yml',
      [
        "spec_version: '0.2'",
        'type: seed',
        'name: orders',
        'payload:',
        '  format: csv',
        '  path: data/orders.csv',
        'schema:',
        '  columns:',
        '    - name: id',
        '      type: INTEGER',
        '    - name: amount',
        '      type: DOUBLE',
        '',
      ].join('\n')
    );
    const calls: string[] = [];
    const runner = async (sql: string) => {
      calls.push(sql);
      return /^INSERT/.test(sql) ? { rowCount: 2 } : {};
    };

    const result = await loadSeeds(root, { dialect: 'bigquery', schema: 'shop', runner });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^CREATE OR REPLACE TABLE `shop`\.`orders`/);
    expect(calls[0]).toContain('`amount` FLOAT64');
    expect(calls[1]).toContain('(1, 10.5)');
    expect(calls[1]).toContain('(2, NULL)');
    expect(calls.some((sql) => sql.includes(';'))).toBe(false);
    expect(result.seeds[0]).toMatchObject({ executed: true, rowsLoaded: 2, rowsAffected: 2 });
  });

  it('counts only INSERT rows when the driver reports -1 for DDL', async () => {
    const root = project();
    write(root, 'seeds/data/tags.csv', 'id\n1\n2\n3\n');
    write(
      root,
      'seeds/tags.yml',
      [
        "spec_version: '0.2'",
        'type: seed',
        'name: tags',
        'payload:',
        '  format: csv',
        '  path: data/tags.csv',
        'schema:',
        '  columns:',
        '    - name: id',
        '      type: INTEGER',
        '',
      ].join('\n')
    );
    const runner = async (sql: string) => ({ rowCount: /^INSERT/.test(sql) ? 3 : -1 });

    const result = await loadSeeds(root, { dialect: 'snowflake', schema: 'shop', runner });

    expect(result.seeds[0]).toMatchObject({ rowsLoaded: 3, rowsAffected: 3 });
  });

  it('rejects an unsupported column type before running any SQL', async () => {
    const root = project();
    write(root, 'seeds/data/shapes.csv', 'id,shape\n1,abc\n');
    write(
      root,
      'seeds/shapes.yml',
      [
        "spec_version: '0.2'",
        'type: seed',
        'name: shapes',
        'payload:',
        '  format: csv',
        '  path: data/shapes.csv',
        'schema:',
        '  columns:',
        '    - name: id',
        '      type: INTEGER',
        '    - name: shape',
        '      type: GEOGRAPHY',
        '',
      ].join('\n')
    );
    const calls: string[] = [];
    const runner = async (sql: string) => {
      calls.push(sql);
      return {};
    };

    const result = await loadSeeds(root, { dialect: 'bigquery', schema: 'shop', runner });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(result.seeds[0]?.error).toContain(
      'Seed shapes column "shape" has unsupported type "GEOGRAPHY"'
    );
  });
});

describe('diffSeeds', () => {
  function typedSeed(root: string): void {
    write(
      root,
      'seeds/data/orders.csv',
      'id,price,ratio,active,day,at,big\n007,1.50,10,yes,2025-01-01,2025-01-01 10:00:00,9007199254740993\n2,2,0.25,no,2025-01-02,2025-01-02 00:00:00,5\n'
    );
    write(
      root,
      'seeds/orders.yml',
      [
        "spec_version: '0.2'",
        'type: seed',
        'name: orders',
        'payload:',
        '  format: csv',
        '  path: data/orders.csv',
        'schema:',
        '  columns:',
        '    - { name: id, type: INTEGER }',
        '    - { name: price, type: DECIMAL }',
        '    - { name: ratio, type: DOUBLE }',
        '    - { name: active, type: BOOLEAN }',
        '    - { name: day, type: DATE }',
        '    - { name: at, type: TIMESTAMP }',
        '    - { name: big, type: BIGINT }',
        'validation:',
        '  unique_columns: [id]',
        '',
      ].join('\n')
    );
  }

  it('sees no drift when a warehouse returns the loaded values in its own types', async () => {
    const root = project();
    typedSeed(root);
    // BigQuery-shaped rows: wrapped dates and timestamps, numbers, booleans.
    const query = async () => [
      {
        id: '7',
        price: '1.5',
        ratio: 10,
        active: true,
        day: { value: '2025-01-01' },
        at: { value: '2025-01-01T10:00:00.000Z' },
        big: '9007199254740993',
      },
      {
        ID: '2',
        PRICE: '2.000000000',
        RATIO: '0.25',
        ACTIVE: false,
        DAY: '2025-01-02',
        AT: '2025-01-02 00:00:00.000',
        BIG: '5',
      },
    ];

    const sql: string[] = [];
    const result = await diffSeeds(root, {
      dialect: 'bigquery',
      schema: 'shop',
      query: async (text: string) => {
        sql.push(text);
        return query();
      },
    });

    expect(result.hasDrift).toBe(false);
    // Integer and exact columns are read as text so big values stay exact.
    expect(sql[0]).toContain('CAST(`id` AS STRING) AS `id`');
    expect(sql[0]).toContain('CAST(`big` AS STRING) AS `big`');
    expect(sql[0]).toContain(', `ratio`,');
    expect(result.seeds[0]).toMatchObject({ addCount: 0, updateCount: 0, deleteCount: 0 });
  });

  it('still reports a changed value', async () => {
    const root = project();
    typedSeed(root);
    const query = async () => [
      {
        id: '7',
        price: '1.51',
        ratio: 10,
        active: true,
        day: '2025-01-01',
        at: '2025-01-01 10:00:00',
        big: '9007199254740993',
      },
      {
        id: '2',
        price: '2',
        ratio: 0.25,
        active: false,
        day: '2025-01-02',
        at: '2025-01-02 00:00:00',
        big: '5',
      },
    ];

    const result = await diffSeeds(root, { dialect: 'snowflake', schema: 'shop', query });

    expect(result.hasDrift).toBe(true);
    expect(result.seeds[0]?.updateCount).toBe(1);
    expect(result.seeds[0]?.updates[0]?.warehouse.price).toBe('1.51');
  });
});
