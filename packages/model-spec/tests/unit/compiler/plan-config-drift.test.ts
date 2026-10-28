/**
 * Unit tests for `planConfigDrift` — the post-`planTransition` check that
 * catches materialization-config drift (strategy / unique_key /
 * incremental_filter / on_schema_change / target_schema / target_database)
 * the existing materialization-type check misses.
 */

import { describe, expect, it } from 'vitest';

import {
  planConfigDrift,
  type CurrentRunConfigSnapshot,
} from '../../../src/compiler/materializer-config-drift.js';

import type { ModelRunState } from '../../../src/compiler/state.js';

/**
 * Build a "fully-populated" prior state so individual tests can override one
 * field at a time and assert that field alone triggers drift. Avoids the
 * combinatorial explosion of constructing fresh objects per scenario.
 */
function priorIncremental(overrides: Partial<ModelRunState> = {}): ModelRunState {
  return {
    lastRunAt: '2026-03-10T12:00:00.000Z',
    materialization: 'incremental',
    specChecksum: 'sha-abc',
    strategy: 'merge',
    uniqueKey: ['customer_id'],
    incrementalFilter: 'updated_at > (SELECT MAX(updated_at) FROM self)',
    onSchemaChange: 'fail',
    targetSchema: 'ANALYTICS',
    targetDatabase: 'PROD',
    priorFqName: '"PROD"."ANALYTICS"."CUSTOMER_SUMMARY"',
    ...overrides,
  };
}

function currentIncremental(
  overrides: Partial<CurrentRunConfigSnapshot> = {}
): CurrentRunConfigSnapshot {
  return {
    materialization: 'incremental',
    strategy: 'merge',
    uniqueKey: ['customer_id'],
    incrementalFilter: 'updated_at > (SELECT MAX(updated_at) FROM self)',
    onSchemaChange: 'fail',
    targetSchema: 'ANALYTICS',
    targetDatabase: 'PROD',
    fqName: '"PROD"."ANALYTICS"."CUSTOMER_SUMMARY"',
    ...overrides,
  };
}

