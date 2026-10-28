import { describe, expect, it } from 'vitest';

import {
  collectStreamLoadStrategy,
  collectStreamSchemaBehavior,
  collectStreamTableOwnershipMarker,
  collectStreamTable,
  parseStreamLoadStrategyPair,
  parseStreamSchemaBehaviorPair,
  parseStreamTableOwnershipMarkerPair,
  parseStreamTablePair,
  resolveStreamSchemaBehaviorOverrides,
  resolveStreamTableOwnershipMarkerOverrides,
  resolveStreamStrategyOverrides,
} from '../../../src/commands/stream-overrides.js';

describe('stream override parsing', () => {
  it('parses and accumulates load-strategy, schema-behavior, table, and ownership pairs', () => {
    expect(parseStreamLoadStrategyPair('issues:full_refresh')).toEqual({
      stream: 'issues',
      strategy: 'full_refresh',
    });
    expect(parseStreamTablePair('issues:raw_issues')).toEqual({
      stream: 'issues',
      table: 'raw_issues',
    });
    expect(parseStreamSchemaBehaviorPair('issues:strict')).toEqual({
      stream: 'issues',
      schemaBehavior: 'strict',
    });
    expect(parseStreamTableOwnershipMarkerPair('issues:temp-dataset-123')).toEqual({
      stream: 'issues',
      marker: 'temp-dataset-123',
    });
    expect(parseStreamTableOwnershipMarkerPair('issues:opaque-owner-v2')).toEqual({
      stream: 'issues',
      marker: 'opaque-owner-v2',
    });
    expect(collectStreamLoadStrategy('pull_requests:merge', { issues: 'append' })).toEqual({
      issues: 'append',
      pull_requests: 'merge',
    });
    expect(collectStreamTable('pull_requests:raw_prs', { issues: 'raw_issues' })).toEqual({
      issues: 'raw_issues',
      pull_requests: 'raw_prs',
    });
    expect(collectStreamSchemaBehavior('pull_requests:freeze', { issues: 'strict' })).toEqual({
      issues: 'strict',
      pull_requests: 'freeze',
    });
    expect(
      collectStreamTableOwnershipMarker('pull_requests:temp-dataset-456', {
        issues: 'temp-dataset-123',
      })
    ).toEqual({
      issues: 'temp-dataset-123',
      pull_requests: 'temp-dataset-456',
    });
  });

  it('rejects invalid strategies and unsafe table names', () => {
    expect(() => parseStreamLoadStrategyPair('issues:replace')).toThrow(/invalid load strategy/);
    expect(() => parseStreamSchemaBehaviorPair('issues:ignore')).toThrow(
      /invalid schema behavior.*evolve, strict, freeze/
    );
    expect(() => parseStreamTablePair('issues:raw.issues')).toThrow(/invalid table name/);
    expect(() => parseStreamTablePair('issues:_dogsled_stg_issues')).toThrow(/reserved/);
    expect(() => parseStreamTableOwnershipMarkerPair('issues: marker')).toThrow(/marker/);
    expect(() => parseStreamTableOwnershipMarkerPair(`issues:${'x'.repeat(257)}`)).toThrow(
      /256 characters/
    );
  });
});

describe('resolveStreamTableOwnershipMarkerOverrides', () => {
  it('keys markers by the final overridden table name', () => {
    const tableByStream = new Map([['issues', 'DS_CSV_aB12cD']]);
    const resolved = resolveStreamTableOwnershipMarkerOverrides(
      { issues: 'temp-dataset-123' },
      (stream) => tableByStream.get(stream) ?? `github__${stream}`
    );

    expect(resolved).toEqual(new Map([['DS_CSV_aB12cD', 'temp-dataset-123']]));
  });

  it('rejects conflicting markers when two streams resolve to one table', () => {
    expect(() =>
      resolveStreamTableOwnershipMarkerOverrides(
        { issues: 'temp-dataset-123', pull_requests: 'temp-dataset-456' },
        () => 'shared_table'
      )
    ).toThrow(/Conflicting per-stream table ownership markers/);
  });
});

describe('resolveStreamSchemaBehaviorOverrides', () => {
  it('keys schema behaviors by the final overridden table name', () => {
    const tableByStream = new Map([['issues', 'raw_issues']]);
    const resolved = resolveStreamSchemaBehaviorOverrides({ issues: 'strict' }, (stream) => {
      return tableByStream.get(stream) ?? `github__${stream}`;
    });

    expect(resolved).toEqual(new Map([['raw_issues', 'strict']]));
  });

  it('rejects conflicting schema behaviors when two streams resolve to one table', () => {
    expect(() =>
      resolveStreamSchemaBehaviorOverrides(
        { issues: 'strict', pull_requests: 'freeze' },
        () => 'shared_table'
      )
    ).toThrow(/Conflicting per-stream schema behaviors/);
  });
});

describe('resolveStreamStrategyOverrides', () => {
  it('keys strategies by the final overridden table name', () => {
    const tableByStream = new Map([['issues', 'raw_issues']]);
    const resolved = resolveStreamStrategyOverrides({ issues: 'merge' }, (stream) => {
      return tableByStream.get(stream) ?? `github__${stream}`;
    });

    expect(resolved).toEqual(new Map([['raw_issues', 'merge']]));
  });

  it('rejects conflicting strategies when two streams resolve to one table', () => {
    expect(() =>
      resolveStreamStrategyOverrides(
        { issues: 'merge', pull_requests: 'append' },
        () => 'shared_table'
      )
    ).toThrow(/Conflicting per-stream load strategies/);
  });
});
