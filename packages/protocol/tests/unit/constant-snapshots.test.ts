import { describe, expect, it } from 'vitest';

import {
  COLUMN_TYPES,
  CURSOR_TYPES,
  FAILURE_REASONS,
  LOAD_STRATEGIES,
  PROGRESS_EVENTS,
  SCHEMA_BEHAVIORS,
  SKIPPED_REASONS,
} from '../../src/index.js';

describe('protocol constant snapshots', () => {
  it('locks supported protocol column types, including vectors', () => {
    expect(COLUMN_TYPES).toMatchInlineSnapshot(`
      [
        "string",
        "integer",
        "number",
        "boolean",
        "timestamp",
        "array",
        "object",
        "vector",
      ]
    `);
  });

  it('locks load strategies', () => {
    expect(LOAD_STRATEGIES).toMatchInlineSnapshot(`
      [
        "append",
        "merge",
        "full_refresh",
      ]
    `);
  });

  it('locks cursor types', () => {
    expect(CURSOR_TYPES).toMatchInlineSnapshot(`
      [
        "string",
        "number",
        "integer",
        "timestamp",
        "lsn",
      ]
    `);
  });

  it('locks failure reasons', () => {
    expect(FAILURE_REASONS).toMatchInlineSnapshot(`
      [
        "auth_failure",
        "rate_limit_exhausted",
        "timeout",
        "data_error",
        "config_error",
        "transient_error",
        "circuit_breaker",
        "schema_conflict",
        "destination_error",
        "partial_success",
        "for_each_parent_not_co_scheduled",
      ]
    `);
  });

  it('locks skipped reasons', () => {
    expect(SKIPPED_REASONS).toMatchInlineSnapshot(`
      [
        "for_each_parent_empty",
        "for_each_incomplete_bindings",
        "timeout",
        "circuit_breaker",
      ]
    `);
  });

  it('locks progress events', () => {
    expect(PROGRESS_EVENTS).toMatchInlineSnapshot(`
      [
        "run_start",
        "run_complete",
        "resource_start",
        "resource_complete",
        "resource_error",
        "resource_skip",
        "health_check_complete",
      ]
    `);
  });

  it('locks schema behaviors', () => {
    expect(SCHEMA_BEHAVIORS).toMatchInlineSnapshot(`
      [
        "evolve",
        "strict",
        "freeze",
      ]
    `);
  });
});
