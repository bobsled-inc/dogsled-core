import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  addModelColumn,
  removeModelColumn,
  updateModel,
  updateModelColumn,
  updateSourceColumn,
} from '../../../src/edit/index.js';

const nativeExtension = (data: Record<string, unknown>) => ({
  vendor_name: 'BOBSLED',
  data: JSON.stringify(data, null, 2),
});
const field = (name: string) => ({
  name,
  datatype: 'Integer',
  expression: { dialects: [{ dialect: 'ANSI_SQL', expression: name }] },
  custom_extensions: [
    nativeExtension({ build_expression: name, sql_type: 'INTEGER' }),
    { vendor_name: 'OTHER', data: '{"keep":true}' },
  ],
});
function fixture() {
  return {
    version: '0.2.0.dev0',
    name: 'sales',
    datasets: [
      {
        name: 'orders',
        source: 'analytics.sales.orders',
        description: 'Original description',
        primary_key: ['id'],
        fields: [field('id'), field('amount')],
        custom_extensions: [
          nativeExtension({
            extension_version: '1',
            kind: 'derived',
            grain: ['id'],
            build: { source: { ref: 'warehouse.raw' }, materialization: { type: 'table' } },
          }),
          { vendor_name: 'OTHER', data: '{"dataset":true}' },
        ],
      },
      {
        name: 'raw',
        source: 'analytics.raw.orders',
        fields: [
          {
            name: 'id',
            datatype: 'Integer',
            expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] },
            custom_extensions: [nativeExtension({ sql_type: 'INTEGER' })],
          },
        ],
        custom_extensions: [
          nativeExtension({ extension_version: '1', kind: 'source', connection: 'warehouse' }),
        ],
      },
    ],
  };
}

describe('Ossie edits through existing public APIs', () => {
  let projectDir: string;
  let filePath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ossie-edit-'));
    filePath = path.join(projectDir, 'sales.yml');
    fs.writeFileSync(filePath, '# Customer metadata\n' + YAML.stringify(fixture()));
  });
  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const read = (file: string) =>
    YAML.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof fixture>;

  it('writes standard descriptions and extension build expressions without changing read expressions or sibling datasets', () => {
    const before = read(filePath);
    const result = updateModelColumn({
      projectDir,
      modelName: 'orders',
      columnName: 'amount',
      patch: { expr: 'amount * 2', description: 'Doubled amount' },
    });
    expect(result.ok ? undefined : result.error).toBeUndefined();
    const after = read(filePath);
    expect(after.datasets[1]).toEqual(before.datasets[1]);
    expect(after.datasets[0]!.fields[1]!.expression).toEqual(
      before.datasets[0]!.fields[1]!.expression
    );
    expect(after.datasets[0]!.fields[1]).toMatchObject({ description: 'Doubled amount' });
    expect(JSON.parse(after.datasets[0]!.fields[1]!.custom_extensions[0]!.data)).toMatchObject({
      build_expression: 'amount * 2',
      sql_type: 'INTEGER',
    });
    expect(after.datasets[0]!.fields[1]!.custom_extensions[1]).toEqual(
      before.datasets[0]!.fields[1]!.custom_extensions[1]
    );
    expect(fs.readFileSync(filePath, 'utf8')).toContain('# Customer metadata');
  });

  it('updates grain and build settings in their owned extension and source field metadata', () => {
    expect(
      updateModel({
        projectDir,
        modelName: 'orders',
        patch: {
          grain: ['id', 'amount'],
          materialization: { type: 'view' },
          source: { ref: 'warehouse.raw', filter: 'id > 0' },
        },
      }).ok
    ).toBe(true);
    const data = JSON.parse(read(filePath).datasets[0]!.custom_extensions[0]!.data);
    expect(data).toMatchObject({
      grain: ['id', 'amount'],
      build: {
        materialization: { type: 'view' },
        source: { ref: 'warehouse.raw', filter: 'id > 0' },
      },
    });
    expect(
      updateSourceColumn({
        projectDir,
        sourceName: 'raw',
        connection: 'warehouse',
        columnName: 'id',
        patch: { description: 'Source identifier', pii: true },
      }).ok
    ).toBe(true);
    expect(read(filePath).datasets[1]!.fields[0]).toMatchObject({
      description: 'Source identifier',
    });
  });

  it('updates exact types together with their standard logical type', () => {
    expect(
      updateModelColumn({
        projectDir,
        modelName: 'orders',
        columnName: 'amount',
        patch: { type: 'DECIMAL(18,2)' },
      }).ok
    ).toBe(true);
    const updated = read(filePath).datasets[0]!.fields[1]!;
    expect(updated.datatype).toBe('Decimal');
    expect(JSON.parse(updated.custom_extensions[0]!.data).sql_type).toBe('DECIMAL(18,2)');
  });

  it('does not rewrite a no-op, and keeps JSON files as JSON', () => {
    const before = fs.readFileSync(filePath, 'utf8');
    expect(
      updateModel({
        projectDir,
        modelName: 'orders',
        patch: { description: 'Original description' },
      }).ok
    ).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    fs.unlinkSync(filePath);
    filePath = path.join(projectDir, 'sales.json');
    fs.writeFileSync(filePath, JSON.stringify(fixture()));
    expect(
      updateModel({
        projectDir,
        modelsDir: '.',
        modelName: 'orders',
        patch: { description: 'Changed' },
      }).ok
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).datasets[0].description).toBe('Changed');
  });

  it('adds and removes explicit fields and rejects removing a referenced key without writing', () => {
    const added = addModelColumn({
      projectDir,
      modelName: 'orders',
      column: { name: 'extra', expr: 'amount + 1' },
    });
    expect(added.ok ? undefined : added.error).toBeUndefined();
    expect(removeModelColumn({ projectDir, modelName: 'orders', columnName: 'extra' }).ok).toBe(
      true
    );
    const before = fs.readFileSync(filePath, 'utf8');
    expect(removeModelColumn({ projectDir, modelName: 'orders', columnName: 'id' }).ok).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('rejects an unknown parent or cycle before writing', () => {
    const before = fs.readFileSync(filePath, 'utf8');
    const missing = updateModel({
      projectDir,
      modelName: 'orders',
      patch: { source: { ref: 'warehouse.missing' } },
    });
    expect(missing.ok).toBe(false);
    const cyclic = updateModel({
      projectDir,
      modelName: 'orders',
      patch: { source: { ref: 'orders' } },
    });
    expect(cyclic.ok).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('does not turn an ephemeral query reference into a non-live view', () => {
    const document = fixture();
    document.datasets[0]!.source = 'bobsled://models/orders';
    document.datasets[0]!.custom_extensions[0] = nativeExtension({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: { source: { ref: 'warehouse.raw' }, materialization: { type: 'ephemeral' } },
    });
    fs.writeFileSync(filePath, YAML.stringify(document));
    const before = fs.readFileSync(filePath, 'utf8');
    const result = updateModel({
      projectDir,
      modelName: 'orders',
      patch: { materialization: { type: 'view' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('has no live source and is not ephemeral');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('reports duplicates across native and Ossie formats rather than choosing a file', () => {
    fs.writeFileSync(
      path.join(projectDir, 'other.yml'),
      'spec_version: "0.2"\ntype: model\nname: orders\n'
    );
    const result = updateModel({
      projectDir,
      modelName: 'orders',
      patch: { description: 'Changed' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Multiple model specs');
  });
});
