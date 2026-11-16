import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { scanProject } from '@bobsled-inc/project-index';
import { resolveOssieExportAddresses } from '../../src/api/ossie-export-addresses.js';
import { exportOssieDocuments, importOssieDocument } from '../../src/interchange/index.js';
import { SourceSpecSchema, TransformSpecSchema } from '../../src/compiler/schemas.js';
import { registerOssieCommand } from '../../src/commands/ossie.js';

const roots: string[] = [];
afterEach(() => {
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});
const integration = (name: string, schema: string, database?: string) => ({
  spec_version: '1',
  type: 'integration',
  name,
  source_type: 'duckdb',
  connection: { schema, ...(database ? { database } : {}) },
  auth: { type: 'file', path: './never-opened.duckdb' },
});
const source = (connection = 'warehouse') => ({
  spec_version: '0.2',
  type: 'source',
  name: 'raw',
  connection,
  source_type: 'warehouse_table',
  table: 'raw_schema.orders',
  schema: { columns: [{ name: 'id', type: 'BIGINT' }] },
});
const model = (name = 'orders', connection = 'warehouse') => ({
  spec_version: '0.2',
  type: 'model',
  name,
  description: 'Orders',
  grain: ['id'],
  source: { ref: `${connection}.raw` },
  materialization: { type: 'table' },
  columns: [{ name: 'id', expr: 'id' }],
});
const agenticModel = (name = 'researched_orders') => ({
  spec_version: '0.2',
  type: 'model',
  model_kind: 'agentic',
  name,
  description: 'Orders enriched by an agent',
  grain: ['id'],
  sources: { orders: { ref: 'warehouse.raw' } },
  llm: { profile: 'review' },
  plan: {
    steps: [
      {
        id: 'research',
        source: { ref: 'orders' },
        execution: { mode: 'llm_call' },
        instructions: 'Summarize the order.',
        map: { over: 'orders', group_by: ['id'] },
        columns: [{ name: 'id', type: 'integer', nullable: false }],
      },
    ],
  },
  output: { from: 'research' },
  materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['id'] },
});
async function setup(documents: Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'ossie-addresses-'));
  roots.push(root);
  documents.forEach((doc, i) => writeFileSync(join(root, `${i}.yml`), JSON.stringify(doc)));
  return { root, index: await scanProject(root) };
}
it('uses compiler targets, model overrides and source table bindings without an address map', async () => {
  const src = source(),
    derived = { ...model(), target_schema: 'curated', target_database: 'reporting' };
  const { root, index } = await setup([integration('warehouse', 'analytics'), src, derived]);
  const addresses = await resolveOssieExportAddresses(root, index, [
    { path: 'model.yml', document: derived },
    { path: 'source.yml', document: src },
  ]);
  expect(addresses).toEqual({
    orders: '"reporting"."curated"."orders"',
    'warehouse.raw': 'raw_schema.orders',
  });
});
it('resolves different models through their own integrations', async () => {
  const a = model('a', 'first'),
    b = model('b', 'second');
  const { root, index } = await setup([
    integration('first', 'one'),
    integration('second', 'two'),
    source('first'),
    source('second'),
    a,
    b,
  ]);
  expect(
    await resolveOssieExportAddresses(root, index, [
      { path: 'a.yml', document: a },
      { path: 'b.yml', document: b },
    ])
  ).toEqual({ a: 'one.a', b: 'two.b' });
});
it('resolves an agentic model through its output integration', async () => {
  const agentic = agenticModel();
  const { root, index } = await setup([integration('warehouse', 'analytics'), source(), agentic]);
  expect(
    await resolveOssieExportAddresses(root, index, [{ path: 'agentic.yml', document: agentic }])
  ).toEqual({ researched_orders: 'analytics.researched_orders' });
});
it('uses the publish destination rather than the execution location', async () => {
  const derived = {
    ...model(),
    publish: { target: 'destination', target_schema: 'published', target_database: 'final_db' },
  };
  const { root, index } = await setup([
    integration('warehouse', 'engine'),
    integration('destination', 'fallback'),
    source(),
    derived,
  ]);
  expect(
    await resolveOssieExportAddresses(root, index, [{ path: 'model.yml', document: derived }])
  ).toEqual({ orders: '"final_db"."published"."orders"' });
});
it('keeps ephemeral references project-local and resolves configured schema variables', async () => {
  vi.stubEnv('OSSIE_EXPORT_SCHEMA', 'configured');
  const ephemeral = { ...model('temporary'), materialization: { type: 'ephemeral' } },
    persisted = model();
  const { root, index } = await setup([
    integration('warehouse', '${{ env.OSSIE_EXPORT_SCHEMA }}'),
    source(),
    ephemeral,
    persisted,
  ]);
  expect(
    await resolveOssieExportAddresses(root, index, [
      { path: 'e.yml', document: ephemeral },
      { path: 'p.yml', document: persisted },
    ])
  ).toEqual({ temporary: 'bobsled://models/temporary', orders: 'configured.orders' });
});
it('fails without project integration bindings instead of guessing an address', async () => {
  const derived = model();
  const { root, index } = await setup([source(), derived]);
  await expect(
    resolveOssieExportAddresses(root, index, [{ path: 'model.yml', document: derived }])
  ).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining('No integrations found') }),
  });
});
it('rejects the removed --addresses flag', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const command = new Command().exitOverride();
  registerOssieCommand(command);
  await expect(
    command.parseAsync(['ossie', 'export', '--name', 'sales', '--addresses', 'unused.yml'], {
      from: 'user',
    })
  ).rejects.toMatchObject({ code: 'commander.unknownOption' });
});

