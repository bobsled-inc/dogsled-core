import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { loadProject, selectIntegrationContexts } from '../../../src/api/load-project.js';
import { validateOssieBindings } from '../../../src/api/ossie-bindings.js';
import { buildDagContext } from '../../../src/commands/common.js';
import { resolveProjectIndex } from '@bobsled-inc/project-index';

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);
const extension = (data: object) => [{ vendor_name: 'BOBSLED', data: JSON.stringify(data) }];
function project(source = 'main.clean_orders') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ossie-load-'));
  roots.push(root);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), stringify(value));
  write('warehouse.yml', {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: path.join(root, 'data.duckdb') },
  });
  write('raw.yml', {
    spec_version: '0.2',
    type: 'source',
    source_type: 'warehouse_table',
    name: 'raw_orders',
    connection: 'warehouse',
    table: 'main.raw_orders',
    schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
  });
  const document = {
    version: '0.2.0.dev0',
    name: 'sales',
    datasets: [
      {
        name: 'clean_orders',
        description: 'Clean orders',
        source,
        fields: [
          {
            name: 'id',
            datatype: 'Integer',
            expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] },
            custom_extensions: extension({ build_expression: 'id', sql_type: 'INTEGER' }),
          },
        ],
        custom_extensions: extension({
          extension_version: '1',
          kind: 'derived',
          grain: ['id'],
          build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'table' } },
        }),
      },
    ],
  };
  write('semantic.yml', document);
  write('downstream.yml', {
    spec_version: '0.2',
    type: 'model',
    name: 'downstream',
    description: 'Reads Ossie',
    grain: 'id',
    source: { ref: 'clean_orders' },
    columns: [{ name: 'id', expr: 'id' }],
    materialization: { type: 'view' },
  });
  return { root, write, document };
}

describe('Ossie project loading', () => {
  it('feeds mixed native and Ossie models through the shared DAG and CLI loaders', async () => {
    const { root } = project();
    const loaded = await loadProject(root);
    expect(loaded.models.map((n) => n.name)).toEqual(['clean_orders', 'downstream']);
    expect(loaded.models[1].refs).toEqual(['clean_orders']);
    expect(selectIntegrationContexts(loaded)[0].modelReg.get('clean_orders')).toBe(
      'main.clean_orders'
    );
    const cli = buildDagContext(
      { cwd: root, index: resolveProjectIndex(root), verbose: false, quiet: true },
      []
    );
    expect(cli.orderedNodes.map((n) => n.name)).toEqual(['clean_orders', 'downstream']);
  });
  it('rejects output destination drift before compilation or execution', async () => {
    const { root } = project('other.clean_orders');
    const loaded = await loadProject(root);
    expect(() => selectIntegrationContexts(loaded)).toThrow(
      /declares source "other.clean_orders".*resolves its output to "main.clean_orders"/
    );
  });
  it('uses DuckDB identifier case rules for the declared address', async () => {
    const { root } = project('MAIN.CLEAN_ORDERS');
    const awaited = await loadProject(root);
    expect(() => selectIntegrationContexts(awaited)).not.toThrow();
  });
  it('distinguishes quoted case-sensitive Snowflake addresses', async () => {
    const { root } = project('"MAIN"."CLEAN_ORDERS"');
    const loaded = await loadProject(root);
    expect(() =>
      validateOssieBindings(
        loaded.models,
        new Map([['clean_orders', 'MAIN.CLEAN_ORDERS']]),
        'snowflake'
      )
    ).not.toThrow();
    expect(() =>
      validateOssieBindings(
        loaded.models,
        new Map([['clean_orders', '"main"."clean_orders"']]),
        'snowflake'
      )
    ).toThrow(/resolves its output/);
  });
  it('rejects a query reference for a view with no live parent', async () => {
    const { root, write, document } = project('bobsled://models/clean_orders');
    document.datasets[0].custom_extensions = extension({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'view' } },
    });
    write('semantic.yml', document);
    await expect(loadProject(root)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('has no live source and is not ephemeral'),
      }),
    });
  });
  it('accepts a query reference when an existing live API source drives the model', async () => {
    const { root, write, document } = project('bobsled://models/clean_orders');
    write('raw.yml', {
      spec_version: '0.2',
      type: 'source',
      source_type: 'api_resource',
      name: 'raw_orders',
      connection: 'warehouse',
      integration: 'orders_api',
      resource: 'orders',
      mode: 'live',
      schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
    });
    document.datasets[0].custom_extensions = extension({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'view' } },
    });
    write('semantic.yml', document);
    const loaded = await loadProject(root, { skipIntegrations: true });
    expect(loaded.models[0].materialization).toBe('view');
  });
  it('accepts a project-local ephemeral model and resolves its downstream reference', async () => {
    const { root, write, document } = project('bobsled://models/clean_orders');
    document.datasets[0].custom_extensions = extension({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'ephemeral' } },
    });
    write('semantic.yml', document);
    const loaded = await loadProject(root);
    expect(loaded.models[0].materialization).toBe('ephemeral');
    expect(() => selectIntegrationContexts(loaded)).not.toThrow();
  });
  it('checks published output against the publish schema override', async () => {
    const { root, write, document } = project('published.clean_orders');
    document.datasets[0].custom_extensions = extension({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: {
        source: { ref: 'warehouse.raw_orders' },
        materialization: { type: 'table' },
        publish: { target: 'warehouse', target_schema: 'published' },
      },
    });
    write('semantic.yml', document);
    const loaded = await loadProject(root);
    expect(() => selectIntegrationContexts(loaded)).not.toThrow();
    document.datasets[0].source = 'wrong.clean_orders';
    write('semantic.yml', document);
    const changed = await loadProject(root);
    expect(() => selectIntegrationContexts(changed)).toThrow(/published.*clean_orders/);
  });
  it('reports duplicates across authoring formats using shared identity validation', async () => {
    const { root, write } = project();
    write('duplicate.yml', {
      spec_version: '0.2',
      type: 'model',
      name: 'clean_orders',
      description: 'Duplicate',
      grain: 'id',
      source: { ref: 'warehouse.raw_orders' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'table' },
    });
    await expect(loadProject(root)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/Duplicate model name/) }),
    });
  });
});
