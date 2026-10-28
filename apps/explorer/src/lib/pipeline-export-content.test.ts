import { describe, expect, it } from 'vitest';

import { generateCliCommands, renderPipelineCommand } from './pipeline-export-content';
import * as pipelineExports from './pipeline-export-content';
import { parse } from 'yaml';
import { generateDogsledYml } from './pipelineExport';
import type { PipelineConfig } from './pipelineExport';

const TEST_CONFIG: PipelineConfig = {
  selectedIntegrations: ['stripe'],
  resources: {
    stripe: ['customers'],
  },
  destination: { type: 'duckdb', db_path: './My Data/pipeline.duckdb' },
  schedule: 'every 4h',
};

describe('pipeline export content helpers', () => {
  it('quotes CLI arguments that contain spaces', () => {
    expect(
      renderPipelineCommand(['--db-path', './My Data/pipeline.duckdb', '--resource', 'customers'])
    ).toBe("dogsled pipeline --db-path './My Data/pipeline.duckdb' --resource customers");
  });

  it('exports no workflow generator or deploy bundle', () => {
    expect(Object.keys(pipelineExports).sort()).toEqual([
      'generateCliCommands',
      'renderPipelineCommand',
      'shellQuote',
    ]);
  });

  it('exports typed local pipeline configuration with no retired runner settings', () => {
    expect(parse(generateDogsledYml(TEST_CONFIG))).toEqual({
      destinations: { default: TEST_CONFIG.destination },
      pipelines: {
        stripe: {
          type: 'extract',
          source: 'stripe',
          destination: 'default',
          schedule: 'every 4h',
          resources: ['customers'],
        },
      },
    });
  });

  it('preserves an empty selection without inventing a resource wildcard', () => {
    expect(
      parse(generateDogsledYml({ ...TEST_CONFIG, resources: {} })).pipelines.stripe.resources
    ).toEqual([]);
  });

  it('uses positional SQL for load query snippets', () => {
    expect(generateCliCommands(TEST_CONFIG)).toContain(
      `dogsled load query --db-path './My Data/pipeline.duckdb' 'SELECT COUNT(*) FROM stripe__customers'`
    );
    expect(generateCliCommands(TEST_CONFIG)).not.toContain('--sql');
  });
});