it('exports exact CLI selectors through the versioned converter', async () => {
  const derived = model();
  const src = source();
  const { root } = await setup([integration('warehouse', 'analytics'), src, derived]);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const command = new Command();
  registerOssieCommand(command);

  await command.parseAsync(
    [
      'ossie',
      'export',
      'model:orders',
      'source:warehouse.raw',
      '--project',
      root,
      '--name',
      'sales',
      '--ossie-version',
      '0.2.0.dev0',
    ],
    { from: 'user' }
  );

  const report = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(''));
  expect(report).toMatchObject({ ok: true, ready: true });
  expect(report.files[0].document).toMatchObject({
    version: '0.2.0.dev0',
    name: 'sales',
  });
  expect(
    report.files[0].document.datasets.map((dataset: { name: string }) => dataset.name)
  ).toEqual(['orders', 'raw']);
});

it('includes agentic models in catalog-only CLI exports', async () => {
  const agentic = agenticModel();
  const { root } = await setup([integration('warehouse', 'analytics'), source(), agentic]);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const command = new Command();
  registerOssieCommand(command);

  await command.parseAsync(
    [
      'ossie',
      'export',
      'model:researched_orders',
      '--project',
      root,
      '--name',
      'sales',
      '--ossie-version',
      '0.2.0.dev0',
    ],
    { from: 'user' }
  );

  const report = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(''));
  expect(report).toMatchObject({ ok: true, ready: true });
  expect(report.files[0].document.datasets).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'researched_orders' })])
  );
  expect(report.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'catalog_only_export' })])
  );
});

it('writes the default 0.1.1 CLI profile to one requested file', async () => {
  const { root } = await setup([integration('warehouse', 'analytics'), source(), model()]);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const command = new Command();
  registerOssieCommand(command);
  const output = join(root, 'sales.ossie.yml');

  await command.parseAsync(
    ['ossie', 'export', '--all', '--project', root, '--name', 'sales', '--out', output],
    { from: 'user' }
  );

  const content = readFileSync(output, 'utf8');
  expect(content).toContain('version: 0.1.1');
  expect(content).toContain('semantic_model:');
  expect(content).not.toContain('BOBSLED');
});

