import { describe, expect, it } from 'vitest';

import { AUDIT_PAYLOAD_KINDS, AuditPayloadSchema } from '../../src/audit.js';

describe('AuditPayloadSchema', () => {
  it.each(AUDIT_PAYLOAD_KINDS)('accepts payload kind %s', (kind) => {
    const basePayloads = {
      merge: { kind, pair_id: 'pair-1' },
      not_match: { kind, pair_id: 'pair-1' },
      unmerge: { kind, cluster_id: 'cluster-1', kept_record_ids: ['r1'] },
      split: { kind, original_cluster_id: 'cluster-1' },
      survivorship_choose: { kind, attribute_name: 'domain' },
      semantic_promote_merge: {
        kind,
        semantic_score: 0.95,
        threshold: 0.9,
        provider: 'openai_text_embedding_3_small',
      },
      semantic_promote_reject: {
        kind,
        semantic_score: 0.2,
        threshold: 0.4,
        provider: 'openai_text_embedding_3_small',
      },
      semantic_triage_skipped: {
        kind,
        estimated_embedding_cost_usd: 1.2,
        max_embedding_cost_usd: 1,
        candidate_count: 10,
        reason: 'budget exceeded',
      },
      relate_confirm: { kind, relationship_name: 'company_contact' },
      relate_reject: { kind, relationship_name: 'company_contact' },
      review_apply: { kind, decision_batch_id: 'batch-1', skipped: false },
      erasure: {
        kind,
        tombstone_id: 'abc123',
        tables: ['company__standardized'],
        row_counts: { requested_records: 1 },
      },
      incremental_run: {
        kind,
        entity: 'company',
        mode: 'incremental',
        mode_reason: 'resolve_state_matched',
        source_count: 1,
        spec_fingerprint: 'sha256:abc123',
      },
      match_assign: {
        kind,
        entity: 'company',
        mode: 'assign',
        idempotency_key: 'key-1',
        record_id: 'record-1',
        source_ref: 'crm.accounts',
        outcome: 'assigned',
        matched_entity_id: 'entity-1',
      },
      policy_block: { kind, policy: 'no-writeback' },
      agent_escalate: { kind, reason: 'low confidence' },
      activation_dispatch: { kind, sync_name: 'salesforce_sync', action: 'upsert_contact' },
      activation_receipt: {
        kind,
        sync_name: 'salesforce_sync',
        action: 'upsert_contact',
        status: 'ok',
        duration_ms: 25,
      },
      expect_pass: { kind, expectation: 'non_null_email' },
      expect_fail: { kind, expectation: 'non_null_email' },
      clean_apply: { kind, spec_ref: 'clean_customers.yml' },
      lineage_refresh: {
        kind,
        entity_type: 'company',
        attribute_count: 4,
        complete_count: 3,
        incomplete_count: 1,
      },
    } as const;

    expect(AuditPayloadSchema.parse(basePayloads[kind])).toMatchObject({ kind });
  });

  it('rejects unknown payload kinds', () => {
    expect(() => AuditPayloadSchema.parse({ kind: 'unknown' })).toThrow();
  });

  it('requires matched_entity_id for assigned match outcomes', () => {
    expect(() =>
      AuditPayloadSchema.parse({
        kind: 'match_assign',
        entity: 'company',
        mode: 'assign',
        idempotency_key: 'key-1',
        record_id: 'record-1',
        source_ref: 'crm.accounts',
        outcome: 'assigned',
      })
    ).toThrow(/matched_entity_id/);
  });

  it('keeps erasure payloads PII-free and strict', () => {
    expect(
      AuditPayloadSchema.parse({
        kind: 'erasure',
        tombstone_id: 'abc123',
        tables: ['company__standardized', 'audit_log'],
        row_counts: { requested_records: 1, redacted: 2 },
      })
    ).toMatchObject({ kind: 'erasure', tombstone_id: 'abc123' });

    expect(() =>
      AuditPayloadSchema.parse({
        kind: 'erasure',
        tombstone_id: 'abc123',
        tables: ['company__standardized'],
        row_counts: { requested_records: 1 },
        email: 'person@example.com',
      })
    ).toThrow();
  });

  it('accepts review_apply decision-trace fields and rejects unknown keys (strict)', () => {
    const parsed = AuditPayloadSchema.parse({
      kind: 'review_apply',
      decision_batch_id: 'batch-1',
      content_hash: 'abc123',
      skipped: false,
      decision_count: 3,
      merge_count: 1,
      not_match_count: 1,
      deferred_count: 1,
      escalated_count: 0,
      policy_version: 'pol-1',
      config_snapshot: { spec: 'company_resolution', auto_apply_threshold: 0.75 },
      langsmith_trace_id: 'ls-trace-1',
      precedent_refs: ['batch-0', 'p7'],
    });
    expect(parsed).toMatchObject({
      kind: 'review_apply',
      policy_version: 'pol-1',
      langsmith_trace_id: 'ls-trace-1',
      precedent_refs: ['batch-0', 'p7'],
    });

    // .strict() — an unknown key on the review_apply payload is rejected, so the
    // warehouse trace never silently absorbs a typo'd field.
    expect(() =>
      AuditPayloadSchema.parse({
        kind: 'review_apply',
        decision_batch_id: 'batch-1',
        skipped: false,
        not_a_real_field: true,
      })
    ).toThrow();
  });

  it('accepts negative cosine scores for semantic reject promotions', () => {
    expect(
      AuditPayloadSchema.parse({
        kind: 'semantic_promote_reject',
        semantic_score: -0.25,
        threshold: 0.4,
        provider: 'openai_text_embedding_3_small',
      })
    ).toMatchObject({ semantic_score: -0.25 });
  });

  it('rejects invalid activation payload field combinations', () => {
    expect(() =>
      AuditPayloadSchema.parse({
        kind: 'activation_dispatch',
        sync_name: 'salesforce_sync',
        action: 'upsert_contact',
        duration_ms: 25,
      })
    ).toThrow();

    expect(() =>
      AuditPayloadSchema.parse({
        kind: 'activation_receipt',
        sync_name: 'salesforce_sync',
        action: 'upsert_contact',
      })
    ).toThrow();
  });
});