describe('planConfigDrift', () => {
  describe('first-run / backward-compat (proceed)', () => {
    it('proceeds when there is no prior state (first run)', () => {
      const decision = planConfigDrift(undefined, currentIncremental(), 'customer_summary');
      expect(decision).toEqual({ kind: 'proceed' });
    });

    it('proceeds when the prior state lacks all tracked fields (older Dogsled version)', () => {
      // Spec §3: "model that has prior state from a previous Dogsled version
      // (i.e. lacks the newly-tracked config fields) must NOT trigger a
      // spurious recreate on its first run under the new Dogsled version."
      const prior: ModelRunState = {
        lastRunAt: '2026-03-10T12:00:00.000Z',
        materialization: 'incremental',
        specChecksum: 'sha-abc',
      };
      const decision = planConfigDrift(prior, currentIncremental(), 'customer_summary');
      expect(decision).toEqual({ kind: 'proceed' });
    });

    it('proceeds when prior and current match exactly', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental(),
        'customer_summary'
      );
      expect(decision).toEqual({ kind: 'proceed' });
    });
  });

  describe('structured changes payload', () => {
    it('surfaces the change list on the recreate decision', () => {
      // The caller (run-project.ts) fires this through `opts.onWarn` and
      // pushes it onto `RunProjectResult.warnings`, so dev-pipeline traces
      // can see *which* field drifted without grep'ing the warehouse log.
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ strategy: 'delete_insert', uniqueKey: ['order_id'] }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;

      expect(decision.changes).toEqual([
        'strategy merge -> delete_insert',
        'unique_key [customer_id] -> [order_id]',
      ]);
    });

    it('omits the changes payload on proceed', () => {
      const decision = planConfigDrift(undefined, currentIncremental(), 'customer_summary');
      expect(decision.kind).toBe('proceed');
      // No `changes` field — the proceed variant doesn't carry one.
      expect((decision as { changes?: unknown }).changes).toBeUndefined();
    });
  });

  describe('preDdl shape', () => {
    it('inlines the diagnostic comment with the DROP into a single entry', () => {
      // Regression: `executeSqlStatements` dispatches each preDdl entry as a
      // standalone runner call. A standalone comment-only string is rejected
      // by Snowflake (`SQL compilation error: Empty SQL statement`) and
      // similarly by BigQuery / MySQL / Databricks. The recreate decision
      // must therefore emit exactly one entry — comment + DROP on the same
      // string — so every dialect treats the comment as a leading
      // annotation on the next statement.
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ strategy: 'delete_insert' }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;

      expect(decision.preDdl).toHaveLength(1);
      const entry = decision.preDdl[0]!;
      // The comment is preserved as a leading annotation, and the DROP
      // follows on its own line so it's visible in the SQL log.
      expect(entry.startsWith('-- ')).toBe(true);
      expect(entry).toContain('strategy merge -> delete_insert');
      expect(entry).toContain('DROP TABLE IF EXISTS "PROD"."ANALYTICS"."CUSTOMER_SUMMARY"');
      // No bare comment-only entry would have a `;` *before* the DROP.
      const commentEnd = entry.indexOf('\n');
      expect(commentEnd).toBeGreaterThan(0);
      expect(
        entry
          .slice(commentEnd + 1)
          .trimStart()
          .startsWith('DROP')
      ).toBe(true);
    });
  });

  describe('strategy drift (recreate)', () => {
    it('recreates on merge → delete_insert', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ strategy: 'delete_insert' }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain('strategy merge -> delete_insert');
      // DROP must target the prior fqName, not the current.
      expect(decision.preDdl.join('\n')).toContain(
        'DROP TABLE IF EXISTS "PROD"."ANALYTICS"."CUSTOMER_SUMMARY"'
      );
    });

    it('recreates on merge → append', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ strategy: 'append' }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
    });
  });

  describe('unique_key drift (recreate)', () => {
    it('recreates when a column is added', () => {
      const decision = planConfigDrift(
        priorIncremental({ uniqueKey: ['customer_id'] }),
        currentIncremental({ uniqueKey: ['customer_id', 'tenant_id'] }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain('unique_key [customer_id]');
    });

    it('recreates when the column list is reordered', () => {
      // Spec §2 calls out reorder explicitly. Order matters because MERGE ON
      // clauses are emitted positionally and some warehouse planners build
      // clustering/indexing structures from the listed order.
      const decision = planConfigDrift(
        priorIncremental({ uniqueKey: ['customer_id', 'tenant_id'] }),
        currentIncremental({ uniqueKey: ['tenant_id', 'customer_id'] }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
    });

    it('does not recreate when the column list is identical', () => {
      const decision = planConfigDrift(
        priorIncremental({ uniqueKey: ['a', 'b'] }),
        currentIncremental({ uniqueKey: ['a', 'b'] }),
        'customer_summary'
      );
      expect(decision).toEqual({ kind: 'proceed' });
    });
  });

  describe('incremental_filter drift (recreate)', () => {
    it('recreates when the filter is changed substantively', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({
          incrementalFilter: 'created_at > (SELECT MAX(created_at) FROM self)',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain('incremental_filter changed');
    });

    it('recreates when a filter is added to a model that previously had none', () => {
      const decision = planConfigDrift(
        priorIncremental({ incrementalFilter: undefined }),
        currentIncremental({
          incrementalFilter: 'updated_at > (SELECT MAX(updated_at) FROM self)',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.changes).toContain('incremental_filter added');
    });

    it('recreates when a filter is removed from a model that previously had one', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ incrementalFilter: undefined }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.changes).toContain('incremental_filter removed');
    });

    it('does not fire filter-added drift for old Dogsled state that lacks strategy', () => {
      const prior: ModelRunState = {
        lastRunAt: '2026-03-10T12:00:00.000Z',
        materialization: 'incremental',
        specChecksum: 'sha-abc',
      };
      const decision = planConfigDrift(
        prior,
        currentIncremental({
          incrementalFilter: 'updated_at > (SELECT MAX(updated_at) FROM self)',
        }),
        'customer_summary'
      );
      expect(decision).toEqual({ kind: 'proceed' });
    });
  });

  describe('on_schema_change flip (recreate)', () => {
    it('recreates when fail → full_refresh', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ onSchemaChange: 'full_refresh' }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain('on_schema_change fail -> full_refresh');
    });
  });

  describe('target routing drift (recreate against PRIOR destination)', () => {
    it('drops the prior fqName when target_schema changes', () => {
      // Spec §2: "when the prior state's destination differs from the current
      // invocation's resolved destination, the DROP must target the **prior**
      // destination, not the new one."
      const decision = planConfigDrift(
        priorIncremental({
          targetSchema: 'ANALYTICS_OLD',
          priorFqName: '"PROD"."ANALYTICS_OLD"."CUSTOMER_SUMMARY"',
        }),
        currentIncremental({
          targetSchema: 'ANALYTICS_NEW',
          fqName: '"PROD"."ANALYTICS_NEW"."CUSTOMER_SUMMARY"',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      // Critical: DROP must target the OLD destination — otherwise the table
      // at ANALYTICS_OLD sits orphaned and the user assumes the run is
      // updating it.
      const joined = decision.preDdl.join('\n');
      expect(joined).toContain('DROP TABLE IF EXISTS "PROD"."ANALYTICS_OLD"."CUSTOMER_SUMMARY"');
      expect(joined).not.toContain('"PROD"."ANALYTICS_NEW"."CUSTOMER_SUMMARY"');
    });

    it('drops the prior fqName when target_database changes', () => {
      const decision = planConfigDrift(
        priorIncremental({
          targetDatabase: 'PROD',
          priorFqName: '"PROD"."ANALYTICS"."CUSTOMER_SUMMARY"',
        }),
        currentIncremental({
          targetDatabase: 'STAGING',
          fqName: '"STAGING"."ANALYTICS"."CUSTOMER_SUMMARY"',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain(
        'DROP TABLE IF EXISTS "PROD"."ANALYTICS"."CUSTOMER_SUMMARY"'
      );
    });

    it('detects target_database being added (single-db prior → multi-db current)', () => {
      // Bug regression: a drift-aware single-database prior (targetSchema set,
      // targetDatabase legitimately absent) that later gains an explicit
      // target_database was previously silently ignored, orphaning the old
      // destination at the bare two-part name.
      const prior = priorIncremental({
        targetDatabase: undefined,
        priorFqName: '"ANALYTICS"."CUSTOMER_SUMMARY"',
      });
      const decision = planConfigDrift(
        prior,
        currentIncremental({
          targetDatabase: 'PROD',
          fqName: '"PROD"."ANALYTICS"."CUSTOMER_SUMMARY"',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      const joined = decision.preDdl.join('\n');
      expect(joined).toContain('target_database (unset) -> PROD');
      // DROP targets the OLD two-part name, not the new three-part one.
      expect(joined).toContain('DROP TABLE IF EXISTS "ANALYTICS"."CUSTOMER_SUMMARY"');
    });

    it('detects target_database being removed (multi-db prior → single-db current)', () => {
      const decision = planConfigDrift(
        priorIncremental({
          targetDatabase: 'PROD',
          priorFqName: '"PROD"."ANALYTICS"."CUSTOMER_SUMMARY"',
        }),
        currentIncremental({
          targetDatabase: undefined,
          fqName: '"ANALYTICS"."CUSTOMER_SUMMARY"',
        }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      expect(decision.preDdl.join('\n')).toContain('target_database PROD -> (unset)');
    });
  });

  describe('combined drift', () => {
    it('lists every changed field in the preDdl comment', () => {
      const decision = planConfigDrift(
        priorIncremental(),
        currentIncremental({ strategy: 'append', uniqueKey: ['order_id'] }),
        'customer_summary'
      );
      expect(decision.kind).toBe('recreate');
      if (decision.kind !== 'recreate') return;
      const joined = decision.preDdl.join('\n');
      expect(joined).toContain('strategy merge -> append');
      expect(joined).toContain('unique_key');
    });
  });
});
