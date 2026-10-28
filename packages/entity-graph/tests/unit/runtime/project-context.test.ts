import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedIntegration } from '@bobsled-inc/model-spec/project';

import { loadEntityGraphProjectContext } from '../../../src/runtime/project-context.js';

let tmpDir: string;

const resolutionSpec = [
  `spec_version: '0.2'`,
  `name: company_resolution`,
  `type: resolution`,
  `description: Resolve companies.`,
  `inputs:`,
  `  - ref: raw.company`,
  `    id_fields: [id]`,
  `blocking:`,
  `  rules:`,
  `    - name: exact_name`,
  `      key: name`,
  `scoring:`,
  `  method: weighted_features`,
  `  features:`,
  `    - field: name`,
  `      algorithm: exact`,
  `      weight: 1`,
  `thresholds:`,
  `  auto_merge: 0.9`,
  `  review: 0.6`,
  `  auto_reject: 0.2`,
].join('\n');

function writeProject(): void {
  fs.mkdirSync(path.join(tmpDir, 'entity-graph'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'integrations'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'model-spec.yml'),
    [`entity_graph_dir: entity-graph`, `integrations_dir: integrations`].join('\n')
  );
  fs.writeFileSync(path.join(tmpDir, 'entity-graph/company_resolution.yml'), resolutionSpec);
  fs.writeFileSync(
    path.join(tmpDir, 'integrations/warehouse.yml'),
    [
      `spec_version: '1'`,
      `type: integration`,
      `name: warehouse`,
      `source_type: duckdb`,
      `connection:`,
      `  schema: warehouse_entity_graph`,
      `auth:`,
      `  type: memory`,
    ].join('\n')
  );
}

// The orchestrator-managed, slug-only source shape — no `source_type`
// discriminator, so the strict on-disk `IntegrationFileSchema` loader rejects it
// with an `invalid_union` error. A host that already holds the resolved
// connection in memory injects it via `resolvedIntegration` instead.
const slugOnlyIntegration = [
  `spec_version: '2'`,
  `type: source`,
  `name: dogsled_managed`,
  `dogsled_connection_ref: dogsled_managed`,
  `dogsled_source_kind: bigquery`,
  `transports: []`,
].join('\n');

function writeSlugOnlyIntegration(): void {
  fs.rmSync(path.join(tmpDir, 'integrations/warehouse.yml'));
  fs.writeFileSync(path.join(tmpDir, 'integrations/dogsled_managed.yml'), slugOnlyIntegration);
}

function makeInjectedIntegration(): ResolvedIntegration {
  return {
    handle: 'dogsled_managed',
    dialect: 'duckdb',
    targetSchema: 'injected_entity_graph',
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'dogsled_managed',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'memory' },
    },
  };
}

describe('loadEntityGraphProjectContext', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-project-context-'));
    writeProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('derives dialect and schema from the requested integration', async () => {
    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
      integration: 'warehouse',
    });

    expect(context.integration?.handle).toBe('warehouse');
    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('warehouse_entity_graph');
    expect(context.specs[0]?.targetSchema).toBe('warehouse_entity_graph');
  });

  it('auto-selects the only configured integration when no dialect is requested', async () => {
    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
    });

    expect(context.integration?.handle).toBe('warehouse');
    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('warehouse_entity_graph');
    expect(context.specs[0]?.targetSchema).toBe('warehouse_entity_graph');
  });

  it('auto-selects directory-style integrations when no dialect is requested', async () => {
    const flatSpec = fs.readFileSync(path.join(tmpDir, 'integrations/warehouse.yml'), 'utf-8');
    fs.rmSync(path.join(tmpDir, 'integrations/warehouse.yml'));
    fs.mkdirSync(path.join(tmpDir, 'integrations/warehouse'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'integrations/warehouse/integration.yml'), flatSpec);

    const context = await loadEntityGraphProjectContext({ cwd: tmpDir });

    expect(context.integration?.handle).toBe('warehouse');
    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('warehouse_entity_graph');
  });

  it('lets --schema override the integration output schema', async () => {
    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
      integration: 'warehouse',
      schema: 'entity_graph',
    });

    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('entity_graph');
    expect(context.specs[0]?.targetSchema).toBe('entity_graph');
  });

  it('keeps the legacy dialect and schema path without integration', async () => {
    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
      dialect: 'snowflake',
      schema: 'legacy_entity_graph',
    });

    expect(context.integration).toBeUndefined();
    expect(context.dialect).toBe('snowflake');
    expect(context.targetSchema).toBe('legacy_entity_graph');
    expect(context.specs[0]?.targetSchema).toBe('legacy_entity_graph');
  });

  it('rejects contradictory --dialect and --integration options', async () => {
    await expect(
      loadEntityGraphProjectContext({
        cwd: tmpDir,
        integration: 'warehouse',
        dialect: 'snowflake',
      })
    ).rejects.toThrow('--dialect cannot be combined with --integration');
  });

  it('rejects duplicate source columns before field metadata is built', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sources/raw'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'sources/raw/company.yml'),
      [
        `spec_version: '0.2'`,
        `name: company`,
        `type: source`,
        `source_type: warehouse_table`,
        `connection: warehouse`,
        `table: raw.company`,
        `schema:`,
        `  columns:`,
        `    - name: id`,
        `      type: string`,
        `    - name: id`,
        `      type: string`,
      ].join('\n')
    );

    await expect(loadEntityGraphProjectContext({ cwd: tmpDir })).rejects.toThrow(
      "Source warehouse.company declares duplicate column 'id'"
    );
  });

  it('uses an injected resolvedIntegration and skips the on-disk integration read', async () => {
    // The only integration on disk is the slug-only shape that the strict
    // loader rejects — proving the injected context bypasses the disk read.
    writeSlugOnlyIntegration();

    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
      integration: 'dogsled_managed',
      resolvedIntegration: makeInjectedIntegration(),
    });

    expect(context.integration?.handle).toBe('dogsled_managed');
    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('injected_entity_graph');
    expect(context.specs[0]?.targetSchema).toBe('injected_entity_graph');
  });

  it('throws on the slug-only integration shape when no resolvedIntegration is injected', async () => {
    writeSlugOnlyIntegration();

    await expect(
      loadEntityGraphProjectContext({ cwd: tmpDir, integration: 'dogsled_managed' })
    ).rejects.toThrow(/source_type/);
  });

  it('lets --schema override an injected resolvedIntegration output schema', async () => {
    writeSlugOnlyIntegration();

    const context = await loadEntityGraphProjectContext({
      cwd: tmpDir,
      resolvedIntegration: makeInjectedIntegration(),
      schema: 'override_schema',
    });

    expect(context.dialect).toBe('duckdb');
    expect(context.targetSchema).toBe('override_schema');
    expect(context.specs[0]?.targetSchema).toBe('override_schema');
  });

  it('rejects contradictory --dialect and resolvedIntegration options', async () => {
    await expect(
      loadEntityGraphProjectContext({
        cwd: tmpDir,
        resolvedIntegration: makeInjectedIntegration(),
        dialect: 'snowflake',
      })
    ).rejects.toThrow('--dialect cannot be combined with --integration');
  });
});