it('keeps a strict CLI export as a preview when conversion reports warnings', async () => {
  const { root } = await setup([integration('warehouse', 'analytics'), source(), model()]);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const command = new Command();
  registerOssieCommand(command);
  const output = join(root, 'strict.ossie.yml');

  await command.parseAsync(
    ['ossie', 'export', '--all', '--project', root, '--name', 'sales', '--strict', '--out', output],
    { from: 'user' }
  );

  const report = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(''));
  expect(report).toMatchObject({ ok: true, ready: false });
  expect(report.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ severity: 'warning' })])
  );
  expect(process.exitCode).toBe(2);
  expect(existsSync(output)).toBe(false);
});

it('resolves a Snowflake database and schema without resolving auth or opening a warehouse', async () => {
  const derived = model();
  const snowflake = {
    auth_env_vars: ['OSSIE_UNSET_ACCOUNT', 'OSSIE_UNSET_TOKEN', 'OSSIE_UNSET_USER'],
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'snowflake',
    connection: {
      account_identifier: '${{ env.OSSIE_UNSET_ACCOUNT }}',
      user: '${{ env.OSSIE_UNSET_USER }}',
      warehouse: 'COMPUTE_WH',
      role: 'READER',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
    },
    auth: { type: 'pat', token: '${{ env.OSSIE_UNSET_TOKEN }}' },
  };
  const { root, index } = await setup([snowflake, source(), derived]);
  expect(
    await resolveOssieExportAddresses(root, index, [{ path: 'orders.yml', document: derived }])
  ).toEqual({ orders: '"ANALYTICS"."PUBLIC"."ORDERS"' });
});
it('uses a project-local reference for a live model', async () => {
  const { table: _table, ...base } = source();
  const liveSource = {
    ...base,
    source_type: 'api_resource',
    integration: 'service',
    resource: 'orders',
    mode: 'live',
  };
  const derived = { ...model(), materialization: { type: 'view' } };
  const { root, index } = await setup([integration('warehouse', 'main'), liveSource, derived]);
  const inputs = [
    { path: 'source.yml', document: liveSource },
    { path: 'orders.yml', document: derived },
  ];
  const addresses = await resolveOssieExportAddresses(root, index, inputs);
  expect(addresses).toEqual({ orders: 'bobsled://models/orders' });
  const exported = exportOssieDocuments(inputs, { addresses });
  expect(exported.diagnostics).toEqual([]);
  const imported = importOssieDocument(exported.files[0]!.document, { sourcePath: 'live.yml' });
  expect(imported.ready).toBe(true);
  const restoredSource = imported.files.find((f) => f.document.type === 'source')!.document;
  const restoredModel = imported.files.find((f) => f.document.type === 'model')!.document;
  const { interchange: _sourceMetadata, ...sourceBehavior } =
    SourceSpecSchema.parse(restoredSource);
  const { interchange: _modelMetadata, ...modelBehavior } =
    TransformSpecSchema.parse(restoredModel);
  const identityExpression = {
    dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }],
  };
  expect(sourceBehavior).toEqual(
    SourceSpecSchema.parse({
      ...liveSource,
      schema: {
        columns: [
          {
            ...liveSource.schema.columns[0],
            semantic_expression: identityExpression,
          },
        ],
      },
    })
  );
  expect(modelBehavior).toEqual(
    TransformSpecSchema.parse({
      ...derived,
      columns: [
        {
          ...derived.columns[0],
          semantic_expression: identityExpression,
        },
      ],
    })
  );
});

it('resolves explicit BigQuery targets without opening a connection', async () => {
  const bigquery = {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'bigquery',
    connection: { project_id: 'test-project', dataset: 'Analytics', default_location: 'US' },
    auth: { type: 'adc' },
  };
  const derived = { ...model('Orders'), target_database: 'reporting', target_schema: 'Analytics' };
  const { root, index } = await setup([bigquery, source(), derived]);
  expect(
    await resolveOssieExportAddresses(root, index, [{ path: 'model.yml', document: derived }])
  ).toEqual({ Orders: '`reporting`.`analytics`.`orders`' });
});
