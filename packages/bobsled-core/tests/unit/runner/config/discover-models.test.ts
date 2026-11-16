/**
 * Tests for the v3 diskless metadata contract:
 *   - `discoverModels` now collects per-model `refs` (bare model deps) and
 *     `tags` alongside `connection` + `materialization`.
 *   - `expandAuthoredModelPipelines` / `computeSyntheticModelPipelines` populate
 *     `ExpandedModelPipeline.modelNodes`, intersecting refs with the pipeline's
 *     own model set so cross-pipeline refs can't create dangling v3 edges.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { indexProjectFiles } from '@bobsled-inc/project-index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeSyntheticModelPipelines,
  discoverModels,
  expandAuthoredModelPipelines,
  type DiscoveredModel,
  type ResolvedModelPipeline,
} from '../../../../src/runner/config/loader.js';
import type { BobsledConfig } from '../../../../src/runner/config/schema.js';

describe('discoverModels — scan limits', () => {
  it('refuses an index that stopped at a limit instead of dropping models', () => {
    const model = (name: string) => `spec_version: '0.2'\ntype: model\nname: ${name}\n`;
    const index = indexProjectFiles(
      [
        { path: 'models/a.yml', content: model('a') },
        { path: 'models/b.yml', content: model('b') },
      ],
      { maxFiles: 1 }
    );

    expect(() => discoverModels(index)).toThrow(/more than 1 YAML, JSON, and Markdown files/);
  });
});

describe('discoverModels — native compatibility', () => {
  it('still skips malformed native files while discovering valid native models', () => {
    const index = indexProjectFiles([
      { path: 'models/broken.yml', content: 'type: model\ncolumns: [\n' },
      { path: 'models/valid.yml', content: 'type: model\nname: valid\nsource: {ref: wh.raw}\n' },
    ]);
    expect(discoverModels(index).get('valid')?.connection).toBe('wh');
  });

  it('refuses an Ossie candidate that exceeded the read limit', () => {
    const index = indexProjectFiles(
      [{ path: 'domain/model.yml', content: 'version: 0.2.0.dev0\nname: orders\ndatasets: []\n' }],
      { maxFileBytes: 10 }
    );
    expect(() => discoverModels(index)).toThrow(/limit is 10/);
  });
});

describe('discoverModels — refs + tags', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-models-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeModel = (file: string, lines: string[]): void => {
    fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
  };

  it('collects bare model refs from source/joins/union and drops dotted source refs', () => {
    writeModel('stg_orders.yml', [
      "spec_version: '0.2'",
      'name: stg_orders',
      'type: model',
      'source:',
      '  ref: ecom.raw_orders',
    ]);
    writeModel('stg_customers.yml', [
      "spec_version: '0.2'",
      'name: stg_customers',
      'type: model',
      'source:',
      '  ref: ecom.raw_customers',
    ]);
    writeModel('fct_orders.yml', [
      "spec_version: '0.2'",
      'name: fct_orders',
      'type: model',
      'source:',
      '  ref: stg_orders',
      'joins:',
      '  - ref: stg_customers',
      '  - ref: ecom.raw_regions', // dotted = source, NOT a model edge
      'tags:',
      '  - finance',
      '  - nightly',
      'materialization:',
      '  type: table',
    ]);

    const models = discoverModels(dir);

    expect(models.get('fct_orders')?.refs).toEqual(['stg_orders', 'stg_customers']);
    expect(models.get('fct_orders')?.tags).toEqual(['finance', 'nightly']);
    expect(models.get('fct_orders')?.materialization).toBe('table');
    // A model whose only ref is a source has no model edges and no tags.
    expect(models.get('stg_orders')?.refs).toEqual([]);
    expect(models.get('stg_orders')?.tags).toBeUndefined();
  });

  it('de-duplicates repeated model refs across source + union', () => {
    writeModel('a.yml', [
      "spec_version: '0.2'",
      'name: a',
      'type: model',
      'source:',
      '  ref: ecom.raw',
    ]);
    writeModel('b.yml', [
      "spec_version: '0.2'",
      'name: b',
      'type: model',
      'source:',
      '  ref: a',
      'union:',
      '  - ref: a', // duplicate model ref
    ]);
    const models = discoverModels(dir);
    expect(models.get('b')?.refs).toEqual(['a']);
  });
});

describe('expandAuthoredModelPipelines / computeSyntheticModelPipelines — modelNodes', () => {
  const models = new Map<string, DiscoveredModel>([
    ['stg', { connection: 'wh', materialization: 'view', refs: [], tags: ['staging'] }],
    // `external` is not in any pipeline below → its edge must be dropped.
    ['fct', { connection: 'wh', materialization: 'table', refs: ['stg', 'external'] }],
  ]);

  it('builds modelNodes with refs intersected to the pipeline set and tags carried verbatim', () => {
    const pipelines: ResolvedModelPipeline[] = [
      {
        name: 'wh_pipe',
        schedule: 'hourly',
        cron: '0 * * * *',
        trigger: 'schedule',
        connection: 'wh',
        models: ['stg', 'fct'],
        enabled: true,
      },
    ];
    const [expanded] = expandAuthoredModelPipelines(pipelines, models);
    expect(expanded?.modelNodes).toEqual([
      { name: 'stg', refs: [], tags: ['staging'] },
      { name: 'fct', refs: ['stg'] }, // `external` dropped, no tags
    ]);
  });

  it('intersects refs within a synthetic orphan pipeline too', () => {
    // No authored pipeline claims anything; `fct` (table) is an orphan, `stg`
    // (view) is not orphan-eligible — so the synthetic pipeline holds only fct,
    // and fct's ref to stg (not in the synthetic set) is dropped.
    const config = { defaults: { models: { schedule: 'daily' } } } as BobsledConfig;
    const synthetic = computeSyntheticModelPipelines(config, [], models);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]?.name).toBe('_models_default_wh');
    expect(synthetic[0]?.models).toEqual(['fct']);
    expect(synthetic[0]?.modelNodes).toEqual([{ name: 'fct', refs: [] }]);
  });

  it('claims orphans case-insensitively (authored name case may differ from the spec key)', () => {
    // A pipeline claims `FCT` (uppercase) while the discovered key is `fct`.
    // `fct` (table) must NOT be re-emitted as a synthetic orphan.
    const pipelines: ResolvedModelPipeline[] = [
      {
        name: 'wh_pipe',
        schedule: 'hourly',
        cron: '0 * * * *',
        trigger: 'schedule',
        connection: 'wh',
        models: ['FCT'],
        enabled: true,
      },
    ];
    const expanded = expandAuthoredModelPipelines(pipelines, models);
    const config = { defaults: { models: { schedule: 'daily' } } } as BobsledConfig;
    const synthetic = computeSyntheticModelPipelines(config, expanded, models);
    expect(synthetic).toHaveLength(0);
  });
});

describe('discoverModels — Ossie', () => {
  it('discovers translated models and resolves references across both formats', () => {
    const index = indexProjectFiles([
      {
        path: 'domain/native.yml',
        content: 'type: model\nname: upstream\nsource: {ref: warehouse.raw_orders}\n',
      },
      {
        path: 'domain/semantic.json',
        content: JSON.stringify({
          version: '0.2.0.dev0',
          name: 'sales',
          datasets: [
            {
              name: 'orders',
              source: 'analytics.sales.orders',
              description: 'Orders',
              fields: [
                {
                  name: 'order_id',
                  custom_extensions: [
                    {
                      vendor_name: 'DOGSLED',
                      data: JSON.stringify({ build_expression: 'order_id' }),
                    },
                  ],
                  expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'order_id' }] },
                },
              ],
              custom_extensions: [
                {
                  vendor_name: 'DOGSLED',
                  data: JSON.stringify({
                    extension_version: '1',
                    kind: 'derived',
                    grain: ['order_id'],
                    build: { source: { ref: 'upstream' }, materialization: { type: 'table' } },
                  }),
                },
              ],
            },
          ],
        }),
      },
    ]);
    expect(discoverModels(index).get('orders')).toMatchObject({
      connection: 'warehouse',
      materialization: 'table',
      refs: ['upstream'],
    });
  });
});
