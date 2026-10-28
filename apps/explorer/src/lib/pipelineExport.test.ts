import { describe, expect, it } from 'vitest';

import {
  buildPipelineCliArgs,
  buildPipelineRunArgs,
  buildPipelineRunCommands,
  type PipelineConfig,
} from './pipelineExport.js';

describe('buildPipelineCliArgs', () => {
  it('uses the default DuckDB path when one is not provided', () => {
    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'duckdb' },
      })
    ).toEqual(['--integration', 'github', '--dest', 'duckdb', '--db-path', './pipeline.duckdb']);
  });

  it('preserves explicit destination settings across supported targets', () => {
    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'duckdb', db_path: './warehouse.duckdb' },
      })
    ).toEqual(['--integration', 'github', '--dest', 'duckdb', '--db-path', './warehouse.duckdb']);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'bigquery', project: 'analytics', dataset: 'raw_events' },
      })
    ).toEqual([
      '--integration',
      'github',
      '--dest',
      'bigquery',
      '--project-id',
      'analytics',
      '--dataset-id',
      'raw_events',
    ]);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'local', prefix: './exports' },
      })
    ).toEqual(['--integration', 'github', '--dest', 'local', '--output-dir', './exports']);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 's3', bucket: 'raw-bucket', prefix: 'github/events' },
      })
    ).toEqual([
      '--integration',
      'github',
      '--dest',
      's3',
      '--s3-bucket',
      'raw-bucket',
      '--s3-prefix',
      'github/events',
    ]);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'gcs', bucket: 'raw-bucket', prefix: 'github/events' },
      })
    ).toEqual([
      '--integration',
      'github',
      '--dest',
      'gcs',
      '--gcs-bucket',
      'raw-bucket',
      '--gcs-prefix',
      'github/events',
    ]);
  });

  it('fills in documented defaults for destination types that rely on placeholders', () => {
    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'bigquery' },
      })
    ).toEqual([
      '--integration',
      'github',
      '--dest',
      'bigquery',
      '--project-id',
      'my-project',
      '--dataset-id',
      'raw_data',
    ]);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'local' },
      })
    ).toEqual(['--integration', 'github', '--dest', 'local', '--output-dir', './output']);
  });

  it('omits optional cloud flags when bucket details are not provided', () => {
    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 's3' },
      })
    ).toEqual(['--integration', 'github', '--dest', 's3']);

    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'gcs' },
      })
    ).toEqual(['--integration', 'github', '--dest', 'gcs']);
  });

  it('renders every selected resource as a repeatable flag', () => {
    expect(
      buildPipelineCliArgs({
        integration: 'github',
        destination: { type: 'duckdb' },
        resources: ['issues', 'pull_requests'],
      })
    ).toEqual([
      '--integration',
      'github',
      '--dest',
      'duckdb',
      '--db-path',
      './pipeline.duckdb',
      '--resource',
      'issues',
      'pull_requests',
    ]);
  });
});

describe('buildPipelineRunArgs', () => {
  it('returns help when no integrations are selected', () => {
    const config: PipelineConfig = {
      selectedIntegrations: [],
      resources: {},
      destination: { type: 'duckdb' },
      schedule: '0 0 * * *',
    };

    expect(buildPipelineRunArgs(config)).toEqual({ command: 'pipeline', args: ['--help'] });
  });

  it('builds a runnable pipeline command for the first selected integration', () => {
    const config: PipelineConfig = {
      selectedIntegrations: ['github'],
      resources: { github: ['issues', 'pull_requests'] },
      destination: { type: 'bigquery', project: 'analytics', dataset: 'raw_events' },
      schedule: '0 0 * * *',
    };

    expect(buildPipelineRunArgs(config)).toEqual({
      command: 'pipeline',
      args: [
        '--integration',
        'github',
        '--dest',
        'bigquery',
        '--project-id',
        'analytics',
        '--dataset-id',
        'raw_events',
        '--resource',
        'issues',
        'pull_requests',
      ],
    });
  });

  it('returns a command sequence when multiple integrations are selected', () => {
    const config: PipelineConfig = {
      selectedIntegrations: ['stripe', 'hubspot'],
      resources: {
        stripe: ['customers'],
        hubspot: ['contacts'],
      },
      destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
      schedule: '0 0 * * *',
    };

    expect(buildPipelineRunCommands(config)).toEqual([
      {
        command: 'pipeline',
        args: [
          '--integration',
          'stripe',
          '--dest',
          'duckdb',
          '--db-path',
          './pipeline.duckdb',
          '--resource',
          'customers',
        ],
      },
      {
        command: 'pipeline',
        args: [
          '--integration',
          'hubspot',
          '--dest',
          'duckdb',
          '--db-path',
          './pipeline.duckdb',
          '--resource',
          'contacts',
        ],
      },
    ]);

    expect(buildPipelineRunArgs(config)).toEqual({
      sequence: buildPipelineRunCommands(config),
    });
  });
});
