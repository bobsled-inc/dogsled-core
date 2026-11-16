import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeChecksum,
  computeSelectState,
  diffSelectColumns,
  isFirstRun,
  loadState,
  normalizeIncrementalFilterForState,
  normalizeSelectColumns,
  normalizeUniqueKeyForState,
  saveState,
  stateKey,
} from '../../../src/compiler/state.js';
import { CommandError } from '../../../src/errors.js';

import type { RunState } from '../../../src/compiler/state.js';

describe('state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadState', () => {
    it('returns empty state when file does not exist', () => {
      const state = loadState(tmpDir);
      expect(state).toEqual({ models: {} });
    });

    it('throws CommandError exit 2 on corrupted JSON', () => {
      fs.mkdirSync(path.join(tmpDir, '.bobsled/model-spec'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.bobsled/model-spec', 'run-state.json'),
        'not json',
        'utf-8'
      );
      expect(() => loadState(tmpDir)).toThrow(CommandError);
      try {
        loadState(tmpDir);
      } catch (err) {
        expect((err as CommandError).exitCode).toBe(2);
        expect((err as CommandError).message).toContain('not valid JSON');
      }
    });

    it('throws CommandError exit 2 on invalid schema', () => {
      fs.mkdirSync(path.join(tmpDir, '.bobsled/model-spec'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.bobsled/model-spec', 'run-state.json'),
        JSON.stringify({ models: { bad: { unexpectedField: true } } }),
        'utf-8'
      );
      expect(() => loadState(tmpDir)).toThrow(CommandError);
      try {
        loadState(tmpDir);
      } catch (err) {
        expect((err as CommandError).exitCode).toBe(2);
        expect((err as CommandError).message).toContain('schema validation');
      }
    });

    it.each(['.bms', '.bobsled-context'])('ignores retired state directory %s', (legacyDir) => {
      const legacyState: RunState = {
        models: {
          legacy_model: {
            lastRunAt: '2026-01-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'legacy123',
          },
        },
      };
      fs.mkdirSync(path.join(tmpDir, legacyDir), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, legacyDir, 'run-state.json'),
        JSON.stringify(legacyState),
        'utf-8'
      );
      const loaded = loadState(tmpDir);
      expect(loaded).toEqual({ models: {} });
    });
  });

  describe('saveState + loadState', () => {
    it('round-trips correctly', () => {
      const state: RunState = {
        models: {
          stg_orders: {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'table',
            specChecksum: 'abc123def456',
          },
          fct_revenue: {
            lastRunAt: '2026-03-10T12:01:00.000Z',
            materialization: 'incremental',
            specChecksum: 'xyz789',
            selectSignature: 'v1:abc123def4567890',
            columns: [
              { name: 'ORDER_ID', type: 'integer', primary_key: true, not_null: true },
              { name: 'TOTAL', type: 'number', primary_key: false, not_null: false },
            ],
          },
        },
      };

      saveState(tmpDir, state);
      const loaded = loadState(tmpDir);

      expect(loaded).toEqual(state);
    });

    it('creates directory and preserves structure', () => {
      const state: RunState = {
        models: {
          test: {
            lastRunAt: '2026-01-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'abc',
          },
        },
      };
      saveState(tmpDir, state);
      const loaded = loadState(tmpDir);
      expect(loaded.models.test).toEqual(state.models.test);
    });
  });

  describe('isFirstRun', () => {
    it('returns true for unknown model', () => {
      const state: RunState = { models: {} };
      expect(isFirstRun(state, 'stg_orders')).toBe(true);
    });

    it('returns false for known model', () => {
      const state: RunState = {
        models: {
          stg_orders: {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'table',
            specChecksum: 'abc123',
          },
        },
      };
      expect(isFirstRun(state, 'stg_orders')).toBe(false);
    });

    it('is case-insensitive', () => {
      const state: RunState = {
        models: {
          stg_orders: {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'table',
            specChecksum: 'abc123',
          },
        },
      };
      expect(isFirstRun(state, 'STG_ORDERS')).toBe(false);
    });

    it('returns true for a model not scoped to the given handle', () => {
      const state: RunState = {
        models: {
          'ecom.stg_orders': {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'table',
            specChecksum: 'abc123',
          },
        },
      };
      expect(isFirstRun(state, 'stg_orders', 'analytics')).toBe(true);
    });

    it('returns false when the handle-scoped key exists', () => {
      const state: RunState = {
        models: {
          'ecom.stg_orders': {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'table',
            specChecksum: 'abc123',
          },
        },
      };
      expect(isFirstRun(state, 'stg_orders', 'ecom')).toBe(false);
    });
  });

  describe('stateKey', () => {
    it('joins handle and lowercased model name with a dot', () => {
      expect(stateKey('ecom', 'stg_orders')).toBe('ecom.stg_orders');
      expect(stateKey('ecom', 'STG_ORDERS')).toBe('ecom.stg_orders');
    });
  });

  describe('computeChecksum', () => {
    it('returns consistent hash for same input', () => {
      const a = computeChecksum('hello world');
      const b = computeChecksum('hello world');
      expect(a).toBe(b);
    });

    it('returns different hash for different input', () => {
      const a = computeChecksum('hello world');
      const b = computeChecksum('goodbye world');
      expect(a).not.toBe(b);
    });

    it('returns a 16-character hex string', () => {
      const hash = computeChecksum('test');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('computeSelectState', () => {
    it('returns a versioned 16-character sha256 prefix', () => {
      const { signature } = computeSelectState([{ name: 'ORDER_ID', type: 'NUMBER' }]);
      expect(signature).toMatch(/^v1:[0-9a-f]{16}$/);
    });

    it('is stable for case-insensitive column ordering and canonical type buckets', () => {
      const a = computeSelectState([
        { name: 'amount', type: 'DECIMAL(10, 2)' },
        { name: 'ORDER_ID', type: 'BIGINT' },
        { name: 'payload', type: 'STRUCT<name STRING>' },
      ]).signature;
      const b = computeSelectState([
        { name: 'payload', type: 'object' },
        { name: 'ORDER_ID', type: 'integer' },
        { name: 'amount', type: 'number' },
      ]).signature;

      expect(a).toBe(b);
    });

    it('preserves original column names in the canonical payload', () => {
      const upper = computeSelectState([{ name: 'ORDER_ID', type: 'INTEGER' }]).signature;
      const lower = computeSelectState([{ name: 'order_id', type: 'INTEGER' }]).signature;
      expect(upper).not.toBe(lower);
    });

    it('throws CommandError exit 2 for empty columns', () => {
      expect(() => computeSelectState([])).toThrow(CommandError);
      try {
        computeSelectState([]);
      } catch (err) {
        expect(err).toBeInstanceOf(CommandError);
        expect((err as CommandError).exitCode).toBe(2);
      }
    });

    it('returns the signature and canonical structural payload', () => {
      const result = computeSelectState([
        { name: 'ORDER_ID', type: 'BIGINT', primary_key: true, not_null: true },
        { name: 'TOTAL', type: 'DECIMAL(18, 2)' },
      ]);

      expect(result.signature).toMatch(/^v1:[0-9a-f]{16}$/);
      expect(result.columns).toEqual([
        { name: 'ORDER_ID', type: 'integer', primary_key: true, not_null: true },
        { name: 'TOTAL', type: 'number', primary_key: false, not_null: false },
      ]);
    });
  });

  describe('normalizeSelectColumns', () => {
    it('buckets structural column types', () => {
      expect(
        normalizeSelectColumns([
          { name: 'tags', type: 'ARRAY<STRING>' },
          { name: 'payload', type: 'JSONB' },
          { name: 'created_at', type: 'TIMESTAMP WITH TIME ZONE' },
          { name: 'is_active', type: 'BOOL' },
        ])
      ).toEqual([
        { name: 'created_at', type: 'timestamp', primary_key: false, not_null: false },
        { name: 'is_active', type: 'boolean', primary_key: false, not_null: false },
        { name: 'payload', type: 'object', primary_key: false, not_null: false },
        { name: 'tags', type: 'array', primary_key: false, not_null: false },
      ]);
    });
  });

  describe('diffSelectColumns', () => {
    it('reports added, removed, and changed columns case-insensitively', () => {
      const diff = diffSelectColumns(
        [
          { name: 'ORDER_ID', type: 'integer', primary_key: true, not_null: true },
          { name: 'TOTAL', type: 'number', primary_key: false, not_null: false },
          { name: 'REMOVED_AT', type: 'timestamp', primary_key: false, not_null: false },
        ],
        [
          { name: 'order_id', type: 'integer', primary_key: true, not_null: true },
          { name: 'TOTAL', type: 'string', primary_key: false, not_null: false },
          { name: 'CREATED_AT', type: 'timestamp', primary_key: false, not_null: false },
        ]
      );

      expect(diff.hasChanges).toBe(true);
      expect(diff.added).toEqual([
        { name: 'CREATED_AT', type: 'timestamp', primary_key: false, not_null: false },
      ]);
      expect(diff.removed).toEqual([
        { name: 'REMOVED_AT', type: 'timestamp', primary_key: false, not_null: false },
      ]);
      expect(diff.changed).toEqual([
        {
          before: { name: 'ORDER_ID', type: 'integer', primary_key: true, not_null: true },
          after: { name: 'order_id', type: 'integer', primary_key: true, not_null: true },
        },
        {
          before: { name: 'TOTAL', type: 'number', primary_key: false, not_null: false },
          after: { name: 'TOTAL', type: 'string', primary_key: false, not_null: false },
        },
      ]);
    });

    it('returns no changes for equivalent columns', () => {
      const diff = diffSelectColumns(
        [{ name: 'ORDER_ID', type: 'integer', primary_key: false, not_null: false }],
        [{ name: 'ORDER_ID', type: 'integer', primary_key: false, not_null: false }]
      );
      expect(diff).toEqual({ added: [], removed: [], changed: [], hasChanges: false });
    });
  });

  describe('normalizeUniqueKeyForState', () => {
    it('returns undefined for missing input', () => {
      expect(normalizeUniqueKeyForState(undefined)).toBeUndefined();
      expect(normalizeUniqueKeyForState(null)).toBeUndefined();
      expect(normalizeUniqueKeyForState([])).toBeUndefined();
    });

    it('lowercases column names and preserves order', () => {
      expect(normalizeUniqueKeyForState(['Customer_ID', 'ORDER_DATE'])).toEqual([
        'customer_id',
        'order_date',
      ]);
    });

    it('wraps a bare string into a single-element array', () => {
      expect(normalizeUniqueKeyForState('customer_id')).toEqual(['customer_id']);
    });

    it('treats reorder as a meaningful change (no canonical sort)', () => {
      // Order is load-bearing for downstream MERGE planners; we must not
      // silently sort the list — that would mask reorder-as-change.
      const a = normalizeUniqueKeyForState(['a', 'b']);
      const b = normalizeUniqueKeyForState(['b', 'a']);
      expect(a).not.toEqual(b);
    });
  });

  describe('normalizeIncrementalFilterForState', () => {
    it('returns undefined for missing or empty input', () => {
      expect(normalizeIncrementalFilterForState(undefined)).toBeUndefined();
      expect(normalizeIncrementalFilterForState(null)).toBeUndefined();
      expect(normalizeIncrementalFilterForState('   ')).toBeUndefined();
    });

    it('collapses internal whitespace and trims', () => {
      expect(
        normalizeIncrementalFilterForState(
          '  updated_at   >\n  (SELECT MAX(updated_at) FROM self) '
        )
      ).toBe('updated_at > (SELECT MAX(updated_at) FROM self)');
    });

    it('treats whitespace-only edits as equal', () => {
      const a = normalizeIncrementalFilterForState('a > b');
      const b = normalizeIncrementalFilterForState('a  >  b');
      const c = normalizeIncrementalFilterForState('a\n>\nb');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('treats semantic changes as unequal', () => {
      const a = normalizeIncrementalFilterForState('a > b');
      const b = normalizeIncrementalFilterForState('a >= b');
      expect(a).not.toBe(b);
    });
  });

  describe('extended ModelRunState round-trip', () => {
    it('persists new config-snapshot fields and reads them back as-is', () => {
      const state: RunState = {
        models: {
          'snowflake.fct_orders': {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'incremental',
            specChecksum: 'abc123',
            strategy: 'merge',
            uniqueKey: ['order_id'],
            incrementalFilter: 'updated_at > (SELECT MAX(updated_at) FROM self)',
            onSchemaChange: 'fail',
            targetSchema: 'ANALYTICS',
            targetDatabase: 'PROD',
            priorFqName: '"PROD"."ANALYTICS"."FCT_ORDERS"',
          },
        },
      };
      saveState(tmpDir, state);
      const loaded = loadState(tmpDir);
      expect(loaded).toEqual(state);
    });

    it('loads older state files that lack the new fields (backward compat)', () => {
      // Mirrors state written by Dogsled versions < drift-detection. The reader
      // must accept it without throwing — the new fields are all optional.
      const fileContent = JSON.stringify({
        models: {
          'snowflake.fct_orders': {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'incremental',
            specChecksum: 'abc123',
          },
        },
      });
      fs.mkdirSync(path.join(tmpDir, '.bobsled/model-spec'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.bobsled/model-spec', 'run-state.json'),
        fileContent,
        'utf-8'
      );
      expect(() => loadState(tmpDir)).not.toThrow();
      const loaded = loadState(tmpDir);
      expect(loaded.models['snowflake.fct_orders']?.strategy).toBeUndefined();
      expect(loaded.models['snowflake.fct_orders']?.priorFqName).toBeUndefined();
    });

    it('preserves unknown forward-compat fields on round-trip', () => {
      // State written by a *newer* Dogsled version may have keys this version
      // doesn't recognize. We must not strip them — round-tripping must be
      // lossless so the orchestrator can persist whatever Dogsled gives it.
      const fileContent = JSON.stringify({
        models: {
          'duckdb.stg_orders': {
            lastRunAt: '2026-03-10T12:00:00.000Z',
            materialization: 'view',
            specChecksum: 'abc',
            futureField: { nested: 'value' },
          },
        },
      });
      fs.mkdirSync(path.join(tmpDir, '.bobsled/model-spec'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.bobsled/model-spec', 'run-state.json'),
        fileContent,
        'utf-8'
      );
      const loaded = loadState(tmpDir);
      expect(loaded.models['duckdb.stg_orders']?.['futureField']).toEqual({ nested: 'value' });
    });
  });
});
