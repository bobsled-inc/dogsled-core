import { describe, expect, it } from 'vitest';

import { buildLoadArgsForDestination } from '../../../src/commands/pipeline-load-args.js';

import type { PipelineOptions } from '../../../src/commands/pipeline.js';
import type { NamedDestination } from '../../../src/runner/config/schema.js';

describe('buildLoadArgsForDestination', () => {
  it('makes invocation full refresh authoritative over a named destination strategy', () => {
    const destination: NamedDestination = {
      name: 'warehouse',
      type: 'snowflake',
      account: 'demo',
      username: 'demo_user',
      password: 'secret',
      warehouse: 'demo_wh',
      database: 'analytics',
      load_strategy: 'append',
    };
    const options: PipelineOptions = {
      integration: 'github',
      outputDir: './output',
      fullRefresh: true,
      loadStrategy: 'full_refresh',
      reconcileSchema: ['issues'],
    };

    const args = buildLoadArgsForDestination(destination, options, {});

    expect(args).toEqual(expect.arrayContaining(['--load-strategy', 'full_refresh']));
    expect(args).toEqual(expect.arrayContaining(['--reconcile-schema', 'issues']));
    expect(args).not.toContain('append');
  });

  it('prefers pipeline and resource load strategies over a named destination strategy', () => {
    const destination: NamedDestination = {
      name: 'warehouse',
      type: 'duckdb',
      db_path: './data.duckdb',
      load_strategy: 'append',
    };
    const args = buildLoadArgsForDestination(
      destination,
      {
        integration: 'github',
        outputDir: './output',
        loadStrategy: 'merge',
        resourceLoadStrategy: { issues: 'full_refresh' },
      },
      {}
    );

    expect(args).toEqual(expect.arrayContaining(['--load-strategy', 'merge']));
    expect(args).toEqual(expect.arrayContaining(['--stream-load-strategy', 'issues:full_refresh']));
    expect(args).not.toContain('append');
  });

  it('falls back to a named destination load strategy when the pipeline omits one', () => {
    const destination: NamedDestination = {
      name: 'warehouse',
      type: 'duckdb',
      db_path: './data.duckdb',
      load_strategy: 'merge',
    };

    const args = buildLoadArgsForDestination(
      destination,
      { integration: 'github', outputDir: './output' },
      {}
    );

    expect(args).toEqual(expect.arrayContaining(['--load-strategy', 'merge']));
  });

  it('forwards pipeline and per-resource schema behaviors with destination fallback', () => {
    const destination: NamedDestination = {
      name: 'warehouse',
      type: 'duckdb',
      db_path: './data.duckdb',
      schema_behavior: 'freeze',
    };
    const args = buildLoadArgsForDestination(
      destination,
      {
        integration: 'github',
        outputDir: './output',
        schemaBehavior: 'strict',
        resourceSchemaBehavior: { issues: 'evolve' },
      },
      {}
    );

    expect(args).toEqual(expect.arrayContaining(['--schema-behavior', 'strict']));
    expect(args).toEqual(expect.arrayContaining(['--stream-schema-behavior', 'issues:evolve']));
    expect(args).not.toContain('freeze');
  });

  it('forwards a destination schema behavior when no pipeline override is set', () => {
    const destination: NamedDestination = {
      name: 'warehouse',
      type: 'duckdb',
      db_path: './data.duckdb',
      schema_behavior: 'strict',
    };

    const args = buildLoadArgsForDestination(
      destination,
      { integration: 'github', outputDir: './output' },
      {}
    );

    expect(args).toEqual(expect.arrayContaining(['--schema-behavior', 'strict']));
  });
});
