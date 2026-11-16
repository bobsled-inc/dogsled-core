import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BobsledRuntimeError } from '@bobsled-inc/protocol';
import {
  compileProject,
  loadProject,
  selectIntegrationContexts,
  validateProject,
} from '../../../src/api/index.js';
import type { ResolvedIntegration } from '../../../src/integrations.js';

/**
 * When the caller supplies `opts.project`, the orchestrators must treat
 * `project.integrations` as authoritative for integration-handle discovery.
 * Re-reading `integrations/*.yml` from disk would defeat the
 * `loadProject({ skipIntegrations: true })` escape hatch hosts rely on for
 * pre-resolved (DB-backed, dynamically discovered) integration maps.
 */
describe('validateProject / compileProject — preloaded integrations bypass disk', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-model-spec-preloaded-'));

    fs.writeFileSync(
      path.join(tmpDir, 'model-spec.yml'),
      'sources_dir: sources\nmodels_dir: models\nintegrations_dir: integrations\n',
      'utf-8'
    );

    fs.mkdirSync(path.join(tmpDir, 'sources', 'ecom'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'sources', 'ecom', 'raw_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: raw_orders',
        'type: source',
        'source_type: warehouse_table',
        'connection: ecom',
        'table: RAW.RAW_ORDERS',
        'schema:',
        '  columns:',
        '    - name: ID',
        '      type: NUMBER',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.mkdirSync(path.join(tmpDir, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'description: Staging orders',
        'grain: order_id',
        'source:',
        '  ref: ecom.raw_orders',
        'columns:',
        '  - name: ORDER_ID',
        '    expr: ID',
        '    primary_key: true',
        'materialization:',
        '  type: view',
        '',
      ].join('\n'),
      'utf-8'
    );

    // Deliberately invalid on-disk integration YAML — strict Zod parse
    // (via @bobsled-inc/connections) would reject `source_type: not_a_dialect`.
    // Pre-fix, both `validateProject` and `compileProject(includeMetadata)`
    // re-read this file and surfaced the parse error even when callers passed
    // a pre-loaded project with a valid in-memory integrations map.
    fs.mkdirSync(path.join(tmpDir, 'integrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'integrations', 'ecom.yml'),
      [
        "spec_version: '1'",
        'type: integration',
        'name: ecom',
        'source_type: not_a_dialect',
        'connection: {}',
        'auth:',
        '  type: pat',
        '  token: tok-placeholder',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeInMemoryIntegration(handle: string): ResolvedIntegration {
    return {
      handle,
      dialect: 'duckdb',
      targetSchema: 'main',
      integration: {
        spec_version: '1',
        type: 'integration',
        name: handle,
        source_type: 'duckdb',
        connection: {},
        auth: { type: 'memory' },
      },
    };
  }

  it('validateProject honors pre-loaded integrations and does not re-read disk YAMLs', async () => {
    const project = await loadProject(tmpDir, { skipIntegrations: true });
    project.integrations.set('ecom', makeInMemoryIntegration('ecom'));

    // Sanity check: selectIntegrationContexts already honored the pre-loaded
    // project; the bug was that validateProject's listIntegrationHandles call
    // re-read disk. Both should pass cleanly now.
    expect(() => selectIntegrationContexts(project)).not.toThrow();

    const result = await validateProject(tmpDir, { project });
    expect(result.ok).toBe(true);
    expect(result.byIntegration.map((r) => r.handle)).toEqual(['ecom']);
  });

  it('compileProject({ includeMetadata: true }) honors pre-loaded integrations and does not re-read disk YAMLs', async () => {
    const project = await loadProject(tmpDir, { skipIntegrations: true });
    project.integrations.set('ecom', makeInMemoryIntegration('ecom'));

    const result = await compileProject(tmpDir, { project, includeMetadata: true });
    expect(result.ok).toBe(true);
    expect(result.byIntegration.map((r) => r.handle)).toEqual(['ecom']);
    expect(result.metadata).toBeDefined();
  });

  it('validateProject rejects an unknown --integration handle against the pre-loaded map', async () => {
    const project = await loadProject(tmpDir, { skipIntegrations: true });
    project.integrations.set('ecom', makeInMemoryIntegration('ecom'));

    const error = await validateProject(tmpDir, {
      project,
      integration: 'does_not_exist',
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      kind: 'validation',
      code: 'MODEL_PROJECT_VALIDATE_VALIDATION_FAILED',
      operation: 'model.project.validate',
    });
    expect((error as BobsledRuntimeError).cause).toMatchObject({
      message: expect.stringContaining('does_not_exist'),
    });
  });
});
